// Background: night sky, star field, and the open water the show reflects in.
// Drawn as a fullscreen effect before the sparks, so it doubles as the clear for
// the HDR scene target.

import { hashU, rand } from "./common.wgsl";

struct SkyParams {
  /// Inverse of the camera's view-projection, for reconstructing view rays.
  invViewProj: mat4x4f,
  eye: vec3f,
  time: f32,
  /// 0..1 — smoke and haze sitting on the water.
  haze: f32,
  /// Ambient light the recent breaks are throwing onto the scene.
  glow: f32,
  pad0: f32,
  pad1: f32,
  /// Colour of that ambient light, taken from whatever just broke.
  glowColor: vec3f,
  pad2: f32,
}

@group(0) @binding(0) var<uniform> sky: SkyParams;

const HORIZON_FOG = vec3f(0.0075, 0.0115, 0.021);

fn starField(dir: vec3f) -> vec3f {
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
  let twinkle = 0.78 + 0.22 * sin(sky.time * 1.7 + f32(id % 617u));
  let tint = mix(vec3f(0.75, 0.83, 1.0), vec3f(1.0, 0.88, 0.72), rand(id ^ 0x68bc21ebu));
  return tint * brightness * twinkle * disc * 2.4;
}

fn skyColor(dir: vec3f, starScale: f32) -> vec3f {
  let h = clamp(dir.y, -1.0, 1.0);
  let zenith = vec3f(0.0014, 0.0030, 0.0098);
  var color = mix(HORIZON_FOG, zenith, smoothstep(-0.02, 0.6, h));
  color += starField(dir) * smoothstep(0.01, 0.16, h) * starScale;
  // Warm light from a shore too far away to see, banked against the horizon.
  color += vec3f(0.042, 0.021, 0.010) * exp(-max(h, 0.0) * 11.0);
  // Ambient bounce from whatever just exploded. Kept well under the star
  // field: it should warm the horizon, never wash the sky out.
  color += sky.glowColor * sky.glow * 0.012 * exp(-max(h, 0.0) * 7.0);
  return color;
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  // `uv` is top-origin, so v grows downward; NDC y is the flip of that.
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let farPoint = sky.invViewProj * vec4f(ndc, 1.0, 1.0);
  let dir = normalize(farPoint.xyz / farPoint.w - sky.eye);

  var color: vec3f;
  if (dir.y >= 0.0) {
    color = skyColor(dir, 1.0);
  } else {
    // Water: mirror the sky, roughen it, and let distance wash it out.
    let ripple = sin(dir.x * 90.0 + sky.time * 1.4) * 0.004
      + sin(dir.z * 61.0 - sky.time * 1.1) * 0.003;
    let mirrored = normalize(vec3f(dir.x, -dir.y + ripple, dir.z));
    let reflected = skyColor(mirrored, 0.25) * vec3f(0.55, 0.68, 0.9);
    // Fresnel: grazing angles mirror, steep ones look into dark water.
    let fresnel = pow(1.0 - min(1.0, -dir.y * 3.2), 3.0);
    color = mix(vec3f(0.002, 0.004, 0.010), reflected, clamp(fresnel, 0.0, 1.0));
    color += vec3f(0.022, 0.013, 0.006) * exp(dir.y * 24.0);
  }

  // Haze band hugging the horizon, thickest right at eye level.
  let band = exp(-abs(dir.y) * 26.0);
  color = mix(color, HORIZON_FOG * 1.6, band * sky.haze * 0.55);

  return vec4f(color, 1.0);
}
