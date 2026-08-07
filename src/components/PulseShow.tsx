"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Waveform from "@/components/Waveform";
import {
  type AnalysisProgress,
  type AnalysisResult,
  analyzeBuffer,
  buildChart,
  type Difficulty,
} from "@/game/analysis";
import { AudioEngine } from "@/game/audio";
import { GameEngine } from "@/game/engine";
import { DEMO_CHART } from "@/game/song";
import {
  addTotalScore,
  DEFAULT_SETTINGS,
  deleteSong,
  deserializeAnalysis,
  getHighScore,
  getTotalScore,
  listSongs,
  loadSettings,
  recordScore,
  type Settings,
  type StoredSong,
  saveSettings,
  saveSong,
  scoreKey,
  serializeAnalysis,
  UNLOCKABLES,
  unlockedSkins,
} from "@/game/storage";
import {
  accuracy,
  type Chart,
  emptyScore,
  grade,
  LANE_KEYS,
  LANE_LABELS,
  type ScoreState,
} from "@/game/types";

type Screen = "title" | "select" | "importing" | "playing" | "results";

interface ActiveSong {
  chart: Chart;
  /** Undefined for the bundled demo, which is synthesized rather than decoded. */
  buffer?: AudioBuffer;
  analysis?: AnalysisResult;
  /** Stored song id, when the track came from the library. */
  storedId?: string;
}

const DIFFICULTIES: Difficulty[] = ["easy", "normal", "hard"];

