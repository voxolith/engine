// Headless checks for @voxolith/engine/atmosphere.  bun tools/verify-atmosphere.ts

import { BACKGROUND_FLOATS } from "@voxolith/renderer/core";
import { EARTH_ATMOSPHERE, makeSkyModel, skyBelowHorizon, skyDisplay } from "../src/atmosphere/sky-model";
import { PHYSICAL_SKY_WESL } from "../src/atmosphere/physical-sky-wgsl";
import { physicalSkyFrame } from "../src/atmosphere/physical-sky";
import { approach, atmosphereFrame, ATMOSPHERES, blendAtmosphere, CLASSIC_SKY_WESL, classicSky, classicSkyParams, makeAtmosphereTransition, timeOfDay, type Atmosphere } from "../src/atmosphere/index";

let failed = 0, checks = 0;
const ok = (c: boolean, m: string, d = "") => {
  checks++;
  if (c) console.log(`  ✓ ${m}`);
  else { failed++; console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); }
};
const lum = (c: [number, number, number]) => c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

console.log("time of day:");
{
  const noon = timeOfDay(0.5), midnight = timeOfDay(0), dusk = timeOfDay(0.75);
  ok(lum(noon.lightColor) > 0.8 && lum(midnight.lightColor) < 0.3, `noon is bright, midnight dim (${lum(noon.lightColor).toFixed(2)} / ${lum(midnight.lightColor).toFixed(2)})`);
  ok(noon.lightDir[1] > 0.6 && noon.lightDir[1] < 0.95, "the noon sun is high but not overhead, so walls get light");
  ok(midnight.nightFactor > 0.9 && noon.nightFactor < 0.05 && dusk.nightFactor > 0.2 && dusk.nightFactor < 0.8, "night factor follows the day");
  ok(same(timeOfDay(1.25), timeOfDay(0.25)), "phase wraps around a day");
}

console.log("presets:");
{
  const inRange = (a: Atmosphere) => [a.cloud, a.fog, a.wetness, a.cover, a.precipitation.intensity, a.wind.strength].every((v) => v >= 0 && v <= 1);
  ok(Object.values(ATMOSPHERES).every(inRange), `all ${Object.keys(ATMOSPHERES).length} presets are in range`);
}

console.log("blending and transitions:");
{
  const { clear, rain, snow } = ATMOSPHERES;
  ok(same(blendAtmosphere(clear, rain, 0), clear) && same(blendAtmosphere(clear, rain, 1), rain), "blend hits both endpoints");
  const mid = blendAtmosphere(rain, snow, 0.5);
  ok(mid.precipitation.intensity === 0, "rain to snow passes through no precipitation rather than mixing kinds");
  ok(blendAtmosphere(rain, snow, 0.75).precipitation.kind === "snow", "and comes out as snow");
  const turn = blendAtmosphere({ ...clear, wind: { direction: 350, strength: 0 } }, { ...clear, wind: { direction: 10, strength: 0 } }, 0.5);
  ok(Math.abs(((turn.wind.direction % 360) + 360) % 360) < 1e-9, `wind turns the short way (350° → 10° passes 0°, got ${turn.wind.direction})`);
  const tr = makeAtmosphereTransition(clear);
  tr.set(ATMOSPHERES.storm, 2);
  ok(tr.changing(), "a transition reports that it is changing");
  let last = tr.current().cloud, monotonic = true;
  for (let i = 0; i < 30; i++) { const c = tr.update(0.1).cloud; if (c < last - 1e-9) monotonic = false; last = c; }
  ok(!tr.changing() && same(tr.current(), ATMOSPHERES.storm), "and arrives exactly at its target");
  ok(monotonic, "without overshooting on the way");
  ok(approach(0.9, 1, 0.5, 1) === 1 && approach(0.1, 0, 0.5, 1) === 0 && Math.abs(approach(0, 1, 0.5, 0.5) - 0.25) < 1e-12, "approach moves at its rate and never overshoots");
}

