/**
 * `@voxolith/engine/atmosphere`: time of day and weather, as configuration.
 *
 * The renderer draws raw atmospheric effects (fog, clouds, rain or snow, wet and snow-covered
 * ground, wind on water) and knows nothing about weather. A game decides whether there is
 * weather and when it changes. This module is the layer between: a vocabulary
 * ({@link Atmosphere}) and presets ({@link ATMOSPHERES}) for describing the sky, blending and
 * transitions between them ({@link makeAtmosphereTransition}), and one function that turns time
 * of day ({@link timeOfDay}) plus an atmosphere into the renderer's settings:
 *
 * ```ts
 * renderer.render({ ...camera, ...atmosphereFrame(timeOfDay(phase), weather), time });
 * ```
 *
 * Optional and headless: games without weather never import it.
 *
 * @packageDocumentation
 */

export { timeOfDay } from "./timeofday";
export type { Lighting, TimeOfDayOptions } from "./timeofday";

export { approach, atmosphereFrame, ATMOSPHERES, blendAtmosphere, makeAtmosphereTransition } from "./weather";
export type { Atmosphere, AtmosphereFrameOptions, AtmosphereName, AtmosphereTransition, PrecipitationKind } from "./weather";
