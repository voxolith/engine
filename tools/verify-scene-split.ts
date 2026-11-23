// Headless checks for placement bakes split over several workers.  bun tools/verify-scene-split.ts
//
// `makeSceneWorker({ bakeWorkers })` against the fakes of tools/scene-fakes.ts: every `spawn` is a
// real `serveScene` of its own behind a channel that structured-clones each message with its
// transfer list, the first the scene worker and the rest helpers, running the renderer's real
// `splitPlacement` / `bakePlacementShare` / `mergePlacementShares`. Covered: a bake over 2, 3 and 4
// workers applies what one worker and the synchronous `commit()` apply, byte for byte, with a
// scene worker (`worker`) and a bake-only one (`placement`); helpers are spawned only by a bake
// that is split, get every model the set names (also those registered before they existed, and by
// keys only on the scene worker) once, and nothing but models and shares; `bakeWorkers: 1` posts
// the message it always did; the threshold (`bakeShareUnits`) and sets with empty ranges; progress
// (sums over the shares, never decreasing, ending at the total; the layer's placement phase); a
// split bake is cached as a single one and a hit spawns no helper; abort before and during the
// shares, a newer commit superseding an older one, a share that fails, a helper that dies;
// `destroy()` (busy and idle, with the cache write finished) and the helpers' idle release.
//
// What this cannot run: real workers and cores, so nothing here measures the speed-up.

import { bakePlacement, type PlacementBake, type PlacementInput } from "@voxolith/renderer/core";
import { makeInstanceLayer, type EntityPlacement } from "../src/instances";
import { makeSceneWorker, type SceneRequest, type SceneWorkerOptions } from "../src/worker/scene";
import { memoryCacheStore, type CacheStore } from "../src/worker/cache";
import { LOAD_PHASES, makeLoadTracker } from "../src/load";
import { box, channel, fakeTarget, farm, kinds, phase, sameBake, sameState, scene, settle, sparseBox, syncOf, tick, type Fake } from "./scene-fakes";

let failed = 0, checks = 0;
const ok = (c: boolean, m: string, d = "") => {
  checks++;
  if (c) console.log(`  ✓ ${m}`);
  else { failed++; console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); }
};

const tree = box(10, 24, 10, 0.3, 3), rock = box(14, 8, 12, 0.6, 7), bush = box(6, 6, 6, 0.8, 11);
const oak = sparseBox(40, 33, 36, 0.05, 5);
const MODELS = [tree, oak, rock, bush];
const SET = scene(MODELS, 300, 5);
const SMALL = 500; // marking units per share: every set here splits

type Chan = ReturnType<typeof channel>;
/** A layer on a fresh fake renderer with a scene worker over a farm of workers. */
function rig(o: Partial<SceneWorkerOptions> & { store?: CacheStore; onSpawn?: (ch: Chan, i: number) => void; bakeOnly?: boolean; load?: ReturnType<typeof makeLoadTracker> } = {}) {
  const { store, onSpawn, bakeOnly, load, ...rest } = o;
  const f = farm(store ? { cache: { store } } : {}, onSpawn);
  const worker = makeSceneWorker({ spawn: f.spawn, chunkBricks: 7, bakeShareUnits: SMALL, ...rest });
  const t = fakeTarget();
  const layer = makeInstanceLayer(t, bakeOnly ? { placement: worker, load } : { worker, load });
  return { f, worker, t, layer, primary: () => f.all[0], helpers: () => f.all.slice(1) };
}
const holdHelpers = (ch: Chan, i: number) => { if (i > 0) ch.state.hold = true; };
/** Wait until `cond` holds (a bounded number of tasks). */
async function until(cond: () => boolean, n = 400): Promise<boolean> {
  for (let i = 0; i < n && !cond(); i++) await tick();
  return cond();
}
/** The marking units of a set, as the worker counts them (no posed instances here). */
const unitsOf = (t: Fake, input: PlacementInput) => input.instances.reduce((n, p) => n + t.placementModel(p.model)!.subs.length / 3, 0);
const inputOf = (r: ReturnType<typeof rig>, set: EntityPlacement[]) => r.t.placementInput(set.map((p) => ({ x: p.x, y: p.y, z: p.z, yaw: p.yaw, mirror: p.mirror, base: p.base, model: r.layer.models.id(p.model)! })));
const reference = (t: Fake, input: PlacementInput): PlacementBake => bakePlacement(input, (key) => t.models.find((m) => m?.placement.key === key)?.placement);

