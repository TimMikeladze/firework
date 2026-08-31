/**
 * Renders the show's voices offline and writes a WAV, so the sounds can be
 * heard — and measured — without a browser.
 *
 *   bun run sfx                        # the whole audition, to sfx.wav
 *   bun run sfx -- --scene burst       # one scene
 *   bun run sfx -- --out /tmp/try.wav --seed 7
 *
 * It builds the same chain `ShowAudio` builds and schedules the same voices
 * onto it, so what lands on disk is the mix the browser plays. Every scene is
 * seeded, which means a change to the sound design shows up as a change in the
 * printed peak, RMS, and centroid — not just as a vibe.
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { OfflineAudioContext } from "node-web-audio-api";
import { DEMO_DURATION, scheduleDemoSong } from "../src/audio/demo-song";
import {
  BURST_CHARACTERS,
  buildSfxChain,
  noiseBuffer,
  type Rng,
  type SfxBus,
  scheduleBurst,
  scheduleCrackle,
  scheduleLift,
} from "../src/builder/sfx";

/** Seeded so a render is comparable against the one before it. */
function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Scene {
  seconds: number;
  /** What the ear is being asked about, printed with the numbers. */
  about: string;
  play(
    ctx: OfflineAudioContext,
    bus: SfxBus,
    noise: AudioBuffer,
    rng: Rng,
  ): void;
}

const SCENES: Record<string, Scene> = {
  burst: {
    seconds: 14,
    about: "one break at a time: small to big, near to far",
    play(_ctx, bus, noise, rng) {
      const sizes = [0, 0.35, 0.7, 1];
      const distances = [25, 70, 160];
      let at = 0.4;
      for (const distance of distances) {
        for (const size of sizes) {
          scheduleBurst(
            _ctx,
            bus,
            noise,
            at,
            { gain: 0.9, size, distance, pan: 0 },
            rng,
          );
          at += 1.1;
        }
      }
    },
  },

  characters: {
    seconds: 17,
    about: "salute, shell, deep, bomb — near then far, in that order",
    play(ctx, bus, noise, rng) {
      let at = 0.4;
      for (const name of Object.keys(BURST_CHARACTERS) as Array<
        keyof typeof BURST_CHARACTERS
      >) {
        for (const distance of [30, 110]) {
          for (let i = 0; i < 2; i++) {
            scheduleBurst(
              ctx,
              bus,
              noise,
              at,
              { gain: 0.9, size: 0.5, distance, pan: 0, character: name },
              rng,
            );
            at += 0.55;
          }
        }
        at += 0.7;
      }
    },
  },

  lift: {
    seconds: 8,
    about: "the mortar and the whistle, then the break they set up",
    play(ctx, bus, noise, rng) {
      for (let i = 0; i < 3; i++) {
        const at = 0.3 + i * 2.4;
        const fuse = 1.4 + i * 0.3;
        const distance = 30 + i * 45;
        const pan = -0.5 + i * 0.5;
        scheduleLift(
          ctx,
          bus,
          noise,
          at,
          { gain: 0.7, seconds: fuse, distance, pan },
          rng,
        );
        scheduleBurst(
          ctx,
          bus,
          noise,
          at + fuse,
          { gain: 0.85, size: 0.5, distance, pan },
          rng,
        );
      }
    },
  },

  crackle: {
    seconds: 8,
    about: "the tail on its own — should read as many small fires, not hiss",
    play(ctx, bus, noise, rng) {
      const distances = [25, 80, 150];
      distances.forEach((distance, i) => {
        scheduleCrackle(
          ctx,
          bus,
          noise,
          0.3 + i * 2.5,
          { gain: 0.9, seconds: 2, distance, pan: (i - 1) * 0.6 },
          rng,
        );
      });
    },
  },

  barrage: {
    seconds: 10,
    about: "a finale: twenty breaks over four seconds, and what the glue does",
    play(ctx, bus, noise, rng) {
      for (let i = 0; i < 20; i++) {
        const at = 0.5 + i * 0.2 + rng() * 0.05;
        const distance = 30 + rng() * 90;
        const pan = (rng() - 0.5) * 1.4;
        const size = rng();
        // The live path pulls each voice back as the count climbs; mirror it,
        // or this scene is not the one the listener gets.
        const crowd = Math.max(0.32, 1 / (1 + Math.min(6, i) * 0.22));
        scheduleBurst(
          ctx,
          bus,
          noise,
          at,
          { gain: 0.9, size, distance, pan, crowd },
          rng,
        );
        if (rng() > 0.5)
          scheduleCrackle(
            ctx,
            bus,
            noise,
            at,
            { gain: 0.5, seconds: 1.4, distance, pan },
            rng,
          );
      }
    },
  },

  song: {
    seconds: DEMO_DURATION,
    about: "the bundled demo track — the music the show is cut against",
    play(ctx) {
      // Straight to the output: the track has its own bus and its own glue,
      // and it is not a firework.
      scheduleDemoSong(ctx, ctx.destination, 0);
    },
  },

  show: {
    seconds: 16,
    about: "the whole thing, paced like a show",
    play(ctx, bus, noise, rng) {
      let at = 0.4;
      while (at < 12) {
        const fuse = 1.1 + rng() * 0.8;
        const distance = 25 + rng() * 110;
        const pan = (rng() - 0.5) * 1.5;
        const size = rng();
        scheduleLift(
          ctx,
          bus,
          noise,
          at,
          { gain: 0.6, seconds: fuse, distance, pan },
          rng,
        );
        scheduleBurst(
          ctx,
          bus,
          noise,
          at + fuse,
          { gain: 0.9, size, distance, pan },
          rng,
        );
        scheduleCrackle(
          ctx,
          bus,
          noise,
          at + fuse,
          { gain: 0.45 + rng() * 0.4, seconds: 1 + rng() * 1.5, distance, pan },
          rng,
        );
        at += 0.5 + rng() * 1.4;
      }
    },
  },
};

