// A cache of the scene worker's results in the browser's storage: encoded models and placement
// bakes.
//
// Both are pure functions of their inputs: an encoding of the model's voxels (and parts), a bake
// of the static set and the placement data of the models it names. At 100 voxels per metre they
// take seconds (nightwood: 3 s of encodes, 20 s of bake), and a warm visit asks for exactly the
// same ones again, so the worker that computes them keeps them, and the main thread never
// serialises anything.
//
// Keys:
// - an encoding: `encoded|v<ENCODED_MODEL_VERSION>|<digest>`, the digest of the model's identity
//   (a key the host supplies, e.g. `GeneratorPool.modelKey`, or a hash of the source's bytes) and
//   the source's part boxes and joints;
// - a bake: `placement|v<PLACEMENT_BAKE_VERSION>|r<record layout>|<digest>`, the digest of the
//   input (grid, instances, models in order of first appearance rather than by id) and of the
//   placement data (size, sub-cells, part boxes, joints, shared poses) of every model it names.
//   Bakes are stored normalised (`normalizePlacement`) and bound to the current visit's model ids
//   and keys on a hit (`bindPlacement`), since the renderer numbers models by free slot.
// Everything is salted with the worker's script URL, which a production build hashes, so new
// renderer code never reads what older code stored (the renderer's format versions are there as
// well, for builds whose URL does not change).
//
// The storage is the model cache's: a `CacheStore` (IndexedDB, or memory in the checks), with
// the same per-entry bookkeeping, eviction and controls. The entry's `generator` field holds the
// kind (`encoded` or `placement`).

import { ENCODED_MODEL_VERSION, PLACEMENT_BAKE_VERSION, type EncodedModel, type PlacementBake, type PlacementModel } from "@voxolith/renderer/core";
import { checkCacheCap, deflate, inflate, idbStore, openDb, planEviction, watchCacheCap, type CacheStore, type ModelCacheEntry } from "./cache";
import { Hasher } from "./hash";

/** What a scene cache entry holds: a model's encoding or a static set's bake. */
export type SceneCacheKind = "encoded" | "placement";

/** One entry of the scene cache, as {@link SceneCacheControls.entries} lists it. */
export interface SceneCacheEntry {
  /** The stored key: `salt|encoded|v<version>|<digest>` or `salt|placement|v<version>|r<layout>|<digest>`. */
  key: string;
  /** The salt it was stored under: the URL of the worker script that made it. */
  salt: string;
  /** An encoded model or a placement bake. */
  kind: SceneCacheKind;
  /** Approximate size: the stored bytes plus the header. */
  bytes: number;
  /** When it was stored, `Date.now()` milliseconds. */
  created: number;
  /** When it was last stored or served, `Date.now()` milliseconds. */
  lastUsed: number;
}

/** Which entries a control applies to; every field given must match. An empty filter matches everything. */
export interface SceneCacheFilter {
  /** Only encodings, or only bakes. */
  kind?: SceneCacheKind;
  /** Only entries stored under this salt (a worker script URL). */
  salt?: string;
}

/**
 * Developer controls for the cache that `serveScene({ cache })` fills, from
 * {@link openSceneCacheControls}: the model cache's controls (`ModelCacheControls`), by
 * kind rather than by generator. They read only the small per-entry records. Nothing here runs
 * by itself: the app decides when to inspect, clear or trim.
 */
export interface SceneCacheControls {
  /** Every entry matching `filter`, most recently used first. */
  entries(filter?: SceneCacheFilter): Promise<SceneCacheEntry[]>;
  /** How many entries match `filter` and their approximate total bytes. */
  usage(filter?: SceneCacheFilter): Promise<{ entries: number; bytes: number }>;
  /** Delete the entries matching `filter` (all of them without one). Resolves to how many went. */
  clear(filter?: SceneCacheFilter): Promise<number>;
  /** Evict least recently used entries until the cache is at most `maxBytes`. Resolves to how many went. */
  trim(maxBytes: number): Promise<number>;
  /** Close the database connection. The controls are unusable afterwards. */
  close(): void;
}

