// Filling ground chunks on workers, for makeChunkedWorld's `fill`.
//
// A streamed ground at 100 voxels per metre spends 20-40 ms per chunk in the
// terrain's fillBrick, on the thread that draws. The fill is a pure function
// of the terrain, so it moves: each worker rebuilds the terrain once from a
// description the app sends (`init`), then answers requests of boxes with the
// bricks it filled, transferred. The main thread only copies bricks in.
//
// Two halves, as for the generator pool: `makeChunkFillPool` on the main
// thread, `serveChunks` in the worker. What `init` holds and how a worker
// turns it into a fill is the app's (a terrain package offers the data form
// and the rebuild); the engine only moves boxes and bricks.

import type { Box, ChunkFillSource, FilledBricks } from "../chunks";

/**
 * Fills one 8³ brick, the way an `editMany` fill callback does: `cells` holds the brick's 512
 * voxels (`lx + ly*8 + lz*64`), empty unless an earlier box of the same request already wrote to
 * it, and (ox, oy, oz) is its world origin. Write the voxels and return true if anything changed.
 */
export type ChunkFill = (cells: Uint8Array, ox: number, oy: number, oz: number) => boolean;

/** Messages the pool sends a chunk worker. */
export type ChunkRequest =
  /** Sent once, first: what the worker builds its fill from. */
  | { kind: "init"; init: unknown }
  /** Fill these boxes: six inclusive bounds per box (`x0, y0, z0, x1, y1, z1`). */
  | { kind: "fill"; id: number; boxes: Int32Array };

/** Messages a chunk worker sends the pool. */
export type ChunkResponse =
  /** `make` returned: the worker serves fills. */
  | { kind: "ready" }
  /** `make` threw: the worker cannot serve anything. */
  | { kind: "init-error"; message: string }
  /** The bricks a fill wrote ({@link FilledBricks}), buffers transferred. */
  | { kind: "filled"; id: number; count: number; origins: Int32Array; cells: Uint8Array; ms: number }
  /** The fill threw on this request. */
  | { kind: "error"; id: number; message: string };

/** Minimal shape of the worker global, so this file needs no DOM lib. */
interface ChunkScope {
  onmessage: ((ev: { data: ChunkRequest }) => void) | null;
  postMessage(message: ChunkResponse, transfer?: Transferable[]): void;
}

/** Options for {@link serveChunks}. */
export interface ServeChunksOptions {
  /**
   * Build this worker's fill from the `init` the pool sends (as given to
   * {@link ChunkFillPoolOptions.init}, structured-cloned). Called once. May return a promise
   * (loading a table, say); fills wait for it. If it throws, every request to this pool fails
   * with its message.
   */
  make: (init: unknown) => ChunkFill | Promise<ChunkFill>;
  /** The worker global (default `self`). */
  scope?: ChunkScope;
}

/**
 * Serve chunk fills on this worker until it is terminated: the worker side of
 * {@link makeChunkFillPool}. The pool sends `init` once; `make` turns it into a {@link ChunkFill};
 * then each request's boxes are filled brick by brick, each brick from empty, and the bricks
 * written come back in one transferred buffer. Requests run in the order they arrive, one at a
 * time.
 *
 * @example
 * ```ts
 * // ground.worker.ts: rebuild the app's terrain from its description, fill its bricks
 * import { serveChunks } from "@voxolith/engine/worker";
 * import { fineTerrainFrom, type FineTerrainInit } from "@voxolith/gen-terrain";
 * serveChunks({
 *   make(init) {
 *     const { fine, base } = init as { fine: FineTerrainInit; base: number };
 *     const ground = fineTerrainFrom(fine);
 *     return (cells, ox, oy, oz) => ground.fillBrick(cells, ox, oy, oz, base);
 *   },
 * });
 * ```
 */
