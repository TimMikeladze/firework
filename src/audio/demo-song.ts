import type { Section } from "./analysis";
import { softClipCurve } from "./glue";

/**
 * The bundled demo track, synthesized rather than loaded as a file. Every voice
 * is scheduled ahead of time against a single start offset, so anything keyed
 * to the same clock — the game's chart, the builder's cue list — stays
 * sample-accurate against what the listener hears.
 */

export const DEMO_BPM = 124;
export const DEMO_BEAT = 60 / DEMO_BPM;
export const DEMO_BAR = DEMO_BEAT * 4;
/** 32 bars ≈ 62s. */
export const DEMO_BARS = 32;
export const DEMO_DURATION = DEMO_BAR * DEMO_BARS;

interface SongSection {
  bar: number;
  kind: Section["kind"];
  intensity: number;
}

const SONG_SECTIONS: SongSection[] = [
  { bar: 0, kind: "intro", intensity: 0.2 },
  { bar: 4, kind: "verse", intensity: 0.4 },
  { bar: 10, kind: "build", intensity: 0.65 },
  { bar: 14, kind: "chorus", intensity: 0.85 },
  { bar: 20, kind: "verse", intensity: 0.45 },
  { bar: 24, kind: "build", intensity: 0.7 },
  { bar: 26, kind: "drop", intensity: 1 },
  { bar: 30, kind: "outro", intensity: 0.35 },
];

export const DEMO_SECTIONS: Section[] = SONG_SECTIONS.map((s) => ({
  time: s.bar * DEMO_BAR,
  kind: s.kind,
  intensity: s.intensity,
}));

export function demoSectionForBar(bar: number): SongSection {
  let current = SONG_SECTIONS[0];
  for (const s of SONG_SECTIONS) {
    if (s.bar <= bar) current = s;
    else break;
  }
  return current;
}

/* ------------------------------------------------------------------ */
/* Synthesis                                                           */
/* ------------------------------------------------------------------ */

/**
 * Every voice is filtered, and most of them are two oscillators rather than
 * one. A bare `sawtooth` or `square` straight into the output is the sound of
 * a beeper: all the harmonics, all the time, no movement. A lowpass with an
 * envelope on it is what makes a note read as plucked or struck, and a couple
 * of cents of detune is what makes a pad sound like more than one voice.
 */

/** Deterministic PRNG, so the track sounds identical on every play. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 0xffffffff;
  };
}

function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * 0.5);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  const rand = seeded(0x2f6e2b1);
  for (let i = 0; i < len; i++) data[i] = rand() * 2 - 1;
  return buf;
}

function noiseSource(
  ctx: BaseAudioContext,
  noise: AudioBuffer,
): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.loop = true;
  return src;
}

/**
 * A set of fixed positions across the stereo field, built once and shared.
 *
 * A panner per note would be a few hundred extra nodes for a track that is
 * already scheduled in one go, and nothing here needs to move while it sounds.
 */
function stereoField(ctx: BaseAudioContext, out: AudioNode) {
  const taps = new Map<string, GainNode>();
  return (pan: number): GainNode => {
    const clamped = Math.max(-1, Math.min(1, pan));
    const key = clamped.toFixed(2);
    const found = taps.get(key);
    if (found) return found;
    const gain = ctx.createGain();
    const panner = ctx.createStereoPanner();
    panner.pan.value = clamped;
    gain.connect(panner).connect(out);
    taps.set(key, gain);
    return gain;
  };
}

/**
 * The kick: a pitch drop for the body, a click on top so it cuts through on a
 * laptop speaker, and a lowpass to keep the drop from whistling.
 */
