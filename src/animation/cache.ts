// A cache of baked poses.
//
// Clips run at 12 frames a second and a creature's heading can be bucketed
// (16 directions is plenty at voxel scale), so a herd sharing a few variants
// and clips asks for the same few hundred poses over and over. Keyed by the
// caller (variant, clip, frame, yaw bucket, damage), least-recently-used out
// when the byte budget is exceeded.

export interface PoseCache<T> {
  /** The cached value for `key`, made (and counted as a miss) if absent. */
  get(key: string, make: () => T): T;
  /** Drop everything whose key starts with `prefix` (e.g. one damaged creature). */
  drop(prefix: string): void;
  stats(): { entries: number; bytes: number; hits: number; misses: number };
  resetStats(): void;
}

export function makePoseCache<T>(sizeOf: (value: T) => number, opts: { maxBytes?: number } = {}): PoseCache<T> {
  const max = opts.maxBytes ?? 48 * 1024 * 1024;
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
      }
      return v;
    },
    drop(prefix) {
      for (const [k, e] of map) if (k.startsWith(prefix)) { map.delete(k); bytes -= e.bytes; }
    },
    stats: () => ({ entries: map.size, bytes, hits, misses }),
    resetStats() { hits = 0; misses = 0; },
  };
}