export function serveChunks(opts: ServeChunksOptions): void {
  const scope = opts.scope ?? (self as unknown as ChunkScope);
  let fill: ChunkFill | undefined;
  let broken: string | undefined;
  /** Requests that arrived before `make` returned. */
  const early: Extract<ChunkRequest, { kind: "fill" }>[] = [];
  const scratch = new Uint8Array(512);

  function serve(req: Extract<ChunkRequest, { kind: "fill" }>): void {
    if (broken !== undefined) return scope.postMessage({ kind: "error", id: req.id, message: broken });
    const t0 = performance.now();
    try {
      const b = req.boxes;
      // Start room for the bricks the boxes cover (capped; it grows as needed).
      let bricks = 0;
      for (let i = 0; i + 5 < b.length; i += 6)
        bricks += ((b[i + 3] >> 3) - (b[i] >> 3) + 1) * ((b[i + 4] >> 3) - (b[i + 1] >> 3) + 1) * ((b[i + 5] >> 3) - (b[i + 2] >> 3) + 1);
      let cap = Math.max(16, Math.min(bricks, 4096));
      let origins = new Int32Array(cap * 3);
      let cells = new Uint8Array(cap * 512);
      let count = 0;
      /** Bricks written so far, so a brick two boxes share sees the first box's writes. */
      const seen = new Map<number, number>();
      for (let i = 0; i + 5 < b.length; i += 6) {
        const x0 = b[i] >> 3, y0 = b[i + 1] >> 3, z0 = b[i + 2] >> 3, x1 = b[i + 3] >> 3, y1 = b[i + 4] >> 3, z1 = b[i + 5] >> 3;
        for (let bz = z0; bz <= z1; bz++)
          for (let by = y0; by <= y1; by++)
            for (let bx = x0; bx <= x1; bx++) {
              const ox = bx * 8, oy = by * 8, oz = bz * 8;
              const k = (bz * 8192 + by) * 8192 + bx;
              const at = seen.get(k);
              if (at !== undefined) {
                fill!(cells.subarray(at * 512, at * 512 + 512), ox, oy, oz);
                continue;
              }
              scratch.fill(0);
              if (!fill!(scratch, ox, oy, oz)) continue;
              if (count === cap) {
                cap *= 2;
                const o = new Int32Array(cap * 3);
                o.set(origins);
                origins = o;
                const c = new Uint8Array(cap * 512);
                c.set(cells);
                cells = c;
              }
              origins[count * 3] = ox;
              origins[count * 3 + 1] = oy;
              origins[count * 3 + 2] = oz;
              cells.set(scratch, count * 512);
              seen.set(k, count++);
            }
      }
      scope.postMessage(
        { kind: "filled", id: req.id, count, origins, cells, ms: performance.now() - t0 },
        [origins.buffer, cells.buffer],
      );
    } catch (err) {
      scope.postMessage({ kind: "error", id: req.id, message: err instanceof Error ? err.message : String(err) });
    }
  }

  scope.onmessage = (ev) => {
    const req = ev.data;
    if (req?.kind === "init") {
      void (async () => {
        try {
          fill = await opts.make(req.init);
          if (typeof fill !== "function") throw new Error("serveChunks: `make` must return a fill function");
          scope.postMessage({ kind: "ready" });
        } catch (err) {
          broken = err instanceof Error ? err.message : String(err);
          scope.postMessage({ kind: "init-error", message: broken });
        }
        for (const r of early.splice(0)) serve(r);
      })();
      return;
    }
    if (req?.kind !== "fill") return;
    if (!fill && broken === undefined) early.push(req);
    else serve(req);
  };
}

/** Options for {@link makeChunkFillPool}. */
export interface ChunkFillPoolOptions {
  /**
   * Creates one worker running {@link serveChunks}. Only the consumer's bundler can resolve the
   * entry:
   *
   *   spawn: () => new Worker(new URL("./ground.worker.ts", import.meta.url), { type: "module" })
   */
  spawn: () => Worker;
  /**
   * What each worker builds its fill from, sent once to every worker (and to a replacement for
   * one that died). Structured-cloned, so plain data and typed arrays; a copy per worker. Opaque
   * to the engine: typically the app's terrain description plus its palette base.
   */
  init: unknown;
  /**
   * Workers to run. Defaults to one per core less one, capped at 4, as for the generator pool
   * (both pools share the machine while a scene loads; size them together).
   */
  size?: number;
  /**
   * Requests each worker keeps queued (default 2), so it starts the next while the main thread
   * is busy. The pool's `capacity` is `size * depth`.
   */
  depth?: number;
}

