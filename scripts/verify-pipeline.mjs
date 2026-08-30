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

const here = dirname(fileURLToPath(import.meta.url));
const shaderDir = resolve(here, "../src/builder/shaders");

const WIDTH = 480;
const HEIGHT = 270;
const POOL = 20_000;
const PARTICLE_BYTES = 96;
const WORKGROUP = 64;

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const pngPath = flag("png", null);
/** Pattern id to fire, matching PATTERN_IDS in spec.ts. Handy for eyeballing one. */
const PATTERN = Number(flag("pattern", 0));
const BURST_COUNT = Number(flag("count", 6000));
/** Frames of simulation before the frame is captured. */
const STEPS = Number(flag("steps", 24));

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exitCode = 1;
}

function pass(message) {
  console.log(`ok    ${message}`);
}

/** Column-major perspective matrix, matching what vgpu/scene produces. */
function perspective(fovDeg, aspect, near, far) {
  const f = 1 / Math.tan((fovDeg * Math.PI) / 360);
  const nf = 1 / (near - far);
  // prettier-ignore
  return new Float32Array([
    f / aspect,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    0,
    0,
    far * nf,
    -1,
    0,
    0,
    far * near * nf,
    0,
  ]);
}

function lookAt(eye, center, up) {
  const z = normalize([
    eye[0] - center[0],
    eye[1] - center[1],
    eye[2] - center[2],
  ]);
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  // prettier-ignore
  return new Float32Array([
    x[0],
    y[0],
    z[0],
    0,
    x[1],
    y[1],
    z[1],
    0,
    x[2],
    y[2],
    z[2],
    0,
    -dot(x, eye),
    -dot(y, eye),
    -dot(z, eye),
    1,
  ]);
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function normalize(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function multiply(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
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
const output = target(gpu, { size: [WIDTH, HEIGHT], format: "rgba8unorm" });

const eye = [0, 7, 88];
const center = [0, 1, 0];
const view = lookAt(eye, center, [0, 1, 0]);
const projection = perspective(52, WIDTH / HEIGHT, 0.5, 900);
const viewProj = multiply(projection, view);

// Inverse of the view-projection, for the sky's ray reconstruction. Kept local
// rather than imported from src/, so this script runs under plain node too.
function invertInto(out, m) {
  const inv = new Float32Array(16);
  const a = m;
  inv[0] =
    a[5] * a[10] * a[15] -
    a[5] * a[11] * a[14] -
    a[9] * a[6] * a[15] +
    a[9] * a[7] * a[14] +
    a[13] * a[6] * a[11] -
    a[13] * a[7] * a[10];
  inv[4] =
    -a[4] * a[10] * a[15] +
    a[4] * a[11] * a[14] +
    a[8] * a[6] * a[15] -
    a[8] * a[7] * a[14] -
    a[12] * a[6] * a[11] +
    a[12] * a[7] * a[10];
  inv[8] =
    a[4] * a[9] * a[15] -
    a[4] * a[11] * a[13] -
    a[8] * a[5] * a[15] +
    a[8] * a[7] * a[13] +
    a[12] * a[5] * a[11] -
    a[12] * a[7] * a[9];
  inv[12] =
    -a[4] * a[9] * a[14] +
    a[4] * a[10] * a[13] +
    a[8] * a[5] * a[14] -
    a[8] * a[6] * a[13] -
    a[12] * a[5] * a[10] +
    a[12] * a[6] * a[9];
  inv[1] =
    -a[1] * a[10] * a[15] +
    a[1] * a[11] * a[14] +
    a[9] * a[2] * a[15] -
    a[9] * a[3] * a[14] -
    a[13] * a[2] * a[11] +
    a[13] * a[3] * a[10];
  inv[5] =
    a[0] * a[10] * a[15] -
    a[0] * a[11] * a[14] -
    a[8] * a[2] * a[15] +
    a[8] * a[3] * a[14] +
    a[12] * a[2] * a[11] -
    a[12] * a[3] * a[10];
  inv[9] =
    -a[0] * a[9] * a[15] +
    a[0] * a[11] * a[13] +
    a[8] * a[1] * a[15] -
    a[8] * a[3] * a[13] -
    a[12] * a[1] * a[11] +
    a[12] * a[3] * a[9];
  inv[13] =
    a[0] * a[9] * a[14] -
    a[0] * a[10] * a[13] -
    a[8] * a[1] * a[14] +
    a[8] * a[2] * a[13] +
    a[12] * a[1] * a[10] -
    a[12] * a[2] * a[9];
  inv[2] =
    a[1] * a[6] * a[15] -
    a[1] * a[7] * a[14] -
    a[5] * a[2] * a[15] +
    a[5] * a[3] * a[14] +
    a[13] * a[2] * a[7] -
    a[13] * a[3] * a[6];
  inv[6] =
    -a[0] * a[6] * a[15] +
    a[0] * a[7] * a[14] +
    a[4] * a[2] * a[15] -
    a[4] * a[3] * a[14] -
    a[12] * a[2] * a[7] +
    a[12] * a[3] * a[6];
  inv[10] =
    a[0] * a[5] * a[15] -
    a[0] * a[7] * a[13] -
    a[4] * a[1] * a[15] +
    a[4] * a[3] * a[13] +
    a[12] * a[1] * a[7] -
    a[12] * a[3] * a[5];
  inv[14] =
    -a[0] * a[5] * a[14] +
    a[0] * a[6] * a[13] +
    a[4] * a[1] * a[14] -
    a[4] * a[2] * a[13] -
    a[12] * a[1] * a[6] +
    a[12] * a[2] * a[5];
  inv[3] =
    -a[1] * a[6] * a[11] +
    a[1] * a[7] * a[10] +
    a[5] * a[2] * a[11] -
    a[5] * a[3] * a[10] -
    a[9] * a[2] * a[7] +
    a[9] * a[3] * a[6];
  inv[7] =
    a[0] * a[6] * a[11] -
    a[0] * a[7] * a[10] -
    a[4] * a[2] * a[11] +
    a[4] * a[3] * a[10] +
    a[8] * a[2] * a[7] -
    a[8] * a[3] * a[6];
  inv[11] =
    -a[0] * a[5] * a[11] +
    a[0] * a[7] * a[9] +
    a[4] * a[1] * a[11] -
    a[4] * a[3] * a[9] -
    a[8] * a[1] * a[7] +
    a[8] * a[3] * a[5];
  inv[15] =
    a[0] * a[5] * a[10] -
    a[0] * a[6] * a[9] -
    a[4] * a[1] * a[10] +
    a[4] * a[2] * a[9] +
    a[8] * a[1] * a[6] -
    a[8] * a[2] * a[5];
  const det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
  for (let i = 0; i < 16; i++) out[i] = inv[i] / det;
}

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

const sky = effect(gpu, skySrc, {
  set: {
    sky: {
      invViewProj,
      eye,
      time: 3,
      haze: 0.4,
      glow: 0.6,
      pad0: 0,
      pad1: 0,
      glowColor: [1, 0.7, 0.45],
      pad2: 0,
    },
  },
});

const sparks = draw(gpu, {
  shader: sparksSrc,
  blend: "additive",
  vertices: 6,
  instances: 0,
  set: {
    camera: cameraUniform,
    params: {
      time: 0,
      first: 0,
      span: 0,
      poolSize: POOL,
      reflection: 0.6,
      waterY: 0,
      sizeScale: 1,
      pad0: 0,
    },
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

sparks.set({
  camera: cameraUniform,
  params: {
    time: simTime,
    first: 0,
    span: BURST_COUNT,
    poolSize: POOL,
    reflection: 0.6,
    waterY: 0,
    sizeScale: 1,
    pad0: 0,
  },
});

// One frame, in the same order and with the same pass structure as the app.
frame(gpu, (f) => {
  f.pass(scene, sky);
  f.pass({ target: scene, clear: false }, (pass) => {
    pass.draw(sparks, { instances: BURST_COUNT * 2 });
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
