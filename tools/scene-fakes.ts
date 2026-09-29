// Fakes shared by the scene worker checks (verify-scene, verify-scene-cache): a renderer-like
// target on a real brick pool with real bakes, and a real `serveScene` behind a fake channel that
// structured-clones every message with its transfer list, as postMessage does.

import { BrickPool, bakePlacement, encodeModel, sparseFromDense, type EncodedModel, type ModelSource, type PlacementBake, type PlacementInput, type PlacementModel } from "@voxolith/renderer/core";
import { makeInstanceLayer, type EntityPlacement, type InstancePlacement } from "../src/instances";
import { serveScene, type SceneRequest, type SceneResponse, type ServeSceneOptions } from "../src/worker/scene";
import { LOAD_PHASES, makeLoadTracker } from "../src/load";
import type { EntityModel } from "../src/entity";

export const tick = () => new Promise<void>((r) => setTimeout(r, 0));
export const settle = async (n = 12) => { for (let i = 0; i < n; i++) await tick(); };

// --- a fake renderer: the renderer's add path on a real brick pool, real bakes ---------------------

let nextKey = 1; // unique on the page, never reused, as the renderer's are
const poseKeys = new WeakMap<Int32Array, number>();
export function fakeTarget() {
  const pool = new BrickPool();
  const models: ({ top: Uint32Array; partTop?: Uint32Array; placement: PlacementModel } | null)[] = [];
  const byKey = new Map<number, PlacementModel>();
  const log: string[] = [];
  const t = {
    pool,
    models,
    log,
    adds: 0,
    encodedAdds: 0,
    staticBake: undefined as PlacementBake | undefined,
    staticSets: 0,
    dynamicCalls: 0,
    addModel(src: ModelSource, o?: { scale?: number }) {
      t.adds++;
      log.push("addModel");
      return add(encodeModel(src), o?.scale);
    },
    addEncodedModel(e: EncodedModel, o?: { scale?: number }) {
      t.encodedAdds++;
      log.push("addEncoded");
      return add(e, o?.scale);
    },
    reserveBricks(list: readonly EncodedModel[]) {
      log.push(`reserve:${list.length}`);
      let n4 = 0, n8 = 0;
      for (const e of list) { n4 += e.voxels4.length / 64; n8 += e.voxels8.length / 128; }
      pool.reserve(pool.slots4 + n4, pool.slots8 + n8);
    },
    removeModel(id: number) {
      const m = models[id];
      if (!m) return;
      log.push(`remove:${id}`);
      byKey.delete(m.placement.key);
      models[id] = null;
    },
    addPalette: () => 256,
    setPaletteColors() {},
    removePalette() {},
    setInstances(list: readonly InstancePlacement[], o: { dynamic?: boolean } = {}) {
      if (o.dynamic) { t.dynamicCalls++; return; }
      apply(bakePlacement(t.placementInput(list), (key) => byKey.get(key)));
    },
    placementModel: (id: number) => models[id]?.placement ?? null,
    placementInput(list: readonly InstancePlacement[]): PlacementInput {
      const keys: number[] = [];
      const instances = [];
      for (const p of list) {
        const m = models[p.model];
        if (!m) continue;
        keys[p.model] = m.placement.key;
        const q: Record<string, unknown> = { model: p.model, x: p.x, y: p.y, z: p.z, base: p.base };
        if (p.anchor !== undefined) q.anchor = p.anchor;
        if (p.yaw !== undefined) q.yaw = p.yaw;
        if (p.mirror !== undefined) q.mirror = p.mirror;
        instances.push(q);
      }
      for (let i = 0; i < keys.length; i++) keys[i] ??= 0;
      return { grid: { brickDim: [32, 16, 32], topDim: [4, 2, 4], gridMax: 256 }, models: keys, instances } as unknown as PlacementInput;
    },
    applyPlacement: (bake: PlacementBake) => apply(bake),
  };
  function add(e: EncodedModel, scale = 1, at?: number): number {
    if (e.version !== 1) throw new Error("stale encoding");
    const claimed = pool.adopt(e);
    const local = (top: Uint32Array) => top.map((v) => (v ? claimed.blocks[v - 1] + 1 : 0));
    const placement: PlacementModel = { key: nextKey++, size: { ...e.size }, subs: e.subs };
    const boxes = e.partTop ? e.partBoxes : undefined;
    if (boxes) {
      let k = poseKeys.get(boxes);
      if (k === undefined) poseKeys.set(boxes, (k = nextKey++));
      placement.partBoxes = boxes;
      placement.poseKey = k;
    }
    if (e.joints) placement.joints = e.joints;
    if (scale !== 1) placement.scale = scale; // as the renderer: left out at scale 1
    let id = at ?? models.indexOf(null);
    if (id < 0) id = models.push(null) - 1;
    models[id] = { top: local(e.top), partTop: e.partTop && local(e.partTop), placement };
    byKey.set(placement.key, placement);
    return id;
  }
  const apply = (bake: PlacementBake) => {
    bake.models.forEach((key, id) => {
      if (key && models[id]?.placement.key !== key) throw new Error(`applyPlacement: model ${id} was removed or replaced since the bake; bake again`);
    });
    t.staticBake = bake;
    t.staticSets++;
    log.push("placed");
  };
  return Object.assign(t, { addAt: add });
}
export type Fake = ReturnType<typeof fakeTarget>;

