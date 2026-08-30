/**
 * The dice button. Random shells are only fun if they are plausible, so this
 * samples from curated palettes and pattern-appropriate physics rather than
 * from the raw slider ranges.
 */

import {
  type BurstLayer,
  type BurstPattern,
  defaultLayer,
  defaultShell,
  makeId,
  type ShellSpec,
} from "./spec";

/** Named the way a pyrotechnician would, so the generated names read well. */
const PALETTES: readonly { name: string; a: string; b: string }[] = [
  { name: "Gold", a: "#fff0c2", b: "#ff5a1e" },
  { name: "Ember", a: "#ffd27a", b: "#c41212" },
  { name: "Sapphire", a: "#cfe4ff", b: "#1440d0" },
  { name: "Emerald", a: "#d6ffe8", b: "#0bb45c" },
  { name: "Amethyst", a: "#f0d4ff", b: "#7a1ee0" },
  { name: "Rose", a: "#ffd9ea", b: "#ff2f7a" },
  { name: "Silver", a: "#ffffff", b: "#9fb6d8" },
  { name: "Aqua", a: "#d9ffff", b: "#00b4c8" },
  { name: "Sunset", a: "#fff2a8", b: "#ff2f00" },
  { name: "Ultraviolet", a: "#e6e0ff", b: "#3a10a8" },
];

const SHAPES: readonly { name: string; pattern: BurstPattern }[] = [
  { name: "Peony", pattern: "sphere" },
  { name: "Ring", pattern: "ring" },
  { name: "Rings", pattern: "double-ring" },
  { name: "Palm", pattern: "palm" },
  { name: "Willow", pattern: "willow" },
  { name: "Crossette", pattern: "crossette" },
  { name: "Star", pattern: "star" },
  { name: "Heart", pattern: "heart" },
  { name: "Spiral", pattern: "spiral" },
  { name: "Strobe", pattern: "strobe" },
];

const pick = <T>(items: readonly T[]): T =>
  items[Math.floor(Math.random() * items.length)];
const range = (min: number, max: number) => min + Math.random() * (max - min);

/** Physics that suit each shape, so a willow droops and a ring holds its edge. */
function tuneForPattern(layer: BurstLayer, pattern: BurstPattern): BurstLayer {
  switch (pattern) {
    case "willow":
      return {
        ...layer,
        speed: range(9, 14),
        life: range(3.4, 5),
        gravity: 1.2,
        drag: range(0.4, 0.7),
        stretch: range(0.5, 0.8),
      };
    case "ring":
    case "double-ring":
    case "star":
    case "heart":
      return {
        ...layer,
        speedJitter: range(0.03, 0.1),
        drag: range(1.2, 1.7),
        life: range(1.8, 2.6),
      };
    case "palm":
      return {
        ...layer,
        count: Math.round(range(900, 1800)),
        size: range(0.13, 0.19),
        glitter: range(0.4, 0.8),
        stretch: range(0.6, 0.85),
      };
    case "strobe":
      return {
        ...layer,
        count: Math.round(range(600, 1200)),
        size: range(0.16, 0.24),
        sparkle: 1,
        glitter: range(0.7, 1),
        gravity: range(0.2, 0.5),
        drag: range(1.8, 2.6),
        stretch: 0,
      };
    case "spiral":
      return { ...layer, spin: range(2, 5), stretch: range(0.35, 0.6) };
    default:
      return layer;
  }
}

export function randomShell(): ShellSpec {
  const palette = pick(PALETTES);
  const shape = pick(SHAPES);
  const rainbow = Math.random() < 0.12;

  const primary = tuneForPattern(
    defaultLayer({
      name: shape.name,
      pattern: shape.pattern,
      count: Math.round(range(1600, 3600)),
      speed: range(12, 22),
      speedJitter: range(0.08, 0.28),
      life: range(1.8, 3),
      lifeJitter: range(0.15, 0.4),
      size: range(0.08, 0.13),
      colorMode: rainbow
        ? "rainbow"
        : pick(["fade", "fade", "solid", "bicolor"] as const),
      colorA: palette.a,
      colorB: palette.b,
      drag: range(0.8, 1.5),
      sparkle: range(0.2, 0.7),
      glitter: range(0.1, 0.6),
      stretch: range(0.15, 0.55),
    }),
    shape.pattern,
  );

  const layers: BurstLayer[] = [primary];

  // Roughly half of real shells have a second break; a delayed inner layer is
  // the cheapest way to make a design look designed.
  if (Math.random() < 0.55) {
    const secondPalette = Math.random() < 0.6 ? palette : pick(PALETTES);
    layers.push(
      defaultLayer({
        name: Math.random() < 0.5 ? "Pistil" : "Second break",
        pattern: pick(["sphere", "crossette", "ring"] as const),
        count: Math.round(range(700, 1800)),
        speed: range(5, 11),
        delay: range(0.25, 1.2),
        startRadius: Math.random() < 0.4 ? range(4, 10) : 0,
        life: range(1.2, 2.4),
        size: range(0.07, 0.1),
        colorMode: "fade",
        colorA: "#ffffff",
        colorB: secondPalette.b,
        drag: range(1.2, 1.9),
        sparkle: range(0.4, 0.9),
        glitter: range(0.3, 0.9),
        stretch: range(0.1, 0.3),
        inherit: 0,
      }),
    );
  }

  return defaultShell({
    id: makeId("shell"),
    name: `${palette.name} ${shape.name}`,
    launch: {
      height: range(28, 48),
      tilt: range(-6, 6),
      fuse: range(-0.05, 0.2),
      trailRate: range(60, 140),
      trailColor: palette.a,
      flash: range(0.4, 1),
    },
    layers,
    physics: {
      gravity: range(7.5, 10.5),
      drag: range(0.2, 0.5),
      wind: range(-1.5, 1.5),
      turbulence: range(0.15, 0.7),
    },
    look: {
      bloom: range(0.9, 1.35),
      exposure: 1,
      reflection: range(0.4, 0.75),
      haze: range(0.25, 0.6),
    },
    audio: { enabled: true, boom: range(0.5, 0.85), crackle: range(0.3, 0.7) },
  });
}
