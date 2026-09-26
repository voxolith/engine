// Deterministic placement for worlds generated a chunk at a time.
//
// A global loop that rejection-samples positions works only when the whole world
// is built at once: it depends on how many points came before. Chunks are built
// in whatever order the camera reaches them, so placement has to be a pure
// function of position instead.
//
// The standard answer is a jittered grid: divide the world into cells, give each
// cell one candidate whose position and properties come from a hash of its
// coordinates. Any chunk can then work out its own candidates *and its
// neighbours'* without shared state, which is what lets a tree rooted in one
// chunk hang over into the next and still look the same whichever is built
// first.

import { seededRandom } from "@voxolith/renderer/core";

/** Options for {@link scatterRegion}. */
export interface ScatterOptions {
  /** Cell size in world voxels. One candidate per cell, so this sets density. */
  cell: number;
  /** World seed. */
  seed: number;
  /** Distinguishes layers, so trees and grass do not land on the same points. */
  salt?: number;
  /**
   * How far a candidate may stray from its cell centre, as a fraction of the
   * cell (0 = a rigid lattice, 0.5 = anywhere in the cell). Default 0.4, which
   * looks scattered while keeping a minimum spacing.
   */
  jitter?: number;
}

/** One candidate position from {@link scatterRegion}. */
export interface ScatterPoint {
  /** Position in whole world voxels. */
  x: number;
  z: number;
  /** Cell coordinates, useful as a stable id. */
  cx: number;
  cz: number;
  /**
   * Deterministic generator for this cell. Draw every decision about this
   * candidate from it — whether it exists, which species, which variant — and
   * the result stays identical however the world is traversed.
   */
  rng: () => number;
}

/** Mixes cell coordinates into a seed. Any good avalanche will do. */
function cellSeed(seed: number, salt: number, cx: number, cz: number): number {
  let h = (seed ^ Math.imul(salt, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ Math.imul(cx, 0x85ebca6b), 0xc2b2ae35) >>> 0;
  h = Math.imul(h ^ Math.imul(cz, 0x27d4eb2f), 0x165667b1) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h || 1;
}

/**
 * Visit every candidate whose cell overlaps the world-space rectangle
 * `[x0..x1] × [z0..z1]`.
 *
 * Expand the rectangle by the largest thing a candidate can produce before
 * calling this, or entities rooted just outside a chunk will not be drawn
 * where they reach into it.
 *
 * Every cell yields one candidate, so thin the layer by drawing from `p.rng` in `visit`. The same
 * options always give the same points, in any order of calls.
 *
 * @param x0 - With `z0`, `x1`, `z1`: the rectangle in world voxels, inclusive.
 * @param visit - Called once per candidate, row by row.
 * @example
 * ```ts
 * const m = 24; // the widest canopy, so trees rooted next door are drawn here too
 * scatterRegion({ cell: 40, seed, salt: 7 }, box.x0 - m, box.z0 - m, box.x1 + m, box.z1 + m, (pt) => {
 *   if (pt.rng() > 0.6) return;
 *   const variant = trees[Math.floor(pt.rng() * trees.length)];
 *   ctx.blit(variant.model, { x: pt.x, y: heightAt(pt.x, pt.z) + 1, z: pt.z }, treeBase);
 * });
 * ```
 */
export function scatterRegion(
  opts: ScatterOptions,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  visit: (p: ScatterPoint) => void,
): void {
  const { cell, seed } = opts;
  const salt = opts.salt ?? 0;
  const jitter = Math.max(0, Math.min(0.5, opts.jitter ?? 0.4));
  const cx0 = Math.floor(x0 / cell);
  const cz0 = Math.floor(z0 / cell);
  const cx1 = Math.floor(x1 / cell);
  const cz1 = Math.floor(z1 / cell);
  for (let cz = cz0; cz <= cz1; cz++)
    for (let cx = cx0; cx <= cx1; cx++) {
      const rng = seededRandom(cellSeed(seed, salt, cx, cz));
      // Draw the offset first so the caller's own draws stay aligned whatever
      // it decides to do with the point.
      const ox = (rng() * 2 - 1) * jitter * cell;
      const oz = (rng() * 2 - 1) * jitter * cell;
      visit({
        x: Math.round((cx + 0.5) * cell + ox),
        z: Math.round((cz + 0.5) * cell + oz),
        cx,
        cz,
        rng,
      });
    }
}
