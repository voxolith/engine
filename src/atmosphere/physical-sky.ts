// The physical sky: a renderer background from Hillaire's look-up tables, and the scene's light
// from the same model, so the lighting matches the backdrop.
//
// Sébastien Hillaire, "A Scalable and Production Ready Sky and Atmosphere Rendering Technique",
// Computer Graphics Forum 39(4), EGSR 2020, doi:10.1111/cgf.14050. The transmittance and
// multiple-scattering tables are built once (they depend only on the atmosphere); the sky-view
// tables, one lit by the sun and one by the moon, whenever either moves by more than ~0.1°. The
// backdrop samples them; the CPU twin (sky-model.ts) derives the key light, the ambient and the fog
// colour from the same model. This is the engine's only code that touches the GPU device.

import type { BackgroundOptions } from "@voxolith/renderer/core";
import {
  cloudHorizon,
  makeSkyModel,
  MULTI_SCATTERING_N,
  packPhysicalSky,
  skyDisplay,
  SKY_VIEW_H,
  SKY_VIEW_W,
  TRANSMITTANCE_H,
  TRANSMITTANCE_W,
  encodeHue,
  type PhysicalSkyOptions,
  type SkyLighting,
  type SkyModel,
} from "./sky-model";
import { LUT_WGSL, PHYSICAL_SKY_WESL } from "./physical-sky-wgsl";
import { atmosphereFrame, ATMOSPHERES, type Atmosphere, type AtmosphereFrame, type AtmosphereFrameOptions } from "./weather";
import type { Lighting } from "./timeofday";

type Vec3 = [number, number, number];

/** A physical sky, from {@link makePhysicalSky}. */
export interface PhysicalSky {
  /**
   * The backdrop, for `createRenderer(gpu, scene, { background: sky.background })`: the module and
   * its two sky-view textures. The renderer must be created on the same device.
   */
  readonly background: BackgroundOptions;
  /** The CPU twin the sky derives its light from. */
  readonly model: SkyModel;
  /**
   * One frame's renderer settings: the backdrop's parameters (`background`), the key light, the
   * ambient and, with weather, fog (in the horizon's colour), precipitation, wet or snowy ground
   * and wind on water, as {@link atmosphereFrame} makes them. Spread it into `renderer.render`.
   * Rebuilds the sky-view tables (a small compute pass) when the sun or moon has moved; call it
   * before `render` each frame the sky may have changed.
   *
   * @param lighting - Where the sun and moon are; usually {@link timeOfDay}'s result (its colours
   *   are not used: the sky makes its own).
   * @param atmosphere - Weather (default {@link ATMOSPHERES}.clear): clouds cover the sky, cut the
   *   key light and flatten the ambient.
   * @param opts - Scale, fall speeds and snow colour, as for {@link atmosphereFrame}.
   */
  frame(lighting: SkyLighting, atmosphere?: Atmosphere, opts?: AtmosphereFrameOptions): AtmosphereFrame;
  /** Free the GPU tables. The renderer using the background must be destroyed first (or not draw again). */
  destroy(): void;
}

/** Anything with the device the renderer uses: `initGpu()`'s context, or `{ device }`. */
export interface PhysicalSkyGpu {
  /** The renderer's device. */
  device: GPUDevice;
}

// Rebuild a sky-view table when its light has moved by more than this (radians).
const REBUILD_ANGLE = 0.002;
const UNIFORM_BYTES = 6 * 16;
// WebGPU usage flags, by value: the engine compiles without WebGPU's ambient globals.
const TEXTURE_BINDING = 0x04, STORAGE_BINDING = 0x08, UNIFORM = 0x40, COPY_DST = 0x08;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix3 = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * A physically based sky for the renderer, after Hillaire (EGSR 2020): Rayleigh, Mie and ozone
 * scattering from look-up tables built in compute shaders, a sun disc with limb darkening coloured
 * by the air it shines through, a moon with its phase that lights a bluish night sky, stars one or
 * two pixels wide at any resolution, and the drifting cloud layer, lit by the sun and moon. The
 * scene's light comes from the same model: `frame()` returns the key light (sunlight, or
 * moonlight at night, through the atmosphere), sky and ground ambient, and a fog colour that
 * matches the horizon, all weather-aware.
 *
 * Costs, once: two small compute passes at creation and ~30 ms of CPU for the twin's tables. Per
 * frame: a CPU lookup, and a sky-view rebuild (two 192x108 passes of 30 samples) only when the
 * sun or moon moved. The backdrop is linked into every renderer pipeline and is about the size of
 * the classic sky's.
 *
 * @param gpu - The renderer's device (`initGpu()`'s context will do).
 * @param opts - The atmosphere, the camera's altitude, disc sizes, moonlight, exposure.
 * @returns The sky, once its tables are built.
 * @example
 * ```ts
 * const sky = await makePhysicalSky(gpu);
 * const renderer = await createRenderer(gpu, scene, { background: sky.background });
 * // per frame:
 * renderer.render({ ...camera, ...sky.frame(timeOfDay(phase), weather), time: now / 1000 });
 * ```
 */
