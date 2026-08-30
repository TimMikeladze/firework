/**
 * Renders the still that sits behind the social card.
 *
 * The card's background is not a painting of a firework — it is one frame of
 * the real show, produced by the same emit -> sim -> draw -> bloom -> composite
 * chain the browser runs. This script drives a tiny scripted show (rockets
 * climb, shells break on a schedule), stops the clock on a chosen beat, and
 * writes the frame to `public/og/night.png`.
 *
 *   bun run og            # rewrite the background plate
 *   bun run og --time 2.1 # stop the clock somewhere else
 *
 * `src/app/opengraph-image.tsx` composes the wordmark and the cue rail over the
 * plate at build time, so re-running this is the only way the imagery changes.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveShader } from "@vgpu/wgsl/runtime";
import { PNG } from "pngjs";
import {
  compute,
  draw,
  effect,
  frame,
  init,
  sampler,
  storage,
  target,
} from "vgpu/node";
import { invertInto, lookAt, multiply, perspective } from "./lib/mat4.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const shaderDir = resolve(here, "../src/builder/shaders");
const outPath = resolve(here, "../public/og/night.png");

/** Open Graph's own size. Twitter and LinkedIn both letterbox to 1.91:1. */
const OUT_WIDTH = 1200;
const OUT_HEIGHT = 630;
/** Sparks are point sprites, so the only antialiasing they get is this. */
const SUPERSAMPLE = 2;
const WIDTH = OUT_WIDTH * SUPERSAMPLE;
const HEIGHT = OUT_HEIGHT * SUPERSAMPLE;

const POOL = 80_000;
const WORKGROUP = 64;
const WATER_Y = 0;
const GRAVITY = 9.4;
const DT = 1 / 120;

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

/** When the clock stops. Everything below is authored against this instant. */
const CAPTURE = Number(flag("time", 2.95));

const hex = (value) => {
  const n = Number.parseInt(value.replace("#", ""), 16);
  // The shaders work in linear light; the palette is written in sRGB.
  const toLinear = (c) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  return [
    toLinear(((n >> 16) & 255) / 255),
    toLinear(((n >> 8) & 255) / 255),
    toLinear((n & 255) / 255),
  ];
};

/**
 * The show, as a cue sheet.
 *
 * `breakAt` is when the shell opens, not when it launches — the same contract
 * the renderer's cues use. Rockets are back-solved from it so their trails are
 * the right length when the clock stops.
 */
const CUES = [
  {
    // Furthest back and oldest: a cold shell already spending itself, wide and
    // thin. Its job is depth and colour contrast, not a second focal point.
    name: "Sapphire Peony",
    breakAt: 1.5,
    at: [-58, 46, -72],
    trail: { color: "#9fd8ff", rate: 90 },
    layers: [
      {
        pattern: 0,
        count: 3600,
        colorA: "#e2f2ff",
        colorB: "#2a63d8",
        colorMode: 1,
        speed: 19,
        speedJitter: 0.22,
        life: 3.4,
        lifeJitter: 0.3,
        size: 0.15,
        gravity: 0.8,
        drag: 0.55,
        sparkle: 0.3,
        glitter: 0.5,
        stretch: 0.7,
      },
    ],
  },
  {
    // A red ring, tilted into the camera so it reads as a ring and not a line:
    // a ring lies in the plane normal to its axis, and a vertical axis is
    // exactly edge-on from a camera sitting this close to the water.
    name: "Crimson Ring",
    breakAt: 1.72,
    at: [52, 32, -26],
    trail: { color: "#ff8a5c", rate: 80 },
    layers: [
      {
        pattern: 1,
        count: 2200,
        colorA: "#ff2350",
        colorB: "#ffb08a",
        colorMode: 1,
        speed: 16,
        speedJitter: 0.07,
        life: 2.2,
        size: 0.15,
        gravity: 0.6,
        drag: 1.1,
        sparkle: 0.45,
        glitter: 0.25,
        stretch: 0.3,
        axis: [0.16, 0.62, 0.77],
      },
    ],
  },
  {
    // Small, far, and cold — a depth cue against all the warm light.
    name: "Silver Strobe",
    breakAt: 1.5,
    at: [-24, 46, -145],
    trail: null,
    layers: [
      {
        pattern: 10,
        count: 1100,
        colorA: "#eaf2ff",
        colorB: "#eaf2ff",
        colorMode: 0,
        speed: 13,
        life: 2.4,
        size: 0.2,
        gravity: 0.5,
        drag: 0.9,
        sparkle: 0.9,
        glitter: 0.8,
        stretch: 0.1,
      },
    ],
  },
  {
    // The hero: a golden peony with a white pistil, right of centre and open
    // wide enough that individual stars still read as stars.
    name: "Golden Peony",
    breakAt: 1.86,
    at: [8, 22, -2],
    trail: { color: "#ffb066", rate: 120 },
    layers: [
      {
        pattern: 0,
        count: 6000,
        colorA: "#fff0c2",
        colorB: "#ff5a1e",
        colorMode: 1,
        speed: 23,
        speedJitter: 0.16,
        life: 2.8,
        size: 0.15,
        gravity: 0.8,
        drag: 0.82,
        sparkle: 0.45,
        glitter: 0.4,
        stretch: 0.45,
      },
      {
        pattern: 0,
        count: 1300,
        colorA: "#fff6dc",
        colorB: "#fff6dc",
        colorMode: 0,
        speed: 7.5,
        life: 1.6,
        size: 0.13,
        gravity: 0.6,
        drag: 1.4,
        sparkle: 0.7,
        glitter: 0.25,
        stretch: 0.2,
      },
    ],
  },
  {
    // Still climbing when the shutter closes — the show is mid-sentence.
    name: "Rising",
    breakAt: CAPTURE + 2.2,
    at: [34, 33, 30],
    trail: { color: "#ffc78a", rate: 190 },
    layers: [],
  },
];

