// Headless checks for @voxolith/engine/animation.  bun tools/verify-animation.ts

import type { Clip, EntityModel, Rig } from "../src/entity";
import {
  bakePose,
  makeAnimator,
  poseMatrices,
  prepareRigged,
  quatAxisAngle,
  restPose,
  sampleClip,
  sever,
  transformPoint,
  wound,
} from "../src/animation/index";
import { INST_WORDS, maxPoseWords, packInstance, packPose, partBoxes, sampleInstance as sampleCpu } from "@voxolith/renderer/core";

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

console.log("posing on the GPU (renderer parts) matches baking:");
{
  // A 12-bone limb that bends in several directions, with varied roles, a fractional anchor
  // aligned to the lattice as described below, drawn two ways: baked and placed as a plain
  // instance, and as one instance with per-part transforms (what the renderer samples on the GPU).
  const size = { x: 16, y: 16, z: 44 };
  const data = new Uint8Array(size.x * size.y * size.z);
  const bones = new Uint8Array(data.length);
  for (let z = 0; z < size.z; z++) for (let y = 0; y < size.y; y++) for (let x = 0; x < size.x; x++) {
    const r = 6 - z * 0.08, dx = x - 7.5, dy = y - 7.5;
    if (dx * dx + dy * dy > r * r) continue;
    const i = x + y * size.x + z * size.x * size.y;
    data[i] = 1 + ((x + 2 * y + 3 * z) % 5);
    bones[i] = Math.min(11, Math.floor(z / 3.6));
  }
  const rig: Rig = { bones: Array.from({ length: 12 }, (_, k) => ({ id: `b${k}`, parent: k - 1, head: [8, 8, k * 3.6] as [number, number, number], tail: [8, 8, (k + 1) * 3.6] as [number, number, number] })) };
  const model: EntityModel = { size, data, bones, anchor: [8, 0, 22], roles: [1, 2, 3, 4, 5].map((r) => ({ id: `r${r}`, name: `r${r}`, color: [1, 1, 1] as [number, number, number] })) };
  const rest = prepareRigged(model, rig, new Uint8Array(0));
  const pb = partBoxes(rest.size, rest.data, rest.parts, 12);
  const at = { x: 60, y: 30, z: 60 };
  const sxy = size.x * size.y;
  const restLookup = { size, voxel: (x: number, y: number, z: number) => rest.data[x + y * size.x + z * sxy], part: (x: number, y: number, z: number) => rest.data[x + y * size.x + z * sxy] ? rest.parts[x + y * size.x + z * sxy] + 1 : 0 };
  let worst = 0, cells = 0;
  for (let f = 0; f < 24; f++) {
    const pose = restPose(12);
    for (let k = 1; k < 12; k++) pose.rotations.set(quatAxisAngle(k % 3 === 0 ? [1, 0, 0] : [0, 1, 0], 0.25 * Math.sin(f * 0.7 + k)), k * 4);
    const mats = poseMatrices(rig, pose);
    // Baked (no weld or crack fill, no cover): what bake step one writes, drawn as an instance.
    const posed = bakePose(model, rig, mats, { weld: false, fill: false, cover: new Uint8Array(0) });
    const P = posed.size, pxy = P.x * P.y;
    const w1 = new Uint32Array(INST_WORDS);
    const b1 = packInstance({ ...at, anchor: posed.anchor, base: 1 }, { size: P }, 0, w1, 0).box;
    const baked = new Map<number, number>();
    const key = (x: number, y: number, z: number) => x + y * 1000 + z * 1000000;
    for (let z = Math.floor(b1[2]); z < Math.ceil(b1[5]); z++) for (let y = Math.floor(b1[1]); y < Math.ceil(b1[4]); y++) for (let x = Math.floor(b1[0]); x < Math.ceil(b1[3]); x++) {
      const v = sampleCpu(w1, 0, undefined, { size: P, voxel: (a, b, c) => posed.data[a + b * P.x + c * pxy], part: () => 0 }, x, y, z);
      if (v) baked.set(key(x, y, z), v);
    }
    // Posed on the GPU: the pose packed once in model space, one instance naming it, no weld
    // (joints unset).
    const poses = new Uint32Array(maxPoseWords({ size, partBoxes: pb }));
    const packed = packPose(mats, { size, partBoxes: pb }, poses, 0);
    const w2 = new Uint32Array(INST_WORDS);
    const b2 = packInstance({ ...at, anchor: rest.anchor, base: 1, parts: mats }, { size, partBoxes: pb }, 0, w2, 0, { off: 0, box: packed.box }).box;
    let diff = 0;
    const seen = new Set<number>();
    for (let z = Math.floor(b2[2]); z < Math.ceil(b2[5]); z++) for (let y = Math.floor(b2[1]); y < Math.ceil(b2[4]); y++) for (let x = Math.floor(b2[0]); x < Math.ceil(b2[3]); x++) {
      const v = sampleCpu(w2, 0, poses, restLookup, x, y, z);
      if (!v) continue;
      const k = key(x, y, z);
      seen.add(k);
      if (baked.get(k) !== v) diff++;
    }
    for (const k of baked.keys()) if (!seen.has(k)) diff++;
    worst = Math.max(worst, diff);
    cells += baked.size;
  }
  ok(worst === 0, `a pose sampled per part draws exactly the cells baking writes (24 poses, ${cells} cells)`, `${worst} cells differ`);
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
  // A guard against order-of-magnitude regressions only; CI runners are slow and parallel.
  ok(us < 25000, `baking a rat-sized model (${solid(model)} voxels, 12 bones) takes ${us.toFixed(0)} µs`);
}

console.log(`\n${checks - failed}/${checks} animation checks passed`);
if (failed) process.exit(1);
