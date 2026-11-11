// The physical sky's shaders, as strings (headless: bun tools import this module, so no `?raw`).
//
// LUT_WGSL builds the three look-up tables of Hillaire, "A Scalable and Production Ready Sky and
// Atmosphere Rendering Technique" (EGSR 2020, doi:10.1111/cgf.14050) on the GPU: transmittance
// (Bruneton's parameterisation), multiple scattering (his §5.5) and the sky view (§5.3, with his
// non-linear latitude mapping, upper hemisphere only). It is the same model as sky-model.ts, the
// CPU twin; keep the two in step.
//
// PHYSICAL_SKY_WESL is the background module the renderer links in: it samples the sky-view
// tables and draws the sun, the moon, the stars and the cloud layer over them.

import { MULTI_SCATTERING_N, SKY_VIEW_H, SKY_VIEW_W, TRANSMITTANCE_H, TRANSMITTANCE_W } from "./sky-model";

const f = (n: number) => n.toFixed(1);

/** The look-up tables' compute kernels: `transmittance`, `multiScattering`, `skyView`. */
export const LUT_WGSL = /* wgsl */ `
struct Atmo {
  rayleigh : vec4<f32>, // rgb scattering /km, scale height km
  mie      : vec4<f32>, // scattering, extinction, scale height, g
  ozone    : vec4<f32>, // rgb absorption /km, peak altitude km
  radii    : vec4<f32>, // bottom, top, ozone half width, camera radius
  ground   : vec4<f32>, // albedo rgb, horizon zenith angle
  light    : vec4<f32>, // x: the light's cos-zenith (sky view)
};

@group(0) @binding(0) var<uniform> A : Atmo;
@group(0) @binding(1) var transLut : texture_2d<f32>;
@group(0) @binding(2) var msLut : texture_2d<f32>;
@group(0) @binding(3) var lutSampler : sampler;
@group(0) @binding(4) var outTex : texture_storage_2d<rgba16float, write>;

const PI = 3.14159265;
const TW = ${f(TRANSMITTANCE_W)};
const TH = ${f(TRANSMITTANCE_H)};
const MSN = ${f(MULTI_SCATTERING_N)};

struct Med { sr : vec3<f32>, sm : f32, ext : vec3<f32> };

fn medium(hIn : f32) -> Med {
  let h = max(hIn, 0.0);
  let dr = exp(-h / A.rayleigh.w);
  let dm = exp(-h / A.mie.z);
  let dz = max(0.0, 1.0 - abs(h - A.ozone.w) / A.radii.z);
  var m : Med;
  m.sr = A.rayleigh.xyz * dr;
  m.sm = A.mie.x * dm;
  m.ext = m.sr + vec3<f32>(A.mie.y * dm) + A.ozone.xyz * dz;
  return m;
}

fn toTop(r : f32, mu : f32) -> f32 {
  let d = r * r * (mu * mu - 1.0) + A.radii.y * A.radii.y;
  return max(0.0, -r * mu + sqrt(max(d, 0.0)));
}
// Distance to the ground along (r, mu), or -1 when the ray misses it.
fn toGround(r : f32, mu : f32) -> f32 {
  let d = r * r * (mu * mu - 1.0) + A.radii.x * A.radii.x;
  if (mu >= 0.0 || d < 0.0) { return -1.0; }
  return -r * mu - sqrt(d);
}

// Transmittance to the top from (r, mu), 0 when the planet is in the way.
fn sunTrans(r : f32, mu : f32) -> vec3<f32> {
  let Rg = A.radii.x; let Rt = A.radii.y;
  if (mu < 0.0 && r * r * (mu * mu - 1.0) + Rg * Rg >= 0.0) { return vec3<f32>(0.0); }
  let H = sqrt(Rt * Rt - Rg * Rg);
  let rho = sqrt(max(0.0, r * r - Rg * Rg));
  let d = toTop(r, mu);
  let dmin = Rt - r; let dmax = rho + H;
  let uv = vec2<f32>((d - dmin) / max(1e-6, dmax - dmin), rho / H);
  let t = (clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0)) * vec2<f32>(TW - 1.0, TH - 1.0) + 0.5) / vec2<f32>(TW, TH);
  return textureSampleLevel(transLut, lutSampler, t, 0.0).rgb;
}

fn msAt(r : f32, mus : f32) -> vec3<f32> {
  let uv = clamp(vec2<f32>(mus * 0.5 + 0.5, (r - A.radii.x) / (A.radii.y - A.radii.x)), vec2<f32>(0.0), vec2<f32>(1.0));
  return textureSampleLevel(msLut, lutSampler, (uv * (MSN - 1.0) + 0.5) / MSN, 0.0).rgb;
}

// Transmittance table (256x64): Bruneton's (r, mu) from the texel, 40 steps to the top.
@compute @workgroup_size(8, 8)
fn transmittance(@builtin(global_invocation_id) id : vec3<u32>) {
  if (id.x >= u32(TW) || id.y >= u32(TH)) { return; }
  let Rg = A.radii.x; let Rt = A.radii.y;
  let H = sqrt(Rt * Rt - Rg * Rg);
  let rho = H * f32(id.y) / (TH - 1.0);
  let r = sqrt(rho * rho + Rg * Rg);
  let dmin = Rt - r; let dmax = rho + H;
  let d = dmin + f32(id.x) / (TW - 1.0) * (dmax - dmin);
  var mu = 1.0;
  if (d > 0.0) { mu = clamp((H * H - rho * rho - d * d) / (2.0 * r * d), -1.0, 1.0); }
  let t = toTop(r, mu);
  let dt = t / 40.0;
  var od = vec3<f32>(0.0);
  for (var i = 0; i < 40; i++) {
    let s = (f32(i) + 0.5) * dt;
    od += medium(sqrt(r * r + s * s + 2.0 * r * mu * s) - Rg).ext * dt;
  }
  textureStore(outTex, id.xy, vec4<f32>(exp(-od), 1.0));
}

// Multiple-scattering table (32x32, Hillaire 2020 §5.5): from height v with the sun at cos-zenith
// u * 2 - 1, the isotropic second order L2 and the transfer f_ms over 8x8 directions, then
// psi = L2 / (1 - f_ms), his eq. 10.
@compute @workgroup_size(8, 8)
fn multiScattering(@builtin(global_invocation_id) id : vec3<u32>) {
  if (id.x >= u32(MSN) || id.y >= u32(MSN)) { return; }
  // A little above the ground (Hillaire's planet radius offset): at the ground itself, f32 loses
  // the rays that graze it.
  let r = A.radii.x + max(0.01, f32(id.y) / (MSN - 1.0) * (A.radii.y - A.radii.x));
  let muS = f32(id.x) / (MSN - 1.0) * 2.0 - 1.0;
  let l = vec3<f32>(sqrt(max(0.0, 1.0 - muS * muS)), muS, 0.0);
  let iso = 1.0 / (4.0 * PI);
  var L = vec3<f32>(0.0);
  var F = vec3<f32>(0.0);
  for (var k = 0; k < 64; k++) {
    let theta = 2.0 * PI * (f32(k / 8) + 0.5) / 8.0;
    let phi = acos(1.0 - 2.0 * (f32(k % 8) + 0.5) / 8.0);
    let dir = vec3<f32>(cos(theta) * sin(phi), cos(phi), sin(theta) * sin(phi));
    let tg = toGround(r, dir.y);
    let tMax = select(toTop(r, dir.y), tg, tg >= 0.0);
    let dt = tMax / 20.0;
    var th = vec3<f32>(1.0);
    for (var s = 0; s < 20; s++) {
      let p = vec3<f32>(0.0, r, 0.0) + dir * ((f32(s) + 0.3) * dt);
      let pr = length(p);
      let m = medium(pr - A.radii.x);
      let ts = sunTrans(pr, dot(p, l) / pr);
      let ex = max(m.ext, vec3<f32>(1e-9));
      let tr = exp(-ex * dt);
      let w = th * (m.sr + vec3<f32>(m.sm)) * (1.0 - tr) / ex;
      L += w * ts * iso;
      F += w;
      th *= tr;
    }
    if (tg >= 0.0) {
      let p = vec3<f32>(0.0, r, 0.0) + dir * tg;
      let pr = length(p);
      let mus = dot(p, l) / pr;
      L += th * sunTrans(pr, mus) * max(0.0, mus) * A.ground.xyz / PI;
    }
  }
  L /= 64.0;
  F /= 64.0;
  textureStore(outTex, id.xy, vec4<f32>(L / (1.0 - F), 1.0));
}

// Sky-view table (192x108, Hillaire 2020 §5.3), upper hemisphere: latitude theta =
// horizonZenith * (1 - (1 - v)^2), dense at the horizon; u = sin(phi / 2) of the azimuth from the
// light. 30 samples spread quadratically (dense near the camera, where the air is).
@compute @workgroup_size(8, 8)
fn skyView(@builtin(global_invocation_id) id : vec3<u32>) {
  let W = ${f(SKY_VIEW_W)}; let Hh = ${f(SKY_VIEW_H)};
  if (id.x >= u32(W) || id.y >= u32(Hh)) { return; }
  let u = f32(id.x) / (W - 1.0);
  let v = f32(id.y) / (Hh - 1.0);
  let theta = A.ground.w * (1.0 - (1.0 - v) * (1.0 - v));
  let cphi = 1.0 - 2.0 * u * u;
  let sphi = sqrt(max(0.0, 1.0 - cphi * cphi));
  let dir = vec3<f32>(sin(theta) * cphi, cos(theta), sin(theta) * sphi);
  let muS = A.light.x;
  let l = vec3<f32>(sqrt(max(0.0, 1.0 - muS * muS)), muS, 0.0);
  let nu = dot(dir, l);
  let g = A.mie.w;
  let pR = 3.0 / (16.0 * PI) * (1.0 + nu * nu);
  let pM = (1.0 - g * g) / (4.0 * PI * pow(1.0 + g * g - 2.0 * g * nu, 1.5));
  let rc = A.radii.w;
  let tg = toGround(rc, dir.y);
  let tMax = select(toTop(rc, dir.y), tg, tg >= 0.0);
  var th = vec3<f32>(1.0);
  var Ls = vec3<f32>(0.0);
  var prev = 0.0;
  for (var i = 0; i < 30; i++) {
    let f1 = f32(i + 1) / 30.0;
    let t1 = tMax * f1 * f1;
    let dt = t1 - prev;
    let p = vec3<f32>(0.0, rc, 0.0) + dir * (prev + 0.3 * dt);
    prev = t1;
    let pr = length(p);
    let mus = dot(p, l) / pr;
    let m = medium(pr - A.radii.x);
    let S = (m.sr * pR + vec3<f32>(m.sm * pM)) * sunTrans(pr, mus) + (m.sr + vec3<f32>(m.sm)) * msAt(pr, mus);
    let ex = max(m.ext, vec3<f32>(1e-9));
    let tr = exp(-ex * dt);
    Ls += th * (S - S * tr) / ex;
    th *= tr;
  }
  textureStore(outTex, id.xy, vec4<f32>(Ls, 1.0));
}
`;

