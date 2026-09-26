// Many animated entities: posing, caching and stamping on a budget.
//
// A crowd member is a rigged entity plus where it is, which way it faces and
// its animator. Each update the crowd picks every member's pose frame (at the
// clips' 12 fps near the camera, fewer frames further out, frozen beyond a
// radius), buckets its heading, fetches the baked pose from a shared cache or
// bakes it within a millisecond budget (a member whose bake does not fit this
// frame keeps last frame's pose), and hands the result to the stamper, which
// only touches bricks whose members actually changed.

import type { Entity, EntityModel, Rig, Vec3 } from "../entity";
import { toSprite, type BrickStamper, type Sprite, type StampStats } from "../dynamic";
import type { InstanceLayer, InstancePlacement } from "../instances";
import { bakePose } from "./bake";
import type { PoseCache } from "./cache";
import { makePoseCache } from "./cache";
import { poseMatrices, sampleClip } from "./pose";
import type { Animator } from "./animator";

/**
 * One animated entity in a {@link Crowd}. The crowd reads these fields on every update and never
 * writes them: the game owns the member, moves it and advances its animator.
 */
export interface CrowdMember {
  /** Stable, unique among the stamper's movers. */
  id: number;
  entity: Entity;
  /** The rest model to bake from; defaults to `entity.model`. Replace it to show damage. */
  rest?: EntityModel;
  /** Bump when `rest` changes, so cached poses of the old body are not reused. */
  damage?: number;
  /** Cache key shared by members that look identical (same variant, undamaged). */
  variant: string;
  /** The member's clip player; call its `update(dt)` yourself before `crowd.update`. */
  anim: Animator;
  /**
   * Palette base for this member's roles: a world slot from `PaletteAllocator` when
   * stamping, an instance palette (`layer.palettes.of`) when drawing instances.
   */
  base: number;
  /** Where the entity's anchor goes, in world voxels. Fractional values are fine. */
  x: number;
  y: number;
  z: number;
  /** Radians about +y, 0 facing +z. Stamped members snap to `headings` buckets. */
  yaw: number;
}

/** Options for {@link makeCrowd}. Distances are in world voxels from the camera. */
export interface CrowdOptions {
  /** Stamp members into the world's bricks. One of `stamper` or `instances`. */
  stamper?: BrickStamper;
  /**
   * Draw members as instances instead: each pose is uploaded once as a model
   * (no heading buckets: the instance turns it) and members move and turn
   * smoothly, with nothing written into the world. Needs a renderer with
   * instancing; the layer's `commit` is called at the end of each update.
   */
  instances?: InstanceLayer;
  /** Share a pose cache between crowds. Default a new one with a 96 MiB budget. */
  cache?: PoseCache<BakedPose>;
  /** Clip sampling rate near the camera. Default 12. */
  fps?: number;
  /** Heading buckets. Default 16. */
  headings?: number;
  /** Full rate within this distance, `farFps` beyond it. Default 120. */
  near?: number;
  /** Clip sampling rate beyond `near`. Default 6. */
  farFps?: number;
  /** Beyond this distance poses freeze (members still move). Default 400. */
  freeze?: number;
  /** Milliseconds per update allowed for new bakes. Default 4. */
  budgetMs?: number;
  /**
   * Keep each baked pose's full posed model, not just its sprite (for hit
   * tests against exact voxels and bones). Off by default: a sprite is a
   * small fraction of the dense posed grid, so many more poses fit the cache.
   */
  keepModels?: boolean;
  /**
   * Beyond `near`, re-stamp a member only when its pose frame changes, moving
   * it in steps like sprite animation, instead of whenever its rounded
   * position changes. Near members still move every frame. Default true.
   */
  stepFar?: boolean;
}

