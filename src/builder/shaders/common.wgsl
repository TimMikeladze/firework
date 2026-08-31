// Shared types and spark-distribution math for the fireworks builder.
//
// Pure module: no @group/@binding declarations live here, only the struct the
// emit/sim/draw shaders all agree on plus the pattern generators.

/// One spark. 96 bytes, laid out so every vec3f lands on a 16-byte boundary.
export struct Particle {
  pos: vec3f,
  /// Seconds of burn left. <= 0 means the slot is free.
  life: f32,
  vel: vec3f,
  /// Life the spark started with, so shaders can derive normalised age.
  maxLife: f32,
  color: vec3f,
  /// World-space radius.
  size: f32,
  fade: vec3f,
  /// Per-spark air resistance, added to the show's global drag.
  drag: f32,
  /// (gravityScale, sparkle, glitter, seed)
  misc: vec4f,
  /// (stretch, spin, kind, unused)
  extra: vec4f,
}

/// `extra.z` values. Kinds differ only in how the fragment stage shades them.
export const KIND_SPARK: f32 = 0.0;
export const KIND_TRAIL: f32 = 1.0;
export const KIND_FLASH: f32 = 2.0;

export fn hashU(seed: u32) -> u32 {
  var state = seed * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

/// Uniform random in [0, 1) from an integer stream.
export fn rand(seed: u32) -> f32 {
  return f32(hashU(seed)) * 2.3283064e-10;
}

/// Three decorrelated randoms from one stream position.
export fn rand3(seed: u32) -> vec3f {
  return vec3f(rand(seed), rand(seed ^ 0x9e3779b9u), rand(seed ^ 0x85ebca6bu));
}

/// Right-handed basis whose Y axis is `axis`. Used to aim a pattern.
export fn basisFrom(axis: vec3f) -> mat3x3f {
  let up = normalize(axis);
  // Any vector not parallel to `up` seeds the tangent; pick by component.
  let hint = select(vec3f(0.0, 0.0, 1.0), vec3f(1.0, 0.0, 0.0), abs(up.y) < 0.9);
  let right = normalize(cross(hint, up));
  let forward = cross(up, right);
  return mat3x3f(right, up, forward);
}

/// A spark's direction plus the per-pattern scaling the emitter applies on top
/// of the layer's own speed/life/size settings.
export struct SparkSeed {
  dir: vec3f,
  speedScale: f32,
  lifeScale: f32,
  sizeScale: f32,
}

export const PATTERN_SPHERE: u32 = 0u;
export const PATTERN_RING: u32 = 1u;
export const PATTERN_DOUBLE_RING: u32 = 2u;
export const PATTERN_PALM: u32 = 3u;
export const PATTERN_WILLOW: u32 = 4u;
export const PATTERN_CROSSETTE: u32 = 5u;
export const PATTERN_STAR: u32 = 6u;
export const PATTERN_HEART: u32 = 7u;
export const PATTERN_SPIRAL: u32 = 8u;
export const PATTERN_CONE: u32 = 9u;
export const PATTERN_STROBE: u32 = 10u;
export const PATTERN_TRAIL: u32 = 11u;
export const PATTERN_FLASH: u32 = 12u;
export const PATTERN_TRIANGLE: u32 = 13u;

const TAU: f32 = 6.2831853;
/// Golden angle — spaces successive indices as evenly as a sphere allows.
const GOLDEN: f32 = 2.3999632;

/// Evenly distributed point on the unit sphere, +Y as the pole.
fn fibonacciSphere(index: f32, total: f32) -> vec3f {
  let k = (index + 0.5) / max(total, 1.0);
  let y = 1.0 - 2.0 * k;
  let r = sqrt(max(0.0, 1.0 - y * y));
  let phi = index * GOLDEN;
  return vec3f(cos(phi) * r, y, sin(phi) * r);
}

/// Cheap unit vector inside a cone of half-angle `spread` radians around +Y.
fn coneDir(spread: f32, r: vec3f) -> vec3f {
  let cosMax = cos(spread);
  let cosTheta = mix(cosMax, 1.0, r.x);
  let sinTheta = sqrt(max(0.0, 1.0 - cosTheta * cosTheta));
  let phi = r.y * TAU;
  return vec3f(cos(phi) * sinTheta, cosTheta, sin(phi) * sinTheta);
}

/// Places spark `index` of `count` for `pattern`, in the pattern's own space
/// (+Y is the shell axis). `seed` decorrelates repeat launches of one shell.
export fn patternSeed(pattern: u32, index: u32, count: u32, seed: u32) -> SparkSeed {
  let i = f32(index);
  let n = f32(count);
  let r = rand3(seed + index * 7919u);
  var out: SparkSeed;
  out.dir = fibonacciSphere(i, n);
  out.speedScale = 1.0;
  out.lifeScale = 1.0;
  out.sizeScale = 1.0;

  switch pattern {
    case 1u: { // ring — a disc-thin circle, thickened just enough to read as 3D
      let a = (i / n) * TAU;
      let thickness = (r.z - 0.5) * 0.16;
      out.dir = normalize(vec3f(cos(a), thickness, sin(a)));
      out.speedScale = 0.85 + r.x * 0.3;
    }
    case 2u: { // double ring — two orthogonal circles
      let half = n * 0.5;
      let a = (i % half) / half * TAU;
      let thickness = (r.z - 0.5) * 0.12;
      if (i < half) {
        out.dir = normalize(vec3f(cos(a), thickness, sin(a)));
      } else {
        out.dir = normalize(vec3f(thickness, cos(a), sin(a)));
      }
      out.speedScale = 0.85 + r.x * 0.3;
    }
    case 3u: { // palm — a handful of thick fronds, sparse along each stroke
      let fronds = 7u;
      let frond = index % fronds;
      let fr = rand3(seed * 31u + frond * 104729u);
      let axis = normalize(mix(fibonacciSphere(f32(frond), f32(fronds)), vec3f(0.0, 1.0, 0.0), 0.45));
      let jitter = (rand3(seed + index) - 0.5) * 0.16;
      out.dir = normalize(axis + jitter);
      // Sparks spread along the frond instead of sitting on a shell surface.
      out.speedScale = 0.35 + r.x * 0.75 + fr.x * 0.1;
      out.sizeScale = 1.25;
      out.lifeScale = 0.8 + r.y * 0.5;
    }
    case 4u: { // willow — slow, long-lived, drooping
      out.speedScale = 0.45 + r.x * 0.25;
      out.lifeScale = 1.7 + r.y * 0.6;
      out.sizeScale = 0.85;
    }
    case 5u: { // crossette — a few tight clusters that read as separate breaks
      let clusters = 5u;
      let cluster = index % clusters;
      let center = fibonacciSphere(f32(cluster), f32(clusters));
      let local = coneDir(0.34, rand3(seed + index * 2131u));
      let basis = basisFrom(center);
      out.dir = normalize(basis * local);
      out.speedScale = 0.7 + r.x * 0.55;
    }
    case 6u: { // star — five-point outline, facing the shell axis
      let a = (i / n) * TAU;
      let spikes = 5.0;
      let radius = 0.55 + 0.45 * cos(a * spikes);
      let wobble = (r.z - 0.5) * 0.1;
      out.dir = normalize(vec3f(cos(a) * radius, wobble, sin(a) * radius));
      out.speedScale = radius * (0.9 + r.x * 0.2);
    }
    case 7u: { // heart — the classic parametric curve, in the pattern plane
      let t = (i / n) * TAU;
      let x = 16.0 * pow(sin(t), 3.0);
      let y = 13.0 * cos(t) - 5.0 * cos(2.0 * t) - 2.0 * cos(3.0 * t) - cos(4.0 * t);
      let p = vec2f(x, y) / 17.0;
      let wobble = (r.z - 0.5) * 0.1;
      out.dir = normalize(vec3f(p.x, p.y, wobble));
      out.speedScale = length(p) * (0.95 + r.x * 0.15);
    }
    case 8u: { // spiral — a helix wound around the shell axis
      let turns = 5.0;
      let t = i / n;
      let a = t * TAU * turns;
      let y = 1.0 - 2.0 * t;
      let radius = sqrt(max(0.0, 1.0 - y * y));
      out.dir = normalize(vec3f(cos(a) * radius, y, sin(a) * radius));
      out.speedScale = 0.8 + t * 0.4;
    }
    case 9u: { // cone — a directed jet, for comets and mines
      out.dir = coneDir(0.42, r);
      out.speedScale = 0.55 + r.z * 0.7;
      out.sizeScale = 1.1;
    }
    case 10u: { // strobe — sparse, hanging, violently flickering
      out.speedScale = 0.2 + r.x * 0.95;
      out.lifeScale = 0.7 + r.y * 1.4;
      out.sizeScale = 1.5;
    }
    case 11u: { // trail — the shell's own rising sparks
      out.dir = normalize(fibonacciSphere(i, n) + (r - 0.5) * 1.4);
      out.speedScale = 0.15 + r.x * 0.5;
      out.lifeScale = 0.3 + r.y * 0.5;
      out.sizeScale = 0.7;
    }
    case 13u: { // triangle — an equilateral outline, apex up, edges dead straight
      // Perimeter-uniform: the index walks the three edges end to end, and the
      // spark flies radially to a distance proportional to how far out the
      // outline is at that point, so the corners reach twice the mid-edge and
      // the sides stay straight instead of bowing into an arc.
      let t = i / n;
      let edge = floor(t * 3.0);
      let along = fract(t * 3.0);
      let a0 = TAU * 0.25 + edge * (TAU / 3.0);
      let a1 = a0 + TAU / 3.0;
      let corner = mix(vec2f(cos(a0), sin(a0)), vec2f(cos(a1), sin(a1)), along);
      let wobble = (r.z - 0.5) * 0.08;
      out.dir = normalize(vec3f(corner.x, corner.y, wobble));
      out.speedScale = length(corner) * (0.96 + r.x * 0.08);
    }
    case 12u: { // flash — one fat, instant bloom at the break point
      out.dir = vec3f(0.0, 1.0, 0.0);
      out.speedScale = 0.0;
      out.lifeScale = 1.0;
      out.sizeScale = 1.0;
    }
    default: { // sphere — the peony, and the fallback for anything unknown
      out.speedScale = 0.92 + r.x * 0.16;
    }
  }
  return out;
}

/// Hue-cycled palette for `rainbow` layers. `t` wraps every 1.0.
export fn rainbow(t: f32) -> vec3f {
  let phase = fract(t) * TAU;
  return vec3f(
    0.5 + 0.5 * cos(phase),
    0.5 + 0.5 * cos(phase - 2.094),
    0.5 + 0.5 * cos(phase - 4.188),
  );
}
