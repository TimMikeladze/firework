/**
 * The choreographer: an analysed track in, a firing script out.
 *
 * A cue is a *break* time, not a launch time. The renderer launches each shell
 * `shellRiseTime()` seconds early so the flower opens on the beat rather than
 * the mortar firing on it — the eye reads the break, so that is what has to be
 * in time.
 *
 * Everything here is pure and seeded: the same track, shell, and settings
 * always produce the same show, which is what makes it testable and what lets
 * the timeline draw the script before a note of it has played.
 */

import type { AnalysisResult, Section, SectionKind } from "@/audio/analysis";
import { sectionAt } from "@/audio/analysis";
import {
  type BurstLayer,
  type BurstPattern,
  defaultLayer,
  type ShellSpec,
  shellRiseTime,
} from "./spec";

export type CueKind = "beat" | "accent" | "sweep" | "finale";

export interface Cue {
  /** Song time in seconds at which this shell should break. */
  at: number;
  /** Song time at which it has to leave the mortar to break on time. */
  launchAt: number;
  spec: ShellSpec;
  x: number;
  z: number;
  /** 0..1 — onset strength this cue was cut from. The timeline draws it. */
  strength: number;
  kind: CueKind;
}

export interface ShowOptions {
  /** 0..1 — how much of the track gets a shell. */
  density: number;
  /** Keep the edited shell's palette instead of colouring by section. */
  followColors: boolean;
  /** Any integer; the same seed replays the same show. */
  seed?: number;
}

export interface ShowPlan {
  cues: Cue[];
  bpm: number;
  /** Seconds per beat. */
  beat: number;
  /** Offset of the beat grid from song start, in seconds. */
  phase: number;
  duration: number;
  sections: Section[];
  /** Sparks the whole script asks for. */
  stars: number;
}

/**
 * Sparks allowed alive at once. The renderer's pool holds 180k, so this leaves
 * room for rising trails, flashes, and the water mirror on top of the script.
 */
export const SHOW_STAR_BUDGET = 110_000;

/** Beats between shells, per section, before the density slider scales it. */
const GAP_BEATS: Record<SectionKind, number> = {
  intro: 4,
  verse: 2,
  build: 1.5,
  chorus: 1,
  drop: 0.75,
  outro: 3,
};

/**
 * What breaks where in the spectrum. A kick belongs to a wide, low peony; a
 * hi-hat to a small, high crossette. `bandTilt` is the split the analysis
 * already computed, so this is a lookup rather than another pass over the audio.
 */
const PATTERNS_BY_BAND: Record<
  SectionKind,
  { low: BurstPattern[]; mid: BurstPattern[]; high: BurstPattern[] }
> = {
  intro: {
    low: ["palm", "willow"],
    mid: ["ring", "sphere"],
    high: ["star", "strobe"],
  },
  verse: {
    low: ["sphere", "palm"],
    mid: ["ring", "star"],
    high: ["star", "crossette"],
  },
  build: {
    low: ["sphere", "spiral"],
    mid: ["spiral", "cone"],
    high: ["crossette", "strobe"],
  },
  chorus: {
    low: ["sphere", "palm"],
    mid: ["double-ring", "heart"],
    high: ["crossette", "star"],
  },
  drop: {
    low: ["sphere", "double-ring"],
    mid: ["crossette", "spiral"],
    high: ["strobe", "crossette"],
  },
  outro: {
    low: ["willow", "palm"],
    mid: ["ring", "willow"],
    high: ["star", "strobe"],
  },
};

/**
 * The energy ladder the analysis segments a track with, reused live: the
 * conductor has no future to look at, so it names the moment it is in from the
 * same thresholds and gets the same treatment for it.
 */
export function kindForIntensity(norm: number): SectionKind {
  if (norm > 0.85) return "drop";
  if (norm > 0.66) return "chorus";
  if (norm > 0.48) return "build";
  if (norm > 0.28) return "verse";
  return "intro";
}

/** Beats between shells at a given energy, before the density slider. */
export function gapBeatsFor(kind: SectionKind): number {
  return GAP_BEATS[kind];
}

/** Section palettes, used unless the show is following the edited shell. */
const PALETTES: Record<SectionKind, [string, string]> = {
  intro: ["#cfe4ff", "#1440d0"],
  verse: ["#d6ffe8", "#0bb45c"],
  build: ["#f0d4ff", "#7a1ee0"],
  chorus: ["#fff0c2", "#ff5a1e"],
  drop: ["#ffd9ea", "#ff2f7a"],
  outro: ["#fff2a8", "#ff8a1e"],
};

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

