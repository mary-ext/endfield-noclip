# lighting

the viewer's lighting and post chain, which environment-profile fields drive each part, and the
baked irradiance volume (`HGIrradianceVolume` v3) as a format. the profile itself (phases, volumes,
blending) is in [environment.md](environment.md); materials and the render pipeline's structure are
in [viewer.md](../viewer.md) and [assets.md](assets.md).

the game (HGRP, a deferred PBR pipeline in Hypergryph's Unity fork) lights in physical units with a
fixed exposure. the viewer does the same: `preExposure = 1 / (1.2 · 2^directEV100)`, and the sun,
ambient probe and fog colours are all pre-exposed, so shaded values reach the tonemapper around 0–2.
emission is authored in those units already ([below](#emission)). the game packs most profile fields
into shader constants on the CPU; where that packing is known, the viewer follows it, and where it
isn't, the viewer substitutes and the gap is listed under [open](#open).

[`render/environment.ts`](../../packages/viewer/src/render/environment.ts) (`deriveEnvironment`)
turns a blended profile into the renderer's `Environment`; packages without profiles get a built-in
default look.

## sun

| input                                  | effect                                            |
| -------------------------------------- | ------------------------------------------------- |
| `light.directLux`, `light.directEV100` | pre-exposed illuminance `directLux · preExposure` |
| `light.directColor`                    | sun colour (decoded from sRGB)                    |
| `light.directPitchYaw`                 | direction of the shading and shadow-casting sun   |
| `light.directSpecularIntensity`        | scales the sun's specular lobe                    |

the game gives every sun-drawn effect its own direction (`<effect>PitchYawMode` 0 follows the light,
1 uses `<effect>PitchYaw`; `rotation*` quaternions are the resolved results). the viewer reads the
atmosphere's (`atmospherePitchYaw` per its mode) for the sky, `rotationAtmosphere` for the
atmosphere fog and `rotationHeightFogDirectionalInscattering` for the height fog's directional term.
art direction often moves these away from the light, so don't substitute the shading sun for them.

direct lighting is GGX with height-correlated Smith visibility and Lambert diffuse in
[`shaders/frame.wgsl`](../../packages/viewer/src/render/shaders/frame.wgsl); foliage takes the
game's two-sided model ([below](#foliage)).

### foliage

the game lights foliage with its own deferred model, fed by what each foliage shader writes into the
GBuffer: a sun shadow term, the diffuse N·L, a transmission amount and a subsurface amount. the
viewer evaluates the same model per pixel (`foliage_sun` in `frame.wgsl`). per unit of the sun's
illuminance, before the shadow map and cloud shadow:

- diffuse: albedo × the stored N·L / π, with no `(1 − F)`
- specular: the usual GGX, times `mix(sat(n·v + 0.2) · sat(sat(v·l) + 0.5), 1, sat(v·l + 1))`, which
  dims it only for views from behind the leaf
- transmission: the albedo divided by its largest channel, × the transmission × `sat(0.5 − n·l)` × a
  GGX lobe of α² = 0.36 about the direction to the sun (peaking for a viewer looking at the sun),
  over π
- wrap: albedo × `(sat(n·l + subsurface) − sat(n·l))` / π
- all four are multiplied by the sun shadow term

`HGRP/Foliage/Leaf` fills the inputs from its material
([`leafParams`](../../packages/viewer/src/render/materials.ts)) and the mesh's vertex colours (R
ambient occlusion, A height in the canopy):

| input                                                        | effect                                                                                                                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_OcclusionShadow`                                           | sun shadow × `mix(1, R, _OcclusionShadow)`                                                                                                                    |
| `_FakeDirectionalShadowStrength`, `…Pow`                     | sun shadow × `sat(1 − pow(n·d · 0.5 + 0.5, pow) · strength)` with `d` the sun's direction of travel: leaves facing away from the sun darken                   |
| `_DiffuseUseVertexNormal`                                    | the diffuse N·L takes the mesh's vertex normal as stored (not turned towards the viewer) instead of the normal-mapped one                                     |
| `_OcclusionStrength`                                         | material occlusion `mix(1, R, strength)`, on ambient only                                                                                                     |
| `_Transmission`, `_TransmissionDistanceFade`                 | transmission × (1 − the normal map's alpha), faded out between 50 and 60 m from the object with the fade on                                                   |
| `_SubsurfaceIntensity`                                       | the wrap amount                                                                                                                                               |
| `_AoAffect{Transmission,Subsurface}{Start,Range}`            | transmission and subsurface × a smoothstep of the material occlusion over the range                                                                           |
| `_CANOPY_COLOR_RAMP`: `_CanopyRamp{Color,Intensity,Range,…}` | albedo blends toward the colour (times the albedo, brightened, or covering it) by `smoothstep(range + transition, range, A)` × (1 − normal alpha) × intensity |
| `_Reflectance`                                               | F0 `0.08 · (0.5 + 0.75 · r)`, `r` quantized to 3 bits                                                                                                         |

on the cherry trees of Marker Stone's pits, whose phases ship an 80–100 klx sun, this is what keeps
the blossoms from blowing out. grass and card-mesh foliage take the same model with the transmission
alone (shadow 1, N·L from the shading normal, no wrap); their shaders' own inputs aren't decoded.
not drawn: trunk ramps and vertex AO (`_EnableTrunkRamp`, `_TrunkVertexAoStrength`; trunks otherwise
shade as Lit), sphere-shadow proxies (`_UseSphereShadowProxy`), the vertical-normal AO boost,
broadleaf indirect transmission, contact shadows on foliage, and the per-instance tint some leaves
get.

## shadows

the game's PC high layout: three sharp cascades out to 12, 30 and 80 m, then a coarse layer the game
keeps as a cached, tiled shadow map out to 800 m (its ASM, `HGASMManager`, which the package's
`asm*` shadow fields configure). the viewer draws all four as 2048² `depth32float` layers fitted to
bounding spheres of frustum slices and snapped to world texels so edges don't crawl
([`render/shadow-map.ts`](../../packages/viewer/src/render/shadow-map.ts)). turning the camera
doesn't change a sphere's fit. casters are what the main pass draws that frame, plus instances
outside the view within 250 m whose shadows can reach it: the view frustum's planes are swept 250 m
towards the sun, and instances inside the swept planes draw into the shadow layers only. off-screen
casters smaller than 16 px (as if on screen) are skipped, and terrain outside the view doesn't cast.

- a point uses the first cascade sphere containing it, dithered with the next one over the outer
  tenth of the sphere's radius.
- the sharp cascades filter like the game: 16 gathers (64 depths) on a Poisson disk rotated per 4×4
  pixel cell, at a radius of `csmShadowSoftness / split` (splits 12, 30 and, as the game computes
  it, 40 m) in the game's 2 × 2 atlas uv. the blocked fraction goes through a curve that hardens
  edges where blockers are close in depth and leaves plain PCF where they're far.
- the sharp cascades fade into the far layer between 64 and 80 m by squared distance to the camera.
  the far layer is a 3×3 grid of bilinear comparisons, standing in for the game's tent-filtered
  cached map.
- receivers move along the normal by about a texel, against acne. the game instead pushes them
  towards the sun by its contact-shadow pass's clear ray length, and biases casters in hardware.
- the environment's `shadow` section (the phase's `shadowConfig`) sets the rest, blended across
  volumes like any other section. map02 has softness 0.01 and strength 1 everywhere:

  | input                                              | effect                                                                    |
  | -------------------------------------------------- | ------------------------------------------------------------------------- |
  | `csmShadowSoftness`                                | the filter radius numerator above                                         |
  | `disableCsmBlendFactor`, `csmSimulatedAttenuation` | the shadow is replaced by the attenuation by the factor (caves: 1 and 0)  |
  | `csmIntensity`                                     | sun visibility `mix(1, shadow, intensity)`                                |
  | `csmRampTexture`                                   | penumbra tint: the sun times `1 − (1 − ramp(v)) · (1 − v)`, black if none |

  without a ramp the sun is multiplied by the visibility `v`. on map02, Yinglung Pass's phases tint
  penumbrae purple, and ten cave and interior volumes keep the sun out entirely. the cached map's,
  contact shadows' and other fields are packed but unused; contact shadows aren't drawn.

### cloud shadows

the `cloud` section's `cloudShadowConfig` (on with `enable` and `enableCloudShadow`) darkens the sun
with a tiling texture skewed along the sun's light by height. an offset `d` from
`cloudShadowEnvCenter` becomes `d + l · d.y`, where `l` is `rotationCloudShadow`'s direction divided
by `|cos(pitch / 360)|` clamped to [0.001, 1], with the pitch (`cloudShadowPitchYaw` with mode 1,
else `directPitchYaw`) in degrees but the cosine taken in radians. the divisor is therefore within
1% of 1 at any pitch, so `l` is effectively the unit direction. a true `1 / sin(pitch)` would reach
1000 at the 0° pitch Wuling City's outdoor phase ships, and its texture would stripe along the
terrain's contours.

- uv = the skewed offset (x, z) × `0.001 / cloudShadowCoverage` (coverage is the tile's span in
  kilometres), plus `flowDirection · flowSpeed / 1000` per second.
- past `cloudShadowScaleStartDistance` metres from the centre (horizontally), over the next
  `cloudShadowScaleEndDistance` metres, the sample smoothsteps to one taken at uv /
  `cloudShadowDistanceScale`.
- the sun visibility is multiplied by `mix(1, red, cloudShadowAlpha)` before the sun-off override,
  strength and ramp above.

no shipped phase enables the far texture set (`enableFarCloudShadowTexture`); the viewer ignores it.
rain phases set high alphas: on Marker Stone 0.75–1 against 0.49–0.70 for its dry phases, which is
most of what makes the rain look overcast. the volumetric fog takes the same cloud shadow on its
sun; where a phase sets the alpha to 1, as Marker Stone's cave volumes do, fog under a dark patch
gets no sun at all, and without it the haze over such places reads near-white.

## ambient

diffuse ambient comes from the irradiance volume where it reaches, and the **ambient probe**
elsewhere.

- the ambient probe is `sky.skyAmbientSH` (Unity `SphericalHarmonicsL2`, 27 floats channel-major)
  scaled by `light.indirectDiffuseFactor`, converted to Unity's `ShadeSH9` vectors (`shaderSh`). it
  is stored pre-exposed.
- the irradiance volume's L1 probes are sampled from three camera-centred clipmaps
  ([below](#the-viewers-clipmaps)), blended between levels near each level's edge. the probes'
  validity decides how much of the ambient probe fills in, including the game's vertical correction
  term at the volume's boundary. the game also jitters the lookup and shifts the clipmaps along the
  view; the viewer does neither.
- diffuse ambient is darkened by the lower of ambient occlusion (GTAO, below) and material
  occlusion, through Jimenez's multi-bounce fit so bright surfaces darken less. the game fits per
  channel; the viewer uses the albedo's luminance. with AO off, material occlusion applies alone and
  linearly, as in the game.
- specular ambient gets Lagarde's specular occlusion from material occlusion only; the game also
  feeds GTAO into it.

specular ambient samples `sky.reflectionMap` (a BC6H cubemap, prefiltered by roughness across its
mips) along the roughness-bent reflection vector, or the ambient probe until the cubemap streams in;
it's weighted by an analytic split-sum environment BRDF and `light.indirectSpecularFactor`.

as in the game, the reflection is scaled by how the surface's diffuse light compares with the sky
probe's: with `d` the luminance of the diffuse irradiance (above) and `p` the ambient probe's
luminance L1 along the normal, the factor is `(2 · min(d / p, 1) + d) / (2 + p)`. that's about
`d / p` under cover, so interiors don't mirror the bright sky, and about 1 in the open. the game's
clustered local reflection probes (normalised the same way) are not implemented.

### screen-space reflections

every lit surface, at any roughness, gets the game's screen-space reflections on top
([`ssr.wgsl`](../../packages/viewer/src/render/shaders/ssr.wgsl),
[`screen-space-reflections.ts`](../../packages/viewer/src/render/screen-space-reflections.ts)), as
its PC high quality runs them. where a hit is found, its colour replaces the sky reflection by a
fade: `specular = (hit · fade + sky · (1 − fade)) · environment BRDF · specular occlusion`, where
only the sky term carries the normalisation above and the indirect specular factor.

- **march.** the mirror ray is projected to the screen and stretched to its edge, then stepped in
  equal steps of uv and device depth, 4 taps per loop: 32 steps (PC high quality's
  `ssrRayMarchingSampleCount`, which is also the floor distant pixels would otherwise drop below),
  and 4 once roughness reaches 0.3. a tap hits when it lies behind the depth buffer by less than two
  steps' depth; the hit is refined linearly between taps. the start is offset by interleaved
  gradient noise per frame unless a step is shorter than a pixel
- **colour.** the hit reads last frame's composited scene (with its fog, transparents, water and
  reflections) where the hit point was on last frame's screen
- **fade.** the product of three ramps: towards the screen's edges over `fadenessOnScreen` of uv;
  for surfaces seen head-on, `1 − saturate(|N·V| · fadenessOnMirrorMul + fadenessOnMirrorAdd)`,
  whose rays turn back off the screen; and, unless roughness is below 0.1, between 90 and 100 m.
  these come from the post profile's `ScreenSpaceReflectionVolume`; every shipped profile sets 0.1,
  2 and −1
- **temporal filter.** colour (kept as `c / (1 + max(c))`) and fade blend 97% of last frame's,
  reprojected and clipped to the 3 × 3 neighbourhood's box (the plus and full extremes averaged,
  widened to the mean ± 1.25 σ), times a confidence
  `exp(−screen motion in px) · saturate(ln(0.02 · view depth) + 0.01)`. that confidence is about 0
  nearer than 50 m, so close reflections are left to the main antialiasing
- **blur.** both go into a pyramid of up to 7 mips, each a 4 × 4 binomial (1 3 3 1)² of the finer
  mip weighted by `exp(−0.01 · |Δ view depth|)` against the nearest depth under the texel. the
  resolve picks the mip the reflected cone covers: a Blinn-Phong lobe's half-angle
  `acos(0.244^(1 / (2/α² − 1)))` seen through the mirror at the hit's distance, its footprint in
  pixels → `log2`. it blends the same depth-weighted binomial at the two mips around it (below a
  quarter mip, the filtered colour as is); the fade is read at the lower mip

the viewer runs these as fullscreen passes rather than the game's compute kernels, reprojects
through the depth buffer and the previous camera instead of motion vectors (the scenery is static),
and needs no rain-wetness variant: the game's re-derives the wet roughness the deferred wetness
computes, which the viewer's surfaces already carry ([environment](environment.md#wetness)), plus
rain ripple normals the viewer doesn't draw. off-screen reflections keep the sky reflection.

## local lights

the scenes' point, spot and tube lights live in the chunk files
([world.md](world.md#initchunkdata-layout)). the packer keeps the spot and point lights (a point
with a positive length is a tube along its direction) in `tables/lights.json.zst`
([`pack/lights.ts`](../../packages/extractor/src/pack/lights.ts)), with conditions from the scene
states of the files holding them, like instances. directional lights, shadow-only lights (12 on
map02) and character-only lights (none) are left out. both bake types on the maps, realtime and
mixed, light directly, as in the game.

| input                                                         | effect                                                                                                                                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| final colour                                                  | linear colour × intensity × the colour temperature's tint, precomputed in the file; added to the scene without pre-exposure                                               |
| range, falloff exponent                                       | negative exponent: `1 / (d² + 1)` times `(1 − (d²/R²)²)²`; otherwise `(1 − d²/R²)^exponent`                                                                               |
| tube length                                                   | `1 / (d²+1)` becomes `1 / ((\|a\|\|b\| + a·b) / 2 + 1)` over the segment ends `a`, `b`; `n·l` averages both ends; specular takes the segment point nearest the reflection |
| spot angle, inner spot angle                                  | `saturate((cos θ − cos(outer/2)) / (cos(inner/2) − cos(outer/2)))²`                                                                                                       |
| culling box (offset, half extents, Euler rotation, threshold) | in world axes about the light; with `m` the largest box coordinate, `(1 − saturate((m − (1 + t)/2) / ((1 − t)/2)))²`                                                      |
| culling and falloff distance                                  | the colour fades with camera distance, linearly in squared distance, from the falloff distance to nothing at the culling distance                                         |
| soft source radius `s`                                        | widens the lobe: `α += saturate(s / d)² / (3.6 v·h + 0.4)`                                                                                                                |
| specular intensity                                            | scales the specular lobe                                                                                                                                                  |
| volumetric scattering intensity                               | scales the light in the volumetric fog                                                                                                                                    |

the game's lobe for these lights (and for its sun) is GGX with the height-correlated Smith
visibility and Schlick Fresnel, but without the 1/π in the distribution and the Lambert term and
without (1 − F) on diffuse, so a light adds
`colour · attenuation · n·l · (diffuse colour + π · specular BRDF)`; the specular term is clamped to
1000 and the sum of all lights to 255. the viewer follows that
([`local_lighting` in `shaders/frame.wgsl`](../../packages/viewer/src/render/shaders/frame.wgsl)),
leaving out the game's multiple-scattering term. the viewer's sun divides diffuse by π with the
colour taken as illuminance; which convention reproduces the game's sun brightness is open
([open](#open)).

each frame [`render/local-lights.ts`](../../packages/viewer/src/render/local-lights.ts) takes the
shown level's lights (and tag 0's) whose condition holds, that are within their culling distance and
in the view, sorts them by camera distance then priority and keeps the nearest 256, as the game's
light list does. it bins them the game's way: 32 px screen tiles and 1 m view-depth slices from the
near plane (2048 of them), each a 256-bit mask; a pixel walks the lights set in both its tile's and
its slice's mask. the viewer bins conservative bounding spheres on the CPU; the game does it in
compute shaders. the volumetric fog lights each froxel with the same lists, through the fog's
Henyey-Greenstein phase times each light's volumetric intensity.

not drawn: local light shadows (972 map02 lights cast them in the game), shadow-only lights, cookies
(no map02 light has one), the flicker component and light beams.

## emission

HGRP Lit materials emit through one of their `_EMISSIVE_*` keywords
([`render/materials.ts`](../../packages/viewer/src/render/materials.ts)). `_EmissiveColor` is an HDR
colour, which Unity's HDR picker authors in linear space (`base × 2^intensity`), so it's used as
stored, unlike the gamma-encoded LDR colours. the result is added to the lit colour without
pre-exposure: the Hub's white ceiling panels store about 24, enough to read near-white with their
grid still visible.

| keyword           | emission                                                                                |
| ----------------- | --------------------------------------------------------------------------------------- |
| `_EMISSIVE_MAP`   | the colour times `_EmissiveMap`'s R channel                                             |
| `_EMISSIVE_MASK`  | the colour times a channel of the material's own maps, picked by `_EmissiveMaskChannel` |
| `_EMISSIVE_NOMAP` | only ships with the sweep animation (`_EMISSIVE_ANIM_SWEEP`); not drawn                 |

the mask channel is 0 for no emission, 1 for the base colour's alpha, 2 for the normal map's B
(two-basemap layout) or the base alpha (MRO layout), and 3 or more for the normal map's alpha
(two-basemap) or the MRO map's alpha; the channel is remapped by `saturate((m − 0.05) / 0.9)`. the
Hub's ceiling panels use mask channel 3. emission is multiplied by the albedo unless
`_AlbedoAffectEmissive` is 1. `_IgnorePostExposure` emitters (nearly all) divide out the post
exposure (the [auto exposure](#auto-exposure) times the viewer's exposure option), so they keep
their brightness however the exposure adapts.

not drawn: the animated variants' motion (they're drawn still), `_EmissiveType`'s extra G/B/A
colours, the Fresnel term, and per-instance emission overrides.

## lit layers

the Lit, LitTransparent and foliage shaders start from the base colour map times the linearized
`_BaseColor`, times `_BaseColorBrighterScale`, clamped to 1, then blend toward `_BaseColor` by
`_BaseColorTintCover`. the tint matters: Dijiang's black floors and walls are a light grey map
tinted by about 0.3. `HGRP/LitHLOD` ignores the tint.

these optional Lit layers come from the game's shader for these keywords
([`render/materials.ts`](../../packages/viewer/src/render/materials.ts), `shaders/mesh.wgsl`). each
map samples UV set 0 or 1 as a float of its own says: `_BaseUVSet` for the base colour,
`_BasePbrMapUVSet` for the normal and MRO maps, `_DetailUVSet`, `_MaskUVSet` and `_EmissiveUVSet`.
the slot's `m_UVSetIndex` stays 0 on hundreds of materials whose maps sample UV set 1, such as Power
Plateau's concrete walls, whose tri-channel mask spreads weathering streaks over UV set 1. the
originium crystals' base colour and detail map tile ×5 over UV set 1. not drawn:
`_UseMaskRUVSetAndTilingScale`, which samples the mask's R from `_MaskRUVSet` tiled by
`_MaskRTilingScale` (no map01 material sets it).

- **`_TRI_CHANNEL_MASK`** (~450 map01 materials, mostly rock): each channel of `_MaskMap` becomes a
  weight `saturate(s/2 + mix(−s, 1, m + offset)) · _MaskAlbedo*.a`, with contrast `s` from
  `_Mask*Scale` and the offset from `_Mask*Offset`. albedo, roughness and metallic then blend toward
  `_MaskAlbedo*` (an LDR colour, linearized), `_MaskRoghness*` and `_MaskMetallic*`, B first and R
  last. the originium crystals are grey rock tinted brown at strength 0.5 where R is set. the mask
  shares the MRO map's slot, so the few MRO-layout materials with a mask go untinted. the
  `_TRI_CHANNEL_MASK_SWITCH_TEXTURE*` variants take G and B from extra textures, so only R blends
  there.
- **`_DETAIL_MAP`**: a weight from `_DetailMaskMode` (1, the detail's alpha, the base colour's
  alpha, or the normal map's B or A) fades out with view depth between `_DetailFalloffStart` and
  `…End`. the detail normal (`× _DetailNormalIntensity`) is reoriented onto the base normal.
  `_DetailMode` 1 blends roughness toward the detail's alpha and occlusion by `_DetailPBRIntensity`;
  mode 0 overlays `_DetailOverlayColor` where the detail's B is dark, and blends roughness toward B.
- **`_PARALLAX_MAP`** (the originium crystals' glow): the view ray, in the geometric tangent frame,
  steps `trunc(_ParallaxMarchNum)` times (at most 20) through `_ParallaxNoiseMap` (tiled by
  `_ParallaxNoiseMapTilling`) as a height field `_ParallaxStrength` deep, and the hit is refined
  between the last two steps. at the hit, `_ParallaxMap`'s G (tiled by `_ParallaxTilling`; both maps
  ignore their `_ST`) picks between `_ParallaxColorDark` and the HDR `_ParallaxColor`. the result is
  emission: times the mask channel squared (`_ParallaxMaskChannel`, numbered like the emission mask
  minus one), times `N·V` to the power `floor(_ParallaxFresnelStrength)`, and times a pulse
  `cos(0.05 · _ParallaxAnimSpeed · t + _ParallaxAnimRandom · (x + y + z))` remapped to
  `[_ParallaxMinBrightness, 1]`, where `x + y + z` is the object's world position. the pulse moves
  only while frames render (the `continuous` option); its clock is assumed to tick in seconds. with
  `_ParallaxCharPos` set, `_ParallaxBrightStrength` times a smoothstep from
  `_ParallaxBrightOuterRadius` down to `…InnerRadius` of the distance to the player is added to the
  pulse; the viewer puts the player at the camera. on map01 seven crystal materials use it, mostly
  with strength 20 within 3–25 m; one stores a glow colour of only 0.75, so it glows almost only
  near the player.
- **`_LAYERBLEND_TOP`** (moss and sand on rock tops; ~220 map02 materials, 33 on map01): a second
  material covers the surface by `saturate((up − _TopBlendThreshold) / _TopBlendSmoothness)`, where
  `up` is the world Y of the geometric normal, blended toward the normal-mapped one by
  `_TopBlendWithBumpMap`. with `_LayerBlendHeight`, the base's height and `_Layer1BaseMap`'s alpha,
  each weighted by its coverage, compete within `_LayerBlendHeightTransition`. the layer's colour is
  desaturated by `_Layer1Saturation`, tinted by `_Layer1TintColor`, brightened by
  `_Layer1ColorBrighterScale`, and replaces the albedo (`_Layer1BaseColorBlendMode` 0) or adds to it
  (1). roughness blends toward `_Layer1BumpMap`'s B, occlusion toward its A (by `_Layer1AOStrength`,
  or 1 with `_LayerAOType`), metallic toward `_Layer1Metallic` or the layer's alpha
  (`_LayerMetallicType`), and the layer's normal (× `_Layer1BumpScale`) is reoriented onto the
  base's by `_Layer1BaseNormalIntensity`. it applies after the detail map and the tri-channel mask.
  both maps sample one coordinate picked by `_LayerBlendUVType` (UV set 0, world XZ, or UV set 2),
  times `_Layer1Tilling` plus `_Layer1Offset`, ignoring their `_ST`. no mesh map02 draws with a
  UV-set-2 layer has that set, and the game reads a missing UV set as set 0 (an in-game shot of a
  Jingyu moss rock shows the moss tiling over UV set 0), so the viewer samples UV set 0 for them and
  binds set 0 in place of a missing set 1. two all-moss rock materials have no base colour map, so
  their base is white and the layer is all they show. the layer takes the parallax slots, so
  `_BaseHeightMap` has none and reads as the shader's grey default.
- **`_LAYERBLEND_MASK`** (~200 map02 materials): the same layer, covering by a mask instead of
  facing up: `_LayerBlendMaskMap`'s R, sampled untiled from UV set 0 (UV set 1 when
  `_LayerBlendMaskUVType` is 0, whatever the slot's own set), or with `_LayerBlendMaskType` 1 to 4
  the layer bump map's alpha, the base colour's alpha, the normal map's alpha, or 1. the mask map
  sits in the emissive slot, so the few materials with both an emissive map and a mask map draw
  without the layer. not drawn: the `_LAYERBLEND_NOISEBLEND` and `_LAYERBLEND_MASK_PARALLAX_PBR`
  variants, which draw without the layer.
- **`_LAYERBLEND_MOSS`** (with either layer; the rabbit-hole resource mounds): shades the layer as
  moss. with `f = 1 − N·V` of the blended normal and the raw coverage `c` (the mask, or the top
  coverage before the height blend), the edge term
  `e = saturate(1 − (c − _Layer1FuzzyEdgeShadowOffset)² / _Layer1FuzzyEdgeShadowRange)` darkens the
  layer's colour by `_Layer1FuzzyEdgeShadowIntensity`; the colour is then scaled by
  `mix(1 − _Layer1FuzzyCoreDarkness, 1, f^_Layer1FuzzyDarkPower)` and brightened towards the
  silhouette by `_Layer1FuzzyEdgeBrightness` times twice its luma, by `f^_Layer1FuzzyBrightPower`
  (both powers at least 0.1). the world normal tips down by `e · _Layer1FuzzyNormalStrength`.

not drawn: a global highlight term around a point on the ground, a separate parallax mask texture
(`_UseParallaxMask`; such materials don't glow), and the `_PARALLAX_MAP_WORLDSPACE`, `_PBR` and
`_DEFORM` variants.

## alpha testing

alpha-tested HGRP Lit materials (`_ALPHATEST_ON`) test the alpha `_AlphaMaskChannel` picks against
`_AlphaClipThreshold`: 0 for the base colour's, 1 for the normal map's. map01 has 26 materials on
channel 1, all in the two-basemap layout, where the base alpha is metallic; testing that instead
cuts the Hub's white container walls down to their grime streaks.

## glass

`HGRP/LitTransparent` is the glass shader (16 materials on map01: windows and glass walls such as
the Originium Science Park offices). its materials alpha-blend (`_EnableAlphaBlend`, source alpha
over one minus source alpha, queue 3000, no depth write) and use Lit's texture layouts. the viewer
shades them like Lit and takes the opacity from the alpha `_AlphaMaskChannel` picks, times
`_BaseColor.a`; with the map still streaming, the tint's alpha alone. they cast no shadows.

the transparent pass draws them after the main pass, tested against its depth, with weighted blended
order-independent transparency (McGuire and Bavoil 2013): one target sums each layer's premultiplied
radiance and alpha, both times a weight that falls off gently with distance so nearer panes show
more, and another multiplies `1 − alpha` into the revealage. the composite lays the layers' mean
colour over the opaque scene by `1 − revealage` before the atmosphere and height fog, which treat
the glass as if it lay at the opaque surface behind it, and doesn't fog glass in front of the sky. a
single layer resolves exactly; overlapping panes blend without sorting.

not drawn: refraction (`_GLASS_REFRACTION_SCENECOLOR`, `_RefractTex`, `_IoR`, …), Fresnel opacity
(`_UseFresnel`; off on every map01 material) and subsurface scattering. water draws after the
composite, so glass in front of water is lost.

## matte paintings

`HGRP/MattePainting` draws the painted mountain ranges on the horizon: a few alpha-tested ring
segments, 600–1000 m from their origin and 1000 m tall, carrying one wide texture (map01's is
4096×512). they're unlit ([`mattePaintingLook`](../../packages/viewer/src/render/materials.ts)): the
colour is `_MainTex` times `_TintColor · _TintColorIntensity`, plus `_ExpIntensity` times whatever
exceeds `_ExpThreshold`, in pre-exposed units unless `_IgnorePostExposure` is set. alpha is the
texture's times `_TintColor.a · _TintColorAlpha`, clamped to 1 and tested against
`_AlphaClipThreshold`; the viewer folds the scale into the threshold so the shared alpha-test depth
pass still applies. fog comes from the composite like everything else. the shader has no shadow
pass, so they don't cast shadows, and the viewer holds them back until their texture is resident.
`_UseMainTexAsAlpha` isn't read; no map01 material sets it.

## erosion

`HGRP/Erosion` draws the dark blight rock that grows over the Originium Science Park and other map01
areas. it has no base colour map; the colour comes from its other maps
([`erosionLook`](../../packages/viewer/src/render/materials.ts), `erosion_surface` in
`shaders/mesh.wgsl`):

- `_MetalMixMap` R is 0 where the surface is metal. there the colour becomes `_MetallicColor`, the
  roughness 0.01 and the metallic `_Metallic · (metal − _MetallicOffset)`; elsewhere it's
  `_BaseColor`, with roughness `_Roughness` times the map's A, blended toward the detail map's alpha
  by `_DetailRoughnessCover`. G is occlusion (by `_OcclusionStrength`) and B masks the flow band.
- a noise layer: `_NoisePatternMap`, shifted by one parallax step `_NoiseStrength` deep, tinted by
  `_NoisePatternTintColor` and the base normal map's alpha, scaled by `max(N·V, _NoiseMin)` and
  faded out by distance over `_DistanceBlend` metres. it's added to the colour and, times
  `_NoiseEmissiveStrength`, to emission.
- a flow band: `_FlowRampMap` read along the object-space height (`× _FlowNormalTilling`, plus the
  metal map's G `× _FlowNoiseStrength` and `_FlowSpeedOffset`, scrolling by `_FlowNormalSpeed`),
  coloured `_FlowBottomColor` below the height `_FlowColorOffset` and `_FlowTopColor` above it. it
  adds `_FlowColorStrength` of itself to the colour where the metal map's B is set,
  `_FlowColorEmissiveStrength` to emission elsewhere, and lowers roughness by `_FlowRoughness` times
  its brightness.
- the base and detail normal maps (each with its own scale) are summed; metal flattens the bitangent
  component.

every map samples UV set 0 and tiles by its own `*Tilling` property rather than its `_ST`. the
metal, noise and flow colours are HDR and used as stored, like `_EmissiveColor`. not drawn: the soft
blend into whatever lies behind (`_ObjectBlend*`, which reads the scene depth) and
`_FakeTranslucency`.

`HGRP/ErosionDynamic` (animated, glowing) isn't drawn either. it's used only by the
`P_erosion_map01_dynamic…` prefabs, the erosion patches the player clears. their load gate shows
them while a map variable is not 2, and the finished-story defaults hide them
([variable gates](scene-states.md)), so they draw only when that gate is flipped, as a flat tint.

## scene effects

scenery effects are meshes placed like any other renderer, mostly in dynamic structures, with
`HGRP/Effect/*` materials. the magenta blight around Jingyu Valley's corrupted shrine (map02_lv001,
near unity −905, 228, −1505) is one: `VFXDecal` boxes stain the ground and `VFXBaseV2` cards rise
from it as red and blue smoke, all in script group `script:458752:41` with the shrine's damaged
pieces (on by default). two shaders are drawn
([`effect-looks.ts`](../../packages/viewer/src/render/effect-looks.ts),
[`shaders/effect.wgsl`](../../packages/viewer/src/render/shaders/effect.wgsl)); every other effect
shader stays hidden, since the opaque fallback would turn its bounding surfaces into walls.

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
material without a main texture samples the shader's default, white, as the game does (the base
ring of Origin Lodespring's crater column is one). alpha fades by a Fresnel term (`saturate(N·V + _FresnelBias)^_FresnelPower`, flipped by `_FresnelFlip`,
applied by `_FresnelAffectOpacity`) and, with `_USE_SOFTBLEND`, where the surface comes within
`_SoftDistance` metres of what lies behind it.

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

### mist

the drifting mist banks are effects too: `HGRP/FogSimple` cards (841 on map02, `SimpleFogCard*`) and
`HGRP/Effect/VFXFakeVolumeFog` boxes (69, `SimpleFakeVolumeFog*`), drawn by their own entry points
in the same file:

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
  `_FogColor.a · (1 − 2^(−thickness · _FogExponent)) · _FogDensity`, faded within `_CubEdgeFade` of
  the box's axis line, above `_HeightOffset` by `_HeightFalloff`, between `_VerticalFalloffMin/Max`,
  close to boxes the camera can't walk into (`_NearFadeDistance`), and out to
  `_FogIntensityFadeDistance` from the point (or the box's centre). the colour is `_FogColor`.

most cards and every box blend additively; they draw into the transparent pass's glow, which the
composite adds unfogged after the fog ([viewer](../viewer.md#the-render-frame)). premultiplied cards
join the weighted blend. the cards' own fog (`_USE_FOG`, faded by `_FogIntensity` and
`_FogIntensityFadeOutDistance`) isn't drawn, nor the boxes' 3D noise or their depth prepass, so the
additive ones read a little brighter far away. at Sword Vault Dale (map02_lv006) the cards make the
haze over the valley's middle distance that the fog alone left clear.

### blending and gaps

effects join the transparent pass's weighted blend ([glass](#glass)) and are fogged the same way;
additive ones could draw into its glow but are still hidden. they cast no shadows and wait until all
their textures are resident.

not drawn: additive VFXBaseV2 and VFXDecal effects, the vertex offset's mask (`_USE_VERTOFFSETMASK`)
and particle-data terms, brightening that is a scan line or centred on a fixed point, polar or
screen-space UVs, lighting, breathing, edge colour, vertex animation textures or water blending, the
flipbook and particle inputs, VFXDecal's parallax, 3D texture, weight and particle variants, the
effects' own fog (`_USE_FOG`; the composite fogs them instead), the scene effect colour grade, and
every other effect shader (`VFXAdvance`, `VFXDitherAlpha`, `VFXRefract`, `VFXWater`, …).

## sky

[`shaders/atmosphere.wgsl`](../../packages/viewer/src/render/shaders/atmosphere.wgsl) is a
Hillaire-style atmosphere (transmittance, multiple-scattering and per-frame sky-view LUTs), which is
the model the game's `atmosphereConfig` parameterises (Unreal's SkyAtmosphere: kilometres and
per-kilometre coefficients, scale × colour per term, ozone as a tent). the game's absolute sky
brightness comes from CPU factors that aren't recovered, so `sky_scale` in
[`shaders/sky.wgsl`](../../packages/viewer/src/render/shaders/sky.wgsl) matches the LUT's
upper-hemisphere luminance to the ambient probe's luminance looking up. the sky fades out just below
the horizon.

the cloud panorama (`cloud.cloudTexture`) is blended over the sky by its alpha above the horizon. it
covers only the upper hemisphere: u is the azimuth (`atan2(x, z)`) turned back by `rotation`
degrees, and v runs from the horizon (0, Unity's bottom row) to the zenith (1), so the texture's
height spans 90° of elevation. it's tinted by
`cloudTint × cloudFadeAlpha × cloudAbsoluteBrightness`; the brightness reaches alpha only with
`brightnessAffectCloudAlpha`. `cloudBrightness` matters only with `lightAffectCloud`, which no
shipped base profile sets, so the viewer ignores both. texture mode 0 takes
`cloudOpacityR`/`cloudOpacityG` per channel. contrast and rotation apply as authored. the tint goes
in raw, like the game's C# passes it; decoding it from sRGB makes some skies near-black.

the sky is fogged as if at `sky.skyDistance`.

### sun disc

with `sky.enableSunDisc`, a disc is added onto the atmosphere's sky around the light config's
`rotationSunDisc` sun, before the planets and clouds, so clouds cover it (drawn in
[`shaders/celestial.wgsl`](../../packages/viewer/src/render/shaders/celestial.wgsl)). with d the
view direction and s the direction towards that sun:

- `c = saturate(s · d)^20`, and the lobe is
  `0.0100164 (1 + c²) / max((1.9801 − 1.98 c)^(8 · sunDiscRadius^0.65), 1e-4)`, a forward-scattering
  phase function about 0.99 sharp
- `sunDiscRampIntensity` keeps the lobe's soft skirt: the disc takes
  `mix(smoothstep(0.5, 1, lobe) · lobe, lobe, ramp)`
- times the raw `sunDiscColor`, the light's `directIntensityDividePi` and the sky's
  `proceduralSkyLuxFactor`, clamped to 0–3

those factors are pre-exposed, so the disc reaches the [light shafts](#light-shafts)' threshold.

### beyond the atmosphere

the game shades everything past the atmosphere inside its one sky-dome draw, switched by keywords
and fed from the phase's `celestial` and `star` sections. the viewer renders the same layers per sky
pixel in a pass of its own
([`shaders/celestial.wgsl`](../../packages/viewer/src/render/shaders/celestial.wgsl), packed by
[`render/celestial.ts`](../../packages/viewer/src/render/celestial.ts)), and the composite puts them
over the atmosphere's sky before fogging it: `sky · (1 − cover) + layers`. in the game's order:

- **nebula** (`star.enableNebula`): the equirectangular `nebulaMap`, turned by `nebulaMapRotation`
  about the vertical, times the raw `nebulaTint` × 2. sky planets hide it by
  `celestialNebulaConverage`.
- **stars** (`star.enableStars`): one candidate per cell of a grid over the direction
  (`starsTilling` × 200 cells per radian), kept where a hash clears `1 − starsDensity`, sized
  between `minMaxRange`, tinted between `starsTint` and `starsTint1`, twinkling at
  `starsFlickerSpeed`, scaled by `starsExposure` and thinned by `skyBoxStarRangeMap` and the
  nebula's brightness (`nebulaStarConverage`).
- **the ray-traced planet** (`advancedPlanetConfig`, Dijiang's view of Talos-II): its material
  (`HGRP/Planet/PlanetBillboard`) is only a parameter source, copied with colours linearised. a
  sphere of `_RealPlanetRadius` at `_PlanetWSBase + (−sin φ, sin θ, −cos θ cos φ) · _Dist` (`_Phi2`,
  `_Theta2`), textured in a cylindrical equal-area mapping after the `_Pitch`/`_Roll` tilt, with sea
  colours from the RSM map (g depth, b sea mask), a cloud atlas (four quadrants of longitude ×
  hemisphere in RGBA, point-sampled) and its cloud shadows, URP's minimal GGX, a soft terminator
  `1 / (1 + e^(−20 n·l))`, a rim and a flat ambient. a three-sample single-scattering atmosphere
  runs over it, with the sun's transmittance from the material's lookup texture. it's lit from
  `_CustomLightDir` when `_CustomLightDirection` is set, and its disc replaces the sky behind.
- **sky planets** (`planetConfig`, `talosAlphaConfig`, when `drawPlanetInSkydome`): spheres seen
  from `moonConfig.orbitRadius − moonConfig.radius` (the moon is the body the map stands on) in the
  direction of `skydomeDrawer.pitchYaw`, lit from `incidentLightingPitchYaw`. the body's frame is
  `Euler(selfTiltX, 0, selfTiltZ)` spun by `selfRotationY` about its pole; the game hands the
  frame's right vector to the shader as "forward" and its forward as "right", and the viewer does
  the same. the disc samples `_MainTex` and `_EmissiveTex` of the draw material, with a ring
  (`_RingTex`, inner to outer radius over v) shadowed by the planet, and a single-scattering rim
  placed 2000 units out. they're added on top, faded below the horizon when `drawPlanetBelowHorizon`
  is set.

the cloud panorama is drawn in the same pass, because the game layers it between these: the sky
planets go onto the sky first, then the clouds cover them (with `drawCloudAfterPlanet`, as Wuling
City's phases set; without it the discs show in front and only their glow off the disc is covered),
then the nebula and stars are added, the stars thinned behind the clouds by `cloudRingStarCoverage`,
and the ray-traced planet goes over everything.

## fog

two analytic fogs and the volumetric fog in front of them, applied in
[`shaders/sky.wgsl`](../../packages/viewer/src/render/shaders/sky.wgsl) by the composite (opaque
surfaces and sky) and water passes, in the game's order: the atmosphere fog first, then the height
fog over it, then the froxels.

- **atmosphere fog** (`fogConfig`, when `enable`): single scattering in a medium thinning
  exponentially with height, from `startDistance`. Rayleigh and Mie scattering come from the fog
  section (a negative `rayleighScatteringScale` defers to the atmosphere's), absorption from
  `atmosphereConfig`'s Mie absorption, the sun from `light.directColor` × the pre-exposed sun
  intensity, plus `inscatterAmbientColor`. colours raw.
- **height fog**: two exponential layers (density, falloff, start height each), a constant inscatter
  colour, a max opacity, start and cutoff ramps, and a directional inscatter lobe towards its own
  light past a start distance. densities and falloffs are in the game's packed base-2 units
  (`FOG_UNIT` in `environment.ts`), and `heightFogInscatter` is used raw: it is already pre-exposed
  radiance. while `volumetricFogConfig.enable` is set (the PC path) the game takes the layers from
  the volumetric section's own height-fog set, which often differs a lot from `heightFogConfig`'s;
  on/off still follows `heightFogConfig.enable`.
- **volumetric fog** (`volumetricFogConfig`, when `enable`): a froxel grid over the view whose
  slices are spaced logarithmically in view depth from `volumetricFogStartDistance` out to
  `volumetricFogDistance`, computed each frame by a compute pass
  ([`volumetric-fog.ts`](../../packages/viewer/src/render/volumetric-fog.ts)). each froxel takes the
  height fog's layer density at its height, halved and times `volumetricFogExtinctionScale`, as
  extinction; `volumetricFogAlbedo` times it scatters. it scatters the sun (raw `directColor` times
  the pre-exposed intensity and `volumetricFogDirectLightingScatteringIntensity`, through one
  shadow-map comparison times the [cloud shadow](#cloud-shadows), then the shadow's sun-off override
  and strength, with a Henyey-Greenstein phase of `volumetricFogScatteringDistribution` towards the
  atmosphere's sun direction) and the ambient probe's linear part (times
  `volumetricFogSkyLightingScatteringIntensity` / π), and adds `volumetricFogEmissive` / 1000 per
  metre. a column is integrated front to back, fading in over `volumetricFogNearFadeInDistance`.
  - while it's on, the height fog integrates only the part of each ray past `volumetricFogDistance`
    of view depth, though its start and cutoff ramps and opacity cap still measure the whole ray.
    nothing nearer than the start distance is fogged.
  - so the height-fog set's start distance and inscatter colour are the far fog's, not the near
    fog's: drawing them alone puts a hard, bright fog wall at the start distance inside caves.
  - each froxel is lit at a point that moves through its cell from frame to frame (a Halton sequence
    shared by every froxel), and is blended with the last frame's lit medium (scattered light and
    extinction) reprojected to the froxel's centre, at 90 % history, as the game does. where the
    last frame's grid didn't cover the froxel, it takes this frame's sample alone; the game averages
    several jittered samples there instead. without the history, a sun shadow edge turns each froxel
    (a dozen pixels across on a 2000-pixel-wide view) fully lit or fully dark, and the temporal
    antialiasing can't average a pattern that coarse.

the volumetric fog's local fog volumes and its volumetric light flow noise are not drawn; its local
lights are (see [local lights](#local-lights)), unshadowed.

### flow noise

a phase's height-fog set can make the fog drift: `enableFlowNoise` sways how much fog each opaque
surface gets with a scrolling 3D noise, the drifting fog banks at Marker Stone. the set is the
volumetric section's while volumetric fog is on, else the height-fog section's, as for the layers.
the game applies it in its deferred lighting after all the fog; the viewer in the composite, on
opaque surfaces only (not the sky).

- the noise is the render pipeline's `HeightFogFlowNoise`, a 64³ alpha-only texture, packed once as
  the manifest's `heightFogFlowNoise`. it's sampled with repeat at the surface's world position ×
  `flowNoiseTilling`, plus `flowNoiseDir · flowNoiseSpeed` × time.
- strength `k = flowNoiseIntensity · saturate(1 − distance / flowNoiseDistance)`; the surface
  becomes `mix(unfogged, fogged, min(1 − k + 2 · noise · k, 1 + T))`, `T` the mean of what the fog
  lets through. so noise 0.5 leaves the fog as it is, low noise clears it and high noise thickens it
  up to twice as much.
- across volumes, two noises with the same speed and tiling blend their intensity, distance and
  direction; otherwise the first fades out to the halfway point and the second fades in. a noise on
  one side only fades in from zero intensity with that side's settings.

where a phase without the noise applies fully, there is none: Wuling City's own phase turns off what
its outskirts' phase sets. the viewer's "drifting fog" toggle turns it off, and "animate drifting
fog" pauses it; while it plays the viewer renders every frame.

## post chain

[`render/post-process.ts`](../../packages/viewer/src/render/post-process.ts), after the main pass:

| pass                                                                                                                                               | inputs                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| GTAO, half resolution, depth-aware upsample ([`gtao.wgsl`](../../packages/viewer/src/render/shaders/gtao.wgsl))                                    | post `ambientOcclusion`: see [below](#ambient-occlusion)                                  |
| celestial: nebula, stars and planets at the sky pixels                                                                                             | `celestial`, `star`: see [beyond the atmosphere](#beyond-the-atmosphere)                  |
| composite: AO on the ambient part, sky, fog                                                                                                        | as above                                                                                  |
| water                                                                                                                                              | see [water.md](water.md)                                                                  |
| light shafts: thresholded far pixels near the sun, radial blur ([`light-shafts.wgsl`](../../packages/viewer/src/render/shaders/light-shafts.wgsl)) | `lightShaft`: see [below](#light-shafts)                                                  |
| lens flare: quads around the sun, faded by its occlusion ([`lens-flare.wgsl`](../../packages/viewer/src/render/shaders/lens-flare.wgsl))           | `lensFlare`: see [below](#lens-flare)                                                     |
| bloom: thresholded mip chain, scattered upsample ([`bloom.wgsl`](../../packages/viewer/src/render/shaders/bloom.wgsl))                             | post `bloom`: see [below](#bloom)                                                         |
| tonemap ([`tonemap.wgsl`](../../packages/viewer/src/render/shaders/tonemap.wgsl)): exposure, bloom, vignette, grading, curve, sRGB encode          | post `vignette`; `colorGrading`; the auto exposure and the viewer's exposure compensation |

### auto exposure

on top of the fixed pre-exposure, the game adapts a post exposure to the view, following the
profile's `autoExposure` section (blended across volumes like the rest)
([`render/exposure.ts`](../../packages/viewer/src/render/exposure.ts),
[`render/auto-exposure.ts`](../../packages/viewer/src/render/auto-exposure.ts)):

- a 16-bin histogram of log2 luminance over `autoExposureEv100Range`, from every 16th pixel of the
  composited scene before bloom, each sample split between its two nearest bins. metering mode 1
  weights samples towards the screen's centre (`1 − 0.75 · (1 − 2^(−170.6 · r²))`, `r` from the
  centre in uv).
- the average counts each bin as its lower edge, clamped to `autoExposureEv100HistogramRange`, keeps
  only the samples between the `autoExposurePixelLuminanceRange` fractions (5 % and 95 %) and
  divides by all samples.
- the target is `2^autoExposureManualEvCompensationAuto · 0.18 / clamp(2^average, 0.01, 8)`, or
  `2^autoExposureManualEvCompensationManual` in mode 1, clamped to `2^autoExposureEvClampRange`.
  most profiles on map01 and map02 clamp to 0…8 EV (the Hub's to −0.2…8), so daylight stays at the
  fixed exposure and dark interiors brighten; a few allow darkening.
- the exposure moves `clamp(speed · dt)` of the way to the target each frame, with
  `autoExposureLerpUpSpeed` when brightening, else `autoExposureLerpDownSpeed`.

the viewer reads the histogram back a frame or two late, as the game does, renders while the
exposure moves, and jumps straight to the first reading after loading or switching levels. the stats
panel shows the adjustment; the "auto exposure" toggle holds it at 0 EV.

### light shafts

the game's sun shafts are Unreal's light shaft bloom
([`render/light-shafts.ts`](../../packages/viewer/src/render/light-shafts.ts)), added onto the
composited scene before temporal antialiasing, so the auto exposure meters them:

- they run while `lightShaft.enable` is set and the sun is in front of the camera. the sun is the
  light config's `rotationLightShaft`, projected to the screen without clamping, so a sun just off
  screen still casts shafts into the view.
- a target at half the render size (the game's `lightShaftDownSampleFactor` 2 on PC) keeps
  `colour / luminance · clamp(luminance − bloomThreshold, 0, bloomMaxBrightness) · 2 · bloomScale · bloomTint`
  of each pixel, only where the view depth is beyond half of `occlusionDepthRange` (ramping in over
  the range), faded towards the screen's edges and by `(1 − 2·|sun − uv|)²` away from the sun.
- three blur passes (`lightShaftBlurPassCount`) each average 12 samples (`lightShaftSampleNum`) on
  the way to the sun, reaching `min(blurIntensity · 0.1 · 4.8^pass, 1)` of the distance.
- the last blur is added to the scene's colour.

the occlusion-term variant (`enableOcclusion`) and the cloud mask (`enableLightShaftCloudMask`)
aren't drawn. where the sky has no [sun disc](#sun-disc), only bright fog and sky near the sun pass
the threshold.

### lens flare

the game's sun flare is SRP core's data-driven lens flare (version 12), drawn after the light shafts
(which don't see it) and before temporal antialiasing, so bloom and the auto exposure do
([`render/lens-flare-layout.ts`](../../packages/viewer/src/render/lens-flare-layout.ts),
[`render/lens-flare.ts`](../../packages/viewer/src/render/lens-flare.ts)). the game draws flares for
its flare components; the sun's takes its settings from the environment's `lensFlare` section while
`enable` is set: the flare asset, intensity, scale, occlusion and whether it may show off screen.
its direction is the light config's `rotationLensFlare`, its light colour the raw `directColor`.
with `enable` off the component's own settings would apply; those aren't known, so the viewer draws
no flare. Origin Lodespring's overview (`Env_map01_lv006_art_entry_overview_01`) turns it on while
the level's own phase turns the [sun disc](#sun-disc) off, so the flare is the sun there.

- **the asset.** `LensFlareDataSRP` ships without a TypeTree; the extractor reads its bytes in SRP
  core 12's field order, every bool padded to four bytes
  ([`unity/lens-flare-data.ts`](../../packages/formats/src/unity/lens-flare-data.ts)), and packs its
  elements under SRP core's field names, curves as keys and gradients as colour and alpha keys.
- **layout.** each frame the CPU places the sun on screen (y down, −1 to 1, as SRP core lays it out)
  and lays out every visible element as SRP core does: copies along the ray from the sun through the
  screen's centre (uniform, by curve, or random from Unity's generator seeded by the element),
  turned by the angular offset, sized `0.1 · sizeXY · uniformScale · scale` in units of the screen's
  height and grown towards the target size by the radial distortion, rotated towards the centre with
  `autoRotate`, tinted by the element, its gradient and the flare's intensity.
- **shapes.** images sample their texture; circles fade from `edgeOffset` out to the rim with an
  exponent `e^(4 · (1 − fallOff))`. each element blends additively, as a screen, premultiplied or
  lerped by its `blendMode`.
- **occlusion.** for the sun, `sampleCount` points on a disc around it (radius
  `tan 0.0576 · occlusionRadius` at its distance, projected to viewport units) are tested against
  the depth buffer; the share that lands on sky scales every quad. points off screen count only when
  the flare may show off screen. the game compares against the sun's depth at the far plane, which
  everything drawn is in front of.

polygon elements and inverse SDFs aren't drawn (map01's flares use neither), the per-light curves
(radial screen attenuation, distance) take SRP core's directional-light defaults, and curve key
weights are ignored.

### bloom

the game's bloom is HDRP's in structure, and the viewer follows it with the profile's high-quality
tier:

- the chain is sized as if the view were at most 1080 px tall. its first level is half that size,
  and each further level halves again, down to `log2(longest side) − 2` levels
  (`resolutionHighQuality` quarter gives one fewer).
- the prefilter averages five taps around each texel of the exposed scene, each weighted by
  `1 / (1 + luma)` against fireflies, keeping what's above `thresholdHighQuality` (sRGB → linear)
  with a soft knee of half the threshold.
- each further level is a 9-tap horizontal Gaussian that halves the width, then a 5-tap vertical
  one. upsamples go from the coarsest level, each a cubic B-spline of the coarser result blended
  over the level by `lerp(0.05, 0.95, scatterHighQuality)`.
- the composite adds `(2^intensityHighQuality − 1) · (bloom · tint)`, with the tint's luminance
  normalised to 1. blend modes other than add (`blendMode` 2 everywhere on map01 and map02) also
  subtract the scene's own above-threshold part by the same factor; add mode compresses bloom past
  0.3 instead.

the game's compute-shader variant of the chain isn't decoded; the viewer follows the pixel-shader
one. dirt, the additive upsample mode, character bloom and anamorphic stretch aren't drawn.

### ambient occlusion

the game's GTAO is XeGTAO, and the viewer's march follows it at the game's high tier (3 slices × 3
steps, reach capped at 48 half-resolution pixels with the falloff radius shrunk to match). unless
`ambientOcclusion.custom` is set, the game ignores the volume's march settings for a fixed preset:
radius 4 m, falloff range 1, sample distribution power 1, thin-occluder compensation 2; only
`finalValuePower` comes from the volume (6 on map02). thin-occluder compensation scales depth
differences by `1 + thin` in the falloff distance. the viewer derives normals from depth and filters
with one depth-aware blur; the game reads GBuffer normals and filters temporally and twice
spatially.

colour grading ([`render/color-grading.ts`](../../packages/viewer/src/render/color-grading.ts))
packs `colorGradingConfig` the way URP's colour utilities do (white balance, colour adjustments,
channel mixer, shadows/midtones/highlights, lift/gamma/gain, split toning); each sub-section that's
off reads as its neutral default. the game bakes grading and curve into a LogC LUT; the viewer
evaluates them per pixel with the game's HG-specific contrast and its modified-ACES curve (the only
tonemapper the game ships besides none; every profile sets `tonemappingMode` 5). colour curves
aren't packed and stay neutral; no shipped profile enables the external lookup texture. the viewer
also offers Khronos PBR Neutral and a clamp, for separating lighting errors from grading.

the viewer's toggles for sky, height fog, atmosphere fog, AO, bloom and vignette, and its debug
views (albedo, normals, roughness, ambient only, raw cloud panorama), turn passes off without
touching the profile.

## irradiance volume format

the game's GI is a baked probe volume, not lightmaps or Unity APV. files live under
`Data/IrradianceVolume/PC/<scene>/v3/`: an `index.bytes` and payloads
`iv_<stateGroupHash>_<n>.bytes`. parser:
[`hg/irradiance.ts`](../../packages/formats/src/hg/irradiance.ts).

### index.bytes

little-endian, read front to back to EOF:

1. `u32` magic: `0x03000004` (map02) or `0x03000003` (map01), same layout. other magics (gacha and
   legacy indices) are rejected. the magic sets the volume's extent (below).
2. scene-state names: `u32` count, each a `u32` byte length + UTF-16LE (e.g. `Map02_lv002_sunny`).
   these are MapConfig scene states ([scene-states.md](scene-states.md)); the game picks bakes by
   its active scene-state mask.
3. state groups: `u32` count, each `u32 hash` + counted `u32` indices into the names. hash 0 with no
   members is the base bake; payload filenames carry these hashes.
4. payload filenames: counted, length-prefixed UTF-16LE.
5. the scene's top-level spatial hash header (`u32` table size, `u32 O`, `O³` offset words), then a
   counted table of `(u32 value, u32 state-group hash)` pairs. neither is needed to read cells; both
   are skipped.
6. the cell directory: `u32` count, each nine `u32`:

   | word | meaning                                            |
   | ---- | -------------------------------------------------- |
   | 0    | cell key (below)                                   |
   | 1    | unknown                                            |
   | 2, 3 | byte offset and stored length in the payload       |
   | 4    | decompressed size = word 5 + word 6                |
   | 5    | the cell's hash-header bytes                       |
   | 6    | probe bytes (16 per probe)                         |
   | 7    | low 16 bits: payload file index; high bits unknown |
   | 8    | unknown                                            |

7. a counted table of five-word rows, meaning unknown, ending exactly at EOF.

the parser checks that records tile each payload contiguously from 0 and that every payload has
records; the packer also checks each payload's length against the index. the payload index comes
from word 7, never from filename order.

cell keys are `x | y << 8 | z << 16 | level << 24`, 8 bits per axis in 32 m units from the volume's
minimum corner, with world 0 at the middle of its extent: 8192 m for `0x03000004` (world 0 at 128)
and 4096 m for `0x03000003` (world 0 at 64). the extents are inferred from the data: map01's cells
line up with its levels only with world 0 at 64. the parser moves every key to the 8192 m layout, so
the package and viewer share one origin. a level-`n` cell spans `32 · 2^n` m, its coordinates are
multiples of `2^n`, and its probes are `0.5 · 4^n` m apart. levels 1 and 2 cover the map; level 0
(0.5 m probes) is sparse.

### cells and probes

a stored cell is raw when its stored length equals its size, else one block of Hypergryph's inverted
LZ4 (`decodeInvertedLz4Block` in [`binary/lz4.ts`](../../packages/formats/src/binary/lz4.ts)).
decompressed, it is the structure the game's GPU update pass reads (all `u32`):

- a perfect spatial hash over blocks of 4³ probes: `u32 T`, `u32 O`, `O³` offset words (byte
  triples), then `T³` entries of `(block key, probe offset, mask lo, mask hi)`. a block key is
  `bx | by << 8 | bz << 16`.
- the 64-bit mask marks which of the block's 64 probes exist; a probe's address is the entry's probe
  offset + 16 × the number of set mask bits below its own (relative to the cell).
- a probe is 16 bytes: L0 rgb as R11G11B10F, then three rgba8 words, the L1 direction of red, green
  and blue (unpacked as `· 4 − 2`, relative to that channel's L0) with the probe's validity in
  alpha.

where a level has no probe (no cell, no block, or a clear mask bit), the clipmap texel takes the
next coarser level's filtered value at that position; at the coarsest level it is zero light with
full validity. level 0 is sparse, so most of the finest clipmap comes from level 1.

### packing

[`pack/irradiance.ts`](../../packages/extractor/src/pack/irradiance.ts) stores every **base-bake**
cell (state group hash 0) whose centre the package covers as one decompressed `Irradiance` blob,
zstd-compressed, in the 512 m archive `irradiance/<x>_<z>.czar` over it. `tables/irradiance.bin`
lists cell keys ascending with their blob indices (see [package-format.md](../package-format.md)).
cells stay in the game's GPU layout so the viewer uploads them unchanged.

scene-state bakes (e.g. sunny, sunrise, night variants, or map01's damaged and overcast-rainy
states) are not packed. the game selects them by its active scene-state mask; how a state's cells
replace or overlay the base bake is unchecked.

### the viewer's clipmaps

[`render/irradiance-volume.ts`](../../packages/viewer/src/render/irradiance-volume.ts) keeps three
3D clipmaps of 128 × 64 × 128 texels with probes 0.5, 2 and 8 m apart (A: L0 rgb; B: three slabs
along y for the L1 of each channel). per level it wants the window of cells its texels fall in,
streams them into one storage buffer (coarse levels first, ahead of scenery), and refills the level
with
[`shaders/irradiance-update.wgsl`](../../packages/viewer/src/render/shaders/irradiance-update.wgsl)
when the camera moves more than 4 texels from its centre or a cell arrives or leaves. levels refill
coarse to fine, and a refilled level refills every finer one, because their probe-less texels copy
it. the update pass looks cells up in that window instead of the game's top-level hash. the clipmaps
are sampled toroidally in `ambient_irradiance`.

## open

- the CPU packing of the diffuse-ambient scale, the irradiance volume's default SH (`skyAmbientSH`
  vs `customIVDefaultSH`), and the sky's absolute brightness. these live in native engine code; the
  viewer's ambient and sky brightness are approximations.
- irradiance scene-state bakes, the index's pair table and trailing rows, directory words 1, 7 (high
  bits) and 8.
- the volumetric fog's grid size, depth distribution and history weight come from quality presets
  that aren't recovered (the viewer uses Unreal's defaults), and its sky term takes the ambient
  probe without the native diffuse-ambient scale.
- not rendered: the moon's sky-wide ring (`HG_RING`), aurora, local reflection probes, local light
  shadows and light beams, precipitation (rain wetness does render:
  [environment](environment.md#wetness)).
- celestial bodies ([beyond the atmosphere](#beyond-the-atmosphere)): the sky planets' ring thinning
  the stars, their blend modes (the viewer always adds them), and the brightness of the ray-traced
  planet's light (taken as the viewer's pre-exposed sun) are unchecked against a shot.
- the sun's units: the game shades its sun with the same lobe as local lights (no 1/π on diffuse),
  while the viewer treats the sun's colour as illuminance and divides diffuse by π. unless the CPU
  folds a 1/π into the sun's colour, the viewer's sun is π too dark. unchecked against a shot.
- the cap on local lights per frame comes from a quality setting that isn't recovered (the viewer
  takes the hard maximum, 256).
- interiors outside the game's sun-off volumes receive the outdoor sun wherever no drawn geometry
  shadows them.
