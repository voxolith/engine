// Headless checks for load events and the loaders that report them.  bun tools/verify-load.ts
//
// The tracker with synthetic tasks (aggregation, growing totals, reopened phases, idle(),
// unsubscribe, a throwing listener), then the generator pool with fake workers, the chunked
// world and the instance layer with fake targets.

import { formatTimeline, LOAD_MARKS, LOAD_PHASES, makeLoadTracker, trackRenderer, type LoadEvent, type LoadMark } from "../src/load";
import { makeGeneratorPool } from "../src/worker/pool";
import type { GenerateRequest, WorkerRequest, WorkerResponse } from "../src/worker/protocol";
import { makeChunkedWorld } from "../src/chunks";
import { makeInstanceLayer, makeModelLibrary, type InstanceTarget } from "../src/instances";
import type { Entity, EntityModel } from "../src/entity";

let failed = 0, checks = 0;
const ok = (c: boolean, m: string, d = "") => {
  checks++;
  if (c) console.log(`  ✓ ${m}`);
  else { failed++; console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); }
};
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const record = (load: ReturnType<typeof makeLoadTracker>) => {
  const events: LoadEvent[] = [];
  load.on((e) => events.push(e));
  return events;
};
const kinds = (events: LoadEvent[], phase: string) => events.filter((e) => e.phase === phase).map((e) => e.kind).join(",");

console.log("tracker:");
{
  const load = makeLoadTracker();
  const events = record(load);
  const a = load.task("models", 3);
  const b = load.task("models", 2);
  ok(events.length === 2 && events[0].kind === "start" && events[1].kind === "progress" && events[1].total === 5,
    "two tasks on one phase: one start, totals add up", JSON.stringify(events));
  a.tick(1, { cached: true, label: "tree" });
  b.tick(2);
  const last = events.at(-1)!;
  ok(last.done === 3 && last.total === 5 && last.cached === 1 && events.at(-2)!.label === "tree", "  done and cached sum over tasks; the tick's label reaches the event");
  b.end();
  ok(load.snapshot().busy && events.at(-1)!.kind === "progress", "  the phase stays busy while one task is open");
  a.tick(2);
  a.end();
  ok(events.at(-1)!.kind === "end" && !load.snapshot().busy, "  it ends with its last task");
  a.tick(5);
  a.end();
  ok(load.snapshot().phases[0].done === 5 && events.at(-1)!.kind === "end", "  an ended task is inert");

  const g = load.task("ground");
  g.add(2);
  g.tick(3);
  const s = load.snapshot().phases.find((p) => p.phase === "ground")!;
  ok(s.done === 3 && s.total === 3, "ticking past the total grows it (done never exceeds total)", JSON.stringify(s));
  g.add(4);
  g.tick(1);
  g.end();
  const s2 = load.snapshot().phases.find((p) => p.phase === "ground")!;
  ok(s2.done === 4 && s2.total === 4 && !s2.busy && s2.end !== undefined, "  ending early drops what was never done from the total", JSON.stringify(s2));
  const g2 = load.task("ground", 2);
  const s3 = load.snapshot().phases.find((p) => p.phase === "ground")!;
  ok(s3.busy && s3.end === undefined && s3.total === 6, "  a phase reopens with its counts carried on");
  g2.tick(2);
  g2.end();
  ok(kinds(events, "ground") === "start,progress,progress,progress,progress,end,start,progress,end", "  and sends start/end again", kinds(events, "ground"));
  const tl = load.timeline();
  const gt = tl.find((e) => e.phase === "ground")!;
  ok(tl.map((e) => e.phase).join() === "models,ground" && gt.spans === 2 && gt.done === 6 && gt.end! >= gt.start && gt.busy <= gt.end! - gt.start + 1e-9,
    "  timeline: one entry per phase in start order, first start to latest end, two spans", JSON.stringify(gt));
  const snap = load.snapshot();
  ok(snap.done === 11 && snap.total === 11 && snap.cached === 1 && !snap.busy, "snapshot totals sum the phases", JSON.stringify(snap));
}

