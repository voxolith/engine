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

import type { EntityModel, RGB, Role, Vec3 } from "./entity";
import { instancePalette } from "./palette";
import type { SparseVoxels } from "@voxolith/renderer/core";

/** What a renderer offers for instancing; `Renderer` implements it. */
export interface InstanceTarget {
  addModel(src: {
    size: { x: number; y: number; z: number };
    data?: Uint8Array;
    sparse?: SparseVoxels;
    /** Part index per voxel (a rig's bones), for models drawn with per-part transforms. */
    parts?: Uint8Array;
    /** Per part, its parent (-1 for none) and the joint where it meets it. */
    joints?: readonly { parent: number; at: readonly [number, number, number] }[];
    /** Per-part boxes to pack poses with (shared by copies of a model, so they share poses). */
    partBoxes?: Int32Array;
  }): number;
  removeModel(id: number): void;
  /** A palette of its own for instances; returns its base slot. */
  addPalette(colors: Float32Array, materials?: Float32Array): number;
  setPaletteColors(base: number, colors: Float32Array, materials?: Float32Array): void;
  removePalette(base: number, entries: number): void;
  /** Replace the static set, or with `dynamic` only the moving one (cheap per frame). */
  setInstances(list: readonly InstancePlacement[], opts?: { dynamic?: boolean }): void;
}

/** One instance of an uploaded model, as the renderer's `setInstances` takes it. */
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
  /** A full rotation instead of `yaw`: 3x3 row-major, world = R · model, about the anchor voxel's centre. */
  rotation?: ArrayLike<number>;
  /** Mirror along the model's x before turning (see `orientationYaw`). */
  mirror?: boolean;
  /**
   * Palette slot of role 1: an instance palette's base (`PaletteLibrary.of`), or a world slot
   * for instances coloured like stamped voxels.
   */
  base: number;
  /**
   * Per-part transforms (12 floats each, e.g. `poseMatrices` output) for a model uploaded with
   * parts: the renderer poses it on the GPU from the shared rest model. See `makeCrowd`'s
   * `rigged` option.
   */
  parts?: ArrayLike<number>;
}

/**
 * The instance turn that draws what stamping with an axis-aligned
 * orientation would: `{ yaw, mirror }` for Orientation `o`.
 */
export function orientationYaw(o: number): { yaw: number; mirror: boolean } {
  return { yaw: -(o & 3) * (Math.PI / 2), mirror: (o & 4) !== 0 };
}

/** Uploaded models by identity, from {@link makeModelLibrary}. */
export interface ModelLibrary {
  /** The model's id on the target, uploading it the first time it is seen. */
  id(model: EntityModel): number;
  /** Forget a model and free it on the target. */
  release(model: EntityModel): void;
  /** Models uploaded. */
  readonly size: number;
}

/**
 * Upload each model to an instancing target once, keyed by object identity: pass the same
 * `EntityModel` object and get the same id back. Dense and sparse models both work. Models stay
 * on the GPU until released. {@link makeInstanceLayer} makes one for you.
 */
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
  /** Uploaded on first use; its own `anchor` is used. */
  model: EntityModel;
  /** Where the anchor goes, in world voxels; fractions are fine. */
  x: number;
  y: number;
  z: number;
  /** Radians about +y, any angle. */
  yaw?: number;
  /** A full rotation instead of `yaw` (3x3 row-major, world = R · model). */
  rotation?: ArrayLike<number>;
  /** Mirror along the model's x before turning. */
  mirror?: boolean;
  /** Palette slot of role 1. */
  base: number;
}

/**
 * Palettes for instances, by key: a species shares one, a placement that
 * should look different gets its own. No slot budget: they live after the
 * world's 256 on the renderer.
 */
