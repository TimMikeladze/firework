// Night sky and open-water surface maths.
//
// Pure module: no @group/@binding declarations live here, only functions. The
// background pass (`sky.wgsl`) owns the uniforms and the reflection texture and
// composes what this file returns.

import { hashU, rand } from "./common.wgsl";

/// The colour everything converges to at the horizon — sky, water, and haze all
/// meet here, which is what keeps the waterline from reading as a hard seam.
export const HORIZON_FOG = vec3f(0.0075, 0.0115, 0.021);

const PI: f32 = 3.14159265;
const TAU: f32 = 6.2831853;
/// Deep-water dispersion constant. Ties each octave's speed to its wavelength.
const GRAVITY: f32 = 9.81;

/// Wave octaves in the spectrum. The longest is a 64 m swell, the shortest a
/// 10 cm capillary ripple; anything finer than that lives in `alpha0`.
export const OCTAVES: i32 = 15;
/// Octaves the parallax correction bothers with: the swell is what displaces
/// the ray, the ripples only tilt it.
export const SWELL_OCTAVES: i32 = 5;
const LONGEST: f32 = 64.0;
/// Wavelength ratio between octaves. Irrational enough that no two octaves
/// share a harmonic and line back up into a lattice.
const RATIO: f32 = 0.6435;
/// Where the wind blows from. World space, unit. Waves run along it, which is
/// toward the default camera: a sea seen along its swell reads as depth, one
/// seen across it reads as stripes.
const WIND = vec2f(0.3162, 0.9487);
/// Microfacet roughness floor: capillary waves below the last octave, plus
/// every facet too small for even the nearest pixel to resolve. Cox–Munk
/// measured a slope variance of 0.003 + 0.005 U for wind speed U, nearly all
/// of it in ripples under a centimetre — so most of the sea's roughness is
/// always sub-pixel, and this floor carries it. Scaled by the sea state.
const ALPHA0: f32 = 0.05;

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

/// Everything the surface knows about itself at one point.
export struct Wave {
  /// Height above the water plane.
  height: f32,
  /// (dH/dx, dH/dz).
  slope: vec2f,
  /// Slope variance the pixel footprint swallowed, summed over the faded
  /// octaves. Comes back as microfacet roughness.
  variance: f32,
}

/// Direction of octave `i`: the wind, spread by a per-octave angle that widens
/// as the waves shorten. Swell is coherent and runs with the wind; the ripples
/// on top of it scatter across a wide fan, which is what a real directional
/// spectrum looks like and what keeps the sum from reading as one texture.
fn octaveDir(i: i32) -> vec2f {
  let spread = 0.28 + f32(i) * 0.11;
  let turn = (rand(u32(i) * 0x9e3779b9u + 0x7f4a7c15u) - 0.5) * 2.0 * spread;
  let c = cos(turn);
  let s = sin(turn);
  return vec2f(WIND.x * c - WIND.y * s, WIND.x * s + WIND.y * c);
}

