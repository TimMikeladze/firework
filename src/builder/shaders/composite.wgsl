// Final pass: scene + bloom, exposed, tonemapped, and dressed with the small
// lens artefacts that sell a night photograph — vignette, grain, and a touch of
// chromatic aberration that only the bloom carries.

struct CompositeParams {
  /// Multiplier on the blurred bright pass.
  bloom: f32,
  exposure: f32,
  time: f32,
  /// 0..1 — corner darkening.
  vignette: f32,
  /// 0..1 — film grain amount.
  grain: f32,
  /// UV offset per channel for the bloom's chromatic split.
  aberration: f32,
  pad0: f32,
  pad1: f32,
}

@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var bloom: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> composite: CompositeParams;

fn luminance(color: vec3f) -> f32 {
  return dot(color, vec3f(0.2126, 0.7152, 0.0722));
}

/// Narkowicz's ACES approximation — cheap, and it keeps saturated highlights
/// from turning white the instant a burst overlaps itself.
fn tonemapAces(x: vec3f) -> vec3f {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}

fn hash12(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

/// Tonemaps toward the shell's own colour instead of toward white.
///
/// Per-channel ACES drives a bright gold star to (1,1,1) — every shell ends up
/// the same colour at its core. Scaling by the tonemapped *luminance* keeps the
/// hue instead; blending the two keeps that from turning genuinely
/// overexposed highlights into flat, posterised colour.
fn tonemap(color: vec3f) -> vec3f {
  let perChannel = tonemapAces(color);
  let l = luminance(color);
  let huePreserving = color * (tonemapAces(vec3f(l)).x / max(l, 0.0001));
  return clamp(mix(perChannel, huePreserving, 0.65), vec3f(0.0), vec3f(1.0));
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let centered = uv - 0.5;
  let base = textureSampleLevel(scene, samp, uv, 0.0).rgb;

  // Split the bloom's channels along the radius: strongest at the frame edge.
  let shift = centered * composite.aberration;
  let glowR = textureSampleLevel(bloom, samp, uv + shift, 0.0).r;
  let glowG = textureSampleLevel(bloom, samp, uv, 0.0).g;
  let glowB = textureSampleLevel(bloom, samp, uv - shift, 0.0).b;
  let glow = vec3f(glowR, glowG, glowB);

  var color = base + glow * composite.bloom;
  color *= composite.exposure;
  color = tonemap(color);

  let radius = length(centered * vec2f(1.08, 1.0));
  color *= mix(1.0, smoothstep(0.95, 0.28, radius), composite.vignette);

  let noise = hash12(uv * 1024.0 + fract(composite.time) * 71.0) - 0.5;
  color += noise * composite.grain * 0.055;

  // The swapchain format is plain (non-sRGB) bgra/rgba, so encode by hand.
  return vec4f(pow(max(color, vec3f(0.0)), vec3f(1.0 / 2.2)), 1.0);
}
