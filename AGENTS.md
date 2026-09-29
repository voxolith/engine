# AGENTS.md: engine

`@voxolith/engine` sits between the renderer and apps. It owns:
- entities (a voxel model with an anchor and named colour roles);
- the generator contract and registry, and generator workers (`./worker`);
- placement, scatter and palettes;
- chunked streaming (`makeChunkedWorld`) and instance layers (`makeInstanceLayer`);
- input (`./input`), atmosphere (`./atmosphere`) and animation (`./animation`: rigs, clips,
  crowds, damage);
- the apps' service worker: a build-time Vite plugin (`./vite`) and its registration (`./pwa`).

It never authors models: generators bake them, the engine consumes them.

## Commands

```sh
bun run --cwd engine typecheck
bun run --cwd engine verify   # verify, -input, -atmosphere, -animation, -dynamic, -chunks, -instances, -load, -pool, -placement, -scene, -scene-cache, -pwa
```

CI (`ci.yml`, job `typecheck`) runs both, with `renderer` checked out alongside.

## Map

- `src/entity.ts`, `src/palette.ts` (`PaletteAllocator`), `src/generator.ts` (the
  `EntityGenerator` contract, `GenerateContext`, `refinement`), `src/share.ts` (share codes),
  `src/variants.ts`, `src/orient.ts` (`orientationYaw`).
- `src/chunks.ts` (streaming; `pendingWithin` / `readyAround` / `whenReady` for "built around a
  point"; `fill` takes a `ChunkFillSource` and applies chunks filled elsewhere, `columnBoxes`), `src/instances.ts` (the instance layer, `palettes.of`; `EntityPlacement.scale` draws a
  coarse model enlarged, one renderer model per model and scale, and a new static set releases
  the models the drawn one no longer names, after it draws: coarse first, one swap; a target with `beginEncodedModel` gets big models added in slices within `uploadBudgetMs` per frame, keys registered and baked only once a model is done),
  `src/dynamic.ts` (`makeBrickStamper`: movers in a streamed world, keeping per brick only
  the cells it overwrote), `src/scatter.ts`, `src/sink.ts`, `src/vox.ts`.
- `src/worker/`: `makeGeneratorPool` (priority, abort, pause, reprioritise; `destroy()` lets idle
  workers finish their cache writes), `serveGenerators({ cache })` (the IndexedDB model cache) and
  `openModelCacheControls` (inspect, clear, trim; the logic runs on a `CacheStore`, tested in memory).
  `maxBytes` is checked (`checkCacheCap`: not positive and finite throws) and watched
  (`watchCacheCap`: under 16 MiB, above the quota, an entry bigger than the cap warn once per cache).
  `makeChunkFillPool` / `serveChunks` (`chunks.ts`): ground chunks filled on workers from an
  opaque `init`, for `makeChunkedWorld({ fill })`.
  `makeSceneWorker` / `serveScene` (`scene.ts`): model encoding (`encodeModel`) and the static
  placement bake on one worker, for `makeInstanceLayer(target, { worker })` and
  `layer.commitAsync()`; the worker keeps each encoding's sub-cells, so registering it for
  placement sends only keys. `makePlacementWorker` / `servePlacement` (`placement.ts`) are its
  older, bake-only names (deprecated), for `{ placement }`.
  `serveScene({ cache })` keeps encodings and bakes in IndexedDB (`scene-cache.ts`, on the same
  `CacheStore` as the model cache; `openSceneCacheControls`): encodings by the model's identity
  (`makeInstanceLayer({ modelKey: pool.modelKey })`, or `hashModels`), bakes by a digest of the
  input and the models' placement data (`hash.ts`), stored `normalizePlacement`d and bound with `bindPlacement`, since the
  renderer numbers models by free slot. Generator workers post entities packed (`PackedEntity`,
  one transferred buffer); transferring one buffer per brick took seconds.
- `src/input/`: `createInput`, `prepareSurface`, orbit and look controllers, gestures, actions
  and touch controls.
- `src/atmosphere/`: `timeOfDay`, `ATMOSPHERES`, blending, `atmosphereFrame`.
- `src/animation/`: animator, pose, bake (`bakePose`), cache, crowd (`makeCrowd`), damage
  (`wound`, `sever`).
