// The scene worker: model encoding and the static placement bake, off the main thread.
//
// Two CPU jobs of an instanced scene take seconds for a fine one, on the main thread:
// - encoding a model's bricks for the GPU (`Renderer.addModel`); the renderer splits it into a
//   headless `encodeModel` (@voxolith/renderer/core) and a cheap `Renderer.addEncodedModel`;
// - baking a static set's per-cell lists and sub-cell tables; split into `PlacementBaker` and
//   `Renderer.applyPlacement`.
// This module runs both halves' heavy parts on one worker: `makeSceneWorker` on the main thread,
// `serveScene` inside the worker. An instance layer given one encodes the models its static set
// names and bakes the set there (`makeInstanceLayer(target, { worker })`, `layer.commitAsync()`).
//
// Why one worker for both jobs: the bake needs every model's occupied sub-cells, and the encode
// is what computes them. On one worker the encode keeps them (`encodedTransferables` with
// `keepPlacement`) and registers the model for placement once the main thread names its keys, so
// the sub-cells (millions of words at 100 vox/m) never travel back. Encodes and bakes share one
// queue in the order they were asked for, which is the order a scene needs them in anyway (a
// bake can only start once its models are registered). It is not the generator pool's job: a
// generator worker runs one synchronous generation after another, so a bake queued behind one
// would wait seconds for it, and the registrations would have to be repeated on every worker.
//
// Several workers for one bake (`SceneWorkerOptions.bakeWorkers`): marking the sub-cell tables is
// nearly all of a bake and splits exactly over ranges of the instances (the renderer's
// `splitPlacement` / `bakePlacementShare` / `mergePlacementShares`). The first worker stays the
// scene worker: it alone encodes, holds the cache and answers every bake. A bake that misses the
// cache and is big enough it cuts into ranges (`split`), bakes the first itself and names the
// others to the main thread, which hands each to a helper worker (spawned then, from the same
// `spawn`, and sent the models the set names) and passes the helpers' shares back (`merge`). The
// first worker merges, stores and answers `baked` as for a bake of its own, so the result, the
// cache and everything above this file are the same as with one worker.

import {
  PlacementBaker,
  bindPlacement,
  encodeModel,
  mergePlacementShares,
  normalizePlacement,
  encodedTransferables,
  placementModelOf,
  placementShareTransferables,
  placementTransferables,
  type EncodedModel,
  type ModelSource,
  type PlacementBake,
  type PlacementInput,
  type PlacementKeys,
  type PlacementModel,
  type PlacementRange,
  type PlacementShare,
} from "@voxolith/renderer/core";
import { checkCacheCap, type CacheStore } from "./cache";
import { Hasher } from "./hash";
import { encodedDigest, openSceneCache, openSceneCacheOn, placementDigest, sourceDigest, type SceneCache, type SceneCacheOptions } from "./scene-cache";

/**
 * A model to encode, as it travels to the worker: {@link ModelSource} without the sparse brick
 * map, whose bricks come ahead of it in `chunk` messages (a map of hundreds of thousands of small
 * arrays is slow to structured-clone; packed chunks transfer).
 */
export interface EncodeSource {
  /** Extent in voxels. */
  size: { x: number; y: number; z: number };
  /** Dense role values (`ModelSource.data`). */
  data?: Uint8Array;
  /** The model is sparse: its bricks arrived in `chunk` messages with the same id. */
  sparse?: boolean;
  /** `ModelSource.parts`. */
  parts?: Uint8Array;
  /** `ModelSource.joints`. */
  joints?: ModelSource["joints"];
  /** `ModelSource.partBoxes`. */
  partBoxes?: Int32Array;
}

/** How a `bake` may be split over several workers ({@link SceneWorkerOptions.bakeWorkers}). */
export interface BakeSplit {
  /** The most workers to split over, this one included. */
  workers: number;
  /** The least marking work per share ({@link SceneWorkerOptions.bakeShareUnits}). */
  shareUnits: number;
}

/** A message to a scene worker. Everything but `chunk`, `lookup`, `merge`, `cancel` and `close` applies in the order sent. */
export type SceneRequest =
  /** Register a model for placement (`Renderer.placementModel`) under its key. */
  | { kind: "model"; model: PlacementModel }
  /** Forget a model key, after its model was removed. */
  | { kind: "drop"; key: number }
  /**
   * Bake a static set (`Renderer.placementInput`); answered by `baked` or `error` with this `id`,
   * after `progress` messages while it runs.
   *
   * With `split`, a bake that misses the cache and has enough marking work for two or more shares
   * is split: the worker answers `split` with the ranges, bakes the first share itself, and waits
   * for a `merge` with the others before it answers `baked`. Otherwise it bakes alone, as without.
   */
  | { kind: "bake"; id: number; input: PlacementInput; /** `false`: neither read nor write the worker's cache. */ cache?: boolean; split?: BakeSplit }
  /**
   * Bake one share of a split bake (`PlacementBaker.bakeShare`): the instances of `range`, one of
   * the ranges a `split` named. Answered by `shared` or `error` with this `id`, after `progress`
   * messages for this share alone. Every model the input names must be registered. Never cached.
   */
  | { kind: "share"; id: number; input: PlacementInput; range: PlacementRange }
  /**
   * The other workers' shares of the split bake `id`: the worker joins them with its own
   * (`mergePlacementShares`), stores the bake if it caches, and answers `baked` (or `error`).
   * Ignored when the bake was cancelled meanwhile.
   */
  | { kind: "merge"; id: number; shares: PlacementShare[] }
  /**
   * Some of the bricks of sparse model `id` (encoded by the `encode` that follows): `keys[i]` is
   * the brick key of bytes `[i * 512, i * 512 + 512)` of `bricks`.
   */
  | { kind: "chunk"; id: number; keys: Uint32Array; bricks: Uint8Array }
  /**
   * Encode a model (`encodeModel`); answered by `encoded` or `error` with this `id`, after
   * `progress` messages while it runs. With `keep`, the worker keeps the encoding's placement
   * data until a `keys` (register it) or a `cancel` (forget it) for this id.
   */
  | {
      kind: "encode";
      id: number;
      model: EncodeSource;
      keep?: boolean;
      /** The source's identity for the worker's cache: its encoding is stored under it (with the part boxes and joints). */
      cacheKey?: string;
      /** No identity given: with a cache, the worker hashes the source's bytes to look it up. */
      hashKey?: boolean;
    }
  /**
   * Look up encode `id` in the worker's cache by the source's identity, before sending its bytes:
   * answered by `encoded` (with `cached`) or `miss`. After a miss the host sends the source as
   * usual (`chunk`s and an `encode` with the same id and `cacheKey`). With `keep`, a hit is kept
   * for placement as an encode's would be.
   */
  | { kind: "lookup"; id: number; cacheKey: string; partBoxes?: Int32Array; joints?: ModelSource["joints"]; keep?: boolean }
  /** Finish the cache writes in progress, answer `closed`, and expect to be terminated. */
  | { kind: "close" }
  /**
   * Register the kept encoding `id` for placement under the keys the renderer gave it: a list
   * when one encoding was added at several scales (one renderer model, and key, per scale).
   */
  | { kind: "keys"; id: number; keys: PlacementKeys | PlacementKeys[] }
  /**
   * Skip job `id` (a bake, a share or an encode) if it has not started, forget encoding `id` if
   * it is kept, and drop the share of a split bake `id` waiting for its `merge`. A running job
   * cannot be stopped.
   */
  | { kind: "cancel"; id: number };

