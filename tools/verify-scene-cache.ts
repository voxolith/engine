// Headless checks for the scene worker's cache.  bun tools/verify-scene-cache.ts
//
// The real `serveScene` with a cache on the in-memory store, behind the fake channel that
// structured-clones every message with its transfer list (tools/scene-fakes.ts), running the real
// `encodeModel` and `bakePlacement`; the instance layer against the fake renderer. Covered: a
// cached encode equals a fresh one byte for byte (dense, sparse, with parts and shared boxes) and
// sends none of the source; a warm visit's commitAsync applies a cached bake without baking, and
// equals the synchronous path; keys change with the model's identity, part boxes, bytes (hashKey),
// the instances, the models' placement data and the scale they are drawn at (the encoding is
// shared across scales, scale-1 bake keys unchanged), and a model that changes only colour keeps its
// bake; the renderer's encoding version, the record layout and the salt invalidate; maxBytes
// eviction and the controls by kind; the load tracker's cached counts, supersede and abort; the
// close handshake and `cache: false`. The hash itself: stable across chunkings, sensitive to bytes.
//
// What bun cannot run: IndexedDB (openSceneCache returns null here, which is checked); the
// warm-visit bench (`gpu-bench examples --load`) exercises it for real.

import { ENCODED_MODEL_VERSION, bakePlacement, encodeModel, type EncodedModel, type ModelSource } from "@voxolith/renderer/core";
import { makeInstanceLayer, type EntityPlacement, type InstanceLayer } from "../src/instances";
import { makeSceneWorker, type SceneRequest } from "../src/worker/scene";
import { memoryCacheStore, type CacheStore } from "../src/worker/cache";
import { encodedDigest, makeSceneCache, makeSceneCacheControls, openSceneCache, openSceneCacheControls, openSceneCacheOn, sourceDigest } from "../src/worker/scene-cache";
import { Hasher } from "../src/worker/hash";
import { LOAD_PHASES, makeLoadTracker } from "../src/load";
import type { EntityModel } from "../src/entity";
import { box, channel, dense, eq, fakeTarget, kinds, phase, sameBake, sameState, scene, settle, sparseBox, syncOf, units } from "./scene-fakes";

let failed = 0, checks = 0;
const ok = (c: boolean, m: string, d = "") => {
  checks++;
  if (c) console.log(`  ✓ ${m}`);
  else { failed++; console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); }
};

const ARRAYS = ["top", "partTop", "blocks", "voxels4", "palettes", "voxels8", "subs", "partBoxes"] as const;
function sameEncoding(a: EncodedModel, b: EncodedModel): string {
  if (a.version !== b.version || JSON.stringify(a.size) !== JSON.stringify(b.size)) return "version or size differs";
  for (const k of ARRAYS) if (!eq(a[k], b[k])) return `${k} differs`;
  if (JSON.stringify(a.joints) !== JSON.stringify(b.joints)) return "joints differ";
  for (const k of ARRAYS) {
    const v = a[k];
    if (v && (v.byteOffset !== 0 || v.byteLength !== v.buffer.byteLength)) return `${k} does not own its buffer`;
  }
  return "";
}

const tree = box(10, 24, 10, 0.3, 3), rock = box(14, 8, 12, 0.6, 7), bush = box(6, 6, 6, 0.8, 11);
const oak = sparseBox(40, 33, 36, 0.05, 5);
const names = new Map<EntityModel, string>([[tree, "gen|tree|1"], [rock, "gen|rock|1"], [bush, "gen|bush|1"], [oak, "gen|oak|1"]]);
const modelKey = (m: EntityModel) => names.get(m);

/** A layer on a fresh fake renderer, with a scene worker on `store` (one "visit"). */
function visit(store: CacheStore, o: { load?: ReturnType<typeof makeLoadTracker>; hashModels?: boolean; keyed?: boolean } = {}) {
  const ch = channel({ cache: { store } });
  const worker = makeSceneWorker({ spawn: ch.spawn, chunkBricks: 7 });
  const t = fakeTarget();
  const layer = makeInstanceLayer(t, { load: o.load, worker, modelKey: o.keyed === false ? undefined : modelKey, hashModels: o.hashModels });
  return { ch, worker, t, layer };
}
async function commit(layer: InstanceLayer, set: EntityPlacement[]) {
  layer.setStatic(set);
  await layer.commitAsync();
}