function kick(
  ctx: BaseAudioContext,
  out: AudioNode,
  noise: AudioBuffer,
  t: number,
  gainScale = 1,
) {
  const osc = ctx.createOscillator();
  const low = ctx.createBiquadFilter();
  low.type = "lowpass";
  low.frequency.value = 320;
  const gain = ctx.createGain();
  osc.frequency.setValueAtTime(170, t);
  osc.frequency.exponentialRampToValueAtTime(44, t + 0.09);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.linearRampToValueAtTime(0.8 * gainScale, t + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
  osc.connect(low).connect(gain).connect(out);
  osc.start(t);
  osc.stop(t + 0.32);

  const click = noiseSource(ctx, noise);
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 2200;
  band.Q.value = 0.8;
  const clickGain = ctx.createGain();
  clickGain.gain.setValueAtTime(0.28 * gainScale, t);
  clickGain.gain.exponentialRampToValueAtTime(0.001, t + 0.02);
  click.connect(band).connect(clickGain).connect(out);
  click.start(t);
  click.stop(t + 0.05);
}

/**
 * The snare: noise for the wires, a tuned body under it so it has a note, and
 * a short bright layer on top for the snap.
 */
function snare(
  ctx: BaseAudioContext,
  out: AudioNode,
  noise: AudioBuffer,
  t: number,
  level = 1,
) {
  const src = noiseSource(ctx, noise);
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.setValueAtTime(2200, t);
  bp.frequency.exponentialRampToValueAtTime(1200, t + 0.16);
  bp.Q.value = 0.7;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.linearRampToValueAtTime(0.36 * level, t + 0.003);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.17);
  src.connect(bp).connect(gain).connect(out);
  src.start(t);
  src.stop(t + 0.2);

  const body = ctx.createOscillator();
  body.type = "triangle";
  body.frequency.setValueAtTime(210, t);
  body.frequency.exponentialRampToValueAtTime(150, t + 0.08);
  const bodyGain = ctx.createGain();
  bodyGain.gain.setValueAtTime(0.0001, t);
  bodyGain.gain.linearRampToValueAtTime(0.24 * level, t + 0.003);
  bodyGain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
  body.connect(bodyGain).connect(out);
  body.start(t);
  body.stop(t + 0.12);
}

/** The hats. `open` is the only thing separating a tick from a wash. */
function hat(
  ctx: BaseAudioContext,
  out: AudioNode,
  noise: AudioBuffer,
  t: number,
  level: number,
  open = false,
) {
  const src = noiseSource(ctx, noise);
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 8200;
  const tone = ctx.createBiquadFilter();
  tone.type = "bandpass";
  tone.frequency.value = 11000;
  tone.Q.value = 0.5;
  const gain = ctx.createGain();
  const decay = open ? 0.19 : 0.045;
  gain.gain.setValueAtTime(level, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + decay);
  src.connect(hp).connect(tone).connect(gain).connect(out);
  src.start(t);
  src.stop(t + decay + 0.02);
}

/**
 * The bass: a square and a sine an octave apart, through a lowpass that opens
 * on the attack and shuts again. The sine is what a phone speaker gets to keep
 * when the square's fundamental is gone.
 */
function bass(
  ctx: BaseAudioContext,
  out: AudioNode,
  t: number,
  freq: number,
  dur: number,
  level: number,
) {
  const low = ctx.createBiquadFilter();
  low.type = "lowpass";
  // Gently resonant. A high Q here is a +15 dB peak at the cutoff, which is
  // most of a mix's headroom spent on one note.
  low.Q.value = 1.6;
  low.frequency.setValueAtTime(freq * 10, t);
  low.frequency.exponentialRampToValueAtTime(freq * 3, t + dur * 0.7);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.linearRampToValueAtTime(level, t + 0.008);
  gain.gain.setTargetAtTime(0.0001, t + dur * 0.5, dur * 0.25);
  low.connect(gain).connect(out);

  const square = ctx.createOscillator();
  square.type = "square";
  square.frequency.value = freq;
  square.connect(low);
  square.start(t);
  square.stop(t + dur + 0.05);

  const sub = ctx.createOscillator();
  sub.type = "sine";
  sub.frequency.value = freq;
  const subGain = ctx.createGain();
  subGain.gain.setValueAtTime(0.0001, t);
  subGain.gain.linearRampToValueAtTime(level * 0.8, t + 0.008);
  subGain.gain.setTargetAtTime(0.0001, t + dur * 0.5, dur * 0.25);
  sub.connect(subGain).connect(out);
  sub.start(t);
  sub.stop(t + dur + 0.05);
}

