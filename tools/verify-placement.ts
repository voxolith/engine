// Headless checks for placement on a worker.  bun tools/verify-placement.ts
//
// The instance layer's commitAsync against a fake target that bakes with the renderer's real
// bakePlacement (so the sync commit and the async one run the same code), and a real
// servePlacement worker side (a PlacementBaker) behind a fake message channel that structured-
// clones every message, as postMessage does. Covered: the applied result equals the sync
// commit's, byte for byte; the placement phase spans request to apply; a moving set committed
// during a bake; stale replies (superseded async and sync commits); abort; a model released
// during a bake and added again; models sent once; a worker error; and no worker at all. A
// scripted worker (progress sent by hand) checks the placement phase counting up during a bake:
// increasing, held below the total until the apply, nothing from stale or unknown bakes, and the
// totals after abort and supersede.

import { bakePlacement, type PlacementBake, type PlacementInput, type PlacementModel } from "@voxolith/renderer/core";
import { makeInstanceLayer, type EntityPlacement, type InstancePlacement, type InstanceTarget } from "../src/instances";
import { makePlacementWorker, servePlacement, type PlacementRequest, type PlacementResponse } from "../src/worker/placement";
import { LOAD_PHASES, makeLoadTracker, type LoadEvent } from "../src/load";
import type { EntityModel } from "../src/entity";

let failed = 0, checks = 0;
const ok = (c: boolean, m: string, d = "") => {
  checks++;
  if (c) console.log(`  ✓ ${m}`);
  else { failed++; console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); }
};
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await tick(); };

// --- a fake renderer: real bakes, the renderer's key checks ---------------------------------------

let nextKey = 1; // unique on the page, never reused, as the renderer's are
function fakeTarget() {
  const models: (PlacementModel | null)[] = [];
  const byKey = new Map<number, PlacementModel>();
  const t = {
    staticBake: undefined as PlacementBake | undefined,
    staticSets: 0,
    dynamicCalls: 0,
    lastDynamic: [] as readonly InstancePlacement[],
    applyThrows: 0,
    addModel(src: { size: { x: number; y: number; z: number }; data?: Uint8Array }) {
      const { x: sx, y: sy, z: sz } = src.size;
      const seen = new Set<number>(), subs: number[] = [];
      for (let z = 0; z < sz; z++) for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) {
        if (!src.data![x + y * sx + z * sx * sy]) continue;
        const k = (x >> 1) + (y >> 1) * 1024 + (z >> 1) * 1048576;
        if (seen.has(k)) continue;
        seen.add(k);
        subs.push(x >> 1, y >> 1, z >> 1);
      }
      const m: PlacementModel = { key: nextKey++, size: { ...src.size }, subs: new Int32Array(subs) };
      byKey.set(m.key, m);
      models.push(m);
      return models.length - 1;
    },
    removeModel(id: number) {
      const m = models[id];
      if (!m) return;
      byKey.delete(m.key);
      models[id] = null;
    },
    addPalette: () => 256,
    setPaletteColors() {},
    removePalette() {},
    setInstances(list: readonly InstancePlacement[], o: { dynamic?: boolean } = {}) {
      if (o.dynamic) { t.dynamicCalls++; t.lastDynamic = list; return; }
      apply(bakePlacement(t.placementInput(list), (key) => byKey.get(key)));
    },
    placementModel: (id: number) => models[id] ?? null,
    placementInput(list: readonly InstancePlacement[]): PlacementInput {
      const keys: number[] = [];
      const instances = [];
      for (const p of list) {
        const m = models[p.model];
        if (!m) continue;
        keys[p.model] = m.key;
        const q: Record<string, unknown> = { model: p.model, x: p.x, y: p.y, z: p.z, base: p.base };
        if (p.anchor !== undefined) q.anchor = p.anchor;
        if (p.yaw !== undefined) q.yaw = p.yaw;
        if (p.mirror !== undefined) q.mirror = p.mirror;
        instances.push(q);
      }
      for (let i = 0; i < keys.length; i++) keys[i] ??= 0;
      return { grid: { brickDim: [32, 16, 32], topDim: [4, 2, 4], gridMax: 256 }, models: keys, instances } as unknown as PlacementInput;
    },
    applyPlacement: (bake: PlacementBake) => apply(bake),
  };
  const apply = (bake: PlacementBake) => {
    bake.models.forEach((key, id) => {
      if (key && models[id]?.key !== key) { t.applyThrows++; throw new Error(`applyPlacement: model ${id} was removed or replaced since the bake; bake again`); }
    });
    t.staticBake = bake;
    t.staticSets++;
  };
  return t;
}