export interface PaletteLibrary {
  /** The base slot of the palette for `key`, made from `roles` (and `tint`) the first time. */
  of(key: string, roles: readonly Role[], tint?: (color: RGB, role: Role, index: number) => RGB): number;
  /** Recolour the palette for `key` in place: every instance using it changes. */
  restyle(key: string, roles: readonly Role[], tint?: (color: RGB, role: Role, index: number) => RGB): void;
  /** Free the palette for `key`; move placements that use its base off it first. */
  release(key: string): void;
  /** Palettes held. */
  readonly size: number;
  /** Slots those palettes use in total. */
  readonly slots: number;
}

/**
 * Instance palettes by key on an instancing target. They live after the world's 256 slots, so
 * they need no {@link PaletteAllocator} budget. {@link makeInstanceLayer} makes one for you as
 * `layer.palettes`.
 */
export function makePaletteLibrary(target: InstanceTarget): PaletteLibrary {
  const byKey = new Map<string, { base: number; n: number }>();
  let slots = 0;
  return {
    of(key, roles, tint) {
      let p = byKey.get(key);
      if (!p) {
        const { colors, materials } = instancePalette(roles, tint);
        p = { base: target.addPalette(colors, materials), n: roles.length };
        byKey.set(key, p);
        slots += p.n;
      }
      return p.base;
    },
    restyle(key, roles, tint) {
      const p = byKey.get(key);
      if (!p) return;
      const { colors, materials } = instancePalette(roles, tint);
      target.setPaletteColors(p.base, colors, materials);
    },
    release(key) {
      const p = byKey.get(key);
      if (!p) return;
      target.removePalette(p.base, p.n);
      byKey.delete(key);
      slots -= p.n;
    },
    get size() { return byKey.size; },
    get slots() { return slots; },
  };
}

/**
 * Instanced drawing for a scene: static scenery and a moving set, sent to the renderer together.
 * From {@link makeInstanceLayer}.
 */
export interface InstanceLayer {
  /** The renderer it draws through. */
  readonly target: InstanceTarget;
  /** Models uploaded by `setStatic`; use it to get ids for `setDynamic` placements. */
  readonly models: ModelLibrary;
  /** Instance palettes; `palettes.of(key, roles)` gives the `base` for a placement. */
  readonly palettes: PaletteLibrary;
  /** Replace the static placements (scenery); the model's own anchor is used. */
  setStatic(list: readonly EntityPlacement[]): void;
  /** Replace the moving placements (a crowd's, every frame). */
  setDynamic(list: readonly InstancePlacement[]): void;
  /**
   * Send both to the target: the static set only when it changed, the moving set every time.
   * Nothing is drawn until the first commit. Cheap to call every frame; a `Crowd` drawing
   * into this layer commits for you.
   */
  commit(): void;
  /** Placements sent last commit. */
  count(): number;
}

/**
 * Draw entities by reference instead of stamping them into the world: one GPU copy of each
 * model, drawn wherever it is placed, at any yaw, mirrored, at fractional positions. Instances
 * use palettes of their own, so a scene of instances has no colour budget, and nothing is
 * written into the world's bricks.
 *
 * @param target - A renderer with instancing (`Renderer` implements {@link InstanceTarget}).
 * @returns The layer; pass it to `makeCrowd` as `instances` for animated members.
 * @example
 * ```ts
 * const layer = makeInstanceLayer(renderer);
 * const oakBase = layer.palettes.of("oak", oak.model.roles);
 * layer.setStatic(sites.map((s) => ({ model: oak.model, x: s.x, y: s.y, z: s.z, yaw: s.yaw, base: oakBase })));
 * layer.commit();
 * ```
 */
export function makeInstanceLayer(target: InstanceTarget): InstanceLayer {
  const models = makeModelLibrary(target);
  const palettes = makePaletteLibrary(target);
  let fixed: InstancePlacement[] = [];
  let moving: readonly InstancePlacement[] = [];
  let fixedDirty = true;
  return {
    target,
    models,
    palettes,
    setStatic(list) {
      fixed = list.map((p) => ({ model: models.id(p.model), x: p.x, y: p.y, z: p.z, anchor: p.model.anchor, yaw: p.yaw ?? 0, rotation: p.rotation, mirror: p.mirror, base: p.base }));
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