console.log("to the renderer:");
{
  const light = timeOfDay(0.5);
  const clear = atmosphereFrame(light, ATMOSPHERES.clear);
  ok(same(clear.lightColor, light.lightColor) && same(clear.skyTop, light.skyTop) && same(clear.ambientSky, light.ambientSky), "clear weather leaves the lighting untouched");
  ok(!clear.fog && !clear.precipitation && !clear.surface && clear.background[15] === 0, "and asks the renderer for no fog, clouds, precipitation or surface");
  ok(!("clouds" in clear), "the cloud layer travels in the background parameters, not as a renderer field");
  ok(same(Array.from(clear.background), Array.from(classicSkyParams(light))), "a clear sky's background is the time of day's, packed");
  const over = atmosphereFrame(light, ATMOSPHERES.overcast);
  ok(lum(over.lightColor) < lum(light.lightColor) * 0.5, "overcast dims the key light");
  const bg = over.background, f32 = (v: number) => Math.fround(v);
  ok(bg.length === BACKGROUND_FLOATS && bg[15] === f32(ATMOSPHERES.overcast.cloud) && bg[24] > 0.5, `overcast packs its cloud cover and colour for the sky (cover ${bg[15].toFixed(2)})`);
  ok([0, 1, 2].every((i) => bg[16 + i] === f32(over.skyTop[i]) && bg[20 + i] === f32(over.skyHorizon[i])) && bg[3] === f32(over.sunIntensity) && bg[7] === f32(over.moonIntensity),
    "  and the greyed sky and dimmed discs it returns, as the renderer used to pack them");
  const east = atmosphereFrame(light, { ...ATMOSPHERES.storm, wind: { direction: 90, strength: 1 } });
  ok(east.background[28] > 1 && Math.abs(east.background[29]) < 1e-6, "wind towards +X drifts the clouds that way");
  ok(!!east.precipitation && east.precipitation.fall[0] > 5 && east.precipitation.fall[1] < -30, `wind towards +X tilts the rain that way (${east.precipitation?.fall.map((v) => v.toFixed(1))})`);
  const snowy = atmosphereFrame(timeOfDay(0), { ...ATMOSPHERES.snow, cover: 0.7 });
  ok(snowy.precipitation?.kind === "snow" && (snowy.precipitation?.fall[1] ?? 0) > -20, "snow falls slowly");
  ok(snowy.surface?.cover === 0.7, "settled snow reaches the renderer as surface cover");
  ok(lum(atmosphereFrame(timeOfDay(0), ATMOSPHERES.overcast).skyTop) < 0.12, "an overcast night stays dark");
}

console.log("classic sky:");
{
  ok(classicSky.source === CLASSIC_SKY_WESL && /fn background\(rd : vec3<f32>, footprint : f32\) -> vec3<f32>/.test(CLASSIC_SKY_WESL) && CLASSIC_SKY_WESL.includes("import package::bg::BG;"),
    "classicSky is a background module (fn background(rd, footprint), reading package::bg)");
  const out = new Float32Array(BACKGROUND_FLOATS).fill(9);
  const packed = classicSkyParams(timeOfDay(0), out);
  ok(packed === out && out.slice(24).every((v) => v === 0) && out[12] > 0.8 && out[11] > 0.9, "classicSkyParams writes into the given array, clearing what it does not use (night factor " + out[11].toFixed(2) + ")");
}

