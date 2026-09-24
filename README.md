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
| `@voxolith/engine` | entity and generator contracts, registry, palette allocation, placement (runtime-safe: no DOM, no GPU) |
| `@voxolith/engine/vox` | MagicaVoxel import and export |
| `@voxolith/engine/worker` | off-thread generation pool |
| `@voxolith/engine/animation` | rigs and clips: play (`makeAnimator`), pose, bake posed models, damage (`wound`, `sever`), pose cache, crowds |
| `@voxolith/engine/atmosphere` | time of day and weather as configuration: `timeOfDay`, `Atmosphere` presets, blending and transitions, `atmosphereFrame` into the renderer's settings |
| `@voxolith/engine/input` | desktop and mobile input: pointers, keys, wheel, pointer lock, gamepad, gestures, actions, touch controls, orbit and look controllers (DOM only) |

## Authoring lives with the generators

The engine consumes baked models: it places, orients, palettes, streams and blits them, and it
holds the generator *contract* (`EntityGenerator`, `ParamSpec`, the registry, share codes) so a
host can build a model from a seed at runtime. It does not author them. The toolkit generators are
written with (dense volumes, rasterisers, noise, branch growth, canopy carving, rock masses) and
the headless preview renderer are
[`@voxolith/gen-kit`](https://github.com/voxolith/generators/tree/main/kit), in the generators repo.

## Input

One `createInput(el)` per surface owns every listener; everything else reads from it, so two
controls can share a canvas and the whole lot disposes in one call. Layers, each built on the
one before:

- **`createInput`**: Pointer Events (mouse, pen, touch) with capture; keys by `code` with a
  focus guard and release-on-blur; wheel normalised across `deltaMode`s, ctrl+wheel reported as a
  trackpad pinch; pointer lock; the first gamepad (standard mapping, radial deadzone); a virtual
  channel for on-screen controls. Pass `{ loop }` and every event invalidates it; render
  continuously while `input.active()`.
- **`recogniseGestures`**: tap, double-tap, long-press, drag, pinch. Tap versus drag is decided
  on total travel, so a slow pan is never a click; a second finger turns a drag into a pinch.
  Recognisers on one input take a `priority` and can `claim` a pointer.
- **`makeActions`**: named buttons and axes over `key:`, `pad:` and `touch:` sources, so game
  code asks for `jump`, not Space. Bindings round-trip as JSON for rebinding.
- **`makeTouchControls`**: a floating joystick and buttons feeding `touch:` sources, shown once a
  touch is seen and hidden on mouse, keyboard or gamepad. Themed by `--vx-control-bg`,
  `--vx-control-fg` and `--vx-control-active`.
- **`makeOrbitController`** (turntable, clamped room, RTS map) and **`makeLookController`**
  (first person: pointer lock, drag on touch, right stick, turn keys). Their state is what
  `makeCamera` and `firstPersonFrame` take.

```ts
import { createInput, makeOrbitController, prepareSurface } from "@voxolith/engine/input";

prepareSurface(canvas); // no browser pan/zoom, selection or tap flash over it
const input = createInput(canvas, { loop });
const orbit = makeOrbitController(input, { distance: 200, distanceLimits: [40, 600], pan: "secondary" });
// in the frame: camera(orbit.yaw(), orbit.distance(), orbit.target(), orbit.pitch())
```

## Animation

Rigged entities (optional on the contract) carry `model.bones` (a bone per voxel), `rig` and
`clips` (quaternion tracks per bone at 12 fps, a root offset, events such as footfalls).
`@voxolith/engine/animation` is headless and pure:

- `makeAnimator(entity)` plays clips with crossfades and reports events; `poseMatrices` turns a
  pose into one rigid matrix per bone.
- `bakePose(model, rig, matrices, { yaw })` produces the posed voxel model by **inverse mapping**
  (every cell of a bone's posed box is taken back to rest space), so rotated limbs stay solid at
  any angle; a crack pass closes joints, and `rig.cover` draws flesh a pose uncovers as fur.
  About 0.6 ms for the 3.5k-voxel rat.
- `wound` carves the rest model to expose its inside; `sever` cuts a bone's subtree off as its own
  model and sub-rig, for a game to throw.
- `makePoseCache`, and `makeCrowd`, which poses, caches and stamps many members on a budget: full
  rate near the camera, stepped like sprite animation beyond `near`, frozen beyond `freeze`, a
  millisecond budget for new bakes.

Movers reach the world through `makeBrickStamper` (main barrel): per brick it keeps exactly the
cells it overwrote and restores them inside the same edit that writes the movers' new positions,
so things move through a streamed world with no dense copy; `Renderer.editMany` uploads a
frame's bricks in one go.

Measured headless (`bun run --cwd generators/creature bench`: CPU per frame for the crowd update
and brick edits, not the upload or the draw), rats wandering a 512x512 field at 60 Hz:

| rats | ms/frame | bakes/frame | bricks/frame | upload KB/frame |
|---|---|---|---|---|
| 10 | 0.4 | 0.1 | 52 | 15 |
| 100 | 2.8 | 0.6 | 515 | 145 |
| 500 | 15.5 | 1.0 | 2347 | 660 |
| 1000 | 37.9 | 1.2 | 4293 | 1207 |

Past a few hundred, brick re-encoding dominates. The next step is a dynamic entity layer on the
GPU (instances with their own transform), which removes both the re-encode and the upload.

## Atmosphere

The renderer draws raw atmospheric effects and knows nothing about weather; a game decides
whether there is weather and when it changes. `@voxolith/engine/atmosphere` sits between, with
no simulation and no clock of its own:

- `timeOfDay(phase)`: the lighting half of `FrameParams` for a time of day (0 midnight, 0.5 noon).
  By day the key light follows the sun; at night it becomes a dim blue moonlight.
- `Atmosphere`: cloud, precipitation (none, rain or snow, and intensity), wind, fog, and the
  ground's `wetness` and snow `cover`. `ATMOSPHERES` has presets (`clear`, `cloudy`, `overcast`,
  `rain`, `storm`, `snow`, `blizzard`, `fog`).
- `blendAtmosphere`, `makeAtmosphereTransition` (eased, from wherever it is now), and `approach`
  for a game's own accumulators: rain soaking the ground, snow settling, things drying.
- `atmosphereFrame(lighting, atmosphere)`: the renderer's settings. Overcast dims and flattens the
  key light and greys the sky, fog takes the horizon's colour, wind tilts the rain and drives the
  clouds and the water. Clear weather passes the lighting through unchanged.

```ts
import { atmosphereFrame, ATMOSPHERES, timeOfDay } from "@voxolith/engine/atmosphere";

renderer.render({ ...camera, ...atmosphereFrame(timeOfDay(0.5), { ...ATMOSPHERES.rain, wetness: 0.7 }), time });
```

## Development

```sh
bun install
bun run typecheck
```

## License

MIT