/** A scene worker's answer to a `bake`, a `share` or an `encode`. */
export type SceneResponse =
  /**
   * Bake `id` is split over these ranges (`PlacementBaker.split`): the worker is baking the first
   * (the one with `pack`) and wants the shares of the others that are not empty in a `merge`.
   * At least one other range is not empty.
   */
  | { kind: "split"; id: number; ranges: PlacementRange[] }
  /** One share of a split bake, its buffers transferred; `ms` is how long the worker spent on it. */
  | { kind: "shared"; id: number; share: PlacementShare; ms: number }
  /**
   * The job is running: `done` of `total` opaque work units (read `done / total` as a fraction),
   * posted from inside it, about every 50 ms. The first is `done` 0, the last `done === total`,
   * and `done` never decreases.
   */
  | { kind: "progress"; id: number; done: number; total: number }
  /**
   * The bake, its buffers transferred; `ms` is how long the worker spent on it (for a split bake,
   * from its start to the end of the merge, waiting for the other shares included); `cached` when
   * it came from the worker's cache.
   */
  | { kind: "baked"; id: number; bake: PlacementBake; ms: number; cached?: boolean }
  /** The encoded model, its buffers transferred; `ms` is how long the worker spent on it; `cached` when it came from the worker's cache. */
  | { kind: "encoded"; id: number; encoded: EncodedModel; ms: number; cached?: boolean }
  /** A `lookup` found nothing (or the worker has no cache): send the source. */
  | { kind: "miss"; id: number }
  /** The answer to `close`: every cache write has finished. */
  | { kind: "closed" }
  /** The job failed (a bake names an unregistered model, a model has too many parts, ...). */
  | { kind: "error"; id: number; message: string };

/** Minimal shape of the worker global, so this file needs no DOM lib. */
interface SceneScope {
  onmessage: ((ev: { data: SceneRequest }) => void) | null;
  postMessage(message: SceneResponse, transfer?: Transferable[]): void;
}

/** Options for {@link serveScene}. */
export interface ServeSceneOptions {
  /** The worker global (default `self`). */
  scope?: SceneScope;
  /**
   * Keep encodings and bakes in IndexedDB under this database name ({@link openSceneCache}), and
   * serve them from there next time. Off by default; leave it off in development, where the worker
   * URL does not change with the code. The object form adds a size cap and compression
   * ({@link SceneCacheOptions}); inspect and clear it from the main thread with
   * {@link openSceneCacheControls}.
   *
   * - A bake is looked up by a digest of its input and of the placement data of every model it
   *   names, so it needs nothing from the host.
   * - An encoding is looked up by the source's identity: the `cacheKey` the host gives
   *   ({@link SceneEncodeOptions.cacheKey}, e.g. `GeneratorPool.modelKey`), or with `hashKey` a
   *   hash of the source's bytes. Without either it is not cached.
   *
   * Opening the cache deletes every entry stored under another salt (an older build of this
   * worker), so give each worker script its own database name, and not the model cache's.
   *
   * A `maxBytes` that is not a positive finite number makes `serveScene` throw; doubtful ones warn
   * ({@link SceneCacheOptions.maxBytes}).
   */
  cache?: string | ServeSceneCacheOptions;
}

/** The object form of {@link ServeSceneOptions.cache}. */
export interface ServeSceneCacheOptions extends SceneCacheOptions {
  /** The IndexedDB database name. */
  name?: string;
  /** A storage of your own instead of IndexedDB (`memoryCacheStore` in tests). Takes precedence over `name`. */
  store?: CacheStore;
}

/**
 * Serve model encodes and placement bakes on this worker until it is terminated: the worker side
 * of {@link makeSceneWorker}. Encodes run the renderer's `encodeModel`; bakes run a
 * `PlacementBaker` holding the registered models. Each job is answered with its result, buffers
 * transferred, after `progress` messages posted while it runs (so the main thread hears them
 * before it returns).
 *
 * Jobs run one at a time in the order asked, and the worker yields between them, so a `cancel`
 * for a job that has not started skips it. A job that has started runs to the end: it is one
 * synchronous call. A stale result costs worker time only; the main thread drops it.
 *
 * The same function serves the helpers of a split bake ({@link SceneWorkerOptions.bakeWorkers}):
 * they are spawned from the same worker entry and are only ever sent models and shares to bake.
 *
 * With `cache`, results are kept in IndexedDB and served from there next time (see
 * {@link ServeSceneOptions.cache}), salted with this worker's URL, so a production build (which
 * hashes the URL) never serves what older renderer code made. Writes finish after the result is
 * posted; the main side's `destroy()` asks the worker to finish them (`close`) first.
 *
 * @example
 * ```ts
 * // scene.worker.ts
 * import { serveScene } from "@voxolith/engine/worker";
 * serveScene({ cache: import.meta.env.DEV ? undefined : "voxolith-scene" });
 * ```
 */
