// CPU preview renderer.
//
// The GPU path cannot be screenshotted headlessly, so generator work is judged
// with this instead: a DDA raymarcher over the entity's own grid with coarse
// empty-space skipping, a sun shadow ray, face ambient occlusion and a ground
// plane. Shadow and AO are not decoration here — without them a canopy is
// impossible to read, and the whole point is to judge canopies.
//
// It follows the real engine's shading closely enough that what looks right
// here looks right on the GPU, but it is a preview: no materials, one bounce.

import { OccupancyGrid, COARSE_B } from "@voxolith/renderer/core";
import type { Entity, EntityModel, RGB, Vec3 } from "../entity";

export interface RenderOptions {
  width?: number;
  height?: number;
  /** Orbit angle in degrees; 0 looks along +Z. */
  yawDeg?: number;
  /** Elevation in degrees above the horizon. */
  pitchDeg?: number;
  fovDeg?: number;
  /** >1 pulls the camera back, <1 pushes in. */
  zoom?: number;
  /** Look-at height as a fraction of the model's height. */
  aimY?: number;
  /** Look-at offset in voxels, applied after aimY (for close-ups). */
  aimOffset?: Vec3;
  sun?: Vec3;
  shadows?: boolean;
  ao?: boolean;
  ground?: boolean;
  /** Sky gradient, top then horizon. */
  sky?: [RGB, RGB];
  groundColor?: [RGB, RGB];
  /** Replace the model's own role colours. */
  palette?: RGB[];
  /** Render silhouettes in one flat colour, to judge shape alone. */
  flat?: RGB;
}

export interface RenderResult {
  width: number;
  height: number;
  /** Row-major RGB triples. */
  rgb: Uint8Array;
  ms: number;
}

const DEFAULT_SKY: [RGB, RGB] = [
  [0.38, 0.55, 0.85],
  [0.78, 0.86, 0.94],
];
const DEFAULT_GROUND: [RGB, RGB] = [
  [0.33, 0.39, 0.27],
  [0.29, 0.35, 0.24],
];

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export function renderEntity(entity: Entity, opts: RenderOptions = {}): RenderResult {
  return renderModel(entity.model, opts);
}

