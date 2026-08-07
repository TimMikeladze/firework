import type { Chart, Note, Section, SectionKind } from "./types";
import { LANE_COUNT } from "./types";

/**
 * Client-side beatmap generation for imported tracks.
 *
 * Pipeline: downmix → STFT magnitude frames → spectral flux → adaptive-threshold
 * peak picking → tempo estimate by inter-onset histogram → note selection by
 * difficulty → section segmentation by windowed energy.
 *
 * Nothing here touches the network. The decoded buffer never leaves the tab.
 */

export type Difficulty = "easy" | "normal" | "hard";

/**
 * Notes per second the generator aims for, per difficulty. Tuned low: the show
 * carries the spectacle, so a sparser chart still looks spectacular while
 * staying comfortably playable.
 */
const TARGET_DENSITY: Record<Difficulty, number> = {
  easy: 0.9,
  normal: 1.8,
  hard: 3.2,
};

const FFT_SIZE = 1024;
const HOP = 256;

export interface AnalysisResult {
  /** Onset times in seconds, strongest first is NOT guaranteed — time-sorted. */
  onsets: number[];
  /** Onset strength parallel to `onsets`, normalized 0..1. */
  strengths: number[];
  bpm: number;
  duration: number;
  sections: Section[];
  /** Downsampled peak envelope for waveform display. */
  waveform: Float32Array;
  /** Per-onset band split, used to bias lane assignment. */
  bandTilt: number[];
}

export interface AnalysisProgress {
  stage: "decoding" | "spectrum" | "onsets" | "tempo" | "sections" | "done";
  /** 0..1 */
  progress: number;
}

/* ------------------------------------------------------------------ */
/* FFT                                                                 */
/* ------------------------------------------------------------------ */

/** In-place iterative radix-2 FFT. `re`/`im` must be power-of-two length. */
function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Analysis                                                            */
/* ------------------------------------------------------------------ */

function downmix(buffer: AudioBuffer): Float32Array {
  const len = buffer.length;
  const out = new Float32Array(len);
  const channels = buffer.numberOfChannels;
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < len; i++) out[i] += data[i];
  }
  if (channels > 1) {
    for (let i = 0; i < len; i++) out[i] /= channels;
  }
  return out;
}

function hannWindow(size: number): Float32Array {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++)
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  return w;
}

/**
 * Computes spectral flux (positive-only magnitude difference) plus a low/high
 * band split per frame. Yields to the caller periodically via `onProgress`.
 */
async function spectralFlux(
  samples: Float32Array,
  sampleRate: number,
  onProgress: (p: number) => void,
): Promise<{ flux: Float32Array; tilt: Float32Array; frameTime: number }> {
  const frames = Math.max(1, Math.floor((samples.length - FFT_SIZE) / HOP));
  const flux = new Float32Array(frames);
  const tilt = new Float32Array(frames);
  const window = hannWindow(FFT_SIZE);
  const bins = FFT_SIZE / 2;
  let prev = new Float32Array(bins);
  let mag = new Float32Array(bins);
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);

  // Boundary between "low" and "high" for the tilt metric (~500 Hz).
  const splitBin = Math.max(
    1,
    Math.min(bins - 1, Math.round((500 / (sampleRate / 2)) * bins)),
  );

  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = samples[off + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);

    let sum = 0;
    let low = 0;
    let high = 0;
    for (let b = 0; b < bins; b++) {
      const m = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
      mag[b] = m;
      const d = m - prev[b];
      if (d > 0) sum += d;
      if (b < splitBin) low += m;
      else high += m;
    }
    flux[f] = sum;
    tilt[f] = high / (low + high + 1e-9);

    // Swap buffers instead of copying.
    const t = prev;
    prev = mag;
    mag = t;

    if ((f & 255) === 0) {
      onProgress(f / frames);
      // Yield so the progress UI can paint.
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  return { flux, tilt, frameTime: HOP / sampleRate };
}

/**
 * Adaptive-threshold peak picking. A frame is an onset if it is a local maximum
 * and exceeds the local mean by a margin — this tracks loudness changes across
 * the song instead of using one global threshold.
 */