/** A cached pose of one variant: what was baked for a (variant, damage, clip, frame, heading) key. */
export interface BakedPose {
  /** Only with `keepModels`. */
  model?: EntityModel;
  /** Stamping only. */
  sprite?: Sprite;
  /** Instances only: the pose's model id and anchor. */
  instance?: { id: number; anchor: Vec3 };
  /** Bone matrices of the pose (see `poseMatrices`), for hit tests against bones. */
  matrices: Float32Array;
  /** The yaw the pose was baked at, radians: the heading bucket, or 0 for instances. */
  yaw: number;
}

/** What one {@link Crowd.update} did. The stamping counters are 0 when drawing instances. */
export interface CrowdStats extends StampStats {
  /** Members passed in. */
  members: number;
  /** Poses baked this update (cache misses). */
  bakes: number;
  /** Members whose new pose did not fit the budget and kept the old one. */
  deferred: number;
  /** Poses served from the cache. */
  hits: number;
}

/** A crowd of animated entities, from {@link makeCrowd}. */
export interface Crowd {
  /**
   * Pose, bake (within `budgetMs`) and place every member, then commit the stamper or instance
   * layer. Call once per frame after moving the members and advancing their animators. Members
   * left out of the list are not removed; call `remove` for those.
   *
   * @param camera - Camera position in world voxels, for the distance LOD.
   */
  update(members: readonly CrowdMember[], camera: [number, number, number]): CrowdStats;
  /** The pose each member was last stamped with (for hit tests). */
  last(id: number): BakedPose | undefined;
  /** Forget a member and, when stamping, erase it from the world on the next commit. */
  remove(id: number): void;
  /** The pose cache; `drop(variant + ".")` frees one variant's poses. */
  readonly cache: PoseCache<BakedPose>;
}

/**
 * Animate many rigged entities on a budget. Each update picks every member's pose frame (at
 * `fps` near the camera, `farFps` beyond `near`, frozen beyond `freeze`), takes the baked pose
 * from a cache shared by members of the same variant, bakes missing ones within `budgetMs`
 * (a member that does not fit keeps last frame's pose), and either stamps it into the world
 * through a {@link BrickStamper} or draws it through an {@link InstanceLayer}.
 *
 * Stamping buckets headings (`headings`, default 16) and costs brick uploads for every member
 * that moves; instances turn and move smoothly and write nothing into the world.
 *
 * @param opts - Exactly one of `stamper` or `instances` is required.
 * @returns The crowd.
 * @example
 * ```ts
 * const crowd = makeCrowd({ stamper: makeBrickStamper(renderer, { size: SIZE }), near: 140, farFps: 6, freeze: 700 });
 * const members: CrowdMember[] = rats.map((entity, i) => ({
 *   id: i + 1, entity, variant: "rat", anim: makeAnimator(entity, "walk"), base: ratBase,
 *   x: 100 + i * 20, y: 1, z: 100, yaw: 0,
 * }));
 * // per frame:
 * for (const m of members) m.anim.update(dt);
 * const stats = crowd.update(members, frame.camPos as [number, number, number]);
 * ```
 */
