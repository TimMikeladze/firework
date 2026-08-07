import type { Chart, Note, Section } from "./types";
import { LANE_COUNT } from "./types";

/**
 * The bundled demo track is synthesized in the browser rather than loaded as a
 * file. Every voice is scheduled ahead of time against a single start offset on
 * the AudioContext clock, so the chart below — authored on the same BPM grid —
 * is sample-accurate against what the player hears.
 */

export const DEMO_BPM = 124;
const BEAT = 60 / DEMO_BPM;
const BAR = BEAT * 4;
/** 32 bars ≈ 62s. */
const BARS = 32;
export const DEMO_DURATION = BAR * BARS;

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
  time: s.bar * BAR,
  kind: s.kind,
  intensity: s.intensity,
}));

function sectionForBar(bar: number): SongSection {
  let current = SONG_SECTIONS[0];
  for (const s of SONG_SECTIONS) {
    if (s.bar <= bar) current = s;
    else break;
  }
  return current;
}

/**
 * Authored note pattern. Each section gets a hand-picked rhythm figure; the
 * lane assignment is deterministic so the chart is identical every play.
 */
function buildNotes(): Note[] {
  const notes: Note[] = [];
  const push = (time: number, lane: number) => {
    notes.push({ time, lane: ((lane % LANE_COUNT) + LANE_COUNT) % LANE_COUNT });
  };

  for (let bar = 0; bar < BARS; bar++) {
    const t0 = bar * BAR;
    const kind = sectionForBar(bar).kind;
    const barIndex = bar % 4;

    switch (kind) {
      case "intro": {
        // One note on the downbeat, walking across the pads.
        push(t0, bar % LANE_COUNT);
        if (bar >= 2) push(t0 + BEAT * 2, (bar + 2) % LANE_COUNT);
        break;
      }
      case "verse": {
        // Quarter notes with a syncopated tail every other bar.
        push(t0, 0);
        push(t0 + BEAT, 2);
        push(t0 + BEAT * 2, 1);
        push(t0 + BEAT * 3, 3);
        if (barIndex % 2 === 1) push(t0 + BEAT * 3.5, 2);
        break;
      }
      case "build": {
        // Eighths that tighten into sixteenths on the last bar of the build.
        for (let i = 0; i < 8; i++) {
          push(t0 + BEAT * 0.5 * i, i % 2 === 0 ? i / 2 : 3 - ((i / 2) | 0));
        }
        if (barIndex === 3) {
          for (let i = 0; i < 4; i++) push(t0 + BEAT * 3 + BEAT * 0.25 * i, i);
        }
        break;
      }
      case "chorus": {
        // Driving eighths with a two-lane stack on each downbeat.
        push(t0, 0);
        push(t0, 3);
        for (let i = 1; i < 8; i++) {
          push(
            t0 + BEAT * 0.5 * i,
            i % 2 === 0 ? (i / 2) % LANE_COUNT : 3 - (i % LANE_COUNT),
          );
        }
        break;
      }
      case "drop": {
        // Densest figure: sixteenth runs sweeping outward, stacks on the beat.
        for (let b = 0; b < 4; b++) {
          push(t0 + BEAT * b, b % 2 === 0 ? 0 : 1);
          push(t0 + BEAT * b, b % 2 === 0 ? 3 : 2);
          push(t0 + BEAT * b + BEAT * 0.25, b % LANE_COUNT);
          push(t0 + BEAT * b + BEAT * 0.5, (b + 1) % LANE_COUNT);
          push(t0 + BEAT * b + BEAT * 0.75, (b + 2) % LANE_COUNT);
        }
        break;
      }
      case "outro": {
        push(t0, 1);
        push(t0 + BEAT * 2, 2);
        break;
      }
    }
  }

  notes.sort((a, b) => a.time - b.time || a.lane - b.lane);
  return notes;
}

export const DEMO_CHART: Chart = {
  id: "demo-pulse-show",
  title: "Pulse Show",
  artist: "Synthesized in your browser",
  bpm: DEMO_BPM,
  duration: DEMO_DURATION,
  notes: buildNotes(),
  sections: DEMO_SECTIONS,
};

/* ------------------------------------------------------------------ */
/* Synthesis                                                           */
/* ------------------------------------------------------------------ */