console.log("hash:");
{
  const bytes = dense(37, 11, 5, 0.5, 9);
  const whole = new Hasher().add(bytes).digest();
  const pieces = new Hasher().add(bytes.subarray(0, 5)).add(bytes.subarray(5, 1001)).add(bytes.subarray(1001, 1002)).add(bytes.subarray(1002)).digest();
  const flipped = bytes.slice();
  flipped[1234] ^= 1;
  ok(whole === pieces && whole.length === 16, "a digest does not depend on how the bytes were fed");
  ok(new Hasher().add(flipped).digest() !== whole && new Hasher().add(bytes.subarray(1)).digest() !== whole, "  one flipped bit or one byte less changes it");
  ok(new Hasher().str("ab").str("c").digest() !== new Hasher().str("a").str("bc").digest(), "  strings are length-prefixed, so concatenations differ");
  const big = new Uint8Array(100 << 20);
  for (let i = 0; i < big.length; i += 4093) big[i] = i & 255;
  const times = [0, 1, 2].map(() => {
    const t0 = performance.now();
    new Hasher().add(big).digest();
    return performance.now() - t0;
  });
  console.log(`    (${times.map((t) => t.toFixed(0)).join(", ")} ms)`);
  const ms = Math.min(...times);
  ok(ms < 1000, `100 MB hashes in ${ms.toFixed(0)} ms`);
  const sparse = oak.sparse!;
  ok(sourceDigest({ size: oak.size, sparse }) === sourceDigest({ size: oak.size, sparse: { bricks: new Map(sparse.bricks) } }) && sourceDigest({ size: oak.size, sparse }) !== sourceDigest({ size: tree.size, data: tree.data }), "sourceDigest follows the bytes, not the objects");
}

console.log("cached encode = fresh encode:");
{
  const store = memoryCacheStore();
  const size = { x: 8, y: 12, z: 6 };
  const data = dense(8, 12, 6, 0.7, 4).map((v) => (v ? 1 + (v % 3) : 0));
  const parts = data.map((_, i) => (Math.floor(i / 48) % 12 < 6 ? 0 : 1));
  const joints = [{ parent: -1, at: [4, 0, 3] as const }, { parent: 0, at: [4, 6, 3] as const }];
  const boxes = new Int32Array([0, 0, 0, 7, 5, 5, 0, 6, 0, 7, 11, 5]);
  const sources: [string, ModelSource][] = [
    ["dense", { size: tree.size, data: tree.data }],
    ["sparse", { size: oak.size, sparse: oak.sparse }],
    ["with parts and shared boxes", { size, data, parts, joints, partBoxes: boxes }],
  ];
  const ch1 = channel({ cache: { store } });
  const w1 = makeSceneWorker({ spawn: ch1.spawn, chunkBricks: 7 });
  const first = await Promise.all(sources.map(([n, src]) => w1.encode(src, { cacheKey: `k:${n}` })));
  ok(first.every((e) => !w1.fromCache(e)) && ch1.state.encodes === 3, "a first visit encodes (lookups miss)");
  await w1.destroy();
  ok(ch1.state.terminated && (await store.list()).length === 3, "  destroy() waits for the three writes, then terminates");

  const ch2 = channel({ cache: { store } });
  const w2 = makeSceneWorker({ spawn: ch2.spawn, chunkBricks: 7 });
  const second = await Promise.all(sources.map(([n, src]) => w2.encode(src, { cacheKey: `k:${n}` })));
  ok(second.every((e) => w2.fromCache(e)) && ch2.state.encodes === 0 && ch2.state.cachedEncodes === 3, "the next visit is served from the cache");
  ok(kinds(ch2.sent, "chunk").length === 0 && kinds(ch2.sent, "encode").length === 0 && kinds(ch2.sent, "lookup").length === 3, "  sending none of the sources: one lookup each");
  sources.forEach(([n, src], i) => {
    const d = sameEncoding(second[i], encodeModel(src));
    ok(d === "", `  ${n}: byte for byte what encodeModel gives, each array owning its buffer`, d);
  });
  ok(second[2].partBoxes === boxes, "  a source's shared boxes object is put back on the cached result");
  await w2.destroy();

  // Without a cache, a key costs one round trip.
  const ch3 = channel();
  const w3 = makeSceneWorker({ spawn: ch3.spawn });
  const e3 = await w3.encode({ size: rock.size, data: rock.data }, { cacheKey: "k:rock" });
  ok(!w3.fromCache(e3) && kinds(ch3.sent, "lookup").length === 1 && kinds(ch3.sent, "encode").length === 1 && sameEncoding(e3, encodeModel({ size: rock.size, data: rock.data })) === "", "a worker without a cache misses the lookup and encodes as usual");
  await w3.destroy();
}