export async function makePhysicalSky(gpu: PhysicalSkyGpu, opts: PhysicalSkyOptions = {}): Promise<PhysicalSky> {
  const { device } = gpu;
  const model = makeSkyModel(opts);
  const s = model.settings, a = s.atm;

  const usage = TEXTURE_BINDING | STORAGE_BINDING | 0x01;
  const tex = (w: number, h: number, label: string) => device.createTexture({ label, size: [w, h], format: "rgba16float", usage });
  const trans = tex(TRANSMITTANCE_W, TRANSMITTANCE_H, "sky transmittance");
  const ms = tex(MULTI_SCATTERING_N, MULTI_SCATTERING_N, "sky multiple scattering");
  const sunView = tex(SKY_VIEW_W, SKY_VIEW_H, "sky view (sun)");
  const moonView = tex(SKY_VIEW_W, SKY_VIEW_H, "sky view (moon)");
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });

  const atmo = new Float32Array(UNIFORM_BYTES / 4);
  atmo.set([...a.rayleighScattering, a.rayleighScaleHeight], 0);
  atmo.set([a.mieScattering, a.mieExtinction, a.mieScaleHeight, a.mieG], 4);
  atmo.set([...a.ozoneAbsorption, a.ozoneCentre], 8);
  atmo.set([a.bottomRadius, a.topRadius, a.ozoneHalfWidth, s.camR], 12);
  atmo.set([...a.groundAlbedo, s.horizonZenith], 16);
  const buffer = () => device.createBuffer({ size: UNIFORM_BYTES, usage: UNIFORM | COPY_DST });
  const baseU = buffer(), sunU = buffer(), moonU = buffer();
  device.queue.writeBuffer(baseU, 0, atmo);

  const module = device.createShaderModule({ label: "physical sky tables", code: LUT_WGSL });
  const pipe = (entryPoint: string) => device.createComputePipelineAsync({ label: `sky ${entryPoint}`, layout: "auto", compute: { module, entryPoint } });
  const [transP, msP, viewP] = await Promise.all([pipe("transmittance"), pipe("multiScattering"), pipe("skyView")]);

  const group = (p: GPUComputePipeline, u: GPUBuffer, out: GPUTexture, reads: 0 | 1 | 2) => {
    const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: u } }, { binding: 4, resource: out.createView() }];
    if (reads >= 1) entries.push({ binding: 1, resource: trans.createView() }, { binding: 3, resource: sampler });
    if (reads >= 2) entries.push({ binding: 2, resource: ms.createView() });
    return device.createBindGroup({ layout: p.getBindGroupLayout(0), entries });
  };
  const transG = group(transP, baseU, trans, 0);
  const msG = group(msP, baseU, ms, 1);
  const sunG = group(viewP, sunU, sunView, 2);
  const moonG = group(viewP, moonU, moonView, 2);

  const run = (passes: [GPUComputePipeline, GPUBindGroup, number, number][]) => {
    const enc = device.createCommandEncoder({ label: "physical sky" });
    for (const [p, g, w, h] of passes) {
      const pass = enc.beginComputePass();
      pass.setPipeline(p);
      pass.setBindGroup(0, g);
      pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
      pass.end();
    }
    device.queue.submit([enc.finish()]);
  };
  run([[transP, transG, TRANSMITTANCE_W, TRANSMITTANCE_H], [msP, msG, MULTI_SCATTERING_N, MULTI_SCATTERING_N]]);

  // The directions the sky-view tables were last built for (null: never).
  let lutSun: Vec3 | null = null, lutMoon: Vec3 | null = null;
  const moved = (was: Vec3 | null, now: Vec3) => !was || was[0] * now[0] + was[1] * now[1] + was[2] * now[2] < Math.cos(REBUILD_ANGLE);
  const lightU = new Float32Array(UNIFORM_BYTES / 4);
  const rebuild = (sun: Vec3, moon: Vec3) => {
    const passes: [GPUComputePipeline, GPUBindGroup, number, number][] = [];
    if (moved(lutSun, sun)) {
      lightU.set(atmo); lightU[20] = sun[1];
      device.queue.writeBuffer(sunU, 0, lightU);
      passes.push([viewP, sunG, SKY_VIEW_W, SKY_VIEW_H]);
      lutSun = sun;
    }
    if (moved(lutMoon, moon)) {
      lightU.set(atmo); lightU[20] = moon[1];
      device.queue.writeBuffer(moonU, 0, lightU);
      passes.push([viewP, moonG, SKY_VIEW_W, SKY_VIEW_H]);
      lutMoon = moon;
    }
    if (passes.length) run(passes);
  };

  let destroyed = false;
  (globalThis as any).__skyDebug = { trans, ms, sunView };
  return {
    background: { source: PHYSICAL_SKY_WESL, textures: [sunView.createView(), moonView.createView()] },
    model,
    frame(lighting, atm = ATMOSPHERES.clear, fo = {}) {
      const st = model.state(lighting.sunDir, lighting.moonDir);
      if (!destroyed) rebuild(st.sunDir, st.moonDir);
      return physicalFrame(model, st, atm, fo, lutSun ?? st.sunDir, lutMoon ?? st.moonDir);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const t of [trans, ms, sunView, moonView]) t.destroy();
      for (const b of [baseU, sunU, moonU]) b.destroy();
    },
  };
}