export function renderModel(model: EntityModel, opts: RenderOptions = {}): RenderResult {
  const t0 = performance.now();
  const W = opts.width ?? 420;
  const H = opts.height ?? 560;
  const { x: sx, y: sy, z: sz } = model.size;
  const data = model.data;
  const sxy = sx * sy;

  const occ = new OccupancyGrid(model.size, data);
  const cxn = Math.ceil(sx / COARSE_B), cyn = Math.ceil(sy / COARSE_B), czn = Math.ceil(sz / COARSE_B);
  const coarseSolid = (x: number, y: number, z: number): boolean => {
    const cx = (x / COARSE_B) | 0, cy = (y / COARSE_B) | 0, cz = (z / COARSE_B) | 0;
    if (cx < 0 || cy < 0 || cz < 0 || cx >= cxn || cy >= cyn || cz >= czn) return false;
    return occ.data[cx + cy * cxn + cz * cxn * cyn] !== 0;
  };
  const at = (x: number, y: number, z: number): number =>
    x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz ? 0 : data[x + y * sx + z * sxy];

  // Colours, indexed by voxel value.
  const colors: RGB[] = [[0, 0, 0]];
  for (let i = 0; i < model.roles.length; i++) {
    colors.push(opts.flat ?? opts.palette?.[i] ?? model.roles[i].color);
  }

  // --- camera ---------------------------------------------------------------
  const yaw = ((opts.yawDeg ?? 35) * Math.PI) / 180;
  const pitch = ((opts.pitchDeg ?? 12) * Math.PI) / 180;
  const fov = ((opts.fovDeg ?? 30) * Math.PI) / 180;
  const tanV = Math.tan(fov / 2);
  const tanU = tanV * (W / H);
  const aimY = opts.aimY ?? 0.5;
  const off = opts.aimOffset ?? [0, 0, 0];
  const target: Vec3 = [sx / 2 + off[0], sy * aimY + off[1], sz / 2 + off[2]];
  const halfV = sy / 2, halfU = Math.max(sx, sz) / 2;
  const dist = Math.max(halfV / tanV, halfU / tanU) * 1.15 * (opts.zoom ?? 1);
  const eye: Vec3 = [
    target[0] + dist * Math.cos(pitch) * Math.sin(yaw),
    target[1] + dist * Math.sin(pitch),
    target[2] + dist * Math.cos(pitch) * Math.cos(yaw),
  ];
  const fwd = norm([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
  const right = norm(cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);

  const sun = norm(opts.sun ?? [0.42, 0.78, -0.46]);
  const sky = opts.sky ?? DEFAULT_SKY;
  const gcol = opts.groundColor ?? DEFAULT_GROUND;
  const wantShadows = opts.shadows !== false;
  const wantAo = opts.ao !== false;
  const wantGround = opts.ground !== false;

  // --- traversal ------------------------------------------------------------
  interface Hit {
    v: number;
    cell: Vec3;
    n: Vec3;
    t: number;
  }

  function trace(ox: number, oy: number, oz: number, d: Vec3, maxT: number, anyHit: boolean): Hit | null {
    // Clip to the grid box first.
    let t0 = 0, t1 = maxT;
    for (let a = 0; a < 3; a++) {
      const o = a === 0 ? ox : a === 1 ? oy : oz;
      const s = a === 0 ? sx : a === 1 ? sy : sz;
      const dd = d[a];
      if (Math.abs(dd) < 1e-9) {
        if (o < 0 || o > s) return null;
        continue;
      }
      let ta = (0 - o) / dd, tb = (s - o) / dd;
      if (ta > tb) [ta, tb] = [tb, ta];
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
    }
    if (t0 > t1) return null;

    let t = t0 + 1e-4;
    let px = ox + d[0] * t, py = oy + d[1] * t, pz = oz + d[2] * t;
    let cx = Math.floor(px), cy = Math.floor(py), cz = Math.floor(pz);
    const stepX = d[0] > 0 ? 1 : d[0] < 0 ? -1 : 0;
    const stepY = d[1] > 0 ? 1 : d[1] < 0 ? -1 : 0;
    const stepZ = d[2] > 0 ? 1 : d[2] < 0 ? -1 : 0;
    const ddx = stepX ? Math.abs(1 / d[0]) : Infinity;
    const ddy = stepY ? Math.abs(1 / d[1]) : Infinity;
    const ddz = stepZ ? Math.abs(1 / d[2]) : Infinity;
    let mx = stepX ? t + (stepX > 0 ? cx + 1 - px : px - cx) * ddx : Infinity;
    let my = stepY ? t + (stepY > 0 ? cy + 1 - py : py - cy) * ddy : Infinity;
    let mz = stepZ ? t + (stepZ > 0 ? cz + 1 - pz : pz - cz) * ddz : Infinity;
    let nx = 0, ny = 0, nz = 0;

    const cap = sx + sy + sz + 16;
    for (let i = 0; i < cap; i++) {
      if (cx < 0 || cy < 0 || cz < 0 || cx >= sx || cy >= sy || cz >= sz) return null;
      if (t > t1) return null;

      if (!coarseSolid(cx, cy, cz)) {
        // Jump the ray to the far plane of the empty coarse block.
        const bx = ((cx / COARSE_B) | 0) + (stepX > 0 ? 1 : 0);
        const by = ((cy / COARSE_B) | 0) + (stepY > 0 ? 1 : 0);
        const bz = ((cz / COARSE_B) | 0) + (stepZ > 0 ? 1 : 0);
        const tx = stepX ? (bx * COARSE_B - ox) / d[0] : Infinity;
        const ty = stepY ? (by * COARSE_B - oy) / d[1] : Infinity;
        const tz = stepZ ? (bz * COARSE_B - oz) / d[2] : Infinity;
        const tExit = Math.min(tx, ty, tz);
        if (!isFinite(tExit) || tExit > t1) return null;
        nx = tExit === tx ? -stepX : 0;
        ny = tExit === ty ? -stepY : 0;
        nz = tExit === tz ? -stepZ : 0;
        t = tExit + 1e-4;
        px = ox + d[0] * t;
        py = oy + d[1] * t;
        pz = oz + d[2] * t;
        cx = Math.floor(px);
        cy = Math.floor(py);
        cz = Math.floor(pz);
        mx = stepX ? t + (stepX > 0 ? cx + 1 - px : px - cx) * ddx : Infinity;
        my = stepY ? t + (stepY > 0 ? cy + 1 - py : py - cy) * ddy : Infinity;
        mz = stepZ ? t + (stepZ > 0 ? cz + 1 - pz : pz - cz) * ddz : Infinity;
        continue;
      }

      const v = at(cx, cy, cz);
      if (v !== 0) {
        if (anyHit) return { v, cell: [cx, cy, cz], n: [0, 0, 0], t };
        return { v, cell: [cx, cy, cz], n: [nx, ny, nz], t };
      }

      if (mx <= my && mx <= mz) {
        t = mx;
        mx += ddx;
        cx += stepX;
        nx = -stepX;
        ny = 0;
        nz = 0;
      } else if (my <= mz) {
        t = my;
        my += ddy;
        cy += stepY;
        nx = 0;
        ny = -stepY;
        nz = 0;
      } else {
        t = mz;
        mz += ddz;
        cz += stepZ;
        nx = 0;
        ny = 0;
        nz = -stepZ;
      }
    }
    return null;
  }

  const inShadow = (p: Vec3): boolean =>
    wantShadows && trace(p[0], p[1], p[2], sun, 4096, true) !== null;

  /** Classic voxel face AO: darken where the cell in front has solid neighbours. */
  function faceAo(cell: Vec3, n: Vec3): number {
    if (!wantAo) return 1;
    const fx = cell[0] + n[0], fy = cell[1] + n[1], fz = cell[2] + n[2];
    let t1x = 1, t1y = 0, t1z = 0, t2x = 0, t2y = 0, t2z = 1;
    if (Math.abs(n[1]) > 0.5) {
      t1x = 1; t1y = 0; t1z = 0; t2x = 0; t2y = 0; t2z = 1;
    } else if (Math.abs(n[0]) > 0.5) {
      t1x = 0; t1y = 1; t1z = 0; t2x = 0; t2y = 0; t2z = 1;
    } else {
      t1x = 1; t1y = 0; t1z = 0; t2x = 0; t2y = 1; t2z = 0;
    }
    const s = (dx: number, dy: number, dz: number) => (at(fx + dx, fy + dy, fz + dz) !== 0 ? 1 : 0);
    const side =
      s(t1x, t1y, t1z) + s(-t1x, -t1y, -t1z) + s(t2x, t2y, t2z) + s(-t2x, -t2y, -t2z);
    const corner =
      s(t1x + t2x, t1y + t2y, t1z + t2z) +
      s(t1x - t2x, t1y - t2y, t1z - t2z) +
      s(-t1x + t2x, -t1y + t2y, -t1z + t2z) +
      s(-t1x - t2x, -t1y - t2y, -t1z - t2z);
    return Math.max(0.45, 1 - (side * 0.1 + corner * 0.05));
  }

  // --- shading --------------------------------------------------------------
  const rgb = new Uint8Array(W * H * 3);
  const enc = (o: number, r: number, g: number, b: number): void => {
    // Gentle filmic-ish curve, then sRGB-ish gamma.
    rgb[o] = Math.min(255, Math.max(0, Math.round(Math.pow(Math.min(1, r), 0.85) * 255)));
    rgb[o + 1] = Math.min(255, Math.max(0, Math.round(Math.pow(Math.min(1, g), 0.85) * 255)));
    rgb[o + 2] = Math.min(255, Math.max(0, Math.round(Math.pow(Math.min(1, b), 0.85) * 255)));
  };

  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const u = ((i + 0.5) / W - 0.5) * 2 * tanU;
      const v = (0.5 - (j + 0.5) / H) * 2 * tanV;
      const dir = norm([
        fwd[0] + u * right[0] + v * up[0],
        fwd[1] + u * right[1] + v * up[1],
        fwd[2] + u * right[2] + v * up[2],
      ]);
      const o = (j * W + i) * 3;

      const hit = trace(eye[0], eye[1], eye[2], dir, 4096, false);
      if (hit) {
        const c = colors[hit.v] ?? [1, 0, 1];
        const n = hit.n;
        const ndl = Math.max(0, n[0] * sun[0] + n[1] * sun[1] + n[2] * sun[2]);
        const px = eye[0] + dir[0] * hit.t + n[0] * 0.02;
        const py = eye[1] + dir[1] * hit.t + n[1] * 0.02;
        const pz = eye[2] + dir[2] * hit.t + n[2] * 0.02;
        const shade = ndl > 0 && inShadow([px, py, pz]) ? 0.35 : 1;
        const ao = faceAo(hit.cell, n);
        // Hemispheric ambient: sky above, bounced ground below.
        const upness = Math.max(0, Math.min(1, n[1] * 0.5 + 0.5));
        const ambR = gcol[0][0] * (1 - upness) * 0.45 + sky[1][0] * upness * 0.55;
        const ambG = gcol[0][1] * (1 - upness) * 0.45 + sky[1][1] * upness * 0.55;
        const ambB = gcol[0][2] * (1 - upness) * 0.45 + sky[1][2] * upness * 0.55;
        const key = 1.05 * ndl * shade;
        enc(o, c[0] * (ambR + key) * ao, c[1] * (ambG + key) * ao, c[2] * (ambB + key) * ao);
        continue;
      }

      if (wantGround && dir[1] < -1e-6) {
        const tg = -eye[1] / dir[1];
        if (tg > 0 && tg < 4000) {
          const gx = eye[0] + dir[0] * tg, gz = eye[2] + dir[2] * tg;
          const checker = ((Math.floor(gx / 8) + Math.floor(gz / 8)) & 1) === 0 ? 0 : 1;
          const g = gcol[checker];
          const shadowed = trace(gx, 0.02, gz, sun, 4096, true) !== null;
          // Fade the plane into the horizon so it does not read as a hard disc.
          const fade = Math.min(1, 220 / (tg * 0.5 + 1));
          const lit = shadowed ? 0.45 : 1;
          const r = g[0] * lit, gg = g[1] * lit, b = g[2] * lit;
          enc(
            o,
            r * fade + sky[1][0] * (1 - fade),
            gg * fade + sky[1][1] * (1 - fade),
            b * fade + sky[1][2] * (1 - fade),
          );
          continue;
        }
      }

      const h = Math.max(0, Math.min(1, dir[1] * 1.6 + 0.12));
      enc(
        o,
        sky[1][0] + (sky[0][0] - sky[1][0]) * h,
        sky[1][1] + (sky[0][1] - sky[1][1]) * h,
        sky[1][2] + (sky[0][2] - sky[1][2]) * h,
      );
    }
  }

  return { width: W, height: H, rgb, ms: performance.now() - t0 };
}
