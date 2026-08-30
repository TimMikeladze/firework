/**
 * Starting points. Each preset is a complete `ShellSpec`, so loading one and
 * dragging a slider is the intended way in — nothing here is special-cased by
 * the renderer.
 */

import { defaultLayer, defaultShell, type ShellSpec } from "./spec";

/**
 * Layer ids are derived from the preset id rather than generated, so the same
 * preset renders identically on the server and the client — the break chart
 * seeds its scatter from the layer id, and a generated id would desync
 * hydration.
 */
function preset(
  id: string,
  name: string,
  spec: Omit<Partial<ShellSpec>, "id" | "name">,
): ShellSpec {
  const shell = defaultShell({ ...spec, id, name });
  return {
    ...shell,
    layers: shell.layers.map((layer, index) => ({
      ...layer,
      id: `${id}/layer-${index + 1}`,
    })),
  };
}

export const PRESETS: readonly ShellSpec[] = [
  preset("preset-golden-peony", "Golden Peony", {
    launch: {
      height: 36,
      tilt: 3,
      fuse: 0.05,
      trailRate: 110,
      trailColor: "#ffb066",
      flash: 0.75,
    },
    layers: [
      defaultLayer({
        name: "Peony",
        pattern: "sphere",
        count: 3200,
        speed: 16,
        life: 2.3,
        size: 0.1,
        colorMode: "fade",
        colorA: "#fff0c2",
        colorB: "#ff5a1e",
        drag: 1.15,
        sparkle: 0.5,
        glitter: 0.25,
        stretch: 0.3,
      }),
    ],
  }),

  preset("preset-blue-willow", "Blue Willow", {
    launch: {
      height: 44,
      tilt: 2,
      fuse: 0.15,
      trailRate: 70,
      trailColor: "#8fd4ff",
      flash: 0.45,
    },
    physics: { gravity: 8.2, drag: 0.25, wind: 1.1, turbulence: 0.22 },
    layers: [
      defaultLayer({
        name: "Willow",
        pattern: "willow",
        count: 2600,
        speed: 11,
        speedJitter: 0.25,
        life: 4.4,
        lifeJitter: 0.35,
        size: 0.085,
        colorMode: "fade",
        colorA: "#d8f4ff",
        colorB: "#1846b8",
        gravity: 1.15,
        drag: 0.55,
        sparkle: 0.3,
        glitter: 0.1,
        stretch: 0.6,
      }),
    ],
    look: { bloom: 1.1, exposure: 1, reflection: 0.7, waves: 0.3, haze: 0.45 },
  }),

  preset("preset-crimson-ring", "Crimson Ring", {
    launch: {
      height: 34,
      tilt: 0,
      fuse: 0.05,
      trailRate: 80,
      trailColor: "#ff8a5c",
      flash: 0.8,
    },
    layers: [
      defaultLayer({
        name: "Ring",
        pattern: "ring",
        count: 2000,
        speed: 19,
        speedJitter: 0.06,
        life: 2,
        size: 0.11,
        colorMode: "solid",
        colorA: "#ff2350",
        colorB: "#ff2350",
        drag: 1.4,
        sparkle: 0.35,
        glitter: 0.15,
        stretch: 0.2,
      }),
      defaultLayer({
        name: "Pistil",
        pattern: "sphere",
        count: 900,
        speed: 6.5,
        life: 1.5,
        size: 0.09,
        colorMode: "solid",
        colorA: "#fff4d0",
        colorB: "#fff4d0",
        drag: 1.6,
        sparkle: 0.8,
        glitter: 0.5,
        stretch: 0.1,
      }),
    ],
  }),

  preset("preset-palm-gold", "Gold Palm", {
    launch: {
      height: 30,
      tilt: 5,
      fuse: 0,
      trailRate: 140,
      trailColor: "#ffcf8a",
      flash: 0.9,
    },
    layers: [
      defaultLayer({
        name: "Fronds",
        pattern: "palm",
        count: 1500,
        speed: 21,
        speedJitter: 0.12,
        life: 3.2,
        lifeJitter: 0.25,
        size: 0.16,
        colorMode: "fade",
        colorA: "#fff2cc",
        colorB: "#ff7a12",
        gravity: 1.1,
        drag: 0.5,
        sparkle: 0.25,
        glitter: 0.55,
        stretch: 0.75,
      }),
    ],
    look: { bloom: 1.25, exposure: 1, reflection: 0.6, waves: 0.5, haze: 0.5 },
  }),

  preset("preset-emerald-crossette", "Emerald Crossette", {
    launch: {
      height: 38,
      tilt: 3,
      fuse: 0.05,
      trailRate: 85,
      trailColor: "#a8ffcc",
      flash: 0.6,
    },
    layers: [
      defaultLayer({
        name: "Break",
        pattern: "crossette",
        count: 1800,
        speed: 15,
        life: 1.4,
        size: 0.1,
        colorMode: "solid",
        colorA: "#22ff88",
        colorB: "#22ff88",
        drag: 1.3,
        sparkle: 0.3,
        glitter: 0.2,
        stretch: 0.35,
      }),
      defaultLayer({
        name: "Split",
        pattern: "crossette",
        count: 2600,
        speed: 9,
        delay: 1.15,
        startRadius: 9,
        life: 1.5,
        size: 0.08,
        colorMode: "fade",
        colorA: "#ffffff",
        colorB: "#0bd06a",
        drag: 1.5,
        sparkle: 0.7,
        glitter: 0.8,
        stretch: 0.2,
        inherit: 0,
      }),
    ],
  }),

  preset("preset-heart", "Heartstring", {
    launch: {
      height: 32,
      tilt: 0,
      fuse: 0.05,
      trailRate: 70,
      trailColor: "#ffb3d9",
      flash: 0.5,
    },
    layers: [
      defaultLayer({
        name: "Heart",
        pattern: "heart",
        count: 2200,
        speed: 17,
        speedJitter: 0.05,
        life: 2.4,
        size: 0.1,
        colorMode: "bicolor",
        colorA: "#ff4f9a",
        colorB: "#fff0f6",
        drag: 1.5,
        sparkle: 0.4,
        glitter: 0.25,
        stretch: 0.2,
      }),
    ],
  }),

  preset("preset-silver-strobe", "Silver Strobe", {
    launch: {
      height: 40,
      tilt: 2,
      fuse: 0.1,
      trailRate: 60,
      trailColor: "#dfe9ff",
      flash: 0.85,
    },
    physics: { gravity: 6.4, drag: 0.6, wind: 0.4, turbulence: 0.5 },
    layers: [
      defaultLayer({
        name: "Strobes",
        pattern: "strobe",
        count: 900,
        speed: 13,
        speedJitter: 0.4,
        life: 3.6,
        lifeJitter: 0.5,
        size: 0.2,
        colorMode: "solid",
        colorA: "#eaf2ff",
        colorB: "#eaf2ff",
        gravity: 0.35,
        drag: 2.2,
        sparkle: 1,
        glitter: 1,
        stretch: 0,
      }),
    ],
    look: { bloom: 1.4, exposure: 1, reflection: 0.5, waves: 0.6, haze: 0.35 },
  }),

  preset("preset-sapphire-rings", "Sapphire Rings", {
    launch: {
      height: 42,
      tilt: 2,
      fuse: 0.08,
      trailRate: 90,
      trailColor: "#9ec7ff",
      flash: 0.7,
    },
    layers: [
      defaultLayer({
        name: "Rings",
        pattern: "double-ring",
        count: 2600,
        speed: 20,
        speedJitter: 0.07,
        life: 2.2,
        size: 0.1,
        colorMode: "bicolor",
        colorA: "#3a7bff",
        colorB: "#ffffff",
        drag: 1.35,
        sparkle: 0.35,
        glitter: 0.2,
        stretch: 0.25,
      }),
      defaultLayer({
        name: "Core",
        pattern: "sphere",
        count: 1200,
        speed: 7,
        delay: 0.35,
        life: 1.8,
        size: 0.09,
        colorMode: "fade",
        colorA: "#ffffff",
        colorB: "#1b3fd8",
        drag: 1.7,
        sparkle: 0.6,
        glitter: 0.45,
        stretch: 0.15,
        inherit: 0,
      }),
    ],
  }),

  preset("preset-spiral-nebula", "Spiral Nebula", {
    launch: {
      height: 38,
      tilt: 6,
      fuse: 0.05,
      trailRate: 100,
      trailColor: "#ffd6ff",
      flash: 0.6,
    },
    physics: { gravity: 8.6, drag: 0.4, wind: 1.6, turbulence: 0.85 },
    layers: [
      defaultLayer({
        name: "Spiral",
        pattern: "spiral",
        count: 3000,
        speed: 15,
        speedJitter: 0.1,
        life: 2.8,
        size: 0.095,
        colorMode: "rainbow",
        drag: 1.1,
        sparkle: 0.45,
        glitter: 0.3,
        stretch: 0.45,
        spin: 3.2,
      }),
    ],
    look: {
      bloom: 1.2,
      exposure: 1.05,
      reflection: 0.65,
      waves: 0.35,
      haze: 0.4,
    },
  }),

  preset("preset-chrysanthemum", "Chrysanthemum Rain", {
    launch: {
      height: 46,
      tilt: 3,
      fuse: 0.12,
      trailRate: 120,
      trailColor: "#ffc178",
      flash: 1,
    },
    layers: [
      defaultLayer({
        name: "Break",
        pattern: "sphere",
        count: 4200,
        speed: 18,
        speedJitter: 0.22,
        life: 3.4,
        lifeJitter: 0.4,
        size: 0.11,
        colorMode: "fade",
        colorA: "#ffffff",
        colorB: "#ff7b1c",
        gravity: 1.25,
        drag: 0.75,
        sparkle: 0.55,
        glitter: 0.6,
        stretch: 0.7,
      }),
      defaultLayer({
        name: "Tail",
        pattern: "sphere",
        count: 1400,
        speed: 6,
        delay: 0.5,
        life: 3.8,
        size: 0.07,
        colorMode: "fade",
        colorA: "#ffd9a0",
        colorB: "#5a1500",
        gravity: 1.4,
        drag: 0.4,
        sparkle: 0.8,
        glitter: 0.9,
        stretch: 0.55,
        inherit: 0,
      }),
    ],
    look: { bloom: 1.15, exposure: 1, reflection: 0.6, waves: 0.7, haze: 0.55 },
  }),
];

export function presetById(id: string): ShellSpec | undefined {
  return PRESETS.find((preset) => preset.id === id);
}
