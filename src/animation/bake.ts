// Baking a pose: turn a rigged rest model plus bone matrices into a posed
// voxel model.
//
// Forward-mapping every rest voxel to its posed position leaves holes as soon
// as a bone rotates (neighbouring voxels land two cells apart). This inverse-
// maps instead: for each bone, every cell of its posed bounding box is taken
// back to rest space through that bone's inverse matrix and filled from the
// rest voxel there, if that voxel belongs to the bone. Every posed cell is
// sampled, so rotated limbs stay solid. A final pass closes the one-voxel
// cracks that open on the outside of a bending joint.
//
// A root yaw goes through the same inverse map, so creatures turn at any
// angle. That is resampling, which is why scenery (engine/src/orient.ts)
// sticks to 90° steps; a creature trades one-voxel exactness for motion.

import type { EntityModel, Rig } from "../entity";
import { invertRigid, mulAffine, transformPoint, type Vec3 } from "./math";

export interface BakeOptions {
  /** Turn about the vertical axis through the anchor, radians. */
  yaw?: number;
  /** Close joint cracks (default true). */
  fill?: boolean;
  /**
   * Cover for voxels a pose exposes. When a limb swings, voxels that were
   * buried at rest (flesh under a haunch) end up on the surface; with a table
   * mapping role value → surface role (a generator's interior → fur), those
   * are drawn with the cover instead. Voxels already on the rest surface —
   * including wounds carved into the rest model — are left alone, so damage
   * still shows its inside. Defaults to `rig.cover`.
   */
  cover?: Uint8Array;
}

interface BoneBounds {
  /** Per bone: min x, y, z, max x, y, z (inclusive), or empty when min > max. */
  box: Int32Array;
  counts: Int32Array;
}

const boundsCache = new WeakMap<EntityModel, BoneBounds>();
const surfaceCache = new WeakMap<EntityModel, Uint8Array>();

/** 1 where a rest voxel touches air. */
function restSurface(model: EntityModel): Uint8Array {
  let s = surfaceCache.get(model);
  if (s) return s;
  const { x: sx, y: sy, z: sz } = model.size;
  const sxy = sx * sy, d = model.data;
  s = new Uint8Array(d.length);
  for (let z = 0, i = 0; z < sz; z++)
    for (let y = 0; y < sy; y++)
      for (let x = 0; x < sx; x++, i++) {
        if (!d[i]) continue;
        if (x === 0 || y === 0 || z === 0 || x === sx - 1 || y === sy - 1 || z === sz - 1 ||
          !d[i - 1] || !d[i + 1] || !d[i - sx] || !d[i + sx] || !d[i - sxy] || !d[i + sxy]) s[i] = 1;
      }
  surfaceCache.set(model, s);
  return s;
}

function boneBounds(model: EntityModel, boneCount: number): BoneBounds {
  let b = boundsCache.get(model);
  if (b && b.counts.length === boneCount) return b;
  const box = new Int32Array(boneCount * 6);
  for (let i = 0; i < boneCount; i++) {
    box[i * 6] = box[i * 6 + 1] = box[i * 6 + 2] = 1 << 30;
    box[i * 6 + 3] = box[i * 6 + 4] = box[i * 6 + 5] = -(1 << 30);
  }
  const counts = new Int32Array(boneCount);
  const { x: sx, y: sy, z: sz } = model.size;
  const bones = model.bones!;
  let i = 0;
  for (let z = 0; z < sz; z++)
    for (let y = 0; y < sy; y++)
      for (let x = 0; x < sx; x++, i++) {
        if (!model.data[i]) continue;
        const k = bones[i];
        if (k >= boneCount) continue;
        counts[k]++;
        const o = k * 6;
        if (x < box[o]) box[o] = x;
        if (y < box[o + 1]) box[o + 1] = y;
        if (z < box[o + 2]) box[o + 2] = z;
        if (x > box[o + 3]) box[o + 3] = x;
        if (y > box[o + 4]) box[o + 4] = y;
        if (z > box[o + 5]) box[o + 5] = z;
      }
  b = { box, counts };
  boundsCache.set(model, b);
  return b;
}

