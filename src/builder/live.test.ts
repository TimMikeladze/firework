import { describe, expect, test } from "bun:test";
import {
  BeatTracker,
  estimatePeriod,
  LiveConductor,
  OnsetDetector,
} from "./live";
import { PRESETS } from "./presets";

/** Frames at 60 Hz, the rate the renderer reads the analyser at. */
const FRAME = 1 / 60;

/** A spectrum with a broadband hit on the frames a beat lands on. */
function spectrumFrame(hit: boolean, bins = 64): Float32Array {
  const frame = new Float32Array(bins);
  for (let i = 0; i < bins; i++) {
    // Deterministic "noise floor" so the test is not flaky.
    frame[i] = 0.2 + ((i * 37) % 11) / 200;
    if (hit) frame[i] += 0.55;
  }
  return frame;
}

describe("estimatePeriod", () => {
  test("reads a steady tempo straight off the intervals", () => {
    expect(estimatePeriod(new Array(12).fill(0.5))).toBeCloseTo(0.5, 2);
  });

  test("folds half- and double-time intervals onto the same grid", () => {
    // 60 bpm folds up to 120, 240 folds down to 120.
    expect(estimatePeriod(new Array(12).fill(1))).toBeCloseTo(0.5, 2);
    expect(estimatePeriod(new Array(12).fill(0.25))).toBeCloseTo(0.5, 2);
  });

  test("keeps the previous estimate when there is nothing to go on", () => {
    expect(estimatePeriod([0.42], 0.42)).toBe(0.42);
  });
});

describe("BeatTracker", () => {
  const play = (bpm: number, beats: number, jitter = 0) => {
    const tracker = new BeatTracker();
    const period = 60 / bpm;
    let seed = 1;
    const noise = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return (seed / 2147483648 - 0.5) * 2 * jitter;
    };
    for (let i = 0; i < beats; i++) {
      tracker.onOnset(10 + i * period + noise(), 0.8);
    }
    return { tracker, period, last: 10 + (beats - 1) * period };
  };

  test("locks onto a steady tempo", () => {
    const { tracker } = play(128, 24);
    expect(tracker.locked).toBe(true);
    expect(tracker.bpm).toBeCloseTo(128, 0);
  });

  test("predicts the beats that have not happened yet", () => {
    const { tracker, period, last } = play(124, 32, 0.008);
    for (let ahead = 1; ahead <= 8; ahead++) {
      const expected = last + ahead * period;
      const index = tracker.beatIndexAt(expected);
      // Predicting three seconds out is the whole point: a shell has to leave
      // the mortar that far before the beat it breaks on.
      expect(Math.abs(tracker.timeOfBeat(index) - expected)).toBeLessThan(0.03);
    }
  });

  test("stays unlocked until it has heard enough", () => {
    const tracker = new BeatTracker();
    tracker.onOnset(0, 1);
    tracker.onOnset(0.5, 1);
    expect(tracker.locked).toBe(false);
  });

  test("counts bars four beats at a time", () => {
    const { tracker } = play(120, 16);
    const anchor = tracker.beatIndexAt(10);
    expect(tracker.isDownbeat(anchor)).toBe(true);
    expect(tracker.isDownbeat(anchor + 4)).toBe(true);
    expect(tracker.isDownbeat(anchor + 2)).toBe(false);
  });
});

