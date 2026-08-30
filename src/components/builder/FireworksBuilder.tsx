"use client";

/**
 * The firing desk.
 *
 * Everything the user edits is one `ShellSpec` in React state; the renderer
 * reads the latest one at launch time, so dragging a slider never touches the
 * GPU until the next shell goes up. Panels float over a full-bleed canvas — the
 * show is the page, the chrome is the instrument.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildShow, type ShowPlan } from "@/builder/choreography";
import {
  loadDemoTrack,
  loadTrackFile,
  looksLikeAudio,
  type Track,
  type TrackProgress,
} from "@/builder/music";
import { PRESETS } from "@/builder/presets";
import { randomShell } from "@/builder/random";
import {
  type FireworksHandle,
  type RendererStats,
  startFireworks,
} from "@/builder/renderer";
import {
  type BurstLayer,
  defaultLayer,
  MAX_LAYERS,
  makeId,
  parseShell,
  type ShellSpec,
  shellParticleCount,
} from "@/builder/spec";
import {
  deleteShell as deleteSavedShell,
  loadLast,
  loadSavedShells,
  rememberLast,
  saveShell,
} from "@/builder/storage";
import { BreakChart } from "./BreakChart";
import {
  ColorField,
  Credit,
  DeskButton,
  Eyebrow,
  Lamp,
  Slider,
  Toggle,
} from "./controls";
import { LayerEditor } from "./LayerEditor";
import { MusicDeck } from "./MusicDeck";
import { ShellRack } from "./ShellRack";

type MobileTab = "shell" | "rack" | "music";

/**
 * Where the music deck lives: a strip over the water on a desk-sized screen,
 * a sheet tab on a phone. One instance either way — two would mean two
 * playheads polling the same clock.
 */