export function serveScene(opts: ServeSceneOptions = {}): void {
  const scope = opts.scope ?? (self as unknown as SceneScope);
  const baker = new PlacementBaker();
  const queue: SceneRequest[] = [];
  const cancelled = new Set<number>();
  /** Bricks of sparse models still arriving, by encode id. */
  const assembling = new Map<number, Map<number, Uint8Array>>();
  /** Encodings kept for placement, by encode id, until their keys come (or a cancel). */
  const kept = new Map<number, EncodedModel>();
  let highest = 0; // the highest job id taken off the queue
  let scheduled = false;
  let running = false;
  /** The job running now (0 for none), and whether a `cancel` for it came while it awaited the cache. */
  let current = 0;
  let currentCancelled = false;
  /** Split bakes whose own share is done, by bake id, until their `merge` (or a cancel). */
  const splitting = new Map<number, { input: PlacementInput; share: PlacementShare; digest: string | undefined; store: SceneCache | null; t0: number }>();

  // --- the cache ---
  const salt = String((globalThis as { location?: { href: string } }).location?.href ?? "worker");
  const spec = typeof opts.cache === "string" ? { name: opts.cache } : opts.cache;
  // A bad cap is a programming error: fail here, loudly (opening the cache swallows errors).
  checkCacheCap(spec?.maxBytes, "serveScene({ cache })");
  const cacheOpts: SceneCacheOptions = { maxBytes: spec?.maxBytes, compress: spec?.compress };
  const cache: Promise<SceneCache | null> = spec?.store
    ? openSceneCacheOn(spec.store, salt, cacheOpts)
    : spec?.name
      ? openSceneCache(spec.name, salt, cacheOpts).catch(() => null)
      : Promise.resolve(null);
  /** Cache writes in progress (they finish after the result is posted). */
  const writes = new Set<Promise<void>>();
  const track = (w: Promise<void>) => {
    writes.add(w);
    void w.finally(() => writes.delete(w));
  };
  /** Registered models, by key: what a bake's digest reads. */
  const registered = new Map<number, PlacementModel>();
  /** Placement digests, by model key (computed at the first bake that names the model, or known from the cache). */
  const digests = new Map<number, string>();
  /** Placement digests of encodings, known when they were stored or read. */
  const encodedDigests = new WeakMap<EncodedModel, string>();
  /** Lookups in flight, by encode id. */
  const lookups = new Set<number>();

  const register = (m: PlacementModel, digest?: string) => {
    baker.register(m);
    registered.set(m.key, m);
    if (digest) digests.set(m.key, digest);
    else digests.delete(m.key);
  };
  const digestOf = (key: number): string => {
    let d = digests.get(key);
    if (d === undefined) {
      const m = registered.get(key);
      if (!m) throw new Error(`bakePlacement: model key ${key} is not registered`);
      digests.set(key, (d = placementDigest(m)));
    }
    return d;
  };
  /**
   * A bake's digest: its grid, and every instance's fields in order, with each model named by its
   * placement digest rather than its id (ids are the renderer's slots and differ between visits:
   * models are numbered in order of first appearance), which of them share poses, and the parts
   * by value plus which instances share a parts object (the bake packs one pose per shared one).
   */
  const bakeDigest = (input: PlacementInput): string => {
    const g = input.grid;
    const h = new Hasher().str("bake").num(...g.brickDim, ...g.topDim, g.gridMax, input.instances.length);
    const canon = new Map<number, number>();
    const poseClass = new Map<number, number>();
    const shared = new Map<object, number>();
    const row = new Float64Array(10);
    input.instances.forEach((p, k) => {
      let c = canon.get(p.model);
      if (c === undefined) {
        canon.set(p.model, (c = canon.size));
        const key = input.models[p.model];
        if (!key) throw new Error(`bakePlacement: an instance names model ${p.model}, which has no key in the input`);
        const pk = registered.get(key)?.poseKey;
        let cls = -1;
        if (pk !== undefined) {
          if (!poseClass.has(pk)) poseClass.set(pk, c);
          cls = poseClass.get(pk)!;
        }
        h.num(-3, c, cls).str(digestOf(key));
        // The scale a model is drawn at is the registration's, not the encoding's (one encoding
        // serves every scale, and its placement digest leaves scale out), so it goes in here.
        // Left out at scale 1, so scale-1 bakes keep the keys they had before scales.
        const scale = registered.get(key)?.scale ?? 1;
        if (scale !== 1) h.num(-4, scale);
      }
      row[0] = c; row[1] = p.x; row[2] = p.y; row[3] = p.z; row[4] = p.base;
      row[5] = p.yaw ?? NaN; row[6] = p.mirror === undefined ? -1 : p.mirror ? 1 : 0;
      row[7] = p.anchor ? p.anchor.length : -1; row[8] = p.rotation ? p.rotation.length : -1;
      row[9] = p.parts ? p.parts.length : -1;
      h.add(row);
      if (p.anchor) h.num(...p.anchor);
      if (p.rotation) h.num(...Array.from(p.rotation));
      if (p.parts) {
        const o = p.parts as unknown as object;
        const first = shared.get(o);
        if (first !== undefined) h.num(first);
        else {
          shared.set(o, k);
          h.num(-1, ...Array.from(p.parts));
        }
      }
    });
    return h.digest();
  };

  /**
   * The ranges to split a bake over, or undefined when it should be baked alone: its marking work
   * (an instance's occupied sub-cells, times its pieces when scaled and turned, or its box's
   * bricks when posed: the renderer's units, which it does not export, so mirrored here) allows fewer than two shares of `shareUnits`, or fewer
   * than two ranges have instances (one instance outweighs the rest).
   */
  const planSplit = (input: PlacementInput, split: BakeSplit): PlacementRange[] | undefined => {
    const perModel: number[] = [], perPosed: number[] = [];
    let units = 0;
    for (const p of input.instances) {
      const m = registered.get(input.models[p.model]);
      if (!m) continue; // the split below throws, as the bake would
      if (p.parts && m.partBoxes) units += perPosed[p.model] ??= (Math.ceil(m.size.x / 8) + 2) * (Math.ceil(m.size.y / 8) + 2) * (Math.ceil(m.size.z / 8) + 2);
      else {
        // A scaled model's sub-cells are marked in pieces of at most a brick when it is turned off
        // the axes (the renderer's `subPieces`: ceil(scale / 4) a side).
        const scale = m.scale ?? 1;
        const turned = scale > 1 && (p.rotation !== undefined || (p.yaw !== undefined && Math.abs(Math.sin(2 * p.yaw)) > 1e-9));
        units += (perModel[p.model] ??= m.subs.length / 3) * (turned ? Math.ceil(scale / 4) ** 3 : 1);
      }
    }
    const n = Math.min(Math.floor(split.workers), Math.floor(units / Math.max(1, split.shareUnits)));
    if (!(n >= 2)) return undefined;
    const ranges = baker.split(input, n);
    return ranges.filter((r) => r.hi > r.lo).length >= 2 ? ranges : undefined;
  };

  const schedule = () => {
    if (scheduled || running) return;
    scheduled = true;
    setTimeout(() => void run(), 0);
  };
  const fail = (id: number, err: unknown) => scope.postMessage({ kind: "error", id, message: err instanceof Error ? err.message : String(err) });
  const postEncoded = (id: number, encoded: EncodedModel, t0: number, keep: boolean, cached: boolean) => {
    const msg: SceneResponse = { kind: "encoded", id, encoded, ms: performance.now() - t0 };
    if (cached) msg.cached = true;
    scope.postMessage(msg, encodedTransferables(encoded, { keepPlacement: keep }));
    if (keep) kept.set(id, encoded);
  };

  async function lookup(m: Extract<SceneRequest, { kind: "lookup" }>): Promise<void> {
    const t0 = performance.now();
    lookups.add(m.id);
    try {
      const store = await cache;
      const hit = store ? await store.getEncoded(encodedDigest(m.cacheKey, m.partBoxes, m.joints)) : undefined;
      if (cancelled.has(m.id)) return;
      if (!hit) return scope.postMessage({ kind: "miss", id: m.id });
      if (m.partBoxes && hit.encoded.partBoxes) hit.encoded.partBoxes = m.partBoxes;
      encodedDigests.set(hit.encoded, hit.placement);
      postEncoded(m.id, hit.encoded, t0, !!m.keep, true);
    } catch {
      if (!cancelled.has(m.id)) scope.postMessage({ kind: "miss", id: m.id });
    } finally {
      lookups.delete(m.id);
    }
  }

  async function job(m: Extract<SceneRequest, { kind: "bake" | "share" | "encode" }>): Promise<void> {
    const t0 = performance.now();
    const id = m.id;
    const onProgress = (done: number, total: number) => scope.postMessage({ kind: "progress", id, done, total });
    if (m.kind === "share") {
      // A helper's whole job: no cache, the range as given.
      const share = baker.bakeShare(m.input, m.range, { onProgress });
      scope.postMessage({ kind: "shared", id, share, ms: performance.now() - t0 }, placementShareTransferables(share));
      return;
    }
    const store = m.kind === "bake" && m.cache === false ? null : await cache;
    if (m.kind === "bake") {
      const digest = store ? bakeDigest(m.input) : undefined;
      const hit = digest ? await store!.getBake(digest) : undefined;
      let bound: PlacementBake | undefined;
      try {
        // Stored normalised; baked against the same models under other ids and keys (another
        // visit), so bound to this input's. A bake that does not fit is a miss.
        bound = hit && bindPlacement(hit, m.input);
      } catch {
        bound = undefined;
      }
      if (bound) {
        scope.postMessage({ kind: "baked", id, bake: bound, ms: performance.now() - t0, cached: true }, placementTransferables(bound));
        return;
      }
      if (m.split) {
        // Cancelled while the cache was read: a split would only start the other workers too.
        if (currentCancelled) return;
        const ranges = planSplit(m.input, m.split);
        if (ranges) {
          // Named before the share is baked, so the others start while this one works. No await
          // from here to the `set`: the merge (or a cancel) finds the share there.
          scope.postMessage({ kind: "split", id, ranges });
          const share = baker.bakeShare(m.input, ranges[0], { onProgress });
          splitting.set(id, { input: m.input, share, digest, store, t0 });
          return;
        }
      }
      const bake = baker.bake(m.input, { onProgress });
      // Stored with its model ids normalised; putBake copies before its first await, and the
      // normalised bake shares every array but `inst`, so the original can be transferred right after.
      if (digest) track(store!.putBake(digest, normalizePlacement(bake)));
      scope.postMessage({ kind: "baked", id, bake, ms: performance.now() - t0 }, placementTransferables(bake));
      return;
    }
    const { sparse, ...rest } = m.model;
    const src: ModelSource = rest;
    if (sparse) src.sparse = { size: { ...m.model.size }, bricks: assembling.get(id) ?? new Map() };
    assembling.delete(id);
    const identity = m.cacheKey ?? (m.hashKey && store ? `hash:${sourceDigest(src)}` : undefined);
    const digest = store && identity !== undefined ? encodedDigest(identity, src.partBoxes, src.joints) : undefined;
    if (digest && m.cacheKey === undefined) {
      const hit = await store!.getEncoded(digest);
      if (hit) {
        if (src.partBoxes && hit.encoded.partBoxes) hit.encoded.partBoxes = src.partBoxes;
        encodedDigests.set(hit.encoded, hit.placement);
        postEncoded(id, hit.encoded, t0, !!m.keep, true);
        return;
      }
    }
    const encoded = encodeModel(src, { onProgress });
    if (digest) {
      const { placement, written } = store!.putEncoded(digest, encoded);
      encodedDigests.set(encoded, placement);
      track(written);
    }
    postEncoded(id, encoded, t0, !!m.keep, false);
  }

  async function run(): Promise<void> {
    scheduled = false;
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const m = queue.shift()!;
        if (m.kind === "model") register(m.model);
        else if (m.kind === "drop") {
          baker.unregister(m.key);
          registered.delete(m.key);
          digests.delete(m.key);
        } else if (m.kind === "keys") {
          const e = kept.get(m.id);
          kept.delete(m.id);
          if (e) for (const k of Array.isArray(m.keys) ? m.keys : [m.keys]) register(placementModelOf(e, k), encodedDigests.get(e));
        } else if (m.kind === "bake" || m.kind === "share" || m.kind === "encode") {
          highest = Math.max(highest, m.id);
          if (cancelled.delete(m.id)) {
            assembling.delete(m.id);
            continue;
          }
          current = m.id;
          currentCancelled = false;
          try {
            await job(m);
          } catch (err) {
            assembling.delete(m.id);
            fail(m.id, err);
          }
          current = 0;
          // Yield after each job, so cancels (and newer jobs) that came in meanwhile are seen.
          if (queue.length) await new Promise<void>((r) => setTimeout(r, 0));
        }
      }
    } finally {
      running = false;
    }
  }
  scope.onmessage = (ev) => {
    const m = ev.data;
    if (!m) return;
    if (m.kind === "cancel") {
      kept.delete(m.id);
      assembling.delete(m.id);
      splitting.delete(m.id);
      if (m.id === current) currentCancelled = true;
      if (m.id > highest || lookups.has(m.id)) cancelled.add(m.id);
      return;
    }
    if (m.kind === "merge") {
      // Not queued: the bake is this worker's oldest job, and its own share is done (the merge
      // can only follow the `split`, posted in the task that baked it). A few ms.
      const s = splitting.get(m.id);
      if (!s) return; // cancelled meanwhile
      splitting.delete(m.id);
      try {
        const bake = mergePlacementShares(s.input, [s.share, ...m.shares]);
        if (s.digest) track(s.store!.putBake(s.digest, normalizePlacement(bake)));
        scope.postMessage({ kind: "baked", id: m.id, bake, ms: performance.now() - s.t0 }, placementTransferables(bake));
      } catch (err) {
        fail(m.id, err);
      }
      return;
    }
    if (m.kind === "close") {
      void (async () => {
        await cache;
        while (writes.size) await Promise.allSettled([...writes]);
        scope.postMessage({ kind: "closed" });
      })();
      return;
    }
    if (m.kind === "lookup") {
      void lookup(m);
      return;
    }
    if (m.kind === "chunk") {
      if (cancelled.has(m.id)) return;
      let map = assembling.get(m.id);
      if (!map) assembling.set(m.id, (map = new Map()));
      // Views into the chunk: the encode only reads them.
      for (let i = 0; i < m.keys.length; i++) map.set(m.keys[i], m.bricks.subarray(i * 512, i * 512 + 512));
      return;
    }
    queue.push(m);
    schedule();
  };
}

