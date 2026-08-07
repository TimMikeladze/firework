import type { AudioEngine, AudioSource } from "./audio";
import { applySkin, type Bands, css, hitColor, laneColor } from "./palette";
import { type BurstShape, ParticleSystem, type Rgb } from "./particles";
import { Scene } from "./scene";
import {
  type Chart,
  emptyScore,
  type HitResult,
  type Judgement,
  LANE_COUNT,
  LANE_LABELS,
  type Note,
  type ScoreState,
  type Section,
  sectionAt,
  WINDOW_GOOD,
  WINDOW_MISS,
  WINDOW_PERFECT,
} from "./types";

/** Seconds a note is visible before its hit time. */
const APPROACH = 1.6;
/** Score awarded at combo multiplier 1. */
const BASE_SCORE = { perfect: 300, good: 150, miss: 0 } as const;

interface LaneState {
  /** Seconds remaining on the pad's "fired" glow. */
  flash: number;
  held: boolean;
  lastJudgement: Judgement | null;
}

interface Popup {
  text: string;
  x: number;
  y: number;
  life: number;
  color: Rgb;
}

export interface EngineCallbacks {
  onScore: (s: ScoreState) => void;
  onFinish: (s: ScoreState, failed: boolean) => void;
  onHit?: (h: HitResult) => void;
  /** Only fires in hard mode. 0..1 */
  onHealth?: (health: number) => void;
}

export type EngineMode = "menu" | "play" | "ambient";

export interface EngineOptions {
  /**
   * Audio/visual calibration in seconds, added to the song clock before
   * comparing against note times. Positive means the player hits late.
   */
  offset: number;
  /** Opt-in fail condition. Off by default — the show should never stop. */
  hardMode: boolean;
  /** Firework skin id from the unlockables list. */
  skin: string;
}