/**
 * The fake target, adding encoded models in slices (`beginEncodedModel`) as the renderer does: the
 * id is claimed at `begin` (so ids match the whole-add path), each finite `step` does
 * `bricksPerStep` bricks, the last one adds the model; `cancel` frees the id.
 */
export function slicedTarget(bricksPerStep: number) {
  const t = fakeTarget();
  const s = Object.assign(t, { begins: 0, steps: 0, cancels: 0, open: 0 });
  return Object.assign(s, {
    beginEncodedModel(e: EncodedModel, o?: { scale?: number }) {
      s.begins++;
      s.open++;
      t.log.push("begin");
      let id = t.models.indexOf(null);
      if (id < 0) id = t.models.push(null) - 1;
      // Claimed: not free (null), not a model yet.
      t.models[id] = undefined as unknown as (typeof t.models)[number];
      const total = Math.max(1, e.voxels4.length / 64 + e.voxels8.length / 128);
      let did = 0, done = false, cancelled = false;
      return {
        id,
        get done() { return done; },
        /** Bricks done over the model's, as the renderer's fraction of payload bytes. */
        get progress() { return done ? 1 : did / total; },
        step(budget: number) {
          if (done || cancelled) throw new Error("step after done or cancel");
          s.steps++;
          t.log.push("step");
          did = budget === Infinity ? total : Math.min(total, did + bricksPerStep);
          if (did < total) return false;
          t.encodedAdds++;
          t.addAt(e, o?.scale, id);
          done = true;
          s.open--;
          t.log.push("addEncoded");
          return true;
        },
        cancel() {
          if (done || cancelled) return;
          cancelled = true;
          s.cancels++;
          s.open--;
          t.log.push("cancel");
          t.models[id] = null;
        },
      };
    },
  });
}

// --- a real worker side behind a fake channel that clones and transfers ---------------------------

export function channel(opts: Pick<ServeSceneOptions, "cache"> = {}) {
  const sent: SceneRequest[] = [];
  const state = { hold: false, held: [] as SceneResponse[], encodes: 0, bakes: 0, cachedEncodes: 0, cachedBakes: 0, progress: 0, terminated: false };
  let toMain: ((ev: MessageEvent<SceneResponse>) => void) | null = null;
  const scope = {
    onmessage: null as ((ev: { data: SceneRequest }) => void) | null,
    postMessage(msg: SceneResponse, transfer: Transferable[] = []) {
      if (msg.kind === "encoded") msg.cached ? state.cachedEncodes++ : state.encodes++;
      if (msg.kind === "baked") msg.cached ? state.cachedBakes++ : state.bakes++;
      if (msg.kind === "progress") state.progress++;
      const copy = structuredClone(msg, { transfer: transfer as Transferable[] });
      if (state.hold) state.held.push(copy);
      else setTimeout(() => toMain?.({ data: copy } as MessageEvent<SceneResponse>), 0);
    },
  };
  serveScene({ scope, ...opts });
  const worker = {
    set onmessage(fn: typeof toMain) { toMain = fn; },
    onerror: null as ((ev: ErrorEvent) => void) | null,
    postMessage(msg: SceneRequest, transfer: Transferable[] = []) {
      sent.push(msg);
      const copy = structuredClone(msg, { transfer: transfer as Transferable[] });
      setTimeout(() => scope.onmessage?.({ data: copy }), 0);
    },
    terminate() { state.terminated = true; },
  };
  const release = () => { const h = state.held.splice(0); state.hold = false; for (const m of h) toMain?.({ data: m } as MessageEvent<SceneResponse>); };
  return { spawn: () => worker as unknown as Worker, sent, state, release, worker };
}
export const kinds = (list: readonly SceneRequest[], kind: SceneRequest["kind"]) => list.filter((m) => m.kind === kind);

// --- the scene -----------------------------------------------------------------------------------