console.log("a bake over 1, 2, 3 and 4 workers = commit():");
{
  const syncT = syncOf(SET);
  for (const n of [1, 2, 3, 4]) {
    const load = makeLoadTracker();
    const r = rig({ bakeWorkers: n, load });
    r.layer.setStatic(SET);
    ok(r.f.all.length === 1, `${n}: making the worker spawns one, whatever the count`);
    await r.layer.commitAsync();
    const diff = sameState(syncT, r.t);
    ok(diff === "", `${n}: the pool, every model and the applied bake equal the synchronous path's`, diff);
    ok(r.f.all.length === n && r.primary().state.bakes === 1, `${n}: ${n} worker${n > 1 ? "s" : ""} in all, and the scene worker answers the one bake`, `${r.f.all.length} workers, ${r.primary().state.bakes} bakes`);
    const bakeMsg = kinds(r.primary().sent, "bake")[0] as Extract<SceneRequest, { kind: "bake" }>;
    if (n === 1) {
      ok(!("split" in bakeMsg) && Object.keys(bakeMsg).sort().join() === "id,input,kind" && r.primary().state.splits === 0, "1: the bake message is what it was before bakes could split");
    } else {
      ok(r.primary().state.splits === 1 && kinds(r.primary().sent, "merge").length === 1 && r.helpers().every((h) => h.state.shares === 1), `${n}: one split, a share from every helper, one merge on the scene worker`);
      ok(r.helpers().every((h) => h.sent.every((m) => m.kind === "model" || m.kind === "share" || m.kind === "cancel")), `${n}: helpers are sent models and shares only (no encodes, no keys)`, r.helpers().map((h) => h.sent.map((m) => m.kind).join()).join(" | "));
      ok(r.helpers().every((h) => kinds(h.sent, "model").length === MODELS.length) && kinds(r.primary().sent, "model").length === 0, `${n}: each helper gets the four models whole, the scene worker still only their keys`);
      ok(r.helpers().every((h) => h.state.encodes === 0 && h.state.bakes === 0), `${n}: helpers encode nothing and answer no bake`);
    }
    const p = phase(load, LOAD_PHASES.placement);
    ok(!!p && !p.busy && p.done === p.total && p.total === SET.length, `${n}: the placement phase ends at its total`, JSON.stringify(p));
    // The same set again through the bare API: progress, and the bake itself.
    const input = inputOf(r, SET);
    const seen: [number, number][] = [];
    const bake = await r.worker.bake(input, { onProgress: (d, t) => seen.push([d, t]) });
    ok(sameBake(reference(r.t, input), bake) === "", `${n}: worker.bake() equals bakePlacement of the same input`, sameBake(reference(r.t, input), bake));
    const last = seen[seen.length - 1];
    ok(seen.length >= 2 && seen[0][0] === 0 && last[0] === last[1] && seen.every(([d, t], i) => d <= t && (i === 0 || d >= seen[i - 1][0])), `${n}: progress starts at 0, never decreases and ends at the total`, JSON.stringify(seen.slice(0, 3)) + " … " + JSON.stringify(seen.slice(-2)));
    if (n > 1) ok(r.f.all.length === n && r.helpers().every((h) => kinds(h.sent, "model").length === MODELS.length), `${n}: the second bake reuses the helpers and sends them no model again`);
    await r.worker.destroy();
  }
}

