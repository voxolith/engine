// Headless checks for the scene worker: model encoding and placement on one worker.
//   bun tools/verify-scene.ts
//
// The instance layer with `worker` against a fake target that adds models the renderer's way
// (its real `encodeModel` into a real `BrickPool`, `adopt`ing encodings as `addEncodedModel`
// does, part boxes keyed by identity) and bakes with the real `bakePlacement`; a real
// `serveScene` worker side behind a fake message channel that structured-clones every message
// with its transfer list, as postMessage does (so a transferred buffer is detached on the
// sender). Covered: the applied state (pool bytes, each model's index, placement model and the
// bake) equals the synchronous path's; one reservation for the batch before the adds, and adds
// paced by the budget; sub-cells never sent back (keys only); the upload phase in bricks, held
// short until each add; sparse models sent in chunks, the source untouched; supersede (early and
// late), abort, a sync commit during encodes, drop and re-add, a failing worker, and shared part
// boxes restored after transfer; scaled models (k = 3, kept and sent whole) bake on the worker as
// on the main thread, their scale travelling with the keys. A target that adds in slices
// (`beginEncodedModel`): a big model spans several paced steps and equals the whole-add path;
// supersede and abort mid-model cancel it, a sync commit finishes it; the upload phase stays truthful.


import { bakePlacement, encodeModel } from "@voxolith/renderer/core";
import { makeInstanceLayer, type InstancePlacement } from "../src/instances";
import { makeSceneWorker, type SceneRequest } from "../src/worker/scene";
import { LOAD_PHASES, makeLoadTracker, type LoadEvent } from "../src/load";
import { box, channel, dense, eq, fakeTarget, kinds, phase, sameBake, sameState, scene, settle, slicedTarget, sparseBox, syncOf, tick, units } from "./scene-fakes";
import { memoryCacheStore } from "../src/worker/cache";
let failed = 0, checks = 0;
const ok = (c: boolean, m: string, d = "") => {
  checks++;
  if (c) console.log(`  ✓ ${m}`);
  else { failed++; console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); }
};

const tree = box(10, 24, 10, 0.3, 3), rock = box(14, 8, 12, 0.6, 7), bush = box(6, 6, 6, 0.8, 11);
const oak = sparseBox(40, 33, 36, 0.05, 5); // 5 x 5 x 5 bricks, sent in chunks of 7

console.log("encoded on the worker = uploaded on the main thread:");
{
  const set = scene([tree, oak, rock, bush], 300, 5);
  const syncT = syncOf(set);
  const load = makeLoadTracker();
  const events: LoadEvent[] = [];
  const addsAt: number[] = [];
  const ch = channel();
  const worker = makeSceneWorker({ spawn: ch.spawn, chunkBricks: 7 });
  const t = fakeTarget();
  load.on((e) => { if (e.phase === LOAD_PHASES.upload) events.push({ ...e }); });
  let paces = 0;
  const layer = makeInstanceLayer(t, { load, worker, uploadBudgetMs: 0, pace: async () => { paces++; t.log.push("pace"); await tick(); } });
  const before = oak.sparse!.bricks.get(oak.sparse!.bricks.keys().next().value!)!;
  layer.setStatic(set);
  ok(t.adds === 0 && t.encodedAdds === 0 && ch.sent.length === 0, "setStatic returns at once: nothing added, nothing posted yet");
  ok(layer.uploads === 4 && phase(load)?.busy === true && phase(load)?.total === [tree, oak, rock, bush].reduce((n, m) => n + units(m), 0), "  four encodes asked for; the upload phase counts their bricks", JSON.stringify(phase(load)));
  const done = layer.commitAsync();
  ok(layer.baking && t.staticSets === 0 && t.dynamicCalls === 1, "commitAsync: the moving set is sent, the static set is in flight");
  load.on((e) => { if (e.phase === LOAD_PHASES.upload && t.encodedAdds === 0) addsAt.push(e.done); });
  await done;
  ok(t.adds === 0 && t.encodedAdds === 4, "every model is added from its encoding", `addModel ${t.adds}, addEncodedModel ${t.encodedAdds}`);
  const diff = sameState(syncT, t);
  ok(diff === "", "the pool, every model's index and placement model, and the bake equal the synchronous path's", diff);
  const firstAdd = t.log.indexOf("addEncoded");
  ok(t.log.filter((x) => x.startsWith("reserve")).length === 1 && t.log.indexOf("reserve:4") >= 0 && t.log.indexOf("reserve:4") < firstAdd, "one reservation for the batch of four, before the first add", t.log.join());
  ok(paces === 4 && t.log.slice(firstAdd - 1).join() === "pace,addEncoded,pace,addEncoded,pace,addEncoded,pace,addEncoded,placed", "  with a zero budget, one add per paced frame", t.log.join());
  ok(kinds(ch.sent, "model").length === 0 && kinds(ch.sent, "keys").length === 4, "placement registration sends only keys: no sub-cells go back to the worker");
  ok(kinds(ch.sent, "chunk").length === Math.ceil(oak.sparse!.bricks.size / 7), "the sparse model travels in chunks of chunkBricks", `${kinds(ch.sent, "chunk").length} chunks for ${oak.sparse!.bricks.size} bricks`);
  ok(before.length === 512 && oak.sparse!.bricks.get(oak.sparse!.bricks.keys().next().value!) === before, "  and the source's bricks are left as they were (copied, not transferred)");
  const total = phase(load)!.total;
  ok(Math.max(...addsAt, 0) <= total - 4 && Math.max(...addsAt, 0) === total - 4, "the encodes' progress counts up to one short of each model before its add", `${Math.max(...addsAt)} of ${total}`);
  ok(events.every((e, i) => i === 0 || e.done >= events[i - 1].done) && !phase(load)!.busy && phase(load)!.done === total, "  never decreasing, and done === total once all are added");
  ok(layer.models.size === 4 && layer.uploads === 0 && !layer.baking, "the library holds the four models; nothing is pending");

  layer.setStatic(scene([tree, bush], 40, 6));
  await layer.commitAsync();
  ok(ch.state.encodes === 4 && kinds(ch.sent, "keys").length === 4, "a set of known models encodes and registers nothing again");
  worker.destroy();
}

