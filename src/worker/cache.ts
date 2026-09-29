// A cache of generated models in the browser's storage, for the worker pool.
//
// Generation is deterministic, so a model is a pure function of its generator
// (id and version), parameters, seed and context: generate it once, keep it,
// and the next visit loads it instead. Refined models at 100 voxels per metre
// take seconds each on a phone, and a valley needs dozens.
//
// Entries are packed (a sparse model's bricks concatenated, typed arrays as
// bytes) and deflated, then kept in IndexedDB under a key that also carries a
// `salt`: the worker passes its own script URL, which a production build
// hashes, so new generator code never reads a model the old code made.
// Entries from any other salt are deleted when a worker opens the cache.
//
// Two object stores: `models` holds the packed records, `meta` a small record
// per entry (generator, salt, bytes, created, last used), so inspecting,
// clearing and evicting never read a model. The logic runs on a small
// `CacheStore` interface; IndexedDB is one implementation, and the checks use
// an in-memory one, since bun has no IndexedDB.

import type { Entity, EntityModel } from "../entity";

/**
 * Generated models kept in IndexedDB, from {@link openModelCache}. Both methods swallow storage
 * errors: a failed `get` is a miss and a failed `put` simply keeps nothing.
 */
export interface ModelCache {
  /** The entity stored under `key`, as fresh arrays, or undefined. A hit marks the entry used now (for the size cap's eviction). */
  get(key: string): Promise<Entity | undefined>;
  /**
   * The entity stored under `key` in its packed form ({@link packEntity}), or undefined: what
   * `serveGenerators` posts, since one buffer transfers where a sparse model's thousands of
   * brick buffers are slow to. A hit marks the entry used now.
   */
  getPacked(key: string): Promise<PackedEntity | undefined>;
  /**
   * Store a packed, deflated copy. It copies before its first await, so the caller may transfer
   * the entity's buffers straight after calling. Resolves once the write has committed (or
   * failed). `info.generator` is recorded for inspecting and clearing by generator.
   */
  put(key: string, entity: Entity, info?: { generator?: string }): Promise<void>;
  /** {@link ModelCache.put} for an entity already packed; it copies `packed.bytes` before its first await. */
  putPacked(key: string, packed: PackedEntity, info?: { generator?: string }): Promise<void>;
}

/**
 * An entity as one header plus one byte buffer holding its arrays, from {@link packEntity}: how
 * the model cache stores entities and how `serveGenerators` posts them (one buffer to transfer).
 */
export interface PackedEntity {
  /** The entity without its arrays, plus where each array lies in `bytes`. Plain data. */
  head: Record<string, unknown>;
  /** The arrays, back to back (each 4-byte aligned). */
  bytes: Uint8Array<ArrayBuffer>;
}

/** Options for {@link openModelCache}. */
export interface ModelCacheOptions {
  /**
   * Keep the cache under about this many bytes (compressed): after each write, the least
   * recently used entries (of any salt) are evicted until it fits, and a model bigger than the cap
   * is not kept at all. Unset, the cache grows until the browser's quota stops it (a failed write
   * keeps nothing, the model still works).
   *
   * The cap is the game's to set: size it by measuring. Load the game's heaviest scenes once with
   * no cap, read {@link ModelCacheControls.usage} (e.g. from the console), and set the cap to that
   * with some headroom, so that what one play session needs stays cached.
   *
   * Checked when the cache is made: a value that is not a positive finite number throws (a
   * `RangeError`). These warn once per cache, with `console.warn` (each worker keeps its own
   * cache, so a pool of four may warn four times): a cap under {@link CACHE_CAP_FLOOR} (16 MiB);
   * a cap above the origin's quota as `navigator.storage.estimate()` reports it (the browser
   * evicts first, so the cap never applies); and the first entry bigger than the cap, which is
   * then not kept.
   */
  maxBytes?: number;
}

