// Pluggable entity generators.
//
// A generator package exports one or more `EntityGenerator`s and the host
// registers them. Generation is pure and deterministic: everything random
// comes from the injected `rng`, so the same parameters and seed always give
// the same entity, which is what makes generated content safe to use in
// gameplay, tests and asset baking.

import type { Entity, Role } from "./entity";

/** Describes one tunable so an editor can build a UI without knowing the type. */
export type ParamSpec =
  | { path: string; label: string; kind: "number"; min: number; max: number; step?: number; group?: string; help?: string }
  | { path: string; label: string; kind: "int"; min: number; max: number; group?: string; help?: string }
  | { path: string; label: string; kind: "bool"; group?: string; help?: string }
  | { path: string; label: string; kind: "enum"; options: readonly string[]; group?: string; help?: string };

export interface EntityGenerator<P> {
  /** Namespaced and stable, e.g. "voxolith/tree.broadleaf". */
  id: string;
  name: string;
  /** Bump when output changes for the same input, so caches can be invalidated. */
  version: string;
  description?: string;
  /** Every role the generator can emit, in voxel-value order. */
  roles: Role[];
  defaults: P;
  params: ParamSpec[];
  /**
   * `ctx` is optional and every field of it has a default, so a call without
   * it gives exactly the model it always did.
   */
  generate(params: P, rng: () => number, ctx?: GenerateContext): Entity;
  /**
   * Voxel scales this generator supports beyond its native one (default
   * DEFAULT_VOXELS_PER_METRE), e.g. [100]. Absent: native only.
   */
  scales?: number[];
}

/**
 * The world an entity is generated for.
 *
 * Parameters stay in the generator's native voxels (10 per metre unless it
 * says otherwise), so share codes and existing models are unaffected; a finer
 * world asks for the same design at more voxels per metre, and the generator
 * decides how to add the detail (see gen-kit `refine`).
 */
export interface GenerateContext {
  /** Default DEFAULT_VOXELS_PER_METRE. */
  voxelsPerMetre?: number;
}

/** The scale every generator's parameters are written in. */
export const DEFAULT_VOXELS_PER_METRE = 10;

/**
 * Whole-number refinement factor for a context: how many fine voxels per
 * native one along each axis (1 at the native scale).
 */
export function refinement(ctx?: GenerateContext, native = DEFAULT_VOXELS_PER_METRE): number {
  return Math.max(1, Math.round((ctx?.voxelsPerMetre ?? native) / native));
}

const registry = new Map<string, EntityGenerator<never>>();

export function registerGenerator<P>(gen: EntityGenerator<P>): void {
  if (registry.has(gen.id)) throw new Error(`Generator "${gen.id}" is already registered`);
  registry.set(gen.id, gen as unknown as EntityGenerator<never>);
}

export function getGenerator<P = unknown>(id: string): EntityGenerator<P> | undefined {
  return registry.get(id) as unknown as EntityGenerator<P> | undefined;
}

export function listGenerators(): EntityGenerator<unknown>[] {
  return [...registry.values()] as unknown as EntityGenerator<unknown>[];
}

/** Test/hot-reload helper; not used at runtime. */
export function clearGenerators(): void {
  registry.clear();
}

/** Read a dotted `ParamSpec.path` out of a parameter object. */
export function getParam(params: unknown, path: string): unknown {
  let cur: unknown = params;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Write a dotted `ParamSpec.path`, cloning objects along the way. */
export function withParam<P>(params: P, path: string, value: unknown): P {
  const keys = path.split(".");
  const clone = (node: unknown, depth: number): unknown => {
    if (depth === keys.length) return value;
    const key = keys[depth];
    const src = (node ?? {}) as Record<string, unknown>;
    return { ...src, [key]: clone(src[key], depth + 1) };
  };
  return clone(params, 0) as P;
}