// Shareable generator state.
//
// A generator plus its parameters plus a seed is a complete description of one
// model: generation is pure and takes all its randomness from the injected rng,
// so the same three always rebuild the same voxels. This packs those three into
// a short string that can be pasted into a URL or a chat and turned back into
// the model on the other side.
//
// It is a *code*, not a hash. A hash is one-way and could only name a model, not
// rebuild one — that would need a server holding every model anyone had made.
// `fingerprint` is available separately for the naming-and-comparing job.
//
// The code carries values for the generator's declared `params` only, in
// declaration order, and decoding starts from the generator's `defaults`. So the
// contract is exactly what a UI can show and a person can tweak; anything not
// declared as a ParamSpec is part of the preset, not part of the shared state.

import { getGenerator, getParam, withParam, type EntityGenerator, type GenerateContext, type ParamSpec } from "./generator";
import type { Entity } from "./entity";
import { seededRandom } from "@voxolith/renderer/core";

export interface GeneratorState<P = unknown> {
  /** `EntityGenerator.id`. */
  generator: string;
  /** Generator version the state was produced with. */
  version: string;
  /** Seeds the rng, so the same state rebuilds the same model. */
  seed: number;
  params: P;
}

const MAGIC = 1;

// --- base64url, hand-rolled so this needs no platform globals ---------------

const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LOOKUP = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHA.length; i++) t[ALPHA.charCodeAt(i)] = i;
  return t;
})();

function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : -1;
    const c = i + 2 < bytes.length ? bytes[i + 2] : -1;
    out += ALPHA[a >> 2];
    out += ALPHA[((a & 3) << 4) | (b < 0 ? 0 : b >> 4)];
    if (b < 0) break;
    out += ALPHA[((b & 15) << 2) | (c < 0 ? 0 : c >> 6)];
    if (c < 0) break;
    out += ALPHA[c & 63];
  }
  return out;
}

