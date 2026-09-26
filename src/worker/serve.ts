// Worker side of the generator pool.
//
// A consumer's worker file is three lines: import the generator packages it
// wants (which registers them), then call serveGenerators(). Generators are
// pure and take all their randomness from an injected rng, so they are
// worker-safe as written — nothing in them touches the DOM or shared state.
//
//   // gen.worker.ts
//   import { registerTreeGenerators } from "@voxolith/gen-tree";
//   import { serveGenerators } from "@voxolith/engine/worker";
//   registerTreeGenerators();
//   serveGenerators();
//
// The registry has to be populated in the worker itself: a function cannot be
// posted across the boundary, so the pool sends a generator *id* and the worker
// resolves it locally.

import { seededRandom } from "@voxolith/renderer/core";
import type { Entity } from "../entity";
import { getGenerator, listGenerators } from "../generator";
import type { WorkerRequest, WorkerResponse } from "./protocol";
import { openModelCache, type ModelCache } from "./cache";

/** Minimal shape of the worker global, so this file needs no DOM lib. */
interface WorkerScope {
  onmessage: ((ev: { data: WorkerRequest }) => void | Promise<void>) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
}

/**
 * Transferring a buffer detaches it, which is what makes handing a model back
 * free rather than a copy — but only when the array owns its whole buffer. A
 * view into a larger buffer would take unrelated data with it, so those are
 * copied instead.
 */
function transferables(entity: Entity): Transferable[] {
  const out: Transferable[] = [];
  const own = (a: Uint8Array) => a.byteOffset === 0 && a.byteLength === a.buffer.byteLength && a.byteLength > 0;
  const d = entity.model.data;
  if (own(d)) out.push(d.buffer);
  // A sparse model is a map of 512-byte bricks; each is its own buffer.
  if (entity.model.sparse) for (const b of entity.model.sparse.bricks.values()) if (own(b)) out.push(b.buffer);
  if (entity.model.bones && own(entity.model.bones)) out.push(entity.model.bones.buffer);
  return out;
}

/** Options for {@link serveGenerators}. */
export interface ServeOptions {
  /** The worker global (default `self`). */
  scope?: WorkerScope;
  /**
   * Keep generated models in IndexedDB under this database name and load
   * them from there next time (see cache.ts). Off by default; leave it off
   * in development, where the worker URL does not change with the code.
   */
  cache?: string;
}

/**
 * Serve generate requests on this worker until it is terminated. Call after
 * registering the generators this worker should offer: the pool sends a generator id, and a
 * function cannot cross the worker boundary, so the registry must be filled here. Posts a
 * `ready` message listing the registered ids, then answers each request with the entity (its
 * buffers transferred) or an error.
 *
 * With `cache`, models are kept in IndexedDB keyed by generator id and version, seed, params
 * and context, salted with this worker's URL, so a production build (which hashes the URL)
 * never serves a model made by older generator code.
 *
 * @param opts - Options, or the worker scope itself (the older form).
 * @example
 * ```ts
 * // gen.worker.ts
 * import { registerTreeGenerators } from "@voxolith/gen-tree";
 * import { serveGenerators } from "@voxolith/engine/worker";
 * registerTreeGenerators();
 * serveGenerators({ cache: import.meta.env.DEV ? undefined : "voxolith-models" });
 * ```
 */
export function serveGenerators(opts: ServeOptions | WorkerScope = {}): void {
  const o: ServeOptions = "postMessage" in opts ? { scope: opts as WorkerScope } : (opts as ServeOptions);
  const scope = o.scope ?? (self as unknown as WorkerScope);
  // The worker's own URL is the salt: a production build hashes it, so a
  // model made by older generator code is never served.
  const salt = String((globalThis as { location?: { href: string } }).location?.href ?? "worker");
  const cache: Promise<ModelCache | null> = o.cache ? openModelCache(o.cache, salt) : Promise.resolve(null);
  scope.onmessage = async (ev) => {
    const req = ev.data;
    if (!req || req.kind !== "generate") return;
    try {
      const gen = getGenerator(req.generator);
      if (!gen) {
        throw new Error(
          `Generator "${req.generator}" is not registered in this worker. ` +
            `Registered: ${listGenerators().map((g) => g.id).join(", ") || "none"}`,
        );
      }
      const store = await cache;
      const key = `${gen.id}@${gen.version}|${req.seed}|${JSON.stringify(req.params)}|${JSON.stringify(req.ctx ?? {})}`;
      const hit = store ? await store.get(key) : undefined;
      if (hit) {
        if (req.entityId) hit.id = req.entityId;
        scope.postMessage({ kind: "ok", id: req.id, entity: hit, cached: true }, transferables(hit));
        return;
      }
      const entity = gen.generate(req.params as never, seededRandom(req.seed), req.ctx);
      if (req.entityId) entity.id = req.entityId;
      // put() packs a copy before it first awaits, so the buffers can be
      // handed over straight away while it compresses and stores.
      if (store) void store.put(key, entity);
      scope.postMessage({ kind: "ok", id: req.id, entity }, transferables(entity));
    } catch (err) {
      scope.postMessage({
        kind: "error",
        id: req.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
  scope.postMessage({ kind: "ready", generators: listGenerators().map((g) => g.id) });
}
