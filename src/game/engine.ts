import type { AudioEngine, AudioSource } from "./audio";
import { Camera } from "./camera";
import { applySkin, type Bands, css, hitColor, laneColor } from "./palette";
import { type BurstShape, ParticleSystem, type Rgb } from "./particles";
import {
  type Chart,
  COMBO_GRACE,
  emptyScore,
  type HitResult,
  type Judgement,
  LANE_COUNT,
  LANE_LABELS,
  type Note,
  type ScoreState,
  type Section,
  sectionAt,
  WINDOW_GREAT,
  WINDOW_MISS,
  WINDOW_PERFECT,
} from "./types";
import { World } from "./world";

/**
 * Seconds a rocket is visible before it reaches the beam. This is the climb
 * time, not a scroll time — the note *is* the rocket.
 */
const APPROACH = 1.7;
/** Score awarded at combo multiplier 1. */
const BASE_SCORE = { perfect: 300, great: 220, good: 150, miss: 0 } as const;

interface LaneState {
  /** Seconds remaining on the lane's "fired" glow along the beam. */
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

/** A burst flare sitting on the beam, fading out. */
interface BeamFlare {
  x: number;
  life: number;
  maxLife: number;
  color: Rgb;
  strength: number;
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
  private camera = new Camera();
  private world = new World();

  private chart: Chart | null = null;
  /** Index of the earliest note not yet hit or missed. */
  private cursor = 0;
  private hit: Uint8Array = new Uint8Array(0);

  private score: ScoreState = emptyScore();
  private lanes: LaneState[] = [];
  private popups: Popup[] = [];
  private flares: BeamFlare[] = [];

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
  private w = 0;
  private h = 0;
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
  /** Misses still tolerated before the combo breaks. Refilled by every hit. */
  private graceLeft = COMBO_GRACE;
  /** True once hard mode's health ran out. Read by `hasFailed`. */
  private failed = false;
  /** Section kind the world was last told about, to detect changes. */
  private lastSectionKind: Section["kind"] | null = null;

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
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.camera.resize(w, h);
    this.world.resize(w, h);
  }

  /**
   * Screen Y of the beam — the hit line. Fixed high in the frame; rockets rise
   * from the bottom edge to meet it.
   */
  private get beamY(): number {
    return this.h * 0.26;
  }

  /** Where a lane's rockets launch from and burst, horizontally. */
  private laneX(lane: number): number {
    const usable = Math.min(this.w * 0.78, 760);
    const left = (this.w - usable) / 2;
    return left + (usable / LANE_COUNT) * (lane + 0.5);
  }

  private get laneW(): number {
    return Math.min(this.w * 0.78, 760) / LANE_COUNT;
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
    this.flares.length = 0;
    this.particles.clear();
    this.finished = false;
    this.failed = false;
    this.health = 1;
    this.graceLeft = COMBO_GRACE;
    this.mode = mode;
    this.lastSectionKind = null;
    this.cb.onScore(this.score);
    this.cb.onHealth?.(this.health);
    await this.audio.start(src);
  }

  stop() {
    this.audio.stop();
    this.mode = "menu";
    this.chart = null;
    this.particles.clear();
    this.flares.length = 0;
  }

  /* -------------------------------------------------------------- */
  /* Input                                                          */
  /* -------------------------------------------------------------- */

