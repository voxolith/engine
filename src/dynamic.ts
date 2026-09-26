// Moving things through a world that lives in bricks.
//
// A creature, a thrown limb or a projectile is stamped into the same brick
// grid as the scenery. Moving it means putting back what it covered and
// writing it somewhere else. GridStamper does that against a dense copy of the
// world; a streamed world has no dense copy, so this keeps, per brick, exactly
// the cells it overwrote and what they held — and does the restore and the
// write inside the same brick edit, reading the brick's current contents.
//
// Movers are handed in as sprites: just their surface voxels (the inside of a
// solid mover is never seen, and skipping it more than halves the work),
// grouped by the brick they land in. Only bricks whose movers changed are
// touched, and all of them go out in one batched edit (Renderer.editMany).

import type { EntityModel } from "./entity";
import type { BrickTarget } from "./sink";

export interface MultiBrickTarget extends BrickTarget {
  /** Edit many small boxes with one upload. `Renderer.editMany` satisfies this. */
  editMany?(boxes: readonly { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }[], fill: (cells: Uint8Array, ox: number, oy: number, oz: number) => boolean): void;
}

/** A model prepared for stamping: the voxels worth writing, as local positions and role values. */
export interface Sprite {
  size: { x: number; y: number; z: number };
  anchor: [number, number, number];
  /** Local linear index (x + y*sx + z*sx*sy) per voxel. */
  cells: Int32Array;
  /** Role value (1-based) per voxel. */
  values: Uint8Array;
}

/** Surface voxels of a model (or all of them), ready to stamp. */
export function toSprite(model: EntityModel, opts: { surfaceOnly?: boolean } = {}): Sprite {
  const { x: sx, y: sy, z: sz } = model.size;
  const sxy = sx * sy, d = model.data;
  const surfaceOnly = opts.surfaceOnly !== false;
  const cells: number[] = [], values: number[] = [];
  for (let z = 0, i = 0; z < sz; z++)
    for (let y = 0; y < sy; y++)
      for (let x = 0; x < sx; x++, i++) {
        const v = d[i];
        if (!v) continue;
        if (surfaceOnly && x > 0 && y > 0 && z > 0 && x < sx - 1 && y < sy - 1 && z < sz - 1 &&
          d[i - 1] && d[i + 1] && d[i - sx] && d[i + sx] && d[i - sxy] && d[i + sxy]) continue;
        cells.push(i);
        values.push(v);
      }
  return { size: model.size, anchor: [...model.anchor] as [number, number, number], cells: Int32Array.from(cells), values: Uint8Array.from(values) };
}

/** What one {@link BrickStamper.commit} did. */
export interface StampStats {
  /** Bricks edited this commit. */
  bricks: number;
  /** Voxels written this commit. */
  voxels: number;
  /** Movers that changed this commit. */
  movers: number;
}

/** Moving voxel models stamped into a brick world, from {@link makeBrickStamper}. */
export interface BrickStamper {
  /**
   * Place mover `id` (or move it). `base` maps role v to palette slot base + v - 1.
   * Nothing changes in the world until `commit`.
   */
  put(id: number, sprite: Sprite, origin: { x: number; y: number; z: number }, base: number): void;
  /** Take mover `id` out, restoring what it covered, on the next `commit`. */
  remove(id: number): void;
  /** Restore what changed movers covered, write them at their new places. */
  commit(): StampStats;
  /** How many movers are placed. */
  readonly size: number;
}

const B = 8;
const KEY_Y = 4096, KEY_Z = 4096 * 4096;
const keyOf = (bx: number, by: number, bz: number) => bx + by * KEY_Y + bz * KEY_Z;

interface Placement {
  sprite: Sprite;
  ox: number;
  oy: number;
  oz: number;
  base: number;
  /** Packed (local brick index << 8 | slot) per brick this placement covers. */
  bricks: Map<number, number[]>;
}

/**
 * Stamp moving things (creatures, thrown limbs, projectiles) into the same brick grid as the
 * scenery, with no dense copy of the world. Per brick it keeps exactly the cells its movers
 * overwrote and what they held; each `commit` restores those and writes the movers at their new
 * places in one batched edit, touching only bricks whose movers changed.
 *
 * Origins are rounded to whole voxels (the sprite's anchor lands on `origin`), and a mover stays
 * where it is until it is put again or removed. Cells under a mover are restored to what they
 * held when it arrived, so an edit made underneath a mover is lost when it leaves. Movers share
 * the world's 8-bit palette: `base` is a slot from the world's {@link PaletteAllocator}. For many
 * animated movers use `makeCrowd` (`@voxolith/engine/animation`); to draw without touching the
 * world, {@link makeInstanceLayer}.
 *
 * @param target - The renderer, or anything with `edit` (and ideally `editMany`).
 * @param opts - `size` clips writes to the world's extent, in voxels.
 * @returns The stamper.
 * @example
 * ```ts
 * const stamper = makeBrickStamper(renderer, { size: SIZE });
 * const sprite = toSprite(bakePose(rat.model, rat.rig!, poseMatrices(rat.rig!, anim.pose())));
 * stamper.put(1, sprite, { x: 120.4, y: 9, z: 88 }, ratBase);
 * stamper.commit();
 * ```
 */
