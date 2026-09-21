// Shaping and shading a mass of scattered voxels — foliage, but equally moss,
// rubble or coral.
//
// Placement alone never looks right: clumps hung on every twig merge into one
// solid mass. Three passes fix that, in order of how much they matter. Shell
// hollowing throws away everything buried deep inside, which halves the voxel
// count and lets you see structure through the surface. The macro carve removes
// whole pockets, which is what puts holes in the silhouette. Then colour is
// scored from how far out, how high and how exposed each voxel is, with accents
// chosen per cluster — randomising per voxel looks like television static.

import type { Noise } from "./noise";
import { clamp } from "./noise";
import type { Volume } from "./volume";

const THETA_BINS = 36;
const Y_BINS = 28;

export type Mask = (value: number) => boolean;

export interface Hull {
  /** Max radius per (angle, height) bin, in voxels from the axis. */
  radius: Float32Array;
  y0: number;
  y1: number;
  cx: number;
  cz: number;
}

/** Outer envelope of the marked voxels, sampled in cylindrical bins. */
export function buildHull(vol: Volume, cx: number, cz: number, isTarget: Mask): Hull | null {
  const radius = new Float32Array(THETA_BINS * Y_BINS);
  const sx = vol.sx, sy = vol.sy, sxy = sx * sy;
  let y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < vol.data.length; i++) {
    if (!isTarget(vol.data[i])) continue;
    const y = ((i / sx) | 0) % sy;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (y1 < y0) return null;
  const span = Math.max(1, y1 - y0);
  for (let i = 0; i < vol.data.length; i++) {
    if (!isTarget(vol.data[i])) continue;
    const x = i % sx;
    const y = ((i / sx) | 0) % sy;
    const z = (i / sxy) | 0;
    const dx = x + 0.5 - cx, dz = z + 0.5 - cz;
    const r = Math.hypot(dx, dz);
    const k = thetaBin(dx, dz) + Math.min(Y_BINS - 1, Math.floor(((y - y0) / span) * Y_BINS)) * THETA_BINS;
    if (r > radius[k]) radius[k] = r;
  }
  return { radius, y0, y1, cx, cz };
}

const thetaBin = (dx: number, dz: number): number => {
  const t = (Math.atan2(dz, dx) + Math.PI) / (Math.PI * 2);
  return Math.min(THETA_BINS - 1, Math.floor(t * THETA_BINS));
};

export function hullRadius(hull: Hull, x: number, y: number, z: number): number {
  const dx = x + 0.5 - hull.cx, dz = z + 0.5 - hull.cz;
  const span = Math.max(1, hull.y1 - hull.y0);
  const yb = clamp(Math.floor(((y - hull.y0) / span) * Y_BINS), 0, Y_BINS - 1);
  const tb = thetaBin(dx, dz);
  // Blend neighbouring angular bins so the shell has no facets.
  const a = hull.radius[((tb + THETA_BINS - 1) % THETA_BINS) + yb * THETA_BINS];
  const b = hull.radius[tb + yb * THETA_BINS];
  const c = hull.radius[((tb + 1) % THETA_BINS) + yb * THETA_BINS];
  return (a + b * 2 + c) / 4;
}

export interface CarveOptions {
  /** Drop voxels deeper than this below the hull. 0 disables. */
  shellDepth: number;
  /** Frequency and threshold of the pocket carve. */
  macroScale: number;
  macroThreshold: number;
}

export interface CarveStats {
  shell: number;
  macro: number;
}

/** Hollow the mass and punch holes through it. */
export function carveCanopy(
  vol: Volume,
  hull: Hull | null,
  isTarget: Mask,
  opts: CarveOptions,
  noise: Noise,
): CarveStats {
  const stats: CarveStats = { shell: 0, macro: 0 };
  const sx = vol.sx, sy = vol.sy, sxy = sx * sy;
  for (let i = 0; i < vol.data.length; i++) {
    if (!isTarget(vol.data[i])) continue;
    const x = i % sx;
    const y = ((i / sx) | 0) % sy;
    const z = (i / sxy) | 0;
    if (hull && opts.shellDepth > 0) {
      const r = Math.hypot(x + 0.5 - hull.cx, z + 0.5 - hull.cz);
      if (hullRadius(hull, x, y, z) - r > opts.shellDepth) {
        vol.data[i] = 0;
        stats.shell++;
        continue;
      }
    }
    if (opts.macroThreshold > 0) {
      const s = opts.macroScale;
      if (noise.fbm3(x * s, y * s, z * s, 2) < opts.macroThreshold) {
        vol.data[i] = 0;
        stats.macro++;
      }
    }
  }
  return stats;
}

