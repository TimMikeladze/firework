// Background: night sky, star field, and the open water the show reflects in.
// Drawn as a fullscreen effect before the sparks, so it doubles as the clear for
// the HDR scene target.
//
// The water is a real ray-surface intersection, not a mirrored ray: every pixel
// below the horizon knows where on the sea it landed and how far away that is,
// which is what lets the wave detail, the reflection sharpness, and the fog all
// fall out of the same distance. The reflection is then looked up along the
// ray the wave facet actually reflects, projected back to the screen, so the
// image in the water is displaced by the real geometry rather than by a
// screen-space offset that only looks right from one place.

import {
  HORIZON_FOG, fresnelWater, ggxD, ggxVisibility, oceanHeight, oceanNormal, oceanWave,
  MOON_TINT, OCTAVES, breakHalo, moonLight, seaAlpha, seaGlint, skyColor, skyGradient,
} from "./water.wgsl";

/// Breaks the water lights from at once. A show has several shells burning at
/// a time, and each lays its own path across the water.
const LIGHTS: i32 = 4;

struct SkyParams {
  /// Inverse of the camera's view-projection, for reconstructing view rays.
  invViewProj: mat4x4f,
  /// The camera's view-projection, for projecting reflected rays back to the
  /// screen the mirror target was drawn with.
  viewProj: mat4x4f,
  eye: vec3f,
  time: f32,
  /// 0..1 — smoke and haze sitting on the water.
  haze: f32,
  /// Ambient light the recent breaks are throwing onto the sky.
  glow: f32,
  /// 0..1 — how much of the show the water throws back.
  reflection: f32,
  /// 0..1 — sea state. 0 is a still pond, 1 is a choppy swell.
  waves: f32,
  /// Colour of that ambient light, taken from whatever just broke.
  glowColor: vec3f,
  /// Height of the water plane in world space.
  waterY: f32,
  /// Angular size of one pixel, radians. Sets the footprint on the water.
  pixelAngle: f32,
  /// 0..1 — how confused the sea is: steeper, sharper, more scattered short
  /// waves on the same swell.
  chop: f32,
  /// Angular radius of the moon's disc, radians.
  moonRadius: f32,
  /// 0..1 — lunar phase. 0.5 is full, either end is new.
  moonPhase: f32,
  /// Unit direction to the moon.
  moonDir: vec3f,
  /// Brightness of the moon; 0 leaves it out of the sky entirely.
  moon: f32,
  /// Recent breaks as point lights: xyz is the break position, w its
  /// intensity. Zero intensity is an empty slot.
  lights: array<vec4f, 4>,
  /// Their colours, normalised so w is unused.
  lightColors: array<vec4f, 4>,
}

@group(0) @binding(0) var<uniform> sky: SkyParams;
/// The show mirrored through the water plane, drawn with this same camera.
@group(0) @binding(1) var mirror: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

/// Light from every recent break scattered toward the eye by the haze along
/// `dir`. Added to the sky directly and to its reflection, where the wave
/// normal bends it — which is what lets a burst light the swell around it.
fn haloLight(dir: vec3f) -> vec3f {
  var halo = vec3f(0.0);
  for (var i = 0; i < LIGHTS; i = i + 1) {
    let light = sky.lights[i];
    if (light.w <= 0.0) {
      continue;
    }
    let toLight = normalize(light.xyz - sky.eye);
    halo += sky.lightColors[i].rgb * breakHalo(dir, toLight, light.w, sky.haze);
  }
  return halo;
}

/// The whole sky along `dir`: gradient, stars, the moon, and the breaks' halos.
fn skyAlong(dir: vec3f, starScale: f32) -> vec3f {
  // A bright moon washes the faint stars out of the sky, the way it does.
  let stars = starScale * (1.0 - 0.4 * clamp(sky.moon, 0.0, 1.0));
  return skyColor(dir, sky.time, stars, sky.glow, sky.glowColor)
    + moonLight(dir, sky.moonDir, sky.moonRadius, sky.moonPhase, sky.moon, sky.haze)
    + haloLight(dir);
}

/// Screen coordinate of a world point, in the mirror target's top-origin UV.
fn projectUV(p: vec3f) -> vec2f {
  let clip = sky.viewProj * vec4f(p, 1.0);
  let ndc = clip.xy / max(clip.w, 1e-4);
  return vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
}

/// One tap of the mirror target, faded to nothing past the frame edge: a
/// clamped sample there smears the last column of the image into a streak.
fn mirrorTap(uv: vec2f) -> vec3f {
  let edge = smoothstep(vec2f(0.0), vec2f(0.03), uv) * smoothstep(vec2f(1.0), vec2f(0.97), uv);
  return textureSampleLevel(mirror, samp, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0).rgb * edge.x * edge.y;
}