console.log("discard():");
{
  const load = makeLoadTracker();
  const events = record(load);
  const keep = load.task("bake", 4);
  keep.tick(1);
  const drop = load.task("bake", 10);
  drop.tick(3, { cached: true });
  drop.tick(2);
  drop.discard();
  const s = load.snapshot().phases[0];
  ok(s.done === 1 && s.total === 4 && s.cached === 0 && s.busy, "a discarded task takes back its ticks, total and cached; other tasks keep theirs", JSON.stringify(s));
  drop.tick(5);
  drop.end();
  ok(load.snapshot().phases[0].done === 1, "  it is inert afterwards");
  keep.tick(3);
  keep.discard();
  keep.end();
  const e = load.snapshot().phases[0];
  ok(e.done === 0 && e.total === 0 && !e.busy && events.at(-1)!.kind === "end", "  discarding the last open task ends the phase at 0/0", JSON.stringify(e));
  const t = load.task("bake", 2);
  t.tick(2);
  t.end();
  t.discard();
  ok(load.snapshot().phases[0].done === 2, "  discard after end does nothing");
  ok(events.every((x) => x.done <= x.total && x.done >= 0), "  no event ever has done > total or done < 0");
}

console.log("idle():");
{
  const load = makeLoadTracker();
  let resolved = false;
  await load.idle().then(() => (resolved = true));
  ok(resolved, "resolves at once when nothing is loading");
  resolved = false;
  await load.idle("never").then(() => (resolved = true));
  ok(resolved, "  and for a phase that never started");
  const m = load.task("models", 1);
  const u = load.task("upload", 1);
  let modelsIdle = false, allIdle = false;
  load.idle("models").then(() => (modelsIdle = true));
  load.idle().then(() => (allIdle = true));
  await tick();
  ok(!modelsIdle && !allIdle, "  waits while busy");
  m.tick();
  m.end();
  await tick();
  ok(modelsIdle && !allIdle, "  a phase's idle resolves when that phase ends, the overall one waits");
  u.end();
  await tick();
  ok(allIdle, "  the overall one resolves when every phase is idle");
}

console.log("listeners:");
{
  const load = makeLoadTracker();
  let a = 0, b = 0;
  const offA = load.on(() => a++);
  load.on(() => { throw new Error("listener bug (expected in this check)"); });
  load.on(() => b++);
  const origError = console.error;
  let logged = 0;
  console.error = () => { logged++; };
  let threw = false;
  try {
    const t = load.task("x", 1);
    t.tick();
    offA();
    t.end();
  } catch {
    threw = true;
  } finally {
    console.error = origError;
  }
  ok(!threw && logged === 3 && b === 3, "a throwing listener is logged and never breaks the loader or other listeners", `logged ${logged}, b ${b}`);
  ok(a === 2, "  unsubscribe stops delivery", `a ${a}`);
}

console.log("trackRenderer:");
{
  const load = makeLoadTracker();
  const events = record(load);
  const hook = trackRenderer(load);
  hook("shaders", "start");
  hook("shaders", "end");
  hook("pipelines", "start", "module");
  hook("pipelines", "end", "module");
  hook("pipelines", "start", "fragment");
  hook("pipelines", "end", "fragment");
  ok(kinds(events, "shaders") === "start,progress,progress,end", "one start/end pair is one tick of a task", kinds(events, "shaders"));
  const p = load.timeline().find((e) => e.phase === LOAD_PHASES.pipelines)!;
  ok(p.done === 2 && p.total === 2 && p.spans === 2, "  sequential pipeline compiles count one each", JSON.stringify(p));
  ok(events.filter((e) => e.phase === "pipelines" && e.label).map((e) => e.label).join() === "module,fragment", "  the variant is the tick's label");
  hook("pipelines", "start", "a");
  hook("pipelines", "start", "b");
  hook("pipelines", "end", "b");
  ok(load.snapshot().busy, "  nested starts keep the phase open until every one ends");
  hook("pipelines", "end", "a");
  hook("pipelines", "end", "stray");
  const p2 = load.timeline().find((e) => e.phase === LOAD_PHASES.pipelines)!;
  ok(!load.snapshot().busy && p2.done === 4 && p2.total === 4, "  ... and a stray end is ignored", JSON.stringify(p2));
}