/** Options for the scene cache ({@link openSceneCache}, `serveScene({ cache })`). */
export interface SceneCacheOptions {
  /**
   * Keep the cache under about this many bytes (as stored): after each write the least recently
   * used entries are evicted until it fits, and a result bigger than the cap is not kept at all.
   * Unset, it grows until the browser's quota stops it (a failed write keeps nothing).
   *
   * Size it by measuring, as for the model cache: load the heaviest scenes with no cap, read
   * {@link SceneCacheControls.usage}, and add headroom (the examples measured 108-693 MB at 50-100
   * voxels per metre). Checked and warned about as {@link ModelCacheOptions.maxBytes} describes:
   * a value that is not a positive finite number throws; under 16 MiB, above the origin's quota,
   * or smaller than an entry warns once per cache.
   */
  maxBytes?: number;
  /**
   * Deflate what is stored (default false). Measured on nightwood at 100 vox/m (desktop Chrome):
   * its twelve encodings and one bake are 528 MB as they are and about 6-7 times smaller deflated,
   * but deflating them takes about 14 s of the worker's time after a first visit (35-90 MB/s, and
   * only while the worker is not baking), and inflating adds about 0.8 s to every warm visit,
   * where reading them as they are takes about 0.2 s. So it is for storage that is tight (and
   * then give `makeSceneWorker` a longer `closeTimeoutMs`, or the writes of a short visit are lost),
   * not for speed.
   */
  compress?: boolean;
}

/**
 * The scene worker's cache of encodings and bakes, from {@link openSceneCache} or
 * {@link makeSceneCache}. Storage errors are swallowed: a failed `get` is a miss, a failed `put`
 * keeps nothing. Every `put` copies what it stores before its first await, so the caller may
 * transfer the result's buffers straight after calling.
 */
export interface SceneCache {
  /**
   * The encoding stored under an identity digest, as fresh arrays that each own their buffer,
   * with its placement digest; or undefined. A hit marks the entry used.
   */
  getEncoded(digest: string): Promise<{ encoded: EncodedModel; placement: string } | undefined>;
  /**
   * Store an encoding under an identity digest. Returns its placement digest (a hash of what the
   * placement bake reads of it, computed at once) and a promise that settles once the write has
   * committed or failed.
   */
  putEncoded(digest: string, encoded: EncodedModel): { placement: string; written: Promise<void> };
  /**
   * The bake stored under a bake digest, as fresh arrays; or undefined. It is stored normalised
   * (`normalizePlacement`): bind it to the current input (`bindPlacement`) before applying it.
   */
  getBake(digest: string): Promise<PlacementBake | undefined>;
  /** Store a bake under a bake digest. Resolves once the write has committed or failed. */
  putBake(digest: string, bake: PlacementBake): Promise<void>;
}

// --- digests ------------------------------------------------------------------------------------

/**
 * The digest an encoding is stored under: the source's identity (a host's key for its voxels and
 * parts, or {@link sourceDigest}), plus what the key may not cover (the part boxes the source
 * gives, its joints) and the renderer's encoding version.
 * @internal
 */
export function encodedDigest(identity: string, partBoxes?: Int32Array, joints?: unknown, version: number = ENCODED_MODEL_VERSION): string {
  const h = new Hasher().str("encoded").num(version).str(identity);
  if (partBoxes) h.num(partBoxes.length).add(partBoxes);
  else h.num(-1);
  return h.str(joints === undefined ? "" : JSON.stringify(joints)).digest();
}

/**
 * A hash of a model source's bytes (size, dense data or sparse bricks in map order, parts), for
 * hosts that give no identity key. About 30 ms per 100 MB.
 * @internal
 */
