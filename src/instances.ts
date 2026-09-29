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
// per scale it is drawn at (by identity) and `makeInstanceLayer` keeps the static
// placements (scenery) apart from the moving ones (a crowd), sending both in one
// list. A placement's `scale` draws a coarser model enlarged (the renderer's
// `ModelOptions.scale`), which is how a scene shows placeholders before its fine
// models exist; replacing the static set releases the models it no longer needs,
// after the new set draws.

import type { EntityModel, RGB, Role, Vec3 } from "./entity";
import { instancePalette } from "./palette";
import type { EncodedModel, PlacementBake, PlacementInput, PlacementModel, SparseVoxels } from "@voxolith/renderer/core";
import { LOAD_PHASES, type LoadTask, type LoadTracker } from "./load";
import type { PlacementWorker, SceneWorker } from "./worker/scene";

/**
 * How a model is added to an {@link InstanceTarget} (the renderer's `ModelOptions`): `scale`
 * draws it enlarged by an integer factor, and its anchors are then in enlarged-model voxels.
 */
export interface TargetModelOptions {
  /** The integer factor the model is drawn enlarged by (default 1). */
  scale?: number;
}

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
  }, opts?: TargetModelOptions): number;
  removeModel(id: number): void;
  /** A palette of its own for instances; returns its base slot. */
  addPalette(colors: Float32Array, materials?: Float32Array): number;
  setPaletteColors(base: number, colors: Float32Array, materials?: Float32Array): void;
  removePalette(base: number, entries: number): void;
  /** Replace the static set, or with `dynamic` only the moving one (cheap per frame). */
  setInstances(list: readonly InstancePlacement[], opts?: { dynamic?: boolean }): void;
  /**
   * Optional, for baking the static set on a worker: what the bake reads about model `id`
   * (`Renderer.placementModel`). A target without all three placement methods always places
   * synchronously.
   */
  placementModel?(id: number): PlacementModel | null;
  /** Optional: the bake's input for a static set (`Renderer.placementInput`). */
  placementInput?(list: readonly InstancePlacement[]): PlacementInput;
  /**
   * Optional: replace the static set with a baked one (`Renderer.applyPlacement`). Throws when a
   * model the bake names was removed or replaced since its input was taken.
   */
  applyPlacement?(bake: PlacementBake): void;
  /**
   * Optional, for encoding models on a worker: add a model encoded by `encodeModel`
   * (`Renderer.addEncodedModel`), with the id `addModel` would have given it. A target without it
   * uploads every model with `addModel`, on the main thread.
   */
  addEncodedModel?(encoded: EncodedModel, opts?: TargetModelOptions): number;
  /**
   * Optional, with `addEncodedModel`: start adding an encoded model in slices
   * (`Renderer.beginEncodedModel`), so one big model spreads its main-thread work over several
   * frames. `addEncodedModel` is this plus `step(Infinity)`. With it, a layer's `commitAsync` steps
   * one pending model at a time within {@link InstanceLayerOptions.uploadBudgetMs} per frame;
   * without it, each model is added whole.
   */
  beginEncodedModel?(encoded: EncodedModel, opts?: TargetModelOptions): TargetPendingModel;
  /**
   * Optional: make room for a batch of encoded models before adding them
   * (`Renderer.reserveBricks`), so the pools grow once for the batch rather than model by model.
   */
  reserveBricks?(encoded: readonly EncodedModel[]): void;
}

/**
 * A model being added in slices, from {@link InstanceTarget.beginEncodedModel} (the renderer's
 * `PendingModel`). No instance may name `id` until `step` has returned true.
 */
