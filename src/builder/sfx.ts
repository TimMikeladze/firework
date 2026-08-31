/**
 * The firework voices: the lift, the break, and the crackling tail.
 *
 * Nothing here owns a context or a bus. Every voice is scheduled against an
 * absolute `AudioContext` time on a bus somebody else built, exactly like
 * `@/audio/demo-song` — which is what lets `scripts/render-sfx.ts` render the
 * same voices through an `OfflineAudioContext` and write a WAV, and lets the
 * tests assert on real samples instead of on node graphs.
 *
 * The randomness is injected for the same reason. Two shells that break with
 * identical numbers read as one machine gun, so every voice jitters; passing
 * the generator in keeps that jitter reproducible under test.
 *
 * What makes a break sound like a break, in the order the ear gets it:
 *
 *   1. a crack — a few milliseconds of bright broadband transient,
 *   2. a punch — the low body under it, felt more than heard,
 *   3. a roll — a long, uneven rumble as the report comes back off everything
 *      around the listener.
 *
 * Distance is what mixes those three: air eats the crack first, the punch
 * survives it, and the roll grows, because more of what arrives late has
 * bounced off something. A far shell is not a quiet near shell.
 */

import { softClipCurve } from "@/audio/glue";

/** Metres per second. Near enough at show temperatures. */
const SPEED_OF_SOUND = 343;

export type Rng = () => number;

/** The two nodes a voice needs: the dry path, and the send into the tail. */
export interface SfxBus {
  dry: AudioNode;
  wet: AudioNode;
}

export interface Space {
  /** Metres from the listener. */
  distance: number;
  /** -1 hard left to 1 hard right, taken from the camera's own right vector. */
  pan: number;
}

export interface BurstSound extends Space {
  /** 0..1 level for this break, before distance. */
  gain: number;
  /** 0 is a tight salute, 1 is a slow deep thud from a big break. */
  size: number;
  /** Scales the voice down while a barrage is in flight. */
  crowd?: number;
  /** Overrides the character `size` would have picked. */
  character?: BurstCharacterName | BurstCharacter;
}

export interface LiftSound extends Space {
  gain: number;
  /** Seconds from the mortar to the break. */
  seconds: number;
}

export interface CrackleSound extends Space {
  gain: number;
  /** Seconds the stars keep popping. */
  seconds: number;
}

/* ------------------------------------------------------------------ */
/* The distance model                                                  */
/* ------------------------------------------------------------------ */

/** Seconds before a break that far away is heard at all. */
export function travelTime(distance: number): number {
  return Math.max(0, distance) / SPEED_OF_SOUND;
}

/**
 * Level against distance.
 *
 * Not inverse-square: a real report is loud enough that the ear's own
 * compression flattens the curve badly, and the shells here live between about
 * twenty and a hundred and fifty metres out. This holds the near ones at full
 * level and lets the far ones sit a long way back without vanishing.
 */
export function distanceGain(distance: number): number {
  return Math.min(1, 1 / (1 + Math.max(0, distance) / 130));
}

/**
 * The corner air absorption puts on everything, in hertz.
 *
 * Calibrated, not guessed. Air costs a few dB per hundred metres at 4 kHz —
 * dramatic over a kilometre, barely there across a park. A show lives between
 * about twenty and a hundred and fifty metres out, so this has to stay near
 * the top of the band across that whole range: a curve that shuts down to
 * 4 kHz at ninety metres muffles every single break in the show, and the whole
 * thing sounds like it is happening behind a door.
 */
export function airCutoff(distance: number): number {
  return Math.max(1200, Math.min(18000, 18000 * Math.exp(-distance / 320)));
}

/**
 * How much of a voice goes to the tail bus. Farther is wetter, up to a point:
 * past about half a kilometre the reflections stop growing and the whole thing
 * simply gets quieter, and a send that keeps climbing makes a distant break
 * *louder* than a near one.
 */
export function reverbSend(distance: number): number {
  return Math.min(0.6, 0.08 + Math.max(0, distance) / 260);
}

/** Clamps a pan that came from a camera that may be looking anywhere. */
function safePan(pan: number): number {
  return Math.max(-1, Math.min(1, Number.isFinite(pan) ? pan : 0));
}

/* ------------------------------------------------------------------ */
/* Buffers                                                             */
/* ------------------------------------------------------------------ */

/** White noise, looped by every voice that needs a source of hiss. */
export function noiseBuffer(
  ctx: BaseAudioContext,
  seconds: number,
  rng: Rng = Math.random,
): AudioBuffer {
  const frames = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = rng() * 2 - 1;
  return buffer;
}