/**
 * A pool of chunk-fill workers, from {@link makeChunkFillPool}: a {@link ChunkFillSource} for
 * `makeChunkedWorld({ fill })`.
 */
export interface ChunkFillPool extends ChunkFillSource {
  /**
   * Fill every brick overlapping `boxes` on the next free worker. Rejects when the fill throws,
   * the worker dies running it (it is replaced), `make` failed, the request is aborted (with
   * `signal.reason`) or the pool is destroyed (an `AbortError`). An aborted request that is
   * already running still runs; its result is dropped.
   */
  fill(boxes: readonly Box[], opts?: { signal?: AbortSignal }): Promise<FilledBricks>;
  /** Resolves once every worker has built its fill; rejects if `make` failed. */
  ready(): Promise<void>;
  /** Terminate the workers; pending requests reject with an `AbortError`. */
  destroy(): void;
  /** Number of workers. */
  readonly size: number;
  /** Requests not yet settled (queued or running). */
  readonly pending: number;
}

interface Job {
  id: number;
  boxes: Int32Array;
  resolve: (r: FilledBricks) => void;
  reject: (e: unknown) => void;
  detach?: () => void;
  slot?: Slot;
}
interface Slot {
  worker: Worker;
  running: Set<Job>;
  ready: boolean;
}

const abortError = (message: string): Error => {
  if (typeof DOMException !== "undefined") return new DOMException(message, "AbortError");
  const e = new Error(message);
  e.name = "AbortError";
  return e;
};

/**
 * Fill ground chunks on a pool of workers, main-thread side: pass it as `makeChunkedWorld`'s
 * `fill`. Each worker runs {@link serveChunks}, gets `init` once, and fills the boxes it is sent.
 * Requests go to the least busy worker, up to `depth` each, and queue in order beyond that; the
 * chunked world keeps its own nearest-first queue and hands out only `capacity` at a time.
 * A worker that dies fails the request it was running (the others it held go to another worker)
 * and is replaced (with `init` sent again), unless it died
 * before it was ready, which fails the pool as `make` throwing does. Browser-only (needs
 * `Worker`).
 *
 * @example
 * ```ts
 * const fill = makeChunkFillPool({
 *   spawn: () => new Worker(new URL("./ground.worker.ts", import.meta.url), { type: "module" }),
 *   init: { fine: fineTerrainInit(ground), base: terrainBase },
 * });
 * const world = makeChunkedWorld({
 *   target: renderer, size: SIZE, chunk: 256, seed, load, fill,
 *   boxes: ({ box }) => columnBoxes(box, (ox, oz) => ground.columnSpan(ox, oz)),
 * });
 * // per frame, as without it:
 * world.focus(x, z, 2000);
 * if (world.step(4) > 0) loop.invalidate();
 * ```
 */
