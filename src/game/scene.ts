import { css, rampColor } from "./palette";
import type { Rgb } from "./particles";
import type { SectionKind } from "./types";

/**
 * Static backdrop: sky gradient, star field, layered parallax skyline and a
 * water strip that mirrors the sky. The skyline is generated once per resize
 * into an offscreen canvas so the render loop only blits.
 */

interface Layer {
  canvas: HTMLCanvasElement;
  /** Multiplier on the parallax offset. */
  depth: number;
  /** Y position of the layer's baseline. */
  baseY: number;
}

interface Star {
  x: number;
  y: number;
  r: number;
  phase: number;
}

export class Scene {
  private layers: Layer[] = [];
  private stars: Star[] = [];
  private w = 0;
  private h = 0;
  /** Horizon: everything below is water. */
  horizonY = 0;
  private seed = 0x1234567;

  private rand(): number {
    this.seed ^= this.seed << 13;
    this.seed ^= this.seed >>> 17;
    this.seed ^= this.seed << 5;
    this.seed >>>= 0;
    return this.seed / 0xffffffff;
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.horizonY = h * 0.78;
    this.seed = 0x1234567;
    this.buildStars();
    this.buildSkyline();
  }

  private buildStars() {
    this.stars = [];
    const count = Math.round((this.w * this.h) / 9000);
    for (let i = 0; i < count; i++) {
      this.stars.push({
        x: this.rand() * this.w,
        y: this.rand() * this.horizonY * 0.85,
        r: this.rand() * 1.1 + 0.25,
        phase: this.rand() * Math.PI * 2,
      });
    }
  }

  private buildSkyline() {
    this.layers = [];
    // Three depths: far hills, mid towers, near blocks.
    const specs = [
      {
        depth: 0.18,
        tint: "#080d1c",
        minH: 0.05,
        maxH: 0.11,
        wMin: 60,
        wMax: 160,
        y: 0.0,
      },
      {
        depth: 0.42,
        tint: "#050916",
        minH: 0.08,
        maxH: 0.2,
        wMin: 32,
        wMax: 88,
        y: 0.012,
      },
      {
        depth: 0.85,
        tint: "#02040c",
        minH: 0.05,
        maxH: 0.14,
        wMin: 46,
        wMax: 120,
        y: 0.028,
      },
    ];

    for (const spec of specs) {
      // Layer is wider than the viewport so parallax never reveals an edge.
      const lw = Math.ceil(this.w * 1.5);
      const lh = Math.ceil(this.h * 0.35);
      const c = document.createElement("canvas");
      c.width = lw;
      c.height = lh;
      const g = c.getContext("2d");
      if (!g) continue;
      g.fillStyle = spec.tint;

      let x = 0;
      while (x < lw) {
        const bw = spec.wMin + this.rand() * (spec.wMax - spec.wMin);
        const bh = this.h * (spec.minH + this.rand() * (spec.maxH - spec.minH));
        const top = lh - bh;
        g.fillRect(x, top, bw, bh);

        // Antenna on the occasional tall tower.
        if (spec.depth > 0.3 && this.rand() > 0.82) {
          g.fillRect(x + bw * 0.45, top - bh * 0.18, 2, bh * 0.18);
        }

        // Lit windows — sparse, warm, and dim so they never fight the fireworks.
        if (spec.depth > 0.3) {
          const cols = Math.max(1, Math.floor(bw / 11));
          const rows = Math.max(1, Math.floor(bh / 14));
          for (let cx = 0; cx < cols; cx++) {
            for (let cy = 0; cy < rows; cy++) {
              if (this.rand() > 0.86) {
                g.fillStyle = `rgba(255,205,130,${0.1 + this.rand() * 0.22})`;
                g.fillRect(x + 4 + cx * 11, top + 5 + cy * 14, 3, 4);
              }
            }
          }
          g.fillStyle = spec.tint;
        }
        x += bw + 1 + this.rand() * 5;
      }

      this.layers.push({
        canvas: c,
        depth: spec.depth,
        baseY: this.horizonY + this.h * spec.y,
      });
    }
  }

