// Bloom step 2: one half of a separable Gaussian.
//
// The renderer creates two Effects from this file — a horizontal one and a
// vertical one — because two passes in the same frame cannot share uniforms:
// `set()` writes immediately, so the second write would win for both.

struct BlurParams {
  /// Step between taps in UV units; the direction is baked into this vector.
  step: vec2f,
  /// Extra radius multiplier, so wide bloom does not need more taps.
  spread: f32,
  pad0: f32,
}

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> blur: BlurParams;

// Nine-tap Gaussian collapsed to five samples: linear filtering fetches each
// pair of neighbours in one tap, at a weighted offset between them.
const OFFSETS = array<f32, 3>(0.0, 1.3846153846, 3.2307692308);
const WEIGHTS = array<f32, 3>(0.2270270270, 0.3162162162, 0.0702702703);

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let step = blur.step * blur.spread;
  var color = textureSampleLevel(src, samp, uv, 0.0).rgb * WEIGHTS[0];
  for (var i = 1u; i < 3u; i += 1u) {
    let offset = step * OFFSETS[i];
    color += textureSampleLevel(src, samp, uv + offset, 0.0).rgb * WEIGHTS[i];
    color += textureSampleLevel(src, samp, uv - offset, 0.0).rgb * WEIGHTS[i];
  }
  return vec4f(color, 1.0);
}
