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
import { LOAD_PHASES, type LoadTask, type LoadTracker } from "./load";

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

/**
 * The bricks one chunk request filled, from a {@link ChunkFillSource}: `count` bricks, brick `i`
 * at world origin `origins[3i..3i+2]` (multiples of 8) with its 512 voxels (`lx + ly*8 + lz*64`)
 * at `cells[512i..512i+511]`. Only bricks the fill wrote to are listed. The arrays may be longer
 * than `count` needs.
 */
export interface FilledBricks {
  /** How many bricks are listed. */
  count: number;
  /** Three world coordinates per brick: the brick's lowest corner. */
  origins: Int32Array;
  /** 512 voxels per brick, in `origins` order. */
  cells: Uint8Array;
  /** How long the worker spent filling, in ms (diagnostics only). */
  ms?: number;
}

/**
 * Where a chunked world gets its chunks filled off the main thread: `makeChunkFillPool` from
 * `@voxolith/engine/worker` implements it. Anything that fills boxes of bricks asynchronously
 * can stand in (a test, another transport).
 */
export interface ChunkFillSource {
  /**
   * Fill every brick overlapping `boxes`, each starting from empty (a brick two boxes share is
   * filled once per box, the second seeing what the first wrote, as `editMany` does), and resolve
   * with the bricks that were written. `signal` cancels: the promise then rejects and its result,
   * if the work had started, is dropped.
   */
  fill(boxes: readonly Box[], opts?: { signal?: AbortSignal }): Promise<FilledBricks>;
  /**
   * How many requests are worth having out at once (a pool: its workers times the requests each
   * keeps queued). The world hands out no more than this, so the rest of its queue stays in its
   * own nearest-first order and follows the focus.
   */
  readonly capacity: number;
}

/** A chunk as {@link ChunkedWorldOptions.boxes} is handed it. */
export interface ChunkRef {
  /** Chunk coordinates, as in {@link ChunkContext}. */
  cx: number;
  cz: number;
  /** World-voxel bounds of this chunk, full height. */
  box: Box;
}

/** Options for {@link makeChunkedWorld}. */
export interface ChunkedWorldOptions {
  /**
   * Usually the Renderer. With `fill`, chunks are applied through `editMany` when the target has
   * it (one upload per chunk), else through `edit` per box.
   */
  target: BrickTarget & {
    clear(box: Box): void;
    editMany?(boxes: readonly Box[], fill: (cells: Uint8Array, ox: number, oy: number, oz: number) => boolean): void;
  };
  /** World extent in voxels; chunks are columns over the full height. */
  size: { x: number; y: number; z: number };
  /** Chunk footprint in voxels. Should be a multiple of the 8-voxel brick. */
  chunk: number;
  /** Mixed with chunk coordinates into each chunk's `rng`. */
  seed: number;
  /**
   * Fills one chunk. Must depend only on `ctx`, never on call order. Required without `fill`.
   * With `fill` it is optional and runs on the main thread after the chunk's bricks are applied,
   * for what cannot move to a worker (blitting entities, say).
   */
  generate?(ctx: ChunkContext): void;
  /**
   * Fill chunks on workers instead of in `generate` (opt-in; usually `makeChunkFillPool` from
   * `@voxolith/engine/worker`). `focus` queues chunks as before; the world keeps up to
   * `fill.capacity` requests out, nearest first, and `step` applies the chunks that have come
   * back, nearest first, within its budget: the main thread only copies bricks in. A chunk counts
   * as built (`resident`, `pendingWithin`, `whenReady`, the `ground` phase) once it is applied.
   * A chunk freed (beyond `keep`) while queued or out is dropped, and its result with it.
   *
   * The worker fills each brick from empty and the brick is replaced by the result, which is
   * what `generate` writes whenever a chunk's bricks start empty, as they do (a chunk is new, or
   * cleared when freed). So `chunk` must be a multiple of 8 here, or two chunks would share
   * bricks. A request that fails leaves its chunk unbuilt: it is reported to `onError`, not
   * retried until it has been freed, and `whenReady` over it rejects.
   */
  fill?: ChunkFillSource;
  /**
   * With `fill`: the boxes to fill for a chunk, clamped to it (default the chunk's whole box).
   * Tight boxes are what make it cheap, e.g. one per 8x8 brick column from the terrain's
   * `columnSpan`. Runs on the main thread when the chunk is sent.
   */
  boxes?(chunk: ChunkRef): Box[];
  /**
   * With `fill`: called when a chunk's request fails (the fill threw, the worker died), with the
   * error. Default: `console.error`. Not called for requests the world cancelled itself.
   */
  onError?(error: unknown, chunk: ChunkRef): void;
  /**
   * Report into a load tracker under the `ground` phase: `focus` adds the chunks it newly
   * queues and `step` ticks each one it builds, so the total is what was actually asked for.
   * Freed chunks are not counted back; revisiting one queues it again and adds it again. The
   * phase ends when the queue is empty and starts again when the camera moves on.
   */
  load?: LoadTracker;
}

