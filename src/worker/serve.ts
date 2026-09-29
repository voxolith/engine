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
import { getGenerator, listGenerators } from "../generator";
import type { WorkerRequest, WorkerResponse } from "./protocol";
import { checkCacheCap, openModelCache, openModelCacheOn, packEntity, type CacheStore, type PackedEntity, type ModelCache, type ModelCacheOptions } from "./cache";

/** Minimal shape of the worker global, so this file needs no DOM lib. */
interface WorkerScope {
  onmessage: ((ev: { data: WorkerRequest }) => void | Promise<void>) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
}

/** Options for {@link serveGenerators}. */
export interface ServeOptions {
  /** The worker global (default `self`). */
  scope?: WorkerScope;
  /**
   * Keep generated models in IndexedDB under this database name and load them from there next
   * time ({@link openModelCache}). Off by default; leave it off in development, where the worker
   * URL does not change with the code. The object form adds a size cap
   * ({@link ModelCacheOptions.maxBytes}, evicting by last use). Inspect and clear it from the
   * main thread with {@link openModelCacheControls}; a request can skip it with the pool's
   * `generate(spec, { cache: false })`.
   *
   * Opening the cache deletes every entry stored under another salt (an older build of this
   * worker), so give each worker script its own database name: two apps on one origin (GitHub
   * Pages serves every repo from one) sharing a name would delete each other's models.
   *
   * A `maxBytes` that is not a positive finite number makes `serveGenerators` throw; doubtful ones
   * warn ({@link ModelCacheOptions.maxBytes}).
   */
  cache?: string | ServeCacheOptions;
}

/** The object form of {@link ServeOptions.cache}. */
export interface ServeCacheOptions extends ModelCacheOptions {
  /** The IndexedDB database name. */
  name?: string;
  /**
   * A storage of your own instead of IndexedDB (another backend, or {@link memoryCacheStore} in
   * tests). Takes precedence over `name`.
   */
  store?: CacheStore;
}

/**
 * Serve generate requests on this worker until it is terminated. Call after
 * registering the generators this worker should offer: the pool sends a generator id, and a
 * function cannot cross the worker boundary, so the registry must be filled here. Posts a
 * `ready` message listing the registered ids, then answers each request with the entity (packed
 * into one buffer and transferred, see {@link PackedEntity}; the pool unpacks it) or an error.
 * Each answer also names what made the model (`key`: this worker's URL, generator id and version,
 * seed, params and context), which the pool hands out as `GeneratorPool.modelKey`.
 *
 * With `cache`, models are kept in IndexedDB keyed by generator id and version, seed, params
 * and context, salted with this worker's URL, so a production build (which hashes the URL)
 * never serves a model made by older generator code. Writes finish after the result is posted;
 * the pool's `destroy()` asks the worker to finish them (`close`) before terminating it.
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
  const spec = typeof o.cache === "string" ? { name: o.cache } : o.cache;
  // A bad cap is a programming error: fail here, loudly, rather than in every request.
  checkCacheCap(spec?.maxBytes, "serveGenerators({ cache })");
  const cacheOpts = { maxBytes: spec?.maxBytes };
  const cache: Promise<ModelCache | null> = spec?.store
    ? openModelCacheOn(spec.store, salt, cacheOpts)
    : spec?.name
      ? openModelCache(spec.name, salt, cacheOpts)
      : Promise.resolve(null);
  // Cache writes still in progress. They finish after the result has been posted, and the
  // worker is often busy with the next generation meanwhile, so a pool that terminated its
  // workers straight after the last result lost them; it asks with `close` first now.
  const writes = new Set<Promise<void>>();
  scope.onmessage = async (ev) => {
    const req = ev.data;
    if (req?.kind === "close") {
      await cache;
      while (writes.size) await Promise.allSettled([...writes]);
      scope.postMessage({ kind: "closed" });
      return;
    }
    if (!req || req.kind !== "generate") return;
    try {
      const gen = getGenerator(req.generator);
      if (!gen) {
        throw new Error(
          `Generator "${req.generator}" is not registered in this worker. ` +
            `Registered: ${listGenerators().map((g) => g.id).join(", ") || "none"}`,
        );
      }
      const store = req.cache === false ? null : await cache;
      const key = `${gen.id}@${gen.version}|${req.seed}|${JSON.stringify(req.params)}|${JSON.stringify(req.ctx ?? {})}`;
      // What made the model, for hosts that cache what they derive from it (GeneratorPool.modelKey).
      const identity = `${salt}|${key}`;
      const hit = store ? await store.getPacked(key) : undefined;
      if (hit) {
        if (req.entityId) (hit.head.entity as { id?: string }).id = req.entityId;
        scope.postMessage({ kind: "ok", id: req.id, packed: hit, cached: true, key: identity }, [hit.bytes.buffer]);
        return;
      }
      const entity = gen.generate(req.params as never, seededRandom(req.seed), req.ctx);
      if (req.entityId) entity.id = req.entityId;
      // Posted packed: one buffer transfers in no time, where a sparse model's bricks, each its
      // own buffer, took seconds to (7 s for nightwood's twelve models at 100 vox/m).
      const packed = packEntity(entity);
      // putPacked() copies the bytes before it first awaits, so they can be handed over
      // straight away while it compresses and stores.
      if (store) {
        const w = store.putPacked(key, packed, { generator: gen.id });
        writes.add(w);
        void w.finally(() => writes.delete(w));
      }
      scope.postMessage({ kind: "ok", id: req.id, packed, key: identity }, [packed.bytes.buffer]);
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