/** Options for {@link makeSceneWorker}. */
export interface SceneWorkerOptions {
  /**
   * Creates the worker, which runs {@link serveScene}. The consumer supplies this because only
   * their bundler can resolve a worker entry:
   *
   *   spawn: () => new Worker(new URL("./scene.worker.ts", import.meta.url), { type: "module" })
   */
  spawn: () => Worker;
  /**
   * Sparse bricks per `chunk` message when a model is sent to be encoded (default 16384, 8 MiB).
   * Each chunk is packed on the main thread in a task of its own, so this bounds how long one
   * such task takes.
   */
  chunkBricks?: number;
  /**
   * How long `destroy()` lets an idle worker finish its cache writes before terminating it anyway,
   * in ms (default 10000).
   */
  closeTimeoutMs?: number;
  /**
   * The most workers one placement bake is split over, the scene worker itself included. With
   * more than one, a bake that misses the cache and is big enough ({@link bakeShareUnits}) is
   * cut into shares of equal marking work (the renderer's `splitPlacement`): the scene worker
   * bakes one, helper workers the others, and the scene worker joins them into the bake a single
   * worker makes, byte for byte, so the result and the cache are the same either way. Measured
   * on a forest at 50 vox/m: 4.2 times faster with 8 workers on a 24-thread laptop, 4.1 times
   * with 4 on a phone whose other four cores are slow (nothing more with 8).
   *
   * The helpers come from `spawn`, at the first bake that is split and never before, and only do
   * shares: encoding, the cache and every answer stay with the scene worker. Each helper is sent
   * the placement data of the models the set names (their sub-cells, 12 bytes per occupied 2³
   * sub-cell; the main thread already holds them for the renderer), a few MiB per task, so a
   * helper holds a copy of them until it is released ({@link bakeIdleMs}). Measured for a forest
   * of twelve models (five trees, a house, shrubs and grasses): 39 MiB per helper at 50 vox/m,
   * 5 MiB at 20.
   *
   * Default: one per core less one (`navigator.hardwareConcurrency`), at most 4 where the primary
   * pointer is coarse (phones and tablets) and 8 elsewhere, at least 1. Pass 1 for a single
   * worker, exactly as before this option: no helper is ever spawned. Other workers the app runs
   * (a generator pool, chunk fills) compete for the same cores while a bake runs.
   */
  bakeWorkers?: number;
  /**
   * The least marking work per share of a split bake, in the bake's work units (one occupied 2³
   * sub-cell of one instance marked, about 25 ns on a laptop and 60 ns on a phone; a posed
   * instance counts its box's bricks, a turned scaled one its sub-cells' pieces). A bake is
   * split over `min(bakeWorkers, floor(units / bakeShareUnits))` workers, and not at all below
   * two shares, so a small set never spawns a worker. Default 2 000 000 (about 50 ms of marking on a laptop,
   * 120 ms on a phone, against the tens of ms it takes to start a worker and send it the
   * models): a set splits from 4 million units, and uses all of 8 workers from 16 million.
   */
  bakeShareUnits?: number;
  /**
   * How long the helpers of a split bake are kept once no split bake is in flight, in ms, before
   * they are terminated and their copies of the models freed (default 5000: long enough that a
   * coarse set followed by its fine one, or a retried bake, reuses them). 0 releases them at
   * once, `Infinity` keeps them until `destroy()`. Released helpers are spawned again, and sent
   * the models again, by the next bake that is split.
   */
  bakeIdleMs?: number;
}

