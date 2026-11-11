// The physical sky's model, on the CPU: the atmosphere, its transmittance and multiple
// scattering, the sky's radiance and the light it casts, and everything `makePhysicalSky` derives
// from them each frame (key light, ambient, fog colour, the background's parameters). Headless: the
// GPU half (physical-sky.ts) computes the same look-up tables in compute shaders for the backdrop,
// and this twin keeps the scene light consistent with it and testable without a GPU.
//
// After Sébastien Hillaire, "A Scalable and Production Ready Sky and Atmosphere Rendering
// Technique", Computer Graphics Forum 39(4) (EGSR 2020), doi:10.1111/cgf.14050: a transmittance
// table, a multiple-scattering table (the isotropic second order, summed as a geometric series,
// his eq. 5-10) and a sky-view table with a non-linear latitude mapping. The transmittance table's
// parameterisation and the Earth constants follow Eric Bruneton and Fabrice Neyret, "Precomputed
// Atmospheric Scattering", Computer Graphics Forum 27(4) (EGSR 2008), doi:10.1111/j.1467-8659.2008.01245.x,
// as revised in Bruneton's 2017 reference implementation, which Hillaire's also uses.
//
// Units: kilometres for the atmosphere; light in units of the sun's illuminance outside the
// atmosphere (1 = the sun, per channel). Exposure and the tone curve turn it into the renderer's
// LDR values; they are artistic (the renderer has no bounce light and no tone mapping), and tuned
// so the derived light lands in the ranges `timeOfDay` has always used.

import { BACKGROUND_FLOATS } from "@voxolith/renderer/core";
import type { Lighting } from "./timeofday";

type Vec3 = [number, number, number];

/**
 * The constants of a planet's atmosphere for {@link makePhysicalSky}, in kilometres. Defaults are
 * {@link EARTH_ATMOSPHERE}. Changing them rebuilds every look-up table, so set them once.
 */
export interface SkyAtmosphere {
  /** Planet radius, km. */
  bottomRadius: number;
  /** Radius of the top of the atmosphere, km. */
  topRadius: number;
  /** Rayleigh (air) scattering coefficients per km at the ground, linear RGB. */
  rayleighScattering: Vec3;
  /** Height over which the air's density falls by e, km. */
  rayleighScaleHeight: number;
  /** Mie (aerosol) scattering coefficient per km at the ground. */
  mieScattering: number;
  /** Mie extinction per km at the ground (scattering plus absorption). */
  mieExtinction: number;
  /** Height over which aerosol density falls by e, km. */
  mieScaleHeight: number;
  /** Mie phase asymmetry (Henyey-Greenstein g): 0 even, towards 1 a bright halo round the sun. */
  mieG: number;
  /** Ozone absorption per km at its densest, linear RGB (what keeps twilight blue). */
  ozoneAbsorption: Vec3;
  /** Altitude of the ozone layer's peak, km. */
  ozoneCentre: number;
  /** Half the ozone layer's thickness, km (density falls linearly to 0 either side). */
  ozoneHalfWidth: number;
  /** The ground's albedo, linear RGB: light it sends back into the sky, and the ambient from below. */
  groundAlbedo: Vec3;
}

/**
 * The Earth's atmosphere, as Hillaire (EGSR 2020) and Bruneton (2017) use it: Rayleigh scattering
 * with an 8 km scale height, Mie with 1.2 km and g = 0.8, an ozone layer peaking at 25 km, ground
 * albedo 0.3.
 */
export const EARTH_ATMOSPHERE: Readonly<SkyAtmosphere> = {
  bottomRadius: 6360,
  topRadius: 6460,
  rayleighScattering: [5.802e-3, 13.558e-3, 33.1e-3],
  rayleighScaleHeight: 8,
  mieScattering: 3.996e-3,
  mieExtinction: 4.44e-3,
  mieScaleHeight: 1.2,
  mieG: 0.8,
  ozoneAbsorption: [0.65e-3, 1.881e-3, 0.085e-3],
  ozoneCentre: 25,
  ozoneHalfWidth: 15,
  groundAlbedo: [0.3, 0.3, 0.3],
};

/** Options for {@link makePhysicalSky} (and its headless twin, {@link makeSkyModel}). */
export interface PhysicalSkyOptions {
  /** The atmosphere's constants; default {@link EARTH_ATMOSPHERE}. */
  atmosphere?: Partial<SkyAtmosphere>;
  /** The camera's height above the ground, metres (default 100; at least 10). Fixed per sky. */
  altitude?: number;
  /** Angular radius of the sun disc, radians. Default 0.0093, about twice the real sun, which reads better on screen. */
  sunRadius?: number;
  /** Angular radius of the moon disc, radians. Default 0.0093. */
  moonRadius?: number;
  /**
   * The full moon's illuminance, as a fraction of the sun's (default 0.03). The real ratio is
   * about 2.5e-6; this one is brighter, so that with the eye's adaptation (below) a moonlit night
   * is dark but readable, lit about as `timeOfDay`'s night is.
   */
  moonIlluminance?: number;
  /** Colour of moonlight (linear RGB, default [0.3, 0.45, 1], which displays as a pale blue): the blue of a moonlit night. */
  moonTint?: Vec3;
  /** Overall exposure multiplier, on the scene light and the sky alike (default 1). */
  exposure?: number;
  /**
   * How far exposure adapts to the light, 0 (fixed: night is black) .. 1 (fully: night as bright
   * as day). Default 0.55. The backdrop adapts less than the scene light, so the night sky stays
   * darker than what it lights.
   */
  adaptation?: number;
  /**
   * Multiplier on the sky's ambient light (default 3.2). The renderer has no bounce light, so its
   * ambient stands for the sky and everything the scene reflects; physical sky light alone leaves
   * shadows too dark.
   */
  ambient?: number;
  /** Multiplier on the stars' brightness (default 1; 0 hides them). */
  stars?: number;
  /**
   * The key light never comes from lower than this elevation, degrees (default 8; eased, not
   * clamped), so a low sun still lights walls rather than grazing everything into shadow.
   */
  minLightElevation?: number;
}