function fromBase64Url(s: string): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const v = LOOKUP[s.charCodeAt(i) & 127] ?? -1;
    if (v < 0) throw new Error(`Not a valid share code: unexpected "${s[i]}"`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

// --- byte writer/reader -----------------------------------------------------

class Writer {
  private readonly bytes: number[] = [];
  u8(v: number) {
    this.bytes.push(v & 0xff);
  }
  /** LEB128; values here are small, so most take one byte. */
  varint(v: number) {
    let n = Math.max(0, Math.round(v));
    do {
      let b = n & 0x7f;
      n = Math.floor(n / 128);
      if (n > 0) b |= 0x80;
      this.bytes.push(b);
    } while (n > 0);
  }
  str(s: string) {
    const enc: number[] = [];
    for (const ch of s) {
      const cp = ch.codePointAt(0)!;
      if (cp < 0x80) enc.push(cp);
      else if (cp < 0x800) enc.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
      else enc.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    }
    this.varint(enc.length);
    for (const b of enc) this.bytes.push(b);
  }
  done(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

class Reader {
  private i = 0;
  constructor(private readonly b: Uint8Array) {}
  u8(): number {
    if (this.i >= this.b.length) throw new Error("Share code ended early");
    return this.b[this.i++];
  }
  varint(): number {
    let out = 0;
    let shift = 1;
    for (;;) {
      const b = this.u8();
      out += (b & 0x7f) * shift;
      if (!(b & 0x80)) return out;
      shift *= 128;
    }
  }
  str(): string {
    const n = this.varint();
    let s = "";
    for (let k = 0; k < n; ) {
      const b = this.u8();
      k++;
      if (b < 0x80) s += String.fromCodePoint(b);
      else if (b < 0xe0) {
        s += String.fromCodePoint(((b & 31) << 6) | (this.u8() & 63));
        k++;
      } else {
        s += String.fromCodePoint(((b & 15) << 12) | ((this.u8() & 63) << 6) | (this.u8() & 63));
        k += 2;
      }
    }
    return s;
  }
}

// --- parameter quantisation -------------------------------------------------

/** Smallest step a `number` spec is encoded at when it declares none. */
const DEFAULT_STEPS = 1000;

function stepOf(spec: ParamSpec): number {
  if (spec.kind === "number") return spec.step ?? (spec.max - spec.min) / DEFAULT_STEPS;
  return 1;
}

/** Clamp and snap a value to what its spec allows. */
export function clampToSpec(spec: ParamSpec, value: unknown): number | boolean | string {
  switch (spec.kind) {
    case "bool":
      return Boolean(value);
    case "enum": {
      const i = spec.options.indexOf(String(value));
      return spec.options[i < 0 ? 0 : i];
    }
    case "int": {
      const n = Math.round(Number(value));
      return Math.max(spec.min, Math.min(spec.max, Number.isFinite(n) ? n : spec.min));
    }
    default: {
      const step = stepOf(spec);
      const n = Number(value);
      const snapped = Math.round((Number.isFinite(n) ? n : spec.min) / step) * step;
      const clamped = Math.max(spec.min, Math.min(spec.max, snapped));
      // Snapping in float leaves long tails (0.30000000000000004); round to the
      // step's own precision so encode/decode is exactly stable.
      const dp = Math.max(0, Math.ceil(-Math.log10(step)) + 1);
      return Number(clamped.toFixed(dp));
    }
  }
}

function encodeValue(spec: ParamSpec, value: unknown): number {
  switch (spec.kind) {
    case "bool":
      return value ? 1 : 0;
    case "enum":
      return Math.max(0, spec.options.indexOf(String(value)));
    case "int":
      return (clampToSpec(spec, value) as number) - spec.min;
    default:
      return Math.round(((clampToSpec(spec, value) as number) - spec.min) / stepOf(spec));
  }
}

function decodeValue(spec: ParamSpec, raw: number): number | boolean | string {
  switch (spec.kind) {
    case "bool":
      return raw !== 0;
    case "enum":
      return spec.options[Math.min(spec.options.length - 1, raw)];
    case "int":
      return clampToSpec(spec, spec.min + raw) as number;
    default:
      return clampToSpec(spec, spec.min + raw * stepOf(spec)) as number;
  }
}

/**
 * Identifies the parameter *layout*. A code is a positional list, so a
 * generator that gains, loses or reorders a parameter can no longer read old
 * codes — and must say so rather than silently rebuild a different tree.
 */
function schemaHash(specs: ParamSpec[]): number {
  let h = 0x811c9dc5;
  for (const s of specs) {
    const sig = `${s.path}:${s.kind}:${s.kind === "enum" ? s.options.join(",") : ""}`;
    for (let i = 0; i < sig.length; i++) {
      h ^= sig.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h & 0xffff;
}

// --- public API -------------------------------------------------------------

/** Pack a generator, its parameters and a seed into a shareable code. */
export function encodeState<P>(gen: EntityGenerator<P>, state: Omit<GeneratorState<P>, "generator" | "version">): string {
  const w = new Writer();
  w.u8(MAGIC);
  w.str(gen.id);
  w.str(gen.version);
  const sh = schemaHash(gen.params);
  w.u8(sh >> 8);
  w.u8(sh & 0xff);
  w.varint(state.seed >>> 0);
  for (const spec of gen.params) w.varint(encodeValue(spec, getParam(state.params, spec.path)));
  return toBase64Url(w.done());
}

/**
 * Unpack a code. The generator must be registered, since decoding starts from
 * its defaults and only the declared parameters travel in the code.
 */
export function decodeState<P = unknown>(code: string): GeneratorState<P> {
  const r = new Reader(fromBase64Url(code.trim()));
  const magic = r.u8();
  if (magic !== MAGIC) throw new Error(`Unsupported share code version ${magic}`);
  const id = r.str();
  const version = r.str();
  const sh = (r.u8() << 8) | r.u8();
  const seed = r.varint();

  const gen = getGenerator<P>(id);
  if (!gen) throw new Error(`Generator "${id}" is not registered`);
  if (sh !== schemaHash(gen.params)) {
    throw new Error(
      `Share code was made with different parameters for "${id}" ` +
        `(code says version ${version}, this build is ${gen.version}). ` +
        `Rebuilding it would give a different model, so it is refused rather than guessed at.`,
    );
  }

  let params = structuredClone(gen.defaults) as P;
  for (const spec of gen.params) params = withParam(params, spec.path, decodeValue(spec, r.varint()));
  return { generator: id, version, seed, params };
}

/** Build the model a state describes. Pure: same state, same voxels. */
export function generateFromState<P>(state: GeneratorState<P>, id?: string, ctx?: GenerateContext): Entity {
  const gen = getGenerator<P>(state.generator);
  if (!gen) throw new Error(`Generator "${state.generator}" is not registered`);
  const entity = gen.generate(state.params, seededRandom(state.seed || 1), ctx);
  if (id) entity.id = id;
  return entity;
}

/**
 * Short stable name for a state — for filenames, caches and "is this the same
 * tree?" comparisons. One-way, unlike the code: it identifies, it does not
 * rebuild.
 */
export function fingerprint(code: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b1;
  for (let i = 0; i < code.length; i++) {
    const c = code.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0").slice(0, 4);
}

/** Every declared parameter with its current value, for building a UI. */
export function readParams<P>(gen: EntityGenerator<P>, params: P): { spec: ParamSpec; value: unknown }[] {
  return gen.params.map((spec) => ({ spec, value: getParam(params, spec.path) }));
}
