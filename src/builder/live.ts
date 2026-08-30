/**
 * Firing to music the desk has never heard before: a browser tab, or whatever
 * the microphone can hear.
 *
 * A loaded file can be choreographed because the whole song is known up front.
 * Live audio has no future to read, and a shell needs a couple of seconds in
 * the air before it opens — so the only way to break *on* a beat is to predict
 * one. This module tracks the beat with a phase-locked loop, then launches each
 * shell exactly its own rise time before a beat that has not happened yet.
 *
 * The onset detector and the beat tracker take plain numbers so they can be
 * tested without an audio device; only `LiveConductor` touches WebAudio.
 */

import {
  designShell,
  gapBeatsFor,
  kindForIntensity,
  type ShowOptions,
} from "./choreography";
import { type ShellSpec, shellRiseTime } from "./spec";

/** Never hold a beat further out than this; tempo drift makes it a guess. */
const MAX_LEAD = 3.6;
/** Below this the shell would break before it cleared the water. */
const MIN_LEAD = 0.35;

export interface LiveFeatures {
  /** 0..1 — how loud the moment is against the loudest so far. */
  energy: number;
  /** 0..1 — spectral tilt, bass to cymbal. */
  tilt: number;
  /** 0..1 — strength of the most recent onset, decaying between them. */
  attack: number;
}

/* ------------------------------------------------------------------ */
/* Onsets                                                              */
/* ------------------------------------------------------------------ */

/**
 * Spectral flux with an adaptive threshold, the live twin of the offline peak
 * picker. The threshold tracks a running window rather than a fixed level, so
 * it follows a track that gets louder instead of firing on everything after it.
 */
export class OnsetDetector {
  private previous: Float32Array | null = null;
  private history: number[] = [];
  private lastOnset = -1;
  /** Rolling loudness ceiling, decayed so a quiet passage re-normalises. */
  private ceiling = 1e-3;

  /** Minimum seconds between onsets — about a sixteenth at 200 bpm. */
  constructor(private readonly minGap = 0.11) {}

  /**
   * Feeds one spectrum frame. `spectrum` is magnitudes in any consistent unit
   * (byte or linear); `split` is the bin where "low" becomes "high".
   */
  push(
    time: number,
    spectrum: Float32Array,
    split: number,
  ): { onset: boolean; strength: number; features: LiveFeatures } {
    let flux = 0;
    let low = 0;
    let high = 0;
    const previous = this.previous;
    for (let i = 0; i < spectrum.length; i++) {
      const value = spectrum[i];
      if (previous) {
        const delta = value - previous[i];
        if (delta > 0) flux += delta;
      }
      if (i < split) low += value;
      else high += value;
    }
    if (!previous || previous.length !== spectrum.length) {
      this.previous = new Float32Array(spectrum);
    } else {
      previous.set(spectrum);
    }

    const loudness = (low + high) / Math.max(1, spectrum.length);
    this.ceiling = Math.max(this.ceiling * 0.9995, loudness);
    const energy = Math.min(1, loudness / Math.max(1e-6, this.ceiling));
    const tilt = high / (low + high + 1e-9);

    this.history.push(flux);
    if (this.history.length > 64) this.history.shift();
    let mean = 0;
    for (const value of this.history) mean += value;
    mean /= Math.max(1, this.history.length);

    const threshold = mean * 1.6 + 1e-6;
    const onset =
      this.previous !== null &&
      flux > threshold &&
      time - this.lastOnset > this.minGap;
    // Loud relative to its own context, not to the whole track: this is what
    // makes a hit in a quiet passage still read as a hit.
    const strength = Math.min(1, flux / Math.max(1e-6, mean * 3));
    if (onset) this.lastOnset = time;

    return {
      onset,
      strength,
      features: { energy, tilt, attack: onset ? strength : 0 },
    };
  }
}

/* ------------------------------------------------------------------ */
/* Beats                                                               */
/* ------------------------------------------------------------------ */

/**
 * A phase-locked loop over onset times.
 *
 * The period comes from a folded inter-onset histogram — the same trick the
 * offline tempo estimate uses — and the phase is nudged toward every onset that
 * lands near a beat. Small corrections, so one syncopated hit cannot drag the
 * grid off the music.
 */
export class BeatTracker {
  private intervals: number[] = [];
  private lastOnset = -1;
  /** A beat time; the grid is this plus whole periods. */
  private anchor = 0;
  private anchored = false;
  private strongest = 0;
  private strongestAt = 0;
  /**
   * Time of the strongest onset heard, which is taken to be a bar line. Held as
   * a time rather than an index because refitting renumbers the grid.
   */
  private barAnchorTime = 0;
  /** Recent onsets that landed on the grid, as (beat index, time) pairs. */
  private fitted: { index: number; time: number }[] = [];

  period = 0.5;

  get bpm(): number {
    return 60 / this.period;
  }

