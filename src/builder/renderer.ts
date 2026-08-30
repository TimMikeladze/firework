/**
 * The GPU side of the builder.
 *
 * Ownership split: the CPU tracks the handful of rising shells (kinematics for
 * a dozen objects is free, and the break has to be scheduled somewhere), while
 * every spark lives and dies on the GPU. Spawning a layer is one uniform write
 * plus one compute dispatch — the spark data never crosses the bus.
 *
 * The particle pool is a ring buffer. Because slots are handed out in order and
 * each layer knows how long its sparks burn, the live set is always a window
 * `[first, first + span)`, so the sim and the draw only ever touch live sparks.
 */

import {
  clock,
  compute,
  draw,
  effect,
  type FrameLoopHandle,
  frameLoop,
  init,
  sampler,
  storage,
  surface,
  target,
} from "vgpu";
import { orbitControls, perspectiveCamera } from "vgpu/scene";
import { ShowAudio } from "./audio";
import type { Cue, ShowOptions } from "./choreography";
import { LiveConductor, type LiveState } from "./live";
import { invertMat4, type Mat4, rayPlaneHit } from "./math";
import blurShader from "./shaders/blur.wgsl";
import brightShader from "./shaders/bright.wgsl";
import compositeShader from "./shaders/composite.wgsl";
import emitShader from "./shaders/emit.wgsl";
import simShader from "./shaders/sim.wgsl";
import skyShader from "./shaders/sky.wgsl";
import sparksShader from "./shaders/sparks.wgsl";
import {
  type BurstLayer,
  COLOR_MODE_IDS,
  hexToLinear,
  type LookSpec,
  PATTERN_FLASH,
  PATTERN_IDS,
  PATTERN_TRAIL,
  type ShellSpec,
} from "./spec";

/** Sparks in flight at once. 96 bytes each, so ~17 MB of VRAM. */
const POOL = 180_000;
const PARTICLE_BYTES = 96;
const WORKGROUP = 64;
/** The water plane. Everything is built around y = 0. */
const WATER_Y = 0;
/** Breaks the water lights from at once; mirrors `LIGHTS` in `sky.wgsl`. */
const WATER_LIGHTS = 4;
/** Vertical field of view, degrees. */
const FOV = 52;
/**
 * The opening view: a spectator on the shore rather than a camera in the
 * middle of the show. The eye sits a few units above the water and aims a
 * little above it, which drops the horizon below the middle of the frame and
 * hands the larger share to the sky the shells break in — the water keeps
 * enough of the bottom to carry the reflection.
 */
const EYE_HEIGHT = 4;
const AIM_HEIGHT = 11;
/**
 * The box a show fills. Cues drift out to about forty units either side and
 * break as high as fifty, and a fat layer throws sparks a good fifteen further
 * in every direction, so the opening framing is built to hold all of it.
 */
const SHOW_HALF_WIDTH = 55;
const SHOW_TOP = 68;
/**
 * Past this the shells are specks, so a very tall, narrow window gets a
 * cropped show rather than a distant one.
 */
const MAX_FRAMING_DISTANCE = 175;

/**
 * How far out across the water to stand so the whole show is in frame. The
 * vertical fit is what binds on a desk; a portrait phone is too narrow to hold
 * the width of a show at any sane distance, so it backs off to the cap and
 * crops the outermost cues instead.
 */
function openingGround(aspect: number): number {
  const half = Math.tan((FOV * Math.PI) / 360);
  const vertical = (SHOW_TOP - AIM_HEIGHT) / half;
  const horizontal = SHOW_HALF_WIDTH / (half * Math.max(0.2, aspect));
  return Math.min(Math.max(vertical, horizontal), MAX_FRAMING_DISTANCE);
}

/** The same framing as an orbit pose, for re-framing a camera already built. */
function openingPose(aspect: number): { distance: number; pitch: number } {
  // The orbit distance runs eye to target, not along the water, and the eye
  // sits below the target — hence the negative pitch.
  const rise = AIM_HEIGHT - EYE_HEIGHT;
  const distance = Math.hypot(openingGround(aspect), rise);
  return { distance, pitch: -Math.asin(rise / distance) };
}

/**
 * A recent break, lighting the water as a point source. Its intensity follows
 * the burn curve the sparks themselves use, so the path it lays across the
 * water dies with the stars and not before them.
 */
interface WaterLight {
  pos: [number, number, number];
  color: [number, number, number];
  /** Peak intensity, from the size of the break. */
  strength: number;
  /** Seconds since the break. */
  age: number;
  /** Burn time of the shell's first layer. */
  life: number;
}

