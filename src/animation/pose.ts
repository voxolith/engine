// Poses: sampling clips, blending, and forward kinematics.
//
// A pose is one rotation per bone, relative to the rest pose and about the
// bone's head, plus an offset for the root. Forward kinematics turns it into
// one rigid matrix per bone that maps rest-pose model space to posed model
// space, which is exactly what baking and hit-testing need.

import type { Clip, Rig } from "../entity";
import { mulAffine, quatToMat, slerpInto, type Vec3 } from "./math";

export interface Pose {
  /** Four numbers (x, y, z, w) per bone. */
  rotations: Float32Array;
  /** Root offset in voxels. */
  root: Vec3;
}

export function restPose(boneCount: number): Pose {
  const rotations = new Float32Array(boneCount * 4);
  for (let i = 0; i < boneCount; i++) rotations[i * 4 + 3] = 1;
  return { rotations, root: [0, 0, 0] };
}

/** Index of the key interval containing t, and how far into it. */
function locate(times: number[], t: number): [number, number] {
  const n = times.length;
  if (n === 1 || t <= times[0]) return [0, 0];
  if (t >= times[n - 1]) return [n - 1, 0];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  return [lo, (t - times[lo]) / (times[hi] - times[lo])];
}

/** Wrap or clamp a time into the clip. */
export function clipTime(clip: Clip, t: number): number {
  if (clip.duration <= 0) return 0;
  if (clip.loop) return ((t % clip.duration) + clip.duration) % clip.duration;
  return Math.max(0, Math.min(clip.duration, t));
}

export function sampleClip(clip: Clip, t: number, boneCount: number, out = restPose(boneCount)): Pose {
  const tt = clipTime(clip, t);
  out.rotations.fill(0);
  for (let i = 0; i < boneCount; i++) out.rotations[i * 4 + 3] = 1;
  for (const tr of clip.tracks) {
    if (tr.bone < 0 || tr.bone >= boneCount || tr.times.length === 0) continue;
    const [k, f] = locate(tr.times, tt);
    const k2 = Math.min(k + 1, tr.times.length - 1);
    slerpInto(out.rotations, tr.bone * 4, tr.rotations, k * 4, tr.rotations, k2 * 4, f);
  }
  out.root = [0, 0, 0];
  if (clip.root && clip.root.times.length) {
    const [k, f] = locate(clip.root.times, tt);
    const k2 = Math.min(k + 1, clip.root.times.length - 1);
    const o = clip.root.offsets;
    for (let a = 0; a < 3; a++) out.root[a] = o[k * 3 + a] + (o[k2 * 3 + a] - o[k * 3 + a]) * f;
  }
  return out;
}

/** Blend two poses: w = 0 is `a`, 1 is `b`. */
export function blendPoses(a: Pose, b: Pose, w: number, out = restPose(a.rotations.length / 4)): Pose {
  const n = a.rotations.length / 4;
  for (let i = 0; i < n; i++) slerpInto(out.rotations, i * 4, a.rotations, i * 4, b.rotations, i * 4, w);
  out.root = [a.root[0] + (b.root[0] - a.root[0]) * w, a.root[1] + (b.root[1] - a.root[1]) * w, a.root[2] + (b.root[2] - a.root[2]) * w];
  return out;
}

/**
 * Forward kinematics: one 3x4 per bone (12 floats each) mapping rest model
 * space to posed model space. Each bone rotates about its own head, inside its
 * parent's posed frame. Bones must be ordered parents first.
 */
export function poseMatrices(rig: Rig, pose: Pose, out = new Float32Array(rig.bones.length * 12)): Float32Array {
  const local = new Float32Array(12);
  for (let i = 0; i < rig.bones.length; i++) {
    const b = rig.bones[i];
    // Local: T(head) · R · T(-head), i.e. rotation R and translation head - R·head.
    quatToMat(pose.rotations, i * 4, local, 0);
    const [hx, hy, hz] = b.head;
    local[3] = hx - (local[0] * hx + local[1] * hy + local[2] * hz);
    local[7] = hy - (local[4] * hx + local[5] * hy + local[6] * hz);
    local[11] = hz - (local[8] * hx + local[9] * hy + local[10] * hz);
    if (b.parent < 0) {
      out.set(local, i * 12);
      out[i * 12 + 3] += pose.root[0];
      out[i * 12 + 7] += pose.root[1];
      out[i * 12 + 11] += pose.root[2];
    } else {
      mulAffine(out, b.parent * 12, local, 0, out, i * 12);
    }
  }
  return out;
}
