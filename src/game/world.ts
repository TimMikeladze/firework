import type { Camera, Projected } from "./camera";
import { css, rampColor } from "./palette";
import type { Rgb } from "./particles";
import type { SectionKind } from "./types";

/**
 * The world beneath the flight path: an endless procession of terrain "slabs"
 * generated on demand ahead of the camera and retired once they pass behind it.
 *
 * Each slab belongs to a biome. Biomes change gradually — a slab's biome is
 * chosen when it is generated, far ahead of the camera, so by the time the
 * player reaches it the transition has already blended in visually.
 */

export type Biome = "city" | "coast" | "mountains" | "forest" | "canyon";

/** How far ahead of the camera terrain exists, in world units. */
const VIEW_DISTANCE = 4200;
/** Depth of one slab. */
const SLAB_DEPTH = 130;
/** Half-width of the generated corridor. */
const HALF_WIDTH = 2400;

interface Prop {
  /** World X of the prop's centre. */
  x: number;
  /** World Z. */
  z: number;
  width: number;
  height: number;
  /** Extra depth for boxy props; 0 draws a flat billboard. */
  depth: number;
  kind: "tower" | "peak" | "tree" | "mesa" | "wave" | "pylon";
  /** 0..1, seeds per-prop variation like lit windows. */
  variation: number;
}

interface Slab {
  z: number;
  biome: Biome;
  props: Prop[];
}

/** Which biome each section kind flies over. */
const SECTION_BIOME: Record<SectionKind, Biome> = {
  intro: "coast",
  verse: "city",
  build: "forest",
  chorus: "mountains",
  drop: "canyon",
  outro: "coast",
};

interface BiomeStyle {
  /** Silhouette fill. */
  body: string;
  /** Rim/edge highlight. */
  edge: string;
  /** Ground plane tint under this biome. */
  ground: Rgb;
  /** Whether the ground reflects bursts (water-like). */
  reflective: boolean;
}

const STYLES: Record<Biome, BiomeStyle> = {
  city: {
    body: "#0a0f1e",
    edge: "rgba(170,205,255,0.55)",
    ground: { r: 20, g: 28, b: 52 },
    reflective: false,
  },
  coast: {
    body: "#081428",
    edge: "rgba(140,215,255,0.6)",
    ground: { r: 16, g: 42, b: 78 },
    reflective: true,
  },
  mountains: {
    body: "#0b1020",
    edge: "rgba(205,225,255,0.55)",
    ground: { r: 24, g: 32, b: 56 },
    reflective: false,
  },
  forest: {
    body: "#061410",
    edge: "rgba(140,255,200,0.42)",
    ground: { r: 16, g: 38, b: 32 },
    reflective: false,
  },
  canyon: {
    body: "#1a0c07",
    edge: "rgba(255,175,120,0.55)",
    ground: { r: 52, g: 28, b: 18 },
    reflective: false,
  },
};

export class World {
  private slabs: Slab[] = [];
  /** Z of the furthest slab generated so far. */
  private frontier = 0;
  private seed = 0x7f4a7c15;
  private scratch: Projected = { x: 0, y: 0, depth: 0, scale: 0 };
  private viewW = 0;
  private viewH = 0;

  /** Biome the generator is currently laying down ahead of the camera. */
  private pendingBiome: Biome = "city";
  /** Biome under the camera right now, for ground tint and reflections. */
  private currentBiome: Biome = "city";

  private rand(): number {
    this.seed ^= this.seed << 13;
    this.seed ^= this.seed >>> 17;
    this.seed ^= this.seed << 5;
    this.seed >>>= 0;
    return this.seed / 0xffffffff;
  }

  resize(w: number, h: number) {
    this.viewW = w;
    this.viewH = h;
  }

  reset() {
    this.slabs.length = 0;
    this.frontier = 0;
    this.seed = 0x7f4a7c15;
  }

  get biome(): Biome {
    return this.currentBiome;
  }

  get style(): BiomeStyle {
    return STYLES[this.currentBiome];
  }

  /**
   * Points the generator at a new biome. Terrain already laid down keeps its
   * old biome, so the change arrives as a fly-through rather than a cut.
   */
  setBiomeForSection(kind: SectionKind) {
    this.pendingBiome = SECTION_BIOME[kind];
  }