export function dense(sx: number, sy: number, sz: number, fill: number, seed: number): Uint8Array {
  const data = new Uint8Array(sx * sy * sz);
  let s = seed;
  for (let i = 0; i < data.length; i++) { s = (s * 1103515245 + 12345) >>> 0; if ((s >>> 24) / 256 < fill) data[i] = 1 + ((s >>> 8) % 20); }
  return data;
}
export const box = (sx: number, sy: number, sz: number, fill = 0.4, seed = 1): EntityModel =>
  ({ size: { x: sx, y: sy, z: sz }, data: dense(sx, sy, sz, fill, seed), anchor: [sx >> 1, 0, sz >> 1], roles: [] }) as unknown as EntityModel;
export const sparseBox = (sx: number, sy: number, sz: number, fill: number, seed: number): EntityModel => {
  const size = { x: sx, y: sy, z: sz };
  return { size, data: new Uint8Array(0), sparse: sparseFromDense(size, dense(sx, sy, sz, fill, seed)), anchor: [sx >> 1, 0, sz >> 1], roles: [] } as unknown as EntityModel;
};
export function scene(ms: EntityModel[], n: number, seed: number): EntityPlacement[] {
  let s = seed;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  return Array.from({ length: n }, (_, i) => ({ model: ms[i % ms.length], x: 8 + r() * 200, y: r() * 60, z: 8 + r() * 200, yaw: r() * 6.28, mirror: r() < 0.3, base: 256 + (i % 3) * 4 }));
}
export const units = (m: EntityModel) => (m.sparse ? m.sparse.bricks.size : Math.ceil(m.size.x / 8) * Math.ceil(m.size.y / 8) * Math.ceil(m.size.z / 8));

// --- comparing applied state ------------------------------------------------------------------------

export const bytes = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
export function eq(a: ArrayBufferView | undefined, b: ArrayBufferView | undefined): boolean {
  if (!a || !b) return a === b;
  const x = bytes(a), y = bytes(b);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
/** Where two targets' uploaded state differs ("" when it is the same). */
export function sameState(a: Fake, b: Fake): string {
  const pa = a.pool, pb = b.pool;
  if (pa.slots4 !== pb.slots4 || pa.slots8 !== pb.slots8 || pa.blockCount !== pb.blockCount) return `pool sizes ${pa.slots4}/${pa.slots8}/${pa.blockCount} vs ${pb.slots4}/${pb.slots8}/${pb.blockCount}`;
  if (!eq(pa.voxels4.subarray(0, pa.slots4 * 64), pb.voxels4.subarray(0, pb.slots4 * 64))) return "4-bit payloads differ";
  if (!eq(pa.palettes.subarray(0, pa.slots4 * 8), pb.palettes.subarray(0, pb.slots4 * 8))) return "palettes differ";
  if (!eq(pa.voxels8.subarray(0, pa.slots8 * 128), pb.voxels8.subarray(0, pb.slots8 * 128))) return "8-bit payloads differ";
  if (!eq(pa.blocks.subarray(0, pa.blockCount * 512), pb.blocks.subarray(0, pb.blockCount * 512))) return "index blocks differ";
  if (a.models.length !== b.models.length) return `${a.models.length} vs ${b.models.length} model slots`;
  for (let i = 0; i < a.models.length; i++) {
    const x = a.models[i], y = b.models[i];
    if (!x || !y) { if (x !== y) return `model ${i} present on one side only`; continue; }
    if (!eq(x.top, y.top) || !eq(x.partTop, y.partTop)) return `model ${i}: top level differs`;
    if (!eq(x.placement.subs, y.placement.subs)) return `model ${i}: sub-cells differ`;
    if (JSON.stringify(x.placement.size) !== JSON.stringify(y.placement.size)) return `model ${i}: size differs`;
  }
  return sameBake(a.staticBake, b.staticBake);
}
export const WORDS = ["inst", "boxes", "parts", "cells", "list", "subs", "subCells"] as const;
export function sameBake(a: PlacementBake | undefined, b: PlacementBake | undefined): string {
  if (!a || !b) return a === b ? "" : "missing bake";
  if (a.count !== b.count) return `count ${a.count} vs ${b.count}`;
  for (const k of WORDS) if (!eq(a[k], b[k])) return `bake: ${k} differs`;
  return "";
}
export function syncOf(set: EntityPlacement[]): Fake {
  const t = fakeTarget();
  const l = makeInstanceLayer(t);
  l.setStatic(set);
  l.commit();
  return t;
}
export const phase = (load: ReturnType<typeof makeLoadTracker>, p: string = LOAD_PHASES.upload) => load.snapshot().phases.find((x) => x.phase === p);
