// Palette allocation across a scene.
//
// The renderer has one 256-slot palette for the whole grid, so entities cannot
// each own colours 1..K. The allocator hands every entity a contiguous slot
// range and produces the palette (and optional material block) the renderer
// uploads. Role index `r` of an entity placed at `base` becomes voxel value
// `base + r - 1` in the world grid.

import type { Entity, EntityModel, MaterialHint, RGB, Role } from "./entity";
import { orientAnchor, orientVoxel, type Orientation } from "./orient";

const MATERIAL_KIND = { diffuse: 0, metal: 1, glass: 2, emit: 3, water: 4 } as const;

/** A slot range from {@link PaletteAllocator.allocate}. */
export interface Allocation {
  /** Voxel value of the entity's first role. */
  base: number;
  /** Slots reserved: one per role. */
  count: number;
}

/**
 * Shares the world's 256-slot palette between the entities stamped into it. Each entity (or each
 * key, for entities that look alike) gets a contiguous range, and role `r` of an entity placed at
 * `base` becomes world voxel value `base + r - 1`. Build the renderer's palette and material block
 * from it once everything is allocated; recolouring a range later restyles every copy.
 *
 * Only for what is stamped into the world. Instanced models get palettes of their own
 * (`InstanceLayer.palettes`) and need no slots here. Ranges are never freed.
 *
 * @example
 * ```ts
 * const palette = new PaletteAllocator(1);
 * const { base: groundBase } = palette.allocate(terrain.roles, "terrain");
 * const { base: oakBase } = palette.allocateFor(oak);
 * const renderer = await createRenderer(gpu, {
 *   size: SIZE, palette: palette.buildPalette(), materials: palette.buildMaterials(),
 * });
 * blitModelToBricks(renderer, oak.model, { x: 40, y: 12, z: 40 }, oakBase);
 * ```
 */
export class PaletteAllocator {
  private next: number;
  private readonly capacity: number;
  private readonly slots: (Role | null)[];
  private readonly byKey = new Map<string, Allocation>();

  /**
   * The world's palette: 256 slots, since world voxels are 8-bit. Slot 0 is
   * empty; reserve low slots for a host's own colours if wanted. Instanced
   * models do not need slots here: they get palettes of their own
   * (instancePalette, Renderer.addPalette).
   */
  constructor(firstSlot = 1) {
    this.next = Math.max(1, firstSlot);
    this.capacity = 256;
    this.slots = new Array(this.capacity).fill(null);
  }

  /** Slots handed out so far, counting any reserved below `firstSlot`. */
  get used(): number {
    return this.next - 1;
  }

  /** Slots still available. */
  get free(): number {
    return this.capacity - this.next;
  }

  /**
   * Reserve a range for these roles. `key` deduplicates: two entities from the
   * same generator and style share one range instead of burning the palette.
   *
   * @throws When the roles do not fit in the slots left.
   */
  allocate(roles: Role[], key?: string): Allocation {
    if (key !== undefined) {
      const hit = this.byKey.get(key);
      if (hit) return hit;
    }
    if (this.next + roles.length > this.capacity) {
      throw new Error(`Palette exhausted: need ${roles.length} slots, ${this.free} left`);
    }
    const alloc: Allocation = { base: this.next, count: roles.length };
    for (let i = 0; i < roles.length; i++) this.slots[this.next + i] = roles[i];
    this.next += roles.length;
    if (key !== undefined) this.byKey.set(key, alloc);
    return alloc;
  }

  /** Convenience: allocate for an entity, keyed by kind so clones share slots. */
  allocateFor(entity: Entity, key = entity.kind): Allocation {
    return this.allocate(entity.model.roles, key);
  }

  /** Override one slot's colour, e.g. to tint a single placement. */
  setColor(slot: number, color: RGB): void {
    const role = this.slots[slot];
    if (role) this.slots[slot] = { ...role, color };
  }

  /** 256 × RGBA floats for `RenderScene.palette`. */
  buildPalette(): Float32Array {
    const p = new Float32Array(this.capacity * 4);
    for (let s = 1; s < this.capacity; s++) {
      const role = this.slots[s];
      if (!role) continue;
      p.set([role.color[0], role.color[1], role.color[2], 1], s * 4);
    }
    return p;
  }

  /**
   * 256 × 8 floats for `RenderScene.materials`, or undefined when no role asked
   * for one (the renderer then keeps its cheaper flat-palette path).
   */
  buildMaterials(): Float32Array | undefined {
    let any = false;
    const m = new Float32Array(this.capacity * 8);
    for (let s = 1; s < this.capacity; s++) {
      const hint = this.slots[s]?.material;
      if (!hint) continue;
      any = true;
      writeMaterial(m, s, hint);
    }
    return any ? m : undefined;
  }
}

