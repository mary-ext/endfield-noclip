# materials

the game's HGRP surface shaders: Lit and its optional layers, alpha testing, emission, foliage,
glass, decals, matte paintings and erosion rock. a material's serialized state is in
[assets.md](assets.md#material-and-shader), the light the surfaces receive in
[lighting.md](lighting.md), and the `HGRP/Effect/*` shaders in [effects.md](effects.md).

## texture layouts

the Lit families (`HGRP/Lit`, `HGRP/LitTransparent`, `HGRP/LitEffect`) and `HGRP/Foliage/Trunk` come
in two texture layouts, picked by `_BaseTextureMapCount` (from the `_TWO_BASEMAP` keyword when the
float is absent: 2 with it, 0 without). LitEffect declares a subset of Lit's properties plus
dissolve and disturb effects; trunks declare no property Lit lacks:

- **MRO layout** (0): a separate `_MROMap` holds metallic in R, roughness in G and occlusion in B,
  and the normal map is stored `RAG` (x is R times A, as in DXT5nm).
- **two-basemap layout** (1 or 2, most materials): the normal map holds the normal in RG, roughness
  in B and occlusion in A. metallic is the base colour's alpha with 1, `_Metallic` with 2.

foliage normal maps hold roughness in B the same way. roughness read from a map is remapped between
`_RoughnessMin` and `_RoughnessMax`, which can be inverted (min 1, max 0, so B holds smoothness).
the map's roughness and occlusion don't depend on the mesh's tangents, which only the bump uses: the
steel display sculpture in Dijiang's hall (`M_prop_map01_zmdlife+1_005_01` on a mesh without
tangents, metallic from the base alpha, range 1 to 0) is a satin metal at roughness about 0.7 from
its map's B, not the mirror that `_RoughnessMax` alone would give.

## forward Lit

`HGRP/LitForward` is Lit drawn in a forward pass instead of the GBuffer; in the packages surveyed
only the golden treasure chest's body uses it (`M_anm_com_treasurechest+1_001_02`, in
`int_trchest_common_gorgeous_postmodel`). its surface inputs are Lit's: the texture layouts, base
colour, `0.08 · _Specular` reflectance, and the emission mask, whose emission is also multiplied by
`_EnableEmissiveMap`. with `_CUSTOM_IBL` its ambient specular comes from the material's own cubemap
(`_CustomIBL`, the chest's a 128² BC6H environment) times `_CustomIBLIntensity`, in place of the
scene's reflections, sampled at a mip from the roughness. its other variants (`_THIN_FILM`,
`_PLANAR_REFLECTION`, `_LAYERBLEND_MASK`) aren't decoded.

## base colour

the Lit, LitTransparent and foliage shaders start from the base colour map times the linearized
`_BaseColor`, times `_BaseColorBrighterScale`, clamped to 1, then blend toward `_BaseColor` by
`_BaseColorTintCover`. the tint matters: Dijiang's black floors and walls are a light grey map
tinted by about 0.3. `HGRP/LitHLOD` ignores the tint.

## alpha testing

alpha-tested HGRP Lit materials (`_ALPHATEST_ON`) test the alpha `_AlphaMaskChannel` picks against
`_AlphaClipThreshold`: 0 for the base colour's, 1 for the normal map's. map01 has 26 materials on
channel 1, all in the two-basemap layout, where the base alpha is metallic; testing that instead
cuts the Hub's white container walls down to their grime streaks.

## emission

HGRP Lit materials emit through one of their `_EMISSIVE_*` keywords. `_EmissiveColor` is an HDR
colour, which Unity's HDR picker authors in linear space (`base × 2^intensity`), so it's used as
stored, unlike the gamma-encoded LDR colours. the result is added to the lit colour without
pre-exposure: the Hub's white ceiling panels store about 24, enough to read near-white with their
grid still visible.

| keyword           | emission                                                                                |
| ----------------- | --------------------------------------------------------------------------------------- |
| `_EMISSIVE_MAP`   | the colour times `_EmissiveMap`'s R channel, plus G, B and A as below                   |
| `_EMISSIVE_MASK`  | the colour times a channel of the material's own maps, picked by `_EmissiveMaskChannel` |
| `_EMISSIVE_NOMAP` | only ships with the sweep animation (`_EMISSIVE_ANIM_SWEEP`)                            |