  get locked(): boolean {
    return this.fitted.length >= 6;
  }

  onOnset(time: number, strength: number): void {
    if (this.lastOnset >= 0) {
      const interval = time - this.lastOnset;
      if (interval > 0.18 && interval < 2) {
        this.intervals.push(interval);
        if (this.intervals.length > 40) this.intervals.shift();
        // The histogram only bootstraps the grid; the fit below refines it.
        if (this.fitted.length < 6) {
          this.period = estimatePeriod(this.intervals, this.period);
        }
      }
    }
    this.lastOnset = time;

    if (!this.anchored) {
      this.anchor = time;
      this.anchored = true;
      this.strongest = strength;
      this.strongestAt = time;
      this.barAnchorTime = time;
      return;
    }

    const index = Math.round((time - this.anchor) / this.period);
    const error = time - (this.anchor + index * this.period);
    // Onsets off the grid — syncopation, a stray hit — are not evidence about
    // where the beat is, so they are left out of the fit entirely.
    if (Math.abs(error) < this.period * 0.32) {
      this.fitted.push({ index, time });
      if (this.fitted.length > 32) this.fitted.shift();
      this.refit();

      // Only a clearly bigger hit moves the bar line — an even pulse says
      // nothing about where a bar starts, so the first hit keeps it. The peak
      // fades over about a minute so a later section can still take it back.
      const faded = this.strongest * 0.5 ** ((time - this.strongestAt) / 60);
      if (strength > faded * 1.25) {
        this.strongest = strength;
        this.strongestAt = time;
        this.barAnchorTime = time;
      }
    }
  }

  /**
   * Least squares over the recent grid-consistent onsets.
   *
   * Nudging the phase per onset drifts: the error is small every time and the
   * grid still walks. Fitting a line through (beat index, time) instead pins
   * both tempo and phase to the whole window, which is what makes a beat three
   * seconds out land where the music does.
   */
  private refit(): void {
    const n = this.fitted.length;
    if (n < 3) return;
    let meanIndex = 0;
    let meanTime = 0;
    for (const point of this.fitted) {
      meanIndex += point.index;
      meanTime += point.time;
    }
    meanIndex /= n;
    meanTime /= n;

    let covariance = 0;
    let variance = 0;
    for (const point of this.fitted) {
      const di = point.index - meanIndex;
      covariance += di * (point.time - meanTime);
      variance += di * di;
    }
    // Every onset on the same beat index says nothing about the period.
    if (variance < 1e-6) return;

    const period = Math.min(60 / 70, Math.max(60 / 200, covariance / variance));
    const anchor = meanTime - period * meanIndex;
    // Re-index the window against the new grid so the next fit stays coherent.
    for (const point of this.fitted) {
      point.index = Math.round((point.time - anchor) / period);
    }
    this.period = period;
    this.anchor = anchor;
  }

  /** Index of the beat nearest `time` on the current grid. */
  beatIndexAt(time: number): number {
    return Math.round((time - this.anchor) / this.period);
  }

  timeOfBeat(index: number): number {
    return this.anchor + index * this.period;
  }

  /** The first beat strictly after `time`. */
  nextBeatIndex(time: number): number {
    return Math.floor((time - this.anchor) / this.period) + 1;
  }

  isDownbeat(index: number): boolean {
    const bar = this.beatIndexAt(this.barAnchorTime);
    return (((index - bar) % 4) + 4) % 4 === 0;
  }
}

/** Folds inter-onset intervals into a 70–200 bpm histogram and takes the peak. */
export function estimatePeriod(
  intervals: readonly number[],
  fallback = 0.5,
): number {
  if (intervals.length < 3) return fallback;
  const buckets = new Float64Array(201);
  for (const interval of intervals) {
    let bpm = 60 / interval;
    while (bpm < 70) bpm *= 2;
    while (bpm > 200) bpm /= 2;
    const index = Math.round(bpm);
    buckets[index] += 1;
    if (index > 0) buckets[index - 1] += 0.5;
    if (index < 200) buckets[index + 1] += 0.5;
  }
  let best = 60 / fallback;
  let bestValue = -1;
  for (let bpm = 70; bpm <= 200; bpm++) {
    if (buckets[bpm] > bestValue) {
      bestValue = buckets[bpm];
      best = bpm;
    }
  }
  return 60 / best;
}

/* ------------------------------------------------------------------ */
/* The conductor                                                       */
/* ------------------------------------------------------------------ */

export interface LiveCue {
  spec: ShellSpec;
  x: number;
  z: number;
  /** Seconds from now to the break — handed straight to the rocket's fuse. */
  breakIn: number;
}

export interface LiveState {
  bpm: number;
  locked: boolean;
  energy: number;
  level: number;
  shells: number;
}

