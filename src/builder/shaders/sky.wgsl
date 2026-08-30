// Background: night sky, star field, and the open water the show reflects in.
// Drawn as a fullscreen effect before the sparks, so it doubles as the clear for
// the HDR scene target.
//
// The water is a real ray-plane intersection, not a mirrored ray: every pixel
// below the horizon knows where on the sea it landed and how far away that is,
// which is what lets the wave detail, the reflection sharpness, and the fog all
// fall out of the same distance.

import { HORIZON_FOG, oceanNormal, oceanSlope, seaGlint, seaRoughness, skyColor, skyGradient } from "./water.wgsl";

struct SkyParams {
  /// Inverse of the camera's view-projection, for reconstructing view rays.
  invViewProj: mat4x4f,
  eye: vec3f,
  time: f32,
  /// 0..1 — smoke and haze sitting on the water.
  haze: f32,
  /// Ambient light the recent breaks are throwing onto the scene.
  glow: f32,
  /// 0..1 — how much of the show the water throws back.
  reflection: f32,
  /// 0..1 — sea state. 0 is a still pond, 1 is a choppy swell.
  waves: f32,
  /// Colour of that ambient light, taken from whatever just broke.
  glowColor: vec3f,
  /// Height of the water plane in world space.
  waterY: f32,
  /// Where the last break happened, so the water can light from it directly.
  glowPos: vec3f,
  pad0: f32,
}

@group(0) @binding(0) var<uniform> sky: SkyParams;
/// The show mirrored through the water plane, drawn with this same camera.
@group(0) @binding(1) var mirror: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

