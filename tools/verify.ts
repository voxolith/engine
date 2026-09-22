// Headless checks for the engine's entity handling. No GPU.
//
//   bun run --cwd engine verify

import { blitModel, PaletteAllocator } from "../src/palette";
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