function pickPeaks(
  flux: Float32Array,
  frameTime: number,
): { times: number[]; strengths: number[]; frames: number[] } {
  const n = flux.length;
  // ~0.15s of context on each side.
  const w = Math.max(3, Math.round(0.15 / frameTime));
  const times: number[] = [];
  const strengths: number[] = [];
  const frames: number[] = [];

  // Running mean via prefix sums keeps this O(n).
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + flux[i];
  const localMean = (i: number) => {
    const a = Math.max(0, i - w);
    const b = Math.min(n, i + w + 1);
    return (prefix[b] - prefix[a]) / (b - a);
  };

  let peak = 0;
  // Minimum gap between onsets — ~16ths at 200 BPM.
  const minGap = 0.075;
  let lastTime = -1;

  for (let i = 1; i < n - 1; i++) {
    const v = flux[i];
    if (v <= flux[i - 1] || v < flux[i + 1]) continue;
    const mean = localMean(i);
    if (v < mean * 1.5 + 1e-6) continue;
    const t = i * frameTime;
    if (t - lastTime < minGap) {
      // Keep the stronger of two neighbours that are too close together.
      if (strengths.length > 0 && v > strengths[strengths.length - 1]) {
        times[times.length - 1] = t;
        strengths[strengths.length - 1] = v;
        frames[frames.length - 1] = i;
        lastTime = t;
      }
      continue;
    }
    times.push(t);
    strengths.push(v);
    frames.push(i);
    lastTime = t;
    if (v > peak) peak = v;
  }

  if (peak > 0) {
    for (let i = 0; i < strengths.length; i++) strengths[i] /= peak;
  }
  return { times, strengths, frames };
}

/**
 * Tempo from an inter-onset-interval histogram, folded into 70–180 BPM. Good
 * enough to place notes on a grid; we never rely on it for hit timing.
 */
function estimateTempo(times: number[]): number {
  if (times.length < 8) return 120;
  const buckets = new Float64Array(200);
  for (let i = 0; i < times.length; i++) {
    // Compare against the next few onsets, not just the immediate neighbour.
    for (let j = i + 1; j < Math.min(times.length, i + 5); j++) {
      const dt = times[j] - times[i];
      if (dt < 0.2 || dt > 2) continue;
      let bpm = 60 / dt;
      while (bpm < 70) bpm *= 2;
      while (bpm > 180) bpm /= 2;
      const b = Math.round(bpm);
      if (b >= 0 && b < 200) {
        // Spread a little energy into neighbouring bins for robustness.
        buckets[b] += 1;
        if (b > 0) buckets[b - 1] += 0.5;
        if (b < 199) buckets[b + 1] += 0.5;
      }
    }
  }
  let best = 120;
  let bestVal = -1;
  for (let b = 70; b <= 180; b++) {
    if (buckets[b] > bestVal) {
      bestVal = buckets[b];
      best = b;
    }
  }
  return best;
}

/**
 * Segments the song by windowed RMS energy into intensity tiers, then maps each
 * tier to a section kind so the visual treatment tracks song structure.
 */
function segment(
  samples: Float32Array,
  sampleRate: number,
  duration: number,
): Section[] {
  const winSec = 2;
  const win = Math.floor(sampleRate * winSec);
  const count = Math.max(1, Math.floor(samples.length / win));
  const energy = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let sum = 0;
    const off = i * win;
    for (let j = 0; j < win; j += 8) {
      const s = samples[off + j];
      sum += s * s;
    }
    energy[i] = Math.sqrt(sum / (win / 8));
  }

  let lo = Number.POSITIVE_INFINITY;
  let hi = 0;
  for (const e of energy) {
    if (e < lo) lo = e;
    if (e > hi) hi = e;
  }
  const range = Math.max(1e-6, hi - lo);

  const kindFor = (norm: number): SectionKind => {
    if (norm > 0.85) return "drop";
    if (norm > 0.66) return "chorus";
    if (norm > 0.48) return "build";
    if (norm > 0.28) return "verse";
    return "intro";
  };

  const sections: Section[] = [];
  let lastKind: SectionKind | null = null;
  for (let i = 0; i < count; i++) {
    // Smooth over three windows so single loud bars don't create a section.
    const a = energy[Math.max(0, i - 1)];
    const b = energy[i];
    const c = energy[Math.min(count - 1, i + 1)];
    const norm = ((a + b + c) / 3 - lo) / range;
    const kind = kindFor(norm);
    if (kind !== lastKind) {
      sections.push({
        time: i * winSec,
        kind,
        intensity: Math.max(0.15, Math.min(1, norm)),
      });
      lastKind = kind;
    }
  }

  if (sections.length === 0)
    sections.push({ time: 0, kind: "verse", intensity: 0.5 });
  sections[0].time = 0;
  // Final calm-down so the show doesn't end mid-climax.
  if (duration > 12)
    sections.push({
      time: Math.max(0, duration - 6),
      kind: "outro",
      intensity: 0.3,
    });
  return sections;
}