console.log("bake only (`placement`), models registered whole:");
{
  const r = rig({ bakeWorkers: 3, bakeOnly: true });
  r.layer.setStatic(SET);
  await r.layer.commitAsync();
  ok(sameState(syncOf(SET), r.t) === "" && r.f.all.length === 3 && r.primary().state.splits === 1, "three workers bake what commit() bakes", sameState(syncOf(SET), r.t));
  ok(r.f.all.every((c) => kinds(c.sent, "model").length === MODELS.length), "  every worker got every model once");
  // A model dropped is dropped on the helpers too.
  const key = r.t.placementModel(r.layer.models.id(bush)!)!.key;
  r.worker.drop(key);
  ok(r.f.all.every((c) => c.sent.some((m) => m.kind === "drop" && m.key === key)), "  a dropped key is dropped on every worker that has it");
  await r.worker.destroy();
}

console.log("the threshold, and ranges that come out empty:");
{
  // The default: 2 million units per share; this set is tens of thousands.
  const d = rig({ bakeWorkers: 4, bakeShareUnits: undefined });
  d.layer.setStatic(SET);
  await d.layer.commitAsync();
  const units = unitsOf(d.t, inputOf(d, SET));
  ok(d.f.all.length === 1 && d.primary().state.splits === 0 && d.primary().state.bakes === 1, `a small set (${units} units) spawns no helper under the default threshold`);
  ok(sameState(syncOf(SET), d.t) === "", "  and bakes as ever");
  await d.worker.destroy();
  // Enough work for two shares only: two workers of the four allowed.
  const two = rig({ bakeWorkers: 4, bakeShareUnits: Math.floor(units / 2.5) });
  two.layer.setStatic(SET);
  await two.layer.commitAsync();
  ok(two.f.all.length === 2 && two.primary().state.splits === 1 && sameState(syncOf(SET), two.t) === "", "work for two shares uses two of four workers", `${two.f.all.length} workers`);
  await two.worker.destroy();
  // Just under two shares: not split.
  const one = rig({ bakeWorkers: 4, bakeShareUnits: Math.floor(units / 2) + 1 });
  one.layer.setStatic(SET);
  await one.layer.commitAsync();
  ok(one.f.all.length === 1 && one.primary().state.splits === 0, "work for less than two shares is not split");
  await one.worker.destroy();
  // One big model among a few small ones: some ranges are empty, and their helpers never spawn.
  const lop = [{ ...scene([oak], 1, 3)[0] }, ...scene([bush], 3, 4)];
  const e = rig({ bakeWorkers: 4, bakeShareUnits: 1 });
  e.layer.setStatic(lop);
  await e.layer.commitAsync();
  ok(sameState(syncOf(lop), e.t) === "", "a set with one model outweighing the rest equals commit()", sameState(syncOf(lop), e.t));
  ok(e.f.all.length < 4 && e.helpers().every((h) => h.state.shares === 1), `  its empty ranges spawn no worker (${e.f.all.length} of 4 used)`);
  await e.worker.destroy();
  // A single instance: nothing to split, whatever the threshold.
  const solo = scene([oak], 1, 3);
  const s = rig({ bakeWorkers: 4, bakeShareUnits: 1 });
  s.layer.setStatic(solo);
  await s.layer.commitAsync();
  ok(s.f.all.length === 1 && s.primary().state.splits === 0 && sameState(syncOf(solo), s.t) === "", "one instance is baked alone");
  await s.worker.destroy();
}

