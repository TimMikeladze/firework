/**
 * A tiny synth for the show, and the transport that plays music under it.
 *
 * No samples for the fireworks: a lift whistle, a body-hit boom, and a crackle
 * tail are all cheaper — and easier to tune from sliders — as scheduled
 * WebAudio nodes. A loaded track plays through the same context, because a
 * synced show has to schedule breaks against the clock the music is actually
 * playing on; `songTime` is that clock, and nothing else is allowed to drive
 * cue timing.
 *
 * The context stays suspended until the first user gesture, which is what
 * browser autoplay policy requires.
 */

const NOISE_SECONDS = 2;

export class ShowAudio {
  private ctx: AudioContext | null = null;
  /** The bus every synthesized shell sound runs through. */
  private master: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  /** Rejects overlapping booms so a barrage cannot clip the output. */
  private lastBoom = 0;

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
    const master = ctx.createGain();
    master.gain.value = this.sfxLevel;
    master.connect(ctx.destination);

    const musicBus = ctx.createGain();
    musicBus.gain.value = 0.85;
    musicBus.connect(ctx.destination);
    this.musicBus = musicBus;

    const frames = Math.floor(ctx.sampleRate * NOISE_SECONDS);
    const noise = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

    this.ctx = ctx;
    this.master = master;
    this.noise = noise;
    return ctx;
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

  /** Reads a random slice of the shared noise buffer. */
  private noiseSource(ctx: AudioContext): AudioBufferSourceNode {
    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    source.loop = true;
    source.loopEnd = NOISE_SECONDS;
    return source;
  }

  /** The lift: a rising, breathy whistle that tracks the shell upward. */
  lift(gain: number, seconds: number): void {
    if (gain <= 0) return;
    const ctx = this.ensure();
    if (ctx.state !== "running" || !this.master) return;
    const t = ctx.currentTime;

    const source = this.noiseSource(ctx);
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.Q.value = 9;
    band.frequency.setValueAtTime(700, t);
    band.frequency.exponentialRampToValueAtTime(2100, t + seconds);

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.exponentialRampToValueAtTime(0.12 * gain, t + seconds * 0.35);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + seconds);

    source.connect(band).connect(amp).connect(this.master);
    source.start(t);
    source.stop(t + seconds + 0.05);
  }

  /**
   * The break. `size` (0..1) shifts the body between a tight crack and a deep
   * thud; `distance` delays and dulls it, the way a far shell actually sounds.
   */
  boom(gain: number, size: number, distance: number): void {
    if (gain <= 0) return;
    const ctx = this.ensure();
    if (ctx.state !== "running" || !this.master) return;
    // Sound takes about 3 ms per metre to arrive.
    const t = ctx.currentTime + distance * 0.003;
    if (t - this.lastBoom < 0.035) return;
    this.lastBoom = t;

    const body = ctx.createOscillator();
    body.type = "sine";
    const bodyHz = 120 - size * 62;
    body.frequency.setValueAtTime(bodyHz * 2.2, t);
    body.frequency.exponentialRampToValueAtTime(bodyHz * 0.55, t + 0.42);

    const bodyAmp = ctx.createGain();
    bodyAmp.gain.setValueAtTime(0.0001, t);
    bodyAmp.gain.exponentialRampToValueAtTime(0.55 * gain, t + 0.012);
    bodyAmp.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    body.connect(bodyAmp).connect(this.master);
    body.start(t);
    body.stop(t + 0.6);

    const source = this.noiseSource(ctx);
    const low = ctx.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.setValueAtTime(2600 - distance * 12, t);
    low.frequency.exponentialRampToValueAtTime(240, t + 0.4);

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.exponentialRampToValueAtTime(0.4 * gain, t + 0.008);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);

    source.connect(low).connect(amp).connect(this.master);
    source.start(t);
    source.stop(t + 0.6);
  }

  /** The tail: high, dry, irregular pops under the falling sparks. */
  crackle(gain: number, seconds: number, distance: number): void {
    if (gain <= 0) return;
    const ctx = this.ensure();
    if (ctx.state !== "running" || !this.master) return;
    const start = ctx.currentTime + distance * 0.003 + 0.06;

    const source = this.noiseSource(ctx);
    const high = ctx.createBiquadFilter();
    high.type = "highpass";
    high.frequency.value = 2600;

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, start);
    // Hand-scheduled pops read as crackle; a smooth envelope reads as hiss.
    const pops = Math.max(4, Math.round(seconds * 14));
    for (let i = 0; i < pops; i++) {
      const at = start + (i / pops) * seconds + Math.random() * 0.03;
      const decay = 0.9 - (i / pops) * 0.75;
      amp.gain.exponentialRampToValueAtTime(
        Math.max(0.0001, 0.07 * gain * decay * (0.4 + Math.random())),
        at,
      );
      amp.gain.exponentialRampToValueAtTime(0.0001, at + 0.02);
    }

    source.connect(high).connect(amp).connect(this.master);
    source.start(start);
    source.stop(start + seconds + 0.1);
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
    this.musicBus = null;
    this.noise = null;
  }
}
