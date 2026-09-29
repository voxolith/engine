// A fast 64-bit content hash for cache keys, in plain JS (workers and bun alike).
//
// Two murmur3-style lanes over 32-bit words, each lane taking every other word, finished with
// murmur3's fmix32 and the length. It is not cryptographic: it only has to tell apart the inputs
// one page caches (tens of models and static sets), where 64 bits make a collision negligible.
// About 30 ms per 100 MB in bun, so hashing a big model costs a small fraction of encoding it.
//
// Incremental: feed typed arrays in order with `add`, then `digest`. Words are read in the
// platform's byte order (little-endian everywhere Voxolith runs); the key is only ever compared
// with keys made on the same machine's cache.

const C1 = 0xcc9e2d51, C2 = 0x1b873593;

function fmix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** An incremental 64-bit content hash. @internal */
export class Hasher {
  private h1 = 0x9e3779b1 | 0;
  private h2 = 0x85ebca77 | 0;
  /** Words mixed so far. */
  private n = 0;
  /** A word waiting for its partner lane (odd count so far). */
  private odd: number | undefined;
  private readonly tail = new Uint8Array(4);
  private tailLen = 0;

  /** Mix `words` 32-bit words. */
  private words(w: Uint32Array): void {
    let h1 = this.h1, h2 = this.h2, i = 0;
    const n = w.length;
    if (this.odd !== undefined && n > 0) {
      h2 = lane2(h2, w[0]);
      this.odd = undefined;
      i = 1;
    }
    const pairs = i + ((n - i) & ~1);
    for (; i < pairs; i += 2) {
      let k1 = Math.imul(w[i], C1);
      k1 = (k1 << 15) | (k1 >>> 17);
      h1 ^= Math.imul(k1, C2);
      h1 = (Math.imul((h1 << 13) | (h1 >>> 19), 5) + 0xe6546b64) | 0;
      let k2 = Math.imul(w[i + 1], C2);
      k2 = (k2 << 17) | (k2 >>> 15);
      h2 ^= Math.imul(k2, C1);
      h2 = (Math.imul((h2 << 13) | (h2 >>> 19), 5) + 0x561ccd1b) | 0;
    }
    if (i < n) {
      let k1 = Math.imul(w[i], C1);
      k1 = (k1 << 15) | (k1 >>> 17);
      h1 ^= Math.imul(k1, C2);
      h1 = (Math.imul((h1 << 13) | (h1 >>> 19), 5) + 0xe6546b64) | 0;
      this.odd = 1;
    }
    this.h1 = h1;
    this.h2 = h2;
    this.n += n;
  }

  /** Feed the bytes of a typed array (or a plain buffer). */
  add(a: ArrayBufferView | ArrayBuffer): this {
    let b = a instanceof ArrayBuffer ? new Uint8Array(a) : new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    // Complete a pending partial word first.
    while (this.tailLen > 0 && b.length > 0) {
      this.tail[this.tailLen++] = b[0];
      b = b.subarray(1);
      if (this.tailLen === 4) {
        this.words(new Uint32Array(this.tail.slice().buffer));
        this.tailLen = 0;
      }
    }
    const whole = b.length & ~3;
    if (whole) {
      const w = b.byteOffset % 4 === 0 ? new Uint32Array(b.buffer, b.byteOffset, whole / 4) : new Uint32Array(b.slice(0, whole).buffer);
      this.words(w);
    }
    for (let i = whole; i < b.length; i++) this.tail[this.tailLen++] = b[i];
    return this;
  }

  /** Feed a string (UTF-16 code units, with its length first so that concatenations differ). */
  str(s: string): this {
    const w = new Uint32Array(s.length + 1);
    w[0] = s.length;
    for (let i = 0; i < s.length; i++) w[i + 1] = s.charCodeAt(i);
    return this.add(w);
  }

  /** Feed numbers, as float64 bit patterns (so -0, NaN and fractions all count). */
  num(...v: number[]): this {
    return this.add(new Float64Array(v));
  }

  /** The 64-bit digest as 16 hex digits. The hasher can keep being fed afterwards. */
  digest(): string {
    let h1 = this.h1, h2 = this.h2;
    if (this.tailLen) {
      const t = new Uint8Array(4);
      t.set(this.tail.subarray(0, this.tailLen));
      h1 ^= new Uint32Array(t.buffer)[0] ^ this.tailLen;
    }
    const len = this.n * 4 + this.tailLen;
    h1 ^= len;
    h2 ^= Math.floor(len / 4294967296);
    h1 = (h1 + h2) | 0;
    h2 = (h2 + h1) | 0;
    h1 = fmix(h1);
    h2 = fmix(h2);
    h1 = (h1 + h2) | 0;
    h2 = (h2 + h1) | 0;
    return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
  }
}

function lane2(h2: number, w: number): number {
  let k2 = Math.imul(w, C2);
  k2 = (k2 << 17) | (k2 >>> 15);
  h2 ^= Math.imul(k2, C1);
  return (Math.imul((h2 << 13) | (h2 >>> 19), 5) + 0x561ccd1b) | 0;
}
