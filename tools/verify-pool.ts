// Headless checks for the loading controls.  bun tools/verify-pool.ts
//
// The generator pool's queue controls (priority, reprioritise, abort queued and running,
// pause and resume, respawnOnAbort, destroy's close handshake) with fake workers; the model
// cache (round trip, size cap with LRU eviction, controls, salt sweep) on the in-memory store;
// and serveGenerators with a fake scope, its cache bypass and its close handshake.
//
// What bun cannot run: IndexedDB itself (openModelCache / openModelCacheControls return null
// here, which is checked). The IndexedDB store only maps the CacheStore calls onto one
// transaction each; the warm-visit bench (`gpu-bench examples --load`) exercises it for real.

import { LOAD_PHASES, makeLoadTracker, type LoadEvent } from "../src/load";
import { makeGeneratorPool } from "../src/worker/pool";
import { serveGenerators } from "../src/worker/serve";
import {
  makeModelCache,
  makeModelCacheControls,
  memoryCacheStore,
  openModelCache,
  openModelCacheControls,
  openModelCacheOn,
  planEviction,
  type CacheStore,
} from "../src/worker/cache";
import type { GenerateRequest, WorkerRequest, WorkerResponse } from "../src/worker/protocol";
import { clearGenerators, registerGenerator } from "../src/generator";
import type { Entity } from "../src/entity";

let failed = 0, checks = 0;
const ok = (c: boolean, m: string, d = "") => {
  checks++;
  if (c) console.log(`  ✓ ${m}`);
  else { failed++; console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); }
};
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// A fake worker: records requests; the test answers them. `closes` answers close requests.
function fakeWorkers(closes = true) {
  const workers: { requests: WorkerRequest[]; reply(msg: WorkerResponse): void; terminated: boolean }[] = [];
  const spawn = () => {
    const w = {
      onmessage: null as ((ev: MessageEvent<WorkerResponse>) => void) | null,
      onerror: null as ((ev: ErrorEvent) => void) | null,
      postMessage(req: WorkerRequest) {
        rec.requests.push(req);
        if (req.kind === "close" && closes) queueMicrotask(() => rec.reply({ kind: "closed" }));
      },
      terminate() { rec.terminated = true; },
    };
    const rec = {
      requests: [] as WorkerRequest[],
      terminated: false,
      reply: (msg: WorkerResponse) => { if (!rec.terminated) w.onmessage?.({ data: msg } as MessageEvent<WorkerResponse>); },
    };
    workers.push(rec);
    queueMicrotask(() => rec.reply({ kind: "ready", generators: ["g"] }));
    return w as unknown as Worker;
  };
  const gens = (w: number) => workers[w].requests.filter((r): r is GenerateRequest => r.kind === "generate");
  const answer = (w: number, i: number, cached = false) => {
    const req = gens(w)[i];
    workers[w].reply({ kind: "ok", id: req.id, entity: fakeEntity(`e${req.seed}`), cached });
  };
  return { workers, spawn, gens, answer };
}
const fakeEntity = (id: string): Entity => ({
  id, kind: "test", meta: {}, model: { size: { x: 1, y: 1, z: 1 }, data: new Uint8Array([1]), anchor: [0, 0, 0], roles: [] },
} as unknown as Entity);
const spec = (seed: number, generator = "g") => ({ generator, params: {}, seed });
const models = (load: ReturnType<typeof makeLoadTracker>) => load.snapshot().phases.find((p) => p.phase === LOAD_PHASES.models);

console.log("priority:");
{
  const { spawn, gens, answer } = fakeWorkers();
  const pool = makeGeneratorPool({ spawn, size: 1 });
  await pool.ready();
  pool.pause();
  const out = [pool.generate(spec(1)), pool.generate(spec(2), { priority: 5 }), pool.generate(spec(3)), pool.generate(spec(4), { priority: 5 }), pool.generate(spec(5), { priority: -1 })];
  ok(pool.paused && pool.queued === 5 && gens(0).length === 0, "paused: nothing is dispatched, everything queues");
  pool.resume();
  for (let i = 0; i < 5; i++) answer(0, i);
  await Promise.all(out);
  ok(gens(0).map((r) => r.seed).join() === "2,4,1,3,5", "higher priority first, queue order within a priority", gens(0).map((r) => r.seed).join());

  pool.pause();
  const more = [6, 7, 8, 9].map((s) => pool.generate(spec(s), { priority: s === 7 ? 1 : 0 }));
  pool.reprioritise((s, p) => (s.seed === 9 ? 10 : s.seed === 7 ? p - 5 : p));
  pool.resume();
  for (let i = 5; i < 9; i++) answer(0, i);
  await Promise.all(more);
  ok(gens(0).slice(5).map((r) => r.seed).join() === "9,6,8,7", "reprioritise re-sorts the queue, keeping queue order on ties", gens(0).slice(5).map((r) => r.seed).join());
  await pool.destroy();
}