/**
 * The impulse response every voice sends into: the report coming back off the
 * ground and off whatever is standing around the listener.
 *
 * It is deliberately not a hall. A firework tail is a handful of hard, late
 * slaps — the far bank, the buildings behind — smearing into a rumble that
 * outlasts the shell, so the early reflections are discrete and the diffuse
 * part is dark and slow. The one-pole lowpass over the noise is what keeps it
 * a rumble rather than a two-second hiss, and the channels decorrelate so the
 * tail opens up wider than the shell that fed it.
 */
export function tailImpulse(
  ctx: BaseAudioContext,
  seconds = 2.4,
  rng: Rng = Math.random,
): AudioBuffer {
  const rate = ctx.sampleRate;
  const frames = Math.max(1, Math.floor(rate * seconds));
  const buffer = ctx.createBuffer(2, frames, rate);
  // Metres of extra path, roughly, for the surfaces the show stands in front of.
  const reflections = [
    { at: 0.031, gain: 0.55 },
    { at: 0.058, gain: 0.42 },
    { at: 0.092, gain: 0.33 },
    { at: 0.147, gain: 0.24 },
  ];

  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < frames; i++) {
      const t = i / rate;
      const decay = Math.exp(-t * (2.6 + c * 0.15));
      // Two poles of smoothing, so the tail is a rumble and not a hiss.
      lp += ((rng() * 2 - 1) * decay - lp) * 0.06;
      data[i] = lp;
    }
    for (const r of reflections) {
      const i = Math.floor((r.at + c * 0.004) * rate);
      if (i < frames) data[i] += (rng() * 2 - 1) * r.gain;
    }

    // Normalised by energy rather than by peak, and by hand rather than by the
    // convolver: a two-second impulse response is tens of thousands of taps, so
    // an un-normalised one puts forty decibels of gain on the send and pins the
    // whole show against the limiter. Unit energy makes the send control read
    // as the wet fraction it is named after.
    let energy = 0;
    for (let i = 0; i < frames; i++) energy += data[i] * data[i];
    const scale = 1 / Math.sqrt(Math.max(1e-9, energy));
    for (let i = 0; i < frames; i++) data[i] *= scale;
  }
  return buffer;
}

/* ------------------------------------------------------------------ */
/* The bus                                                             */
/* ------------------------------------------------------------------ */

export interface SfxChain {
  /** What voices are scheduled onto. */
  bus: SfxBus;
  /** The fader at the end of it. */
  master: GainNode;
}

/**
 * Builds the chain every voice runs through: the shared tail, then the glue,
 * then the fader.
 *
 * One convolver serves the whole show. A break is far too short to carry its
 * own space, and sharing one is what makes the shells sound like they are
 * going off in the same place rather than in a rack of separate boxes.
 *
 * The live context and the offline render both build it here, so what
 * `scripts/render-sfx.ts` writes to a WAV is the mix the browser plays.
 */
export function buildSfxChain(
  ctx: BaseAudioContext,
  destination: AudioNode,
  rng: Rng = Math.random,
): SfxChain {
  const master = ctx.createGain();
  master.connect(destination);

  const shaper = ctx.createWaveShaper();
  shaper.curve = softClipCurve();
  shaper.connect(master);

  const glue = ctx.createDynamicsCompressor();
  // Gentle: this is here to catch a finale stacking up, not to flatten every
  // break to the same height. A single shell should pass it almost untouched.
  glue.threshold.value = -10;
  glue.knee.value = 10;
  glue.ratio.value = 6;
  glue.attack.value = 0.003;
  glue.release.value = 0.25;
  glue.connect(shaper);

  const tail = ctx.createConvolver();
  tail.normalize = false;
  tail.buffer = tailImpulse(ctx, 2.4, rng);
  const tailLevel = ctx.createGain();
  tailLevel.gain.value = 0.5;
  tail.connect(tailLevel).connect(glue);

  const wet = ctx.createGain();
  wet.connect(tail);

  return { bus: { dry: glue, wet }, master };
}

/* ------------------------------------------------------------------ */
/* Voices                                                              */
/* ------------------------------------------------------------------ */

interface VoiceOut {
  /** Everything a voice makes goes in here. */
  input: GainNode;
}

/**
 * Builds the panned tap into the bus that a voice writes into, and returns it.
 * Both the dry and the wet path hang off the same pan, so a shell that breaks
 * on the left is also reflected from the left.
 */