console.log("cached bake = fresh bake:");
{
  const store = memoryCacheStore();
  const set = scene([tree, oak, rock, bush], 300, 5);
  const a = visit(store);
  await commit(a.layer, set);
  ok(a.ch.state.bakes === 1 && a.ch.state.cachedBakes === 0, "a first visit bakes");
  ok(sameState(syncOf(set), a.t) === "", "  and equals the synchronous path");
  await a.worker.destroy();
  const b = visit(store);
  await commit(b.layer, set);
  ok(b.ch.state.bakes === 0 && b.ch.state.cachedBakes === 1 && b.ch.state.encodes === 0 && b.ch.state.cachedEncodes === 4, "a warm visit's commitAsync encodes nothing and bakes nothing: all four encodings and the bake come from the cache");
  ok(b.ch.state.progress === 0, "  no progress messages: nothing ran");
  ok(sameState(syncOf(set), b.t) === "", "  the pool, every model and the applied bake equal the synchronous path's", sameState(syncOf(set), b.t));
  ok(b.t.staticBake!.models.join() !== a.t.staticBake!.models.join() && b.t.staticBake!.models.every((k, id) => !k || b.t.placementModel(id)!.key === k), "  the cached bake names this visit's model keys (so applyPlacement accepts it)");
  // The same models registered, another set: a new bake, and it is right.
  const other = scene([tree, rock], 50, 9);
  await commit(b.layer, other);
  ok(b.ch.state.bakes === 1 && b.t.staticBake!.count === 50, "another static set over the same models is baked afresh, and applied");
  await b.worker.destroy();
  // The renderer numbers models by free slot, so another visit may give them other ids (valley
  // does: models come and go around them). The digest names models by content, and a hit is
  // rebound to this visit's ids.
  const c = visit(store);
  const spare = { size: { x: 3, y: 3, z: 3 }, data: dense(3, 3, 3, 0.9, 1) };
  c.t.addModel(spare);
  c.t.addModel(spare);
  c.t.removeModel(0);
  await commit(c.layer, set);
  const ref = fakeTarget();
  ref.addModel(spare);
  ref.addModel(spare);
  ref.removeModel(0);
  const rl = makeInstanceLayer(ref);
  rl.setStatic(set);
  rl.commit();
  ok(c.ch.state.cachedBakes === 1 && c.ch.state.bakes === 0, "models under other ids this visit: the bake still hits");
  ok(sameState(ref, c.t) === "" && [tree, oak, rock, bush].some((m) => c.layer.models.id(m) !== a.layer.models.id(m)), "  and is rebound to the new ids: equal to the synchronous path with the same ids", sameState(ref, c.t));
  await c.worker.destroy();
  // A stored bake that no longer fits the input (here: its count tampered with) is a miss.
  for (const e of await store.list()) {
    if (e.generator !== "placement") continue;
    const rec = (await store.get(e.key))!;
    await store.put(e.key, { ...rec, head: { ...rec.head, count: (rec.head.count as number) + 1 } }, e);
  }
  const d = visit(store);
  await commit(d.layer, set);
  ok(d.ch.state.cachedBakes === 0 && d.ch.state.bakes === 1 && sameState(syncOf(set), d.t) === "", "a stored bake bindPlacement rejects counts as a miss: baked afresh, and right");
  await d.worker.destroy();
}

