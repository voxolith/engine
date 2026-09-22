// @voxolith/engine/build — the authoring toolkit generator packages share.
//
// A dense working volume, voxel primitives, vector helpers, seeded noise, and
// the higher-level pieces that more than one generator needs: branching
// structures, scattered clumps, and the carving and shading that turn a solid
// mass into something with gaps and depth. Headless and dependency-free, so it
// runs in a bun script or a worker.

export { Volume } from "./volume";
export type { Box } from "./volume";

export {
  add,
  boxFill,
  capsule,
  cross,
  dot,
  ellipsoid,
  frame,
  length,
  line3,
  normalize,
  perpendicular,
  rotateAround,
  scale,
  sphere,
  sub,
  v3,
} from "./shapes";
export type { FillOptions } from "./shapes";

export { clamp, makeNoise, mix, smoothstep } from "./noise";
export type { Noise } from "./noise";

export { fitHeight, growBranches, segmentFrames } from "./branch";
export type { BranchLevel, BranchParams, Segment, Skeleton, Stem, StemSeed, Tip } from "./branch";

export { buildHull, carveCanopy, hash01, hullRadius, shadeByExposure, skyOcclusion } from "./canopy";
export type { CarveOptions, CarveStats, Hull, Mask, ShadeOptions } from "./canopy";

export { placeClusters, spotsAlong } from "./cluster";
export type { ClusterOptions, ClusterResult, ClusterSpot } from "./cluster";

export { blob, facet } from "./blob";
export type { BlobOptions, FacetOptions, FacetPlane } from "./blob";