console.log("physical sky, below the horizon:");
{
  const model = makeSkyModel();
  const dl = (v: readonly number[]) => lum(v.map(skyDisplay) as [number, number, number]);
  const dip = model.settings.horizonZenith - Math.PI / 2;
  const mu = (deg: number) => -Math.sin(dip + (deg * Math.PI) / 180); // degrees below the horizon
  const rows: string[] = [];
  let bounded = true, between = true, lit = true, hazy = true, sky = true, exact = true, shaded = true;
  for (const [name, phase] of [["noon", 0.5], ["dusk", 0.76], ["night", 0]] as const) {
    const t = timeOfDay(phase);
    const frame = physicalSkyFrame(model, t);
    const st = model.state(t.sunDir, t.moonDir);
    const h = st.horizonLinear;
    const at = (deg: number) => skyBelowHorizon(frame.background, h, mu(deg));
    const ls = [0.01, 0.3, 1, 5, 30, 89.6].map((d) => dl(at(d)));
    rows.push(`${name} horizon ${dl(h).toFixed(3)} below ${ls.map((v) => v.toFixed(3)).join(" ")}`);
    if (ls.some((v) => v > dl(h) + 1e-6)) bounded = false;
    // The ground is what the renderer would draw for an upward face of that albedo under this light.
    const want = EARTH_ATMOSPHERE.groundAlbedo.map((g, c) => Math.pow(g, 1 / 2.2) * (0.85 * frame.ambientSky[c] + 0.6 * Math.max(0, frame.lightDir[1]) * frame.lightColor[c]));
    if (want.some((v, c) => Math.abs(skyDisplay(frame.background[48 + c]) - v) > 1e-4)) shaded = false;
    // A mix of ground and horizon: monotonic from one to the other.
    const dir = Math.sign(ls[5] - ls[0]);
    if (ls.some((v, i) => i > 0 && (v - ls[i - 1]) * dir < -1e-6)) between = false;
    if (!(ls[5] > 0.004)) lit = false;
    if (!(Math.abs(ls[0] - dl(h)) < Math.abs(ls[5] - dl(h)))) hazy = false;
    // Above the horizon line (inside the dip) the backdrop is the sky's, untouched.
    const up = skyBelowHorizon(frame.background, h, -Math.sin(dip * 0.5));
    if (up.some((v, c) => v !== h[c])) sky = false;
    // The uniform-air sum against the model's own march to the ground (in-scattered light only).
    for (const deg of [1, 5]) {
      const m = mu(deg), full = at(deg), g = frame.background.subarray(48, 51);
      const d = frame.background[55] / (frame.background[51] * -m + Math.sqrt(frame.background[51] ** 2 * m * m - frame.background[55]));
      const s = model.radiance(m, 0, st.sunDir[1]), hz = model.radiance(0, 0, st.sunDir[1]);
      for (let c = 0; c < 3; c++) {
        const haze = full[c] - g[c] * Math.exp(-frame.background[52 + c] * d);
        const want = (s[c] / hz[c]) * h[c];
        if (phase === 0.5 && Math.abs(haze - want) > 0.35 * want + 0.004) exact = false;
      }
    }
  }
  ok(bounded, "the backdrop below the horizon is never brighter than the horizon (noon, dusk, night)", rows.join("; "));
  ok(between, "  it runs from the horizon's haze to the ground, one way, without a bump", rows.join("; "));
  ok(lit && hazy, "  straight down is the lit ground, not black; towards the horizon it nears the horizon's colour", rows.join("; "));
  ok(shaded, "  the ground is an upward face of the ground albedo under the frame's key light and ambient, as the renderer shades one");
  ok(sky, "  a direction that misses the ground (inside the horizon's dip) keeps the sky's colour");
  ok(exact, "  the haze matches the model's march to the ground at 1 and 5 degrees down (noon)");
  console.log(`    ${rows.join("\n    ")}`);

  const noon = timeOfDay(0.5);
  const clear = physicalSkyFrame(model, noon), over = physicalSkyFrame(model, noon, ATMOSPHERES.overcast), rain = physicalSkyFrame(model, noon, ATMOSPHERES.storm);
  const gl = (f: typeof clear) => lum([f.background[48], f.background[49], f.background[50]]);
  const down = dl([clear.background[48], clear.background[49], clear.background[50]]);
  ok(down > 0.3 && down < 0.7 && down < 0.75 * dl(model.state(noon.sunDir, noon.moonDir).horizonLinear), `at noon the ground straight down is a mid tone, well under the horizon (${down.toFixed(3)})`);
  ok(gl(over) < gl(clear) && gl(rain) < gl(over), "cloud and rain darken the ground as they darken the scene's light");
  ok(clear.background[51] > 6360 && clear.background[55] > 0 && clear.background[52] < clear.background[54], "the camera's radius, tangent length and the air's extinction (blue most) reach the shader");
  ok(/P\[12\]/.test(PHYSICAL_SKY_WESL) && /P\[13\]/.test(PHYSICAL_SKY_WESL) && BACKGROUND_FLOATS >= 56, "the shader reads the ground's parameters, inside the renderer's background block");
}

console.log("scale:");
{
  const a = atmosphereFrame(timeOfDay(0.5), ATMOSPHERES.rain);
  const b = atmosphereFrame(timeOfDay(0.5), ATMOSPHERES.rain, { voxelsPerMetre: 100 });
  ok(a.effectScale === undefined && b.effectScale === 10, "a 100 vox/m world asks for effects ten voxels to the native one");
  ok(Math.abs((b.fog?.density ?? 0) * 10 - (a.fog?.density ?? 1)) < 1e-9 && Math.abs((b.precipitation?.fall[1] ?? 0) - (a.precipitation?.fall[1] ?? 0) * 10) < 1e-9,
    "  fog per voxel thins and rain falls ten times the voxels per second: the same weather in metres");
}

console.log(`\n${checks - failed}/${checks} atmosphere checks passed`);
if (failed) process.exit(1);
