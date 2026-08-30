// Draws the live sparks as camera-facing quads, additively, in one draw call.
//
// The same shader draws the show and its reflection. With `mirror` set, every
// spark is flipped through the water plane and rendered with the unchanged
// camera, which is exactly the virtual image a flat mirror would show — so the
// water pass can look the reflection up at its own screen pixel. Two Draws bind
// this shader, because passes in one frame cannot share uniforms.

import { Particle, KIND_FLASH, KIND_TRAIL } from "./common.wgsl";

struct Camera {
  viewProj: mat4x4f,
  /// Billboard basis, world space.
  right: vec3f,
  pad0: f32,
  up: vec3f,
  pad1: f32,
  eye: vec3f,
  pad2: f32,
}

struct DrawParams {
  time: f32,
  first: u32,
  span: u32,
  poolSize: u32,
  /// 1 flips every spark through the water plane, for the reflection pass.
  mirror: f32,
  waterY: f32,
  /// Scales every spark; lets the UI keep sizes readable at any zoom.
  sizeScale: f32,
  pad0: f32,
}

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> params: DrawParams;
@group(0) @binding(2) var<storage, read> particles: array<Particle>;

struct VertexOut {
  @builtin(position) position: vec4f,
  /// Quad-local coordinates in [-1, 1] for the radial falloff.
  @location(0) local: vec2f,
  @location(1) color: vec3f,
  @location(2) intensity: f32,
  @location(3) kind: f32,
}

/// Behind the far plane, so the rasteriser drops the whole quad.
fn culled() -> VertexOut {
  var out: VertexOut;
  out.position = vec4f(0.0, 0.0, 2.0, 1.0);
  out.local = vec2f(0.0);
  out.color = vec3f(0.0);
  out.intensity = 0.0;
  out.kind = 0.0;
  return out;
}

@vertex
fn vs_main(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VertexOut {
  let mirrored = params.mirror > 0.5;
  let p = particles[(params.first + instance) % params.poolSize];
  if (p.life <= 0.0 || p.maxLife <= 0.0) {
    return culled();
  }

  var center = p.pos;
  var velocity = p.vel;
  if (mirrored) {
    center.y = 2.0 * params.waterY - center.y;
    velocity.y = -velocity.y;
  }

  let age = clamp(1.0 - p.life / p.maxLife, 0.0, 1.0);
  let seed = p.misc.w;

  // Brightness: a hot ignition spike, a long exponential burn, a soft death.
  //
  // The overall scale matters more than it looks: these quads blend additively,
  // so a dense break stacks hundreds of them per pixel. Too hot and every shell
  // tonemaps to the same white blob — the colour only survives if one spark is
  // dim on its own.
  var intensity = exp(-2.6 * age) * (1.0 + 1.2 * exp(-26.0 * age)) * 0.55;
  intensity *= smoothstep(0.0, 0.06, p.life);

  // Twinkle and crackle. Both key off the same per-spark seed so a spark keeps
  // its own rhythm instead of pulsing in lockstep with its neighbours.
  let flickerPhase = params.time * 34.0 + seed * 12.0;
  let twinkle = mix(1.0, 0.35 + 0.65 * (0.5 + 0.5 * sin(flickerPhase)), p.misc.y);
  let glitterPhase = fract(params.time * 11.0 + seed * 0.61);
  let glitter = 1.0 + p.misc.z * 7.0 * pow(max(0.0, 1.0 - abs(glitterPhase - 0.5) * 6.0), 6.0);
  intensity *= twinkle * glitter;

  var color = mix(p.color, p.fade, smoothstep(0.12, 0.95, age));
  if (p.extra.z == KIND_FLASH) {
    // The break flash is a single fat, very short-lived puff.
    intensity = exp(-7.0 * age) * 6.0;
    color = p.color;
  } else if (p.extra.z == KIND_TRAIL) {
    intensity *= 0.55;
  }

  // Billboard axes: elongate along the screen-space velocity when `stretch` is
  // on, which turns fast sparks into comet streaks and leaves slow ones round.
  let screenVel = vec2f(dot(velocity, camera.right), dot(velocity, camera.up));
  let speed = length(screenVel);
  var alongAxis = vec2f(0.0, 1.0);
  if (speed > 0.0001) {
    alongAxis = screenVel / speed;
  }
  let acrossAxis = vec2f(-alongAxis.y, alongAxis.x);

  let radius = p.size * params.sizeScale * mix(1.0, 0.55, age);
  let stretch = 1.0 + p.extra.x * min(speed * 0.28, 9.0);

  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let local = corners[vertex];
  let offset2d = acrossAxis * (local.x * radius) + alongAxis * (local.y * radius * stretch);
  let world = center + camera.right * offset2d.x + camera.up * offset2d.y;

  if (mirrored) {
    // Water swallows the far end of a reflection: the deeper the virtual image
    // sits, the longer the path back to the eye. The surface itself applies
    // Fresnel and the reflection strength, so neither belongs here.
    let depth = max(0.0, params.waterY - world.y);
    intensity *= 1.05 * exp(-depth * 0.010);
    color = mix(color, vec3f(0.18, 0.34, 0.55) * (color.r + color.g + color.b) * 0.33, 0.35);
  }

  var out: VertexOut;
  out.position = camera.viewProj * vec4f(world, 1.0);
  out.local = local;
  out.color = color;
  out.intensity = intensity;
  out.kind = p.extra.z;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let r2 = dot(in.local, in.local);
  if (r2 > 1.0) {
    discard;
  }
  // A tight core inside a wide halo: the halo is what bloom picks up.
  let falloff = 1.0 - r2;
  var shape = falloff * falloff;
  if (in.kind == KIND_FLASH) {
    shape = falloff * 0.6;
  } else {
    shape += pow(falloff, 12.0) * 0.4;
  }
  let energy = in.intensity * shape;
  // Premultiplied: the pass blends additively, so alpha only carries coverage.
  return vec4f(in.color * energy, energy);
}
