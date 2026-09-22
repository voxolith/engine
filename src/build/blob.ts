// Noise-displaced superellipsoid: the shape most solid natural things start
// from. A rock, a mushroom cap, a termite mound and a coral head are all "a
// rounded mass with a bumpy surface"; what differs is how boxy the mass is and
// how rough the bumps are, which is exactly what this exposes.
//
// The superellipsoid exponent gives the silhouette family: 2 is a true
// ellipsoid, 3–4 is a rounded box (a river boulder), 6+ approaches a slab. The
// displacement is fbm evaluated on the direction from the centre, so it wraps
// around the shape without seams and scales with the radius.

import type { Noise } from "./noise";
import type { Volume } from "./volume";
import type { Vec3 } from "../entity";

export interface BlobOptions {
  centre: Vec3;
  /** Half-extents per axis, in voxels. */
  radii: Vec3;
  /** Superellipsoid exponent; 2 = ellipsoid, higher = boxier. Default 2.4. */
  exponent?: number;
  noise: Noise;
  /** Surface displacement as a fraction of the radius. 0 = smooth. Default 0.12. */
  roughness?: number;
  /** Bumps per radius: 1 gives a few big lumps, 4 gives fine grit. Default 1.8. */
  detail?: number;
  octaves?: number;
  /**
   * Fine displacement in absolute voxels, sampled in world space. Low-frequency
   * bumps on a shallow slope quantise into contour-line terraces; a voxel or so
   * of high-frequency grit breaks them up. Default 0.
   */
  grit?: number;
  /** Grit frequency in 1/voxel. Default 0.35. */
  gritDetail?: number;
  /** Decorrelates the noise between blobs sharing one Noise instance. */
  seed?: number;
  /** Nothing is written below this y (a rock sitting in the ground). */
  floorY?: number;
}

/** Fill the blob with `value`; returns the voxel count written. */
export function blob(vol: Volume, o: BlobOptions, value: number): number {
  const [cx, cy, cz] = o.centre;
  const [rx, ry, rz] = o.radii;
  const n = o.exponent ?? 2.4;
  const rough = o.roughness ?? 0.12;
  const detail = o.detail ?? 1.8;
  const oct = o.octaves ?? 3;
  const grit = o.grit ?? 0;
  const gf = o.gritDetail ?? 0.35;
  const s = (o.seed ?? 0) * 17.31;
  const rMean = (rx + ry + rz) / 3;
  const floorY = o.floorY ?? -Infinity;
  // The surface can push out by `rough`, so scan that much further.
  const pad = 1 + rough + grit / rMean;
  const x0 = Math.max(0, Math.floor(cx - rx * pad)), x1 = Math.min(vol.sx - 1, Math.ceil(cx + rx * pad));
  const y0 = Math.max(0, Math.floor(cy - ry * pad), Math.ceil(floorY)), y1 = Math.min(vol.sy - 1, Math.ceil(cy + ry * pad));
  const z0 = Math.max(0, Math.floor(cz - rz * pad)), z1 = Math.min(vol.sz - 1, Math.ceil(cz + rz * pad));
  let filled = 0;
  for (let z = z0; z <= z1; z++)
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const ux = (x + 0.5 - cx) / rx, uy = (y + 0.5 - cy) / ry, uz = (z + 0.5 - cz) / rz;
        // Superellipsoid "radius": 1 on the undisplaced surface.
        const f = Math.pow(Math.pow(Math.abs(ux), n) + Math.pow(Math.abs(uy), n) + Math.pow(Math.abs(uz), n), 1 / n);
        if (f > pad) continue;
        let limit = 1;
        if (rough > 0) {
          // Sample on the unit direction so the bumps ride the surface rather
          // than being a volume texture the shape happens to cut through.
          const inv = f > 1e-6 ? 1 / f : 0;
          const dx = ux * inv * detail + s, dy = uy * inv * detail + s * 0.7, dz = uz * inv * detail - s * 0.4;
          limit = 1 + rough * (o.noise.fbm3(dx, dy, dz, oct) * 2 - 1);
        }
        if (grit > 0) limit += (grit / rMean) * (o.noise.value3(x * gf + s, y * gf, z * gf - s, 5) * 2 - 1);
        if (f > limit) continue;
        if (vol.get(x, y, z) === 0) filled++;
        vol.set(x, y, z, value);
      }
  return filled;
}