function voiceOut(
  ctx: BaseAudioContext,
  bus: SfxBus,
  distance: number,
  pan: number,
): VoiceOut {
  const input = ctx.createGain();
  input.gain.value = 1;
  const panner = ctx.createStereoPanner();
  panner.pan.value = safePan(pan);
  input.connect(panner);
  panner.connect(bus.dry);

  const send = ctx.createGain();
  send.gain.value = reverbSend(distance);
  panner.connect(send).connect(bus.wet);
  return { input };
}

function noiseSource(
  ctx: BaseAudioContext,
  noise: AudioBuffer,
  rng: Rng,
): AudioBufferSourceNode {
  const source = ctx.createBufferSource();
  source.buffer = noise;
  source.loop = true;
  source.loopStart = 0;
  source.loopEnd = noise.duration;
  // Detuned per voice, and every caller starts at a random offset. Without
  // both, a barrage keeps replaying the same few hundred samples of hiss and
  // the ear starts to hear the repeat as a pitch.
  source.playbackRate.value = 0.85 + rng() * 0.3;
  return source;
}

/**
 * How a break is put together. Four of these exist because "an explosion" is
 * not one sound: a salute is a whipcrack, a big chrysanthemum is a shove of
 * air, a bomb is a body with a shape wrapped around it, and they want
 * completely different balances.
 *
 * The one thing they share is that the body is *noise*, not a tuned
 * oscillator. A sine swept down through the floor is a kick drum, and a kick
 * drum is what a firework does not sound like — the ear picks the pitch out
 * immediately and the whole show turns into a drum machine. The sub under it
 * is short and pitchless enough to be felt rather than heard.
 */
export interface BurstCharacter {
  /** The transient: level, and where it sits before the air takes it. */
  crack: number;
  crackHz: number;
  crackSeconds: number;
  /** The noise body — the shove of air that follows the shock. */
  punch: number;
  punchSeconds: number;
  /** How hard the body is driven. This is most of what reads as "explosion". */
  drive: number;
  /** The felt-not-heard thump under the body. Short, or it sings. */
  sub: number;
  subSeconds: number;
  /**
   * Where that thump sits, in hertz, before `size` nudges it. Weight is pitch
   * as much as level: the difference between a report and a detonation is
   * mostly that the detonation's body is an octave lower.
   */
  subHz: number;
  /** The report coming back off everything around the listener. */
  roll: number;
  rollSeconds: number;
}

export const BURST_CHARACTERS = {
  /** Sharp, dry, and over fast. A salute or a small hard break. */
  salute: {
    crack: 1.15,
    crackHz: 3000,
    crackSeconds: 0.05,
    punch: 0.9,
    punchSeconds: 0.13,
    drive: 3.2,
    sub: 0.35,
    subSeconds: 0.1,
    subHz: 62,
    roll: 0.5,
    rollSeconds: 0.5,
  },
  /** The default: a crack, a real shove of air, and a short roll behind it. */
  shell: {
    crack: 1,
    crackHz: 2400,
    crackSeconds: 0.07,
    punch: 1,
    punchSeconds: 0.22,
    drive: 2.6,
    sub: 0.55,
    subSeconds: 0.16,
    subHz: 54,
    roll: 0.85,
    rollSeconds: 0.9,
  },
  /** Big and slow: more air, more sub, and a long tail. */
  deep: {
    crack: 0.7,
    crackHz: 1700,
    crackSeconds: 0.1,
    punch: 1.15,
    punchSeconds: 0.34,
    drive: 2.1,
    sub: 0.9,
    subSeconds: 0.26,
    subHz: 44,
    roll: 1.2,
    rollSeconds: 1.6,
  },
  /**
   * A demolition charge rather than a shell: the crack is a dull slap instead
   * of a whipcrack, almost all of the level is in a long, hard-driven body,
   * and the sub underneath it is an octave down and slow to let go. The roll
   * runs on past the shape, which is what makes the ear place it as something
   * far bigger than the flash it just saw.
   */
  bomb: {
    crack: 0.6,
    crackHz: 1100,
    crackSeconds: 0.13,
    punch: 1.3,
    punchSeconds: 0.46,
    drive: 4.4,
    sub: 1.15,
    subSeconds: 0.44,
    subHz: 30,
    roll: 1.5,
    rollSeconds: 2,
  },
} as const satisfies Record<string, BurstCharacter>;

export type BurstCharacterName = keyof typeof BURST_CHARACTERS;

