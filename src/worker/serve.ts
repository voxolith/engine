// Worker side of the generator pool.
//
// A consumer's worker file is three lines: import the generator packages it
// wants (which registers them), then call serveGenerators(). Generators are
// pure and take all their randomness from an injected rng, so they are
// worker-safe as written — nothing in them touches the DOM or shared state.
//
//   // gen.worker.ts
//   import { registerTreeGenerators } from "@voxolith/gen-tree";
//   import { serveGenerators } from "@voxolith/engine/worker";
//   registerTreeGenerators();
//   serveGenerators();
//
// The registry has to be populated in the worker itself: a function cannot be
// posted across the boundary, so the pool sends a generator *id* and the worker
// resolves it locally.

import { seededRandom } from "@voxolith/renderer/core";
import type { Entity } from "../entity";
import { getGenerator, listGenerators } from "../generator";
import type { WorkerRequest, WorkerResponse } from "./protocol";

/** Minimal shape of the worker global, so this file needs no DOM lib. */
interface WorkerScope {
  onmessage: ((ev: { data: WorkerRequest }) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
}

/**
 * Transferring a buffer detaches it, which is what makes handing a model back
 * free rather than a copy — but only when the array owns its whole buffer. A
 * view into a larger buffer would take unrelated data with it, so those are
 * copied instead.
 */
function transferables(entity: Entity): Transferable[] {
  const out: Transferable[] = [];
  const own = (a: Uint8Array) => a.byteOffset === 0 && a.byteLength === a.buffer.byteLength && a.byteLength > 0;
  const d = entity.model.data;
  if (own(d)) out.push(d.buffer);
  // A sparse model is a map of 512-byte bricks; each is its own buffer.
  if (entity.model.sparse) for (const b of entity.model.sparse.bricks.values()) if (own(b)) out.push(b.buffer);
  if (entity.model.bones && own(entity.model.bones)) out.push(entity.model.bones.buffer);
  return out;
}

/**
 * Serve generate requests on this worker until it is terminated. Call after
 * registering the generators this worker should offer.
 */
export function serveGenerators(scope: WorkerScope = self as unknown as WorkerScope): void {
  scope.onmessage = (ev) => {
    const req = ev.data;
    if (!req || req.kind !== "generate") return;
    try {
      const gen = getGenerator(req.generator);
      if (!gen) {
        throw new Error(
          `Generator "${req.generator}" is not registered in this worker. ` +
            `Registered: ${listGenerators().map((g) => g.id).join(", ") || "none"}`,
        );
      }
      const entity = gen.generate(req.params as never, seededRandom(req.seed), req.ctx);
      if (req.entityId) entity.id = req.entityId;
      scope.postMessage({ kind: "ok", id: req.id, entity }, transferables(entity));
    } catch (err) {
      scope.postMessage({
        kind: "error",
        id: req.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
  scope.postMessage({ kind: "ready", generators: listGenerators().map((g) => g.id) });
}
