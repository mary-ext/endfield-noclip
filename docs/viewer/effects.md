# scene effects

how the viewer draws the effects [game-data/effects.md](../game-data/effects.md) describes, and the
[light beams](#light-beams) ([`looks/effects/`](../../packages/viewer/src/looks/effects), a module
per family beside the rows they share in `effect-look.ts`, and
[`effect.wgsl`](../../packages/viewer/src/render/meshes/effect.wgsl)). the extractor reads each
effect material's properties and keywords into a [surface](../package-format.md#materials)
([game/material-effects.ts](../../packages/extractor/src/game/material-effects.ts)), or marks it
unsupported with the reason; the viewer packs the surface into the look's rows, 12 of which effect
looks have past the mesh looks' 32. effects on particle meshes play through the
[particles](particles.md#particles), which also carry their [custom data](particles.md#custom-data);
what's left out is in [status](../status.md).

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
  additive mist does; drawn over, the glare at the corroded planet's centre (seen from Dijiang's
  deck) was a dark square.
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
  variant is unsupported.

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
  depth. a dissolve samples slot 2 and scales the offset and alpha as the game's does. custom data
  comes only from particles, so a mesh's second UV set, which the game's shader reads in its place,
  isn't.

## reflection-only effects

[reflection-only effects](../game-data/effects.md#reflection-only-effects) aren't drawn
(`UNDRAWN_SHADERS` in
[`material-describe.ts`](../../packages/extractor/src/game/material-describe.ts)), since the game
never shades them into the image. the viewer's screen-space reflections don't take their normal and
roughness either.

## portals

[portals](../game-data/effects.md#portals) draw with a stencil buffer
([`look.ts`](../../packages/viewer/src/looks/look.ts), `LookStencil`). an opaque mask writes only
the stencil, at the end of the main pass, tested against the depth there, and isn't shaded or
written to depth. in the transparent pass, effects that write the stencil draw before the rest, and
each effect's stencil state and depth test pick a pipeline variant. stencil operations other than
keep and replace are unsupported, and portals need the GPU's `depth32float-stencil8`.

## solid effects

VFXDitherAlpha shades through the opaque mesh path
([`special-looks.ts`](../../packages/viewer/src/looks/special-looks.ts), `ditheredLook`). its
[dither](../game-data/effects.md#solid-effects) is an alpha test in the cutout depth pass
(`fs_cutout_depth` in `mesh.wgsl`), for materials without `_USE_MAIN2` in the default
`_DitherAlphaMode`; with `_UseMainTexAsAlpha` only unlit ones, which test the texture through the
normal slot. drawn without the test, Power Plateau's `blackspot` was a dark square. the test leaves
out the vertex alpha and the near camera fade, and `_USE_MAIN2` is drawn only when its second
texture masks.

unlit VFXDitherAlpha materials with a distortion, a dissolve, a mask or polar or screen UVs draw
through VFXBaseV2's texture stack (`describeDitherEffect`, `stackLook`), fogged, blended by the
alpha the game dithers with rather than dithered, which the temporal antialiasing would average to
the same coverage. that alpha is raised to `_DitherAlphaExp` as the game's is, which thins the Very
Large Rift's red sky ring (`wenli_01_red` in `p_fxmap_dung02_dg005_boss_semicircle_sky_02`,
exponent 3) to streaks. unlike the game's, they don't write depth, so they don't hide effects behind
them. the stack's mask scales the colour as well as the alpha, so a mask draws only as its red
(`_UseMaskTexAsAlpha`, the default), where its colour is white; other masks, lit variants, other
dither modes and object-relative screen UVs stay unsupported. their vertex offset fills the same
rows as VFXBaseV2's, leaving out VFXBaseV2's vertex-alpha weight and camera pull. a vertex offset
alone doesn't bring a material onto the stack, and those stay unsupported.

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
blend and dissolve take slots 1–5. the particle's frame is its normal turned towards the camera and
its object x axis made square to it. the sun takes the viewer's light colour over π, as Lit's
diffuse does, and the shadow is sampled per pixel without the game's ramp texture. a mask or
dissolve switched to UV set 1 reads UV0 on particles (`_InParticle`), as the UV2 stream holds the
same UVs without a texture sheet, and stays unsupported on meshes.

## mist

the [mist](../game-data/effects.md#mist) cards and boxes draw by their own entry points in
`effect.wgsl` (`fs_mist_card`, `fs_mist_volume`). lit cards take the sun over π, at the mesh normal
rather than the game's normal map, and the cards' own fog (`_USE_FOG`) isn't drawn. boxes draw their
back faces without a depth test, like the decals, and take the thickness from the nearer of the
surface behind and the back face; only additive boxes are drawn, without their depth prepass or
vertex colour. a box's 3D noise is the look's `volumeTexture`, streamed whole and bound beside the
slots (a zeroed placeholder leaves boxes without it unchanged); the box waits for it like an
effect's other textures. additive cards and boxes add their light unfogged; premultiplied cards
blend over and fog themselves ([blending](#blending)).

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
