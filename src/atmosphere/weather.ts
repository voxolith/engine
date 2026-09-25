// Weather as configuration: a vocabulary, presets, blending, and the
// translation into the renderer's raw atmosphere settings.
//
// Nothing here decides *when* it rains. A game that wants weather keeps an
// Atmosphere (from a preset, a script, a season, a forecast), changes it when
// its own rules say so — optionally through a transition — and hands it to
// `atmosphereFrame` each frame with the time-of-day lighting. A game without
// weather never imports this.
//
// `wetness` and `cover` are the ground's state rather than the sky's: how wet
// it is and how much snow has settled. They build up and fade over time by
// the game's rules; `approach` is a small helper for that. Presets leave them
// at 0, so a game sets them from its own accumulators.

import type { AtmosphereParams } from "@voxolith/renderer/core";
import type { Lighting } from "./timeofday";

type Vec3 = [number, number, number];

export type PrecipitationKind = "none" | "rain" | "snow";

export interface Atmosphere {
  /** 0 clear .. 1 overcast. */
  cloud: number;
  precipitation: { kind: PrecipitationKind; intensity: number };
  /** Direction the wind blows towards, degrees (0 = +Z, 90 = +X); strength 0..1. */
  wind: { direction: number; strength: number };
  /** 0 .. 1: mist on top of whatever the precipitation brings. */
  fog: number;
  /** 0 .. 1: how wet the ground is. */
  wetness: number;
  /** 0 .. 1: how much snow has settled. */
  cover: number;
}

const base = (o: Partial<Atmosphere>): Atmosphere => ({
  cloud: 0,
  precipitation: { kind: "none", intensity: 0 },
  wind: { direction: 60, strength: 0.15 },
  fog: 0,
  wetness: 0,
  cover: 0,
  ...o,
});

export const ATMOSPHERES = {
  clear: base({}),
  cloudy: base({ cloud: 0.45, wind: { direction: 60, strength: 0.3 } }),
  overcast: base({ cloud: 0.85, wind: { direction: 60, strength: 0.3 }, fog: 0.05 }),
  rain: base({ cloud: 0.9, precipitation: { kind: "rain", intensity: 0.6 }, wind: { direction: 75, strength: 0.35 }, fog: 0.12 }),
  storm: base({ cloud: 1, precipitation: { kind: "rain", intensity: 1 }, wind: { direction: 95, strength: 0.85 }, fog: 0.2 }),
  snow: base({ cloud: 0.8, precipitation: { kind: "snow", intensity: 0.6 }, wind: { direction: 40, strength: 0.2 }, fog: 0.12 }),
  blizzard: base({ cloud: 1, precipitation: { kind: "snow", intensity: 1 }, wind: { direction: 110, strength: 0.9 }, fog: 0.45 }),
  fog: base({ cloud: 0.5, fog: 0.8, wind: { direction: 60, strength: 0.05 } }),
} satisfies Record<string, Atmosphere>;

export type AtmosphereName = keyof typeof ATMOSPHERES;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix3 = (a: Vec3, b: Vec3, t: number): Vec3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const lum = (c: Vec3) => c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;

/** Blend two atmospheres. A change of precipitation kind fades one out before the other fades in. */
export function blendAtmosphere(a: Atmosphere, b: Atmosphere, t: number): Atmosphere {
  const k = clamp01(t);
  if (k <= 0) return structuredClone(a);
  if (k >= 1) return structuredClone(b);
  const pa = a.precipitation, pb = b.precipitation;
  let precipitation: Atmosphere["precipitation"];
  if (pa.kind === pb.kind || pb.kind === "none") precipitation = { kind: pa.kind, intensity: lerp(pa.intensity, pb.kind === "none" ? 0 : pb.intensity, k) };
  else if (pa.kind === "none") precipitation = { kind: pb.kind, intensity: lerp(0, pb.intensity, k) };
  else precipitation = k < 0.5 ? { kind: pa.kind, intensity: pa.intensity * (1 - 2 * k) } : { kind: pb.kind, intensity: pb.intensity * (2 * k - 1) };
  // Wind turns the short way round.
  const dd = ((((b.wind.direction - a.wind.direction) % 360) + 540) % 360) - 180;
  return {
    cloud: lerp(a.cloud, b.cloud, k),
    precipitation,
    wind: { direction: a.wind.direction + dd * k, strength: lerp(a.wind.strength, b.wind.strength, k) },
    fog: lerp(a.fog, b.fog, k),
    wetness: lerp(a.wetness, b.wetness, k),
    cover: lerp(a.cover, b.cover, k),
  };
}

export interface AtmosphereTransition {
  /** Move to `target` over `seconds` (eased), starting from wherever it is now. */
  set(target: Atmosphere, seconds?: number): void;
  update(dt: number): Atmosphere;
  current(): Atmosphere;
  changing(): boolean;
}

export function makeAtmosphereTransition(start: Atmosphere = ATMOSPHERES.clear): AtmosphereTransition {
  let from = start, to = start, t = 1, dur = 1;
  const ease = (x: number) => x * x * (3 - 2 * x);
  const current = () => (t >= 1 ? to : blendAtmosphere(from, to, ease(t)));
  return {
    set(target, seconds = 4) {
      from = current();
      to = target;
      dur = Math.max(1e-3, seconds);
      t = seconds <= 0 ? 1 : 0;
    },
    update(dt) {
      if (t < 1) t = Math.min(1, t + dt / dur);
      return current();
    },
    current,
    changing: () => t < 1,
  };
}

