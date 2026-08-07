/**
 * Hand-rolled Canvas2D particle engine. Everything is kept in flat typed arrays
 * with a free-list so the hot loop never allocates and never triggers GC pauses
 * mid-show.
 */

const MAX_PARTICLES = 6000;
const GRAVITY = 46;
const DRAG = 0.86;

export type BurstShape =
  | "peony"
  | "chrysanthemum"
  | "willow"
  | "palm"
  | "ring"
  | "crossette";

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface BurstOptions {
  x: number;
  y: number;
  color: Rgb;
  /** Secondary color; particles lerp toward it as they age. */
  fade?: Rgb;
  shape: BurstShape;
  /** Roughly the visual radius in pixels. */
  size: number;
  count: number;
  /** Seconds. */
  life: number;
  /** 0..1 — how much sparkle/flicker to apply. */
  sparkle?: number;
}

interface Rocket {
  x: number;
  y: number;
  vx: number;
  vy: number;
  targetY: number;
  color: Rgb;
  trail: number;
  alive: boolean;
  onBurst: (x: number, y: number) => void;
}

export class ParticleSystem {
  private px = new Float32Array(MAX_PARTICLES);
  private py = new Float32Array(MAX_PARTICLES);
  private pvx = new Float32Array(MAX_PARTICLES);
  private pvy = new Float32Array(MAX_PARTICLES);
  private life = new Float32Array(MAX_PARTICLES);
  private maxLife = new Float32Array(MAX_PARTICLES);
  private size = new Float32Array(MAX_PARTICLES);
  private cr = new Float32Array(MAX_PARTICLES);
  private cg = new Float32Array(MAX_PARTICLES);
  private cb = new Float32Array(MAX_PARTICLES);
  private fr = new Float32Array(MAX_PARTICLES);
  private fg = new Float32Array(MAX_PARTICLES);
  private fb = new Float32Array(MAX_PARTICLES);
  private drag = new Float32Array(MAX_PARTICLES);
  private grav = new Float32Array(MAX_PARTICLES);
  private sparkle = new Float32Array(MAX_PARTICLES);
  private active = new Uint8Array(MAX_PARTICLES);
  private free: number[] = [];
  private liveCount = 0;

  private rockets: Rocket[] = [];
  /** Deterministic-ish PRNG; cheaper than Math.random and avoids bias clumps. */
  private seed = 0x9e3779b9;

  constructor() {
    for (let i = MAX_PARTICLES - 1; i >= 0; i--) this.free.push(i);
  }

  private rand(): number {
    this.seed ^= this.seed << 13;
    this.seed ^= this.seed >>> 17;
    this.seed ^= this.seed << 5;
    this.seed >>>= 0;
    return this.seed / 0xffffffff;
  }

  get count(): number {
    return this.liveCount;
  }

  clear() {
    this.active.fill(0);
    this.free.length = 0;
    for (let i = MAX_PARTICLES - 1; i >= 0; i--) this.free.push(i);
    this.liveCount = 0;
    this.rockets.length = 0;
  }

  private spawn(
    x: number,
    y: number,
    vx: number,
    vy: number,
    life: number,
    size: number,
    color: Rgb,
    fade: Rgb,
    drag: number,
    grav: number,
    sparkle: number,
  ) {
    const i = this.free.pop();
    if (i === undefined) return;
    this.px[i] = x;
    this.py[i] = y;
    this.pvx[i] = vx;
    this.pvy[i] = vy;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
    this.cr[i] = color.r;
    this.cg[i] = color.g;
    this.cb[i] = color.b;
    this.fr[i] = fade.r;
    this.fg[i] = fade.g;
    this.fb[i] = fade.b;
    this.drag[i] = drag;
    this.grav[i] = grav;
    this.sparkle[i] = sparkle;
    this.active[i] = 1;
    this.liveCount++;
  }