/**
 * Below this `maxBytes` (16 MiB) a model or scene cache warns that its cap is probably a
 * mistake: one refined model or placement bake is often bigger.
 */
export const CACHE_CAP_FLOOR = 16 * 1024 * 1024;

const mib = (n: number) =>
  n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${Math.round(n)} bytes`;

/**
 * Validate a cache's `maxBytes`: undefined (or null) is no cap, a positive finite number is the
 * cap, anything else throws a `RangeError` naming `what`. @internal
 */
export function checkCacheCap(maxBytes: number | undefined, what: string): number | undefined {
  if (maxBytes === undefined || maxBytes === null) return undefined;
  if (typeof maxBytes !== "number" || !Number.isFinite(maxBytes) || maxBytes <= 0)
    throw new RangeError(
      `${what}: maxBytes must be a positive, finite number of bytes (got ${String(maxBytes)}). ` +
        "Leave it unset for no cap; to size one, measure with the cache controls' usage().",
    );
  return maxBytes;
}

/**
 * The once-per-cache warnings about a cap ({@link ModelCacheOptions.maxBytes}): warns now if it
 * is under the floor, soon if it is above the origin's quota, and returns the check for an entry
 * too big to keep. @internal
 */
export function watchCacheCap(cap: number | undefined, what: string): (size: number) => void {
  if (cap === undefined) return () => {};
  const warn = (m: string) => console.warn(`voxolith: ${what}: ${m}`);
  if (cap < CACHE_CAP_FLOOR)
    warn(
      `maxBytes is ${mib(cap)}, under ${mib(CACHE_CAP_FLOOR)}. One model or bake at a fine scale is often bigger, ` +
        "so a cap this small keeps little. Measure what your scenes store with the cache controls' usage() and size the cap from that.",
    );
  const storage = (globalThis as { navigator?: { storage?: { estimate?: () => Promise<{ quota?: number }> } } }).navigator?.storage;
  if (typeof storage?.estimate === "function") {
    void Promise.resolve()
      .then(() => storage.estimate!())
      .then((e) => {
        if (e?.quota !== undefined && cap > e.quota)
          warn(
            `maxBytes (${mib(cap)}) is above this origin's storage quota (${mib(e.quota)}), so the browser evicts before the cap ` +
              "is reached. Lower it, or ask for more room with navigator.storage.persist().",
          );
      })
      .catch(() => {});
  }
  let warned = false;
  return (size) => {
    if (warned || size <= cap) return;
    warned = true;
    warn(
      `an entry of ${mib(size)} is larger than maxBytes (${mib(cap)}), so it is not cached and is rebuilt on every visit. ` +
        "Raise the cap (measure with the cache controls' usage()). Warned once; later ones are skipped silently.",
    );
  };
}

/** One entry of the model cache, as {@link ModelCacheControls.entries} lists it. */
export interface ModelCacheEntry {
  /** The stored key: `salt|generator@version|seed|params|context`. */
  key: string;
  /** The salt it was stored under: the URL of the worker script that made it. */
  salt: string;
  /** The generator id (`EntityGenerator.id`). */
  generator: string;
  /** Approximate size: the compressed model plus its header. */
  bytes: number;
  /** When it was stored, `Date.now()` milliseconds. */
  created: number;
  /** When it was last stored or served, `Date.now()` milliseconds. */
  lastUsed: number;
}

/**
 * Which entries a control applies to; every field given must match. An empty filter matches
 * everything.
 */
export interface ModelCacheFilter {
  /** Only entries of this generator id (e.g. "voxolith/tree.broadleaf"). */
  generator?: string;
  /** Only entries stored under this salt (a worker script URL; see {@link ModelCacheEntry.salt}). */
  salt?: string;
}

/**
 * Developer controls for the model cache that `serveGenerators({ cache })` fills, from
 * {@link openModelCacheControls}. They run on the main thread (or anywhere with IndexedDB) and
 * read only the small per-entry records, never the models. Nothing here runs by itself: the app
 * decides when to inspect, clear or trim.
 */
