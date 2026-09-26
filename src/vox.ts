/**
 * MagicaVoxel interop: `.vox` in, `.vox` out.
 *
 * This is the "entities which match existing models" path: any `.vox` the project already ships
 * becomes an entity, with one role per distinct colour it uses. It is also how generated
 * entities leave the engine for the viewer, the editor or MagicaVoxel itself.
 *
 * Axis convention: `.vox` is Z-up, entities are Y-up. Both directions swizzle
 * (model x, y, z) <-> (entity x, z, y), the same mapping the viewer uses.
 *
 * Headless: it parses and writes buffers, so it runs in bun and workers as well as the browser.
 *
 * @packageDocumentation
 */

import { parseVox, writeVox, type VoxModel } from "@voxolith/renderer/vox";
import type { Entity, EntityModel, RGB, Role } from "./entity";

/** Options for {@link entityFromVox}. */
export interface FromVoxOptions {
  /** `Entity.id`. Default "vox". */
  id?: string;
  /** `Entity.kind`. Default "model". */
  kind?: string;
  /** Role id prefix; roles come out as `${prefix}.0`, `.1`, ... */
  rolePrefix?: string;
  /**
   * Anchor inside the cropped box. Default "base": horizontal centre, y = 0,
   * which is what you want for anything that stands on the ground.
   */
  anchor?: "base" | "centre" | [number, number, number];
  /** Merged into `Entity.meta` after `source` and `srcSize`. */
  meta?: Record<string, unknown>;
}

/**
 * Parse a `.vox` buffer into an entity, cropped to its occupied box. Each distinct palette
 * colour becomes a role (`color.0`, `color.1`, ... in first-seen order, colours from the file's
 * palette), so the entity can be restyled like a generated one. Only the first model in the file
 * is read; colours past 255 roles are dropped.
 *
 * @example
 * ```ts
 * const res = await fetch(`${import.meta.env.BASE_URL}models/chair.vox`);
 * const chair = entityFromVox(await res.arrayBuffer(), { id: "chair", kind: "furniture" });
 * const { base } = palette.allocateFor(chair);
 * ```
 */
export function entityFromVox(buffer: ArrayBuffer, opts: FromVoxOptions = {}): Entity {
  return entityFromVoxModel(parseVox(buffer), opts);
}

/** {@link entityFromVox} for a model already parsed with the renderer's `parseVox`. */
export function entityFromVoxModel(m: VoxModel, opts: FromVoxOptions = {}): Entity {
  // Occupied box in model space (Z-up).
  let mnx = Infinity, mny = Infinity, mnz = Infinity;
  let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (const v of m.voxels) {
    if (v.x < mnx) mnx = v.x;
    if (v.x > mxx) mxx = v.x;
    if (v.y < mny) mny = v.y;
    if (v.y > mxy) mxy = v.y;
    if (v.z < mnz) mnz = v.z;
    if (v.z > mxz) mxz = v.z;
  }
  if (!isFinite(mnx)) {
    mnx = mny = mnz = 0;
    mxx = mxy = mxz = 0;
  }

  // Y-up sizes: width from model x, height from model z, depth from model y.
  const size = { x: mxx - mnx + 1, y: mxz - mnz + 1, z: mxy - mny + 1 };
  const data = new Uint8Array(size.x * size.y * size.z);

  // One role per distinct source colour, numbered in first-seen order.
  const roleOf = new Map<number, number>();
  const roles: Role[] = [];
  const prefix = opts.rolePrefix ?? "color";
  for (const v of m.voxels) {
    let r = roleOf.get(v.c);
    if (r === undefined) {
      if (roles.length >= 255) continue;
      r = roles.length + 1;
      roleOf.set(v.c, r);
      const p = v.c * 4;
      const color: RGB = [m.palette[p] / 255, m.palette[p + 1] / 255, m.palette[p + 2] / 255];
      roles.push({ id: `${prefix}.${roles.length}`, name: `Colour ${v.c}`, color });
    }
    const x = v.x - mnx, y = v.z - mnz, z = v.y - mny;
    data[x + y * size.x + z * size.x * size.y] = r;
  }

  const anchor = resolveAnchor(size, opts.anchor ?? "base");
  const model: EntityModel = { size, data, anchor, roles };
  return {
    id: opts.id ?? "vox",
    kind: opts.kind ?? "model",
    model,
    meta: { source: "vox", srcSize: m.size, ...opts.meta },
  };
}

function resolveAnchor(
  size: { x: number; y: number; z: number },
  a: "base" | "centre" | [number, number, number],
): [number, number, number] {
  if (Array.isArray(a)) return [a[0], a[1], a[2]];
  if (a === "centre") return [size.x / 2, size.y / 2, size.z / 2];
  return [size.x / 2, 0, size.z / 2];
}

/**
 * Serialise an entity to `.vox`. MagicaVoxel stores coordinates in single
 * bytes, so no axis may exceed 255; larger models throw rather than silently
 * wrapping. Role colours become the file's palette (role `v` at index `v`); materials, rigs and
 * clips are not written. Dense models only: a `sparse` model has empty `data` and writes nothing.
 *
 * @returns The file's bytes.
 * @example
 * ```ts
 * const bytes = entityToVox(tree);
 * const url = URL.createObjectURL(new Blob([bytes]));
 * ```
 */
export function entityToVox(entity: Entity): ArrayBuffer {
  const { size, data, roles } = entity.model;
  if (size.x > 255 || size.y > 255 || size.z > 255) {
    throw new Error(`.vox allows at most 255 per axis; model is ${size.x}x${size.y}x${size.z}`);
  }
  if (roles.length > 255) throw new Error(`.vox allows at most 255 colours; model has ${roles.length} roles`);

  const voxels: [number, number, number, number][] = [];
  for (let z = 0; z < size.z; z++)
    for (let y = 0; y < size.y; y++)
      for (let x = 0; x < size.x; x++) {
        const v = data[x + y * size.x + z * size.x * size.y];
        // Y-up entity -> Z-up file.
        if (v !== 0) voxels.push([x, z, y, v]);
      }

  return writeVox({ x: size.x, y: size.z, z: size.y }, voxels, (i) => {
    const role = roles[i - 1];
    if (!role) return null;
    return [
      Math.round(Math.max(0, Math.min(1, role.color[0])) * 255),
      Math.round(Math.max(0, Math.min(1, role.color[1])) * 255),
      Math.round(Math.max(0, Math.min(1, role.color[2])) * 255),
    ];
  });
}