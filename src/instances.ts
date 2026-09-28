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
import type { PlacementBake, PlacementInput, PlacementModel, SparseVoxels } from "@voxolith/renderer/core";
import { LOAD_PHASES, type LoadTask, type LoadTracker } from "./load";
import type { PlacementWorker } from "./worker/placement";

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

/** Options for {@link makeModelLibrary}. */
export interface ModelLibraryOptions {
  /**
   * Report uploads into a load tracker under the `upload` phase, one tick per model seen for the
   * first time. Uploads made in one synchronous run (a `setStatic` call, a loop of `id` calls)
   * form one span, which ends at the end of that run.
   */
  load?: LoadTracker;
}

/** A model library plus the hook that closes its current upload span. */
function modelLibrary(target: InstanceTarget, load: LoadTracker | undefined, beforeRemove?: (id: number) => void): { lib: ModelLibrary; settle(): void } {
  const ids = new Map<EntityModel, number>();
  let task: LoadTask | undefined;
  const settle = () => {
    task?.end();
    task = undefined;
  };
  const lib: ModelLibrary = {
    id(model) {
      let id = ids.get(model);
      if (id === undefined) {
        if (load && !task) {
          task = load.task(LOAD_PHASES.upload);
          // Direct `id` calls have no natural end; close the span once this run is over.
          queueMicrotask(settle);
        }
        task?.add(1);
        id = target.addModel(model.sparse ? { size: model.size, sparse: model.sparse } : { size: model.size, data: model.data });
        ids.set(model, id);
        task?.tick(1);
      }
      return id;
    },
    release(model) {
      const id = ids.get(model);
      if (id === undefined) return;
      beforeRemove?.(id);
      target.removeModel(id);
      ids.delete(model);
    },
    get size() {
      return ids.size;
    },
  };
  return { lib, settle };
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
  /**
   * {@link InstanceLayer.commit}, with the static set baked on the layer's placement worker
   * (`makeInstanceLayer(target, { placement })`) instead of on the main thread. The moving set is
   * sent at once, as by `commit`; the old static set keeps drawing until the new one is applied,
   * and `commit()` calls meanwhile (a crowd's, every frame) send only the moving set.
   *
   * Resolves once the static set of this call, or a newer one, is drawing: at once when it had
   * not changed. Only the newest bake is applied: a `setStatic` + commit while a bake is in
   * flight supersedes it (a synchronous `commit()` too), and its result is dropped when it lands.
   * If a model it names was removed meanwhile, the layer bakes again. Without a placement worker,
   * or with a target lacking the placement methods, it is `commit()` and resolves at once.
   *
   * `signal` drops the pending apply and rejects with `signal.reason` (unless another
   * `commitAsync` is still waiting for the same bake). The worker skips the bake if it has not
   * started it; a started one runs to the end, since the bake is one synchronous call. The static
   * set then counts as unsent: the next `commit()` places it synchronously, the next
   * `commitAsync()` bakes it again. Rejects too when the bake fails on the worker, with the same
   * effect.
   */
  commitAsync(opts?: { signal?: AbortSignal }): Promise<void>;
  /** A static bake is in flight on the placement worker. */
  readonly baking: boolean;
  /** Placements sent last commit. */
  count(): number;
}

/** Options for {@link makeInstanceLayer}. */
export interface InstanceLayerOptions {
  /**
   * Report into a load tracker: first-sight model uploads under `upload` (one tick per model),
   * and each static `setInstances` in `commit` under `placement`, with the number of static
   * placements as its total (ticked all at once, since the renderer builds them in one call).
   * An empty static set is not reported. Both block the main thread; see
   * {@link makeLoadTracker} for what that means for a loading screen. A static set baked on the
   * placement worker (`commitAsync`) is one `placement` task from the bake request to its apply,
   * with the main thread free meanwhile. Its total is still the number of static placements, and
   * its `done` follows the worker's progress (the bake's fraction of that count) but stays below
   * the total until the apply, which ticks the rest. A superseded, aborted or failed bake leaves
   * the phase entirely, its progress included.
   */
  load?: LoadTracker;
  /**
   * Bake static sets on this worker ({@link makePlacementWorker}) when committed with
   * `commitAsync()`. The layer sends each model a static set names once (after its upload) and
   * drops it on the worker when the model is released. Without it, and for `commit()`, the static
   * set is placed synchronously, as before.
   */
  placement?: PlacementWorker;
}