// --- a real worker side behind a fake channel ----------------------------------------------------

function channel() {
  const sent: PlacementRequest[] = [];
  const state = { hold: false, held: [] as PlacementResponse[], bakes: 0, terminated: false };
  let toMain: ((ev: MessageEvent<PlacementResponse>) => void) | null = null;
  const scope = {
    onmessage: null as ((ev: { data: PlacementRequest }) => void) | null,
    postMessage(msg: PlacementResponse) {
      if (msg.kind === "baked") state.bakes++;
      const copy = structuredClone(msg);
      if (state.hold) state.held.push(copy);
      else setTimeout(() => toMain?.({ data: copy } as MessageEvent<PlacementResponse>), 0);
    },
  };
  servePlacement({ scope });
  const worker = {
    set onmessage(fn: typeof toMain) { toMain = fn; },
    onerror: null as ((ev: ErrorEvent) => void) | null,
    postMessage(msg: PlacementRequest) {
      sent.push(msg);
      const copy = structuredClone(msg);
      setTimeout(() => scope.onmessage?.({ data: copy }), 0);
    },
    terminate() { state.terminated = true; },
  };
  const release = () => { const h = state.held.splice(0); state.hold = false; for (const m of h) toMain?.({ data: m } as MessageEvent<PlacementResponse>); };
  return { spawn: () => worker as unknown as Worker, sent, state, release, worker };
}

// --- the scene -----------------------------------------------------------------------------------

const box = (sx: number, sy: number, sz: number, fill = 0.4, seed = 1): EntityModel => {
  const data = new Uint8Array(sx * sy * sz);
  let s = seed;
  for (let i = 0; i < data.length; i++) { s = (s * 1103515245 + 12345) >>> 0; if ((s >>> 24) / 256 < fill) data[i] = 1; }
  return { size: { x: sx, y: sy, z: sz }, data, anchor: [sx >> 1, 0, sz >> 1], roles: [] } as unknown as EntityModel;
};
const tree = box(10, 24, 10, 0.3, 3), rock = box(14, 8, 12, 0.6, 7), bush = box(6, 6, 6, 0.8, 11);
function scene(models: EntityModel[], n: number, seed: number): EntityPlacement[] {
  let s = seed;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  return Array.from({ length: n }, (_, i) => ({ model: models[i % models.length], x: 8 + r() * 230, y: r() * 60, z: 8 + r() * 230, yaw: r() * 6.28, mirror: r() < 0.3, base: 256 + (i % 3) * 4 }));
}
const WORDS = ["inst", "boxes", "parts", "cells", "list", "subs", "subCells"] as const;
function same(a: PlacementBake | undefined, b: PlacementBake | undefined): string {
  if (!a || !b) return "missing bake";
  if (a.count !== b.count) return `count ${a.count} vs ${b.count}`;
  for (const k of WORDS) {
    const x = new Uint8Array(a[k].buffer, a[k].byteOffset, a[k].byteLength), y = new Uint8Array(b[k].buffer, b[k].byteOffset, b[k].byteLength);
    if (x.length !== y.length) return `${k}: ${x.length} vs ${y.length} bytes`;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return `${k} differs at byte ${i}`;
  }
  return a.dropped === b.dropped ? "" : "dropped differs";
}
const models = (list: readonly PlacementRequest[]) => list.filter((m) => m.kind === "model").length;
const phase = (load: ReturnType<typeof makeLoadTracker>) => load.snapshot().phases.find((p) => p.phase === LOAD_PHASES.placement);

