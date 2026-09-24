// Headless checks for @voxolith/engine/animation.  bun tools/verify-animation.ts

import type { Clip, EntityModel, Rig } from "../src/entity";
import {
  bakePose,
  makeAnimator,
  poseMatrices,
  quatAxisAngle,
  restPose,
  sampleClip,
  sever,
  transformPoint,
  wound,
} from "../src/animation/index";

let failed = 0, checks = 0;
const ok = (c: boolean, m: string, d = "") => {
  checks++;
  if (c) console.log(`  ✓ ${m}`);
  else { failed++; console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); }
};
const near = (a: number, b: number, e = 1e-4) => Math.abs(a - b) < e;
const solid = (m: EntityModel) => m.data.reduce((n, v) => n + (v ? 1 : 0), 0);

/** Largest 6-connected component as a fraction of solid voxels. */
function connected(m: EntityModel): number {
  const { x: sx, y: sy } = m.size, sxy = sx * sy, d = m.data;
  const seen = new Uint8Array(d.length);
  let best = 0, total = 0;
  for (let i = 0; i < d.length; i++) if (d[i]) total++;
  for (let i = 0; i < d.length; i++) {
    if (!d[i] || seen[i]) continue;
    const st = [i]; seen[i] = 1; let n = 0;
    while (st.length) {
      const j = st.pop()!; n++;
      const x = j % sx, y = ((j / sx) | 0) % sy, z = (j / sxy) | 0;
      for (const [k, inb] of [[j - 1, x > 0], [j + 1, x < sx - 1], [j - sx, y > 0], [j + sx, y < sy - 1], [j - sxy, z > 0], [j + sxy, z < m.size.z - 1]] as const)
        if (inb && d[k] && !seen[k]) { seen[k] = 1; st.push(k); }
    }
    best = Math.max(best, n);
  }
  return total ? best / total : 1;
}

/**
 * A test rod standing on +y: a 5x40x5 column, bone 0 owns y < 20, bone 1 the
 * rest (with the joint at y = 20). Role 1 outside, role 2 inside, to check
 * interiors survive posing.
 */
function rod(): { model: EntityModel; rig: Rig } {
  const size = { x: 5, y: 40, z: 5 };
  const data = new Uint8Array(size.x * size.y * size.z);
  const bones = new Uint8Array(data.length);
  for (let z = 0; z < 5; z++) for (let y = 0; y < 40; y++) for (let x = 0; x < 5; x++) {
    const i = x + y * 5 + z * 200;
    data[i] = x === 0 || x === 4 || z === 0 || z === 4 ? 1 : 2;
    bones[i] = y < 20 ? 0 : 1;
  }
  const roles = [{ id: "skin", name: "Skin", color: [1, 0, 0] as [number, number, number] }, { id: "flesh", name: "Flesh", color: [0, 1, 0] as [number, number, number] }];
  return {
    model: { size, data, bones, anchor: [2.5, 0, 2.5], roles },
    rig: { bones: [{ id: "lower", parent: -1, head: [2.5, 0, 2.5], tail: [2.5, 20, 2.5] }, { id: "upper", parent: 0, head: [2.5, 20, 2.5], tail: [2.5, 40, 2.5] }] },
  };
}

console.log("kinematics:");
{
  const { rig } = rod();
  const pose = restPose(2);
  pose.rotations.set(quatAxisAngle([0, 0, 1], Math.PI / 2), 4);
  const m = poseMatrices(rig, pose);
  const p = transformPoint(m, 12, 2.5, 40, 2.5, [0, 0, 0]);
  ok(near(p[0], -17.5) && near(p[1], 20) && near(p[2], 2.5), `a 90° bend about the joint swings the tip to the side (${p.map((v) => v.toFixed(2))})`);
  const q = transformPoint(m, 0, 2.5, 10, 2.5, [0, 0, 0]);
  ok(near(q[0], 2.5) && near(q[1], 10), "the parent bone stays where it was");
  pose.rotations.set(quatAxisAngle([0, 0, 1], Math.PI / 2), 0);
  const m2 = poseMatrices(rig, pose);
  const tip = transformPoint(m2, 12, 2.5, 40, 2.5, [0, 0, 0]);
  // Root turns 90° about its head (2.5, 0): the joint goes to (-17.5, 0) and
  // the already-bent tip (-17.5, 20) to (-17.5, -20).
  ok(near(tip[0], -17.5) && near(tip[1], -20), `rotations compose down the chain (tip at ${tip.map((v) => v.toFixed(2))})`);
}

