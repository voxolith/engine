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
 * A second worker, the scene worker, encodes models for the GPU and bakes static instance
 * placements ({@link makeSceneWorker} on the main thread, {@link serveScene} in the worker), for
 * `makeInstanceLayer(target, { worker })` and its `commitAsync()`. {@link makePlacementWorker} and
 * {@link servePlacement} are its older, bake-only names. With its `cache` option it keeps the
 * encodings and bakes in IndexedDB too ({@link openSceneCache}, {@link openSceneCacheControls}),
 * so a warm visit skips both.
 *
 * Ground chunks fill on workers too: {@link makeChunkFillPool} on the main thread is a
 * `makeChunkedWorld({ fill })` source, and {@link serveChunks} in the worker rebuilds the app's
 * fill from a description sent once and answers boxes with bricks.
 *
 * @packageDocumentation
 */

export { makeGeneratorPool } from "./pool";
export type { GeneratorPool, GeneratorPoolOptions, GenerateSpec, GenerateOptions, GenerateManyOptions } from "./pool";
export { serveGenerators } from "./serve";
export type { ServeOptions, ServeCacheOptions } from "./serve";
export {
  CACHE_CAP_FLOOR,
  openModelCache,
  openModelCacheControls,
  openModelCacheOn,
  makeModelCache,
  makeModelCacheControls,
  memoryCacheStore,
  packEntity,
  unpackEntity,
} from "./cache";
export type { ModelCache, ModelCacheOptions, ModelCacheEntry, ModelCacheFilter, ModelCacheControls, CacheStore, CacheRecord, PackedEntity } from "./cache";
export type { GenerateRequest, CloseRequest, WorkerRequest, WorkerResponse } from "./protocol";
export { makeSceneWorker, serveScene } from "./scene";
export type { SceneWorker, SceneWorkerOptions, SceneEncodeOptions, ServeSceneOptions, ServeSceneCacheOptions, SceneRequest, SceneResponse, EncodeSource } from "./scene";
export { openSceneCache, openSceneCacheOn, makeSceneCache, openSceneCacheControls, makeSceneCacheControls } from "./scene-cache";
export type { SceneCache, SceneCacheOptions, SceneCacheEntry, SceneCacheFilter, SceneCacheControls, SceneCacheKind } from "./scene-cache";
export { makePlacementWorker, servePlacement } from "./placement";
export type { PlacementWorker, PlacementWorkerOptions, ServePlacementOptions, PlacementRequest, PlacementResponse } from "./placement";
export { makeChunkFillPool, serveChunks } from "./chunks";
export type { ChunkFill, ChunkFillPool, ChunkFillPoolOptions, ServeChunksOptions, ChunkRequest, ChunkResponse } from "./chunks";