console.log("async commit = sync commit:");
{
  const set = scene([tree, rock, bush], 400, 5);
  const syncT = fakeTarget();
  const syncL = makeInstanceLayer(syncT);
  syncL.setStatic(set);
  syncL.commit();

  const load = makeLoadTracker();
  const events: LoadEvent[] = [];
  load.on((e) => events.push(e));
  const ch = channel();
  const placement = makePlacementWorker({ spawn: ch.spawn, closeTimeoutMs: 50 });
  const t = fakeTarget();
  const layer = makeInstanceLayer(t, { load, placement });
  layer.setStatic(set);
  const done = layer.commitAsync();
  ok(t.staticSets === 0 && t.dynamicCalls === 1 && layer.baking, "commitAsync returns at once: moving set sent, static set baking");
  ok(phase(load)?.busy === true && phase(load)?.total === 400, "  the placement phase is open from the request", JSON.stringify(phase(load)));
  ok(models(ch.sent) === 3 && ch.sent.at(-1)?.kind === "bake", "  each model the set names is sent once, before the bake");
  await done;
  ok(t.staticSets === 1 && !layer.baking, "  resolves once the bake is applied");
  const diff = same(syncT.staticBake, t.staticBake);
  ok(diff === "" && t.staticBake!.count === 400, "the applied bake equals the synchronous commit's, byte for byte", diff);
  ok(!phase(load)!.busy && phase(load)!.done === 400 && phase(load)!.total === 400 && events.every((e) => e.done <= e.total), "  the phase ends at the apply with done === total");
  ok((await layer.commitAsync().then(() => "ok")) === "ok" && t.staticSets === 1 && t.dynamicCalls === 2, "an unchanged static set: commitAsync resolves at once, sends only the moving set");

  layer.setStatic(scene([tree, rock], 50, 9));
  await layer.commitAsync();
  ok(models(ch.sent) === 3 && t.staticBake!.count === 50, "a new set of known models sends no model again");
  placement.destroy();
}

console.log("the moving set during a bake:");
{
  const ch = channel();
  const placement = makePlacementWorker({ spawn: ch.spawn, closeTimeoutMs: 50 });
  const t = fakeTarget();
  const layer = makeInstanceLayer(t, { placement });
  layer.setStatic(scene([tree], 20, 1));
  layer.commit();
  const first = t.staticBake!;
  layer.setStatic(scene([tree, rock], 200, 2));
  ch.state.hold = true;
  const done = layer.commitAsync();
  const id = layer.models.id(bush);
  for (let f = 0; f < 5; f++) {
    layer.setDynamic([{ model: id, x: 10 + f, y: 0, z: 10, base: 256 }]);
    layer.commit();
  }
  await settle();
  ok(t.dynamicCalls === 7 && t.lastDynamic[0].x === 14, "commit() during the bake sends each moving set at once");
  ok(t.staticBake === first && t.staticSets === 1 && layer.baking, "  and neither re-places nor disturbs the static set: the old one keeps drawing");
  ch.release();
  await done;
  ok(t.staticSets === 2 && t.staticBake!.count === 200 && t.dynamicCalls === 7, "  the bake lands and is applied; the moving set stays");
  placement.destroy();
}

