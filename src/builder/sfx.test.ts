import { describe, expect, test } from "bun:test";
import { OfflineAudioContext } from "node-web-audio-api";
import {
  airCutoff,
  type BurstSound,
  buildSfxChain,
  distanceGain,
  noiseBuffer,
  type Rng,
  reverbSend,
  scheduleBurst,
  scheduleCrackle,
  scheduleLift,
  travelTime,
} from "./sfx";

/**
 * The voices are scheduled against a real (offline) WebAudio graph, so these
 * assert on samples rather than on node counts: what came out, how loud, how
 * bright, and when it arrived. `bun run sfx` writes the same renders to a WAV
 * when they need to be listened to instead.
 */

const RATE = 24000;

function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function render(
  seconds: number,
  play: (
    ctx: BaseAudioContext,
    bus: ReturnType<typeof buildSfxChain>["bus"],
    noise: AudioBuffer,
    rng: Rng,
  ) => void,
  seed = 99,
): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(
    2,
    Math.ceil(seconds * RATE),
    RATE,
  ) as unknown as BaseAudioContext & { startRendering(): Promise<AudioBuffer> };
  const rng = seeded(seed);
  const { bus, master } = buildSfxChain(ctx, ctx.destination, rng);
  master.gain.value = 0.9;
  play(ctx, bus, noiseBuffer(ctx, 1, rng), rng);
  return await ctx.startRendering();
}

function peak(buffer: AudioBuffer): number {
  const data = buffer.getChannelData(0);
  let max = 0;
  for (const v of data) max = Math.max(max, Math.abs(v));
  return max;
}

function rms(buffer: AudioBuffer): number {
  const data = buffer.getChannelData(0);
  let sum = 0;
  for (const v of data) sum += v * v;
  return Math.sqrt(sum / data.length);
}

/** Zero crossings per second — a cheap stand-in for "how bright is this". */
function brightness(buffer: AudioBuffer): number {
  const data = buffer.getChannelData(0);
  let crossings = 0;
  for (let i = 1; i < data.length; i++) {
    if (data[i - 1] <= 0 !== data[i] <= 0) crossings++;
  }
  return (crossings * buffer.sampleRate) / (2 * data.length);
}

/** Seconds until anything is heard at all. */
function onset(buffer: AudioBuffer, floor = 0.01): number {
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    if (Math.abs(data[i]) > floor) return i / buffer.sampleRate;
  }
  return Number.POSITIVE_INFINITY;
}

const burst = (over: Partial<BurstSound> = {}): BurstSound => ({
  gain: 0.9,
  size: 0.5,
  distance: 30,
  pan: 0,
  ...over,
});

describe("the distance model", () => {
  test("sound takes time to arrive", () => {
    expect(travelTime(0)).toBe(0);
    // A shell across the bay is most of a second late.
    expect(travelTime(343)).toBeCloseTo(1, 5);
  });

  test("distance is quieter, duller, and wetter", () => {
    expect(distanceGain(0)).toBe(1);
    expect(distanceGain(150)).toBeLessThan(distanceGain(40));
    expect(airCutoff(150)).toBeLessThan(airCutoff(40));
    expect(reverbSend(150)).toBeGreaterThan(reverbSend(40));
    // Nothing ever disappears entirely, however far away it is.
    expect(distanceGain(1e6)).toBeGreaterThan(0);
    expect(airCutoff(1e6)).toBeGreaterThanOrEqual(500);
    expect(reverbSend(1e6)).toBeLessThanOrEqual(0.85);
  });
});