/**
 * A pad voice: two saws a few cents apart, filtered dark, with a slow swell.
 * The detune is the whole trick — one saw is a buzzer, two is a chord.
 */
function pad(
  ctx: BaseAudioContext,
  out: AudioNode,
  t: number,
  freq: number,
  dur: number,
  level: number,
) {
  const low = ctx.createBiquadFilter();
  low.type = "lowpass";
  low.frequency.setValueAtTime(700, t);
  low.frequency.linearRampToValueAtTime(1500, t + dur * 0.6);
  low.Q.value = 0.8;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.linearRampToValueAtTime(level, t + dur * 0.25);
  gain.gain.setTargetAtTime(0.0001, t + dur * 0.6, dur * 0.3);
  low.connect(gain).connect(out);

  for (const cents of [-7, 7]) {
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = freq;
    osc.detune.value = cents;
    osc.connect(low);
    osc.start(t);
    osc.stop(t + dur + 0.1);
  }
}

/** A plucked note: short, filtered, and gone before the next one. */
function pluck(
  ctx: BaseAudioContext,
  out: AudioNode,
  t: number,
  freq: number,
  dur: number,
  level: number,
  type: OscillatorType = "square",
) {
  const low = ctx.createBiquadFilter();
  low.type = "lowpass";
  low.Q.value = 1.2;
  low.frequency.setValueAtTime(Math.min(9000, freq * 9), t);
  low.frequency.exponentialRampToValueAtTime(
    Math.max(220, freq * 1.6),
    t + dur,
  );

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.linearRampToValueAtTime(level, t + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  low.connect(gain).connect(out);

  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  osc.connect(low);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

const MIDI_A4 = 69;
const note = (semitone: number) => 440 * 2 ** ((semitone - MIDI_A4) / 12);

// A minor progression, one chord per bar in a 4-bar loop.
const CHORDS = [
  [57, 60, 64], // Am
  [53, 57, 60], // F
  [55, 59, 62], // G
  [48, 55, 64], // C/E-ish
];

/**
 * Schedules the whole demo track. `startTime` is an absolute AudioContext time;
 * every event is placed relative to it, so gameplay can use
 * `ctx.currentTime - startTime` as the song position with no drift.
 *
 * The mix is three buses: the drums stay dry and centred, the melodic voices
 * feed a dotted-eighth delay for width, and everything meets at a limiter so a
 * chorus cannot push the track into the ceiling — the show's own reports are
 * playing over the top of it.
 */
export function scheduleDemoSong(
  ctx: BaseAudioContext,
  destination: AudioNode,
  startTime: number,
) {
  const master = ctx.createGain();
  master.gain.value = 0.16;

  const shaper = ctx.createWaveShaper();
  shaper.curve = softClipCurve();
  shaper.connect(destination);

  const glue = ctx.createDynamicsCompressor();
  glue.threshold.value = -10;
  glue.knee.value = 12;
  glue.ratio.value = 5;
  glue.attack.value = 0.004;
  glue.release.value = 0.2;
  master.connect(glue).connect(shaper);

  // One delay per side, at different times, is the cheapest honest stereo
  // there is: no reverb tail to smear the transients the show reads as beats.
  const echo = ctx.createGain();
  echo.gain.value = 0.22;
  for (const [beats, pan] of [
    [0.75, -0.6],
    [0.5, 0.55],
  ] as const) {
    const delay = ctx.createDelay(2);
    delay.delayTime.value = DEMO_BEAT * beats;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.28;
    const damp = ctx.createBiquadFilter();
    damp.type = "lowpass";
    damp.frequency.value = 2600;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    echo.connect(delay);
    delay.connect(damp).connect(feedback).connect(delay);
    damp.connect(panner).connect(master);
  }

  const noise = noiseBuffer(ctx);
  const across = stereoField(ctx, master);

  for (let bar = 0; bar < DEMO_BARS; bar++) {
    const t0 = startTime + bar * DEMO_BAR;
    const section = demoSectionForBar(bar);
    const energy = section.intensity;
    const chord = CHORDS[bar % CHORDS.length];

    // Pad: sustained chord under everything, spread across the stereo field.
    chord.forEach((semi, i) => {
      const out = across((i - 1) * 0.45);
      pad(ctx, out, t0, note(semi - 12), DEMO_BAR * 0.95, 0.06 + energy * 0.05);
    });

    if (section.kind === "intro") {
      kick(ctx, master, noise, t0, 0.6);
      hat(ctx, across(0.2), noise, t0 + DEMO_BEAT * 2, 0.07);
      for (let i = 0; i < 4; i++) {
        const voice = ctx.createGain();
        voice.connect(across(i % 2 === 0 ? -0.3 : 0.3));
        voice.connect(echo);
        pluck(
          ctx,
          voice,
          t0 + DEMO_BEAT * i,
          note(chord[i % 3] + 12),
          0.3,
          0.09,
          "triangle",
        );
      }
      continue;
    }

    if (section.kind === "outro") {
      kick(ctx, master, noise, t0, 0.7);
      snare(ctx, master, noise, t0 + DEMO_BEAT * 2, 0.8);
      for (let i = 0; i < 4; i++) {
        const voice = ctx.createGain();
        voice.connect(master);
        voice.connect(echo);
        pluck(
          ctx,
          voice,
          t0 + DEMO_BEAT * i,
          note(chord[i % 3]),
          0.4,
          0.1,
          "triangle",
        );
      }
      continue;
    }

    // Four-on-the-floor with backbeat snare.
    for (let b = 0; b < 4; b++) kick(ctx, master, noise, t0 + DEMO_BEAT * b);
    snare(ctx, master, noise, t0 + DEMO_BEAT);
    snare(ctx, master, noise, t0 + DEMO_BEAT * 3);

    // Hats: eighths normally, sixteenths once the energy is up. The offbeat
    // one opens in the busier sections, which is what carries the lift.
    const hatDiv = energy >= 0.65 ? 0.25 : 0.5;
    for (let t = 0; t < 4; t += hatDiv) {
      const onBeat = t % 1 === 0;
      const open = energy >= 0.65 && t % 1 === 0.5;
      hat(
        ctx,
        across(onBeat ? 0.12 : -0.28),
        noise,
        t0 + DEMO_BEAT * t,
        onBeat ? 0.11 : 0.06,
        open,
      );
    }

    // Bass on the root, eighth-note pulse.
    for (let b = 0; b < 8; b++) {
      bass(
        ctx,
        master,
        t0 + DEMO_BEAT * 0.5 * b,
        note(chord[0] - 24),
        DEMO_BEAT * 0.45,
        0.2,
      );
    }

    // Arp rides on top and gets busier with intensity.
    const arpDiv = energy >= 0.8 ? 0.25 : 0.5;
    let step = 0;
    for (let t = 0; t < 4; t += arpDiv) {
      const semi = chord[step % chord.length] + (step % 6 >= 3 ? 12 : 0);
      const voice = ctx.createGain();
      voice.connect(across(step % 2 === 0 ? -0.35 : 0.35));
      voice.connect(echo);
      pluck(
        ctx,
        voice,
        t0 + DEMO_BEAT * t,
        note(semi + 12),
        arpDiv * DEMO_BEAT * 0.9,
        0.07 + energy * 0.05,
      );
      step++;
    }

    if (section.kind === "drop") {
      // Octave stab on every downbeat for the climax.
      pluck(
        ctx,
        master,
        t0,
        note(chord[0] + 24),
        DEMO_BEAT * 0.5,
        0.13,
        "sawtooth",
      );
    }
  }

  return master;
}

/**
 * Renders the demo track offline into a buffer.
 *
 * The builder analyses whatever it is about to play, and analysis needs
 * samples, so the demo goes through the same decode → analyse → choreograph
 * path an imported file does instead of a shortcut around it.
 */
export async function renderDemoTrack(
  sampleRate = 44100,
): Promise<AudioBuffer> {
  const frames = Math.ceil(DEMO_DURATION * sampleRate);
  const offline = new OfflineAudioContext(2, frames, sampleRate);
  scheduleDemoSong(offline, offline.destination, 0);
  return await offline.startRendering();
}
