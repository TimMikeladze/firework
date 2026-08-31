/**
 * A tiny synth for the show, and the transport that plays music under it.
 *
 * No samples for the fireworks: the lift, the break, and the crackling tail are
 * all cheaper — and easier to tune from sliders — as scheduled WebAudio nodes.
 * The voices themselves live in `./sfx`, which knows nothing about contexts or
 * transports so it can be rendered offline and tested; this class owns the
 * context, the buses they land on, and the music underneath them.
 *
 * A loaded track plays through the same context, because a synced show has to
 * schedule breaks against the clock the music is actually playing on;
 * `songTime` is that clock, and nothing else is allowed to drive cue timing.
 *
 * The context stays suspended until the first user gesture, which is what
 * browser autoplay policy requires.
 */

import {
  type BurstCharacterName,
  type BurstSound,
  buildSfxChain,
  type CrackleSound,
  type LiftSound,
  noiseBuffer,
  type SfxBus,
  scheduleBurst,
  scheduleCrackle,
  scheduleLift,
} from "./sfx";

const NOISE_SECONDS = 2;

/** How long a burst counts as "in flight" when levelling a barrage. */
const CROWD_WINDOW = 0.4;

export class ShowAudio {
  private ctx: AudioContext | null = null;
  /** The output gain the fireworks volume slider drives. */
  private master: GainNode | null = null;
  /** Where the voices land: dry straight to the glue, wet through the tail. */
  private bus: SfxBus | null = null;
  private musicBus: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  /**
   * When the recent breaks happened, oldest first.
   *
   * A barrage used to be handled by refusing any break within 35 ms of the
   * last one, which quietly deleted the sound of half a finale. The limiter
   * downstream takes care of the peaks now, so this is only here to pull the
   * level of each voice back as the count climbs — twenty shells at once
   * should sound like twenty shells, not like twenty times one shell.
   */
  private recentBursts: number[] = [];

  private music: AudioBufferSourceNode | null = null;
  private musicBuffer: AudioBuffer | null = null;
  /** Context time the current playback would have had song position 0 at. */
  private musicOrigin = 0;
  private musicPaused = false;
  private pausedAt = 0;
  private sfxLevel = 0.9;
  /**
   * Manual audio/visual calibration in seconds, on top of the device's own
   * reported output latency. Positive delays the fireworks.
   */
  private syncOffset = 0;
  /** Called once when a track reaches its end on its own. */
  onMusicEnd: (() => void) | null = null;

  private listenStream: MediaStream | null = null;
  private listenSource: MediaStreamAudioSourceNode | null = null;
  private listenSink: GainNode | null = null;

  /** Safe to call on every gesture; only the first one does work. */
  resume(): void {
    const ctx = this.ensure();
    if (ctx.state === "suspended") void ctx.resume();
  }

  private ensure(): AudioContext {
    if (this.ctx) return this.ctx;
    const Ctor: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const ctx = new Ctor({ latencyHint: "interactive" });

    const { bus, master } = buildSfxChain(ctx, ctx.destination);
    master.gain.value = this.sfxLevel;

    const musicBus = ctx.createGain();
    musicBus.gain.value = 0.85;
    musicBus.connect(ctx.destination);
    this.musicBus = musicBus;

    this.ctx = ctx;
    this.master = master;
    this.bus = bus;
    this.noise = noiseBuffer(ctx, NOISE_SECONDS);
    return ctx;
  }

  /**
   * The bus and buffer a voice needs, or `null` when nothing can be heard
   * anyway — the context is still suspended, or the show is muted to zero.
   */
  private ready(
    gain: number,
  ): { ctx: AudioContext; bus: SfxBus; noise: AudioBuffer } | null {
    if (gain <= 0) return null;
    const ctx = this.ensure();
    if (ctx.state !== "running" || !this.bus || !this.noise) return null;
    return { ctx, bus: this.bus, noise: this.noise };
  }