/** Sky-view table size (Hillaire's 192x108). */
export const SKY_VIEW_W = 192;
/** Sky-view table height. */
export const SKY_VIEW_H = 108;
/** Transmittance table size on the GPU (Hillaire's 256x64). */
export const TRANSMITTANCE_W = 256;
/** Transmittance table height on the GPU. */
export const TRANSMITTANCE_H = 64;
/** Multiple-scattering table size (32x32). */
export const MULTI_SCATTERING_N = 32;

/** Resolved options. */
export interface SkySettings {
  atm: SkyAtmosphere;
  /** Camera radius, km. */
  camR: number;
  /** Zenith angle of the horizon seen from the camera (a little past 90°). */
  horizonZenith: number;
  sunRadius: number;
  moonRadius: number;
  moonIlluminance: number;
  moonTint: Vec3;
  exposure: number;
  adaptation: number;
  ambient: number;
  stars: number;
  minLightY: number;
}

export function resolveSkyOptions(o: PhysicalSkyOptions = {}): SkySettings {
  const atm: SkyAtmosphere = { ...EARTH_ATMOSPHERE, ...o.atmosphere };
  const camR = atm.bottomRadius + Math.max(10, o.altitude ?? 100) / 1000;
  return {
    atm,
    camR,
    horizonZenith: Math.PI / 2 + Math.acos(Math.min(1, atm.bottomRadius / camR)),
    sunRadius: o.sunRadius ?? 0.0093,
    moonRadius: o.moonRadius ?? 0.0093,
    moonIlluminance: o.moonIlluminance ?? 0.03,
    moonTint: o.moonTint ?? [0.3, 0.45, 1.0],
    exposure: o.exposure ?? 1,
    adaptation: Math.max(0, Math.min(1, o.adaptation ?? 0.55)),
    ambient: o.ambient ?? 3.2,
    stars: o.stars ?? 1,
    minLightY: Math.sin(((o.minLightElevation ?? 8) * Math.PI) / 180),
  };
}

// --- the atmosphere ------------------------------------------------------------------------------

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const lum = (c: Readonly<Vec3>) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const PI = Math.PI;

/** Scattering and extinction at a height (km), written into `m` (rgb scat R, scat M, ext). */
interface Medium { sr: Float64Array; sm: number; ext: Float64Array }
const newMedium = (): Medium => ({ sr: new Float64Array(3), sm: 0, ext: new Float64Array(3) });
const v3 = () => new Float64Array(3);
function medium(a: SkyAtmosphere, hIn: number, m: Medium): void {
  const h = Math.max(0, hIn);
  const dr = Math.exp(-h / a.rayleighScaleHeight);
  const dm = Math.exp(-h / a.mieScaleHeight);
  const dozone = Math.max(0, 1 - Math.abs(h - a.ozoneCentre) / a.ozoneHalfWidth);
  for (let c = 0; c < 3; c++) {
    m.sr[c] = a.rayleighScattering[c] * dr;
    m.ext[c] = m.sr[c] + a.mieExtinction * dm + a.ozoneAbsorption[c] * dozone;
  }
  m.sm = a.mieScattering * dm;
}

/** Distance from radius r along cos-zenith mu to the sphere of radius R (the far side), or -1. */
function toSphere(r: number, mu: number, R: number): number {
  const d = r * r * (mu * mu - 1) + R * R;
  return d < 0 ? -1 : -r * mu + Math.sqrt(d);
}
/** Distance to the ground along (r, mu), or -1 when the ray misses it. */
function toGround(a: SkyAtmosphere, r: number, mu: number): number {
  if (mu >= 0) return -1;
  const d = r * r * (mu * mu - 1) + a.bottomRadius * a.bottomRadius;
  return d < 0 ? -1 : -r * mu - Math.sqrt(d);
}

// Transmittance table parameterisation (Bruneton 2017): x = distance to the top, remapped between
// its minimum and the horizon's; y = height, as the distance to the horizon.
export function transmittanceUv(a: SkyAtmosphere, r: number, mu: number): [number, number] {
  const Rg = a.bottomRadius, Rt = a.topRadius;
  const H = Math.sqrt(Rt * Rt - Rg * Rg);
  const rho = Math.sqrt(Math.max(0, r * r - Rg * Rg));
  const d = Math.max(0, toSphere(r, mu, Rt));
  const dmin = Rt - r, dmax = rho + H;
  return [(d - dmin) / Math.max(1e-9, dmax - dmin), rho / H];
}
function transmittanceParams(a: SkyAtmosphere, xmu: number, xr: number): [number, number] {
  const Rg = a.bottomRadius, Rt = a.topRadius;
  const H = Math.sqrt(Rt * Rt - Rg * Rg);
  const rho = H * xr;
  const r = Math.sqrt(rho * rho + Rg * Rg);
  const dmin = Rt - r, dmax = rho + H;
  const d = dmin + xmu * (dmax - dmin);
  const mu = d === 0 ? 1 : clamp((H * H - rho * rho - d * d) / (2 * r * d), -1, 1);
  return [r, mu];
}

