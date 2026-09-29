// Headless checks for filling chunks on workers.  bun tools/verify-chunks.ts
//
// makeChunkedWorld({ fill }) against the synchronous path on a fake brick target: the same
// cells, nearest-first dispatch and apply, re-ranking when the focus moves, frees while chunks
// are out, whenReady and the `ground` phase staying truthful, and failures. The pool and
// serveChunks run together over a fake worker channel (messages delivered on later tasks, as
// postMessage does); the world's ordering is checked with a hand-driven source.

import { columnBoxes, makeChunkedWorld, type Box, type ChunkFillSource, type FilledBricks } from "../src/chunks";
import { LOAD_PHASES, makeLoadTracker } from "../src/load";
import { makeChunkFillPool, serveChunks, type ChunkFill, type ChunkRequest, type ChunkResponse } from "../src/worker/chunks";

let failed = 0, checks = 0;
const ok = (c: boolean, m: string, d = "") => {
  checks++;
  if (c) console.log(`  ✓ ${m}`);
  else { failed++; console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); }
};
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// --- a brick target, as the renderer's BrickGrid behaves --------------------------------------
function fakeTarget() {
  const bricks = new Map<string, Uint8Array>();
  const log: string[] = [];
  let uploads = 0;
  const visit = (box: Box, fill: (c: Uint8Array, ox: number, oy: number, oz: number) => boolean) => {
    for (let bz = box.z0 >> 3; bz <= box.z1 >> 3; bz++)
      for (let by = box.y0 >> 3; by <= box.y1 >> 3; by++)
        for (let bx = box.x0 >> 3; bx <= box.x1 >> 3; bx++) {
          const k = `${bx},${by},${bz}`;
          const cur = bricks.get(k) ?? new Uint8Array(512);
          if (fill(cur, bx * 8, by * 8, bz * 8) && !bricks.has(k)) bricks.set(k, cur);
        }
  };
  return {
    bricks,
    log,
    get uploads() { return uploads; },
    edit(box: Box, fill: (c: Uint8Array, ox: number, oy: number, oz: number) => boolean) {
      uploads++;
      log.push(`edit ${box.x0 >> 6},${box.z0 >> 6}`);
      visit(box, fill);
    },
    editMany(boxes: readonly Box[], fill: (c: Uint8Array, ox: number, oy: number, oz: number) => boolean) {
      uploads++;
      if (boxes.length) log.push(`many ${boxes[0].x0 >> 6},${boxes[0].z0 >> 6}`);
      for (const b of boxes) visit(b, fill);
    },
    clear(box: Box) {
      for (let bz = box.z0 >> 3; bz <= box.z1 >> 3; bz++)
        for (let by = box.y0 >> 3; by <= box.y1 >> 3; by++)
          for (let bx = box.x0 >> 3; bx <= box.x1 >> 3; bx++) bricks.delete(`${bx},${by},${bz}`);
    },
  };
}
const sameBricks = (a: Map<string, Uint8Array>, b: Map<string, Uint8Array>): string => {
  if (a.size !== b.size) return `${a.size} vs ${b.size} bricks`;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (!w) return `brick ${k} missing`;
    for (let i = 0; i < 512; i++) if (v[i] !== w[i]) return `brick ${k} cell ${i}: ${v[i]} vs ${w[i]}`;
  }
  return "";
};

// --- a terrain: a pure function of the coordinates, writing solids only ---------------------
interface TerrainInit { seed: number; base: number }
const heightAt = (t: TerrainInit, x: number, z: number) => 10 + ((Math.imul(x >> 2, 73856093) ^ Math.imul(z >> 2, 19349663) ^ t.seed) >>> 0) % 13;
const makeFill = (t: TerrainInit): ChunkFill => (cells, ox, oy, oz) => {
  let touched = false;
  for (let lz = 0; lz < 8; lz++)
    for (let lx = 0; lx < 8; lx++) {
      const h = heightAt(t, ox + lx, oz + lz);
      for (let ly = 0; ly < 8; ly++) {
        const y = oy + ly;
        if (y > h) break;
        cells[lx + ly * 8 + lz * 64] = t.base + (y === h ? 1 : y > h - 3 ? 2 : 3);
        touched = true;
      }
    }
  return touched;
};
const span = (t: TerrainInit) => (ox: number, oz: number): [number, number] => {
  let hi = 0;
  for (let z = oz; z < oz + 8; z++) for (let x = ox; x < ox + 8; x++) hi = Math.max(hi, heightAt(t, x, z));
  return [0, hi];
};

