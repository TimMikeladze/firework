/**
 * The data model for the fireworks builder.
 *
 * A `ShellSpec` is the whole design of one firework: how it flies, when it
 * breaks, and the stack of `BurstLayer`s that make up the break. Everything the
 * GPU needs is derivable from this object, so a spec is also the save format —
 * `JSON.stringify(spec)` round-trips through `parseShell`.
 */

/**
 * How a layer distributes its sparks. Names follow pyrotechnic convention where
 * one exists; the GPU maps each to an id in `PATTERN_IDS`.
 */
export type BurstPattern =
  | "sphere"
  | "ring"
  | "double-ring"
  | "palm"
  | "willow"
  | "crossette"
  | "star"
  | "heart"
  | "spiral"
  | "cone"
  | "strobe";

export const PATTERNS: readonly BurstPattern[] = [
  "sphere",
  "ring",
  "double-ring",
  "palm",
  "willow",
  "crossette",
  "star",
  "heart",
  "spiral",
  "strobe",
  "cone",
];

/** Must match the `PATTERN_*` constants in `emit.wgsl`. */
export const PATTERN_IDS: Record<BurstPattern, number> = {
  sphere: 0,
  ring: 1,
  "double-ring": 2,
  palm: 3,
  willow: 4,
  crossette: 5,
  star: 6,
  heart: 7,
  spiral: 8,
  cone: 9,
  strobe: 10,
};

/** Internal patterns the UI never exposes but the renderer emits directly. */
export const PATTERN_TRAIL = 11;
export const PATTERN_FLASH = 12;

export type ColorMode = "solid" | "fade" | "bicolor" | "rainbow";

export const COLOR_MODES: readonly ColorMode[] = [
  "solid",
  "fade",
  "bicolor",
  "rainbow",
];

/** Must match the `COLOR_*` constants in `emit.wgsl`. */
export const COLOR_MODE_IDS: Record<ColorMode, number> = {
  solid: 0,
  fade: 1,
  bicolor: 2,
  rainbow: 3,
};

export interface BurstLayer {
  id: string;
  name: string;
  enabled: boolean;
  pattern: BurstPattern;
  /** Spark count. The renderer clamps the shell total to the particle pool. */
  count: number;
  /** Outward speed in world units per second. */
  speed: number;
  /** 0..1 — fraction of `speed` randomised per spark. */
  speedJitter: number;
  /** Seconds after the shell breaks before this layer ignites. */
  delay: number;
  /** Spawn offset from the break point, in world units. Makes pistils/rings. */
  startRadius: number;
  /** Spark burn time in seconds. */
  life: number;
  lifeJitter: number;
  /** Spark radius in world units. */
  size: number;
  colorMode: ColorMode;
  /** Hex `#rrggbb`. */
  colorA: string;
  colorB: string;
  /** Multiplier on the show's gravity — willows fall, strobes hang. */
  gravity: number;
  /** Air resistance, per second. High drag stops sparks dead at full radius. */
  drag: number;
  /** 0..1 — per-spark twinkle. */
  sparkle: number;
  /** 0..1 — sharp random brightness spikes, the "crackle" look. */
  glitter: number;
  /** 0..1 — stretches sparks along their velocity into comet tails. */
  stretch: number;
  /** Tangential swirl around the break axis. */
  spin: number;
  /** 0..1 — how much of the shell's own velocity the sparks keep. */
  inherit: number;
}

export interface LaunchSpec {
  /** Apex height in world units. Determines the lift impulse. */
  height: number;
  /** Degrees off vertical. */
  tilt: number;
  /** Extra seconds of rise after apex before the break. Negative breaks early. */
  fuse: number;
  /** Sparks per second shed by the rising shell. */
  trailRate: number;
  trailColor: string;
  /** 0..1 — brightness of the break flash. */
  flash: number;
}

export interface PhysicsSpec {
  /** World units per second squared, positive downward. */
  gravity: number;
  /** Global air resistance added on top of each layer's own drag. */
  drag: number;
  /** Horizontal wind, world units per second squared. */
  wind: number;
  /** 0..1 — swirling turbulence field strength. */
  turbulence: number;
}

export interface LookSpec {
  /** 0..2 — bloom strength in the composite pass. */
  bloom: number;
  /** 0..1 — exposure of the whole scene. */
  exposure: number;
  /** 0..1 — how much the water mirrors the show. 0 disables the mirror pass. */
  reflection: number;
  /** 0..1 — sea state. 0 is a still pond, 1 is a choppy swell. */
  waves: number;
  /** 0..1 — haze/smoke sitting over the water. */
  haze: number;
}

