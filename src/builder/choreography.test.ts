import { describe, expect, test } from "bun:test";
import type { AnalysisResult } from "@/audio/analysis";
import {
  beatPhase,
  buildShow,
  SHOW_STAR_BUDGET,
  shiftHue,
  showSummary,
} from "./choreography";
import { PRESETS } from "./presets";
import { shellRiseTime } from "./spec";

const BPM = 120;
const BEAT = 60 / BPM;

/**
 * A synthetic track: a hit on every eighth for two minutes, walking through the
 * section kinds, with the spectral tilt sweeping bass to cymbal so every branch
 * of the pattern table gets exercised.
 */
function fixture(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  const onsets: number[] = [];
  const strengths: number[] = [];
  const bandTilt: number[] = [];
  for (let i = 0; i * BEAT * 0.5 < 120; i++) {
    onsets.push(i * BEAT * 0.5);
    strengths.push(i % 8 === 0 ? 0.95 : i % 2 === 0 ? 0.6 : 0.3);
    bandTilt.push((i % 10) / 10);
  }
  return {
    onsets,
    strengths,
    bandTilt,
    bpm: BPM,
    duration: 120,
    sections: [
      { time: 0, kind: "intro", intensity: 0.2 },
      { time: 20, kind: "verse", intensity: 0.45 },
      { time: 45, kind: "build", intensity: 0.7 },
      { time: 60, kind: "chorus", intensity: 0.85 },
      { time: 85, kind: "drop", intensity: 1 },
      { time: 110, kind: "outro", intensity: 0.3 },
    ],
    waveform: new Float32Array(64).fill(0.5),
    ...overrides,
  };
}

const base = PRESETS[0];
const options = { density: 0.55, followColors: true, seed: 7 };

describe("buildShow", () => {
  test("puts every break inside the track, in order", () => {
    const plan = buildShow(fixture(), base, options);
    expect(plan.cues.length).toBeGreaterThan(20);
    for (let i = 0; i < plan.cues.length; i++) {
      const cue = plan.cues[i];
      expect(cue.at).toBeGreaterThan(0);
      expect(cue.at).toBeLessThanOrEqual(plan.duration + 0.01);
      if (i > 0) expect(cue.at).toBeGreaterThanOrEqual(plan.cues[i - 1].at);
    }
  });

  test("launches each shell exactly its rise time before the break", () => {
    const plan = buildShow(fixture(), base, options);
    for (const cue of plan.cues) {
      // This is the whole contract with the renderer: fire at `launchAt` and
      // the flower opens on `at`.
      expect(cue.launchAt).toBeCloseTo(cue.at - shellRiseTime(cue.spec), 6);
      expect(cue.launchAt).toBeGreaterThanOrEqual(0);
    }
  });

  test("never asks for more sparks than the pool can hold", () => {
    const plan = buildShow(fixture(), base, { ...options, density: 1 });
    expect(showSummary(plan).peakStars).toBeLessThanOrEqual(SHOW_STAR_BUDGET);
  });

  test("density decides how much of the track gets a shell", () => {
    const sparse = buildShow(fixture(), base, { ...options, density: 0.1 });
    const dense = buildShow(fixture(), base, { ...options, density: 1 });
    expect(dense.cues.length).toBeGreaterThan(sparse.cues.length * 1.5);
  });

  test("is deterministic for a seed", () => {
    const a = buildShow(fixture(), base, options);
    const b = buildShow(fixture(), base, options);
    expect(
      a.cues.map((cue) => [cue.at, cue.x, cue.spec.layers[0].pattern]),
    ).toEqual(b.cues.map((cue) => [cue.at, cue.x, cue.spec.layers[0].pattern]));
  });

  test("marks section climbs with a sweep and the ending with a finale", () => {
    const plan = buildShow(fixture(), base, options);
    const kinds = new Set(plan.cues.map((cue) => cue.kind));
    expect(kinds.has("sweep")).toBe(true);
    expect(kinds.has("finale")).toBe(true);

    const finale = plan.cues.filter((cue) => cue.kind === "finale");
    for (const cue of finale) {
      expect(cue.at).toBeGreaterThan(plan.duration - BEAT * 7);
    }
    // A sweep walks across the water rather than piling up in one place.
    const sweep = plan.cues.filter((cue) => cue.kind === "sweep");
    const spread =
      Math.max(...sweep.map((cue) => cue.x)) -
      Math.min(...sweep.map((cue) => cue.x));
    expect(spread).toBeGreaterThan(30);
  });

  test("bass breaks low and wide, cymbals break high", () => {
    const bass = buildShow(
      fixture({ bandTilt: new Array(240).fill(0.05) }),
      base,
      options,
    );
    const bright = buildShow(
      fixture({ bandTilt: new Array(240).fill(0.95) }),
      base,
      options,
    );
    const meanHeight = (plan: typeof bass) =>
      plan.cues.reduce((sum, cue) => sum + cue.spec.launch.height, 0) /
      plan.cues.length;
    const meanSpeed = (plan: typeof bass) =>
      plan.cues.reduce((sum, cue) => sum + cue.spec.layers[0].speed, 0) /
      plan.cues.length;

    expect(meanHeight(bright)).toBeGreaterThan(meanHeight(bass));
    expect(meanSpeed(bass)).toBeGreaterThan(meanSpeed(bright));
  });

  test("follows the edited shell's palette when asked to", () => {
    const followed = buildShow(fixture(), base, {
      ...options,
      followColors: true,
    });
    const sectioned = buildShow(fixture(), base, {
      ...options,
      followColors: false,
    });
    const first = (plan: typeof followed) => plan.cues[0].spec.layers[0].colorA;
    expect(first(followed)).not.toBe(first(sectioned));
  });

  test("keeps the reports under the music", () => {
    const plan = buildShow(fixture(), base, options);
    for (const cue of plan.cues) {
      expect(cue.spec.audio.boom).toBeLessThan(base.audio.boom);
    }
  });

  test("survives a track with no usable analysis", () => {
    const empty: AnalysisResult = {
      onsets: [],
      strengths: [],
      bandTilt: [],
      bpm: 0,
      duration: 0,
      sections: [],
      waveform: new Float32Array(0),
    };
    const plan = buildShow(empty, base, options);
    expect(plan.cues).toEqual([]);
    expect(plan.bpm).toBeGreaterThan(0);
  });
});

describe("beatPhase", () => {
  test("recovers the offset a grid of hits sits on", () => {
    const beat = 0.5;
    const onsets: number[] = [];
    for (let i = 0; i < 64; i++) onsets.push(0.12 + i * beat);
    const strengths = new Array(onsets.length).fill(1);
    expect(beatPhase(onsets, strengths, beat)).toBeCloseTo(0.12, 3);
  });

  test("wraps into the beat, never negative", () => {
    const beat = 0.5;
    const onsets = [0.48, 0.98, 1.48, 1.98];
    const phase = beatPhase(onsets, new Array(4).fill(1), beat);
    expect(phase).toBeGreaterThanOrEqual(0);
    expect(phase).toBeLessThan(beat);
  });
});

describe("shiftHue", () => {
  test("moves the hue but holds the lightness", () => {
    expect(shiftHue("#ff0000", 120)).toBe("#00ff00");
    expect(shiftHue("#ff0000", 360)).toBe("#ff0000");
  });

  test("leaves greys alone", () => {
    expect(shiftHue("#808080", 90)).toBe("#808080");
  });
});
