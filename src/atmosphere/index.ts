/**
 * `@voxolith/engine/atmosphere`: time of day and weather, as configuration.
 *
 * The renderer draws raw atmospheric effects (fog, rain or snow, wet and snow-covered ground,
 * wind on water) and whatever background module the host links in, and knows nothing about
 * weather. A game decides whether there is
 * weather and when it changes. This module is the layer between: a vocabulary
 * ({@link Atmosphere}) and presets ({@link ATMOSPHERES}) for describing the sky, blending and
 * transitions between them ({@link makeAtmosphereTransition}), and one function that turns time
 * of day ({@link timeOfDay}) plus an atmosphere into the renderer's settings, including the
 * parameters of {@link classicSky}, the stylised sky (gradient, blocky sun, moon and stars,
 * clouds) it draws:
 *
 * ```ts
 * const renderer = await createRenderer(gpu, scene, { background: classicSky });
 * renderer.render({ ...camera, ...atmosphereFrame(timeOfDay(phase), weather), time });
 * ```
 *
 * {@link makePhysicalSky} is the other sky: physically based (after Hillaire, EGSR 2020), drawn
 * from look-up tables it builds on the GPU, and lighting the scene from the same model:
 *
 * ```ts
 * const sky = await makePhysicalSky(gpu);
 * const renderer = await createRenderer(gpu, scene, { background: sky.background });
 * renderer.render({ ...camera, ...sky.frame(timeOfDay(phase), weather), time });
 * ```
 *
 * Optional, and headless except for {@link makePhysicalSky}: games without weather never import it.
 *
 * @packageDocumentation
 */

export { timeOfDay } from "./timeofday";
export type { Lighting, TimeOfDayOptions } from "./timeofday";

export { CLASSIC_SKY_WESL, classicSky, classicSkyParams } from "./classic-sky";

export { makePhysicalSky, physicalSkyFrame } from "./physical-sky";
export type { PhysicalSky, PhysicalSkyGpu } from "./physical-sky";
export { EARTH_ATMOSPHERE, makeSkyModel } from "./sky-model";
export type { PhysicalSkyOptions, SkyAtmosphere, SkyLighting, SkyModel, SkySettings, SkyState } from "./sky-model";
export type { ClassicSkyClouds, ClassicSkyFrame } from "./classic-sky";

export { approach, atmosphereFrame, ATMOSPHERES, blendAtmosphere, makeAtmosphereTransition } from "./weather";
export type { Atmosphere, AtmosphereFrame, AtmosphereFrameOptions, AtmosphereName, AtmosphereTransition, PrecipitationKind } from "./weather";