/// The sea at `p`, summed over the first `octaves` of the spectrum.
///
/// Each octave is `a * exp(s * (sin(phase) - 1))` — the sharp-crest wave the
/// classic ocean shaders use — so it piles energy into the peaks the way wind
/// waves do while still differentiating in closed form. Deep-water dispersion
/// (`omega = sqrt(g * k)`) gives every octave its own speed, which is what
/// stops the sum from looking like one texture scrolling. Steepness (`k * a`)
/// is held nearly constant across the spectrum, rising a little toward the
/// short end: that is the shape of a wind sea, and it is why the surface has
/// the same texture at every scale instead of one dominant ripple size.
///
/// `footprint` is the pixel's size on the water. Octaves shorter than a few
/// footprints can only alias, so they fade out and their slope energy is
/// handed back as `variance` instead: far water is smooth to the eye but
/// rough to the light, which is exactly what a real sea does at a distance.
export fn oceanWave(p: vec2f, time: f32, chop: f32, footprint: f32, octaves: i32) -> Wave {
  var out: Wave;
  out.height = 0.0;
  out.slope = vec2f(0.0);
  out.variance = 0.0;

  var pos = p;
  var wavelength = LONGEST;
  for (var i = 0; i < octaves; i = i + 1) {
    let k = TAU / wavelength;
    // Slope amplitude. The swell is gentle and the ripples steep, so most of
    // the slope variance — the glitter — comes from the short end.
    let steepness = chop * (0.024 + 0.0045 * f32(i));
    let amplitude = steepness / k;

    // Two pixels per wavelength is the Nyquist limit; fade from there to a
    // comfortable six. Smoothstep, not a clamp: a hard cut-off makes the
    // octave pop in as a visible ring at whatever distance it crosses.
    let visible = smoothstep(2.0, 6.0, wavelength / max(footprint, 1e-4));
    // Mean square of `cos * shaped * envelope` over a period, ~0.2: the slope
    // energy the faded part of this octave would have carried.
    out.variance += 0.2 * steepness * steepness * (1.0 - visible) * (1.0 + visible);

    if (visible > 0.002) {
      let dir = octaveDir(i);
      let perp = vec2f(-dir.y, dir.x);
      let omega = sqrt(GRAVITY * k);
      let along = dot(dir, pos);
      let phase = along * k - omega * time + f32(i) * 1.7;
      // Sharper crests on the short, steep octaves; the long swell stays soft.
      let sharpness = 0.9 + f32(i) * 0.12;
      let shaped = exp(sharpness * (sin(phase) - 1.0));

      // Wave groups. An infinite sinusoid is a ridge the eye follows for
      // miles; real crests run a few wavelengths across and a train of them
      // lasts a few wavelengths along, travelling at the group velocity of
      // half the phase speed. Two slow sines, one along the crest and one
      // along the travel, cut the ridges into the short-crested lumps a sea is
      // actually made of. The envelope is differentiated along with the wave
      // so the slope stays the true gradient of the height.
      let groupAcross = dot(perp, pos) * k * 0.23 + f32(i) * 2.1;
      let groupAlong = (along * k - omega * time * 0.5) * 0.11 + f32(i) * 0.7;
      let envAcross = 0.6 + 0.4 * sin(groupAcross);
      let envAlong = 0.6 + 0.4 * sin(groupAlong);
      let envelope = envAcross * envAlong;
      let envelopeGrad = perp * (0.4 * cos(groupAcross) * k * 0.23 * envAlong)
        + dir * (0.4 * cos(groupAlong) * k * 0.11 * envAcross);

      out.height += amplitude * (shaped - 0.45) * envelope * visible;
      out.slope += (dir * (steepness * sharpness * cos(phase) * shaped) * envelope
        + envelopeGrad * (amplitude * (shaped - 0.45))) * visible;

      // Ride the next octave on this one's back: the horizontal half of a
      // Gerstner wave, so the short waves pile up the face of the long ones the
      // way a real sea does instead of sitting on it like a decal.
      pos -= dir * (shaped * envelope * amplitude * 0.8 * visible);
    }
    wavelength *= RATIO;
  }
  return out;
}

/// Height only, over the long octaves. The parallax correction calls this
/// two or three times per pixel, so it stays cheap.
export fn oceanHeight(p: vec2f, time: f32, chop: f32, footprint: f32) -> f32 {
  return oceanWave(p, time, chop, footprint, SWELL_OCTAVES).height;
}

export fn oceanNormal(slope: vec2f) -> vec3f {
  return normalize(vec3f(-slope.x, 1.0, -slope.y));
}

/// GGX roughness for a facet whose sub-pixel structure carried `variance` of
/// slope. Beckmann's `m = sqrt(2) * sigma` is close enough for GGX, summed in
/// quadrature with the floor the spectrum never resolves.
export fn seaAlpha(variance: f32, chop: f32) -> f32 {
  let floor = ALPHA0 * (0.5 + 0.8 * chop);
  return clamp(sqrt(floor * floor + 2.0 * variance), floor, 0.7);
}