// --- a fake worker channel running serveChunks ----------------------------------------------
interface ChannelOptions { make?: (init: unknown) => ChunkFill | Promise<ChunkFill>; crashOn?: (req: ChunkRequest) => boolean }
function channel(o: ChannelOptions = {}) {
  const spawned: { terminated: boolean; requests: ChunkRequest[] }[] = [];
  const spawn = () => {
    const rec = { terminated: false, requests: [] as ChunkRequest[] };
    spawned.push(rec);
    const w = {
      onmessage: null as ((ev: MessageEvent<ChunkResponse>) => void) | null,
      onerror: null as ((ev: ErrorEvent) => void) | null,
      postMessage(msg: ChunkRequest) {
        rec.requests.push(msg);
        const copy = structuredClone(msg);
        setTimeout(() => {
          if (rec.terminated) return;
          if (o.crashOn?.(copy)) {
            w.onerror?.({ message: "worker crashed", preventDefault() {} } as unknown as ErrorEvent);
            return;
          }
          scope.onmessage?.({ data: copy });
        }, 0);
      },
      terminate() { rec.terminated = true; },
    };
    const scope = {
      onmessage: null as ((ev: { data: ChunkRequest }) => void) | null,
      postMessage(msg: ChunkResponse) {
        const copy = structuredClone(msg);
        setTimeout(() => { if (!rec.terminated) w.onmessage?.({ data: copy } as MessageEvent<ChunkResponse>); }, 0);
      },
    };
    serveChunks({ scope, make: o.make ?? ((init) => makeFill(init as TerrainInit)) });
    return w as unknown as Worker;
  };
  return { spawn, spawned };
}

/** Step until nothing is pending (results land between steps, as between frames). */
async function settle(world: { step(b?: number): number }, budget = Infinity, limit = 2000): Promise<number> {
  let steps = 0;
  while (world.step(budget) > 0 && steps++ < limit) await tick();
  return steps;
}

const SIZE = { x: 512, y: 32, z: 512 };
const CHUNK = 64;
const T: TerrainInit = { seed: 7, base: 10 };

console.log("the same cells as the synchronous path:");
{
  const a = fakeTarget();
  const sync = makeChunkedWorld({
    target: a, size: SIZE, chunk: CHUNK, seed: 1,
    generate(ctx) { for (const b of columnBoxes(ctx.box, span(T))) ctx.edit(b, makeFill(T)); },
  });
  sync.focus(200, 260, 180);
  sync.step(Infinity);

  const b = fakeTarget();
  const { spawn } = channel();
  const pool = makeChunkFillPool({ spawn, init: T, size: 3 });
  await pool.ready();
  let after = 0;
  const world = makeChunkedWorld({
    target: b, size: SIZE, chunk: CHUNK, seed: 1, fill: pool,
    boxes: ({ box }) => columnBoxes(box, span(T)),
    generate() { after++; },
  });
  world.focus(200, 260, 180);
  const queuedAtFirst = world.pending;
  ok(queuedAtFirst === sync.resident && queuedAtFirst > 0, "focus queues the same chunks", `${queuedAtFirst} vs ${sync.resident}`);
  ok(pool.pending === pool.capacity && pool.capacity === 6, "the world hands out only the pool's capacity", `${pool.pending} of ${pool.capacity}`);
  const steps = await settle(world);
  ok(world.resident === sync.resident && world.pending === 0, "every chunk is applied", `${world.resident} resident after ${steps} steps`);
  const diff = sameBricks(a.bricks, b.bricks);
  ok(diff === "", `the async world holds exactly the sync world's bricks (${a.bricks.size} bricks)`, diff);
  ok(b.uploads === world.resident, "one editMany per chunk", `${b.uploads}`);
  ok(after === world.resident, "generate runs on the main thread after each chunk's fill", `${after}`);

  // Whole-box default, and a request whose boxes share a brick: the second sees the first's writes.
  const c = fakeTarget();
  const whole = makeChunkedWorld({ target: c, size: SIZE, chunk: CHUNK, seed: 1, fill: pool });
  whole.focus(200, 260, 180);
  await settle(whole);
  ok(sameBricks(a.bricks, c.bricks) === "", "without boxes, the chunk's whole box gives the same bricks");

  const shared: Box[] = [{ x0: 0, y0: 0, z0: 0, x1: 3, y1: 7, z1: 7 }, { x0: 0, y0: 0, z0: 0, x1: 7, y1: 3, z1: 7 }];
  const d = fakeTarget();
  let n = 0;
  const count: ChunkFill = (cells) => { for (let i = 0; i < 512; i++) if (!cells[i]) { cells[i] = ++n; break; } return true; };
  d.editMany(shared, count);
  n = 0;
  const { spawn: spawnCount } = channel({ make: () => count });
  const counter = makeChunkFillPool({ spawn: spawnCount, init: null, size: 1 });
  const r = await counter.fill(shared);
  const want = d.bricks.get("0,0,0")!;
  ok(r.count === 1 && r.cells.subarray(0, 512).every((v, i) => v === want[i]) && want[1] === 2, "a brick two boxes share is filled once per box, accumulating, as editMany does");
  counter.destroy();
  pool.destroy();
}