console.log("adds paced by the budget:");
{
  const set = scene([tree, rock, bush], 60, 2);
  const ch = channel();
  const worker = makeSceneWorker({ spawn: ch.spawn });
  const t = fakeTarget();
  let paces = 0;
  const layer = makeInstanceLayer(t, { worker, pace: async () => { paces++; await tick(); } });
  layer.setStatic(set);
  await layer.commitAsync();
  ok(paces === 0 && t.encodedAdds === 3, "small models all fit one frame's default budget", `${paces} paces`);
  ok(sameState(syncOf(set), t) === "", "  and equal the synchronous path's");
  worker.destroy();
}

console.log("supersede:");
{
  const load = makeLoadTracker();
  const ch = channel();
  const worker = makeSceneWorker({ spawn: ch.spawn, chunkBricks: 7 });
  const t = fakeTarget();
  const layer = makeInstanceLayer(t, { load, worker });
  layer.setStatic(scene([tree, oak, rock], 50, 1));
  const a = layer.commitAsync();
  layer.setStatic(scene([tree, bush], 60, 2)); // before anything was sent
  const b = layer.commitAsync();
  await Promise.all([a, b]);
  ok(t.encodedAdds === 2 && t.adds === 0 && ch.state.encodes === 2, "superseding at once: the dropped models are never encoded or added", `encoded ${ch.state.encodes}, added ${t.encodedAdds}`);
  ok(kinds(ch.sent, "chunk").length === 0, "  the sparse one's bricks were never sent");
  ok(sameState(syncOf(scene([tree, bush], 60, 2)), t) === "", "  the result equals a synchronous commit of the newer set; both commits resolve");
  ok(!phase(load)!.busy && phase(load)!.total === units(tree) + units(bush) && phase(load)!.done === phase(load)!.total, "  the dropped encodes leave the upload phase", JSON.stringify(phase(load)));

  // Late: the encodes have landed (kept on the worker) when the set is replaced.
  ch.state.hold = true;
  layer.setStatic(scene([rock, oak, bush], 70, 3));
  const c = layer.commitAsync();
  await settle(40);
  ok(ch.state.held.some((m) => m.kind === "encoded"), "late supersede: the encodes ran on the worker");
  layer.setStatic(scene([tree], 20, 4));
  const d = layer.commitAsync();
  ch.release();
  await Promise.all([c, d]);
  await settle();
  ok(t.encodedAdds === 2 && t.staticBake!.count === 20, "  their late results are dropped and the newer set is applied");
  ok(kinds(ch.sent, "cancel").length >= 2, "  and the worker is told to forget what it kept of them", `${kinds(ch.sent, "cancel").length} cancels`);
  ok(!phase(load)!.busy && phase(load)!.done === phase(load)!.total && phase(load)!.total === units(tree) + units(bush), "  the upload phase ends as if they were never asked for", JSON.stringify(phase(load)));
  worker.destroy();
}

console.log("abort, and a sync commit during encodes:");
{
  const set = scene([tree, oak, rock], 80, 7);
  const ch = channel();
  const worker = makeSceneWorker({ spawn: ch.spawn, chunkBricks: 7 });
  const t = fakeTarget();
  const layer = makeInstanceLayer(t, { worker });
  ch.state.hold = true;
  layer.setStatic(set);
  const ctl = new AbortController();
  const p = layer.commitAsync({ signal: ctl.signal });
  await settle(40);
  ctl.abort();
  const e = await p.catch((err) => err);
  ok(e?.name === "AbortError" && !layer.baking, "abort rejects with the signal's AbortError and drops the set");
  ch.release();
  await settle();
  ok(t.encodedAdds === 0 && t.staticSets === 0 && layer.uploads === 3, "  the encodes carry on and land, but nothing is added");
  layer.commit();
  ok(t.adds === 0 && t.encodedAdds === 3 && t.log.indexOf("reserve:3") === 0, "  the next commit() adds the landed encodings (one reservation), uploading nothing", t.log.join());
  ok(sameState(syncOf(set), t) === "", "  and equals the synchronous path's");
  worker.destroy();

  const load = makeLoadTracker();
  const ch2 = channel();
  const w2 = makeSceneWorker({ spawn: ch2.spawn, chunkBricks: 7 });
  const t2 = fakeTarget();
  const l2 = makeInstanceLayer(t2, { load, worker: w2 });
  l2.setStatic(set);
  l2.commit(); // encodes asked for, none landed
  ok(t2.adds === 3 && t2.encodedAdds === 0 && sameState(syncOf(set), t2) === "", "commit() right after setStatic uploads on the main thread, as without a worker");
  ok(!phase(load)!.busy && phase(load)!.done === phase(load)!.total && phase(load)!.total === [tree, oak, rock].reduce((n, m) => n + units(m), 0), "  each model's upload task completes there", JSON.stringify(phase(load)));
  await settle(40);
  ok(t2.encodedAdds === 0 && t2.adds === 3, "  the cancelled encodes add nothing when they would have landed");

  // A model id asked for directly while its encode has landed: added from the encoding.
  const ch3 = channel();
  const w3 = makeSceneWorker({ spawn: ch3.spawn });
  const t3 = fakeTarget();
  const l3 = makeInstanceLayer(t3, { worker: w3 });
  l3.setStatic(scene([rock], 5, 1));
  await settle(20);
  const id = l3.models.id(rock);
  ok(t3.encodedAdds === 1 && t3.adds === 0 && l3.models.id(rock) === id && l3.uploads === 0, "models.id of a landed encoding adds it (no second encode or upload)");
  await l3.commitAsync();
  ok(t3.staticBake!.count === 5 && t3.encodedAdds === 1, "  and the commit that follows uses it");
  w2.destroy();
  w3.destroy();
}