export interface ModelCacheControls {
  /** Every entry matching `filter`, most recently used first. */
  entries(filter?: ModelCacheFilter): Promise<ModelCacheEntry[]>;
  /** How many entries match `filter` and their approximate total bytes. */
  usage(filter?: ModelCacheFilter): Promise<{ entries: number; bytes: number }>;
  /** Delete the entries matching `filter` (all of them without one). Resolves to how many went. */
  clear(filter?: ModelCacheFilter): Promise<number>;
  /** Evict least recently used entries until the cache is at most `maxBytes`. Resolves to how many went. */
  trim(maxBytes: number): Promise<number>;
  /** Close the database connection. The controls are unusable afterwards. */
  close(): void;
}

// --- storage --------------------------------------------------------------------------------

/** A packed model as stored: the header and the deflated bytes. */
export interface CacheRecord {
  /** {@link packEntity}'s header. */
  head: Record<string, unknown>;
  /** The deflated bytes. */
  body: Blob;
}

/**
 * The storage under the model cache: records and their per-entry bookkeeping, written together.
 * IndexedDB implements it in the browser; {@link memoryCacheStore} in tests.
 */
export interface CacheStore {
  /** The record under `key`; with `used`, also sets the entry's `lastUsed` to it. */
  get(key: string, used?: number): Promise<CacheRecord | undefined>;
  /** Store a record and its entry together. */
  put(key: string, record: CacheRecord, entry: ModelCacheEntry): Promise<void>;
  /** Every entry. */
  list(): Promise<ModelCacheEntry[]>;
  /** In one step: pass every entry to `choose` and delete the keys it returns. Resolves to how many went. */
  sweep(choose: (entries: ModelCacheEntry[]) => string[]): Promise<number>;
  /** Release the storage. */
  close(): void;
}

/** A {@link CacheStore} in memory, for tests and for hosts without IndexedDB. */
export function memoryCacheStore(): CacheStore {
  const map = new Map<string, { record: CacheRecord; entry: ModelCacheEntry }>();
  return {
    async get(key, used) {
      const v = map.get(key);
      if (v && used !== undefined) v.entry = { ...v.entry, lastUsed: used };
      return v?.record;
    },
    async put(key, record, entry) {
      map.set(key, { record, entry: { ...entry } });
    },
    async list() {
      return [...map.values()].map((v) => ({ ...v.entry }));
    },
    async sweep(choose) {
      const keys = choose([...map.values()].map((v) => ({ ...v.entry })));
      let n = 0;
      for (const k of keys) if (map.delete(k)) n++;
      return n;
    },
    close() {},
  };
}

const MODELS = "models";
const META = "meta";
/** 1: records only. 2: adds `meta`; version-1 records have no entry and are dropped. */
const VERSION = 2;

/** Open (and create or upgrade) the cache database, or null where it cannot be opened. @internal */
export function openDb(name: string): Promise<IDBDatabase | null> {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    let req: IDBOpenDBRequest;
    try {
      req = idb.open(name, VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(MODELS)) db.createObjectStore(MODELS);
      else if (ev.oldVersion < 2) req.transaction!.objectStore(MODELS).clear();
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    req.onsuccess = () => {
      const db = req.result;
      // Let a newer build upgrade the database instead of being blocked by this connection.
      db.onversionchange = () => db.close();
      if (settled) db.close();
      else {
        settled = true;
        resolve(db);
      }
    };
    req.onerror = () => {
      settled = true;
      resolve(null);
    };
    // An older build in another tab holds the database open: go without a cache this time.
    req.onblocked = () => {
      if (settled) return;
      settled = true;
      resolve(null);
    };
  });
}