// --- a hand-driven source, for ordering ---------------------------------------------------------
function manualSource(capacity: number) {
  const reqs: { boxes: readonly Box[]; chunk: string; signal?: AbortSignal; resolve: (r: FilledBricks) => void; reject: (e: unknown) => void }[] = [];
  const fillT = makeFill(T);
  const source: ChunkFillSource = {
    capacity,
    fill(boxes, o) {
      return new Promise((resolve, reject) => {
        const req = { boxes, chunk: `${boxes[0].x0 / CHUNK},${boxes[0].z0 / CHUNK}`, signal: o?.signal, resolve, reject };
        reqs.push(req);
        o?.signal?.addEventListener("abort", () => reject(o.signal!.reason), { once: true });
      });
    },
  };
  /** Answer a request with the real fill, computed here. */
  const answer = (i: number) => {
    const req = reqs[i];
    const origins: number[] = [], cells: Uint8Array[] = [];
    for (const b of req.boxes)
      for (let bz = b.z0 >> 3; bz <= b.z1 >> 3; bz++)
        for (let by = b.y0 >> 3; by <= b.y1 >> 3; by++)
          for (let bx = b.x0 >> 3; bx <= b.x1 >> 3; bx++) {
            const c = new Uint8Array(512);
            if (fillT(c, bx * 8, by * 8, bz * 8)) { origins.push(bx * 8, by * 8, bz * 8); cells.push(c); }
          }
    const all = new Uint8Array(cells.length * 512);
    cells.forEach((c, j) => all.set(c, j * 512));
    req.resolve({ count: cells.length, origins: new Int32Array(origins), cells: all });
  };
  return { source, reqs, answer };
}

console.log("ordering and focus:");
{
  const target = fakeTarget();
  const load = makeLoadTracker();
  const { source, reqs, answer } = manualSource(2);
  const world = makeChunkedWorld({ target, size: SIZE, chunk: CHUNK, seed: 1, fill: source, load });
  const ground = () => load.snapshot().phases.find((p) => p.phase === LOAD_PHASES.ground)!;
  world.focus(32, 32, 150);
  const total = world.pending;
  ok(reqs.length === 2 && reqs[0].chunk === "0,0" && ["1,0", "0,1"].includes(reqs[1].chunk), "focus sends the nearest chunks, up to capacity", reqs.map((r) => r.chunk).join(" "));
  ok(ground().total === total && ground().done === 0 && ground().busy, "the ground phase counts every queued chunk", JSON.stringify(ground()));

  // Land the second first: step applies nearest-first among what has landed.
  answer(1);
  answer(0);
  await tick();
  ok(world.resident === 0 && world.pendingWithin(32, 32, 1) === 1 && !world.readyAround(32, 32, 1), "a chunk that has landed is not built until it is applied");
  let near = false;
  void world.whenReady(32, 32, 1).then(() => (near = true));
  await tick();
  ok(!near, "  whenReady waits for the apply, not the landing");
  ok(reqs.length === 4, "  landing frees capacity, so the next two go out at once", `${reqs.length}`);
  world.step(0);
  await tick();
  ok(target.log[0] === "many 0,0" && world.resident === 1 && near, "step applies the nearest landed chunk first, and whenReady resolves", target.log.join(" "));
  ok(ground().done === 1, "  the phase ticks when a chunk is applied");
  world.step(Infinity);
  ok(world.resident === 2 && target.log.length === 2, "  a budget of Infinity applies everything landed");

  // Move the focus: what is still queued is re-ranked from the new point.
  const out = reqs.length;
  world.focus(480, 480, 150);
  const next = reqs.slice(out).map((r) => r.chunk);
  ok(reqs[2].signal!.aborted && reqs[3].signal!.aborted && next[0] === "7,7", "walking off: requests out of range are cancelled, and the nearest new chunk goes out first", next.join(" "));
}
{
  // Everything queued, then the focus moves with nothing new to queue: the queue is re-ranked.
  const { source, reqs, answer } = manualSource(1);
  const world = makeChunkedWorld({ target: fakeTarget(), size: SIZE, chunk: CHUNK, seed: 1, fill: source });
  world.focus(32, 32, 2000, Infinity);
  const all = world.pending;
  world.focus(480, 480, 2000, Infinity);
  ok(world.pending === all && reqs.length === 1 && reqs[0].chunk === "0,0", "a focus move with nothing new to queue keeps what is out");
  answer(0);
  await tick();
  ok(reqs[1]?.chunk === "7,7", "  and the next request is the queued chunk nearest the new focus", reqs.map((r) => r.chunk).join(" "));
}

