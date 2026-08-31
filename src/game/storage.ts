import type { AnalysisResult, Difficulty } from "./analysis";
import type { Section } from "./types";

/**
 * IndexedDB holds imported songs: the raw file (so a track survives a reload
 * without re-picking it) plus the cached analysis, which is the expensive part.
 * localStorage holds settings and high scores.
 */

const DB_NAME = "pulse-show";
const DB_VERSION = 1;
const STORE_SONGS = "songs";

export interface StoredSong {
  id: string;
  title: string;
  artist: string;
  addedAt: number;
  duration: number;
  bpm: number;
  /** The original file, kept locally so re-analysis is never needed. */
  file: Blob;
  fileName: string;
  /** Cached analysis; regenerating a chart from it is instant. */
  analysis: SerializedAnalysis;
}

interface SerializedAnalysis {
  onsets: number[];
  strengths: number[];
  bandTilt: number[];
  bpm: number;
  duration: number;
  sections: Section[];
  waveform: number[];
}

export function serializeAnalysis(a: AnalysisResult): SerializedAnalysis {
  return {
    onsets: a.onsets,
    strengths: a.strengths,
    bandTilt: a.bandTilt,
    bpm: a.bpm,
    duration: a.duration,
    sections: a.sections,
    waveform: Array.from(a.waveform),
  };
}

export function deserializeAnalysis(s: SerializedAnalysis): AnalysisResult {
  return {
    onsets: s.onsets,
    strengths: s.strengths,
    bandTilt: s.bandTilt,
    bpm: s.bpm,
    duration: s.duration,
    sections: s.sections,
    waveform: Float32Array.from(s.waveform),
  };
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SONGS)) {
        db.createObjectStore(STORE_SONGS, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE_SONGS, mode);
        const req = fn(t.objectStore(STORE_SONGS));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function saveSong(song: StoredSong): Promise<void> {
  await tx("readwrite", (s) => s.put(song));
}

export async function listSongs(): Promise<StoredSong[]> {
  try {
    const all = await tx<StoredSong[]>(
      "readonly",
      (s) => s.getAll() as IDBRequest<StoredSong[]>,
    );
    return all.sort((a, b) => b.addedAt - a.addedAt);
  } catch {
    // Private-browsing or blocked storage — the game still works, just without a library.
    return [];
  }
}

export async function getSong(id: string): Promise<StoredSong | undefined> {
  try {
    return await tx<StoredSong | undefined>(
      "readonly",
      (s) => s.get(id) as IDBRequest<StoredSong | undefined>,
    );
  } catch {
    return undefined;
  }
}

export async function deleteSong(id: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(id));
}

/* ------------------------------------------------------------------ */
/* Settings & scores (localStorage)                                    */
/* ------------------------------------------------------------------ */

export interface Settings {
  difficulty: Difficulty;
  volume: number;
  /** Manual audio/visual offset in milliseconds, applied to hit windows. */
  offsetMs: number;
  hardMode: boolean;
}

const SETTINGS_KEY = "pulse-show:settings";
const SCORES_KEY = "pulse-show:scores";

export const DEFAULT_SETTINGS: Settings = {
  difficulty: "normal",
  volume: 0.8,
  offsetMs: 0,
  hardMode: false,
};

export function loadSettings(): Settings {
  if (typeof localStorage === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // Storage unavailable; settings just won't persist.
  }
}

export interface HighScore {
  score: number;
  accuracy: number;
  maxCombo: number;
  grade: string;
  at: number;
}

type ScoreMap = Record<string, HighScore>;

function loadScoreMap(): ScoreMap {
  if (typeof localStorage === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(SCORES_KEY) ?? "{}") as ScoreMap;
  } catch {
    return {};
  }
}

/** Scores are keyed per chart *and* difficulty — they aren't comparable across them. */
export function scoreKey(chartId: string, difficulty: Difficulty): string {
  return `${chartId}::${difficulty}`;
}

export function getHighScore(key: string): HighScore | undefined {
  return loadScoreMap()[key];
}

/** Returns true if this run beat the stored best. */
export function recordScore(key: string, entry: HighScore): boolean {
  const map = loadScoreMap();
  const prev = map[key];
  if (prev && prev.score >= entry.score) return false;
  map[key] = entry;
  try {
    localStorage.setItem(SCORES_KEY, JSON.stringify(map));
  } catch {
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Unlockables                                                         */
/* ------------------------------------------------------------------ */

export interface Unlockable {
  id: string;
  name: string;
  description: string;
  /** Total accumulated score required. */
  requirement: number;
}

export const UNLOCKABLES: Unlockable[] = [
  {
    id: "classic",
    name: "Classic",
    description: "Warm shells over the harbour.",
    requirement: 0,
  },
  {
    id: "aurora",
    name: "Aurora",
    description: "Cool ribbons and long willows.",
    requirement: 50_000,
  },
  {
    id: "ember",
    name: "Ember",
    description: "Deep reds with heavy fallout.",
    requirement: 200_000,
  },
  {
    id: "prism",
    name: "Prism",
    description: "Every shell picks its own hue.",
    requirement: 500_000,
  },
];

const TOTAL_KEY = "pulse-show:total";

export function getTotalScore(): number {
  if (typeof localStorage === "undefined") return 0;
  return Number(localStorage.getItem(TOTAL_KEY) ?? 0) || 0;
}

export function addTotalScore(delta: number): number {
  const next = getTotalScore() + delta;
  try {
    localStorage.setItem(TOTAL_KEY, String(next));
  } catch {
    // Non-fatal.
  }
  return next;
}

export function unlockedSkins(total = getTotalScore()): Unlockable[] {
  return UNLOCKABLES.filter((u) => total >= u.requirement);
}