function useWideLayout(): boolean {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const sync = () => setWide(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return wide;
}

function Section({
  title,
  children,
  right,
}: {
  title: string;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <Eyebrow>{title}</Eyebrow>
        {right}
      </div>
      {children}
    </section>
  );
}

export default function FireworksBuilder() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<FireworksHandle | null>(null);

  const [spec, setSpec] = useState<ShellSpec>(() => PRESETS[0]);
  const [saved, setSaved] = useState<ShellSpec[]>([]);
  const [stats, setStats] = useState<RendererStats>({
    particles: 0,
    fps: 0,
    shells: 0,
  });
  const [autoFire, setAutoFire] = useState(18);
  const [muted, setMuted] = useState(false);
  const [paused, setPaused] = useState(false);
  const [chromeHidden, setChromeHidden] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [gpuError, setGpuError] = useState<string | null>(null);
  const [tab, setTab] = useState<MobileTab>("shell");

  const wide = useWideLayout();
  const [track, setTrack] = useState<Track | null>(null);
  const [plan, setPlan] = useState<ShowPlan | null>(null);
  const [trackProgress, setTrackProgress] = useState<TrackProgress | null>(
    null,
  );
  const [musicError, setMusicError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [density, setDensity] = useState(0.55);
  const [followColors, setFollowColors] = useState(true);
  const [musicVolume, setMusicVolume] = useState(0.85);
  const [syncOffset, setSyncOffset] = useState(0);
  /** Which live source the desk is listening to, if any. */
  const [listening, setListening] = useState<"tab" | "mic" | null>(null);
  /** True between pressing play and stopping, so pause can resume in place. */
  const startedRef = useRef(false);
  /** Set by a load so the show starts as soon as its script is cut. */
  const autoStartRef = useRef(false);

  /**
   * The renderer starts once and then follows `spec` through `setSpec()`, so it
   * only ever needs the shell that existed at mount.
   */
  const bootSpec = useRef(spec);

  // Restore the last session's draft and rack once, on the client.
  useEffect(() => {
    setSaved(loadSavedShells());
    const last = loadLast();
    if (last) setSpec(last);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let handle: FireworksHandle | null = null;
    let cancelled = false;

    void startFireworks(canvas, {
      spec: bootSpec.current,
      onStats: setStats,
      onMusicEnd: () => {
        startedRef.current = false;
        setPlaying(false);
      },
    })
      .then((created) => {
        if (cancelled) {
          created.dispose();
          return;
        }
        handle = created;
        handleRef.current = created;
      })
      .catch((error: unknown) => {
        setGpuError(
          error instanceof Error
            ? error.message
            : "This browser could not start WebGPU.",
        );
      });

    return () => {
      cancelled = true;
      handle?.dispose();
      handleRef.current = null;
    };
  }, []);

  useEffect(() => {
    handleRef.current?.setSpec(spec);
    rememberLast(spec);
  }, [spec]);

  useEffect(() => {
    handleRef.current?.setAutoFire(autoFire);
  }, [autoFire]);

  useEffect(() => {
    handleRef.current?.setMuted(muted);
  }, [muted]);

  useEffect(() => {
    handleRef.current?.setPaused(paused);
  }, [paused]);

  useEffect(() => {
    handleRef.current?.setMusicVolume(musicVolume);
  }, [musicVolume]);

  useEffect(() => {
    handleRef.current?.setShowOptions({ density, followColors, syncOffset });
  }, [density, followColors, syncOffset]);

  /**
   * Re-cut the script whenever the track, the shell, or the show settings
   * change. Debounced because dragging a slider would otherwise re-choreograph
   * the whole song on every pixel — and the renderer picks the new script up
   * mid-playback, so this is safe to do while the music runs.
   */
  useEffect(() => {
    if (!track) {
      setPlan(null);
      handleRef.current?.setCues(null);
      return;
    }
    const timer = window.setTimeout(() => {
      const next = buildShow(track.analysis, spec, { density, followColors });
      setPlan(next);
      const handle = handleRef.current;
      handle?.setCues(next.cues);
      if (autoStartRef.current && handle) {
        autoStartRef.current = false;
        startedRef.current = true;
        handle.playMusic(track.buffer, 0);
        setPlaying(true);
      }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [track, spec, density, followColors]);

  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(null), 2600);
    return () => window.clearTimeout(timer);
  }, [status]);

  const fire = useCallback(() => handleRef.current?.launch(), []);

  const patch = useCallback((next: Partial<ShellSpec>) => {
    setSpec((current) => ({ ...current, ...next }));
  }, []);

  const patchLayer = useCallback((index: number, next: BurstLayer) => {
    setSpec((current) => {
      const layers = current.layers.slice();
      layers[index] = next;
      return { ...current, layers };
    });
  }, []);

  const addLayer = useCallback(() => {
    setSpec((current) => {
      if (current.layers.length >= MAX_LAYERS) return current;
      const lead = current.layers[0];
      return {
        ...current,
        layers: [
          ...current.layers,
          defaultLayer({
            name: "Second break",
            delay: 0.6,
            count: 1200,
            speed: 8,
            colorA: lead?.colorB ?? "#ffffff",
            colorB: lead?.colorA ?? "#ff6a1f",
            inherit: 0,
          }),
        ],
      };
    });
  }, []);

  const randomize = useCallback(() => {
    const next = randomShell();
    setSpec(next);
    setStatus(`Rolled “${next.name}”`);
    window.setTimeout(() => handleRef.current?.launch(), 60);
  }, []);

  const save = useCallback(() => {
    // A fresh id on save keeps stock shells intact while stacking variations.
    const stored: ShellSpec = { ...spec, id: makeId("shell") };
    setSaved(saveShell(stored));
    setSpec(stored);
    setStatus(`Saved “${stored.name}” to your rack`);
  }, [spec]);

  const exportJson = useCallback(() => {
    const json = JSON.stringify(spec, null, 2);
    void navigator.clipboard
      ?.writeText(json)
      .then(() => setStatus("Shell JSON copied to the clipboard"))
      .catch(() => setStatus("Could not reach the clipboard"));
  }, [spec]);

  const importJson = useCallback(() => {
    const text = window.prompt("Paste shell JSON");
    if (!text) return;
    try {
      const next = parseShell(JSON.parse(text));
      setSpec({ ...next, id: makeId("shell") });
      setStatus(`Loaded “${next.name}”`);
    } catch {
      setStatus("That JSON could not be read");
    }
  }, []);

  const loadTrack = useCallback(
    async (loader: () => Promise<Track>, what: string) => {
      setMusicError(null);
      setTrackProgress({ stage: "decoding", progress: 0 });
      handleRef.current?.stopMusic();
      startedRef.current = false;
      setPlaying(false);
      try {
        const next = await loader();
        autoStartRef.current = true;
        setTrack(next);
        setStatus(
          `Charted “${next.name}” — ${Math.round(next.analysis.bpm)} bpm`,
        );
      } catch (error) {
        setMusicError(
          error instanceof Error ? error.message : `Could not read ${what}`,
        );
      } finally {
        setTrackProgress(null);
      }
    },
    [],
  );

  const pickFile = useCallback(
    (file: File) => {
      if (!looksLikeAudio(file)) {
        setMusicError("That file does not look like audio.");
        return;
      }
      void loadTrack(
        () =>
          loadTrackFile(
            file,
            (audio) => {
              const handle = handleRef.current;
              if (!handle) throw new Error("The show is still starting up.");
              return handle.decode(audio);
            },
            setTrackProgress,
          ),
        file.name,
      );
    },
    [loadTrack],
  );

  const useDemoTrack = useCallback(() => {
    void loadTrack(() => loadDemoTrack(setTrackProgress), "the demo track");
  }, [loadTrack]);

  const togglePlay = useCallback(() => {
    const handle = handleRef.current;
    if (!handle || !track) return;
    if (handle.musicPlaying) {
      handle.pauseMusic();
      setPlaying(false);
      return;
    }
    if (startedRef.current) handle.resumeMusic();
    else {
      startedRef.current = true;
      handle.playMusic(track.buffer, 0);
    }
    setPlaying(true);
  }, [track]);

  const stopMusic = useCallback(() => {
    handleRef.current?.stopMusic();
    startedRef.current = false;
    setPlaying(false);
  }, []);

  const ejectTrack = useCallback(() => {
    handleRef.current?.clearMusic();
    startedRef.current = false;
    setPlaying(false);
    setTrack(null);
    setPlan(null);
    setStatus("Track ejected — auto-fire has the sky again");
  }, []);

  const seekMusic = useCallback((seconds: number) => {
    startedRef.current = true;
    handleRef.current?.seekMusic(seconds);
  }, []);

  const songTime = useCallback(() => handleRef.current?.songTime ?? null, []);
  const liveState = useCallback(() => handleRef.current?.liveState ?? null, []);

  const stopListening = useCallback(() => {
    handleRef.current?.stopListening();
    setListening(null);
    setStatus("Stopped listening — auto-fire has the sky again");
  }, []);

  /**
   * Opens a live source and hands it to the conductor.
   *
   * Tab capture has to ask for video: Chrome only offers the "share tab audio"
   * tick alongside a video share. The frames are dropped the moment the stream
   * arrives — nothing looks at them.
   */
  const listenTo = useCallback(
    async (source: "tab" | "mic") => {
      setMusicError(null);
      let stream: MediaStream;
      try {
        stream =
          source === "tab"
            ? await navigator.mediaDevices.getDisplayMedia({
                audio: true,
                video: true,
              })
            : await navigator.mediaDevices.getUserMedia({
                audio: {
                  echoCancellation: false,
                  noiseSuppression: false,
                  autoGainControl: false,
                },
              });
      } catch (error) {
        // A cancelled picker is not an error worth shouting about.
        if ((error as DOMException).name === "NotAllowedError") return;
        setMusicError(
          error instanceof Error
            ? error.message
            : "Could not open that audio source.",
        );
        return;
      }

      for (const video of stream.getVideoTracks()) {
        video.stop();
        stream.removeTrack(video);
      }
      const audio = stream.getAudioTracks()[0];
      if (!audio) {
        for (const leftover of stream.getTracks()) leftover.stop();
        setMusicError(
          source === "tab"
            ? "That share carried no audio — pick a tab and tick “Also share tab audio”."
            : "No microphone audio came through.",
        );
        return;
      }

      const handle = handleRef.current;
      if (!handle) {
        for (const leftover of stream.getTracks()) leftover.stop();
        setMusicError("The show is still starting up — try again in a moment.");
        return;
      }

      // One source at a time: a loaded track would fight the live conductor.
      handle.clearMusic();
      startedRef.current = false;
      setPlaying(false);
      setTrack(null);
      setPlan(null);

      handle.startListening(stream);
      audio.addEventListener("ended", () => stopListening());
      setListening(source);
      if (source === "mic") {
        // The desk's own booms would otherwise be heard as beats.
        setMuted(true);
        setStatus(
          "Listening to the microphone — reports muted so they don't loop",
        );
      } else {
        setStatus("Listening to the shared tab");
      }
    },
    [stopListening],
  );

  // A track dropped anywhere on the page loads it; the canvas fills the page,
  // so there is nowhere else a drop could sensibly mean.
  useEffect(() => {
    const onDragOver = (event: DragEvent) => {
      if (!event.dataTransfer) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (event: DragEvent) => {
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      event.preventDefault();
      pickFile(file);
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [pickFile]);

  // Keyboard is the fastest way to iterate: fire, roll, and get the desk out
  // of the way without leaving the sliders.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      switch (event.code) {
        case "Space":
          event.preventDefault();
          fire();
          break;
        case "KeyR":
          randomize();
          break;
        case "KeyH":
          setChromeHidden((value) => !value);
          break;
        case "KeyM":
          setMuted((value) => !value);
          break;
        case "KeyA":
          setAutoFire((value) => (value > 0 ? 0 : 18));
          break;
        case "KeyP":
          if (track) {
            event.preventDefault();
            togglePlay();
          }
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fire, randomize, togglePlay, track]);

  const stars = useMemo(() => shellParticleCount(spec), [spec]);

  const shellCard = (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <input
          value={spec.name}
          onChange={(event) => patch({ name: event.target.value.slice(0, 60) })}
          aria-label="Shell name"
          className="border-seam text-paper focus:border-ember/60 min-w-0 flex-1 rounded-[3px] border bg-transparent px-2 py-1.5 text-[13px] outline-none"
        />
        <DeskButton tone="primary" onClick={save}>
          Save
        </DeskButton>
      </div>

      <BreakChart spec={spec} />

      <Section
        title="Layers"
        right={
          <span className="readout text-ash text-[10px]">
            {stars.toLocaleString()} stars
          </span>
        }
      >
        <div className="flex flex-col gap-1.5">
          {spec.layers.map((layer, index) => (
            <LayerEditor
              key={layer.id}
              layer={layer}
              index={index}
              canDelete={spec.layers.length > 1}
              onChange={(next) => patchLayer(index, next)}
              onDuplicate={() =>
                setSpec((current) => ({
                  ...current,
                  layers:
                    current.layers.length >= MAX_LAYERS
                      ? current.layers
                      : [
                          ...current.layers,
                          {
                            ...layer,
                            id: makeId("layer"),
                            name: `${layer.name} copy`,
                          },
                        ],
                }))
              }
              onDelete={() =>
                setSpec((current) => ({
                  ...current,
                  layers: current.layers.filter(
                    (entry) => entry.id !== layer.id,
                  ),
                }))
              }
            />
          ))}
        </div>
        <DeskButton
          onClick={addLayer}
          disabled={spec.layers.length >= MAX_LAYERS}
          title={
            spec.layers.length >= MAX_LAYERS
              ? `A shell carries at most ${MAX_LAYERS} layers`
              : undefined
          }
        >
          Add layer
        </DeskButton>
      </Section>

      <div className="bg-seam h-px" />

      <Section title="Lift">
        <Slider
          label="Break height"
          value={spec.launch.height}
          min={8}
          max={90}
          step={1}
          unit=" m"
          onChange={(height) => patch({ launch: { ...spec.launch, height } })}
        />
        <Slider
          label="Tilt"
          value={spec.launch.tilt}
          min={-30}
          max={30}
          step={0.5}
          unit="°"
          precision={1}
          onChange={(tilt) => patch({ launch: { ...spec.launch, tilt } })}
        />
        <Slider
          label="Fuse"
          value={spec.launch.fuse}
          min={-0.5}
          max={1.2}
          step={0.05}
          unit="s"
          onChange={(fuse) => patch({ launch: { ...spec.launch, fuse } })}
        />
        <Slider
          label="Rising trail"
          value={spec.launch.trailRate}
          min={0}
          max={300}
          step={5}
          unit="/s"
          onChange={(trailRate) =>
            patch({ launch: { ...spec.launch, trailRate } })
          }
        />
        <Slider
          label="Break flash"
          value={spec.launch.flash}
          min={0}
          max={1}
          step={0.01}
          onChange={(flash) => patch({ launch: { ...spec.launch, flash } })}
        />
        <ColorField
          label="Trail colour"
          value={spec.launch.trailColor}
          onChange={(trailColor) =>
            patch({ launch: { ...spec.launch, trailColor } })
          }
        />
      </Section>

      <div className="bg-seam h-px" />

      <Section title="Night air">
        <Slider
          label="Gravity"
          value={spec.physics.gravity}
          min={1}
          max={20}
          step={0.1}
          unit=" m/s²"
          precision={1}
          onChange={(gravity) =>
            patch({ physics: { ...spec.physics, gravity } })
          }
        />
        <Slider
          label="Air drag"
          value={spec.physics.drag}
          min={0}
          max={2}
          step={0.02}
          onChange={(drag) => patch({ physics: { ...spec.physics, drag } })}
        />
        <Slider
          label="Wind"
          value={spec.physics.wind}
          min={-6}
          max={6}
          step={0.1}
          precision={1}
          onChange={(wind) => patch({ physics: { ...spec.physics, wind } })}
        />
        <Slider
          label="Turbulence"
          value={spec.physics.turbulence}
          min={0}
          max={2}
          step={0.02}
          onChange={(turbulence) =>
            patch({ physics: { ...spec.physics, turbulence } })
          }
        />
      </Section>

      <div className="bg-seam h-px" />

      <Section title="Camera">
        <Slider
          label="Bloom"
          value={spec.look.bloom}
          min={0}
          max={2}
          step={0.02}
          onChange={(bloom) => patch({ look: { ...spec.look, bloom } })}
        />
        <Slider
          label="Exposure"
          value={spec.look.exposure}
          min={0.3}
          max={2}
          step={0.02}
          onChange={(exposure) => patch({ look: { ...spec.look, exposure } })}
        />
        <Slider
          label="Water mirror"
          value={spec.look.reflection}
          min={0}
          max={1}
          step={0.01}
          onChange={(reflection) =>
            patch({ look: { ...spec.look, reflection } })
          }
        />
        <Slider
          label="Haze"
          value={spec.look.haze}
          min={0}
          max={1}
          step={0.01}
          onChange={(haze) => patch({ look: { ...spec.look, haze } })}
        />
      </Section>

      <div className="bg-seam h-px" />

      <Section title="Sound">
        <Toggle
          label="Report and crackle"
          checked={spec.audio.enabled}
          onChange={(enabled) => patch({ audio: { ...spec.audio, enabled } })}
        />
        <Slider
          label="Report"
          value={spec.audio.boom}
          min={0}
          max={1}
          step={0.01}
          onChange={(boom) => patch({ audio: { ...spec.audio, boom } })}
        />
        <Slider
          label="Crackle"
          value={spec.audio.crackle}
          min={0}
          max={1}
          step={0.01}
          onChange={(crackle) => patch({ audio: { ...spec.audio, crackle } })}
        />
      </Section>
    </div>
  );

  const musicDeck = (
    <MusicDeck
      track={track}
      plan={plan}
      progress={trackProgress}
      error={musicError}
      playing={playing}
      getTime={songTime}
      density={density}
      followColors={followColors}
      musicVolume={musicVolume}
      syncOffset={syncOffset}
      onDensity={setDensity}
      onFollowColors={setFollowColors}
      onMusicVolume={setMusicVolume}
      onSyncOffset={setSyncOffset}
      onPickFile={pickFile}
      onDemo={useDemoTrack}
      onPlayPause={togglePlay}
      onStop={stopMusic}
      onSeek={seekMusic}
      onClear={ejectTrack}
      listening={listening}
      getLive={liveState}
      onListen={(source) => void listenTo(source)}
      onStopListening={stopListening}
    />
  );

  const rack = (
    <ShellRack
      presets={PRESETS}
      saved={saved}
      activeId={spec.id}
      onLoad={(shell) => {
        setSpec(shell);
        setStatus(`Loaded “${shell.name}”`);
        window.setTimeout(() => handleRef.current?.launch(), 60);
      }}
      onDelete={(id) => setSaved(deleteSavedShell(id))}
      onExport={exportJson}
      onImport={importJson}
    />
  );

  return (
    <main className="bg-void relative h-full w-full overflow-hidden">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 block h-full w-full touch-none"
      />

      {gpuError ? (
        <div className="absolute inset-0 grid place-items-center p-6">
          <div className="border-seam bg-panel max-w-sm rounded-[4px] border p-5 backdrop-blur-md">
            <Eyebrow>No WebGPU</Eyebrow>
            <p className="text-paper mt-2 text-[13px] leading-relaxed">
              This browser could not start WebGPU, so the show cannot run. Try
              the latest Chrome, Edge, or Safari 26 on a machine with a GPU.
            </p>
            <p className="readout text-ash mt-3 text-[11px] break-words">
              {gpuError}
            </p>
          </div>
        </div>
      ) : null}

      {/* Masthead. The subtitle is the only instruction the desk needs. */}
      <header
        className={`pointer-events-none absolute top-0 left-0 z-20 p-4 transition-opacity duration-300 md:p-5 ${
          chromeHidden ? "opacity-0" : "opacity-100"
        }`}
      >
        <h1 className="font-display text-paper text-[26px] leading-none font-extrabold tracking-[0.02em] uppercase md:text-[30px]">
          Firework<span className="text-ember">.</span>sh
        </h1>
        <p className="text-ash mt-1 text-[11px] tracking-wide">
          Click the water to fire there · Drag to look around · Space fires · H
          hides the desk
        </p>
        {/* Credits. The header ignores pointer events, so the links opt back in. */}
        <nav className="text-ash pointer-events-auto mt-1.5 flex items-center gap-2 text-[11px] tracking-wide">
          <Credit href="https://github.com/TimMikeladze">GitHub</Credit>
          <span className="text-ash/45">·</span>
          <Credit href="https://linesofcode.dev">linesofcode.dev</Credit>
          <span className="text-ash/45">·</span>
          <Credit href="https://x.com/linesofcode">@linesofcode</Credit>
        </nav>
      </header>

      {/* Desk panels. Hidden entirely on hand-held widths, where the sheet wins. */}
      <aside
        className={`panel-scroll desk-rise border-seam bg-panel absolute top-24 bottom-24 left-4 z-20 hidden w-[248px] overflow-y-auto rounded-[5px] border p-3 backdrop-blur-md transition-opacity duration-300 md:block ${
          chromeHidden ? "pointer-events-none opacity-0" : "opacity-100"
        }`}
      >
        {rack}
      </aside>

      <aside
        className={`panel-scroll desk-rise border-seam bg-panel absolute top-6 right-4 bottom-24 z-20 hidden w-[330px] overflow-y-auto rounded-[5px] border p-3 backdrop-blur-md transition-opacity duration-300 lg:block ${
          chromeHidden ? "pointer-events-none opacity-0" : "opacity-100"
        }`}
        style={{ animationDelay: "80ms" }}
      >
        {shellCard}
      </aside>

      {wide ? (
        <div
          // Centred in the gap between the two desk panels, not the window, so
          // a narrow desktop cannot slide the deck under the shell card.
          className={`pointer-events-none absolute right-4 bottom-[62px] left-4 z-30 flex justify-center transition-opacity duration-300 lg:right-[352px] lg:left-[268px] ${
            chromeHidden ? "pointer-events-none opacity-0" : "opacity-100"
          }`}
        >
          {musicDeck}
        </div>
      ) : null}

      {/* Firing bar. */}
      <div
        className={`absolute inset-x-0 bottom-0 z-30 flex justify-center p-4 transition-opacity duration-300 ${
          chromeHidden ? "pointer-events-none opacity-0" : "opacity-100"
        }`}
      >
        <div className="desk-rise border-seam bg-panel flex max-w-full items-center gap-3 overflow-x-auto rounded-[5px] border px-3 py-2 backdrop-blur-md">
          <button
            type="button"
            onClick={fire}
            className="border-ember/70 bg-ember/20 text-gold hover:bg-ember/35 font-display rounded-[3px] border px-4 py-1.5 text-[15px] font-bold tracking-[0.12em] uppercase transition-colors"
          >
            Fire
          </button>

          <div className="bg-seam h-6 w-px" />

          <label className="flex items-center gap-2 text-[11px]">
            <Lamp on={autoFire > 0} live={autoFire > 0 && !paused} />
            <span className="text-ash whitespace-nowrap">Auto</span>
            <input
              type="range"
              min={0}
              max={60}
              step={1}
              value={autoFire}
              aria-label="Auto-fire rate, shells per minute"
              onChange={(event) => setAutoFire(Number(event.target.value))}
              style={
                { "--fill": `${(autoFire / 60) * 100}%` } as React.CSSProperties
              }
              className="w-24"
            />
            <span className="readout text-paper w-12 text-[11px]">
              {playing || listening
                ? "synced"
                : autoFire === 0
                  ? "off"
                  : `${autoFire}/min`}
            </span>
          </label>

          <div className="bg-seam h-6 w-px" />

          <DeskButton onClick={randomize} title="Roll a random shell (R)">
            Roll
          </DeskButton>
          <DeskButton
            onClick={() => {
              handleRef.current?.clear();
              setStatus("Sky cleared");
            }}
          >
            Clear
          </DeskButton>
          <DeskButton onClick={() => setPaused((value) => !value)}>
            {paused ? "Resume" : "Freeze"}
          </DeskButton>
          <DeskButton onClick={() => setMuted((value) => !value)}>
            {muted ? "Unmute" : "Mute"}
          </DeskButton>

          <div className="bg-seam h-6 w-px" />

          <span className="readout text-ash hidden text-[10px] whitespace-nowrap md:inline">
            {stats.fps} fps · {stats.particles.toLocaleString()} stars ·{" "}
            {stats.shells} up
          </span>
        </div>
      </div>

      {/* Mobile sheet: the same two panels, stacked behind a tab switch. */}
      <div
        className={`absolute inset-x-0 bottom-0 z-20 lg:hidden ${
          chromeHidden ? "hidden" : ""
        }`}
      >
        <div className="border-seam bg-panel panel-scroll mx-2 mb-[68px] max-h-[46vh] overflow-y-auto rounded-[5px] border p-3 backdrop-blur-md">
          <div className="mb-3 flex gap-1">
            {(["shell", "rack", "music"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setTab(value)}
                className={`eyebrow rounded-[3px] px-2.5 py-1 text-[11px] transition-colors ${
                  tab === value ? "bg-ember/18 text-gold" : "text-ash"
                }`}
              >
                {value === "shell"
                  ? "Shell"
                  : value === "rack"
                    ? "Rack"
                    : "Music"}
              </button>
            ))}
          </div>
          {tab === "shell" ? shellCard : tab === "rack" ? rack : null}
          {tab === "music" && !wide ? musicDeck : null}
        </div>
      </div>

      {status ? (
        <output className="border-seam bg-panel text-paper absolute bottom-20 left-1/2 z-40 -translate-x-1/2 rounded-[3px] border px-3 py-1.5 text-[11px] backdrop-blur-md">
          {status}
        </output>
      ) : null}
    </main>
  );
}