  /**
   * Draws sky, stars and skyline. `drift` is a slowly increasing value (seconds)
   * used for parallax; `flash` 0..1 adds a horizon glow on big moments.
   */
  drawBack(
    ctx: CanvasRenderingContext2D,
    kind: SectionKind,
    intensity: number,
    drift: number,
    flash: number,
  ) {
    const deep = rampColor(kind, 0);

    const sky = ctx.createLinearGradient(0, 0, 0, this.horizonY);
    sky.addColorStop(0, "#01030a");
    sky.addColorStop(
      0.6,
      `rgba(${(deep.r * 0.09) | 0},${(deep.g * 0.1) | 0},${(deep.b * 0.16) | 0},1)`,
    );
    sky.addColorStop(
      1,
      `rgba(${(deep.r * 0.2 + 6) | 0},${(deep.g * 0.2 + 8) | 0},${(deep.b * 0.28 + 16) | 0},1)`,
    );
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, this.w, this.horizonY);

    // Stars twinkle slowly; brighter in quiet sections where the sky is empty.
    const starLift = 0.5 + (1 - intensity) * 0.5;
    ctx.globalCompositeOperation = "lighter";
    for (const s of this.stars) {
      const a =
        (0.3 + 0.7 * (Math.sin(drift * 0.9 + s.phase) * 0.5 + 0.5)) * starLift;
      ctx.fillStyle = `rgba(200,220,255,${a * 0.55})`;
      ctx.fillRect(s.x, s.y, s.r, s.r);
    }
    ctx.globalCompositeOperation = "source-over";

    if (flash > 0.01) {
      const glow = ctx.createLinearGradient(
        0,
        this.horizonY - this.h * 0.28,
        0,
        this.horizonY,
      );
      const c = rampColor(kind, 0.8);
      glow.addColorStop(0, css(c, 0));
      glow.addColorStop(1, css(c, 0.16 * flash));
      ctx.fillStyle = glow;
      ctx.fillRect(0, this.horizonY - this.h * 0.28, this.w, this.h * 0.28);
    }

    for (const layer of this.layers) {
      // Slow lateral drift, wrapped so it loops seamlessly.
      const span = layer.canvas.width - this.w;
      const off = -((drift * 3.5 * layer.depth) % span);
      ctx.drawImage(layer.canvas, off, layer.baseY - layer.canvas.height);
      ctx.drawImage(
        layer.canvas,
        off + span,
        layer.baseY - layer.canvas.height,
      );
    }
  }

  /** Water: mirrored, blurred, darkened copy of the sky region. */
  drawWater(
    ctx: CanvasRenderingContext2D,
    source: HTMLCanvasElement,
    drift: number,
    dpr: number,
  ) {
    const waterH = this.h - this.horizonY;
    if (waterH <= 1) return;

    ctx.save();
    ctx.globalAlpha = 0.32;
    ctx.filter = "blur(3px)";
    ctx.translate(0, this.horizonY);
    ctx.scale(1, -1);
    // Sample the band of sky just above the horizon and flip it downward.
    ctx.drawImage(
      source,
      0,
      (this.horizonY - waterH) * dpr,
      this.w * dpr,
      waterH * dpr,
      0,
      0,
      this.w,
      waterH,
    );
    ctx.restore();

    // Horizontal ripple bands break up the mirror so it reads as water.
    ctx.globalCompositeOperation = "source-over";
    for (let y = 0; y < waterH; y += 3) {
      const wobble = Math.sin(y * 0.28 + drift * 1.6) * 0.5 + 0.5;
      ctx.fillStyle = `rgba(1,3,10,${0.14 + wobble * 0.2})`;
      ctx.fillRect(0, this.horizonY + y, this.w, 1.6);
    }

    // Darken toward the bottom edge so the HUD stays readable.
    const grad = ctx.createLinearGradient(0, this.horizonY, 0, this.h);
    grad.addColorStop(0, "rgba(0,0,0,0)");
    grad.addColorStop(1, "rgba(0,0,0,0.75)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, this.horizonY, this.w, waterH);
  }

  ambientLaunchX(rand: number): number {
    return this.w * (0.08 + rand * 0.84);
  }

  get width() {
    return this.w;
  }

  get height() {
    return this.h;
  }

  waterTint(kind: SectionKind): Rgb {
    return rampColor(kind, 0.5);
  }
}