export interface TargetPendingModel {
  /** Do up to about `budgetMs` of the add; true once the model is added (then `done`). */
  step(budgetMs: number): boolean;
  /** The id the model will have, the one `addEncodedModel` would have given it. */
  readonly id: number;
  /** Whether the add has finished. */
  readonly done: boolean;
  /**
   * How far the add is, 0 to 1 (the renderer: the fraction of payload bytes copied and uploaded);
   * never goes back, 1 once done. Optional: without it a layer shows no progress within a model.
   */
  readonly progress?: number;
  /** Stop the add and free what it claimed so far. */
  cancel(): void;
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

/**
 * Uploaded models by identity and scale, from {@link makeModelLibrary}: the same `EntityModel`
 * at two scales is two renderer models (each costs its bricks once).
 */
export interface ModelLibrary {
  /**
   * The model's id on the target at `scale`, uploading it the first time that pair is seen.
   *
   * @param model - The model.
   * @param scale - The integer factor it is drawn enlarged by (`ModelOptions.scale`, default 1):
   *   a model built at 20 vox/m drawn in a 100 vox/m world takes 5. A scaled model cannot be
   *   posed (`InstancePlacement.parts`).
   * @returns The id an {@link InstancePlacement} names in `model`.
   */
  id(model: EntityModel, scale?: number): number;
  /** Whether the model is uploaded at `scale` (default 1), without uploading it. */
  has(model: EntityModel, scale?: number): boolean;
  /** Forget a model at `scale` and free it on the target; without `scale`, at every scale it has. */
  release(model: EntityModel, scale?: number): void;
  /** The scale model `id` was uploaded at (1 for a plain one), or undefined for an id it does not hold. */
  scaleOf(id: number): number | undefined;
  /** Renderer models uploaded (a model at two scales counts twice). */
  readonly size: number;
}

/** Options for {@link makeModelLibrary}. */
export interface ModelLibraryOptions {
  /**
   * Report uploads into a load tracker under the `upload` phase, one tick per model seen for the
   * first time. Uploads made in one synchronous run (a `setStatic` call, a loop of `id` calls)
   * form one span, which ends at the end of that run.
   */
  load?: LoadTracker;
}

/** A first-sight model being encoded on the scene worker, or encoded and waiting to be added. */
interface Upload {
  model: EntityModel;
  /** The scales to add it at once it lands: one encoding serves every scale. */
  scales: Set<number>;
  ctl: AbortController;
  /** Resolves with the encoding once it lands; rejects when the encode fails or is cancelled. */
  landed: Promise<EncodedModel>;
  encoded?: EncodedModel;
  /** The model's own task on the `upload` phase, counted in bricks. */
  task?: LoadTask;
  units: number;
  ticked: number;
  /** The encoding came from the worker's cache. */
  cached?: boolean;
  /** The scale being added in slices (`beginEncodedModel`), if one is. */
  pending?: { scale: number; add: TargetPendingModel };
  /** Placement keys of the scales added so far, registered on the worker once all are. */
  keys: { key: number; poseKey?: number; scale?: number; id: number }[];
}

/** Models by the scales they are wanted at. */
type Wanted = Map<EntityModel, Set<number>>;

/** The library's encoded-upload side, for a layer with a scene worker. */
interface Uploads {
  /** Ask the worker to encode `model` for `scale`, unless it is uploaded at that scale or already asked for. */
  request(model: EntityModel, scale: number): void;
  /** The upload in flight or landed for `model`. */
  get(model: EntityModel): Upload | undefined;
  /** Add a landed encoding to the target at every scale it is wanted at, and register them for placement on the worker. */
  apply(u: Upload): void;
  /**
   * `apply` in slices: add within about `budgetMs` (at least one step), true once every scale
   * is added and registered. A target without `beginEncodedModel` adds every scale whole.
   */
  step(u: Upload, budgetMs: number): boolean;
  /** Cancel every upload's add in progress (its encoding is kept, so it can start again). */
  pauseAdds(): void;
  /** Cancel every upload (or scale of one) that `keep` does not name. */
  keepOnly(keep: Wanted): void;
  /** Uploads in flight or landed. */
  readonly size: number;
}

/** Bricks an encode walks for a model: its stored bricks, or every brick position of a dense one. */
const uploadUnits = (m: EntityModel) => Math.max(1, m.sparse ? m.sparse.bricks.size : Math.ceil(m.size.x / 8) * Math.ceil(m.size.y / 8) * Math.ceil(m.size.z / 8));

/** What a model library needs to encode on a scene worker. */
interface EncodeConfig {
  worker: SceneWorker;
  /** The model's identity for the worker's cache ({@link InstanceLayerOptions.modelKey}). */
  modelKey?: (model: EntityModel) => string | undefined;
  /** {@link InstanceLayerOptions.hashModels}. */
  hashModels?: boolean;
  /** A model was added from its encoding and registered for placement under `key`. */
  registered(id: number, key: number): void;
}

/** The scale a placement asks for, checked: an integer of at least 1. */
function checkScale(scale: number | undefined, where: string): number {
  const k = scale ?? 1;
  if (!Number.isInteger(k) || k < 1) throw new Error(`${where}: scale must be an integer >= 1 (got ${scale})`);
  return k;
}

/** A model's anchor in the instance's voxels: `k × anchor` for a model drawn enlarged by k. */
const anchorAt = (m: EntityModel, k: number): Vec3 => (k === 1 ? m.anchor : [m.anchor[0] * k, m.anchor[1] * k, m.anchor[2] * k]);

/** One renderer model in a library: an EntityModel at one scale. */
interface Held {
  model: EntityModel;
  scale: number;
  id: number;
  /** Asked for through the public `id`: the host uses it, so a layer never releases it by itself. */
  pinned: boolean;
}

/** The library's own side, for its layer. */
interface LibraryInternals {
  lib: ModelLibrary;
  /** Close the current upload span. */
  settle(): void;
  uploads?: Uploads;
  /** `lib.id` without pinning: a layer resolving its own static set. */
  idOf(model: EntityModel, scale: number): number;
  /** Every renderer model held. */
  held(): Iterable<Held>;
}

/** A model library plus the hook that closes its current upload span, and its encoded uploads. */
function modelLibrary(target: InstanceTarget, load: LoadTracker | undefined, beforeRemove?: (id: number) => void, enc?: EncodeConfig): LibraryInternals {
  const ids = new Map<EntityModel, Map<number, Held>>();
  const byId = new Map<number, Held>();
  const ups = new Map<EntityModel, Upload>();
  let task: LoadTask | undefined;
  const settle = () => {
    task?.end();
    task = undefined;
  };
  const heldAt = (model: EntityModel, scale: number) => ids.get(model)?.get(scale);
  const hold = (model: EntityModel, scale: number, id: number): Held => {
    const h: Held = { model, scale, id, pinned: false };
    let m = ids.get(model);
    if (!m) ids.set(model, (m = new Map()));
    m.set(scale, h);
    byId.set(id, h);
    return h;
  };
  const opts = (k: number) => (k === 1 ? undefined : { scale: k });
  /** Stop an upload's add in progress, freeing what it claimed. */
  const stopAdd = (u: Upload) => {
    u.pending?.add.cancel();
    u.pending = undefined;
  };
  /** Stop the add in progress if its scale is no longer wanted. */
  const prune = (u: Upload) => {
    if (u.pending && !u.scales.has(u.pending.scale)) stopAdd(u);
  };
  /** Register the scales added so far on the worker (or let it forget the encoding when none are). */
  const register = (u: Upload) => {
    const e = u.encoded!;
    for (const k of u.keys) enc!.registered(k.id, k.key);
    const keys = u.keys.map(({ key, poseKey, scale }) => ({ key, poseKey, scale }));
    u.keys = [];
    if (keys.length) enc!.worker.registerEncoded(e, keys.length === 1 ? keys[0] : keys);
    else enc!.worker.forget(e);
  };
  /**
   * Stop an upload: its encode is aborted (or its kept data forgotten), an add in progress is
   * cancelled, and its progress taken back. Scales already added stay held (and registered).
   */
  const cancel = (u: Upload) => {
    ups.delete(u.model);
    u.task?.discard();
    u.ctl.abort();
    stopAdd(u);
    if (u.encoded) register(u);
  };
  const idOf = (model: EntityModel, scale: number): number => {
    const h = heldAt(model, scale);
    if (h) return h.id;
    const u = ups.get(model);
    // Landed already: adding it is cheap. In flight: upload here and now, as without a worker.
    if (u?.encoded) {
      u.scales.add(scale);
      uploads!.apply(u);
      return heldAt(model, scale)!.id;
    }
    // In flight for other scales too: those keep waiting for the encode.
    const alone = !!u && [...u.scales].every((k) => k === scale);
    if (u && alone) {
      ups.delete(model);
      u.ctl.abort();
    } else {
      u?.scales.delete(scale);
      if (load && !task) {
        task = load.task(LOAD_PHASES.upload);
        // Direct `id` calls have no natural end; close the span once this run is over.
        queueMicrotask(settle);
      }
      task?.add(1);
    }
    const src = model.sparse ? { size: model.size, sparse: model.sparse } : { size: model.size, data: model.data };
    const id = scale === 1 ? target.addModel(src) : target.addModel(src, { scale });
    hold(model, scale, id);
    if (u && alone) {
      u.task?.tick(u.units - u.ticked);
      u.task?.end();
    } else task?.tick(1);
    return id;
  };
  const releaseOne = (h: Held) => {
    beforeRemove?.(h.id);
    target.removeModel(h.id);
    const m = ids.get(h.model)!;
    m.delete(h.scale);
    if (!m.size) ids.delete(h.model);
    byId.delete(h.id);
  };
  const lib: ModelLibrary = {
    id(model, scale) {
      const k = checkScale(scale, "models.id");
      const id = idOf(model, k);
      heldAt(model, k)!.pinned = true;
      return id;
    },
    has: (model, scale) => !!heldAt(model, scale ?? 1),
    release(model, scale) {
      const u = ups.get(model);
      if (u) {
        if (scale === undefined) u.scales.clear();
        else u.scales.delete(scale);
        if (!u.scales.size) cancel(u);
        else prune(u);
      }
      const m = ids.get(model);
      if (!m) return;
      for (const h of [...m.values()]) if (scale === undefined || h.scale === scale) releaseOne(h);
    },
    scaleOf: (id) => byId.get(id)?.scale,
    get size() {
      return byId.size;
    },
  };
  const uploads: Uploads | undefined = enc && {
    request(model, scale) {
      if (heldAt(model, scale)) return;
      const had = ups.get(model);
      if (had) {
        had.scales.add(scale);
        return;
      }
      const units = uploadUnits(model);
      const u: Upload = { model, scales: new Set([scale]), ctl: new AbortController(), landed: undefined as unknown as Promise<EncodedModel>, units, ticked: 0, task: load?.task(LOAD_PHASES.upload, units), keys: [] };
      // The encode's progress, as bricks: held one short of the model's count until it is added.
      const onProgress = (done: number, total: number) => {
        if (ups.get(model) !== u || !u.task || total <= 0) return;
        const n = Math.min(units - 1, Math.round((Math.min(done, total) / total) * units));
        if (n > u.ticked) {
          u.task.tick(n - u.ticked);
          u.ticked = n;
        }
      };
      const src = model.sparse ? { size: model.size, sparse: model.sparse } : { size: model.size, data: model.data };
      const cacheKey = enc.modelKey?.(model);
      u.landed = enc.worker.encode(src, { signal: u.ctl.signal, onProgress, keepPlacement: true, cacheKey, hashKey: cacheKey === undefined && !!enc.hashModels }).then(
        (e) => {
          if (ups.get(model) === u) {
            u.encoded = e;
            u.cached = enc.worker.fromCache(e);
          } else enc.worker.forget(e);
          return e;
        },
        (err) => {
          if (ups.get(model) === u) {
            ups.delete(model);
            u.task?.discard();
          }
          throw err;
        },
      );
      // Whoever needs it awaits it; nobody may.
      u.landed.catch(() => {});
      ups.set(model, u);
    },
    get: (model) => ups.get(model),
    apply(u) {
      uploads!.step(u, Infinity);
    },
    step(u, budgetMs) {
      const e = u.encoded!;
      const t0 = performance.now();
      const sliced = typeof target.beginEncodedModel === "function";
      // One encoding, added once per scale: the renderer copies its payload into the pools and
      // reads its sub-cells only, so the same arrays serve every scale. Its keys are registered
      // on the worker once every scale is added, only then (and only then may a bake name them).
      const added = (k: number, id: number) => {
        hold(u.model, k, id);
        const pm = target.placementModel?.(id);
        if (pm) u.keys.push({ key: pm.key, poseKey: pm.poseKey, scale: pm.scale, id });
      };
      let stepped = false;
      for (;;) {
        if (!u.pending) {
          const k = [...u.scales].find((s) => !heldAt(u.model, s));
          if (k === undefined) break;
          if (!sliced) {
            added(k, target.addEncodedModel!(e, opts(k)));
            continue;
          }
          u.pending = { scale: k, add: target.beginEncodedModel!(e, opts(k)) };
        }
        const left = budgetMs - (performance.now() - t0);
        // At least one step per call, so a frame always makes progress.
        if (stepped && left <= 0) return false;
        stepped = true;
        const p = u.pending;
        if (!p.add.step(Math.max(0, left))) {
          // Its progress, as bricks: held one short of the model's count until it is added.
          const f = p.add.progress;
          if (f !== undefined && u.task) {
            const n = Math.min(u.units - 1, Math.round(Math.min(1, Math.max(0, f)) * u.units)) - u.ticked;
            if (n > 0) {
              u.task.tick(n, u.cached ? { cached: true } : undefined);
              u.ticked += n;
            }
          }
          return false;
        }
        u.pending = undefined;
        added(p.scale, p.add.id);
      }
      ups.delete(u.model);
      register(u);
      u.task?.tick(u.units - u.ticked, u.cached ? { cached: true } : undefined);
      u.task?.end();
      return true;
    },
    pauseAdds() {
      for (const u of ups.values()) stopAdd(u);
    },
    keepOnly(keep) {
      for (const u of [...ups.values()]) {
        const want = keep.get(u.model);
        for (const k of [...u.scales]) if (!want?.has(k)) u.scales.delete(k);
        if (!u.scales.size) cancel(u);
        else prune(u);
      }
    },
    get size() {
      return ups.size;
    },
  };
  return { lib, settle, uploads, idOf, held: () => byId.values() };
}

/**
 * Upload each model to an instancing target once, keyed by object identity: pass the same
 * `EntityModel` object and get the same id back. Dense and sparse models both work. Models stay
 * on the GPU until released. {@link makeInstanceLayer} makes one for you.
 *
 * @param opts - `load` reports first-sight uploads into a tracker (phase `upload`).
 */
export function makeModelLibrary(target: InstanceTarget, opts: ModelLibraryOptions = {}): ModelLibrary {
  return modelLibrary(target, opts.load).lib;
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
  /**
   * Draw the model enlarged by this integer factor (default 1): each of its voxels covers
   * `scale`³ world voxels (`ModelOptions.scale`). The factor is the world's resolution over the
   * model's: a tree generated at 20 vox/m in a 100 vox/m world takes 5, which is how a scene
   * shows coarse placeholders while the fine models are made. The layer uploads the model once
   * per scale it is drawn at and places its anchor at `scale × model.anchor`, the anchor a
   * generator gives the same design built `scale` times finer, so a coarse placeholder and its
   * fine model share a placement.
   *
   * The scale is explicit, not read from the model: only the app knows the world's resolution.
   * Scaled models are drawn at rest; they cannot be posed.
   */
  scale?: number;
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
  /**
   * Models uploaded by `setStatic`; use it to get ids for `setDynamic` placements. With a scene
   * worker, a model `setStatic` sent to be encoded is in it once its encoding has been added;
   * asking for its id before that uploads it at once, on the main thread.
   *
   * A model whose id you asked for here is yours: the layer never releases it by itself (see
   * {@link InstanceLayer.setStatic}); release it with `models.release` when you are done.
   */
  readonly models: ModelLibrary;
  /** Instance palettes; `palettes.of(key, roles)` gives the `base` for a placement. */
  readonly palettes: PaletteLibrary;
  /**
   * Replace the static placements (scenery); the model's own anchor is used. Without a scene
   * worker, models seen for the first time are uploaded here, on the main thread. With one
   * (`makeInstanceLayer(target, { worker })`), they are only sent to the worker to be encoded, and
   * this returns at once; `commitAsync()` adds them as they land, and `commit()` adds or uploads
   * whatever is still missing, synchronously. Models the previous static set sent to be encoded
   * and this one does not name are cancelled (unless a `commitAsync` still waits for them).
   *
   * Once a new static set is drawing (after `commit()` places it, or when `commitAsync` applies
   * its bake), the models the layer uploaded for earlier sets and no longer needs are released,
   * freeing their bricks: never before, so the old set never draws a freed model. Kept are the
   * models the drawn set names, those of a `setStatic` not committed yet or still in flight, and
   * any whose id the host asked for with `models.id` (see
   * {@link InstanceLayerOptions.keepUnused}).
   *
   * That makes a coarse-to-fine swap one call pair. Place coarse models first (`scale`), commit,
   * show the scene; then give the fine set and `await commitAsync()`: the coarse set keeps
   * drawing while the fine models encode, upload and bake, the fine set replaces it in one
   * apply, and the coarse models are released right after. Call `commitAsync` in the same task
   * as `setStatic`: a `commit()` in between (a crowd's) would place the fine set synchronously.
   * With `deferPipelines`, prepare both pipeline variants up front (`prepare({ instances: true,
   * scaled: true })` and `prepare({ instances: true })`), or the first frame after the swap
   * compiles the unscaled one.
   *
   * @throws When a placement's `scale` is not an integer of at least 1.
   */
  setStatic(list: readonly EntityPlacement[]): void;
  /**
   * Replace the moving placements (a crowd's, every frame).
   *
   * @throws When a posed placement (`parts`) names a model the layer holds at a scale above 1:
   *   scaled models cannot be posed.
   */
  setDynamic(list: readonly InstancePlacement[]): void;
  /**
   * Send both to the target: the static set only when it changed, the moving set every time.
   * Nothing is drawn until the first commit. Cheap to call every frame; a `Crowd` drawing
   * into this layer commits for you. A static set whose models are still being encoded on the
   * scene worker is completed here, on the main thread: landed encodings are added, the rest
   * uploaded with `addModel`.
   */
  commit(): void;
  /**
   * {@link InstanceLayer.commit}, with the static set's work done on the layer's worker
   * (`makeInstanceLayer(target, { worker })`, or bake only with `{ placement }`) instead of on
   * the main thread. The moving set is sent at once, as by `commit`; the old static set keeps
   * drawing until the new one is applied, and `commit()` calls meanwhile (a crowd's, every
   * frame) send only the moving set.
   *
   * With a scene worker it first waits for the encodes `setStatic` asked for, reserves the pool
   * room for all of them at once (`reserveBricks`), and adds them a few at a time, one batch per
   * frame (see {@link InstanceLayerOptions.uploadBudgetMs}); a target with
   * {@link InstanceTarget.beginEncodedModel} adds a big model in slices over several frames. Each
   * is registered for placement on the worker once it is added, so the bake that follows needs
   * nothing sent. Then it bakes.
   *
   * Resolves once the static set of this call, or a newer one, is drawing: at once when it had
   * not changed. Only the newest set is applied: a `setStatic` + commit while one is in flight
   * supersedes it (a synchronous `commit()` too), and its bake is dropped when it lands; models
   * it already added stay added. If a model it names was removed meanwhile, the layer bakes
   * again. Without a worker, or with a target lacking the placement methods, it is `commit()`
   * and resolves at once.
   *
   * `signal` drops the pending apply and rejects with `signal.reason` (unless another
   * `commitAsync` is still waiting for the same set). Encodes carry on (the set still names
   * their models); the worker skips the bake if it has not started it, and a started one runs to
   * the end, since the bake is one synchronous call. A model being added in slices is cancelled
   * (what it claimed is freed; its encoding is kept). A superseding set cancels such an add only
   * if it no longer names the model; a synchronous `commit()` finishes it before placing. The
   * static set then counts as unsent: the
   * next `commit()` places it synchronously, the next `commitAsync()` bakes it again. Rejects too
   * when an encode or the bake fails on the worker, with the same effect.
   */
  commitAsync(opts?: { signal?: AbortSignal }): Promise<void>;
  /** A static set is in flight on the worker: its models being encoded or added, or its bake. */
  readonly baking: boolean;
  /** Models sent to the scene worker to be encoded and not yet added (in flight or landed). */
  readonly uploads: number;
  /** Placements in the static set (as last set) plus the moving set. */
  count(): number;
}

/** Options for {@link makeInstanceLayer}. */
export interface InstanceLayerOptions {
  /**
   * Report into a load tracker: first-sight model uploads under `upload`, and each static
   * `setInstances` in `commit` under `placement`, with the number of static placements as its
   * total (ticked all at once, since the renderer builds them in one call). An empty static set
   * is not reported. On the main thread both block it; see {@link makeLoadTracker} for what that
   * means for a loading screen.
   *
   * Uploads on the main thread tick one per model. Uploads encoded on a scene worker count in
   * bricks instead (a model's stored bricks, or every brick position of a dense one), one task per
   * model from the request to its add, so a big model weighs what it costs: `done` follows the
   * encode's progress but stays one short of the model's count until it is added. A cancelled or
   * failed encode leaves the phase, its progress included.
   *
   * A static set baked on the worker (`commitAsync`) is one `placement` task from the bake
   * request to its apply, with the main thread free meanwhile. Its total is still the number of
   * static placements, and its `done` follows the worker's progress (the bake's fraction of that
   * count) but stays below the total until the apply, which ticks the rest. A superseded, aborted
   * or failed bake leaves the phase entirely, its progress included.
   *
   * What a scene worker's cache served (`serveScene({ cache })`) ticks with `cached: true`: a
   * cached encoding its model's bricks at its add, a cached bake the set's placements at its
   * apply, so a loading screen can say "n cached".
   */
  load?: LoadTracker;
  /**
   * With a scene worker that has a cache (`serveScene({ cache })`): the identity of a model's
   * voxels, under which the worker keeps its encoding, so a warm visit reads it instead of
   * encoding (and never sends the model's bricks). `GeneratorPool.modelKey` is one:
   * `makeInstanceLayer(renderer, { worker, modelKey: pool.modelKey })`. Return undefined for a
   * model with no stable identity (one the app built or edited itself); it is encoded as before,
   * or looked up by a hash of its bytes with `hashModels`. A key two different models share would
   * give the second the first's encoding, so a key must change whenever the voxels do.
   *
   * Placement bakes need no key: the worker looks them up by a digest of the static set and of the
   * models' placement data.
   */
  modelKey?: (model: EntityModel) => string | undefined;
  /**
   * With a scene worker that has a cache: look up models that have no `modelKey` by a hash of
   * their bytes, computed on the worker (about 30 ms per 100 MB there). Their bricks are still
   * sent, so this saves the encode only. Default false.
   */
  hashModels?: boolean;
  /**
   * Encode the static set's models and bake the static set on this worker
   * ({@link makeSceneWorker}): `setStatic` sends first-sight models to be encoded, and
   * `commitAsync()` adds them and bakes. The layer drops a model on the worker when it is
   * released. A target without `addEncodedModel` only bakes there. Takes the place of
   * `placement` when both are given.
   */
  worker?: SceneWorker;
  /**
   * Bake static sets on this worker ({@link makePlacementWorker}, or a {@link makeSceneWorker}
   * one used for bakes only) when committed with `commitAsync()`; models are uploaded on the main
   * thread. The layer sends each model a static set names once (after its upload) and drops it on
   * the worker when the model is released. Without it (or `worker`), and for `commit()`, the
   * static set is placed synchronously, as before.
   */
  placement?: PlacementWorker;
  /**
   * With a scene worker: how long `commitAsync` may spend adding encoded models before it waits
   * for the next frame, in ms (default 8). Small models share a frame. A target that adds in
   * slices ({@link InstanceTarget.beginEncodedModel}) steps a big model within the budget, so it
   * spans several frames; otherwise at least one whole model is added per frame, and a big one
   * (tens of ms at 100 vox/m) is one long task.
   */
  uploadBudgetMs?: number;
  /**
   * With a scene worker: how `commitAsync` waits between batches of adds. Default: the next frame
   * (`requestAnimationFrame`, then a task, so the frame paints first), or at most 100 ms, since a
   * hidden page draws no frames.
   */
  pace?: () => Promise<void>;
  /**
   * Keep every model an earlier static set uploaded, instead of releasing the ones the drawn set
   * no longer names once it is drawing (see {@link InstanceLayer.setStatic}). For a host that
   * switches between the same sets and would rather keep their models on the GPU than upload
   * them again. Default false.
   */
  keepUnused?: boolean;
}

/** The next frame, painted; or 100 ms, for a page that draws none (hidden, or not a browser). */
function nextFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      setTimeout(resolve, 0);
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(go);
    setTimeout(go, typeof requestAnimationFrame === "function" ? 100 : 0);
  });
}

