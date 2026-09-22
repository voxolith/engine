// Headless checks for the engine's entity handling. No GPU.
//
//   bun run --cwd engine verify

import { blitModel, PaletteAllocator } from "../src/palette";
import { blitModelToBricks } from "../src/sink";
import { makeChunkedWorld } from "../src/chunks";
import { scatterRegion } from "../src/scatter";
import { BrickGrid } from "@voxolith/renderer/core";
import { ORIENTATIONS, orientModel, orientedSize, orientAnchor, type Orientation } from "../src/orient";
import { makeVariantPool } from "../src/variants";
import { voxelCount } from "../src/entity";
import type { Entity, EntityModel, Role } from "../src/entity";
import { seededRandom } from "@voxolith/renderer/core";

let failed = 0;
let checks = 0;
function ok(cond: boolean, what: string, detail = ""): void {
  checks++;
  if (cond) console.log(`  ✓ ${what}`);
  else {
    failed++;
    console.log(`  ✗ ${what}${detail ? ` — ${detail}` : ""}`);
  }
}

const roles: Role[] = Array.from({ length: 4 }, (_, i) => ({
  id: `r${i}`,
  name: `R${i}`,
  color: [i / 4, 0.5, 1 - i / 4] as [number, number, number],
}));

/** An asymmetric model, so a wrong rotation cannot accidentally look right. */
function makeModel(sx: number, sy: number, sz: number): EntityModel {
  const data = new Uint8Array(sx * sy * sz);
  const rng = seededRandom(4242);
  for (let z = 0; z < sz; z++)
    for (let y = 0; y < sy; y++)
      for (let x = 0; x < sx; x++)
        if (rng() < 0.3) data[x + y * sx + z * sx * sy] = 1 + ((rng() * 4) | 0);
  // A unique marker in one corner pins the handedness.
  data[0] = 4;
  return { size: { x: sx, y: sy, z: sz }, data, anchor: [sx / 2, 0, sz / 2], roles };
}

console.log("orientation:");
{
  const model = makeModel(5, 3, 7);
  const before = voxelCount(model);

  ok(orientModel(model, 0) === model, "orientation 0 is the identity (same object)");

  let allPreserve = true;
  let allDistinct = true;
  const seen = new Set<string>();
  for (const o of ORIENTATIONS) {
    const m = orientModel(model, o);
    if (voxelCount(m) !== before) allPreserve = false;
    const s = orientedSize(model.size, o);
    if (m.size.x !== s.x || m.size.y !== s.y || m.size.z !== s.z) allPreserve = false;
    seen.add(Array.from(m.data).join(","));
  }
  ok(allPreserve, "every orientation preserves voxel count and reports the right size");
  allDistinct = seen.size === ORIENTATIONS.length;
  ok(allDistinct, "the 8 orientations are all distinct", `${seen.size} distinct`);

  // Four yaw steps must return to the start; mirroring twice likewise.
  const yaw4 = [1, 1, 1, 1].reduce((m) => orientModel(m, 1), model as EntityModel);
  ok(
    yaw4.data.join() === model.data.join() && yaw4.size.x === model.size.x,
    "four 90° yaw steps return to the original",
  );
  const mirror2 = orientModel(orientModel(model, 4), 4);
  ok(mirror2.data.join() === model.data.join(), "mirroring twice returns to the original");
}

console.log("\nblit with orientation:");
{
  // Blitting with an orientation must equal blitting a pre-oriented copy: the
  // in-place path is an optimisation and must not diverge from the obvious one.
  const model = makeModel(6, 4, 5);
  const size = { x: 32, y: 16, z: 32 };
  let same = true;
  let firstBad = "";
  for (const o of ORIENTATIONS) {
    const a = { size, data: new Uint8Array(size.x * size.y * size.z) };
    const b = { size, data: new Uint8Array(size.x * size.y * size.z) };
    const boxA = blitModel(a, model, { x: 16, y: 2, z: 16 }, 10, o as Orientation);
    const boxB = blitModel(b, orientModel(model, o), { x: 16, y: 2, z: 16 }, 10);
    if (a.data.join() !== b.data.join()) {
      same = false;
      if (!firstBad) firstBad = `orientation ${o}`;
    }
    if (JSON.stringify(boxA) !== JSON.stringify(boxB)) {
      same = false;
      if (!firstBad) firstBad = `orientation ${o} dirty box`;
    }
  }
  ok(same, "blit(orientation) matches blit(orientModel(...))", firstBad);

  // The anchor must stay put: an oriented tree still stands where it was planted.
  let anchored = true;
  for (const o of ORIENTATIONS) {
    const a = orientAnchor(o as Orientation, model.anchor, model.size);
    const s = orientedSize(model.size, o as Orientation);
    if (a[0] < -1 || a[2] < -1 || a[0] > s.x || a[2] > s.z) anchored = false;
    if (a[1] !== model.anchor[1]) anchored = false;
  }
  ok(anchored, "oriented anchors stay inside the oriented box and keep their height");
}