console.log("formatTimeline:");
{
  const load = makeLoadTracker();
  const t = load.task("models", 2);
  t.tick(1, { cached: true });
  t.tick(1);
  t.end();
  load.task("ground", 5);
  const text = formatTimeline(load.timeline());
  const lines = text.split("\n");
  ok(lines.length === 3 && /^phase\s+start\s+took\s+done\/total\s+cached$/.test(lines[0]), "a header and one line per phase", text);
  ok(/^models\s+\d+ ms\s+\d+ ms\s+2\/2\s+1$/.test(lines[1]) && /^ground\s+\d+ ms\s+running\s+0\/5$/.test(lines[2]), "  start, duration, done/total, cached; an open phase reads running", text);
}

// A fake worker: records requests; the test answers them.
function fakeWorkers() {
  const workers: { requests: GenerateRequest[]; reply(msg: WorkerResponse): void; die(): void; terminated: boolean }[] = [];
  const spawn = () => {
    const w = {
      onmessage: null as ((ev: MessageEvent<WorkerResponse>) => void) | null,
      onerror: null as ((ev: ErrorEvent) => void) | null,
      postMessage(req: WorkerRequest) {
        if (req.kind === "close") queueMicrotask(() => rec.reply({ kind: "closed" }));
        else rec.requests.push(req);
      },
      terminate() { rec.terminated = true; },
    };
    const rec = {
      requests: [] as GenerateRequest[],
      terminated: false,
      reply: (msg: WorkerResponse) => w.onmessage?.({ data: msg } as MessageEvent<WorkerResponse>),
      die: () => w.onerror?.({ message: "boom" } as ErrorEvent),
    };
    workers.push(rec);
    queueMicrotask(() => rec.reply({ kind: "ready", generators: ["t"] }));
    return w as unknown as Worker;
  };
  return { workers, spawn };
}
const fakeEntity = (id: string): Entity => ({
  id, name: id, roles: [], model: { size: { x: 1, y: 1, z: 1 }, data: new Uint8Array(1), anchor: [0, 0, 0], roles: [] },
} as unknown as Entity);

console.log("generator pool:");
{
  const load = makeLoadTracker();
  const events = record(load);
  const { workers, spawn } = fakeWorkers();
  const pool = makeGeneratorPool({ spawn, size: 2, load });
  await pool.ready();
  let progress: number[] = [];
  const all = pool.generateMany(
    [1, 2, 3].map((seed) => ({ generator: seed === 3 ? "voxolith/rock" : "voxolith/tree", params: {}, seed })),
    (done) => progress.push(done),
  );
  const models = () => load.snapshot().phases.find((p) => p.phase === LOAD_PHASES.models)!;
  ok(models().total === 3 && models().done === 0 && models().busy, "enqueueing adds one item per request", JSON.stringify(models()));
  const answer = (w: number, i: number, cached: boolean) => {
    const req = workers[w].requests[i];
    workers[w].reply({ kind: "ok", id: req.id, entity: fakeEntity(`e${req.id}`), cached });
  };
  answer(0, 0, true);
  answer(1, 0, false);
  ok(models().done === 2 && models().cached === 1 && models().busy, "  results tick, cache hits count as cached", JSON.stringify(models()));
  ok(events.some((e) => e.label === "voxolith/tree"), "  the generator id is the label");
  answer(0, 1, false);
  await all;
  ok(!models().busy && models().done === 3 && events.at(-1)!.kind === "end" && events.at(-2)!.label === "voxolith/rock", "  the phase ends when the queue drains", JSON.stringify(models()));
  ok(progress.join() === "1,2,3", "  onDone still reports");
  const failing = pool.generate({ generator: "voxolith/tree", params: {}, seed: 9 }).catch(() => "rejected");
  ok(models().busy && models().total === 4, "  a later request reopens the phase");
  const w0 = workers[0], req = w0.requests.at(-1)!;
  w0.reply({ kind: "error", id: req.id, message: "nope" });
  ok((await failing) === "rejected" && !models().busy && models().done === 4, "  an error ticks too, so the phase still ends", JSON.stringify(models()));
  const dying = pool.generate({ generator: "voxolith/tree", params: {}, seed: 10 }).catch(() => "rejected");
  workers[0].die();
  ok((await dying) === "rejected" && !models().busy && models().done === 5, "  so does a request lost with its worker");
  const pending = [pool.generate({ generator: "g", params: {}, seed: 1 }), pool.generate({ generator: "g", params: {}, seed: 2 }), pool.generate({ generator: "g", params: {}, seed: 3 })].map((p) => p.catch(() => 0));
  pool.destroy();
  await Promise.all(pending);
  ok(!models().busy && models().done === models().total && models().total === 5, "  destroy ends the phase and drops what never ran", JSON.stringify(models()));
  ok(load.timeline()[0].spans === 4, "  four spans in the timeline");

  const { spawn: spawn2 } = fakeWorkers();
  const plain = makeGeneratorPool({ spawn: spawn2, size: 1 });
  await plain.ready();
  ok(plain.pending === 0, "a pool without a tracker still works");
  plain.destroy();
}

