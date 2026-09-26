// Axis-aligned orientations for voxel models.
//
// Placing the same model many times is how a scene gets a thousand plants out of
// a dozen generated ones, but copies of one model all facing the same way read
// as wallpaper. The eight axis-aligned orientations — four yaw steps of 90° and
// an optional mirror — fix that for free: they are pure index permutations, so
// nothing is resampled and no extra memory is allocated.
//
// Arbitrary angles are deliberately not offered. Rotating a voxel grid by
// anything other than a right angle means resampling it, which blurs or shreds
// exactly the one-voxel twigs and grass blades the generators work hardest to
// keep 6-connected.

import type { EntityModel, Size, Vec3 } from "./entity";

/** Low two bits are the yaw step (×90°); bit 2 mirrors along x first. */
export type Orientation = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** All eight orientations, for picking one at random or iterating. */
export const ORIENTATIONS: readonly Orientation[] = [0, 1, 2, 3, 4, 5, 6, 7];

/** Does this orientation swap the x and z extents? */
export function swapsXZ(o: Orientation): boolean {
  return (o & 1) === 1;
}

/** Model size after orienting. */
export function orientedSize(size: Size, o: Orientation): Size {
  return swapsXZ(o) ? { x: size.z, y: size.y, z: size.x } : { x: size.x, y: size.y, z: size.z };
}

/**
 * Map a voxel coordinate through an orientation.
 *
 * Reversal uses `extent - 1 - i` so the transform is an exact permutation of
 * voxel indices, and `orientAnchor` mirrors it with the same `- 1` so a model
 * and its anchor never drift apart.
 */
export function orientVoxel(
  o: Orientation,
  x: number,
  y: number,
  z: number,
  size: Size,
  out: [number, number, number],
): [number, number, number] {
  // Mirror first, in the model's own frame, so yaw composes on top of it.
  const mx = o & 4 ? size.x - 1 - x : x;
  switch (o & 3) {
    case 0:
      out[0] = mx; out[2] = z;
      break;
    case 1:
      out[0] = size.z - 1 - z; out[2] = mx;
      break;
    case 2:
      out[0] = size.x - 1 - mx; out[2] = size.z - 1 - z;
      break;
    default:
      out[0] = z; out[2] = size.x - 1 - mx;
      break;
  }
  out[1] = y;
  return out;
}

/** Map an anchor through an orientation, using the same convention as voxels. */
export function orientAnchor(o: Orientation, anchor: Vec3, size: Size): Vec3 {
  const mx = o & 4 ? size.x - 1 - anchor[0] : anchor[0];
  const z = anchor[2];
  switch (o & 3) {
    case 0:
      return [mx, anchor[1], z];
    case 1:
      return [size.z - 1 - z, anchor[1], mx];
    case 2:
      return [size.x - 1 - mx, anchor[1], size.z - 1 - z];
    default:
      return [z, anchor[1], size.x - 1 - mx];
  }
}

/**
 * Materialise an oriented copy. Placement does not need this — `blitModel`
 * applies an orientation while writing — but exporting or previewing a rotated
 * model does.
 */
export function orientModel(model: EntityModel, o: Orientation): EntityModel {
  if (o === 0) return model;
  const size = orientedSize(model.size, o);
  const data = new Uint8Array(size.x * size.y * size.z);
  const p: [number, number, number] = [0, 0, 0];
  const { x: sx, y: sy, z: sz } = model.size;
  for (let z = 0; z < sz; z++)
    for (let y = 0; y < sy; y++)
      for (let x = 0; x < sx; x++) {
        const v = model.data[x + y * sx + z * sx * sy];
        if (v === 0) continue;
        orientVoxel(o, x, y, z, model.size, p);
        data[p[0] + p[1] * size.x + p[2] * size.x * size.y] = v;
      }
  return { size, data, anchor: orientAnchor(o, model.anchor, model.size), roles: model.roles };
}