/// Colour of the sea where the view ray `dir` hits it. `uv` is the pixel's own
/// screen coordinate, which is where the mirror target is sampled from.
fn waterColor(dir: vec3f, uv: vec2f) -> vec3f {
  // Distance to the plane. `dir` is unit, so it doubles as the travel length.
  // The clamp keeps rays that graze the horizon from running to infinity.
  let dist = (sky.waterY - sky.eye.y) / min(dir.y, -0.0008);
  let hit = sky.eye + dir * dist;

  // Pixel footprint on the water: the ray cone widens with distance and lands
  // at a grazing angle, which stretches it further along the view direction.
  let footprint = dist * 0.0016 / max(0.012, -dir.y);
  let detail = 1.0 / max(footprint * 3.2, 1e-4);

  let chop = 0.22 + sky.waves * 1.05;
  let slope = oceanSlope(hit.xz, sky.time, chop, detail);
  let normal = oceanNormal(slope);
  let roughness = seaRoughness(footprint, chop);

  // Schlick against the wave normal, not the flat plane: crests tipped toward
  // the camera go dark while their backs mirror, and that difference is most of
  // what reads as water rather than as a mirror.
  let cosIncidence = clamp(dot(-dir, normal), 0.0, 1.0);
  let fresnel = clamp(0.02 + 0.98 * pow(1.0 - cosIncidence, 5.0), 0.0, 1.0);

  // Sky half of the reflection, evaluated analytically so it distorts with the
  // real per-pixel normal. A crest can bend the ray below the horizon; flatten
  // those back to grazing rather than returning black.
  let bounced = reflect(dir, normal);
  let skyDir = normalize(vec3f(bounced.x, max(bounced.y, 0.003), bounced.z));
  // Cooled a little. A mirror does not tint, but the sea is never a clean one:
  // the light that comes back has been through the top of the water column,
  // which eats the red end first.
  let mirrored = skyColor(skyDir, sky.time, mix(0.5, 0.0, roughness), sky.glow, sky.glowColor)
    * vec3f(0.82, 0.90, 1.04);

  // Show half of the reflection. The mirror target holds the sparks reflected
  // through the plane and drawn with this camera, so flat water would sample it
  // at exactly this pixel. Splitting the slope into the components along and
  // across the view direction displaces the sample instead: tipping a crest
  // toward the camera slides the image up the screen, which is what smears a
  // single burst into a long shimmering path.
  let viewXZ = normalize(vec2f(dir.x, dir.z) + vec2f(1e-5, 0.0));
  let along = dot(slope, viewXZ);
  let across = dot(slope, vec2f(-viewXZ.y, viewXZ.x));
  // `uv` grows downward, hence the sign on the vertical term.
  let bend = vec2f(across * 0.16, -along * 0.55) * mix(0.5, 1.0, roughness);

  // Taps run up the screen from the sample point, which drags the mirrored
  // burst down toward the camera: that one-sided smear is the glitter path a
  // point source lays across open water, and it is why the reflection is a
  // shimmering column rather than a second copy of the burst.
  let smear = 0.004 + roughness * 0.055;
  var show = vec3f(0.0);
  var weight = 0.0;
  for (var i = 0; i < 6; i = i + 1) {
    let w = 1.0 / (1.0 + f32(i) * 0.85);
    let offset = bend - vec2f(0.0, f32(i) * smear);
    let tap = clamp(uv + offset, vec2f(0.002), vec2f(0.998));
    show += textureSampleLevel(mirror, samp, tap, 0.0).rgb * w;
    weight += w;
  }
  show *= sky.reflection / weight;

  // The break as a point light, for everything the reflection alone cannot do.
  let toLight = sky.glowPos - hit;
  let lightDist = max(length(toLight), 1.0);
  let lightDir = toLight / lightDist;
  // Inverse-square, so a break genuinely lights the patch of sea beneath it and
  // leaves the rest of the bay dark.
  let falloff = sky.glow * 260.0 / (lightDist * lightDist);

  // Deep water at night is nearly black. What little comes back from below the
  // surface is the break's light, scattered back up through the top of the
  // water column — which is why it arrives green-blue however warm the shell.
  let deep = vec3f(0.0012, 0.0044, 0.0079);
  let subsurface = sky.glowColor * vec3f(0.35, 0.8, 1.0)
    * falloff * max(lightDir.y, 0.0) * (0.35 + 0.65 * max(normal.y, 0.0));

  var color = mix(deep + subsurface, mirrored, fresnel);
  // The show reflects a little even head-on — a bright source over dark water
  // is visible at any angle — so the Fresnel term only weights it, never gates
  // it entirely.
  color += show * (0.6 + 0.8 * fresnel);

  // Specular from that same light. The mirror target gives the reflection its
  // shape; this gives it the long shimmering path a sea lays under any bright
  // source. No screen-space smear can fake that path — it exists because facets
  // all the way back to the camera happen to catch the light, not because the
  // image is blurred.
  if (sky.glow > 0.0 && lightDir.y > 0.0) {
    let halfway = normalize(lightDir - dir);
    let ndoth = max(dot(normal, halfway), 0.0);
    // GGX, roughened by exactly what the level of detail threw away: near water
    // resolves its own facets and wants a tight lobe, far water has to stand in
    // for the ones it dropped.
    let alpha = clamp(0.035 + roughness * 0.36, 0.02, 0.6);
    let a2 = alpha * alpha;
    let denom = ndoth * ndoth * (a2 - 1.0) + 1.0;
    var glint = a2 / (3.14159265 * denom * denom);
    glint *= fresnel * falloff * 2.7;
    glint *= 0.18 + seaGlint(hit.xz, max(footprint * 2.4, 0.04), sky.time);
    color += sky.glowColor * min(glint, 40.0);
  }

  // Distance fog. The far water fades toward the sky immediately above the
  // waterline in the same compass direction, not toward a constant: mixing to a
  // flat colour leaves a visible seam wherever the sky is warmer or cooler than
  // it, which is exactly along the horizon where the eye is looking.
  let horizon = skyGradient(normalize(vec3f(dir.x, 0.012, dir.z)), sky.glow, sky.glowColor);
  let fog = 1.0 - exp(-dist * 0.0032);
  return mix(color, mix(horizon, HORIZON_FOG * 1.2, 0.35), fog * (0.5 + 0.5 * sky.haze));
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  // `uv` is top-origin, so v grows downward; NDC y is the flip of that.
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let farPoint = sky.invViewProj * vec4f(ndc, 1.0, 1.0);
  let dir = normalize(farPoint.xyz / farPoint.w - sky.eye);

  var color: vec3f;
  if (dir.y >= 0.0 || sky.eye.y <= sky.waterY) {
    color = skyColor(dir, sky.time, 1.0, sky.glow, sky.glowColor);
  } else {
    color = waterColor(dir, uv);
  }

  // Haze band hugging the horizon, thickest right at eye level.
  let band = exp(-abs(dir.y) * 26.0);
  color = mix(color, HORIZON_FOG * 1.6, band * sky.haze * 0.55);

  return vec4f(color, 1.0);
}
