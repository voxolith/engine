// Headless checks for the instance layer and a crowd drawn by instances.  bun tools/verify-instances.ts

import type { Clip, Entity, EntityModel, Rig } from "../src/entity";
import { makeInstanceLayer, type InstancePlacement, type InstanceTarget } from "../src/instances";
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
  let last: readonly InstancePlacement[] = [];
  const t: InstanceTarget = {
    addModel: () => { adds++; live.add(next); return next++; },
    removeModel: (id) => { removes++; live.delete(id); },
    setInstances: (list) => { last = list; },
  };
  return { t, live, stats: () => ({ adds, removes, last }) };
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

console.log(`\n${checks - failed}/${checks} instance checks passed`);
if (failed) process.exit(1);