/** Transmittance from (r, mu) to the top of the atmosphere, integrated in `steps` (no ground test). */
function transmittanceToTop(a: SkyAtmosphere, r: number, mu: number, steps: number, out: Float64Array, m: Medium): void {
  const t = Math.max(0, toSphere(r, mu, a.topRadius));
  const dt = t / steps;
  let o0 = 0, o1 = 0, o2 = 0;
  for (let i = 0; i < steps; i++) {
    const s = (i + 0.5) * dt;
    const h = Math.sqrt(r * r + s * s + 2 * r * mu * s) - a.bottomRadius;
    medium(a, h, m);
    o0 += m.ext[0] * dt; o1 += m.ext[1] * dt; o2 += m.ext[2] * dt;
  }
  out[0] = Math.exp(-o0); out[1] = Math.exp(-o1); out[2] = Math.exp(-o2);
}

/** A 2D RGB table, sampled bilinearly with texel centres at the unit coordinates' ends (like the GPU's). */
interface Table { w: number; h: number; data: Float32Array }
function sample(t: Table, x: number, y: number, out: Float64Array): void {
  const fx = clamp(x, 0, 1) * (t.w - 1), fy = clamp(y, 0, 1) * (t.h - 1);
  const x0 = Math.min(t.w - 2, Math.floor(fx)), y0 = Math.min(t.h - 2, Math.floor(fy));
  const ax = fx - x0, ay = fy - y0;
  const d = t.data, i00 = (y0 * t.w + x0) * 3, i10 = i00 + 3, i01 = i00 + t.w * 3, i11 = i01 + 3;
  for (let c = 0; c < 3; c++) {
    out[c] = (d[i00 + c] * (1 - ax) + d[i10 + c] * ax) * (1 - ay) + (d[i01 + c] * (1 - ax) + d[i11 + c] * ax) * ay;
  }
}

/** The CPU tables: transmittance and multiple scattering, as the GPU builds them (coarser). */
interface Tables { trans: Table; ms: Table }

const CPU_TRANS_W = 128, CPU_TRANS_H = 32, CPU_MS_N = 16, CPU_MS_DIRS = 8;

function buildTables(a: SkyAtmosphere): Tables {
  const m = newMedium();
  const tv = v3();
  const trans: Table = { w: CPU_TRANS_W, h: CPU_TRANS_H, data: new Float32Array(CPU_TRANS_W * CPU_TRANS_H * 3) };
  for (let y = 0; y < trans.h; y++)
    for (let x = 0; x < trans.w; x++) {
      const [r, mu] = transmittanceParams(a, x / (trans.w - 1), y / (trans.h - 1));
      transmittanceToTop(a, r, mu, 40, tv, m);
      trans.data.set(tv, (y * trans.w + x) * 3);
    }
  const tables: Tables = { trans, ms: { w: CPU_MS_N, h: CPU_MS_N, data: new Float32Array(CPU_MS_N * CPU_MS_N * 3) } };
  const out = v3();
  for (let y = 0; y < CPU_MS_N; y++)
    for (let x = 0; x < CPU_MS_N; x++) {
      multiScattering(a, tables, x / (CPU_MS_N - 1), y / (CPU_MS_N - 1), CPU_MS_DIRS, out);
      tables.ms.data.set(out, (y * CPU_MS_N + x) * 3);
    }
  return tables;
}

/** Transmittance to the top from (r, mu), from the table; 0 when the planet is in the way. */
function sunTransmittance(a: SkyAtmosphere, t: Tables, r: number, mu: number, out: Float64Array): void {
  const Rg = a.bottomRadius, Rt = a.topRadius;
  if (mu < 0 && r * r * (mu * mu - 1) + Rg * Rg >= 0) { out[0] = out[1] = out[2] = 0; return; }
  const H = Math.sqrt(Rt * Rt - Rg * Rg);
  const rho = Math.sqrt(Math.max(0, r * r - Rg * Rg));
  const dd = r * r * (mu * mu - 1) + Rt * Rt;
  const d = dd < 0 ? 0 : Math.max(0, -r * mu + Math.sqrt(dd));
  const dmin = Rt - r, dmax = rho + H;
  sample(t.trans, (d - dmin) / Math.max(1e-9, dmax - dmin), rho / H, out);
}

/**
 * One texel of the multiple-scattering table (Hillaire 2020, §5.5): from height `v` (0 ground, 1
 * top) with the sun at cos-zenith `u * 2 - 1`, the isotropic second-order in-scattering L2 and
 * the transfer f_ms over `n * n` directions, then Ψ = L2 / (1 - f_ms).
 */