console.log("abort:");
{
  const load = makeLoadTracker();
  const events: LoadEvent[] = [];
  load.on((e) => events.push(e));
  const { spawn, gens, answer } = fakeWorkers();
  const pool = makeGeneratorPool({ spawn, size: 1, load });
  await pool.ready();
  const running = new AbortController(), queued = new AbortController();
  const a = pool.generate(spec(1), { signal: running.signal });
  const b = pool.generate(spec(2), { signal: queued.signal });
  const c = pool.generate(spec(3));
  ok(models(load)!.total === 3 && pool.pending === 3 && pool.queued === 2, "three requests: one running, two queued");
  queued.abort();
  const eb = await b.catch((e) => e);
  ok(eb instanceof DOMException && eb.name === "AbortError", "an aborted queued request rejects with an AbortError DOMException", String(eb));
  ok(pool.queued === 1 && models(load)!.total === 2, "  it leaves the queue and the models total", JSON.stringify(models(load)));
  running.abort(new Error("walked away"));
  const ea = await a.catch((e) => e);
  ok(ea instanceof Error && ea.message === "walked away", "an aborted running request rejects at once, with the signal's reason");
  ok(pool.pending === 1 && models(load)!.total === 1 && gens(0).length === 1, "  it leaves pending and the total; its worker is still busy", `pending ${pool.pending}, ${JSON.stringify(models(load))}`);
  answer(0, 0);
  await tick();
  ok(gens(0).length === 2 && gens(0)[1].seed === 3, "  its result is dropped when it lands, and the worker takes the next");
  answer(0, 1);
  const ec = await c;
  ok(ec.id === "e3" && !models(load)!.busy && models(load)!.done === 1 && models(load)!.total === 1, "idle after aborts: done === total", JSON.stringify(models(load)));
  ok(events.every((e) => e.done <= e.total), "  no event ever has done > total");
  const gone = new AbortController();
  gone.abort();
  const before = models(load)!.total;
  const ed = await pool.generate(spec(4), { signal: gone.signal }).catch((e) => e);
  ok(ed?.name === "AbortError" && models(load)!.total === before && gens(0).length === 2, "an already-aborted signal rejects without queueing or counting");

  const many = new AbortController();
  pool.pause();
  const all = pool.generateMany([5, 6, 7].map((s) => spec(s)), { signal: many.signal, priority: 2, onDone: () => {} });
  many.abort();
  ok((await all.catch((e) => e))?.name === "AbortError" && pool.pending === 0 && !models(load)!.busy, "generateMany: one signal aborts the batch", JSON.stringify(models(load)));
  pool.resume();
  await pool.destroy();
}

console.log("pause and resume:");
{
  const load = makeLoadTracker();
  const { spawn, gens, answer } = fakeWorkers();
  const pool = makeGeneratorPool({ spawn, size: 2, load });
  await pool.ready();
  const first = [1, 2].map((s) => pool.generate(spec(s)));
  pool.pause();
  const later = [3, 4].map((s) => pool.generate(spec(s)));
  ok(gens(0).length === 1 && gens(1).length === 1 && pool.queued === 2, "running requests stay running, new ones queue");
  answer(0, 0);
  answer(1, 0);
  await Promise.all(first);
  ok(gens(0).length === 1 && gens(1).length === 1 && models(load)!.busy, "  running ones finish while paused; the phase stays busy with work owed", JSON.stringify(models(load)));
  pool.resume();
  ok(!pool.paused && gens(0).length === 2 && gens(1).length === 2, "resume dispatches again");
  answer(0, 1);
  answer(1, 1);
  await Promise.all(later);
  ok(!models(load)!.busy && models(load)!.done === 4, "  and the phase ends");
  await pool.destroy();
}

