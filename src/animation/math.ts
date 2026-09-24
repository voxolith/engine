// Small rigid-transform maths for skeletons: quaternions and 3x4 affine
// matrices (rotation + translation, row-major, 12 floats). Everything a pose
// needs is rigid, so an inverse is a transpose plus a translation.

export type Vec3 = [number, number, number];
/** x, y, z, w. */
export type Quat = [number, number, number, number];

export const IDENTITY_Q: Quat = [0, 0, 0, 1];

export function quatAxisAngle(axis: Vec3, rad: number): Quat {
  const l = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const s = Math.sin(rad / 2) / l;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(rad / 2)];
}

/** a * b: apply b, then a. */
export function quatMul(a: ArrayLike<number>, b: ArrayLike<number>): Quat {
  const [ax, ay, az, aw] = [a[0], a[1], a[2], a[3]];
  const [bx, by, bz, bw] = [b[0], b[1], b[2], b[3]];
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Spherical interpolation, taking the short way round. Writes into `out` at `o`. */
export function slerpInto(out: Float32Array | number[], o: number, a: ArrayLike<number>, ai: number, b: ArrayLike<number>, bi: number, t: number): void {
  let bx = b[bi], by = b[bi + 1], bz = b[bi + 2], bw = b[bi + 3];
  const ax = a[ai], ay = a[ai + 1], az = a[ai + 2], aw = a[ai + 3];
  let cos = ax * bx + ay * by + az * bz + aw * bw;
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  let ka: number, kb: number;
  if (cos > 0.9995) { ka = 1 - t; kb = t; }
  else {
    const th = Math.acos(cos), s = Math.sin(th);
    ka = Math.sin((1 - t) * th) / s;
    kb = Math.sin(t * th) / s;
  }
  let x = ax * ka + bx * kb, y = ay * ka + by * kb, z = az * ka + bz * kb, w = aw * ka + bw * kb;
  const l = Math.hypot(x, y, z, w) || 1;
  out[o] = x / l; out[o + 1] = y / l; out[o + 2] = z / l; out[o + 3] = w / l;
}

/** Rotation matrix of a unit quaternion into a 3x4 (translation 0). */
export function quatToMat(q: ArrayLike<number>, qi = 0, out = new Float32Array(12), o = 0): Float32Array {
  const x = q[qi], y = q[qi + 1], z = q[qi + 2], w = q[qi + 3];
  out[o] = 1 - 2 * (y * y + z * z); out[o + 1] = 2 * (x * y - z * w); out[o + 2] = 2 * (x * z + y * w); out[o + 3] = 0;
  out[o + 4] = 2 * (x * y + z * w); out[o + 5] = 1 - 2 * (x * x + z * z); out[o + 6] = 2 * (y * z - x * w); out[o + 7] = 0;
  out[o + 8] = 2 * (x * z - y * w); out[o + 9] = 2 * (y * z + x * w); out[o + 10] = 1 - 2 * (x * x + y * y); out[o + 11] = 0;
  return out;
}

/** out = a * b for 3x4 affines (apply b, then a). `out` may not alias. */
export function mulAffine(a: ArrayLike<number>, ai: number, b: ArrayLike<number>, bi: number, out: Float32Array, o: number): void {
  for (let r = 0; r < 3; r++) {
    const a0 = a[ai + r * 4], a1 = a[ai + r * 4 + 1], a2 = a[ai + r * 4 + 2], a3 = a[ai + r * 4 + 3];
    out[o + r * 4] = a0 * b[bi] + a1 * b[bi + 4] + a2 * b[bi + 8];
    out[o + r * 4 + 1] = a0 * b[bi + 1] + a1 * b[bi + 5] + a2 * b[bi + 9];
    out[o + r * 4 + 2] = a0 * b[bi + 2] + a1 * b[bi + 6] + a2 * b[bi + 10];
    out[o + r * 4 + 3] = a0 * b[bi + 3] + a1 * b[bi + 7] + a2 * b[bi + 11] + a3;
  }
}

/** Inverse of a rigid 3x4 (rotation transposed, translation mapped back). */
export function invertRigid(m: ArrayLike<number>, mi: number, out: Float32Array, o: number): void {
  const r00 = m[mi], r01 = m[mi + 1], r02 = m[mi + 2], tx = m[mi + 3];
  const r10 = m[mi + 4], r11 = m[mi + 5], r12 = m[mi + 6], ty = m[mi + 7];
  const r20 = m[mi + 8], r21 = m[mi + 9], r22 = m[mi + 10], tz = m[mi + 11];
  out[o] = r00; out[o + 1] = r10; out[o + 2] = r20; out[o + 3] = -(r00 * tx + r10 * ty + r20 * tz);
  out[o + 4] = r01; out[o + 5] = r11; out[o + 6] = r21; out[o + 7] = -(r01 * tx + r11 * ty + r21 * tz);
  out[o + 8] = r02; out[o + 9] = r12; out[o + 10] = r22; out[o + 11] = -(r02 * tx + r12 * ty + r22 * tz);
}

export function transformPoint(m: ArrayLike<number>, mi: number, x: number, y: number, z: number, out: Vec3): Vec3 {
  out[0] = m[mi] * x + m[mi + 1] * y + m[mi + 2] * z + m[mi + 3];
  out[1] = m[mi + 4] * x + m[mi + 5] * y + m[mi + 6] * z + m[mi + 7];
  out[2] = m[mi + 8] * x + m[mi + 9] * y + m[mi + 10] * z + m[mi + 11];
  return out;
}