console.log("the cache: a split bake is stored and found as a single one:");
{
  const store = memoryCacheStore();
  const a = rig({ bakeWorkers: 3, store });
  a.layer.setStatic(SET);
  await a.layer.commitAsync();
  ok(a.primary().state.splits === 1 && a.primary().state.bakes === 1 && a.primary().state.cachedBakes === 0, "a first visit splits the bake over three workers");
  await a.worker.destroy();
  ok(a.f.all.every((c) => c.state.terminated) && kinds(a.primary().sent, "close").length === 1 && a.helpers().every((h) => kinds(h.sent, "close").length === 0), "  destroy() lets the scene worker finish its cache write and terminates the helpers without asking");
  const b = rig({ bakeWorkers: 3, store });
  b.layer.setStatic(SET);
  await b.layer.commitAsync();
  ok(b.primary().state.cachedBakes === 1 && b.primary().state.bakes === 0 && b.primary().state.splits === 0 && b.f.all.length === 1, "a warm visit takes the bake from the cache and spawns no helper", `${b.f.all.length} workers`);
  ok(sameState(syncOf(SET), b.t) === "", "  and it equals the synchronous path's", sameState(syncOf(SET), b.t));
  await b.worker.destroy();
  const c = rig({ bakeWorkers: 1, store });
  c.layer.setStatic(SET);
  await c.layer.commitAsync();
  ok(c.primary().state.cachedBakes === 1 && c.primary().state.bakes === 0 && sameState(syncOf(SET), c.t) === "", "a single worker finds the bake a split one stored (the same key, the same bytes)");
  await c.worker.destroy();
  // And the other way round.
  const store2 = memoryCacheStore();
  const d = rig({ bakeWorkers: 1, store: store2 });
  d.layer.setStatic(SET);
  await d.layer.commitAsync();
  await d.worker.destroy();
  const e = rig({ bakeWorkers: 4, store: store2 });
  e.layer.setStatic(SET);
  await e.layer.commitAsync();
  ok(e.primary().state.cachedBakes === 1 && e.f.all.length === 1 && sameState(syncOf(SET), e.t) === "", "a worker that would split finds the bake a single one stored");
  // `cache: false` still splits, and stores nothing new.
  const before = (await store2.list()).length;
  const input = inputOf(e, SET);
  const bake = await e.worker.bake(input, { cache: false });
  ok(e.primary().state.splits === 1 && !e.worker.fromCache(bake) && sameBake(reference(e.t, input), bake) === "" && (await store2.list()).length === before, "cache: false bakes afresh, split, and stores nothing");
  await e.worker.destroy();
}

console.log("abort:");
{
  // During the shares: the scene worker's is done, the helpers' answers are held back.
  const r = rig({ bakeWorkers: 3, onSpawn: holdHelpers });
  r.layer.setStatic(SET);
  const ctl = new AbortController();
  const p = r.layer.commitAsync({ signal: ctl.signal });
  const mid = await until(() => r.f.all.length === 3 && r.helpers().every((h) => h.state.held.some((m) => m.kind === "shared")));
  ok(mid && r.t.staticSets === 0 && r.worker.pending === 1, "mid-bake: the helpers' shares are out, nothing is applied yet");
  ctl.abort();
  const err = await p.catch((e) => e);
  ok(err?.name === "AbortError" && !r.layer.baking && r.worker.pending === 0, "abort rejects with the signal's AbortError");
  ok(kinds(r.primary().sent, "cancel").some((m) => (m as { id: number }).id === (kinds(r.primary().sent, "bake")[0] as { id: number }).id) && r.helpers().every((h) => kinds(h.sent, "cancel").length === 1), "  the scene worker and every helper are told to cancel");
  for (const h of r.helpers()) h.release();
  await settle(30);
  ok(kinds(r.primary().sent, "merge").length === 0 && r.primary().state.bakes === 0 && r.t.staticSets === 0, "  the late shares are dropped: no merge, no bake, nothing applied");
  r.layer.setStatic(SET);
  await r.layer.commitAsync();
  ok(sameState(syncOf(SET), r.t) === "" && r.f.all.length === 3 && r.helpers().every((h) => kinds(h.sent, "model").length === MODELS.length), "  the next commitAsync bakes on the same helpers (no model sent twice) and equals commit()", sameState(syncOf(SET), r.t));
  await r.worker.destroy();
  // Before the split is known: aborted in the task that asked.
  const q = rig({ bakeWorkers: 3, bakeOnly: true });
  q.layer.setStatic(SET);
  const c2 = new AbortController();
  const p2 = q.layer.commitAsync({ signal: c2.signal });
  c2.abort();
  const e2 = await p2.catch((e) => e);
  await settle(30);
  ok(e2?.name === "AbortError" && q.f.all.length === 1 && q.primary().state.splits === 0 && q.primary().state.bakes === 0, "an abort before the bake starts skips it: no split, no helper");
  q.layer.setStatic(SET);
  await q.layer.commitAsync();
  ok(sameState(syncOf(SET), q.t) === "" && q.f.all.length === 3, "  and the next commitAsync splits and equals commit()");
  await q.worker.destroy();
  // After the split was named but before a helper got its share: the feed stops.
  const c3 = new AbortController();
  const s = rig({ bakeWorkers: 3, bakeOnly: true, onSpawn: (_, i) => { if (i === 1) c3.abort(); } });
  s.layer.setStatic(SET);
  const e3 = await s.layer.commitAsync({ signal: c3.signal }).catch((e) => e);
  await settle(30);
  ok(e3?.name === "AbortError" && s.f.all.length === 2 && s.helpers().every((h) => kinds(h.sent, "share").length === 0 && h.state.shares === 0) && kinds(s.primary().sent, "merge").length === 0, "an abort as the first helper spawns sends it no share and spawns no other", `${s.f.all.length} workers`);
  s.layer.setStatic(SET);
  await s.layer.commitAsync();
  ok(sameState(syncOf(SET), s.t) === "", "  and the next commitAsync equals commit()", sameState(syncOf(SET), s.t));
  await s.worker.destroy();
}