/** mulberry32 — small, fast, and good enough to place shells with. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

function hexToRgb(hex: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return [1, 1, 1];
  const value = Number.parseInt(match[1], 16);
  return [
    ((value >> 16) & 0xff) / 255,
    ((value >> 8) & 0xff) / 255,
    (value & 0xff) / 255,
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  const channel = (v: number) =>
    Math.round(clamp(v, 0, 1) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/**
 * Rotates a colour's hue while keeping its saturation and lightness, so a
 * section can drift the palette without losing the shell's character.
 */
export function shiftHue(hex: string, degrees: number): string {
  const [r, g, b] = hexToRgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-6) return hex;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  h = (h + degrees / 360 + 1) % 1;

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const toChannel = (t: number) => {
    const v = (t + 1) % 1;
    if (v < 1 / 6) return p + (q - p) * 6 * v;
    if (v < 1 / 2) return q;
    if (v < 2 / 3) return p + (q - p) * (2 / 3 - v) * 6;
    return p;
  };
  return rgbToHex(toChannel(h + 1 / 3), toChannel(h), toChannel(h - 1 / 3));
}

/**
 * The beat grid's offset from song start.
 *
 * Onset times are wrapped onto one beat and averaged as angles, weighted by
 * strength: the resulting circular mean is the phase the loudest hits sit on,
 * which is where quantisation should pull everything to.
 */
export function beatPhase(
  onsets: readonly number[],
  strengths: readonly number[],
  beat: number,
): number {
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < onsets.length; i++) {
    const angle = (2 * Math.PI * (onsets[i] % beat)) / beat;
    const weight = strengths[i] ?? 0.5;
    sx += Math.cos(angle) * weight;
    sy += Math.sin(angle) * weight;
  }
  if (sx === 0 && sy === 0) return 0;
  const phase = (Math.atan2(sy, sx) / (2 * Math.PI)) * beat;
  return ((phase % beat) + beat) % beat;
}

/* ------------------------------------------------------------------ */
/* Shell design                                                        */
/* ------------------------------------------------------------------ */

export interface CueFeatures {
  strength: number;
  /** 0..1 — spectral tilt: 0 is all bass, 1 is all cymbal. */
  tilt: number;
  section: Section;
  downbeat: boolean;
  kind: CueKind;
}

function pickPattern(features: CueFeatures, random: () => number) {
  const pools = PATTERNS_BY_BAND[features.section.kind];
  const pool =
    features.tilt < 0.38
      ? pools.low
      : features.tilt > 0.62
        ? pools.high
        : pools.mid;
  return pool[Math.floor(random() * pool.length) % pool.length];
}

/** Physics that suit each shape, mirroring what the dice button does. */
function tuneForPattern(layer: BurstLayer, pattern: BurstPattern): BurstLayer {
  switch (pattern) {
    case "willow":
      return {
        ...layer,
        life: layer.life * 1.8,
        speed: layer.speed * 0.75,
        gravity: 1.2,
        drag: 0.6,
        stretch: 0.7,
      };
    case "palm":
      return { ...layer, life: layer.life * 1.3, stretch: 0.55, drag: 0.8 };
    case "ring":
    case "double-ring":
      return { ...layer, speedJitter: 0.05, drag: 1.35, stretch: 0.2 };
    case "strobe":
      return {
        ...layer,
        life: layer.life * 1.25,
        gravity: 0.35,
        drag: 2.2,
        glitter: 0.9,
        sparkle: 0.9,
      };
    case "crossette":
      return { ...layer, drag: 1.4, glitter: 0.45, life: layer.life * 0.95 };
    case "spiral":
      return { ...layer, spin: 3.5, drag: 1.1 };
    case "heart":
    case "star":
      return { ...layer, speedJitter: 0.06, drag: 1.3 };
    default:
      return layer;
  }
}

/**
 * Builds the shell one cue fires.
 *
 * The edited shell stays the anchor: its night air, camera, and — when the show
 * follows its colours — its palette carry through, so the script always looks
 * like a show of *that* shell rather than a stock demo playing over the top.
 */
