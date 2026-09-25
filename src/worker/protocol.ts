// Messages between the generator pool and its workers.
//
// Kept in its own module so both sides agree on the shape without the worker
// side pulling in the pool, or vice versa.

import type { Entity } from "../entity";
import type { GenerateContext } from "../generator";

export interface GenerateRequest {
  kind: "generate";
  /** Correlates a reply with its request. */
  id: number;
  /** `EntityGenerator.id`, looked up in the worker's own registry. */
  generator: string;
  params: unknown;
  /** Seeds the injected rng, so a request is reproducible. */
  seed: number;
  /** Optional id for the produced entity. */
  entityId?: string;
  /** Passed to the generator (a finer voxelsPerMetre, ...). */
  ctx?: GenerateContext;
}

export type WorkerRequest = GenerateRequest;

export type WorkerResponse =
  /** Sent once when the worker has registered its generators and can serve. */
  | { kind: "ready"; generators: string[] }
  | { kind: "ok"; id: number; entity: Entity; /** Loaded from the model cache rather than generated. */ cached?: boolean }
  | { kind: "error"; id: number; message: string };