console.log("keys follow what the result depends on:");
{
  const store = memoryCacheStore();
  const ch = channel({ cache: { store } });
  const w = makeSceneWorker({ spawn: ch.spawn });
  const src = { size: rock.size, data: rock.data };
  await w.encode(src, { cacheKey: "id:rock" });
  await settle();
  ok(w.fromCache(await w.encode(src, { cacheKey: "id:rock" })), "the same identity hits");
  ok(!w.fromCache(await w.encode(src, { cacheKey: "id:rock2" })), "  another identity misses (a changed model has a new key)");
  const boxes = new Int32Array([0, 0, 0, 13, 7, 11]);
  const withBoxes = { ...src, parts: new Uint8Array(rock.data.length), partBoxes: boxes };
  await w.encode(withBoxes, { cacheKey: "id:rock" });
  ok(ch.state.encodes === 3, "  the same identity with other part boxes misses too", `${ch.state.encodes} encodes`);
  // hashKey: by the bytes.
  const h1 = await w.encode({ size: tree.size, data: tree.data }, { hashKey: true });
  await settle();
  const h2 = await w.encode({ size: tree.size, data: tree.data.slice() }, { hashKey: true });
  const edited = tree.data.slice();
  edited[5] = edited[5] ? 0 : 3;
  const h3 = await w.encode({ size: tree.size, data: edited }, { hashKey: true });
  ok(!w.fromCache(h1) && w.fromCache(h2) && !w.fromCache(h3), "hashKey: the same bytes hit, one changed voxel misses");
  ok(sameEncoding(h2, encodeModel({ size: tree.size, data: tree.data })) === "", "  and the hit equals a fresh encode");
  await w.encode({ size: bush.size, data: bush.data });
  await settle();
  ok(!w.fromCache(await w.encode({ size: bush.size, data: bush.data })), "no key and no hashKey: never cached");
  ok(encodedDigest("x") !== encodedDigest("x", undefined, undefined, ENCODED_MODEL_VERSION + 1) && encodedDigest("x") !== encodedDigest("x", new Int32Array(6)), "the encoding digest carries the renderer's encoding version and the part boxes");
  await w.destroy();

  // Bakes: instances and the models' placement data.
  const set = scene([tree, rock], 80, 3);
  const a = visit(store);
  await commit(a.layer, set);
  await a.worker.destroy();
  const moved = set.map((p, i) => (i === 7 ? { ...p, x: p.x + 0.5 } : p));
  const b = visit(store);
  await commit(b.layer, moved);
  ok(b.ch.state.bakes === 1 && sameState(syncOf(moved), b.t) === "", "one instance moved half a voxel: baked afresh, and right");
  await b.worker.destroy();
  // A model whose voxels changed, under its new identity: new encoding, new sub-cells, new bake.
  const rock2 = box(14, 8, 12, 0.05, 8); // sparse enough that its occupied sub-cells differ
  names.set(rock2, "gen|rock|2");
  const swapped = set.map((p) => (p.model === rock ? { ...p, model: rock2 } : p));
  const c = visit(store);
  await commit(c.layer, swapped);
  ok(c.ch.state.encodes === 1 && c.ch.state.bakes === 1 && sameState(syncOf(swapped), c.t) === "", "a changed model (new key): encoded and baked afresh, and right", `${c.ch.state.encodes} encodes, ${c.ch.state.bakes} bakes, ${sameState(syncOf(swapped), c.t)}`);
  await c.worker.destroy();
  // Only its colours changed (same occupancy): the bake does not depend on them, so it is reused.
  const recoloured = { ...rock, data: rock.data.map((v) => (v ? 1 + ((v + 5) % 20) : 0)) } as EntityModel;
  names.set(recoloured, "gen|rock|recoloured");
  const tinted = set.map((p) => (p.model === rock ? { ...p, model: recoloured } : p));
  const d = visit(store);
  await commit(d.layer, tinted);
  ok(d.ch.state.encodes === 1 && d.ch.state.bakes === 0 && d.ch.state.cachedBakes === 1, "a model changed in colour only: encoded afresh, but its bake is reused (it reads occupancy only)");
  ok(sameState(syncOf(tinted), d.t) === "", "  and the result equals the synchronous path's");
  await d.worker.destroy();
  // cache: false on a bake.
  const e = visit(store);
  e.layer.setStatic(set);
  await e.layer.commitAsync();
  const before = (await store.list()).length;
  const again = await e.worker.bake(e.t.placementInput(set.map((p) => ({ model: e.layer.models.id(p.model), x: p.x, y: p.y, z: p.z, yaw: p.yaw, mirror: p.mirror, base: p.base, anchor: p.model.anchor }))), { cache: false });
  ok(!e.worker.fromCache(again) && (await store.list()).length === before, "bake(input, { cache: false }) neither reads nor writes");
  await e.worker.destroy();
}