export function designShell(
  base: ShellSpec,
  features: CueFeatures,
  index: number,
  options: ShowOptions,
  random: () => number,
): ShellSpec {
  const { strength, tilt, section, downbeat } = features;
  const intensity = section.intensity;
  const pattern = pickPattern(features, random);
  const lead = base.layers.find((layer) => layer.enabled) ?? base.layers[0];

  // Bright hits ride high and tight; bass hits break low and wide. Heights are
  // scaled from the edited shell rather than absolute, so the script stays
  // inside the framing the user set up their own shell for.
  const height = clamp(
    base.launch.height *
      (0.62 +
        tilt * 0.45 +
        strength * 0.3 +
        intensity * 0.12 +
        (downbeat ? 0.05 : 0)),
    12,
    80,
  );
  const speed = clamp(7 + strength * 9 + (1 - tilt) * 7, 4, 34);
  const life = clamp(1.0 + strength * 1.5 + (1 - tilt) * 0.9, 0.8, 4);

  const [paletteA, paletteB] = PALETTES[section.kind];
  const drift = index * 7 + (section.kind === "drop" ? 40 : 0);
  const colorA = options.followColors
    ? shiftHue(lead.colorA, ((drift % 60) - 30) * 0.6)
    : shiftHue(paletteA, ((drift % 40) - 20) * 0.5);
  const colorB = options.followColors
    ? shiftHue(lead.colorB, ((drift % 80) - 40) * 0.5)
    : shiftHue(paletteB, ((drift % 60) - 30) * 0.5);

  const main = tuneForPattern(
    defaultLayer({
      id: `cue-${index}-main`,
      name: pattern,
      pattern,
      count: Math.round(600 + strength * 2200 + intensity * 900),
      speed,
      speedJitter: 0.12 + strength * 0.14,
      life,
      lifeJitter: 0.25,
      size: clamp(0.065 + strength * 0.055 + (1 - tilt) * 0.02, 0.05, 0.16),
      colorMode: lead.colorMode,
      colorA,
      colorB,
      drag: lead.drag,
      sparkle: lead.sparkle,
      glitter: lead.glitter,
      stretch: lead.stretch,
      inherit: 0.12,
    }),
    pattern,
  );

  const layers: BurstLayer[] = [main];

  // A pistil for anything that reads as an accent: a second, slower core in the
  // contrasting colour is what makes a big break look designed rather than big.
  if (strength > 0.6 || downbeat) {
    layers.push(
      defaultLayer({
        id: `cue-${index}-pistil`,
        name: "Pistil",
        pattern: "sphere",
        count: Math.round(main.count * 0.32),
        speed: main.speed * 0.42,
        life: main.life * 0.7,
        size: main.size * 0.85,
        colorMode: "solid",
        colorA: colorB,
        colorB: colorA,
        delay: 0.05,
        drag: main.drag * 1.2,
        sparkle: 0.6,
        glitter: 0.3,
        inherit: 0.1,
      }),
    );
  }

  // The loudest hits of the loudest sections get a delayed ring on top, which
  // is the shell equivalent of a cymbal crash.
  if (
    strength > 0.82 &&
    (section.kind === "drop" || section.kind === "chorus")
  ) {
    layers.push(
      defaultLayer({
        id: `cue-${index}-crown`,
        name: "Crown",
        pattern: "crossette",
        count: Math.round(main.count * 0.45),
        speed: main.speed * 1.25,
        life: main.life * 0.8,
        size: main.size * 0.8,
        colorMode: "fade",
        colorA: shiftHue(colorA, 30),
        colorB: colorB,
        delay: 0.32,
        startRadius: 1.2,
        glitter: 0.6,
        stretch: 0.4,
        inherit: 0.1,
      }),
    );
  }

  return {
    ...base,
    id: `cue-${index}`,
    name: `${section.kind} ${pattern}`,
    launch: {
      ...base.launch,
      height,
      tilt: (random() - 0.5) * 8,
      // The break is scheduled, so the fuse stays at apex and the schedule does
      // the timing. Anything else fights the cue clock.
      fuse: 0,
      trailRate: Math.round(40 + strength * 120),
      trailColor: colorA,
      flash: clamp(0.35 + strength * 0.6, 0, 1),
    },
    layers,
    // Under music the reports are punctuation, not the show — the track has to
    // stay audible through a barrage.
    audio: {
      ...base.audio,
      boom: base.audio.boom * clamp(0.25 + strength * 0.45, 0, 1),
      crackle: base.audio.crackle * 0.45,
    },
  };
}

/* ------------------------------------------------------------------ */
/* The script                                                          */
/* ------------------------------------------------------------------ */