/** A world built around a moving focus, from {@link makeChunkedWorld}. */
export interface ChunkedWorld {
  /**
   * Set the point to keep the world around. Chunks within `radius` are queued
   * nearest-first; chunks beyond `keep` (default `radius * 1.5`) are freed.
   * Cheap to call every frame — it only diffs the resident set. When the point
   * moves, chunks still queued are re-ranked from it, so the queue stays
   * nearest-first to the latest focus.
   */
  focus(x: number, z: number, radius: number, keep?: number): void;
  /**
   * Build queued chunks for up to `budgetMs`, then stop. Returns how many are
   * still queued, so a caller can show progress or keep going next frame.
   *
   * With `fill`, it applies the chunks that have come back from the workers instead (at least
   * one, if any has, then more while within the budget) and sends more requests; the count it
   * returns includes the chunks still out, so keep stepping (and rendering) while it is above 0.
   */
  step(budgetMs?: number): number;
  /** Queued but not yet built (with `fill`: queued, out on a worker, or back and not applied yet). */
  readonly pending: number;
  /** Built and not yet freed. */
  readonly resident: number;
  /**
   * Chunks near a point that are not built yet: those whose centre lies within `radius` voxels of
   * (x, z) (the test `focus` queues by), inside the world, and not resident, whether queued or
   * not. Data for a loading screen that waits for the ground around the camera rather than the
   * whole focus radius. Costs one test per chunk in the square around the point.
   *
   * @returns 0 once everything within `radius` is built.
   */
  pendingWithin(x: number, z: number, radius: number): number;
  /** `pendingWithin(x, z, radius) === 0`: every chunk within `radius` of (x, z) is built. */
  readyAround(x: number, z: number, radius: number): boolean;
  /**
   * Resolves once {@link ChunkedWorld.readyAround} holds: at once if it does, else after the
   * `step` that builds the last missing chunk. The world only builds in `step`, and only what
   * `focus` queued, so keep stepping and focus on a radius of at least `radius` around the point,
   * or this never resolves. `signal` rejects it with `signal.reason`. With `fill`, it rejects
   * with the error when a chunk within `radius` failed to fill.
   */
  whenReady(x: number, z: number, radius: number, opts?: { signal?: AbortSignal }): Promise<void>;
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
 * With `fill` (opt-in), chunks are filled on workers instead: `makeChunkFillPool` from
 * `@voxolith/engine/worker` rebuilds the app's fill from a description sent once per worker and
 * answers each chunk's boxes with the bricks it wrote; `step` only copies them in, nearest first,
 * within its budget. Measured in bun on a gen-terrain fine ground at 100 voxels per metre (256²
 * chunks, one box per brick column): 50 ms per chunk on the main thread synchronously, against
 * 42 ms on a worker plus 10 ms on the main thread, almost all of it the brick grid encoding what
 * it is given. Everything else (`focus`, `pendingWithin`, `whenReady`, the `ground` phase) reads
 * the same either way, counting a chunk as built once it is applied.
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
 *
 * // The same ground, filled on workers (see makeChunkFillPool and serveChunks):
 * const ground = makeChunkedWorld({
 *   target: renderer, size: SIZE, chunk: 256, seed, load,
 *   fill: makeChunkFillPool({ spawn, init: { fine: fineTerrainInit(terrain), base: groundBase } }),
 *   boxes: ({ box }) => columnBoxes(box, (ox, oz) => terrain.columnSpan(ox, oz)),
 * });
 * ```
 */
export function makeChunkedWorld(opts: ChunkedWorldOptions): ChunkedWorld {
  const { target, size, chunk, seed } = opts;
  const source = opts.fill;
  if (!source && !opts.generate) throw new Error("makeChunkedWorld: give `generate`, or `fill` to fill chunks on workers");
  if (source && (chunk % 8 !== 0 || chunk <= 0))
    throw new Error(`makeChunkedWorld: with \`fill\`, \`chunk\` must be a positive multiple of the 8-voxel brick (got ${chunk})`);
  const nx = Math.ceil(size.x / chunk);
  const nz = Math.ceil(size.z / chunk);
  const live = new Set<string>();
  /** Queued chunks; with `fill`, also those out on a worker or back and not applied yet. */
  const queued = new Set<string>();
  let queue: { cx: number; cz: number; d2: number }[] = [];
  let task: LoadTask | undefined;
  /** The focus (in chunks) the queue was last ranked from. */
  let sortedAt = [NaN, NaN];
  let waiters: { x: number; z: number; r: number; resolve: () => void; reject: (e: unknown) => void; detach?: () => void }[] = [];

  // --- the asynchronous path's state (only used with `fill`) ---
  interface Flight {
    cx: number;
    cz: number;
    /** Its own item on the `ground` phase: ticked when applied, ended unticked when dropped. */
    task?: LoadTask;
    ctrl: AbortController;
    boxes: Box[];
    result?: FilledBricks;
  }
  /** Requests out on the source, by chunk key. */
  const flying = new Map<string, Flight>();
  /** Results back and not applied yet. */
  let landed: Flight[] = [];
  /** Chunks whose fill failed, with the error: not requeued until freed. */
  const failed = new Map<string, unknown>();

  /** Of the chunks within `radius` of (x, z): how many are not built, and a failure among them. */
  const scan = (x: number, z: number, radius: number): { n: number; error?: { e: unknown } } => {
    const fx = x / chunk, fz = z / chunk, r = radius / chunk;
    if (!(r >= 0)) return { n: 0 };
    let n = 0;
    let error: { e: unknown } | undefined;
    for (let cz = Math.max(0, Math.floor(fz - r)); cz <= Math.min(nz - 1, Math.ceil(fz + r)); cz++)
      for (let cx = Math.max(0, Math.floor(fx - r)); cx <= Math.min(nx - 1, Math.ceil(fx + r)); cx++) {
        const dx = cx + 0.5 - fx, dz = cz + 0.5 - fz;
        if (dx * dx + dz * dz > r * r) continue;
        const k = key(cx, cz);
        if (live.has(k)) continue;
        n++;
        if (!error && failed.size && failed.has(k)) error = { e: failed.get(k) };
      }
    return { n, error };
  };
  const pendingWithin = (x: number, z: number, radius: number): number => scan(x, z, radius).n;
  /** Settle the waiters whose area is built (or, with `fill`, holds a chunk that failed). */
  const wake = () => {
    if (!waiters.length) return;
    const settled: { w: (typeof waiters)[number]; error?: { e: unknown } }[] = [];
    for (const w of waiters) {
      const s = scan(w.x, w.z, w.r);
      if (s.n === 0 || s.error) settled.push({ w, error: s.error });
    }
    if (!settled.length) return;
    waiters = waiters.filter((w) => !settled.some((s) => s.w === w));
    for (const { w, error } of settled) {
      w.detach?.();
      if (error) w.reject(error.e);
      else w.resolve();
    }
  };

  const boxOf = (cx: number, cz: number): Box => ({
    x0: cx * chunk,
    y0: 0,
    z0: cz * chunk,
    x1: Math.min(size.x, (cx + 1) * chunk) - 1,
    y1: size.y - 1,
    z1: Math.min(size.z, (cz + 1) * chunk) - 1,
  });
  const clampTo = (box: Box, b: Box): Box => ({
    x0: Math.max(b.x0, box.x0), y0: Math.max(b.y0, box.y0), z0: Math.max(b.z0, box.z0),
    x1: Math.min(b.x1, box.x1), y1: Math.min(b.y1, box.y1), z1: Math.min(b.z1, box.z1),
  });
  const nonEmpty = (c: Box) => c.x1 >= c.x0 && c.y1 >= c.y0 && c.z1 >= c.z0;

  /** Run `generate` for a chunk (the whole build without `fill`; the main-thread part with it). */
  function generateAt(cx: number, cz: number, generate: (ctx: ChunkContext) => void): void {
    const box = boxOf(cx, cz);
    generate({
      cx,
      cz,
      box,
      rng: seededRandom((Math.imul(cx, 0x85ebca6b) ^ Math.imul(cz, 0x27d4eb2f) ^ seed) >>> 0 || 1),
      edit(b, fill) {
        const c = clampTo(box, b);
        if (nonEmpty(c)) target.edit(c, fill);
      },
      blit(model, origin, base, orientation) {
        blitModelToBricks(target, model, origin, base, orientation ?? 0, box);
      },
    });
  }

  function build(cx: number, cz: number): void {
    generateAt(cx, cz, opts.generate!);
    live.add(key(cx, cz));
  }

  // --- the asynchronous path ---

  /** Copy a landed chunk's bricks in: the main thread's whole share of the work. */
  function apply(f: Flight): void {
    const r = f.result!;
    const at = new Map<number, number>();
    for (let i = 0; i < r.count; i++)
      at.set(brickKey(r.origins[i * 3], r.origins[i * 3 + 1], r.origins[i * 3 + 2]), i);
    const copy = (cells: Uint8Array, ox: number, oy: number, oz: number): boolean => {
      const i = at.get(brickKey(ox, oy, oz));
      if (i === undefined) return false;
      cells.set(r.cells.subarray(i * 512, i * 512 + 512));
      return true;
    };
    if (target.editMany) target.editMany(f.boxes, copy);
    else for (const b of f.boxes) target.edit(b, copy);
    if (opts.generate) generateAt(f.cx, f.cz, opts.generate);
    const k = key(f.cx, f.cz);
    queued.delete(k);
    live.add(k);
    f.task?.tick(1);
    f.task?.end();
  }

  /** Forget a chunk that is queued, out or landed (it was freed): its item leaves the phase. */
  function drop(f: Flight): void {
    f.ctrl.abort();
    f.task?.end();
    queued.delete(key(f.cx, f.cz));
  }

  /** Hand queued chunks to the source, nearest first, up to its capacity. */
  function pump(): void {
    if (!source) return;
    const cap = Math.max(1, Math.floor(source.capacity) || 1);
    while (queue.length && flying.size < cap) {
      const next = queue.shift()!;
      const k = key(next.cx, next.cz);
      const box = boxOf(next.cx, next.cz);
      const f: Flight = { cx: next.cx, cz: next.cz, ctrl: new AbortController(), boxes: [], task: tasks.get(k) };
      tasks.delete(k);
      try {
        const asked = opts.boxes ? opts.boxes({ cx: next.cx, cz: next.cz, box }) : [box];
        for (const b of asked) {
          const c = clampTo(box, b);
          if (nonEmpty(c)) f.boxes.push(c);
        }
      } catch (err) {
        fail(f, k, err);
        continue;
      }
      flying.set(k, f);
      let p: Promise<FilledBricks>;
      try {
        p = source.fill(f.boxes, { signal: f.ctrl.signal });
      } catch (err) {
        p = Promise.reject(err);
      }
      p.then(
        (result) => {
          if (flying.get(k) !== f) return; // dropped meanwhile: the result is stale
          flying.delete(k);
          f.result = result;
          landed.push(f);
          pump();
        },
        (err) => {
          if (flying.get(k) !== f) return; // cancelled by the world itself
          flying.delete(k);
          fail(f, k, err);
          pump();
        },
      );
    }
  }
  /** A chunk whose request failed: unbuilt, remembered, reported, and its waiters told. */
  function fail(f: Flight, k: string, err: unknown): void {
    queued.delete(k);
    f.task?.end();
    failed.set(k, err);
    if (!(err instanceof Error && err.name === "AbortError")) {
      const ref = { cx: f.cx, cz: f.cz, box: boxOf(f.cx, f.cz) };
      if (opts.onError) opts.onError(err, ref);
      else console.error(`voxolith: chunk ${k} failed to fill`, err);
    }
    wake();
  }
  /** Per-chunk load items of queued chunks, by key (the asynchronous path counts per chunk). */
  const tasks = new Map<string, LoadTask>();

  return {
    get pending() {
      return queue.length + flying.size + landed.length;
    },
    get resident() {
      return live.size;
    },
    pendingWithin,
    readyAround: (x, z, radius) => pendingWithin(x, z, radius) === 0,
    whenReady(x, z, radius, o = {}) {
      const signal = o.signal;
      if (signal?.aborted) return Promise.reject(signal.reason);
      const now = scan(x, z, radius);
      if (now.n === 0) return Promise.resolve();
      if (now.error) return Promise.reject(now.error.e);
      return new Promise<void>((resolve, reject) => {
        const w: (typeof waiters)[number] = { x, z, r: radius, resolve, reject };
        if (signal) {
          const onAbort = () => {
            waiters = waiters.filter((v) => v !== w);
            reject(signal.reason);
          };
          signal.addEventListener("abort", onAbort, { once: true });
          w.detach = () => signal.removeEventListener("abort", onAbort);
        }
        waiters.push(w);
      });
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
          if (failed.size && failed.has(kk)) continue;
          want.push({ cx, cz, d2 });
        }
      // Chunks queued for an earlier focus are re-ranked from this one, so the queue stays
      // nearest-first wherever the camera went (a sort of what is queued, only when it moved).
      const moved = fx !== sortedAt[0] || fz !== sortedAt[1];
      if (moved && queue.length) {
        for (const q of queue) q.d2 = (q.cx + 0.5 - fx) ** 2 + (q.cz + 0.5 - fz) ** 2;
        if (!want.length) queue.sort((a, b) => a.d2 - b.d2);
      }
      sortedAt = [fx, fz];
      if (want.length) {
        for (const w of want) queued.add(key(w.cx, w.cz));
        queue = queue.concat(want).sort((a, b) => a.d2 - b.d2);
        if (opts.load) {
          if (source) {
            // One item per chunk, so a chunk dropped before it is applied leaves the total.
            for (const w of want) tasks.set(key(w.cx, w.cz), opts.load.task(LOAD_PHASES.ground, 1));
          } else {
            task ??= opts.load.task(LOAD_PHASES.ground);
            task.add(want.length);
          }
        }
      }

      // Free what has drifted out. `keep` is larger than `radius` so a camera
      // jittering on the boundary does not rebuild the same chunk every frame.
      if (!Number.isFinite(k)) {
        pump();
        return;
      }
      const far = (cx: number, cz: number) => (cx + 0.5 - fx) ** 2 + (cz + 0.5 - fz) ** 2 > k * k;
      for (const kk of [...live]) {
        const [cx, cz] = kk.split(",").map(Number);
        if (!far(cx, cz)) continue;
        target.clear(boxOf(cx, cz));
        live.delete(kk);
      }
      if (source) {
        // Chunks not built yet that fell out are dropped: queued, out (its result is ignored when
        // it lands) or landed. A failure out there is forgotten, so coming back retries it.
        if (queue.some((q) => far(q.cx, q.cz))) {
          queue = queue.filter((q) => {
            if (!far(q.cx, q.cz)) return true;
            const kk = key(q.cx, q.cz);
            queued.delete(kk);
            tasks.get(kk)?.end();
            tasks.delete(kk);
            return false;
          });
        }
        for (const [kk, f] of [...flying])
          if (far(f.cx, f.cz)) {
            flying.delete(kk);
            drop(f);
          }
        if (landed.some((f) => far(f.cx, f.cz)))
          landed = landed.filter((f) => {
            if (!far(f.cx, f.cz)) return true;
            drop(f);
            return false;
          });
        for (const kk of [...failed.keys()]) {
          const [cx, cz] = kk.split(",").map(Number);
          if (far(cx, cz)) failed.delete(kk);
        }
        pump();
      }
    },

    step(budgetMs = 8) {
      const t0 = performance.now();
      if (source) {
        if (landed.length > 1) {
          const [fx, fz] = sortedAt;
          const d2 = (f: Flight) => (f.cx + 0.5 - fx) ** 2 + (f.cz + 0.5 - fz) ** 2;
          landed.sort((a, b) => d2(a) - d2(b));
        }
        while (landed.length) {
          apply(landed.shift()!);
          if (performance.now() - t0 >= budgetMs) break;
        }
        pump();
        wake();
        return queue.length + flying.size + landed.length;
      }
      while (queue.length) {
        const next = queue.shift()!;
        queued.delete(key(next.cx, next.cz));
        build(next.cx, next.cz);
        task?.tick(1);
        if (performance.now() - t0 >= budgetMs) break;
      }
      if (task && queue.length === 0) {
        task.end();
        task = undefined;
      }
      wake();
      return queue.length;
    },
  };
}

