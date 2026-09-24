// Headless checks for makeBrickStamper against a real BrickGrid.  bun tools/verify-dynamic.ts

import { BrickGrid } from "@voxolith/renderer/core";
import { makeBrickStamper, toSprite } from "../src/dynamic";
import type { EntityModel } from "../src/entity";

let failed = 0, checks = 0;
const ok = (c: boolean, m: string, d = "") => {
  checks++;
  if (c) console.log(`  ✓ ${m}`);
  else { failed++; console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); }
};

const size = { x: 96, y: 32, z: 96 };
function world() {
  const g = new BrickGrid(size);
  // Ground up to y = 4 (slot 1), a pillar (slot 2).
  g.editBox({ x0: 0, y0: 0, z0: 0, x1: 95, y1: 31, z1: 95 }, (cells, ox, oy, oz) => {
    let any = false;
    for (let z = 0; z < 8; z++) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const wx = ox + x, wy = oy + y, wz = oz + z;
      const v = wy <= 4 ? 1 : wx >= 40 && wx < 44 && wz >= 40 && wz < 44 && wy < 20 ? 2 : 0;
      if (v) { cells[x + y * 64 / 8 + z * 64] = v; any = true; }
    }
    return any;
  });
  return g;
}
const snapshot = (g: BrickGrid) => {
  const out = new Uint8Array(size.x * size.y * size.z);
  for (let z = 0; z < size.z; z++) for (let y = 0; y < size.y; y++) for (let x = 0; x < size.x; x++) out[x + y * size.x + z * size.x * size.y] = g.get(x, y, z);
  return out;
};
const same = (a: Uint8Array, b: Uint8Array) => a.every((v, i) => v === b[i]);

/** A solid 10x6x14 block model with a 1-voxel shell of role 1 and core of role 2. */
function block(): EntityModel {
  const s = { x: 10, y: 6, z: 14 };
  const data = new Uint8Array(s.x * s.y * s.z).fill(2);
  for (let z = 0; z < s.z; z++) for (let y = 0; y < s.y; y++) for (let x = 0; x < s.x; x++)
    if (x === 0 || y === 0 || z === 0 || x === s.x - 1 || y === s.y - 1 || z === s.z - 1) data[x + y * s.x + z * s.x * s.y] = 1;
  return { size: s, data, anchor: [5, 0, 7], roles: [] };
}

const g = world();
const base = snapshot(g);
const target = { edit: (b: any, f: any) => void g.editBox(b, f), editMany: (bs: any[], f: any) => { for (const b of bs) g.editBox(b, f); } };
const st = makeBrickStamper(target, { size });
const sprite = toSprite(block());
ok(sprite.cells.length === 10 * 6 * 14 - 8 * 4 * 12, `a sprite keeps only the surface (${sprite.cells.length} of ${10 * 6 * 14})`);

st.put(1, sprite, { x: 30, y: 5, z: 30 }, 10);
st.commit();
ok(g.get(30, 5, 30) === 10 && g.get(25, 5, 23) === 10, "a placed mover appears, its roles mapped to base + v - 1");
st.put(1, sprite, { x: 36, y: 5, z: 44 }, 10);
const s1 = st.commit();
ok(g.get(30, 5, 26) === 0 && g.get(36, 5, 44) === 10, `moving it clears where it was and writes where it is (${s1.bricks} bricks)`);
ok(g.get(40, 8, 41) === 10, "it may overlap scenery (its face runs through the pillar)");
st.put(2, sprite, { x: 40, y: 5, z: 48 }, 20); // overlaps mover 1
st.commit();
st.put(1, sprite, { x: 60, y: 5, z: 60 }, 10); // move 1 away; 2 must stay whole
st.commit();
let hole = false;
for (const c of sprite.cells) {
  const x = 40 - 5 + (c % 10), y = 5 + (((c / 10) | 0) % 6), z = 48 - 7 + ((c / 60) | 0);
  if (g.get(x, y, z) !== 20) hole = true;
}
ok(!hole, "moving one of two overlapping movers leaves every voxel of the other in place");
const quiet = st.commit();
ok(quiet.bricks === 0, "a commit with nothing changed touches nothing");
st.remove(1);
st.remove(2);
st.commit();
ok(same(snapshot(g), base), "removing every mover leaves the world exactly as it was, pillar and all");

// Cost: 300 movers wandering.
const g2 = world();
const st2 = makeBrickStamper({ edit: (b: any, f: any) => void g2.editBox(b, f), editMany: (bs: any[], f: any) => { for (const b of bs) g2.editBox(b, f); } }, { size });
const pos = Array.from({ length: 300 }, (_, i) => [8 + ((i * 37) % 80), 5, 8 + ((i * 61) % 80)]);
for (let i = 0; i < 300; i++) st2.put(i, sprite, { x: pos[i][0], y: 5, z: pos[i][2] }, 10);
st2.commit();
const t0 = performance.now();
let bricks = 0;
const frames = 30;
for (let f = 0; f < frames; f++) {
  for (let i = 0; i < 300; i++) st2.put(i, sprite, { x: pos[i][0] + (f % 3), y: 5, z: pos[i][2] }, 10);
  bricks += st2.commit().bricks;
}
const ms = (performance.now() - t0) / frames;
// A guard against order-of-magnitude regressions only; CI runners are slow and parallel.
ok(ms < 400, `300 movers all moving: ${ms.toFixed(1)} ms per commit, ${Math.round(bricks / frames)} bricks (CPU side, no upload)`);

console.log(`\n${checks - failed}/${checks} stamper checks passed`);
if (failed) process.exit(1);