describe("the break", () => {
  test("is loud, and does not clip the bus", async () => {
    const buffer = await render(2, (ctx, bus, noise, rng) => {
      scheduleBurst(ctx, bus, noise, 0.05, burst(), rng);
    });
    expect(peak(buffer)).toBeGreaterThan(0.2);
    expect(peak(buffer)).toBeLessThanOrEqual(1);
  });

  test("a far break arrives late, quieter, and darker than a near one", async () => {
    const play =
      (distance: number) =>
      (
        ctx: BaseAudioContext,
        bus: ReturnType<typeof buildSfxChain>["bus"],
        noise: AudioBuffer,
        rng: Rng,
      ) => {
        scheduleBurst(ctx, bus, noise, 0.05, burst({ distance }), rng);
      };
    const near = await render(3, play(20));
    const far = await render(3, play(200));

    expect(onset(far)).toBeGreaterThan(onset(near) + 0.4);
    expect(rms(far)).toBeLessThan(rms(near));
    expect(brightness(far)).toBeLessThan(brightness(near));
  });

  test("a barrage still holds the ceiling", async () => {
    const buffer = await render(4, (ctx, bus, noise, rng) => {
      for (let i = 0; i < 24; i++) {
        scheduleBurst(
          ctx,
          bus,
          noise,
          0.05 + i * 0.06,
          burst({ distance: 25 + rng() * 60, crowd: 0.4 }),
          rng,
        );
      }
    });
    expect(peak(buffer)).toBeLessThanOrEqual(1);
    // Not a loudness target — a break is mostly transient, so the average is
    // low by design. This only asserts the glue did not swallow the finale.
    expect(rms(buffer)).toBeGreaterThan(0.015);
  });

  test("the bomb voice is lower, longer, and heavier than a shell", async () => {
    const play =
      (character: "shell" | "bomb") =>
      (
        ctx: BaseAudioContext,
        bus: ReturnType<typeof buildSfxChain>["bus"],
        noise: AudioBuffer,
        rng: Rng,
      ) => {
        scheduleBurst(ctx, bus, noise, 0.05, burst({ character }), rng);
      };
    const shell = await render(4, play("shell"));
    const bomb = await render(4, play("bomb"));

    // Lower: the body and the sub under it both sit an octave down.
    expect(brightness(bomb)).toBeLessThan(brightness(shell));
    // Heavier, and still under the ceiling — a bomb is not a clipped shell.
    expect(rms(bomb)).toBeGreaterThan(rms(shell) * 1.3);
    expect(peak(bomb)).toBeLessThanOrEqual(1);
    // Longer: what is left two seconds later is the roll running on.
    const tailRms = (buffer: AudioBuffer) => {
      const data = buffer.getChannelData(0).slice(Math.floor(2 * RATE));
      let sum = 0;
      for (const v of data) sum += v * v;
      return Math.sqrt(sum / data.length);
    };
    expect(tailRms(bomb)).toBeGreaterThan(tailRms(shell));
  });

  test("the same seed gives the same break", async () => {
    const once = await render(
      1.5,
      (ctx, bus, noise, rng) =>
        scheduleBurst(ctx, bus, noise, 0.05, burst(), rng),
      7,
    );
    const twice = await render(
      1.5,
      (ctx, bus, noise, rng) =>
        scheduleBurst(ctx, bus, noise, 0.05, burst(), rng),
      7,
    );
    expect(Array.from(once.getChannelData(0).slice(0, 4000))).toEqual(
      Array.from(twice.getChannelData(0).slice(0, 4000)),
    );
  });

  test("silence in, silence out", async () => {
    const buffer = await render(1, (ctx, bus, noise, rng) => {
      scheduleBurst(ctx, bus, noise, 0.05, burst({ gain: 0 }), rng);
      scheduleLift(
        ctx,
        bus,
        noise,
        0.05,
        { gain: 0, seconds: 1, distance: 30, pan: 0 },
        rng,
      );
      scheduleCrackle(
        ctx,
        bus,
        noise,
        0.05,
        { gain: 0, seconds: 1, distance: 30, pan: 0 },
        rng,
      );
    });
    expect(peak(buffer)).toBe(0);
  });
});

describe("the other voices", () => {
  test("the lift ends when the fuse does", async () => {
    const buffer = await render(3, (ctx, bus, noise, rng) => {
      scheduleLift(
        ctx,
        bus,
        noise,
        0.05,
        { gain: 0.8, seconds: 1.2, distance: 20, pan: 0 },
        rng,
      );
    });
    // The whistle is over by the time the break would land — only its tail is
    // still in the room. A lift still sounding through the crack muddies the
    // one transient that matters.
    const data = buffer.getChannelData(0);
    const after = data.slice(Math.floor(1.5 * RATE));
    let late = 0;
    for (const v of after) late = Math.max(late, Math.abs(v));
    expect(peak(buffer)).toBeGreaterThan(0.05);
    expect(late).toBeLessThan(peak(buffer) * 0.2);
  });

  test("crackle is many pops, not one bed of hiss", async () => {
    const buffer = await render(3, (ctx, bus, noise, rng) => {
      scheduleCrackle(
        ctx,
        bus,
        noise,
        0.05,
        { gain: 1, seconds: 1.6, distance: 25, pan: 0 },
        rng,
      );
    });
    // Count the gaps: a hiss stays above its own floor, a field of pops keeps
    // falling back to nothing between them.
    const data = buffer.getChannelData(0);
    const window = Math.floor(RATE * 0.01);
    let quiet = 0;
    let loud = 0;
    for (let i = 0; i + window < data.length; i += window) {
      let block = 0;
      for (let j = i; j < i + window; j++)
        block = Math.max(block, Math.abs(data[j]));
      if (block < 0.005) quiet++;
      else if (block > 0.02) loud++;
    }
    expect(loud).toBeGreaterThan(8);
    expect(quiet).toBeGreaterThan(loud / 2);
    // And it stays high: crackle sits above the report, not in it.
    expect(brightness(buffer)).toBeGreaterThan(1200);
  });
});
