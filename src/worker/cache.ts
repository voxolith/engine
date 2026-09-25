// A cache of generated models in the browser's storage, for the worker pool.
//
// Generation is deterministic, so a model is a pure function of its generator
// (id and version), parameters, seed and context: generate it once, keep it,
// and the next visit loads it instead. Refined models at 100 voxels per metre
// take seconds each on a phone, and a valley needs dozens.
//
// Entries are packed (a sparse model's bricks concatenated, typed arrays as
// bytes) and deflated, then kept in IndexedDB under a key that also carries a
// `salt` — the worker passes its own script URL, which a production build
// hashes, so new generator code never reads a model the old code made.
// Entries from any other salt are deleted when the cache opens.

import type { Entity, EntityModel } from "../entity";

export interface ModelCache {
  get(key: string): Promise<Entity | undefined>;
  put(key: string, entity: Entity): Promise<void>;
}

const STORE = "models";

/** A cache in IndexedDB database `name`, or null where there is none (bun, a private window). */
export async function openModelCache(name: string, salt: string): Promise<ModelCache | null> {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb || typeof CompressionStream === "undefined") return null;
  let db: IDBDatabase;
  try {
    db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = idb.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
  const prefix = `${salt}|`;
  // Drop what older builds left.
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    const cur = tx.objectStore(STORE).openKeyCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return;
      if (!String(c.key).startsWith(prefix)) tx.objectStore(STORE).delete(c.key);
      c.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
  const req = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  return {
    async get(key) {
      try {
        const rec = await req(db.transaction(STORE, "readonly").objectStore(STORE).get(prefix + key)) as { head: Record<string, unknown>; body: Blob } | undefined;
        if (!rec) return undefined;
        const bytes = new Uint8Array(await new Response(rec.body.stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
        return unpackEntity(rec.head, bytes);
      } catch {
        return undefined;
      }
    },
    async put(key, entity) {
      try {
        const { head, bytes } = packEntity(entity);
        const body = await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"))).blob();
        await req(db.transaction(STORE, "readwrite").objectStore(STORE).put({ head, body }, prefix + key));
      } catch {
        // Storage full or unavailable: the model still works, it just is not kept.
      }
    },
  };
}

interface Section { name: string; offset: number; length: number; kind: "u8" | "u32" }

/** An entity as a small header plus one byte buffer holding its arrays. */
export function packEntity(entity: Entity): { head: Record<string, unknown>; bytes: Uint8Array<ArrayBuffer> } {
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

export function unpackEntity(head: Record<string, unknown>, bytes: Uint8Array): Entity {
  const sections = head.sections as Section[];
  const view = (s: Section) => (s.kind === "u32" ? new Uint32Array(bytes.buffer, bytes.byteOffset + s.offset, s.length) : new Uint8Array(bytes.buffer, bytes.byteOffset + s.offset, s.length));
  const get = (n: string) => sections.find((s) => s.name === n);
  const e = head.entity as Entity;
  const model = { ...e.model } as EntityModel;
  const keys = get("keys"), bricks = get("bricks"), data = get("data"), bones = get("bones");
  if (keys && bricks) {
    const k = view(keys) as Uint32Array, b = view(bricks) as Uint8Array;
    const map = new Map<number, Uint8Array>();
    // Each brick its own buffer, as a generator would make it (and as the pool transfers them).
    for (let i = 0; i < k.length; i++) map.set(k[i], b.slice(i * 512, i * 512 + 512));
    model.sparse = { size: { ...model.size }, bricks: map };
    model.data = new Uint8Array(0);
  } else if (data) model.data = (view(data) as Uint8Array).slice();
  if (bones) model.bones = (view(bones) as Uint8Array).slice();
  return { ...e, model };
}