export class GameEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private audio: AudioEngine;
  private particles = new ParticleSystem();
  private scene = new Scene();

  private chart: Chart | null = null;
  /** Index of the earliest note not yet hit or missed. */
  private cursor = 0;
  private hit: Uint8Array = new Uint8Array(0);

  private score: ScoreState = emptyScore();
  private lanes: LaneState[] = [];
  private popups: Popup[] = [];

  private raf = 0;
  private lastFrame = 0;
  private drift = 0;
  private shake = 0;
  private flash = 0;
  private mode: EngineMode = "menu";
  private finished = false;
  private cb: EngineCallbacks;
  private bands: Bands = { bass: 0, mid: 0, high: 0 };
  private ambientTimer = 0;
  private seed = 0x51ed270b;
  private dpr = 1;
  private fpsAccum = 0;
  private fpsFrames = 0;
  private fps = 60;
  private options: EngineOptions = {
    offset: 0,
    hardMode: false,
    skin: "classic",
  };
  /** Hard mode only: drains on miss, refills on hit. */
  private health = 1;
  /** True once hard mode's health ran out. Read by `hasFailed`. */
  private failed = false;

  constructor(
    canvas: HTMLCanvasElement,
    audio: AudioEngine,
    cb: EngineCallbacks,
  ) {
    this.canvas = canvas;
    this.audio = audio;
    this.cb = cb;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas2D unavailable");
    this.ctx = ctx;
    for (let i = 0; i < LANE_COUNT; i++)
      this.lanes.push({ flash: 0, held: false, lastJudgement: null });
    this.resize();
  }

  private rand(): number {
    this.seed ^= this.seed << 13;
    this.seed ^= this.seed >>> 17;
    this.seed ^= this.seed << 5;
    this.seed >>>= 0;
    return this.seed / 0xffffffff;
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.dpr = dpr;
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.scene.resize(w, h);
  }

  private get w() {
    return this.scene.width;
  }

  private get h() {
    return this.scene.height;
  }

  /** Y coordinate of the hit line. */
  private get hitY() {
    return this.h - Math.max(96, this.h * 0.13);
  }

  private laneX(lane: number): number {
    const usable = Math.min(this.w * 0.72, 620);
    const left = (this.w - usable) / 2;
    return left + (usable / LANE_COUNT) * (lane + 0.5);
  }

  private get laneW(): number {
    return Math.min(this.w * 0.72, 620) / LANE_COUNT;
  }

  /* -------------------------------------------------------------- */

  start() {
    if (this.raf) return;
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  destroy() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  setOptions(options: Partial<EngineOptions>) {
    this.options = { ...this.options, ...options };
  }

  /**
   * The song clock every gameplay decision uses. Derived from the audio context,
   * shifted by the player's calibration offset.
   */
  private get songTime(): number {
    return this.audio.time + this.options.offset;
  }

  setMode(mode: EngineMode) {
    this.mode = mode;
  }

  getMode(): EngineMode {
    return this.mode;
  }

  /** Loads a chart and starts audio. Resets all run state. */
  async play(
    chart: Chart,
    src: AudioSource,
    mode: Exclude<EngineMode, "menu"> = "play",
  ) {
    this.chart = chart;
    this.cursor = 0;
    this.hit = new Uint8Array(chart.notes.length);
    this.score = emptyScore();
    this.popups.length = 0;
    this.particles.clear();
    this.finished = false;
    this.failed = false;
    this.health = 1;
    this.mode = mode;
    this.cb.onScore(this.score);
    this.cb.onHealth?.(this.health);
    await this.audio.start(src);
  }

  stop() {
    this.audio.stop();
    this.mode = "menu";
    this.chart = null;
    this.particles.clear();
  }

  /* -------------------------------------------------------------- */
  /* Input                                                          */
  /* -------------------------------------------------------------- */

  pressLane(lane: number) {
    if (lane < 0 || lane >= LANE_COUNT) return;
    const state = this.lanes[lane];
    state.held = true;

    if (this.mode !== "play" || !this.chart) {
      // Menus and ambient mode still fire a firework — the sky is never idle.
      this.launchFor(lane, "good", 0.6);
      state.flash = 0.28;
      return;
    }

    const now = this.songTime;
    const notes = this.chart.notes;
    let best = -1;
    let bestAbs = Number.POSITIVE_INFINITY;

    // Scan forward from the cursor; notes are time-sorted so the window is small.
    for (let i = this.cursor; i < notes.length; i++) {
      const n = notes[i];
      const delta = now - n.time;
      if (delta > WINDOW_MISS) continue;
      if (-delta > WINDOW_MISS) break;
      if (n.lane !== lane || this.hit[i]) continue;
      const abs = Math.abs(delta);
      if (abs < bestAbs) {
        bestAbs = abs;
        best = i;
      }
    }

    state.flash = 0.3;

    if (best < 0) {
      // Stray press: a small puff, no penalty. Spectacle over punishment.
      const c = laneColor(this.currentSection().kind, lane, LANE_COUNT);
      this.particles.spray(this.laneX(lane), this.hitY, 8, c, 60, 0.9, 0.35);
      return;
    }

    this.hit[best] = 1;
    const delta = now - notes[best].time;
    const abs = Math.abs(delta);
    const judgement: Judgement =
      abs <= WINDOW_PERFECT ? "perfect" : abs <= WINDOW_GOOD ? "good" : "good";
    this.registerHit(best, judgement, delta);
  }

  releaseLane(lane: number) {
    if (lane >= 0 && lane < LANE_COUNT) this.lanes[lane].held = false;
  }

  /* -------------------------------------------------------------- */
  /* Scoring                                                        */
  /* -------------------------------------------------------------- */

  private currentSection(): Section {
    if (!this.chart) return { time: 0, kind: "verse", intensity: 0.5 };
    return sectionAt(this.chart.sections, Math.max(0, this.songTime));
  }

  private comboMultiplier(): number {
    const c = this.score.combo;
    if (c >= 100) return 8;
    if (c >= 60) return 6;
    if (c >= 30) return 4;
    if (c >= 15) return 2;
    return 1;
  }

  private registerHit(index: number, judgement: Judgement, delta: number) {
    const note = this.chart?.notes[index];
    if (!note) return;
    const section = this.currentSection();

    if (judgement === "perfect") this.score.perfect++;
    else this.score.good++;
    this.score.combo++;
    this.score.maxCombo = Math.max(this.score.maxCombo, this.score.combo);
    this.score.score += BASE_SCORE[judgement] * this.comboMultiplier();
    this.lanes[note.lane].lastJudgement = judgement;

    this.launchFor(note.lane, judgement, section.intensity);
    this.pushPopup(judgement, note.lane);

    // Big-moment juice, deliberately rare.
    if (this.score.combo > 0 && this.score.combo % 25 === 0) {
      this.shake = Math.min(1, 0.5 + section.intensity * 0.5);
      this.flash = 1;
      this.finale(section.intensity);
    }

    if (this.options.hardMode) {
      this.health = Math.min(
        1,
        this.health + (judgement === "perfect" ? 0.03 : 0.02),
      );
      this.cb.onHealth?.(this.health);
    }

    this.cb.onScore(this.score);
    this.cb.onHit?.({
      judgement,
      lane: note.lane,
      delta,
      combo: this.score.combo,
      intensity: section.intensity,
    });
  }

  private registerMiss(index: number) {
    const note = this.chart?.notes[index];
    if (!note) return;
    this.score.miss++;
    this.score.combo = 0;
    this.lanes[note.lane].lastJudgement = "miss";
    // A miss still produces something: a weak, low fizzle instead of a burst.
    const c = laneColor(this.currentSection().kind, note.lane, LANE_COUNT);
    const dim: Rgb = { r: c.r * 0.35, g: c.g * 0.35, b: c.b * 0.4 };
    this.particles.spray(
      this.laneX(note.lane),
      this.hitY,
      10,
      dim,
      45,
      1.4,
      0.5,
    );
    this.pushPopup("miss", note.lane);

    if (this.options.hardMode) {
      this.health = Math.max(0, this.health - 0.06);
      this.cb.onHealth?.(this.health);
      if (this.health <= 0 && !this.finished) {
        this.finished = true;
        this.failed = true;
        this.audio.stop();
        this.mode = "menu";
        this.cb.onFinish(this.score, true);
      }
    }

    this.cb.onScore(this.score);
  }

  private pushPopup(judgement: Judgement, lane: number) {
    const colors: Record<Judgement, Rgb> = {
      perfect: { r: 255, g: 230, b: 150 },
      good: { r: 150, g: 220, b: 255 },
      miss: { r: 130, g: 130, b: 150 },
    };
    this.popups.push({
      text:
        judgement === "perfect"
          ? "PERFECT"
          : judgement === "good"
            ? "GOOD"
            : "MISS",
      x: this.laneX(lane),
      y: this.hitY - 34,
      life: 0.7,
      color: colors[judgement],
    });
    if (this.popups.length > 24) this.popups.shift();
  }

  /* -------------------------------------------------------------- */
  /* Fireworks                                                      */
  /* -------------------------------------------------------------- */

  /** Picks a shape from combo + intensity so the show visibly escalates. */
  private shapeFor(intensity: number, combo: number): BurstShape {
    const power = intensity * 0.6 + Math.min(1, combo / 80) * 0.4;
    const roll = this.rand();
    if (power > 0.8)
      return roll < 0.35
        ? "chrysanthemum"
        : roll < 0.6
          ? "palm"
          : roll < 0.82
            ? "willow"
            : "ring";
    if (power > 0.55)
      return roll < 0.4
        ? "peony"
        : roll < 0.7
          ? "palm"
          : roll < 0.88
            ? "crossette"
            : "ring";
    if (power > 0.3) return roll < 0.6 ? "peony" : "crossette";
    return "peony";
  }

  /** Section + band color for a shell, with the active skin applied on top. */
  private shellColor(lane: number): Rgb {
    const section = this.currentSection();
    const base = hitColor(section.kind, this.bands, lane, LANE_COUNT);
    return applySkin(this.options.skin, base, this.rand());
  }

  private launchFor(lane: number, judgement: Judgement, intensity: number) {
    const color = this.shellColor(lane);
    const combo = this.score.combo;
    const quality = judgement === "perfect" ? 1 : 0.62;

    const x = this.laneX(lane) + (this.rand() - 0.5) * this.laneW * 0.5;
    // Higher intensity and longer combos push bursts further up the sky.
    const spread = 0.16 + intensity * 0.2;
    const targetY =
      this.h *
      (0.5 - intensity * 0.22 - Math.min(0.12, combo / 700)) *
      (0.75 + this.rand() * spread);

    const shape = this.shapeFor(intensity, combo);
    const sizeBase = 55 + intensity * 90 + Math.min(70, combo * 0.7);
    const size = sizeBase * quality;
    const count = Math.round(
      (70 + intensity * 130 + Math.min(120, combo * 1.1)) * quality,
    );

    this.particles.launch(x, this.hitY, targetY, color, (bx, by) => {
      this.particles.burst({
        x: bx,
        y: by,
        color,
        shape,
        size,
        count,
        life: 1.1 + intensity * 0.7,
        sparkle: 0.3 + this.bands.high * 0.5,
      });
      // Layered secondary shell once the combo is meaningful.
      if (combo >= 30 && judgement === "perfect") {
        const inner = this.shellColor((lane + 2) % LANE_COUNT);
        this.particles.burst({
          x: bx,
          y: by,
          color: inner,
          shape: "ring",
          size: size * 0.55,
          count: Math.round(count * 0.4),
          life: 0.9,
          sparkle: 0.6,
        });
      }
      this.flash = Math.max(
        this.flash,
        0.35 * quality * (0.5 + intensity * 0.5),
      );
    });

    // Pad muzzle spray.
    this.particles.spray(this.laneX(lane), this.hitY, 14, color, 90, 0.7, 0.4);
    this.lanes[lane].flash = 0.32;
  }

  /** Screen-wide multi-burst for combo milestones and song climaxes. */
  private finale(intensity: number) {
    const shells = 4 + Math.round(intensity * 4);
    for (let i = 0; i < shells; i++) {
      const x =
        this.w * (0.1 + (i / Math.max(1, shells - 1)) * 0.8) +
        (this.rand() - 0.5) * 40;
      const y = this.h * (0.18 + this.rand() * 0.3);
      const color = this.shellColor(i % LANE_COUNT);
      const delay = i * 0.06;
      // Staggered by launching from just below the burst point.
      this.particles.launch(x, this.hitY + delay * 240, y, color, (bx, by) => {
        this.particles.burst({
          x: bx,
          y: by,
          color,
          shape: this.shapeFor(intensity, this.score.combo),
          size: 90 + intensity * 80,
          count: 150 + Math.round(intensity * 120),
          life: 1.5,
          sparkle: 0.5,
        });
      });
    }
  }

  private ambientTick(dt: number) {
    this.ambientTimer -= dt;
    if (this.ambientTimer > 0) return;
    this.ambientTimer = 0.7 + this.rand() * 1.6;
    const lane = Math.floor(this.rand() * LANE_COUNT);
    const color = this.shellColor(lane);
    const x = this.scene.ambientLaunchX(this.rand());
    const y = this.h * (0.16 + this.rand() * 0.32);
    this.particles.launch(x, this.h * 0.9, y, color, (bx, by) => {
      this.particles.burst({
        x: bx,
        y: by,
        color,
        shape: this.shapeFor(0.5, 0),
        size: 60 + this.rand() * 50,
        count: 90 + Math.round(this.rand() * 70),
        life: 1.4,
        sparkle: 0.45,
      });
    });
  }

  /* -------------------------------------------------------------- */
  /* Loop                                                           */
  /* -------------------------------------------------------------- */

  private loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop);
    // Frame delta is only used for animation smoothing — never for game timing.
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.drift += dt;

    this.fpsAccum += dt;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.5) {
      this.fps = this.fpsFrames / this.fpsAccum;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }

    if (this.audio.isRunning && !this.audio.isPaused)
      this.bands = this.audio.sampleBands();

    if (this.mode === "menu") this.ambientTick(dt);
    if (this.mode === "ambient") this.ambientPlayTick();
    if (this.mode === "play") this.playTick();

    for (const l of this.lanes) l.flash = Math.max(0, l.flash - dt * 3.2);
    for (let i = this.popups.length - 1; i >= 0; i--) {
      this.popups[i].life -= dt;
      this.popups[i].y -= dt * 26;
      if (this.popups[i].life <= 0) this.popups.splice(i, 1);
    }
    this.shake = Math.max(0, this.shake - dt * 2.6);
    this.flash = Math.max(0, this.flash - dt * 2.4);

    this.particles.update(dt);
    this.draw(dt);
  };

  /** Ambient mode: no input, notes auto-fire so the show plays itself. */
  private ambientPlayTick() {
    if (!this.chart) return;
    const now = this.songTime;
    const notes = this.chart.notes;
    while (this.cursor < notes.length && notes[this.cursor].time <= now) {
      const n = notes[this.cursor];
      if (!this.hit[this.cursor]) {
        this.hit[this.cursor] = 1;
        this.launchFor(n.lane, "perfect", this.currentSection().intensity);
      }
      this.cursor++;
    }
    if (now > this.chart.duration + 3 && !this.finished) {
      this.finished = true;
      this.cb.onFinish(this.score, false);
    }
  }

  private playTick() {
    if (!this.chart) return;
    const now = this.songTime;
    const notes = this.chart.notes;

    // Retire notes that fell out of the window.
    while (
      this.cursor < notes.length &&
      now - notes[this.cursor].time > WINDOW_MISS
    ) {
      if (!this.hit[this.cursor]) {
        this.hit[this.cursor] = 1;
        this.registerMiss(this.cursor);
      }
      this.cursor++;
    }

    if (!this.finished && now > this.chart.duration + 2.5) {
      this.finished = true;
      this.cb.onFinish(this.score, false);
    }
  }

  /* -------------------------------------------------------------- */
  /* Rendering                                                      */
  /* -------------------------------------------------------------- */

  private draw(dt: number) {
    const ctx = this.ctx;
    const section = this.currentSection();

    ctx.save();
    if (this.shake > 0.01) {
      const s = this.shake * 9;
      ctx.translate((this.rand() - 0.5) * s, (this.rand() - 0.5) * s);
    }

    this.scene.drawBack(
      ctx,
      section.kind,
      section.intensity,
      this.drift,
      this.flash,
    );

    // Particles render above the skyline, then get mirrored into the water.
    this.particles.render(ctx, this.drift);
    this.scene.drawWater(ctx, this.canvas, this.drift, this.dpr);

    if (this.mode === "play") this.drawLanes(ctx, section, dt);
    else this.drawIdleLanes(ctx, section);

    this.drawPopups(ctx);

    if (this.flash > 0.01) {
      // Radial pulse, kept subtle so it stays special.
      ctx.globalCompositeOperation = "lighter";
      const g = ctx.createRadialGradient(
        this.w / 2,
        this.h * 0.42,
        0,
        this.w / 2,
        this.h * 0.42,
        this.w * 0.7,
      );
      const c = laneColor(section.kind, 2, LANE_COUNT);
      g.addColorStop(0, css(c, 0.1 * this.flash));
      g.addColorStop(1, css(c, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, this.w, this.h);
      ctx.globalCompositeOperation = "source-over";
    }

    // Vignette keeps the eye on the sky.
    const vig = ctx.createRadialGradient(
      this.w / 2,
      this.h * 0.45,
      this.h * 0.3,
      this.w / 2,
      this.h * 0.5,
      this.h * 0.95,
    );
    vig.addColorStop(0, "rgba(0,0,0,0)");
    vig.addColorStop(1, "rgba(0,0,0,0.55)");
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, this.w, this.h);

    ctx.restore();
  }

  private drawLanes(
    ctx: CanvasRenderingContext2D,
    section: Section,
    _dt: number,
  ) {
    if (!this.chart) return;
    const now = this.songTime;
    const hitY = this.hitY;
    const laneW = this.laneW;
    const topY = this.h * 0.12;

    // Lane guides — faint columns from the top of the play area to the pads.
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const x = this.laneX(lane);
      const c = laneColor(section.kind, lane, LANE_COUNT);
      const g = ctx.createLinearGradient(0, topY, 0, hitY);
      g.addColorStop(0, css(c, 0));
      g.addColorStop(1, css(c, 0.07 + this.lanes[lane].flash * 0.2));
      ctx.fillStyle = g;
      ctx.fillRect(x - laneW * 0.42, topY, laneW * 0.84, hitY - topY);
    }

    // Hit line.
    ctx.globalCompositeOperation = "lighter";
    const left = this.laneX(0) - laneW * 0.5;
    const right = this.laneX(LANE_COUNT - 1) + laneW * 0.5;
    ctx.fillStyle = "rgba(190,215,255,0.28)";
    ctx.fillRect(left, hitY - 1, right - left, 2);
    ctx.globalCompositeOperation = "source-over";

    // Notes: only those inside the approach window are considered.
    const notes = this.chart.notes;
    for (let i = this.cursor; i < notes.length; i++) {
      const n = notes[i];
      const dtToHit = n.time - now;
      if (dtToHit > APPROACH) break;
      if (this.hit[i]) continue;
      const progress = 1 - dtToHit / APPROACH;
      const y = topY + (hitY - topY) * progress;
      this.drawNote(ctx, n, y, section, progress);
    }

    this.drawPads(ctx, section);
  }

  private drawNote(
    ctx: CanvasRenderingContext2D,
    n: Note,
    y: number,
    section: Section,
    progress: number,
  ) {
    const x = this.laneX(n.lane);
    const c = laneColor(section.kind, n.lane, LANE_COUNT);
    const w = this.laneW * 0.62;
    const h = 13;
    // Fade in over the first 15% of travel so notes don't pop into existence.
    const alpha = Math.min(1, progress / 0.15);

    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = css(c, 0.22 * alpha);
    ctx.fillRect(x - w * 0.62, y - h * 0.9, w * 1.24, h * 1.8);
    ctx.globalCompositeOperation = "source-over";

    ctx.fillStyle = css(c, 0.95 * alpha);
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - h / 2, w, h, 5);
    ctx.fill();

    ctx.fillStyle = `rgba(255,255,255,${0.55 * alpha})`;
    ctx.beginPath();
    ctx.roundRect(x - w / 2 + 3, y - h / 2 + 2, w - 6, 3, 2);
    ctx.fill();
  }

  private drawPads(ctx: CanvasRenderingContext2D, section: Section) {
    const y = this.hitY;
    const laneW = this.laneW;
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const x = this.laneX(lane);
      const c = laneColor(section.kind, lane, LANE_COUNT);
      const f = this.lanes[lane].flash;
      const w = laneW * 0.72;
      const h = 30;

      ctx.globalCompositeOperation = "lighter";
      const glow = ctx.createRadialGradient(x, y, 0, x, y, w);
      glow.addColorStop(0, css(c, 0.12 + f * 0.5));
      glow.addColorStop(1, css(c, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(x - w, y - w, w * 2, w * 2);
      ctx.globalCompositeOperation = "source-over";

      ctx.strokeStyle = css(c, 0.55 + f * 0.45);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(x - w / 2, y - h / 2, w, h, 8);
      ctx.stroke();

      if (this.lanes[lane].held || f > 0.05) {
        ctx.fillStyle = css(c, 0.14 + f * 0.32);
        ctx.beginPath();
        ctx.roundRect(x - w / 2, y - h / 2, w, h, 8);
        ctx.fill();
      }

      ctx.fillStyle = `rgba(235,245,255,${0.5 + f * 0.5})`;
      ctx.font = "600 13px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(LANE_LABELS[lane], x, y + 1);
    }
  }

  private drawIdleLanes(ctx: CanvasRenderingContext2D, section: Section) {
    // Menu/ambient: pads are visible but dimmed, so the sky owns the frame.
    ctx.save();
    ctx.globalAlpha = 0.35;
    this.drawPads(ctx, section);
    ctx.restore();
  }

  private drawPopups(ctx: CanvasRenderingContext2D) {
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const p of this.popups) {
      const a = Math.min(1, p.life / 0.35);
      ctx.font = "700 13px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.fillStyle = css(p.color, a * 0.9);
      ctx.fillText(p.text, p.x, p.y);
    }
  }

  /* -------------------------------------------------------------- */

  hasFailed(): boolean {
    return this.failed;
  }

  getHealth(): number {
    return this.health;
  }

  getFps(): number {
    return this.fps;
  }

  getParticleCount(): number {
    return this.particles.count;
  }

  getSongTime(): number {
    return this.audio.time;
  }

  getSection(): Section {
    return this.currentSection();
  }

  getBands(): Bands {
    return this.bands;
  }
}