  /**
   * How far to pull one voice down for the company it is keeping.
   *
   * Sub-linear, so a finale still gets louder as it thickens, but not by the
   * sum of its parts.
   */
  private crowding(now: number): number {
    while (
      this.recentBursts.length &&
      now - this.recentBursts[0] > CROWD_WINDOW
    )
      this.recentBursts.shift();
    const n = this.recentBursts.length;
    this.recentBursts.push(now);
    return Math.max(0.32, 1 / (1 + n * 0.22));
  }

  /** Level of the fireworks themselves — the booms, whistles, and crackle. */
  set volume(value: number) {
    this.ensure();
    this.sfxLevel = Math.max(0, Math.min(1, value));
    if (this.master) this.master.gain.value = this.sfxLevel;
  }

  set musicVolume(value: number) {
    this.ensure();
    if (this.musicBus)
      this.musicBus.gain.value = Math.max(0, Math.min(1, value));
  }

  get musicVolume(): number {
    return this.musicBus?.gain.value ?? 0.85;
  }

  /** Decodes a dropped or picked file. Throws if the browser cannot read it. */
  async decode(file: File): Promise<AudioBuffer> {
    const ctx = this.ensure();
    return await ctx.decodeAudioData(await file.arrayBuffer());
  }

  /**
   * The lift: the mortar's thump, then the whistle climbing with the shell.
   *
   * `seconds` is the fuse — how long until the break — so the whistle ends
   * exactly where the crack begins.
   */
  lift(gain: number, seconds: number, distance = 0, pan = 0): void {
    const ready = this.ready(gain);
    if (!ready) return;
    const sound: LiftSound = { gain, seconds, distance, pan };
    scheduleLift(
      ready.ctx,
      ready.bus,
      ready.noise,
      ready.ctx.currentTime,
      sound,
    );
  }

  /**
   * The break. `size` (0..1) shifts the body between a tight salute and a deep
   * thud; `distance` delays it, dulls it, and wets it, the way a far shell
   * actually sounds; `pan` places it across the camera's own right vector.
   */
  boom(
    gain: number,
    size: number,
    distance: number,
    pan = 0,
    character?: BurstCharacterName,
  ): void {
    const ready = this.ready(gain);
    if (!ready) return;
    const now = ready.ctx.currentTime;
    const sound: BurstSound = {
      gain,
      size,
      distance,
      pan,
      crowd: this.crowding(now),
      character,
    };
    scheduleBurst(ready.ctx, ready.bus, ready.noise, now, sound);
  }

  /** The tail: dry, irregular pops scattering under the falling sparks. */
  crackle(gain: number, seconds: number, distance: number, pan = 0): void {
    const ready = this.ready(gain);
    if (!ready) return;
    const sound: CrackleSound = { gain, seconds, distance, pan };
    scheduleCrackle(
      ready.ctx,
      ready.bus,
      ready.noise,
      ready.ctx.currentTime,
      sound,
    );
  }

  /** The audio clock everything schedules against. */
  get now(): number {
    return this.ensure().currentTime;
  }

  /* ---------------------------------------------------------------- */
  /* Listening                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Taps a live stream — a shared tab, or the microphone — and returns the
   * analyser the conductor reads.
   *
   * The analyser feeds a silent gain node on the way to the destination.
   * Nothing is played back: a tab is already audible in its own tab, and
   * playing a microphone back into the room is a feedback loop. The silent
   * connection is only there because a graph branch that reaches no destination
   * is not guaranteed to be pulled at all.
   */
  listen(stream: MediaStream): AnalyserNode {
    const ctx = this.ensure();
    this.stopListening();

    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.55;
    const sink = ctx.createGain();
    sink.gain.value = 0;

    source.connect(analyser);
    analyser.connect(sink).connect(ctx.destination);

    this.listenStream = stream;
    this.listenSource = source;
    this.listenSink = sink;
    void ctx.resume();
    return analyser;
  }