console.log("\nbrick sink (no dense array):");
{
  // Writing a model through the sink must land exactly where blitModel puts it
  // in a dense world — that equivalence is the whole basis for dropping the
  // dense array on large scenes.
  const model = makeModel(7, 5, 6);
  const size = { x: 48, y: 24, z: 48 };
  let same = true;
  let firstBad = "";
  for (const o of ORIENTATIONS) {
    const dense = { size, data: new Uint8Array(size.x * size.y * size.z) };
    blitModel(dense, model, { x: 20, y: 4, z: 26 }, 30, o as Orientation);

    const bricks = new BrickGrid(size);
    blitModelToBricks(
      { edit: (box, fill) => { bricks.editBox(box, fill); } },
      model, { x: 20, y: 4, z: 26 }, 30, o as Orientation,
    );
    for (let z = 0; z < size.z && same; z++)
      for (let y = 0; y < size.y && same; y++)
        for (let x = 0; x < size.x && same; x++) {
          const want = dense.data[x + y * size.x + z * size.x * size.y];
          if (bricks.get(x, y, z) !== want) {
            same = false;
            firstBad = `orientation ${o} at ${x},${y},${z}: dense ${want}, bricks ${bricks.get(x, y, z)}`;
          }
        }
  }
  ok(same, "blitModelToBricks matches blitModel for all 8 orientations", firstBad);

  // Two overlapping stamps must compose the same way too.
  const size2 = { x: 32, y: 16, z: 32 };
  const dense = { size: size2, data: new Uint8Array(size2.x * size2.y * size2.z) };
  const bricks = new BrickGrid(size2);
  const target = { edit: (box: any, fill: any) => { bricks.editBox(box, fill); } };
  const m1 = makeModel(6, 6, 6);
  const m2 = makeModel(5, 7, 4);
  blitModel(dense, m1, { x: 12, y: 2, z: 12 }, 20);
  blitModelToBricks(target, m1, { x: 12, y: 2, z: 12 }, 20);
  blitModel(dense, m2, { x: 14, y: 3, z: 13 }, 40);
  blitModelToBricks(target, m2, { x: 14, y: 3, z: 13 }, 40);
  let overlapSame = true;
  for (let z = 0; z < size2.z && overlapSame; z++)
    for (let y = 0; y < size2.y && overlapSame; y++)
      for (let x = 0; x < size2.x && overlapSame; x++)
        if (bricks.get(x, y, z) !== dense.data[x + y * size2.x + z * size2.x * size2.y]) overlapSame = false;
  ok(overlapSame, "overlapping stamps compose identically");
}

