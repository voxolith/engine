// The static placement bake on a worker of its own.
//
// Placing a static instance set (the renderer's per-cell lists and sub-cell tables) takes
// seconds for a fine scene, on the main thread. The renderer splits it into a headless bake
// (`bakePlacement` / `PlacementBaker` in @voxolith/renderer/core) and a cheap apply
// (`Renderer.applyPlacement`); this module runs the bake on a worker: `makePlacementWorker` on
// the main thread, `servePlacement` inside the worker. An instance layer given one bakes its
// static set there (`layer.commitAsync()`).
//
// It is a worker of its own rather than a job for the generator pool: a generator worker runs
// one synchronous generation after another, so a bake queued behind one would wait seconds for
// it, and the bake needs every model registered on the worker that runs it, which a pool of
// several would have to repeat on each.

import { PlacementBaker, placementTransferables, type PlacementBake, type PlacementInput, type PlacementModel } from "@voxolith/renderer/core";

/** A message to a placement worker. Models and drops apply in order with the bakes around them. */
export type PlacementRequest =
  /** Register a model (`Renderer.placementModel`) under its key. */
  | { kind: "model"; model: PlacementModel }
  /** Forget a model key, after its model was removed. */
  | { kind: "drop"; key: number }
  /**
   * Bake a static set (`Renderer.placementInput`); answered by `baked` or `error` with this `id`,
   * after `progress` messages while it runs.
   */
  | { kind: "bake"; id: number; input: PlacementInput }
  /** Skip bake `id` if it has not started (a running bake cannot be stopped). */
  | { kind: "cancel"; id: number };

/** A placement worker's answer to a `bake`. */
export type PlacementResponse =
  /**
   * The bake is running: `done` of `total` opaque work units (read `done / total` as a fraction),
   * posted from inside the bake, about every 50 ms. The first is `done` 0, the last `done ===
   * total`, and `done` never decreases.
   */
  | { kind: "progress"; id: number; done: number; total: number }
  /** The bake, its buffers transferred; `ms` is how long the worker spent on it. */
  | { kind: "baked"; id: number; bake: PlacementBake; ms: number }
  /** The bake failed (a model it names is not registered, ...). */
  | { kind: "error"; id: number; message: string };

/** Minimal shape of the worker global, so this file needs no DOM lib. */
interface PlacementScope {
  onmessage: ((ev: { data: PlacementRequest }) => void) | null;
  postMessage(message: PlacementResponse, transfer?: Transferable[]): void;
}

/** Options for {@link servePlacement}. */
export interface ServePlacementOptions {
  /** The worker global (default `self`). */
  scope?: PlacementScope;
}

/**
 * Serve placement bakes on this worker until it is terminated: the worker side of
 * {@link makePlacementWorker}. Keeps the registered models in a `PlacementBaker` and answers each
 * bake with the result, its buffers transferred, after `progress` messages posted while the bake
 * runs (so the main thread hears them before the bake returns).
 *
 * Bakes run one at a time, and the worker yields between them, so a `cancel` for a bake that
 * has not started yet skips it. A bake that has started runs to the end: it is one synchronous
 * call. A stale result costs worker time only; the layer never applies it.
 *
 * @example
 * ```ts
 * // placement.worker.ts
 * import { servePlacement } from "@voxolith/engine/worker";
 * servePlacement();
 * ```
 */
export function servePlacement(opts: ServePlacementOptions = {}): void {
  const scope = opts.scope ?? (self as unknown as PlacementScope);
  const baker = new PlacementBaker();
  const queue: PlacementRequest[] = [];
  const cancelled = new Set<number>();
  let highest = 0; // the highest bake id taken off the queue
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(run, 0);
  };
  function run(): void {
    scheduled = false;
    while (queue.length) {
      const m = queue.shift()!;
      if (m.kind === "model") baker.register(m.model);
      else if (m.kind === "drop") baker.unregister(m.key);
      else if (m.kind === "bake") {
        highest = Math.max(highest, m.id);
        if (cancelled.delete(m.id)) continue;
        const t0 = performance.now();
        try {
          const id = m.id;
          const bake = baker.bake(m.input, { onProgress: (done, total) => scope.postMessage({ kind: "progress", id, done, total }) });
          scope.postMessage({ kind: "baked", id: m.id, bake, ms: performance.now() - t0 }, placementTransferables(bake));
        } catch (err) {
          scope.postMessage({ kind: "error", id: m.id, message: err instanceof Error ? err.message : String(err) });
        }
        // Yield after each bake, so cancels (and newer bakes) that came in meanwhile are seen.
        if (queue.length) schedule();
        return;
      }
    }
  }
  scope.onmessage = (ev) => {
    const m = ev.data;
    if (!m) return;
    if (m.kind === "cancel") {
      if (m.id > highest) cancelled.add(m.id);
      return;
    }
    queue.push(m);
    schedule();
  };
}

