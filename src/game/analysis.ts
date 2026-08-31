import type { AnalysisResult } from "@/audio/analysis";
import type { Chart, Note } from "./types";
import { LANE_COUNT } from "./types";

/**
 * Beatmap generation for imported tracks.
 *
 * The signal processing lives in `@/audio/analysis` because the builder's
 * synced show runs the same pass; this module is only the game's half — turning
 * onsets into notes on four lanes.
 */

export type {
  AnalysisProgress,
  AnalysisResult,
} from "@/audio/analysis";
export { analyzeBuffer } from "@/audio/analysis";

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