/**
 * The saturation curve for the body.
 *
 * A break is loud enough to be non-linear on its way to the ear, and running
 * the body through a hard tanh is what puts the harmonics of that
 * non-linearity back — the difference between a puff of filtered noise and
 * something that has actually gone off.
 */
function driveCurve(drive: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
  }
  return curve;
}

/**
 * The break.
 *
 * `at` is when the shell breaks — the visual event. The sound is placed at
 * `at + travelTime(distance)` here rather than by the caller, so the delay
 * across the show is consistent and the renderer never has to know about the
 * speed of sound.
 */
export function scheduleBurst(
  ctx: BaseAudioContext,
  bus: SfxBus,
  noise: AudioBuffer,
  at: number,
  sound: BurstSound,
  rng: Rng = Math.random,
): void {
  const size = Math.max(0, Math.min(1, sound.size));
  const distance = Math.max(0, sound.distance);
  const level = sound.gain * distanceGain(distance) * (sound.crowd ?? 1);
  if (level <= 0.003) return;

  const voice =
    typeof sound.character === "string"
      ? BURST_CHARACTERS[sound.character]
      : (sound.character ??
        // Small breaks crack, big ones shove. The size slider picks the
        // character as well as tuning it.
        (size < 0.34
          ? BURST_CHARACTERS.salute
          : size > 0.72
            ? BURST_CHARACTERS.deep
            : BURST_CHARACTERS.shell));

  const t = at + travelTime(distance);
  const out = voiceOut(ctx, bus, distance, sound.pan).input;
  const cutoff = airCutoff(distance);
  // A break whose crack the air has already eaten only gets a body and a roll.
  const crackHeard = Math.min(1, cutoff / 9000);

  /* 1. The crack. Milliseconds long, and the whole reason a near break makes
        people flinch. */
  if (crackHeard > 0.05) {
    const crack = noiseSource(ctx, noise, rng);
    // A highpass, not a bandpass: a shock front is broadband, and a resonant
    // band turns it into a tuned tick.
    const high = ctx.createBiquadFilter();
    high.type = "highpass";
    high.Q.value = 0.7;
    const crackHz = voice.crackHz * (0.85 + rng() * 0.3);
    high.frequency.setValueAtTime(Math.min(crackHz, cutoff * 0.9), t);
    high.frequency.exponentialRampToValueAtTime(
      Math.max(300, Math.min(crackHz * 0.2, cutoff)),
      t + voice.crackSeconds * 1.6,
    );
    const lid = ctx.createBiquadFilter();
    lid.type = "lowpass";
    lid.frequency.value = cutoff;

    const amp = ctx.createGain();
    const peak = 0.52 * level * crackHeard * voice.crack;
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.linearRampToValueAtTime(peak, t + 0.001);
    amp.gain.exponentialRampToValueAtTime(
      0.0001,
      t + voice.crackSeconds * (0.85 + rng() * 0.3),
    );

    crack.connect(high).connect(lid).connect(amp).connect(out);
    crack.start(t, rng() * noise.duration);
    crack.stop(t + 0.25);
  }

  /* 2. The body: air being shoved, driven hard. Noise, never an oscillator —
        a swept sine here is a kick drum, and the ear hears the note. */
  const punchSeconds = voice.punchSeconds * (0.9 + rng() * 0.2);
  const body = noiseSource(ctx, noise, rng);
  // Flat, not resonant, and it barely moves. A resonant lowpass swept down
  // through the body is a filter sweep, and the ear knows a synth when it
  // hears one; a real break just loses its top as it decays.
  const bodyLow = ctx.createBiquadFilter();
  bodyLow.type = "lowpass";
  bodyLow.Q.value = 0.6;
  bodyLow.frequency.setValueAtTime(Math.min(2200 - size * 700, cutoff), t);
  bodyLow.frequency.exponentialRampToValueAtTime(
    420 + size * 120,
    t + punchSeconds * 2,
  );
  // And the weight sits where a report's weight actually sits — a couple of
  // hundred hertz — rather than in the sub, which is felt but not heard.
  const bodyHigh = ctx.createBiquadFilter();
  bodyHigh.type = "highpass";
  bodyHigh.Q.value = 0.5;
  bodyHigh.frequency.value = 70;

  const shaper = ctx.createWaveShaper();
  shaper.curve = driveCurve(voice.drive);
  // Saturating noise generates harmonics well past Nyquist. Without
  // oversampling they fold back down the band as a metallic fizz, which is
  // exactly the "cheap" in a cheap explosion.
  shaper.oversample = "4x";

  const bodyAmp = ctx.createGain();
  bodyAmp.gain.setValueAtTime(0.0001, t);
  bodyAmp.gain.linearRampToValueAtTime(1.0 * level * voice.punch, t + 0.004);
  bodyAmp.gain.exponentialRampToValueAtTime(0.0001, t + punchSeconds * 2.2);
  body
    .connect(bodyHigh)
    .connect(bodyLow)
    .connect(shaper)
    .connect(bodyAmp)
    .connect(out);
  body.start(t, rng() * noise.duration);
  body.stop(t + punchSeconds * 2.4 + 0.1);

  /* 3. The sub. Short and low — the part that is felt. It falls fast enough
        that it never resolves into a note. */
  const sub = ctx.createOscillator();
  sub.type = "sine";
  const subHz = voice.subHz * (1 - size * 0.22) * (0.92 + rng() * 0.16);
  sub.frequency.setValueAtTime(subHz * 2.4, t);
  sub.frequency.exponentialRampToValueAtTime(subHz, t + voice.subSeconds * 0.5);
  const subAmp = ctx.createGain();
  subAmp.gain.setValueAtTime(0.0001, t);
  subAmp.gain.linearRampToValueAtTime(0.62 * level * voice.sub, t + 0.006);
  subAmp.gain.exponentialRampToValueAtTime(0.0001, t + voice.subSeconds * 1.8);
  sub.connect(subAmp).connect(out);
  sub.start(t);
  sub.stop(t + voice.subSeconds * 2 + 0.05);

  /* 4. The roll. Uneven on purpose: a smooth decay here reads as a synth pad,
        and what a real report does on the way back is stumble. */
  const rollSeconds = Math.min(
    2.2,
    voice.rollSeconds + Math.min(distance, 140) * 0.005 + rng() * 0.2,
  );
  const roll = noiseSource(ctx, noise, rng);
  const rollLow = ctx.createBiquadFilter();
  rollLow.type = "lowpass";
  rollLow.Q.value = 0.7;
  rollLow.frequency.setValueAtTime(Math.min(700 - size * 220, cutoff), t);
  rollLow.frequency.exponentialRampToValueAtTime(
    90 + size * 20,
    t + rollSeconds,
  );

  const rollAmp = ctx.createGain();
  // Distance shifts a break's weight from its crack into its roll — but only
  // so far, or the horizon ends up louder than the front row.
  const rollPeak =
    0.21 * level * voice.roll * (0.7 + Math.min(1, distance / 180) * 0.5);
  rollAmp.gain.setValueAtTime(0.0001, t);
  rollAmp.gain.linearRampToValueAtTime(rollPeak, t + 0.04 + distance * 0.0006);
  const steps = 7;
  for (let i = 1; i <= steps; i++) {
    const frac = i / steps;
    const wobble = 0.45 + rng() * 0.85;
    rollAmp.gain.exponentialRampToValueAtTime(
      Math.max(0.0001, rollPeak * Math.exp(-3.1 * frac) * wobble),
      t + frac * rollSeconds,
    );
  }
  rollAmp.gain.exponentialRampToValueAtTime(0.0001, t + rollSeconds + 0.15);
  roll.connect(rollLow).connect(rollAmp).connect(out);
  roll.start(t, rng() * noise.duration);
  roll.stop(t + rollSeconds + 0.2);
}

