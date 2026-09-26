// A cache of baked poses.
//
// Clips run at 12 frames a second and a creature's heading can be bucketed
// (16 directions is plenty at voxel scale), so a herd sharing a few variants
// and clips asks for the same few hundred poses over and over. Keyed by the
// caller (variant, clip, frame, yaw bucket, damage), least-recently-used out
// when the byte budget is exceeded.

/** A least-recently-used cache under a byte budget, from {@link makePoseCache}. */
export interface PoseCache<T> {
  /** The cached value for `key`, made (and counted as a miss) if absent. */
  get(key: string, make: () => T): T;
  /** The cached value if present (counted as a hit), without making one. */
  peek(key: string): T | undefined;
  /** Drop everything whose key starts with `prefix` (e.g. one damaged creature). */
  drop(prefix: string): void;
  /** Entries, estimated bytes held, and hits and misses since the last `resetStats`. */
  stats(): { entries: number; bytes: number; hits: number; misses: number };
  /** Zero the hit and miss counters. */
  resetStats(): void;
}

/**
 * Make a cache for baked poses (or anything else keyed by string). When the estimated size goes
 * over `maxBytes` (default 48 MiB) the least recently used entries are evicted. {@link makeCrowd}
 * makes one itself; make your own to share poses between crowds or to cache poses you bake by
 * hand.
 *
 * @param sizeOf - Estimated bytes of a value, counted against `maxBytes`.
 */
export function makePoseCache<T>(sizeOf: (value: T) => number, opts: { maxBytes?: number; /** Called for each value evicted or dropped (free what it holds). */ onEvict?: (key: string, value: T) => void } = {}): PoseCache<T> {
  const max = opts.maxBytes ?? 48 * 1024 * 1024;
  const evict = opts.onEvict;
  const map = new Map<string, { v: T; bytes: number }>();
  let bytes = 0, hits = 0, misses = 0;
  return {
    get(key, make) {
      const hit = map.get(key);
      if (hit) {
        // Refresh: Map keeps insertion order, so re-inserting makes it newest.
        map.delete(key);
        map.set(key, hit);
        hits++;
        return hit.v;
      }
      misses++;
      const v = make();
      const b = sizeOf(v);
      map.set(key, { v, bytes: b });
      bytes += b;
      for (const [k, e] of map) {
        if (bytes <= max || k === key) break;
        map.delete(k);
        bytes -= e.bytes;
        evict?.(k, e.v);
      }
      return v;
    },
    peek(key) {
      const hit = map.get(key);
      if (!hit) return undefined;
      map.delete(key);
      map.set(key, hit);
      hits++;
      return hit.v;
    },
    drop(prefix) {
      for (const [k, e] of map) if (k.startsWith(prefix)) { map.delete(k); bytes -= e.bytes; evict?.(k, e.v); }
    },
    stats: () => ({ entries: map.size, bytes, hits, misses }),
    resetStats() { hits = 0; misses = 0; },
  };
}
