// Model reuse: a few generated models, placed many times.
//
// Generating every instance of a species uniquely is what makes a large scene
// slow to build. Measured on the examples forest at 4x4, generation is 89.6% of
// the total build time — 10.8 of 12.1 seconds for 1120 entities — while
// placement is 2%. Cutting the number of models generated is therefore the only
// change to load time that matters.
//
// This is what vegetation systems do: SpeedTree ships a handful of variants per
// species rather than a unique tree per instance. A pool of `count` models, each
// placed in any of the eight axis-aligned orientations, gives `count * 8`
// distinct silhouettes for `count` generations.

import type { Entity } from "./entity";
import { ORIENTATIONS, type Orientation } from "./orient";

export interface Variant {
  entity: Entity;
  orientation: Orientation;
  /** Which pool slot this came from, for debugging and stats. */
  index: number;
}

export interface VariantPool {
  /** A model from the pool with a random orientation. Generates on first use. */
  pick(rng: () => number): Variant;
  /** A specific slot, still randomly oriented. */
  at(index: number, rng: () => number): Variant;
  /** How many models have actually been generated so far. */
  readonly generated: number;
  /** Pool size. */
  readonly size: number;
}

export interface VariantPoolOptions {
  /**
   * Distinct models to generate. Each is placed in any of 8 orientations, so
   * the apparent variety is 8x this. Around a dozen per species is plenty.
   */
  count: number;
  /**
   * Builds model `index`. Called at most once per index, lazily. Vary the
   * parameters by index — height, age, seed — so the pool is not 12 copies of
   * the same thing.
   */
  make: (index: number) => Entity;
}

/**
 * Lazily-filled pool of interchangeable models.
 *
 * Generation is deferred so a pool costs nothing until something is placed, and
 * a scene that ends up placing fewer entities than the pool size never pays for
 * the rest.
 */
export function makeVariantPool(opts: VariantPoolOptions): VariantPool {
  const count = Math.max(1, Math.floor(opts.count));
  const models: (Entity | null)[] = new Array(count).fill(null);
  let generated = 0;

  const ensure = (i: number): Entity => {
    let e = models[i];
    if (!e) {
      e = opts.make(i);
      models[i] = e;
      generated++;
    }
    return e;
  };

  const orient = (rng: () => number): Orientation =>
    ORIENTATIONS[Math.min(ORIENTATIONS.length - 1, (rng() * ORIENTATIONS.length) | 0)];

  return {
    pick(rng) {
      const index = Math.min(count - 1, (rng() * count) | 0);
      return { entity: ensure(index), orientation: orient(rng), index };
    },
    at(index, rng) {
      const i = ((index % count) + count) % count;
      return { entity: ensure(i), orientation: orient(rng), index: i };
    },
    get generated() {
      return generated;
    },
    get size() {
      return count;
    },
  };
}