/* ------------------------------------------------------------------ */

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const sceneName = arg("scene", "all");
const seed = Number(arg("seed", "1234"));
const rate = Number(arg("rate", "48000"));
const outPath = resolve(arg("out", "sfx.wav"));

const chosen =
  sceneName === "all"
    ? Object.keys(SCENES)
    : sceneName.split(",").filter((n) => n in SCENES);
if (!chosen.length) {
  console.error(
    `unknown scene "${sceneName}" — pick from ${Object.keys(SCENES).join(", ")}, or "all"`,
  );
  process.exit(1);
}

/** Peak, RMS, and where the energy sits — enough to catch a broken change. */
function measure(buffer: AudioBuffer): {
  peak: number;
  rms: number;
  centroid: number;
} {
  const left = buffer.getChannelData(0);
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < left.length; i++) {
    const v = Math.abs(left[i]);
    if (v > peak) peak = v;
    sum += left[i] * left[i];
  }
  // A zero-crossing rate stands in for a spectrum: cheap, and it moves the
  // right way when a sound gets brighter or duller.
  let crossings = 0;
  for (let i = 1; i < left.length; i++) {
    if (left[i - 1] <= 0 !== left[i] <= 0) crossings++;
  }
  return {
    peak,
    rms: Math.sqrt(sum / left.length),
    centroid: (crossings * buffer.sampleRate) / (2 * left.length),
  };
}

/** 16-bit stereo PCM. Nothing here needs more than that. */
function encodeWav(buffer: AudioBuffer): Buffer {
  const channels = Math.min(2, buffer.numberOfChannels);
  const frames = buffer.length;
  const bytes = Buffer.alloc(44 + frames * channels * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(36 + frames * channels * 2, 4);
  bytes.write("WAVE", 8);
  bytes.write("fmt ", 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(buffer.sampleRate, 24);
  bytes.writeUInt32LE(buffer.sampleRate * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(frames * channels * 2, 40);

  const data = Array.from({ length: channels }, (_, c) =>
    buffer.getChannelData(c),
  );
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, data[c][i]));
      bytes.writeInt16LE(Math.round(v * 32767), offset);
      offset += 2;
    }
  }
  return bytes;
}

const rendered: AudioBuffer[] = [];
const GAP = 0.6;

for (const name of chosen) {
  const scene = SCENES[name];
  const ctx = new OfflineAudioContext(
    2,
    Math.ceil(scene.seconds * rate),
    rate,
  ) as unknown as OfflineAudioContext & BaseAudioContext;
  const rng = mulberry32(seed);
  const { bus, master } = buildSfxChain(ctx, ctx.destination, rng);
  master.gain.value = 0.9;
  const noise = noiseBuffer(ctx, 2, rng);
  scene.play(ctx, bus, noise, rng);

  const buffer = (await ctx.startRendering()) as unknown as AudioBuffer;
  const { peak, rms, centroid } = measure(buffer);
  console.log(
    `${name.padEnd(8)} ${scene.seconds.toFixed(0).padStart(3)}s  ` +
      `peak ${peak.toFixed(3)}  rms ${rms.toFixed(4)}  ~${centroid.toFixed(0).padStart(5)} Hz   ${scene.about}`,
  );
  if (peak > 0.999)
    console.warn(`  ${name}: clipping — the glue is not holding`);
  rendered.push(buffer);
}

// Everything into one file, so an audition is one play rather than five.
const total = rendered.reduce(
  (frames, b) => frames + b.length + Math.floor(GAP * rate),
  0,
);
const joinCtx = new OfflineAudioContext(2, total, rate);
const joined = joinCtx.createBuffer(2, total, rate);
let cursor = 0;
for (const buffer of rendered) {
  for (let c = 0; c < 2; c++) {
    joined.getChannelData(c).set(buffer.getChannelData(c), cursor);
  }
  cursor += buffer.length + Math.floor(GAP * rate);
}

const wav = encodeWav(joined as unknown as AudioBuffer);
await writeFile(outPath, wav);
console.log(
  `\nwrote ${outPath} — ${(wav.length / 1024 / 1024).toFixed(1)} MB, ${(total / rate).toFixed(1)}s`,
);
