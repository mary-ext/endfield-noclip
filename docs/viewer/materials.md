# materials

how the viewer draws the surface shaders [game-data/materials.md](../game-data/materials.md)
describes. the extractor reads each material's properties and keywords into a
[surface](../package-format.md#materials)
([game/materials/surfaces/](../../packages/extractor/src/game/materials/surfaces/), one module per
shader), which the viewer packs into a look
([`looks/material-looks.ts`](../../packages/viewer/src/looks/material-looks.ts) picks the builder by
surface kind: Lit in [`lit-look.ts`](../../packages/viewer/src/looks/lit-look.ts), erosion, dithered
surfaces and matte paintings in
[`special-looks.ts`](../../packages/viewer/src/looks/special-looks.ts), [effects](effects.md) in
[`effects/`](../../packages/viewer/src/looks/effects)), shaded in
[`mesh.wgsl`](../../packages/viewer/src/render/meshes/mesh.wgsl); what's left out is in
[status](../status.md).

the mesh shader has seven texture slots (`SLOTS` in
[`looks/look.ts`](../../packages/viewer/src/looks/look.ts); the frame group takes the rest of
WebGPU's sixteen), so features that rarely meet share a slot or a parameter row, and a material that
has both draws only one. each section below names what that leaves out.

## emission

[emission](../game-data/materials.md#emission)'s post exposure is the auto exposure times the
viewer's exposure option, so `_IgnorePostExposure` emitters divide out both.

`_EMISSIVE_ANIM`'s pulse runs on the animation clock, so like the parallax pulse it moves only while
frames render. it keeps its inputs in the parallax rows, so a look with a parallax glow or a layer
doesn't pulse. flickering emitters (`_EnableEmissiveAnimFlicker`) are drawn steady, and the emissive
map doesn't scroll (`_EmissiveSpeed` isn't read).

the emissive map's G, B and A colours, already times `_EmissiveType` (null when they add nothing),
ride in the three rows effect looks keep for their own parameters, which mesh looks don't otherwise
use.

`_EMISSIVE_ANIM_SWEEP`'s band isn't drawn: the packer scales each emission colour by one minus its
alpha, its value outside the band, so colours that glow only in the band are left out and steady
ones stay. `_EMISSIVE_NOMAP`, which emits only through the band, emits nothing.

the per-draw emission colour isn't known for static scenery, so it's taken as zero and those draws
use their material's `_EmissiveColor`. a prefab's `AnimationProperties_Emissive` resting colours, or
the emissive config its view states leave on it, are mixed into its renderers' emission colour at
pack time ([emissive-override.ts](../../packages/extractor/src/game/prefabs/emissive-override.ts)),
and its albedo tint travels as `LitEmission.albedoTint`, which `mesh.wgsl` applies to the albedo
before the emission takes it. its breathing isn't read.

## lit layers

`HGRP/LitEffect` is drawn as Lit, without its dissolve and disturb effects.

- **`_TRI_CHANNEL_MASK`**: the mask shares the MRO map's slot, so MRO-layout materials draw without
  it. of the switch-texture variants only R blends, since their G and B textures have no slot.
  `_UseMaskRUVSetAndTilingScale` isn't read.
- **`_PARALLAX_MAP`**: the [pulse](../game-data/materials.md#lit-layers) moves only while frames
  render ([performance](performance.md); the `continuous` option keeps it moving), and the
  brightening near the player puts the player at the camera. a glow without a noise map binds only
  the pattern, and the march reads height 0 in place of the empty slot. a glow with a separate mask
  texture (`_UseParallaxMask`) has no slot for it and isn't drawn, nor is the global highlight
  (`_VFXParams2`, set natively).
- **`_MATCAP`** has no free slot and isn't drawn, so the campfires' crystal glows without its sheen.
- **`_LAYERBLEND_TOP`** and **`_LAYERBLEND_MASK`**: the layer's two maps take the parallax slots and
  rows, and a mask map takes the emissive slot, so a mask layer on an emissive-mapped material isn't
  drawn. a layer on UV set 2 samples UV set 0, and set 0 is bound in place of a missing set 1, as
  the game reads a missing set. `_BaseHeightMap` has no slot and reads as the shader's grey default
  (0.5). mask layers with noise (`_LAYERBLEND_NOISEBLEND`) or parallax
  (`_LAYERBLEND_MASK_PARALLAX_PBR`) aren't drawn.

## foliage

the viewer evaluates the game's [foliage model](../game-data/materials.md#foliage) per pixel
(`foliage_sun` in [`frame.wgsl`](../../packages/viewer/src/render/frame/frame.wgsl) for the sun, and
the same terms per light in `local_lighting`). `HGRP/Foliage/Leaf`'s and the grass shaders' inputs
are their surfaces' `foliage`
([game/materials/surfaces/foliage.ts](../../packages/extractor/src/game/materials/surfaces/foliage.ts)),
packed by `leafParams` and `grassParams`; a leaf's `_BLEND_COLOR` rides in the tri-channel mask's
rows. a leaf without `_TwoSidedNormal` keeps its normal on back faces, as the game's does; with it,
and on every other material, the viewer turns the normal towards the camera wherever it faces away
rather than by the face that shows. the grass takes `h` as the vertex's object-space height. the
grass card LOD takes neither the bend nor the masks, since its normal decoding isn't read.
`HGRP/Foliage/Trunk` takes Lit's texture layout plus its `_FOLIAGE_TRUNK` vertex AO and ramp (the
surface's `trunk`, packed by `trunkParams` into rows leaves use otherwise and marked by the look's
`Trunk` flag, since those rows hold the dither on dithered looks), and
`HGRP/Foliage/TreeFoliageCardMeshLod` draws as plain alpha-tested foliage.

## swaying cloth

[swaying cloth](../game-data/materials.md#swaying-cloth) is the surface's `sway`, packed by
`swayParams` into rows only foliage uses otherwise, and offset in `instance_rel`, which the shading,
depth, alpha-tested depth and shadow passes share, so the passes agree on the swayed position. the
vertex colour's alpha arrives as the position stream's W
([geometry blob](../package-format.md#geometry-blob-mesh-efgm)), so the depth passes read no extra
stream. the wind clock is `Frame.wind.x`, advanced with the animation clock at the blended
environment's [wind](../game-data/environment.md#wind) rate, so the sway moves only while frames
render, every placement swings from one clock rather than the game's running one, and no environment
means still air. each pass's `_DisableAnimateVert` is taken as 0. the viewer draws no motion
vectors, so the previous frame's offset isn't needed. skinned geometry drops the weight, so a
swaying material on an animated mesh keeps still, and `_GPU_CLOTH` materials keep still too.

## vertex offset

the [vertex offset](../game-data/materials.md#vertex-offset) is the surface's `vertexOffset`
([lit-sway.ts](../../packages/extractor/src/game/materials/surfaces/lit-sway.ts)), packed by
`vertexOffsetParams`: the offset texture and its mask take the parallax slots, marked by the
`VertexOffset` look flag so the fragment stage doesn't read them as a glow, and their inputs take
the three parallax rows the emission pulse leaves alone. `vertex_offset` in `mesh.wgsl` samples them
in the vertex stage, so the mesh pipelines' material group
([`mesh-pipelines.ts`](../../packages/viewer/src/render/meshes/mesh-pipelines.ts)) shows the two
parallax slots to the vertex stage and carries a fourth sampler, the noise slot's own, for the mask.
the offset adds to the sway.

- **passes**: the offset needs the UV sets and the material's textures wherever vertices are
  positioned. the alpha-tested depth and shadow path already reads both (`vs_cutout_depth`), and the
  opaque one reads positions alone, so only alpha-tested looks are offset, which every map02
  material with the keyword is; an opaque one keeps still. `vs_main` and `vs_cutout_depth` add the
  same expression, so the passes agree on the position. a look's draws are alpha-tested only once
  the map holding its alpha is bound, and the shader tests that same flag, so a material drawn
  opaque while it streams keeps still rather than splitting from its depth. the offset also waits
  for its own textures.
- **clock**: the scroll runs on the animation clock (`Frame.eye.w`, seconds), so it moves only while
  frames render, and every placement scrolls in step.
- **left out**: an offset along the vertex normal (`_OffsetSwitchDir` 2), since the depth passes
  don't read normals; an offset on a surface with a parallax glow or a layer, whose maps hold the
  slots; one whose offset texture is unset. a fractional `_OffsetUVSet` reads as the nearer set.
- **weights and bounds**: an offset weighted by the vertex colour's alpha reads it from position W
  as the sway does, and the packer grows the mesh's bounds by the offset's reach
  ([geometry blob](../package-format.md#geometry-blob-mesh-efgm)). skinned geometry drops the
  weight, so a weighted offset on an animated mesh keeps still; an unweighted one, like the
  balloon's, is added after the skinning. an object-space direction turns by the transform the
  geometry is drawn with, which for a skinned renderer posed into its prefab is the prefab's rather
  than the renderer's; the balloon's renderers sit unrotated in theirs.

## glass

[glass](../game-data/materials.md#glass) is shaded like Lit, with the opacity taken from the alpha
`_AlphaMaskChannel` picks, times `_BaseColor.a`; with the map still streaming, the tint's alpha
alone. glass casts no shadows. premultiplied glass (source factor one) adds its whole radiance and
lets the opacity only dim what lies behind.

the [transparent pass](frame.md) draws it with the effects, far to near by instance, over the
composited scene: its radiance fogged at its own distance, as the game's shader fogs itself, then
blended over by its opacity. so an effect kilometres behind a pane shows through it, dimmed by the
pane (the corroded planet's plume behind Dijiang's deck glass).

## decals

the viewer has no GBuffer, so it draws a [decal](../game-data/materials.md#decals) like the VFXDecal
boxes ([effects](effects.md#vfxbasev2-and-vfxdecal)): the box's back faces without a depth test, in
a pass of their own over the composited scene
([`litDecalLook`](../../packages/viewer/src/looks/effects/lit-decal.ts), `fx_lit_decal` in
[`effect.wgsl`](../../packages/viewer/src/render/meshes/effect.wgsl)). that pass runs before the
water and the [transparent pass](frame.md), since the game's decals are part of the surface they lie
on: drawn after the water, the moss and rust on a pool's bed showed through water that hides the bed
itself. it takes the surface's normal and roughness from the main pass where the masks keep them,
shades the decal like any surface, and lays it over by its alpha. placements of one material share
its look and draw the game's VFXDecal cube; each row's block word indexes its placement's colour and
UV transform in a placement buffer beside the rows (`row_placement` in frame.wgsl), which the effect
vertex shader passes on. overlapping decals draw in no set order (`_DrawOrder` isn't read). under a
laid-over decal that doesn't write them, the surface's occlusion and metallic are taken as 1 and 0.

the game keeps lit decals off surfaces by a stencil bit. the viewer carries it in the main pass's
packed surface instead (bit 31, `SURFACE_NO_LIT_DECALS` in frame.wgsl), so it works without a
stencil buffer: looks whose shader writes `_StencilRef` and whose value has bit 32 set it
(`keepsLitDecalsOff` in [lit-look.ts](../../packages/viewer/src/looks/lit-look.ts)), and laid-over
and relit decals skip those pixels. VFXDecal boxes ignore it.

decals that write no albedo can't be laid over the surface, because the main pass has already lit
it. a pass between the main and the transparent pass (`fs_decal_relight`) adds the change in the
surface's light instead: it lights the surface twice, with its own normal, roughness and occlusion
and with the decal's, and adds the difference times the decal's alpha to the radiance. the surface's
colour comes from the main pass's diffuse ambient divided by the ambient light at its normal, taken
as a dielectric's; its emission, screen-space reflections, ambient occlusion and metallic stay as
drawn.

an emissive decal's glow is part of the decal's own shading when it's laid over; a relit one adds
it, times its alpha, on top of the surface's emission rather than replacing it. lit decals with
keywords past `_COMPLETE_PBR`, `_NORMAL_ANGLE_BLEND`, `_BLEND_WATER_FLOW` and `_BLEND_EMISSIVE`
(wetness, sludge, footprints, UV noise, arcs) are [unsupported](#unsupported-materials): drawn by
the opaque path, their box would show as a solid block.

## matte paintings

[matte paintings](../game-data/materials.md#matte-paintings) are drawn by
[`mattePaintingLook`](../../packages/viewer/src/looks/special-looks.ts). the alpha scale is folded
into the threshold so the shared alpha-test depth pass still applies, fog comes from the composite
like everything else, and they're held back until their texture is resident. `_UseMainTexAsAlpha`
isn't read, and a texture on a UV set other than 0 is dropped.

## forward Lit

[forward Lit](../game-data/materials.md#forward-lit) (`HGRP/LitForward`, the golden treasure chest)
is drawn as Lit, deferred with everything else, so it reflects the scene's sky cubemap and
screen-space reflections rather than its own `_CUSTOM_IBL` cubemap, and its metal reads darker than
the game's. none of Lit's optional layers are read for it.

## erosion

[erosion rock](../game-data/materials.md#erosion) is drawn by
[`erosionLook`](../../packages/viewer/src/looks/special-looks.ts) and `erosion_surface` in
`mesh.wgsl`, without the soft blend into what lies behind (`_ObjectBlend*`). its textures reuse the
Lit slots (`erosionLook` lists which). `HGRP/ErosionDynamic` has no look and shows as
[unsupported](#unsupported-materials).

## unsupported materials

a material the viewer can't draw can show as an unlit checker of magenta and black, in half-metre
cells of world space, to mark where something is missing. two settings show it, both off by default
since the checker covers what lies behind: "unsupported materials" for meshes in materials the
viewer lacks, and "missing content" for the package's [stand-ins](../package-format.md#stand-ins)
for content it doesn't draw at all. off, those draws are skipped during
[mesh selection](../../packages/viewer/src/streaming/mesh-selection.ts) (`unsupportedLook` in
[`looks/material-looks.ts`](../../packages/viewer/src/looks/material-looks.ts)). it shows both
faces, casts no shadow and keeps its colour at any exposure. this covers effect shaders without a
look of their own ([effects](effects.md)), effect materials using keywords, blend modes, stencil
operations or texture combinations their look doesn't handle, or sampling a texture from a UV set
the look doesn't read (sets past 1, past 0 for VFXWater and VFXRefract), lit decals in variants the
viewer lacks or without a placement or base colour map, additive materials outside the effects,
since the opaque path can't blend, shaders without a family (`HGRP/CharacterNPR`,
`Hidden/HGRP/LitEffectBlend`, `HGRP/Foliage/Glow`, `HGRP/ErosionDynamic` and the like, which `pack`
lists per shader), and materials that didn't convert. stand-ins (`DrawRole.Unsupported`) take the
same look whatever their material.

the extractor decides which materials are unsupported when it
[describes their surfaces](../package-format.md#materials), and `pack` counts them by shader and
reason. its `debug/assets.json` lists per material why it's unsupported (`unsupported`, such as the
keywords or texture combination an effect's look rejects), the surface keywords the viewer doesn't
draw (`keywordsNotDrawn`, from
[game/materials/surfaces/surface-keywords.ts](../../packages/extractor/src/game/materials/surfaces/surface-keywords.ts),
beside the describers that read them) and the texture slots whose reference couldn't be followed
(`slotErrors`). a surface shader draws without the keywords it doesn't read rather than showing the
checker.

only materials the game draws nothing visible with aren't drawn: `HGRP/WaterProxy`, whose passes all
feed the water pipeline ([water](../game-data/water.md#waterproxy-and-waterdecal)), and lit decals
that write nothing the viewer draws.
