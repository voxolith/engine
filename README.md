<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/voxolith/.github/main/profile/lockup-dark.svg">
    <img alt="Voxolith — WebGPU voxel engine" src="https://raw.githubusercontent.com/voxolith/.github/main/profile/lockup.svg" width="420">
  </picture>
</p>

# @voxolith/engine

Entities for the [Voxolith](https://github.com/voxolith/renderer) voxel engine: the model contract,
the generator registry, an authoring toolkit and a headless preview renderer.

An **entity** is a voxel model with an anchor and named colour **roles**, produced either from a
`.vox` file or by a generator package such as
[`@voxolith/gen-tree`](https://github.com/voxolith/gen-tree).

```ts
import { PaletteAllocator, blitModel } from "@voxolith/engine";
import { entityFromVox, entityToVox } from "@voxolith/engine/vox";

const tree = entityFromVox(await (await fetch("oak.vox")).arrayBuffer(), { kind: "tree" });
const palette = new PaletteAllocator();
const { base } = palette.allocateFor(tree);
blitModel(world, tree.model, { x: 64, y: 0, z: 64 }, base);
renderer.updatePalette(palette.buildPalette());
```

## Roles, not colours

Voxel values are role indices, and the host maps role `r` of an entity to palette slot
`base + r - 1`. One scene can then mix many entities inside the renderer's single 256-slot palette,
and an entity can be restyled — season, faction, damage — without regenerating its geometry.

## Entry points

| import | contents |
|---|---|
| `@voxolith/engine` | entity and generator contracts, registry, palette allocation, placement |
| `@voxolith/engine/build` | authoring toolkit: dense volumes, voxel primitives, vectors, seeded noise |
| `@voxolith/engine/preview` | CPU renderer and contact sheets (Node/bun only) |
| `@voxolith/engine/vox` | MagicaVoxel import and export |

## The authoring toolkit

`Volume` is a dense working grid with cropping, surface queries and a 6-connected flood, which is
how a generator proves its output is one piece. `capsule` rasterises tapered limbs exactly;
`line3` walks thin ones with a 3D DDA so they stay 6-connected. `makeNoise` is the shared seeded
value noise.

## The preview renderer

Headless rendering for generator work: a DDA raymarcher with coarse empty-space skipping, a sun
shadow ray, face ambient occlusion and a ground plane, plus captioned contact sheets and a PNG
writer. Shadow and occlusion are not decoration — without them a canopy cannot be judged.

## Development

```sh
bun install
bun run typecheck
```

## License

MIT