async function shader(name) {
  const resolved = await resolveShader({
    entry: resolve(shaderDir, `${name}.wgsl`),
    validate: "require",
  });
  return { version: 1, wgsl: resolved.wgsl };
}

const gpu = await init();
const [emitSrc, simSrc, sparksSrc, skySrc, brightSrc, blurSrc, compositeSrc] =
  await Promise.all([
    shader("emit"),
    shader("sim"),
    shader("sparks"),
    shader("sky"),
    shader("bright"),
    shader("blur"),
    shader("composite"),
  ]);

const particles = storage(gpu, POOL * 96);
const linear = sampler(gpu, { minFilter: "linear", magFilter: "linear" });
const hdr = "rgba16float";
const scene = target(gpu, { size: [WIDTH, HEIGHT], format: hdr });
const bloomA = target(gpu, { size: [WIDTH >> 1, HEIGHT >> 1], format: hdr });
const bloomB = target(gpu, { size: [WIDTH >> 1, HEIGHT >> 1], format: hdr });
const mirror = target(gpu, { size: [WIDTH, HEIGHT], format: hdr });
const output = target(gpu, { size: [WIDTH, HEIGHT], format: "rgba8unorm" });

// Matches the builder's default camera, so the plate is framed the way the app
// frames itself the moment it loads.
const eye = [0, 7, 88];
const view = lookAt(eye, [0, 1, 0], [0, 1, 0]);
const viewProj = multiply(perspective(52, WIDTH / HEIGHT, 0.5, 900), view);
const invViewProj = new Float32Array(16);
invertInto(invViewProj, viewProj);

const cameraUniform = {
  viewProj,
  right: [view[0], view[4], view[8]],
  pad0: 0,
  up: [view[1], view[5], view[9]],
  pad1: 0,
  eye,
  pad2: 0,
};

/** Where the last break happened; the water lights from it as a point source. */
let glowPos = [0, 34, 0];

const emitter = compute(gpu, emitSrc, { label: "emit" });
const sim = compute(gpu, simSrc, { label: "sim", set: { particles } });
const skyUniform = {
  invViewProj,
  eye,
  time: 6,
  haze: 0.4,
  glow: 0.62,
  reflection: 0.72,
  waves: 0.09,
  glowColor: [1, 0.6, 0.34],
  waterY: WATER_Y,
  glowPos,
  pad0: 0,
};
const sky = effect(gpu, skySrc, {
  set: { sky: skyUniform, mirror, samp: linear },
});

const sparkParams = (mirrored) => ({
  time: 0,
  first: 0,
  span: 0,
  poolSize: POOL,
  mirror: mirrored ? 1 : 0,
  waterY: WATER_Y,
  sizeScale: SUPERSAMPLE,
  pad0: 0,
});

