// Voxel primitives for generators.
//
// The important one is `capsule` vs `line3`. A tapered limb whose radius is at
// least one voxel is rasterised exactly, by testing each candidate voxel
// centre against the segment. Below one voxel that test starts missing cells,
// so thin twigs instead walk the axis with a 3D DDA, which crosses voxel faces
// and is therefore 6-connected by construction. Sphere-stamping thin segments
// at sub-voxel steps is what produces diagonal-only twigs that a 6-connected
// flood fill treats as detached.

import type { Vec3 } from "../entity";
import type { Volume } from "./volume";

export interface FillOptions {
  /** Called for every voxel written, e.g. to record which segment made it. */
  onFill?: (index: number, x: number, y: number, z: number) => void;
  /** Overwrite existing voxels (default true). False writes into empty space only. */
  overwrite?: boolean;
  /** Per-voxel radius multiplier, for effects like a flared trunk base. */
  scale?: (x: number, y: number, z: number, t: number) => number;
}

function put(vol: Volume, x: number, y: number, z: number, v: number, o: FillOptions): boolean {
  if (!vol.inside(x, y, z)) return false;
  const i = vol.index(x, y, z);
  if (o.overwrite === false && vol.data[i] !== 0) return false;
  vol.data[i] = v;
  o.onFill?.(i, x, y, z);
  return true;
}

/**
 * Tapered capsule from `a` (radius `ra`) to `b` (radius `rb`), exact. Use when
 * max(ra, rb) >= 1; below that use `line3`.
 */
export function capsule(vol: Volume, a: Vec3, b: Vec3, ra: number, rb: number, value: number, o: FillOptions = {}): number {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const len2 = abx * abx + aby * aby + abz * abz;
  const rMax = Math.max(ra, rb);
  const pad = Math.ceil(rMax) + 1;
  const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0]) - pad));
  const x1 = Math.min(vol.sx - 1, Math.ceil(Math.max(a[0], b[0]) + pad));
  const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1]) - pad));
  const y1 = Math.min(vol.sy - 1, Math.ceil(Math.max(a[1], b[1]) + pad));
  const z0 = Math.max(0, Math.floor(Math.min(a[2], b[2]) - pad));
  const z1 = Math.min(vol.sz - 1, Math.ceil(Math.max(a[2], b[2]) + pad));

  let filled = 0;
  for (let z = z0; z <= z1; z++)
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5 - a[0], py = y + 0.5 - a[1], pz = z + 0.5 - a[2];
        let t = len2 > 0 ? (px * abx + py * aby + pz * abz) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = px - abx * t, dy = py - aby * t, dz = pz - abz * t;
        let r = ra + (rb - ra) * t;
        if (o.scale) r *= o.scale(x, y, z, t);
        if (dx * dx + dy * dy + dz * dz <= r * r && put(vol, x, y, z, value, o)) filled++;
      }
  return filled;
}

/**
 * 3D DDA along the segment axis, stamping every voxel the line passes through.
 * Face-crossing means consecutive voxels share a face, so the result is always
 * 6-connected. `pad` widens it to roughly two voxels for a chunkier twig.
 */
export function line3(vol: Volume, a: Vec3, b: Vec3, value: number, o: FillOptions & { pad?: boolean } = {}): number {
  let x = Math.floor(a[0]), y = Math.floor(a[1]), z = Math.floor(a[2]);
  const ex = Math.floor(b[0]), ey = Math.floor(b[1]), ez = Math.floor(b[2]);
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  const tdx = stepX ? Math.abs(1 / dx) : Infinity;
  const tdy = stepY ? Math.abs(1 / dy) : Infinity;
  const tdz = stepZ ? Math.abs(1 / dz) : Infinity;
  let tmx = stepX ? (stepX > 0 ? x + 1 - a[0] : a[0] - x) * tdx : Infinity;
  let tmy = stepY ? (stepY > 0 ? y + 1 - a[1] : a[1] - y) * tdy : Infinity;
  let tmz = stepZ ? (stepZ > 0 ? z + 1 - a[2] : a[2] - z) * tdz : Infinity;

  // Pad across the two axes the line travels along least, keeping it connected.
  const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
  const minor: Vec3[] = [];
  if (o.pad) {
    if (ax >= ay && ax >= az) minor.push([0, 1, 0], [0, 0, 1]);
    else if (ay >= az) minor.push([1, 0, 0], [0, 0, 1]);
    else minor.push([1, 0, 0], [0, 1, 0]);
  }

  let filled = 0;
  const stamp = () => {
    if (put(vol, x, y, z, value, o)) filled++;
    for (const m of minor) if (put(vol, x + m[0], y + m[1], z + m[2], value, o)) filled++;
  };

  stamp();
  let guard = 0;
  const cap = vol.sx + vol.sy + vol.sz + 8;
  while ((x !== ex || y !== ey || z !== ez) && guard++ < cap) {
    if (tmx <= tmy && tmx <= tmz) {
      x += stepX;
      tmx += tdx;
    } else if (tmy <= tmz) {
      y += stepY;
      tmy += tdy;
    } else {
      z += stepZ;
      tmz += tdz;
    }
    stamp();
  }
  return filled;
}