/** {@link SceneWorkerOptions.bakeWorkers}' default: a worker per core less one, at most 4 on touch devices and 8 elsewhere. */
function defaultBakeWorkers(): number {
  const g = globalThis as { navigator?: { hardwareConcurrency?: number }; matchMedia?: (q: string) => { matches: boolean } };
  const cores = g.navigator?.hardwareConcurrency ?? 4;
  // Phones: half the cores are slow ones, and a prototype gained nothing beyond 4 there.
  const coarse = typeof g.matchMedia === "function" && g.matchMedia("(pointer: coarse)").matches;
  return Math.max(1, Math.min(coarse ? 4 : 8, cores - 1));
}

/** Bytes of placement data sent to a helper per task (each send is a structured clone on the main thread). */
const FEED_BYTES = 4 << 20;

/**
 * A worker that bakes static placements, from {@link makeSceneWorker}. Give it to
 * `makeInstanceLayer(target, { placement })`, which registers models and bakes for you; the
 * methods are there for hosts that drive
 * `Renderer.placementInput` / `applyPlacement` themselves. One worker can serve several layers
 * and renderers: model keys are unique on the page.
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
   * destroyed. For a bake split over several workers ({@link SceneWorkerOptions.bakeWorkers})
   * `done` and `total` are the sums over the shares; until every share has reported, `total`
   * counts the missing ones at the average of the others (the shares are balanced, so it barely
   * moves), and `done` still never decreases.
   *
   * Aborting a split bake cancels every share that has not started; started ones run to the end
   * on their workers, as a single bake does. A share that fails, or a helper that dies, rejects
   * the bake; the next bake starts afresh.
   *
   * A worker with a cache (`serveScene({ cache })`) answers from it when it holds this bake (by a
   * digest of the input and of the models' placement data): no progress then, and
   * {@link PlacementWorker.fromCache} is true for the result. `cache: false` skips it both ways.
   */
  bake(input: PlacementInput, opts?: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void; cache?: boolean }): Promise<PlacementBake>;
  /** Whether a bake (or an encoding, on a scene worker) this worker returned came from its cache. */
  fromCache(result: PlacementBake | EncodedModel): boolean;
  /** Jobs (bakes, and on a scene worker encodes) asked for and not yet settled. */
  readonly pending: number;
  /**
   * Stop the worker: pending jobs reject at once and the worker is unusable afterwards. A worker
   * still running a job is terminated at once; an idle one first finishes its cache writes (up
   * to `closeTimeoutMs`), so what it just made is there next visit. Resolves when the worker has
   * been terminated; callers need not wait (and should not make a first frame wait for it).
   * The helpers of split bakes are terminated at once: they write no cache.
   */
  destroy(): Promise<void>;
}