console.log("drop and re-add:");
{
  const set = scene([tree, rock, bush], 120, 8);
  const ch = channel();
  const worker = makeSceneWorker({ spawn: ch.spawn });
  const t = fakeTarget();
  const layer = makeInstanceLayer(t, { worker });
  layer.setStatic(set);
  await layer.commitAsync();
  const rockKey = t.placementModel(layer.models.id(rock))!.key;
  layer.models.release(rock);
  ok(ch.sent.some((m) => m.kind === "drop" && m.key === rockKey) && !layer.models.has(rock), "releasing a model drops its key on the worker");
  layer.setStatic(set);
  await layer.commitAsync();
  const keys = kinds(ch.sent, "keys") as Extract<SceneRequest, { kind: "keys" }>[];
  const newKey = t.placementModel(layer.models.id(rock))!.key;
  ok(ch.state.encodes === 4 && keys.length === 4 && keys.at(-1)!.keys.key === newKey && newKey !== rockKey, "adding it again encodes it once more and registers the new key");
  const syncT = fakeTarget();
  const sl = makeInstanceLayer(syncT);
  sl.setStatic(set);
  sl.commit();
  sl.models.release(rock);
  sl.setStatic(set);
  sl.commit();
  ok(sameState(syncT, t) === "", "  the result equals the synchronous path's with the same release", sameState(syncT, t));

  // Released while its encode is in flight.
  const load = makeLoadTracker();
  const ch2 = channel();
  const w2 = makeSceneWorker({ spawn: ch2.spawn });
  const t2 = fakeTarget();
  const l2 = makeInstanceLayer(t2, { load, worker: w2 });
  l2.setStatic(scene([tree, rock], 10, 1));
  l2.models.release(rock);
  ok(l2.uploads === 1 && phase(load)!.total === units(tree), "releasing a model with an encode in flight cancels it and takes it off the phase", JSON.stringify(phase(load)));
  await l2.commitAsync();
  ok(t2.encodedAdds === 2 && t2.adds === 0 && t2.staticBake!.count === 10, "  a committed set that still names it encodes it again", `encoded ${t2.encodedAdds}, addModel ${t2.adds}`);
  worker.destroy();
  w2.destroy();
}

console.log("failure and fallbacks:");
{
  const ch = channel();
  const worker = makeSceneWorker({ spawn: ch.spawn });
  const t = fakeTarget();
  const layer = makeInstanceLayer(t, { worker });
  ch.state.hold = true;
  layer.setStatic(scene([tree, rock], 30, 1));
  const p = layer.commitAsync();
  await settle();
  (ch.worker as { onerror: ((ev: ErrorEvent) => void) | null }).onerror?.({ message: "worker crashed" } as ErrorEvent);
  const e = await p.catch((err) => err.message);
  ok(e === "worker crashed" && !layer.baking && t.staticSets === 0, "a failing worker rejects commitAsync", String(e));
  layer.commit();
  ok(t.staticSets === 1 && t.adds === 2 && t.staticBake!.count === 30, "  the set counts as unsent: commit() uploads and places it synchronously");
  ch.release();
  const bad = await worker.encode({ size: { x: 2, y: 2, z: 2 }, parts: new Uint8Array(8) }).catch((err) => err.message);
  ok(typeof bad === "string" && bad.includes("parts need a dense model"), "an encode that throws on the worker rejects with its message", String(bad));
  await worker.destroy();
  ok(ch.state.terminated && (await worker.encode({ size: { x: 1, y: 1, z: 1 }, data: new Uint8Array(1) }).catch((err) => err.message)) === "scene worker destroyed", "destroy terminates the worker; later encodes reject");

  const bare = fakeTarget() as Partial<Fake>;
  delete bare.addEncodedModel;
  const ch2 = channel();
  const w2 = makeSceneWorker({ spawn: ch2.spawn });
  const old = makeInstanceLayer(bare as unknown as Fake, { worker: w2 });
  old.setStatic(scene([tree, rock], 20, 3));
  ok(bare.adds === 2, "a target without addEncodedModel uploads at setStatic, as before");
  await old.commitAsync();
  ok(kinds(ch2.sent, "encode").length === 0 && kinds(ch2.sent, "model").length === 2 && bare.staticBake!.count === 20, "  and only bakes on the worker");
  w2.destroy();

  const plain = fakeTarget();
  const noWorker = makeInstanceLayer(plain);
  noWorker.setStatic(scene([tree], 10, 1));
  ok(plain.adds === 1, "without a worker, setStatic uploads at once");
  const r = noWorker.commitAsync();
  ok(plain.staticSets === 1 && !noWorker.baking, "  and commitAsync is commit()");
  await r;
}