/** Peak envelope for the waveform preview. */
function envelope(samples: Float32Array, buckets = 900): Float32Array {
  const out = new Float32Array(buckets);
  const per = Math.max(1, Math.floor(samples.length / buckets));
  for (let i = 0; i < buckets; i++) {
    let peak = 0;
    const off = i * per;
    for (let j = 0; j < per; j += 4) {
      const v = Math.abs(samples[off + j] || 0);
      if (v > peak) peak = v;
    }
    out[i] = peak;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export async function analyzeBuffer(
  buffer: AudioBuffer,
  onProgress?: (p: AnalysisProgress) => void,
): Promise<AnalysisResult> {
  const report = (stage: AnalysisProgress["stage"], progress: number) =>
    onProgress?.({ stage, progress });

  report("spectrum", 0);
  const samples = downmix(buffer);
  const duration = buffer.duration;

  const { flux, tilt, frameTime } = await spectralFlux(
    samples,
    buffer.sampleRate,
    (p) => report("spectrum", p * 0.7),
  );

  report("onsets", 0.72);
  const { times, strengths, frames } = pickPeaks(flux, frameTime);
  const bandTilt = frames.map((f) => tilt[f] ?? 0.5);

  report("tempo", 0.84);
  const bpm = estimateTempo(times);

  report("sections", 0.9);
  const sections = segment(samples, buffer.sampleRate, duration);
  const waveform = envelope(samples);

  report("done", 1);
  return {
    onsets: times,
    strengths,
    bpm,
    duration,
    sections,
    waveform,
    bandTilt,
  };
}

/**
 * Turns an analysis into a playable chart. Cheap enough to re-run when the
 * player changes difficulty — no re-decode, no re-analysis.
 */
export function buildChart(
  analysis: AnalysisResult,
  meta: { id: string; title: string; artist?: string },
  difficulty: Difficulty,
): Chart {
  const target = TARGET_DENSITY[difficulty] * analysis.duration;
  const indices = analysis.onsets.map((_, i) => i);

  // Keep the strongest onsets up to the target count, then restore time order.
  indices.sort((a, b) => analysis.strengths[b] - analysis.strengths[a]);
  const keep = indices.slice(0, Math.max(8, Math.round(target)));
  keep.sort((a, b) => a - b);

  const notes: Note[] = [];
  let lastLane = -1;
  let lastTime = -1;
  // Easier difficulties get a wider minimum gap so patterns stay readable.
  const minGap =
    difficulty === "easy" ? 0.5 : difficulty === "normal" ? 0.32 : 0.2;

  for (const i of keep) {
    const t = analysis.onsets[i];
    if (t - lastTime < minGap) continue;

    // Bright/percussive onsets sit in the outer lanes, bassy ones inside.
    const tiltValue = analysis.bandTilt[i] ?? 0.5;
    let lane = Math.min(LANE_COUNT - 1, Math.floor(tiltValue * LANE_COUNT));
    // Alternate hands when two consecutive notes would land on one pad.
    if (lane === lastLane) lane = (lane + 1 + (i % 2)) % LANE_COUNT;

    notes.push({ time: t, lane });
    lastLane = lane;
    lastTime = t;
  }

  return {
    id: meta.id,
    title: meta.title,
    artist: meta.artist ?? "Imported",
    bpm: analysis.bpm,
    duration: analysis.duration,
    notes,
    sections: analysis.sections,
    generated: true,
  };
}
