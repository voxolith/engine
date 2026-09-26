/**
 * `@voxolith/engine`: entities and generators for the Voxolith voxel engine, and the
 * placement, streaming and instancing that put them into a renderer's world.
 *
 * An entity ({@link Entity}) is a voxel model with an anchor and named colour roles, produced
 * from a `.vox` file or by a generator package ({@link EntityGenerator},
 * {@link registerGenerator}). Voxel values are role indices, never colours: a
 * {@link PaletteAllocator} gives each entity a slot range in the world's 256-slot palette, and
 * {@link blitModel} or {@link blitModelToBricks} stamps it. {@link makeChunkedWorld} and
 * {@link scatterRegion} build large worlds a chunk at a time, {@link makeInstanceLayer} draws
 * models by reference at any yaw, and {@link makeBrickStamper} moves things through the bricks.
 * Share codes ({@link encodeState}, {@link decodeState}) rebuild a generated model from a short
 * string.
 *
 * The engine talks to the renderer through structural types (`BrickTarget`, `InstanceTarget`)
 * that `Renderer` satisfies, and this barrel is runtime-safe (no filesystem, no GPU), so it
 * runs headless in bun and in workers. Subpaths:
 *
 * - `@voxolith/engine/vox`: MagicaVoxel import and export
 * - `@voxolith/engine/worker`: off-thread generation pool
 * - `@voxolith/engine/input`: pointer, keyboard, gamepad and touch input (DOM)
 * - `@voxolith/engine/atmosphere`: time of day and weather
 * - `@voxolith/engine/animation`: rigs, clips, poses, crowds and damage
 *
 * The engine consumes baked models; it does not author them. The authoring
 * toolkit (volumes, rasterisers, noise, branch growth, canopy carving) and the
 * headless preview renderer live in `@voxolith/gen-kit`, beside the generators.
 *
 * @packageDocumentation
 */

export type { Bone, Clip, ClipEvent, ClipTrack, Entity, EntityModel, MaterialHint, RGB, Rig, Role, Size, SparseVoxels, Vec3 } from "./entity";
export { entityPalette, isSparse, modelAt, modelIndex, roleHistogram, roleValue, voxelCount } from "./entity";

export { entityMaterials } from "./palette";
export type { Orientation } from "./orient";
export { ORIENTATIONS, orientAnchor, orientModel, orientVoxel, orientedSize, swapsXZ } from "./orient";
export type { GeneratorState } from "./share";
export { clampToSpec, decodeState, encodeState, fingerprint, generateFromState, readParams } from "./share";
export type { Box, ChunkContext, ChunkedWorld, ChunkedWorldOptions } from "./chunks";
export { makeChunkedWorld } from "./chunks";
export type { ScatterOptions, ScatterPoint } from "./scatter";
export { scatterRegion } from "./scatter";
export type { BrickTarget } from "./sink";
export { makeBrickStamper, toSprite } from "./dynamic";
export { makeInstanceLayer, makeModelLibrary, makePaletteLibrary, orientationYaw } from "./instances";
export type { EntityPlacement, InstanceLayer, InstancePlacement, InstanceTarget, ModelLibrary, PaletteLibrary } from "./instances";
export type { BrickStamper, MultiBrickTarget, Sprite, StampStats } from "./dynamic";
export { blitModelToBricks } from "./sink";
export type { Variant, VariantPool, VariantPoolOptions } from "./variants";
export { makeVariantPool } from "./variants";

export type { EntityGenerator, GenerateContext, ParamSpec } from "./generator";
export {
  DEFAULT_VOXELS_PER_METRE,
  refinement,
  clearGenerators,
  getGenerator,
  getParam,
  listGenerators,
  registerGenerator,
  withParam,
} from "./generator";

export type { Allocation } from "./palette";
export { blitModel, instancePalette, PaletteAllocator } from "./palette";