console.log("shared part boxes:");
{
  const ch = channel();
  const worker = makeSceneWorker({ spawn: ch.spawn });
  const t = fakeTarget();
  const size = { x: 8, y: 12, z: 6 };
  const data = dense(8, 12, 6, 0.7, 4).map((v) => (v ? 1 : 0));
  const parts = data.map((_, i) => (Math.floor(i / 48) % 12 < 6 ? 0 : 1));
  const joints = [{ parent: -1, at: [4, 0, 3] as const }, { parent: 0, at: [4, 6, 3] as const }];
  const boxes = new Int32Array([0, 0, 0, 7, 5, 5, 0, 6, 0, 7, 11, 5]);
  const wounded = data.slice();
  wounded.fill(0, 0, 40);
  const [a, b, c] = await Promise.all([
    worker.encode({ size, data, parts, joints, partBoxes: boxes }, { keepPlacement: true }),
    worker.encode({ size, data: wounded, parts, joints, partBoxes: boxes }, { keepPlacement: true }),
    worker.encode({ size, data, parts, joints }, { keepPlacement: true }),
  ]);
  ok(a.partBoxes === boxes && b.partBoxes === boxes, "after transfer, each result carries the source's own boxes object again");
  ok(!!c.partBoxes && c.partBoxes !== boxes, "  a source without boxes gets its computed ones");
  const ia = t.addEncodedModel(a), ib = t.addEncodedModel(b), ic = t.addEncodedModel(c);
  const [pa, pb, pc] = [ia, ib, ic].map((i) => t.placementModel(i)!);
  ok(pa.poseKey !== undefined && pa.poseKey === pb.poseKey && pc.poseKey !== pa.poseKey, "  so the copies share a pose key, and the other does not");
  for (const [e, p] of [[a, pa], [b, pb], [c, pc]] as const) worker.registerEncoded(e, p);
  const keys = kinds(ch.sent, "keys") as Extract<SceneRequest, { kind: "keys" }>[];
  ok(keys.length === 3 && keys[0].keys.poseKey === keys[1].keys.poseKey && kinds(ch.sent, "model").length === 0, "registering sends the keys only, with the shared pose key");
  const direct = encodeModel({ size, data, parts, joints, partBoxes: boxes });
  ok(eq(direct.blocks, a.blocks) && eq(direct.voxels8, a.voxels8) && eq(direct.subs, a.subs) && eq(direct.partTop, a.partTop), "  and the worker's encoding equals encodeModel's on the main thread");
  const list: InstancePlacement[] = [ia, ib, ic].map((model, i) => ({ model, x: 20 + i * 20, y: 10, z: 20, base: 256, parts: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]) }));
  const baked = await worker.bake(t.placementInput(list)).catch((err) => err);
  ok(!(baked instanceof Error) && baked.count === 3, "a bake over them runs from the kept encodings", String(baked instanceof Error ? baked.message : baked.count));
  worker.destroy();
}

console.log("scaled models (ModelOptions.scale):");
{
  const ch = channel();
  const worker = makeSceneWorker({ spawn: ch.spawn });
  const t = fakeTarget();
  const K = 3;
  const srcOf = (m: typeof rock) => ({ size: m.size, data: m.data });
  // Kept on the worker (keys only travel) and sent whole (placementModelOf), each at k = 3,
  // beside the same rock at scale 1.
  const [kept, whole, plain] = await Promise.all([
    worker.encode(srcOf(rock), { keepPlacement: true }),
    worker.encode(srcOf(tree)),
    worker.encode(srcOf(rock), { keepPlacement: true }),
  ]);
  const ik = t.addEncodedModel(kept, { scale: K }), iw = t.addEncodedModel(whole, { scale: K }), ip = t.addEncodedModel(plain);
  const [pk, pw, pp] = [ik, iw, ip].map((i) => t.placementModel(i)!);
  ok(pk.scale === K && pw.scale === K && pp.scale === undefined, "the fake target records the scale as the renderer does (left out at 1)");
  worker.registerEncoded(kept, pk);
  worker.registerEncoded(whole, pw);
  worker.registerEncoded(plain, pp);
  const keys = kinds(ch.sent, "keys") as Extract<SceneRequest, { kind: "keys" }>[];
  const models = kinds(ch.sent, "model") as Extract<SceneRequest, { kind: "model" }>[];
  ok(keys.length === 2 && keys[0].keys.scale === K && !("scale" in keys[1].keys), "registering a kept encoding sends its scale with the keys; a scale-1 one sends none", JSON.stringify(keys.map((k) => k.keys)));
  ok(models.length === 1 && models[0].model.scale === K, "  one sent whole carries its scale too");
  let s = 17;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const list: InstancePlacement[] = Array.from({ length: 24 }, (_, i) => {
    const model = [ik, iw, ip][i % 3], m = [rock, tree, rock][i % 3], k = i % 3 === 2 ? 1 : K;
    return { model, x: 40 + r() * 170, y: 10 + r() * 40, z: 40 + r() * 170, yaw: i % 4 === 0 ? (i % 8) * Math.PI / 2 : r() * 6.28, mirror: r() < 0.3, base: 256, anchor: m.anchor.map((a) => a * k) as [number, number, number] };
  });
  const input = t.placementInput(list);
  const byKey = new Map([pk, pw, pp].map((p) => [p.key, p]));
  const sync = bakePlacement(input, (key) => byKey.get(key));
  const baked = await worker.bake(input);
  const diff = sameBake(sync, baked);
  ok(diff === "", "a bake of k = 3 models on the worker equals bakePlacement on the main thread", diff);
  const unscaled = bakePlacement(input, (key) => { const p = byKey.get(key)!; const { scale: _, ...rest } = p; return rest; });
  ok(sameBake(sync, unscaled) !== "", "  (and differs from the same input baked at scale 1, so the scale did reach the worker)");
  worker.destroy();
}