console.log("a newer commit supersedes an older one:");
{
  const other = scene(MODELS, 120, 11);
  const r = rig({ bakeWorkers: 4, onSpawn: holdHelpers });
  r.layer.setStatic(SET);
  const a = r.layer.commitAsync();
  await until(() => r.f.all.length === 4 && r.helpers().every((h) => h.state.held.some((m) => m.kind === "shared")));
  r.layer.setStatic(other);
  const b = r.layer.commitAsync();
  await until(() => r.helpers().every((h) => h.state.held.filter((m) => m.kind === "shared").length === 2));
  for (const h of r.helpers()) h.release();
  await Promise.all([a.catch(() => {}), b]);
  ok(r.t.staticSets === 1 && r.t.staticBake!.count === other.length, "only the newer set is applied", `${r.t.staticSets} sets`);
  // The same models in the same order, so the whole state compares.
  const ref = fakeTarget();
  const rl = makeInstanceLayer(ref);
  rl.setStatic(SET);
  rl.setStatic(other);
  rl.commit();
  ok(sameBake(ref.staticBake, r.t.staticBake) === "", "  and it is the bake commit() makes of it", sameBake(ref.staticBake, r.t.staticBake));
  ok(kinds(r.primary().sent, "merge").length === 1 && r.primary().state.bakes === 1, "  the older bake's shares were never merged");
  await r.worker.destroy();
}

console.log("a share that fails, a helper that dies:");
{
  // The second worker's first share gets a range outside the set.
  let broke = 0;
  const r = rig({
    bakeWorkers: 3,
    onSpawn: (ch, i) => {
      if (i !== 1) return;
      const w = ch.worker as unknown as { postMessage: (m: SceneRequest, t?: Transferable[]) => void };
      const post = w.postMessage.bind(w);
      w.postMessage = (m, t) => post(m.kind === "share" && !broke++ ? { ...m, range: { lo: 5, hi: 1e9, pack: false } } : m, t);
    },
  });
  r.layer.setStatic(SET);
  const err = await r.layer.commitAsync().catch((e) => e);
  ok(err instanceof Error && /bakePlacementShare/.test(err.message) && !r.layer.baking && r.worker.pending === 0 && r.t.staticSets === 0, "a failing share rejects the bake with its error", String(err));
  await settle(30);
  ok(kinds(r.primary().sent, "merge").length === 0 && kinds(r.primary().sent, "cancel").length >= 1, "  the scene worker is told to drop its share; nothing is merged");
  r.layer.setStatic(SET);
  await r.layer.commitAsync();
  ok(sameState(syncOf(SET), r.t) === "" && r.f.all.length === 3, "  the next commitAsync bakes on the same workers and equals commit()", sameState(syncOf(SET), r.t));
  await r.worker.destroy();
  // A helper dies with its share out.
  let holding = true;
  const d = rig({ bakeWorkers: 3, onSpawn: (ch, i) => { if (holding) holdHelpers(ch, i); } });
  d.layer.setStatic(SET);
  const p = d.layer.commitAsync();
  await until(() => d.f.all.length === 3 && d.helpers().every((h) => h.state.held.some((m) => m.kind === "shared")));
  holding = false;
  d.f.all[1].worker.onerror?.({ message: "boom" } as ErrorEvent);
  const e2 = await p.catch((e) => e);
  ok(e2 instanceof Error && e2.message === "boom" && d.f.all[1].state.terminated && !d.f.all[0].state.terminated, "a helper that dies rejects the bake and is terminated; the scene worker lives");
  d.f.all[2].release();
  d.layer.setStatic(SET);
  await d.layer.commitAsync();
  ok(sameState(syncOf(SET), d.t) === "" && d.f.all.length === 4 && kinds(d.f.all[3].sent, "model").length === MODELS.length, "  the next commitAsync spawns a new helper, sends it the models, and equals commit()", `${d.f.all.length} workers`);
  await d.worker.destroy();
}

