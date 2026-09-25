// Drawing entities by reference instead of stamping them.
//
// Stamping writes every voxel of a model into the world's bricks, so a forest
// of the same six trees costs six trees' worth of memory per copy, a turned
// tree must be resampled into new voxels, and a moving thing re-uploads
// bricks every frame. A renderer that supports instances (Renderer.addModel /
// setInstances) keeps one copy of each model and draws it wherever it is
// placed, at any heading, at fractional positions.
//
// This is the engine side: `makeModelLibrary` uploads each EntityModel once
// (by identity) and `makeInstanceLayer` keeps the static placements (scenery)
// apart from the moving ones (a crowd), sending both in one list.

import type { EntityModel, Vec3 } from "./entity";
import type { SparseVoxels } from "@voxolith/renderer/core";

/** What a renderer offers for instancing; `Renderer` implements it. */
export interface InstanceTarget {
  addModel(src: { size: { x: number; y: number; z: number }; data?: Uint8Array; sparse?: SparseVoxels }): number;
  removeModel(id: number): void;
  /** Replace the static set, or with `dynamic` only the moving one (cheap per frame). */
  setInstances(list: readonly InstancePlacement[], opts?: { dynamic?: boolean }): void;
}

export interface InstancePlacement {
  /** Model id from `addModel` (or ModelLibrary.id). */
  model: number;
  /** Where the model's anchor goes, in world voxels; fractions are fine. */
  x: number;
  y: number;
  z: number;
  /** The model's anchor (model voxels). Default: its base centre. */
  anchor?: Vec3;
  /** Radians about +y, any angle. */
  yaw?: number;
  /** Mirror along the model's x before turning (see `orientationYaw`). */
  mirror?: boolean;
  /** Palette slot of role 1. */
  base: number;
}

/**
 * The instance turn that draws what stamping with an axis-aligned
 * orientation would: `{ yaw, mirror }` for Orientation `o`.
 */
export function orientationYaw(o: number): { yaw: number; mirror: boolean } {
  return { yaw: -(o & 3) * (Math.PI / 2), mirror: (o & 4) !== 0 };
}

export interface ModelLibrary {
  /** The model's id on the target, uploading it the first time it is seen. */
  id(model: EntityModel): number;
  /** Forget a model and free it on the target. */
  release(model: EntityModel): void;
  /** Models uploaded. */
  readonly size: number;
}

export function makeModelLibrary(target: InstanceTarget): ModelLibrary {
  const ids = new Map<EntityModel, number>();
  return {
    id(model) {
      let id = ids.get(model);
      if (id === undefined) {
        id = target.addModel(model.sparse ? { size: model.size, sparse: model.sparse } : { size: model.size, data: model.data });
        ids.set(model, id);
      }
      return id;
    },
    release(model) {
      const id = ids.get(model);
      if (id === undefined) return;
      target.removeModel(id);
      ids.delete(model);
    },
    get size() {
      return ids.size;
    },
  };
}

/** A placement of an entity's model, by model rather than id. */
export interface EntityPlacement {
  model: EntityModel;
  x: number;
  y: number;
  z: number;
  yaw?: number;
  mirror?: boolean;
  base: number;
}

export interface InstanceLayer {
  readonly target: InstanceTarget;
  readonly models: ModelLibrary;
  /** Replace the static placements (scenery); the model's own anchor is used. */
  setStatic(list: readonly EntityPlacement[]): void;
  /** Replace the moving placements (a crowd's, every frame). */
  setDynamic(list: readonly InstancePlacement[]): void;
  /** Send both to the target. Cheap to call every frame. */
  commit(): void;
  /** Placements sent last commit. */
  count(): number;
}

export function makeInstanceLayer(target: InstanceTarget): InstanceLayer {
  const models = makeModelLibrary(target);
  let fixed: InstancePlacement[] = [];
  let moving: readonly InstancePlacement[] = [];
  let fixedDirty = true;
  return {
    target,
    models,
    setStatic(list) {
      fixed = list.map((p) => ({ model: models.id(p.model), x: p.x, y: p.y, z: p.z, anchor: p.model.anchor, yaw: p.yaw ?? 0, mirror: p.mirror, base: p.base }));
      fixedDirty = true;
    },
    setDynamic(list) {
      moving = list;
    },
    commit() {
      // Scenery is sent once; the moving set every commit.
      if (fixedDirty) {
        target.setInstances(fixed);
        fixedDirty = false;
      }
      target.setInstances(moving, { dynamic: true });
    },
    count: () => fixed.length + moving.length,
  };
}
