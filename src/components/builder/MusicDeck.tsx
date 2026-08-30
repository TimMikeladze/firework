"use client";

/**
 * The music deck: load a track, and the desk stops firing at random and starts
 * firing the song.
 *
 * The strip under the transport is the score. It draws the track's own
 * envelope, the sections the analysis found, and a tick for every scheduled
 * break — so the whole show is visible before it plays, and the playhead is
 * just a line moving across a script you can already read.
 *
 * The playhead runs off its own animation frame and writes straight to the DOM.
 * Re-rendering the desk sixty times a second to move one line would cost far
 * more than the line is worth.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SectionKind } from "@/audio/analysis";
import type { Cue, ShowPlan } from "@/builder/choreography";
import { showSummary } from "@/builder/choreography";
import type { LiveState } from "@/builder/live";
import { formatTime, type Track, type TrackProgress } from "@/builder/music";
import { DeskButton, Eyebrow, Lamp, Slider, Toggle } from "./controls";

const VIEW_W = 1000;
const VIEW_H = 100;
/** Where the waveform sits inside the strip; ticks hang above it. */
const WAVE_TOP = 58;

const SECTION_TINT: Record<SectionKind, string> = {
  intro: "#1440d0",
  verse: "#0bb45c",
  build: "#7a1ee0",
  chorus: "#ff8a1e",
  drop: "#ff2f7a",
  outro: "#3a414c",
};

const CUE_TINT: Record<Cue["kind"], string> = {
  beat: "#8b929c",
  accent: "#ffc24a",
  sweep: "#ff6a1f",
  finale: "#e9e7e2",
};

export interface MusicDeckProps {
  track: Track | null;
  plan: ShowPlan | null;
  /** Set while a track is being decoded or analysed. */
  progress: TrackProgress | null;
  error: string | null;
  playing: boolean;
  /** Reads the live song position. Polled on an animation frame, not in state. */
  getTime: () => number | null;
  density: number;
  followColors: boolean;
  musicVolume: number;
  syncOffset: number;
  onDensity: (value: number) => void;
  onFollowColors: (value: boolean) => void;
  onMusicVolume: (value: number) => void;
  onSyncOffset: (value: number) => void;
  onPickFile: (file: File) => void;
  onDemo: () => void;
  onPlayPause: () => void;
  onStop: () => void;
  onSeek: (seconds: number) => void;
  onClear: () => void;
  /** Which live source is being listened to, if any. */
  listening: "tab" | "mic" | null;
  /** Reads the conductor's live tempo and level. Polled, not stored in state. */
  getLive: () => LiveState | null;
  onListen: (source: "tab" | "mic") => void;
  onStopListening: () => void;
  /**
   * Drawn inside another panel (the hand-held sheet) rather than floating
   * over the water: no frame of its own, and nothing to collapse.
   */
  embedded?: boolean;
}

/** The waveform outline, as one filled path in view space. */
function wavePath(waveform: Float32Array): string {
  const n = waveform.length;
  if (!n) return "";
  const height = VIEW_H - WAVE_TOP;
  let peak = 0;
  for (const v of waveform) if (v > peak) peak = v;
  const scale = peak > 0 ? 1 / peak : 1;

  let top = `M 0 ${VIEW_H}`;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * VIEW_W;
    const y = VIEW_H - waveform[i] * scale * height;
    top += ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  return `${top} L ${VIEW_W} ${VIEW_H} Z`;
}

/** One path per cue kind keeps the tick marks to four draw calls. */
function cuePaths(plan: ShowPlan): { kind: Cue["kind"]; d: string }[] {
  const byKind = new Map<Cue["kind"], string[]>();
  const duration = Math.max(0.001, plan.duration);
  for (const cue of plan.cues) {
    const x = ((cue.at / duration) * VIEW_W).toFixed(2);
    const height = 8 + cue.strength * (WAVE_TOP - 14);
    const list = byKind.get(cue.kind) ?? [];
    list.push(`M ${x} ${WAVE_TOP} L ${x} ${(WAVE_TOP - height).toFixed(2)}`);
    byKind.set(cue.kind, list);
  }
  return [...byKind].map(([kind, parts]) => ({ kind, d: parts.join(" ") }));
}

function stageLabel(progress: TrackProgress): string {
  switch (progress.stage) {
    case "decoding":
      return "Decoding";
    case "spectrum":
      return "Reading spectrum";
    case "onsets":
      return "Finding hits";
    case "tempo":
      return "Timing the beat";
    case "sections":
      return "Marking sections";
    default:
      return "Ready";
  }
}

