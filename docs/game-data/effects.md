# scene effects

scenery effects are meshes placed like any other renderer, mostly in dynamic structures, with
`HGRP/Effect/*` materials. the magenta blight around Jingyu Valley's corrupted shrine (map02_lv001,
near unity −905, 228, −1505) is one: `VFXDecal` boxes stain the ground and `VFXBaseV2` cards rise
from it as red and blue smoke, all in script group `script:458752:41` with the shrine's damaged
pieces (on by default). the viewer draws VFXBaseV2, VFXDecal, the [solid effects](#solid-effects),
the [waterfalls](#waterfalls) and the [mist](#mist)
([`effect-looks.ts`](../../packages/viewer/src/render/effect-looks.ts),
[`shaders/effect.wgsl`](../../packages/viewer/src/render/shaders/effect.wgsl)); every other effect
shader stays hidden, since the opaque fallback would turn its bounding surfaces into walls. mesh
particles that carry effects are in [assets.md](assets.md#prefabs) and
[viewer.md](../viewer.md#particles).

## VFXBaseV2 and VFXDecal

both are unlit and premultiplied (one, one minus source alpha), and build their colour from a stack
of textures by role:

- **disturb**: the texture's red channel, remapped by `_Bi_Disturb`, shifts the UVs of the textures
  sampled after it that opt in (`*UseDisturb`), by `_DisturbU/VIntensity1` (or `…2` for the second)
- **weight**: scales that shift (`_WeightTexIntensity · _DisturbUseWeight`) and the dissolve
  threshold
- **mask**: multiplies the main texture's colour and alpha
- **blend**: adds `blend · saturate((alpha + blend.a) · _BlendTint.a) · _BlendTint.rgb`
- **dissolve**: alpha survives where the texture's red exceeds a threshold that sweeps from −1.01 to
  1.01 with `_DissolveScheduleOffset`, sharpened by `_DissolveEdgeSharp`; a band
  `_DissolveEmissiveEdge` wide takes `_DissolveEmissiveColor`

each texture's UVs scroll by its `*UVSpeed` per second, rotate about the texture's centre, then take
an `_ST`; `*AsAlpha` turns a texture's red channel into its alpha. colour properties marked HDR are
used as stored, the others are converted to linear. colours ignore the post exposure when
`_IgnorePostExposure` is set, as emission does. the near camera fade (`_UseNearCameraFade`) fades a
layer in between `_NearCameraFadeDistanceStart` and `…End` metres of view depth, and out between
`…Start2` and `…End2`.

**VFXBaseV2** takes the main texture plus up to five `_SampleTexN`, each playing the role its
`_SampleTexNUseWeightK` property selects (0 disturb, 1 second disturb, 2 weight, 3 mask, 4 blend, 5
dissolve), with the `_ST` of that role's own texture property (`_DisturbTex1`, `_DisturbTex2`,
`_WeightTex`, `_MaskTex`, `_BlendTex`, `_DissolveTex`). the colour starts from
`_TintColor · _TintColorIntensity` times the vertex colour, alpha from
`_TintColor.a · _TintColorAlpha`; it's brightened by `_ExpIntensity` above `_ExpThreshold`. a
material without a main texture samples the shader's default, white, as the game does (the base ring
of Origin Lodespring's crater column is one). alpha fades by a Fresnel term
(`saturate(N·V + _FresnelBias)^_FresnelPower`, flipped by `_FresnelFlip`, applied by
`_FresnelAffectOpacity`) and, with `_USE_SOFTBLEND`, where the surface comes within `_SoftDistance`
metres of what lies behind it.

`_USE_VERTOFFSET` moves each vertex along `_OffsetDir` (`_OffsetSwitchDir` 0: object space, 1: world
space, 2: the vertex normal) by `_OffsetIntensity · (r · (1 + _Bi_Offset) − _Bi_Offset)`, where r is
`_OffsetTex`'s red channel at UV set 0 (set 1 with `_OffsetUVSet`), after its `_ST`, scrolled by
`_OffsetSpeed` per second. `_UseVertexColorAlphaAsVertOffsetWeight` weights it by the vertex alpha,
and every vertex is also pulled towards the camera by up to `_VertCameraOffset` metres (plus 1 mm).
the whole offset is scaled by `1 − _InParticle`, so a mesh material left at the default
`_InParticle` of 1 doesn't move. the vertex stage samples the texture from the look's seventh slot.
`_USE_BRIGHT` with `_BrightType` 0 and no `_BrightCenter` (w 0) adds `_BrightColor` and a UV wobble
within `_OuterRadius` of the player; the viewer has no player, so it draws such materials without
it. the teal streams winding between Wuling City's floating pillars (`M_fx_map02_zhenlie_*`,
map02_lv002) use both.

**VFXDecal** draws a unit box (`s_fx_particle_decal_cube`). the viewer draws its back faces without
a depth test, so it still shows with the camera inside: each covered pixel reconstructs the main
pass's surface from the depth buffer and, if that point lies inside the box, projects the textures
down the box's y (UV = local xz + 0.5). its roles are fixed: `_MainTex`, `_MaskTex`, `_BlendTex`,
`_DisturbTex1/2`, `_DissolveTex`, each only with its `_USE_*` keyword. the colour is
`_DecalBaseColor`, alpha its alpha times `_TintColorAlpha`, faded towards the box's x and z faces
(`_EdgeFadeX/Z`, over `_EdgeFadeIntensity`), its top and bottom (`_HeightFade` around
`_HeightFadeOffset`), and with `_USE_NORMALBLEND` on surfaces facing away from the box's y (`N·up`
to the power `_AngleBlendFallOff`, N from the main pass's packed surface normal). the colour is
premultiplied by the alpha twice, as the game does.

## portals

VFXBaseV2 takes its stencil test and write (`_StencilComp`, `_StencilOp`, `_StencilRef`,
`_StencilReadMask`, `_StencilWriteMask`) and its depth test (`_ZTest`) from material properties, and
`_UseVFXPortal` materials use them to show one effect only through another. the glowing cracks in
the Hub's plaza (map01_lv001, near unity −365, 95, −439) are one: an opaque mask on the crack mesh
writes 7 (queue 2000), and the crack's glow and a cylinder of red chasm walls draw only where the
stencil equals 7, without a depth test, so the chasm shows below the ground through the crack. drawn
whole, the cylinder stands on the ground as a solid red ring. other pairs write the stencil from a
transparent layer and draw a second layer only where it didn't (`NotEqual`).

the viewer draws them with a stencil buffer
([`materials.ts`](../../packages/viewer/src/render/materials.ts), `LookStencil`). an opaque mask
writes only the stencil, at the end of the main pass, tested against the depth there; the game also
shades it and writes its depth, but its effects cover it wherever it shows. in the transparent pass,
effects that write the stencil draw before the rest, and each effect's stencil state and depth test
pick a pipeline variant. stencil operations other than keep and replace aren't drawn, and without
the `depth32float-stencil8` feature (see [viewer](../viewer.md#the-render-frame)) none of it is.

## solid effects

`HGRP/Effect/VFXDitherAlpha` writes the G-buffer like an opaque surface, for effect meshes that are
solid, such as the rocks floating over Origin Lodespring's crater (mesh particles,
[viewer](../viewer.md#particles)). the viewer shades it through the opaque mesh path
([`materials.ts`](../../packages/viewer/src/render/materials.ts), `ditherAlphaLook`): the colour is
`_TintColor · _TintColorIntensity` times `_MainTex` (the tint alone with `_UseMainTexAsAlpha`),
times `_MainTex2Color` when `_USE_MAIN2` takes only the alpha of `_MainTex2` (`_UseMainTex2AsAlpha`)
and multiplies (`_MainTex2BlendMode` 0). with `_UseLighting` it is the albedo, saturated as the
G-buffer stores it, else emitted. `_NORMAL_MAP` adds a tangent-space normal map (`_NormalScale`; x
from alpha times red, as Unity unpacks it); roughness and metallic are `_Roughness` and `_Metallic`.
the shader has no shadow caster pass. its depth pass discards where the alpha falls below a
screen-space dither, which fades a mesh out; nothing drawn fades, so the dither isn't drawn. the
rocks' material multiplies a gold mask by a tint twelve times over, so the saturated albedo is black
rock with gold veins.

## waterfalls

a falls is a stack of prefab placements: the river surface running down the cliff behind it, one or
two VFXWater sheets (a flipbook sheet and a frothier outer one), WaterDecal foam boxes at its foot,
particle mist and splashes, and FogSimple cards around it. the sheets of falling water are
`HGRP/Effect/VFXWater` meshes (about 1800 placements on map02, in `P_fxmap_*waterfall*` prefabs),
drawn by `fs_effect` (`water_sheet` in `shaders/effect.wgsl`; `vfxWaterLook` in
[`effect-looks.ts`](../../packages/viewer/src/render/effect-looks.ts)). per pixel:

- **colour and opacity.** `_TintColor · _TintColorIntensity` (alpha `· _TintColorAlpha`) times the
  vertex colour (unless `_DisableVertColor`), `_MainTex` and `_MaskTex` (`_USE_MASK`), each taking
  only its red as alpha under `_UseMainTexAsAlpha` / `_UseMaskTexAsAlpha`. UVs scroll, rotate about
  0.5 and take their `_ST` as in VFXBaseV2. `_WaterRandomUV` stretches and offsets the main UVs by
  the fractional sum of the object's position.
- **distortion.** `_USE_DISTURB`: `_DisturbTex1`'s red, remapped by `_Bi_Disturb`, times
  `_DisturbU/VIntensity1` (or its normal's xy with `_DisturbTex1Normal`), shifts the main, mask,
  normal map and dissolve UVs by their `_…UseDisturb` fractions. `_USE_DISSOLVE` eats the alpha
  below `_DissolveScheduleOffset`'s threshold, with a glowing edge.
- **flipbook.** `_USE_SEQUENCE_FRAME`: `_SequenceBaseColorMap` holds `_SequenceFrameSize` frames
  (columns by rows, from the top) played at `_PlaybackSpeed` per second, offset per object by
  `_RandomStartByPos`; two frames blend, each pushed along `_SequenceMotionVectorMap` towards the
  other by `_MotionVectorDistortionStrength`. the frame adds `rgb · _SequenceBaseColorMapTint · a`
  and the opacity becomes `saturate(alpha · a · s − _SequenceOpacitySdf) · s`
  (`s = _SequenceOpacityScale`).
- **fades.** the near camera fade, `_USE_SOFTBLEND` against what lies behind, the vertex alpha
  (`_UseVertexColorAsOpacity`) and `|N·V|^_FresnelStrength` (`_UseFresnelAsOpacity`).
- **lighting.** the `_UseLighting` share of the colour is an albedo. it takes the irradiance volume
  at the normal (the flipbook's `_SequenceNormalMap` or `_NORMAL_MAP`, scaled by `_FrameNormalScale`
  / `_NormalScale`), plus a subsurface colour
  (`HSV(_SubsurfaceHue, _SubsurfaceSaturation, _SubsurfaceValue · thickness · albedo red)`) times
  `_SubsurfaceIndirect`, desaturated by `_IndirectSaturation`. the sun adds diffuse, a GGX highlight
  (`_Roughness`, f0 `0.08 · _Specular`, `· _DirSpecularStrength`, divided by the opacity so it
  survives premultiplication) and the subsurface colour through a wrap lobe plus a see-through lobe
  towards the sun, the light that makes falls glow against a low sun.
- `_BlendMode` 1 adds the sheet into the glow instead.

the game also divides the lit share by the post exposure under `_IgnorePostExposure`; the viewer
keeps that for the unlit share only, since it darkens sheets in dark places, such as Jingyu's cave
falls, far below the game's. the normal map's frame comes from the UVs' screen derivatives rather
than mesh tangents. not drawn: `VFX_WATER_REFRACT`, `_VAT_SOFTBODY`, punctual lights, matcaps, and
the `VFX_WATER_SIMPLE_LIGHT` variant's per-draw probe (it's lit the full way).

## mist

the drifting mist banks are effects too: `HGRP/FogSimple` cards (841 on map02, `SimpleFogCard*`) and
`HGRP/Effect/VFXFakeVolumeFog` boxes (69, `SimpleFakeVolumeFog*`), drawn by their own entry points
in `shaders/effect.wgsl` (`fs_mist_card`, `fs_mist_volume`):

- **cards.** alpha is `_MainTex`'s red times `(1 − _FogNoiseIntensity) + noise · _FogNoiseIntensity`
  (`_NoiseTex` red) times `_BaseColor.a`. with `_UseWind`, a second `_NoiseTex` sample at the UV ×
  `_WindScale` (× `_WindScaleX/Y` with `_UseSeparateScale`), scrolling by
  `(−_WindDirX, _WindDirY) · _WindSpeed` per second, remapped by `_WindNoiseContrast` and mixed in
  by `_WindNoiseIntensity`, scales both colour and alpha. the colour is `_BaseColor`; with
  `_USE_LIGHTING` it's `_BaseColor` times the sun (the game's light colour, the viewer's over π),
  mixed towards `_IndirectColor` away from the sun by `_LightFactor`. alpha then fades in over
  `_DistanceFadeStart…End` and out over `_NearCameraFadeDistanceStart…End` metres of view depth,
  towards the card's top (`saturate(−object y · _TopFadeContract + _TopFadeOffset)`), with
  `_USE_SOFTBLEND` within `_SoftDistance` metres of what lies behind, and is scaled by
  `_BaseAlphaIntensity`.
- **boxes.** drawn by their back faces without a depth test, like the decals. from the nearer of the
  surface behind and the back face, the fog's thickness is the distance along the view ray through
  the unit cube towards the camera (stopping at the camera inside it), and alpha is
  `_FogColor.a · _TintColorAlpha · (1 − 2^(−thickness · _FogExponent)) · _FogDensity`, faded within
  `_CubEdgeFade` of the box's axis line, above `_HeightOffset` by `_HeightFalloff`, between
  `_VerticalFalloffMin/Max`, close to boxes the camera can't walk into (`_NearFadeDistance`), out to
  `_FogIntensityFadeDistance` from the point (or the box's centre), and with `_FogDepthStart` in
  from the camera up to that distance, starting at the `_FogDepthEnd` fraction of it. the colour is
  `_FogColor`.

most cards and every box blend additively; they draw into the transparent pass's glow, which the
composite adds unfogged after the fog ([viewer](../viewer.md#the-render-frame)). premultiplied cards
join the weighted blend. the cards' own fog (`_USE_FOG`, faded by `_FogIntensity` and
`_FogIntensityFadeOutDistance`) isn't drawn, nor the boxes' 3D noise or their depth prepass, so the
additive ones read a little brighter far away. at Sword Vault Dale (map02_lv006) the cards make the
haze over the valley's middle distance that the fog alone left clear.

## blending

effects join the transparent pass's weighted blend ([glass](materials.md#glass)). the game draws
them after its fog, so only those with `_USE_FOG` are fogged, at their own distance; the composite
fogs them like glass, as if at the surface behind. the rest add their weight to the glow target's
alpha too, which nothing else writes, and the composite keeps that share of the layers' mean colour
out of the fog, laid over the fogged scene and hiding as much of the fog's inscatter as it covers.
Origin Lodespring's red light stripes along the crystal ridge (`M_fx_prop_connectline_*`) are such
effects. effects cast no shadows and wait until all their textures are resident.

## open

not drawn, for VFXBaseV2 and VFXDecal: additive materials (they could draw into the glow), the
vertex offset's mask (`_USE_VERTOFFSETMASK`) and particle-data terms, brightening that is a scan
line or centred on a fixed point, polar or screen-space UVs, lighting, breathing, edge colour,
vertex animation textures or water blending, the flipbook and particle inputs, and VFXDecal's
parallax, 3D texture, weight and particle variants. across effects: their own fog (`_USE_FOG`), the
scene effect colour grade, VFXDitherAlpha's keyword variants other than the normal map and
`_MainTex2`'s alpha, and every other effect shader (`VFXAdvance`, `VFXRefract`, `WaterDecal`, …).