function kick(ctx: BaseAudioContext, out: AudioNode, t: number, gainScale = 1) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.setValueAtTime(150, t);
  osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);
  gain.gain.setValueAtTime(0.9 * gainScale, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
  osc.connect(gain).connect(out);
  osc.start(t);
  osc.stop(t + 0.3);
}

function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * 0.4);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  // Deterministic PRNG so the track sounds identical on every play.
  let seed = 0x2f6e2b1;
  for (let i = 0; i < len; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    data[i] = (seed / 0xffffffff) * 2 - 1;
  }
  return buf;
}

function hat(
  ctx: BaseAudioContext,
  out: AudioNode,
  noise: AudioBuffer,
  t: number,
  level: number,
) {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 7000;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(level, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
  src.connect(hp).connect(gain).connect(out);
  src.start(t);
  src.stop(t + 0.06);
}

function snare(
  ctx: BaseAudioContext,
  out: AudioNode,
  noise: AudioBuffer,
  t: number,
) {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 1900;
  bp.Q.value = 0.8;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.5, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
  src.connect(bp).connect(gain).connect(out);
  src.start(t);
  src.stop(t + 0.2);
}

function tone(
  ctx: BaseAudioContext,
  out: AudioNode,
  t: number,
  freq: number,
  dur: number,
  level: number,
  type: OscillatorType,
) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(level, t + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(out);
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
 */
export function scheduleDemoSong(
  ctx: BaseAudioContext,
  destination: AudioNode,
  startTime: number,
) {
  const master = ctx.createGain();
  master.gain.value = 0.55;
  master.connect(destination);

  const noise = noiseBuffer(ctx);

  for (let bar = 0; bar < BARS; bar++) {
    const t0 = startTime + bar * BAR;
    const section = sectionForBar(bar);
    const energy = section.intensity;
    const chord = CHORDS[bar % CHORDS.length];

    // Pad: sustained chord under everything.
    for (const semi of chord) {
      tone(
        ctx,
        master,
        t0,
        note(semi - 12),
        BAR * 0.95,
        0.05 + energy * 0.05,
        "sawtooth",
      );
    }

    if (section.kind === "intro") {
      kick(ctx, master, t0, 0.6);
      for (let i = 0; i < 4; i++)
        tone(
          ctx,
          master,
          t0 + BEAT * i,
          note(chord[i % 3] + 12),
          0.3,
          0.08,
          "triangle",
        );
      continue;
    }

    if (section.kind === "outro") {
      kick(ctx, master, t0, 0.7);
      snare(ctx, master, noise, t0 + BEAT * 2);
      for (let i = 0; i < 4; i++)
        tone(
          ctx,
          master,
          t0 + BEAT * i,
          note(chord[i % 3]),
          0.4,
          0.09,
          "triangle",
        );
      continue;
    }

    // Four-on-the-floor with backbeat snare.
    for (let b = 0; b < 4; b++) kick(ctx, master, t0 + BEAT * b);
    snare(ctx, master, noise, t0 + BEAT);
    snare(ctx, master, noise, t0 + BEAT * 3);

    // Hats: eighths normally, sixteenths once the energy is up.
    const hatDiv = energy >= 0.65 ? 0.25 : 0.5;
    for (let t = 0; t < 4; t += hatDiv) {
      hat(ctx, master, noise, t0 + BEAT * t, t % 1 === 0 ? 0.12 : 0.07);
    }

    // Bass on the root, eighth-note pulse.
    for (let b = 0; b < 8; b++) {
      tone(
        ctx,
        master,
        t0 + BEAT * 0.5 * b,
        note(chord[0] - 24),
        0.22,
        0.22,
        "square",
      );
    }

    // Arp rides on top and gets busier with intensity.
    const arpDiv = energy >= 0.8 ? 0.25 : 0.5;
    let step = 0;
    for (let t = 0; t < 4; t += arpDiv) {
      const semi = chord[step % chord.length] + (step % 6 >= 3 ? 12 : 0);
      tone(
        ctx,
        master,
        t0 + BEAT * t,
        note(semi + 12),
        arpDiv * BEAT * 0.9,
        0.06 + energy * 0.06,
        "square",
      );
      step++;
    }

    if (section.kind === "drop") {
      // Octave stab on every downbeat for the climax.
      tone(ctx, master, t0, note(chord[0] + 24), BEAT * 0.5, 0.14, "sawtooth");
    }
  }

  return master;
}