export function MusicDeck(props: MusicDeckProps) {
  const {
    track,
    plan,
    progress,
    error,
    playing,
    getTime,
    getLive,
    listening,
    onSeek,
    onPickFile,
    embedded = false,
  } = props;

  const fileRef = useRef<HTMLInputElement>(null);
  const playheadRef = useRef<SVGGElement>(null);
  const clockRef = useRef<HTMLSpanElement>(null);
  const stripRef = useRef<SVGSVGElement>(null);
  const meterRef = useRef<HTMLDivElement>(null);
  const liveReadoutRef = useRef<HTMLSpanElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const open = embedded || !collapsed;
  /**
   * Tab capture is a desktop-browser feature; where the API is missing the
   * button would only ever show an error, so it stays off the deck.
   */
  const [canShareTab, setCanShareTab] = useState(true);
  useEffect(() => {
    setCanShareTab(
      typeof navigator.mediaDevices?.getDisplayMedia === "function",
    );
  }, []);

  const duration = plan?.duration ?? track?.analysis.duration ?? 0;

  const wave = useMemo(
    () => (track ? wavePath(track.analysis.waveform) : ""),
    [track],
  );
  const ticks = useMemo(() => (plan ? cuePaths(plan) : []), [plan]);
  const bands = useMemo(() => {
    if (!plan || plan.duration <= 0) return [];
    return plan.sections.map((section, index) => {
      const next = plan.sections[index + 1]?.time ?? plan.duration;
      return {
        key: `${section.kind}-${section.time}`,
        kind: section.kind,
        x: (section.time / plan.duration) * VIEW_W,
        width: Math.max(1, ((next - section.time) / plan.duration) * VIEW_W),
        intensity: section.intensity,
      };
    });
  }, [plan]);

  // The playhead, driven straight from the audio clock.
  useEffect(() => {
    if (!track) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const time = getTime();
      const position = time === null ? 0 : Math.max(0, time);
      const x = duration > 0 ? (position / duration) * VIEW_W : 0;
      playheadRef.current?.setAttribute("transform", `translate(${x} 0)`);
      if (clockRef.current) {
        clockRef.current.textContent = `${formatTime(position)} / ${formatTime(duration)}`;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [track, duration, getTime]);

  useEffect(() => {
    if (!listening) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const state = getLive();
      if (!state) return;
      if (meterRef.current) {
        meterRef.current.style.width = `${Math.round(state.level * 100)}%`;
      }
      if (liveReadoutRef.current) {
        liveReadoutRef.current.textContent = state.locked
          ? `${Math.round(state.bpm)} bpm · ${state.shells} shells fired`
          : "listening for a beat…";
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [listening, getLive]);

  const seekFromEvent = useCallback(
    (clientX: number) => {
      const strip = stripRef.current;
      if (!strip || duration <= 0) return;
      const rect = strip.getBoundingClientRect();
      const ratio = Math.min(
        1,
        Math.max(0, (clientX - rect.left) / rect.width),
      );
      onSeek(ratio * duration);
    },
    [duration, onSeek],
  );

  const summary = useMemo(() => (plan ? showSummary(plan) : null), [plan]);
  const shells = plan?.cues.length ?? 0;

  const settings = (
    <div className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
      <Slider
        label="Show density"
        value={props.density}
        min={0}
        max={1}
        step={0.05}
        precision={2}
        onChange={props.onDensity}
      />
      {listening ? null : (
        <Slider
          label="Music level"
          value={props.musicVolume}
          min={0}
          max={1}
          step={0.02}
          onChange={props.onMusicVolume}
        />
      )}
      <Slider
        label="Sync offset"
        value={props.syncOffset * 1000}
        min={-250}
        max={250}
        step={5}
        unit=" ms"
        precision={0}
        onChange={(value) => props.onSyncOffset(value / 1000)}
      />
      <Toggle
        label="Follow my shell's colours"
        checked={props.followColors}
        onChange={props.onFollowColors}
      />
    </div>
  );

  return (
    <div
      className={
        embedded
          ? "flex flex-col gap-3"
          : "border-seam bg-panel desk-rise pointer-events-auto w-full max-w-[760px] rounded-[5px] border px-3 py-2 backdrop-blur-md"
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <Lamp on={Boolean(track)} live={playing} />
        <Eyebrow>Music</Eyebrow>

        {track ? (
          <span className="text-paper min-w-0 max-w-[220px] flex-1 truncate text-[12px]">
            {track.name}
          </span>
        ) : listening ? (
          <span className="text-paper text-[12px]">
            {listening === "tab" ? "Shared tab" : "Microphone"}
          </span>
        ) : (
          <span className="text-ash text-[11px]">
            {embedded
              ? "Play the demo, load a track, or listen to the room"
              : "Drop a track, play the demo, or listen to what is already playing"}
          </span>
        )}

        {/*
         * Sources and transport. Inline at the right on the wide strip; a
         * full-width grid of thumb-sized buttons inside the sheet.
         */}
        <div
          className={
            embedded
              ? "grid w-full grid-cols-2 gap-1.5 sm:flex sm:w-auto sm:flex-1 sm:items-center sm:justify-end"
              : "ml-auto flex items-center gap-2"
          }
        >
          {track ? (
            <>
              <button
                type="button"
                onClick={props.onPlayPause}
                disabled={!plan}
                className="border-ember/70 bg-ember/20 text-gold hover:bg-ember/35 font-display pointer-coarse:min-h-10 rounded-[3px] border px-3 py-1 text-[13px] font-bold tracking-[0.12em] uppercase transition-colors disabled:opacity-40"
              >
                {playing ? "Pause" : "Play"}
              </button>
              <DeskButton onClick={props.onStop}>Stop</DeskButton>
              <DeskButton onClick={props.onClear}>Eject</DeskButton>
            </>
          ) : listening ? (
            <DeskButton tone="primary" onClick={props.onStopListening}>
              Stop listening
            </DeskButton>
          ) : (
            <>
              <DeskButton tone="primary" onClick={props.onDemo}>
                Demo track
              </DeskButton>
              <DeskButton onClick={() => fileRef.current?.click()}>
                Load file
              </DeskButton>
              {canShareTab ? (
                <DeskButton
                  onClick={() => props.onListen("tab")}
                  title="Share a tab with its audio and fire to whatever it plays"
                >
                  Listen to a tab
                </DeskButton>
              ) : null}
              <DeskButton
                onClick={() => props.onListen("mic")}
                title="Fire to whatever the microphone hears"
              >
                Microphone
              </DeskButton>
            </>
          )}
          {embedded ? null : (
            <button
              type="button"
              aria-label={open ? "Collapse music deck" : "Expand music deck"}
              aria-expanded={open}
              onClick={() => setCollapsed((value) => !value)}
              className="text-ash hover:text-paper px-1 text-[11px] transition-colors"
            >
              {open ? "▾" : "▸"}
            </button>
          )}
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onPickFile(file);
        }}
      />

      {progress ? (
        <div className="mt-2 flex items-center gap-2">
          <div className="bg-seam h-[3px] flex-1 overflow-hidden rounded-full">
            <div
              className="bg-ember h-full transition-[width] duration-150"
              style={{ width: `${Math.round(progress.progress * 100)}%` }}
            />
          </div>
          <span className="readout text-ash text-[10px] whitespace-nowrap">
            {stageLabel(progress)}
          </span>
        </div>
      ) : null}

      {error ? <p className="text-ember mt-2 text-[11px]">{error}</p> : null}

      {open && track ? (
        <>
          {/* The score: envelope, sections, and every scheduled break. */}
          <svg
            ref={stripRef}
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`Show timeline: ${shells} shells across ${formatTime(duration)}`}
            className="border-seam pointer-coarse:h-[96px] mt-2 h-[76px] w-full cursor-pointer touch-none rounded-[3px] border bg-black/30"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              seekFromEvent(event.clientX);
            }}
            onPointerMove={(event) => {
              if (event.buttons === 1 || event.pointerType === "touch")
                seekFromEvent(event.clientX);
            }}
          >
            <title>Show timeline</title>
            {bands.map((band) => (
              <rect
                key={band.key}
                x={band.x}
                y={0}
                width={band.width}
                height={VIEW_H}
                fill={SECTION_TINT[band.kind]}
                opacity={0.05 + band.intensity * 0.12}
              />
            ))}

            <path d={wave} fill="#e9e7e2" opacity={0.22} />
            <line
              x1={0}
              y1={WAVE_TOP}
              x2={VIEW_W}
              y2={WAVE_TOP}
              stroke="#262b33"
              strokeWidth={1}
            />

            {ticks.map((tick) => (
              <path
                key={tick.kind}
                d={tick.d}
                stroke={CUE_TINT[tick.kind]}
                strokeWidth={1.6}
                opacity={tick.kind === "beat" ? 0.55 : 0.95}
                vectorEffect="non-scaling-stroke"
              />
            ))}

            <g ref={playheadRef}>
              <line
                x1={0}
                y1={0}
                x2={0}
                y2={VIEW_H}
                stroke="#ff6a1f"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            </g>
          </svg>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span ref={clockRef} className="readout text-paper text-[11px]">
              {formatTime(0)} / {formatTime(duration)}
            </span>
            <span className="readout text-ash text-[10px]">
              {plan ? `${Math.round(plan.bpm)} bpm` : "—"} · {shells} shells ·{" "}
              {summary
                ? `${Math.round(summary.peakStars / 1000)}k stars at peak`
                : "—"}
            </span>
          </div>

          {settings}
        </>
      ) : open && listening ? (
        <>
          {/* No score to draw: a live source is read one frame at a time. */}
          <div className="border-seam mt-2 flex items-center gap-3 rounded-[3px] border bg-black/30 px-3 py-2">
            <div className="bg-seam h-[6px] flex-1 overflow-hidden rounded-full">
              <div
                ref={meterRef}
                className="bg-ember h-full w-0 rounded-full"
              />
            </div>
            <span
              ref={liveReadoutRef}
              className="readout text-ash w-[150px] shrink-0 text-right text-[10px] sm:w-[190px]"
            >
              listening for a beat…
            </span>
          </div>
          <p className="text-ash mt-1.5 text-[10px] leading-relaxed">
            {listening === "tab"
              ? "Breaks are scheduled onto beats the conductor predicts, so the sky stays a step ahead of the tab."
              : "Every shell is aimed at a beat that has not happened yet — a steady tempo gives the tightest sync."}
          </p>
          {settings}
        </>
      ) : null}
    </div>
  );
}
