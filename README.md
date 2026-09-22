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
| `@voxolith/engine/vox` | MagicaVoxel import and export |
| `@voxolith/engine/worker` | off-thread generation pool |

## Authoring lives with the generators

The engine consumes baked models: it places, orients, palettes, streams and blits them, and it
holds the generator *contract* (`EntityGenerator`, `ParamSpec`, the registry, share codes) so a
host can build a model from a seed at runtime. It does not author them. The toolkit generators are
written with (dense volumes, rasterisers, noise, branch growth, canopy carving, rock masses) and
the headless preview renderer are
[`@voxolith/gen-kit`](https://github.com/voxolith/generators/tree/main/kit), in the generators repo.

## Development

```sh
bun install
bun run typecheck
```

## License

MIT