console.log("clips:");
{
  const q = quatAxisAngle([1, 0, 0], Math.PI / 2);
  const clip: Clip = { id: "nod", duration: 1, loop: true, tracks: [{ bone: 1, times: [0, 0.5, 1], rotations: [0, 0, 0, 1, ...q, 0, 0, 0, 1] }] };
  const at = (t: number) => Array.from(sampleClip(clip, t, 2).rotations.slice(4, 8));
  ok(at(0).every((v, i) => near(v, [0, 0, 0, 1][i])) && at(0.5).every((v, i) => near(v, q[i])), "keys are hit exactly");
  const mid = at(0.25);
  ok(near(mid[0], Math.sin(Math.PI / 8)), "between keys the rotation is spherically interpolated (half the angle at the midpoint)");
  ok(at(1).every((v, i) => near(v, at(0)[i])) && at(1.25).every((v, i) => near(v, at(0.25)[i])), "a loop closes and wraps");
}

console.log("baking:");
{
  const { model, rig } = rod();
  const rest = bakePose(model, rig, poseMatrices(rig, restPose(2)), { fill: false });
  ok(solid(rest) === solid(model), `the rest pose bakes to the rest model (${solid(rest)} of ${solid(model)} voxels)`);
  let interior = 0;
  for (const v of rest.data) if (v === 2) interior++;
  ok(interior === 3 * 3 * 40, "interior roles are carried through");

  for (const deg of [30, 45, 90]) {
    const pose = restPose(2);
    pose.rotations.set(quatAxisAngle([0, 0, 1], (deg * Math.PI) / 180), 4);
    const bent = bakePose(model, rig, poseMatrices(rig, pose));
    const ratio = solid(bent) / solid(model);
    ok(ratio > 0.9 && ratio < 1.25, `a ${deg}° bend keeps the rod's volume (${(ratio * 100).toFixed(0)}%)`);
    ok(connected(bent) > 0.995, `  and it stays one piece (${(connected(bent) * 100).toFixed(1)}%)`);
  }
  for (const yawDeg of [22.5, 45, 137]) {
    const turned = bakePose(model, rig, poseMatrices(rig, restPose(2)), { yaw: (yawDeg * Math.PI) / 180 });
    const ratio = solid(turned) / solid(model);
    ok(ratio > 0.9 && ratio < 1.25 && connected(turned) > 0.995, `turned ${yawDeg}° about the anchor it keeps its volume (${(ratio * 100).toFixed(0)}%) in one piece`);
  }
  const pose = restPose(2);
  pose.rotations.set(quatAxisAngle([1, 0, 0], 0.7), 4);
  const a = bakePose(model, rig, poseMatrices(rig, pose), { yaw: 0.4 });
  const b = bakePose(model, rig, poseMatrices(rig, pose), { yaw: 0.4 });
  ok(a.data.every((v, i) => v === b.data[i]), "baking is deterministic");
  ok(!!a.bones && a.bones.length === a.data.length, "the baked model keeps its bone per voxel (for hit tests)");
}

console.log("damage:");
{
  const { model, rig } = rod();
  const w = wound(model, [2.5, 10, 0], 2.5, { rim: 2 });
  ok(solid(w) < solid(model), `a wound removes voxels (${solid(model) - solid(w)})`);
  let exposed = 0;
  for (let i = 0; i < w.data.length; i++) if (w.data[i] === 2 && model.data[i] === 1) exposed++;
  ok(exposed > 0, "and its rim shows the inner role");
  const cut = sever(model, rig, 1);
  ok(!!cut.piece && solid(cut.body) + solid(cut.piece.model) === solid(model), "severing conserves every voxel between body and piece");
  ok(!!cut.piece && cut.piece.rig.bones.length === 1 && cut.piece.rig.bones[0].parent === -1, "the piece gets its own rig, rooted at the cut");
  ok(!!cut.piece && cut.piece.origin[1] === 20, "and remembers where it was attached");
}