console.log("chunked world:");
{
  const load = makeLoadTracker();
  const events = record(load);
  let edits = 0, clears = 0;
  const target = { edit: () => { edits++; }, clear: () => { clears++; } };
  const world = makeChunkedWorld({
    target, size: { x: 256, y: 32, z: 256 }, chunk: 32, seed: 1, load,
    generate(ctx) { ctx.edit(ctx.box, () => true); },
  });
  const ground = () => load.snapshot().phases.find((p) => p.phase === LOAD_PHASES.ground)!;
  world.focus(16, 16, 64);
  const first = world.pending;
  ok(ground().total === first && first > 0 && ground().busy, "focus adds the chunks it queues", `${ground().total} vs ${first}`);
  world.focus(16, 16, 64);
  ok(ground().total === first, "  re-focusing on the same spot adds nothing");
  world.step(0);
  ok(ground().done === 1 && ground().busy, "  step ticks each chunk it builds");
  world.step(Infinity);
  ok(ground().done === first && !ground().busy && edits === first, "  the phase ends when the queue is empty");
  world.focus(240, 240, 64);
  const added = world.pending;
  ok(clears > 0 && ground().total === first + added && ground().busy, "  moving on reopens it; freed chunks are not counted back", JSON.stringify(ground()));
  world.step(Infinity);
  ok(!ground().busy && ground().done === ground().total && kinds(events, "ground").split(",").filter((k) => k === "start").length === 2, "  two spans");
}

console.log("instance layer:");
{
  const load = makeLoadTracker();
  const events = record(load);
  const order: string[] = [];
  load.on((e) => { if (e.kind !== "progress") order.push(`${e.phase}:${e.kind}`); });
  let next = 0;
  const target: InstanceTarget = {
    addModel: () => next++,
    removeModel: () => {},
    addPalette: () => 256,
    setPaletteColors: () => {},
    removePalette: () => {},
    setInstances: () => {},
  };
  const box = (n: number): EntityModel => ({ size: { x: n, y: n, z: n }, data: new Uint8Array(n * n * n).fill(1), anchor: [0, 0, 0], roles: [] });
  const a = box(2), b = box(3);
  const layer = makeInstanceLayer(target, { load });
  layer.setStatic(Array.from({ length: 10 }, (_, i) => ({ model: i % 2 ? a : b, x: i, y: 0, z: 0, base: 256 })));
  layer.commit();
  const phase = (name: string) => load.snapshot().phases.find((p) => p.phase === name)!;
  ok(phase("upload").done === 2 && phase("upload").total === 2 && !phase("upload").busy, "first-sight uploads tick once per model", JSON.stringify(phase("upload")));
  ok(phase("placement").done === 10 && phase("placement").total === 10 && !phase("placement").busy, "  the static setInstances is one placement of every static instance");
  ok(order.join() === "upload:start,upload:end,placement:start,placement:end", "  upload ends before placement starts", order.join());
  layer.commit();
  layer.setDynamic([{ model: 0, x: 0, y: 0, z: 0, base: 256 }]);
  layer.commit();
  ok(load.timeline().find((e) => e.phase === "placement")!.spans === 1, "  dynamic commits are not placement");
  layer.setStatic([{ model: a, x: 0, y: 0, z: 0, base: 256 }]);
  layer.commit();
  ok(load.timeline().find((e) => e.phase === "upload")!.spans === 1 && phase("placement").total === 11,
    "  known models are not uploaded again; a new static set is placed again");
  layer.setStatic([]);
  layer.commit();
  ok(phase("placement").total === 11 && load.timeline().find((e) => e.phase === "placement")!.spans === 2, "  an empty static set is not reported");

  const lib = makeModelLibrary(target, { load });
  lib.id(box(4));
  lib.id(box(5));
  ok(phase("upload").busy && phase("upload").done === 4, "direct id calls keep one span open for the run");
  await Promise.resolve();
  ok(!phase("upload").busy && load.timeline().find((e) => e.phase === "upload")!.spans === 2, "  and close it after");
  ok(events.every((e) => e.done <= e.total), "no event ever has done > total");
}