/**
 * Draw entities by reference instead of stamping them into the world: one GPU copy of each
 * model, drawn wherever it is placed, at any yaw, mirrored, at fractional positions. Instances
 * use palettes of their own, so a scene of instances has no colour budget, and nothing is
 * written into the world's bricks.
 *
 * @param target - A renderer with instancing (`Renderer` implements {@link InstanceTarget}).
 * @param opts - `load` reports uploads and placement into a load tracker; `worker` encodes the
 *   static set's models and bakes it on a scene worker when committed with `commitAsync()`
 *   (`placement` bakes only).
 * @returns The layer; pass it to `makeCrowd` as `instances` for animated members.
 * @example
 * ```ts
 * const layer = makeInstanceLayer(renderer);
 * const oakBase = layer.palettes.of("oak", oak.model.roles);
 * layer.setStatic(sites.map((s) => ({ model: oak.model, x: s.x, y: s.y, z: s.z, yaw: s.yaw, base: oakBase })));
 * layer.commit();
 * ```
 * @example
 * ```ts
 * // Off the main thread: encodes and the bake on a scene worker, adds paced over frames.
 * const worker = makeSceneWorker({ spawn: () => new Worker(new URL("./scene.worker.ts", import.meta.url), { type: "module" }) });
 * const layer = makeInstanceLayer(renderer, { load, worker });
 * layer.setStatic(scenery); // returns at once
 * await layer.commitAsync();
 * ```
 * @example
 * ```ts
 * // Coarse first, one swap: placeholders generated at 20 vox/m drawn 5x enlarged in a 100 vox/m
 * // world, then the fine models. The coarse set draws until the fine one applies, and its models
 * // are released right after. Which models are coarse and when to swap is the app's choice.
 * await renderer.prepare({ scaled: true }); // with deferPipelines
 * layer.setStatic(sites.map((s) => ({ model: coarse[s.kind].model, scale: 5, ...s })));
 * await layer.commitAsync();
 * screen.ready();
 * layer.setStatic(sites.map((s) => ({ model: fine[s.kind].model, ...s })));
 * await layer.commitAsync();
 * ```
 */