console.log("scaled placements (EntityPlacement.scale):");
{
  // The same rock at scales 3 and 1, a tree at 3 and a bush at 1.
  const K = 3;
  let s = 29;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const kinds3 = [[rock, K], [tree, K], [rock, 1], [bush, 1]] as const;
  const set = Array.from({ length: 48 }, (_, i) => {
    const [model, k] = kinds3[i % 4];
    return { model, scale: k === 1 && i % 8 === 2 ? undefined : k, x: 30 + r() * 180, y: 10 + r() * 40, z: 30 + r() * 180, yaw: i % 5 === 0 ? (i % 4) * Math.PI / 2 : r() * 6.28, mirror: r() < 0.3, base: 256 };
  });
  // What the renderer draws, by hand: each (model, scale) added once, models in order of first
  // sight with all their scales together; anchors at k × the model's.
  const hand = fakeTarget();
  const handIds = new Map<string, number>();
  const idOfHand = (m: typeof rock, k: number) => {
    const key = `${[rock, tree, bush].indexOf(m)}@${k}`;
    let id = handIds.get(key);
    if (id === undefined) handIds.set(key, (id = hand.addModel({ size: m.size, data: m.data }, k === 1 ? undefined : { scale: k })));
    return id;
  };
  for (const [m, k] of [[rock, K], [rock, 1], [tree, K], [bush, 1]] as const) idOfHand(m, k);
  hand.setInstances(set.map((p) => {
    const k = p.scale ?? 1;
    return { model: idOfHand(p.model, k), x: p.x, y: p.y, z: p.z, yaw: p.yaw, mirror: p.mirror, base: p.base, anchor: p.model.anchor.map((a) => a * k) as [number, number, number] };
  }));
  const syncT = syncOf(set);
  ok(sameBake(hand.staticBake, syncT.staticBake) === "", "the layer's sync path draws each model at its scale, anchored at k × anchor", sameBake(hand.staticBake, syncT.staticBake));
  ok(syncT.models.filter(Boolean).length === 4 && syncT.adds === 4, "  one renderer model per (model, scale): the rock twice");

  const load = makeLoadTracker();
  const ch = channel();
  const worker = makeSceneWorker({ spawn: ch.spawn });
  const t = fakeTarget();
  const layer = makeInstanceLayer(t, { load, worker });
  layer.setStatic(set);
  ok(layer.uploads === 3 && phase(load)!.total === units(rock) + units(tree) + units(bush), "setStatic asks for one encode per model, whatever its scales", `${layer.uploads} uploads`);
  await layer.commitAsync();
  const diff = sameState(syncT, t);
  ok(diff === "", "encoded and baked on the worker = the synchronous path (pool, models, bake)", diff);
  ok(ch.state.encodes === 3 && t.encodedAdds === 4 && t.adds === 0, "  the rock is encoded once and added from that encoding at both scales", `${ch.state.encodes} encodes, ${t.encodedAdds} adds`);
  const keyMsgs = kinds(ch.sent, "keys") as Extract<SceneRequest, { kind: "keys" }>[];
  const multi = keyMsgs.find((m) => Array.isArray(m.keys));
  ok(keyMsgs.length === 3 && kinds(ch.sent, "model").length === 0 && Array.isArray(multi?.keys) && (multi!.keys as { scale?: number }[]).map((k) => k.scale ?? 1).sort().join() === "1,3", "  registered with keys only; the rock's two keys (scales 1 and 3) in one message", JSON.stringify(keyMsgs.map((m) => m.keys)));
  ok(t.log.includes(`reserve:4`), "  and the reservation counts it once per scale", t.log.join());
  ok(!phase(load)!.busy && phase(load)!.done === phase(load)!.total, "  the upload phase completes");
  ok(layer.models.has(rock, K) && layer.models.has(rock) && layer.models.has(tree, K) && !layer.models.has(tree) && layer.models.size === 4, "models.has answers per scale; size counts renderer models");
  const rock3 = layer.models.id(rock, K);
  ok(layer.models.scaleOf(rock3) === K && layer.models.scaleOf(layer.models.id(rock)) === 1 && t.encodedAdds === 4, "models.id(model, scale) returns the layer's id at that scale; scaleOf reads it back");
  let err = "";
  try {
    layer.setDynamic([{ model: rock3, x: 50, y: 10, z: 50, base: 256, parts: new Float32Array(12) }]);
  } catch (e) {
    err = (e as Error).message;
  }
  ok(err.includes("scale 3") && err.includes("cannot be posed"), "a posed dynamic placement of a scaled model throws a clear error", err);
  layer.setDynamic([{ model: rock3, x: 50, y: 10, z: 50, base: 256 }]);
  ok(true, "  an unposed one is fine");
  let bad = "";
  try {
    layer.setStatic([{ model: rock, x: 0, y: 0, z: 0, base: 256, scale: 2.5 }]);
  } catch (e) {
    bad = (e as Error).message;
  }
  ok(bad.includes("integer"), "setStatic rejects a scale that is not an integer >= 1", bad);
  worker.destroy();

  // A later scale of a model already added: encoded again (the encoding was not kept).
  const ch2 = channel();
  const w2 = makeSceneWorker({ spawn: ch2.spawn });
  const t2 = fakeTarget();
  const l2 = makeInstanceLayer(t2, { worker: w2 });
  l2.setStatic([{ model: rock, x: 40, y: 10, z: 40, base: 256 }]);
  await l2.commitAsync();
  l2.setStatic([{ model: rock, x: 40, y: 10, z: 40, base: 256 }, { model: rock, x: 90, y: 10, z: 90, base: 256, scale: 2 }]);
  await l2.commitAsync();
  const syncT2 = fakeTarget();
  const sl2 = makeInstanceLayer(syncT2);
  sl2.setStatic([{ model: rock, x: 40, y: 10, z: 40, base: 256 }]);
  sl2.commit();
  sl2.setStatic([{ model: rock, x: 40, y: 10, z: 40, base: 256 }, { model: rock, x: 90, y: 10, z: 90, base: 256, scale: 2 }]);
  sl2.commit();
  ok(ch2.state.encodes === 2 && sameState(syncT2, t2) === "", "a scale added later encodes the model again and equals the sync path", sameState(syncT2, t2));
  w2.destroy();
}

