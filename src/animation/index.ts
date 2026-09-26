/**
 * `@voxolith/engine/animation`: rigs, clips, poses and damage for animated entities.
 *
 * Headless and pure. A generator authors a rigged entity (a rest model whose voxels know their
 * bone, a rig, clips at 12 frames per second); this module plays the clips
 * ({@link makeAnimator}), turns a pose into bone matrices ({@link poseMatrices}), bakes the
 * posed voxel model ({@link bakePose}), and damages the rest model ({@link wound} exposes the
 * interior, {@link sever} cuts a limb off as a separate piece).
 *
 * Getting the posed model into the world is the host's job: stamp it with `makeBrickStamper`
 * from the engine barrel, or draw it as an instance. {@link makeCrowd} does either for many
 * animated entities at once, with a pose cache, a bake budget and distance LOD.
 *
 * @packageDocumentation
 */

export { bakePose } from "./bake";
export type { BakeOptions } from "./bake";
export { blendPoses, clipTime, poseMatrices, restPose, sampleClip } from "./pose";
export type { Pose } from "./pose";
export { makeAnimator } from "./animator";
export type { Animator } from "./animator";
export { sever, subtree, wound } from "./damage";
export { makePoseCache } from "./cache";
export { makeCrowd } from "./crowd";
export type { BakedPose, Crowd, CrowdMember, CrowdOptions, CrowdStats } from "./crowd";
export type { PoseCache } from "./cache";
export type { Severed, WoundOptions } from "./damage";
export { IDENTITY_Q, invertRigid, mulAffine, quatAxisAngle, quatMul, quatToMat, transformPoint } from "./math";
export type { Quat } from "./math";