function multiScattering(a: SkyAtmosphere, t: Tables, u: number, v: number, n: number, out: Float64Array): void {
  const r = a.bottomRadius + Math.max(0.01, v * (a.topRadius - a.bottomRadius));
  const muS = u * 2 - 1;
  const lx = Math.sqrt(Math.max(0, 1 - muS * muS)), ly = muS;
  const m = newMedium();
  const ts = v3(), L = v3(), F = v3();
  const iso = 1 / (4 * PI);
  const STEPS = 20;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const theta = (2 * PI * (i + 0.5)) / n;
      const phi = Math.acos(1 - (2 * (j + 0.5)) / n);
      const dx = Math.cos(theta) * Math.sin(phi), dy = Math.cos(phi), dz = Math.sin(theta) * Math.sin(phi);
      const tg = toGround(a, r, dy);
      const tMax = tg >= 0 ? tg : Math.max(0, toSphere(r, dy, a.topRadius));
      const dt = tMax / STEPS;
      let th0 = 1, th1 = 1, th2 = 1;
      for (let s = 0; s < STEPS; s++) {
        const tt = (s + 0.3) * dt;
        const px = dx * tt, py = r + dy * tt, pz = dz * tt;
        const pr = Math.sqrt(px * px + py * py + pz * pz);
        const mus = (px * lx + py * ly) / pr;
        medium(a, pr - a.bottomRadius, m);
        sunTransmittance(a, t, pr, mus, ts);
        const sm = m.sm, sr = m.sr, ex = m.ext;
        const e0 = Math.max(1e-9, ex[0]), e1 = Math.max(1e-9, ex[1]), e2 = Math.max(1e-9, ex[2]);
        const s0 = sr[0] + sm, s1 = sr[1] + sm, s2 = sr[2] + sm;
        const t0 = Math.exp(-e0 * dt), t1 = Math.exp(-e1 * dt), t2 = Math.exp(-e2 * dt);
        const w0 = th0 * s0 * (1 - t0) / e0, w1 = th1 * s1 * (1 - t1) / e1, w2 = th2 * s2 * (1 - t2) / e2;
        L[0] += w0 * ts[0] * iso; L[1] += w1 * ts[1] * iso; L[2] += w2 * ts[2] * iso;
        F[0] += w0; F[1] += w1; F[2] += w2;
        th0 *= t0; th1 *= t1; th2 *= t2;
      }
      if (tg >= 0) {
        // The ground's bounce (Lambertian).
        const px = dx * tg, py = r + dy * tg, pz = dz * tg;
        const pr = Math.sqrt(px * px + py * py + pz * pz);
        const mus = (px * lx + py * ly) / pr;
        sunTransmittance(a, t, pr, mus, ts);
        const ndl = Math.max(0, mus);
        L[0] += th0 * ts[0] * ndl * a.groundAlbedo[0] / PI;
        L[1] += th1 * ts[1] * ndl * a.groundAlbedo[1] / PI;
        L[2] += th2 * ts[2] * ndl * a.groundAlbedo[2] / PI;
      }
    }
  const k = 1 / (n * n);
  for (let c = 0; c < 3; c++) out[c] = (L[c] * k) / (1 - F[c] * k);
}

const HG = (g: number, c: number) => (1 - g * g) / (4 * PI * Math.pow(1 + g * g - 2 * g * c, 1.5));

/**
 * Sky radiance seen from the camera along a view direction, for a light of unit illuminance at
 * cos-zenith `muS` with the view at relative azimuth cos `cosPhi`: single scattering (Rayleigh and
 * Mie, planet shadow) plus the multiple-scattering table, `steps` samples distributed
 * quadratically (dense near the camera, where the air is). The GPU's sky-view table is the same
 * march.
 */
function skyRadiance(s: SkySettings, t: Tables, muV: number, cosPhi: number, muS: number, steps: number, out: Float64Array): void {
  const a = s.atm, r = s.camR;
  const sv = Math.sqrt(Math.max(0, 1 - muV * muV)), sPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
  const dx = sv * cosPhi, dy = muV, dz = sv * sPhi;
  const lx = Math.sqrt(Math.max(0, 1 - muS * muS)), ly = muS;
  const nu = dx * lx + dy * ly;
  const pR = (3 / (16 * PI)) * (1 + nu * nu), pM = HG(a.mieG, nu);
  const tg = toGround(a, r, muV);
  const tMax = tg >= 0 ? tg : Math.max(0, toSphere(r, muV, a.topRadius));
  const m = newMedium();
  const ts = v3(), ms = v3();
  let th0 = 1, th1 = 1, th2 = 1;
  out[0] = out[1] = out[2] = 0;
  let prev = 0;
  for (let i = 0; i < steps; i++) {
    const f1 = (i + 1) / steps, t1 = tMax * f1 * f1;
    const dt = t1 - prev, tt = prev + 0.3 * dt;
    prev = t1;
    const px = dx * tt, py = r + dy * tt, pz = dz * tt;
    const pr = Math.sqrt(px * px + py * py + pz * pz);
    const mus = (px * lx + py * ly) / pr;
    medium(a, pr - a.bottomRadius, m);
    sunTransmittance(a, t, pr, mus, ts);
    sample(t.ms, mus * 0.5 + 0.5, (pr - a.bottomRadius) / (a.topRadius - a.bottomRadius), ms);
    for (let c = 0; c < 3; c++) {
      const ex = Math.max(1e-9, m.ext[c]);
      const S = (m.sr[c] * pR + m.sm * pM) * ts[c] + (m.sr[c] + m.sm) * ms[c];
      const tr = Math.exp(-ex * dt);
      const th = c === 0 ? th0 : c === 1 ? th1 : th2;
      out[c] += th * (S - S * tr) / ex;
      if (c === 0) th0 *= tr; else if (c === 1) th1 *= tr; else th2 *= tr;
    }
  }
}