console.log("stale replies:");
{
  const load = makeLoadTracker();
  const ch = channel();
  const placement = makePlacementWorker({ spawn: ch.spawn, closeTimeoutMs: 50 });
  const t = fakeTarget();
  const layer = makeInstanceLayer(t, { load, placement });
  ch.state.hold = true;
  layer.setStatic(scene([tree], 30, 1));
  const a = layer.commitAsync();
  await settle(); // bake A runs on the worker; its reply is held
  layer.setStatic(scene([tree], 40, 2));
  const b = layer.commitAsync();
  layer.setStatic(scene([rock], 50, 3));
  const c = layer.commitAsync();
  ok(phase(load)!.total === 50 && phase(load)!.busy, "superseded bakes leave the placement total", JSON.stringify(phase(load)));
  await settle();
  ch.release();
  await Promise.all([a, b, c]);
  ok(t.staticSets === 1 && t.staticBake!.count === 50, "only the newest bake is applied; every waiter resolves with it", `sets ${t.staticSets}, count ${t.staticBake?.count}`);
  ok(ch.state.bakes === 2, "  the worker skipped the superseded bake it had not started", `worker baked ${ch.state.bakes}`);
  ok(!phase(load)!.busy && phase(load)!.done === 50 && phase(load)!.total === 50, "  done === total once idle");

  ch.state.hold = true;
  layer.setStatic(scene([tree], 60, 4));
  const d = layer.commitAsync();
  await settle();
  layer.setStatic(scene([bush], 70, 5));
  layer.commit();
  ok(t.staticSets === 2 && t.staticBake!.count === 70 && !layer.baking, "a synchronous commit supersedes the bake in flight");
  await d;
  ch.release();
  await settle();
  ok(t.staticSets === 2 && t.staticBake!.count === 70, "  its late reply is dropped; the pending commitAsync resolved with the newer set");
  placement.destroy();
}

console.log("abort:");
{
  const load = makeLoadTracker();
  const ch = channel();
  const placement = makePlacementWorker({ spawn: ch.spawn, closeTimeoutMs: 50 });
  const t = fakeTarget();
  const layer = makeInstanceLayer(t, { load, placement });
  ch.state.hold = true;
  layer.setStatic(scene([tree], 30, 1));
  const ctl = new AbortController();
  const p = layer.commitAsync({ signal: ctl.signal });
  await settle();
  ctl.abort();
  const e = await p.catch((err) => err);
  ok(e?.name === "AbortError" && !layer.baking, "abort rejects with the signal's AbortError and drops the bake");
  ok(!phase(load)!.busy && phase(load)!.done === 0 && phase(load)!.total === 0, "  the placement phase ends with its total dropped", JSON.stringify(phase(load)));
  ch.release();
  await settle();
  ok(t.staticSets === 0, "  the bake's late result is never applied");
  const again = layer.commitAsync();
  await again;
  ok(t.staticSets === 1 && t.staticBake!.count === 30, "  the static set counts as unsent: the next commitAsync bakes it again");

  const shared = new AbortController();
  layer.setStatic(scene([rock], 10, 2));
  ch.state.hold = true;
  const x = layer.commitAsync({ signal: shared.signal });
  const y = layer.commitAsync();
  shared.abort();
  ok((await x.catch((err) => err.name)) === "AbortError" && layer.baking, "one caller's abort keeps a bake another commitAsync still waits for");
  ch.release();
  await y;
  await settle();
  ch.release();
  await settle();
  ok(t.staticSets === 2 && t.staticBake!.count === 10, "  which is applied");
  const gone = new AbortController();
  gone.abort();
  ok((await layer.commitAsync({ signal: gone.signal }).catch((err) => err.name)) === "AbortError", "an already-aborted signal rejects at once");
  placement.destroy();
}