export function makeCrowd(opts: CrowdOptions): Crowd {
  const fps = opts.fps ?? 12, headings = opts.headings ?? 16;
  const near = opts.near ?? 120, farFps = opts.farFps ?? 6, freeze = opts.freeze ?? 400;
  const budget = opts.budgetMs ?? 4;
  const keepModels = opts.keepModels === true;
  const layer = opts.instances;
  if (!layer && !opts.stamper) throw new Error("makeCrowd needs a stamper or an instance layer");
  // Evicted poses free their GPU model once no member shows them any more.
  const retired: number[] = [];
  const cache = opts.cache ?? makePoseCache<BakedPose>(
    (v) => (v.model ? v.model.data.length * 2 : 0) + (v.sprite ? v.sprite.cells.length * 5 : 0) + (v.instance ? 4096 : 0) + 64,
    { maxBytes: 96 * 1024 * 1024, onEvict: (_k, v) => { if (v.instance) retired.push(v.instance.id); } },
  );

  const lastPose = new Map<number, BakedPose>();
  const lastKey = new Map<number, string>();
  const stepFar = opts.stepFar !== false;
  const frozen = new Map<number, number>();

  return {
    cache,
    last: (id) => lastPose.get(id),
    remove(id) {
      opts.stamper?.remove(id);
      lastPose.delete(id);
      lastKey.delete(id);
      frozen.delete(id);
    },
    update(members, cam) {
      const t0 = performance.now();
      let bakes = 0, deferred = 0, hits = 0;
      const placed: InstancePlacement[] = [];
      for (const m of members) {
        const d = Math.hypot(m.x - cam[0], m.y - cam[1], m.z - cam[2]);
        const rig = m.entity.rig as Rig;
        const clip = m.anim.clip();
        // Frame index at the clips' rate, coarser with distance, frozen far away.
        let frame: number;
        if (d > freeze) frame = frozen.get(m.id) ?? Math.floor(m.anim.time() * fps);
        else {
          const rate = d > near ? farFps : fps;
          frame = Math.floor(m.anim.time() * rate) * Math.round(fps / rate);
          frozen.set(m.id, frame);
        }
        // Instances turn for free, so their poses are not bucketed by heading.
        const hb = layer ? 0 : ((Math.round((m.yaw / (Math.PI * 2)) * headings) % headings) + headings) % headings;
        const key = `${m.variant}.${m.damage ?? 0}|${clip}|${frame}|${hb}`;
        // Far away and still on the same pose frame: leave it where it is.
        if (!layer && stepFar && d > near && lastKey.get(m.id) === key) continue;
        lastKey.set(m.id, key);
        let pose: BakedPose | undefined;
        const before = cache.stats().misses;
        const overBudget = performance.now() - t0 > budget;
        if (overBudget) {
          // Out of time for bakes: take it only if it is already cached,
          // otherwise keep last frame's pose for this member.
          pose = cache.peek(key);
          if (pose) hits++;
          else {
            pose = lastPose.get(m.id);
            deferred++;
          }
        } else {
          pose = cache.get(key, () => {
            const c = m.entity.clips!.find((k) => k.id === clip)!;
            const matrices = poseMatrices(rig, sampleClip(c, frame / fps, rig.bones.length));
            const yaw = (hb / headings) * Math.PI * 2;
            const model = bakePose(m.rest ?? m.entity.model, rig, matrices, { yaw });
            if (layer) return { model: keepModels ? model : undefined, instance: { id: layer.target.addModel({ size: model.size, data: model.data }), anchor: model.anchor }, matrices, yaw };
            return { model: keepModels ? model : undefined, sprite: toSprite(model), matrices, yaw };
          });
          if (cache.stats().misses > before) bakes++;
          else hits++;
        }
        if (!pose) continue;
        lastPose.set(m.id, pose);
        if (pose.instance) placed.push({ model: pose.instance.id, x: m.x, y: m.y, z: m.z, anchor: pose.instance.anchor, yaw: m.yaw, base: m.base });
        else if (pose.sprite) opts.stamper!.put(m.id, pose.sprite, { x: m.x, y: m.y, z: m.z }, m.base);
      }
      if (layer) {
        layer.setDynamic(placed);
        layer.commit();
        // Free evicted poses nobody is showing now.
        if (retired.length) {
          const shown = new Set(placed.map((p) => p.model));
          for (let i = retired.length - 1; i >= 0; i--) {
            if (shown.has(retired[i])) continue;
            layer.target.removeModel(retired[i]);
            retired.splice(i, 1);
          }
        }
        return { bricks: 0, voxels: 0, movers: placed.length, members: members.length, bakes, deferred, hits };
      }
      const st = opts.stamper!.commit();
      return { ...st, members: members.length, bakes, deferred, hits };
    },
  };
}