export default function PulseShow() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<AudioEngine | null>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Kept in a ref so the results screen can replay without a re-render loop. */
  const activeRef = useRef<ActiveSong | null>(null);

  const [screen, setScreen] = useState<Screen>("title");
  const [score, setScore] = useState<ScoreState>(emptyScore());
  const [ready, setReady] = useState(false);
  const [paused, setPaused] = useState(false);
  const [failed, setFailed] = useState(false);
  const [health, setHealth] = useState(1);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [library, setLibrary] = useState<StoredSong[]>([]);
  const [ambient, setAmbient] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [total, setTotal] = useState(0);
  const [newBest, setNewBest] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [importState, setImportState] = useState<{
    name: string;
    stage: AnalysisProgress["stage"];
    progress: number;
    waveform: Float32Array | null;
    error?: string;
  } | null>(null);
  const [activeTitle, setActiveTitle] = useState("");

  /* ---------------------------------------------------------------- */
  /* Engine bootstrap                                                  */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const stored = loadSettings();
    setSettings(stored);
    setTotal(getTotalScore());

    const audio = new AudioEngine();
    audio.volume = stored.volume;
    audioRef.current = audio;

    const engine = new GameEngine(canvas, audio, {
      onScore: setScore,
      onHealth: setHealth,
      onFinish: (s, didFail) => {
        setScore(s);
        setFailed(didFail);
        engine.setMode("menu");
        const active = activeRef.current;
        if (active && !didFail) {
          const acc = accuracy(s);
          const key = scoreKey(active.chart.id, stored.difficulty);
          setNewBest(
            recordScore(key, {
              score: s.score,
              accuracy: acc,
              maxCombo: s.maxCombo,
              grade: grade(acc),
              at: Date.now(),
            }),
          );
          setTotal(addTotalScore(s.score));
        } else {
          setNewBest(false);
        }
        setScreen("results");
      },
    });
    engine.setOptions({
      offset: stored.offsetMs / 1000,
      hardMode: stored.hardMode,
      skin: "classic",
    });
    engineRef.current = engine;
    engine.start();
    setReady(true);

    void listSongs().then(setLibrary);

    const onResize = () => engine.resize();
    window.addEventListener("resize", onResize);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const lane = LANE_KEYS.indexOf(e.code as (typeof LANE_KEYS)[number]);
      if (lane >= 0) {
        e.preventDefault();
        void audio.resume();
        engine.pressLane(lane);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const lane = LANE_KEYS.indexOf(e.code as (typeof LANE_KEYS)[number]);
      if (lane >= 0) engine.releaseLane(lane);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      engine.destroy();
      audio.dispose();
    };
  }, []);

  /* ---------------------------------------------------------------- */
  /* Settings                                                          */
  /* ---------------------------------------------------------------- */

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      if (audioRef.current) audioRef.current.volume = next.volume;
      engineRef.current?.setOptions({
        offset: next.offsetMs / 1000,
        hardMode: next.hardMode,
      });
      return next;
    });
  }, []);

  const skins = useMemo(() => unlockedSkins(total), [total]);
  const [skin, setSkin] = useState("classic");

  useEffect(() => {
    engineRef.current?.setOptions({ skin });
  }, [skin]);

  /* ---------------------------------------------------------------- */
  /* Playback                                                          */
  /* ---------------------------------------------------------------- */

  const launch = useCallback(
    async (song: ActiveSong, mode: "play" | "ambient") => {
      const engine = engineRef.current;
      if (!engine) return;
      activeRef.current = song;
      setActiveTitle(song.chart.title);
      setAmbient(mode === "ambient");
      setFailed(false);
      setNewBest(false);
      setHealth(1);
      setScreen("playing");
      setPaused(false);
      await engine.play(
        song.chart,
        song.buffer
          ? { kind: "buffer", buffer: song.buffer }
          : { kind: "demo" },
        mode,
      );
    },
    [],
  );

  const playDemo = useCallback(
    (mode: "play" | "ambient" = "play") => launch({ chart: DEMO_CHART }, mode),
    [launch],
  );

  /** Rebuilds a chart at the current difficulty — no decode, no re-analysis. */
  const playStored = useCallback(
    async (song: StoredSong, mode: "play" | "ambient" = "play") => {
      const audio = audioRef.current;
      if (!audio) return;
      const analysis = deserializeAnalysis(song.analysis);
      const buffer = await audio.decode(new File([song.file], song.fileName));
      const chart = buildChart(
        analysis,
        { id: song.id, title: song.title, artist: song.artist },
        settings.difficulty,
      );
      await launch({ chart, buffer, analysis, storedId: song.id }, mode);
    },
    [launch, settings.difficulty],
  );

  const replay = useCallback(async () => {
    const active = activeRef.current;
    if (!active) return;
    if (active.analysis) {
      // Re-roll the chart so a difficulty change since the last run takes effect.
      const chart = buildChart(
        active.analysis,
        {
          id: active.chart.id,
          title: active.chart.title,
          artist: active.chart.artist,
        },
        settings.difficulty,
      );
      await launch({ ...active, chart }, ambient ? "ambient" : "play");
    } else {
      await launch(active, ambient ? "ambient" : "play");
    }
  }, [launch, settings.difficulty, ambient]);

  const quit = useCallback(() => {
    engineRef.current?.stop();
    setScreen("select");
    setPaused(false);
  }, []);

  const togglePause = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.isPaused) {
      await audio.unpause();
      setPaused(false);
    } else {
      await audio.pause();
      setPaused(true);
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Escape" && screen === "playing") void togglePause();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screen, togglePause]);

  /* ---------------------------------------------------------------- */
  /* Import                                                            */
  /* ---------------------------------------------------------------- */

  const handleFile = useCallback(
    async (file: File) => {
      const audio = audioRef.current;
      if (!audio) return;
      const title = file.name.replace(/\.[^.]+$/, "");
      setScreen("importing");
      setImportState({
        name: title,
        stage: "decoding",
        progress: 0,
        waveform: null,
      });

      try {
        await audio.resume();
        const buffer = await audio.decode(file);
        const analysis = await analyzeBuffer(buffer, (p) => {
          setImportState((prev) =>
            prev ? { ...prev, stage: p.stage, progress: p.progress } : prev,
          );
        });
        setImportState((prev) =>
          prev ? { ...prev, waveform: analysis.waveform, progress: 1 } : prev,
        );

        const id = `import-${Date.now().toString(36)}`;
        const stored: StoredSong = {
          id,
          title,
          artist: "Imported",
          addedAt: Date.now(),
          duration: analysis.duration,
          bpm: analysis.bpm,
          file,
          fileName: file.name,
          analysis: serializeAnalysis(analysis),
        };
        // Saving is best-effort: a failed write shouldn't block playing the track.
        try {
          await saveSong(stored);
          setLibrary(await listSongs());
        } catch {
          setLibrary((prev) => [stored, ...prev]);
        }

        const chart = buildChart(analysis, { id, title }, settings.difficulty);
        await launch({ chart, buffer, analysis, storedId: id }, "play");
        setImportState(null);
      } catch (err) {
        setImportState({
          name: title,
          stage: "decoding",
          progress: 0,
          waveform: null,
          error:
            err instanceof Error ? err.message : "Could not decode that file.",
        });
      }
    },
    [launch, settings.difficulty],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) void handleFile(file);
    },
    [handleFile],
  );

  const removeSong = useCallback(async (id: string) => {
    await deleteSong(id);
    setLibrary(await listSongs());
  }, []);

  /* ---------------------------------------------------------------- */
  /* Render                                                            */
  /* ---------------------------------------------------------------- */

  const acc = accuracy(score);
  const active = activeRef.current;
  const best = active
    ? getHighScore(scoreKey(active.chart.id, settings.difficulty))
    : undefined;

  return (
    // Drag-and-drop is a convenience layer over the file picker button, which
    // remains the keyboard-accessible path — hence no interactive role here.
    // biome-ignore lint/a11y/noStaticElementInteractions: drop target duplicates the accessible file input
    <div
      className="relative h-full w-full overflow-hidden bg-black"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full touch-none"
      />

      <input
        ref={fileInputRef}
        type="file"
        accept="audio/mpeg,audio/wav,audio/ogg,audio/mp4,audio/x-m4a,.mp3,.wav,.ogg,.m4a"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFile(file);
          e.target.value = "";
        }}
      />

      {dragOver && screen !== "playing" && (
        <div className="pointer-events-none absolute inset-4 z-30 flex items-center justify-center rounded-2xl border-2 border-dashed border-white/40 bg-black/50 text-sm text-white/80">
          Drop an audio file to build a show
        </div>
      )}

      {/* ---------------- Gameplay HUD ---------------- */}
      {screen === "playing" && (
        <>
          <div className="pointer-events-none absolute left-6 top-5 font-mono text-sm text-white/80">
            {!ambient && (
              <>
                <div className="text-2xl font-semibold tabular-nums tracking-tight">
                  {score.score.toLocaleString()}
                </div>
                <div className="mt-1 text-xs text-white/45">
                  {(acc * 100).toFixed(1)}% acc
                </div>
              </>
            )}
            <div className="mt-1 max-w-[40vw] truncate text-[11px] text-white/35">
              {activeTitle}
            </div>
          </div>

          {settings.hardMode && !ambient && (
            <div className="pointer-events-none absolute left-6 top-24 h-1 w-32 overflow-hidden rounded-full bg-white/15">
              <div
                className="h-full rounded-full transition-[width] duration-200"
                style={{
                  width: `${health * 100}%`,
                  background:
                    health > 0.4
                      ? "rgba(160,220,255,0.85)"
                      : "rgba(255,120,120,0.9)",
                }}
              />
            </div>
          )}

          {!ambient && score.combo >= 2 && (
            <div className="pointer-events-none absolute right-6 top-5 text-right font-mono">
              <div className="text-3xl font-bold tabular-nums text-white/90">
                {score.combo}
              </div>
              <div className="text-[10px] uppercase tracking-widest text-white/40">
                combo
              </div>
            </div>
          )}

          {ambient && (
            <div className="pointer-events-none absolute right-6 top-5 font-mono text-[10px] uppercase tracking-widest text-white/40">
              ambient
            </div>
          )}

          {!ambient && (
            <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 gap-2 md:hidden">
              {LANE_LABELS.map((label, lane) => (
                <button
                  key={label}
                  type="button"
                  className="h-16 w-[19vw] max-w-24 rounded-xl border border-white/20 bg-white/5 font-mono text-white/70 active:bg-white/25"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    engineRef.current?.pressLane(lane);
                  }}
                  onPointerUp={() => engineRef.current?.releaseLane(lane)}
                  onPointerCancel={() => engineRef.current?.releaseLane(lane)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          <button
            type="button"
            onClick={togglePause}
            className="absolute right-6 bottom-6 rounded-full border border-white/20 px-4 py-1.5 text-xs text-white/60 hover:border-white/40 hover:text-white"
          >
            {paused ? "Resume" : "Pause"}
          </button>

          {paused && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-5 bg-black/65 backdrop-blur-sm">
              <div className="font-mono text-xl tracking-[0.3em] text-white/80">
                PAUSED
              </div>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={togglePause}
                  className="rounded-full bg-white px-6 py-2 text-sm font-medium text-black"
                >
                  Resume
                </button>
                <button
                  type="button"
                  onClick={quit}
                  className="rounded-full border border-white/25 px-6 py-2 text-sm text-white/80"
                >
                  Quit
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* ---------------- Title ---------------- */}
      {screen === "title" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-9 px-6 text-center">
          <div>
            <h1 className="text-6xl font-semibold tracking-tight text-white sm:text-8xl">
              Pulse Show
            </h1>
            <p className="mt-4 text-sm text-white/50">
              Hit the beat. Light the sky.
            </p>
          </div>
          <button
            type="button"
            disabled={!ready}
            onClick={() => setScreen("select")}
            className="rounded-full bg-white px-10 py-3 text-sm font-medium text-black transition hover:bg-white/85 disabled:opacity-40"
          >
            Start
          </button>
          <p className="font-mono text-xs text-white/30">
            {LANE_LABELS.join(" · ")} — press a key anywhere to fire a rocket
          </p>
        </div>
      )}

      {/* ---------------- Song select ---------------- */}
      {screen === "select" && (
        <div className="absolute inset-0 overflow-y-auto">
          <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col gap-6 px-6 py-12">
            <div className="flex items-baseline justify-between">
              <h2 className="text-2xl font-semibold tracking-tight text-white">
                Choose a show
              </h2>
              <button
                type="button"
                onClick={() => setShowSettings((v) => !v)}
                className="text-xs text-white/45 hover:text-white"
              >
                {showSettings ? "Close settings" : "Settings"}
              </button>
            </div>

            {showSettings && (
              <div className="rounded-2xl border border-white/10 bg-black/50 p-5 backdrop-blur-sm">
                <div className="flex flex-wrap items-center gap-x-8 gap-y-5">
                  <label className="flex flex-col gap-2 text-xs text-white/50">
                    Volume
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={settings.volume}
                      onChange={(e) =>
                        updateSettings({ volume: Number(e.target.value) })
                      }
                      className="w-36 accent-white"
                    />
                  </label>
                  <label className="flex flex-col gap-2 text-xs text-white/50">
                    Offset {settings.offsetMs > 0 ? "+" : ""}
                    {settings.offsetMs}ms
                    <input
                      type="range"
                      min={-200}
                      max={200}
                      step={5}
                      value={settings.offsetMs}
                      onChange={(e) =>
                        updateSettings({ offsetMs: Number(e.target.value) })
                      }
                      className="w-36 accent-white"
                    />
                  </label>
                  <label className="flex items-center gap-2 text-xs text-white/50">
                    <input
                      type="checkbox"
                      checked={settings.hardMode}
                      onChange={(e) =>
                        updateSettings({ hardMode: e.target.checked })
                      }
                      className="accent-white"
                    />
                    Hard mode (can fail)
                  </label>
                </div>

                <div className="mt-5 border-t border-white/10 pt-4">
                  <div className="mb-2 text-xs text-white/40">
                    Firework skins · {total.toLocaleString()} lifetime score
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {UNLOCKABLES.map((u) => {
                      const unlocked = skins.some((s) => s.id === u.id);
                      return (
                        <button
                          key={u.id}
                          type="button"
                          disabled={!unlocked}
                          onClick={() => setSkin(u.id)}
                          title={
                            unlocked
                              ? u.description
                              : `Unlocks at ${u.requirement.toLocaleString()}`
                          }
                          className={`rounded-full border px-3 py-1 text-xs transition ${
                            skin === u.id
                              ? "border-white bg-white text-black"
                              : unlocked
                                ? "border-white/25 text-white/70 hover:border-white/50"
                                : "border-white/10 text-white/25"
                          }`}
                        >
                          {unlocked
                            ? u.name
                            : `${u.name} · ${(u.requirement / 1000) | 0}k`}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            <div className="flex items-center gap-2">
              <span className="text-xs text-white/40">Difficulty</span>
              {DIFFICULTIES.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => updateSettings({ difficulty: d })}
                  className={`rounded-full border px-3 py-1 text-xs capitalize transition ${
                    settings.difficulty === d
                      ? "border-white bg-white text-black"
                      : "border-white/20 text-white/60 hover:border-white/40"
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>

            {/* Import card, front and center. */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="group rounded-2xl border border-dashed border-white/25 bg-white/[0.03] p-6 text-left transition hover:border-white/50 hover:bg-white/[0.06]"
            >
              <div className="text-sm font-medium text-white">
                Import your music
              </div>
              <div className="mt-1 text-xs text-white/45">
                Drop a file or click to pick one. mp3, wav, ogg, m4a — analyzed
                in your browser and never uploaded.
              </div>
            </button>

            <SongRow
              title={DEMO_CHART.title}
              subtitle={`${DEMO_CHART.artist} · ${DEMO_CHART.bpm} BPM · ${DEMO_CHART.notes.length} notes`}
              onPlay={() => void playDemo("play")}
              onAmbient={() => void playDemo("ambient")}
            />

            {library.map((song) => (
              <SongRow
                key={song.id}
                title={song.title}
                subtitle={`${Math.round(song.bpm)} BPM · ${formatDuration(song.duration)}`}
                waveform={song.analysis.waveform}
                onPlay={() => void playStored(song, "play")}
                onAmbient={() => void playStored(song, "ambient")}
                onDelete={() => void removeSong(song.id)}
              />
            ))}

            <button
              type="button"
              onClick={() => setScreen("title")}
              className="self-start text-xs text-white/35 hover:text-white/70"
            >
              ← Back
            </button>
          </div>
        </div>
      )}

      {/* ---------------- Import progress ---------------- */}
      {screen === "importing" && importState && (
        <div className="absolute inset-0 flex items-center justify-center px-6">
          <div className="w-full max-w-md rounded-2xl border border-white/10 bg-black/60 p-6 backdrop-blur-sm">
            <div className="truncate text-sm font-medium text-white">
              {importState.name}
            </div>

            {importState.error ? (
              <>
                <p className="mt-3 text-xs text-red-300/80">
                  {importState.error}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setImportState(null);
                    setScreen("select");
                  }}
                  className="mt-4 rounded-full border border-white/25 px-4 py-1.5 text-xs text-white/80"
                >
                  Back
                </button>
              </>
            ) : (
              <>
                <div className="mt-2 text-xs capitalize text-white/45">
                  {importState.stage === "spectrum"
                    ? "Analyzing spectrum"
                    : importState.stage === "onsets"
                      ? "Finding onsets"
                      : importState.stage === "tempo"
                        ? "Estimating tempo"
                        : importState.stage === "sections"
                          ? "Mapping song sections"
                          : importState.stage}
                </div>
                <div className="mt-4">
                  <Waveform
                    data={importState.waveform}
                    progress={importState.progress}
                    height={56}
                  />
                </div>
                <div className="mt-4 h-1 overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full bg-white/80 transition-[width]"
                    style={{
                      width: `${Math.round(importState.progress * 100)}%`,
                    }}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ---------------- Results ---------------- */}
      {screen === "results" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 px-6 text-center">
          {failed ? (
            <div className="text-4xl font-semibold tracking-tight text-white/90">
              Show over
            </div>
          ) : (
            <div className="text-8xl font-bold leading-none text-white">
              {grade(acc)}
            </div>
          )}

          <div className="font-mono text-sm text-white/70">
            <div className="text-2xl tabular-nums text-white">
              {score.score.toLocaleString()}
            </div>
            <div className="mt-2 text-white/50">
              {(acc * 100).toFixed(1)}% · {score.maxCombo}x max combo
            </div>
            <div className="mt-1 text-xs text-white/40">
              {score.perfect} perfect · {score.good} good · {score.miss} miss
            </div>
            {newBest && (
              <div className="mt-2 text-xs text-amber-200/80">
                New personal best
              </div>
            )}
            {!newBest && best && (
              <div className="mt-2 text-xs text-white/30">
                Best {best.score.toLocaleString()} · {best.grade}
              </div>
            )}
          </div>

          <div className="flex flex-wrap justify-center gap-3">
            <button
              type="button"
              onClick={() => void replay()}
              className="rounded-full bg-white px-6 py-2 text-sm font-medium text-black"
            >
              Play again
            </button>
            <button
              type="button"
              onClick={() => setScreen("select")}
              className="rounded-full border border-white/25 px-6 py-2 text-sm text-white/80"
            >
              Song select
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface SongRowProps {
  title: string;
  subtitle: string;
  waveform?: number[];
  onPlay: () => void;
  onAmbient: () => void;
  onDelete?: () => void;
}

function SongRow({
  title,
  subtitle,
  waveform,
  onPlay,
  onAmbient,
  onDelete,
}: SongRowProps) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 transition hover:border-white/25">
      <div className="flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={onPlay}
          className="min-w-0 flex-1 text-left"
        >
          <div className="truncate text-sm font-medium text-white">{title}</div>
          <div className="mt-0.5 truncate text-xs text-white/40">
            {subtitle}
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onAmbient}
            title="Watch without playing"
            className="rounded-full border border-white/20 px-3 py-1 text-[11px] text-white/55 hover:border-white/45 hover:text-white"
          >
            Watch
          </button>
          <button
            type="button"
            onClick={onPlay}
            className="rounded-full bg-white/90 px-4 py-1 text-[11px] font-medium text-black hover:bg-white"
          >
            Play
          </button>
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              title="Remove from library"
              className="text-white/25 transition hover:text-white/70"
            >
              ×
            </button>
          )}
        </div>
      </div>
      {waveform && (
        <div className="mt-3 opacity-60">
          <Waveform
            data={waveform}
            height={28}
            color="rgba(255,255,255,0.5)"
            dimColor="rgba(255,255,255,0.5)"
          />
        </div>
      )}
    </div>
  );
}
