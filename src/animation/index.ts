// @voxolith/engine/animation — rigs, clips, poses and damage for animated entities.
//
// Headless and pure. A generator authors a rigged entity (a rest model whose
// voxels know their bone, a rig, clips); this module plays the clips, turns a
// pose into bone matrices, bakes the posed voxel model, and damages the rest
// model (wounds that expose the interior, severed limbs as separate pieces).
// Getting the posed model into the world is the host's job (see
// makeBrickStamper in the engine barrel).

export { bakePose } from "./bake";
export type { BakeOptions } from "./bake";
export { blendPoses, clipTime, poseMatrices, restPose, sampleClip } from "./pose";
export type { Pose } from "./pose";
export { makeAnimator } from "./animator";
export type { Animator } from "./animator";
export { sever, subtree, wound } from "./damage";
export type { Severed, WoundOptions } from "./damage";
export { IDENTITY_Q, invertRigid, mulAffine, quatAxisAngle, quatMul, quatToMat, transformPoint } from "./math";
export type { Quat } from "./math";