console.log("frees while chunks are out:");
{
  const target = fakeTarget();
  const load = makeLoadTracker();
  const { source, reqs, answer } = manualSource(3);
  const world = makeChunkedWorld({ target, size: SIZE, chunk: CHUNK, seed: 1, fill: source, load });
  const ground = () => load.snapshot().phases.find((p) => p.phase === LOAD_PHASES.ground)!;
  world.focus(32, 32, 100, 120);
  const before = ground().total;
  answer(0);
  await tick();
  ok(reqs.length === 4, "one landed, the next went out", `${reqs.length}`);
  // Walk away: everything near the old focus is beyond `keep` now.
  world.focus(480, 480, 60, 80);
  const aborted = reqs.slice(0, 4).filter((r) => r.signal?.aborted).length;
  ok(aborted === 4, "requests out and landed for chunks now out of range are cancelled", `${aborted}`);
  ok(world.resident === 0, "  nothing was applied");
  const added = world.pending;
  ok(ground().total === added && ground().done === 0 && ground().total < before + added, "  the dropped chunks left the phase's total", `${JSON.stringify(ground())}, ${added} new`);
  // A late answer for a dropped request must change nothing.
  reqs[1].resolve({ count: 0, origins: new Int32Array(0), cells: new Uint8Array(0) });
  await tick();
  world.step(Infinity);
  ok(target.bricks.size === 0 && world.resident === 0, "  a result for a dropped chunk is ignored when it lands");
  for (let i = 4; i < reqs.length; i++) answer(i);
  await tick();
  await settle({ step: (b) => { const n = world.step(b); for (let i = 0; i < reqs.length; i++) if (!reqs[i].signal?.aborted) answer(i); return n; } });
  ok(world.pending === 0 && world.readyAround(480, 480, 60) && !ground().busy && ground().done === ground().total, "the new area builds and the phase ends with done === total", JSON.stringify(ground()));
  // Coming back queues the old chunks again, and counts them again.
  world.focus(32, 32, 100, 120);
  ok(world.pending > 0 && ground().busy, "  coming back requeues what was dropped");
}