  private generateSlab(z: number): Slab {
    const biome = this.pendingBiome;
    const props: Prop[] = [];

    // Props are placed in the corridor but pushed away from the flight line so
    // the camera never clips through one.
    const place = (minX: number, spanX: number): number => {
      const side = this.rand() < 0.5 ? -1 : 1;
      return side * (minX + this.rand() * spanX);
    };

    switch (biome) {
      case "city": {
        const count = 14 + Math.floor(this.rand() * 10);
        for (let i = 0; i < count; i++) {
          const w = 40 + this.rand() * 90;
          props.push({
            x: place(70, HALF_WIDTH - 70),
            z: z + this.rand() * SLAB_DEPTH,
            width: w,
            height: 90 + this.rand() ** 1.7 * 420,
            depth: w * (0.7 + this.rand() * 0.6),
            kind: "tower",
            variation: this.rand(),
          });
        }
        // Occasional radio pylon for silhouette variety.
        if (this.rand() > 0.7) {
          props.push({
            x: place(120, HALF_WIDTH - 120),
            z: z + this.rand() * SLAB_DEPTH,
            width: 14,
            height: 120 + this.rand() * 120,
            depth: 14,
            kind: "pylon",
            variation: this.rand(),
          });
        }
        break;
      }
      case "mountains": {
        const count = 6 + Math.floor(this.rand() * 4);
        for (let i = 0; i < count; i++) {
          const w = 420 + this.rand() * 520;
          props.push({
            x: place(140, HALF_WIDTH),
            z: z + this.rand() * SLAB_DEPTH,
            width: w,
            height: 260 + this.rand() * 520,
            depth: 0,
            kind: "peak",
            variation: this.rand(),
          });
        }
        break;
      }
      case "forest": {
        const count = 34 + Math.floor(this.rand() * 20);
        for (let i = 0; i < count; i++) {
          props.push({
            x: place(50, HALF_WIDTH),
            z: z + this.rand() * SLAB_DEPTH,
            width: 22 + this.rand() * 30,
            height: 60 + this.rand() * 100,
            depth: 0,
            kind: "tree",
            variation: this.rand(),
          });
        }
        break;
      }
      case "canyon": {
        const count = 7 + Math.floor(this.rand() * 4);
        for (let i = 0; i < count; i++) {
          const w = 280 + this.rand() * 460;
          props.push({
            x: place(110, HALF_WIDTH),
            z: z + this.rand() * SLAB_DEPTH,
            width: w,
            height: 150 + this.rand() * 260,
            depth: w * 0.8,
            kind: "mesa",
            variation: this.rand(),
          });
        }
        break;
      }
      case "coast": {
        // Sparse islands and swells; the ground plane does most of the work.
        if (this.rand() > 0.55) {
          props.push({
            x: place(200, HALF_WIDTH),
            z: z + this.rand() * SLAB_DEPTH,
            width: 120 + this.rand() * 260,
            height: 30 + this.rand() * 90,
            depth: 0,
            kind: "peak",
            variation: this.rand(),
          });
        }
        // Short glints, densely scattered. Long ones read as scanlines once
        // perspective magnifies whatever is close to the camera.
        const waves = 34 + Math.floor(this.rand() * 20);
        for (let i = 0; i < waves; i++) {
          props.push({
            x: place(30, HALF_WIDTH),
            z: z + this.rand() * SLAB_DEPTH,
            width: 8 + this.rand() * 22,
            height: 2,
            depth: 0,
            kind: "wave",
            variation: this.rand(),
          });
        }
        break;
      }
    }

    return { z, biome, props };
  }

  update(camera: Camera) {
    // Extend the corridor ahead.
    while (this.frontier < camera.distance + VIEW_DISTANCE) {
      this.slabs.push(this.generateSlab(this.frontier));
      this.frontier += SLAB_DEPTH;
    }
    // Retire what is behind. Slabs are appended in Z order, so this is a shift.
    while (this.slabs.length > 0 && this.slabs[0].z < camera.distance - 260) {
      this.slabs.shift();
    }
    // The biome under the camera is whatever slab it is currently over.
    for (const slab of this.slabs) {
      if (
        slab.z >= camera.distance - SLAB_DEPTH &&
        slab.z <= camera.distance + SLAB_DEPTH
      ) {
        this.currentBiome = slab.biome;
        break;
      }
    }
  }