function waterLightIntensity(light: WaterLight): number {
  const age = light.age / Math.max(0.2, light.life);
  if (age >= 1) return 0;
  // The spark brightness curve from `sparks.wgsl`: an ignition spike, a long
  // exponential burn, and a soft death.
  return (
    light.strength *
    Math.exp(-2.6 * age) *
    (1 + 1.2 * Math.exp(-26 * age)) *
    Math.min(1, (1 - age) / 0.15)
  );
}

/** Packs the lights into the `vec4f` slots the shader reads. */
function packWaterLights(lights: readonly WaterLight[]) {
  const positions: [number, number, number, number][] = [];
  const colors: [number, number, number, number][] = [];
  for (let i = 0; i < WATER_LIGHTS; i++) {
    const light = lights[i];
    const intensity = light ? waterLightIntensity(light) : 0;
    positions.push(light ? [...light.pos, intensity] : [0, 0, 0, 0]);
    colors.push(light ? [...light.color, 0] : [0, 0, 0, 0]);
  }
  return { lights: positions, lightColors: colors };
}

/** Angular size of one pixel for a vertical field of view over `height` px. */
function pixelAngleFor(height: number): number {
  return (2 * Math.tan((FOV * Math.PI) / 360)) / Math.max(1, height);
}

/**
 * The moon's share of the sky uniform, from the look settings. Height maps
 * to an elevation between just clear of the horizon and high overhead; the
 * bearing is a compass angle with 0 straight ahead of the default camera,
 * which looks down -Z. Size runs from the real half-degree disc to a
 * cinematic four degrees.
 */
function moonUniform(look: LookSpec) {
  const elevation = ((4 + 66 * look.moonHeight) * Math.PI) / 180;
  const bearing = (look.moonAngle * Math.PI) / 180;
  const flat = Math.cos(elevation);
  return {
    moonRadius: ((0.26 + 1.74 * look.moonSize) * Math.PI) / 180,
    moonPhase: look.moonPhase,
    moonDir: [
      Math.sin(bearing) * flat,
      Math.sin(elevation),
      -Math.cos(bearing) * flat,
    ] as [number, number, number],
    moon: look.moon,
  };
}

function sizeOf(size: readonly [number, number]): [number, number] {
  return [Math.max(1, size[0]), Math.max(1, size[1])];
}

function halfOf(size: readonly [number, number]): [number, number] {
  return [Math.max(1, size[0] >> 1), Math.max(1, size[1] >> 1)];
}

export interface RendererStats {
  /** Sparks currently alive (the ring window, so a slight over-count). */
  particles: number;
  fps: number;
  /** Shells still rising. */
  shells: number;
}

export interface FireworksHandle {
  /** Swap the design being previewed. Takes effect on the next launch. */
  setSpec(spec: ShellSpec): void;
  /** Fire one shell. Omit the position for a random spot on the water. */
  launch(x?: number, z?: number): void;
  /**
   * Hand over the firing script. Cues are break times on the song clock; the
   * renderer launches each shell early enough to break on time.
   */
  setCues(cues: readonly Cue[] | null): void;
  /** Start (or restart) the loaded track at `offset` seconds. */
  playMusic(buffer: AudioBuffer, offset?: number): void;
  pauseMusic(): void;
  resumeMusic(): void;
  stopMusic(): void;
  seekMusic(seconds: number): void;
  /** Forget the track entirely, script included. */
  clearMusic(): void;
  /** Decodes a picked or dropped file on the show's own audio context. */
  decode(file: File): Promise<AudioBuffer>;
  setMusicVolume(value: number): void;
  /**
   * Listen to a live stream — a shared tab or the microphone — and fire to the
   * beat the conductor predicts from it.
   */
  startListening(stream: MediaStream): void;
  stopListening(): void;
  /** Density, palette source, and audio/visual calibration for both modes. */
  setShowOptions(options: Partial<ShowOptions & { syncOffset: number }>): void;
  /** Live tempo and level, or `null` when nothing is being listened to. */
  readonly liveState: LiveState | null;
  /** Song position being heard right now, or `null` with no track loaded. */
  readonly songTime: number | null;
  readonly musicPlaying: boolean;
  /** Shells per minute; 0 stops auto-fire. Idles while a show is playing. */
  setAutoFire(perMinute: number): void;
  setPaused(paused: boolean): void;
  setMuted(muted: boolean): void;
  /** Kills every live spark and rising shell immediately. */
  clear(): void;
  readonly stats: RendererStats;
  dispose(): void;
}

interface Rocket {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Seconds until the break, counting down. */
  fuse: number;
  spec: ShellSpec;
  /** Fractional sparks carried between frames so low trail rates still emit. */
  trailDebt: number;
}

