/** Minimal 4x4 helpers. vgpu's scene camera owns the matrices; we only need to
 * invert its view-projection so the sky shader can rebuild view rays. */

/** Column-major, the layout every WebGPU `mat4x4f` uniform expects. */
export type Mat4 = Float32Array;

/**
 * Writes `inverse(m)` into `out`. Returns false for a singular matrix, leaving
 * `out` untouched — callers keep the previous frame's inverse in that case.
 */
export function invertMat4(out: Mat4, m: ArrayLike<number>): boolean {
  const a00 = m[0];
  const a01 = m[1];
  const a02 = m[2];
  const a03 = m[3];
  const a10 = m[4];
  const a11 = m[5];
  const a12 = m[6];
  const a13 = m[7];
  const a20 = m[8];
  const a21 = m[9];
  const a22 = m[10];
  const a23 = m[11];
  const a30 = m[12];
  const a31 = m[13];
  const a32 = m[14];
  const a33 = m[15];

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  const det =
    b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return false;
  const d = 1 / det;

  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
  return true;
}

/**
 * Where the ray through a normalised-device-coordinate point crosses `planeY`.
 * Returns null when the ray runs away from the plane — a click at the sky.
 */
export function rayPlaneHit(
  invViewProj: Mat4,
  eye: readonly [number, number, number],
  ndcX: number,
  ndcY: number,
  planeY: number,
): [number, number, number] | null {
  const px =
    invViewProj[0] * ndcX +
    invViewProj[4] * ndcY +
    invViewProj[8] +
    invViewProj[12];
  const py =
    invViewProj[1] * ndcX +
    invViewProj[5] * ndcY +
    invViewProj[9] +
    invViewProj[13];
  const pz =
    invViewProj[2] * ndcX +
    invViewProj[6] * ndcY +
    invViewProj[10] +
    invViewProj[14];
  const pw =
    invViewProj[3] * ndcX +
    invViewProj[7] * ndcY +
    invViewProj[11] +
    invViewProj[15];
  if (!pw) return null;

  const dx = px / pw - eye[0];
  const dy = py / pw - eye[1];
  const dz = pz / pw - eye[2];
  if (Math.abs(dy) < 1e-6) return null;

  const t = (planeY - eye[1]) / dy;
  if (t <= 0) return null;
  return [eye[0] + dx * t, planeY, eye[2] + dz * t];
}