/** Move `value` towards `target` by at most `rate * dt`, never past it. For accumulating state. */
export function approach(value: number, target: number, rate: number, dt: number): number {
  const step = Math.max(0, rate) * Math.max(0, dt);
  return value < target ? Math.min(target, value + step) : Math.max(target, value - step);
}

export interface AtmosphereFrameOptions {
  /** Snow colour on the ground. */
  coverColor?: Vec3;
  /** Rain fall speed, voxels per second. Default 70. */
  rainSpeed?: number;
  /** Snow fall speed. Default 8. */
  snowSpeed?: number;
  /**
   * The world's scale (default 10, the scale everything above is tuned for).
   * A finer world gets the same weather in metres: fog per voxel thins,
   * rain and snow fall more voxels per second, and the renderer's
   * `effectScale` keeps waves and drops their size.
   */
  voxelsPerMetre?: number;
}

/**
 * Lighting and the renderer's atmosphere settings for one frame: overcast
 * dims and flattens the key light and greys the sky (keeping the night dark),
 * fog takes the horizon's colour, wind tilts the rain and snow and drives the
 * clouds and the water. With a clear atmosphere the lighting passes through
 * unchanged.
 */
export function atmosphereFrame(lighting: Lighting, atm: Atmosphere, opts: AtmosphereFrameOptions = {}): Lighting & AtmosphereParams {
  const day = clamp01(lighting.sunIntensity);
  const cloud = clamp01(atm.cloud);
  const precip = atm.precipitation.kind === "none" ? 0 : clamp01(atm.precipitation.intensity);
  const heavy = Math.max(cloud, precip);
  const gloom = 1 - 0.45 * precip; // rain clouds are darker than white ones

  // Cloud colour: bright grey by day, near-black by night.
  const cloudDay: Vec3 = scale([0.8, 0.82, 0.86], gloom);
  const cloudNight: Vec3 = [0.05, 0.06, 0.09];
  const cloudColor = mix3(cloudNight, cloudDay, day);

  // Light: cloud blocks the direct key light and turns it into sky light.
  const keep = 1 - 0.78 * cloud * (0.6 + 0.4 * heavy);
  const lightColor = scale(lighting.lightColor, keep);
  const flat = mix3(lighting.ambientSky, scale([1, 1, 1], lum(lighting.ambientSky)), 0.7);
  const ambientSky = mix3(lighting.ambientSky, scale(flat, 1 + 0.25 * day), cloud * 0.6);
  const ambientGround = mix3(lighting.ambientGround, scale([1, 1, 1], lum(lighting.ambientGround)), cloud * 0.5);
  const skyTop = mix3(lighting.skyTop, scale(cloudColor, 0.9), cloud * 0.8);
  const skyHorizon = mix3(lighting.skyHorizon, cloudColor, cloud * 0.75);

  // Wind: a horizontal unit vector the weather blows towards.
  const w = (atm.wind.direction * Math.PI) / 180;
  const wx = Math.sin(w), wz = Math.cos(w);
  const ws = clamp01(atm.wind.strength);

  const es = (opts.voxelsPerMetre ?? 10) / 10;
  const out: Lighting & AtmosphereParams = {
    ...lighting,
    ...(es !== 1 ? { effectScale: es } : {}),
    lightColor,
    ambientSky,
    ambientGround,
    skyTop,
    skyHorizon,
    sunIntensity: lighting.sunIntensity * (1 - 0.7 * cloud),
    moonIntensity: lighting.moonIntensity * (1 - 0.8 * cloud),
    waterWind: [wx * ws * 1.5, wz * ws * 1.5],
  };
  if (cloud > 0) out.clouds = { cover: cloud, color: cloudColor, drift: [wx * (0.3 + ws * 2), wz * (0.3 + ws * 2)] };

  const fogAmount = clamp01(atm.fog) + precip * (atm.precipitation.kind === "snow" ? 0.35 : 0.2);
  if (fogAmount > 0) {
    out.fog = {
      density: (0.0012 + fogAmount * fogAmount * 0.018) / es,
      color: mix3(skyHorizon, cloudColor, 0.4),
      heightFalloff: (0.004 + (1 - clamp01(atm.fog)) * 0.008) / es,
    };
  }

  if (precip > 0) {
    const snow = atm.precipitation.kind === "snow";
    const speed = (snow ? (opts.snowSpeed ?? 8) : (opts.rainSpeed ?? 70)) * es;
    const side = ws * (snow ? 10 : 28) * es;
    // Particles are lit like the scene: mostly ambient, some key light.
    const lit = mix3(ambientSky, lightColor, 0.35);
    out.precipitation = {
      kind: snow ? "snow" : "rain",
      density: precip,
      fall: [wx * side, -speed, wz * side],
      color: snow ? scale([1, 1, 1], Math.min(1, 0.45 + lum(lit) * 1.1)) : scale([0.82, 0.86, 0.92], Math.min(1.1, 0.35 + lum(lit) * 1.2)),
    };
  }

  if (atm.wetness > 0 || atm.cover > 0) {
    out.surface = { wet: clamp01(atm.wetness), cover: clamp01(atm.cover), coverColor: opts.coverColor ?? [0.93, 0.95, 0.98] };
  }
  return out;
}