console.log("models released and added again:");
{
  const ch = channel();
  const placement = makePlacementWorker({ spawn: ch.spawn, closeTimeoutMs: 50 });
  const t = fakeTarget();
  const layer = makeInstanceLayer(t, { placement });
  const set = scene([tree, rock, bush], 120, 8);
  layer.setStatic(set);
  await layer.commitAsync();
  ch.state.hold = true;
  layer.setStatic(scene([tree, rock, bush], 90, 9));
  const p = layer.commitAsync();
  await settle();
  const rockKey = t.placementModel(layer.models.id(rock))!.key;
  layer.models.release(rock); // removed while its bake is in flight
  ok(ch.sent.some((m) => m.kind === "drop" && m.key === rockKey), "releasing a model drops its key on the worker");
  ch.release();
  await p;
  ok(t.applyThrows === 1, "  the bake naming it fails applyPlacement once", `${t.applyThrows}`);
  const syncT = fakeTarget();
  const ids = new Map<EntityModel, number>();
  const syncL = makeInstanceLayer(syncT);
  for (const m of [tree, rock, bush]) ids.set(m, syncL.models.id(m));
  syncL.setStatic(scene([tree, rock, bush], 90, 9));
  syncL.models.release(rock);
  syncL.commit();
  ok(same(syncT.staticBake, t.staticBake) === "" && t.staticBake!.count === 60, "  and the layer bakes again: the result equals a sync commit without the removed model", same(syncT.staticBake, t.staticBake));
  const before = models(ch.sent);
  layer.setStatic(set); // the rock is uploaded again, under a new key
  await layer.commitAsync();
  ok(models(ch.sent) === before + 1 && t.staticBake!.count === 120, "adding it again registers the new key once and bakes it");
  placement.destroy();
}

console.log("failure and fallbacks:");
{
  const ch = channel();
  const placement = makePlacementWorker({ spawn: ch.spawn, closeTimeoutMs: 50 });
  const t = fakeTarget();
  const layer = makeInstanceLayer(t, { placement });
  layer.setStatic(scene([tree], 10, 1));
  ch.state.hold = true;
  const p = layer.commitAsync();
  (ch.worker as { onerror: ((ev: ErrorEvent) => void) | null }).onerror?.({ message: "worker crashed" } as ErrorEvent);
  const e = await p.catch((err) => err.message);
  await settle();
  ok(e === "worker crashed" && !layer.baking, "a failing worker rejects commitAsync", String(e));
  layer.commit();
  ok(t.staticSets === 1, "  the set counts as unsent: commit() places it synchronously");
  await placement.destroy();
  ok(ch.state.terminated && (await placement.bake(t.placementInput([])).catch((err) => err.message)) === "placement worker destroyed", "destroy terminates the worker");

  const plain = fakeTarget();
  const noWorker = makeInstanceLayer(plain);
  noWorker.setStatic(scene([tree], 10, 1));
  const r = noWorker.commitAsync();
  ok(plain.staticSets === 1 && !noWorker.baking, "without a placement worker, commitAsync is commit()");
  await r;
  const bare = fakeTarget() as Partial<ReturnType<typeof fakeTarget>>;
  delete bare.applyPlacement;
  const ch2 = channel();
  const w2 = makePlacementWorker({ spawn: ch2.spawn, closeTimeoutMs: 50 });
  const old = makeInstanceLayer(bare as unknown as InstanceTarget, { placement: w2 });
  old.setStatic(scene([tree], 10, 1));
  let threw = false;
  try { await old.commitAsync(); } catch { threw = true; }
  ok(ch2.sent.length === 0 && !threw, "  so it is with a target lacking the placement methods (nothing is sent)");
  w2.destroy();
}

// --- a scripted worker: the test sends progress and results by hand ------------------------------

function scripted() {
  const models = new Map<number, PlacementModel>();
  const bakes: { id: number; input: PlacementInput }[] = [];
  const cancels: number[] = [];
  let toMain: ((ev: MessageEvent<PlacementResponse>) => void) | null = null;
  const send = (m: PlacementResponse) => toMain?.({ data: structuredClone(m) } as MessageEvent<PlacementResponse>);
  const worker = {
    set onmessage(fn: typeof toMain) { toMain = fn; },
    onerror: null as ((ev: ErrorEvent) => void) | null,
    postMessage(msg: PlacementRequest) {
      if (msg.kind === "model") models.set(msg.model.key, msg.model);
      else if (msg.kind === "drop") models.delete(msg.key);
      else if (msg.kind === "bake") bakes.push({ id: msg.id, input: structuredClone(msg.input) });
      else cancels.push(msg.id);
    },
    terminate() {},
  };
  return {
    spawn: () => worker as unknown as Worker,
    bakes,
    cancels,
    last: () => bakes.at(-1)!.id,
    progress: (id: number, done: number, total: number) => send({ kind: "progress", id, done, total }),
    finish(id: number) {
      const b = bakes.find((x) => x.id === id)!;
      send({ kind: "baked", id, bake: bakePlacement(b.input, (key) => models.get(key)), ms: 1 });
    },
  };
}