export function sourceDigest(src: { size: { x: number; y: number; z: number }; data?: Uint8Array; sparse?: { bricks: Map<number, Uint8Array> }; parts?: Uint8Array }): string {
  const h = new Hasher().str("source").num(src.size.x, src.size.y, src.size.z);
  if (src.sparse) {
    h.num(src.sparse.bricks.size);
    const k = new Uint32Array(1);
    for (const [key, b] of src.sparse.bricks) {
      k[0] = key;
      h.add(k).add(b);
    }
  } else if (src.data) h.num(-1, src.data.length).add(src.data);
  if (src.parts) h.num(-2, src.parts.length).add(src.parts);
  return h.digest();
}

/** What the placement bake reads about a model, hashed: size, sub-cells, part boxes, joints. @internal */
export function placementDigest(m: Pick<PlacementModel, "size" | "subs" | "partBoxes" | "joints">): string {
  const h = new Hasher().str("placement-model").num(m.size.x, m.size.y, m.size.z, m.subs.length).add(m.subs);
  if (m.partBoxes) h.num(m.partBoxes.length).add(m.partBoxes);
  else h.num(-1);
  return h.str(m.joints ? JSON.stringify(m.joints) : "").digest();
}

// --- records ------------------------------------------------------------------------------------

type ArrayKind = "u32" | "i32" | "f64";
interface Section { name: string; offset: number; bytes: number; kind: ArrayKind }
const CTORS = { u32: Uint32Array, i32: Int32Array, f64: Float64Array } as const;
const kindOf = (a: Uint32Array | Int32Array | Float64Array): ArrayKind => (a instanceof Float64Array ? "f64" : a instanceof Int32Array ? "i32" : "u32");

