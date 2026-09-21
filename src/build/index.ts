// @voxolith/engine/build — the authoring toolkit generator packages share:
// a dense working volume, voxel primitives, vector helpers and seeded noise.
// Headless and dependency-free, so it can run in a bun script or a worker.

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