/// One layer of glint noise over a lattice `q` already scaled to cells. Each
/// cell blinks on its own clock, the way one facet rocks through alignment.
fn glintLayer(q: vec2f, time: f32, salt: u32) -> f32 {
  let cell = floor(q);
  let seed = hashU(bitcast<u32>((i32(cell.x) * 73856093) ^ (i32(cell.y) * 19349663)) ^ salt);
  let rate = 8.0 + rand(seed) * 14.0;
  let blink = 0.5 + 0.5 * sin(time * rate + rand(seed ^ 0x9e3779b9u) * TAU);
  // Fourth power: a facet is aligned for a small fraction of its rock, so most
  // cells are dark at any instant and the lit ones are bright.
  let b2 = blink * blink;
  return b2 * b2;
}

/// Stochastic glints, mean 1. Multiplies the smooth specular lobe.
///
/// The lobe is the *expected* reflection from the facets a pixel covers. When
/// the source is small and the pixel holds only a handful of facets, the
/// actual number aligned at any instant is a small Poisson count, and that
/// variance is the sparkle — bright points that blink in and out — rather than
/// the airbrushed streak the expectation alone would draw. `across` and
/// `along` are the pixel footprint on the water in the two screen directions,
/// so a cell is one pixel whatever the distance and the glints neither swell
/// into tiles nearby nor alias into shimmer far out. The lattice drifts with
/// the wind at a ripple's pace so the sparkle rides the water instead of
/// being pinned to it.
export fn seaGlint(p: vec2f, viewXZ: vec2f, across: f32, along: f32, time: f32) -> f32 {
  let drift = p + WIND * time * 0.35;
  let perp = vec2f(-viewXZ.y, viewXZ.x);
  let q = vec2f(dot(drift, perp) / max(across, 1e-3), dot(drift, viewXZ) / max(along, 1e-3));
  // Two lattices at unrelated scales and angles: one alone reads as a grid.
  let a = glintLayer(q, time, 0x2545f491u);
  let b = glintLayer(vec2f(q.x * 0.71 + q.y * 0.53, q.y * 0.71 - q.x * 0.53) * 1.37, time * 1.13, 0x68bc21ebu);
  // Each layer averages 35/128; the product of two independent ones ~0.0748.
  return a * b * 13.37;
}

/// The break's light scattered by the haze around it: the lit smoke and damp
/// air every firework photograph shows as a soft halo. `toLight` is the unit
/// direction from the eye to the break. A Lorentzian in the angle, which has
/// the long tail of real forward scattering without a bright core — the
/// break itself supplies that.
export fn breakHalo(dir: vec3f, toLight: vec3f, intensity: f32, haze: f32) -> f32 {
  let cosine = clamp(dot(dir, toLight), -1.0, 1.0);
  let angle2 = 2.0 * (1.0 - cosine);
  return intensity * (0.15 + 0.85 * haze) * 0.0016 / (angle2 + 0.006);
}

/// Schlick's Fresnel for water. `F0 = 0.02` is the real number for
/// n = 1.333; a mirror at grazing, all but transparent head-on.
export fn fresnelWater(cosTheta: f32) -> f32 {
  let f = pow(1.0 - clamp(cosTheta, 0.0, 1.0), 5.0);
  return 0.02 + 0.98 * f;
}

/// GGX normal distribution.
export fn ggxD(ndoth: f32, alpha: f32) -> f32 {
  let a2 = alpha * alpha;
  let d = ndoth * ndoth * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}

/// Height-correlated Smith visibility, `G / (4 NdotL NdotV)`. The grazing view
/// the water is always seen at makes this the term that decides how bright the
/// light path is — without it the specular blows up as `NdotV` goes to zero.
export fn ggxVisibility(ndotl: f32, ndotv: f32, alpha: f32) -> f32 {
  let a2 = alpha * alpha;
  let gv = ndotl * sqrt(ndotv * ndotv * (1.0 - a2) + a2);
  let gl = ndotv * sqrt(ndotl * ndotl * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-5);
}
