# sky and fog

how the viewer draws the sky, the layers beyond the atmosphere and the fogs that
[game-data/sky-and-fog.md](../game-data/sky-and-fog.md) describes. the passes are listed in
[frame.md](frame.md) and [post-processing.md](post-processing.md#post-chain).

## sky

[`atmosphere.wgsl`](../../packages/viewer/src/render/sky/atmosphere.wgsl)
([`atmosphere-luts.ts`](../../packages/viewer/src/render/sky/atmosphere-luts.ts)) builds the
transmittance, multiple-scattering and per-frame sky-view LUTs of the
[atmosphere model](../game-data/sky-and-fog.md#sky). the game's LUT scale (`skyViewScale` in
[`environment/derive.ts`](../../packages/viewer/src/environment/derive.ts)) is applied when
[`sky.wgsl`](../../packages/viewer/src/render/sky/sky.wgsl) samples the LUT rather than when it's
rendered, which comes to the same. the sky-view LUT has no ground bounce below the horizon (only the
multiple-scattering LUT takes the ground albedo), and the global colour adjustment is left out. at
Power Plateau's overcast the sky stays 15–20 sRGB levels brighter than an in-game shot, while Wuling
City's matches.

the cloud panorama is drawn in the celestial pass (see
[beyond the atmosphere](#beyond-the-atmosphere)), with contrast and rotation applied as authored and
its tint raw. the cloud flow isn't read, so it never moves.

## sun disc

the disc is drawn in [`celestial.wgsl`](../../packages/viewer/src/render/sky/celestial.wgsl),
following the [game's lobe](../game-data/sky-and-fog.md#sun-disc), unchecked against an in-game shot
facing the sun.

## beyond the atmosphere

where the game shades these layers inside its one sky-dome draw, the viewer renders them per sky
pixel in a pass of its own ([`celestial.wgsl`](../../packages/viewer/src/render/sky/celestial.wgsl),
drawn by [`render/sky/celestial.ts`](../../packages/viewer/src/render/sky/celestial.ts) from the
look [`environment/celestial-look.ts`](../../packages/viewer/src/environment/celestial-look.ts)
derives), and the composite puts them over the atmosphere's sky before fogging it:
`sky · (1 − cover) + layers`. the cloud panorama is drawn in the same pass so it can sit between the
layers in the [game's order](../game-data/sky-and-fog.md#beyond-the-atmosphere).

- **the ray-traced planet**: `environment/celestial-look.ts` copies its parameters from the
  `HGRP/Planet/PlanetBillboard` material, linearising the colours. its light is the viewer's
  pre-exposed sun; which light the game gives it in a space level is unchecked.
- **sky planets**: the body's frame hands its right vector to the shader as "forward" and its
  forward as "right", as the game does. the viewer always adds the planets, whatever their
  `_BlendMode`, and doesn't thin the stars behind their rings.
- the moon's sky-wide ring and the aurora aren't drawn.

none of the layers is checked against an in-game shot.

## fog

the analytic fogs are applied in [`sky.wgsl`](../../packages/viewer/src/render/sky/sky.wgsl) by the
composite (opaque surfaces and sky) and water passes. the height fog's packed base-2 units are
`FOG_UNIT` in [`environment/derive.ts`](../../packages/viewer/src/environment/derive.ts).

the volumetric fog's froxels are computed each frame by a compute pass
([`render/sky/volumetric-fog.ts`](../../packages/viewer/src/render/sky/volumetric-fog.ts)). it
slices depth as the game does, but with the quality presets unrecovered it takes Unreal's defaults
for the rest: a fixed 160 × 90 × 64 grid, 32 slices per doubling and 90 % history. its sky term
takes the ambient probe without the native diffuse-ambient scale. local fog volumes and the
volumetric light's flow noise aren't drawn.

- the height fog's start distance and inscatter colour belong to the far fog while the volumetric
  fog is on; drawn alone with them, the height fog would put a hard, bright fog wall at the start
  distance inside caves.
- where the last frame's grid didn't cover a froxel, the viewer takes this frame's sample alone; the
  game averages several jittered samples there instead.
- without the history, a sun shadow edge turns each froxel (a dozen pixels across on a
  2000-pixel-wide view) fully lit or fully dark, and the temporal antialiasing can't average a
  pattern that coarse.

## flow noise

the viewer sways the fog in the composite, on opaque surfaces only (not the sky), where the game
does it in its deferred lighting after all the fog. the noise texture comes packed once as the
environment table's `flowNoise`.

the "drifting fog" toggle turns it off. it drifts by the viewer's animation clock, so it pauses when
the view idles or "animate" is off ([performance](performance.md)).
