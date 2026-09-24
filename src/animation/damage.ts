// Damage on rigged models, as pure functions: a game calls them, keeps the
// results and throws the pieces around; nothing here knows about physics.
//
// Both work on the rest model, so damage follows the creature through every
// pose it is baked into afterwards. A generator that layers its interior
// (bone, flesh, organs under the skin) gets gore for free: carving simply
// exposes what is underneath.

import type { Bone, EntityModel, Rig, Vec3 } from "../entity";

export interface WoundOptions {
  /** Role value painted on the wound's rim (blood), if any. */
  rim?: number;
}

/** Remove the voxels within `radius` of a rest-space point; optionally paint the rim. */
export function wound(model: EntityModel, point: Vec3, radius: number, opts: WoundOptions = {}): EntityModel {
  const { x: sx, y: sy, z: sz } = model.size;
  const sxy = sx * sy;
  const data = model.data.slice();
  const bones = model.bones?.slice();
  const r = Math.max(0.5, radius), r2 = r * r, rr = (r + 1.2) * (r + 1.2);
  const [px, py, pz] = point;
  const lo = (v: number) => Math.max(0, Math.floor(v - r - 2));
  for (let z = lo(pz); z <= Math.min(sz - 1, Math.ceil(pz + r + 2)); z++)
    for (let y = lo(py); y <= Math.min(sy - 1, Math.ceil(py + r + 2)); y++)
      for (let x = lo(px); x <= Math.min(sx - 1, Math.ceil(px + r + 2)); x++) {
        const i = x + y * sx + z * sxy;
        if (!data[i]) continue;
        const d2 = (x + 0.5 - px) ** 2 + (y + 0.5 - py) ** 2 + (z + 0.5 - pz) ** 2;
        if (d2 <= r2) data[i] = 0;
        else if (opts.rim && d2 <= rr) data[i] = opts.rim;
      }
  return { ...model, data, bones };
}

export interface Severed {
  /** What is left, still on the original rig (the severed bones own no voxels). */
  body: EntityModel;
  /** The cut-off part: its own model, anchored at the cut, with its own sub-rig. */
  piece: { model: EntityModel; rig: Rig; /** Where the piece's anchor sat in the body's rest space. */ origin: Vec3 } | null;
}

/** Every bone in the subtree rooted at `bone`. */
export function subtree(rig: Rig, bone: number): Set<number> {
  const out = new Set([bone]);
  for (let i = bone + 1; i < rig.bones.length; i++) if (out.has(rig.bones[i].parent)) out.add(i);
  return out;
}

/**
 * Cut a bone and everything below it off the model. The stump and the cut
 * face of the piece get the rim role (blood, raw flesh) when given.
 */
export function sever(model: EntityModel, rig: Rig, bone: number, opts: WoundOptions = {}): Severed {
  if (!model.bones) throw new Error("sever needs a rigged model (model.bones)");
  const cut = subtree(rig, bone);
  const { x: sx, y: sy, z: sz } = model.size;
  const sxy = sx * sy;
  const body = model.data.slice();
  const pieceMask = new Uint8Array(body.length);
  let x0 = sx, y0 = sy, z0 = sz, x1 = -1, y1 = -1, z1 = -1, count = 0;
  for (let z = 0, i = 0; z < sz; z++)
    for (let y = 0; y < sy; y++)
      for (let x = 0; x < sx; x++, i++) {
        if (!body[i] || !cut.has(model.bones[i])) continue;
        pieceMask[i] = 1;
        count++;
        if (x < x0) x0 = x; if (y < y0) y0 = y; if (z < z0) z0 = z;
        if (x > x1) x1 = x; if (y > y1) y1 = y; if (z > z1) z1 = z;
      }
  if (!count) return { body: { ...model, data: body }, piece: null };

  // Rim on both sides of the cut: body voxels touching the piece, and piece
  // voxels touching the body.
  const touches = (i: number, x: number, y: number, z: number, wantPiece: boolean) => {
    const check = (j: number) => model.data[j] !== 0 && (pieceMask[j] === 1) === wantPiece;
    return (x > 0 && check(i - 1)) || (x < sx - 1 && check(i + 1)) || (y > 0 && check(i - sx)) ||
      (y < sy - 1 && check(i + sx)) || (z > 0 && check(i - sxy)) || (z < sz - 1 && check(i + sxy));
  };
  const psx = x1 - x0 + 1, psy = y1 - y0 + 1, psz = z1 - z0 + 1;
  const pdata = new Uint8Array(psx * psy * psz);
  const pbones = new Uint8Array(pdata.length);
  const remap = new Map<number, number>();
  const pieceBones: Bone[] = [];
  const shift = (v: Vec3): Vec3 => [v[0] - x0, v[1] - y0, v[2] - z0];
  for (let i = bone; i < rig.bones.length; i++) {
    if (!cut.has(i)) continue;
    const b = rig.bones[i];
    remap.set(i, pieceBones.length);
    pieceBones.push({ id: b.id, parent: i === bone ? -1 : remap.get(b.parent) ?? -1, head: shift(b.head), tail: shift(b.tail) });
  }
  for (let z = z0; z <= z1; z++)
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const i = x + y * sx + z * sxy;
        if (!pieceMask[i]) continue;
        const j = (x - x0) + (y - y0) * psx + (z - z0) * psx * psy;
        pdata[j] = opts.rim && touches(i, x, y, z, false) ? opts.rim : model.data[i];
        pbones[j] = remap.get(model.bones[i]) ?? 0;
      }
  for (let z = 0, i = 0; z < sz; z++)
    for (let y = 0; y < sy; y++)
      for (let x = 0; x < sx; x++, i++) {
        if (pieceMask[i]) { body[i] = 0; continue; }
        if (opts.rim && body[i] && touches(i, x, y, z, true)) body[i] = opts.rim;
      }
  const head = rig.bones[bone].head;
  return {
    body: { ...model, data: body, bones: model.bones },
    piece: {
      model: { size: { x: psx, y: psy, z: psz }, data: pdata, bones: pbones, anchor: shift(head), roles: model.roles },
      rig: { bones: pieceBones },
      origin: [head[0], head[1], head[2]],
    },
  };
}