export function bakePose(model: EntityModel, rig: Rig, matrices: Float32Array, opts: BakeOptions = {}): EntityModel {
  if (!model.bones) throw new Error("bakePose needs a rigged model (model.bones)");
  const n = rig.bones.length;
  const { box, counts } = boneBounds(model, n);
  const { x: sx, y: sy, z: sz } = model.size;
  const sxy = sx * sy;
  const [ax, ay, az] = model.anchor;

  // World matrix per bone: the yaw about the anchor, after the pose.
  const yaw = opts.yaw ?? 0;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const Y = new Float32Array([c, 0, s, ax - (c * ax + s * az), 0, 1, 0, 0, -s, 0, c, az - (-s * ax + c * az)]);
  const world = new Float32Array(n * 12);
  const inv = new Float32Array(n * 12);
  for (let b = 0; b < n; b++) {
    mulAffine(Y, 0, matrices, b * 12, world, b * 12);
    invertRigid(world, b * 12, inv, b * 12);
  }

  // Posed bounding box of each bone, and of the whole.
  const pbox = new Int32Array(n * 6);
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  const p: Vec3 = [0, 0, 0];
  for (let b = 0; b < n; b++) {
    if (!counts[b]) continue;
    const o = b * 6;
    let bx0 = Infinity, by0 = Infinity, bz0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity;
    for (let k = 0; k < 8; k++) {
      transformPoint(world, b * 12, k & 1 ? box[o + 3] + 1 : box[o], k & 2 ? box[o + 4] + 1 : box[o + 1], k & 4 ? box[o + 5] + 1 : box[o + 2], p);
      bx0 = Math.min(bx0, p[0]); by0 = Math.min(by0, p[1]); bz0 = Math.min(bz0, p[2]);
      bx1 = Math.max(bx1, p[0]); by1 = Math.max(by1, p[1]); bz1 = Math.max(bz1, p[2]);
    }
    pbox[o] = Math.floor(bx0); pbox[o + 1] = Math.floor(by0); pbox[o + 2] = Math.floor(bz0);
    pbox[o + 3] = Math.ceil(bx1) - 1; pbox[o + 4] = Math.ceil(by1) - 1; pbox[o + 5] = Math.ceil(bz1) - 1;
    x0 = Math.min(x0, pbox[o]); y0 = Math.min(y0, pbox[o + 1]); z0 = Math.min(z0, pbox[o + 2]);
    x1 = Math.max(x1, pbox[o + 3]); y1 = Math.max(y1, pbox[o + 4]); z1 = Math.max(z1, pbox[o + 5]);
  }
  if (!isFinite(x0)) return { size: { x: 1, y: 1, z: 1 }, data: new Uint8Array(1), anchor: [0, 0, 0], roles: model.roles, bones: new Uint8Array(1) };

  // Pad by one so the crack pass has neighbours on every side.
  x0--; y0--; z0--; x1++; y1++; z1++;
  const ox = x1 - x0 + 1, oy = y1 - y0 + 1, oz = z1 - z0 + 1, oxy = ox * oy;
  const data = new Uint8Array(ox * oy * oz);
  const outBones = new Uint8Array(ox * oy * oz);
  // Which rest voxel each posed cell came from (+1), for the cover pass.
  const cover = opts.cover ?? (rig.cover ? Uint8Array.from(rig.cover) : undefined);
  const src = cover ? new Int32Array(ox * oy * oz) : null;
  const rest = model.data, restBones = model.bones;

  for (let b = 0; b < n; b++) {
    if (!counts[b]) continue;
    const o = b * 6, m = b * 12;
    const i00 = inv[m], i01 = inv[m + 1], i02 = inv[m + 2], i03 = inv[m + 3];
    const i10 = inv[m + 4], i11 = inv[m + 5], i12 = inv[m + 6], i13 = inv[m + 7];
    const i20 = inv[m + 8], i21 = inv[m + 9], i22 = inv[m + 10], i23 = inv[m + 11];
    for (let z = pbox[o + 2]; z <= pbox[o + 5]; z++)
      for (let y = pbox[o + 1]; y <= pbox[o + 4]; y++) {
        const cy = y + 0.5, cz = z + 0.5;
        const by = i01 * cy + i02 * cz + i03, bgy = i11 * cy + i12 * cz + i13, bz = i21 * cy + i22 * cz + i23;
        let di = (pbox[o] - x0) + (y - y0) * ox + (z - z0) * oxy;
        for (let x = pbox[o]; x <= pbox[o + 3]; x++, di++) {
          const cx = x + 0.5;
          const rx = Math.floor(i00 * cx + by), ry = Math.floor(i10 * cx + bgy), rz = Math.floor(i20 * cx + bz);
          if (rx < 0 || ry < 0 || rz < 0 || rx >= sx || ry >= sy || rz >= sz) continue;
          const ri = rx + ry * sx + rz * sxy;
          const v = rest[ri];
          if (!v || restBones[ri] !== b || data[di]) continue;
          data[di] = v;
          outBones[di] = b;
          if (src) src[di] = ri + 1;
        }
      }
  }

  if (opts.fill !== false) {
    // Close cracks: an empty cell boxed in by solid on at least 5 sides takes
    // a neighbour's value. One pass, reading the unfilled state.
    const snap = data.slice();
    for (let z = 1; z < oz - 1; z++)
      for (let y = 1; y < oy - 1; y++)
        for (let x = 1; x < ox - 1; x++) {
          const i = x + y * ox + z * oxy;
          if (snap[i]) continue;
          let solid = 0, pick = -1;
          for (const j of [i - 1, i + 1, i - ox, i + ox, i - oxy, i + oxy]) {
            if (snap[j]) { solid++; if (pick < 0) pick = j; }
          }
          if (solid >= 5) { data[i] = snap[pick]; outBones[i] = outBones[pick]; }
        }
  }

  if (cover && src) {
    const surf = restSurface(model);
    for (let z = 1; z < oz - 1; z++)
      for (let y = 1; y < oy - 1; y++)
        for (let x = 1; x < ox - 1; x++) {
          const i = x + y * ox + z * oxy;
          const v = data[i];
          if (!v || !cover[v]) continue;
          const r0 = src[i];
          if (r0 && surf[r0 - 1]) continue; // already outside at rest: a wound, or a detail
          if (data[i - 1] && data[i + 1] && data[i - ox] && data[i + ox] && data[i - oxy] && data[i + oxy]) continue;
          data[i] = cover[v];
        }
  }

  return {
    size: { x: ox, y: oy, z: oz },
    data,
    bones: outBones,
    anchor: [ax - x0, ay - y0, az - z0],
    roles: model.roles,
  };
}