console.log("progress during a bake:");
{
  const load = makeLoadTracker();
  const ch = scripted();
  const placement = makePlacementWorker({ spawn: ch.spawn, closeTimeoutMs: 50 });
  const t = fakeTarget();
  const layer = makeInstanceLayer(t, { load, placement });
  const seen: { done: number; total: number; applied: boolean }[] = [];
  load.on((e) => { if (e.phase === LOAD_PHASES.placement) seen.push({ done: e.done, total: e.total, applied: t.staticSets > 0 }); });
  layer.setStatic(scene([tree, rock, bush], 400, 5));
  const done = layer.commitAsync();
  await settle();
  const id = ch.last();
  const counts: number[] = [];
  for (const [d, n] of [[0, 1000], [250, 1000], [700, 1000], [1000, 1000]]) {
    ch.progress(id, d, n);
    counts.push(phase(load)!.done);
  }
  ok(counts.join() === "0,100,280,399", "progress ticks placement as the bake's fraction of the instance count", counts.join());
  ok(phase(load)!.total === 400 && phase(load)!.busy && t.staticSets === 0, "  the total stays the instance count; at 100% the phase is held one short of it until the apply");
  ch.finish(id);
  await done;
  const inc = seen.every((e, i) => i === 0 || e.done >= seen[i - 1].done);
  ok(inc && seen.filter((e) => !e.applied).every((e) => e.done < e.total), "  counts only increase, and stay below the total before the apply", JSON.stringify(seen));
  ok(!phase(load)!.busy && phase(load)!.done === 400 && phase(load)!.total === 400 && seen.at(-1)!.applied, "  the apply ticks the rest and ends the phase at 400/400");
  ch.progress(id, 1000, 1000);
  ch.progress(9999, 5, 10);
  ok(phase(load)!.done === 400 && phase(load)!.total === 400, "progress for a settled or unknown bake is ignored");

  // Supersede: A's progress, then B, then A's late progress and result.
  layer.setStatic(scene([tree], 100, 6));
  void layer.commitAsync();
  await settle();
  const a = ch.last();
  ch.progress(a, 0, 10);
  ch.progress(a, 5, 10);
  ok(phase(load)!.done === 450 && phase(load)!.total === 500, "a second bake counts on the phase", JSON.stringify(phase(load)));
  layer.setStatic(scene([rock], 60, 7));
  const pb = layer.commitAsync();
  await settle();
  const b = ch.last();
  ok(phase(load)!.done === 400 && phase(load)!.total === 460 && ch.cancels.includes(a), "  superseding it takes its progress and its total off the phase", JSON.stringify(phase(load)));
  ch.progress(a, 10, 10);
  ch.progress(b, 1, 2);
  ok(phase(load)!.done === 430 && phase(load)!.total === 460, "  the stale bake's progress sends nothing; the new one's counts", JSON.stringify(phase(load)));
  ch.finish(a);
  await settle();
  ok(t.staticBake!.count === 400, "  the stale result is not applied");
  ch.finish(b);
  await pb;
  ok(!phase(load)!.busy && phase(load)!.done === 460 && phase(load)!.total === 460 && t.staticBake!.count === 60, "  the new bake's apply ends the phase at done === total");

  // Abort after progress.
  const ctl = new AbortController();
  layer.setStatic(scene([bush], 80, 8));
  const pc = layer.commitAsync({ signal: ctl.signal });
  await settle();
  const c = ch.last();
  ch.progress(c, 3, 4);
  ok(phase(load)!.done === 520 && phase(load)!.total === 540, "a bake about to be aborted counts", JSON.stringify(phase(load)));
  ctl.abort();
  await pc.catch(() => {});
  ch.progress(c, 4, 4);
  ok(!phase(load)!.busy && phase(load)!.done === 460 && phase(load)!.total === 460, "  aborting takes its progress off; its later progress is ignored", JSON.stringify(phase(load)));

  // A sync commit supersedes a bake that has progress.
  layer.setStatic(scene([tree], 20, 9));
  void layer.commitAsync();
  await settle();
  ch.progress(ch.last(), 1, 2);
  layer.setStatic(scene([rock], 30, 10));
  layer.commit();
  ok(!phase(load)!.busy && phase(load)!.done === 490 && phase(load)!.total === 490, "  so does a synchronous commit superseding it", JSON.stringify(phase(load)));

  // One instance: nothing to show before the apply.
  layer.setStatic(scene([tree], 1, 11));
  const pd = layer.commitAsync();
  await settle();
  ch.progress(ch.last(), 1, 1);
  const held = phase(load)!.done;
  ch.finish(ch.last());
  await pd;
  ok(held === 490 && phase(load)!.done === 491 && phase(load)!.total === 491, "a one-instance set stays at 0 of 1 until the apply");
  ok(seen.every((e) => e.done <= e.total && e.done >= 0), "no placement event ever has done > total");
  placement.destroy();
}