console.log("a model's scale is part of the bake key:");
{
  const store = memoryCacheStore();
  const bakeKeys = async () => (await store.list()).filter((e) => e.generator === "placement").map((e) => e.key);
  const encodedKeys = async () => (await store.list()).filter((e) => e.generator !== "placement").map((e) => e.key);
  /**
   * One visit: the rock encoded by identity (kept), added at `scale`, and baked. The instances are
   * the same at every scale (anchor included, a point in world voxels), so only the scale differs.
   */
  async function at(scale: number | undefined, keysScale: number | undefined = scale) {
    const ch = channel({ cache: { store } });
    const w = makeSceneWorker({ spawn: ch.spawn });
    const t = fakeTarget();
    const e = await w.encode({ size: rock.size, data: rock.data }, { cacheKey: "id:rock", keepPlacement: true });
    const id = t.addEncodedModel(e, scale === undefined ? undefined : { scale });
    const pm = t.placementModel(id)!;
    w.registerEncoded(e, { key: pm.key, poseKey: pm.poseKey, scale: keysScale });
    const list = Array.from({ length: 12 }, (_, i) => ({ model: id, x: 50 + i * 13, y: 20, z: 60 + (i % 4) * 30, yaw: i * 0.7, mirror: i % 3 === 0, base: 256, anchor: [21, 0, 18] as [number, number, number] }));
    const input = t.placementInput(list);
    const baked = await w.bake(input);
    const sync = bakePlacement(input, (key) => (key === pm.key ? pm : undefined));
    await settle();
    await w.destroy();
    return { ch, cached: w.fromCache(baked), right: sameBake(sync, baked) };
  }
  const one = await at(undefined);
  const b1 = await bakeKeys(), e1 = await encodedKeys();
  const three = await at(3);
  const b3 = await bakeKeys(), e3 = await encodedKeys();
  ok(!one.cached && !three.cached && b1.length === 1 && b3.length === 2, "the same model at scale 1 and at k = 3 (same instances): two bakes under two keys", `${b1.length} then ${b3.length} bake keys`);
  ok(one.right === "" && three.right === "", "  each equal to the synchronous bake", one.right || three.right);
  ok(three.ch.state.cachedEncodes === 1 && three.ch.state.encodes === 0 && e3.join() === e1.join(), "  the encoding is one entry, shared (it does not depend on the scale)");
  const again = await at(3);
  ok(again.cached && again.right === "", "a warm visit at k = 3 hits its own bake, and it is right", again.right);
  const explicit = await at(1);
  ok(explicit.cached && explicit.right === "" && (await bakeKeys()).length === 2, "scale 1 given explicitly keys as no scale: it hits the scale-1 bake (scale-1 keys are unchanged)");
}

console.log("versions and salts invalidate:");
{
  const store = memoryCacheStore();
  const cache = makeSceneCache(store, "S");
  const src = { size: rock.size, data: rock.data };
  const e = encodeModel(src);
  await cache.putEncoded("d1", e).written;
  ok(!!(await cache.getEncoded("d1")), "an encoding round-trips");
  const [entry] = await store.list();
  ok(entry.key === `S|encoded|v${ENCODED_MODEL_VERSION}|d1` && entry.generator === "encoded", "  its key carries the salt, the kind and the renderer's encoding version", entry.key);
  // What an older renderer stored: another version in the record (and in the key, which a newer
  // renderer never asks for).
  const rec = (await store.get(entry.key))!;
  await store.put(entry.key, { ...rec, head: { ...rec.head, version: ENCODED_MODEL_VERSION + 1 } }, entry);
  ok((await cache.getEncoded("d1")) === undefined, "  a record of another encoding version is a miss");
  await store.put(entry.key, { ...rec, head: { ...rec.head, record: 99 } }, entry);
  ok((await cache.getEncoded("d1")) === undefined, "  so is one of another record layout");
  await store.put(entry.key, rec, entry);
  ok(!!(await cache.getEncoded("d1")) && (await makeSceneCache(store, "T").getEncoded("d1")) === undefined, "another salt (a new build of the worker) does not see it");
  await openSceneCacheOn(store, "T");
  ok((await store.list()).length === 0, "  and opening under the new salt deletes the old build's entries");
  ok((await openSceneCache("x", "s")) === null && (await openSceneCacheControls("x")) === null, "without IndexedDB (bun) both openers return null");
}