// --- what a light at a given elevation casts, cached per elevation -------------------------------

/** What a light of unit illuminance at one elevation gives the camera. */
interface LightEntry {
  /** Beam transmittance at the camera (0 below the horizon). */
  trans: Vec3;
  /** Sky irradiance on an upward face (cosine-weighted). */
  skyUp: Vec3;
  /** Sky radiance at the zenith. */
  zenith: Vec3;
  /** Sky radiance 2° above the horizon, averaged round the compass. */
  horizon: Vec3;
}

const BIN_MIN = (-20 * PI) / 180, BIN_MAX = PI / 2, BINS = 110;

// --- exposure and tone ---------------------------------------------------------------------------

/** The backdrop's soft shoulder: linear to 0.8, then easing towards 1 (also in the shader). */
export function skyTone(x: number): number {
  return x <= 0.8 ? x : 0.8 + 0.2 * (1 - Math.exp(-(x - 0.8) / 0.2));
}

/**
 * The renderer writes its values straight to the screen (no transfer function), so the backdrop
 * is display-encoded after the tone curve (gamma 2.2, as the shader does).
 */
export function skyDisplay(x: number): number {
  return Math.pow(Math.max(0, skyTone(x)), 1 / 2.2);
}

/**
 * A light colour for the renderer, whose shading runs on display values: keep the brightest
 * channel (the exposure's magnitude) and display-encode the hue, so a sunset beam of physical
 * (1, 0.3, 0.03) lights the scene the orange the backdrop's sun shows.
 */
export function encodeHue(v: Vec3): Vec3 {
  const mx = Math.max(v[0], v[1], v[2]);
  if (!(mx > 0)) return [0, 0, 0];
  return [mx * Math.pow(Math.max(0, v[0]) / mx, 1 / 2.2), mx * Math.pow(Math.max(0, v[1]) / mx, 1 / 2.2), mx * Math.pow(Math.max(0, v[2]) / mx, 1 / 2.2)];
}

/** Artistic constants, tuned against timeOfDay's ranges (see the frame table in verify-atmosphere). */
const TUNE = {
  /** Key light scale at noon. */
  light: 1.0,
  /** Backdrop scale at noon. */
  sky: 3.2,
  /** Share of the adaptation the backdrop gets. */
  skyAdapt: 0.7,
  /** How much less than the key light the ambient adapts (a fraction of the adaptation). */
  ambientAdapt: 0.3,
  /** The moon lights the sky this much less than it lights the ground. */
  moonSky: 0.08,
  /** Ground bounce relative to the sky's ambient. */
  ground: 0.35,
  /** Soft ceiling of the key light's brightest channel. */
  keyCap: 1.1,
  /** Sun disc brightness (linear, before the tone curve). */
  sunDisc: 1.6,
  /** Brightest the moon disc gets. */
  moonDiscMax: 1.6,
};

/** Everything a frame derives from the model, before weather. */
export interface SkyState {
  /** Unit sun and moon directions. */
  sunDir: Vec3;
  moonDir: Vec3;
  /** Illuminated fraction of the moon, 0 new .. 1 full. */
  moonPhase: number;
  /** Key light (renderer units), its direction, the ambients. */
  lightColor: Vec3;
  lightDir: Vec3;
  ambientSky: Vec3;
  ambientGround: Vec3;
  /** Scale from sky radiance to the backdrop's values (before the tone curve). */
  skyScale: number;
  /**
   * Scale from irradiance to the backdrop's values for the cloud layer: the key light's scale at
   * noon, adapting as the backdrop does, so clouds sit with lit ground by day and with the sky at night.
   */
  cloudScale: number;
  /** Sun and moon illuminance reaching the camera (unit sun, before exposure). */
  sunBeam: Vec3;
  moonBeam: Vec3;
  /** Sky irradiance upwards from both. */
  skyUp: Vec3;
  /** Backdrop zenith and horizon (after the tone curve), clear sky. */
  zenith: Vec3;
  horizon: Vec3;
  /** The same before the tone curve. */
  zenithLinear: Vec3;
  horizonLinear: Vec3;
  /** Sun and moon disc colours for the backdrop. */
  sunDisc: Vec3;
  moonDisc: Vec3;
  /** Scales of the sun's and moon's sky-view tables into the backdrop. */
  sunSky: Vec3;
  moonSky: Vec3;
  /** Airglow, backdrop units. */
  airglow: Vec3;
  /** Star brightness, backdrop units. */
  stars: number;
  /** 0 night .. 1 day, by the sun's elevation. */
  day: number;
  /** Global horizontal illuminance (luminance, unit sun) the exposure adapts to. */
  adaptLuminance: number;
}

// Faint light of the night sky itself (airglow and starlight), radiance per unit sun. Keeps a
// moonless night from being black and bounds the exposure.
const AIRGLOW: Vec3 = [0.1e-5, 0.15e-5, 0.3e-5];
// The moon's disc radiance per unit sun (the real ratio: 2.5e-6 / the disc's solid angle), so the
// disc is faint by day and bright at night, as the eye sees it.
const MOON_DISC = 0.04;
// Stars' brightness per unit exposure; tuned so a clear night's brightest stars are near white.
const STAR_K = 0.02;