  /**
   * Draws sky, ground plane and all terrain props, far to near. Roll is expected
   * to be applied by the caller before this runs.
   */
  render(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    kind: SectionKind,
    intensity: number,
    time: number,
  ) {
    const horizon = camera.horizonY;
    const deep = rampColor(kind, 0);
    // Oversize the fill so a rolled frame never shows a corner of raw canvas.
    const pad = this.viewH;

    // Sky.
    const sky = ctx.createLinearGradient(0, -pad, 0, horizon);
    sky.addColorStop(0, "#010206");
    sky.addColorStop(
      0.72,
      `rgba(${(deep.r * 0.1) | 0},${(deep.g * 0.11) | 0},${(deep.b * 0.2) | 0},1)`,
    );
    sky.addColorStop(
      1,
      `rgba(${(deep.r * 0.24 + 8) | 0},${(deep.g * 0.24 + 10) | 0},${(deep.b * 0.34 + 22) | 0},1)`,
    );
    ctx.fillStyle = sky;
    ctx.fillRect(-pad, -pad, this.viewW + pad * 2, horizon + pad);

    // Ground plane, tinted by the biome directly beneath. The falloff is slow
    // near the horizon and only goes fully dark at the very bottom of frame,
    // so the ground reads as receding distance rather than a black wall.
    const g = this.style.ground;
    const ground = ctx.createLinearGradient(0, horizon, 0, this.viewH + pad);
    ground.addColorStop(0, `rgba(${g.r},${g.g},${g.b},1)`);
    ground.addColorStop(
      0.35,
      `rgba(${(g.r * 0.6) | 0},${(g.g * 0.6) | 0},${(g.b * 0.65) | 0},1)`,
    );
    ground.addColorStop(1, "rgba(2,3,6,1)");
    ctx.fillStyle = ground;
    ctx.fillRect(-pad, horizon, this.viewW + pad * 2, this.viewH + pad * 2);

    // Perspective grid: lines at fixed world-Z intervals that stream toward the
    // camera. This is what makes the sense of flight legible between props.
    this.drawGroundGrid(ctx, camera, horizon);

    // A haze band right at the horizon sells the distance.
    const haze = ctx.createLinearGradient(
      0,
      horizon - this.viewH * 0.1,
      0,
      horizon + this.viewH * 0.02,
    );
    const hz = rampColor(kind, 0.45);
    haze.addColorStop(0, css(hz, 0));
    haze.addColorStop(1, css(hz, 0.09 + intensity * 0.07));
    ctx.fillStyle = haze;
    ctx.fillRect(
      -pad,
      horizon - this.viewH * 0.1,
      this.viewW + pad * 2,
      this.viewH * 0.12,
    );

    // Terrain, far to near so nearer props overlap correctly.
    for (let i = this.slabs.length - 1; i >= 0; i--) {
      const slab = this.slabs[i];
      for (const prop of slab.props) {
        this.drawProp(ctx, camera, slab.biome, prop, time);
      }
    }
  }

  /**
   * Lateral lines on the ground plane at fixed world-Z intervals. Because the
   * spacing is in world units, they sweep toward the viewer at exactly the
   * camera's speed — the clearest possible cue that the frame is flying.
   */
  private drawGroundGrid(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    horizon: number,
  ) {
    const spacing = 140;
    const style = this.style;
    const first = Math.ceil(camera.distance / spacing) * spacing;

    ctx.save();
    ctx.strokeStyle = style.edge;
    ctx.lineWidth = 1;

    for (let z = first; z < camera.distance + 2200; z += spacing) {
      const left = camera.project(-HALF_WIDTH, 0, z, this.scratch);
      if (left.depth <= 1) continue;
      const ly = left.y;
      const lx = left.x;
      const right = camera.project(HALF_WIDTH, 0, z, this.scratch);
      if (right.depth <= 1) continue;

      // Fade with distance so lines emerge from the haze instead of popping.
      const t = 1 - (right.depth - 200) / 2000;
      const alpha = Math.max(0, Math.min(0.22, t * 0.22));
      if (alpha <= 0.005 || ly < horizon) continue;

      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.moveTo(lx, ly);
      ctx.lineTo(right.x, right.y);
      ctx.stroke();
    }

    ctx.restore();
  }

