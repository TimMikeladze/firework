// Bloom step 1: downsample the HDR scene to half resolution, keeping only what
// is brighter than the threshold. Sampling at half res with a 4-tap box gives a
// free extra blur radius before the separable passes even start.

struct BrightParams {
  /// One source texel, in UV units.
  texel: vec2f,
  /// Luminance below which nothing blooms.
  threshold: f32,
  /// Softness of the threshold knee.
  knee: f32,
}

@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> bright: BrightParams;

fn luminance(color: vec3f) -> f32 {
  return dot(color, vec3f(0.2126, 0.7152, 0.0722));
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let o = bright.texel;
  var sum = textureSampleLevel(scene, samp, uv + vec2f(-o.x, -o.y), 0.0).rgb;
  sum += textureSampleLevel(scene, samp, uv + vec2f(o.x, -o.y), 0.0).rgb;
  sum += textureSampleLevel(scene, samp, uv + vec2f(-o.x, o.y), 0.0).rgb;
  sum += textureSampleLevel(scene, samp, uv + vec2f(o.x, o.y), 0.0).rgb;
  let color = sum * 0.25;

  // Soft knee: fade contribution in around the threshold instead of clipping,
  // so a spark drifting across it does not pop.
  let l = luminance(color);
  let soft = smoothstep(bright.threshold, bright.threshold + bright.knee, l);
  return vec4f(color * soft, 1.0);
}