console.log("makePlacementWorker.bake onProgress:");
{
  const ch = scripted();
  const placement = makePlacementWorker({ spawn: ch.spawn, closeTimeoutMs: 50 });
  const t = fakeTarget();
  const got: string[] = [];
  const input = t.placementInput([]);
  const p1 = placement.bake(input, { onProgress: (d, n) => got.push(`1:${d}/${n}`) });
  const ctl = new AbortController();
  const p2 = placement.bake(input, { signal: ctl.signal, onProgress: (d, n) => got.push(`2:${d}/${n}`) });
  const [i1, i2] = [ch.bakes[0].id, ch.bakes[1].id];
  ch.progress(i1, 0, 8);
  ch.progress(i2, 0, 8);
  ch.progress(i1, 8, 8);
  ok(got.join() === "1:0/8,2:0/8,1:8/8", "progress reaches the onProgress of its own bake only", got.join());
  ctl.abort();
  await p2.catch(() => {});
  ch.progress(i2, 4, 8);
  ch.finish(i1);
  await p1;
  ch.progress(i1, 8, 8);
  ok(got.length === 3, "  nothing after the bake settles or aborts", got.join());
  placement.destroy();
}

console.log("servePlacement posts progress:");
{
  const ch = channel();
  const t = fakeTarget();
  const layer = makeInstanceLayer(t);
  for (const m of [tree, rock, bush]) layer.models.id(m);
  const list = scene([tree, rock, bush], 300, 12).map((p) => ({ model: layer.models.id(p.model), x: p.x, y: p.y, z: p.z, anchor: p.model.anchor, yaw: p.yaw, mirror: p.mirror, base: p.base }));
  const placement = makePlacementWorker({ spawn: ch.spawn, closeTimeoutMs: 50 });
  for (let id = 0; id < 3; id++) placement.register(t.placementModel(id)!);
  const prog: [number, number][] = [];
  await placement.bake(t.placementInput(list), { onProgress: (d, n) => prog.push([d, n]) });
  const total = prog[0]?.[1] ?? -1;
  ok(prog.length >= 2 && prog[0][0] === 0 && prog.at(-1)![0] === total && prog.every(([, n]) => n === total), "the worker side posts (0, total) first and (total, total) last", JSON.stringify(prog));
  ok(prog.every(([d], i) => i === 0 || d >= prog[i - 1][0]), "  done never decreases");
  placement.destroy();
}

console.log(`\n${checks - failed}/${checks} placement checks passed`);
if (failed) process.exit(1);
