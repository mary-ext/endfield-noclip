# scene effects

scenery effects are meshes placed like any other renderer, mostly in dynamic structures, with
`HGRP/Effect/*` materials. the magenta blight around Jingyu Valley's corrupted shrine (map02_lv001,
near unity −905, 228, −1505) is one: `VFXDecal` boxes stain the ground and `VFXBaseV2` cards rise
from it as red and blue smoke, all in script group `script:458752:41` with the shrine's damaged
pieces (on by default). the components that switch effects inside prefabs (one-shot effects and
effect LOD tables) are at the end of this page; particle systems and spline movers are in
[particles.md](particles.md), prefabs themselves and billboards in [assets.md](assets.md#prefabs).

## VFXBaseV2 and VFXDecal

### the texture stack

both are unlit and premultiplied (one, one minus source alpha), and build their colour from a stack
of textures by role:

- **disturb**: the texture's red channel, remapped by `_Bi_Disturb`, shifts the UVs of the textures
  sampled after it by `_DisturbU/VIntensity1` (or `…2` for the second), each texture taking the
  share its `*UseDisturb` sets (mostly 0–1, often fractional). the rising mist puffs of
  `M_fxmap_dung02_rdg005_camille_range_smoke_01_1102` (Si's Painting, map02_lv010) shift their main
  texture by a tenth: shifted fully, their 2×2 sheet's neighbouring puffs reach the quads' edges
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

### VFXBaseV2

**textures.** the main texture plus up to six `_SampleTexN`, each playing the role its
`_SampleTexNUseWeightK` property selects (0 disturb, 1 second disturb, 2 weight, 3 mask, 4 blend, 5
dissolve), with the `_ST` of that role's own texture property (`_DisturbTex1`, `_DisturbTex2`,
`_WeightTex`, `_MaskTex`, `_BlendTex`, `_DissolveTex`). a sample texture its keyword switches on
samples the property's default (white for every `_SampleTexN`) when the material binds none: the
white talosite's shards switch on a mask that way, so it masks nothing. a material without a main
texture samples the shader's default, white (the base ring of Origin Lodespring's crater column is
one).

**UV sources.** each texture's UVs start from its `*UVWeights` times UV0, UV1, polar and screen UVs
(materials set one weight). polar UVs are computed with `_USE_POLARUV` and `_UsePolarUV`: about
UV0's centre, the angle from +v as a fraction of a turn and twice the distance. screen UVs, with
`_USE_SCREENUV` and `_UseScreenUV`, are the pixel's position, centred and divided by half the width,
v optionally the world height (`_UsePosYAsScreenV`), times the object origin's view depth past the
near plane (`_ScreenUVUseDepth`, on by default). `_LocalPivortSpace` replaces the pixel's position
with the fragment's offset from the object's origin along the camera's right and up, in metres,
before the height and depth steps, so the pattern is anchored to the object rather than the screen.
a source that isn't computed is zero, so a texture weighted to it only scrolls. the sixth sample
texture's UVs come from UV0 or UV1 alone and scroll by the first's `_SampleTex0UVSpeed`. on
particles (`_InParticle`) UV1 is the first texture coordinate set's zw (the UV2 stream); the second
set is the particle's [custom data](#particle-custom-data).

**colour and alpha.** the colour starts from `_TintColor · _TintColorIntensity` times the vertex
colour, alpha from `_TintColor.a · _TintColorAlpha`; it's brightened by `_ExpIntensity` above
`_ExpThreshold`. `_USE_ANIM_BREATHING` pulses that alpha between `_BreathingMinAlpha` and 1, by
`saturate((cos(t · _BreathingSpeed) · 0.5 + 0.5)^_BreathingPower)`, t the shader's time scaled and
offset by two per-draw values; the panels of Dijiang's clue board breathe so. alpha fades by a
Fresnel term (`saturate(N·V + _FresnelBias)^_FresnelPower`, flipped by `_FresnelFlip`, applied by
`_FresnelAffectOpacity`) and, with `_USE_SOFTBLEND`, where the surface comes within `_SoftDistance`
metres of what lies behind it.

**lighting.** with `_USE_LIGHTING` the colour is an albedo lit by the irradiance volume, the
shadowed sun and local lights, at the vertex normal turned towards the camera or at the world's up
(`_RotateNormalToWorldUp`), and divided by the post exposure under `_IgnorePostExposure`. the mist
cards rising at the foot of falls are lit so. `_USE_FORCE_DYNAMIC_LIGHTING` is a material toggle in
the shader's keyword space that none of its compiled variants reads, so it changes nothing; the glow
over Marker Stone Interiors' rift monsters (`M_fx_monster_enemy_etthillu_lsq_01`) sets it.

**blend modes.** the shader writes its alpha times `1 − _BlendMode`, so under `_BlendMode` 1, the
shader's default, the premultiplied colour adds to what lies behind instead of covering it; about a
quarter of the scenery's VFXBaseV2 materials are such, among them the glare at the corroded planet's
centre seen from Dijiang's deck. `_BlendMode` 2 writes `lerp(1, colour, alpha)` for a
`Blend DstColor Zero` state, which multiplies what lies behind by it.

**opaque.** a material whose `_SrcBlend` and `_DstBlend` are one and zero writes the shader's
premultiplied colour (the colour times its alpha) over what lies behind, and its depth, in the
opaque queue (2000); the shader's only pass is the forward one, so it writes no G-buffer and casts
no shadow. the falling gravel by map01's mining pipes (`p_fxmap_common_gravel_02`, near unity 635,
62, 632) is mesh particles of rock pieces in such a material, `M_fx_quicksand_1104`: lit at the
world's up, with `_UseMainTexAsAlpha`, so each rock is the flat grey tint with its texture's red,
times `_TintColorAlpha` 10, as its alpha, so only texels whose red is below 0.1 darken it. its near
camera fade, out from 200 to 300 m, would turn rocks beyond 300 m black rather than hide them.

### edge colour

`_USE_EDGECOLOR` marks where the surface meets what lies behind it, after the dissolve and before
the brightening: `e = _EdgeColor.a · saturate(_EdgeDistance / max(d, 0.001) − _EdgeDistanceOffset)`,
d the view depth from the surface to the main pass's depth behind it. `_EdgeColorMode` 1 adds
`(_EdgeColor.rgb, _TintColorAlpha) · e` to the colour and alpha; 0 multiplies the colour by
`_EdgeColor.rgb` and the alpha by e, so only the contact shows; the shader blends the two by the
mode. the frames of Dijiang's aisle-guide panels (`M_fxmap_base01_lv001_ship_aisle_guide_01_fj_05`,
mode 1, `_EdgeDistance` 0.002) glow only within millimetres of a contact, so they draw almost as
without the keyword.