with `_EMISSIVE_MAP`, Lit and LitEffect also add the map's G, B and A channels times
`_EmissiveColorG`, `_EmissiveColorB` and `_EmissiveColorA` (HDR, as stored), all scaled by
`_EmissiveType`; at 0 only R emits. the stripe rings round the cargo in Dijiang's central shaft
(`M_fx_base01_lv001_ship_line_1123` and `_1125`, `HGRP/LitEffect`) set the type to 1 with red, green
and blue colours, so they glow in their emissive map's own colour bands rather than its red channel
alone.

`_EmissiveSpeed` scrolls the emissive map's UVs (xy per tick of a shader clock whose source isn't
traced); the stripe rings set it to (0, 0.1).

`_EMISSIVE_ANIM` makes the emission pulse: each cycle it rises smoothly from
`_EmissiveMinBrightness` to full and falls back, over the share of the cycle `_EmissiveAnimInterval`
gives it. `_EmissiveAnimSpeed` sets the rate, `_EmissiveAnimRandom` offsets the phase and
`_EmissiveColor`'s alpha sets how deep the pulse goes. the cycle runs on [the clock](#clock), so the
white lamp cubes on Wuling's and Marker Stone's towers (`M_module_tylight+1_001_03`, speed 40) pulse
about every 3 s. `_EnableEmissiveAnimFlicker` swaps the pulse for random on/off flicker, value noise
over time hashed per object position; no map02 material sets it.