export function makeBrickStamper(
  target: MultiBrickTarget,
  opts: { size?: { x: number; y: number; z: number } } = {},
): BrickStamper {
  const world = opts.size;
  const placed = new Map<number, Placement>();
  const dirty = new Set<number>();
  /** Per brick: what the movers overwrote, in write order (local index, previous value). */
  const saved = new Map<number, number[]>();

  function layout(p: Placement): void {
    p.bricks.clear();
    const { sprite: s, ox, oy, oz } = p;
    const sx = s.size.x, sxy = s.size.x * s.size.y;
    for (let k = 0; k < s.cells.length; k++) {
      const c = s.cells[k];
      const x = ox + (c % sx), y = oy + (((c / sx) | 0) % s.size.y), z = oz + ((c / sxy) | 0);
      if (x < 0 || y < 0 || z < 0 || (world && (x >= world.x || y >= world.y || z >= world.z))) continue;
      const key = keyOf(x >> 3, y >> 3, z >> 3);
      const li = (x & 7) + (y & 7) * B + (z & 7) * B * B;
      const slot = Math.min(255, p.base + s.values[k] - 1);
      let list = p.bricks.get(key);
      if (!list) p.bricks.set(key, (list = []));
      list.push((li << 8) | slot);
    }
  }

  return {
    get size() {
      return placed.size;
    },
    put(id, sprite, origin, base) {
      const ox = Math.round(origin.x - sprite.anchor[0]), oy = Math.round(origin.y - sprite.anchor[1]), oz = Math.round(origin.z - sprite.anchor[2]);
      const cur = placed.get(id);
      if (cur && cur.sprite === sprite && cur.ox === ox && cur.oy === oy && cur.oz === oz && cur.base === base) return;
      const p: Placement = cur ?? { sprite, ox, oy, oz, base, bricks: new Map() };
      // Keep the old brick list until commit, so the restore knows where it was.
      if (cur) {
        (p as Placement & { old?: Map<number, number[]> }).old ??= new Map(cur.bricks);
        Object.assign(p, { sprite, ox, oy, oz, base });
      }
      layout(p);
      placed.set(id, p);
      dirty.add(id);
    },
    remove(id) {
      const cur = placed.get(id);
      if (!cur) return;
      (cur as Placement & { old?: Map<number, number[]> }).old ??= new Map(cur.bricks);
      cur.bricks.clear();
      dirty.add(id);
    },
    commit() {
      if (!dirty.size) return { bricks: 0, voxels: 0, movers: 0 };
      // Bricks to touch: everywhere a changed mover was or is.
      const touched = new Set<number>();
      for (const id of dirty) {
        const p = placed.get(id) as (Placement & { old?: Map<number, number[]> }) | undefined;
        if (!p) continue;
        if (p.old) for (const k of p.old.keys()) touched.add(k);
        for (const k of p.bricks.keys()) touched.add(k);
      }
      // Who is in each touched brick now, in a stable order (ids ascending).
      const inBrick = new Map<number, number[]>();
      for (const [id, p] of placed) {
        for (const k of p.bricks.keys()) {
          if (!touched.has(k)) continue;
          let l = inBrick.get(k);
          if (!l) inBrick.set(k, (l = []));
          l.push(id);
        }
      }
      for (const l of inBrick.values()) l.sort((a, b) => a - b);

      const boxes: { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }[] = [];
      for (const k of touched) {
        const bx = k % KEY_Y, by = Math.floor(k / KEY_Y) % KEY_Y, bz = Math.floor(k / KEY_Z);
        boxes.push({ x0: bx * B, y0: by * B, z0: bz * B, x1: bx * B + 7, y1: by * B + 7, z1: bz * B + 7 });
      }
      let voxels = 0;
      const fill = (cells: Uint8Array, ox: number, oy: number, oz: number): boolean => {
        const k = keyOf(ox >> 3, oy >> 3, oz >> 3);
        if (!touched.has(k)) return false;
        // Put back what was there before any mover, newest write first.
        const prev = saved.get(k);
        if (prev) for (let i = prev.length - 2; i >= 0; i -= 2) cells[prev[i]] = prev[i + 1];
        const now: number[] = [];
        for (const id of inBrick.get(k) ?? []) {
          const list = placed.get(id)!.bricks.get(k)!;
          for (const packed of list) {
            const li = packed >> 8;
            now.push(li, cells[li]);
            cells[li] = packed & 255;
            voxels++;
          }
        }
        if (now.length) saved.set(k, now);
        else saved.delete(k);
        return true;
      };
      if (target.editMany) target.editMany(boxes, fill);
      else for (const b of boxes) target.edit(b, fill);

      const movers = dirty.size;
      for (const id of dirty) {
        const p = placed.get(id) as (Placement & { old?: Map<number, number[]> }) | undefined;
        if (!p) continue;
        delete p.old;
        if (!p.bricks.size) placed.delete(id);
      }
      dirty.clear();
      return { bricks: boxes.length, voxels, movers };
    },
  };
}