console.log("cache bypass and respawnOnAbort:");
{
  const { workers, spawn, gens, answer } = fakeWorkers();
  const pool = makeGeneratorPool({ spawn, size: 1, respawnOnAbort: true });
  await pool.ready();
  const ctl = new AbortController();
  const a = pool.generate(spec(1), { signal: ctl.signal, cache: false }).catch((e) => e);
  const b = pool.generate(spec(2));
  ok(gens(0)[0].cache === false, "cache: false reaches the worker");
  ctl.abort();
  await a;
  ok(workers[0].terminated && workers.length === 2, "respawnOnAbort terminates the busy worker and spawns a fresh one");
  await pool.ready();
  ok(gens(1)[0]?.seed === 2 && gens(1)[0].cache === undefined, "  the queue carries on on the new worker, cache left on by default");
  answer(1, 0);
  ok((await b).id === "e2", "  and its results arrive");
  await pool.destroy();
}

console.log("destroy:");
{
  const { workers, spawn, gens } = fakeWorkers();
  const pool = makeGeneratorPool({ spawn, size: 2 });
  await pool.ready();
  const busy = pool.generate(spec(1)).catch((e) => e.message);
  const done = pool.destroy();
  ok(workers[0].terminated && !workers[1].terminated, "a worker still generating is terminated at once, an idle one is asked to close");
  ok(workers[1].requests.at(-1)?.kind === "close", "  with a close request");
  await done;
  ok(workers[1].terminated && (await busy) === "generator pool destroyed", "  and terminated when it answers; pending requests reject");
  ok(gens(0).length === 1, "  nothing else was dispatched");

  const silent = fakeWorkers(false);
  const p2 = makeGeneratorPool({ spawn: silent.spawn, size: 1, closeTimeoutMs: 20 });
  await p2.ready();
  const t0 = performance.now();
  await p2.destroy();
  ok(silent.workers[0].terminated && performance.now() - t0 >= 15, "a worker that never answers is terminated after closeTimeoutMs");
  ok((await p2.generate(spec(1)).catch((e) => e.message)) === "generator pool destroyed", "  the pool is unusable afterwards");
}

console.log("model cache:");
{
  let clock = 1000;
  const now = () => clock++;
  const store = memoryCacheStore();
  const entity = (n: number, bytes: number): Entity => {
    // Noise so deflate cannot shrink it far: sizes stay roughly `bytes`.
    const data = new Uint8Array(bytes);
    let s = n * 2654435761;
    for (let i = 0; i < bytes; i++) data[i] = (s = (s * 1103515245 + 12345) >>> 0) >>> 24;
    return { id: `m${n}`, kind: "test", meta: { n }, model: { size: { x: bytes, y: 1, z: 1 }, data, anchor: [0, 0, 0], roles: [] } } as unknown as Entity;
  };
  const cache = makeModelCache(store, "A", {}, now);
  await cache.put("k1", entity(1, 2000), { generator: "tree" });
  const back = await cache.get("k1");
  ok(!!back && back.model.data.length === 2000 && back.model.data[7] === entity(1, 2000).model.data[7] && (back.meta as { n: number }).n === 1, "put then get round-trips the model");
  ok((await cache.get("nope")) === undefined, "  a missing key is a miss");
  const controls = makeModelCacheControls(store);
  const [e1] = await controls.entries();
  ok(e1.key === "A|k1" && e1.salt === "A" && e1.generator === "tree" && e1.bytes > 1500 && e1.lastUsed > e1.created, "  the entry records salt, generator, bytes and a get's use", JSON.stringify(e1));

  const capped = makeModelCache(store, "A", { maxBytes: 7000 }, now);
  await capped.put("k2", entity(2, 2000), { generator: "rock" });
  await capped.get("k1"); // k1 is now the most recently used
  await capped.put("k3", entity(3, 2000), { generator: "tree" });
  await capped.put("k4", entity(4, 2000), { generator: "tree" });
  const keys = (await controls.entries()).map((e) => e.key);
  ok(!keys.includes("A|k2") && keys.includes("A|k1") && keys.length === 3, "maxBytes evicts the least recently used", keys.join());
  ok(keys[0] === "A|k4", "  entries() lists the most recently used first");
  await capped.put("huge", entity(5, 9000), { generator: "tree" });
  ok(!(await controls.entries()).some((e) => e.key === "A|huge") && (await controls.entries()).length === 3, "  a model bigger than the cap is not kept, and evicts nothing");

  const other = makeModelCache(store, "B", {}, now);
  await other.put("k1", entity(6, 500), { generator: "rock" });
  ok((await cache.get("k1"))?.id === "m1" && (await other.get("k1"))?.id === "m6", "salts keep the same key apart");
  const u = await controls.usage();
  const uTree = await controls.usage({ generator: "tree" });
  ok(u.entries === 4 && uTree.entries === 3 && u.bytes > uTree.bytes, "usage() counts entries and bytes, filtered by generator", JSON.stringify({ u, uTree }));
  ok((await controls.usage({ salt: "B", generator: "tree" })).entries === 0, "  every field of a filter must match");
  ok((await controls.clear({ salt: "B" })) === 1 && (await other.get("k1")) === undefined, "clear({ salt }) removes that salt only");
  ok((await controls.clear({ generator: "tree" })) === 3 && (await controls.usage()).entries === 0, "clear({ generator })");
  for (let i = 0; i < 4; i++) await cache.put(`t${i}`, entity(10 + i, 1000), { generator: "g" });
  const total = (await controls.usage()).bytes;
  ok((await controls.trim(total - 1)) === 1 && !(await controls.entries()).some((e) => e.key === "A|t0"), "trim(maxBytes) evicts the oldest until it fits");
  ok((await controls.clear()) === 3 && (await controls.usage()).bytes === 0, "clear() empties it");

  await cache.put("x", entity(20, 100), { generator: "g" });
  await other.put("y", entity(21, 100), { generator: "g" });
  const reopened = await openModelCacheOn(store, "B");
  ok((await controls.entries()).map((e) => e.salt).join() === "B" && (await reopened.get("y"))?.id === "m21", "opening under a salt drops every other salt's entries");
  ok(planEviction([{ key: "a", salt: "", generator: "", bytes: 5, created: 1, lastUsed: 3 }, { key: "b", salt: "", generator: "", bytes: 5, created: 2, lastUsed: 2 }], 5).join() === "b",
    "planEviction: least recently used first, just enough");

  const broken: CacheStore = { ...memoryCacheStore(), put: async () => { throw new Error("quota"); }, get: async () => { throw new Error("gone"); } };
  const safe = makeModelCache(broken, "A");
  let threw = false;
  try { await safe.put("k", entity(1, 10)); ok((await safe.get("k")) === undefined, "storage errors: a failed put keeps nothing, a failed get is a miss"); } catch { threw = true; }
  ok(!threw, "  and neither throws");
  ok((await openModelCache("x", "s")) === null && (await openModelCacheControls("x")) === null, "without IndexedDB (bun) both openers return null");
}