### vertex offset and brightening

`_USE_VERTOFFSET` moves each vertex along `_OffsetDir` (`_OffsetSwitchDir` 0: object space, 1: world
space, 2: the vertex normal) by `_OffsetIntensity · (r · (1 + _Bi_Offset) − _Bi_Offset)`, where r is
`_OffsetTex`'s red channel at UV set 0 (set 1 with `_OffsetUVSet`), after its `_ST`, scrolled by
`_OffsetSpeed` per second. `_UseVertexColorAlphaAsVertOffsetWeight` weights it by the vertex alpha.
the offset is scaled by `1 − _InParticle`, so it never moves particles, and a mesh material left at
the default `_InParticle` of 1 doesn't move either.

every VFXBaseV2 variant, with or without the keyword, also pulls each vertex towards the camera by
`min(max(0, d − 1), _VertCameraOffset) + 0.001` metres, d its distance from the camera, scaled by
the same `1 − _InParticle`. VFXDitherAlpha and VFXDecal don't pull. a pull lets a glow sit inside
the object it lights without that object hiding it: Marker Stone's tower lamps
(`P_fxmap_map_lv004_lamp_light_01`, one prefab for the whole tower) draw red streaks across the
white lamp cubes from a mesh (`M_fxmap_map_lv004_lamp_light_01`, `_TintColor` red times 100) pulled
1 m, and red stars from particle systems emitting from mesh shapes, pulled 3 m and, for the far
stars that fade in past 200 m, 50 m; all three leave `_InParticle` at 0.

`_USE_VERTOFFSETMASK` scales the offset, but not the pull towards the camera, by `1 − p·(1 − m)`,
where `p = _OffsetMaskPower / 5` and m is `_OffsetMaskTex`'s red at the offset texture's UVs, after
the mask's own `_ST`, scrolled by `_OffsetMaskSpeed`. the fragment stage doesn't read it. the glow
over the collectible pieces (`M_fx_interactive_collection_2102` in `int_collection_piece_postmodel`)
pushes its vertices up to 1.2 m along world y (`_OffsetDir` 0.1 times `_OffsetIntensity` 12.15) by a
flow texture, masked by a star texture at a power of 3; Jingyu's butterflies and waterfalls and
Wuling's ink drops use it too.

`_USE_BRIGHT` with `_BrightType` 0 and no `_BrightCenter` (w 0) adds `_BrightColor` and a UV wobble
within `_OuterRadius` of the player. the teal streams winding between Wuling City's floating pillars
(`M_fx_map02_zhenlie_*`, map02_lv002) use both. VFXBaseV2's radii are the material's alone;
VFXAdvance and VFXDitherAlpha add the [global reveal radii](#invisible-bridges) under
`_USE_GLOBAL_APPEAR`.

## VFXAdvance

`HGRP/Effect/VFXAdvance` is VFXBaseV2's sibling with fixed slots rather than sample textures: a main
texture, `_DisturbTex1` (and a second) shifting the main texture and `_MaskTex` by their
`*UseDisturb` shares as the [texture stack](#the-texture-stack)'s disturb role does, a mask, a
dissolve, a blend layer, polar and screen UVs, soft blending, an edge colour and an "interior" (a
parallax tunnel). the colour and alpha start as VFXBaseV2's (`_TintColor`, vertex colour, intensity,
`_TintColorAlpha`), the Fresnel term fades the alpha and mixes the colour towards `_FresnelColor` by
its w, and `_BlendMode` 1 adds. `_USE_VERTOFFSET` and the pull towards the camera are VFXBaseV2's.
`_USE_DISSOLVE` is VFXBaseV2's [dissolve](#the-texture-stack) on `_DissolveTex` (its UVs built like
the main texture's from `_Dissolve*` properties, shifted by `_DissolveTexUseDisturb` of the
distortion), with the edge colour `_DissolveEmissiveColor · _TintColorIntensity`; it eats the alpha
after the mask and before the near-camera fade. the ink bridge prefabs' walls, floors and joins
(`M_fx_map02_lv007_inkbridge_freelance_wall_*`, `…_floor_*`, `…_join_*`) tear their edges with it.
`_FogIntensity` mixes how much of the fog a fogged layer takes, fully past
`_FogIntensityFadeOutDistance` metres. `_USE_SOFTBLEND` is VFXBaseV2's: the alpha fades by
`saturate((d_scene − d + _SoftBias) / _SoftDistance)`, d the view depth, alongside the near-camera
fade. the black and white ink layers of Si's Painting's ink road over the cave falls
(`M_fxmap_map02_lv010_cave_inkroad_02_fj_01`, `…_02`, `…_04`, near unity 727, 239, 1166, script
group 37900020000) fade so where they meet the rocks.

`_USE_BLEND` is the texture stack's [blend layer](#the-texture-stack) on `_BlendTex` (UVs built like
the main texture's from `_BlendTex*` properties, its `_ST` applied once, shifted by
`_BlendTexUseDisturb`), except that `_BlendTint` is times the vertex colour unless
`_BlendDisableVertColor` is set. `_DisturbTex1Normal` reads the disturb texture as a normal: the
shift is `(a · r′, g) · 2 − 1` times `_DisturbUIntensity1` on both axes, r′ its red remapped by
`_Bi_Disturb` (for a BC5 texture, whose alpha reads 1, `(r′, g) · 2 − 1`), in place of r′ times the
u and v strengths.

