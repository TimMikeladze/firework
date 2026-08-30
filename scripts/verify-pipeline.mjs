/**
 * Headless proof that the fireworks pipeline actually renders.
 *
 * `next build` never compiles WGSL, so this script is the gate: it resolves
 * every shader against a real device, runs the exact emit -> sim -> draw ->
 * bloom -> composite chain the browser runs, and asserts on the pixels that
 * come back. Run it with `bun run verify` (or `node scripts/verify-pipeline.mjs`).
 *
 * Pass `--png out.png` to also write the frame out for eyeballing.
 */

import { writeFileSync } from "node:fs";
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

const POOL = 20_000;
const PARTICLE_BYTES = 96;
const WORKGROUP = 64;

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

/** Render size. Raise it with `--width/--height` when eyeballing a PNG. */
const WIDTH = Number(flag("width", 480));
const HEIGHT = Number(flag("height", 270));

const pngPath = flag("png", null);
/** Pattern id to fire, matching PATTERN_IDS in spec.ts. Handy for eyeballing one. */
const PATTERN = Number(flag("pattern", 0));
const BURST_COUNT = Number(flag("count", 6000));
/** Frames of simulation before the frame is captured. */
const STEPS = Number(flag("steps", 24));
/** Sea state and mirror strength, for eyeballing the water on its own. */
const WAVES = Number(flag("waves", 0.45));
const REFLECTION = Number(flag("reflection", 0.6));
/** Intensity of the break as a point light on the water; 0 isolates the mirror. */
const LIGHT = Number(flag("light", 1.2));
/** Sea confusion and moon brightness, for eyeballing those on their own. */
const CHOP = Number(flag("chop", 0.35));
const MOON = Number(flag("moon", 0.5));

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exitCode = 1;
}

function pass(message) {
  console.log(`ok    ${message}`);
}

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
pass("every shader resolves and validates against a device");

const particles = storage(gpu, POOL * PARTICLE_BYTES);
const linear = sampler(gpu, { minFilter: "linear", magFilter: "linear" });
const hdr = "rgba16float";
const scene = target(gpu, { size: [WIDTH, HEIGHT], format: hdr });
const bloomA = target(gpu, { size: [WIDTH >> 1, HEIGHT >> 1], format: hdr });
const bloomB = target(gpu, { size: [WIDTH >> 1, HEIGHT >> 1], format: hdr });
const mirror = target(gpu, { size: [WIDTH >> 1, HEIGHT >> 1], format: hdr });
const output = target(gpu, { size: [WIDTH, HEIGHT], format: "rgba8unorm" });

const eye = [0, 7, 88];
const center = [0, 1, 0];
const view = lookAt(eye, center, [0, 1, 0]);
const projection = perspective(52, WIDTH / HEIGHT, 0.5, 900);
const viewProj = multiply(projection, view);

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

const emitter = compute(gpu, emitSrc, { label: "emit" });
const sim = compute(gpu, simSrc, { label: "sim", set: { particles } });

/** One pixel's angle for the 52° vertical field of view above. */
const pixelAngle = (2 * Math.tan((52 * Math.PI) / 360)) / HEIGHT;

const sky = effect(gpu, skySrc, {
  set: {
    sky: {
      invViewProj,
      viewProj,
      eye,
      time: 3,
      haze: 0.4,
      glow: 0.6,
      reflection: REFLECTION,
      waves: WAVES,
      glowColor: [1, 0.7, 0.45],
      waterY: 0,
      pixelAngle,
      chop: CHOP,
      // A gibbous moon up and to the left of the burst, inside the frame.
      moonRadius: (0.9 * Math.PI) / 180,
      moonPhase: 0.72,
      moonDir: [-0.3601, 0.2756, -0.8913],
      moon: MOON,
      // The burst as a point light, plus three empty slots.
      lights: [
        [0, 34, 0, LIGHT],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ],
      lightColors: [
        [1, 0.7, 0.45, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ],
    },
    mirror,
    samp: linear,
  },
});

const sparkParams = (mirrored) => ({
  time: 0,
  first: 0,
  span: 0,
  poolSize: POOL,
  mirror: mirrored ? 1 : 0,
  waterY: 0,
  sizeScale: 1,
  pad0: 0,
});

const sparks = draw(gpu, {
  shader: sparksSrc,
  blend: "additive",
  vertices: 6,
  instances: 0,
  set: {
    camera: cameraUniform,
    params: sparkParams(false),
    particles,
  },
});

// The reflection is a second Draw of the same shader: passes inside one frame
// cannot share uniforms, and the water pass has to read a finished target.
const sparksMirror = draw(gpu, {
  shader: sparksSrc,
  blend: "additive",
  vertices: 6,
  instances: 0,
  set: {
    camera: cameraUniform,
    params: sparkParams(true),
    particles,
  },
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
      bloom: 1,
      exposure: 1,
      time: 0,
      vignette: 0.55,
      grain: 0,
      aberration: 0.004,
      pad0: 0,
      pad1: 0,
    },
  },
});
pass("every pipeline builds and every binding is accepted");