console.log("coarse first, then one swap to fine:");
{
  // Coarse placeholders (built 3x coarser, drawn at scale 3) and their fine models (scale 1).
  const K = 3;
  const coarseTree = box(4, 8, 4, 0.5, 21), coarseRock = box(5, 3, 4, 0.7, 22);
  const fineTree = box(12, 24, 12, 0.3, 23), fineRock = sparseBox(15, 9, 12, 0.5, 24);
  let s = 41;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const sites = Array.from({ length: 60 }, (_, i) => ({ i, x: 20 + r() * 200, y: 10 + r() * 30, z: 20 + r() * 200, yaw: r() * 6.28, base: 256 + (i % 2) * 8 }));
  const coarse = sites.map((p) => ({ ...p, model: p.i % 2 ? coarseRock : coarseTree, scale: K }));
  const fine = sites.map((p) => ({ ...p, model: p.i % 2 ? fineRock : fineTree }));

  const load = makeLoadTracker();
  const ch = channel();
  const worker = makeSceneWorker({ spawn: ch.spawn, chunkBricks: 7 });
  const t = fakeTarget();
  const layer = makeInstanceLayer(t, { load, worker });
  layer.setStatic(coarse);
  await layer.commitAsync();
  const coarseBake = t.staticBake!;
  const coarseIds = [layer.models.id(coarseTree, K), layer.models.id(coarseRock, K)];
  // (asking for their ids pinned them; a second layer below checks the unpinned case)
  ok(t.staticSets === 1 && coarseBake.count === 60 && sameBake(coarseBake, syncOf(coarse).staticBake) === "", "the coarse set draws, equal to the synchronous path's");

  const l2t = fakeTarget();
  const ch2 = channel();
  const w2 = makeSceneWorker({ spawn: ch2.spawn, chunkBricks: 7 });
  const load2 = makeLoadTracker();
  const l2 = makeInstanceLayer(l2t, { load: load2, worker: w2 });
  l2.setStatic(coarse);
  await l2.commitAsync();
  const cIds = [0, 1].filter((id) => l2t.models[id]);
  const cKeys = cIds.map((id) => l2t.placementModel(id)!.key);
  const drawn = l2t.staticBake!;
  ch2.state.hold = true;
  l2.setStatic(fine);
  const swapped = l2.commitAsync();
  await settle(40);
  ok(l2t.staticBake === drawn && l2t.staticSets === 1 && cIds.every((id) => l2t.models[id]) && l2.baking, "while the fine models encode, the coarse set keeps drawing and its models stay");
  ok(phase(load2)!.busy && phase(load2)!.done < phase(load2)!.total, "  the upload phase counts the fine encodes, not done", JSON.stringify(phase(load2)));
  ch2.release();
  // Let the encodes land and the adds run, then hold the bake.
  for (let i = 0; i < 200 && !kinds(ch2.sent, "bake").length; i++) await tick();
  ch2.state.hold = true;
  await settle(40);
  const pl = phase(load2, LOAD_PHASES.placement)!;
  ok(l2t.staticBake === drawn && cIds.every((id) => l2t.models[id]) && l2t.encodedAdds === 4, "  fine models added, bake in flight: still the coarse set, coarse models still held", `${l2t.encodedAdds} adds`);
  ok(pl.busy && pl.total === 120 && pl.done < pl.total, "  the placement phase has the fine set's task open, below its total", JSON.stringify(pl));
  ch2.release();
  await swapped;
  const placedAt = l2t.log.lastIndexOf("placed");
  const removes = l2t.log.map((x, i) => [x, i] as const).filter(([x]) => x.startsWith("remove:"));
  const ref = fakeTarget();
  const rl = makeInstanceLayer(ref);
  rl.setStatic(coarse);
  rl.commit();
  rl.setStatic(fine);
  rl.commit();
  ok(sameState(ref, l2t) === "" && l2t.staticSets === 2, "the fine set is applied in one swap, equal to the synchronous path's coarse-then-fine", sameState(ref, l2t));
  ok(removes.length === 2 && removes.every(([, i]) => i > placedAt) && cIds.every((id) => !l2t.models[id]), "  the coarse models are removed only after the apply, both of them", l2t.log.slice(-6).join());
  ok(!l2.models.has(coarseTree, K) && !l2.models.has(coarseRock, K) && l2.models.size === 2, "  the library holds only the fine models");
  const drops = (kinds(ch2.sent, "drop") as Extract<SceneRequest, { kind: "drop" }>[]).map((m) => m.key);
  ok(cKeys.every((k) => drops.includes(k)), "  and their keys are dropped on the worker");
  const up = phase(load2)!, pl2 = phase(load2, LOAD_PHASES.placement)!;
  const allUnits = [coarseTree, coarseRock, fineTree, fineRock].reduce((n, m) => n + units(m), 0);
  ok(!up.busy && up.total === allUnits && up.done === allUnits, "  upload counted every model once, coarse and fine, and ends complete", JSON.stringify(up));
  ok(!pl2.busy && pl2.total === 120 && pl2.done === 120, "  placement counted both sets (60 + 60) and ends complete", JSON.stringify(pl2));
  w2.destroy();

  // The pinned layer: models whose ids the host asked for survive the swap.
  layer.setStatic(fine);
  await layer.commitAsync();
  ok(coarseIds.every((id) => t.models[id]) && layer.models.has(coarseTree, K), "models the host asked for by id (models.id) are not released by a swap");
  layer.models.release(coarseTree, K);
  ok(!t.models[coarseIds[0]] && t.models[coarseIds[1]], "  models.release(model, scale) frees just that one");
  layer.models.release(coarseRock);
  ok(!t.models[coarseIds[1]], "  models.release(model) frees it at every scale");
  worker.destroy();

  // Sync commits swap the same way; keepUnused keeps everything.
  const st = fakeTarget();
  const sl = makeInstanceLayer(st);
  sl.setStatic(coarse);
  sl.commit();
  sl.setStatic(fine);
  sl.commit();
  const sp = st.log.lastIndexOf("placed");
  ok(st.log.filter((x) => x.startsWith("remove:")).length === 2 && st.log.findIndex((x) => x.startsWith("remove:")) > sp && sl.models.size === 2, "commit(): the coarse models are removed after the fine set is placed", st.log.join());
  const kt = fakeTarget();
  const kl = makeInstanceLayer(kt, { keepUnused: true });
  kl.setStatic(coarse);
  kl.commit();
  kl.setStatic(fine);
  kl.commit();
  ok(!kt.log.some((x) => x.startsWith("remove:")) && kl.models.size === 4, "keepUnused: nothing is released");

  // A newer set given but not yet committed keeps what it names.
  const nt = fakeTarget();
  const ch3 = channel();
  const w3 = makeSceneWorker({ spawn: ch3.spawn });
  const nl = makeInstanceLayer(nt, { worker: w3 });
  nl.setStatic(coarse);
  await nl.commitAsync();
  nl.setStatic(fine);
  const p = nl.commitAsync();
  nl.setStatic(coarse.slice(0, 10)); // named again, not committed
  await p;
  ok(nl.models.has(coarseTree, K) && nl.models.has(coarseRock, K) && nt.log.filter((x) => x.startsWith("remove:")).length === 0, "a setStatic not committed yet keeps the models it names through an apply");
  w3.destroy();
}

