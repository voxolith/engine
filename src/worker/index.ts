// @voxolith/engine/worker — run generators off the main thread.
//
// Generation is pure CPU with no DOM contact, so it belongs on a worker; doing
// it inline competes with the thread that has to draw. Split in two because the
// two halves run in different realms:
//
//   makeGeneratorPool  main thread, owns the workers and the queue
//   serveGenerators    inside the worker, answers requests from its registry
//
// The consumer supplies the worker entry, because only their bundler can
// resolve one. See serve.ts for the three-line worker file.

export { makeGeneratorPool } from "./pool";
export type { GeneratorPool, GeneratorPoolOptions, GenerateSpec } from "./pool";
export { serveGenerators } from "./serve";
export type { ServeOptions } from "./serve";
export { openModelCache, packEntity, unpackEntity } from "./cache";
export type { ModelCache } from "./cache";
export type { GenerateRequest, WorkerRequest, WorkerResponse } from "./protocol";