/**
 * The lift: the mortar's own thump, then the whistle that climbs with the
 * shell.
 *
 * The whistle is the shell's rising tube, so it warbles — a perfectly steady
 * band of noise sounds like a test tone. It also fades well before the break:
 * the shell is running away from the listener, and a lift still at full level
 * when the break lands muddies the transient that matters most.
 */
export function scheduleLift(
  ctx: BaseAudioContext,
  bus: SfxBus,
  noise: AudioBuffer,
  at: number,
  sound: LiftSound,
  rng: Rng = Math.random,
): void {
  const seconds = Math.max(0.15, sound.seconds);
  const distance = Math.max(0, sound.distance);
  const level = sound.gain * distanceGain(distance);
  if (level <= 0.003) return;

  const t = at + travelTime(distance);
  const out = voiceOut(ctx, bus, distance, sound.pan).input;
  const cutoff = airCutoff(distance);

  // The mortar. Low, short, and dry — the shove that puts the shell up.
  const chuff = noiseSource(ctx, noise, rng);
  const chuffLow = ctx.createBiquadFilter();
  chuffLow.type = "lowpass";
  chuffLow.frequency.setValueAtTime(Math.min(900, cutoff), t);
  chuffLow.frequency.exponentialRampToValueAtTime(160, t + 0.2);
  const chuffAmp = ctx.createGain();
  chuffAmp.gain.setValueAtTime(0.0001, t);
  chuffAmp.gain.linearRampToValueAtTime(0.6 * level, t + 0.005);
  chuffAmp.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
  chuff.connect(chuffLow).connect(chuffAmp).connect(out);
  chuff.start(t, rng() * noise.duration);
  chuff.stop(t + 0.35);

  // The whistle, climbing with the shell and thinning as it goes away.
  const whistle = noiseSource(ctx, noise, rng);
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.Q.value = 16;
  const from = 780 + rng() * 220;
  const to = Math.min(2600 + rng() * 500, Math.max(from * 1.2, cutoff));
  band.frequency.setValueAtTime(from, t);
  // Most of the climb happens early, while the shell is still fast.
  band.frequency.exponentialRampToValueAtTime(to * 0.8, t + seconds * 0.45);
  band.frequency.exponentialRampToValueAtTime(to, t + seconds);

  // The warble. Cheap — one oscillator into the filter's own frequency.
  const vibrato = ctx.createOscillator();
  vibrato.type = "sine";
  vibrato.frequency.value = 5.5 + rng() * 3;
  const vibratoDepth = ctx.createGain();
  vibratoDepth.gain.value = 45 + rng() * 35;
  vibrato.connect(vibratoDepth).connect(band.frequency);
  vibrato.start(t);
  vibrato.stop(t + seconds);

  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0.0001, t);
  amp.gain.exponentialRampToValueAtTime(0.2 * level, t + seconds * 0.28);
  amp.gain.exponentialRampToValueAtTime(0.05 * level, t + seconds * 0.8);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + seconds);

  whistle.connect(band).connect(amp).connect(out);
  whistle.start(t, rng() * noise.duration);
  whistle.stop(t + seconds + 0.05);
}