/**
 * The physical sky's background module (WESL), for `RendererOptions.background`: the sun's and
 * the moon's sky-view tables (`bgTex0`, `bgTex1`), sun and moon discs (limb darkening, the moon's
 * phase), stars sized from the pixel footprint, the fbm cloud layer lit by the sun and moon, and
 * the soft tone curve with display encoding. Reads the parameters `packPhysicalSky` writes
 * (layout there). {@link makePhysicalSky} hands it over with its textures; it is not useful alone.
 */
export const PHYSICAL_SKY_WESL = /* wgsl */ `
// Physical sky background (after Hillaire, EGSR 2020). Parameters: see packPhysicalSky.
import package::bg::{BG, bgTex0, bgTex1, bgSampler};

// Sky-view table coordinates of a direction (y up) for a light: Hillaire's non-linear latitude,
// azimuth from the light as sin(phi / 2), texel centres at the ends.
fn skyUv(d : vec3<f32>, l : vec3<f32>) -> vec2<f32> {
  let theta = acos(clamp(d.y, -1.0, 1.0));
  let v = 1.0 - sqrt(max(0.0, 1.0 - theta / BG.params[4].w));
  let den = length(d.xz) * length(l.xz);
  let cphi = select(1.0, dot(d.xz, l.xz) / den, den > 1e-6);
  let u = sqrt(clamp(0.5 - 0.5 * cphi, 0.0, 1.0));
  return (vec2<f32>(u, v) * vec2<f32>(${f(SKY_VIEW_W - 1)}, ${f(SKY_VIEW_H - 1)}) + 0.5) / vec2<f32>(${f(SKY_VIEW_W)}, ${f(SKY_VIEW_H)});
}

fn pcg(v : u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

fn hash2(p : vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

fn valueNoise2(p : vec2<f32>) -> f32 {
  let i = floor(p);
  let f = p - i;
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2<f32>(1.0, 0.0)), u.x), mix(hash2(i + vec2<f32>(0.0, 1.0)), hash2(i + vec2<f32>(1.0, 1.0)), u.x), u.y);
}

// The classic sky's cloud layer: fbm on a plane above the world, drifting with the wind.
fn cloudAmount(d : vec3<f32>, cover : f32) -> f32 {
  if (cover <= 0.001) { return 0.0; }
  var p = d.xz / max(d.y, 0.04) * 1.6 + vec2<f32>(BG.params[6].w, BG.params[7].w) * BG.time * 0.02;
  var n = 0.0;
  var amp = 0.55;
  for (var i = 0; i < 4; i = i + 1) {
    n += valueNoise2(p) * amp;
    p = p * 2.03 + vec2<f32>(17.1, 9.3);
    amp *= 0.5;
  }
  let edge = (1.0 - cover) * 0.9;
  return max(smoothstep(edge - 0.05, edge + 0.25, n), smoothstep(0.75, 1.0, cover));
}

// Stars: at most one per cell of a 128x128 grid on each cube face, jittered inside its cell, drawn
// as a Gaussian about 0.6 pixel wide (from the footprint), so a star is one or two pixels at any
// resolution, never a quad. The width is capped inside the cell, so none is ever cut off.
fn stars(rd : vec3<f32>, fp : f32) -> vec3<f32> {
  let a = abs(rd);
  var face = 0u;
  var uv = rd.yz / a.x;
  var s = rd.x;
  if (a.y >= a.x && a.y >= a.z) { face = 2u; uv = rd.xz / a.y; s = rd.y; }
  else if (a.z >= a.x && a.z >= a.y) { face = 4u; uv = rd.xy / a.z; s = rd.z; }
  if (s < 0.0) { face += 1u; }
  let cell = min(floor((uv * 0.5 + 0.5) * 128.0), vec2<f32>(127.0));
  let h = pcg(pcg(u32(cell.x) + 128u * u32(cell.y)) + face * 2654435769u);
  if ((h & 1023u) >= 48u) { return vec3<f32>(0.0); }
  let h2 = pcg(h);
  let h3 = pcg(h2);
  let suv = (cell + 0.25 + 0.5 * vec2<f32>(f32(h2 & 65535u), f32(h2 >> 16u)) / 65535.0) / 64.0 - 1.0;
  var sd = vec3<f32>(sign(s), suv.x, suv.y);
  if (face >= 4u) { sd = vec3<f32>(suv.x, suv.y, sign(s)); } else if (face >= 2u) { sd = vec3<f32>(suv.x, sign(s), suv.y); }
  sd = normalize(sd);
  let major = max(abs(sd.x), max(abs(sd.y), abs(sd.z)));
  let sigma = min(max(fp * 0.6, 1e-5), major * major / 768.0);
  let d = length(rd - sd);
  let b = 0.03 + 0.97 * pow(f32(h3 >> 16u) / 65535.0, 6.0);
  let tint = mix(vec3<f32>(1.0, 0.8, 0.6), vec3<f32>(0.75, 0.85, 1.0), f32(h3 & 65535u) / 65535.0);
  return tint * (b * exp(-0.5 * d * d / (sigma * sigma)));
}

fn tone(x : vec3<f32>) -> vec3<f32> {
  return select(x, 0.8 + 0.2 * (1.0 - exp(-(x - 0.8) / 0.2)), x > vec3<f32>(0.8));
}

fn background(rd : vec3<f32>, footprint : f32) -> vec3<f32> {
  let P = BG.params;
  let fp = max(footprint, 1e-5);
  // Below the horizon: the horizon (the world stands in the haze).
  var d = rd;
  if (rd.y < 0.0) {
    let hz = length(rd.xz);
    d = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(rd.x / hz, 0.0, rd.z / hz), hz > 1e-5);
  }
  var col = textureSampleLevel(bgTex0, bgSampler, skyUv(d, P[9].xyz), 0.0).rgb * P[2].xyz
          + textureSampleLevel(bgTex1, bgSampler, skyUv(d, P[10].xyz), 0.0).rgb * P[3].xyz + P[11].xyz;
  let cover = P[2].w;
  let cloud = cloudAmount(d, cover) * max(smoothstep(-0.02, 0.12, d.y), smoothstep(0.6, 1.0, cover));
  let clear = 1.0 - max(cloud, cover * 0.85);
  // What the planet hides (the horizon dips a little below 0 from above the ground).
  let cut = smoothstep(-fp, fp, rd.y + BG.params[4].w - 1.5707963);

  // Moon: a lit sphere, phase from the sun's direction, faint maria; it hides the stars behind it.
  let md = P[1].xyz;
  let mr = P[1].w;
  var moonCover = 0.0;
  if (dot(rd, md) > cos(mr + 2.0 * fp)) {
    let up = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(md.y) > 0.95);
    let t1 = normalize(cross(up, md));
    let t2 = cross(md, t1);
    let q = vec2<f32>(dot(rd, t1), dot(rd, t2)) / mr;
    let rho = length(q);
    moonCover = smoothstep(1.0 + fp / mr, 1.0 - fp / mr, rho) * cut;
    let n = t1 * q.x + t2 * q.y - md * sqrt(max(0.0, 1.0 - rho * rho));
    let lit = smoothstep(-0.06, 0.06, dot(n, P[0].xyz));
    let maria = 0.8 + 0.2 * valueNoise2(q * 2.5 + 7.0);
    col += P[5].xyz * (lit * maria * moonCover * clear);
  }

  // Stars fade out as the sky brightens, towards the horizon, behind the moon and cloud.
  if (P[3].w > 0.0) {
    let skyLum = dot(col, vec3<f32>(0.2126, 0.7152, 0.0722));
    let k = P[3].w * (1.0 - smoothstep(0.004, 0.05, skyLum)) * smoothstep(0.0, 0.12, rd.y) * (1.0 - moonCover) * clear;
    if (k > 0.001) { col += stars(rd, fp) * k; }
  }

  // Sun: limb-darkened disc (I = 1 - 0.6 (1 - mu)), anti-aliased over the footprint.
  let sd = P[0].xyz;
  let sr = P[0].w;
  let ch = length(rd - sd);
  if (ch < sr + fp) {
    let cov = smoothstep(sr + 0.5 * fp, sr - 0.5 * fp, ch);
    let x = min(ch / sr, 1.0);
    let limb = 0.4 + 0.6 * sqrt(1.0 - x * x);
    col += P[4].xyz * (limb * cov * clear * cut);
  }

  // Clouds: ambient from the sky, the sun's and moon's light, brighter towards each.
  if (cloud > 0.0) {
    let ls = pow(max(dot(d, sd), 0.0), 5.0);
    let lm = pow(max(dot(d, md), 0.0), 5.0);
    let cc = P[8].xyz + P[6].xyz * (0.3 + 0.7 * ls) + P[7].xyz * (0.3 + 0.7 * lm);
    col = mix(col, cc, cloud);
  }
  return pow(tone(max(col, vec3<f32>(0.0))), vec3<f32>(1.0 / 2.2));
}
`;