/** Axis-aligned ellipsoid; `keep` can carve it, receiving the normalised radius. */
export function ellipsoid(
  vol: Volume,
  c: Vec3,
  r: Vec3,
  value: number,
  keep?: (x: number, y: number, z: number, d: number) => boolean,
  o: FillOptions = {},
): number {
  const x0 = Math.max(0, Math.floor(c[0] - r[0])), x1 = Math.min(vol.sx - 1, Math.ceil(c[0] + r[0]));
  const y0 = Math.max(0, Math.floor(c[1] - r[1])), y1 = Math.min(vol.sy - 1, Math.ceil(c[1] + r[1]));
  const z0 = Math.max(0, Math.floor(c[2] - r[2])), z1 = Math.min(vol.sz - 1, Math.ceil(c[2] + r[2]));
  const rx = r[0] || 1, ry = r[1] || 1, rz = r[2] || 1;
  let filled = 0;
  for (let z = z0; z <= z1; z++)
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const ux = (x + 0.5 - c[0]) / rx, uy = (y + 0.5 - c[1]) / ry, uz = (z + 0.5 - c[2]) / rz;
        const d = Math.sqrt(ux * ux + uy * uy + uz * uz);
        if (d > 1) continue;
        if (keep && !keep(x, y, z, d)) continue;
        if (put(vol, x, y, z, value, o)) filled++;
      }
  return filled;
}

export function sphere(vol: Volume, c: Vec3, r: number, value: number, o: FillOptions = {}): number {
  return ellipsoid(vol, c, [r, r, r], value, undefined, o);
}

export function boxFill(vol: Volume, a: Vec3, b: Vec3, value: number, o: FillOptions = {}): number {
  let filled = 0;
  for (let z = Math.max(0, Math.round(a[2])); z <= Math.min(vol.sz - 1, Math.round(b[2])); z++)
    for (let y = Math.max(0, Math.round(a[1])); y <= Math.min(vol.sy - 1, Math.round(b[1])); y++)
      for (let x = Math.max(0, Math.round(a[0])); x <= Math.min(vol.sx - 1, Math.round(b[0])); x++)
        if (put(vol, x, y, z, value, o)) filled++;
  return filled;
}

// --- small vector helpers generators keep needing -------------------------

export const v3 = (x: number, y: number, z: number): Vec3 => [x, y, z];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
/** Any unit vector perpendicular to `d`. */
export function perpendicular(d: Vec3): Vec3 {
  const up: Vec3 = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  return normalize(cross(d, up));
}
/** Orthonormal frame around `d`: [forward, side, up]. */
export function frame(d: Vec3): [Vec3, Vec3, Vec3] {
  const f = normalize(d);
  const s = perpendicular(f);
  return [f, s, cross(s, f)];
}
/** Rotate `v` around unit axis `axis` by `angle` radians (Rodrigues). */
export function rotateAround(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle), s = Math.sin(angle);
  const k = cross(axis, v);
  const d = dot(axis, v) * (1 - c);
  return [v[0] * c + k[0] * s + axis[0] * d, v[1] * c + k[1] * s + axis[1] * d, v[2] * c + k[2] * s + axis[2] * d];
}