console.log("eviction and controls:");
{
  let clock = 1000;
  const now = () => clock++;
  const store = memoryCacheStore();
  const e = encodeModel({ size: rock.size, data: rock.data });
  const probe = makeSceneCache(store, "S", {}, now);
  await probe.putEncoded("size", e).written;
  const one = (await store.list())[0].bytes;
  await makeSceneCacheControls(store).clear();
  const cache = makeSceneCache(store, "S", { maxBytes: one * 3 + 10 }, now);
  for (const d of ["a", "b", "c"]) await cache.putEncoded(d, e).written;
  await cache.getEncoded("a"); // a is now the most recently used
  await cache.putEncoded("d", e).written;
  const controls = makeSceneCacheControls(store);
  const keys = (await controls.entries()).map((x) => x.key.split("|").at(-1));
  ok(keys.length === 3 && !keys.includes("b") && keys.includes("a") && keys[0] === "d", "maxBytes evicts the least recently used", keys.join());
  const huge = makeSceneCache(store, "S", { maxBytes: one - 1 }, now);
  await huge.putEncoded("e", e).written;
  ok((await controls.usage()).entries === 3, "  a result bigger than the cap is not kept, and evicts nothing");
  // A bake beside them.
  const set = scene([tree, rock], 20, 1);
  const t = fakeTarget();
  const l = makeInstanceLayer(t);
  l.setStatic(set);
  l.commit();
  await makeSceneCache(store, "S", {}, now).putBake("p", t.staticBake!);
  const u = await controls.usage(), ue = await controls.usage({ kind: "encoded" }), up = await controls.usage({ kind: "placement" });
  ok(u.entries === 4 && ue.entries === 3 && up.entries === 1 && u.bytes === ue.bytes + up.bytes, "usage() by kind", JSON.stringify({ u, ue, up }));
  const [first] = await controls.entries({ kind: "placement" });
  ok(first.kind === "placement" && first.salt === "S" && first.bytes > 0 && first.created > 0, "  entries() list kind, salt, bytes and times", JSON.stringify(first));
  const back = await makeSceneCache(store, "S").getBake("p");
  ok(!!back && ["inst", "boxes", "parts", "cells", "list", "subs", "subCells"].every((k) => eq(back[k as "inst"], t.staticBake![k as "inst"])) && back.count === t.staticBake!.count && back.dropped === t.staticBake!.dropped, "  a stored bake reads back word for word");
  ok((await controls.clear({ kind: "placement" })) === 1 && (await controls.usage()).entries === 3, "clear({ kind })");
  ok((await controls.trim(one * 2)) === 1 && (await controls.usage()).entries === 2, "trim(maxBytes) evicts the oldest until it fits");
  ok((await controls.clear()) === 2 && (await controls.usage()).bytes === 0, "clear() empties it");
  const compressed = makeSceneCache(store, "S", { compress: true }, now);
  await compressed.putEncoded("z", e).written;
  const z = await compressed.getEncoded("z");
  ok(!!z && sameEncoding(z.encoded, e) === "", "compress: true round-trips too");
  const broken: CacheStore = { ...memoryCacheStore(), put: async () => { throw new Error("quota"); }, get: async () => { throw new Error("gone"); } };
  const safe = makeSceneCache(broken, "S");
  let threw = false;
  try { await safe.putEncoded("k", e).written; await safe.putBake("k", t.staticBake!); ok((await safe.getEncoded("k")) === undefined && (await safe.getBake("k")) === undefined, "storage errors: a failed put keeps nothing, a failed get is a miss"); } catch { threw = true; }
  ok(!threw, "  and neither throws");
}