/**
 * A frame of the physical sky from its model alone (no GPU): what {@link PhysicalSky.frame}
 * returns, with the sky-view tables assumed built for the current sun and moon. For headless
 * tests, and for hosts that light a scene with the physical sky's colours under another backdrop.
 *
 * @param model - From {@link makeSkyModel}.
 * @param lighting - Where the sun and moon are, usually {@link timeOfDay}'s result.
 * @param atm - Weather; default clear.
 * @param opts - As for {@link atmosphereFrame}.
 * @returns The renderer settings, as {@link PhysicalSky.frame}.
 */
export function physicalSkyFrame(model: SkyModel, lighting: SkyLighting, atm: Atmosphere = ATMOSPHERES.clear, opts: AtmosphereFrameOptions = {}): AtmosphereFrame {
  const st = model.state(lighting.sunDir, lighting.moonDir);
  return physicalFrame(model, st, atm, opts, st.sunDir, st.moonDir);
}

function physicalFrame(model: SkyModel, st: ReturnType<SkyModel["state"]>, atm: Atmosphere, fo: AtmosphereFrameOptions, lutSun: Vec3, lutMoon: Vec3): AtmosphereFrame {
  const s = model.settings;
  const cloud = clamp01(atm.cloud);
  const precip = atm.precipitation.kind === "none" ? 0 : clamp01(atm.precipitation.intensity);
  const w = (atm.wind.direction * Math.PI) / 180, ws = clamp01(atm.wind.strength);
  const drift: [number, number] = [Math.sin(w) * (0.3 + ws * 2), Math.cos(w) * (0.3 + ws * 2)];
  const background = packPhysicalSky(st, s, { cover: cloud, gloom: precip, drift }, lutSun, lutMoon);

  // Readbacks and fog: the clear sky's zenith and horizon, covered by cloud as the backdrop is.
  const ch = cloudHorizon(background);
  const hide = clamp01(cloud * 1.15);
  const skyTop = mix3(st.zenithLinear, ch, hide).map(skyDisplay) as Vec3;
  const skyHorizon = mix3(st.horizonLinear, ch, hide).map(skyDisplay) as Vec3;

  const lighting: Lighting = {
    lightDir: st.lightDir,
    lightColor: st.lightColor,
    ambientSky: st.ambientSky,
    ambientGround: st.ambientGround,
    sunDir: st.sunDir,
    moonDir: st.moonDir,
    sunColor: encodeHue(st.sunDisc).map((v) => Math.min(1, v)) as Vec3,
    moonColor: encodeHue(st.moonDisc).map((v) => Math.min(1, v)) as Vec3,
    skyTop,
    skyHorizon,
    nightFactor: 1 - st.day,
    sunIntensity: st.day,
    moonIntensity: (1 - st.day) * st.moonPhase,
  };
  // Weather's effect on the light, precipitation, ground and water, as atmosphereFrame has it.
  const out = atmosphereFrame(lighting, atm, fo);
  out.background = background;
  out.skyTop = skyTop;
  out.skyHorizon = skyHorizon;
  if (out.fog) out.fog.color = skyHorizon;
  return out;
}