/** A brick's origin as one number (origins are multiples of 8, within 2^16 voxels an axis). */
const brickKey = (ox: number, oy: number, oz: number) => ((oz >> 3) * 8192 + (oy >> 3)) * 8192 + (ox >> 3);

/**
 * One box per 8x8 brick column of `box`, each as tall as `span` says that column's contents
 * reach: the tight boxes a terrain fills fastest, for `ctx.edit` / `editMany` or
 * {@link ChunkedWorldOptions.boxes}. Columns whose span is empty (`y1 < y0`) are left out; spans
 * are clamped to `box`.
 *
 * @param box - The area, usually a chunk's box.
 * @param span - The lowest and highest Y written in the brick column at (ox, oz), e.g. a fine
 * terrain's `columnSpan`.
 * @returns The boxes, x fastest.
 */
export function columnBoxes(box: Box, span: (ox: number, oz: number) => readonly [number, number]): Box[] {
  const out: Box[] = [];
  for (let oz = box.z0 - (box.z0 & 7); oz <= box.z1; oz += 8)
    for (let ox = box.x0 - (box.x0 & 7); ox <= box.x1; ox += 8) {
      const [a, b] = span(ox, oz);
      const y0 = Math.max(box.y0, a), y1 = Math.min(box.y1, b);
      if (y1 < y0) continue;
      out.push({ x0: Math.max(box.x0, ox), y0, z0: Math.max(box.z0, oz), x1: Math.min(box.x1, ox + 7), y1, z1: Math.min(box.z1, oz + 7) });
    }
  return out;
}
