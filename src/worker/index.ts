/**
 * `@voxolith/engine/worker`: run generators off the main thread.
 *
 * Generation is pure CPU with no DOM contact, so it belongs on a worker; doing it inline
 * competes with the thread that has to draw. Split in two because the two halves run in
 * different realms:
 *
 * - {@link makeGeneratorPool}: main thread, owns the workers and the queue
 * - {@link serveGenerators}: inside the worker, answers requests from its registry
 *
 * The consumer supplies the worker entry, because only their bundler can resolve one; see
 * {@link serveGenerators} for the three-line worker file. With its `cache` option, generated
 * models are kept in IndexedDB ({@link openModelCache}) so a second visit loads them.
 *
 * Loading is the app's to steer, and the engine picks no policy: requests take a priority and
 * an `AbortSignal`, the pool pauses, resumes and reprioritises its queue, and
 * {@link openModelCacheControls} inspects, clears and trims the model cache from the main
 * thread. Without those options everything behaves as a plain FIFO with an unbounded cache.
 *
 * A second worker bakes static instance placements ({@link makePlacementWorker} on the main
 * thread, {@link servePlacement} in the worker), for `makeInstanceLayer(target, { placement })`
 * and its `commitAsync()`.
 *
 * @packageDocumentation
 */

export { makeGeneratorPool } from "./pool";
export type { GeneratorPool, GeneratorPoolOptions, GenerateSpec, GenerateOptions, GenerateManyOptions } from "./pool";
export { serveGenerators } from "./serve";
export type { ServeOptions, ServeCacheOptions } from "./serve";
export {
  openModelCache,
  openModelCacheControls,
  openModelCacheOn,
  makeModelCache,
  makeModelCacheControls,
  memoryCacheStore,
  packEntity,
  unpackEntity,
} from "./cache";
export type { ModelCache, ModelCacheOptions, ModelCacheEntry, ModelCacheFilter, ModelCacheControls, CacheStore, CacheRecord } from "./cache";
export type { GenerateRequest, CloseRequest, WorkerRequest, WorkerResponse } from "./protocol";
export { makePlacementWorker, servePlacement } from "./placement";
export type { PlacementWorker, PlacementWorkerOptions, ServePlacementOptions, PlacementRequest, PlacementResponse } from "./placement";
