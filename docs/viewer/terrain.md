# terrain

how the viewer draws the terrain and foliage grids that [game-data/world.md](../game-data/world.md)
describes. which pages a frame selects and streams is in
[streaming.md](streaming.md#terrain-selection); the shader is
[`render/terrain/terrain.wgsl`](../../packages/viewer/src/render/terrain/terrain.wgsl).

## terrain

the baked surface pages ([terrain](../game-data/world.md#terrain)) are drawn as stored: albedo,
normal, roughness and occlusion; the `A` page's subsurface curvature isn't drawn. patches without a
resident surface page get a stand-in colour by slope. rain wetness applies on top, as on other
surfaces ([wetness](environment.md#wetness)).

[holes](../game-data/world.md#terrain) are cut as the game's base terrain pass cuts them: a triangle
touching a hole vertex isn't drawn at all. each vertex passes a hole flag on, and a fragment is
discarded unless the interpolated flag is exactly 0 (`in_hole`), which only a triangle of three
solid vertices gives. no share of such a triangle may be kept: most holes sit at the terrain's base
height, hundreds of metres down, so even a hundredth of one hangs a curtain several metres tall
below every edge of solid ground. the triangles are still rasterized before they're discarded.

which triangles a hole takes depends on how the quads are cut, so the patch grid (`gridIndices` in
[`terrain-renderer.ts`](../../packages/viewer/src/render/terrain/terrain-renderer.ts)) alternates
its diagonals by the page's sample parity as the game's patch does; stray solid samples among holes
then draw the same odd triangles as in the game, and no others.

### close-up layers

on leaves whose splat page and the package's layer textures are resident, `detail_surface` blends
the [close-up layers](../game-data/world.md#close-up-layers) and fades them into the baked page by
distance.

- **distances**: the fade runs from 96 to 144 m (`DETAIL_FADE_START`/`END` in the shader), and
  leaves within 160 m load their splat page (`DETAIL_DISTANCE`,
  [streaming](streaming.md#terrain-selection)). these are the viewer's choices; the game's are
  unknown.
- **weights**: `sample_control` keeps its filtering half a texel inside the 8 m cell, since the
  weights belong to that cell's layers.
- **projection**: the three planes are blended by the baked normal's `|n|⁸` weights instead of the
  game's random per-pixel pick, which would need temporal smoothing. layers sample with explicit
  gradients, so slots and planes without weight aren't sampled.
- **not drawn**: the cliff projection and the cone-map parallax; neither the `C` pages nor the
  `LAYER_C` cone maps are packed.
- **cost**: one measurement on an Apple M-series GPU at 1600×1000 showed about 7 ms added GPU time
  over open ground; the blend's individual costs are unprofiled.

### puddles

`wet_surface` applies the [puddle](../game-data/world.md#puddles) terms to the leaf's surface. the
ground the puddle level fills to moves from the layers' weighted height to the baked pages' flat 0.5
across the same distance fade as the close-up layers. only leaf `S` pages are packed, so puddles
stop where leaves stop loading their splat page; parallax layers' heights aren't used (their
settings aren't packed), and there are no ripples. the puddles' reflections come from the viewer's
screen-space reflections ([lighting](../game-data/lighting.md#screen-space-reflections)).

## foliage grids

grass and tree instances ([foliage grids](../game-data/world.md#foliage-grids)) arrive as ordinary
instance rows carrying their cluster's bounds, so a cluster culls and changes LOD as a whole, like
any other instance ([streaming](streaming.md#per-instance-lod)). every instance draws: the grass
sparsity, the cluster LOD measure (`rendererHalfSize`), the per-instance parameters and column 7
aren't packed.