/**
 * The physical sky's model without the GPU: what {@link makePhysicalSky} derives on the CPU each
 * frame (key light, ambient, fog colour, the backdrop's parameters), and the same sky radiance
 * the GPU tables hold, coarser. Use it to test lighting headlessly or to light a scene with the
 * physical sky's colours without drawing it; {@link makePhysicalSky} uses one inside.
 */
export interface SkyModel {
  /** The resolved settings. */
  readonly settings: SkySettings;
  /**
   * The sky's state for sun and moon directions: exposure, key light, ambient, the backdrop's
   * colours. Unit vectors, y up; `moonDir` defaults to opposite the sun.
   */
  state(sunDir: Readonly<Vec3>, moonDir?: Readonly<Vec3>): SkyState;
  /**
   * Sky radiance (unit sun illuminance, before exposure) along a view direction's cos-zenith
   * `muV` at relative azimuth cos `cosPhi` from a light at cos-zenith `muS`.
   */
  radiance(muV: number, cosPhi: number, muS: number): Vec3;
  /** Transmittance from the camera towards cos-zenith `mu` (0 below the horizon). */
  transmittance(mu: number): Vec3;
}

const norm = (v: Readonly<Vec3>): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/**
 * Make the physical sky's CPU model (headless; no GPU). {@link makePhysicalSky} makes one itself;
 * this is for tests and for hosts that want its light without its backdrop.
 *
 * @param opts - The same options {@link makePhysicalSky} takes.
 * @returns The model. Its tables build on first use (a few milliseconds).
 */
