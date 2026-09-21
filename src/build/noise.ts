// Seeded value noise. Generators need coherent noise for bark, foliage carving
// and terrain, and three private copies of this already existed across the
// project; this is the shared one.
//
// Everything returns 0..1 and is a pure function of (coordinates, seed), so a
// generator stays deterministic no matter what order it samples in.

const fade = (t: number): number => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function hash3(ix: number, iy: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(iz, 2147483647) ^ Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export interface Noise {
  /** Trilinear value noise, 0..1. */
  value3(x: number, y: number, z: number, seed?: number): number;
  value2(x: number, y: number, seed?: number): number;
  /** Fractal sum, 0..1. Octaves double in frequency and halve in amplitude. */
  fbm3(x: number, y: number, z: number, octaves?: number): number;
  fbm2(x: number, y: number, octaves?: number): number;
  /** Signed variant in -1..1, handy for direction wobble. */
  signed3(x: number, y: number, z: number, seed?: number): number;
}

export function makeNoise(seed = 1): Noise {
  const base = seed >>> 0 || 1;

  const value3 = (x: number, y: number, z: number, s = 0): number => {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const fx = fade(x - ix), fy = fade(y - iy), fz = fade(z - iz);
    const sd = base + s * 7919;
    const c000 = hash3(ix, iy, iz, sd), c100 = hash3(ix + 1, iy, iz, sd);
    const c010 = hash3(ix, iy + 1, iz, sd), c110 = hash3(ix + 1, iy + 1, iz, sd);
    const c001 = hash3(ix, iy, iz + 1, sd), c101 = hash3(ix + 1, iy, iz + 1, sd);
    const c011 = hash3(ix, iy + 1, iz + 1, sd), c111 = hash3(ix + 1, iy + 1, iz + 1, sd);
    const x00 = lerp(c000, c100, fx), x10 = lerp(c010, c110, fx);
    const x01 = lerp(c001, c101, fx), x11 = lerp(c011, c111, fx);
    return lerp(lerp(x00, x10, fy), lerp(x01, x11, fy), fz);
  };

  const value2 = (x: number, y: number, s = 0): number => value3(x, y, 0.5, s);

  const fbm3 = (x: number, y: number, z: number, octaves = 3): number => {
    let f = 1, a = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += a * value3(x * f, y * f, z * f, o);
      norm += a;
      f *= 2.03;
      a *= 0.5;
    }
    return sum / norm;
  };

  const fbm2 = (x: number, y: number, octaves = 3): number => {
    let f = 1, a = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += a * value2(x * f, y * f, o);
      norm += a;
      f *= 2.03;
      a *= 0.5;
    }
    return sum / norm;
  };

  return {
    value3,
    value2,
    fbm3,
    fbm2,
    signed3: (x, y, z, s = 0) => value3(x, y, z, s) * 2 - 1,
  };
}

/** Smoothstep between two edges, clamped. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0 || 1)));
  return t * t * (3 - 2 * t);
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const mix = lerp;