/**
 * Draw entities by reference instead of stamping them into the world: one GPU copy of each
 * model, drawn wherever it is placed, at any yaw, mirrored, at fractional positions. Instances
 * use palettes of their own, so a scene of instances has no colour budget, and nothing is
 * written into the world's bricks.
 *
 * @param target - A renderer with instancing (`Renderer` implements {@link InstanceTarget}).
 * @param opts - `load` reports uploads and placement into a load tracker; `placement` bakes the
 *   static set on a worker when committed with `commitAsync()`.
 * @returns The layer; pass it to `makeCrowd` as `instances` for animated members.
 * @example
 * ```ts
 * const layer = makeInstanceLayer(renderer);
 * const oakBase = layer.palettes.of("oak", oak.model.roles);
 * layer.setStatic(sites.map((s) => ({ model: oak.model, x: s.x, y: s.y, z: s.z, yaw: s.yaw, base: oakBase })));
 * layer.commit();
 * ```
 */
export function makeInstanceLayer(target: InstanceTarget, opts: InstanceLayerOptions = {}): InstanceLayer {
  const worker = opts.placement;
  const canBake = !!worker && !!target.placementModel && !!target.placementInput && !!target.applyPlacement;
  /** Model id -> the key this layer registered on the worker for it. */
  const sent = new Map<number, number>();
  const { lib: models, settle: settleUploads } = modelLibrary(target, opts.load, (id) => {
    const key = sent.get(id);
    if (key === undefined) return;
    sent.delete(id);
    worker!.drop(key);
  });
  const palettes = makePaletteLibrary(target);
  let fixed: InstancePlacement[] = [];
  let moving: readonly InstancePlacement[] = [];
  let fixedDirty = true;
  // Static sets are numbered as they are sent; `applied` is the one drawing.
  let sentGen = 0;
  let applied = 0;
  let bake: { gen: number; ctl: AbortController; task?: LoadTask } | undefined;
  let waiters: { gen: number; resolve: () => void; reject: (e: unknown) => void; detach?: () => void }[] = [];

  const placementTask = (n: number) => (opts.load && n > 0 ? opts.load.task(LOAD_PHASES.placement, n) : undefined);

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
   * Drop the bake in flight: its result will be ignored, and its load task leaves the phase
   * (progress it ticked included, since none of it was placed).
   */
  function cancelBake(): void {
    if (!bake) return;
    const b = bake;
    bake = undefined;
    b.task?.discard();
    b.ctl.abort();
  }

  function placeSync(): void {
    cancelBake();
    const task = placementTask(fixed.length);
    try {
      target.setInstances(fixed);
      task?.tick(fixed.length);
    } finally {
      task?.end();
    }
    applied = ++sentGen;
    release(applied);
  }

  /** A model the input names was removed or replaced since it was taken. */
  const stale = (input: PlacementInput) => input.models.some((key, id) => key && target.placementModel!(id)?.key !== key);

  function startBake(): void {
    cancelBake();
    const gen = ++sentGen;
    const b = { gen, ctl: new AbortController(), task: placementTask(fixed.length) };
    bake = b;
    const list = fixed;
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
      b.task?.tick(list.length - ticked);
      b.task?.end();
      applied = gen;
      release(gen);
    };
    const fail = (err: unknown) => {
      bake = undefined;
      b.task?.discard();
      fixedDirty = true;
      release(0, { reason: err });
    };
    void attempt(0);
  }

  const layer: InstanceLayer = {
    target,
    models,
    palettes,
    setStatic(list) {
      fixed = list.map((p) => ({ model: models.id(p.model), x: p.x, y: p.y, z: p.z, anchor: p.model.anchor, yaw: p.yaw ?? 0, rotation: p.rotation, mirror: p.mirror, base: p.base }));
      fixedDirty = true;
      settleUploads();
    },
    setDynamic(list) {
      moving = list;
    },
    commit() {
      // Scenery is sent once; the moving set every commit.
      if (fixedDirty) {
        settleUploads();
        placeSync();
        fixedDirty = false;
      }
      target.setInstances(moving, { dynamic: true });
    },
    commitAsync(o = {}) {
      if (!canBake) {
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
            // Nobody waits for the bake any more: drop it, and the static set counts as unsent.
            if (waiters.length === 0 && bake) {
              cancelBake();
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
    count: () => fixed.length + moving.length,
  };
  return layer;
}