/** Live-spark bookkeeping so a dense passage cannot outrun the pool. */
class StarBudget {
  private live: { until: number; count: number }[] = [];
  private sum = 0;

  /** Sparks still burning at `time`. */
  at(time: number): number {
    while (this.live.length && this.live[0].until <= time) {
      this.sum -= this.live[0].count;
      this.live.shift();
    }
    return this.sum;
  }

  add(time: number, count: number, life: number): void {
    this.at(time);
    this.sum += count;
    this.live.push({ until: time + life, count });
    this.live.sort((a, b) => a.until - b.until);
  }
}

function specStars(spec: ShellSpec): number {
  return spec.layers.reduce(
    (total, layer) => (layer.enabled ? total + layer.count : total),
    0,
  );
}

function specLife(spec: ShellSpec): number {
  let last = 0.6;
  for (const layer of spec.layers) {
    if (!layer.enabled) continue;
    last = Math.max(last, layer.delay + layer.life * (1 + layer.lifeJitter));
  }
  return last;
}

/** Scales every layer down in place when the budget cannot fit the shell. */
function scaleStars(spec: ShellSpec, factor: number): ShellSpec {
  return {
    ...spec,
    layers: spec.layers.map((layer) => ({
      ...layer,
      count: Math.max(120, Math.round(layer.count * factor)),
    })),
  };
}

function makeCue(
  spec: ShellSpec,
  at: number,
  x: number,
  z: number,
  strength: number,
  kind: CueKind,
): Cue {
  return { at, launchAt: at - shellRiseTime(spec), spec, x, z, strength, kind };
}

/**
 * Cuts an analysed track into a firing script.
 *
 * Selection is a per-section budget rather than a fixed rate: a verse gets a
 * shell every couple of beats, a drop gets one on nearly every onset, and an
 * accent loud enough to stand out is allowed to break the gap. Section changes
 * get a sweep across the water, and the last bars get a finale, because those
 * are the two moments an audience expects the show to acknowledge.
 */
export function buildShow(
  analysis: AnalysisResult,
  base: ShellSpec,
  options: ShowOptions,
): ShowPlan {
  const random = rng(options.seed ?? 0x5eed);
  const density = clamp(options.density, 0, 1);
  const bpm = clamp(analysis.bpm || 120, 40, 220);
  const beat = 60 / bpm;
  const phase = beatPhase(analysis.onsets, analysis.strengths, beat);
  const sections = analysis.sections.length
    ? analysis.sections
    : [{ time: 0, kind: "verse" as SectionKind, intensity: 0.5 }];

  // Bars are anchored on the strongest onset in the opening, so downbeats line
  // up with what the track itself accents.
  let anchor = 0;
  let anchorStrength = -1;
  for (let i = 0; i < analysis.onsets.length; i++) {
    if (analysis.onsets[i] > 30) break;
    if (analysis.strengths[i] > anchorStrength) {
      anchorStrength = analysis.strengths[i];
      anchor = analysis.onsets[i];
    }
  }
  const anchorBeat = Math.round((anchor - phase) / beat);

  const budget = new StarBudget();
  const cues: Cue[] = [];
  let index = 0;
  let lastAt = Number.NEGATIVE_INFINITY;
  let side = 1;

  const push = (
    at: number,
    features: CueFeatures,
    position: { x: number; z: number },
  ) => {
    let spec = designShell(base, features, index, options, random);
    const rise = shellRiseTime(spec);
    // A shell that would have to launch before the track started cannot break
    // on time, so the opening bar simply stays empty.
    if (at - rise < 0) return;

    const life = specLife(spec);
    const live = budget.at(at);
    const wanted = specStars(spec);
    if (live + wanted > SHOW_STAR_BUDGET) {
      const room = Math.max(0, SHOW_STAR_BUDGET - live);
      if (room < 400 && features.strength < 0.75) return;
      spec = scaleStars(spec, Math.max(0.12, room / Math.max(1, wanted)));
    }
    budget.add(at, specStars(spec), life);
    cues.push(
      makeCue(
        spec,
        at,
        position.x,
        position.z,
        features.strength,
        features.kind,
      ),
    );
    index++;
    lastAt = at;
  };

  for (let i = 0; i < analysis.onsets.length; i++) {
    const raw = analysis.onsets[i];
    const strength = clamp(analysis.strengths[i] ?? 0.5, 0, 1);
    const tilt = clamp(analysis.bandTilt[i] ?? 0.5, 0, 1);
    const section = sectionAt(sections, raw);

    // Snap to the grid when the detector landed within a hair of a beat: the
    // onset is the truth, but a break reads as "on the beat" or it doesn't.
    const beats = Math.round((raw - phase) / beat);
    const gridded = phase + beats * beat;
    const at = Math.abs(gridded - raw) < 0.045 ? gridded : raw;

    const gap =
      GAP_BEATS[section.kind] * beat * (2.3 - density * 1.9) -
      strength * beat * 0.35;
    const accent = strength > 0.8;
    if (at - lastAt < (accent ? gap * 0.45 : gap)) continue;

    const downbeat = (((beats - anchorBeat) % 4) + 4) % 4 === 0;
    side = -side;
    const spread = 8 + tilt * 24 + random() * 8;
    push(
      at,
      {
        strength,
        tilt,
        section,
        downbeat,
        kind: accent || downbeat ? "accent" : "beat",
      },
      {
        x: side * spread * (downbeat ? 0.5 : 0.85),
        z: (random() - 0.5) * 34 * (1 - strength * 0.35),
      },
    );
  }

  addSweeps(analysis, sections, beat, random, push);
  addFinale(analysis, sections, beat, push, random);

  cues.sort((a, b) => a.at - b.at || a.x - b.x);
  return {
    cues,
    bpm,
    beat,
    phase,
    duration: analysis.duration,
    sections,
    stars: cues.reduce((total, cue) => total + specStars(cue.spec), 0),
  };
}