/**
 * Turns a live signal into launches.
 *
 * Each beat is decided once, at the moment the shell designed for it has to
 * leave the mortar. That keeps the design reading the music as it sounds now,
 * rather than as it sounded three seconds ago when the beat was first visible.
 */
export class LiveConductor {
  private detector = new OnsetDetector();
  private tracker = new BeatTracker();
  private spectrum: Uint8Array;
  private frame: Float32Array;
  private split: number;
  private handled = Number.NEGATIVE_INFINITY;
  private lastFired = Number.NEGATIVE_INFINITY;
  private index = 0;
  private side = 1;
  private smoothEnergy = 0;
  private features: LiveFeatures = { energy: 0, tilt: 0.5, attack: 0 };
  private fired = 0;
  /** Set while the caller wants nothing fired, e.g. the deck is stopped. */
  armed = true;

  constructor(
    private readonly analyser: AnalyserNode,
    private options: ShowOptions & { syncOffset?: number },
  ) {
    const bins = analyser.frequencyBinCount;
    this.spectrum = new Uint8Array(bins);
    this.frame = new Float32Array(bins);
    const nyquist = analyser.context.sampleRate / 2;
    this.split = Math.max(1, Math.round((500 / nyquist) * bins));
  }

  setOptions(options: ShowOptions & { syncOffset?: number }): void {
    this.options = options;
  }

  get state(): LiveState {
    return {
      bpm: this.tracker.bpm,
      locked: this.tracker.locked,
      energy: this.smoothEnergy,
      level: this.features.energy,
      shells: this.fired,
    };
  }

  /**
   * Reads the analyser and returns the shells that should launch this frame.
   * `now` and the returned break times are on the audio context's clock.
   */
  update(now: number, base: ShellSpec): LiveCue[] {
    this.analyser.getByteFrequencyData(
      this.spectrum as Uint8Array<ArrayBuffer>,
    );
    for (let i = 0; i < this.spectrum.length; i++) {
      this.frame[i] = this.spectrum[i] / 255;
    }

    const reading = this.detector.push(now, this.frame, this.split);
    this.features = reading.features;
    // Energy drives the section treatment, smoothed so one bar of silence does
    // not drop the show from a drop to an intro.
    this.smoothEnergy += (reading.features.energy - this.smoothEnergy) * 0.05;
    if (reading.onset) this.tracker.onOnset(now, reading.strength);

    if (!this.armed || !this.tracker.locked) return [];

    const cues: LiveCue[] = [];
    const offset = this.options.syncOffset ?? 0;
    let index = Math.max(this.handled + 1, this.tracker.nextBeatIndex(now));

    // Look a little way ahead; a beat is only fired once its shell is due.
    while (this.tracker.timeOfBeat(index) - now <= MAX_LEAD) {
      const at = this.tracker.timeOfBeat(index) + offset;
      const lead = at - now;
      if (lead < MIN_LEAD) {
        this.handled = index;
        index++;
        continue;
      }

      if (!this.shouldFire(index)) {
        this.handled = index;
        index++;
        continue;
      }

      const spec = this.design(base, index);
      const rise = shellRiseTime(spec);
      // Not due yet: leave the beat undecided so the next frame reads fresher
      // audio than this one.
      if (lead > rise + 0.03) break;

      this.handled = index;
      this.lastFired = index;
      this.fired++;
      cues.push({
        spec,
        x: this.nextX(),
        z: (Math.random() - 0.5) * 30,
        breakIn: Math.max(MIN_LEAD, lead),
      });
      index++;
    }

    return cues;
  }

  /** Grid thinning: quiet passages get a shell every few beats, drops get all. */
  private shouldFire(index: number): boolean {
    const kind = kindForIntensity(this.smoothEnergy);
    const density = Math.min(1, Math.max(0, this.options.density));
    const gap = Math.max(
      1,
      Math.round(gapBeatsFor(kind) * (2.3 - density * 1.9)),
    );
    if (index - this.lastFired >= gap) return true;
    // A downbeat inside a loud passage is worth breaking the spacing for.
    return this.tracker.isDownbeat(index) && this.smoothEnergy > 0.66;
  }

  private design(base: ShellSpec, beatIndex: number): ShellSpec {
    const kind = kindForIntensity(this.smoothEnergy);
    this.index++;
    return designShell(
      base,
      {
        strength: Math.min(
          1,
          0.35 + this.features.energy * 0.4 + this.features.attack * 0.4,
        ),
        tilt: this.features.tilt,
        section: {
          time: 0,
          kind,
          intensity: Math.max(0.15, this.smoothEnergy),
        },
        downbeat: this.tracker.isDownbeat(beatIndex),
        kind: this.tracker.isDownbeat(beatIndex) ? "accent" : "beat",
      },
      this.index,
      this.options,
      Math.random,
    );
  }

  private nextX(): number {
    this.side = -this.side;
    return this.side * (8 + this.features.tilt * 24 + Math.random() * 8);
  }
}
