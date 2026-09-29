// The placement worker's older names. The static placement bake now runs on the scene worker
// (./scene.ts), which also encodes models; these names are kept so existing worker files and
// apps keep working, and behave exactly as before for them: a layer given the worker as
// `placement` only bakes on it.

import { sceneWorker, serveScene, type PlacementWorker, type SceneRequest, type SceneResponse, type ServeSceneOptions } from "./scene";

/** A message to a placement worker: the placement subset of {@link SceneRequest}. */
export type PlacementRequest = Extract<SceneRequest, { kind: "model" | "drop" | "bake" | "cancel" }>;

/** A placement worker's answer to a `bake`: the placement subset of {@link SceneResponse}. */
export type PlacementResponse = Extract<SceneResponse, { kind: "progress" | "baked" | "error" }>;

/** Options for {@link servePlacement}: those of {@link serveScene}. */
export type ServePlacementOptions = ServeSceneOptions;

/** Options for {@link makePlacementWorker}. */
export interface PlacementWorkerOptions {
  /**
   * Creates the worker, which runs {@link servePlacement} (or {@link serveScene}). The consumer
   * supplies this because only their bundler can resolve a worker entry:
   *
   *   spawn: () => new Worker(new URL("./placement.worker.ts", import.meta.url), { type: "module" })
   */
  spawn: () => Worker;
  /**
   * How long `destroy()` waits for an idle worker to finish its cache writes before terminating it
   * (default 10 s), as for {@link makeSceneWorker}.
   */
  closeTimeoutMs?: number;
}

/**
 * Serve placement bakes on this worker: {@link serveScene} under its older name (the worker then
 * encodes models too, when asked).
 *
 * @deprecated Use {@link serveScene}.
 */
export function servePlacement(opts: ServePlacementOptions = {}): void {
  serveScene(opts);
}

/**
 * Bake static placements on a worker, main-thread side: {@link makeSceneWorker} under its older
 * name, typed as the bake-only {@link PlacementWorker}. Give it to
 * `makeInstanceLayer(target, { placement })`, which bakes there as before; to encode models on it
 * as well, use `makeSceneWorker` and the layer's `worker` option.
 *
 * @deprecated Use {@link makeSceneWorker}.
 */
export function makePlacementWorker(opts: PlacementWorkerOptions): PlacementWorker {
  return sceneWorker(opts, "placement worker");
}

export type { PlacementWorker };