export interface AudioSpec {
  enabled: boolean;
  /** 0..1 — boom loudness. */
  boom: number;
  /** 0..1 — crackle/whistle loudness. */
  crackle: number;
}

export interface ShellSpec {
  id: string;
  name: string;
  launch: LaunchSpec;
  layers: BurstLayer[];
  physics: PhysicsSpec;
  look: LookSpec;
  audio: AudioSpec;
}

let idCounter = 0;

/** Short, collision-resistant enough for local ids; not persisted as a key. */
export function makeId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

export function defaultLayer(overrides: Partial<BurstLayer> = {}): BurstLayer {
  return {
    id: makeId("layer"),
    name: "Break",
    enabled: true,
    pattern: "sphere",
    count: 2400,
    speed: 15,
    speedJitter: 0.18,
    delay: 0,
    startRadius: 0,
    life: 2.1,
    lifeJitter: 0.3,
    size: 0.1,
    colorMode: "fade",
    colorA: "#ffd27a",
    colorB: "#ff2f4f",
    gravity: 1,
    drag: 1.1,
    sparkle: 0.45,
    glitter: 0.2,
    stretch: 0.25,
    spin: 0,
    inherit: 0.15,
    ...overrides,
  };
}

export function defaultShell(overrides: Partial<ShellSpec> = {}): ShellSpec {
  return {
    id: makeId("shell"),
    name: "Untitled shell",
    launch: {
      height: 34,
      tilt: 4,
      fuse: 0.1,
      trailRate: 90,
      trailColor: "#ffb066",
      flash: 0.7,
    },
    layers: [defaultLayer()],
    physics: { gravity: 9.4, drag: 0.35, wind: 0.6, turbulence: 0.35 },
    look: { bloom: 1, exposure: 1, reflection: 0.55, waves: 0.45, haze: 0.4 },
    audio: { enabled: true, boom: 0.7, crackle: 0.5 },
    ...overrides,
  };
}

/** Total sparks a shell asks for, ignoring the rising trail. */
export function shellParticleCount(spec: ShellSpec): number {
  return spec.layers.reduce(
    (total, layer) => (layer.enabled ? total + layer.count : total),
    0,
  );
}

/** Seconds from break to the last spark going dark. Drives the auto-fire gap. */
export function shellDuration(spec: ShellSpec): number {
  let last = 0.6;
  for (const layer of spec.layers) {
    if (!layer.enabled) continue;
    last = Math.max(last, layer.delay + layer.life * (1 + layer.lifeJitter));
  }
  return last;
}

/**
 * Seconds from launch to the break, which is what a synced show schedules
 * against: the lift is solved back from the authored apex height, so a cue can
 * be launched exactly this far ahead of the beat it should break on.
 */
export function shellRiseTime(spec: ShellSpec): number {
  const gravity = Math.max(0.5, spec.physics.gravity);
  const speed = Math.sqrt(2 * gravity * Math.max(1, spec.launch.height));
  const tilt = (spec.launch.tilt * Math.PI) / 180;
  return Math.max(0.05, (Math.cos(tilt) * speed) / gravity + spec.launch.fuse);
}

const HEX = /^#?([0-9a-f]{6})$/i;

/** `#rrggbb` to linear-light RGB, which is what the shaders blend in. */
export function hexToLinear(hex: string): [number, number, number] {
  const match = HEX.exec(hex.trim());
  if (!match) return [1, 1, 1];
  const value = Number.parseInt(match[1], 16);
  const toLinear = (channel: number) => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return [
    toLinear((value >> 16) & 0xff),
    toLinear((value >> 8) & 0xff),
    toLinear(value & 0xff),
  ];
}

function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function clampHex(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const match = HEX.exec(value.trim());
  return match ? `#${match[1].toLowerCase()}` : fallback;
}

/**
 * Rebuilds a spec from untrusted JSON (a paste, an old localStorage entry),
 * clamping every field to the range the UI allows. Never throws: anything
 * unreadable falls back to the default shell.
 */
