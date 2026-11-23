// The bake-only view of the scene worker's protocol (./scene.ts): the messages a layer exchanges
// with a worker it was given as `placement`, which only bakes there.

import type { PlacementWorker, SceneRequest, SceneResponse } from "./scene";

/** A message to a worker that only bakes placements: the placement subset of {@link SceneRequest}. */
export type PlacementRequest = Extract<SceneRequest, { kind: "model" | "drop" | "bake" | "share" | "merge" | "cancel" }>;

/** A worker's answer to a `bake`: the placement subset of {@link SceneResponse}. */
export type PlacementResponse = Extract<SceneResponse, { kind: "progress" | "baked" | "split" | "shared" | "error" }>;

export type { PlacementWorker };