/** A {@link CacheStore} on an open IndexedDB database. @internal */
export function idbStore(db: IDBDatabase): CacheStore {
  const run = <T>(mode: IDBTransactionMode, body: (tx: IDBTransaction) => () => T) =>
    new Promise<T>((resolve, reject) => {
      const tx = db.transaction([MODELS, META], mode);
      const result = body(tx);
      tx.oncomplete = () => resolve(result());
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  return {
    get: (key, used) =>
      run(used === undefined ? "readonly" : "readwrite", (tx) => {
        let rec: CacheRecord | undefined;
        const r = tx.objectStore(MODELS).get(key);
        r.onsuccess = () => (rec = r.result as CacheRecord | undefined);
        if (used !== undefined) {
          const m = tx.objectStore(META).get(key);
          m.onsuccess = () => {
            if (m.result) tx.objectStore(META).put({ ...(m.result as ModelCacheEntry), lastUsed: used }, key);
          };
        }
        return () => rec;
      }),
    put: (key, record, entry) =>
      run("readwrite", (tx) => {
        tx.objectStore(MODELS).put(record, key);
        tx.objectStore(META).put(entry, key);
        return () => undefined;
      }),
    list: () =>
      run("readonly", (tx) => {
        let all: ModelCacheEntry[] = [];
        const r = tx.objectStore(META).getAll();
        r.onsuccess = () => (all = r.result as ModelCacheEntry[]);
        return () => all;
      }),
    sweep: (choose) =>
      run("readwrite", (tx) => {
        let n = 0;
        const r = tx.objectStore(META).getAll();
        r.onsuccess = () => {
          for (const key of choose(r.result as ModelCacheEntry[])) {
            tx.objectStore(MODELS).delete(key);
            tx.objectStore(META).delete(key);
            n++;
          }
        };
        return () => n;
      }),
    close: () => db.close(),
  };
}

/** Deflate a blob (raw deflate, as every cache record is stored). @internal */
export async function deflate(b: Blob): Promise<Blob> {
  return new Response(b.stream().pipeThrough(new CompressionStream("deflate-raw"))).blob();
}

/** Inflate a {@link deflate}d blob into bytes that own their buffer. @internal */
export async function inflate(b: Blob): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(b.stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
}

// --- policy-free logic ------------------------------------------------------------------------

/** Whether an entry passes a filter. @internal */
export const matches = (e: ModelCacheEntry, f: ModelCacheFilter = {}) =>
  (f.generator === undefined || e.generator === f.generator) && (f.salt === undefined || e.salt === f.salt);

/** The keys to evict, least recently used first, so that what stays totals at most `maxBytes`. */
export function planEviction(entries: readonly ModelCacheEntry[], maxBytes: number): string[] {
  let total = entries.reduce((n, e) => n + e.bytes, 0);
  const out: string[] = [];
  for (const e of [...entries].sort((a, b) => a.lastUsed - b.lastUsed || a.created - b.created)) {
    if (total <= maxBytes) break;
    out.push(e.key);
    total -= e.bytes;
  }
  return out;
}

/**
 * The model cache on any {@link CacheStore}: keys are prefixed with `salt`, entries are deflated,
 * and `maxBytes` evicts by last use after each write. {@link openModelCache} is this on IndexedDB.
 * Throws a `RangeError` on a `maxBytes` that is not a positive finite number, and warns about
 * doubtful ones ({@link ModelCacheOptions.maxBytes}).
 *
 * @param now - The clock for `created` / `lastUsed` (default `Date.now`); tests pass their own.
 */
export function makeModelCache(store: CacheStore, salt: string, opts: ModelCacheOptions = {}, now: () => number = Date.now): ModelCache {
  const prefix = `${salt}|`;
  const cap = checkCacheCap(opts.maxBytes, "model cache");
  const tooBig = watchCacheCap(cap, "model cache");
  const cache: ModelCache = {
    async get(key) {
      const p = await cache.getPacked(key);
      return p && unpackEntity(p.head, p.bytes);
    },
    async getPacked(key) {
      try {
        const rec = await store.get(prefix + key, now());
        if (!rec) return undefined;
        return { head: rec.head, bytes: await inflate(rec.body) };
      } catch {
        return undefined;
      }
    },
    put(key, entity, info) {
      return cache.putPacked(key, packEntity(entity), info);
    },
    async putPacked(key, { head, bytes }, info) {
      try {
        // The Blob copies the bytes now, so the caller may transfer them once this returns.
        const body = await deflate(new Blob([bytes]));
        const size = body.size + JSON.stringify(head).length;
        if (cap !== undefined && size > cap) return tooBig(size);
        const t = now();
        const generator = info?.generator ?? "";
        await store.put(prefix + key, { head, body }, { key: prefix + key, salt, generator, bytes: size, created: t, lastUsed: t });
        if (cap !== undefined) await store.sweep((all) => planEviction(all, cap));
      } catch {
        // Storage full or unavailable: the model still works, it just is not kept.
      }
    },
  };
  return cache;
}

/** {@link ModelCacheControls} on any {@link CacheStore}. {@link openModelCacheControls} is this on IndexedDB. */
export function makeModelCacheControls(store: CacheStore): ModelCacheControls {
  return {
    async entries(filter) {
      return (await store.list()).filter((e) => matches(e, filter)).sort((a, b) => b.lastUsed - a.lastUsed);
    },
    async usage(filter) {
      const list = (await store.list()).filter((e) => matches(e, filter));
      return { entries: list.length, bytes: list.reduce((n, e) => n + e.bytes, 0) };
    },
    clear: (filter) => store.sweep((all) => all.filter((e) => matches(e, filter)).map((e) => e.key)),
    trim: (maxBytes) => store.sweep((all) => planEviction(all, Math.max(0, maxBytes))),
    close: () => store.close(),
  };
}

/**
 * The model cache in IndexedDB database `name`, or null where there is none (bun, some private
 * windows, a database an older build in another tab holds open). Used by `serveGenerators` in the
 * worker; entries stored under any other salt are deleted when it opens, so a new build frees
 * the old build's models.
 *
 * @param name - The database name (the same one given to `serveGenerators({ cache })`).
 * @param salt - Prefixed to every key; the worker passes its script URL.
 * @param opts - An optional size cap.
 */
export async function openModelCache(name: string, salt: string, opts: ModelCacheOptions = {}): Promise<ModelCache | null> {
  if (typeof CompressionStream === "undefined") return null;
  const db = await openDb(name);
  if (!db) return null;
  return openModelCacheOn(idbStore(db), salt, opts);
}

/**
 * {@link openModelCache} on a store of your own: deletes the entries of every other salt, then
 * returns {@link makeModelCache} on it.
 */
export async function openModelCacheOn(store: CacheStore, salt: string, opts: ModelCacheOptions = {}): Promise<ModelCache> {
  // Drop what older builds left.
  try {
    await store.sweep((all) => all.filter((e) => e.salt !== salt).map((e) => e.key));
  } catch {
    // Not fatal: the stale entries are only unreachable.
  }
  return makeModelCache(store, salt, opts);
}

/**
 * Open controls for the model cache in IndexedDB database `name` (the name given to
 * `serveGenerators({ cache })`), or null where there is no IndexedDB. Works from the main
 * thread while workers use the cache.
 *
 * These are controls, never automatic: the engine clears or trims nothing unless asked (apart
 * from a worker dropping an older build's entries, and a `maxBytes` cap if the worker was given
 * one). On phones storage is small and the browser may evict a whole origin under pressure. Two
 * platform calls help an app decide, and both are the app's to make:
 * `navigator.storage.estimate()` reports the origin's usage and quota (compare it with
 * `usage()`), and `navigator.storage.persist()` asks the browser not to evict the origin (it may
 * prompt the user or refuse; ask after the user has shown they will come back, not on first
 * load).
 *
 * @example
 * ```ts
 * const cache = await openModelCacheControls("voxolith-models");
 * if (cache) {
 *   const { entries, bytes } = await cache.usage();
 *   const { quota = Infinity } = (await navigator.storage?.estimate()) ?? {};
 *   console.log(`${entries} models, ${(bytes / 1e6).toFixed(1)} MB`);
 *   if (bytes > quota / 4) await cache.trim(quota / 8);
 *   await cache.clear({ generator: "voxolith/tree.broadleaf" });
 *   cache.close();
 * }
 * ```
 */
export async function openModelCacheControls(name: string): Promise<ModelCacheControls | null> {
  const db = await openDb(name);
  return db ? makeModelCacheControls(idbStore(db)) : null;
}

// --- packing ----------------------------------------------------------------------------------

interface Section { name: string; offset: number; length: number; kind: "u8" | "u32" }

/**
 * An entity as a small header plus one byte buffer holding its arrays ({@link PackedEntity}): a
 * sparse model's bricks become one key array and one brick array, in the map's order. Copies.
 */
export function packEntity(entity: Entity): PackedEntity {
  const m = entity.model;
  const parts: { name: string; data: Uint8Array | Uint32Array }[] = [];
  if (m.sparse) {
    const keys = new Uint32Array(m.sparse.bricks.size);
    const bricks = new Uint8Array(m.sparse.bricks.size * 512);
    let i = 0;
    for (const [k, b] of m.sparse.bricks) { keys[i] = k; bricks.set(b, i * 512); i++; }
    parts.push({ name: "keys", data: keys }, { name: "bricks", data: bricks });
  } else parts.push({ name: "data", data: m.data });
  if (m.bones) parts.push({ name: "bones", data: m.bones });
  const sections: Section[] = [];
  let size = 0;
  for (const p of parts) { size = (size + 3) & ~3; sections.push({ name: p.name, offset: size, length: p.data.length, kind: p.data instanceof Uint32Array ? "u32" : "u8" }); size += p.data.byteLength; }
  const bytes = new Uint8Array(size);
  parts.forEach((p, i) => bytes.set(new Uint8Array(p.data.buffer, p.data.byteOffset, p.data.byteLength), sections[i].offset));
  const { data: _d, sparse: _s, bones: _b, ...model } = m;
  void _d; void _s; void _b;
  return { head: { entity: { ...entity, model }, sections }, bytes };
}

/**
 * Rebuild an entity from {@link packEntity}'s output. Every array is copied out of `bytes`, unless
 * `opts.views`: then a sparse model's bricks are views into `bytes` (which the entity then owns;
 * one allocation per brick rather than one copy each, which is what the generator pool does with
 * the packed entities its workers post). Dense `data` and `bones` are always copies.
 */
export function unpackEntity(head: Record<string, unknown>, bytes: Uint8Array, opts: { views?: boolean } = {}): Entity {
  const sections = head.sections as Section[];
  const view = (s: Section) => (s.kind === "u32" ? new Uint32Array(bytes.buffer, bytes.byteOffset + s.offset, s.length) : new Uint8Array(bytes.buffer, bytes.byteOffset + s.offset, s.length));
  const get = (n: string) => sections.find((s) => s.name === n);
  const e = head.entity as Entity;
  const model = { ...e.model } as EntityModel;
  const keys = get("keys"), bricks = get("bricks"), data = get("data"), bones = get("bones");
  if (keys && bricks) {
    const k = view(keys) as Uint32Array, b = view(bricks) as Uint8Array;
    const map = new Map<number, Uint8Array>();
    // Each brick its own buffer, as a generator would make it; or views into the one buffer.
    if (opts.views) for (let i = 0; i < k.length; i++) map.set(k[i], b.subarray(i * 512, i * 512 + 512));
    else for (let i = 0; i < k.length; i++) map.set(k[i], b.slice(i * 512, i * 512 + 512));
    model.sparse = { size: { ...model.size }, bricks: map };
    model.data = new Uint8Array(0);
  } else if (data) model.data = (view(data) as Uint8Array).slice();
  if (bones) model.bones = (view(bones) as Uint8Array).slice();
  return { ...e, model };
}
