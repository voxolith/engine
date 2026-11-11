// The classic sky: the stylised background every Voxolith scene had before backgrounds became
// pluggable (a vertical gradient, blocky night stars, blocky sun and moon discs with glows, a
// drifting fbm cloud layer). The renderer no longer draws a sky of its own; a host that wants
// this look passes `classicSky` to `createRenderer({ background })` and packs each frame's sky
// with `classicSkyParams` (which `atmosphereFrame` does). Headless: nothing here touches the GPU.

import { BACKGROUND_FLOATS, type BackgroundOptions } from "@voxolith/renderer/core";

type Vec3 = [number, number, number];

/**
 * The WESL source of the classic sky, a background module for `RendererOptions.background`
 * (`fn background(rd, footprint)`, reading `BG.params` and `BG.time`). It reads the parameters
 * {@link classicSkyParams} packs: `params[0]` sunDir and sunIntensity, `[1]` moonDir and
 * moonIntensity, `[2]` sunColor and nightFactor, `[3]` moonColor and cloud cover, `[4]` skyTop,
 * `[5]` skyHorizon, `[6]` cloud colour, `[7].xy` cloud drift. Most hosts use {@link classicSky}.
 */
export const CLASSIC_SKY_WESL = /* wgsl */ `
// Sky background: a vertical gradient with blocky night stars and world-positioned
// sun/moon discs. Parameters (classicSkyParams): params[0] sunDir, sunIntensity;
// [1] moonDir, moonIntensity; [2] sunColor, nightFactor; [3] moonColor, cloudCover;
// [4] skyTop; [5] skyHorizon; [6] cloudColor; [7].xy cloudDrift.

import package::bg::BG;

// A blocky (voxel-style) celestial disc in 3D: project the ray into a tangent
// basis around \`dir\`, quantise the local UV into cells, then radius-test → square
// edges. Being world-positioned, it's seen through the window from any angle.
fn celestialDisc(rd : vec3<f32>, dir : vec3<f32>, radius : f32, cells : f32) -> f32 {
  let d = normalize(dir);
  if (dot(rd, d) < 0.8) { return 0.0; }
  var up = vec3<f32>(0.0, 1.0, 0.0);
  if (abs(d.y) > 0.95) { up = vec3<f32>(1.0, 0.0, 0.0); }
  let t1 = normalize(cross(up, d));
  let t2 = cross(d, t1);
  let cell = radius / cells;
  let qu = (floor(dot(rd, t1) / cell) + 0.5) * cell;
  let qv = (floor(dot(rd, t2) / cell) + 0.5) * cell;
  return select(0.0, 1.0, qu * qu + qv * qv < radius * radius);
}

fn hash2(p : vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

fn valueNoise2(p : vec2<f32>) -> f32 {
  let i = floor(p);
  let f = p - i;
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash2(i);
  let b = hash2(i + vec2<f32>(1.0, 0.0));
  let c = hash2(i + vec2<f32>(0.0, 1.0));
  let d = hash2(i + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Cloud density along a sky direction: fbm on a plane above the world,
// drifting with the wind. 0 clear sky .. 1 solid cloud.
fn cloudAmount(rd : vec3<f32>) -> f32 {
  let cloudCover = BG.params[3].w;
  if (cloudCover <= 0.001) { return 0.0; }
  let h = max(rd.y, 0.04);
  var p = rd.xz / h * 1.6 + BG.params[7].xy * BG.time * 0.02;
  var n = 0.0;
  var amp = 0.55;
  for (var i = 0; i < 4; i = i + 1) {
    n += valueNoise2(p) * amp;
    p = p * 2.03 + vec2<f32>(17.1, 9.3);
    amp *= 0.5;
  }
  // Cover moves the threshold: at 1 the whole sky is cloud.
  let edge = 1.0 - cloudCover;
  let c = smoothstep(edge * 0.9 - 0.05, edge * 0.9 + 0.25, n) ;
  return max(c, smoothstep(0.75, 1.0, cloudCover));
}

fn background(rd : vec3<f32>, footprint : f32) -> vec3<f32> {
  let sunDir = BG.params[0].xyz;
  let sunIntensity = BG.params[0].w;
  let moonDir = BG.params[1].xyz;
  let moonIntensity = BG.params[1].w;
  let sunColor = BG.params[2].xyz;
  let nightFactor = BG.params[2].w;
  let moonColor = BG.params[3].xyz;
  let cloudCover = BG.params[3].w;
  let skyTop = BG.params[4].xyz;
  let skyHorizon = BG.params[5].xyz;
  let cloudColor = BG.params[6].xyz;

  let t = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  var col = mix(skyHorizon, skyTop, smoothstep(0.0, 0.6, t));
  let cloud = cloudAmount(rd);
  // Cloud hides the stars and the discs; overcast also dims their glow.
  let clear = 1.0 - max(cloud, cloudCover * 0.85);

  // Blocky stars at night (quantise the direction into cells, sparse hash).
  if (nightFactor > 0.05) {
    let q = floor(rd * 60.0);
    let h = fract(sin(dot(q, vec3<f32>(127.1, 311.7, 74.7))) * 43758.5453);
    let star = select(0.0, 1.0, h > 0.992);
    col += vec3<f32>(0.9, 0.92, 1.0) * star * nightFactor * clear;
  }

  // Sun: glow + blocky disc (world-positioned, seen through the window).
  if (sunIntensity > 0.01) {
    col += sunColor * pow(max(dot(rd, normalize(sunDir)), 0.0), 40.0) * sunIntensity * 0.5 * (0.35 + 0.65 * clear);
    col = mix(col, sunColor, celestialDisc(rd, sunDir, 0.1, 4.0) * sunIntensity * clear);
  }
  // Moon.
  if (moonIntensity > 0.01) {
    col += moonColor * pow(max(dot(rd, normalize(moonDir)), 0.0), 60.0) * moonIntensity * 0.3 * clear;
    col = mix(col, moonColor, celestialDisc(rd, moonDir, 0.08, 4.0) * moonIntensity * clear);
  }

  // Clouds over everything, lit a little from the sun side.
  if (cloud > 0.0) {
    let lit = 0.85 + 0.25 * max(dot(rd, normalize(sunDir)), 0.0) * sunIntensity;
    col = mix(col, cloudColor * lit, cloud * smoothstep(-0.02, 0.12, rd.y));
  }
  return col;
}
`;