console.log("\nchunked world:");
{
  // The property everything rests on: a chunk must come out the same whatever
  // order chunks were built in. Build the same world twice, once in reading
  // order and once shuffled, and compare every voxel.
  const size = { x: 128, y: 32, z: 128 };
  const CHUNK = 32;
  const model = makeModel(9, 11, 7); // wider than a chunk is tall — it straddles

  function buildWorld(order: "forward" | "shuffled"): BrickGrid {
    const bricks = new BrickGrid(size);
    const target = {
      edit: (box: any, fill: any) => { bricks.editBox(box, fill); },
      clear: (box: any) => { bricks.clearBox(box); },
    };
    const world = makeChunkedWorld({
      target, size, chunk: CHUNK, seed: 99,
      generate(ctx) {
        // Terrain: a flat slab, so any difference is down to entity placement.
        ctx.edit({ ...ctx.box, y1: 3 }, (cells) => { cells.fill(7); return true; });
        // Scan a margin beyond the chunk so entities rooted outside still draw
        // the part of themselves that reaches in.
        const M = 16;
        scatterRegion({ cell: 24, seed: 99, salt: 1 },
          ctx.box.x0 - M, ctx.box.z0 - M, ctx.box.x1 + M, ctx.box.z1 + M,
          (pt) => {
            if (pt.rng() > 0.6) return;
            const o = Math.floor(pt.rng() * 8) as Orientation;
            ctx.blit(model, { x: pt.x, y: 4, z: pt.z }, 20, o);
          });
      },
    });
    const all: [number, number][] = [];
    for (let cz = 0; cz < size.z / CHUNK; cz++) for (let cx = 0; cx < size.x / CHUNK; cx++) all.push([cx, cz]);
    if (order === "shuffled") {
      const r = seededRandom(5);
      for (let i = all.length - 1; i > 0; i--) { const j = (r() * (i + 1)) | 0; [all[i], all[j]] = [all[j], all[i]]; }
    }
    // focus() queues by distance, so drive the order explicitly.
    for (const [cx, cz] of all) {
      world.focus(cx * CHUNK + CHUNK / 2, cz * CHUNK + CHUNK / 2, 1, Infinity);
      world.step(1e9);
    }
    return bricks;
  }

  const a = buildWorld("forward");
  const b = buildWorld("shuffled");
  let diff = 0;
  let firstBad = "";
  for (let z = 0; z < size.z; z++)
    for (let y = 0; y < size.y; y++)
      for (let x = 0; x < size.x; x++)
        if (a.get(x, y, z) !== b.get(x, y, z)) {
          if (!diff) firstBad = `at ${x},${y},${z}: ${a.get(x, y, z)} vs ${b.get(x, y, z)}`;
          diff++;
        }
  ok(diff === 0, "chunk build order does not change the world", `${diff} voxels differ, ${firstBad}`);
  ok(a.stats().used > 0, "the chunked world actually built something", `${a.stats().used} bricks`);

  // Eviction must free bricks and leave neighbours untouched.
  const before = a.stats().used;
  a.clearBox({ x0: 0, y0: 0, z0: 0, x1: CHUNK - 1, y1: size.y - 1, z1: CHUNK - 1 });
  const after = a.stats().used;
  ok(after < before, "evicting a chunk frees its bricks", `${before} -> ${after}`);
  let survived = 0;
  for (let z = CHUNK; z < size.z; z++) for (let x = CHUNK; x < size.x; x++) if (a.get(x, 2, z)) survived++;
  ok(survived > 0, "  neighbouring chunks survive the eviction", `${survived} voxels left`);
}

console.log("\nvariant pool:");
{
  let built = 0;
  const pool = makeVariantPool({
    count: 6,
    make: (i) => {
      built++;
      return {
        id: `v${i}`,
        kind: "test",
        model: makeModel(3 + i, 4, 3),
        meta: {},
      } satisfies Entity;
    },
  });
  ok(pool.generated === 0 && built === 0, "pool generates nothing until something is picked");

  const rng = seededRandom(7);
  const picks = Array.from({ length: 200 }, () => pool.pick(rng));
  ok(built <= 6, "never builds more models than the pool size", `built ${built}`);
  ok(pool.generated === built, "reports how many it built", `${pool.generated} vs ${built}`);
  ok(new Set(picks.map((p) => p.index)).size > 1, "spreads picks across the pool");
  ok(new Set(picks.map((p) => p.orientation)).size > 4, "uses a range of orientations");
  ok(
    picks.every((p) => p.entity === pool.at(p.index, rng).entity),
    "the same index always returns the same cached model",
  );
  ok(
    200 / Math.max(1, built) > 10,
    "200 placements cost at most a handful of generations",
    `${built} generations for 200 placements`,
  );
}

console.log("\npalette allocation:");
{
  const alloc = new PaletteAllocator(1);
  const e = (id: string): Entity => ({ id, kind: "t", model: makeModel(2, 2, 2), meta: {} });
  const a = alloc.allocateFor(e("a"), "species:a");
  const b = alloc.allocateFor(e("b"), "species:a");
  ok(a.base === b.base, "the same key reuses one slot range");
  const c = alloc.allocateFor(e("c"), "species:b");
  ok(c.base !== a.base, "a different key gets its own range");
}

console.log(`\n${failed ? `${failed} of ${checks} checks FAILED` : `ALL ${checks} CHECKS PASSED`}`);
process.exit(failed ? 1 : 0);
