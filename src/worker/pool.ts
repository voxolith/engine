// Main-thread side of the generator pool.
//
// Generation is the single most expensive part of building a scene and it is
// pure CPU work with no DOM contact, so it belongs off the render thread. Doing
// it inline competes with the frame loop: yielding between entities keeps the
// page responsive but the work still lands on the one thread that has to draw.
//
// The pool owns N workers and hands each the next queued request, so generation
// also parallelises across cores rather than merely moving sideways.
//
// It also gives the app controls over that queue (priority, cancelling, pausing),
// and picks no policy with them: without options it behaves as a plain FIFO.

import type { Entity, EntityModel } from "../entity";
import type { GenerateContext } from "../generator";
import type { GenerateRequest, WorkerResponse } from "./protocol";
import { LOAD_PHASES, type LoadTask, type LoadTracker } from "../load";
import { unpackEntity } from "./cache";

/** Options for {@link makeGeneratorPool}. */
export interface GeneratorPoolOptions {
  /**
   * Creates one worker. The consumer supplies this because only their bundler can resolve a
   * worker entry:
   *
   *   spawn: () => new Worker(new URL("./gen.worker.ts", import.meta.url), { type: "module" })
   */
  spawn: () => Worker;
  /**
   * Workers to run. Defaults to one per core less one, capped at 4 — generation
   * is memory-heavy and the main thread still needs a core to draw on.
   */
  size?: number;
  /**
   * Report into a load tracker under the `models` phase: one item per request as it is queued,
   * a tick as each result (or error) comes back, marked `cached` when the worker's model cache
   * served it and labelled with the generator id. An aborted request leaves the total, so an idle
   * phase always reads done === total. The phase is busy while requests are pending (queued,
   * paused or running) and ends when none are; the next request starts it again.
   */
  load?: LoadTracker;
  /**
   * When a running request is aborted, terminate its worker and start a fresh one, instead of
   * letting the worker finish a model nobody wants. Off by default: a new worker reloads its
   * script and generators (a few hundred ms), and model-cache writes still in progress on the
   * old one are lost. Worth it when single models take seconds (fine scales, phones) and a game
   * cancels often, e.g. streaming models around a moving player.
   */
  respawnOnAbort?: boolean;
  /**
   * How long `destroy()` lets an idle worker finish its model-cache writes before terminating it
   * anyway, in ms (default 10000).
   */
  closeTimeoutMs?: number;
}

/**
 * One entity to generate. Everything in it is posted to a worker, so it must be structured-
 * cloneable (plain data, no functions).
 */
export interface GenerateSpec {
  /** `EntityGenerator.id`, registered in the worker (e.g. "voxolith/tree.broadleaf"). */
  generator: string;
  /** The generator's parameters, in its units (10 voxels per metre). */
  params: unknown;
  /** Seeds the generator's rng; the same spec always gives the same entity. */
  seed: number;
  /** Sets the produced entity's `id`. */
  entityId?: string;
  /** Passed to the generator, e.g. { voxelsPerMetre: 100 }. */
  ctx?: GenerateContext;
}

/** How to run one request, for {@link GeneratorPool.generate}. Every field is optional. */
export interface GenerateOptions {
  /**
   * Queue priority (default 0): a free worker takes the highest-priority queued request, in the
   * order they were queued within one priority. Running requests are never pre-empted. Change it
   * later with {@link GeneratorPool.reprioritise}.
   */
  priority?: number;
  /**
   * Cancel the request. A queued one leaves the queue; a running one rejects at once and its
   * result is discarded when it lands, but the worker still finishes it, because a generator runs
   * synchronously and cannot be interrupted (see `respawnOnAbort` for the alternative). Either way
   * the promise rejects with `signal.reason`: a `DOMException` named "AbortError" unless `abort()`
   * was given a reason of its own, as with `fetch`. An already-aborted signal rejects without
   * queueing anything.
   */
  signal?: AbortSignal;
  /** `false`: neither read nor write the worker's model cache for this request (default true). */
  cache?: boolean;
}

/** Options for {@link GeneratorPool.generateMany}: those of every request, plus progress. */
export interface GenerateManyOptions extends GenerateOptions {
  /** Called as each entity lands, with how many have and how many were asked for. */
  onDone?: (done: number, total: number) => void;
}

/**
 * A pool of generator workers, from {@link makeGeneratorPool}. Entities come back with their
 * buffers transferred, so the main thread owns them outright.
 */