/** Options of {@link SceneWorker.encode}. */
export interface SceneEncodeOptions {
  /**
   * Aborting rejects with `signal.reason` (an AbortError unless given another), stops sending
   * the model's bricks, and skips the encode if the worker has not started it; a started one
   * runs to the end and its result is dropped.
   */
  signal?: AbortSignal;
  /**
   * The encode's progress on the worker (`EncodeOptions.onProgress`): `done` of `total` opaque
   * units, first `(0, total)`, last `(total, total)`, about every 50 ms, never decreasing. Silent
   * while the model's bricks are still being sent, and after the encode settles or aborts.
   */
  onProgress?: (done: number, total: number) => void;
  /**
   * Keep the encoding's placement data (its sub-cells) on the worker too, so that once the model
   * is added, {@link SceneWorker.registerEncoded} registers it for placement without sending the
   * sub-cells back. Then either `registerEncoded` or {@link SceneWorker.forget} must follow, or
   * the worker holds them until it is destroyed. Default false: everything is transferred.
   */
  keepPlacement?: boolean;
  /**
   * The source's identity, for a worker with a cache: a string that names its voxels and parts
   * (e.g. `GeneratorPool.modelKey(model)`). The worker is asked for a stored encoding under it
   * (together with the source's part boxes and joints and the renderer's encoding version) before
   * any of the source is sent; on a miss the source is sent and its encoding stored. A key that
   * two different sources share gives the second the first's encoding, so it must change whenever
   * the voxels do. Ignored by a worker without a cache (one round trip, then the usual encode).
   */
  cacheKey?: string;
  /**
   * With no `cacheKey`: let a worker with a cache hash the source's bytes to look it up (about
   * 30 ms per 100 MB on the worker). The source is sent in full either way, so this saves only the
   * encode. Default false.
   */
  hashKey?: boolean;
}

/**
 * A worker that encodes models for the GPU and bakes static placements, from
 * {@link makeSceneWorker}. Give it to `makeInstanceLayer(target, { worker })`, which does both
 * for its static set; the methods are there for hosts that drive `encodeModel` /
 * `Renderer.addEncodedModel` and the placement bake themselves.
 */
export interface SceneWorker extends PlacementWorker {
  /**
   * Encode a model on the worker (`encodeModel`), for `Renderer.addEncodedModel`. The call
   * returns at once: a sparse model's bricks are packed and sent in chunks, one task each, and a
   * dense model's arrays are copied as `postMessage` copies them. Don't change the model until the
   * promise settles. Rejects when the encode fails (more than 32 parts, parts without dense data),
   * the worker dies or is destroyed, or `signal` aborts.
   *
   * A source's `partBoxes` object is put back on the result in place of the worker's copy, so
   * models added with the same boxes object still share poses (`ModelSource.partBoxes`).
   *
   * @param src - The model, as `Renderer.addModel` takes it.
   * @param opts - Abort, progress, and whether the worker keeps the placement data.
   * @returns The encoded model, its arrays transferred from the worker.
   */
  encode(src: ModelSource, opts?: SceneEncodeOptions): Promise<EncodedModel>;
  /**
   * Register a model for placement once the renderer has added it (`key`, `poseKey` and `scale`
   * from `Renderer.placementModel(id)` after `addEncodedModel`; pass `scale` too, or the worker
   * bakes a scaled model at scale 1). An encoding this worker kept
   * (`keepPlacement`) is registered from the worker's own copy, so only the keys travel; any other
   * is sent whole (`placementModelOf`, as {@link PlacementWorker.register}). Once per key.
   *
   * One encoding added at several scales (`addEncodedModel(e, { scale })` once per scale) is
   * several renderer models: pass all their keys in one call, so a kept encoding still sends
   * only keys. The worker forgets its copy after this call, so a scale added later is sent whole.
   */
  registerEncoded(encoded: EncodedModel, keys: PlacementKeys | readonly PlacementKeys[]): void;
  /** Let the worker drop what it kept of an encoding that will not be registered. Harmless otherwise. */
  forget(encoded: EncodedModel): void;
}

/** The abort reason, or an AbortError when there is none. */
function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const e = typeof DOMException !== "undefined" ? new DOMException("The operation was aborted.", "AbortError") : Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
  return e;
}

/**
 * Encode models and bake static placements on a worker, main-thread side (the worker runs
 * {@link serveScene}). With it, `makeInstanceLayer(renderer, { worker })` builds its static set
 * off the main thread (`layer.commitAsync()`): the main thread only packs the models' bricks to
 * send, claims their pool slots and applies the bake. Browser-only (needs `Worker`).
 *
 * A big bake is split over several workers by default ({@link SceneWorkerOptions.bakeWorkers});
 * the extra ones are spawned from the same `spawn` when such a bake comes and released a while
 * after it. Nothing else changes for the caller: same result, same cache, same progress.
 *
 * @example
 * ```ts
 * const worker = makeSceneWorker({
 *   spawn: () => new Worker(new URL("./scene.worker.ts", import.meta.url), { type: "module" }),
 * });
 * const layer = makeInstanceLayer(renderer, { load, worker });
 * layer.setStatic(scenery);
 * await layer.commitAsync(); // the page keeps drawing meanwhile
 * ```
 */
export function makeSceneWorker(opts: SceneWorkerOptions): SceneWorker {
  return sceneWorker(opts, "scene worker");
}