export function makeChunkFillPool(opts: ChunkFillPoolOptions): ChunkFillPool {
  const cores = (globalThis.navigator as { hardwareConcurrency?: number } | undefined)?.hardwareConcurrency ?? 4;
  const size = Math.max(1, Math.floor(opts.size ?? Math.max(1, Math.min(4, cores - 1))));
  const depth = Math.max(1, Math.floor(opts.depth ?? 2));
  const waiting: Job[] = [];
  const byId = new Map<number, Job>();
  let nextId = 1;
  let destroyed = false;
  /** Why the pool cannot serve (`make` threw, or a worker died before it was ready). */
  let broken: Error | undefined;
  let readyResolve!: () => void, readyReject!: (e: unknown) => void;
  const readyAll = new Promise<void>((res, rej) => ((readyResolve = res), (readyReject = rej)));
  readyAll.catch(() => {}); // only a caller of ready() hears about it

  function settle(job: Job): void {
    job.detach?.();
    byId.delete(job.id);
    job.slot?.running.delete(job);
  }

  function breakPool(err: Error): void {
    if (broken) return;
    broken = err;
    readyReject(err);
    for (const job of [...byId.values()]) {
      settle(job);
      job.reject(err);
    }
    waiting.length = 0;
  }

  function spawnSlot(): Slot {
    const worker = opts.spawn();
    const slot: Slot = { worker, running: new Set(), ready: false };
    worker.onmessage = (ev: MessageEvent<ChunkResponse>) => {
      const msg = ev.data;
      if (msg.kind === "ready") {
        slot.ready = true;
        if (slots.every((s) => s.ready)) readyResolve();
        return;
      }
      if (msg.kind === "init-error") {
        breakPool(new Error(`chunk fill worker: make() failed: ${msg.message}`));
        return;
      }
      const job = byId.get(msg.id);
      if (!job) return; // aborted: the result is dropped
      settle(job);
      if (msg.kind === "filled") job.resolve({ count: msg.count, origins: msg.origins, cells: msg.cells, ms: msg.ms });
      else job.reject(new Error(msg.message));
      drain();
    };
    worker.onerror = (ev: ErrorEvent) => {
      ev.preventDefault?.();
      const err = new Error(ev.message || "chunk fill worker failed");
      if (!slot.ready) {
        breakPool(err);
        return;
      }
      // A worker runs its requests in order, so the oldest is the one it died on: that one fails.
      // The others had not started; they go back to the front of the queue for another worker.
      const [culprit, ...rest] = [...slot.running];
      slot.running.clear();
      if (culprit) {
        settle(culprit);
        culprit.reject(err);
      }
      for (const job of rest) job.slot = undefined;
      waiting.unshift(...rest);
      worker.terminate();
      if (destroyed || broken) return;
      const i = slots.indexOf(slot);
      if (i >= 0) slots[i] = spawnSlot();
      drain();
    };
    worker.postMessage({ kind: "init", init: opts.init } satisfies ChunkRequest);
    return slot;
  }

  const slots: Slot[] = [];
  for (let i = 0; i < size; i++) slots.push(spawnSlot());

  function drain(): void {
    if (destroyed || broken) return;
    while (waiting.length) {
      // The least busy worker with room (a worker not ready yet queues its requests too).
      let best: Slot | undefined;
      for (const s of slots) if (s.running.size < depth && (!best || s.running.size < best.running.size)) best = s;
      if (!best) return;
      const job = waiting.shift()!;
      job.slot = best;
      best.running.add(job);
      // Cloned, not transferred (a chunk's boxes are a few KB): a request a dead worker held is
      // sent again to another.
      best.worker.postMessage({ kind: "fill", id: job.id, boxes: job.boxes } satisfies ChunkRequest);
    }
  }

  return {
    size,
    capacity: size * depth,
    get pending() {
      return byId.size;
    },
    ready: () => readyAll,
    fill(boxes, o = {}) {
      if (destroyed) return Promise.reject(abortError("chunk fill pool destroyed"));
      if (broken) return Promise.reject(broken);
      const signal = o.signal;
      if (signal?.aborted) return Promise.reject(signal.reason ?? abortError("The operation was aborted."));
      const flat = new Int32Array(boxes.length * 6);
      boxes.forEach((b, i) => flat.set([b.x0, b.y0, b.z0, b.x1, b.y1, b.z1], i * 6));
      return new Promise<FilledBricks>((resolve, reject) => {
        const job: Job = { id: nextId++, boxes: flat, resolve, reject };
        byId.set(job.id, job);
        if (signal) {
          const onAbort = () => {
            const q = waiting.indexOf(job);
            if (q >= 0) waiting.splice(q, 1);
            settle(job);
            reject(signal.reason ?? abortError("The operation was aborted."));
            drain();
          };
          signal.addEventListener("abort", onAbort, { once: true });
          job.detach = () => signal.removeEventListener("abort", onAbort);
        }
        waiting.push(job);
        drain();
      });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      const err = abortError("chunk fill pool destroyed");
      for (const job of [...byId.values()]) {
        settle(job);
        job.reject(err);
      }
      waiting.length = 0;
      for (const s of slots) s.worker.terminate();
      readyReject(err);
    },
  };
}