export interface GeneratorPool {
  /**
   * Generate one entity on the next free worker. Rejects when the generator is not registered in
   * the worker, throws, the worker dies, the request is aborted, or the pool is destroyed.
   */
  generate(spec: GenerateSpec, opts?: GenerateOptions): Promise<Entity>;
  /**
   * Generate many, spread across the pool. Resolves in the order given, not the order they
   * finish; rejects with the first failure (an abort through `opts.signal` rejects them all).
   * The options apply to every request. The older form `generateMany(specs, onDone)` still works.
   */
  generateMany(specs: GenerateSpec[], opts?: GenerateManyOptions | ((done: number, total: number) => void)): Promise<Entity[]>;
  /**
   * Stop handing queued requests to workers. Running ones finish and resolve; new requests queue.
   * The `models` phase stays busy while anything is queued, since the work is still owed.
   */
  pause(): void;
  /** Start dispatching again after {@link GeneratorPool.pause}. */
  resume(): void;
  /**
   * Give queued requests new priorities: `fn` gets each one's spec and current priority and
   * returns the new one. The queue is re-sorted (keeping queue order within a priority); running
   * requests are unaffected. One call is a sort of the queue, so a game streaming models around
   * the player can call it whenever the player has moved far enough.
   */
  reprioritise(fn: (spec: GenerateSpec, priority: number) => number): void;
  /** Resolves once every worker has registered its generators. */
  ready(): Promise<void>;
  /**
   * Stop the pool: every pending request rejects at once and the pool is unusable afterwards.
   * Workers still generating are terminated at once; idle ones first finish their model-cache
   * writes (up to `closeTimeoutMs`), so the models just made are there next visit. Resolves when
   * every worker has been terminated; callers need not wait.
   */
  destroy(): Promise<void>;
  /** Number of workers. */
  readonly size: number;
  /** Requests issued but not yet settled (queued or running; aborted ones are settled). */
  readonly pending: number;
  /** Of `pending`, the requests waiting for a worker. */
  readonly queued: number;
  /** Dispatching is paused. */
  readonly paused: boolean;
  /** Results that came from a worker's model cache (see serveGenerators' `cache`). */
  readonly cached: number;
  /**
   * What produced a model this pool returned, as a string: the worker script's URL (hashed in
   * production builds, so it changes with the generator code), the generator id and version,
   * seed, parameters and context. Undefined for any other model. Deterministic generation makes
   * it a stable name for the model's content across visits, which is what a cache of anything
   * derived from the model needs: give it to `makeInstanceLayer(target, { worker, modelKey:
   * pool.modelKey })` and a scene worker with a cache keeps each model's encoding under it.
   *
   * It names the model as generated: a host that edits a model in place must not pass its key
   * on. In development the worker URL does not change with the code, so keys stay the same
   * across generator edits (leave derived caches off there, as for the model cache). A bound
   * function: pass it around as it is. Works after `destroy()`.
   */
  readonly modelKey: (model: EntityModel) => string | undefined;
}

interface Slot {
  worker: Worker;
  /** The request it is running (possibly aborted), or 0. */
  job: number;
  ready: Promise<void>;
  /** Resolves `destroy()`'s wait for this worker. */
  closed?: () => void;
}

interface Job {
  spec: GenerateSpec;
  priority: number;
  seq: number;
  cache: boolean;
  resolve: (e: Entity) => void;
  reject: (e: unknown) => void;
  task?: LoadTask;
  /** Detaches the abort listener. */
  detach?: () => void;
  slot?: Slot;
  aborted?: boolean;
}

/** One worker per core less one, capped so a pool cannot swamp a small machine. */
function defaultSize(): number {
  const cores = (globalThis.navigator as { hardwareConcurrency?: number } | undefined)?.hardwareConcurrency ?? 4;
  return Math.max(1, Math.min(4, cores - 1));
}

/** The abort reason, or an AbortError when there is none (older runtimes). */
function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  if (typeof DOMException !== "undefined") return new DOMException("The operation was aborted.", "AbortError");
  const e = new Error("The operation was aborted.");
  e.name = "AbortError";
  return e;
}