console.log("failures:");
{
  // A fill that throws on one chunk.
  const target = fakeTarget();
  const bad = (ox: number, oz: number) => ox >= 64 && ox < 128 && oz < 64;
  const base = makeFill(T);
  const { spawn } = channel({ make: () => (cells, ox, oy, oz) => { if (bad(ox, oz)) throw new Error("no ground here"); return base(cells, ox, oy, oz); } });
  const pool = makeChunkFillPool({ spawn, init: null, size: 2 });
  const errors: string[] = [];
  const load = makeLoadTracker();
  const world = makeChunkedWorld({ target, size: SIZE, chunk: CHUNK, seed: 1, fill: pool, load, onError: (e, c) => errors.push(`${c.cx},${c.cz}: ${(e as Error).message}`) });
  world.focus(64, 32, 90);
  let rejected: unknown;
  const around = world.whenReady(64, 32, 90).catch((e) => (rejected = e));
  const clear = world.whenReady(10, 200, 20);
  await settle(world);
  await around;
  ok(errors.length === 1 && errors[0] === "1,0: no ground here", "a fill that throws reports to onError with its chunk", errors.join("; "));
  ok(!world.readyAround(64, 32, 90) && world.pendingWithin(64, 32, 90) === 1 && world.pending === 0, "  the chunk stays unbuilt, and is not retried by stepping");
  ok(rejected instanceof Error && (rejected as Error).message === "no ground here", "  whenReady over it rejects with the error");
  world.focus(64, 32, 90);
  ok(world.pending === 0, "  focusing again does not requeue it");
  const g = load.snapshot().phases.find((p) => p.phase === LOAD_PHASES.ground)!;
  ok(!g.busy && g.done === g.total && g.done === world.resident, "  the phase ends counting only built chunks", JSON.stringify(g));
  let far = false;
  void clear.then(() => (far = true));
  world.focus(10, 200, 20, 30);
  await settle(world);
  await tick();
  ok(far, "  an area without the failed chunk still resolves");
  world.focus(480, 480, 20, 30);
  world.focus(64, 32, 90);
  ok(world.pending > 0, "  once freed, coming back retries it");
  pool.destroy();

  // A worker that dies: its request fails, a fresh worker takes over, the rest carries on.
  let crashes = 0;
  const crashy = channel({ crashOn: (r) => r.kind === "fill" && r.boxes[0] === 128 && r.boxes[2] === 0 && crashes++ === 0 });
  const pool2 = makeChunkFillPool({ spawn: crashy.spawn, init: T, size: 2 });
  await pool2.ready();
  const errs: unknown[] = [];
  const target2 = fakeTarget();
  const world2 = makeChunkedWorld({ target: target2, size: SIZE, chunk: CHUNK, seed: 1, fill: pool2, onError: (e) => errs.push(e) });
  world2.focus(128, 32, 130);
  await settle(world2);
  ok(errs.length === 1 && (errs[0] as Error).message === "worker crashed", "a worker crash fails the request it was running, only", String(errs[0]));
  ok(crashy.spawned.length === 3 && crashy.spawned.filter((s) => s.terminated).length === 1, "  the dead worker is replaced, and gets init again", `${crashy.spawned.length} spawned`);
  ok(world2.pendingWithin(128, 32, 130) === 1 && !target2.bricks.has("16,0,0") && target2.bricks.has("0,0,0"), "  every other chunk is built", `${world2.pendingWithin(128, 32, 130)} unbuilt`);
  pool2.destroy();

  // make() throws: the pool fails as a whole.
  const broken = channel({ make: () => { throw new Error("bad init"); } });
  const pool3 = makeChunkFillPool({ spawn: broken.spawn, init: null, size: 2 });
  const why = await pool3.ready().then(() => "", (e) => (e as Error).message);
  ok(/bad init/.test(why), "make() throwing rejects ready()", why);
  const why2 = await pool3.fill([{ x0: 0, y0: 0, z0: 0, x1: 7, y1: 7, z1: 7 }]).then(() => "", (e) => (e as Error).message);
  ok(/bad init/.test(why2), "  and every fill", why2);
  pool3.destroy();

  // Destroying the pool under a world: silent, and whenReady does not hang.
  const pool4 = makeChunkFillPool({ spawn: channel().spawn, init: T, size: 1 });
  const logged: unknown[] = [];
  const world4 = makeChunkedWorld({ target: fakeTarget(), size: SIZE, chunk: CHUNK, seed: 1, fill: pool4, onError: (e) => logged.push(e) });
  world4.focus(32, 32, 100);
  const w4 = world4.whenReady(32, 32, 100).then(() => "resolved", (e) => (e as Error).name);
  pool4.destroy();
  await tick();
  world4.step();
  ok((await w4) === "AbortError" && logged.length === 0, "destroying the pool rejects whenReady with an AbortError and reports nothing", `${logged.length}`);
}

console.log("pool:");
{
  const { spawn } = channel();
  const pool = makeChunkFillPool({ spawn, init: T, size: 1, depth: 1 });
  const box: Box = { x0: 0, y0: 0, z0: 0, x1: 15, y1: 31, z1: 15 };
  const ctrl = new AbortController();
  const a = pool.fill([box]);
  const b = pool.fill([box], { signal: ctrl.signal });
  ctrl.abort();
  const bWhy = await b.then(() => "", (e) => (e as Error).name);
  const r = await a;
  ok(bWhy === "AbortError" && r.count > 0 && r.origins.length >= r.count * 3, "an aborted queued request rejects; the other resolves", bWhy);
  ok(pool.pending === 0 && pool.capacity === 1, "  nothing is left pending");
  pool.destroy();
  const late = await pool.fill([box]).then(() => "", (e) => (e as Error).name);
  ok(late === "AbortError", "a fill after destroy rejects");
  let threw = "";
  try { makeChunkedWorld({ target: fakeTarget(), size: SIZE, chunk: 60, seed: 1, fill: pool }); } catch (e) { threw = (e as Error).message; }
  ok(/multiple of the 8-voxel brick/.test(threw), "fill with a chunk that is not a multiple of 8 throws", threw);
  threw = "";
  try { makeChunkedWorld({ target: fakeTarget(), size: SIZE, chunk: 64, seed: 1 }); } catch (e) { threw = (e as Error).message; }
  ok(/give `generate`/.test(threw), "neither generate nor fill throws", threw);
}

console.log(`\n${checks - failed}/${checks} chunk-fill checks passed`);
if (failed) process.exit(1);
