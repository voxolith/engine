// Scattered clumps: ellipsoids carved by noise, placed on a structure.
//
// The important property is that placement follows real geometry — twig tips,
// rock faces, whatever the generator hands over — rather than filling a global
// envelope. That is what stops a canopy reading as a lollipop: where the
// structure ends, the mass ends, so the outline inherits its irregularity.

import type { Vec3 } from "../entity";
import { mix, type Noise } from "./noise";
import { ellipsoid } from "./shapes";
import type { Volume } from "./volume";

export interface ClusterSpot {
  /** Centre of the clump, before the outward push. */
  p: Vec3;
  /** Direction to push the clump along, usually the twig's heading. */
  dir: Vec3;
  radius: number;
}

export interface ClusterOptions {
  /** Vertical squash, 1 is spherical. */
  flatten?: number;
  /** How far along `dir` to push the centre. */
  offset?: number;
  /** Per-cluster size variance, as ±fraction. */
  sizeVar?: number;
  /** Noise threshold at the core and at the rim; higher removes more. */
  fillCore: number;
  fillRim: number;
  /** Noise frequency; smaller means larger blobs. */
  scale: number;
  /** Fraction of spots actually used, for thinning. */
  density?: number;
}

export interface ClusterResult {
  /** Which cluster wrote each voxel; 0 means none. */
  clusterId: Uint16Array;
  clusters: number;
  placed: number;
}

/**
 * Write a carved clump at every spot, never overwriting existing voxels, and
 * record which cluster each voxel came from so later passes can make
 * per-cluster choices.
 */
export function placeClusters(
  vol: Volume,
  spots: ClusterSpot[],
  value: number,
  opts: ClusterOptions,
  noise: Noise,
  rng: () => number,
): ClusterResult {
  const clusterId = new Uint16Array(vol.data.length);
  const flatten = opts.flatten ?? 1;
  const offset = opts.offset ?? 0;
  const sizeVar = opts.sizeVar ?? 0.3;
  const density = opts.density ?? 1;
  let clusters = 0;
  let placed = 0;

  for (const s of spots) {
    if (density < 1 && rng() > density) continue;
    if (clusters >= 65534) break;
    const cid = ++clusters;
    // Per-cluster size variance drives the silhouette; without it every clump
    // is the same ball and the surface turns into one smooth shell.
    const r = s.radius * (1 - sizeVar + rng() * sizeVar * 2);
    const c: Vec3 = [
      s.p[0] + s.dir[0] * offset,
      s.p[1] + s.dir[1] * offset,
      s.p[2] + s.dir[2] * offset,
    ];
    // Decorrelate neighbouring clumps, or the carve pattern repeats visibly.
    const ox = rng() * 512, oy = rng() * 512, oz = rng() * 512;
    placed += ellipsoid(
      vol,
      c,
      [r, r * flatten, r],
      value,
      (x, y, z, d) =>
        noise.fbm3(x * opts.scale + ox, y * opts.scale + oy, z * opts.scale + oz, 2) >
        mix(opts.fillCore, opts.fillRim, d),
      {
        overwrite: false,
        onFill: (idx) => {
          clusterId[idx] = cid;
        },
      },
    );
  }

  return { clusterId, clusters, placed };
}

/** Sample points along a stem polyline at roughly even arc length. */
export function spotsAlong(
  points: Vec3[],
  arc: number[],
  spacing: number,
  radius: number,
  out: ClusterSpot[],
): void {
  let since = spacing; // place one immediately at the start
  for (let i = 1; i < points.length; i++) {
    since += arc[i] - arc[i - 1];
    if (since < spacing) continue;
    since = 0;
    const a = points[i - 1], b = points[i];
    const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    out.push({ p: [b[0], b[1], b[2]], dir: [d[0] / l, d[1] / l, d[2] / l], radius });
  }
}