export function makeInstanceLayer(target: InstanceTarget, opts: InstanceLayerOptions = {}): InstanceLayer {
  const worker: PlacementWorker | undefined = opts.worker ?? opts.placement;
  const canBake = !!worker && !!target.placementModel && !!target.placementInput && !!target.applyPlacement;
  const scene = opts.worker && typeof target.addEncodedModel === "function" ? opts.worker : undefined;
  const budget = opts.uploadBudgetMs ?? 8;
  const pace = opts.pace ?? nextFrame;
  /** Model id -> the key this layer registered on the worker for it. */
  const sent = new Map<number, number>();
  const { lib: models, settle: settleUploads, uploads, idOf, held } = modelLibrary(
    target,
    opts.load,
    (id) => {
      const key = sent.get(id);
      if (key === undefined) return;
      sent.delete(id);
      worker!.drop(key);
    },
    scene && { worker: scene, modelKey: opts.modelKey, hashModels: opts.hashModels, registered: (id, key) => sent.set(id, key) },
  );
  const palettes = makePaletteLibrary(target);
  /** The static set as given, and as sent (model ids), once resolved. */
  let staticList: readonly EntityPlacement[] = [];
  let fixed: InstancePlacement[] = [];
  let moving: readonly InstancePlacement[] = [];
  let fixedDirty = true;
  // Static sets are numbered as they are sent; `applied` is the one drawing.
  let sentGen = 0;
  let applied = 0;
  let bake: { gen: number; ctl: AbortController; task?: LoadTask; models: Wanted } | undefined;
  let waiters: { gen: number; resolve: () => void; reject: (e: unknown) => void; detach?: () => void }[] = [];

  const placementTask = (n: number) => (opts.load && n > 0 ? opts.load.task(LOAD_PHASES.placement, n) : undefined);
  /** The models `lists` name, by the scales they are placed at. */
  const modelsOf = (...lists: (readonly EntityPlacement[])[]): Wanted => {
    const w: Wanted = new Map();
    for (const list of lists)
      for (const p of list) {
        const k = p.scale ?? 1;
        let set = w.get(p.model);
        if (!set) w.set(p.model, (set = new Set()));
        set.add(k);
      }
    return w;
  };
  /** Every (model, scale) pair of `w`. */
  const pairs = (w: Wanted) => [...w].flatMap(([m, ks]) => [...ks].map((k) => [m, k] as const));
  /** `a`, with `b`'s pairs added. */
  const merge = (a: Wanted, b: Wanted | undefined): Wanted => {
    if (b) for (const [m, ks] of b) for (const k of ks) (a.get(m) ?? a.set(m, new Set()).get(m)!).add(k);
    return a;
  };
  /**
   * The placements of `list` by model id, uploading any model that has none yet: in order of
   * each model's first placement, all its scales together, as the worker path adds them (so
   * both give the same ids; for a set without scales, simply first-sight order).
   */
  const resolve = (list: readonly EntityPlacement[]): InstancePlacement[] => {
    for (const [m, k] of pairs(modelsOf(list))) idOf(m, k);
    return list.map((p) => {
      const k = p.scale ?? 1;
      return { model: idOf(p.model, k), x: p.x, y: p.y, z: p.z, anchor: anchorAt(p.model, k), yaw: p.yaw ?? 0, rotation: p.rotation, mirror: p.mirror, base: p.base };
    });
  };

  /**
   * After static set `list` is drawing: release what the layer uploaded for earlier sets and no
   * longer needs. Kept: what `list` names, what the newest `setStatic` and a bake in flight name,
   * and every model the host asked for by id.
   */
  function retire(list: readonly EntityPlacement[]): void {
    if (opts.keepUnused) return;
    const keep = merge(modelsOf(list, staticList), bake?.models);
    for (const h of [...held()]) if (!h.pinned && !keep.get(h.model)?.has(h.scale)) models.release(h.model, h.scale);
  }

  /** Settle the waiters `ok` covers (resolved up to `gen`) or every one (rejected with `err`). */
  function release(gen: number, err?: { reason: unknown }): void {
    const done = err ? waiters : waiters.filter((w) => w.gen <= gen);
    waiters = err ? [] : waiters.filter((w) => w.gen > gen);
    for (const w of done) {
      w.detach?.();
      if (err) w.reject(err.reason);
      else w.resolve();
    }
  }

  /**
   * Drop the static set in flight: its bake's result will be ignored, and its load task leaves
   * the phase (progress it ticked included, since none of it was placed). Encodes it waits for
   * are left alone: the next set usually names the same models.
   */
  function cancelBake(): void {
    if (!bake) return;
    const b = bake;
    bake = undefined;
    b.task?.discard();
    b.ctl.abort();
  }

  /** Place `fixed` (resolved from `list`) synchronously as static set `gen`. */
  function placeNow(gen: number, list: readonly EntityPlacement[]): void {
    const task = placementTask(fixed.length);
    try {
      target.setInstances(fixed);
      task?.tick(fixed.length);
    } finally {
      task?.end();
    }
    applied = gen;
    retire(list);
    release(applied);
  }

  function placeSync(): void {
    cancelBake();
    // Encodings that have landed are added (after one reservation for them); the rest upload here.
    // One reservation per scale: each is a copy of the encoding in the pools.
    const landed = [...modelsOf(staticList).keys()].flatMap((m) => {
      const u = uploads?.get(m);
      return u?.encoded ? [...u.scales].map(() => u.encoded!) : [];
    });
    if (landed.length) target.reserveBricks?.(landed);
    fixed = resolve(staticList);
    // Encodes the set no longer needs (a superseded set's) are cancelled.
    uploads?.keepOnly(modelsOf(staticList));
    settleUploads();
    placeNow(++sentGen, staticList);
  }

  /** A model the input names was removed or replaced since it was taken. */
  const stale = (input: PlacementInput) => input.models.some((key, id) => key && target.placementModel!(id)?.key !== key);

  /**
   * Add the encoded models `list` names, once they have all landed: one reservation for the
   * batch, then adds paced over frames. False when the set was superseded meanwhile.
   */
  async function upload(b: NonNullable<typeof bake>, list: readonly EntityPlacement[]): Promise<boolean> {
    const needPairs = pairs(modelsOf(list)).filter(([m, k]) => !models.has(m, k));
    for (const [m, k] of needPairs) uploads!.request(m, k);
    const need = [...new Set(needPairs.map(([m]) => m))];
    for (const m of need) {
      const u = uploads!.get(m);
      if (!u) continue;
      try {
        await u.landed;
      } catch (err) {
        if (bake !== b) return false;
        if (needPairs.every(([n, k]) => n !== m || models.has(n, k))) continue; // uploaded meanwhile by a direct `models.id`
        throw err;
      }
      if (bake !== b) return false;
    }
    const todo = need.map((m) => uploads!.get(m)).filter((u) => !!u?.encoded) as Upload[];
    if (!todo.length) return true;
    // Grow the pools once for the batch, then add a few per frame. The reservation counts
    // against the first frame's budget (growing re-uploads what the pools hold). A target that
    // adds in slices (`beginEncodedModel`) steps one model at a time within the budget, so a big
    // model spans several frames; otherwise each model is added whole.
    let t0 = performance.now();
    target.reserveBricks?.(todo.flatMap((u) => [...u.scales].map(() => u.encoded!)));
    for (const u of todo) {
      for (let wait = false; ; ) {
        if (wait || performance.now() - t0 >= budget) {
          await pace();
          t0 = performance.now();
        }
        if (bake !== b) return false;
        if (uploads!.get(u.model) !== u) break;
        if (uploads!.step(u, budget - (performance.now() - t0))) break;
        wait = true; // a slice ran out of budget: the rest waits for the next frame
      }
    }
    return bake === b;
  }

  function startBake(): void {
    cancelBake();
    const gen = ++sentGen;
    const list = staticList;
    const b: NonNullable<typeof bake> = { gen, ctl: new AbortController(), models: modelsOf(list) };
    bake = b;
    uploads?.keepOnly(b.models);
    const fail = (err: unknown) => {
      if (bake !== b) return;
      bake = undefined;
      b.task?.discard();
      fixedDirty = true;
      release(0, { reason: err });
    };
    const bakeIt = () => {
      if (scene) {
        fixed = resolve(list);
        settleUploads();
      }
      if (!canBake) {
        bake = undefined;
        placeNow(gen, list);
        return;
      }
      b.task = placementTask(fixed.length);
      runBake(b, fixed, list, fail);
    };
    if (!scene) return bakeIt();
    upload(b, list)
      .then((current) => current && bakeIt())
      .catch(fail);
  }

  function runBake(b: NonNullable<typeof bake>, list: InstancePlacement[], set: readonly EntityPlacement[], fail: (err: unknown) => void): void {
    // The worker's progress, as instances: `done` follows the bake's fraction of the set but
    // stays below the whole until the apply, so the phase never reads complete before the new
    // set draws. A retried bake starts from 0 again; the count only goes up.
    let ticked = 0;
    const onProgress = (done: number, total: number) => {
      if (bake !== b || !b.task || total <= 0) return;
      const n = Math.min(list.length - 1, Math.round((Math.min(done, total) / total) * list.length));
      if (n > ticked) {
        b.task.tick(n - ticked);
        ticked = n;
      }
    };
    const attempt = async (tries: number): Promise<void> => {
      const input = target.placementInput!(list);
      input.models.forEach((key, id) => {
        if (!key || sent.get(id) === key) return;
        const m = target.placementModel!(id);
        if (!m) return;
        const old = sent.get(id);
        if (old !== undefined) worker!.drop(old);
        worker!.register(m);
        sent.set(id, m.key);
      });
      let result: PlacementBake;
      try {
        result = await worker!.bake(input, { signal: b.ctl.signal, onProgress });
      } catch (err) {
        if (bake !== b) return; // superseded or aborted: already settled
        // A model removed after the input was taken fails the bake on the worker: take the input
        // again. Any other failure would only repeat.
        if (stale(input) && tries < 8) return attempt(tries + 1);
        fail(err);
        return;
      }
      if (bake !== b) return; // a newer static set was sent meanwhile: drop this one
      try {
        target.applyPlacement!(result);
      } catch (err) {
        // A model it names was removed or replaced since the input: bake again.
        if (stale(input) && tries < 8) return attempt(tries + 1);
        fail(err);
        return;
      }
      bake = undefined;
      b.task?.tick(list.length - ticked, worker!.fromCache(result) ? { cached: true } : undefined);
      b.task?.end();
      applied = b.gen;
      retire(set);
      release(b.gen);
    };
    void attempt(0);
  }

  const layer: InstanceLayer = {
    target,
    models,
    palettes,
    setStatic(list) {
      for (const p of list) if (p.scale !== undefined) checkScale(p.scale, "setStatic");
      staticList = list.slice();
      fixedDirty = true;
      if (!scene) {
        // Without a scene worker, first-sight models upload here, as they always have.
        fixed = resolve(staticList);
        settleUploads();
        return;
      }
      const need = modelsOf(staticList);
      uploads!.keepOnly(merge(modelsOf(staticList), bake?.models));
      for (const [m, k] of pairs(need)) uploads!.request(m, k);
    },
    setDynamic(list) {
      for (const p of list) {
        if (p.parts && (models.scaleOf(p.model) ?? 1) !== 1) throw new Error(`setDynamic: model ${p.model} is drawn at scale ${models.scaleOf(p.model)}; a scaled model cannot be posed (parts). Pose a scale-1 model, or bake the pose`);
      }
      moving = list;
    },
    commit() {
      // Scenery is sent once; the moving set every commit.
      if (fixedDirty) {
        settleUploads();
        if (scene) placeSync();
        else {
          cancelBake();
          placeNow(++sentGen, staticList);
        }
        fixedDirty = false;
      }
      target.setInstances(moving, { dynamic: true });
    },
    commitAsync(o = {}) {
      if (!canBake && !scene) {
        layer.commit();
        return Promise.resolve();
      }
      const signal = o.signal;
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (fixedDirty) {
        settleUploads();
        fixedDirty = false;
        startBake();
      }
      target.setInstances(moving, { dynamic: true });
      if (applied >= sentGen) return Promise.resolve();
      const gen = sentGen;
      return new Promise<void>((resolve, reject) => {
        const w: (typeof waiters)[number] = { gen, resolve, reject };
        if (signal) {
          const onAbort = () => {
            if (!waiters.includes(w)) return;
            waiters = waiters.filter((x) => x !== w);
            reject(signal.reason);
            // Nobody waits for the set any more: drop it, and the static set counts as unsent. An
            // add in slices stops too (freeing what it claimed); its encoding is kept.
            if (waiters.length === 0 && bake) {
              cancelBake();
              uploads?.pauseAdds();
              fixedDirty = true;
            }
          };
          signal.addEventListener("abort", onAbort, { once: true });
          w.detach = () => signal.removeEventListener("abort", onAbort);
        }
        waiters.push(w);
      });
    },
    get baking() {
      return !!bake;
    },
    get uploads() {
      return uploads?.size ?? 0;
    },
    count: () => staticList.length + moving.length,
  };
  return layer;
}