console.log("cover:");
{
  const { model, rig } = rod();
  // Exposed role-2 (inside) voxels on the posed surface, excluding the rod's
  // two end caps, which are outside at rest anyway.
  const exposedInside = (m: EntityModel) => {
    const { x: sx, y: sy } = m.size, sxy = sx * sy;
    let n = 0;
    for (let i = 0; i < m.data.length; i++) {
      if (m.data[i] !== 2) continue;
      const nbrs = [i - 1, i + 1, i - sx, i + sx, i - sxy, i + sxy];
      if (nbrs.some((j) => j < 0 || j >= m.data.length || !m.data[j])) n++;
    }
    return n;
  };
  const pose = restPose(2);
  pose.rotations.set(quatAxisAngle([0, 0, 1], (70 * Math.PI) / 180), 4);
  const mats = poseMatrices(rig, pose);
  const bare = bakePose(model, rig, mats);
  const covered = bakePose(model, { ...rig, cover: [0, 0, 1] }, mats);
  ok(exposedInside(covered) < exposedInside(bare), `a bend no longer shows the inside at the joint (${exposedInside(bare)} -> ${exposedInside(covered)} exposed voxels)`);
  ok(exposedInside(covered) <= 2 * 9, "only the rod's own end caps show their inside");
  const hurt = wound(model, [2.5, 10, 0], 2.5);
  const shown = bakePose(hurt, { ...rig, cover: [0, 0, 1] }, poseMatrices(rig, restPose(2)));
  ok(exposedInside(shown) > exposedInside(bakePose(model, { ...rig, cover: [0, 0, 1] }, poseMatrices(rig, restPose(2)))), "but a wound still shows what is inside");
}

console.log("animator:");
{
  const { model, rig } = rod();
  const q = quatAxisAngle([1, 0, 0], 1);
  const clips: Clip[] = [
    { id: "still", duration: 1, loop: true, tracks: [] },
    { id: "bent", duration: 1, loop: true, tracks: [{ bone: 1, times: [0], rotations: [...q] }], events: [{ t: 0.5, name: "step" }] },
  ];
  const anim = makeAnimator({ id: "r", kind: "test", model, meta: {}, rig, clips }, "still");
  anim.play("bent", { fade: 1 });
  const first = anim.update(0.5);
  const half = anim.pose().rotations[4];
  ok(half > 0.01 && half < q[0] - 0.01, `a crossfade passes through the middle (${half.toFixed(3)} of ${q[0].toFixed(3)})`);
  const ev = [...first, ...anim.update(0.1), ...anim.update(1)];
  ok(ev.filter((e) => e.name === "step").length === 2, `events fire each time they are crossed, across loops (${ev.length})`);
}

console.log("cost:");
{
  // A rat-sized model: 34x14x40 box, 12 bones in a chain, most cells solid.
  const size = { x: 14, y: 14, z: 40 };
  const data = new Uint8Array(size.x * size.y * size.z);
  const bones = new Uint8Array(data.length);
  for (let z = 0; z < size.z; z++) for (let y = 0; y < size.y; y++) for (let x = 0; x < size.x; x++) {
    const dx = x - 6.5, dy = y - 6.5;
    if (dx * dx + dy * dy > 40) continue;
    const i = x + y * size.x + z * size.x * size.y;
    data[i] = 1;
    bones[i] = Math.min(11, Math.floor(z / 3.4));
  }
  const rig: Rig = { bones: Array.from({ length: 12 }, (_, k) => ({ id: `b${k}`, parent: k - 1, head: [7, 7, k * 3.4] as [number, number, number], tail: [7, 7, (k + 1) * 3.4] as [number, number, number] })) };
  const model: EntityModel = { size, data, bones, anchor: [7, 0, 20], roles: [{ id: "a", name: "A", color: [1, 1, 1] }] };
  const pose = restPose(12);
  for (let k = 1; k < 12; k++) pose.rotations.set(quatAxisAngle([0, 1, 0], 0.12), k * 4);
  const mats = poseMatrices(rig, pose);
  bakePose(model, rig, mats, { yaw: 0.3 });
  const N = 300, t0 = performance.now();
  for (let i = 0; i < N; i++) bakePose(model, rig, mats, { yaw: 0.3 + i * 0.001 });
  const us = ((performance.now() - t0) / N) * 1000;
  ok(us < 2500, `baking a rat-sized model (${solid(model)} voxels, 12 bones) takes ${us.toFixed(0)} µs`);
}

console.log(`\n${checks - failed}/${checks} animation checks passed`);
if (failed) process.exit(1);
