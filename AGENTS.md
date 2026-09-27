# AGENTS.md: engine

`@voxolith/engine` sits between the renderer and apps. It owns:
- entities (a voxel model with an anchor and named colour roles);
- the generator contract and registry, and generator workers (`./worker`);
- placement, scatter and palettes;
- chunked streaming (`makeChunkedWorld`) and instance layers (`makeInstanceLayer`);
- input (`./input`), atmosphere (`./atmosphere`) and animation (`./animation`: rigs, clips,
  crowds, damage).

It never authors models: generators bake them, the engine consumes them.

## Commands

```sh
bun run --cwd engine typecheck
bun run --cwd engine verify   # verify, -input, -atmosphere, -animation, -dynamic, -instances, -load
```

CI (`ci.yml`, job `typecheck`) runs both, with `renderer` checked out alongside.

## Map

- `src/entity.ts`, `src/palette.ts` (`PaletteAllocator`), `src/generator.ts` (the
  `EntityGenerator` contract, `GenerateContext`, `refinement`), `src/share.ts` (share codes),
  `src/variants.ts`, `src/orient.ts` (`orientationYaw`).
- `src/chunks.ts` (streaming), `src/instances.ts` (the instance layer, `palettes.of`),
  `src/dynamic.ts` (`makeBrickStamper`: movers in a streamed world, keeping per brick only
  the cells it overwrote), `src/scatter.ts`, `src/sink.ts`, `src/vox.ts`.
- `src/worker/`: `makeGeneratorPool`, `serveGenerators({ cache })` (the IndexedDB model cache).
- `src/input/`: `createInput`, `prepareSurface`, orbit and look controllers, gestures, actions
  and touch controls.
- `src/atmosphere/`: `timeOfDay`, `ATMOSPHERES`, blending, `atmosphereFrame`.
- `src/animation/`: animator, pose, bake (`bakePose`), cache, crowd (`makeCrowd`), damage
  (`wound`, `sever`).
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
