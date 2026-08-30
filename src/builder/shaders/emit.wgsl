// Spawns one burst layer into the particle ring buffer.
//
// One dispatch per layer per break: the CPU owns nothing but the ring cursor,
// so a 10,000-spark chrysanthemum costs one uniform write and one dispatch.

import { Particle, SparkSeed, basisFrom, patternSeed, rand3, rainbow } from "./common.wgsl";

struct EmitParams {
  /// World-space break point.
  origin: vec3f,
  /// Sparks to write. Invocations past this return immediately.
  count: u32,
  colorA: vec3f,
  /// First ring-buffer slot this layer owns.
  base: u32,
  colorB: vec3f,
  pattern: u32,
  /// Shell axis the pattern is aimed along.
  axis: vec3f,
  colorMode: u32,
  /// Velocity of whatever spawned this layer, for `inherit`.
  baseVel: vec3f,
  poolSize: u32,
  speed: f32,
  speedJitter: f32,
  life: f32,
  lifeJitter: f32,
  size: f32,
  gravity: f32,
  drag: f32,
  sparkle: f32,
  glitter: f32,
  spin: f32,
  stretch: f32,
  startRadius: f32,
  seed: u32,
  inherit: f32,
  kind: f32,
  pad0: f32,
}

@group(0) @binding(0) var<uniform> emit: EmitParams;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;

// Colour modes, matching COLOR_MODE_IDS in spec.ts:
//   0 solid, 1 fade, 2 bicolor, 3 rainbow.
// Written as literals because switch labels must be constant expressions that
// survive the module resolver's dead-code pass.

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= emit.count) {
    return;
  }

  let spark: SparkSeed = patternSeed(emit.pattern, index, emit.count, emit.seed);
  let basis = basisFrom(emit.axis);
  let dir = normalize(basis * spark.dir);
  let r = rand3(emit.seed * 6151u + index * 2654435761u);

  let speed = emit.speed * spark.speedScale * (1.0 + (r.x - 0.5) * 2.0 * emit.speedJitter);
  let life = max(0.05, emit.life * spark.lifeScale * (1.0 + (r.y - 0.5) * 2.0 * emit.lifeJitter));
  // Swirl is tangential to the shell axis, so it reads as rotation, not spread.
  let swirl = cross(normalize(emit.axis), dir) * emit.spin;

  var colorA = emit.colorA;
  var colorB = emit.colorB;
  switch emit.colorMode {
    case 0u: { // solid
      colorB = colorA;
    }
    case 2u: { // bicolor
      // Alternating sparks, not alternating halves: the two colours interleave
      // across the whole break instead of splitting it in two.
      let flip = (index & 1u) == 1u;
      let picked = select(colorA, colorB, flip);
      colorA = picked;
      colorB = picked;
    }
    case 3u: { // rainbow
      let t = f32(index) / f32(max(emit.count, 1u));
      colorA = rainbow(t + f32(emit.seed % 997u) * 0.001);
      colorB = rainbow(t + 0.28);
    }
    default: {} // fade keeps colorA -> colorB as authored.
  }

  var p: Particle;
  p.pos = emit.origin + dir * emit.startRadius;
  p.life = life;
  p.vel = dir * speed + emit.baseVel * emit.inherit + swirl;
  p.maxLife = life;
  p.color = colorA;
  p.size = emit.size * spark.sizeScale * (0.75 + r.z * 0.5);
  p.fade = colorB;
  p.drag = emit.drag;
  p.misc = vec4f(emit.gravity, emit.sparkle, emit.glitter, r.z * 64.0);
  p.extra = vec4f(emit.stretch, emit.spin, emit.kind, 0.0);

  particles[(emit.base + index) % emit.poolSize] = p;
}