/** Options for {@link makePlacementWorker}. */
export interface PlacementWorkerOptions {
  /**
   * Creates the worker, which runs {@link servePlacement}. The consumer supplies this because
   * only their bundler can resolve a worker entry:
   *
   *   spawn: () => new Worker(new URL("./placement.worker.ts", import.meta.url), { type: "module" })
   */
  spawn: () => Worker;
}

/**
 * A worker that bakes static placements, from {@link makePlacementWorker}. Give it to
 * `makeInstanceLayer(target, { placement })`, which registers models and bakes for you; the
 * methods are there for hosts that drive `Renderer.placementInput` / `applyPlacement` themselves.
 * One worker can serve several layers and renderers: model keys are unique on the page.
 */
export interface PlacementWorker {
  /** Send a model to the worker (`Renderer.placementModel`), once per key: a known key is not sent again. */
  register(model: PlacementModel): void;
  /** Whether a model key has been sent (and not dropped). */
  has(key: number): boolean;
  /** Forget a model key on the worker, after its model was removed. Unknown keys are ignored. */
  drop(key: number): void;
  /**
   * Bake a static set on the worker. Every model the input names must have been registered.
   * Rejects when the bake fails, the worker dies, the worker is destroyed, or `signal` aborts
   * (with `signal.reason`, an AbortError unless given another). Aborting skips the bake if the
   * worker has not started it; one that has started runs to the end and its result is dropped.
   *
   * `onProgress` hears the bake's progress from the worker while it runs: `done` of `total` opaque
   * work units (use `done / total` as a fraction), first `(0, total)`, last `(total, total)`, about
   * every 50 ms, never decreasing. It stops once the bake settles, is aborted or the worker is
   * destroyed.
   */
  bake(input: PlacementInput, opts?: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void }): Promise<PlacementBake>;
  /** Bakes asked for and not yet settled. */
  readonly pending: number;
  /** Terminate the worker; pending bakes reject. */
  destroy(): void;
}

/** The abort reason, or an AbortError when there is none. */
function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const e = typeof DOMException !== "undefined" ? new DOMException("The operation was aborted.", "AbortError") : Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
  return e;
}

/**
 * Bake static placements on a worker, main-thread side (the worker runs {@link servePlacement}).
 * With it, `makeInstanceLayer(renderer, { placement })` builds its static set off the main
 * thread (`layer.commitAsync()`), so a scene of thousands of instances places without freezing
 * the page. Browser-only (needs `Worker`).
 *
 * @example
 * ```ts
 * const placement = makePlacementWorker({
 *   spawn: () => new Worker(new URL("./placement.worker.ts", import.meta.url), { type: "module" }),
 * });
 * const layer = makeInstanceLayer(renderer, { load, placement });
 * layer.setStatic(scenery);
 * await layer.commitAsync(); // the page keeps drawing meanwhile
 * ```
 */
export function makePlacementWorker(opts: PlacementWorkerOptions): PlacementWorker {
  const worker = opts.spawn();
  const keys = new Set<number>();
  type Entry = { resolve: (b: PlacementBake) => void; reject: (e: unknown) => void; detach?: () => void; onProgress?: (done: number, total: number) => void };
  const pending = new Map<number, Entry>();
  let nextId = 1;
  let destroyed = false;
  const post = (m: PlacementRequest) => worker.postMessage(m);
  const settle = (id: number) => {
    const p = pending.get(id);
    if (!p) return undefined;
    pending.delete(id);
    p.detach?.();
    return p;
  };
  worker.onmessage = (ev: MessageEvent<PlacementResponse>) => {
    const m = ev.data;
    if (m.kind === "progress") {
      pending.get(m.id)?.onProgress?.(m.done, m.total); // unknown, aborted or settled ids: ignored
      return;
    }
    const p = settle(m.id);
    if (!p) return; // aborted: the result is dropped
    if (m.kind === "baked") p.resolve(m.bake);
    else p.reject(new Error(m.message));
  };
  worker.onerror = (ev: ErrorEvent) => {
    for (const id of [...pending.keys()]) settle(id)!.reject(new Error(ev.message || "placement worker failed"));
  };
  return {
    register(model) {
      if (destroyed || keys.has(model.key)) return;
      keys.add(model.key);
      post({ kind: "model", model });
    },
    has: (key) => keys.has(key),
    drop(key) {
      if (destroyed || !keys.delete(key)) return;
      post({ kind: "drop", key });
    },
    bake(input, o = {}) {
      if (destroyed) return Promise.reject(new Error("placement worker destroyed"));
      const signal = o.signal;
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      const id = nextId++;
      return new Promise<PlacementBake>((resolve, reject) => {
        const entry: Entry = { resolve, reject, onProgress: o.onProgress };
        if (signal) {
          const onAbort = () => {
            if (!settle(id)) return;
            post({ kind: "cancel", id });
            reject(abortReason(signal));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          entry.detach = () => signal.removeEventListener("abort", onAbort);
        }
        pending.set(id, entry);
        post({ kind: "bake", id, input });
      });
    },
    get pending() {
      return pending.size;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const id of [...pending.keys()]) settle(id)!.reject(new Error("placement worker destroyed"));
      keys.clear();
      worker.terminate();
    },
  };
}
