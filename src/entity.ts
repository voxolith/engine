// The entity contract.
//
// An entity is the unit the engine places in a world: a voxel model plus an
// anchor and a set of named colour *roles*. Models come either from a `.vox`
// file (see ./vox) or from a generator package (see ./generator), and both
// produce exactly this shape.
//
// Voxel values are role indices, never final colours. A host allocates a slot
// range per entity and maps role `r` to palette slot `slotMin + r - 1`, which
// lets one scene mix many entities inside the renderer's 256-slot palette and
// lets a host restyle an entity (season, faction, damage) without regenerating
// it. The convention follows the decor models in the Catagochi game.

export type Vec3 = [number, number, number];
/** Linear RGB in 0..1, matching the renderer's palette. */
export type RGB = [number, number, number];
export interface Size {
  x: number;
  y: number;
  z: number;
}

/** Optional shading, mirroring the renderer's per-slot material block. */
export interface MaterialHint {
  /**
   * "water" is a transparent, animated surface: the renderer ripples its top
   * faces over time, reflects the sky, and shows the bed through it, fading
   * with depth by `att`.
   */
  kind: "diffuse" | "metal" | "glass" | "emit" | "water";
  /** 0 = mirror-smooth, 1 = fully rough. */
  rough?: number;
  /** Metalness 0..1 (kind "metal"). */
  metal?: number;
  /** Emission strength (kind "emit"). */
  emit?: number;
  /** Index of refraction offset (kind "glass"). */
  ior?: number;
  /** Opacity 0..1 (kinds "glass" and "water"); 0 is clear. */
  alpha?: number;
  /** Attenuation through glass; for water, how fast the bed fades with depth (per voxel). */
  att?: number;
  /** Specular strength. */
  spec?: number;
}

/** One addressable colour of an entity. `roles[i]` describes voxel value `i + 1`. */
export interface Role {
  /** Stable identifier, e.g. "bark.dark". Hosts key restyling off this. */
  id: string;
  /** Human label for editors and previews. */
  name: string;
  /** Default colour, used when the host has no opinion. */
  color: RGB;
  material?: MaterialHint;
}

export interface EntityModel {
  /** Tight bounding box of the occupied voxels, Y-up (y is height). */
  size: Size;
  /** Dense role indices; 0 is empty. Index with `modelIndex`. */
  data: Uint8Array;
  /**
   * Where the entity's origin sits inside the box, in voxels. A tree puts this
   * at the trunk base centre with y = 0, so placing it means aligning the
   * anchor with a ground cell rather than guessing at the box corner.
   */
  anchor: Vec3;
  roles: Role[];
  /**
   * Rigged models only: which bone owns each voxel (index into `Entity.rig.bones`),
   * same indexing as `data`. Meaningless where `data` is 0.
   */
  bones?: Uint8Array;
}

/**
 * One bone of a rig, in the rest pose, in model voxel space. A bone rotates
 * about its `head`; `tail` is where its children usually start.
 */
export interface Bone {
  id: string;
  /** Index of the parent bone, or -1 for the root. Parents come before children. */
  parent: number;
  head: Vec3;
  tail: Vec3;
}

export interface Rig {
  bones: Bone[];
}

/** Keyframed rotations for one bone. Rotations are unit quaternions (x, y, z, w), relative to rest. */
export interface ClipTrack {
  bone: number;
  /** Seconds, ascending, starting at 0. */
  times: number[];
  /** Four numbers per key. */
  rotations: number[];
}

/** A named moment in a clip: a footfall, a bite. For sound, dust, gameplay. */
export interface ClipEvent {
  t: number;
  name: string;
}

export interface Clip {
  id: string;
  /** Seconds. */
  duration: number;
  loop: boolean;
  tracks: ClipTrack[];
  /** Offset of the root in voxels over time (a bob, a crouch): times + 3 numbers per key. */
  root?: { times: number[]; offsets: number[] };
  events?: ClipEvent[];
}

export interface Entity {
  /** Unique within a scene. */
  id: string;
  /** What it is, e.g. "tree.broadleaf". Hosts group and cull by this. */
  kind: string;
  model: EntityModel;
  /** Generator parameters, seed, species, timings — free-form provenance. */
  meta: Record<string, unknown>;
  /** Rigged entities: the skeleton `model.bones` refers to. */
  rig?: Rig;
  /** Rigged entities: the animations that come with it. */
  clips?: Clip[];
}

export const modelIndex = (size: Size, x: number, y: number, z: number): number =>
  x + y * size.x + z * size.x * size.y;

export function modelAt(model: EntityModel, x: number, y: number, z: number): number {
  const { x: sx, y: sy, z: sz } = model.size;
  if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return 0;
  return model.data[x + y * sx + z * sx * sy];
}

/** Number of non-empty voxels. */
export function voxelCount(model: EntityModel): number {
  let n = 0;
  for (let i = 0; i < model.data.length; i++) if (model.data[i] !== 0) n++;
  return n;
}

/** Voxels per role index (1-based; element 0 is the empty count). */
export function roleHistogram(model: EntityModel): number[] {
  const h = new Array<number>(model.roles.length + 1).fill(0);
  for (let i = 0; i < model.data.length; i++) {
    const v = model.data[i];
    if (v < h.length) h[v]++;
  }
  return h;
}

/** 1-based voxel value for a role id, or 0 when the model has no such role. */
export function roleValue(model: EntityModel, id: string): number {
  const i = model.roles.findIndex((r) => r.id === id);
  return i < 0 ? 0 : i + 1;
}

/** 256-entry RGBA float palette for a single entity placed at `slotMin`. */
export function entityPalette(model: EntityModel, slotMin = 1): Float32Array {
  const p = new Float32Array(256 * 4);
  for (let i = 0; i < model.roles.length; i++) {
    const s = slotMin + i;
    if (s > 255) break;
    const c = model.roles[i].color;
    p.set([c[0], c[1], c[2], 1], s * 4);
  }
  return p;
}