export function makeSkyModel(opts: PhysicalSkyOptions = {}): SkyModel {
  const s = resolveSkyOptions(opts);
  const a = s.atm;
  let tables: Tables | null = null;
  const tab = () => (tables ??= buildTables(a));
  const bins: (LightEntry | undefined)[] = new Array(BINS + 1);

  const entryAt = (i: number): LightEntry => {
    let e = bins[i];
    if (e) return e;
    const t = tab();
    const elev = BIN_MIN + ((BIN_MAX - BIN_MIN) * i) / BINS;
    const muS = Math.sin(elev);
    const tr = v3();
    sunTransmittance(a, t, s.camR, muS, tr);
    // Cosine-weighted hemisphere: mu = sqrt(u), 8 rings by 8 azimuths over half the compass
    // (the sky is symmetric about the light's vertical plane).
    const up = v3(), l = v3(), zen = v3(), hor = v3();
    const NR = 8, NA = 8;
    for (let ri = 0; ri < NR; ri++) {
      const muV = Math.sqrt((ri + 0.5) / NR);
      for (let ai = 0; ai < NA; ai++) {
        skyRadiance(s, t, muV, Math.cos((PI * (ai + 0.5)) / NA), muS, 16, l);
        up[0] += l[0]; up[1] += l[1]; up[2] += l[2];
      }
    }
    const skyUp: Vec3 = [up[0] * PI / (NR * NA), up[1] * PI / (NR * NA), up[2] * PI / (NR * NA)];
    skyRadiance(s, t, 1, 1, muS, 30, zen);
    const muH = Math.sin((2 * PI) / 180);
    for (let ai = 0; ai < NA; ai++) {
      skyRadiance(s, t, muH, Math.cos((PI * (ai + 0.5)) / NA), muS, 30, l);
      hor[0] += l[0] / NA; hor[1] += l[1] / NA; hor[2] += l[2] / NA;
    }
    const trans: Vec3 = [tr[0], tr[1], tr[2]], zenith: Vec3 = [zen[0], zen[1], zen[2]], horizon: Vec3 = [hor[0], hor[1], hor[2]];
    e = { trans, skyUp, zenith, horizon };
    bins[i] = e;
    return e;
  };

  /** A light's entry at cos-zenith muS, interpolated between elevation bins (continuous). */
  const lightAt = (muS: number): LightEntry => {
    const elev = Math.asin(clamp(muS, -1, 1));
    const f = clamp((elev - BIN_MIN) / (BIN_MAX - BIN_MIN), 0, 1) * BINS;
    const i = Math.min(BINS - 1, Math.floor(f)), k = f - i;
    const e0 = entryAt(i), e1 = entryAt(i + 1);
    const mix = (p: Vec3, q: Vec3): Vec3 => [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k, p[2] + (q[2] - p[2]) * k];
    // Below the table the sky has no light left.
    const fade = elev < BIN_MIN ? 0 : 1;
    const e = { trans: mix(e0.trans, e1.trans), skyUp: mix(e0.skyUp, e1.skyUp), zenith: mix(e0.zenith, e1.zenith), horizon: mix(e0.horizon, e1.horizon) };
    if (fade === 0) for (const v of [e.trans, e.skyUp, e.zenith, e.horizon]) v.fill(0);
    return e;
  };

  // Exposure. The eye adapts to the light around it: the scene's scale follows the illuminance Y
  // the camera's surroundings receive (the beam on faces of every orientation, plus the sky) as
  // (Y / Y_noon)^-adaptation, pinned so that a noon sun 56° up gives a key light of about 1, as
  // timeOfDay's does. The backdrop adapts less (TUNE.skyAdapt), so the night sky stays darker
  // than what it lights, and sky light less again (TUNE.ambientAdapt), so point lights carry a
  // night scene.
  const surround = (beam: Readonly<Vec3>, mu: number) => lum(beam) * (0.4 + 0.6 * Math.max(0, mu));
  const muNoon = Math.sin((56 * PI) / 180), noon = lightAt(muNoon);
  const yNoon = surround(noon.trans, muNoon) + lum(noon.skyUp);
  const adapt = (y: number, k: number) => Math.pow(Math.max(y, 1e-9) / yNoon, -k) / yNoon;
  const lightNoon = s.exposure * TUNE.light / yNoon, skyNoon = s.exposure * TUNE.sky / yNoon;

  const state = (sunIn: Readonly<Vec3>, moonIn?: Readonly<Vec3>): SkyState => {
    const sunDir = norm(sunIn);
    const moonDir = moonIn ? norm(moonIn) : ([-sunDir[0], -sunDir[1], -sunDir[2]] as Vec3);
    const cosEl = sunDir[0] * moonDir[0] + sunDir[1] * moonDir[1] + sunDir[2] * moonDir[2];
    const moonPhase = clamp((1 - cosEl) / 2, 0, 1);
    const sun = lightAt(sunDir[1]), moon = lightAt(moonDir[1]);
    // The disc's share above the horizon, so the key light fades in and out with it.
    const dip = s.horizonZenith - PI / 2;
    // (Eased over a few radii above it too, so a fast-animated sunset does not snap the light off.)
    const sunUp = smooth(-s.sunRadius, 4 * s.sunRadius, Math.asin(clamp(sunDir[1], -1, 1)) + dip);
    const moonUp = smooth(-s.moonRadius, 4 * s.moonRadius, Math.asin(clamp(moonDir[1], -1, 1)) + dip);
    const mI = s.moonIlluminance * moonPhase;
    const tint = s.moonTint;
    const sunBeam: Vec3 = [sun.trans[0] * sunUp, sun.trans[1] * sunUp, sun.trans[2] * sunUp];
    const moonBeam: Vec3 = [0, 1, 2].map((c) => moon.trans[c] * moonUp * mI * tint[c]) as Vec3;
    const moonSkyK = mI * TUNE.moonSky;
    const skyUp: Vec3 = [0, 1, 2].map((c) => sun.skyUp[c] + moon.skyUp[c] * mI * tint[c] + AIRGLOW[c] * PI) as Vec3;
    const y = surround(sunBeam, sunDir[1]) + surround(moonBeam, moonDir[1]) + lum(skyUp);
    const L = s.exposure * TUNE.light * adapt(y, s.adaptation);
    const K = s.exposure * TUNE.sky * adapt(y, s.adaptation * TUNE.skyAdapt);
    const A = L * s.ambient * Math.pow(Math.max(y, 1e-9) / yNoon, TUNE.ambientAdapt * s.adaptation);

    // Key light: the brighter of the two, less the other, so it passes through zero where they
    // cross and the change of direction never shows.
    const ls = lum(sunBeam), lm = lum(moonBeam);
    const sunKey = ls >= lm;
    const keep = sunKey ? 1 - lm / Math.max(ls, 1e-12) : 1 - ls / Math.max(lm, 1e-12);
    const beam = sunKey ? sunBeam : moonBeam;
    // A soft ceiling on the brightest channel (about 1.1): the renderer's output clips, and an
    // adapted eye still sees a low sun's light as bright, not blinding.
    const raw: Vec3 = [beam[0] * L * keep, beam[1] * L * keep, beam[2] * L * keep];
    const peak = Math.max(raw[0], raw[1], raw[2]);
    const cap = peak > 0 ? 1 / Math.pow(1 + Math.pow(peak / TUNE.keyCap, 4), 0.25) : 1;
    const lightColor = encodeHue([raw[0] * cap, raw[1] * cap, raw[2] * cap]);
    const kd = sunKey ? sunDir : moonDir;
    // Ease the key up to the minimum elevation (a polynomial smooth max, so it never kinks).
    const m0 = s.minLightY, soft = 0.1;
    const gap = Math.max(0, soft - Math.abs(kd[1] - m0));
    const lightDir = norm([kd[0], Math.max(kd[1], m0) + (gap * gap) / (4 * soft), kd[2]]);

    const g = a.groundAlbedo;
    const ambientSky = encodeHue([0, 1, 2].map((c) => skyUp[c] * A) as Vec3);
    const ambientGround = encodeHue([0, 1, 2].map((c) => (sunBeam[c] * Math.max(0, sunDir[1]) + moonBeam[c] * Math.max(0, moonDir[1]) + skyUp[c]) * g[c] * A * TUNE.ground) as Vec3);

    const sunSky: Vec3 = [PI * K, PI * K, PI * K];
    const moonSky: Vec3 = [0, 1, 2].map((c) => PI * K * moonSkyK * tint[c]) as Vec3;
    const airglow: Vec3 = [0, 1, 2].map((c) => PI * K * AIRGLOW[c]) as Vec3;
    const lin = (e1: Vec3, e2: Vec3): Vec3 => [0, 1, 2].map((c) => e1[c] * sunSky[c] + e2[c] * moonSky[c] + airglow[c]) as Vec3;
    const zenithLinear = lin(sun.zenith, moon.zenith), horizonLinear = lin(sun.horizon, moon.horizon);

    // Disc colours: the beam's hue (display encoding softens a sunset's red to orange) at a fixed
    // brightness the tone curve rolls off; the moon's is its real radiance, exposed.
    const hue = (t: Vec3): Vec3 => {
      const mx = Math.max(t[0], t[1], t[2], 1e-9);
      return [t[0] / mx, t[1] / mx, t[2] / mx];
    };
    const sh = hue(sun.trans), mh = hue(moon.trans);
    const sunDisc: Vec3 = [sh[0] * TUNE.sunDisc, sh[1] * TUNE.sunDisc, sh[2] * TUNE.sunDisc];
    const mk = Math.min(TUNE.moonDiscMax, PI * K * MOON_DISC) * smooth(0, 0.1, lum(moon.trans));
    const moonDisc: Vec3 = [mh[0] * mk * 0.92, mh[1] * mk * 0.95, mh[2] * mk];
    const stars = s.stars * Math.min(1, PI * K * STAR_K);
    return {
      sunDir, moonDir, moonPhase, lightColor, lightDir, ambientSky, ambientGround, skyScale: K, cloudScale: (K * lightNoon) / skyNoon,
      sunBeam, moonBeam, skyUp,
      zenith: zenithLinear.map(skyDisplay) as Vec3, horizon: horizonLinear.map(skyDisplay) as Vec3, zenithLinear, horizonLinear,
      sunDisc, moonDisc, sunSky, moonSky, airglow, stars,
      day: smooth(-0.1, 0.15, sunDir[1]), adaptLuminance: y,
    };
  };

  return {
    settings: s,
    state,
    radiance(muV, cosPhi, muS) {
      const out = v3();
      skyRadiance(s, tab(), muV, cosPhi, muS, 30, out);
      return [out[0], out[1], out[2]];
    },
    transmittance(mu) {
      const out = v3();
      sunTransmittance(a, tab(), s.camR, mu, out);
      return [out[0], out[1], out[2]];
    },
  };
}