export function parseShell(input: unknown): ShellSpec {
  const base = defaultShell();
  if (typeof input !== "object" || input === null) return base;
  const raw = input as Record<string, unknown>;
  const launch = (raw.launch ?? {}) as Record<string, unknown>;
  const physics = (raw.physics ?? {}) as Record<string, unknown>;
  const look = (raw.look ?? {}) as Record<string, unknown>;
  const audio = (raw.audio ?? {}) as Record<string, unknown>;
  const layers = Array.isArray(raw.layers) ? raw.layers : [];

  return {
    id: typeof raw.id === "string" ? raw.id : base.id,
    name: typeof raw.name === "string" ? raw.name.slice(0, 60) : base.name,
    launch: {
      height: clampNumber(launch.height, 8, 90, base.launch.height),
      tilt: clampNumber(launch.tilt, -35, 35, base.launch.tilt),
      fuse: clampNumber(launch.fuse, -0.6, 1.5, base.launch.fuse),
      trailRate: clampNumber(launch.trailRate, 0, 400, base.launch.trailRate),
      trailColor: clampHex(launch.trailColor, base.launch.trailColor),
      flash: clampNumber(launch.flash, 0, 1, base.launch.flash),
    },
    layers: layers.length
      ? layers.slice(0, MAX_LAYERS).map((layer) => parseLayer(layer))
      : base.layers,
    physics: {
      gravity: clampNumber(physics.gravity, 0, 30, base.physics.gravity),
      drag: clampNumber(physics.drag, 0, 4, base.physics.drag),
      wind: clampNumber(physics.wind, -8, 8, base.physics.wind),
      turbulence: clampNumber(
        physics.turbulence,
        0,
        3,
        base.physics.turbulence,
      ),
    },
    look: {
      bloom: clampNumber(look.bloom, 0, 2, base.look.bloom),
      exposure: clampNumber(look.exposure, 0.2, 2.5, base.look.exposure),
      reflection: clampNumber(look.reflection, 0, 1, base.look.reflection),
      waves: clampNumber(look.waves, 0, 1, base.look.waves),
      haze: clampNumber(look.haze, 0, 1, base.look.haze),
    },
    audio: {
      enabled:
        typeof audio.enabled === "boolean" ? audio.enabled : base.audio.enabled,
      boom: clampNumber(audio.boom, 0, 1, base.audio.boom),
      crackle: clampNumber(audio.crackle, 0, 1, base.audio.crackle),
    },
  };
}

function parseLayer(input: unknown): BurstLayer {
  const base = defaultLayer();
  if (typeof input !== "object" || input === null) return base;
  const raw = input as Record<string, unknown>;
  const pattern =
    typeof raw.pattern === "string" && raw.pattern in PATTERN_IDS
      ? (raw.pattern as BurstPattern)
      : base.pattern;
  const colorMode =
    typeof raw.colorMode === "string" && raw.colorMode in COLOR_MODE_IDS
      ? (raw.colorMode as ColorMode)
      : base.colorMode;

  return {
    id: typeof raw.id === "string" ? raw.id : base.id,
    name: typeof raw.name === "string" ? raw.name.slice(0, 40) : base.name,
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
    pattern,
    count: Math.round(clampNumber(raw.count, 50, 20000, base.count)),
    speed: clampNumber(raw.speed, 0.5, 60, base.speed),
    speedJitter: clampNumber(raw.speedJitter, 0, 1, base.speedJitter),
    delay: clampNumber(raw.delay, 0, 4, base.delay),
    startRadius: clampNumber(raw.startRadius, 0, 30, base.startRadius),
    life: clampNumber(raw.life, 0.15, 8, base.life),
    lifeJitter: clampNumber(raw.lifeJitter, 0, 1, base.lifeJitter),
    size: clampNumber(raw.size, 0.01, 0.6, base.size),
    colorMode,
    colorA: clampHex(raw.colorA, base.colorA),
    colorB: clampHex(raw.colorB, base.colorB),
    gravity: clampNumber(raw.gravity, -1, 3, base.gravity),
    drag: clampNumber(raw.drag, 0, 6, base.drag),
    sparkle: clampNumber(raw.sparkle, 0, 1, base.sparkle),
    glitter: clampNumber(raw.glitter, 0, 1, base.glitter),
    stretch: clampNumber(raw.stretch, 0, 1, base.stretch),
    spin: clampNumber(raw.spin, -12, 12, base.spin),
    inherit: clampNumber(raw.inherit, 0, 1, base.inherit),
  };
}

export const MAX_LAYERS = 4;