/** The arrays as one Blob (a copy, made now) and where each lies in it. */
function packArrays(arrays: Record<string, Uint32Array | Int32Array | Float64Array | undefined>): { sections: Section[]; blob: Blob } {
  const sections: Section[] = [];
  const parts: Uint8Array[] = [];
  let offset = 0;
  for (const [name, a] of Object.entries(arrays)) {
    if (!a) continue;
    sections.push({ name, offset, bytes: a.byteLength, kind: kindOf(a) });
    parts.push(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
    offset += a.byteLength;
  }
  return { sections, blob: new Blob(parts as BlobPart[]) };
}

/** Each section as a fresh array owning its buffer. */
function unpackArrays(sections: Section[], buf: ArrayBuffer): Record<string, Uint32Array<ArrayBuffer> | Int32Array<ArrayBuffer> | Float64Array<ArrayBuffer>> {
  const out: Record<string, Uint32Array<ArrayBuffer> | Int32Array<ArrayBuffer> | Float64Array<ArrayBuffer>> = {};
  for (const s of sections) {
    if (s.offset + s.bytes > buf.byteLength) throw new Error("scene cache: truncated record");
    out[s.name] = new CTORS[s.kind](buf.slice(s.offset, s.offset + s.bytes));
  }
  return out;
}

const ENCODED = "encoded";
const PLACEMENT = "placement";
/** The layout of this module's records; bump it when they change. */
const RECORD = 1;

/**
 * The scene cache on any {@link CacheStore}: keys are prefixed with `salt`, `maxBytes` evicts by
 * last use after each write. {@link openSceneCache} is this on IndexedDB.
 *
 * @param now - The clock for `created` / `lastUsed` (default `Date.now`); tests pass their own.
 */
export function makeSceneCache(store: CacheStore, salt: string, opts: SceneCacheOptions = {}, now: () => number = Date.now): SceneCache {
  const prefix = `${salt}|`;
  const cap = checkCacheCap(opts.maxBytes, "scene cache");
  const tooBig = watchCacheCap(cap, "scene cache");
  const compress = !!opts.compress;
  const encKey = (d: string) => `${prefix}${ENCODED}|v${ENCODED_MODEL_VERSION}|${d}`;
  const bakeKey = (d: string) => `${prefix}${PLACEMENT}|v${PLACEMENT_BAKE_VERSION}|r${RECORD}|${d}`;

  async function read(key: string): Promise<{ head: Record<string, unknown>; buf: ArrayBuffer } | undefined> {
    const rec = await store.get(key, now());
    if (!rec || rec.head.record !== RECORD) return undefined;
    const buf = rec.head.deflated ? (await inflate(rec.body)).buffer : await rec.body.arrayBuffer();
    return { head: rec.head, buf };
  }
  async function write(key: string, kind: SceneCacheKind, head: Record<string, unknown>, blob: Blob): Promise<void> {
    try {
      const body = compress ? await deflate(blob) : blob;
      const full = { ...head, record: RECORD, deflated: compress };
      const size = body.size + JSON.stringify(full).length;
      if (cap !== undefined && size > cap) return tooBig(size);
      const t = now();
      const entry: ModelCacheEntry = { key, salt, generator: kind, bytes: size, created: t, lastUsed: t };
      await store.put(key, { head: full, body }, entry);
      if (cap !== undefined) await store.sweep((all) => planEviction(all, cap));
    } catch {
      // Storage full or unavailable: the result still works, it just is not kept.
    }
  }

  return {
    async getEncoded(digest) {
      try {
        const r = await read(encKey(digest));
        if (!r) return undefined;
        const h = r.head as { version: number; size: EncodedModel["size"]; joints?: EncodedModel["joints"]; sections: Section[]; placement: string };
        if (h.version !== ENCODED_MODEL_VERSION) return undefined;
        const a = unpackArrays(h.sections, r.buf) as Record<string, Uint32Array<ArrayBuffer>>;
        const encoded: EncodedModel = {
          version: h.version,
          size: { ...h.size },
          top: a.top,
          blocks: a.blocks,
          voxels4: a.voxels4,
          palettes: a.palettes,
          voxels8: a.voxels8,
          subs: a.subs as unknown as Int32Array<ArrayBuffer>,
        };
        if (a.partTop) encoded.partTop = a.partTop;
        if (a.partBoxes) encoded.partBoxes = a.partBoxes as unknown as Int32Array;
        if (h.joints) encoded.joints = h.joints;
        return { encoded, placement: h.placement };
      } catch {
        return undefined;
      }
    },
    putEncoded(digest, e) {
      const placement = placementDigest({ size: e.size, subs: e.subs, partBoxes: e.partBoxes, joints: e.joints });
      const { sections, blob } = packArrays({ top: e.top, partTop: e.partTop, blocks: e.blocks, voxels4: e.voxels4, palettes: e.palettes, voxels8: e.voxels8, subs: e.subs, partBoxes: e.partBoxes });
      const head: Record<string, unknown> = { version: e.version, size: { ...e.size }, sections, placement };
      if (e.joints) head.joints = e.joints;
      return { placement, written: write(encKey(digest), ENCODED, head, blob) };
    },
    async getBake(digest) {
      try {
        const r = await read(bakeKey(digest));
        if (!r) return undefined;
        const h = r.head as { grid: PlacementBake["grid"]; count: number; dropped: number; stats: PlacementBake["stats"]; sections: Section[] };
        const a = unpackArrays(h.sections, r.buf) as Record<string, Uint32Array<ArrayBuffer>>;
        return {
          grid: { brickDim: [...h.grid.brickDim], topDim: [...h.grid.topDim], gridMax: h.grid.gridMax },
          models: [],
          count: h.count,
          inst: a.inst,
          boxes: a.boxes as unknown as Float64Array<ArrayBuffer>,
          parts: a.parts,
          cells: a.cells,
          list: a.list,
          subs: a.subs,
          subCells: a.subCells,
          dropped: h.dropped,
          stats: { ...h.stats },
        };
      } catch {
        return undefined;
      }
    },
    putBake(digest, b) {
      const { sections, blob } = packArrays({ inst: b.inst, boxes: b.boxes, parts: b.parts, cells: b.cells, list: b.list, subs: b.subs, subCells: b.subCells });
      const head = { grid: b.grid, count: b.count, dropped: b.dropped, stats: b.stats, sections };
      return write(bakeKey(digest), PLACEMENT, head, blob);
    },
  };
}

/**
 * {@link openSceneCache} on a store of your own: deletes the entries of every other salt, then
 * returns {@link makeSceneCache} on it.
 */
export async function openSceneCacheOn(store: CacheStore, salt: string, opts: SceneCacheOptions = {}): Promise<SceneCache> {
  try {
    await store.sweep((all) => all.filter((e) => e.salt !== salt).map((e) => e.key));
  } catch {
    // Not fatal: the stale entries are only unreachable.
  }
  return makeSceneCache(store, salt, opts);
}

/**
 * The scene cache in IndexedDB database `name`, or null where there is none (bun, some private
 * windows, a database an older build in another tab holds open). Used by `serveScene` in the
 * worker; entries stored under any other salt are deleted when it opens, so a new build frees
 * the old build's results.
 *
 * @param name - The database name (the same one given to `serveScene({ cache })`).
 * @param salt - Prefixed to every key; the worker passes its script URL.
 * @param opts - A size cap, and compression.
 */
export async function openSceneCache(name: string, salt: string, opts: SceneCacheOptions = {}): Promise<SceneCache | null> {
  if (opts.compress && typeof CompressionStream === "undefined") return null;
  const db = await openDb(name);
  if (!db) return null;
  return openSceneCacheOn(idbStore(db), salt, opts);
}

const toScene = (e: ModelCacheEntry): SceneCacheEntry => ({ key: e.key, salt: e.salt, kind: e.generator as SceneCacheKind, bytes: e.bytes, created: e.created, lastUsed: e.lastUsed });
const sceneMatches = (e: ModelCacheEntry, f: SceneCacheFilter = {}) => (f.kind === undefined || e.generator === f.kind) && (f.salt === undefined || e.salt === f.salt);

/** {@link SceneCacheControls} on any {@link CacheStore}. {@link openSceneCacheControls} is this on IndexedDB. */
export function makeSceneCacheControls(store: CacheStore): SceneCacheControls {
  return {
    async entries(filter) {
      return (await store.list())
        .filter((e) => sceneMatches(e, filter))
        .sort((a, b) => b.lastUsed - a.lastUsed)
        .map(toScene);
    },
    async usage(filter) {
      const list = (await store.list()).filter((e) => sceneMatches(e, filter));
      return { entries: list.length, bytes: list.reduce((n, e) => n + e.bytes, 0) };
    },
    clear: (filter) => store.sweep((all) => all.filter((e) => sceneMatches(e, filter)).map((e) => e.key)),
    trim: (maxBytes) => store.sweep((all) => planEviction(all, Math.max(0, maxBytes))),
    close: () => store.close(),
  };
}

/**
 * Open controls for the scene cache in IndexedDB database `name` (the name given to
 * `serveScene({ cache })`), or null where there is no IndexedDB. Works from the main thread while
 * the worker uses the cache. As with `openModelCacheControls`, nothing is cleared or trimmed
 * unless the app asks (apart from the worker dropping an older build's entries, and a `maxBytes`
 * cap if the worker was given one).
 *
 * @example
 * ```ts
 * const scene = await openSceneCacheControls("voxolith-scene");
 * if (scene) {
 *   const { bytes } = await scene.usage({ kind: "placement" });
 *   console.log(`bakes: ${(bytes / 1e6).toFixed(1)} MB`);
 *   await scene.clear({ kind: "placement" });
 *   scene.close();
 * }
 * ```
 */
export async function openSceneCacheControls(name: string): Promise<SceneCacheControls | null> {
  const db = await openDb(name);
  return db ? makeSceneCacheControls(idbStore(db)) : null;
}
