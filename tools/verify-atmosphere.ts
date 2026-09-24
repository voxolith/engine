// Headless checks for @voxolith/engine/atmosphere.  bun tools/verify-atmosphere.ts

import { approach, atmosphereFrame, ATMOSPHERES, blendAtmosphere, makeAtmosphereTransition, timeOfDay, type Atmosphere } from "../src/atmosphere/index";

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
  ok(!clear.fog && !clear.clouds && !clear.precipitation && !clear.surface, "and asks the renderer for no fog, clouds, precipitation or surface");
  const over = atmosphereFrame(light, ATMOSPHERES.overcast);
  ok(lum(over.lightColor) < lum(light.lightColor) * 0.5, "overcast dims the key light");
  const east = atmosphereFrame(light, { ...ATMOSPHERES.storm, wind: { direction: 90, strength: 1 } });
  ok(!!east.precipitation && east.precipitation.fall[0] > 5 && east.precipitation.fall[1] < -30, `wind towards +X tilts the rain that way (${east.precipitation?.fall.map((v) => v.toFixed(1))})`);
  const snowy = atmosphereFrame(timeOfDay(0), { ...ATMOSPHERES.snow, cover: 0.7 });
  ok(snowy.precipitation?.kind === "snow" && (snowy.precipitation?.fall[1] ?? 0) > -20, "snow falls slowly");
  ok(snowy.surface?.cover === 0.7, "settled snow reaches the renderer as surface cover");
  ok(lum(atmosphereFrame(timeOfDay(0), ATMOSPHERES.overcast).skyTop) < 0.12, "an overcast night stays dark");
}

console.log(`\n${checks - failed}/${checks} atmosphere checks passed`);
if (failed) process.exit(1);
