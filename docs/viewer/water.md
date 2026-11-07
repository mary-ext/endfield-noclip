# water

how the viewer draws the open-world water that [game-data/water.md](../game-data/water.md)
describes: [water-renderer.ts](../../packages/viewer/src/render/water/water-renderer.ts) and
[water.wgsl](../../packages/viewer/src/render/water/water.wgsl). the packed table is in
[package-format.md](../package-format.md#water).

## placements

surfaces are resident in the game, so the whole water table is in the core archive and every surface
is always available. each frame the viewer selects the surfaces whose visibility group shows (its
scene states active, whichever level owns it) and whose geometry entry is ready. each wants its
geometry blob at a priority falling with horizontal distance from the camera, in view or not, so
like the game's the shown surfaces stay resident (map02's 1310 share 392 meshes of 0.6 MiB packed);
resident ones inside the frustum are drawn, up to 4096.

## surface meshes

the vertex stage reads the dequantized `unorm16x4` positions and, for surfaces whose `meshNormals`
is set and whose mesh has them, its octahedral normals; other surfaces face straight up. the packer
sets `meshNormals` on proxy-only surfaces only, standing in for the game's upward-facing grid
([how surfaces are drawn](../game-data/water.md#how-surfaces-are-drawn)); this also hides the
polygon meshes' downward-facing triangles. transforms are made eye-relative on the CPU.

## `Global_Water_Config`

the wave-normal array, the global flow map and the caustic map are streamed whole. the sector tiles
and the rain map are packed but not bound: flow and foam come from the global map everywhere.

## shading

the viewer computes the [game's shading](../game-data/water.md#shading) per fragment in one pass,
where the game writes a G-buffer and lights it full-screen after the opaque scene:

- **pass**: drawn in the post chain after compositing, over a copy of the HDR scene, and only in the
  `lit` debug view. both faces are drawn so water reads from below. only the nearest surface at a
  pixel shades, as in the game's G-buffer, so a surface under another stays hidden (Wuling's stream
  slopes run beneath its river plane).
- **effects over it**: the game lights its water before drawing transparent things, and its camera
  depth holds the scene without the water ([game data](../game-data/water.md#waterdecal)), so they
  presumably show over the water even below its surface (unchecked against an in-game shot). the
  viewer does the same: the water draws before the [transparent pass](frame.md), which tests the
  main pass's depth, without the water. before the composite, the water's surfaces lay down the
  nearest one's depth (`SceneTextures.waterDepth`, from `fs_water_depth`, less the fragments the
  shading drops behind the scene), which the shading tests against so only that surface shades.
- **lighting**: the pass binds the main pass's frame group, so water is lit like the rest of the
  scene: the sun through its shadow maps, the irradiance volume, and the level's sky reflection.
- **reflection**: the game reflects water through its screen-space reflection pass, with water
  written into its inputs. water draws after the composite here, so it marches separately, with the
  same march ([`ssr-trace.wgsl`](../../packages/viewer/src/render/water/ssr-trace.wgsl)).

it differs from the game in that:

- LOD surfaces face up at every distance, where the game shades them around their mesh normals
  beyond its grid's reach; the grid's wave displacement isn't drawn
- back faces are drawn, where the game culls them
- the sun highlight isn't aimed at the nearest point of the sun's disc and has no multiple
  scattering, and the direct light is divided by π like the viewer's other sun terms
  ([sun](lighting.md#sun))
- `FlowmapOption` 1's coverage mask isn't applied (the waves take full amplitude there); no map02
  config sets it
- configs are bound by asset, so two that share a `materialIndex` keep their own looks, where the
  game shades both with the one loaded last
- water isn't in the reflection march's depth, so a ray towards another, higher water surface
  (terraced pools, rivers) hits its bed
- rain, character ripples, the wetness the water leaves on the ground around it and the TAA hint
  aren't drawn

## water volumes

[water-levels.ts](../../packages/viewer/src/scene-states/water-levels.ts) holds each
[water volume](../game-data/water.md#water-volumes)'s fill. a volume's surface is packed at its
authored fill; the water renderer raises its transform and bounds by the difference, and the
floaters' instance rows (an instance block's `floaters` section names each row's volume) move by the
same amount, in the CPU copy the selection culls with and on the GPU. a block's floating rows are
tracked from when it's uploaded until it's released, so the section's "floating parts" count is of
the rows loaded.

the "Water levels" section of the scene conditions panel
([water-levels.tsx](../../packages/viewer/src/ui/scene-controls/water-levels.tsx)) lists the volumes
that scripts move and the [pools the player pumps](../game-data/water.md#depletable-pools), the
current level's first and the others under their levels, each a select over its `waterLevel` scene
control with what sets each fill, its surface's height and "Go" to fly over it (`waterHeight`,
`surfaceView` in water-levels.ts). the viewer moves each volume to the fill its control's value
picks, linearly at the speed the scripts move it at (else the volume's fill speed), so Suiming's
stages take their two or three minutes; "Movement" speeds that up or jumps. a volume following
another sits at its parent's surface within its own depth. a package's defaults and "Reset" (which
drops the picks with every other control's) put each volume at its default fill at once, so a pool a
finished story drained starts drained.

it differs from the game in that:

- a volume that names no config draws with its water type's
  [surface prefab](../game-data/water.md#water-volumes) config (resolved by
  [water-volume-surfaces.ts](../../packages/extractor/src/game/water/water-volume-surfaces.ts)); the
  prefab's foam decal and its per-level multipliers aren't drawn, and the outline is always
  triangulated, where the game loads the volume's prebuilt `_WaterSurface` mesh of the same outline
- moves are linear: the game's ease over the last metres, and the eased moves of scripts that don't
  fix the speed, aren't reproduced (those use the fill speed as metres per second)
- floaters keep their authored height above the surface instead of settling to `surface_offset`, and
  follow it without lag
- nothing is triggered: the switches, clocks and quests that move volumes are listed by script id in
  the level labels, not run
- `ground_distance`, `isPrototype`, the volume's own flow speed and direction, and amount-based
  transfers aren't read
- a volume coinciding with a placed surface (five map02 lv006 pools, lv010's 37900010002, several
  lv002/lv003 ones) draws twice; whether the game draws both isn't checked
- a volume's surface leaves no wetness on the shore

## WaterProxy and WaterDecal

the mesh renderer skips the map02 river meshes that carry
[`HGRP/WaterProxy`](../game-data/water.md#waterproxy-and-waterdecal), since none of its passes draws
in the main view.

### foam boxes

[WaterDecal](../game-data/water.md#waterdecal) boxes are packed as `waterFoam` surfaces and drawn by
the mesh renderer's effect family (`fs_water_foam` in
[effect.wgsl](../../packages/viewer/src/render/meshes/effect.wgsl)), inside the water pass, when the
frame has any:

1. **water depth.** the nearest surface's depth, laid down before the composite (above).
2. **foam.** the boxes draw into an `rgba8unorm` target cleared to (0, 0, 0, 1), with the main
   pass's depth attached read-only for the game's `_ZTest` (`waterFoam`, `waterFoamBehind` and
   `waterFoamThrough` looks, one phase each), each covered pixel projecting the box onto the water
   depth. rgb takes the box's premultiplied foam plus what's there times one minus its alpha, and
   alpha the product of those factors. the material's mip bias scales the base colour map's and the
   mask's UV gradients, and the dissolve texture is read at its fixed level.
3. **shading.** the water reads the target at its pixel: foam colour `= rgb + saturate(own) · a`,
   saturated, the game's 8-bit clamp. the water's own foam is saturated too, with boxes or without.

materials with keywords beyond `_BLEND_BASECOLOR`, `_USE_DISTURB`, `_USE_MASK`, `_USE_SOFTBLEND` and
`_USE_DISSOLVE`, or a `_ZTest` other than 4, 5 or 8, show as
[unsupported](materials.md#unsupported-materials). it differs from the game in that the
per-placement `HGWaterDecalRenderer` values (and so the displacement pass) aren't packed (every
map02 prefab has the neutral ones), the static boxes of InitChunkData component 31 aren't packed
(they're counted in `debug/skipped-entities.json`), the soft blend's device depths use the viewer's
near plane, and the distortion texture's mip bias is left out (its material value is unidentified).