console.log("serveGenerators:");
{
  clearGenerators();
  let generated = 0;
  registerGenerator({
    id: "test/box", name: "box", version: "1", roles: [], defaults: {}, params: [],
    generate: (_p, rng) => { generated++; return { ...fakeEntity("box"), meta: { r: rng() } } as Entity; },
  });
  // A store whose writes finish only when the test says so, like a worker busy generating.
  const inner = memoryCacheStore();
  let release: () => void = () => {};
  const gate = { held: new Promise<void>((r) => (release = r)) };
  const store: CacheStore = { ...inner, put: async (...a) => { await gate.held; return inner.put(...a); } };
  const serve = () => {
    const out: WorkerResponse[] = [];
    const scope = { onmessage: null as ((ev: { data: WorkerRequest }) => void | Promise<void>) | null, postMessage: (m: WorkerResponse) => void out.push(m) };
    serveGenerators({ scope, cache: { store } });
    const send = async (m: WorkerRequest) => { await scope.onmessage!({ data: m }); };
    return { out, send };
  };
  const w = serve();
  await w.send({ kind: "generate", id: 1, generator: "test/box", params: {}, seed: 7 });
  ok(w.out[1]?.kind === "ok" && !(w.out[1] as { cached?: boolean }).cached && generated === 1, "a miss generates and answers before its cache write has finished");
  let closed = false;
  const closing = w.send({ kind: "close" }).then(() => (closed = w.out.some((m) => m.kind === "closed")));
  await tick();
  ok(!closed && !w.out.some((m) => m.kind === "closed"), "close waits for the write in progress");
  release();
  await closing;
  ok(closed, "  and answers closed once it has committed");
  const w2 = serve();
  await w2.send({ kind: "generate", id: 1, generator: "test/box", params: {}, seed: 7 });
  ok((w2.out[1] as { cached?: boolean }).cached === true && generated === 1, "the next worker is served from the cache");
  await w2.send({ kind: "generate", id: 2, generator: "test/box", params: {}, seed: 7, cache: false });
  await w2.send({ kind: "generate", id: 3, generator: "test/box", params: {}, seed: 8, cache: false });
  ok(!(w2.out[2] as { cached?: boolean }).cached && generated === 3 && (await inner.list()).length === 1, "cache: false neither reads nor writes");
  clearGenerators();
}

console.log(`\n${checks - failed}/${checks} pool and cache checks passed`);
if (failed) process.exit(1);