without `_USE_GLOBAL_APPEAR`, `_USE_BRIGHT` is the [reveal](#invisible-bridges) with the material's
radii alone. Yinglung Pass's ink rooms (map02_lv007, near unity −450, 270, 703) are such: floors of
`M_fx_map02_lv007_inkroom_floor_0*` (blend layer, normal-read disturb texture, `_INK_COLOR_DISTORT`)
and `inkarea_*_postmod` walls of `M_fx_map02_lv007_inkbridge_freelance_wall_*`, in script groups
10200150010, …011 and …021 (on by default). their materials set inner 8, outer 1 and `_DistortAlpha`
0, so they show only within 1–8 m of the player, raised 2 m.

`_INK_DISTORT` and `_INK_COLOR_DISTORT` read the runtime ink simulation, a texture the game draws
around the player (`_InkSimulationWorldToUV`): the first (in VFXDitherAlpha's G-buffer pass too,
where it shifts the main, dissolve and, by `_DisturbTex1UseInkSimulation`, disturb textures) shifts
the UVs by its red and green times `_InkDisturbOffset`, the second blends `_InkColor` in by its
result times `_InkStrength` (at most `_InkMaxAlpha`). both fade on steep surfaces and do nothing
outside the simulation's square, so a scene the player hasn't disturbed draws as without them.

## CharacterNPR_VFX

`HGRP/CharacterNPR_VFX` is an effect layer over a character's skinned mesh: one forward pass, a
fixed-slot stack like VFXAdvance's (main texture, `_DisturbTex1`, mask, blend layer, Fresnel fade
and colour, soft blend, near-camera fade, fog with `_FogIntensity`) with VFXBaseV2's
[screen UVs](#vfxbasev2), and no dissolve but its own `VFX_CHARACTER_DISSOLVE`. its vertex offset is
VFXBaseV2's, but its pull towards the camera is the whole `_VertCameraOffset` plus 1 mm rather than
VFXBaseV2's capped one. Marker Stone Interiors' rift monsters (`p_fxmap_map02_lv004_liexi_only_*`,
about 80 placements, most always shown) are ethillu meshes drawn only in effect materials: a
VFXBaseV2 glow (`M_fx_monster_enemy_etthillu_lsq_01`) and a CharacterNPR_VFX shell
(`M_fx_monster_enemy_etthillu_01d11d12_01_04_01`, and `…a`) pushed 0.25 m out along the normals by
the shader's white offset texture, black but for its pale blue blend layer, edged by a flipped
Fresnel term and flowing along screen UVs taken about the mesh's origin. the shell shows only near
the camera: it fades out between 20 and 40 m (`…a`: 80 and 100 m).

## invisible bridges

Yinglung Pass (map02_lv007) has ink bridges that show only around the player while they carry a lit
fire seed. their pieces are VFXAdvance (`M_fx_map02_lv007_inkbridge_freelance_801`, the
Fresnel-rimmed body; `…_802`, the ink strokes, with a vertex offset) and VFXDitherAlpha (`…_802_01`,
the solid surface) layers, all with `_USE_BRIGHT` and `_USE_GLOBAL_APPEAR`. the bridge between the
pillars west of unity −602, 248, 569 is two script groups of such pieces along x ≈ −623: z 515–534
(group 10200150050, loaded by default) and z 556–587 (10200150054, which only script 10200030004
shows, on custom event `#16fa73e2`). no client data raises that event (no level script, table or
config names it), so the server does: the northern group is server-driven.

**the reveal.** for d the distance from the player's position (`_VFXParams0.xyz`) raised by
`_CharacterHeight`, and `s(x) = smoothstep(_OuterRadius + R.y, _InnerRadius + R.x, x)` with R the
global reveal radii (`_VFXParams3.xy`):

- the tint gains `_BrightColor · s(d)`, its alpha times the vertex alpha with `_BrightUseVertColor`
- the alpha becomes `saturate(mix(a, a · _DistortAlpha, s(d + _DistortOnEdge · n)))`, n a value
  noise in −1…1 (a sine hash of lattice points wrapped to 1024, smoothly interpolated) over the main
  texture's UVs times `_DistortScale`, scrolled by the time times `_DistortSpeed` on both axes

the bridges' materials set inner 2, outer −4 and `_DistortAlpha` 0, so they show within R.x − 4 m of
the player and vanish past R.x + 2 m, over an edge the noise frays by up to `_DistortOnEdge` (1 m on
the body).

**the fire seed.** `FireSeedBrain.SetFireSeedLevel`, run only by the level-script action
`SetFireSeedLevel` (scripts 10200030004 and 10200260001 set levels 0–4), sets R from
`FireSeedGameplayConfig`: without a seed (level 0) its `invisibleBrightInnerRadius` and `…Outer`
(9999 and 50000 m), which leave every revealed effect transparent; at level n, `effectRadius[n − 1]`
(4, 7, 10, 10, 12 m) and that plus `radiusThickness` (0.5 m). the radius eases to a new level over
`fadeTime` along `radiusChangeCurve`. what R holds before any script sets a level isn't recovered.

script 10200030004 runs over the whole pass (an active sphere of 442 m about unity −589, 257, 607).
on the player entering its trigger volume 80001 (two boxes covering the pass) it sets the level to
map variable #142, `fire_seed_level_map`, and on leaving it sets level 0; other custom events set
levels 1–4 (`#72485a44`, `#86ef311f`, `#d5cf68e0`, `#8da37c78`) and 0 (`#e5aceaf8`), and 10200260001
also reads the variable. like those events, nothing in client data writes the variable (MapConfig
only declares it), so the fire seed's level is server-held: no quest or mission state gates it on
the client.

## water blending

VFXBaseV2's `_USE_WATER_BLEND` fades the colour as if seen through water below `_WaterHeight`: it
absorbs by `_WaterAbsorption`/`_WaterAbsorption2` and adds inscattered light over the distance the
view ray travels under that height (`clamp(_WaterHeight − y, 0, 1000) / |view y|`, y the fragment's
world height), and changes nothing above it. the vertex stage is unaffected. a `VFXWaterBlendConfig`
component on the effect sets these from water surfaces it enters (from its fields and method names;
its code isn't read). materials keep an authored `_WaterHeight` of −9999, −999 or 0, below where
they're placed, so placed effects out of water draw as without the keyword. the glows of Aurelyne,
the collectible orbs (`int_collection_coin_*_postmodel`, e.g. in Aburrey Quarry near unity 364, 44,
−700), are such: the orbs placed in map01 and map02 lie at y 18.8 and above.

## soft-body animation

VFXBaseV2's `_VAT_SOFTBODY` plays a Houdini vertex animation: each vertex moves by
`_PositionTexture`'s texel at UV set 1's column and the current frame's row, in object space. the
frame is
`floor(fract((time − _gameTimeAtFirstFrame) · _houdiniFPS / (_frameCount − 0.01) · _playbackSpeed) · _frameCount)`
with `_B_autoPlayback`, else `_displayFrame − 1`; the texel is read at
`(u · a, 1 − b · ((1 − v) + frame / _frameCount))`, where a and b are `1 + x − ceil(x)` for x ten
times `_boundMinZ` and `_boundMaxX` (1 for the bounds seen). textures of HDR offsets
(`_TextureFormat` 1) store them as they are; 8-bit ones a fraction between the `_boundMin*` and
`_boundMax*`. vertices whose UV1 v is at most 0.1 collapse to the object's origin.
`_RotationTexture` holds a quaternion per vertex that turns the normal and tangent from +y and −x.
the wobbling blob at the heart of the Hub's Aurelyne (`M_erosionmud_core`, map01_lv001 near unity
−104, 118, −534) is one, 100 frames looped 3.5 times a second.

## VFXDecal

`HGRP/Effect/VFXDecal` draws a unit box (`s_fx_particle_decal_cube`): each covered pixel finds the
surface behind from the scene depth and, if that point lies inside the box, projects the textures
down the box's y (UV = local xz + 0.5). its roles are fixed: `_MainTex`, `_MaskTex`, `_BlendTex`,
`_DisturbTex1/2`, `_WeightTex`, `_DissolveTex`, each only with its `_USE_*` keyword. a texture's
`*SwitchUV` swaps the box UVs for screen UVs (1: the pixel's position over the width) or polar UVs
(2: about the box's axis, as VFXBaseV2's), each computed only with its keyword and `_UseScreenUV` /
`_UsePolarUV`. the weight texture neither scrolls nor turns, and scales the distortion and the
dissolve by `1 − _WeightTexIntensity + red · _WeightTexIntensity` (`_DisturbUseWeight`,
`_DissolveUseWeight`). the rift in Power Plateau's grating (map01_lv007, near unity −129, 173, 593)
is two such decals around VFXBaseV2 rings and swirls on polar UVs. the colour is `_DecalBaseColor`,
alpha its alpha times `_TintColorAlpha`, faded towards the box's x and z faces (`_EdgeFadeX/Z`, over
`_EdgeFadeIntensity`), its top and bottom (`_HeightFade` around `_HeightFadeOffset`), and with
`_USE_NORMALBLEND` on surfaces facing away from the box's y (`N·up` to the power
`_AngleBlendFallOff`, N the surface's normal). the colour is premultiplied by the alpha twice. under
`Blend One One` the decal adds that colour, and `_BlendMode` 1 drops the fog's in-scatter from it
(its alpha output isn't scaled by the mode): the ground glow under Marker Stone Interiors' flowing
lights (`M_fxmap_dung02_rdg002_flowinglight_02_ground_fj_01`) is such.

`_USE_PARALLAX` sinks the decal into the surface. the view direction, taken in the box's frame (x
and z across, y up), steps the main texture's UVs by `−_ParallaxScale · v.xz / v.y / 30` per layer
through `_DepthTex`'s red, a height that is 1 at the top: from 29/30 down, 30 layers and at most 31
samples, stopping at the first layer below the height, and the shift interpolates between that
sample and the one before. the main texture and `_CrackMask` sample at the shifted UVs (the mask
without the distortion), and `_CrackNoiseTex` at its own UVs (`_ParallaxSwitchUV`, its `_ST`, then
`_CrackNoiseSpeed` per second), shifted by `_ParallaxUseDisturb` of the distortion and by the
parallax. the colour adds
`lerp(_CrackColor · m, noise · _CrackNoiseColor · _CrackNoiseIntensity, m)`, m the crack mask's red,
before the dissolve's edge colour; all three textures default to white. the dissolve doesn't take
the shift. two materials use it: the ash on Marker Stone Interiors' floors
(`M_fxmap_map02_lv004_ash_01_03` in `p_fxmap_map02_lv004_ash_large_01`, placed across indie_dg007),
dark blue under glowing pale cracks on polar UVs, and the core of the erosion-mud anchors
(`M_fx_angel_anchorcore_852`).

off particles its textures shift by their speed's zw times constants of the material
(`_MainCustomData`, `_DisturbCustomData`, `_MaskCustomData`, `_BlendCustomData`,
`_DissolveCustomData`), where VFXBaseV2's take custom data, and its dissolve schedule takes nothing.
under `_USE_IN_PARTICLE` it reads custom data from its own stream layout instead
([below](#particle-custom-data)).

## particle custom data

on a particle, an effect shader's second texture coordinate set holds the particle's custom data c
([custom data](particles.md#texture-sheets-and-custom-data)). the effect shaders share one rule: the
main texture's UVs shift by its `*UVSpeed.zw · c.x` and every other texture's by its own
`*UVSpeed.zw · c.y`, before the rotation, and c.z adds to `_DissolveScheduleOffset`. per shader:

- VFXBaseV2, VFXDitherAlpha, [VFXWater](#waterfalls) and [six-way smoke](#six-way-smoke) (whose
  lightmaps are its main texture) follow it under `_InParticle`.
- [VFXRefract](#refraction) reads the second set without that gate, so on a mesh its second UV set
  stands in: c.x shifts its refraction texture and c.y its mask and blend texture; its dissolve and
  spread UVs aren't shifted.
- VFXDitherAlpha's vertex offset, whose speed's zw c.y also scrolls, is off on particles anyway
  ([vertex offset](#vertex-offset-and-brightening)).
- VFXBaseV2 reads c.w with `_UseParticleDisturb` (off the ink-wash path, where that component holds
  UV0's v): it scales the whole distortion, so a mesh with it set isn't distorted. VFXRefract's
  spread adds c.w to its schedule.
- VFXDecal reads custom data only under `_USE_IN_PARTICLE`, from its own stream layout (box centre
  and 3D size from the Center and SizeXYZ streams, c.xyz from Custom1.xyz). one material uses it,
  `M_fx_map_lv007_angeresidue_2104`, on mesh particles of the decal cube.

no effect shader reads the second custom stream or a colour-mode custom value. the black smoke over
the anchors in dung02_rdg011 (`blackfire01` in `p_fxmap_map_lv006_angel_anchor_smoke_active_1p8`,
`M_fx_angel_anchorlight_834`) gives each particle a random shift of its smoke texture and a dissolve
that climbs from about 0.35 to 0.95 over its life, so its 30–40 m streaks are mostly eaten away by
the time they rise high and long enough to turn visibly with the camera.

## portals

VFXBaseV2 takes its stencil test and write (`_StencilComp`, `_StencilOp`, `_StencilRef`,
`_StencilReadMask`, `_StencilWriteMask`) and its depth test (`_ZTest`) from material properties, and
`_UseVFXPortal` materials use them to show one effect only through another. the glowing cracks in
the Hub's plaza (map01_lv001, near unity −365, 95, −439) are one: an opaque mask on the crack mesh
writes 7 (queue 2000), and the crack's glow and a cylinder of red chasm walls draw only where the
stencil equals 7, without a depth test, so the chasm shows below the ground through the crack. drawn
whole, the cylinder stands on the ground as a solid red ring. the opaque mask is also shaded and
writes its depth, but its effects cover it wherever it shows. other pairs write the stencil from a
transparent layer and draw a second layer only where it didn't (`NotEqual`).

## solid effects

`HGRP/Effect/VFXDitherAlpha` writes the G-buffer like an opaque surface, for effect meshes that are
solid, such as the rocks floating over Origin Lodespring's crater
([mesh particles](particles.md#examples)). the colour is `_TintColor · _TintColorIntensity` times
`_MainTex` (the tint alone with `_UseMainTexAsAlpha`), times `_MainTex2Color` when `_USE_MAIN2`
takes `_MainTex2` as alpha (`_UseMainTex2AsAlpha`) and multiplies (`_MainTex2BlendMode` 0); the
G-buffer pass then doesn't sample `_MainTex2` at all, and the depth pass has no `_USE_MAIN2`
variant, so the texture changes neither the colour nor the dithered alpha. with `_UseLighting` the
colour is the albedo, saturated as the G-buffer stores it, else emitted. `_NORMAL_MAP` adds a
tangent-space normal map (`_NormalScale`; x from alpha times red, as Unity unpacks it); roughness
and metallic are `_Roughness` and `_Metallic`. the shader has no shadow caster pass. the rocks'
material multiplies a gold mask by a tint twelve times over, so the saturated albedo is black rock
with gold veins.

`HGRP/Effect/VFXWaterDitherAlpha` has the same G-buffer and depth passes under another name, with
fewer variants (`_NORMAL_MAP`, `_USE_DISTURB`, `_USE_DISSOLVE`, `_USE_MASK` in the depth pass, and
its own `_SUBSURFACE` and `_USE_SEQUENCE_FRAME_*`). `_SUBSURFACE` lights the surface with the
[subsurface model](materials.md#subsurface), where `_Metallic` scales the scattering instead of
making a metal: the splashes under Wuling City's dam (`M_fxmap_water_citywaterfall_820` in
`p_fxmap_common_citywatersplashes_small_b_802`, near unity −1243, 286, −336) have a grey subsurface
colour and `_Metallic` 0, so nothing scatters and they're plain white foam. waterfall splashes use
the shader: map02 has over a dozen such materials, among them the foam sheet at the foot of Si's
Painting's cave falls (`M_fx_map_common_waterdecal_splashes_2504_01` in
`p_fxmap_map02_lv010_water_splashes_01`, near unity 734, 233, 1151), lit at `_TintColorIntensity` 50
(so its albedo saturates to white) with metallic 0.8, a normal map, and its main texture's red as
the dithered alpha (`_UseMainTexAsAlpha`, raised to 2).

`HGRP/Effect/VFXDitherAlphaNoLighting` is the same surface drawn unlit in a forward pass instead of
the G-buffer, and doesn't declare `_UseLighting`. its depth pass is the dithered test below; the
forward pass then draws only where that depth survived (ZTest Equal, blend One Zero), writing
`_TintColor · _TintColorIntensity` times `_MainTex` (the tint alone with `_UseMainTexAsAlpha`) and
times the alpha before the dither's power. Si's Painting's ink plane
(`M_fxmap_map02_lv010_inkpattern_huge_01_fj_03_d02`, in `p_fxmap_map02_lv010_inkpattern_huge_01`) is
one: its shape comes from a mask texture's red alone.

its depth pass keeps a pixel where the alpha beats an interleaved gradient noise of the pixel
position times `_DitherTilling`, so a fraction of the pixels equal to the alpha survives. the alpha
is `_TintColor.a · _TintColorAlpha` times `_MainTex`'s alpha (its red with `_UseMainTexAsAlpha`),
saturated and raised to `_DitherAlphaExp`. this shapes the dark disc at the centre of Power
Plateau's sky vortex (`blackspot`), a quad whose texture's alpha is a soft round mask.

`_USE_DISTURB`, `_USE_DISSOLVE`, `_USE_POLARUV` and `_USE_SCREENUV` bring in VFXBaseV2's texture
stack: `_DisturbTex1` shifts the main and dissolve UVs (`_MainTexUseDisturb`,
`_DissolveTexUseDisturb`, both 1 by default), each texture's UVs start from its `*UVWeights` of UV0,
UV1, polar and screen UVs, and the dissolve multiplies the tested alpha and colours its edge as
VFXBaseV2's does. the vertex alpha and the near camera fade also scale the tested alpha. the walls
of the rift's ripples are such ([below](#the-very-large-rifts-ripples)).

`_USE_MASK` exists only in the depth pass: `_MaskTex` multiplies the tested alpha by its alpha, or
its red under the default `_UseMaskTexAsAlpha`, and doesn't colour the surface. its UVs scroll,
rotate and take the distortion (`_MaskTexUseDisturb`) like the main texture's. the faint blue band
around the Very Large Rift's portal (`glow_04_line` in `p_fxmap_dung02_dg005_boss_semicircle_01`) is
a mask-only material.

`_USE_VERTOFFSET` moves the vertices as VFXBaseV2's does, in both passes, without the vertex alpha's
weight and the pull towards the camera. the rift's escaping trails
(`p_fxmap_dung02_dg005_boss_semicircle_escapism_trail_02`, children `blue02` and `red02`, placed
around the arena) are such: tall sheets pushed half a metre in along their normals by a scrolling
noise, dissolved and distorted into streaks.

## reflection-only effects

`HGRP/Effect/VFXReflectionPass` is never shaded into the image. its passes are `ForwardReflection`
and two ray-traced reflection passes. the deferred path collects `ForwardReflection` materials into
a draw list of their own, and only the
[screen-space reflection](lighting.md#screen-space-reflections) pass draws it, into the normal,
roughness and depth it marches from, as water does. the pass writes the mesh's normal with a
roughness of 1 wherever its alpha (VFXBaseV2's tint, vertex colour, `_MainTex` and near camera fade)
reaches `_ReflectionPassAlphaCutout`, so behind a transparent effect the reflections are traced from
the effect's surface instead of the opaque one. two materials use it: the Very Large Rift portal's
`quan_ad_01_pass` (dung02_dg005), twin of its VFXBaseV2 `quan_ad_01` ring, and
`zhuangfangyi_shu_04_03_pass` (indie_dg005). what this changes on screen behind the ring isn't
checked against the game.

## refraction

`HGRP/Effect/VFXRefract` draws in a pass of its own after the transparent effects, from a copy of
the scene drawn so far. each pixel shows that copy at its own screen position plus an offset:
`_RefractDir · r · _Intensity · _TintColorAlpha · vertex alpha`, in screen UVs, where r is
`_RefractTex`'s red remapped by `_Bi_Refract` (with `_RefractIsNormal`, the texture's xy as a normal
instead). `_MaskTex` (`_USE_MASK`) multiplies it, and its alpha, or its red under the default
`_UseMaskTexAsAlpha`, blends it over the scene (`Blend SrcAlpha OneMinusSrcAlpha`), faded by the
near camera fade. the vertex alpha scales only the offset, so a mesh whose particle fades out stops
distorting but still covers. both textures scroll by their `*UVSpeed`, rotate by `*UVRotate` degrees
and take UV0, or polar UVs with `_USE_POLARUV` and their `*SwitchUV` set.

`_USE_RBOFFSET` splits colours: the copy is sampled again at a further offset,
`_RBOffset.xy · 0.01 · _Intensity · vertex alpha` (times r, or the normal offset's length, under
`_UseMainTexAsMask`), and each channel keeps the brightest of the refracted sample times
`_RBMainColorMask` and the further one times `_RBOffsetColorMask`. `_USE_RGBOFFSET` does nothing
alone; with `_USE_RBOFFSET` it adds a third sample at `_GOffset` times the further offset, and the
two further samples take `_RBOffset1ColorMask` and `_RBOffset2ColorMask` instead. `_RBIntensity`
blends from the refracted sample to the split. `_USE_SOFTBLEND` fades the alpha over `_SoftDistance`
metres of view depth in front of the opaque scene.

`_USE_DISSOLVE` dissolves the offset:
`d = saturate((r − (_DissolveScheduleOffset · 2.02 − 1.01)) · _DissolveEdgeSharp)`, with r the red
of `_DissolveTex` (UV0 scrolled by `_DissolveUVSpeed`, rotated by `_DissolveUVRotate` degrees about
the centre), scales the refraction offset, so the mask's UVs take the dissolved offset too, but not
the colour split's further shift. `_DissolveAffectBlend` blends the alpha from 1 to `d`. custom data
z adds to the schedule offset ([custom data](#particle-custom-data)).

`_USE_BLEND` tints the refracted scene by `_BlendTex`: the colour is multiplied by
`(1 − _BlendColor.a) + blend.rgb · _BlendColor.rgb · _BlendColor.a` (`_BlendColor` is HDR, used as
stored), and the alpha by the texture's alpha, or its red under `_UseBlendTexAsAlpha`. its UVs
scroll, rotate and switch to polar UVs as the mask's do, and take `_BlendTexUseRefract` of the
refraction offset. `_USE_SPREAD` replaces the cover the mask scales, otherwise 1, with a band that
sweeps across `_SpreadTex`: with s its red (UV0, scrolled by `_SpreadUVSpeed.xy`, rotated by
`_SpreadUVRotate` degrees, never polar), flipped to `1 − s` by `_SpreadFlip`, and R `_SpreadRange`,
the cover is `saturate(1 − |(_SpreadScheduleOffset + c.w) · (1 + 2R) − R − s| / R)` times
`_SpreadAlphaCurve`, c.w the particle's custom data: texels within R of a level that climbs from −R
to 1 + R as the schedule goes from 0 to 1, so the band sweeps from the texture's darkest values to
its brightest and is gone at both ends. no shipped variant pairs the spread with polar UVs.

the fire column at Valley Pass (map01_lv002, `p_fxmap_smoke_range_f_smoke_02` at unity −753, 143,
55, under global variable 4 = 2) uses both: `PatternSmoke01_ref`'s five billboards
(`M_fx_common_smoke_01_02_03_1`) are a heat haze that a normal map pushes the column around in,
tinted warm by a scrolling flow texture and swept in by the spread.

the balloons (`int_balloon_postmodel`) glitch the scene behind their "connecting" sign this way
(`distortion01` in `P_interactive_ballonconnecting`, `M_fx_robotemoji_821`), whose split tints the
main sample magenta (`_RBMainColorMask`) against a cyan further one. Deep Dale Street
(dung02_rdg008) uses a split for the heat haze of its fog walls (`p_fxmap_map02_lv008_fogwall_01`,
child `refract`): particle sheets whose red and blue are pushed apart vertically.

### the Very Large Rift's ripples

in Wuling Very Large Rift (dung02_dg005), waves ripple out from the rift at unity 297, 100, 2: two
prefabs, `p_fxmap_dung02_dg005_boss_semicircle_ripple_01` and `…_ripple_01_ground`, in script groups
37000020004 and 37000020005. both load by default; a 3 m area at the arena's entrance (unity 23.6,
100, 18.7) and the server hide them, so they are the arena's look before the fight. each child is a
one-particle system that emits a mesh every 6 s and grows it over its life, so the rings spread:

- `wenli_02`: a 142 m cylinder of VFXDitherAlpha (dissolve, distortion and polar UVs), the rings'
  patterned walls
- `line_z`, `wai_noise1`: VFXBaseV2 cylinders
- `niuqu02`, and in the ground prefab two 300 m cylinders: VFXRefract, the distortion that travels
  with the rings
- `quan_ad_01`, `quan_ad_02`: half-second flashes at the centre, a VFXDitherAlpha disc and a
  `_BlendMode` 2 VFXBaseV2 quad that multiplies what lies behind

## waterfalls

a falls is a stack of prefab placements: the river surface running down the cliff behind it, one or
two VFXWater sheets (a flipbook sheet and a frothier outer one), [WaterDecal](water.md#waterdecal)
foam boxes at its foot, particle mist and splashes, and FogSimple cards around it. some add a
shimmer: `niuqu` planes of [VFXRefract](#refraction) and VFXBaseV2 `add2`/`dark` planes with a
[vertex offset](#vertex-offset-and-brightening) (`P_fxmap_waterfall_map01lv005_00x`). a few falls
are ECS entities in dynamic streaming chunks instead of prefab placements (a few dozen
`P_waterfall_map02lv001_*` on map02), with VFXWater, VFXBaseV2 or VFXRefract materials. the sheets
of falling water are `HGRP/Effect/VFXWater` meshes (about 1800 placements on map02, in
`P_fxmap_*waterfall*` prefabs). per pixel:

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
- **output.** under `_IgnorePostExposure` the colour, lit share included, is divided by the post
  exposure. `_BlendMode` 1 adds the sheet to what lies behind, as VFXBaseV2's does.

## six-way smoke

`HGRP/Effect/VFXSmoke_SixWay` is Unity's six-way smoke lighting: billboard particles whose two
lightmaps store how much light the smoke lets through from each axis of the particle's frame.
`_PositiveAxesLightmap` holds light from its right, up and the side away from the camera in rgb and
the opacity in alpha; `_NegativeAxesLightmap` holds left, down and the camera's side. Valley's
Aberrants' black smoke columns (`p_fxmap_common_smokeblack_large_01`, `M_fx_damagesmoke_06`, 18–25 m
particles) are drawn with it; dung01_wrdg001 has several such materials. with
`_USE_SIXWAY_LIGHTMAP`, per pixel:

- **UVs.** the lightmaps share one transform: `_LightMapUVSpeed` scroll, a turn of
  −`_LightMapUVRotate` degrees about 0.5, then `_LightMapControls` as their scale and offset (their
  own `_ST` is unused). the mask, blend and dissolve textures take their `_…UVSpeed`, `_…UVRotate`
  (degrees) and `_ST` the same way; the blend texture's `_ST` is applied a second time after the
  distortion. every texture reads UV set 0; `_MaskUVSet` and `_DissolveUVSet` switch the mask and
  dissolve to UV set 1: on particles the UV2 stream, which holds the particle's own UVs without a
  texture sheet, on meshes their UV1. custom data shifts and dissolves as the
  [shared rule](#particle-custom-data) says.
- **switched UVs.** the shader has `_USE_POLARUV` and `_USE_SCREENUV` only together. with them each
  texture's `*SwitchUV` (`_LightMap…`, `_Disturb…` for both distortion textures, `_Mask…`,
  `_Blend…`, `_Dissolve…`) picks where its UVs start before the scroll: 1 the screen position (as
  VFXBaseV2's, v from the world height under `_UsePosYAsScreenV`), times the object origin's view
  depth past the near plane where its `*ScreenDepthUV` is set; 2 polar UVs about UV0's centre (the
  mask's about UV set 1's under `_MaskUVSet`); any other value UV0. the dissolve's `_DissolveUVSet`
  overrides its switch. the fire column at Valley Pass (`smoke001_150` in
  `p_fxmap_smoke_range_f_smoke_02`, `M_fx_lv001_207_09`, 20 stretched 10 m billboards with a fire
  lightmap) switches only its blend layer to the screen, so the red-hot flow texture its
  `_BlendTint` (1.84, 0.25, 0.12) colours drifts across the screen rather than with each particle.
- **distortion.** `_USE_DISTURB` (and `_USE_DISTURB_TEX2` for the second texture): each texture's
  red, remapped by `_Bi_Disturb`, times `_DisturbU/VIntensityN` (or its normal with
  `_DisturbTexNNormal`), summed, shifts the lightmap, mask, blend and dissolve UVs by their
  `_…UseDisturb` fractions.
- **colour and opacity.** as VFXBaseV2's stack without a main texture: `_TintColor` (LDR) times
  `_TintColorIntensity`, alpha times `_TintColorAlpha`, times the vertex colour and `_MaskTex`
  (`_USE_MASK`, red as alpha under `_UseMaskTexAsAlpha`), plus the blend layer (`_USE_BLEND`, its
  tint `_BlendTint` always times the vertex colour), eaten by the dissolve (`_USE_DISSOLVE`), then
  brightened above `_ExpThreshold`. the opacity is that alpha, faded by `_USE_SOFTBLEND` and the
  near camera fade, times the positive lightmap's alpha.
- **absorption.** the colour isn't multiplied in; it sets how strongly each channel is absorbed. a
  lightmap value t lets through `min(R, (saturate(t / R))^k · R)` per channel, with
  `k = 1 − log2(colour) / log2(0.2)` and `R = (_AbsorptionRange + 1/π) / (1 − 1/π)`, so dark tints
  thin the light that passes and white leaves it as stored.
- **lighting.** the main light's direction, in the particle's frame (its x axis, up, and away from
  the camera), weights each lightmap channel by its squared component, picking the positive or
  negative map by its sign; the sum passes through the absorption and takes the light's colour and
  shadow (the shadow is sampled per vertex and tinted by a ramp texture). the irradiance volume at
  the normal takes the sum of all six absorbed channels, desaturated by `_EnvLightSaturation`. the
  game's global scene-effect colour adjustment applies to both.
- **output.** `_USE_FOG` fogs the smoke at its own distance. the materials blend
  `SrcAlpha, OneMinusSrcAlpha`.

## mist

the drifting mist banks are effects too: `HGRP/FogSimple` cards (several hundred on map02,
`SimpleFogCard*`) and `HGRP/Effect/VFXFakeVolumeFog` boxes (a few dozen, `SimpleFakeVolumeFog*`):

- **cards.** alpha is `_MainTex`'s red times `(1 − _FogNoiseIntensity) + noise · _FogNoiseIntensity`
  (`_NoiseTex` red) times `_BaseColor.a`. with `_UseWind`, a second `_NoiseTex` sample at the UV ×
  `_WindScale` (× `_WindScaleX/Y` with `_UseSeparateScale`), scrolling by
  `(−_WindDirX, _WindDirY) · _WindSpeed` per second, remapped by `_WindNoiseContrast` and mixed in
  by `_WindNoiseIntensity`, scales both colour and alpha. the colour is `_BaseColor` (`[HDR]`, like
  `_IndirectColor`, so used as stored); with `_USE_LIGHTING` it's `_BaseColor` times the sun's light
  colour, mixed towards `_IndirectColor` away from the sun by `_LightFactor`, at the normal its
  normal map gives. alpha then fades in over `_DistanceFadeStart…End` and out over
  `_NearCameraFadeDistanceStart…End` metres of view depth, upwards
  (`saturate(h · _TopFadeContract + _TopFadeOffset)`, where `h` is the world height below the card's
  origin divided by the length of its y axis, so a card placed upside down, like the 77 m one at
  Suiming's cave exit, still fades towards the sky rather than the ground), with `_USE_SOFTBLEND`
  within `_SoftDistance` metres of what lies behind, and is scaled by `_BaseAlphaIntensity`. the
  `_UseFresnel` switch (a float, not a keyword) scales colour and alpha after the wind by
  `lerp(1, f^_FresnelContract, _FresnelIntensity)`, f being `1 − N·V` (`N·V` with `_FlipFresnel`), N
  the card's normal facing the camera. `_NoiseTex` defaults to white: Marker Stone Interiors'
  `M_fog_indie_dg007_001` (always-shown 50 m cards, additive at `_BaseColor` 311 with
  `_BaseAlphaIntensity` 0.02) binds none, so its noise and wind change nothing, and its flipped
  Fresnel at intensity 0.28 dims it slightly where the card is seen edge-on.
- **light through openings.** some cards fake daylight falling into a cave rather than mist. at
  Suiming's cave exit (near unity −145, 149, −188) a 77 m card, flipped so its mask
  (`T_fog_smoothradial_grad_01_M`, a half-radial glow brightest along v = 0) lights its top edge,
  glows at `_BaseColor` ≈ (16, 20, 30). from the ledge below it reads as a soft shaft through the
  gap; from above the cave's rocks its straight, nearly opaque top edge shows as a white wall.
- **boxes.** from the nearer of the surface behind and the box's far side, the fog's thickness is
  the distance along the view ray through the unit cube towards the camera (stopping at the camera
  inside it), and alpha is
  `_FogColor.a · _TintColorAlpha · (1 − 2^(−thickness · _FogExponent)) · _FogDensity`, faded within
  `_CubEdgeFade` of the box's axis line, above `_HeightOffset` by `_HeightFalloff`, between
  `_VerticalFalloffMin/Max`, close to boxes the camera can't walk into (`_NearFadeDistance`), out to
  `_FogIntensityFadeDistance` from the point (or the box's centre), and with `_FogDepthStart` in
  from the camera up to that distance, starting at the `_FogDepthEnd` fraction of it. the colour is
  `_FogColor`.
- **box noise.** with `_USE_NOISE3D`, `_NoiseTex3D`'s alpha `n` (a 64³ texture), sampled with repeat
  at the world position (or the box's own with `_NoiseTexUseWorldUVW` off) × `_NoiseTexTilling1`,
  scrolling by `_NoiseUVWDir1 · _NoiseUVWSpeed1` per second, scales alpha by
  `saturate(1 − n + i · n)`. the intensity `i` moves from `_NoiseIntensity` at the camera to
  `_NoiseFarIntensity` by `10 · _NoiseFar` metres. most map02 boxes set 0 near and about −0.3 far,
  so the noise only thins them, and more with distance: dense boxes read as broken drifting banks
  rather than a solid wall.

most cards and every box blend additively; the other cards are premultiplied. the cards' own fog
(`_USE_FOG`) is faded by `_FogIntensity` and `_FogIntensityFadeOutDistance`, and the boxes also
carry a depth prepass. at Sword Vault Dale (map02_lv006) the cards make the haze over the valley's
middle distance.

## blending

the game draws effects after its fog and its water, so mist in front of water covers it, and only
effects with `_USE_FOG` are fogged, at their own distance; the rest stay clear of the fog, as Origin
Lodespring's red light stripes along the crystal ridge (`M_fx_prop_connectline_*`) do.

the transparent pass starts from a copy of the opaque scene (the copy refracting glass samples,
which never holds transparents) and draws, in order: a full-screen scene colour adjustment of the
effect manager's, the water's lighting on the one-pass deferred path, the scan-line post effect,
forward decals, the VFXDecal boxes in a list of their own (so every box lies under every other
effect), glass and effects in one sorted list
([transparent draw order](materials.md#transparent-draw-order)), then world-space UI, rain and snow.
it attaches the depth read-only and writes a second target, the motion vectors, where each bright
transparent pixel (luminance times alpha above 0.05) sets a flag for the temporal pass. the sorted
list takes queues 2900–3100, or 2900–3400 where the frame settings leave low-resolution transparents
off, and starts at 2650 where they leave refraction off; the other transparent queues draw in later
passes (distortion, after distortion, after depth of field, after post-processing). the pass can
render whole at half size and be upsampled, a setting only the one-pass deferred path reads: it
defaults to off, no PC quality level sets it, and the scene-effect saturation adjustment forces it
off.

## one-shot effects

a prefab can carry its own view-state controller (`PostModelViewStateController`, recognised by its
`stateList` and `animatorNode` fields). each state's `effectPlayConfigs` can name an `effectNode`, a
GameObject the state plays as an effect; with `controlActive` set, playing it switches the node on.
an `EffectSetting` MonoBehaviour (recognised by `effectLogicCfg`) under the node says whether the
effect loops (`isLoop`) and for how long it plays (`duration`, in seconds).

a node that is switched off as saved, and whose `EffectSetting`s all have `isLoop` 0, is a burst: it
shows only for the moments after its state plays it, and never at rest. the challenge start point
(`int_challenge_start_point_once_postmodel`) is one: its `OneShot` node, a 3 s ring of expanding
spheres, 40 m decal boxes, a radial blur and smoke, plays when the challenge starts
(`SwitchToRunning`).

the controller's states drive an Animator in the prefab, whose clips switch GameObjects on and off
([activity bindings](animation.md#bindings)). a GameObject switched off as saved that every clip
animating it starts and ends off is never shown by any state. the one-time and repeatable challenge
points share an effect block: in the repeatable one (`int_challenge_start_point_postmodel`) its
rising motes (`dotAdd3stages`) and blue decal are part of the idle and running looks, while the
one-time point's clips hold both off in every state.

## effect LOD tables

an enabled `EffectSetting` lists GameObjects in its `lodSetting` table, each with a `gameobject`, a
quality level and per-distance `_distanceLodInfos` (`isActive`, `speedPercent`). the first time the
table is applied it records each GameObject's saved activity, and from then on it shows a GameObject
only when its LOD entry is on and it was saved on; the only other switch it makes is off. so a
GameObject the table lists and that is saved off never shows through the table, even with `isActive`
1 at every distance, and the table's next refresh switches it back off if something else switched it
on. the Very Large Rift (dung02_dg005) places two `p_fxmap_map02_lv002_qinshihuoyan_middle_01_half`
walls whose `dither` layer (a `VFXDitherAlpha` sheet) is one, beside the drawn `caihong`, `wenli`
and `trans` layers on the same mesh.

the table can list the setting's own GameObject, even a prefab's root. effects placed by dynamic
structures are instantiated as saved and have their table applied when they load, and nothing on
that path switches the root on, so a root saved off and listed in its own table never shows. in
map02 there's one such prefab: `p_fxmap_lv002_fangyuzhenlie_middle_01`, ungated placements of thread
particles and stream meshes along Wuling City's pillar array, beside the drawn `_high_03`,
`_middle_02` and `_middle_03` streams.

with `isUseDistanceLod` set, the setting picks a distance band from the camera's distance to its own
GameObject, whenever either moves. `distanceLodCfgList` holds each band's `distance`; the band is
the last one whose distance the camera is beyond (strictly), else the first, and each listed
GameObject is on in band `i` while its `_distanceLodInfos[i].isActive` is 1. an entry switches its
whole GameObject, so its subtree with it. past `cullDis` the setting stops picking bands, and with
`_isCullDisable` set it switches its own GameObject off, hiding the whole effect, until the camera
comes back within it. `lodFadeTime` fades between bands.

the collectible marker (`int_collection_common_postmodel`, whose view states only switch it off once
collected) is one: bands from 0, 30 and 60 m, culled at 80 m. within 30 m it shows everything: the
triangle icon, its glow card, two line trails, sparks and rings; from 30 to 60 m the icon and the
rings; from 60 to 80 m the icon alone.
