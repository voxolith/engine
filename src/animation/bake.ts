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
  /** Weld each posed joint so a child bone cannot come off its parent (default true). */
  weld?: boolean;
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
  // Every cell written, so the later passes visit only the model, not the
  // (mostly empty) posed box.
  const written = new Int32Array(Math.max(16, model.data.length));
  let nWritten = 0;
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
    // Rest-space box of this bone's voxels (half-open), to clip each row.
    const rx0 = box[o], ry0 = box[o + 1], rz0 = box[o + 2], rx1 = box[o + 3] + 1, ry1 = box[o + 4] + 1, rz1 = box[o + 5] + 1;
    for (let z = pbox[o + 2]; z <= pbox[o + 5]; z++)
      for (let y = pbox[o + 1]; y <= pbox[o + 4]; y++) {
        const cy = y + 0.5, cz = z + 0.5;
        const by = i01 * cy + i02 * cz + i03, bgy = i11 * cy + i12 * cz + i13, bz = i21 * cy + i22 * cz + i23;
        // Along the row the rest position is linear in x: solve for the x span
        // that lands inside the bone's rest box instead of visiting every cell.
        let xa = pbox[o] + 0.5, xb = pbox[o + 3] + 0.5;
        const clip = (base: number, slope: number, lo: number, hi: number) => {
          if (Math.abs(slope) < 1e-9) {
            if (base < lo || base >= hi) { xa = 1; xb = 0; }
            return;
          }
          let t0 = (lo - base) / slope, t1 = (hi - base) / slope;
          if (t0 > t1) { const t = t0; t0 = t1; t1 = t; }
          if (t0 > xa) xa = t0;
          if (t1 < xb) xb = t1;
        };
        clip(by, i00, rx0, rx1);
        clip(bgy, i10, ry0, ry1);
        clip(bz, i20, rz0, rz1);
        if (xa > xb) continue;
        const xs = Math.max(pbox[o], Math.floor(xa - 0.5)), xe = Math.min(pbox[o + 3], Math.ceil(xb - 0.5));
        let di = (xs - x0) + (y - y0) * ox + (z - z0) * oxy;
        for (let x = xs; x <= xe; x++, di++) {
          const cx = x + 0.5;
          const rx = Math.floor(i00 * cx + by), ry = Math.floor(i10 * cx + bgy), rz = Math.floor(i20 * cx + bz);
          if (rx < 0 || ry < 0 || rz < 0 || rx >= sx || ry >= sy || rz >= sz) continue;
          const ri = rx + ry * sx + rz * sxy;
          const v = rest[ri];
          if (!v || restBones[ri] !== b || data[di]) continue;
          data[di] = v;
          outBones[di] = b;
          if (src) src[di] = ri + 1;
          if (nWritten < written.length) written[nWritten++] = di;
        }
      }
  }

  if (opts.weld !== false) {
    // Weld joints. Each bone samples only its own rest voxels, so where a
    // child turns against its parent the two can end up touching at an edge
    // or a corner only, and a thin limb comes off. Around each posed joint,
    // fill the empty cells of a 3x3x3 block from the rest model through
    // either bone's inverse, taking voxels of either bone. The rest model
    // decides what is solid, so a weld never adds bulk the body did not have.
    const jp: Vec3 = [0, 0, 0], rp: Vec3 = [0, 0, 0];
    for (let b = 0; b < n; b++) {
      const par = rig.bones[b].parent;
      if (par < 0 || !counts[b] || !counts[par]) continue;
      const h = rig.bones[b].head;
      transformPoint(world, b * 12, h[0], h[1], h[2], jp);
      const jx = Math.floor(jp[0]), jy = Math.floor(jp[1]), jz = Math.floor(jp[2]);
      for (let dz = -1; dz <= 1; dz++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const x = jx + dx, y = jy + dy, z = jz + dz;
            if (x <= x0 || y <= y0 || z <= z0 || x >= x1 || y >= y1 || z >= z1) continue;
            const di = (x - x0) + (y - y0) * ox + (z - z0) * oxy;
            if (data[di]) continue;
            for (const via of [b, par]) {
              transformPoint(inv, via * 12, x + 0.5, y + 0.5, z + 0.5, rp);
              const rx = Math.floor(rp[0]), ry = Math.floor(rp[1]), rz = Math.floor(rp[2]);
              if (rx < 0 || ry < 0 || rz < 0 || rx >= sx || ry >= sy || rz >= sz) continue;
              const ri = rx + ry * sx + rz * sxy;
              const v = rest[ri];
              if (!v || (restBones[ri] !== b && restBones[ri] !== par)) continue;
              data[di] = v;
              outBones[di] = restBones[ri];
              if (src) src[di] = ri + 1;
              if (nWritten < written.length) written[nWritten++] = di;
              break;
            }
          }
    }
  }

  if (opts.weld !== false) {
    // Bridge diagonal-only contacts. Resampling a one- or two-voxel limb at an
    // angle leaves neighbours touching along an edge or at a corner, which a
    // renderer draws as a gap and a flood fill counts as two pieces. Where two
    // cells of the same bone (or a bone and its parent) meet only diagonally,
    // fill one cell between them, as gen-kit's line3 does when authoring. The
    // candidates come from the cells written so far, so the pass stays small.
    const par = Int32Array.from(rig.bones, (b) => b.parent);
    // The 20 non-face neighbours as (dx, dy, dz) triples.
    const diag: number[] = [];
    for (let dz = -1; dz <= 1; dz++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) if ((dx ? 1 : 0) + (dy ? 1 : 0) + (dz ? 1 : 0) >= 2) diag.push(dx, dy, dz);
    const put = (q: number, v: number, bone: number) => {
      data[q] = v;
      outBones[q] = bone;
      if (nWritten < written.length) written[nWritten++] = q;
    };
    const end = nWritten;
    for (let k = 0; k < end; k++) {
      const i = written[k];
      const bi = outBones[i], v = data[i];
      const x = i % ox, y = ((i / ox) | 0) % oy, z = (i / oxy) | 0;
      if (x < 1 || y < 1 || z < 1 || x >= ox - 1 || y >= oy - 1 || z >= oz - 1) continue;
      for (let d = 0; d < diag.length; d += 3) {
        const dx = diag[d], dy = diag[d + 1] * ox, dz = diag[d + 2] * oxy;
        const j = i + dx + dy + dz;
        const bj = outBones[j];
        if (!data[j] || (bj !== bi && par[bj] !== bi && par[bi] !== bj)) continue;
        if (!dx || !dy || !dz) {
          // Edge: joined when either shared face neighbour is solid.
          const s1 = dx ? i + dx : i + dy, s2 = dz ? i + dz : i + dy;
          if (data[s1] || data[s2]) continue;
          put(s1, v, bi);
          continue;
        }
        // Corner: joined when some face path i → a → b → j is solid.
        if ((data[i + dx] && (data[i + dx + dy] || data[i + dx + dz])) ||
          (data[i + dy] && (data[i + dy + dx] || data[i + dy + dz])) ||
          (data[i + dz] && (data[i + dz + dx] || data[i + dz + dy]))) continue;
        if (!data[i + dx]) put(i + dx, v, bi);
        if (!data[i + dx + dy]) put(i + dx + dy, v, bi);
      }
    }
  }

  const solid6 = (i: number) =>
    (data[i - 1] ? 1 : 0) + (data[i + 1] ? 1 : 0) + (data[i - ox] ? 1 : 0) + (data[i + ox] ? 1 : 0) + (data[i - oxy] ? 1 : 0) + (data[i + oxy] ? 1 : 0);
  const firstSolid = (i: number) =>
    data[i - 1] ? i - 1 : data[i + 1] ? i + 1 : data[i - ox] ? i - ox : data[i + ox] ? i + ox : data[i - oxy] ? i - oxy : i + oxy;

  if (opts.fill !== false) {
    // Close cracks: an empty cell boxed in by solid on at least 5 sides takes
    // a neighbour's value. Candidates are the empty neighbours of written
    // cells; decisions are made first and applied after, so fills do not feed
    // each other. (The padding keeps every neighbour in range.)
    const fills: number[] = [];
    const seen = new Uint8Array(data.length);
    const nb = [1, -1, ox, -ox, oxy, -oxy];
    for (let k = 0; k < nWritten; k++) {
      const w = written[k];
      for (let q = 0; q < 6; q++) {
        const i = w + nb[q];
        if (data[i] || seen[i]) continue;
        seen[i] = 1;
        const x = i % ox, y = ((i / ox) | 0) % oy, z = (i / oxy) | 0;
        if (x < 1 || y < 1 || z < 1 || x >= ox - 1 || y >= oy - 1 || z >= oz - 1) continue;
        if (solid6(i) >= 5) fills.push(i, firstSolid(i));
      }
    }
    for (let k = 0; k < fills.length; k += 2) {
      data[fills[k]] = data[fills[k + 1]];
      outBones[fills[k]] = outBones[fills[k + 1]];
      // Filled cells have no rest voxel, so the cover pass treats them as newly exposed.
      if (nWritten < written.length) written[nWritten++] = fills[k];
    }
  }

  if (cover && src) {
    const surf = restSurface(model);
    for (let k = 0; k < nWritten; k++) {
      const i = written[k];
      const v = data[i];
      if (!v || !cover[v]) continue;
      if (src[i] && surf[src[i] - 1]) continue; // already outside at rest: a wound, or a detail
      if (solid6(i) === 6) continue;
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