type PushCue = (
  at: number,
  features: CueFeatures,
  position: { x: number; z: number },
) => void;

/**
 * A fan of shells walking across the water whenever the track steps up a
 * section — the visual equivalent of the drums coming in.
 */
function addSweeps(
  analysis: AnalysisResult,
  sections: Section[],
  beat: number,
  random: () => number,
  push: PushCue,
): void {
  const rank: Record<SectionKind, number> = {
    intro: 0,
    outro: 0,
    verse: 1,
    build: 2,
    chorus: 3,
    drop: 4,
  };

  for (let i = 1; i < sections.length; i++) {
    const section = sections[i];
    const previous = sections[i - 1];
    if (rank[section.kind] <= rank[previous.kind]) continue;
    if (section.time > analysis.duration - 1) continue;

    const shells = section.kind === "drop" ? 6 : 4;
    for (let s = 0; s < shells; s++) {
      const at = section.time + s * beat * 0.5;
      if (at > analysis.duration) break;
      const across = (s / Math.max(1, shells - 1)) * 2 - 1;
      push(
        at,
        {
          strength: 0.55 + section.intensity * 0.35,
          tilt: 0.3 + (s / shells) * 0.5,
          section,
          downbeat: s === 0,
          kind: "sweep",
        },
        { x: across * 30, z: -6 + random() * 18 },
      );
    }
  }
}

/** The last bars: everything the budget will still allow, fanned wide. */
function addFinale(
  analysis: AnalysisResult,
  sections: Section[],
  beat: number,
  push: PushCue,
  random: () => number,
): void {
  const end = analysis.duration;
  if (end < 8) return;
  const start = end - beat * 6;
  const section = sectionAt(sections, start);
  const shells = 10;

  for (let s = 0; s < shells; s++) {
    const at = start + (s / shells) * beat * 5.5;
    push(
      at,
      {
        strength: 0.7 + (s / shells) * 0.3,
        tilt: s % 3 === 0 ? 0.25 : 0.55 + (s % 5) * 0.08,
        section,
        downbeat: s % 3 === 0,
        kind: "finale",
      },
      {
        x: (s % 2 === 0 ? -1 : 1) * (10 + (s / shells) * 30),
        z: (random() - 0.5) * 30,
      },
    );
  }
}

/** Headline numbers for the deck: how busy the script actually is. */
export function showSummary(plan: ShowPlan): {
  shells: number;
  perMinute: number;
  peakStars: number;
} {
  const perMinute = plan.duration ? (plan.cues.length / plan.duration) * 60 : 0;
  let peak = 0;
  const budget = new StarBudget();
  for (const cue of plan.cues) {
    const stars = specStars(cue.spec);
    budget.add(cue.at, stars, specLife(cue.spec));
    peak = Math.max(peak, budget.at(cue.at));
  }
  return {
    shells: plan.cues.length,
    perMinute: Math.round(perMinute),
    peakStars: peak,
  };
}