console.log("marks:");
{
  const before = performance.now();
  const load = makeLoadTracker();
  const after = performance.now();
  ok(load.origin >= before && load.origin <= after && load.now() >= 0 && load.now() <= performance.now() - load.origin + 1e-9,
    "origin is the performance.now() the tracker was made at; now() counts from it");
  const events = record(load);
  const heard: LoadMark[] = [];
  const offMark = load.onMark((m) => heard.push(m));
  const offThrow = load.onMark(() => { throw new Error("listener bug"); });
  const err = console.error;
  let logged = 0;
  console.error = () => { logged++; };
  const a = load.task("models", 1);
  load.mark(LOAD_MARKS.firstFrame);
  console.error = err;
  ok(events.length === 1 && events[0].kind === "start", "a mark sends no phase event (on() listeners never see a new kind)", JSON.stringify(events));
  ok(heard.length === 1 && heard[0].name === "first-frame" && logged === 1, "  onMark hears it, and a throwing mark listener is logged, not raised");
  ok(load.snapshot().phases.length === 1 && load.snapshot().busy, "  marks are not phases: snapshot() has only the phase");
  a.tick();
  a.end();
  let settled = false;
  void load.idle().then(() => { settled = true; });
  await tick();
  ok(settled, "  and never keep the tracker busy");
  console.error = () => { logged++; };
  load.mark("early", 0);
  load.mark(LOAD_MARKS.converged);
  load.mark(LOAD_MARKS.converged);
  console.error = err;
  ok(load.marks().map((m) => m.name).join() === "early,first-frame,converged,converged", "marks() in time order; an explicit t is placed by it; repeats are kept",
    load.marks().map((m) => m.name).join());
  offMark();
  offThrow();
  load.mark("after-off");
  ok(heard.length === 4, "  unsubscribing stops onMark", String(heard.length));
  const tl = load.timeline();
  ok(tl.map((e) => `${e.kind}:${e.phase}`).join() === "mark:early,phase:models,mark:first-frame,mark:converged,mark:converged,mark:after-off",
    "timeline(): phases and marks in time order, told apart by kind", tl.map((e) => `${e.kind}:${e.phase}`).join());
  const m = tl.find((e) => e.phase === "first-frame")!;
  ok(m.end === m.start && m.busy === 0 && m.spans === 0 && m.done === 0 && m.total === 0 && tl.every((e) => e.end !== undefined),
    "  a mark row is zero-length with no counts, and always has an end", JSON.stringify(m));
  ok(tl.every((e, i) => i === 0 || tl[i - 1].start <= e.start), "  sorted by start");
  const text = formatTimeline(tl);
  const lines = text.split("\n");
  ok(lines.length === tl.length + 1 && /^first-frame\s+\d+ ms\s+mark$/.test(lines.find((l) => l.startsWith("first-frame"))!), "formatTimeline: one line per mark, with `mark` for its length", text);
  ok(LOAD_MARKS.firstFrame === "first-frame" && LOAD_MARKS.converged === "converged", "LOAD_MARKS names");
  const quiet = makeLoadTracker();
  quiet.mark("x");
  ok(quiet.snapshot().phases.length === 0 && quiet.timeline().length === 1, "a tracker with only a mark: no phases, one timeline row");
}

console.log(`\n${checks - failed}/${checks} load checks passed`);
if (failed) process.exit(1);