  pressLane(lane: number) {
    if (lane < 0 || lane >= LANE_COUNT) return;
    const state = this.lanes[lane];
    state.held = true;
    state.flash = 0.3;

    if (this.mode !== "play" || !this.chart) {
      // Menus and ambient mode still fire a rocket — the sky is never idle.
      this.launchNow(lane, 0.6);
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

    if (best < 0) {
      // Stray press: a small puff at the beam, no penalty.
      const c = laneColor(this.currentSection().kind, lane, LANE_COUNT);
      this.particles.spray(this.laneX(lane), this.beamY, 8, c, 60, 1.6, 0.3);
      return;
    }

    this.hit[best] = 1;
    const delta = now - notes[best].time;
    const abs = Math.abs(delta);
    const judgement: Judgement =
      abs <= WINDOW_PERFECT
        ? "perfect"
        : abs <= WINDOW_GREAT
          ? "great"
          : "good";
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

  /** Multiplier tiers ramp early so the score climbs fast and feels good. */
  private comboMultiplier(): number {
    const c = this.score.combo;
    if (c >= 60) return 8;
    if (c >= 35) return 6;
    if (c >= 18) return 4;
    if (c >= 8) return 2;
    return 1;
  }

  private registerHit(index: number, judgement: Judgement, delta: number) {
    const note = this.chart?.notes[index];
    if (!note) return;
    const section = this.currentSection();

    if (judgement === "perfect") this.score.perfect++;
    else if (judgement === "great") this.score.great++;
    else this.score.good++;
    // A clean hit restores the grace pool, so grace is a buffer against the
    // occasional slip rather than a budget that runs out over a long song.
    this.graceLeft = COMBO_GRACE;
    this.score.combo++;
    this.score.maxCombo = Math.max(this.score.maxCombo, this.score.combo);
    this.score.score += BASE_SCORE[judgement] * this.comboMultiplier();
    this.lanes[note.lane].lastJudgement = judgement;

    // The rocket is already in flight; this bursts it at the beam.
    this.burstAtBeam(note.lane, judgement, section.intensity);
    this.pushPopup(judgement, note.lane);

    // Bank the camera away from the lane that just fired.
    const dir = note.lane < LANE_COUNT / 2 ? -1 : 1;
    this.camera.impulse(judgement === "perfect" ? 0.5 : 0.3, dir);

    // Big-moment juice, deliberately rare.
    if (this.score.combo > 0 && this.score.combo % 25 === 0) {
      this.shake = Math.min(1, 0.5 + section.intensity * 0.5);
      this.flash = 1;
      this.camera.impulse(1.4, dir);
      this.finale(section.intensity);
    }

    if (this.options.hardMode) {
      this.health = Math.min(
        1,
        this.health + (judgement === "perfect" ? 0.05 : 0.035),
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
    // Combo grace: the first couple of misses after a clean hit only dent the
    // streak instead of resetting it, so one slip never kills the escalation.
    if (this.graceLeft > 0 && this.score.combo > 0) {
      this.graceLeft--;
      this.score.combo = Math.max(0, this.score.combo - 4);
    } else {
      this.score.combo = 0;
    }
    this.lanes[note.lane].lastJudgement = "miss";
    // A miss still produces something: the rocket fizzles out at the beam
    // instead of blooming.
    const c = laneColor(this.currentSection().kind, note.lane, LANE_COUNT);
    const dim: Rgb = { r: c.r * 0.35, g: c.g * 0.35, b: c.b * 0.4 };
    this.particles.spray(
      this.laneX(note.lane),
      this.beamY,
      12,
      dim,
      40,
      2.2,
      0.55,
    );
    this.pushPopup("miss", note.lane);

    if (this.options.hardMode) {
      this.health = Math.max(0, this.health - 0.035);
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
      great: { r: 190, g: 240, b: 200 },
      good: { r: 150, g: 220, b: 255 },
      miss: { r: 130, g: 130, b: 150 },
    };
    const labels: Record<Judgement, string> = {
      perfect: "PERFECT",
      great: "GREAT",
      good: "GOOD",
      miss: "MISS",
    };
    this.popups.push({
      text: labels[judgement],
      x: this.laneX(lane),
      // Judgement text reads below the beam, out of the burst.
      y: this.beamY + 46,
      life: 0.7,
      color: colors[judgement],
    });
    if (this.popups.length > 24) this.popups.shift();
  }

  /* -------------------------------------------------------------- */
  /* Fireworks                                                      */
  /* -------------------------------------------------------------- */

  /**
   * Shape pools by power tier. Higher tiers unlock the more elaborate shells,
   * so the vocabulary itself visibly grows with combo and song intensity.
   */
  private static readonly SHAPE_TIERS: BurstShape[][] = [
    // Calm: clean, readable classics.
    ["peony", "crossette", "ring", "star"],
    // Mid: adds motion and structure.
    ["peony", "palm", "crossette", "ring", "star", "spiral", "comet-shell"],
    // Loud: the full vocabulary.
    [
      "chrysanthemum",
      "palm",
      "willow",
      "double-ring",
      "spiral",
      "star",
      "comet-shell",
      "horsetail",
      "strobe",
      "ring",
    ],
  ];

  /** Picks a shape from combo + intensity so the show visibly escalates. */
  private shapeFor(intensity: number, combo: number): BurstShape {
    const power = intensity * 0.6 + Math.min(1, combo / 80) * 0.4;
    const tier = power > 0.7 ? 2 : power > 0.35 ? 1 : 0;
    const pool = GameEngine.SHAPE_TIERS[tier];
    return pool[Math.floor(this.rand() * pool.length)];
  }

  /** Section + band color for a shell, with the active skin applied on top. */
  private shellColor(lane: number): Rgb {
    const section = this.currentSection();
    const base = hitColor(section.kind, this.bands, lane, LANE_COUNT);
    return applySkin(this.options.skin, base, this.rand());
  }

  /**
   * Bursts at the beam. Called when a note is hit — the rocket that produced it
   * is the one drawn by `drawRockets`, so nothing needs to be launched here.
   */
  private burstAtBeam(lane: number, judgement: Judgement, intensity: number) {
    const color = this.shellColor(lane);
    const combo = this.score.combo;
    const quality = judgement === "perfect" ? 1 : 0.62;

    const x = this.laneX(lane) + (this.rand() - 0.5) * this.laneW * 0.35;
    const y = this.beamY;

    const shape = this.shapeFor(intensity, combo);
    // Real aerial shells throw hundreds of stars across a radius far wider than
    // the shell itself. Both numbers are deliberately large; the low per-particle
    // alpha is what keeps a burst this dense from clipping to white.
    const sizeBase = 190 + intensity * 170 + Math.min(190, combo * 1.9);
    const size = sizeBase * quality;
    const count = Math.round(
      (700 + intensity * 800 + Math.min(1100, combo * 11)) * quality,
    );

    this.particles.burst({
      x,
      y,
      color,
      shape,
      size,
      count,
      // Long life so the fall-and-fade is visible, not just the flash.
      life: 2.4 + intensity * 1.4,
      sparkle: 0.3 + this.bands.high * 0.5,
    });

    // Layered shells: each combo threshold adds another concentric burst in a
    // contrasting color and shape, so big streaks read as compound shells.
    const layers = combo >= 60 ? 3 : combo >= 30 ? 2 : combo >= 12 ? 1 : 0;
    for (let layer = 1; layer <= layers; layer++) {
      const scale = 1 - layer * 0.26;
      this.particles.burst({
        x,
        y,
        color: this.shellColor((lane + layer * 2) % LANE_COUNT),
        shape: this.shapeFor(intensity, combo),
        size: size * scale,
        count: Math.round(count * scale * 0.55),
        life: (1.2 + intensity * 0.6) * scale,
        sparkle: 0.5 + layer * 0.15,
      });
    }

    this.flares.push({
      x,
      life: 0.45,
      maxLife: 0.45,
      color,
      strength: quality * (0.6 + intensity * 0.4),
    });
    if (this.flares.length > 24) this.flares.shift();

    this.flash = Math.max(this.flash, 0.35 * quality * (0.5 + intensity * 0.5));
    this.lanes[lane].flash = 0.34;
  }

  /**
   * Fires a rocket right now and bursts it on arrival. Used outside of charted
   * play — menus, ambient mode, and stray presses that deserve a reward.
   */
  private launchNow(lane: number, intensity: number) {
    const color = this.shellColor(lane);
    const x = this.laneX(lane) + (this.rand() - 0.5) * this.laneW * 0.4;
    this.particles.launch(x, this.h + 10, this.beamY, color, (bx, by) => {
      this.particles.burst({
        x: bx,
        y: by,
        color,
        shape: this.shapeFor(intensity, 0),
        size: 200 + intensity * 150,
        count: 800 + Math.round(intensity * 600),
        life: 2.6,
        sparkle: 0.45,
      });
      this.flares.push({
        x: bx,
        life: 0.4,
        maxLife: 0.4,
        color,
        strength: 0.5,
      });
      this.flash = Math.max(this.flash, 0.2);
    });
  }

  /** Screen-wide multi-burst for combo milestones and song climaxes. */
  private finale(intensity: number) {
    const shells = 7 + Math.round(intensity * 6);
    for (let i = 0; i < shells; i++) {
      const x =
        this.w * (0.06 + (i / Math.max(1, shells - 1)) * 0.88) +
        (this.rand() - 0.5) * 60;
      // Spread the finale across the sky above and around the beam.
      const y = this.beamY + (this.rand() - 0.7) * this.h * 0.34;
      const color = this.shellColor(i % LANE_COUNT);
      this.particles.burst({
        x,
        y,
        color,
        shape: this.shapeFor(intensity, this.score.combo),
        size: 250 + intensity * 190,
        count: 1100 + Math.round(intensity * 900),
        life: 3,
        sparkle: 0.5,
      });
    }
  }

  private ambientTick(dt: number) {
    this.ambientTimer -= dt;
    if (this.ambientTimer > 0) return;
    this.ambientTimer = 0.7 + this.rand() * 1.5;
    this.launchNow(Math.floor(this.rand() * LANE_COUNT), 0.55);
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

    const section = this.currentSection();
    // Hand the world its biome when the section changes; it lays that terrain
    // down far ahead, so the change arrives as a fly-through.
    if (section.kind !== this.lastSectionKind) {
      this.lastSectionKind = section.kind;
      this.world.setBiomeForSection(section.kind);
    }

    const energy = this.bands.bass * 0.6 + this.bands.mid * 0.4;
    this.camera.update(dt, section, energy);
    this.world.update(this.camera);

    if (this.mode === "menu") this.ambientTick(dt);
    if (this.mode === "ambient") this.ambientPlayTick();
    if (this.mode === "play") this.playTick();

    for (const l of this.lanes) l.flash = Math.max(0, l.flash - dt * 3.2);
    for (let i = this.popups.length - 1; i >= 0; i--) {
      this.popups[i].life -= dt;
      this.popups[i].y += dt * 18;
      if (this.popups[i].life <= 0) this.popups.splice(i, 1);
    }
    for (let i = this.flares.length - 1; i >= 0; i--) {
      this.flares[i].life -= dt;
      if (this.flares[i].life <= 0) this.flares.splice(i, 1);
    }
    this.shake = Math.max(0, this.shake - dt * 2.6);
    this.flash = Math.max(0, this.flash - dt * 2.4);

    this.particles.update(dt);
    this.draw();
  };

  /** Ambient mode: no input, notes auto-fire so the show plays itself. */
  private ambientPlayTick() {
    if (!this.chart) return;
    const now = this.songTime;
    const notes = this.chart.notes;
    while (this.cursor < notes.length && notes[this.cursor].time <= now) {
      if (!this.hit[this.cursor]) {
        this.hit[this.cursor] = 1;
        const n = notes[this.cursor];
        this.burstAtBeam(n.lane, "perfect", this.currentSection().intensity);
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

    // Retire notes that climbed past the beam without being hit.
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

  private draw() {
    const ctx = this.ctx;
    const section = this.currentSection();

    ctx.save();
    if (this.shake > 0.01) {
      const s = this.shake * 9;
      ctx.translate((this.rand() - 0.5) * s, (this.rand() - 0.5) * s);
    }

    // The world rolls with the camera; the beam and HUD stay level, which keeps
    // the note track readable no matter how hard the camera banks.
    ctx.save();
    this.camera.applyRoll(ctx);
    this.world.render(
      ctx,
      this.camera,
      section.kind,
      section.intensity,
      this.drift,
    );
    ctx.restore();

    this.particles.render(ctx, this.drift);

    if (this.mode === "play" || this.mode === "ambient") {
      this.drawRockets(ctx, section);
    }
    this.drawBeam(ctx, section);
    this.drawPopups(ctx);

    if (this.flash > 0.01) {
      // Radial pulse centred on the beam, kept subtle so it stays special.
      ctx.globalCompositeOperation = "lighter";
      const g = ctx.createRadialGradient(
        this.w / 2,
        this.beamY,
        0,
        this.w / 2,
        this.beamY,
        this.w * 0.7,
      );
      const c = laneColor(section.kind, 2, LANE_COUNT);
      g.addColorStop(0, css(c, 0.1 * this.flash));
      g.addColorStop(1, css(c, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, this.w, this.h);
      ctx.globalCompositeOperation = "source-over";
    }

    const vig = ctx.createRadialGradient(
      this.w / 2,
      this.h * 0.4,
      this.h * 0.32,
      this.w / 2,
      this.h * 0.5,
      this.h,
    );
    vig.addColorStop(0, "rgba(0,0,0,0)");
    vig.addColorStop(1, "rgba(0,0,0,0.4)");
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, this.w, this.h);

    ctx.restore();
  }

  /**
   * The hit line: a neon beam running the full width of the frame, with a bloom
   * at each recent burst point.
   */
  private drawBeam(ctx: CanvasRenderingContext2D, section: Section) {
    const y = this.beamY;
    const c = laneColor(section.kind, 2, LANE_COUNT);
    const pulse = 0.55 + this.bands.mid * 0.45;

    ctx.globalCompositeOperation = "lighter";

    // Wide soft halo.
    const halo = ctx.createLinearGradient(0, y - 26, 0, y + 26);
    halo.addColorStop(0, css(c, 0));
    halo.addColorStop(0.5, css(c, 0.16 * pulse));
    halo.addColorStop(1, css(c, 0));
    ctx.fillStyle = halo;
    ctx.fillRect(0, y - 26, this.w, 52);

    // Core line, brightest at the centre and tapering to the screen edges.
    const core = ctx.createLinearGradient(0, 0, this.w, 0);
    core.addColorStop(0, css(c, 0.25));
    core.addColorStop(0.5, `rgba(255,255,255,${0.75 * pulse})`);
    core.addColorStop(1, css(c, 0.25));
    ctx.fillStyle = core;
    ctx.fillRect(0, y - 1.1, this.w, 2.2);

    // Burst flares sitting on the beam.
    for (const f of this.flares) {
      const t = f.life / f.maxLife;
      const r = (60 + 180 * (1 - t)) * f.strength;
      const g = ctx.createRadialGradient(f.x, y, 0, f.x, y, r);
      g.addColorStop(0, css(f.color, 0.5 * t * f.strength));
      g.addColorStop(0.4, css(f.color, 0.16 * t * f.strength));
      g.addColorStop(1, css(f.color, 0));
      ctx.fillStyle = g;
      ctx.fillRect(f.x - r, y - r, r * 2, r * 2);
    }

    // Lane markers on the beam, lighting up as their lane fires.
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const x = this.laneX(lane);
      const lc = laneColor(section.kind, lane, LANE_COUNT);
      const f = this.lanes[lane].flash;
      const w = this.laneW * 0.5;
      ctx.fillStyle = css(lc, 0.18 + f * 0.6);
      ctx.fillRect(x - w / 2, y - 2.5, w, 5);
    }

    ctx.globalCompositeOperation = "source-over";
  }

  /**
   * Rockets in flight. Each unhit note within the approach window is drawn as a
   * climbing comet with its key letter riding the head — the note and the rocket
   * are the same object.
   */
  private drawRockets(ctx: CanvasRenderingContext2D, section: Section) {
    if (!this.chart) return;
    const now = this.songTime;
    const notes = this.chart.notes;
    const beamY = this.beamY;
    const bottom = this.h + 20;

    ctx.globalCompositeOperation = "lighter";

    for (let i = this.cursor; i < notes.length; i++) {
      const n = notes[i];
      const dtToHit = n.time - now;
      if (dtToHit > APPROACH) break;
      if (this.hit[i]) continue;

      // Clamped: a note still inside the miss window has already passed its hit
      // time, and a negative base under a fractional exponent yields NaN.
      const progress = Math.max(0, Math.min(1, 1 - dtToHit / APPROACH));
      // Ease-out on the climb: rockets decelerate as they near the beam, which
      // makes the moment of arrival much easier to read.
      const eased = 1 - (1 - progress) ** 1.35;
      const y = bottom + (beamY - bottom) * eased;
      this.drawRocket(ctx, n, y, section, progress);
    }

    ctx.globalCompositeOperation = "source-over";
  }

  private drawRocket(
    ctx: CanvasRenderingContext2D,
    n: Note,
    y: number,
    section: Section,
    progress: number,
  ) {
    const x = this.laneX(n.lane);
    const c = laneColor(section.kind, n.lane, LANE_COUNT);
    // Fade in over the first stretch of the climb so rockets don't pop in.
    const alpha = Math.min(1, progress / 0.12);
    const tail = Math.min(this.h * 0.4, 90 + progress * 260);

    // Trail: a long gradient tapering down from the head, wide enough to read
    // as a burning comet rather than a thin line.
    const grad = ctx.createLinearGradient(0, y, 0, y + tail);
    grad.addColorStop(0, css(c, 0.95 * alpha));
    grad.addColorStop(0.18, css(c, 0.5 * alpha));
    grad.addColorStop(0.55, css(c, 0.16 * alpha));
    grad.addColorStop(1, css(c, 0));
    ctx.fillStyle = grad;
    ctx.fillRect(x - 7, y, 14, tail);

    // Head glow — large and bright, the thing the eye tracks.
    const r = 52;
    const glow = ctx.createRadialGradient(x, y, 0, x, y, r);
    glow.addColorStop(0, `rgba(255,255,255,${0.95 * alpha})`);
    glow.addColorStop(0.18, css(c, 0.8 * alpha));
    glow.addColorStop(0.5, css(c, 0.25 * alpha));
    glow.addColorStop(1, css(c, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);

    // White-hot core.
    ctx.fillStyle = `rgba(255,255,255,${0.98 * alpha})`;
    ctx.fillRect(x - 3, y - 8, 6, 16);

    // Key letter rides the head, so the player reads the key not the position.
    ctx.globalCompositeOperation = "source-over";
    ctx.font = "700 12px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = `rgba(0,0,0,${0.75 * alpha})`;
    ctx.fillText(LANE_LABELS[n.lane], x, y - 13);
    ctx.fillStyle = `rgba(255,255,255,${0.95 * alpha})`;
    ctx.fillText(LANE_LABELS[n.lane], x, y - 14);
    ctx.globalCompositeOperation = "lighter";
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

  getBiome(): string {
    return this.world.biome;
  }
}