/**
 * Run entity generators on a pool of workers, main-thread side. Generation is pure CPU work, so
 * doing it here keeps the render thread free and spreads it across cores. Each worker runs
 * {@link serveGenerators} with its own registry; the pool queues requests and hands each to the
 * next free worker. Browser-only (needs `Worker`).
 *
 * The queue is the app's to steer, and without options it is a plain FIFO: requests take a
 * `priority` and an `AbortSignal`, and the pool can `pause()`, `resume()` and `reprioritise()`.
 * Which models matter first is the game's call; the pool only offers the controls.
 *
 * @param opts - `spawn` creates one worker; only the consumer's bundler can resolve its entry.
 * @returns The pool. Call `destroy()` when done; idle workers hold their memory.
 * @example
 * ```ts
 * import { broadleafGenerator as oak } from "@voxolith/gen-tree";
 *
 * const pool = makeGeneratorPool({
 *   spawn: () => new Worker(new URL("./gen.worker.ts", import.meta.url), { type: "module" }),
 * });
 * try {
 *   await pool.ready();
 *   const trees = await pool.generateMany(
 *     [1, 2, 3].map((seed) => ({ generator: oak.id, params: oak.defaults, seed })),
 *     { onDone: (done, total) => (info.textContent = `${done}/${total}`) },
 *   );
 * } finally {
 *   pool.destroy();
 * }
 *
 * // Streaming: near models first, and drop the ones the player has walked away from.
 * const leave = new AbortController();
 * pool.generate(spec, { priority: -distance, signal: leave.signal }).catch(() => {});
 * pool.reprioritise((s) => -distanceTo(s));
 * leave.abort();
 * ```
 */