console.log("adds in slices (beginEncodedModel):");
{
  const K = 3;
  const big = sparseBox(64, 48, 64, 0.05, 9); // 8 x 6 x 8 bricks
  const set = [...scene([tree, big, rock], 60, 7), ...scene([big], 5, 8).map((p) => ({ ...p, scale: K }))];
  const load = makeLoadTracker();
  const events: LoadEvent[] = [];
  load.on((e) => { if (e.phase === LOAD_PHASES.upload) events.push({ ...e }); });
  const ch = channel();
  const worker = makeSceneWorker({ spawn: ch.spawn });
  const t = slicedTarget(16);
  let paces = 0;
  const layer = makeInstanceLayer(t, { load, worker, pace: async () => { paces++; t.log.push("pace"); await tick(); } });
  layer.setStatic(set);
  await layer.commitAsync();
  const from = t.log.indexOf("begin", t.log.indexOf("addEncoded"));
  const bigSteps = t.log.slice(from, t.log.indexOf("addEncoded", from)).filter((x) => x === "step").length;
  ok(t.begins === 4 && t.encodedAdds === 4 && t.cancels === 0 && t.open === 0, "every model (the big one at two scales) is begun and finished once", `${t.begins} begins, ${t.encodedAdds} adds`);
  ok(bigSteps > 2 && paces >= 2 * (bigSteps - 1), "a big model spans several steps, one per paced frame", `${bigSteps} steps, ${paces} paces: ${t.log.join()}`);
  ok(t.log.every((x, i) => x !== "step" || t.log[i + 1] === "pace" || t.log[i + 1] === "addEncoded"), "  a step that does not finish waits for the next frame");
  const diff = sameState(syncOf(set), t);
  ok(diff === "", "the pool, every model and the bake equal the synchronous path's", diff);
  // The whole-add path on the same worker type gives the same state too.
  const ch2 = channel();
  const w2 = makeSceneWorker({ spawn: ch2.spawn });
  const whole = fakeTarget();
  const l2 = makeInstanceLayer(whole, { worker: w2 });
  l2.setStatic(set);
  await l2.commitAsync();
  ok(sameState(whole, t) === "", "  and the whole-add path's", sameState(whole, t));
  ok(kinds(ch.sent, "model").length === 0 && kinds(ch.sent, "keys").length === 3, "each encoding's keys are registered once, after its last scale is added");
  const total = phase(load)!.total;
  ok(events.every((e, i) => i === 0 || e.done >= events[i - 1].done) && !phase(load)!.busy && phase(load)!.done === total && total === units(tree) + units(big) + units(rock), "the upload phase counts bricks, never decreasing, done === total at the end", JSON.stringify(phase(load)));
  worker.destroy();
  w2.destroy();

  // A cached encoding lands with nothing ticked: its add's steps move the phase, held below done.
  const store = memoryCacheStore();
  const key = (m: unknown) => (m === big ? "big" : m === tree ? "tree" : undefined);
  const warm = channel({ cache: { store } });
  const ww = makeSceneWorker({ spawn: warm.spawn });
  const wl = makeInstanceLayer(fakeTarget(), { worker: ww, modelKey: key });
  wl.setStatic(scene([big], 3, 1));
  await wl.commitAsync();
  await ww.destroy();
  const cl = makeLoadTracker();
  const seen: { done: number; total: number; open: number; progress: number }[] = [];
  const cc = channel({ cache: { store } });
  const cw = makeSceneWorker({ spawn: cc.spawn });
  const ct = slicedTarget(16);
  let last: { progress: number } | undefined;
  const begin = ct.beginEncodedModel;
  ct.beginEncodedModel = (e, o) => { const p = begin(e, o); last = p; return p; };
  cl.on((e) => { if (e.phase === LOAD_PHASES.upload) seen.push({ done: e.done, total: e.total, open: ct.open, progress: last?.progress ?? 0 }); });
  const clayer = makeInstanceLayer(ct, { load: cl, worker: cw, modelKey: key, pace: tick });
  clayer.setStatic(scene([big], 3, 1));
  await clayer.commitAsync();
  const mid = seen.filter((e) => e.open > 0 && e.done > 0);
  ok(cc.state.cachedEncodes === 1 && mid.length >= 2 && mid.every((e) => e.done < e.total), "a cached model's add ticks the phase as its steps land, below done until it finishes", JSON.stringify(seen));
  ok(mid.every((e) => e.done === Math.min(e.total - 1, Math.round(e.progress * e.total))), "  each tick follows the add's progress: round(progress x bricks)", JSON.stringify(mid));
  ok(!phase(cl)!.busy && phase(cl)!.done === units(big) && phase(cl)!.cached === units(big), "  and completes, counted cached", JSON.stringify(phase(cl)));
  cw.destroy();
}