/** {@link makeSceneWorker}, naming itself `name` in its errors. @internal */
export function sceneWorker(opts: SceneWorkerOptions, name: string): SceneWorker {
  const worker = opts.spawn();
  const chunkBricks = Math.max(1, opts.chunkBricks ?? 16384);
  const closeTimeout = opts.closeTimeoutMs ?? 10_000;
  /** Results that came from the worker's cache. */
  const cachedResults = new WeakSet<object>();
  /** Resolves `destroy()`'s wait for the worker's `closed`. */
  let closed: (() => void) | undefined;
  const keys = new Set<number>();
  type Entry = {
    resolve: (r: never) => void;
    reject: (e: unknown) => void;
    detach?: () => void;
    onProgress?: (done: number, total: number) => void;
    /** Encodes: the source's boxes object, put back on the result. */
    boxes?: Int32Array;
    keep?: boolean;
    /** Encodes looked up first: send the source after a miss. */
    onMiss?: () => void;
    /** Bakes that may be split: the input, for the helpers. */
    input?: PlacementInput;
    /** Bakes the worker split. */
    split?: Split;
  };
  const pending = new Map<number, Entry>();
  /** Encodings the worker keeps placement data for, and their encode ids. */
  const keptIds = new WeakMap<EncodedModel, number>();
  let nextId = 1;
  let destroyed = false;
  const post = (m: SceneRequest, transfer?: Transferable[]) => worker.postMessage(m, transfer ?? []);

  // --- bakes split over helper workers ---
  const bakeWorkers = Math.max(1, Math.floor(opts.bakeWorkers ?? defaultBakeWorkers()) || 1);
  const shareUnits = Math.max(1, opts.bakeShareUnits ?? 2_000_000);
  const idleMs = opts.bakeIdleMs ?? 5000;
  /** A worker that only bakes shares, and the model keys it has been sent. */
  interface Helper {
    worker: Worker;
    keys: Set<number>;
    /** The sends to it so far, in order: models are fed in slices, then the share. */
    feed: Promise<void>;
    dead?: boolean;
  }
  /** A split bake: the helpers still owing a share (`posted` once theirs was sent), and the shares in. */
  interface Split {
    on: Map<Helper, { slot: number; posted: boolean }>;
    shares: PlacementShare[];
    /** Progress per share (0 is the scene worker's), as last heard. */
    parts: ({ done: number; total: number } | undefined)[];
    done: number;
  }
  const helpers: Helper[] = [];
  /** The registered models, for helpers (the renderer's own objects; nothing is copied here). Kept only when bakes may split. */
  const models = new Map<number, PlacementModel>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const releaseHelpers = () => {
    clearTimeout(idleTimer);
    idleTimer = undefined;
    for (const h of helpers.splice(0)) {
      h.dead = true;
      h.worker.terminate();
    }
  };
  /** No split bake in flight any more: release the helpers after the idle time. */
  const idle = () => {
    if (!helpers.length || idleTimer !== undefined || idleMs === Infinity) return;
    for (const p of pending.values()) if (p.split) return;
    if (idleMs <= 0) return releaseHelpers();
    idleTimer = setTimeout(releaseHelpers, idleMs);
  };
  /** The sum of a split bake's shares, the ones not heard from yet counted at the others' average. */
  const splitProgress = (p: Entry, slot: number, done: number, total: number) => {
    const s = p.split!;
    s.parts[slot] = { done, total };
    let d = 0, t = 0, known = 0;
    for (const part of s.parts) {
      if (!part) continue;
      d += part.done;
      t += part.total;
      known++;
    }
    const whole = known === s.parts.length ? t : Math.round((t * s.parts.length) / known);
    s.done = Math.max(s.done, Math.min(d, whole));
    p.onProgress?.(Math.min(s.done, whole), whole);
  };
  const failBake = (id: number, err: unknown) => {
    const p = settle(id);
    if (!p) return;
    post({ kind: "cancel", id });
    p.reject(err);
  };
  const spawnHelper = (): Helper => {
    const h: Helper = { worker: opts.spawn(), keys: new Set(), feed: Promise.resolve() };
    h.worker.onmessage = (ev: MessageEvent<SceneResponse>) => {
      const m = ev.data;
      if (m.kind !== "progress" && m.kind !== "shared" && m.kind !== "error") return;
      const p = pending.get(m.id);
      const at = p?.split?.on.get(h);
      if (!p || !at) return; // settled, aborted, or not this helper's share
      if (m.kind === "progress") return splitProgress(p, at.slot, m.done, m.total);
      const s = p.split!;
      if (m.kind === "error") return failBake(m.id, new Error(m.message));
      s.on.delete(h);
      s.shares.push(m.share);
      // The last share in: the scene worker joins them with its own and answers `baked`.
      if (!s.on.size) post({ kind: "merge", id: m.id, shares: s.shares }, s.shares.flatMap(placementShareTransferables));
    };
    h.worker.onerror = (ev: ErrorEvent) => {
      h.dead = true;
      const i = helpers.indexOf(h);
      if (i >= 0) helpers.splice(i, 1);
      h.worker.terminate();
      for (const [id, p] of [...pending]) if (p.split?.on.has(h)) failBake(id, new Error(ev.message || `${name} failed (a helper of a split bake)`));
    };
    return h;
  };
  /** Send helper `h` the models `input` names that it lacks, a few MiB per task, then its share. */
  const feed = (h: Helper, id: number, input: PlacementInput, range: PlacementRange) => {
    const live = () => !destroyed && !h.dead && !!pending.get(id)?.split?.on.has(h);
    h.feed = h.feed.then(async () => {
      let bytes = 0;
      for (const key of new Set(input.models)) {
        if (!key || h.keys.has(key)) continue;
        if (!live()) return;
        const model = models.get(key);
        if (!model) continue; // dropped meanwhile: the share fails as the bake does
        h.keys.add(key);
        h.worker.postMessage({ kind: "model", model } satisfies SceneRequest);
        bytes += model.subs.byteLength;
        if (bytes >= FEED_BYTES) {
          bytes = 0;
          await new Promise<void>((r) => setTimeout(r, 0));
        }
      }
      if (!live()) return;
      pending.get(id)!.split!.on.get(h)!.posted = true;
      // One message, so instances sharing a `parts` object still share it on the helper.
      h.worker.postMessage({ kind: "share", id, input, range } satisfies SceneRequest);
    }).catch((err) => failBake(id, err)); // a send threw: the chain stays usable
  };
  /** The scene worker split bake `id`: hand every other range that is not empty to a helper. */
  const startSplit = (id: number, p: Entry, ranges: PlacementRange[]) => {
    const todo = ranges.slice(1).filter((r) => r.hi > r.lo);
    if (!todo.length || !p.input) return;
    clearTimeout(idleTimer);
    idleTimer = undefined;
    const s: Split = { on: new Map(), shares: [], parts: new Array(todo.length + 1).fill(undefined), done: 0 };
    p.split = s;
    try {
      todo.forEach((range, i) => {
        if (pending.get(id) !== p) return; // settled meanwhile
        const h = (helpers[i] ??= spawnHelper());
        s.on.set(h, { slot: i + 1, posted: false });
        feed(h, id, p.input!, range);
      });
    } catch (err) {
      failBake(id, err); // `spawn` threw
    }
  };

  const settle = (id: number) => {
    const p = pending.get(id);
    if (!p) return undefined;
    pending.delete(id);
    p.detach?.();
    if (p.split) {
      // Shares not baked yet are skipped; one that has started runs to the end, and is dropped.
      for (const [h, at] of p.split.on) if (at.posted && !h.dead) h.worker.postMessage({ kind: "cancel", id } satisfies SceneRequest);
      p.split.on.clear();
      idle();
    }
    return p;
  };
  worker.onmessage = (ev: MessageEvent<SceneResponse>) => {
    const m = ev.data;
    if (m.kind === "progress") {
      const p = pending.get(m.id); // unknown, aborted or settled ids: ignored
      if (p?.split) splitProgress(p, 0, m.done, m.total);
      else p?.onProgress?.(m.done, m.total);
      return;
    }
    if (m.kind === "split") {
      const p = pending.get(m.id);
      if (p) startSplit(m.id, p, m.ranges);
      return;
    }
    if (m.kind === "shared") return; // only helpers are asked for shares
    if (m.kind === "closed") {
      closed?.();
      return;
    }
    if (m.kind === "miss") {
      pending.get(m.id)?.onMiss?.();
      return;
    }
    const p = settle(m.id);
    if (!p) {
      // Aborted meanwhile: an encoding the worker kept is forgotten there too.
      if (m.kind === "encoded") post({ kind: "cancel", id: m.id });
      return;
    }
    if (m.kind === "baked") {
      if (m.cached) cachedResults.add(m.bake);
      p.resolve(m.bake as never);
    } else if (m.kind === "encoded") {
      const e = m.encoded;
      if (m.cached) cachedResults.add(e);
      if (p.boxes && e.partBoxes) e.partBoxes = p.boxes;
      if (p.keep) keptIds.set(e, m.id);
      p.resolve(e as never);
    } else p.reject(new Error(m.message));
  };
  worker.onerror = (ev: ErrorEvent) => {
    for (const id of [...pending.keys()]) settle(id)?.reject(new Error(ev.message || `${name} failed`));
    closed?.();
  };

  /** Start a job: a pending entry, abort wiring, then `send` (which may post over several tasks). */
  function job<T>(o: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void }, extra: Partial<Entry>, send: (id: number, live: () => boolean) => void): Promise<T> {
    if (destroyed) return Promise.reject(new Error(`${name} destroyed`));
    const signal = o.signal;
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: Entry = { resolve: resolve as (r: never) => void, reject, onProgress: o.onProgress, ...extra };
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
      send(id, () => pending.has(id) && !destroyed);
    });
  }

  const self: SceneWorker = {
    register(model) {
      if (destroyed || keys.has(model.key)) return;
      keys.add(model.key);
      if (bakeWorkers > 1) models.set(model.key, model);
      post({ kind: "model", model });
    },
    has: (key) => keys.has(key),
    drop(key) {
      if (destroyed || !keys.delete(key)) return;
      post({ kind: "drop", key });
      models.delete(key);
      for (const h of helpers) if (h.keys.delete(key)) h.worker.postMessage({ kind: "drop", key } satisfies SceneRequest);
    },
    bake(input, o = {}) {
      // One worker: the message, and so everything after it, is what it was before bakes could split.
      if (bakeWorkers < 2) return job<PlacementBake>(o, {}, (id) => post(o.cache === false ? { kind: "bake", id, input, cache: false } : { kind: "bake", id, input }));
      const split: BakeSplit = { workers: bakeWorkers, shareUnits };
      return job<PlacementBake>(o, { input }, (id) => post(o.cache === false ? { kind: "bake", id, input, cache: false, split } : { kind: "bake", id, input, split }));
    },
    fromCache: (result) => cachedResults.has(result),
    encode(src, o = {}) {
      const keep = !!o.keepPlacement;
      const cacheKey = o.cacheKey;
      return job<EncodedModel>(o, { boxes: src.partBoxes, keep }, (id, live) => {
        if (cacheKey !== undefined) {
          // Ask the cache first; the source goes only on a miss (once).
          const entry = pending.get(id)!;
          entry.onMiss = () => {
            entry.onMiss = undefined;
            send(id, live);
          };
          const q: SceneRequest = { kind: "lookup", id, cacheKey, keep };
          if (src.partBoxes) q.partBoxes = src.partBoxes;
          if (src.joints) q.joints = src.joints;
          post(q);
          return;
        }
        send(id, live);
      });
      function send(id: number, live: () => boolean): void {
        const model: EncodeSource = { size: { x: src.size.x, y: src.size.y, z: src.size.z } };
        if (src.parts) model.parts = src.parts;
        if (src.joints) model.joints = src.joints;
        if (src.partBoxes) model.partBoxes = src.partBoxes;
        const finish = () => {
          if (!live()) return;
          const m: SceneRequest = { kind: "encode", id, model, keep };
          if (cacheKey !== undefined) m.cacheKey = cacheKey;
          else if (o.hashKey) m.hashKey = true;
          post(m);
        };
        if (!src.sparse) {
          if (src.data) model.data = src.data;
          // Dense arrays are copied by postMessage in one go; after a yield, like the sparse path,
          // so that starting many encodes in one task costs nothing there.
          setTimeout(finish, 0);
          return;
        }
        model.sparse = true;
        // Pack the brick map into chunks, one task each: a map of many small arrays clones slowly,
        // and a packed chunk transfers.
        const it = src.sparse.bricks.entries();
        let left = src.sparse.bricks.size;
        const step = () => {
          if (!live()) return;
          if (left <= 0) return finish();
          const n = Math.min(chunkBricks, left);
          const k = new Uint32Array(n), b = new Uint8Array(n * 512);
          let i = 0;
          for (; i < n; i++) {
            const r = it.next();
            if (r.done) break;
            k[i] = r.value[0];
            b.set(r.value[1], i * 512);
          }
          left = i < n ? 0 : left - n;
          post({ kind: "chunk", id, keys: i < n ? k.slice(0, i) : k, bricks: i < n ? b.slice(0, i * 512) : b }, i < n ? [] : [k.buffer, b.buffer]);
          setTimeout(step, 0);
        };
        setTimeout(step, 0);
      }
    },
    registerEncoded(encoded, k) {
      const id = keptIds.get(encoded);
      keptIds.delete(encoded);
      if (destroyed) return;
      const fresh = (Array.isArray(k) ? (k as readonly PlacementKeys[]) : [k as PlacementKeys]).filter((x, i, all) => !keys.has(x.key) && all.findIndex((y) => y.key === x.key) === i);
      if (!fresh.length) {
        if (id !== undefined) post({ kind: "cancel", id });
        return;
      }
      if (id === undefined) {
        for (const x of fresh) self.register(placementModelOf(encoded, x));
        return;
      }
      const sent = fresh.map((x) => {
        keys.add(x.key);
        const o: PlacementKeys = { key: x.key, poseKey: x.poseKey };
        if (x.scale !== undefined && x.scale !== 1) o.scale = x.scale;
        // For helpers: a view of the encoding the main thread holds anyway (no copy).
        if (bakeWorkers > 1) models.set(x.key, placementModelOf(encoded, o));
        return o;
      });
      post({ kind: "keys", id, keys: sent.length === 1 ? sent[0] : sent });
    },
    forget(encoded) {
      const id = keptIds.get(encoded);
      if (id === undefined) return;
      keptIds.delete(encoded);
      if (!destroyed) post({ kind: "cancel", id });
    },
    get pending() {
      return pending.size;
    },
    destroy() {
      if (destroyed) return Promise.resolve();
      destroyed = true;
      // Still working: what it is making is unwanted now, so do not wait for it.
      const busy = pending.size > 0;
      for (const id of [...pending.keys()]) settle(id)!.reject(new Error(`${name} destroyed`));
      keys.clear();
      models.clear();
      releaseHelpers(); // they hold no cache writes
      if (busy) {
        worker.terminate();
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          closed = undefined;
          worker.terminate();
          resolve();
        };
        const timer = setTimeout(done, closeTimeout);
        closed = done;
        post({ kind: "close" });
      });
    },
  };
  return self;
}
