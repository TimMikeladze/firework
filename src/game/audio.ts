import type { Bands } from "./palette";
import { scheduleDemoSong } from "./song";

/**
 * All gameplay timing derives from AudioContext.currentTime. requestAnimationFrame
 * only decides *when* we sample that clock — it never advances it.
 */

export interface AudioSource {
  kind: "demo" | "buffer";
  buffer?: AudioBuffer;
}

export class AudioEngine {
  readonly ctx: AudioContext;
  private analyser: AnalyserNode;
  private freq: Uint8Array;
  private master: GainNode;

  private source: AudioBufferSourceNode | null = null;
  private startTime = 0;
  private paused = false;
  private pausedAt = 0;
  private running = false;

  /** Smoothed band energies, updated by `sampleBands`. */
  private bands: Bands = { bass: 0, mid: 0, high: 0 };

  constructor() {
    const Ctor: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    this.ctx = new Ctor({ latencyHint: "interactive" });
    this.master = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.72;
    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    this.master.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
  }

  get volume(): number {
    return this.master.gain.value;
  }

  set volume(v: number) {
    this.master.gain.value = Math.max(0, Math.min(1, v));
  }

  async resume() {
    if (this.ctx.state !== "running") await this.ctx.resume();
  }

  /**
   * Starts playback. `leadIn` seconds of silence precede song position 0 so the
   * player can see the first notes approach.
   */
  async start(src: AudioSource, leadIn = 2.5) {
    await this.resume();
    this.stop();
    const t0 = this.ctx.currentTime + 0.12 + leadIn;
    this.startTime = t0;

    if (src.kind === "demo") {
      scheduleDemoSong(this.ctx, this.master, t0);
    } else if (src.buffer) {
      const node = this.ctx.createBufferSource();
      node.buffer = src.buffer;
      node.connect(this.master);
      node.start(t0);
      this.source = node;
    }
    this.running = true;
    this.paused = false;
  }

  stop() {
    if (this.source) {
      try {
        this.source.stop();
      } catch {
        // Already stopped — nothing to do.
      }
      this.source.disconnect();
      this.source = null;
    }
    this.running = false;
  }

  /**
   * Song position in seconds. Negative during the lead-in, which is exactly what
   * the note scroller wants.
   */
  get time(): number {
    if (!this.running) return 0;
    if (this.paused) return this.pausedAt;
    return this.ctx.currentTime - this.startTime;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Pause is implemented by suspending the whole context: every scheduled event
   * freezes together, and currentTime stops advancing, so nothing desyncs.
   */
  async pause() {
    if (!this.running || this.paused) return;
    this.pausedAt = this.time;
    this.paused = true;
    await this.ctx.suspend();
  }

  async unpause() {
    if (!this.paused) return;
    await this.ctx.resume();
    // currentTime resumes where it left off, so the original offset still holds.
    this.startTime = this.ctx.currentTime - this.pausedAt;
    this.paused = false;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Reads the FFT and returns smoothed 0..1 band energies. */
  sampleBands(): Bands {
    this.analyser.getByteFrequencyData(this.freq as Uint8Array<ArrayBuffer>);
    const n = this.freq.length;
    const nyquist = this.ctx.sampleRate / 2;
    const binHz = nyquist / n;
    const idx = (hz: number) =>
      Math.min(n - 1, Math.max(0, Math.round(hz / binHz)));

    const avg = (lo: number, hi: number) => {
      const a = idx(lo);
      const b = idx(hi);
      let sum = 0;
      for (let i = a; i <= b; i++) sum += this.freq[i];
      return sum / Math.max(1, b - a + 1) / 255;
    };

    const bass = avg(20, 200);
    const mid = avg(200, 2000);
    // Highs are quiet by nature; lift them so they actually influence color.
    const high = Math.min(1, avg(2000, 12000) * 1.9);

    // Extra smoothing on top of the analyser's own, tuned for palette drift.
    const k = 0.25;
    this.bands.bass += (bass - this.bands.bass) * k;
    this.bands.mid += (mid - this.bands.mid) * k;
    this.bands.high += (high - this.bands.high) * k;
    return this.bands;
  }

  async decode(file: File): Promise<AudioBuffer> {
    const bytes = await file.arrayBuffer();
    return await this.ctx.decodeAudioData(bytes);
  }

  dispose() {
    this.stop();
    void this.ctx.close();
  }
}
