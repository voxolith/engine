// Writing models into a world that has no dense array.
//
// blitModel needs somewhere to put voxels. For a small scene that is a dense
// Uint8Array, which is simple and fast. For a large one it is not: the examples
// forest at 8x8 tiles would need 1.1 GB of Uint8Array purely as a staging copy
// of a world the GPU already holds sparsely in 159 MB.
//
// A BrickSink writes straight into brick storage instead. It is structurally
// typed against Renderer.edit rather than importing the renderer, so the engine
// keeps its one-way dependency.

import type { EntityModel } from "./entity";
import { orientAnchor, orientVoxel, type Orientation } from "./orient";

/** Anything that can hand out bricks to edit — `Renderer.edit` satisfies this. */
export interface BrickTarget {
  edit(
    box: { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number },
    fill: (cells: Uint8Array, ox: number, oy: number, oz: number) => boolean,
  ): void;
}

const B = 8;

/**
 * Stamp a model into brick storage at `origin`, mapping role `v` to palette slot
 * `base + v - 1`, exactly as blitModel does for a dense world.
 *
 * Bricks are visited once each and written through a 512-voxel scratch, so cost
 * is proportional to the model's bounding box rather than to the world.
 */
export function blitModelToBricks(
  target: BrickTarget,
  model: EntityModel,
  origin: { x: number; y: number; z: number },
  base: number,
  orientation: Orientation = 0,
  /**
   * Restrict writes to this world-space box. Chunked worlds need it: a chunk
   * draws every entity that reaches into it, including ones rooted in its
   * neighbours, and must write only its own voxels so the result does not
   * depend on which chunk was generated first.
   */
  clip?: { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number },
): void {
  const { x: sx, y: sy, z: sz } = model.size;
  const anchor = orientation === 0 ? model.anchor : orientAnchor(orientation, model.anchor, model.size);
  const ox = Math.round(origin.x - anchor[0]);
  const oy = Math.round(origin.y - anchor[1]);
  const oz = Math.round(origin.z - anchor[2]);
  // Reject against the clip box before touching the model. A chunked world
  // offers every chunk each entity that could reach it, so most calls here are
  // misses, and a miss must not cost a scan of the whole model.
  if (clip) {
    const swap = (orientation & 1) === 1;
    const ex = swap ? sz : sx;
    const ez = swap ? sx : sz;
    if (ox > clip.x1 || ox + ex - 1 < clip.x0) return;
    if (oy > clip.y1 || oy + sy - 1 < clip.y0) return;
    if (oz > clip.z1 || oz + ez - 1 < clip.z0) return;
  }

  // Bucket the model's solid voxels by destination brick in one pass. Visiting
  // the model once per brick instead would be quadratic: an oak is 462k cells
  // spread over ~900 bricks.
  const buckets = new Map<number, number[]>();
  const p: [number, number, number] = [0, 0, 0];
  let bx0 = Infinity, by0 = Infinity, bz0 = Infinity;
  let bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity;
  for (let z = 0; z < sz; z++)
    for (let y = 0; y < sy; y++) {
      const row = y * sx + z * sx * sy;
      for (let x = 0; x < sx; x++) {
        const v = model.data[row + x];
        if (v === 0) continue;
        if (orientation !== 0) orientVoxel(orientation, x, y, z, model.size, p);
        else {
          p[0] = x;
          p[1] = y;
          p[2] = z;
        }
        const wx = ox + p[0], wy = oy + p[1], wz = oz + p[2];
        if (clip && (wx < clip.x0 || wx > clip.x1 || wy < clip.y0 || wy > clip.y1 || wz < clip.z0 || wz > clip.z1))
          continue;
        const cx = Math.floor(wx / B), cy = Math.floor(wy / B), cz = Math.floor(wz / B);
        if (cx < bx0) bx0 = cx;
        if (cy < by0) by0 = cy;
        if (cz < bz0) bz0 = cz;
        if (cx > bx1) bx1 = cx;
        if (cy > by1) by1 = cy;
        if (cz > bz1) bz1 = cz;
        // Brick key is only used within this call, so any injective mix will do.
        const key = (cx * 73856093) ^ (cy * 19349663) ^ (cz * 83492791);
        let arr = buckets.get(key);
        if (!arr) {
          arr = [];
          buckets.set(key, arr);
        }
        // Local index and value, interleaved, to keep one flat array per brick.
        arr.push((wx - cx * B) + (wy - cy * B) * B + (wz - cz * B) * B * B, base + v - 1);
      }
    }
  if (buckets.size === 0) return;

  target.edit(
    { x0: bx0 * B, y0: by0 * B, z0: bz0 * B, x1: bx1 * B + B - 1, y1: by1 * B + B - 1, z1: bz1 * B + B - 1 },
    (cells, cbx, cby, cbz) => {
      const cx = cbx / B, cy = cby / B, cz = cbz / B;
      const arr = buckets.get((cx * 73856093) ^ (cy * 19349663) ^ (cz * 83492791));
      if (!arr) return false;
      for (let i = 0; i < arr.length; i += 2) cells[arr[i]] = arr[i + 1];
      return true;
    },
  );
}
