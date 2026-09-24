// @voxolith/engine — entities and generators for the Voxolith voxel engine.
//
// An entity is a voxel model with an anchor and named colour roles, produced
// from a `.vox` file or by a generator package. This barrel is runtime-safe
// (no filesystem, no GPU).
//
//   @voxolith/engine/vox      MagicaVoxel import and export
//   @voxolith/engine/worker   off-thread generation pool
//
// The engine consumes baked models; it does not author them. The authoring
// toolkit (volumes, rasterisers, noise, branch growth, canopy carving) and the
// headless preview renderer live in @voxolith/gen-kit, beside the generators.

export type { Bone, Clip, ClipEvent, ClipTrack, Entity, EntityModel, MaterialHint, RGB, Rig, Role, Size, Vec3 } from "./entity";
export { entityPalette, modelAt, modelIndex, roleHistogram, roleValue, voxelCount } from "./entity";

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
export type { BrickStamper, MultiBrickTarget, Sprite, StampStats } from "./dynamic";
export { blitModelToBricks } from "./sink";
export type { Variant, VariantPool, VariantPoolOptions } from "./variants";
export { makeVariantPool } from "./variants";

export type { EntityGenerator, ParamSpec } from "./generator";
export {
  clearGenerators,
  getGenerator,
  getParam,
  listGenerators,
  registerGenerator,
  withParam,
} from "./generator";

export type { Allocation } from "./palette";
export { blitModel, PaletteAllocator } from "./palette";