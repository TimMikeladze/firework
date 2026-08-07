/**
 * Hand-rolled Canvas2D particle engine. Everything is kept in flat typed arrays
 * with a free-list so the hot loop never allocates and never triggers GC pauses
 * mid-show.
 */

const MAX_PARTICLES = 60000;
const GRAVITY = 46;
const DRAG = 0.86;

/**
 * Global brightness budget for the additive pass. Individual particles are dim;
 * density is what makes a burst read as bright. Without this the `lighter`
 * composite saturates to flat white the moment two shells overlap.
 */
const PARTICLE_ALPHA = 0.42;

export type BurstShape =
  | "peony"
  | "chrysanthemum"
  | "willow"
  | "palm"
  | "ring"
  | "crossette"
  | "double-ring"
  | "spiral"
  | "star"
  | "strobe"
  | "comet-shell"
  | "horsetail";

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

    // `size` is the radius the shell should actually reach, in pixels. Drag
    // means a particle only travels a fraction of (speed × life), so convert
    // the requested radius into the launch speed that achieves it.
    //
    // With per-frame damping d applied at 60fps, total distance for initial
    // speed v is v · (1 - d^(60·life)) / (60 · (1 - d)). Inverting that for the
    // dominant drag value gives the factor below.
    const reach = (1 - DRAG ** (60 * o.life)) / (60 * (1 - DRAG));
    const speedScale = 1 / Math.max(0.02, reach);
    o = { ...o, size: o.size * speedScale };

    switch (o.shape) {
      case "double-ring": {
        // Two concentric rings. Both stay close to circular: heavy squashing
        // collapses the ring into a wedge rather than reading as perspective.
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 4;
          const outer = i % 2 === 0;
          const speed = o.size * (outer ? 1 : 0.6) * (0.95 + this.rand() * 0.1);
          const squash = outer ? 0.86 : 1;
          this.spawn(
            o.x,
            o.y,
            Math.cos(a) * speed,
            Math.sin(a) * speed * squash,
            o.life,
            2,
            o.color,
            fade,
            DRAG,
            0.65,
            sparkle,
          );
        }
        break;
      }
      case "spiral": {
        // Particles released along a rotating arm, producing curling arcs.
        const arms = 4;
        for (let i = 0; i < n; i++) {
          const t = i / n;
          const arm = i % arms;
          const a = (arm / arms) * Math.PI * 2 + t * Math.PI * 3.2;
          const speed = o.size * (0.25 + t * 0.85);
          this.spawn(
            o.x,
            o.y,
            Math.cos(a) * speed,
            Math.sin(a) * speed,
            o.life * (0.8 + t * 0.5),
            2.1,
            o.color,
            fade,
            DRAG,
            0.85,
            sparkle,
          );
        }
        break;
      }
      case "star": {
        // Five sharp points: speed is modulated by angle so spokes stand out.
        const points = 5;
        for (let i = 0; i < n; i++) {
          const a = this.rand() * Math.PI * 2;
          // Cusped radial profile — max on a point, min between points.
          const lobe = Math.abs(Math.cos((a * points) / 2)) ** 2.5;
          const speed =
            o.size * (0.25 + lobe * 0.95) * (0.85 + this.rand() * 0.3);
          this.spawn(
            o.x,
            o.y,
            Math.cos(a) * speed,
            Math.sin(a) * speed,
            o.life,
            2.1,
            o.color,
            fade,
            DRAG,
            0.9,
            sparkle,
          );
        }
        break;
      }
      case "strobe": {
        // Dense, short-lived, heavily flickering — a crackling burst.
        for (let i = 0; i < n; i++) {
          const a = this.rand() * Math.PI * 2;
          const speed = o.size * (0.2 + this.rand() ** 0.6 * 0.8);
          this.spawn(
            o.x,
            o.y,
            Math.cos(a) * speed,
            Math.sin(a) * speed,
            o.life * (0.45 + this.rand() * 0.4),
            2.3,
            o.color,
            fade,
            0.83,
            0.9,
            1,
          );
        }
        break;
      }
      case "comet-shell": {
        // A tight core plus a handful of long comets streaking well past it.
        const comets = 9;
        const perComet = Math.max(3, Math.floor((n * 0.35) / comets));
        for (let i = 0; i < n - comets * perComet; i++) {
          const a = this.rand() * Math.PI * 2;
          const speed = o.size * (0.15 + this.rand() * 0.4);
          this.spawn(
            o.x,
            o.y,
            Math.cos(a) * speed,
            Math.sin(a) * speed,
            o.life * 0.8,
            2,
            o.color,
            fade,
            DRAG,
            1,
            sparkle,
          );
        }
        for (let c = 0; c < comets; c++) {
          const a = (c / comets) * Math.PI * 2 + this.rand() * 0.3;
          for (let i = 0; i < perComet; i++) {
            // Trailing particles share a heading but lag in speed. Kept close
            // to the shell radius — much faster and they leave the frame as
            // straight streaks instead of arcing comets.
            const speed = o.size * (0.85 + (i / perComet) * 0.4);
            this.spawn(
              o.x,
              o.y,
              Math.cos(a) * speed,
              Math.sin(a) * speed,
              o.life * 1.1,
              2.5,
              o.color,
              fade,
              DRAG,
              0.9,
              sparkle * 0.6,
            );
          }
        }
        break;
      }
      case "horsetail": {
        // Everything falls: a downward-biased spray of heavy, slow embers.
        for (let i = 0; i < n; i++) {
          const a = this.rand() * Math.PI * 2;
          const speed = o.size * (0.14 + this.rand() * 0.3);
          this.spawn(
            o.x,
            o.y,
            Math.cos(a) * speed * 0.9,
            Math.abs(Math.sin(a) * speed) * 0.5 + o.size * 0.12,
            o.life * 2,
            2.4,
            o.color,
            fade,
            0.93,
            1.8,
            sparkle * 1.2,
          );
        }
        break;
      }
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

    // Every shell gets the same two extra layers on top of its shape, which is
    // what makes a burst look like an explosion rather than a scatter plot.

    // 1. Ignition flash: a very fast, very short-lived white-hot core.
    const flashCount = Math.min(28, Math.floor(n * 0.12), this.free.length);
    for (let i = 0; i < flashCount; i++) {
      const a = this.rand() * Math.PI * 2;
      const speed = o.size * (0.05 + this.rand() * 0.28);
      this.spawn(
        o.x,
        o.y,
        Math.cos(a) * speed,
        Math.sin(a) * speed,
        0.14 + this.rand() * 0.12,
        3.4,
        { r: 255, g: 250, b: 230 },
        o.color,
        0.8,
        0.3,
        0,
      );
    }

    // 2. Glitter: slow, long-lived, heavily flickering motes that hang in the
    // air after the shell itself has burned out.
    const glitterCount = Math.min(70, Math.floor(n * 0.22), this.free.length);
    for (let i = 0; i < glitterCount; i++) {
      const a = this.rand() * Math.PI * 2;
      const speed = o.size * (0.08 + this.rand() * 0.5);
      this.spawn(
        o.x,
        o.y,
        Math.cos(a) * speed,
        Math.sin(a) * speed,
        o.life * (1.5 + this.rand()),
        1.5,
        o.color,
        fade,
        0.9,
        0.5,
        1,
      );
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
    ctx.lineCap = "round";

    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.active[i] === 0) continue;
      const t = this.life[i] / this.maxLife[i];
      // Ease-out alpha so embers linger instead of popping out.
      let alpha = t * t * PARTICLE_ALPHA;
      if (this.sparkle[i] > 0) {
        // Flicker frequency varies per particle via its position hash.
        const f = Math.sin(time * 40 + i * 1.7) * 0.5 + 0.5;
        alpha *= 1 - this.sparkle[i] * 0.55 * f;
      }
      if (alpha <= 0.008) continue;

      // Embers cool as they age: the color ramps from its hot value toward the
      // fade color, which is what gives a burst its characteristic gradient.
      const k = 1 - t;
      const r = (this.cr[i] * t + this.fr[i] * k) | 0;
      const g = (this.cg[i] * t + this.fg[i] * k) | 0;
      const b = (this.cb[i] * t + this.fb[i] * k) | 0;

      const vx = this.pvx[i];
      const vy = this.pvy[i];
      const speed = Math.hypot(vx, vy);
      const s = this.size[i] * (0.5 + t * 0.8);

      if (speed > 24) {
        // Fast embers draw as motion-stretched streaks along their velocity —
        // this is the single biggest difference between "dots" and "fireworks".
        const stretch = Math.min(26, speed * 0.045) * (0.4 + t * 0.8);
        const nx = vx / speed;
        const ny = vy / speed;
        ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
        ctx.lineWidth = s;
        ctx.beginPath();
        ctx.moveTo(this.px[i] - nx * stretch, this.py[i] - ny * stretch);
        ctx.lineTo(this.px[i], this.py[i]);
        ctx.stroke();

        // A hot white core on the leading tip of the brightest embers.
        if (alpha > 0.16) {
          ctx.fillStyle = `rgba(255,250,235,${alpha * 0.5})`;
          ctx.fillRect(
            this.px[i] - s * 0.32,
            this.py[i] - s * 0.32,
            s * 0.64,
            s * 0.64,
          );
        }
      } else {
        // Slow embers are round points; drawn as short round-capped segments so
        // they share the same anti-aliased look as the streaks.
        ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
        ctx.lineWidth = s;
        ctx.beginPath();
        ctx.moveTo(this.px[i], this.py[i]);
        ctx.lineTo(this.px[i] + 0.01, this.py[i]);
        ctx.stroke();
      }
    }

    // Rocket heads: brighter than their trail so the climb reads clearly.
    for (const rk of this.rockets) {
      ctx.fillStyle = `rgba(255,225,170,0.9)`;
      ctx.fillRect(rk.x - 1.5, rk.y - 2.5, 3, 5);
    }
    ctx.globalCompositeOperation = "source-over";
  }
}
