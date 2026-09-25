// Headless checks for the instance layer and a crowd drawn by instances.  bun tools/verify-instances.ts

import type { Clip, Entity, EntityModel, Rig } from "../src/entity";
import { makeInstanceLayer, orientationYaw, type InstancePlacement, type InstanceTarget } from "../src/instances";
import { blitModel } from "../src/palette";
import type { Orientation } from "../src/orient";
import { makeAnimator, makeCrowd, type CrowdMember } from "../src/animation";

let failed = 0, checks = 0;
const ok = (c: boolean, m: string, d = "") => {
  checks++;
  if (c) console.log(`  ✓ ${m}`);
  else { failed++; console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); }
};

// A target that records what it is asked to do.
function mockTarget() {
  const live = new Set<number>();
  let next = 0, adds = 0, removes = 0;
  let fixed: readonly InstancePlacement[] = [], moving: readonly InstancePlacement[] = [];
  let staticSends = 0;
  const t: InstanceTarget = {
    addModel: () => { adds++; live.add(next); return next++; },
    removeModel: (id) => { removes++; live.delete(id); },
    setInstances: (list, o) => { if (o?.dynamic) moving = list; else { fixed = list; staticSends++; } },
  };
  return { t, live, stats: () => ({ adds, removes, last: [...fixed, ...moving], staticSends }) };
}

const box = (sx: number, sy: number, sz: number, v = 1): EntityModel => ({
  size: { x: sx, y: sy, z: sz }, data: new Uint8Array(sx * sy * sz).fill(v), anchor: [sx / 2, 0, sz / 2], roles: [{ id: "a", name: "a", color: [1, 1, 1] }],
});

console.log("instance layer:");
{
  const m = mockTarget();
  const layer = makeInstanceLayer(m.t);
  const tree = box(6, 20, 6), rock = box(4, 3, 4);
  layer.setStatic(Array.from({ length: 50 }, (_, i) => ({ model: i % 3 ? tree : rock, x: i * 10, y: 5, z: 3, yaw: i * 0.37, base: 20 })));
  layer.commit();
  ok(m.stats().adds === 2 && m.stats().last.length === 50, "fifty placements of two models upload two models");
  const p = m.stats().last[7];
  ok(p.yaw === 7 * 0.37 && p.anchor?.[0] === 3 && p.x === 70, "  placements keep their exact heading, position and the model's anchor");
  layer.setDynamic([{ model: 0, x: 1.25, y: 2, z: 3.5, yaw: 1, base: 40 }]);
  layer.commit();
  ok(m.stats().last.length === 51 && layer.count() === 51, "  moving placements are sent after the static ones");
  ok(m.stats().staticSends === 1, "  scenery is sent once, not every commit");
}

console.log("a crowd drawn by instances:");
{
  // A two-bone worm with a wag clip.
  const model = box(4, 4, 12);
  model.bones = new Uint8Array(model.data.length).map((_, i) => (Math.floor(i / 16) >= 6 ? 1 : 0));
  const rig: Rig = { bones: [{ id: "a", parent: -1, head: [2, 2, 0], tail: [2, 2, 6] }, { id: "b", parent: 0, head: [2, 2, 6], tail: [2, 2, 12] }] };
  const s = Math.sin(0.3), c = Math.cos(0.3);
  const clip: Clip = { id: "wag", duration: 1, loop: true, tracks: [{ bone: 1, times: [0, 0.5, 1], rotations: [0, 0, 0, 1, 0, s, 0, c, 0, 0, 0, 1] }] };
  const worm: Entity = { id: "worm", kind: "worm", model, rig, clips: [clip], meta: {} };
  const m = mockTarget();
  const layer = makeInstanceLayer(m.t);
  const crowd = makeCrowd({ instances: layer, budgetMs: 1000 });
  const members: CrowdMember[] = Array.from({ length: 40 }, (_, i) => {
    const anim = makeAnimator(worm, "wag");
    return { id: i + 1, entity: worm, variant: "worm", anim, base: 10, x: i * 3.3, y: 1, z: 0.5, yaw: i * 0.1 };
  });
  crowd.update(members, [0, 0, 0]);
  const first = m.stats();
  ok(first.last.length === 40 && first.adds === 1, `forty worms on the same frame share one pose model, whatever their heading (${first.adds} uploaded)`);
  ok(first.last[5].yaw === 0.5 && first.last[5].x === 5 * 3.3, "  each keeps its exact yaw and fractional position");
  // Advance through the whole clip: one model per frame at 12 fps.
  for (let f = 0; f < 24; f++) {
    for (const mb of members) mb.anim.update(1 / 12);
    crowd.update(members, [0, 0, 0]);
  }
  ok(m.stats().adds === 12, `  a one-second clip at 12 fps needs 12 pose models (${m.stats().adds})`);
  ok(crowd.cache.stats().entries === 12, "  and the pose cache holds exactly those");
}

console.log("instances match stamped orientations:");
{
  // The renderer's instance sampling (grid.wesl toModel/instanceVoxel), in TS.
  const sampleInstance = (m: EntityModel, p: InstancePlacement, wx: number, wy: number, wz: number): number => {
    const a0 = p.anchor ?? [m.size.x / 2, 0, m.size.z / 2];
    const an = p.mirror ? [m.size.x - 1 - a0[0], a0[1], a0[2]] : a0;
    const c = Math.cos(p.yaw ?? 0), s = Math.sin(p.yaw ?? 0);
    const dx = wx + 0.5 - p.x - 0.5, dy = wy + 0.5 - p.y, dz = wz + 0.5 - p.z - 0.5;
    let qx = Math.floor(c * dx - s * dz + an[0] + 0.5);
    const qy = Math.floor(dy + an[1]), qz = Math.floor(s * dx + c * dz + an[2] + 0.5);
    if (p.mirror) qx = m.size.x - 1 - qx;
    if (qx < 0 || qy < 0 || qz < 0 || qx >= m.size.x || qy >= m.size.y || qz >= m.size.z) return 0;
    const v = m.data[qx + qy * m.size.x + qz * m.size.x * m.size.y];
    return v ? p.base + v - 1 : 0;
  };
  // An asymmetric model with a fractional-free anchor off centre.
  const m = box(7, 4, 5);
  for (let i = 0; i < m.data.length; i++) m.data[i] = (i * 7919) % 5 === 0 ? 0 : 1 + (i % 3);
  m.anchor = [2, 0, 1];
  m.roles = [0, 1, 2].map((r) => ({ id: `r${r}`, name: `r${r}`, color: [1, 1, 1] as [number, number, number] }));
  let worst = 0;
  for (let o = 0; o < 8; o++) {
    const size = { x: 24, y: 8, z: 24 };
    const world = { size, data: new Uint8Array(size.x * size.y * size.z) };
    blitModel(world, m, { x: 12, y: 1, z: 11 }, 20, o as Orientation);
    const { yaw, mirror } = orientationYaw(o);
    const p: InstancePlacement = { model: 0, x: 12, y: 1, z: 11, anchor: m.anchor, yaw, mirror, base: 20 };
    let diff = 0;
    for (let z = 0; z < size.z; z++) for (let y = 0; y < size.y; y++) for (let x = 0; x < size.x; x++)
      if (world.data[x + y * size.x + z * size.x * size.y] !== sampleInstance(m, p, x, y, z)) diff++;
    worst = Math.max(worst, diff);
  }
  ok(worst === 0, "an instance turned by orientationYaw(o) covers exactly the voxels stamping with orientation o writes, for all 8", `${worst} cells differ`);
}

console.log(`\n${checks - failed}/${checks} instance checks passed`);
if (failed) process.exit(1);
