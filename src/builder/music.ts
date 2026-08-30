/**
 * Getting a track into the desk: decode, analyse, and hand back something the
 * choreographer can cut a script from.
 *
 * The demo goes through exactly the same path as a dropped file — it is
 * rendered offline into a buffer first — so there is one code path to trust and
 * the bundled show is not a special case that hides bugs in the real one.
 *
 * Nothing here uploads anything. The samples never leave the tab.
 */

import type { AnalysisProgress, AnalysisResult } from "@/audio/analysis";
import { analyzeBuffer } from "@/audio/analysis";
import { DEMO_DURATION, renderDemoTrack } from "@/audio/demo-song";

export interface Track {
  id: string;
  name: string;
  buffer: AudioBuffer;
  analysis: AnalysisResult;
}

export type TrackProgress =
  | { stage: "decoding"; progress: number }
  | AnalysisProgress;

const ACCEPTED = /\.(mp3|wav|ogg|m4a|aac|flac|webm)$/i;

export function looksLikeAudio(file: File): boolean {
  return file.type.startsWith("audio/") || ACCEPTED.test(file.name);
}

/** `2:07`, for the transport readout. */
export function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${String(safe % 60).padStart(2, "0")}`;
}

async function analyse(
  id: string,
  name: string,
  buffer: AudioBuffer,
  onProgress?: (progress: TrackProgress) => void,
): Promise<Track> {
  const analysis = await analyzeBuffer(buffer, onProgress);
  return { id, name, buffer, analysis };
}

/**
 * Decodes and analyses a picked or dropped file. `decode` comes from the
 * renderer so the buffer is created on the context it will be played back on.
 */
export async function loadTrackFile(
  file: File,
  decode: (file: File) => Promise<AudioBuffer>,
  onProgress?: (progress: TrackProgress) => void,
): Promise<Track> {
  onProgress?.({ stage: "decoding", progress: 0 });
  const buffer = await decode(file);
  const name = file.name.replace(/\.[^.]+$/, "").slice(0, 48);
  return analyse(
    `file:${name}:${Math.round(buffer.duration)}`,
    name,
    buffer,
    onProgress,
  );
}

/** Renders the bundled demo track and analyses it like any other track. */
export async function loadDemoTrack(
  onProgress?: (progress: TrackProgress) => void,
): Promise<Track> {
  onProgress?.({ stage: "decoding", progress: 0 });
  const buffer = await renderDemoTrack();
  return analyse("demo", "Pulse Show (demo)", buffer, onProgress);
}

/** Rough seconds the demo runs, for the button label before it is rendered. */
export const DEMO_TRACK_SECONDS = DEMO_DURATION;
