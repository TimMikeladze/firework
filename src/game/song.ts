import {
  DEMO_BAR,
  DEMO_BARS,
  DEMO_BEAT,
  DEMO_BPM,
  DEMO_DURATION,
  DEMO_SECTIONS,
  demoSectionForBar,
} from "@/audio/demo-song";
import type { Chart, Note } from "./types";
import { LANE_COUNT } from "./types";

/**
 * The demo track's chart. The audio itself lives in `@/audio/demo-song`, which
 * the builder's synced show also plays; the note pattern below is authored on
 * the same BPM grid, so it is sample-accurate against what the player hears.
 */

export { DEMO_BPM, DEMO_DURATION, DEMO_SECTIONS };
export { scheduleDemoSong } from "@/audio/demo-song";

/**
 * Authored note pattern. Each section gets a hand-picked rhythm figure; the
 * lane assignment is deterministic so the chart is identical every play.
 */
function buildNotes(): Note[] {
  const notes: Note[] = [];
  const push = (time: number, lane: number) => {
    notes.push({ time, lane: ((lane % LANE_COUNT) + LANE_COUNT) % LANE_COUNT });
  };

  for (let bar = 0; bar < DEMO_BARS; bar++) {
    const t0 = bar * DEMO_BAR;
    const kind = demoSectionForBar(bar).kind;
    const barIndex = bar % 4;

    switch (kind) {
      case "intro": {
        // One note on the downbeat, walking across the pads.
        push(t0, bar % LANE_COUNT);
        if (bar >= 2) push(t0 + DEMO_BEAT * 2, (bar + 2) % LANE_COUNT);
        break;
      }
      case "verse": {
        // Quarter notes with a syncopated tail every other bar.
        push(t0, 0);
        push(t0 + DEMO_BEAT, 2);
        push(t0 + DEMO_BEAT * 2, 1);
        push(t0 + DEMO_BEAT * 3, 3);
        if (barIndex % 2 === 1) push(t0 + DEMO_BEAT * 3.5, 2);
        break;
      }
      case "build": {
        // Quarters walking outward, with one offbeat pickup to signal the lift.
        for (let b = 0; b < 4; b++) push(t0 + DEMO_BEAT * b, b % LANE_COUNT);
        if (barIndex === 3) push(t0 + DEMO_BEAT * 3.5, 3);
        break;
      }
      case "chorus": {
        // Quarters with a two-lane stack on the downbeat — the stack is the
        // payoff moment, and it stays readable because nothing crowds it.
        push(t0, 0);
        push(t0, 3);
        push(t0 + DEMO_BEAT, 1);
        push(t0 + DEMO_BEAT * 2, 2);
        push(t0 + DEMO_BEAT * 3, 1);
        break;
      }
      case "drop": {
        // The climax: quarters plus one eighth flourish, still four-per-bar so
        // the player can actually ride it.
        for (let b = 0; b < 4; b++) {
          push(t0 + DEMO_BEAT * b, b % 2 === 0 ? 0 : 2);
          if (b % 2 === 0) push(t0 + DEMO_BEAT * b, 3);
        }
        push(t0 + DEMO_BEAT * 3.5, 1);
        break;
      }
      case "outro": {
        push(t0, 1);
        push(t0 + DEMO_BEAT * 2, 2);
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