export function makeGeneratorPool(opts: GeneratorPoolOptions): GeneratorPool {
  const size = Math.max(1, Math.floor(opts.size ?? defaultSize()));
  const closeTimeout = opts.closeTimeoutMs ?? 10_000;
  /** Queued requests, highest priority first, then by `seq`. */
  const waiting: Job[] = [];
  /** Running requests by request id, aborted ones included until their result lands. */
  const inflight = new Map<number, Job>();
  let nextId = 1;
  let seq = 0;
  let destroyed = false;
  let paused = false;
  let cachedCount = 0;
  let live = 0; // running requests that are not aborted
  /** What made each model returned (the workers' `key`). */
  const keys = new WeakMap<EntityModel, string>();

  const before = (a: Job, b: Job) => a.priority > b.priority || (a.priority === b.priority && a.seq < b.seq);
  function enqueue(job: Job): void {
    // Binary search for the first queued job that should run after this one.
    let lo = 0, hi = waiting.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (before(waiting[mid], job)) lo = mid + 1;
      else hi = mid;
    }
    waiting.splice(lo, 0, job);
  }

  /** A job is over for the caller: detach its listener and close its load item. */
  function finish(job: Job, tick?: { cached: boolean }): void {
    job.detach?.();
    job.detach = undefined;
    if (job.task) {
      if (tick) job.task.tick(1, { cached: tick.cached, label: job.spec.generator });
      job.task.end();
      job.task = undefined;
    }
  }

  function spawnSlot(): Slot {
    const worker = opts.spawn();
    const slot: Slot = { worker, job: 0, ready: Promise.resolve() };
    slot.ready = new Promise<void>((resolveReady) => {
      worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
        const msg = ev.data;
        if (msg.kind === "ready") {
          resolveReady();
          return;
        }
        if (msg.kind === "closed") {
          slot.closed?.();
          return;
        }
        const job = inflight.get(msg.id);
        if (!job) return;
        inflight.delete(msg.id);
        slot.job = 0;
        drain();
        if (job.aborted) return; // settled when it was aborted; the result is dropped
        live--;
        const hit = msg.kind === "ok" && !!msg.cached;
        finish(job, { cached: hit });
        if (msg.kind === "ok") {
          if (hit) cachedCount++;
          let entity: Entity;
          try {
            // Views into the one posted buffer: a Map entry per brick, no copies.
            entity = msg.packed ? unpackEntity(msg.packed.head, msg.packed.bytes, { views: true }) : msg.entity!;
          } catch (err) {
            job.reject(err);
            return;
          }
          if (msg.key) keys.set(entity.model, msg.key);
          job.resolve(entity);
        } else job.reject(new Error(msg.message));
      };
      worker.onerror = (ev: ErrorEvent) => {
        // A worker that dies takes its request with it; fail that one rather
        // than hanging, and let the remaining workers carry on.
        const id = slot.job;
        const job = id ? inflight.get(id) : undefined;
        if (id) inflight.delete(id);
        slot.job = 0;
        resolveReady();
        slot.closed?.();
        drain();
        if (job && !job.aborted) {
          live--;
          finish(job, { cached: false });
          job.reject(new Error(ev.message || "generator worker failed"));
        }
      };
    });
    return slot;
  }

  const slots: Slot[] = Array.from({ length: size }, spawnSlot);

  function drain(): void {
    if (destroyed || paused) return;
    for (const slot of slots) {
      if (slot.job || waiting.length === 0) continue;
      const job = waiting.shift()!;
      const id = nextId++;
      slot.job = id;
      job.slot = slot;
      inflight.set(id, job);
      live++;
      const req: GenerateRequest = {
        kind: "generate",
        id,
        generator: job.spec.generator,
        params: job.spec.params,
        seed: job.spec.seed,
        entityId: job.spec.entityId,
        ctx: job.spec.ctx,
      };
      if (!job.cache) req.cache = false;
      slot.worker.postMessage(req);
    }
  }

  function abort(job: Job, reason: unknown): void {
    if (job.aborted) return;
    job.aborted = true;
    const q = waiting.indexOf(job);
    if (q >= 0) waiting.splice(q, 1);
    else if (job.slot) {
      live--;
      if (opts.respawnOnAbort && !destroyed) {
        const i = slots.indexOf(job.slot);
        for (const [id, j] of inflight) if (j === job) inflight.delete(id);
        job.slot.worker.terminate();
        if (i >= 0) slots[i] = spawnSlot();
        drain();
      }
    }
    finish(job);
    job.reject(reason);
  }

  function closeSlot(slot: Slot): Promise<void> {
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (timer !== undefined) clearTimeout(timer);
        slot.closed = undefined;
        slot.worker.terminate();
        resolve();
      };
      // Still generating: the model is unwanted now, so do not wait for it.
      if (slot.job) return done();
      slot.closed = done;
      timer = setTimeout(done, closeTimeout);
      slot.worker.postMessage({ kind: "close" });
    });
  }

  return {
    size,
    get pending() {
      return waiting.length + live;
    },
    get queued() {
      return waiting.length;
    },
    get paused() {
      return paused;
    },
    get cached() {
      return cachedCount;
    },
    modelKey: (model) => keys.get(model),
    ready: async () => {
      await Promise.all(slots.map((s) => s.ready));
    },
    generate(spec, o = {}) {
      if (destroyed) return Promise.reject(new Error("generator pool destroyed"));
      const signal = o.signal;
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      return new Promise<Entity>((resolve, reject) => {
        const p = Number(o.priority ?? 0);
        const job: Job = { spec, priority: Number.isFinite(p) ? p : 0, seq: seq++, cache: o.cache !== false, resolve, reject };
        if (opts.load) job.task = opts.load.task(LOAD_PHASES.models, 1);
        if (signal) {
          const onAbort = () => abort(job, abortReason(signal));
          signal.addEventListener("abort", onAbort, { once: true });
          job.detach = () => signal.removeEventListener("abort", onAbort);
        }
        enqueue(job);
        drain();
      });
    },
    async generateMany(specs, o) {
      const options: GenerateManyOptions = typeof o === "function" ? { onDone: o } : (o ?? {});
      const { onDone, ...each } = options;
      let done = 0;
      return Promise.all(
        specs.map((spec) =>
          this.generate(spec, each).then((e) => {
            onDone?.(++done, specs.length);
            return e;
          }),
        ),
      );
    },
    pause() {
      paused = true;
    },
    resume() {
      if (!paused) return;
      paused = false;
      drain();
    },
    reprioritise(fn) {
      if (waiting.length === 0) return;
      for (const job of waiting) {
        const p = Number(fn(job.spec, job.priority));
        job.priority = Number.isFinite(p) ? p : 0;
      }
      waiting.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
      drain();
    },
    destroy() {
      if (destroyed) return Promise.resolve();
      destroyed = true;
      const err = new Error("generator pool destroyed");
      const jobs = [...waiting.splice(0), ...[...inflight.values()].filter((j) => !j.aborted)];
      live = 0;
      // Queued requests reject too, or their promises would never settle.
      for (const job of jobs) {
        job.aborted = true;
        finish(job);
        job.reject(err);
      }
      const closing = slots.map(closeSlot);
      inflight.clear();
      return Promise.all(closing).then(() => undefined);
    },
  };
}
