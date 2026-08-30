// Night sky and open-ocean surface maths.
//
// Pure module: no @group/@binding declarations live here, only functions. The
// background pass (`sky.wgsl`) owns the uniforms and the reflection texture and
// composes what this file returns.

import { hashU, rand } from "./common.wgsl";

/// The colour everything converges to at the horizon — sky, water, and haze all
/// meet here, which is what keeps the waterline from reading as a hard seam.
export const HORIZON_FOG = vec3f(0.0075, 0.0115, 0.021);

const TAU: f32 = 6.2831853;
/// Golden angle, used to rotate each wave octave off the last.
const GOLDEN: f32 = 2.3999632;
/// Deep-water dispersion constant. Ties each octave's speed to its wavelength.
const GRAVITY: f32 = 9.81;
/// Rotation applied to the sample plane between wave octaves, ~1.17 rad. The
/// angle is deliberately unrelated to anything else here: octaves that share a
/// rational relationship line back up and the plaid comes straight back.
const OCTAVE_TURN = mat2x2f(0.39015, -0.92074, 0.92074, 0.39015);

export fn starField(dir: vec3f, time: f32) -> vec3f {
  // Quantise the direction into small cells and place at most one star per
  // cell, jittered inside it. The cell has to stay a couple of pixels wide at
  // full resolution, or stars rasterise as visible squares.
  let scaled = dir * 900.0;
  let cell = floor(scaled);
  let id = hashU(bitcast<u32>((i32(cell.x) * 73856093) ^ (i32(cell.y) * 19349663) ^ (i32(cell.z) * 83492791)));
  if ((id % 1000u) > 24u) {
    return vec3f(0.0);
  }

  let jitter = vec3f(rand(id), rand(id ^ 0x1f83c5d1u), rand(id ^ 0x7a3c19bfu)) - 0.5;
  let offset = fract(scaled) - 0.5 - jitter * 0.7;
  let disc = smoothstep(0.34, 0.0, length(offset));
  if (disc <= 0.0) {
    return vec3f(0.0);
  }

  // Squaring the sample skews the population toward faint stars, the way a real
  // magnitude distribution does.
  let magnitude = rand(id ^ 0x2545f491u);
  let brightness = magnitude * magnitude;
  let twinkle = 0.78 + 0.22 * sin(time * 1.7 + f32(id % 617u));
  let tint = mix(vec3f(0.75, 0.83, 1.0), vec3f(1.0, 0.88, 0.72), rand(id ^ 0x68bc21ebu));
  return tint * brightness * twinkle * disc * 2.4;
}

/// The sky without its stars: the gradient, the shore, and the ambient bounce.
/// Split out because the water asks for this several times per pixel and the
/// star field is by far the expensive half.
export fn skyGradient(dir: vec3f, glow: f32, glowColor: vec3f) -> vec3f {
  let h = clamp(dir.y, -1.0, 1.0);
  let zenith = vec3f(0.0014, 0.0030, 0.0098);
  var color = mix(HORIZON_FOG, zenith, smoothstep(-0.02, 0.6, h));
  // Warm light from a shore too far away to see, banked against the horizon.
  color += vec3f(0.042, 0.021, 0.010) * exp(-max(h, 0.0) * 11.0);
  // Ambient bounce from whatever just exploded. Kept well under the star
  // field: it should warm the horizon, never wash the sky out.
  color += glowColor * glow * 0.012 * exp(-max(h, 0.0) * 7.0);
  return color;
}

/// Radiance arriving from `dir`. `starScale` fades the star field out for
/// reflected rays, which a rough surface cannot resolve a point source through;
/// at zero the star field is skipped outright rather than multiplied away.
export fn skyColor(dir: vec3f, time: f32, starScale: f32, glow: f32, glowColor: vec3f) -> vec3f {
  var color = skyGradient(dir, glow, glowColor);
  if (starScale > 0.001) {
    color += starField(dir, time) * smoothstep(0.01, 0.16, clamp(dir.y, -1.0, 1.0)) * starScale;
  }
  return color;
}

