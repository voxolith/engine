// Messages between the generator pool and its workers.
//
// Kept in its own module so both sides agree on the shape without the worker
// side pulling in the pool, or vice versa.

import type { Entity } from "../entity";

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
}

export type WorkerRequest = GenerateRequest;

export type WorkerResponse =
  /** Sent once when the worker has registered its generators and can serve. */
  | { kind: "ready"; generators: string[] }
  | { kind: "ok"; id: number; entity: Entity }
  | { kind: "error"; id: number; message: string };