console.log("the load tracker:");
{
  const store = memoryCacheStore();
  const set = scene([tree, oak, rock, bush], 120, 4);
  const bricks = [tree, oak, rock, bush].reduce((n, m) => n + units(m), 0);
  const cold = makeLoadTracker();
  const a = visit(store, { load: cold });
  await commit(a.layer, set);
  await a.worker.destroy();
  const cu = phase(cold)!, cp = phase(cold, LOAD_PHASES.placement)!;
  ok(cu.cached === 0 && cp.cached === 0 && cu.done === cu.total && cp.done === cp.total, "a cold visit counts nothing as cached", JSON.stringify({ cu, cp }));
  const warm = makeLoadTracker();
  const b = visit(store, { load: warm });
  await commit(b.layer, set);
  const wu = phase(warm)!, wp = phase(warm, LOAD_PHASES.placement)!;
  ok(wu.cached === bricks && wu.done === bricks && wu.total === bricks && !wu.busy, "a warm visit: every model's bricks tick as cached, done === total at idle", JSON.stringify(wu));
  ok(wp.cached === 120 && wp.done === 120 && wp.total === 120 && !wp.busy, "  the cached bake ticks its placements as cached", JSON.stringify(wp));
  await b.worker.destroy();

  // Supersede and abort with cached results.
  const load = makeLoadTracker();
  const c = visit(store, { load });
  c.layer.setStatic(set);
  const p1 = c.layer.commitAsync();
  const small = scene([tree], 10, 2);
  c.layer.setStatic(small);
  const p2 = c.layer.commitAsync();
  await Promise.all([p1, p2]);
  const pp = phase(load, LOAD_PHASES.placement)!, pu = phase(load)!;
  ok(!pp.busy && pp.done === pp.total && pp.total === 10 && c.t.staticBake!.count === 10, "superseded: only the newer set's placements are counted", JSON.stringify(pp));
  ok(!pu.busy && pu.done === pu.total && pu.total === units(tree) && pu.cached === units(tree), "  and only its model's upload, cached", JSON.stringify(pu));
  const ctl = new AbortController();
  c.ch.state.hold = true;
  c.layer.setStatic(scene([rock, bush], 30, 3));
  const p3 = c.layer.commitAsync({ signal: ctl.signal });
  await settle(20);
  ctl.abort();
  const err = await p3.catch((x) => x);
  c.ch.release();
  await settle(40);
  const ap = phase(load, LOAD_PHASES.placement)!;
  ok(err?.name === "AbortError" && !ap.busy && ap.done === ap.total && ap.total === 10, "aborted: its bake leaves the placement phase", JSON.stringify(ap));
  await c.worker.destroy();

  // Unkeyed models with hashModels: cached by bytes on the next visit.
  const hstore = memoryCacheStore();
  const h1 = visit(hstore, { keyed: false, hashModels: true });
  await commit(h1.layer, set);
  await h1.worker.destroy();
  const hl = makeLoadTracker();
  const h2 = visit(hstore, { keyed: false, hashModels: true, load: hl });
  await commit(h2.layer, set);
  ok(h2.ch.state.cachedEncodes === 4 && h2.ch.state.cachedBakes === 1 && kinds(h2.ch.sent, "chunk").length > 0 && phase(hl)!.cached === bricks, "hashModels: unkeyed models hit by their bytes (still sent), and count as cached");
  ok(sameState(syncOf(set), h2.t) === "", "  and the result equals the synchronous path's");
  await h2.worker.destroy();
}

console.log("destroy:");
{
  const store = memoryCacheStore();
  const ch = channel({ cache: { store } });
  const w = makeSceneWorker({ spawn: ch.spawn });
  ch.state.hold = true;
  const p = w.encode({ size: rock.size, data: rock.data }, { cacheKey: "r" }).catch((e) => e.message);
  await settle();
  const d = w.destroy();
  ok(ch.state.terminated && (await p) === "scene worker destroyed", "a worker with a job in flight is terminated at once; the job rejects");
  await d;
  ok(!kinds(ch.sent, "close" as SceneRequest["kind"]).length, "  without asking it to close");
  const silent = channel({ cache: { store } });
  (silent.worker as { postMessage: (m: SceneRequest) => void }).postMessage = () => {};
  const w2 = makeSceneWorker({ spawn: silent.spawn, closeTimeoutMs: 20 });
  const t0 = performance.now();
  await w2.destroy();
  ok(silent.state.terminated && performance.now() - t0 >= 15, "an idle worker that never answers close is terminated after closeTimeoutMs");
}

console.log(`\n${checks - failed}/${checks} scene cache checks passed`);
if (failed) process.exit(1);
