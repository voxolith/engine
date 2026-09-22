// @voxolith/engine — entities and generators for the Voxolith voxel engine.
//
// An entity is a voxel model with an anchor and named colour roles, produced
// from a `.vox` file or by a generator package. This barrel is runtime-safe
// (no filesystem, no GPU). Two subpaths carry the heavier pieces:
//
//   @voxolith/engine/build    authoring toolkit: volumes, shapes, noise
//   @voxolith/engine/preview  CPU renderer for headless previews
//   @voxolith/engine/vox      MagicaVoxel import and export

export type { Entity, EntityModel, MaterialHint, RGB, Role, Size, Vec3 } from "./entity";
export { entityPalette, modelAt, modelIndex, roleHistogram, roleValue, voxelCount } from "./entity";

export type { Orientation } from "./orient";
export { ORIENTATIONS, orientAnchor, orientModel, orientVoxel, orientedSize, swapsXZ } from "./orient";
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