console.log("destroy, and the helpers' idle release:");
{
  const r = rig({ bakeWorkers: 3, onSpawn: holdHelpers });
  r.layer.setStatic(SET);
  const p = r.layer.commitAsync();
  await until(() => r.f.all.length === 3 && r.helpers().every((h) => h.state.held.length > 0));
  const d = r.worker.destroy();
  const err = await p.catch((e) => e);
  await d;
  ok(err instanceof Error && /destroyed/.test(err.message) && r.f.all.every((c) => c.state.terminated) && kinds(r.primary().sent, "close").length === 0, "destroy() during a split bake rejects it and terminates every worker at once");
  // Released at once.
  const z = rig({ bakeWorkers: 3, bakeIdleMs: 0 });
  z.layer.setStatic(SET);
  await z.layer.commitAsync();
  ok(z.helpers().length === 2 && z.helpers().every((h) => h.state.terminated) && !z.primary().state.terminated, "bakeIdleMs 0: the helpers are terminated as the bake settles, the scene worker stays");
  const other = scene(MODELS, 120, 11);
  z.layer.setStatic(other);
  await z.layer.commitAsync();
  ok(z.f.all.length === 5 && z.f.all.slice(3).every((h) => kinds(h.sent, "model").length === MODELS.length) && z.t.staticBake!.count === other.length, "  the next split bake spawns helpers again and sends them the models", `${z.f.all.length} workers`);
  await z.worker.destroy();
  // Released after a while; kept while a bake is in flight.
  const w = rig({ bakeWorkers: 3, bakeIdleMs: 40 });
  w.layer.setStatic(SET);
  await w.layer.commitAsync();
  ok(w.helpers().every((h) => !h.state.terminated), "bakeIdleMs 40: the helpers outlive the bake");
  await new Promise((res) => setTimeout(res, 20));
  w.layer.setStatic(other);
  await w.layer.commitAsync();
  ok(w.f.all.length === 3 && w.helpers().every((h) => !h.state.terminated), "  a bake within the idle time reuses them");
  await new Promise((res) => setTimeout(res, 90));
  ok(w.helpers().every((h) => h.state.terminated) && !w.primary().state.terminated, "  and they are terminated once idle that long");
  await w.worker.destroy();
  // Kept for good.
  const k = rig({ bakeWorkers: 2, bakeIdleMs: Infinity });
  k.layer.setStatic(SET);
  await k.layer.commitAsync();
  await new Promise((res) => setTimeout(res, 30));
  ok(!k.f.all[1].state.terminated, "bakeIdleMs Infinity keeps them");
  await k.worker.destroy();
  ok(k.f.all.every((c) => c.state.terminated), "  until destroy()");
}

console.log(`\n${checks - failed}/${checks} scene split checks passed`);
if (failed) process.exit(1);