/**
 * The tail: the dry, irregular popping of crackling stars.
 *
 * One noise source does all of it. Each pop steps the filter and the pan to a
 * new random place before it sounds, which costs nothing — they are parameter
 * events, not nodes — and is the whole difference between a field of little
 * fires and a single band of hiss being chopped up.
 */
export function scheduleCrackle(
  ctx: BaseAudioContext,
  bus: SfxBus,
  noise: AudioBuffer,
  at: number,
  sound: CrackleSound,
  rng: Rng = Math.random,
): void {
  const seconds = Math.max(0.2, Math.min(3.5, sound.seconds));
  const distance = Math.max(0, sound.distance);
  const level = sound.gain * distanceGain(distance);
  if (level <= 0.003) return;

  // The stars have to be lit before they can pop.
  const t = at + travelTime(distance) + 0.05;
  const cutoff = airCutoff(distance);
  if (cutoff < 900) return;

  const input = ctx.createGain();
  const panner = ctx.createStereoPanner();
  const basePan = safePan(sound.pan);
  input.connect(panner);
  panner.connect(bus.dry);
  const send = ctx.createGain();
  send.gain.value = reverbSend(distance);
  panner.connect(send).connect(bus.wet);

  const source = noiseSource(ctx, noise, rng);
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.Q.value = 2.4;

  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0.0001, t);

  // Dense at the start, thinning as the stars burn out.
  const pops = Math.max(6, Math.min(64, Math.round(seconds * 22)));
  let cursor = 0;
  for (let i = 0; i < pops; i++) {
    const frac = i / pops;
    cursor += (seconds / pops) * (0.35 + rng() * 1.6) * (0.7 + frac);
    const pop = t + Math.min(seconds, cursor);
    const hz = Math.min(cutoff, 1700 + rng() * 5200);
    band.frequency.setValueAtTime(hz, pop);
    panner.pan.setValueAtTime(
      safePan(basePan * 0.6 + (rng() - 0.5) * 1.3),
      pop,
    );
    const fade = 1 - frac * 0.8;
    const peak = 0.3 * level * fade * (0.35 + rng() * 1.1);
    amp.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), pop + 0.0015);
    amp.gain.exponentialRampToValueAtTime(0.0001, pop + 0.008 + rng() * 0.012);
  }

  source.connect(band).connect(amp).connect(input);
  source.start(t, rng() * noise.duration);
  source.stop(t + seconds + 0.2);
}