/** A layer on a sliced target whose frames advance only when `frame()` is called. */
function gated(bricksPerStep = 8) {
  const load = makeLoadTracker();
  const ch = channel();
  const worker = makeSceneWorker({ spawn: ch.spawn });
  const t = slicedTarget(bricksPerStep);
  let gate: (() => void) | undefined;
  const layer = makeInstanceLayer(t, { load, worker, pace: () => new Promise<void>((r) => (gate = r)) });
  /** Run until a model is mid-add (begun, stepped, not done). */
  const midModel = async () => {
    for (let i = 0; i < 400; i++) {
      if (t.open === 1 && t.steps >= 2) return true;
      if (gate) { const g = gate; gate = undefined; g(); }
      await tick();
    }
    return false;
  };
  const frames = async (n = 400) => { for (let i = 0; i < n; i++) { if (gate) { const g = gate; gate = undefined; g(); } await tick(); } };
  return { load, ch, worker, t, layer, midModel, frames };
}

console.log("slices: supersede, abort, sync commit mid-model:");
{
  const big = sparseBox(64, 48, 64, 0.05, 9);
  // Supersede by a set without the model: its add is cancelled, and its encode leaves the phase.
  {
    const g = gated();
    g.layer.setStatic(scene([big], 4, 1));
    const a = g.layer.commitAsync();
    ok(await g.midModel(), "a big model is mid-add");
    g.layer.setStatic(scene([tree], 10, 2));
    const b = g.layer.commitAsync();
    ok(g.t.cancels === 1 && g.t.open === 0, "  a superseding set without it cancels the add", `${g.t.cancels} cancels`);
    await g.frames(40);
    await Promise.all([a, b]);
    ok(sameState(syncOf(scene([tree], 10, 2)), g.t) === "" && g.layer.models.size === 1, "  the newer set applies, equal to the synchronous path's", sameState(syncOf(scene([tree], 10, 2)), g.t));
    ok(!phase(g.load)!.busy && phase(g.load)!.total === units(tree) && phase(g.load)!.done === units(tree), "  and the cancelled model leaves the upload phase", JSON.stringify(phase(g.load)));
    g.worker.destroy();
  }
  // Supersede by a set that still names it: the add carries on.
  {
    const g = gated();
    g.layer.setStatic(scene([big], 4, 1));
    const a = g.layer.commitAsync();
    await g.midModel();
    const set = scene([big, tree], 12, 3);
    g.layer.setStatic(set);
    const b = g.layer.commitAsync();
    await g.frames();
    await Promise.all([a, b]);
    ok(g.t.cancels === 0 && g.t.begins === 2 && sameState(syncOf(set), g.t) === "", "a superseding set that still names it carries the add on", `${g.t.cancels} cancels, ${g.t.begins} begins`);
    g.worker.destroy();
  }
  // Abort mid-model: the add is cancelled, the encoding kept; the next commitAsync adds it again.
  {
    const g = gated();
    const set = scene([big], 4, 1);
    g.layer.setStatic(set);
    const ctl = new AbortController();
    const a = g.layer.commitAsync({ signal: ctl.signal });
    await g.midModel();
    ctl.abort(new Error("gone"));
    const r = await a.then(() => "resolved", (e: Error) => e.message);
    ok(r === "gone" && g.t.cancels === 1 && g.t.open === 0 && g.t.models.every((m) => m !== undefined), "abort mid-model rejects and cancels the add, freeing its claim", `${r}, ${g.t.cancels} cancels`);
    ok(phase(g.load)!.busy && phase(g.load)!.done < phase(g.load)!.total, "  the upload is still counted, not done", JSON.stringify(phase(g.load)));
    const b = g.layer.commitAsync();
    await g.frames();
    await b;
    ok(g.ch.state.encodes === 1 && g.t.begins === 2 && sameState(syncOf(set), g.t) === "", "  the next commitAsync adds it again from the kept encoding, equal to the synchronous path's");
    ok(!phase(g.load)!.busy && phase(g.load)!.done === phase(g.load)!.total, "  and the upload phase completes", JSON.stringify(phase(g.load)));
    g.worker.destroy();
  }
  // A sync commit mid-model finishes the add before placing.
  {
    const g = gated();
    const set = scene([big, rock], 20, 4);
    g.layer.setStatic(set);
    const a = g.layer.commitAsync();
    await g.midModel();
    const steps = g.t.steps;
    g.layer.setStatic(set);
    g.layer.commit();
    ok(g.t.open === 0 && g.t.cancels === 0 && g.t.steps === steps + 2 && g.t.staticSets === 1, "a sync commit mid-model finishes the add in one step (and adds the other whole), then places", `${g.t.steps - steps} steps, open ${g.t.open}`);
    ok(sameState(syncOf(set), g.t) === "", "  equal to the synchronous path's", sameState(syncOf(set), g.t));
    await g.frames(40);
    const r = await Promise.race([a.then(() => "resolved"), tick().then(() => "pending")]);
    ok(r === "resolved" && g.t.staticSets === 1 && g.t.begins === 2, "  the commitAsync it superseded resolves; nothing is added or placed twice", `${r}, ${g.t.staticSets} sets, ${g.t.begins} begins`);
    ok(!phase(g.load)!.busy && phase(g.load)!.done === phase(g.load)!.total, "  the upload phase completes", JSON.stringify(phase(g.load)));
    g.worker.destroy();
  }
}

console.log(`\n${checks - failed}/${checks} scene checks passed`);
if (failed) process.exit(1);