const sparks = draw(gpu, {
  shader: sparksSrc,
  blend: "additive",
  vertices: 6,
  instances: 0,
  set: { camera: cameraUniform, params: sparkParams(false), particles },
});

// The reflection is a second Draw of the same shader: passes inside one frame
// cannot share uniforms, and the water pass has to read a finished target.
const sparksMirror = draw(gpu, {
  shader: sparksSrc,
  blend: "additive",
  vertices: 6,
  instances: 0,
  set: { camera: cameraUniform, params: sparkParams(true), particles },
});
const bright = effect(gpu, brightSrc, {
  set: {
    scene,
    samp: linear,
    bright: { texel: scene.texelSize, threshold: 0.32, knee: 0.5 },
  },
});
const blurH = effect(gpu, blurSrc, {
  set: {
    src: bloomA,
    samp: linear,
    blur: { step: [bloomA.texelSize[0], 0], spread: 1.35, pad0: 0 },
  },
});
const blurV = effect(gpu, blurSrc, {
  set: {
    src: bloomB,
    samp: linear,
    blur: { step: [0, bloomB.texelSize[1]], spread: 1.35, pad0: 0 },
  },
});
const composite = effect(gpu, compositeSrc, {
  set: {
    scene,
    bloom: bloomA,
    samp: linear,
    composite: {
      bloom: 1.28,
      exposure: 1.0,
      time: 4.2,
      vignette: 0.62,
      grain: 0.06,
      aberration: 0.004,
      pad0: 0,
      pad1: 0,
    },
  },
});

// --- the show ---------------------------------------------------------------

/** Bump allocator. A three-second capture never wraps, so nothing recycles. */
let written = 0;
let seed = 0x1234_5678;

function emit(params) {
  const count = Math.min(params.count, POOL - written);
  if (count <= 0) return;
  const base = written;
  written += count;
  seed = (seed + 0x9e37) >>> 0;
  emitter.set({
    emit: {
      origin: params.origin,
      count,
      colorA: hex(params.colorA),
      base,
      colorB: hex(params.colorB),
      pattern: params.pattern,
      axis: params.axis ?? [0, 1, 0],
      colorMode: params.colorMode,
      baseVel: params.baseVel,
      poolSize: POOL,
      speed: params.speed,
      speedJitter: params.speedJitter ?? 0.2,
      life: params.life,
      lifeJitter: params.lifeJitter ?? 0.3,
      size: params.size,
      gravity: params.gravity,
      drag: params.drag,
      sparkle: params.sparkle,
      glitter: params.glitter ?? 0,
      spin: 0,
      stretch: params.stretch,
      startRadius: 0,
      seed,
      inherit: params.inherit ?? 0,
      kind: params.kind ?? 0,
      pad0: 0,
    },
    particles,
  });
  emitter.dispatch(Math.ceil(count / WORKGROUP));
}

/**
 * Back-solve a rocket from the instant its shell must open: the lift that tops
 * out at `y`, launched early enough to arrive on the cue.
 */
const rockets = CUES.map((cue) => {
  const [x, y, z] = cue.at;
  const speed = Math.sqrt(2 * GRAVITY * Math.max(1, y));
  // Time to apex, which is where the fuse is set to burn out.
  const rise = speed / GRAVITY;
  return {
    cue,
    launchAt: cue.breakAt - rise,
    x,
    y: WATER_Y + 0.4,
    z,
    vy: speed,
    live: false,
    broken: false,
    trailDebt: 0,
  };
});

function breakShell(rocket) {
  const cue = rocket.cue;
  // The water lights from the most recent break as a point source, so the sky
  // pass needs to know where it happened.
  glowPos = [rocket.x, rocket.y, rocket.z];
  for (const layer of cue.layers) {
    emit({
      ...layer,
      origin: [rocket.x, rocket.y, rocket.z],
      baseVel: [0, rocket.vy * 0.25, 0],
    });
  }
  if (cue.layers.length > 0) {
    // The break flash, same as the renderer fires on every shell.
    emit({
      pattern: 12,
      count: 1,
      colorA: cue.layers[0].colorA,
      colorB: cue.layers[0].colorA,
      colorMode: 0,
      origin: [rocket.x, rocket.y, rocket.z],
      baseVel: [0, 0, 0],
      speed: 0,
      life: 0.2,
      size: 3.4,
      gravity: 0,
      drag: 0,
      sparkle: 0,
      stretch: 0,
      kind: 2,
    });
  }
}

