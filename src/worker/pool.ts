// Main-thread side of the generator pool.
//
// Generation is the single most expensive part of building a scene and it is
// pure CPU work with no DOM contact, so it belongs off the render thread. Doing
// it inline competes with the frame loop: yielding between entities keeps the
// page responsive but the work still lands on the one thread that has to draw.
//
// The pool owns N workers and hands each the next queued request, so generation
// also parallelises across cores rather than merely moving sideways.

import type { Entity } from "../entity";
import type { GenerateContext } from "../generator";
import type { GenerateRequest, WorkerResponse } from "./protocol";

/** Options for {@link makeGeneratorPool}. */
export interface GeneratorPoolOptions {
  /**
   * Creates one worker. The consumer supplies this because only their bundler
   * can resolve a worker entry:
   *
   *   spawn: () => new Worker(new URL("./gen.worker.ts", import.meta.url), { type: "module" })
   */
  spawn: () => Worker;
  /**
   * Workers to run. Defaults to one per core less one, capped at 4 — generation
   * is memory-heavy and the main thread still needs a core to draw on.
   */
  size?: number;
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

/**
 * A pool of generator workers, from {@link makeGeneratorPool}. Entities come back with their
 * buffers transferred, so the main thread owns them outright.
 */
export interface GeneratorPool {
  /**
   * Generate one entity on the next free worker. Rejects when the generator is not registered in
   * the worker, throws, the worker dies, or the pool is destroyed.
   */
  generate(spec: GenerateSpec): Promise<Entity>;
  /**
   * Generate many, spread across the pool. Resolves in the order given, not the
   * order they finish. `onDone` reports progress as each lands.
   */
  generateMany(specs: GenerateSpec[], onDone?: (done: number, total: number) => void): Promise<Entity[]>;
  /** Resolves once every worker has registered its generators. */
  ready(): Promise<void>;
  /** Terminate every worker. The pool is unusable afterwards. */
  destroy(): void;
  /** Number of workers. */
  readonly size: number;
  /** Requests issued but not yet resolved. */
  readonly pending: number;
  /** Results that came from a worker's model cache (see serveGenerators' `cache`). */
  readonly cached: number;
}

interface Slot {
  worker: Worker;
  busy: boolean;
  ready: Promise<void>;
}

/** One worker per core less one, capped so a pool cannot swamp a small machine. */
function defaultSize(): number {
  const cores = (globalThis.navigator as { hardwareConcurrency?: number } | undefined)?.hardwareConcurrency ?? 4;
  return Math.max(1, Math.min(4, cores - 1));
}

/**
 * Run entity generators on a pool of workers, main-thread side. Generation is pure CPU work, so
 * doing it here keeps the render thread free and spreads it across cores. Each worker runs
 * {@link serveGenerators} with its own registry; the pool queues requests and hands each to the
 * next free worker. Browser-only (needs `Worker`).
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
 *     (done, total) => (info.textContent = `${done}/${total}`),
 *   );
 * } finally {
 *   pool.destroy();
 * }
 * ```
 */
export function makeGeneratorPool(opts: GeneratorPoolOptions): GeneratorPool {
  const size = Math.max(1, Math.floor(opts.size ?? defaultSize()));
  const waiting: { spec: GenerateSpec; resolve: (e: Entity) => void; reject: (e: Error) => void }[] = [];
  const inflight = new Map<number, { resolve: (e: Entity) => void; reject: (e: Error) => void; slot: Slot }>();
  let nextId = 1;
  let destroyed = false;
  let cachedCount = 0;

  const slots: Slot[] = Array.from({ length: size }, () => {
    const worker = opts.spawn();
    const slot: Slot = { worker, busy: false, ready: Promise.resolve() };
    slot.ready = new Promise<void>((resolveReady) => {
      worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
        const msg = ev.data;
        if (msg.kind === "ready") {
          resolveReady();
          return;
        }
        const entry = inflight.get(msg.id);
        if (!entry) return;
        inflight.delete(msg.id);
        entry.slot.busy = false;
        if (msg.kind === "ok") {
          if (msg.cached) cachedCount++;
          entry.resolve(msg.entity);
        }
        else entry.reject(new Error(msg.message));
        drain();
      };
      worker.onerror = (ev: ErrorEvent) => {
        // A worker that dies takes its request with it; fail that one rather
        // than hanging, and let the remaining workers carry on.
        for (const [id, entry] of inflight)
          if (entry.slot === slot) {
            inflight.delete(id);
            entry.reject(new Error(ev.message || "generator worker failed"));
          }
        slot.busy = false;
        resolveReady();
        drain();
      };
    });
    return slot;
  });

  function drain(): void {
    if (destroyed) return;
    for (const slot of slots) {
      if (slot.busy || waiting.length === 0) continue;
      const job = waiting.shift()!;
      const id = nextId++;
      slot.busy = true;
      inflight.set(id, { resolve: job.resolve, reject: job.reject, slot });
      const req: GenerateRequest = {
        kind: "generate",
        id,
        generator: job.spec.generator,
        params: job.spec.params,
        seed: job.spec.seed,
        entityId: job.spec.entityId,
        ctx: job.spec.ctx,
      };
      slot.worker.postMessage(req);
    }
  }

  return {
    size,
    get pending() {
      return waiting.length + inflight.size;
    },
    get cached() {
      return cachedCount;
    },
    ready: async () => {
      await Promise.all(slots.map((s) => s.ready));
    },
    generate(spec) {
      if (destroyed) return Promise.reject(new Error("generator pool destroyed"));
      return new Promise<Entity>((resolve, reject) => {
        waiting.push({ spec, resolve, reject });
        drain();
      });
    },
    async generateMany(specs, onDone) {
      let done = 0;
      return Promise.all(
        specs.map((spec) =>
          this.generate(spec).then((e) => {
            onDone?.(++done, specs.length);
            return e;
          }),
        ),
      );
    },
    destroy() {
      destroyed = true;
      for (const entry of inflight.values()) entry.reject(new Error("generator pool destroyed"));
      inflight.clear();
      waiting.length = 0;
      for (const s of slots) s.worker.terminate();
    },
  };
}