interface PendingBurst {
  /** Seconds until this layer ignites. */
  delay: number;
  layer: BurstLayer;
  spec: ShellSpec;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

/** One emitted chunk of the ring buffer, retired once its sparks are dead. */
interface Chunk {
  /** Absolute slot index one past the chunk's last spark. */
  end: number;
  /** Renderer clock time at which every spark in the chunk is out. */
  expiresAt: number;
}

export interface FireworksOptions {
  /** The shell to preview until `setSpec` replaces it. */
  spec: ShellSpec;
  /** Called about twice a second while the loop runs. */
  onStats?: (stats: RendererStats) => void;
  /** Fires once when a track reaches its end on its own. */
  onMusicEnd?: () => void;
}

/**
 * One renderer per canvas, serialised.
 *
 * A surface owns its canvas exclusively, and React's development double-mount
 * starts a second renderer before the first has finished booting. Chaining the
 * starts — and disposing the previous one first — turns that race into an
 * ordered handover instead of a `VGPU-SURFACE-DUPLICATE`.
 */
const running = new WeakMap<HTMLCanvasElement, Promise<FireworksHandle>>();

export function startFireworks(
  canvas: HTMLCanvasElement,
  options: FireworksOptions,
): Promise<FireworksHandle> {
  const previous = running.get(canvas) ?? Promise.resolve(null);
  const booting = previous
    .then(
      (handle) => handle?.dispose(),
      () => undefined,
    )
    .then(() => bootFireworks(canvas, options));
  running.set(canvas, booting);
  return booting;
}

async function bootFireworks(
  canvas: HTMLCanvasElement,
  options: FireworksOptions,
): Promise<FireworksHandle> {
  const gpu = await init();
  const view = surface(gpu, canvas, { dpr: [1, 2] });

  // --- resources -----------------------------------------------------------

  const particles = storage(gpu, POOL * PARTICLE_BYTES);
  const linear = sampler(gpu, {
    minFilter: "linear",
    magFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });

  // The scene is HDR so a dense break can exceed 1.0 and still bloom; the
  // bloom chain runs at half resolution, which is free extra blur radius.
  const hdr: GPUTextureFormat = "rgba16float";
  const scene = target(gpu, {
    size: sizeOf(view.size),
    format: hdr,
    label: "scene",
  });
  const bloomA = target(gpu, {
    size: halfOf(view.size),
    format: hdr,
    label: "bloom-a",
  });
  const bloomB = target(gpu, {
    size: halfOf(view.size),
    format: hdr,
    label: "bloom-b",
  });
  // The show flipped through the water plane, which the sky pass reads back as
  // the water's reflection. Half resolution is deliberate: a reflection is
  // softer than the thing it reflects, so the downsample is free blur.
  const mirror = target(gpu, {
    size: halfOf(view.size),
    format: hdr,
    label: "mirror",
  });

  const aspectOf = (size: readonly number[]) => size[0] / Math.max(1, size[1]);
  const opening = openingGround(aspectOf(view.size));

  const camera = perspectiveCamera({
    fov: FOV,
    aspect: aspectOf(view.size),
    near: 0.5,
    far: 900,
    position: [0, EYE_HEIGHT, opening],
    target: [0, AIM_HEIGHT, 0],
  });
  const controls = orbitControls(camera, {
    element: canvas,
    // Aimed just over the horizon, so a break and its mirror both fit.
    target: [0, AIM_HEIGHT, 0],
    damping: 0.12,
    distance: { min: 18, max: 300 },
    pitch: { min: -0.22, max: 1.2 },
  });
  /**
   * Whether the viewer has taken the camera — by dragging it round or zooming
   * it. Until they do, a resize re-frames the show: a phone turned on its side
   * is a new window onto the same show, not a request to lose half of it.
   */
  let cameraTaken = false;
  const takeCamera = () => {
    cameraTaken = true;
  };
  canvas.addEventListener("wheel", takeCamera, { passive: true });

  const invViewProj: Mat4 = new Float32Array(16);
  const cameraUniform = {
    viewProj: camera.viewProjection,
    right: [1, 0, 0] as [number, number, number],
    pad0: 0,
    up: [0, 1, 0] as [number, number, number],
    pad1: 0,
    eye: [0, EYE_HEIGHT, opening] as [number, number, number],
    pad2: 0,
  };

  // --- pipelines -----------------------------------------------------------

  const emitter = compute(gpu, emitShader, { label: "emit" });
  const sim = compute(gpu, simShader, { label: "sim", set: { particles } });

  const sky = effect(gpu, skyShader, {
    label: "sky",
    set: {
      sky: {
        invViewProj,
        viewProj: camera.viewProjection,
        eye: cameraUniform.eye,
        time: 0,
        haze: options.spec.look.haze,
        glow: 0,
        reflection: options.spec.look.reflection,
        waves: options.spec.look.waves,
        glowColor: [1, 0.7, 0.45],
        waterY: WATER_Y,
        pixelAngle: pixelAngleFor(view.size[1]),
        chop: options.spec.look.chop,
        ...moonUniform(options.spec.look),
        ...packWaterLights([]),
      },
      mirror,
      samp: linear,
    },
  });

  function sparkParams(mirrored: boolean) {
    return {
      time: 0,
      first: 0,
      span: 0,
      poolSize: POOL,
      mirror: mirrored ? 1 : 0,
      waterY: WATER_Y,
      sizeScale: 1,
      pad0: 0,
    };
  }

  const sparks = draw(gpu, {
    label: "sparks",
    shader: sparksShader,
    blend: "additive",
    vertices: 6,
    instances: 0,
    set: {
      camera: cameraUniform,
      params: sparkParams(false),
      particles,
    },
  });

  // Same shader, second Draw: the reflection runs in its own pass, and passes
  // in one frame cannot share uniforms.
  const sparksMirror = draw(gpu, {
    label: "sparks-mirror",
    shader: sparksShader,
    blend: "additive",
    vertices: 6,
    instances: 0,
    set: {
      camera: cameraUniform,
      params: sparkParams(true),
      particles,
    },
  });

  const bright = effect(gpu, brightShader, {
    label: "bloom-bright",
    set: {
      scene,
      samp: linear,
      bright: { texel: scene.texelSize, threshold: 0.32, knee: 0.5 },
    },
  });

  // Two instances of one shader: passes in the same frame cannot share
  // uniforms, since `set()` writes land before any of the frame executes.
  const blurH = effect(gpu, blurShader, {
    label: "bloom-blur-h",
    set: {
      src: bloomA,
      samp: linear,
      blur: { step: [bloomA.texelSize[0], 0], spread: 1.35, pad0: 0 },
    },
  });
  const blurV = effect(gpu, blurShader, {
    label: "bloom-blur-v",
    set: {
      src: bloomB,
      samp: linear,
      blur: { step: [0, bloomB.texelSize[1]], spread: 1.35, pad0: 0 },
    },
  });

  const composite = effect(gpu, compositeShader, {
    label: "composite",
    set: {
      scene,
      bloom: bloomA,
      samp: linear,
      composite: {
        bloom: options.spec.look.bloom,
        exposure: options.spec.look.exposure,
        time: 0,
        vignette: 0.55,
        grain: 0.35,
        aberration: 0.004,
        pad0: 0,
        pad1: 0,
      },
    },
  });

  view.onResize((event) => {
    const size = sizeOf([event.width, event.height]);
    scene.resize(size);
    const half = halfOf(size);
    bloomA.resize(half);
    bloomB.resize(half);
    mirror.resize(half);
    camera.set({ aspect: aspectOf(size) });
    if (!cameraTaken) controls.set(openingPose(aspectOf(size)));
    bright.set({
      bright: { texel: scene.texelSize, threshold: 0.32, knee: 0.5 },
    });
    blurH.set({
      blur: { step: [bloomA.texelSize[0], 0], spread: 1.35, pad0: 0 },
    });
    blurV.set({
      blur: { step: [0, bloomB.texelSize[1]], spread: 1.35, pad0: 0 },
    });
  });

  // --- show state ----------------------------------------------------------

  const audio = new ShowAudio();
  audio.onMusicEnd = () => options.onMusicEnd?.();
  const rockets: Rocket[] = [];
  const pending: PendingBurst[] = [];
  const chunks: Chunk[] = [];

  let spec = options.spec;
  let written = 0;
  let oldest = 0;
  let time = 0;
  let paused = false;
  let muted = false;
  let autoFireInterval = 0;
  let autoFireTimer = 0;
  let cues: readonly Cue[] = [];
  let cueCursor = 0;
  let conductor: LiveConductor | null = null;
  let showOptions: ShowOptions & { syncOffset: number } = {
    density: 0.55,
    followColors: true,
    syncOffset: 0,
  };
  let ambientGlow = 0;
  let glowTint: [number, number, number] = [1, 0.7, 0.45];
  /** The most recent breaks, newest first; the water lights from each. */
  const waterLights: WaterLight[] = [];
  let seedCounter = (Math.random() * 0xffff) | 0;
  let disposed = false;
  const stats: RendererStats = { particles: 0, fps: 0, shells: 0 };
  let fpsAccum = 0;
  let fpsFrames = 0;

  /** Hands out the next `count` ring slots and records when they go dark. */
  function reserve(count: number, lifetime: number): number {
    const base = written % POOL;
    written += count;
    chunks.push({ end: written, expiresAt: time + lifetime });
    if (written - oldest > POOL) oldest = written - POOL;
    return base;
  }

  function retireChunks() {
    while (chunks.length && chunks[0].expiresAt <= time) {
      oldest = Math.max(oldest, chunks[0].end);
      chunks.shift();
    }
    if (oldest > written) oldest = written;
  }

  function emitLayer(
    layer: BurstLayer,
    origin: readonly [number, number, number],
    axis: readonly [number, number, number],
    baseVel: readonly [number, number, number],
  ) {
    const count = Math.min(layer.count, POOL);
    if (count <= 0) return;
    const lifetime = layer.life * (1 + layer.lifeJitter) * 2.2 + 0.5;
    const base = reserve(count, lifetime);
    seedCounter = (seedCounter + 0x9e37) >>> 0;

    emitter.set({
      emit: {
        origin,
        count,
        colorA: hexToLinear(layer.colorA),
        base,
        colorB: hexToLinear(layer.colorB),
        pattern: PATTERN_IDS[layer.pattern],
        axis,
        colorMode: COLOR_MODE_IDS[layer.colorMode],
        baseVel,
        poolSize: POOL,
        speed: layer.speed,
        speedJitter: layer.speedJitter,
        life: layer.life,
        lifeJitter: layer.lifeJitter,
        size: layer.size,
        gravity: layer.gravity,
        drag: layer.drag,
        sparkle: layer.sparkle,
        glitter: layer.glitter,
        spin: layer.spin,
        stretch: layer.stretch,
        startRadius: layer.startRadius,
        seed: seedCounter,
        inherit: layer.inherit,
        kind: 0,
        pad0: 0,
      },
      particles,
    });
    emitter.dispatch(Math.ceil(count / WORKGROUP));
  }

  /** Raw emit used for the rising trail and the break flash. */
  function emitEffectParticles(
    pattern: number,
    count: number,
    origin: readonly [number, number, number],
    baseVel: readonly [number, number, number],
    color: readonly [number, number, number],
    opts: {
      speed: number;
      life: number;
      size: number;
      gravity: number;
      drag: number;
      kind: number;
      sparkle?: number;
      stretch?: number;
      inherit?: number;
    },
  ) {
    if (count <= 0) return;
    const base = reserve(count, opts.life * 2 + 0.4);
    seedCounter = (seedCounter + 0x7f4a) >>> 0;
    emitter.set({
      emit: {
        origin,
        count,
        colorA: color,
        base,
        colorB: color,
        pattern,
        axis: [0, 1, 0],
        colorMode: COLOR_MODE_IDS.solid,
        baseVel,
        poolSize: POOL,
        speed: opts.speed,
        speedJitter: 0.5,
        life: opts.life,
        lifeJitter: 0.4,
        size: opts.size,
        gravity: opts.gravity,
        drag: opts.drag,
        sparkle: opts.sparkle ?? 0.5,
        glitter: 0,
        spin: 0,
        stretch: opts.stretch ?? 0.4,
        startRadius: 0,
        seed: seedCounter,
        inherit: opts.inherit ?? 0.4,
        kind: opts.kind,
        pad0: 0,
      },
      particles,
    });
    emitter.dispatch(Math.ceil(count / WORKGROUP));
  }

  /**
   * Fires one shell. `breakIn` overrides the fuse with an exact deadline, which
   * is how a cue lands its break on the beat: the scheduler knows how late in
   * the frame it is, and hands the remaining time straight to the rocket.
   */
  function launchShell(
    design: ShellSpec,
    x?: number,
    z?: number,
    breakIn?: number,
  ) {
    const gravity = Math.max(0.5, design.physics.gravity);
    // Solve for the lift that tops out at the authored apex height.
    const speed = Math.sqrt(2 * gravity * Math.max(1, design.launch.height));
    const tilt = (design.launch.tilt * Math.PI) / 180;
    const azimuth = Math.random() * Math.PI * 2;
    const horizontal = Math.sin(tilt) * speed;

    const rocket: Rocket = {
      x: x ?? (Math.random() - 0.5) * 70,
      y: WATER_Y + 0.4,
      z: z ?? (Math.random() - 0.5) * 40,
      vx: Math.cos(azimuth) * horizontal,
      vy: Math.cos(tilt) * speed,
      vz: Math.sin(azimuth) * horizontal,
      // Apex is v/g; the fuse setting nudges the break either side of it.
      fuse: Math.max(
        0.05,
        breakIn ?? (Math.cos(tilt) * speed) / gravity + design.launch.fuse,
      ),
      spec: design,
      trailDebt: 0,
    };
    rockets.push(rocket);

    if (design.audio.enabled && !muted) {
      audio.resume();
      audio.lift(design.audio.boom * 0.6, rocket.fuse);
    }
  }

  function launch(x?: number, z?: number) {
    launchShell(spec, x, z);
  }

  function breakShell(rocket: Rocket) {
    const design = rocket.spec;
    const origin: [number, number, number] = [rocket.x, rocket.y, rocket.z];
    const velocity: [number, number, number] = [
      rocket.vx,
      rocket.vy,
      rocket.vz,
    ];

    if (design.launch.flash > 0) {
      emitEffectParticles(
        PATTERN_FLASH,
        1,
        origin,
        [0, 0, 0],
        hexToLinear(design.layers.find((l) => l.enabled)?.colorA ?? "#ffffff"),
        {
          speed: 0,
          life: 0.14 + design.launch.flash * 0.1,
          size: 1.4 + design.launch.flash * 2.6,
          gravity: 0,
          drag: 0,
          kind: 2,
          sparkle: 0,
          stretch: 0,
          inherit: 0,
        },
      );
    }

    for (const layer of design.layers) {
      if (!layer.enabled) continue;
      if (layer.delay <= 0) {
        emitLayer(layer, origin, [0, 1, 0], velocity);
      } else {
        pending.push({
          delay: layer.delay,
          layer,
          spec: design,
          x: origin[0],
          y: origin[1],
          z: origin[2],
          vx: velocity[0],
          vy: velocity[1],
          vz: velocity[2],
        });
      }
    }

    // Light bounce for the sky, tinted by whatever broke.
    const firstLayer = design.layers.find((l) => l.enabled);
    if (firstLayer) {
      const [r, g, b] = hexToLinear(firstLayer.colorA);
      const peak = Math.max(r, g, b, 0.0001);
      glowTint = [r / peak, g / peak, b / peak];
      // Bigger breaks light more water. Newest first, so the reflection pass
      // can key its depth off the break most likely to be lit.
      waterLights.unshift({
        pos: [origin[0], origin[1], origin[2]],
        color: glowTint,
        strength:
          Math.min(2.2, 0.45 + firstLayer.count / 4000) *
          (1 + design.launch.flash * 0.3),
        age: 0,
        life: firstLayer.life * (1 + firstLayer.lifeJitter),
      });
      waterLights.length = Math.min(waterLights.length, WATER_LIGHTS);
      // Capped so a barrage cannot stack the horizon glow into daylight.
      ambientGlow = Math.min(
        1.6,
        ambientGlow + 0.5 + design.launch.flash * 0.5,
      );
    }

    if (design.audio.enabled && !muted) {
      const distance = Math.hypot(
        rocket.x - cameraUniform.eye[0],
        rocket.y - cameraUniform.eye[1],
        rocket.z - cameraUniform.eye[2],
      );
      const spread = firstLayer ? Math.min(1, firstLayer.speed / 26) : 0.5;
      audio.boom(design.audio.boom, spread, distance);
      const tail = firstLayer ? Math.min(3, firstLayer.life) : 1;
      audio.crackle(design.audio.crackle, tail, distance);
    }
  }

  function stepShow(dt: number) {
    const gravity = spec.physics.gravity;

    for (let i = rockets.length - 1; i >= 0; i--) {
      const rocket = rockets[i];
      rocket.vy -= gravity * dt;
      rocket.x += rocket.vx * dt;
      rocket.y += rocket.vy * dt;
      rocket.z += rocket.vz * dt;
      rocket.fuse -= dt;

      const rate = rocket.spec.launch.trailRate;
      if (rate > 0) {
        rocket.trailDebt += rate * dt;
        const count = Math.floor(rocket.trailDebt);
        if (count > 0) {
          rocket.trailDebt -= count;
          emitEffectParticles(
            PATTERN_TRAIL,
            count,
            [rocket.x, rocket.y, rocket.z],
            [rocket.vx, rocket.vy, rocket.vz],
            hexToLinear(rocket.spec.launch.trailColor),
            {
              speed: 1.6,
              life: 0.55,
              size: 0.095,
              gravity: 0.35,
              drag: 1.6,
              kind: 1,
              sparkle: 0.7,
              stretch: 0.5,
              inherit: 0.25,
            },
          );
        }
      }

      if (rocket.fuse <= 0 || rocket.y <= WATER_Y) {
        rockets.splice(i, 1);
        if (rocket.y > WATER_Y) breakShell(rocket);
      }
    }

    for (let i = pending.length - 1; i >= 0; i--) {
      const burst = pending[i];
      burst.delay -= dt;
      // Track where the break point would have drifted while the fuse burned.
      burst.x += burst.vx * dt;
      burst.y += burst.vy * dt;
      burst.z += burst.vz * dt;
      burst.vy -= burst.spec.physics.gravity * dt;
      if (burst.delay <= 0) {
        pending.splice(i, 1);
        emitLayer(
          burst.layer,
          [burst.x, burst.y, burst.z],
          [0, 1, 0],
          [burst.vx, burst.vy, burst.vz],
        );
      }
    }

    const songTime = fireCues();
    const live = fireLiveCues();

    // Auto-fire is the idle show. A synced script owns the sky while it plays.
    if (autoFireInterval > 0 && songTime === null && !live) {
      autoFireTimer -= dt;
      if (autoFireTimer <= 0) {
        autoFireTimer = autoFireInterval * (0.7 + Math.random() * 0.6);
        launch();
      }
    }
  }

  /**
   * Launches every cue whose rise window has opened, and returns the song
   * position it worked from (`null` when nothing is playing).
   *
   * Timing comes from `audio.songTime` — the clock the music is actually on —
   * never from the renderer's own accumulated `time`, which drifts against it.
   * The remaining time to the break is passed to the rocket as its fuse, so a
   * frame that ran late still breaks on the beat instead of a frame behind it.
   */
  function fireCues(): number | null {
    const songTime = audio.songTime;
    // A loaded-but-paused track leaves the sky to the idle show.
    if (songTime === null || !audio.musicPlaying) return null;

    while (cueCursor < cues.length) {
      const cue = cues[cueCursor];
      if (cue.launchAt > songTime) break;
      cueCursor++;
      const breakIn = cue.at - songTime;
      // A cue the tab was asleep through is gone; firing it now would break it
      // off the beat, which reads worse than not firing it at all.
      if (breakIn < 0.05) continue;
      launchShell(cue.spec, cue.x, cue.z, breakIn);
    }
    return songTime;
  }

  /**
   * Live audio has no script: the conductor predicts the next beat and hands
   * back the shells that have to leave the mortar this frame to break on it.
   */
  function fireLiveCues(): boolean {
    if (!conductor) return false;
    for (const cue of conductor.update(audio.now, spec)) {
      launchShell(cue.spec, cue.x, cue.z, cue.breakIn);
    }
    return true;
  }

  /** Rewinds the script to wherever the track now is. */
  function seekCues(songTime: number) {
    cueCursor = 0;
    while (cueCursor < cues.length && cues[cueCursor].launchAt < songTime) {
      cueCursor++;
    }
  }

  // --- frame ---------------------------------------------------------------

  const timing = clock(gpu);

  const loop: FrameLoopHandle = frameLoop(gpu, (frame) => {
    // Long frames (a backgrounded tab) would otherwise teleport every spark.
    const dt = Math.min(timing.deltaTime, 0.05);
    controls.update(dt);

    if (!paused) {
      time += dt;
      stepShow(dt);
      retireChunks();
      ambientGlow = Math.max(0, ambientGlow - dt * 1.9);
      for (const light of waterLights) light.age += dt;
      while (
        waterLights.length &&
        waterLightIntensity(waterLights[waterLights.length - 1]) <= 0
      ) {
        waterLights.pop();
      }
    }

    const span = Math.min(written - oldest, POOL);
    const first = oldest % POOL;

    if (!paused && span > 0) {
      sim.set({
        sim: {
          wind: [spec.physics.wind, 0, spec.physics.wind * 0.35],
          dt,
          time,
          gravity: spec.physics.gravity,
          drag: spec.physics.drag,
          turbulence: spec.physics.turbulence,
          groundY: WATER_Y,
          first,
          span,
          poolSize: POOL,
        },
        particles,
      });
      sim.dispatch(Math.ceil(span / WORKGROUP));
    }

    // Camera-derived uniforms. The view matrix's rows are the billboard basis.
    const viewMatrix = camera.view;
    cameraUniform.right = [viewMatrix[0], viewMatrix[4], viewMatrix[8]];
    cameraUniform.up = [viewMatrix[1], viewMatrix[5], viewMatrix[9]];
    const eye = camera.worldPosition;
    cameraUniform.eye = [eye[0], eye[1], eye[2]];
    invertMat4(invViewProj, camera.viewProjection);

    sky.set({
      sky: {
        invViewProj,
        viewProj: camera.viewProjection,
        eye: cameraUniform.eye,
        time,
        haze: spec.look.haze,
        glow: ambientGlow,
        reflection: spec.look.reflection,
        waves: spec.look.waves,
        glowColor: glowTint,
        waterY: WATER_Y,
        pixelAngle: pixelAngleFor(scene.size[1]),
        chop: spec.look.chop,
        ...moonUniform(spec.look),
        ...packWaterLights(waterLights),
      },
    });
    sparks.set({
      camera: cameraUniform,
      params: { ...sparkParams(false), time, first, span },
    });
    sparksMirror.set({
      camera: cameraUniform,
      params: { ...sparkParams(true), time, first, span },
    });
    composite.set({
      composite: {
        bloom: spec.look.bloom,
        exposure: spec.look.exposure,
        time,
        vignette: 0.55,
        grain: 0.35,
        aberration: 0.004,
        pad0: 0,
        pad1: 0,
      },
    });

    // The reflection has to exist before the water that samples it, and the
    // pass runs even with nothing alive so a finished burst does not linger in
    // the water.
    const reflecting = spec.look.reflection > 0 && span > 0;
    frame.pass({ target: mirror, clear: [0, 0, 0, 1] }, (pass) => {
      if (reflecting) pass.draw(sparksMirror, { instances: span });
    });
    frame.pass(scene, sky);
    if (span > 0) {
      frame.pass({ target: scene, clear: false }, (pass) => {
        pass.draw(sparks, { instances: span });
      });
    }
    frame.pass(bloomA, bright);
    frame.pass(bloomB, blurH);
    frame.pass(bloomA, blurV);
    frame.pass(view, composite);

    stats.particles = span;
    stats.shells = rockets.length;
    fpsAccum += dt;
    fpsFrames += 1;
    if (fpsAccum >= 0.5) {
      stats.fps = Math.round(fpsFrames / fpsAccum);
      fpsAccum = 0;
      fpsFrames = 0;
      options.onStats?.({ ...stats });
    }
  });

  const handle: FireworksHandle = {
    setSpec(next) {
      spec = next;
    },
    launch(x, z) {
      audio.resume();
      launch(x, z);
    },
    decode(file) {
      return audio.decode(file);
    },
    setCues(next) {
      cues = next ?? [];
      seekCues(audio.songTime ?? 0);
    },
    playMusic(buffer, offset = 0) {
      audio.resume();
      audio.playMusic(buffer, offset);
      seekCues(offset);
    },
    pauseMusic() {
      audio.pauseMusic();
    },
    resumeMusic() {
      audio.resume();
      audio.resumeMusic();
      seekCues(audio.songTime ?? 0);
    },
    stopMusic() {
      audio.stopMusic();
      cueCursor = 0;
    },
    seekMusic(seconds) {
      audio.seekMusic(seconds);
      seekCues(seconds);
    },
    clearMusic() {
      audio.clearMusic();
      cues = [];
      cueCursor = 0;
    },
    startListening(stream) {
      audio.resume();
      const analyser = audio.listen(stream);
      conductor = new LiveConductor(analyser, showOptions);
    },
    stopListening() {
      conductor = null;
      audio.stopListening();
    },
    setShowOptions(next) {
      showOptions = { ...showOptions, ...next };
      audio.setSyncOffset(showOptions.syncOffset);
      conductor?.setOptions(showOptions);
    },
    get liveState() {
      return conductor?.state ?? null;
    },
    setMusicVolume(value) {
      audio.musicVolume = value;
    },
    get songTime() {
      return audio.songTime;
    },
    get musicPlaying() {
      return audio.musicPlaying;
    },
    setAutoFire(perMinute) {
      autoFireInterval = perMinute > 0 ? 60 / perMinute : 0;
      autoFireTimer = Math.min(autoFireTimer, autoFireInterval || 0);
    },
    setPaused(next) {
      paused = next;
    },
    setMuted(next) {
      muted = next;
      if (!next) audio.resume();
    },
    clear() {
      rockets.length = 0;
      pending.length = 0;
      chunks.length = 0;
      oldest = written;
      ambientGlow = 0;
      waterLights.length = 0;
    },
    get stats() {
      return stats;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      loop.stop();
      controls.dispose();
      audio.dispose();
      gpu.dispose();
    },
  };

  // Clicking the water launches there; dragging is the orbit control's.
  let pointerDownAt: { x: number; y: number } | null = null;
  const onPointerDown = (event: PointerEvent) => {
    pointerDownAt = { x: event.clientX, y: event.clientY };
  };
  const onPointerUp = (event: PointerEvent) => {
    const start = pointerDownAt;
    pointerDownAt = null;
    if (!start) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) {
      // The drag went to the orbit control, so the framing is the viewer's now.
      takeCamera();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((event.clientY - rect.top) / rect.height) * 2;
    const hit = rayPlaneHit(
      invViewProj,
      cameraUniform.eye,
      ndcX,
      ndcY,
      WATER_Y,
    );
    audio.resume();
    if (hit) launch(hit[0], hit[2]);
    else launch();
  };
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointerup", onPointerUp);

  const baseDispose = handle.dispose;
  handle.dispose = () => {
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("wheel", takeCamera);
    baseDispose();
  };

  return handle;
}