  stopListening(): void {
    this.listenSource?.disconnect();
    this.listenSink?.disconnect();
    for (const track of this.listenStream?.getTracks() ?? []) track.stop();
    this.listenStream = null;
    this.listenSource = null;
    this.listenSink = null;
  }

  get listening(): boolean {
    return this.listenStream !== null;
  }

  /* ---------------------------------------------------------------- */
  /* Music transport                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * Starts (or restarts) the loaded track at `offset` seconds.
   *
   * Pause is a stop-and-restart rather than a context suspend: suspending would
   * freeze the shell synth and every scheduled boom with it, and the show is
   * allowed to keep burning down while the music is held.
   */
  playMusic(buffer: AudioBuffer, offset = 0): void {
    const ctx = this.ensure();
    this.stopMusicNode();
    this.musicBuffer = buffer;
    const start = Math.max(0, Math.min(buffer.duration, offset));

    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(this.musicBus ?? ctx.destination);
    node.onended = () => {
      // A stop() we asked for clears `music` first, so this only fires when the
      // track actually ran out.
      if (this.music !== node) return;
      this.music = null;
      this.musicPaused = false;
      this.onMusicEnd?.();
    };
    node.start(ctx.currentTime + 0.02, start);

    this.music = node;
    this.musicOrigin = ctx.currentTime + 0.02 - start;
    this.musicPaused = false;
    void ctx.resume();
  }

  private stopMusicNode(): void {
    const node = this.music;
    this.music = null;
    if (!node) return;
    node.onended = null;
    try {
      node.stop();
    } catch {
      // Already stopped.
    }
    node.disconnect();
  }

  pauseMusic(): void {
    if (!this.music || this.musicPaused) return;
    this.pausedAt = this.rawSongTime();
    this.stopMusicNode();
    this.musicPaused = true;
  }

  resumeMusic(): void {
    if (!this.musicPaused || !this.musicBuffer) return;
    this.playMusic(this.musicBuffer, this.pausedAt);
  }

  stopMusic(): void {
    this.stopMusicNode();
    this.musicPaused = false;
    this.pausedAt = 0;
  }

  seekMusic(seconds: number): void {
    if (!this.musicBuffer) return;
    if (this.musicPaused || !this.music) {
      this.pausedAt = Math.max(0, seconds);
      this.musicPaused = true;
      return;
    }
    this.playMusic(this.musicBuffer, seconds);
  }

  /** Song position with no latency compensation. */
  private rawSongTime(): number {
    if (this.musicPaused) return this.pausedAt;
    if (!this.ctx || !this.music) return 0;
    return this.ctx.currentTime - this.musicOrigin;
  }

  /**
   * The song position the listener is hearing right now, or `null` when no
   * track is loaded.
   *
   * `currentTime` is the position being written to the device, so what reaches
   * the ears is `outputLatency` older than that. Cues schedule against the
   * heard position, otherwise every break lands early by the buffer depth.
   */
  get songTime(): number | null {
    if (!this.musicBuffer) return null;
    const latency = this.musicPaused
      ? 0
      : ((this.ctx as (AudioContext & { outputLatency?: number }) | null)
          ?.outputLatency ?? 0);
    return this.rawSongTime() - latency - this.syncOffset;
  }

  get musicPlaying(): boolean {
    return this.music !== null && !this.musicPaused;
  }

  get musicLoaded(): boolean {
    return this.musicBuffer !== null;
  }

  /** Positive values hold the fireworks back; negative fire them early. */
  setSyncOffset(seconds: number): void {
    this.syncOffset = Math.max(-0.5, Math.min(0.5, seconds));
  }

  clearMusic(): void {
    this.stopMusic();
    this.musicBuffer = null;
  }

  dispose(): void {
    this.stopListening();
    this.stopMusicNode();
    this.musicBuffer = null;
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
    this.bus = null;
    this.musicBus = null;
    this.noise = null;
    this.recentBursts = [];
  }
}