/**
 * Material block for a single entity placed at `slotMin`, the material twin of
 * entityPalette. Undefined when no role declares a hint, so the renderer keeps
 * its cheaper flat-palette path.
 */
export function entityMaterials(model: EntityModel, slotMin = 1): Float32Array | undefined {
  let any = false;
  const m = new Float32Array(256 * 8);
  for (let i = 0; i < model.roles.length; i++) {
    const s = slotMin + i;
    if (s > 255) break;
    const hint = model.roles[i].material;
    if (!hint) continue;
    any = true;
    writeMaterial(m, s, hint);
  }
  return any ? m : undefined;
}

/**
 * A palette of its own for a set of roles, as Renderer.addPalette takes it:
 * RGBA per role (role r at entry r - 1) and, when any role has a material
 * hint, 8 floats per role. `tint` adjusts colours (a restyled placement).
 */
export function instancePalette(roles: readonly Role[], tint?: (color: RGB, role: Role, index: number) => RGB): { colors: Float32Array; materials?: Float32Array } {
  const colors = new Float32Array(roles.length * 4);
  const mats = new Float32Array(roles.length * 8);
  let any = false;
  roles.forEach((r, i) => {
    const c = tint ? tint(r.color, r, i) : r.color;
    colors.set([c[0], c[1], c[2], 1], i * 4);
    if (r.material) { any = true; writeMaterial(mats, i, r.material); }
  });
  return { colors, materials: any ? mats : undefined };
}

function writeMaterial(m: Float32Array, slot: number, h: MaterialHint): void {
  const o = slot * 8;
  m[o] = MATERIAL_KIND[h.kind];
  m[o + 1] = h.rough ?? 0.3;
  m[o + 2] = h.kind === "metal" ? (h.metal ?? 1) : 0;
  m[o + 3] = h.kind === "emit" ? Math.max(1, h.emit ?? 1) : 0;
  m[o + 4] = h.ior ?? 0.3;
  m[o + 5] = h.kind === "glass" || h.kind === "water" ? (h.alpha ?? 0.25) : 1;
  m[o + 6] = h.att ?? 0;
  m[o + 7] = h.spec ?? 0;
}

/**
 * Copy a model into a dense world grid at `origin`, offsetting roles by `base - 1`. The model's
 * anchor (after orientation) lands on `origin`, rounded to whole voxels; voxels outside the world
 * are dropped. Dense models only. For a world held by the renderer (no dense copy), use
 * {@link blitModelToBricks}.
 *
 * @param base - The entity's palette range start, from {@link PaletteAllocator.allocate}.
 * @param orientation - One of the eight axis-aligned orientations; exact, no resampling.
 * @returns The world-voxel box written, for `renderer.edit` or an occupancy update, or null if
 *   nothing landed in the world.
 * @example
 * ```ts
 * const world = { size: SIZE, data: new Uint8Array(SIZE.x * SIZE.y * SIZE.z) };
 * const { base } = palette.allocateFor(tree);
 * blitModel(world, tree.model, { x: 48, y: 1, z: 48 }, base, 2);
 * ```
 */
export function blitModel(
  world: { size: { x: number; y: number; z: number }; data: Uint8Array },
  model: EntityModel,
  origin: { x: number; y: number; z: number },
  base: number,
  orientation: Orientation = 0,
): { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number } | null {
  const { x: sx, y: sy, z: sz } = model.size;
  // The orientation is applied while writing, so a rotated placement costs
  // nothing extra and never materialises a second copy of the model.
  const anchor = orientation === 0 ? model.anchor : orientAnchor(orientation, model.anchor, model.size);
  const ox = Math.round(origin.x - anchor[0]);
  const oy = Math.round(origin.y - anchor[1]);
  const oz = Math.round(origin.z - anchor[2]);
  const W = world.size;
  const p: [number, number, number] = [0, 0, 0];
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let z = 0; z < sz; z++)
    for (let y = 0; y < sy; y++)
      for (let x = 0; x < sx; x++) {
        const v = model.data[x + y * sx + z * sx * sy];
        if (v === 0) continue;
        if (orientation !== 0) orientVoxel(orientation, x, y, z, model.size, p);
        else { p[0] = x; p[1] = y; p[2] = z; }
        const wx = ox + p[0], wy = oy + p[1], wz = oz + p[2];
        if (wx < 0 || wy < 0 || wz < 0 || wx >= W.x || wy >= W.y || wz >= W.z) continue;
        world.data[wx + wy * W.x + wz * W.x * W.y] = base + v - 1;
        if (wx < x0) x0 = wx;
        if (wx > x1) x1 = wx;
        if (wy < y0) y0 = wy;
        if (wy > y1) y1 = wy;
        if (wz < z0) z0 = wz;
        if (wz > z1) z1 = wz;
      }
  return x1 >= x0 ? { x0, y0, z0, x1, y1, z1 } : null;
}