`_EMISSIVE_ANIM_SWEEP` (88 map02 materials, among them the clearable rocks and the drones' targets)
lights a band that sweeps up the object along its own y: each emission colour (the main one and G,
B, A) is multiplied by `mix(1, band, alpha)`, so a colour with alpha 1 glows only inside the band
and alpha 0 glows steadily. the band is `_EmissiveSweepWidth` wide, with `_EmissiveSweepFalloff`
sharpening its edge, and moves at `_EmissiveSweepSpeed` from `_EmissiveSweepHeightOffset`, repeating
every `_EmissiveSweepInterval`, phase-shifted per object by `_EmissiveSweepRandom`; inside it the
strength follows the albedo's brightness by `_EmissiveSweepAlbedoScale` and a runtime per-draw
factor. outside the band it is 0. Jingyu's clearable rock
(`M_interactive_hongshan_obstaclerock+1_001_01`) keeps its red cracks lit (alpha 0) and sweeps a
grey glow of 2.1 from its emissive map's G (alpha 1), which covers the whole rock.

each draw also carries a runtime emission colour in its per-draw data, which replaces
`_EmissiveColor` by its alpha. the static scenery's files store it as zero, and the client's known
setters work on GameObject renderers (interactives' emissive configs, VFX-driven emission).

one of those setters is the `AnimationProperties_Emissive` component, a VFX playable that starts
playing when enabled and then writes its `emissiveColor` into that colour on each renderer it lists
(`affectRenderers`), so a prefab can author its resting emission colour there instead of on the
material. `_EmissiveColor`'s own alpha still sets the pulse or sweep depth. the water drone targets
(`int_waterdrone_floating_target_postmodel`) keep a black `_EmissiveColor` on
`M_anm_map02_machine+1_003_02` and glow green (0, 1, 0.17, alpha 1) from their emissive map's R
through the component; their G channel only lights inside the sweep band. the component also sets an
albedo tint where R is at least 0.1, weighted by `emissiveAlbedoColor`'s alpha (0 on the targets),
and a breathing pulse (`breathFrequency`, `breathIntensity`; 0 on the targets). the white lamp cubes
on Wuling's and Marker Stone's towers (`M_module_tylight+1_001_03`) don't take a colour from it:
they emit white, and the green and red glow over them comes from one effect prefab per tower, placed
always ([pull towards the camera](effects.md#vertex-offset-and-brightening)). Wuling's
(`P_fxmap_map02_lv002_citywall_lighting_02`) emits a round glow and a 40 × 5 m horizontal streak at
each lamp from a mesh of their positions, both teal (`_TintColor` 0.45, 0.84, 0.75), added; Marker
Stone's (`P_fxmap_map_lv004_lamp_light_01`) draws red.

the mask channel is 0 for no emission, 1 for the base colour's alpha, 2 for the normal map's B
(two-basemap layout) or the base alpha (MRO layout), and 3 or more for the normal map's alpha
(two-basemap) or the MRO map's alpha; the channel is remapped by `saturate((m − 0.05) / 0.9)`. the
Hub's ceiling panels use mask channel 3. emission is multiplied by the albedo unless
`_AlbedoAffectEmissive` is 1. `_IgnorePostExposure` emitters (nearly all) divide out the post
exposure ([auto exposure](post-processing.md#auto-exposure)), so they keep their brightness however
the exposure adapts.

## lit layers

these optional Lit layers come from the game's shader for these keywords. each map samples UV set 0
or 1 as a float of its own says: `_BaseUVSet` for the base colour, `_BasePbrMapUVSet` for the normal
and MRO maps, `_DetailUVSet`, `_MaskUVSet` and `_EmissiveUVSet`. the slot's `m_UVSetIndex` stays 0
on hundreds of materials whose maps sample UV set 1, such as Power Plateau's concrete walls, whose
tri-channel mask spreads weathering streaks over UV set 1. the originium crystals' base colour and
detail map tile ×5 over UV set 1.

- **`_TRI_CHANNEL_MASK`** (~450 map01 materials, mostly rock): each channel of `_MaskMap` becomes a
  weight `saturate(s/2 + mix(−s, 1, m + offset)) · _MaskAlbedo*.a`, with contrast `s` from
  `_Mask*Scale` and the offset from `_Mask*Offset`. albedo, roughness and metallic then blend toward
  `_MaskAlbedo*` (an LDR colour, linearized), `_MaskRoghness*` and `_MaskMetallic*`, B first and R
  last. the originium crystals are grey rock tinted brown at strength 0.5 where R is set. the
  `_TRI_CHANNEL_MASK_SWITCH_TEXTURE*` variants colour G and B from textures instead
  (`_MaskAlbedoGTex` and `…BTex`, tiled by `_MaskAlbedoGUVTilling` and `…B…`, times
  `_MaskAlbedoTintG` and `…B`, whose alpha is the strength). `_UseMaskRUVSetAndTilingScale` samples
  the mask's R from `_MaskRUVSet` tiled by `_MaskRTilingScale`; no map01 material sets it.
- **`_DETAIL_MAP`**: a weight from `_DetailMaskMode` (1, the detail's alpha, the base colour's
  alpha, or the normal map's B or A) fades out with view depth between `_DetailFalloffStart` and
  `…End`. the detail normal (`× _DetailNormalIntensity`) is reoriented onto the base normal.
  `_DetailMode` 1 blends roughness toward the detail's B and multiplies occlusion by its alpha; mode
  0 overlays `_DetailOverlayColor` where the detail's B is dark, and blends roughness toward its
  alpha. both blends are scaled by `_DetailPBRIntensity`.
- **`_PARALLAX_MAP`** (the originium crystals' glow): the view ray, in the geometric tangent frame,
  steps `trunc(_ParallaxMarchNum)` times (at most 20) through `_ParallaxNoiseMap` (tiled by
  `_ParallaxNoiseMapTilling`) as a height field `_ParallaxStrength` deep, and the hit is refined
  between the last two steps. at the hit, `_ParallaxMap`'s G (tiled by `_ParallaxTilling`; both maps
  ignore their `_ST`) picks between `_ParallaxColorDark` and the HDR `_ParallaxColor`, both times
  `_ParallaxIntensity`. the result is emission: times the mask channel squared
  (`_ParallaxMaskChannel`, numbered like the emission mask minus one), times `N·V` to the power
  `floor(_ParallaxFresnelStrength)`, and times a pulse
  `cos(_ParallaxAnimSpeed · T + _ParallaxAnimRandom · (x + y + z))` remapped to
  `[_ParallaxMinBrightness, 1]`, where `T` is [the clock](#clock) and `x + y + z` is the object's
  world position. with `_ParallaxCharPos` set, `_ParallaxBrightStrength` times a smoothstep from
  `_ParallaxBrightOuterRadius` down to `…InnerRadius` of the distance to the player is added to the
  pulse. on map01 seven crystal materials use it, mostly with strength 20 within 3–25 m; one stores
  a glow colour of only 0.75, so it glows almost only near the player. `_ParallaxIgnorePostExposure`
  divides out the post exposure as emission does. the shader declares both maps' default black, and
  many crystals leave the noise map empty (the campfires' crystal `M_interactive_campfire+1_003_02`,
  the display crystal `M_iprop_map01_zmdmachine+1_009_02` and Dijiang's far crystal
  `M_building_dijianghao+1_001_11`): the height is then 0 everywhere, the march runs its full depth,
  and the pattern is read at that fixed offset.
- **`_MATCAP`** (the campfires' crystal, a few Dijiang props): `_MatcapMap`, sampled at the
  view-space normal's `xy · 0.5 + 0.5`, times `_MatcapMapStrength`, is added to the emission, not
  tinted by the albedo. `_MatCapIgnorePostExposure` divides out the post exposure as emission does.
- **`_LAYERBLEND_TOP`** (moss and sand on rock tops; ~220 map02 materials, 33 on map01): a second
  material covers the surface by `saturate((up − _TopBlendThreshold) / _TopBlendSmoothness)`, where
  `up` is the world Y of the vertex normal, blended toward the normal-mapped one by
  `_TopBlendWithBumpMap`. with `_LayerBlendHeight`, the base's height and `_Layer1BaseMap`'s alpha,
  each weighted by its coverage, compete within `_LayerBlendHeightTransition`. the layer's colour is
  desaturated by `_Layer1Saturation`, tinted by `_Layer1TintColor`, brightened by
  `_Layer1ColorBrighterScale`, and replaces the albedo (`_Layer1BaseColorBlendMode` 0) or adds to it
  (1, times `_Layer1BaseColorAdditiveIntensity`). roughness blends toward `_Layer1BumpMap`'s B,
  occlusion toward its A (by `_Layer1AOStrength`, or 1 with `_LayerAOType`), metallic toward
  `_Layer1Metallic` or the layer's alpha (`_LayerMetallicType`), and the layer's normal (×
  `_Layer1BumpScale`) is reoriented onto the base's by `_Layer1BaseNormalIntensity`. it applies
  after the detail map and the tri-channel mask. both maps sample one coordinate picked by
  `_LayerBlendUVType` (UV set 0, world XZ, or UV set 2), times `_Layer1Tilling` plus
  `_Layer1Offset`, ignoring their `_ST`. no mesh map02 draws with a UV-set-2 layer has that set, and
  the game reads a missing UV set as set 0 (an in-game shot of a Jingyu moss rock shows the moss
  tiling over UV set 0; see [open](#open)). two all-moss rock materials have no base colour map, so
  their base is white and the layer is all they show.
- **`_LAYERBLEND_MASK`** (~200 map02 materials): the same layer, covering by a mask instead of
  facing up: `_LayerBlendMaskMap`'s R, sampled untiled from UV set 0 (UV set 1 when
  `_LayerBlendMaskUVType` is 0, whatever the slot's own set), or with `_LayerBlendMaskType` 1 to 4
  the layer bump map's alpha, the base colour's alpha, the normal map's alpha, or 1.
- **`_LAYERBLEND_MOSS`** (with either layer; the rabbit-hole resource mounds): shades the layer as
  moss. with `f = 1 − N·V` of the blended normal and the raw coverage `c` (the mask, or the top
  coverage before the height blend), the edge term
  `e = saturate(1 − (c − _Layer1FuzzyEdgeShadowOffset)² / _Layer1FuzzyEdgeShadowRange)` darkens the
  layer's colour by `_Layer1FuzzyEdgeShadowIntensity`; the colour is then scaled by
  `mix(1 − _Layer1FuzzyCoreDarkness, 1, f^_Layer1FuzzyDarkPower)` and brightened towards the
  silhouette by `_Layer1FuzzyEdgeBrightness` times twice its luma, by `f^_Layer1FuzzyBrightPower`
  (both powers at least 0.1). the world normal tips down by `e · _Layer1FuzzyNormalStrength`.

## foliage

the game lights foliage with its own deferred model, fed by what each foliage shader writes into the
GBuffer: a sun shadow term, the diffuse N·L, a transmission amount and a subsurface amount. per unit
of the sun's illuminance, before the shadow map and cloud shadow:

- diffuse: albedo × the stored N·L / π, with no `(1 − F)`
- specular: the usual GGX, times `mix(sat(n·v + 0.2) · sat(sat(v·l) + 0.5), 1, sat(v·l + 1))`, which
  dims it only for views from behind the leaf
- transmission: the albedo divided by its largest channel, × the transmission × `sat(0.5 − n·l)` × a
  GGX lobe of α² = 0.36 about the direction to the sun (peaking for a viewer looking at the sun),
  over π
- wrap: albedo × `(sat(n·l + subsurface) − sat(n·l))` / π
- all four are multiplied by the sun shadow term

`HGRP/Foliage/Leaf` fills the inputs from its material and the mesh's vertex colours (R ambient
occlusion, A height in the canopy):

| input                                                        | effect                                                                                                                                                                                   |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_OcclusionShadow`                                           | sun shadow × `mix(1, R, _OcclusionShadow)`                                                                                                                                               |
| `_FakeDirectionalShadowStrength`, `…Pow`                     | sun shadow × `sat(1 − pow(n·d · 0.5 + 0.5, pow) · strength)` with `d` the sun's direction of travel: leaves facing away from the sun darken                                              |
| `_DiffuseUseVertexNormal`                                    | the diffuse N·L takes the mesh's vertex normal as stored (not turned towards the viewer) instead of the normal-mapped one                                                                |
| `_OcclusionStrength`                                         | material occlusion `mix(1, R, strength)`, on ambient only                                                                                                                                |
| `_Transmission`, `_TransmissionDistanceFade`                 | transmission × (1 − the normal map's alpha), faded out between 50 and 60 m from the object with the fade on                                                                              |
| `_SubsurfaceIntensity`                                       | the wrap amount                                                                                                                                                                          |
| `_AoAffect{Transmission,Subsurface}{Start,Range}`            | transmission and subsurface × a smoothstep of the material occlusion over the range                                                                                                      |
| `_CANOPY_COLOR_RAMP`: `_CanopyRamp{Color,Intensity,Range,…}` | albedo blends toward the colour (times the albedo, brightened, or covering it) by `smoothstep(range + transition, range, A)` × (1 − normal alpha) × intensity; `…StartAtTop` reads 1 − A |
| `_Reflectance`                                               | F0 `0.08 · (0.5 + 0.75 · r)`, `r` quantized to 3 bits                                                                                                                                    |

on the cherry trees of Marker Stone's pits, whose phases ship an 80–100 klx sun, this is what keeps
the blossoms from blowing out.

`HGRP/Foliage/Grass` and its card LOD `HGRP/Foliage/Grass Cardmesh Lod` fill the same inputs. `h` is
the vertex's height, measured from a point tens of metres below the root, which over a blade comes
to the same as its object-space height:

| input                                                       | effect                                                                                                                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_BendNormalUpward` (grass only)                            | the normal map's XY blends toward tangent-space +Y, up the blade, before `_NormalScale` scales it; the shading normal and N·L both take the bent normal, so blades shade evenly |
| `_TwoSidedNormal` (grass only)                              | back faces flip only the surface normal, so the bent normal still points up the blade                                                                                           |
| `_AoParams` (x, y, z)                                       | material occlusion `mix(z, 1, sat((h − x) · y))`: darker at the root                                                                                                            |
| `_DirParams` (x, y, z)                                      | a sun mask `d = mix(z, 1, sat((h − x) · y))`                                                                                                                                    |
| `_MaskOnDiffuse`, `_MaskOnTransmission` (grass only)        | the diffuse and transmission masks are `d · mix(1, a, …)` with `a` the normal map's alpha; the sun shadow is their maximum and transmission × (1 − their difference)            |
| `_Transmission`                                             | transmission × 0.5                                                                                                                                                              |
| `_SubsurfaceIntensity`                                      | the wrap amount                                                                                                                                                                 |
| `_USE_CAMERA_BASED_TILLING`: `_CameraBasedTillingIntensity` | each vertex moves `h` × intensity metres along the camera's up vector flattened onto the ground: blades lean away from the camera and cover more ground seen from above         |

both write a reflectance of 4/7. the card LOD decodes its normal map differently and masks by its B.
the grass grids also carry a per-instance colour ([world](world.md#foliage-grids)): the second
parameter vector's RGB, covering the albedo by its A.

## glass

`HGRP/LitTransparent` is the glass shader (16 materials on map01: windows and glass walls such as
the Originium Science Park offices). its materials alpha-blend (`_EnableAlphaBlend`, source alpha
over one minus source alpha, queue 3000, no depth write) and use Lit's texture layouts; some set the
source factor to one instead, which suggests premultiplied colour, unchecked against the shader.
Fresnel opacity (`_UseFresnel`, `_FresnelAffectOpacity`) is off on every map01 material. the shader
also declares screen refraction (`_IoR`, `_RefractionIntensity`, `_RefractThickness`,
`_RefractTint`, `_RefractTex`, `_UseProbeRefraction`) and planar reflection
(`_EnabledPlanarReflection`); how they shade isn't decompiled.

the base variant (no keywords) writes straight colour: Lit's shading, fogged in the shader at the
glass's own depth (height, atmosphere and volumetric fog), then the scene-effect grade
(`_VFXParams1`). its opacity is `_BaseColorMap.a · _BaseColor.a` (times the vertex colour's red with
`_Use_VerexTexColorAsOpacity`); the alpha channel blends `One, OneMinusSrcAlpha`. Dijiang's deck
glass (`M_common_glass+1_001_03b`) is 180/255 opaque across its whole map, so 29% of what lies
behind it shows through.

### transparent draw order

glass and effects share one list. the transparent pass copies the opaque scene into its own target,
then draws decals, then every queue 2900–3100 renderer (both the static ECS scenery and GameObject
renderers such as prefab effects, whose shaders are all `LightMode` `ForwardOnly`) in one order:
each side is sorted back to front (sorting layer, render queue, then distance, then renderer
priority, Unity's `CommonTransparent`) and the two sorted lists are merged by their keys, farther
first. so an effect kilometres behind a window draws first and the window blends over it. the
sorting layer criterion covers a renderer's `m_SortingLayer` (the layer's place in the layer order)
and then its `m_SortingOrder`, lower first; prefab effects use the order to stack parts that share a
centre: the blue talosite's dark backing card (`glow01_andi`) is −4, its light column and ground
glow −2, its upper glow line −1, and its shards and star icon 0, so the card always draws behind the
icon. `_TransparentSortPriority` (±50) acts only through the material's render queue. at PC settings
nothing renders transparents at half size, so the order holds there. what distance each side sorts
by (bounds centre, most likely) isn't traced.

## decals

`HGRP/DecalLit` is the scenery's projected decal: moss, sand, stains, cracks and tyre tracks laid
over floors and rocks (the green floor of Power Plateau's grass cave, map01_lv007 near unity −102,
147, 524, is nine moss decals over grey concrete). each is a rect decal entity
([world](world.md#initchunkdata-layout)): a box whose matrix maps a unit cube, the decal's material,
and per placement a UV scale and offset, an RGBA8 colour and an intensity. the game draws the box
into its GBuffer after the opaque scenery, overlapping decals in their `_DrawOrder`. each covered
pixel finds the surface from depth, and only points inside the box take the decal, which projects
down the box's y. the decal pass tests the stencil (reference 0, read mask 32, equal), which the
scenery's GBuffer pass fills with each material's `_StencilRef` (`HGRP/Lit`, the foliage shaders and
their card LODs; `HGRP/LitHLOD` writes 0 whatever its material says), so surfaces whose
`_StencilRef` has bit 32 never take a decal. most foliage has it (map02's grass and leaves 33,
trunks 32), so the blight's erosion decals (`M_rdecal_com_effect_erosion…`, whose base map is an
iridescent oil-slick pattern) colour the ground and rocks of Sword Vault Dale but not the grass and
trees on them. the compare is read from the pass's shared stencil state; its per-face states say
always.

- UV: `(local.xz + 0.5) · scale + offset`, for `_BaseColorMap` and `_SampleTex1` (the PBR map:
  normal RG, roughness B; with `_SampleTex1UVSet` it takes its own `_ST` of the box's UVs instead)
- albedo: the placement's colour as stored (not gamma-decoded) × its intensity × the base map's RGB;
  with `_BaseTexChannel` the base map is the PBR map and the colour stands alone
- alpha: the base map's alpha × the colour's alpha × `_DecalOpacity`, and with `_NORMAL_ANGLE_BLEND`
  × `sat(y · N)^_AngleBlendFallOff` with `y` the box's axis and `N` the surface's normal, so walls
  the box reaches stay clean
- roughness: `mix(_RoughnessMin, _RoughnessMax, B)`
- normal: the PBR map's RG × `_NormalScale` in the box's frame (x tangent, y normal), or towards the
  surface's by `_BlendSceneNormal`; the result blends from the surface's normal by `_AffectNormal`
- metallic and occlusion: `_Metallic` or a channel of `_SampleTex1` by `_MetallicChannel` (2–5 pick
  R–A), occlusion a channel by `_OcclusionChannel` (1–4) applied by `_OcclusionStrength`

each target blends by the alpha, and the material's colour masks pick what's written: `_ColorMask3`
the albedo, `_ColorMask2` the normal (RG) and roughness (B), `_ColorMask1` metallic (R) and
occlusion (G). the editor derives them from `_AffectNormal`, `_AffectRoughness` and the like; the
moss writes albedo and roughness only. some decals write no albedo at all: they roughen or bump the
surface beneath (Wuling City's terraces), or make it look wet.

`_BLEND_EMISSIVE` decals also glow, as Deep Dale Street's purple patches do (dung02_rdg008 near
unity 13, 92, −21). the GBuffer's emission target is always written, its RGB laid over by the same
alpha, whatever the colour masks: `_EmissiveColor` × a channel picked by `_EmissiveChannel` (0–3
`_SampleTex1`'s R–A, 4 the base map's alpha) × the albedo above, or 1 with `_AlbedoAffectEmissive`;
under `_IgnorePostExposure` it's divided by the post exposure.

`_BLEND_WATER_FLOW` is the wet rock beside waterfalls (Jingyu Valley's falls near unity −1075, 207,
−1414). it writes only normal and roughness, from `_WaterNormalTex` sampled at world positions
rather than the box's UVs:

- the map is projected along x (at world zy) and along z (at world xy), each times its `_ST` scale,
  and the two blend by the surface normal's squared x and z, normalized to sum to 1
- two layers scroll down the world's y: UV scale `_UVMovement.z` with speed `.x`, and `.w` with `.y`
  (in UVs per second); steep walls push both further by `steep · _NormalFactor`, where
  `steep = (1 − |N.y|)^_AngleBlendFallOff2`
- the four samples' normals (decoded like the PBR map's) sum, their xy times `_WaterNormalScale`,
  into the box's or the surface's frame as above
- roughness: `_WaterRoughness` × the mean of the first layer's two B samples
- alpha: the base map's alpha × the colour's alpha × `_DecalOpacity` × `steep`, so level ground
  stays dry

## matte paintings

`HGRP/MattePainting` draws the painted mountain ranges on the horizon: a few alpha-tested ring
segments, 600–1000 m from their origin and 1000 m tall, carrying one wide texture (map01's is
4096×512). they're unlit: the colour is `_MainTex` times `_TintColor · _TintColorIntensity`, plus
`_ExpIntensity` times whatever exceeds `_ExpThreshold`, in pre-exposed units unless
`_IgnorePostExposure` is set. alpha is the texture's times `_TintColor.a · _TintColorAlpha`, clamped
to 1 and tested against `_AlphaClipThreshold`. the shader has no shadow pass, so they don't cast
shadows.

## erosion

`HGRP/Erosion` draws the dark blight rock that grows over the Originium Science Park and other map01
areas. it has no base colour map; the colour comes from its other maps:

- `_MetalMixMap` R is 0 where the surface is metal. there the colour becomes `_MetallicColor`, the
  roughness 0.01 and the metallic `_Metallic · (metal − _MetallicOffset)`; elsewhere it's
  `_BaseColor`, with roughness `_Roughness` times the map's A, blended toward the detail map's alpha
  by `_DetailRoughnessCover`. G is occlusion (by `_OcclusionStrength`) and B masks the flow band.
- a noise layer: `_NoisePatternMap`, shifted by one parallax step `_NoiseStrength` deep, tinted by
  `_NoisePatternTintColor` and the base normal map's alpha, scaled by `max(N·V, _NoiseMin)` and
  faded out by distance over `_DistanceBlend` metres. it's added to the colour and, times
  `_NoiseEmissiveStrength`, to emission.
- a flow band: `_FlowRampMap` read along the object-space height (`× _FlowNormalTilling`, plus the
  metal map's G `× _FlowNoiseStrength` and `_FlowSpeedOffset`, scrolling by `_FlowNormalSpeed` times
  [the clock](#clock)), coloured `_FlowBottomColor` below the height `_FlowColorOffset` and
  `_FlowTopColor` above it. it adds `_FlowColorStrength` of itself to the colour where the metal
  map's B is set, `_FlowColorEmissiveStrength` to emission elsewhere, and lowers roughness by
  `_FlowRoughness` times its brightness.
- the base and detail normal maps (each with its own scale) are summed; metal flattens the bitangent
  component.

every map samples UV set 0 and tiles by its own `*Tilling` property rather than its `_ST`. the
metal, noise and flow colours are HDR and used as stored, like `_EmissiveColor`. the shader also
blends softly into whatever lies behind (`_ObjectBlend*`, which reads the scene depth).

`HGRP/ErosionDynamic` (animated, glowing) is used only by the `P_erosion_map01_dynamic…` prefabs,
the erosion patches the player clears. their load gate shows them while a map variable is not 2,
that is until their core is destroyed ([blight and its cores](scene-states.md#dynamic-load-gates)).

## swaying cloth

`HGRP/Lit` materials with `_SIMPLE_VERTEXANIM` and `_SIMPLE_VERTEXANIM_CLOTH` (map02's kites, flags,
canvases and logos; 26 materials in the scenes surveyed) sway in the wind in the vertex stage of
every pass. the offset is added in world space after the object-to-world transform, and only when
`_SimpleVertexAnimationWindIntensity + _NoiseOffsetIntensity` is non-zero and the vertex colour's
alpha `a` is. with `I` the intensity, `F` `_SimpleVertexAnimationWindFreq`, `S` the soft factor, `T`
`_DirectionTendency`, `t` [the wind clock](environment.md#wind) and `x₀` the object's world X:

- `_Kite` non-zero: `s = sin(t · F + lerp(0, y · S − a · π, _Kite) + x₀) · y` with `y` the
  object-space height, and amplitude `I · 0.05`
- otherwise: `s = sin(t · F − z · S − a · 3.14 + x₀)` with `z` the vertex's world Z, and amplitude
  `I · 0.5`

the offset is `direction · (s + 1 + T) · amplitude · a`, where `direction` is horizontal: the
material's own (`cos, 0, sin` of `_MainDirectionAngle` in degrees, through truncated Taylor series)
when `_Use_Custom_WindDir` is set, otherwise the wind's. the previous frame's offset, for motion
vectors, uses the previous wind clock. a per-pass `_DisableAnimateVert` scales the offset by
`1 − value`; what each pass sets it to isn't known. `_NoiseOffsetIntensity` enters only the gate in
this variant.

`_SIMPLE_VERTEXANIM_PENDULUM`, `_SIMPLE_VERTEXANIM_ROPE` and `_GPU_CLOTH` are other branches of the
same family, not described here; the cloth materials that also enable `_GPU_CLOTH` are simulated
rather than swayed.

## clock

the animated surface terms share one rate, `T` = seconds / 20: the emission pulse reads Unity's
`_Time.x`, which Unity defines as seconds since startup / 20, and the parallax glow's pulse and the
erosion flow advance 0.05 × their speed per tick of the shader clock. that HGRP keeps Unity's
`_Time` and that its clock ticks in seconds are assumed.

## open

- the [clock](#clock)'s rate, and the clock that scrolls the emissive map
- the detail map's channels per `_DetailMode` (roughness from B in mode 1, from the alpha in mode
  0), unchecked against a shot
- the layers' UV set 2 read as set 0, on the strength of map02's meshes and one in-game shot
- what sets the per-draw emission colour of static scenery (the [tower lamps](#emission))
- whether premultiplied [glass](#glass) multiplies its colour by its alpha, and how glass refracts
- what the game does with the bump on meshes without tangents