emitter.set({
  emit: {
    origin: [0, 34, 0],
    count: BURST_COUNT,
    colorA: [1, 0.55, 0.16],
    base: 0,
    colorB: [0.9, 0.06, 0.12],
    pattern: PATTERN,
    axis: [0, 1, 0],
    colorMode: 1,
    baseVel: [0, 0, 0],
    poolSize: POOL,
    speed: 16,
    speedJitter: 0.2,
    life: 2.2,
    lifeJitter: 0.3,
    size: 0.14,
    gravity: 1,
    drag: 1.1,
    sparkle: 0.4,
    glitter: 0.2,
    spin: 0,
    stretch: 0.3,
    startRadius: 0,
    seed: 12345,
    inherit: 0,
    kind: 0,
    pad0: 0,
  },
  particles,
});
emitter.dispatch(Math.ceil(BURST_COUNT / WORKGROUP));

// Run the sim far enough that the burst has actually opened up.
const DT = 1 / 60;
let simTime = 0;
for (let step = 0; step < STEPS; step++) {
  simTime += DT;
  sim.set({
    sim: {
      wind: [0.6, 0, 0.2],
      dt: DT,
      time: simTime,
      gravity: 9.4,
      drag: 0.35,
      turbulence: 0.35,
      groundY: 0,
      first: 0,
      span: BURST_COUNT,
      poolSize: POOL,
    },
    particles,
  });
  sim.dispatch(Math.ceil(BURST_COUNT / WORKGROUP));
}

// The sim writes back into the same buffer the draw reads, so a packing bug in
// `Particle` shows up here as sparks that never moved.
const raw = new Float32Array(await particles.read());
const movedX = raw[0];
const movedY = raw[1];
if (Math.abs(movedX) < 0.01 && Math.abs(movedY - 34) < 0.01) {
  fail("the simulation did not move particle 0 — check the Particle layout");
} else {
  pass(
    `the simulation integrates (particle 0 at ${movedX.toFixed(2)}, ${movedY.toFixed(2)})`,
  );
}

const liveParams = { time: simTime, first: 0, span: BURST_COUNT };
sparks.set({
  camera: cameraUniform,
  params: { ...sparkParams(false), ...liveParams },
});
sparksMirror.set({
  camera: cameraUniform,
  params: { ...sparkParams(true), ...liveParams },
});

// One frame, in the same order and with the same pass structure as the app:
// the reflection has to be finished before the water samples it.
frame(gpu, (f) => {
  f.pass({ target: mirror, clear: [0, 0, 0, 1] }, (pass) => {
    pass.draw(sparksMirror, { instances: BURST_COUNT });
  });
  f.pass(scene, sky);
  f.pass({ target: scene, clear: false }, (pass) => {
    pass.draw(sparks, { instances: BURST_COUNT });
  });
  f.pass(bloomA, bright);
  f.pass(bloomB, blurH);
  f.pass(bloomA, blurV);
  f.pass(output, composite);
});

const pixels = await output.read();
let lit = 0;
let brightest = 0;
let skyPixels = 0;
for (let i = 0; i < pixels.length; i += 4) {
  const l = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
  if (l > 90) lit += 1;
  if (l > brightest) brightest = l;
  if (l > 4) skyPixels += 1;
}
const total = pixels.length / 4;

if (skyPixels < total * 0.2) {
  fail(
    `the background is essentially black (${skyPixels}/${total} pixels lit)`,
  );
} else {
  pass(
    `the sky renders (${((skyPixels / total) * 100).toFixed(0)}% of pixels carry light)`,
  );
}
if (lit < 200) {
  fail(
    `the burst is not visible (only ${lit} bright pixels, peak ${brightest})`,
  );
} else {
  pass(`the burst renders (${lit} bright pixels, peak ${brightest})`);
}

// A burst above the water must also show up mirrored below it.
const half = Math.floor(HEIGHT * 0.62);
let lowerLit = 0;
for (let y = half; y < HEIGHT; y++) {
  for (let x = 0; x < WIDTH; x++) {
    const i = (y * WIDTH + x) * 4;
    if ((pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3 > 18) lowerLit += 1;
  }
}
if (lowerLit < 50) {
  fail(`no reflection in the water (${lowerLit} lit pixels below the horizon)`);
} else {
  pass(
    `the water reflects the burst (${lowerLit} lit pixels below the horizon)`,
  );
}

if (pngPath) {
  const png = new PNG({ width: WIDTH, height: HEIGHT });
  png.data.set(pixels);
  writeFileSync(pngPath, PNG.sync.write(png));
  console.log(`      wrote ${pngPath}`);
}

gpu.dispose();
