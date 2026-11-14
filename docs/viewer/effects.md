# scene effects

how the viewer draws the effects [game-data/effects.md](../game-data/effects.md) describes, and the
[light beams](#light-beams) ([`looks/effects/`](../../packages/viewer/src/looks/effects), a module
per family beside the rows they share in `effect-look.ts`, and
[`effect.wgsl`](../../packages/viewer/src/render/meshes/effect.wgsl)). the extractor reads each
effect material's properties and keywords into a [surface](../package-format.md#materials)
([game/materials/effects/](../../packages/extractor/src/game/materials/effects/), one module per
shader), or marks it unsupported with the reason; the viewer packs the surface into the look's 44
rows, all of which effect looks lay out for themselves (mesh looks use the first 35). effects on
particle meshes play through the [particles](particles.md#particles), which also carry their
[custom data](particles.md#custom-data); what's left out is in [status](../status.md).

## VFXBaseV2 and VFXDecal

- VFXBaseV2's sixth sample texture takes the vertex offset's slot, and the vertex stage samples the
  offset texture from the look's seventh slot.
- a [vertex offset mask](../game-data/effects.md#vertex-offset-and-brightening) takes the highest
  sample slot the stack leaves empty (`EffectVertexOffsetMask.slot`), with no role, so the fragment
  stage skips it; the vertex stage reads its slot and strength from `EffectRow.offsetMask`. with all
  five sample slots taken the material stays unsupported.
- a sample texture switched on without one bound keeps its role over an unset slot, which binds
  white, when the shader's default is white; with another default it's left out.
- each slot's share of the distortion (`*UseDisturb`) rides in its slot bits above the low byte, in
  1/1024ths (`slotDisturb`).
- [`_BlendMode` 1](../game-data/effects.md#vfxbasev2) materials add their light, unfogged, as
  additive mist does.
- [opaque](../game-data/effects.md#vfxbasev2) VFXBaseV2 materials shade in the main pass after the
  meshes (`effectOpaque` queue, `fs_effect_opaque`), writing depth, the colour times the alpha as
  their radiance, and nothing for the screen-space reflections, the AO or the decals. the effect
  group's main-pass outputs are bound to 1×1 stand-ins there (`mainPassStandIns`), so materials with
  a soft blend or edge colour, which read them, stay unsupported, as do those with a stencil. the
  composite fogs them as it does any opaque surface, unchecked against the game.
- [lighting](../game-data/effects.md#vfxbasev2) takes the irradiance volume and the shadowed sun,
  without local lights or the division by the post exposure.
- the [breathing](../game-data/effects.md#vfxbasev2) runs on the viewer's clock, with the per-draw
  time scale and offset left at none (their values aren't traced), so every placement pulses in
  step. its values ride in the decal fade row, which only VFXDecal reads.
- [water blending](../game-data/effects.md#water-blending) is left out, which matches the game above
  the authored `_WaterHeight`. fragments below it show the unsupported checker (`waterBlendBelow`),
  since neither the blend nor the water a `VFXWaterBlendConfig` finds is followed; heights at or
  below −1000 are taken as under every level.
- [soft-body animations](../game-data/effects.md#soft-body-animation) also take the vertex offset's
  slot for their position texture, its UV and scroll rows holding the UV1 scales and the playback's
  cycles per second and phase (a held frame is a still phase), and the offset rows the bounds and
  frame count (`VertexMotion` in [`stack.ts`](../../packages/viewer/src/looks/effects/stack.ts)).
  the rotation texture isn't read: materials with lighting or a Fresnel term, which would read the
  turned normals, stay unsupported, as do those with a vertex offset, a sixth sample texture or
  particle-driven playback.
- the [pull towards the camera](../game-data/effects.md#vertex-offset-and-brightening) is packed per
  surface (`EffectStackSurface.cameraPull`, `null` in particle mode and for VFXDitherAlpha and
  VFXDecal) and added in `vs_effect` for meshes and particles alike, measured from the position
  before the vertex offset (`EffectRow.cameraPull`).
- the [edge colour](../game-data/effects.md#edge-colour) compares the fragment's view depth with the
  main pass's depth, as the soft blend does (`EffectRow.edgeColor`, `edge`, `edgeAlpha`).
- VFXDecal boxes draw their back faces without a depth test, so they still show with the camera
  inside. each covered pixel reconstructs the main pass's surface from the depth buffer, and
  `_USE_NORMALBLEND` reads its normal from the main pass's packed surface normal. the extractor
  folds the shift of their `*CustomData` constants into each slot's offset; the `_USE_IN_PARTICLE`
  variant is unsupported. additive ones (`Blend One One` with `_BlendMode` 1) add without the fog's
  transmittance, as the stack's additive layers do; other additive modes stay unsupported.
  [parallax](../game-data/effects.md#vfxdecal) (`DecalParallax`) puts the depth texture, crack mask
  and crack noise in three slots no layer takes, with no role so the stack's loop skips them, and
  its values in the reveal's rows (`EffectRow.parallax`, `crack`, `crackNoise`), which decals don't
  have; `fx_decal_parallax` and `fx_decal_cracks` in `effect.wgsl` follow the shader. parallax
  beside a blend layer stays unsupported, since where the cracks add against it isn't known.

## VFXAdvance and the reveal

[VFXAdvance](../game-data/effects.md#vfxadvance) materials with only a main texture, the first
disturb texture, a mask, a blend layer, a dissolve, a Fresnel fade, a soft blend, fog, a vertex
offset and the reveal draw through the texture stack (`variant: 'advance'`, `describeVfxAdvance`),
in slots 0–4 (main, disturb, mask, blend, dissolve), the dissolve with VFXBaseV2's sweep and edge
colour; their other keywords, a Fresnel colour and interiors stay unsupported. two switches in row
43 of the look cover what only VFXAdvance does: `disturbNormal` reads the disturb texture as a
normal, and `blendVertexColor` scales the blend tint by the vertex colour. the ink keywords are
drawn as the game draws them where the ink simulation hasn't run, since the viewer has none.

[CharacterNPR_VFX](../game-data/effects.md#characternpr_vfx) is classified with VFXAdvance and drawn
by the same steps (`describeCharacterVfx`), with screen UVs and without the dissolve; a nonzero
`_VertCameraOffset` stays unsupported, since the viewer's pull is VFXBaseV2's capped one. screen UVs
about the object's origin (`screenUv.localPivot`, bit 4 of the look's screen-UV flags) measure from
the draw's origin, which for a skinned mesh posed into its prefab is the prefab's rather than the
renderer's, so the pattern can sit shifted against the game's.

the [reveal around the player](../game-data/effects.md#invisible-bridges) (`EffectAppear`, rows
40–43 of the look) changes the tint before the stack combines it (`fx_appear` in `effect.wgsl`), for
VFXAdvance and VFXDitherAlpha's effect variants alike. the camera stands in for the player, so the
fire seed reveals bridges around the camera. the global radii ride in `frame.render_size.zw`, set
from the `fireSeed:player` control through `PackageManifest.fireSeed` (`revealRadii`); in scenes
without one they're 0, which leaves the materials' own radii about the camera. a reveal without
`_USE_GLOBAL_APPEAR` (`EffectAppear.global` false) takes the material's radii alone, so Yinglung
Pass's ink rooms show only within a few metres of the camera; a reveal about a fixed point stays
unsupported. the reveal's brightening colour is linearized as the tint is.

## over the composited scene

effects whose blending the transparent pass's targets can't hold draw after compositing (and after
the water), into the composited scene with the main pass's depth attached read-only
(`MaterialLook.queue`, the `multiply` and `refract` passes in
[`draw-ranges.ts`](../../packages/viewer/src/render/meshes/draw-ranges.ts)):

- `_BlendMode` 2 VFXBaseV2 layers multiply the scene (`fs_effect_multiply`). they have no stencil
  there, so those with one stay unsupported.
- [VFXRefract](../game-data/effects.md#refraction) layers then sample a copy of the scene, taken
  after the multiplies into the main pass's radiance target, and blend over it (`fs_refract`). the
  copy holds the fog, the transparent layers and the water, which the game's copy may not. colour
  offsets take their further samples from the same copy, and the soft blend reads the main pass's
  depth. a dissolve samples slot 2 and scales the offset and alpha as the game's does; the blend
  layer takes slot 3 and the spread slot 4, their rows on the stack's vertex offset and edge colour
  rows, which only VFXBaseV2 reads (`RefractRow`). custom data comes only from particles, so a
  mesh's second UV set, which the game's shader reads in its place, isn't.

## reflection-only effects

[reflection-only effects](../game-data/effects.md#reflection-only-effects) aren't drawn
(`UNDRAWN_SHADERS` in
[`material-describe.ts`](../../packages/extractor/src/game/materials/material-describe.ts)), since
the game never shades them into the image. the viewer's screen-space reflections don't take their
normal and roughness either.

## portals

[portals](../game-data/effects.md#portals) draw with a stencil buffer
([`look.ts`](../../packages/viewer/src/looks/look.ts), `LookStencil`). an opaque mask writes only
the stencil, at the end of the main pass, tested against the depth there, and isn't shaded or
written to depth. in the transparent pass, effects that write the stencil draw before the rest, and
each effect's stencil state and depth test pick a pipeline variant. stencil operations other than
keep and replace are unsupported, and portals need the GPU's `depth32float-stencil8`.

## solid effects

VFXDitherAlpha and VFXWaterDitherAlpha (classified into one family) shade through the opaque mesh
path ([`special-looks.ts`](../../packages/viewer/src/looks/special-looks.ts), `ditheredLook`). its
[dither](../game-data/effects.md#solid-effects) is an alpha test in the cutout depth pass
(`fs_cutout_depth` in `mesh.wgsl`), for materials without `_USE_MAIN2` in the default
`_DitherAlphaMode`. with `_UseMainTexAsAlpha` the texture only feeds the test: unlit looks bind it
in the normal slot, lit ones (which may need that slot for their normal map) in the base slot, with
the tint covering the base colour as an untextured look's does. the test takes the instance's colour
(a particle's) as the vertex alpha, since the depth passes don't bind a mesh's own vertex colours,
and the near camera fade from `DitherRow.near`; its pattern moves by the temporal antialiasing's
jitter phase (`frame.params.w`), 0 with antialiasing off. `_USE_MAIN2` is drawn only when its second
texture masks (`_UseMainTex2AsAlpha` with `_MainTex2BlendMode` 0): the tint is multiplied by
`_MainTex2Color`, and the surface draws without the test.

`_SUBSURFACE` surfaces take the game's [subsurface model](../game-data/materials.md#subsurface) for
the sun and the ambient light (`subsurface_sun` and `Surface.scatter` in `frame.wgsl`): the look
packs the scattered colour times its amount in `DitherRow.subsurface` and zeroes the metallic. local
lights light them as a default surface.

unlit VFXDitherAlpha materials with a distortion, a dissolve, a mask or polar or screen UVs draw
through VFXBaseV2's texture stack (`describeDitherEffect`, `stackLook`), fogged, blended by the
alpha the game dithers with rather than dithered, which the temporal antialiasing would average to
the same coverage. that alpha is raised to `_DitherAlphaExp` as the game's is, which thins the Very
Large Rift's red sky ring (`wenli_01_red` in `p_fxmap_dung02_dg005_boss_semicircle_sky_02`,
exponent 3) to streaks. unlike the game's, they don't write depth, so they don't hide effects behind
them. their mask scales only the alpha (`maskAlphaOnly`, `EffectRow.maskAlphaOnly`), by its red
(`_UseMaskTexAsAlpha`, the default) or else its alpha, as the game's depth pass tests it and its
colour pass never samples it; lit variants, other dither modes and object-relative screen UVs stay
unsupported; `_INK_DISTORT` is drawn as without it, as VFXAdvance's ink keywords are. their vertex
offset fills the same rows as VFXBaseV2's, leaving out VFXBaseV2's vertex-alpha weight and camera
pull. a vertex offset alone doesn't bring a material onto the stack, and those stay unsupported.
`_USE_MAIN2` that takes its second texture as alpha and multiplies multiplies the tint by
`_MainTex2Color`, as the game's colour pass does without sampling the texture; other second-texture
modes stay unsupported. Wuling City's red-tide walls (`M_fxmap_chichao_06_05`) are such.

## waterfalls

VFXWater sheets are drawn by `fs_effect` (`water_sheet` in `effect.wgsl`; `waterSheetLook` in
[`water-sheet.ts`](../../packages/viewer/src/looks/effects/water-sheet.ts)). `_BlendMode` 1 sheets
add their light. the [post-exposure division](../game-data/effects.md#waterfalls) applies to the
unlit share only, since on the lit share it darkens sheets in dark places, such as Jingyu's cave
falls, far below the game's. the normal map's frame comes from the UVs' screen derivatives rather
than mesh tangents. `VFX_WATER_SIMPLE_LIGHT` sheets are lit the full way, and textures on UV sets
other than 0 are unsupported.

## six-way smoke

[six-way smoke](../game-data/effects.md#six-way-smoke) draws through `fs_effect`, which hands it to
`six_way_smoke` in `effect.wgsl` (`sixWaySmokeLook` in
[`six-way-smoke.ts`](../../packages/viewer/src/looks/effects/six-way-smoke.ts)). the positive
lightmap takes slot 0 and the negative one slot 6, sampled at slot 0's UVs; the distortion, mask,
blend and dissolve take slots 1–5. each slot's bits carry where its
[switched UVs](../game-data/effects.md#six-way-smoke) start, as the texture stack's do, plus
`SIX_WAY_SCREEN_DEPTH` for screen UVs scaled by the object's depth; `_UsePosYAsScreenV` rides in the
stack's screen-UV flags, whose own depth scale stays off. the particle's frame is its normal turned
towards the camera and its object x axis made square to it. the sun takes the viewer's light colour
over π, as Lit's diffuse does, and the shadow is sampled per pixel without the game's ramp texture.
a mask or dissolve switched to UV set 1 reads UV0 on particles (`_InParticle`), as the UV2 stream
holds the same UVs without a texture sheet, and stays unsupported on meshes.

## mist

the [mist](../game-data/effects.md#mist) cards and boxes draw by their own entry points in
`effect.wgsl` (`fs_mist_card`, `fs_mist_volume`). lit cards take the sun over π, at the mesh normal
rather than the game's normal map, and the cards' own fog (`_USE_FOG`) isn't drawn. a card without a
noise texture binds white (`MistCardSurface.noise` `null`), and its Fresnel term is
`MistCardSurface.fresnel`. boxes draw their back faces without a depth test, like the decals, and
take the thickness from the nearer of the surface behind and the back face; only additive boxes are
drawn, without their depth prepass or vertex colour. a box's 3D noise is the look's `volumeTexture`,
streamed whole and bound beside the slots (a zeroed placeholder leaves boxes without it unchanged);
the box waits for it like an effect's other textures. additive cards and boxes add their light
unfogged; premultiplied cards blend over and fog themselves ([blending](#blending)).

## light beams

[light beams](../game-data/lighting.md#light-beams) draw through `fs_effect`, which hands them to
`light_beam` (`lightBeamLook` in
[`light-beam.ts`](../../packages/viewer/src/looks/effects/light-beam.ts)). `vs_effect` shapes the
cone first (`beam_vertex`); the fragment stage takes the beam's own frame and the camera's from the
instance's inverse transform rather than extra varyings. additive beams add their light, unfogged;
alpha-blended ones blend over, fogging themselves under `VLB_USE_FOG`. the 3D noise, the
per-renderer scale and the global tint are left out, and the colour isn't scaled by exposure, which
the game's shader doesn't do either (unverified against an in-game shot).

## blending

effects draw in the [transparent pass](frame.md) with the glass, far to near by instance, as the
game's transparent queue does
([transparent draw order](../game-data/materials.md#transparent-draw-order)): each writes
premultiplied colour and its opacity, blended over the scene behind (`fx_accumulate` in
`effect.wgsl`). those the game [fogs](../game-data/effects.md#blending) fog their colour at their
own distance first, as glass does; additive light (`fx_additive`) adds with an opacity of 0 and
stays out of the fog. effects cast no shadows and wait until all their textures are resident.
