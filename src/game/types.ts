export const LANE_COUNT = 4;

export const LANE_KEYS = ["KeyD", "KeyF", "KeyJ", "KeyK"] as const;
export const LANE_LABELS = ["D", "F", "J", "K"] as const;

/** Judgement windows in seconds, measured against audioContext.currentTime. */
export const WINDOW_PERFECT = 0.045;
export const WINDOW_GOOD = 0.11;
/** Past this, the note is gone and counted as a miss. */
export const WINDOW_MISS = 0.16;

export type Judgement = "perfect" | "good" | "miss";

export type SectionKind =
  | "intro"
  | "verse"
  | "build"
  | "chorus"
  | "drop"
  | "outro";

export interface Section {
  /** Seconds from song start. */
  time: number;
  kind: SectionKind;
  /** 0..1 — drives burst size, particle count, palette heat. */
  intensity: number;
}

export interface Note {
  /** Seconds from song start; the hit target relative to audio clock. */
  time: number;
  lane: number;
  /** Optional hold length in seconds (unused in MVP scoring, reserved). */
  hold?: number;
}

export interface Chart {
  id: string;
  title: string;
  artist: string;
  bpm: number;
  /** Song length in seconds. */
  duration: number;
  notes: Note[];
  sections: Section[];
  /** Set for procedurally generated charts. */
  generated?: boolean;
}

export interface HitResult {
  judgement: Judgement;
  lane: number;
  /** Signed error in seconds: negative = early, positive = late. */
  delta: number;
  combo: number;
  /** Section intensity at the moment of the hit. */
  intensity: number;
}

export interface ScoreState {
  score: number;
  combo: number;
  maxCombo: number;
  perfect: number;
  good: number;
  miss: number;
}

export function emptyScore(): ScoreState {
  return { score: 0, combo: 0, maxCombo: 0, perfect: 0, good: 0, miss: 0 };
}

export function accuracy(s: ScoreState): number {
  const total = s.perfect + s.good + s.miss;
  if (total === 0) return 1;
  return (s.perfect + s.good * 0.6) / total;
}

export function grade(acc: number): string {
  if (acc >= 0.98) return "S";
  if (acc >= 0.93) return "A";
  if (acc >= 0.85) return "B";
  if (acc >= 0.72) return "C";
  return "D";
}

export function sectionAt(sections: Section[], time: number): Section {
  let current = sections[0];
  for (const s of sections) {
    if (s.time <= time) current = s;
    else break;
  }
  return current ?? { time: 0, kind: "verse", intensity: 0.5 };
}