let time = 0;
for (let step = 0; step * DT < CAPTURE; step++) {
  time += DT;

  for (const rocket of rockets) {
    if (rocket.broken) continue;
    if (!rocket.live) {
      if (time < rocket.launchAt) continue;
      rocket.live = true;
    }
    rocket.vy -= GRAVITY * DT;
    rocket.y += rocket.vy * DT;

    const trail = rocket.cue.trail;
    if (trail) {
      rocket.trailDebt += trail.rate * DT;
      const count = Math.floor(rocket.trailDebt);
      if (count > 0) {
        rocket.trailDebt -= count;
        emit({
          pattern: 11,
          count,
          colorA: trail.color,
          colorB: trail.color,
          colorMode: 0,
          origin: [rocket.x, rocket.y, rocket.z],
          baseVel: [0, rocket.vy, 0],
          speed: 1.6,
          speedJitter: 0.5,
          life: 0.55,
          lifeJitter: 0.4,
          size: 0.095,
          gravity: 0.35,
          drag: 1.6,
          sparkle: 0.7,
          stretch: 0.5,
          inherit: 0.25,
          kind: 1,
        });
      }
    }

    if (time >= rocket.cue.breakAt) {
      rocket.broken = true;
      breakShell(rocket);
    }
  }

  if (written > 0) {
    sim.set({
      sim: {
        wind: [0.9, 0, 0.25],
        dt: DT,
        time,
        gravity: GRAVITY,
        drag: 0.35,
        turbulence: 0.4,
        groundY: WATER_Y,
        first: 0,
        span: written,
        poolSize: POOL,
      },
      particles,
    });
    sim.dispatch(Math.ceil(written / WORKGROUP));
  }
}

const shot = { time, first: 0, span: written };
// `glowPos` moved as shells broke; the effect captured the array it was bound
// to, so the final position has to be written back before the frame.
sky.set({ sky: { ...skyUniform, glowPos } });
sparks.set({
  camera: cameraUniform,
  params: { ...sparkParams(false), ...shot },
});
sparksMirror.set({
  camera: cameraUniform,
  params: { ...sparkParams(true), ...shot },
});

frame(gpu, (f) => {
  // The reflection has to be finished before the water samples it.
  f.pass({ target: mirror, clear: [0, 0, 0, 1] }, (pass) => {
    pass.draw(sparksMirror, { instances: written });
  });
  f.pass(scene, sky);
  f.pass({ target: scene, clear: false }, (pass) => {
    pass.draw(sparks, { instances: written });
  });
  f.pass(bloomA, bright);
  f.pass(bloomB, blurH);
  f.pass(bloomA, blurV);
  f.pass(output, composite);
});

// --- resolve ----------------------------------------------------------------

const pixels = await output.read();

/**
 * Box-downsample the supersampled frame. Averaging happens in linear light,
 * because averaging sRGB values would eat the highlights the bloom just made.
 */
const toLinear = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  toLinear[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const encode = (v) =>
  Math.round(
    255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055),
  );

const png = new PNG({ width: OUT_WIDTH, height: OUT_HEIGHT });
const samples = SUPERSAMPLE * SUPERSAMPLE;
for (let y = 0; y < OUT_HEIGHT; y++) {
  for (let x = 0; x < OUT_WIDTH; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let sy = 0; sy < SUPERSAMPLE; sy++) {
      for (let sx = 0; sx < SUPERSAMPLE; sx++) {
        const i = ((y * SUPERSAMPLE + sy) * WIDTH + x * SUPERSAMPLE + sx) * 4;
        r += toLinear[pixels[i]];
        g += toLinear[pixels[i + 1]];
        b += toLinear[pixels[i + 2]];
      }
    }
    const o = (y * OUT_WIDTH + x) * 4;
    png.data[o] = encode(r / samples);
    png.data[o + 1] = encode(g / samples);
    png.data[o + 2] = encode(b / samples);
    png.data[o + 3] = 255;
  }
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, PNG.sync.write(png));
console.log(
  `wrote ${outPath} — ${OUT_WIDTH}x${OUT_HEIGHT}, ${written.toLocaleString()} stars at t=${CAPTURE}s`,
);

gpu.dispose();