/** Occluders directly above each voxel, a cheap stand-in for sky exposure. */
export function skyOcclusion(vol: Volume): Uint8Array {
  const out = new Uint8Array(vol.data.length);
  const sx = vol.sx, sy = vol.sy, sxy = sx * sy;
  for (let z = 0; z < vol.sz; z++)
    for (let x = 0; x < sx; x++) {
      let above = 0;
      for (let y = sy - 1; y >= 0; y--) {
        const i = x + y * sx + z * sxy;
        out[i] = above > 255 ? 255 : above;
        if (vol.data[i] !== 0) above++;
      }
    }
  return out;
}

export interface ShadeOptions {
  isTarget: Mask;
  hull: Hull | null;
  sky: Uint8Array;
  /** Cluster id per voxel; 0 means none. Accents are chosen per cluster. */
  clusterId: Uint16Array;
  noise: Noise;
  /** Roles from light to dark. */
  tones: [number, number, number];
  /** Role for the outermost rim, which reads as backlit. */
  edge: number;
  accent: number;
  accentFraction: number;
  /** Role and share for sickly or dead patches. */
  dead?: number;
  deadFraction?: number;
  /** Noise frequency for the dither that breaks up tone banding. */
  ditherScale?: number;
}

/** Assign a role per voxel from outerness, height and sky exposure. */
export function shadeByExposure(vol: Volume, o: ShadeOptions): void {
  const sx = vol.sx, sy = vol.sy, sxy = sx * sy;
  const nf = o.ditherScale ?? 0.08;
  const deadCut = o.deadFraction ?? 0;

  let yLo = Infinity, yHi = -Infinity;
  for (let i = 0; i < vol.data.length; i++) {
    if (!o.isTarget(vol.data[i])) continue;
    const y = ((i / sx) | 0) % sy;
    if (y < yLo) yLo = y;
    if (y > yHi) yHi = y;
  }
  const ySpan = Math.max(1, yHi - yLo);

  for (let i = 0; i < vol.data.length; i++) {
    if (!o.isTarget(vol.data[i])) continue;
    const x = i % sx;
    const y = ((i / sx) | 0) % sy;
    const z = (i / sxy) | 0;

    const cid = o.clusterId[i];
    if (cid !== 0) {
      const ch = hash01(cid * 2654435761);
      if (ch < o.accentFraction) {
        vol.data[i] = o.accent;
        continue;
      }
      if (o.dead !== undefined && deadCut > 0 && ch > 1 - deadCut) {
        vol.data[i] = o.dead;
        continue;
      }
    }

    let outer = 0.6;
    if (o.hull) {
      const r = Math.hypot(x + 0.5 - o.hull.cx, z + 0.5 - o.hull.cz);
      const hr = hullRadius(o.hull, x, y, z);
      outer = hr > 0.5 ? clamp(r / hr, 0, 1) : 0.6;
    }
    const yNorm = clamp((y - yLo) / ySpan, 0, 1);
    const exposure = 1 - clamp(o.sky[i] / 18, 0, 1);
    const n = o.noise.fbm3(x * nf, y * nf, z * nf, 2);
    const score = 0.45 * outer + 0.25 * yNorm + 0.2 * exposure + 0.1 * n;

    if (outer > 0.86 && isRim(vol, x, y, z)) {
      vol.data[i] = o.edge;
      continue;
    }
    vol.data[i] = score > 0.6 ? o.tones[0] : score > 0.42 ? o.tones[1] : o.tones[2];
  }
}

function isRim(vol: Volume, x: number, y: number, z: number): boolean {
  return (
    vol.get(x - 1, y, z) === 0 ||
    vol.get(x + 1, y, z) === 0 ||
    vol.get(x, y + 1, z) === 0 ||
    vol.get(x, y, z - 1) === 0 ||
    vol.get(x, y, z + 1) === 0
  );
}

/** Stable 0..1 hash, for per-cluster choices that must not flicker per voxel. */
export function hash01(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
