import type { Section, SectionKind } from "./types";

/**
 * A minimal flight camera. The world is a ground plane at y = 0 that the camera
 * flies over; only yaw, roll, pitch and altitude vary. That is enough for the
 * banking-pass feel without a full 3D pipeline, and it keeps projection cheap
 * enough to run per-vertex every frame.
 *
 * Convention: world +Z is forward (the direction of flight), +X is right, +Y is
 * up. Screen Y grows downward as usual.
 */

export interface Projected {
  x: number;
  y: number;
  /** Camera-space depth; <= 0 means behind the camera and must be discarded. */
  depth: number;
  /** Perspective scale factor at that depth. */
  scale: number;
}

interface CameraTarget {
  bank: number;
  altitude: number;
  turnRate: number;
  speed: number;
}

/**
 * Per-section flight character. Drops fly faster and bank harder; altitude
 * stays high enough that terrain never rises into the beam, which sits well
 * above the horizon and must stay clear for bursts to read.
 */
const FLIGHT: Record<SectionKind, CameraTarget> = {
  intro: { bank: 0.04, altitude: 230, turnRate: 0.06, speed: 60 },
  verse: { bank: 0.09, altitude: 210, turnRate: 0.1, speed: 82 },
  build: { bank: 0.13, altitude: 195, turnRate: 0.15, speed: 110 },
  chorus: { bank: 0.14, altitude: 185, turnRate: 0.17, speed: 132 },
  drop: { bank: 0.16, altitude: 170, turnRate: 0.2, speed: 165 },
  outro: { bank: 0.05, altitude: 225, turnRate: 0.07, speed: 66 },
};

export class Camera {
  /** Distance travelled along the flight path, in world units. */
  distance = 0;
  /** Lateral offset from the path centreline. */
  private lateral = 0;
  private altitude = 210;
  private yaw = 0;
  private roll = 0;
  private pitch = 0;

  private targetAltitude = 210;
  private targetRoll = 0;
  private speed = 82;

  /** Drives the slow sinusoidal turn cycle. */
  private phase = 0;
  /** Extra bank/dive applied by beat and combo events, decays over time. */
  private impulseRoll = 0;
  private impulseDive = 0;

  private viewW = 1;
  /** Focal length in pixels; derived from viewport width for a ~65° FOV. */
  private focal = 800;
  /** Screen Y of the horizon line at zero pitch. */
  private horizon = 0;

  resize(w: number, h: number) {
    this.viewW = w;
    this.focal = w * 0.78;
    // The horizon sits well below the beam so bursts always have open sky
    // behind them and the terrain reads as ground being flown over.
    this.horizon = h * 0.52;
  }

  get horizonY(): number {
    // Pitch shifts the horizon; roll is applied later as a screen-space rotation.
    return this.horizon + this.pitch * this.focal;
  }

  get rollAngle(): number {
    return this.roll;
  }

  get altitudeValue(): number {
    return this.altitude;
  }

  get speedValue(): number {
    return this.speed;
  }

  reset() {
    this.distance = 0;
    this.lateral = 0;
    this.phase = 0;
    this.roll = 0;
    this.pitch = 0;
    this.yaw = 0;
    this.impulseRoll = 0;
    this.impulseDive = 0;
  }

  /** Nudges the camera on a big hit: a quick bank plus a shallow dive. */
  impulse(strength: number, direction: number) {
    this.impulseRoll += direction * strength * 0.09;
    this.impulseDive += strength * 0.02;
  }

  update(dt: number, section: Section, energy: number) {
    const flight = FLIGHT[section.kind];

    // Turn cycle: two detuned sinusoids so the path never repeats obviously.
    this.phase += dt * flight.turnRate;
    const turn =
      Math.sin(this.phase) * 0.7 + Math.sin(this.phase * 0.37 + 1.3) * 0.3;

    this.targetRoll = turn * flight.bank;
    // Louder passages fly lower, which makes the terrain rush past faster.
    this.targetAltitude = flight.altitude * (1 - energy * 0.18);

    // Ease toward targets; the lag is what makes the motion read as a heavy aircraft.
    this.roll +=
      (this.targetRoll + this.impulseRoll - this.roll) * Math.min(1, dt * 1.6);
    this.altitude +=
      (this.targetAltitude - this.altitude) * Math.min(1, dt * 0.9);
    this.speed += (flight.speed - this.speed) * Math.min(1, dt * 0.7);

    // Roll and yaw are coupled, as in real banked flight.
    this.yaw += this.roll * dt * 0.55;
    this.lateral += Math.sin(this.yaw) * this.speed * dt;
    this.distance += Math.cos(this.yaw) * this.speed * dt;

    // Pitch: a slow bob plus whatever dive impulses are outstanding.
    const bob = Math.sin(this.phase * 1.7) * 0.012;
    this.pitch += (bob - this.impulseDive - this.pitch) * Math.min(1, dt * 2.2);

    this.impulseRoll *= 0.94 ** (dt * 60);
    this.impulseDive *= 0.9 ** (dt * 60);
  }

  /**
   * Projects a world point. `z` is absolute distance along the path, so callers
   * pass world-space positions and this subtracts the camera's own travel.
   */
  project(x: number, y: number, z: number, out: Projected): Projected {
    // Translate into camera space.
    let dx = x - this.lateral;
    const dy = y - this.altitude;
    let dz = z - this.distance;

    // Yaw rotation about the vertical axis.
    const cy = Math.cos(-this.yaw);
    const sy = Math.sin(-this.yaw);
    const rx = dx * cy - dz * sy;
    const rz = dx * sy + dz * cy;
    dx = rx;
    dz = rz;

    out.depth = dz;
    if (dz <= 1) {
      out.x = 0;
      out.y = 0;
      out.scale = 0;
      return out;
    }

    const scale = this.focal / dz;
    out.scale = scale;
    out.x = this.viewW / 2 + dx * scale;
    out.y = this.horizonY - dy * scale;
    return out;
  }

  /** Screen-space transform for the roll. Applied once around the frame. */
  applyRoll(ctx: CanvasRenderingContext2D) {
    ctx.translate(this.viewW / 2, this.horizonY);
    ctx.rotate(this.roll);
    ctx.translate(-this.viewW / 2, -this.horizonY);
  }
}