  private drawProp(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    biome: Biome,
    prop: Prop,
    time: number,
  ) {
    const style = STYLES[biome];
    const base = camera.project(prop.x, 0, prop.z, this.scratch);
    if (base.depth <= 1) return;

    const scale = base.scale;
    const halfW = prop.width * 0.5 * scale;
    const h = prop.height * scale;

    // Cheap frustum cull with a generous margin for roll.
    if (base.x + halfW < -this.viewW || base.x - halfW > this.viewW * 2) return;

    // Fade distant geometry into the haze instead of popping it in.
    const fade = Math.max(
      0,
      Math.min(1, 1 - (base.depth - 700) / (VIEW_DISTANCE - 700)),
    );
    if (fade <= 0.01) return;

    // Terrain never enters the play area: anything that would reach above the
    // beam is skipped entirely rather than clipped, since a clipped prop reads
    // as a flat wall across the frame.
    if (base.y - h < this.viewH * 0.32) return;

    ctx.globalAlpha = fade;

    switch (prop.kind) {
      case "tower":
      case "mesa": {
        const topY = base.y - h;
        ctx.fillStyle = style.body;
        ctx.fillRect(base.x - halfW, topY, halfW * 2, h);

        // A lit edge along the side facing the camera centre gives it volume.
        const facing = base.x < this.viewW / 2 ? 1 : -1;
        ctx.fillStyle = style.edge;
        ctx.fillRect(
          base.x + facing * halfW - facing * Math.max(1, halfW * 0.06),
          topY,
          Math.max(1, halfW * 0.06),
          h,
        );

        if (prop.kind === "tower" && scale > 0.12) {
          // Windows: a coarse grid, deterministic per tower via its variation.
          const cols = Math.max(
            1,
            Math.floor((halfW * 2) / Math.max(3, 9 * scale)),
          );
          const rows = Math.max(1, Math.floor(h / Math.max(4, 13 * scale)));
          const cw = (halfW * 2) / cols;
          const rh = h / rows;
          let bits = (prop.variation * 0xffffff) | 0;
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              bits = (bits * 1103515245 + 12345) & 0x7fffffff;
              if ((bits & 7) > 4) {
                ctx.fillStyle = `rgba(255,215,150,${0.35 + ((bits >> 5) & 15) / 26})`;
                ctx.fillRect(
                  base.x - halfW + c * cw + cw * 0.25,
                  topY + r * rh + rh * 0.2,
                  cw * 0.5,
                  rh * 0.45,
                );
              }
            }
          }
        }
        break;
      }
      case "pylon": {
        ctx.fillStyle = style.body;
        ctx.fillRect(base.x - halfW, base.y - h, halfW * 2, h);
        // Aircraft warning light, blinking on a fixed cycle.
        const blink = Math.sin(time * 2.4 + prop.variation * 6) > 0.4;
        if (blink) {
          ctx.fillStyle = "rgba(255,70,70,0.9)";
          ctx.fillRect(
            base.x - Math.max(1, halfW),
            base.y - h - 2,
            Math.max(2, halfW * 2),
            Math.max(2, 3 * scale),
          );
        }
        break;
      }
      case "peak": {
        // Triangular ridge with a lit windward face.
        ctx.fillStyle = style.body;
        ctx.beginPath();
        ctx.moveTo(base.x - halfW, base.y);
        ctx.lineTo(base.x + (prop.variation - 0.5) * halfW * 0.6, base.y - h);
        ctx.lineTo(base.x + halfW, base.y);
        ctx.closePath();
        ctx.fill();

        ctx.strokeStyle = style.edge;
        ctx.lineWidth = Math.max(0.6, scale * 1.5);
        ctx.beginPath();
        ctx.moveTo(base.x + (prop.variation - 0.5) * halfW * 0.6, base.y - h);
        ctx.lineTo(base.x + halfW, base.y);
        ctx.stroke();
        break;
      }
      case "tree": {
        // Conifer: a stacked triangle, readable even at a few pixels tall.
        ctx.fillStyle = style.body;
        ctx.beginPath();
        ctx.moveTo(base.x - halfW, base.y);
        ctx.lineTo(base.x, base.y - h);
        ctx.lineTo(base.x + halfW, base.y);
        ctx.closePath();
        ctx.fill();
        if (scale > 0.25) {
          ctx.strokeStyle = style.edge;
          ctx.lineWidth = 0.7;
          ctx.beginPath();
          ctx.moveTo(base.x, base.y - h);
          ctx.lineTo(base.x + halfW, base.y);
          ctx.stroke();
        }
        break;
      }
      case "wave": {
        // A moving glint on the water surface.
        const shimmer =
          0.3 +
          0.45 *
            (Math.sin(time * 1.4 + prop.variation * 9 + prop.z * 0.01) * 0.5 +
              0.5);
        ctx.fillStyle = `rgba(180,230,255,${shimmer * fade})`;
        ctx.fillRect(
          base.x - halfW,
          base.y,
          halfW * 2,
          Math.max(0.6, 2 * scale),
        );
        break;
      }
    }

    ctx.globalAlpha = 1;
  }
}