  /** Launches a rocket that climbs, trails, then fires `onBurst` at apex. */
  launch(
    x: number,
    groundY: number,
    targetY: number,
    color: Rgb,
    onBurst: (x: number, y: number) => void,
  ) {
    const dy = groundY - targetY;
    // v chosen so the rocket decelerates to roughly zero at the target height.
    const vy = -Math.sqrt(2 * GRAVITY * 0.55 * dy);
    this.rockets.push({
      x,
      y: groundY,
      vx: (this.rand() - 0.5) * 22,
      vy,
      targetY,
      color,
      trail: 0,
      alive: true,
      onBurst,
    });
  }

  burst(o: BurstOptions) {
    const fade = o.fade ?? {
      r: o.color.r * 0.35,
      g: o.color.g * 0.25,
      b: o.color.b * 0.6,
    };
    const sparkle = o.sparkle ?? 0.4;
    const n = Math.min(o.count, this.free.length);

    switch (o.shape) {
      case "ring": {
        // Flat expanding ring, slight thickness.
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          const speed = o.size * (0.95 + this.rand() * 0.1);
          this.spawn(
            o.x,
            o.y,
            Math.cos(a) * speed,
            Math.sin(a) * speed * 0.6,
            o.life,
            1.9,
            o.color,
            fade,
            DRAG,
            0.6,
            sparkle,
          );
        }
        break;
      }
      case "willow": {
        // Slow, heavy, long-hanging embers.
        for (let i = 0; i < n; i++) {
          const a = this.rand() * Math.PI * 2;
          const speed = o.size * (0.3 + this.rand() * 0.5);
          this.spawn(
            o.x,
            o.y,
            Math.cos(a) * speed,
            Math.sin(a) * speed - o.size * 0.15,
            o.life * 1.7,
            2.2,
            o.color,
            fade,
            0.9,
            1.5,
            sparkle * 1.4,
          );
        }
        break;
      }
      case "palm": {
        // Few thick fronds arcing outward.
        const fronds = 7;
        const per = Math.max(2, Math.floor(n / fronds));
        for (let f = 0; f < fronds; f++) {
          const base = (f / fronds) * Math.PI * 2 + this.rand() * 0.2;
          for (let i = 0; i < per; i++) {
            const a = base + (this.rand() - 0.5) * 0.16;
            const speed = o.size * (0.5 + (i / per) * 0.7);
            this.spawn(
              o.x,
              o.y,
              Math.cos(a) * speed,
              Math.sin(a) * speed,
              o.life * 1.3,
              2.6,
              o.color,
              fade,
              0.9,
              1.2,
              sparkle,
            );
          }
        }
        break;
      }
      case "crossette": {
        // Four-armed cross that reads clearly even when small.
        for (let i = 0; i < n; i++) {
          const arm = i % 4;
          const a = (arm / 4) * Math.PI * 2 + (this.rand() - 0.5) * 0.35;
          const speed = o.size * (0.4 + this.rand() * 0.8);
          this.spawn(
            o.x,
            o.y,
            Math.cos(a) * speed,
            Math.sin(a) * speed,
            o.life,
            2,
            o.color,
            fade,
            DRAG,
            0.9,
            sparkle,
          );
        }
        break;
      }
      case "chrysanthemum": {
        // Dense sphere with a bright hot core.
        for (let i = 0; i < n; i++) {
          const a = this.rand() * Math.PI * 2;
          const r = Math.sqrt(this.rand());
          const speed = o.size * (0.25 + r * 0.85);
          this.spawn(
            o.x,
            o.y,
            Math.cos(a) * speed,
            Math.sin(a) * speed,
            o.life * (0.7 + r * 0.5),
            2.1,
            o.color,
            fade,
            DRAG,
            1,
            sparkle,
          );
        }
        break;
      }
      default: {
        // peony — even spherical shell, the classic.
        for (let i = 0; i < n; i++) {
          const a = this.rand() * Math.PI * 2;
          const speed = o.size * (0.75 + this.rand() * 0.35);
          this.spawn(
            o.x,
            o.y,
            Math.cos(a) * speed,
            Math.sin(a) * speed,
            o.life,
            2,
            o.color,
            fade,
            DRAG,
            1,
            sparkle,
          );
        }
      }
    }
  }

  /** Small directional spray, used for launch pads and miss puffs. */
  spray(
    x: number,
    y: number,
    count: number,
    color: Rgb,
    speed: number,
    spread: number,
    life: number,
  ) {
    const n = Math.min(count, this.free.length);
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (this.rand() - 0.5) * spread;
      const s = speed * (0.4 + this.rand() * 0.8);
      this.spawn(
        x,
        y,
        Math.cos(a) * s,
        Math.sin(a) * s,
        life,
        1.6,
        color,
        { r: color.r * 0.3, g: color.g * 0.2, b: color.b * 0.5 },
        0.9,
        1.1,
        0.5,
      );
    }
  }

  update(dt: number) {
    // Rockets first so a burst spawned this frame still gets rendered.
    for (let r = this.rockets.length - 1; r >= 0; r--) {
      const rk = this.rockets[r];
      rk.vy += GRAVITY * 0.55 * dt;
      rk.x += rk.vx * dt;
      rk.y += rk.vy * dt;
      rk.trail += dt;
      if (rk.trail > 0.012) {
        rk.trail = 0;
        this.spawn(
          rk.x + (this.rand() - 0.5) * 2,
          rk.y,
          (this.rand() - 0.5) * 8,
          10 + this.rand() * 14,
          0.34,
          1.5,
          rk.color,
          { r: 255, g: 140, b: 40 },
          0.88,
          0.4,
          0.8,
        );
      }
      if (rk.vy >= -6 || rk.y <= rk.targetY) {
        rk.onBurst(rk.x, rk.y);
        this.rockets.splice(r, 1);
      }
    }

    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.active[i] === 0) continue;
      const l = this.life[i] - dt;
      if (l <= 0) {
        this.active[i] = 0;
        this.free.push(i);
        this.liveCount--;
        continue;
      }
      this.life[i] = l;
      const d = this.drag[i] ** (dt * 60);
      this.pvx[i] *= d;
      this.pvy[i] *= d;
      this.pvy[i] += GRAVITY * this.grav[i] * dt;
      this.px[i] += this.pvx[i] * dt;
      this.py[i] += this.pvy[i] * dt;
    }
  }

  /**
   * Draws with additive blending. Caller is responsible for the fade-to-black
   * pass that produces trail persistence.
   */
  render(ctx: CanvasRenderingContext2D, time: number) {
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.active[i] === 0) continue;
      const t = this.life[i] / this.maxLife[i];
      // Ease-out alpha so embers linger instead of popping out.
      let alpha = t * t;
      if (this.sparkle[i] > 0) {
        // Flicker frequency varies per particle via its position hash.
        const f = Math.sin(time * 40 + i * 1.7) * 0.5 + 0.5;
        alpha *= 1 - this.sparkle[i] * 0.55 * f;
      }
      if (alpha <= 0.01) continue;
      const k = 1 - t;
      const r = (this.cr[i] * t + this.fr[i] * k) | 0;
      const g = (this.cg[i] * t + this.fg[i] * k) | 0;
      const b = (this.cb[i] * t + this.fb[i] * k) | 0;
      const s = this.size[i] * (0.5 + t * 0.8);
      ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
      ctx.fillRect(this.px[i] - s * 0.5, this.py[i] - s * 0.5, s, s);
    }

    // Rocket heads: brighter than their trail so the climb reads clearly.
    for (const rk of this.rockets) {
      ctx.fillStyle = `rgba(255,225,170,0.95)`;
      ctx.fillRect(rk.x - 1.5, rk.y - 2.5, 3, 5);
    }
    ctx.globalCompositeOperation = "source-over";
  }
}