describe("OnsetDetector", () => {
  test("finds the hits in a steady pulse and ignores the floor", () => {
    const detector = new OnsetDetector();
    const period = 0.5;
    const hits: number[] = [];
    for (let frame = 0; frame < 60 * 8; frame++) {
      const time = frame * FRAME;
      const sinceBeat = time % period;
      const isHit = sinceBeat < FRAME;
      const result = detector.push(time, spectrumFrame(isHit), 16);
      if (result.onset) hits.push(time);
    }

    // Every beat after the detector has a window to compare against.
    expect(hits.length).toBeGreaterThanOrEqual(14);
    for (const hit of hits.slice(1)) {
      expect(Math.min(hit % period, period - (hit % period))).toBeLessThan(
        0.05,
      );
    }
  });

  test("never reports two onsets inside the minimum gap", () => {
    const detector = new OnsetDetector(0.2);
    let last = Number.NEGATIVE_INFINITY;
    for (let frame = 0; frame < 300; frame++) {
      const time = frame * FRAME;
      // Every other frame is a hit: only the gap can hold this back.
      const result = detector.push(time, spectrumFrame(frame % 2 === 0), 16);
      if (result.onset) {
        expect(time - last).toBeGreaterThan(0.2);
        last = time;
      }
    }
  });

  test("reports a spectral tilt that follows where the energy is", () => {
    const detector = new OnsetDetector();
    const low = new Float32Array(64);
    low.fill(0.9, 0, 16);
    const high = new Float32Array(64);
    high.fill(0.9, 16);
    detector.push(0, low, 16);
    const bassy = detector.push(FRAME, low, 16);
    const bright = detector.push(2 * FRAME, high, 16);
    expect(bassy.features.tilt).toBeLessThan(0.2);
    expect(bright.features.tilt).toBeGreaterThan(0.8);
  });
});

/**
 * A stand-in for the analyser: it replays a 60 Hz stream of spectra with a
 * broadband hit on every beat, so the conductor can be driven without an audio
 * device.
 */
function fakeAnalyser(bpm: number) {
  const bins = 64;
  const period = 60 / bpm;
  let time = 0;
  const node = {
    frequencyBinCount: bins,
    context: { sampleRate: 48000 },
    getByteFrequencyData(out: Uint8Array) {
      const sinceBeat = time % period;
      const hit = sinceBeat < FRAME;
      for (let i = 0; i < bins; i++) {
        out[i] = Math.round(
          (0.2 + ((i * 37) % 11) / 200 + (hit ? 0.55 : 0)) * 255,
        );
      }
    },
  };
  return {
    node: node as unknown as AnalyserNode,
    period,
    advance(seconds: number) {
      time += seconds;
    },
    get time() {
      return time;
    },
  };
}

describe("LiveConductor", () => {
  test("launches each shell in time to break on a beat that has not happened", () => {
    const source = fakeAnalyser(120);
    const conductor = new LiveConductor(source.node, {
      density: 1,
      followColors: true,
    });

    const breaks: number[] = [];
    for (let frame = 0; frame < 60 * 20; frame++) {
      for (const cue of conductor.update(source.time, PRESETS[0])) {
        // A cue is a launch now plus a fuse, so this is when it opens.
        breaks.push(source.time + cue.breakIn);
        expect(cue.breakIn).toBeGreaterThan(0.3);
        expect(cue.breakIn).toBeLessThan(4);
      }
      source.advance(FRAME);
    }

    expect(breaks.length).toBeGreaterThan(4);
    for (const at of breaks) {
      const offGrid = Math.min(
        at % source.period,
        source.period - (at % source.period),
      );
      expect(offGrid).toBeLessThan(0.05);
    }
    expect(conductor.state.locked).toBe(true);
    expect(Math.round(conductor.state.bpm)).toBe(120);
  });

  test("fires nothing until it has found the beat, and nothing when disarmed", () => {
    const source = fakeAnalyser(128);
    const conductor = new LiveConductor(source.node, {
      density: 1,
      followColors: false,
    });
    // The first second cannot contain a locked grid.
    for (let frame = 0; frame < 40; frame++) {
      expect(conductor.update(source.time, PRESETS[0])).toEqual([]);
      source.advance(FRAME);
    }

    conductor.armed = false;
    for (let frame = 0; frame < 60 * 10; frame++) {
      expect(conductor.update(source.time, PRESETS[0])).toEqual([]);
      source.advance(FRAME);
    }
  });
});