/// Slope of the sea surface at `p`, as (dH/dx, dH/dz).
///
/// Each octave is `a * exp(s * (sin(phase) - 1))` — the sharp-crest wave the
/// classic ocean shaders use — so it piles energy into the peaks the way wind
/// waves do while still differentiating in closed form. Deep-water dispersion
/// (`omega = sqrt(g * k)`) gives every octave its own speed, which is what
/// stops the sum from looking like one texture scrolling.
///
/// `detail` is the reciprocal of the pixel footprint on the water. Octaves
/// finer than the footprint can only alias, so they are faded out here and
/// handed to `seaRoughness` as scattering instead.
export fn oceanSlope(p: vec2f, time: f32, chop: f32, detail: f32) -> vec2f {
  var slope = vec2f(0.0);
  var pos = p;
  var wavelength = 68.0;
  var amplitude = 0.72 * chop;
  var angle = 0.9;

  for (var i = 0; i < 8; i = i + 1) {
    // Smoothstep, not a clamp: a hard cut-off makes the octave pop in as a
    // visible ring at whatever distance it crosses the threshold.
    let visible = smoothstep(0.0, 1.0, wavelength * detail);
    if (visible > 0.002) {
      let dir = vec2f(cos(angle), sin(angle));
      let k = TAU / wavelength;
      let omega = sqrt(GRAVITY * k);
      let phase = dot(dir, pos) * k - omega * time;
      // Sharper crests on the short, steep octaves; the long swell stays soft.
      let sharpness = 0.8 + f32(i) * 0.16;
      let shaped = exp(sharpness * (sin(phase) - 1.0));
      slope += dir * (k * amplitude * sharpness * cos(phase) * shaped) * visible;

      // Ride the next octave on this one's back, then turn the sample plane.
      // Seven straight sine ridges crossing at fixed angles read as woven
      // fabric no matter how they are weighted; advecting and rotating the
      // domain between octaves is what turns the sum into water. The advection
      // is also the horizontal half of a Gerstner wave, so it piles the short
      // waves up the face of the long ones the way a real sea does.
      pos = pos - dir * (shaped * amplitude * 1.0 * visible);
    }
    pos = OCTAVE_TURN * pos;
    // The amplitude falls slower than the wavelength, so short waves come out
    // steeper than long ones — which is how a real wind sea is built.
    wavelength *= 0.47;
    amplitude *= 0.47;
    angle += GOLDEN;
  }
  return slope;
}

export fn oceanNormal(slope: vec2f) -> vec3f {
  return normalize(vec3f(-slope.x, 1.0, -slope.y));
}

/// How much of the surface detail the pixel footprint swallowed, 0..1.
///
/// Those facets still scatter light, so the value is fed back as roughness:
/// far water blurs and stretches its reflections instead of mirroring detail it
/// has no resolution for.
export fn seaRoughness(footprint: f32, chop: f32) -> f32 {
  return clamp(footprint * 1.6, 0.0, 1.0) * (0.35 + 0.65 * clamp(chop, 0.0, 1.5));
}

/// One sparse lattice of facet flickers, rotated by `angle`.
fn glintLattice(p: vec2f, angle: f32, time: f32) -> f32 {
  let c = cos(angle);
  let s = sin(angle);
  let q = vec2f(p.x * c - p.y * s, p.x * s + p.y * c);
  let cell = floor(q);
  let seed = hashU(bitcast<u32>((i32(cell.x) * 73856093) ^ (i32(cell.y) * 19349663)));
  return 0.5 + 0.5 * sin(time * (5.0 + rand(seed) * 9.0) + rand(seed ^ 0x9e3779b9u) * 6.2831853);
}

/// Sparse per-facet flicker, 0..~3. Breaks a smooth specular lobe into the
/// individual glints a real sea throws, so a bright source lays down a
/// shimmering path rather than an airbrushed streak.
///
/// `cellSize` is in world units and must track the pixel footprint: facets
/// fixed in world space would swell into visible tiles as they approach the
/// camera, and shrink below one pixel out at the horizon.
export fn seaGlint(p: vec2f, cellSize: f32, time: f32) -> f32 {
  let q = p / max(cellSize, 1e-3) + vec2f(time * 0.4, -time * 0.31);
  // Three lattices at unrelated angles and scales. One alone reads as a tiled
  // floor; the product of three has no axis left to line up on, and the zeros
  // of each are what keep the sparkle sparse.
  let a = glintLattice(q, 0.0, time);
  let b = glintLattice(q * 1.37, 1.04, time * 1.13);
  let c = glintLattice(q * 0.83, 2.31, time * 0.87);
  return pow(a * b * c, 1.5) * 4.0;
}