/// Where the mirror target shows a facet with normal `normal` reflecting from
/// `hit`. The reflected ray is folded back through the plane and run down to
/// the depth of the virtual image, and that point is projected with the same
/// camera the mirror pass used. Exact for anything at the break height, and a
/// smooth distortion of everything else.
fn reflectedUV(hit: vec3f, dir: vec3f, normal: vec3f, imageY: f32) -> vec2f {
  var bounced = reflect(dir, normal);
  // A facet tipped far enough to reflect the water itself sees the dark sea,
  // not the sky; flatten it back to grazing rather than sampling nonsense.
  bounced.y = max(bounced.y, 0.02);
  let below = vec3f(bounced.x, -bounced.y, bounced.z);
  let t = (imageY - hit.y) / below.y;
  return projectUV(hit + below * max(t, 0.0));
}

/// Colour of the sea where the view ray `dir` hits it.
fn waterColor(dir: vec3f) -> vec3f {
  let sea = 0.25 + sky.waves * 1.35;
  let chop = clamp(sky.chop, 0.0, 1.0);
  let dropY = min(dir.y, -0.0008);

  // Distance to the plane. `dir` is unit, so it doubles as the travel length.
  // The clamp keeps rays that graze the horizon from running to infinity.
  var dist = (sky.waterY - sky.eye.y) / dropY;
  var hit = sky.eye + dir * dist;

  // Pixel footprint on the water: the ray cone widens with distance and lands
  // at a grazing angle, which stretches it along the view direction.
  var footprint = dist * sky.pixelAngle / max(0.012, -dir.y);

  // Parallax: the ray lands on the swell, not on the plane. Two relaxed steps
  // toward the height field are enough for the crests to lean into the camera
  // and, near the horizon, to hide the troughs behind them — which is most of
  // what separates a sea from a plane with a normal map on it. Relaxed, since
  // a grazing ray can meet a wave more than once and a full step oscillates.
  for (var i = 0; i < 2; i = i + 1) {
    let h = oceanHeight(hit.xz, sky.time, sea, chop, footprint);
    let corrected = (sky.waterY + h - sky.eye.y) / dropY;
    dist = mix(dist, corrected, 0.7);
    hit = sky.eye + dir * dist;
    footprint = dist * sky.pixelAngle / max(0.012, -dir.y);
  }

  let wave = oceanWave(hit.xz, sky.time, sea, chop, footprint, OCTAVES);
  let normal = oceanNormal(wave.slope);
  let alpha = seaAlpha(wave.variance, sea, chop);

  // Fresnel against the facet, not the flat plane: crests tipped toward the
  // camera go dark while their backs mirror, and that difference is most of
  // what reads as water rather than as a mirror.
  let ndotv = clamp(dot(-dir, normal), 0.0, 1.0);
  let fresnel = fresnelWater(ndotv);

  // Sky half of the reflection, evaluated analytically so it distorts with the
  // real per-pixel normal. A crest can bend the ray below the horizon; flatten
  // those back to grazing rather than returning black.
  let bounced = reflect(dir, normal);
  let skyDir = normalize(vec3f(bounced.x, max(bounced.y, 0.003), bounced.z));
  // Stars only survive in a surface smooth enough to resolve a point source.
  let starScale = smoothstep(0.12, 0.02, alpha);
  let mirrored = skyAlong(skyDir, starScale);

  // Glints. The specular lobe is the *expected* reflection from the facets a
  // pixel covers; when the pixel holds only a handful, the number aligned at
  // any instant is a small count, and that variance is the sparkle. Built
  // once per pixel and shared by the reflection and every light: the same
  // facets are aligned for all of them. A near pixel holds a few facets and
  // sparkles hard, a far one averages thousands and smooths out, and glassy
  // water has no facets to speak of and stays a clean mirror.
  let viewXZ = normalize(vec3f(dir.x, 0.0, dir.z) + vec3f(1e-5, 0.0, 0.0));
  let footAcross = dist * sky.pixelAngle;
  let glint = seaGlint(hit.xz, viewXZ.xz, footAcross, footprint, sky.time);
  let sparkle = mix(0.75, 0.3, smoothstep(0.1, 4.0, footprint)) * smoothstep(0.03, 0.09, alpha);
  let twinkle = mix(1.0, glint, sparkle);

  // Show half of the reflection. The virtual image sits as far below the
  // water as the break sits above it, so the sample point is projected at that
  // depth: an exact planar reflection for the break, displaced by the facet.
  var imageY = sky.waterY - 30.0;
  if (sky.lights[0].w > 0.0) {
    imageY = 2.0 * sky.waterY - sky.lights[0].y;
  }
  let uv0 = reflectedUV(hit, dir, normal, imageY);
  // The facets the pixel could not resolve blur the image. Tilting the normal
  // by the roughness along the view direction and projecting again gives that
  // blur its screen-space size and direction for free — long down the screen,
  // narrow across it, exactly the stretch a rough sea gives a reflection.
  let tilted = normalize(normal + viewXZ * alpha * 0.8);
  let uv1 = reflectedUV(hit, dir, tilted, imageY);
  let smear = uv1 - uv0;
  var show = mirrorTap(uv0) * 0.30;
  show += (mirrorTap(uv0 + smear * 0.5) + mirrorTap(uv0 - smear * 0.5)) * 0.22;
  show += (mirrorTap(uv0 + smear) + mirrorTap(uv0 - smear)) * 0.13;
  // Fresnel weights the image, but does not gate it: at the 8% a facet at
  // this angle really returns, the reflection of a burst that the tonemap has
  // already clipped to white would vanish into the water. A camera would have
  // blown the burst out by a couple of stops and kept the reflection; the
  // floor stands in for that exposure, and so does the roughness term — a
  // rough sea spreads the same light over far more water, and what the
  // tonemap takes from the spread-out version a camera would have given back.
  show *= sky.reflection * (0.5 + 1.5 * fresnel) * (1.0 + 8.0 * alpha) * twinkle;

  // Deep water at night is nearly black. What little comes back from below the
  // surface is the breaks' light, scattered back up through the top of the
  // water column — which is why it arrives green-blue however warm the shell.
  var body = vec3f(0.0012, 0.0044, 0.0079);
  var specular = vec3f(0.0);

  for (var i = 0; i < LIGHTS; i = i + 1) {
    let light = sky.lights[i];
    if (light.w <= 0.0) {
      continue;
    }
    let toLight = light.xyz - hit;
    let lightDist = max(length(toLight), 1.0);
    let lightDir = toLight / lightDist;
    let ndotl = dot(normal, lightDir);
    if (ndotl <= 0.0) {
      continue;
    }
    // Inverse-square, so a break genuinely lights the patch of sea beneath it
    // and leaves the rest of the bay dark.
    let irradiance = light.w * 220.0 / (lightDist * lightDist);
    let tint = sky.lightColors[i].rgb;

    // Scattered back out of the top of the water column, so it lights the
    // faces of the swell turned toward the break and cools toward blue-green.
    body += tint * vec3f(0.55, 0.85, 1.0) * irradiance * ndotl * 0.1;

    // GGX from the break as a point light, roughened by exactly what the
    // level of detail threw away: near water resolves its own facets and
    // sparkles, far water stands in for the ones it dropped with a wide
    // lobe. No screen-space smear can fake the long path this lays across
    // the water — it exists because facets all the way back to the camera
    // happen to catch the light, not because the image is blurred.
    let halfway = normalize(lightDir - dir);
    let ndoth = max(dot(normal, halfway), 0.0);
    let vdoth = max(dot(-dir, halfway), 0.0);
    let d = ggxD(ndoth, alpha);
    let vis = ggxVisibility(ndotl, max(ndotv, 1e-3), alpha);
    let f = fresnelWater(vdoth);
    // A resolved facet is a mirror the size of a pixel and can throw the whole
    // source back at once; cap it where the bloom takes over anyway.
    specular += tint * min(d * vis * f * ndotl * irradiance * twinkle, 60.0);
  }
  // On glassy water the mirror image already is the reflection, and a point
  // light on top of it would draw a second, airbrushed copy of the break.
  // The lobe stands in for the facets the image cannot resolve, so it earns
  // its keep in proportion to how many of those there are.
  specular *= 0.25 + 0.75 * smoothstep(0.03, 0.12, alpha);

  // Moonlight: a directional light, so no falloff and no depth to project to.
  // Its disc and halo are already in the mirrored sky; this is the long
  // glitter path a moon lays across any sea that is not glass, and a little
  // moonlight scattered back out of the water itself.
  if (sky.moon > 0.0) {
    let ndotl = dot(normal, sky.moonDir);
    if (ndotl > 0.0) {
      let halfway = normalize(sky.moonDir - dir);
      let ndoth = max(dot(normal, halfway), 0.0);
      let vdoth = max(dot(-dir, halfway), 0.0);
      let d = ggxD(ndoth, alpha);
      let vis = ggxVisibility(ndotl, max(ndotv, 1e-3), alpha);
      let f = fresnelWater(vdoth);
      // Softer sparkle than a break: the disc is an extended source, so more
      // facets are lit at once and the path reads as silver, not glitter.
      let moonPath = min(d * vis * f * ndotl * sky.moon * 0.11 * mix(1.0, twinkle, 0.6), 60.0)
        * (0.25 + 0.75 * smoothstep(0.03, 0.12, alpha));
      specular += MOON_TINT * moonPath;
      body += MOON_TINT * vec3f(0.55, 0.85, 1.0) * sky.moon * ndotl * 0.004;
    }
  }

  var color = mix(body, mirrored, fresnel) + show * fresnel + specular;

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
    color = skyAlong(dir, 1.0);
  } else {
    color = waterColor(dir);
  }

  // Haze band hugging the horizon, thickest right at eye level.
  let band = exp(-abs(dir.y) * 26.0);
  color = mix(color, HORIZON_FOG * 1.6, band * sky.haze * 0.55);

  return vec4f(color, 1.0);
}