- `src/pwa/`: `vite.ts` (`serviceWorker()`, the plugin; type-only `vite` import), `sw.ts` (the
  worker's source as a template, internal), `index.ts` + `register.ts` (`registerServiceWorker`).
  `verify-pwa` runs the plugin on a fake bundle and the emitted `sw.js` on fake `caches`/`fetch`.
- `tools/verify-*.ts`: headless checks, one per area.

## Invariants

- **Voxel values are role indices, never colours.** A host maps role `r` to palette slot
  `base + r - 1`, so entities restyle without regenerating.
- **Generators are pure and deterministic.** All randomness comes from the injected rng. The
  engine must not add hidden state to generation.
- **Layering.** The renderer knows nothing about weather or meaning, and the engine holds no
  policy: whether and when there is weather, how wetness accumulates and what a game does belong
  to the app. `atmosphereFrame` translates the vocabulary into raw renderer effects.
- **Input.** Apps take all camera and movement input from `./input`, never raw listeners. The
  yaw conventions are fixed:
  - `firstPersonFrame` screen-right is `cross(forward, up)`, so turning right increases yaw;
  - an orbit camera's yaw decreases when dragging right.
  - `verify-input` drives it with synthetic events.
- **Import rules.** Browser code imports `@voxolith/renderer`; anything that runs in bun (tools,
  workers' pure parts) imports `@voxolith/renderer/core`.
- **Animation.**
  - Clips are quaternion tracks at 12 fps.
  - `bakePose` is the reference, and GPU posing must match it cell for cell (`verify-animation`).
  - Rigged models posed on the GPU have at most 32 parts.
  - Moving things go through `makeBrickStamper` (it restores what it overwrote) or `makeCrowd`
    (pose cache, bake budget, distance LOD).
- Cost knobs (quality presets, render scale, `makePerf`) live in the renderer and engine, not in
  apps; apps only offer UI for them.

## Working in the Voxolith repos

- **Layout.** Every Voxolith repo is checked out side by side under one bun workspace root, and
  depends on its siblings as `"workspace:*"`. Run `bun install` from that root, never inside a
  repo. [CONTRIBUTING](https://github.com/voxolith/.github/blob/main/CONTRIBUTING.md) lists
  which siblings each repo needs.
- **Toolchain: bun only.** There is no npm or node step anywhere. It is TypeScript 7 and Vite 8;
  scripts run `tsc`, `vite` and `bun tools/x.ts`. Use current dependency versions.
- **`tsconfig.base.json` is byte-identical in every repo**, because consumers compile the
  renderer's and engine's sources under their own flags. Change it everywhere or nowhere.
- **WebGPU, not WebGL.** Dev servers are HTTPS (`@vitejs/plugin-basic-ssl`), because WebGPU needs a
  secure context. Checks cannot see pixels: anything that changes what is drawn must be looked
  at in a WebGPU browser, with a before/after screenshot in the pull request.
- **Docs live on the site** ([voxolith.github.io](https://voxolith.github.io/docs/), repo
  `voxolith.github.io`). READMEs stay short and link there. The API reference is generated from
  the sources, so doc comments are published content: every exported symbol has a `/** */`, and
  entry files open with `@packageDocumentation`.
- **Credit research.** When an idea comes from a paper, cite it (authors, title, venue, DOI) in
  the code comment, in the docs (the page's References and `/docs/credits/`) and in the commit
  body. Check the citation against the paper or DataCite; don't cite from memory.
- **Prose.** British spelling in prose and comments (`colour`, `normalise`); identifiers follow the
  web platform (`lightColor`). "Voxolith" is capitalised in prose; lowercase is only for the
  wordmark.
- **Commits.** History is linear and read as prose:
  - The subject says what is now true, in plain words: no `feat:` prefixes, no trailing full
    stop, about 70 characters at most.
  - The body says why, what it costs and what it deliberately does not do, wrapped at about 72
    columns.
  - One change per commit. AI-assisted commits keep their `Co-Authored-By` trailer.
  - Pull requests are squash-merged or rebased; there are no merge commits.
  - Don't push, tag or publish unless asked.
- **Community files** (CONTRIBUTING with the AI policy, CODE_OF_CONDUCT, SECURITY, templates) live
  once in `voxolith/.github` and apply org-wide; don't copy them in here.
- **CI's job names are required checks** on `main` (rulesets). Renaming a job breaks merging.
