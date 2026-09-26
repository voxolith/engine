<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/voxolith/.github/main/profile/lockup-dark.svg">
    <img alt="Voxolith — WebGPU voxel engine" src="https://raw.githubusercontent.com/voxolith/.github/main/profile/lockup.svg" width="420">
  </picture>
</p>

# @voxolith/engine

The layer between the [Voxolith](https://github.com/voxolith/renderer) renderer and an app. It
holds the **entity**, a voxel model with an anchor and named colour **roles** (voxel values are
role indices, and the host maps role `r` to palette slot `base + r - 1`, so one scene mixes many
entities and an entity restyles for a season, faction or damage without regenerating), and
everything a host does with one: palette it, orient it, place it, stream it, draw it by reference,
move it, animate it. It also holds the generator *contract* (`EntityGenerator`, `ParamSpec`, the
registry, share codes), so a host can build a model from a seed at runtime, plus input, animation
and atmosphere. The engine consumes baked models and never authors them: the authoring toolkit
and the headless preview renderer are
[`@voxolith/gen-kit`](https://github.com/voxolith/generators/tree/main/kit), beside the generators.

## Install

The package is **not on npm yet**. Until it is, clone it next to `voxolith/renderer` and your app
and link them from a bun workspace (`"@voxolith/engine": "workspace:*"`); the
[installation guide](https://voxolith.github.io/docs/getting-started/installation/) has the
layout. Once published:

```sh
bun add @voxolith/engine @voxolith/renderer
```

## Quick start

```ts
import { PaletteAllocator, blitModel } from "@voxolith/engine";
import { entityFromVox } from "@voxolith/engine/vox";

const tree = entityFromVox(await (await fetch("oak.vox")).arrayBuffer(), { kind: "tree" });
const palette = new PaletteAllocator();
const { base } = palette.allocateFor(tree);
blitModel(world, tree.model, { x: 64, y: 0, z: 64 }, base);
renderer.updatePalette(palette.buildPalette());
```

## Entry points

| import | contents |
|---|---|
| `@voxolith/engine` | entity and generator contracts, registry, share codes, palette allocation, orientation, placement, chunked worlds, instance layers, brick stamping (runtime-safe: no DOM, no GPU) |
| `@voxolith/engine/vox` | MagicaVoxel import and export |
| `@voxolith/engine/worker` | off-thread generation pool, with an optional IndexedDB model cache |
| `@voxolith/engine/animation` | rigs and clips: play (`makeAnimator`), pose, bake posed models, damage (`wound`, `sever`), pose cache, crowds |
| `@voxolith/engine/atmosphere` | time of day and weather as configuration: `timeOfDay`, `Atmosphere` presets, blending and transitions, `atmosphereFrame` into the renderer's settings |
| `@voxolith/engine/input` | desktop and mobile input: pointers, keys, wheel, pointer lock, gamepad, gestures, actions, touch controls, orbit and look controllers (DOM only) |

## Documentation

The long-form material lives on the documentation site, in the
[engine section](https://voxolith.github.io/docs/engine/), which also covers share codes,
stamping and crowds, workers and `.vox`:

- [Entities and roles](https://voxolith.github.io/docs/engine/entities-and-roles/): the entity shape, roles, palettes, sparse models
- [The generator contract](https://voxolith.github.io/docs/engine/generator-contract/): `EntityGenerator`, `ParamSpec`, the registry, scales
- [Placement and worlds](https://voxolith.github.io/docs/engine/placement-and-worlds/) and [Instances](https://voxolith.github.io/docs/engine/instances/): orientations, chunked worlds, drawing by reference
- [Input](https://voxolith.github.io/docs/engine/input/): one input per surface, gestures, actions, touch controls, camera controllers
- [Animation](https://voxolith.github.io/docs/engine/animation/): rigs, clips, baking by inverse mapping, damage
- [Atmosphere](https://voxolith.github.io/docs/engine/atmosphere/): time of day, weather presets, transitions
- [API reference](https://voxolith.github.io/docs/engine/api/): every export, generated from the source

## Development

```sh
bun install
bun run typecheck
bun run verify
```

## References

Instances with parts (renderer) and rigged crowds (engine) pose animated voxel models on the GPU
from one shared rest model, following the rest-space animation of:

- Holger Gruen, Carsten Benthin, Michael Kern, David McAllister. *Ray Tracing Massive Amounts of
  Animated Geometry.* Proc. ACM Comput. Graph. Interact. Tech. 9(4), Article 49 (HPG 2026).
  [doi:10.1145/3820014](https://doi.org/10.1145/3820014)
- Chih-Chen Kao, Grzegorz Makowski, Shin Fujieda, Takahiro Harada. *Voxel Deformation-Aware Neural
  Intersection Function.* Eurographics 2026 Short Papers.
  [doi:10.2312/egs.20261026](https://doi.org/10.2312/egs.20261026)

What was taken and what is Voxolith's own: [Research and credits](https://voxolith.github.io/docs/credits/).

## License

MIT
