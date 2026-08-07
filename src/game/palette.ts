import type { Rgb } from "./particles";
import type { SectionKind } from "./types";

/**
 * Palette selection. Two inputs steer color: the song section (slow, structural)
 * and live FFT band energy (fast, per-frame). Section picks the family, band
 * energy picks which member of the family and how hot it burns.
 */

export interface Bands {
  /** 0..1 each. */
  bass: number;
  mid: number;
  high: number;
}

interface Family {
  /** Ordered cool → hot. */
  ramp: Rgb[];
  accent: Rgb;
}

const FAMILIES: Record<SectionKind, Family> = {
  intro: {
    ramp: [
      { r: 90, g: 150, b: 255 },
      { r: 140, g: 200, b: 255 },
      { r: 200, g: 235, b: 255 },
    ],
    accent: { r: 235, g: 245, b: 255 },
  },
  verse: {
    ramp: [
      { r: 90, g: 190, b: 255 },
      { r: 150, g: 130, b: 255 },
      { r: 220, g: 120, b: 240 },
    ],
    accent: { r: 255, g: 210, b: 255 },
  },
  build: {
    ramp: [
      { r: 255, g: 140, b: 90 },
      { r: 255, g: 190, b: 80 },
      { r: 255, g: 235, b: 150 },
    ],
    accent: { r: 255, g: 250, b: 210 },
  },
  chorus: {
    ramp: [
      { r: 255, g: 80, b: 110 },
      { r: 255, g: 150, b: 60 },
      { r: 255, g: 220, b: 120 },
    ],
    accent: { r: 255, g: 240, b: 190 },
  },
  drop: {
    ramp: [
      { r: 255, g: 60, b: 60 },
      { r: 255, g: 120, b: 30 },
      { r: 255, g: 230, b: 120 },
    ],
    accent: { r: 255, g: 255, b: 230 },
  },
  outro: {
    ramp: [
      { r: 70, g: 120, b: 220 },
      { r: 120, g: 160, b: 255 },
      { r: 190, g: 210, b: 255 },
    ],
    accent: { r: 220, g: 235, b: 255 },
  },
};

function lerp(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

/** Samples the section's ramp at position `t` (0..1). */
export function rampColor(kind: SectionKind, t: number): Rgb {
  const ramp = FAMILIES[kind].ramp;
  const clamped = Math.max(0, Math.min(0.9999, t));
  const scaled = clamped * (ramp.length - 1);
  const i = Math.floor(scaled);
  return lerp(ramp[i], ramp[i + 1] ?? ramp[i], scaled - i);
}

export function accentColor(kind: SectionKind): Rgb {
  return FAMILIES[kind].accent;
}

/**
 * Per-hit color. Bass energy pushes toward the warm end of the ramp, highs push
 * toward the cool/sparkle end, and lane index adds a stable offset so each
 * launch tube keeps its own visual identity.
 */
export function hitColor(
  kind: SectionKind,
  bands: Bands,
  lane: number,
  laneCount: number,
): Rgb {
  const laneBias = lane / Math.max(1, laneCount - 1);
  const energy = bands.bass * 0.6 + bands.mid * 0.25 + bands.high * 0.15;
  const t = Math.max(0, Math.min(1, laneBias * 0.55 + energy * 0.45));
  const base = rampColor(kind, t);
  // Highs add a white sparkle lift.
  return lerp(base, accentColor(kind), bands.high * 0.35);
}

/** Lane identity color used for the launch pads and lane guides. */
export function laneColor(
  kind: SectionKind,
  lane: number,
  laneCount: number,
): Rgb {
  return rampColor(kind, lane / Math.max(1, laneCount - 1));
}

export function css(c: Rgb, alpha = 1): string {
  return `rgba(${c.r | 0},${c.g | 0},${c.b | 0},${alpha})`;
}

/* ------------------------------------------------------------------ */
/* Skins                                                               */
/* ------------------------------------------------------------------ */

/**
 * Skins are a post-process on the section palette rather than a separate set of
 * ramps, so every skin automatically inherits the section and band behaviour.
 * `variant` is a stable per-burst value (0..1) used by skins that want each
 * shell to differ.
 */
export function applySkin(skin: string, c: Rgb, variant: number): Rgb {
  switch (skin) {
    case "aurora": {
      // Rotate toward teal/violet and cool the reds down.
      return {
        r: c.r * 0.55 + c.b * 0.25,
        g: c.g * 0.85 + 40,
        b: Math.min(255, c.b * 0.7 + 90),
      };
    }
    case "ember": {
      // Crush greens and blues so everything reads as deep fire.
      return { r: Math.min(255, c.r * 0.9 + 60), g: c.g * 0.5, b: c.b * 0.28 };
    }
    case "prism": {
      // Each shell picks its own hue; the section only controls brightness.
      const lum = (c.r * 0.3 + c.g * 0.5 + c.b * 0.2) / 255;
      const h = variant * Math.PI * 2;
      const wave = (offset: number) => Math.max(0, Math.sin(h + offset)) ** 0.7;
      const scale = 130 + lum * 125;
      return {
        r: 60 + wave(0) * scale,
        g: 60 + wave((Math.PI * 2) / 3) * scale,
        b: 60 + wave((Math.PI * 4) / 3) * scale,
      };
    }
    default:
      return c;
  }
}