// --- the backdrop's parameters --------------------------------------------------------------------

/** Cloud layer inputs for {@link packPhysicalSky}. */
export interface SkyClouds {
  cover: number;
  /** Rain darkens the clouds, 0 .. 1. */
  gloom: number;
  drift: [number, number];
}

/**
 * Pack the backdrop's parameters (`FrameParams.background` for the physical sky's module).
 * Layout, vec4 by vec4: [0] sunDir, sun radius; [1] moonDir, moon radius; [2] sun sky-view scale,
 * cloud cover; [3] moon sky-view scale, star brightness; [4] sun disc colour, horizon zenith
 * angle; [5] moon disc colour, 0; [6] cloud colour lit by the sun, drift x; [7] cloud colour lit
 * by the moon, drift y; [8] cloud ambient colour, 0; [9] the direction the sun's sky-view table
 * was built for, 0; [10] the moon's, 0; [11] airglow, 0.
 */
export function packPhysicalSky(st: SkyState, s: SkySettings, clouds: SkyClouds, lutSun: Readonly<Vec3>, lutMoon: Readonly<Vec3>, out: Float32Array = new Float32Array(BACKGROUND_FLOATS)): Float32Array {
  out.fill(0);
  const w = (o: number, v: Readonly<Vec3>, x: number) => { out[o * 4] = v[0]; out[o * 4 + 1] = v[1]; out[o * 4 + 2] = v[2]; out[o * 4 + 3] = x; };
  const cover = clamp(clouds.cover, 0, 1);
  // Clouds as a white layer seen from below: what reaches its top (both beams, the sky) diffused
  // through it, less as it thickens, plus some of the sun's beam straight through thin cloud;
  // rain darkens it.
  const C = st.cloudScale, dim = 1 - 0.45 * clouds.gloom;
  const through = 0.6 * Math.pow(1 - cover, 1.5) * dim;
  const cs: Vec3 = [0, 1, 2].map((c) => C * st.sunBeam[c] * Math.max(0, st.sunDir[1] + 0.1) * through) as Vec3;
  const cm: Vec3 = [0, 1, 2].map((c) => C * st.moonBeam[c] * Math.max(0, st.moonDir[1] + 0.1) * through) as Vec3;
  const ca: Vec3 = [0, 1, 2].map((c) => {
    const top = st.sunBeam[c] * Math.max(0, st.sunDir[1]) + st.moonBeam[c] * Math.max(0, st.moonDir[1]) + st.skyUp[c];
    return C * 0.9 * top * (0.8 - 0.4 * cover) * dim + st.airglow[c];
  }) as Vec3;
  w(0, st.sunDir, s.sunRadius);
  w(1, st.moonDir, s.moonRadius);
  w(2, st.sunSky, cover);
  w(3, st.moonSky, st.stars);
  w(4, st.sunDisc, s.horizonZenith);
  w(5, st.moonDisc, 0);
  w(6, cs, clouds.drift[0]);
  w(7, cm, clouds.drift[1]);
  w(8, ca, 0);
  w(9, lutSun, 0);
  w(10, lutMoon, 0);
  w(11, st.airglow, 0);
  return out;
}

/** The linear colour of the cloud layer's underside towards the horizon (for fog), as packed. */
export function cloudHorizon(bg: Float32Array): Vec3 {
  return [bg[32] + 0.25 * (bg[24] + bg[28]), bg[33] + 0.25 * (bg[25] + bg[29]), bg[34] + 0.25 * (bg[26] + bg[30])];
}

/** The sun and moon directions a frame reads from a {@link Lighting}. */
export type SkyLighting = Pick<Lighting, "sunDir" | "moonDir">;
