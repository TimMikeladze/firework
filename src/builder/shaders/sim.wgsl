// Integrates every live spark for one frame.
//
// The pool is a ring buffer, so the live set is the window [first, first+span).
// Dispatching over that window instead of the whole pool keeps an idle scene
// nearly free.

import { Particle } from "./common.wgsl";

struct SimParams {
  /// Constant horizontal acceleration.
  wind: vec3f,
  dt: f32,
  time: f32,
  /// World gravity; each spark scales it by `misc.x`.
  gravity: f32,
  /// Show-wide air resistance, added to each spark's own `drag`.
  drag: f32,
  /// Strength of the swirling field that keeps big breaks from looking rigid.
  turbulence: f32,
  /// Sparks below this height are swallowed by the water.
  groundY: f32,
  first: u32,
  span: u32,
  poolSize: u32,
}

@group(0) @binding(0) var<uniform> sim: SimParams;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;

/// Cheap divergence-ish flow field. Three sines beat a noise texture here: the
/// eye only needs the motion to be non-uniform, not physically curl-free.
fn turbulentField(p: vec3f, t: f32) -> vec3f {
  return vec3f(
    sin(p.z * 0.35 + t * 0.7) + 0.5 * sin(p.y * 0.9 - t * 1.3),
    sin(p.x * 0.41 - t * 0.6) * 0.4,
    cos(p.y * 0.33 + t * 0.5) + 0.5 * cos(p.x * 0.87 + t * 1.1),
  );
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= sim.span) {
    return;
  }
  let index = (sim.first + gid.x) % sim.poolSize;
  var p = particles[index];
  if (p.life <= 0.0) {
    return;
  }

  let life = p.life - sim.dt;
  if (life <= 0.0) {
    particles[index].life = 0.0;
    return;
  }

  var v = p.vel;
  v.y = v.y - sim.gravity * p.misc.x * sim.dt;
  v = v + sim.wind * sim.dt;
  v = v + turbulentField(p.pos, sim.time) * sim.turbulence * sim.dt;
  // Exponential decay is stable at any dt, unlike a `v *= 1 - drag * dt` step.
  v = v * exp(-(p.drag + sim.drag) * sim.dt);

  let pos = p.pos + v * sim.dt;

  p.vel = v;
  p.pos = pos;
  p.life = select(life, 0.0, pos.y < sim.groundY);
  particles[index] = p;
}
