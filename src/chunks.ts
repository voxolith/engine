// Chunk residency: build the world where the camera is, drop it where it is not.
//
// Building a whole world up front makes load time scale with world size, and
// memory with it. A resident set fixes both: chunks near the focus point are
// generated on demand, chunks that fall outside it are freed. What is resident
// is bounded, so the world it is cut from need not be.
//
// Chunks are columns — a square footprint over the full height — which suits a
// terrain world and keeps addressing to two axes. Generation must be a pure
// function of chunk coordinates, because the order chunks are visited in depends
// on where the camera went; see scatter.ts for the placement side of that.

import type { EntityModel } from "./entity";
import type { Orientation } from "./orient";
import { blitModelToBricks, type BrickTarget } from "./sink";
import { seededRandom } from "@voxolith/renderer/core";

/** An inclusive box of world voxels: `x0..x1`, `y0..y1`, `z0..z1`, the shape `Renderer.edit` takes. */
export interface Box {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

/** What a generator is handed for one chunk. */
export interface ChunkContext {
  /** Chunk coordinates: the chunk covers x from `cx * chunk`, z from `cz * chunk`. */
  cx: number;
  cz: number;
  /** World-voxel bounds of this chunk, full height. */
  box: Box;
  /** Deterministic for these coordinates, whatever order chunks are built in. */
  rng: () => number;
  /** Write voxels directly; the box is clamped to the chunk. */
  edit(box: Box, fill: (cells: Uint8Array, ox: number, oy: number, oz: number) => boolean): void;
  /**
   * Stamp a model, clipped to this chunk. Pass entities rooted in neighbouring
   * chunks too — the clip keeps each chunk writing only its own voxels, so a
   * tree that straddles a boundary comes out the same either way round.
   */
  blit(
    model: EntityModel,
    origin: { x: number; y: number; z: number },
    base: number,
    orientation?: Orientation,
  ): void;
}

/** Options for {@link makeChunkedWorld}. */
export interface ChunkedWorldOptions {
  /** Usually the Renderer. */
  target: BrickTarget & { clear(box: Box): void };
  /** World extent in voxels; chunks are columns over the full height. */
  size: { x: number; y: number; z: number };
  /** Chunk footprint in voxels. Should be a multiple of the 8-voxel brick. */
  chunk: number;
  /** Mixed with chunk coordinates into each chunk's `rng`. */
  seed: number;
  /** Fills one chunk. Must depend only on `ctx`, never on call order. */
  generate(ctx: ChunkContext): void;
}

/** A world built around a moving focus, from {@link makeChunkedWorld}. */
export interface ChunkedWorld {
  /**
   * Set the point to keep the world around. Chunks within `radius` are queued
   * nearest-first; chunks beyond `keep` (default `radius * 1.5`) are freed.
   * Cheap to call every frame — it only diffs the resident set.
   */
  focus(x: number, z: number, radius: number, keep?: number): void;
  /**
   * Build queued chunks for up to `budgetMs`, then stop. Returns how many are
   * still queued, so a caller can show progress or keep going next frame.
   */
  step(budgetMs?: number): number;
  /** Queued but not yet built. */
  readonly pending: number;
  /** Built and not yet freed. */
  readonly resident: number;
}

const key = (cx: number, cz: number) => `${cx},${cz}`;

/**
 * Build a world a chunk at a time around a focus point and free chunks that fall out of range,
 * so load time and memory scale with the view rather than the world. Chunks are square columns
 * over the full height, built nearest-first within a time budget.
 *
 * `generate` must be a pure function of its context, because the order chunks are built in
 * depends on where the camera went: draw randomness from `ctx.rng`, place things with
 * {@link scatterRegion}, and blit entities rooted in neighbouring chunks too (the blit clips to
 * this chunk). Freed chunks are cleared on the target and rebuilt from scratch if revisited, so
 * edits made to a chunk after it was built are lost.
 *
 * @returns The world; call `focus` when the camera moves and `step` every frame.
 * @example
 * ```ts
 * const world = makeChunkedWorld({
 *   target: renderer, size: SIZE, chunk: 64, seed,
 *   generate(ctx) {
 *     ctx.edit(ctx.box, (cells, ox, oy, oz) => terrain.fillBrick(cells, ox, oy, oz, groundBase));
 *     scatterRegion({ cell: 40, seed, salt: 1 }, ctx.box.x0 - 32, ctx.box.z0 - 32, ctx.box.x1 + 32, ctx.box.z1 + 32, (pt) => {
 *       if (pt.rng() < 0.5) ctx.blit(tree.model, { x: pt.x, y: terrain.heightAt(pt.x, pt.z) + 1, z: pt.z }, treeBase);
 *     });
 *   },
 * });
 * // per frame:
 * world.focus(target[0], target[2], 400);
 * if (world.step(6) > 0) loop.invalidate();
 * ```
 */
export function makeChunkedWorld(opts: ChunkedWorldOptions): ChunkedWorld {
  const { target, size, chunk, seed } = opts;
  const nx = Math.ceil(size.x / chunk);
  const nz = Math.ceil(size.z / chunk);
  const live = new Set<string>();
  const queued = new Set<string>();
  let queue: { cx: number; cz: number; d2: number }[] = [];

  const boxOf = (cx: number, cz: number): Box => ({
    x0: cx * chunk,
    y0: 0,
    z0: cz * chunk,
    x1: Math.min(size.x, (cx + 1) * chunk) - 1,
    y1: size.y - 1,
    z1: Math.min(size.z, (cz + 1) * chunk) - 1,
  });

  function build(cx: number, cz: number): void {
    const box = boxOf(cx, cz);
    const clamp = (b: Box): Box => ({
      x0: Math.max(b.x0, box.x0), y0: Math.max(b.y0, box.y0), z0: Math.max(b.z0, box.z0),
      x1: Math.min(b.x1, box.x1), y1: Math.min(b.y1, box.y1), z1: Math.min(b.z1, box.z1),
    });
    opts.generate({
      cx,
      cz,
      box,
      rng: seededRandom((Math.imul(cx, 0x85ebca6b) ^ Math.imul(cz, 0x27d4eb2f) ^ seed) >>> 0 || 1),
      edit(b, fill) {
        const c = clamp(b);
        if (c.x1 >= c.x0 && c.y1 >= c.y0 && c.z1 >= c.z0) target.edit(c, fill);
      },
      blit(model, origin, base, orientation) {
        blitModelToBricks(target, model, origin, base, orientation ?? 0, box);
      },
    });
    live.add(key(cx, cz));
  }

  return {
    get pending() {
      return queue.length;
    },
    get resident() {
      return live.size;
    },

    focus(x, z, radius, keep) {
      const fx = x / chunk;
      const fz = z / chunk;
      const r = radius / chunk;
      const k = (keep ?? radius * 1.5) / chunk;

      // Queue what is missing, nearest first, so the view fills from the middle.
      const want: { cx: number; cz: number; d2: number }[] = [];
      const lo = (v: number) => Math.max(0, Math.floor(v - r));
      for (let cz = lo(fz); cz <= Math.min(nz - 1, Math.ceil(fz + r)); cz++)
        for (let cx = lo(fx); cx <= Math.min(nx - 1, Math.ceil(fx + r)); cx++) {
          const dx = cx + 0.5 - fx;
          const dz = cz + 0.5 - fz;
          const d2 = dx * dx + dz * dz;
          if (d2 > r * r) continue;
          const kk = key(cx, cz);
          if (live.has(kk) || queued.has(kk)) continue;
          want.push({ cx, cz, d2 });
        }
      if (want.length) {
        for (const w of want) queued.add(key(w.cx, w.cz));
        queue = queue.concat(want).sort((a, b) => a.d2 - b.d2);
      }

      // Free what has drifted out. `keep` is larger than `radius` so a camera
      // jittering on the boundary does not rebuild the same chunk every frame.
      if (!Number.isFinite(k)) return;
      for (const kk of [...live]) {
        const [cx, cz] = kk.split(",").map(Number);
        const dx = cx + 0.5 - fx;
        const dz = cz + 0.5 - fz;
        if (dx * dx + dz * dz <= k * k) continue;
        target.clear(boxOf(cx, cz));
        live.delete(kk);
      }
    },

    step(budgetMs = 8) {
      const t0 = performance.now();
      while (queue.length) {
        const next = queue.shift()!;
        queued.delete(key(next.cx, next.cz));
        build(next.cx, next.cz);
        if (performance.now() - t0 >= budgetMs) break;
      }
      return queue.length;
    },
  };
}