/**
 * The classic sky, ready for `createRenderer(gpu, scene, { background: classicSky })`: the
 * stylised look Voxolith scenes had before backgrounds became pluggable, with a vertical gradient,
 * blocky night stars, blocky world-positioned sun and moon discs with glows, and a drifting cloud
 * layer. Games that want the blocky look (catagochi, voxrun) keep it. Feed it every frame through
 * `FrameParams.background`, which {@link atmosphereFrame} fills (already packed) and
 * {@link classicSkyParams} packs by hand; without parameters it draws black.
 */
export const classicSky: BackgroundOptions = { source: CLASSIC_SKY_WESL };

/** The classic sky's cloud layer (see {@link ClassicSkyFrame.clouds}). */
export interface ClassicSkyClouds {
  /** 0 clear .. 1 fully overcast. */
  cover: number;
  /** Linear RGB of the clouds, already lit for the time of day. */
  color: Vec3;
  /** Drift of the cloud layer, sky units per second on x and z (moved by `FrameParams.time`). */
  drift: [number, number];
}

/**
 * What {@link classicSkyParams} reads. A {@link Lighting} (from {@link timeOfDay}) is one, so
 * `classicSkyParams(timeOfDay(phase))` is a cloudless sky for that time of day.
 */
export interface ClassicSkyFrame {
  /** Where the sun disc is drawn. */
  sunDir: Vec3;
  /** Where the moon disc is drawn. It lights nothing; the key light does. */
  moonDir: Vec3;
  /** Colour of the sun disc and its glow. */
  sunColor: Vec3;
  /** Colour of the moon disc. */
  moonColor: Vec3;
  /** Sky colour at the zenith. */
  skyTop: Vec3;
  /** Sky colour at the horizon. */
  skyHorizon: Vec3;
  /** 0 day .. 1 night: blends in the stars. */
  nightFactor: number;
  /** Sun disc brightness; 0 hides it. */
  sunIntensity: number;
  /** Moon disc brightness; 0 hides it. */
  moonIntensity: number;
  /** The cloud layer; off when absent. */
  clouds?: ClassicSkyClouds;
}

/**
 * Pack a frame's sky into the parameters {@link CLASSIC_SKY_WESL} reads, for
 * `FrameParams.background`. Writes into `out` when given (at least `BACKGROUND_FLOATS`, 64,
 * long), so a per-frame caller allocates nothing.
 *
 * @param frame - The sky to draw, usually a {@link Lighting}. {@link atmosphereFrame} calls this
 *   itself and returns the result as `background`.
 * @param out - Where to write; a new 64-float array by default.
 * @returns `out`, filled.
 * @example
 * ```ts
 * const bg = new Float32Array(64);
 * const light = timeOfDay(0.42);
 * renderer.render({ ...camera, ...light, background: classicSkyParams(light, bg) });
 * ```
 */
export function classicSkyParams(frame: ClassicSkyFrame, out: Float32Array = new Float32Array(BACKGROUND_FLOATS)): Float32Array {
  const w = (o: number, v: Vec3, s: number) => { out[o] = v[0]; out[o + 1] = v[1]; out[o + 2] = v[2]; out[o + 3] = s; };
  const cl = frame.clouds;
  w(0, frame.sunDir, frame.sunIntensity);
  w(4, frame.moonDir, frame.moonIntensity);
  w(8, frame.sunColor, frame.nightFactor);
  w(12, frame.moonColor, cl ? Math.max(0, Math.min(1, cl.cover)) : 0);
  w(16, frame.skyTop, 0);
  w(20, frame.skyHorizon, 0);
  w(24, cl?.color ?? [0, 0, 0], 0);
  out[28] = cl?.drift[0] ?? 0; out[29] = cl?.drift[1] ?? 0; out[30] = 0; out[31] = 0;
  out.fill(0, 32, BACKGROUND_FLOATS);
  return out;
}

