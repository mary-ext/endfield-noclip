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
[`shaders/frame.wgsl`](../../packages/viewer/src/render/shaders/frame.wgsl), plus a wrapped
back-light term for thin foliage. the game's foliage shading model (canopy ramps, sphere-shadow
proxies) isn't reproduced.

## shadows

the game's PC high layout: three sharp cascades out to 12, 30 and 80 m, then a coarse layer the game
keeps as a cached, tiled shadow map out to 800 m (its ASM, `HGASMManager`, which the package's
`asm*` shadow fields configure). the viewer draws all four as 2048² `depth32float` layers fitted to
bounding spheres of frustum slices and snapped to world texels so edges don't crawl
([`render/shadow-map.ts`](../../packages/viewer/src/render/shadow-map.ts)). turning the camera
doesn't change a sphere's fit. casters are what the main pass draws that frame, so geometry outside
the view doesn't cast.

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
  contact shadows' and other fields are packed but unused; contact and cloud shadows aren't drawn.

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
clustered local reflection probes (normalised the same way) and SSR are not implemented.

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
(two-texture layout) or the base alpha (MRO layout), and 3 or more for the normal map's alpha
(two-texture) or the MRO map's alpha; the channel is remapped by `saturate((m − 0.05) / 0.9)`. the
Hub's ceiling panels use mask channel 3. emission is multiplied by the albedo unless
`_AlbedoAffectEmissive` is 1. `_IgnorePostExposure` emitters (nearly all) divide out the post
exposure (the [auto exposure](#auto-exposure) times the viewer's exposure option), so they keep
their brightness however the exposure adapts.

not drawn: the animated variants' motion (they're drawn still), `_EmissiveType`'s extra G/B/A
colours, the Fresnel term, and per-instance emission overrides.

## lit layers

three optional Lit layers come from the game's shader for these keywords
([`render/materials.ts`](../../packages/viewer/src/render/materials.ts), `shaders/mesh.wgsl`). each
texture slot samples UV set 0 or 1, as its `m_UVSetIndex` says; the originium crystals' base colour
and detail map tile ×5 over UV set 1.

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
  only while frames render (the `continuous` option); its clock is assumed to tick in seconds.

not drawn: the parallax brightening near the player (`_ParallaxCharPos`), a global highlight term, a
separate parallax mask texture (`_UseParallaxMask`; such materials don't glow), and the
`_PARALLAX_MAP_WORLDSPACE`, `_PBR` and `_DEFORM` variants.

## alpha testing

alpha-tested HGRP Lit materials (`_ALPHATEST_ON`) test the alpha `_AlphaMaskChannel` picks against
`_AlphaClipThreshold`: 0 for the base colour's, 1 for the normal map's. map01 has 26 materials on
channel 1, all in the two-texture layout, where the base alpha is metallic; testing that instead
cuts the Hub's white container walls down to their grime streaks.

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

## sky

[`shaders/atmosphere.wgsl`](../../packages/viewer/src/render/shaders/atmosphere.wgsl) is a
Hillaire-style atmosphere (transmittance, multiple-scattering and per-frame sky-view LUTs), which is
the model the game's `atmosphereConfig` parameterises (Unreal's SkyAtmosphere: kilometres and
per-kilometre coefficients, scale × colour per term, ozone as a tent). the game's absolute sky
brightness comes from CPU factors that aren't recovered, so `sky_scale` in
[`shaders/sky.wgsl`](../../packages/viewer/src/render/shaders/sky.wgsl) matches the LUT's
upper-hemisphere luminance to the ambient probe's luminance looking up. the sky fades out just below
the horizon.

the cloud panorama (`cloud.cloudTexture`, equirectangular, Unity's bottom-up rows) is blended over
the sky by its alpha above the horizon. it's tinted by
`cloudTint × cloudFadeAlpha × cloudAbsoluteBrightness`; the brightness reaches alpha only with
`brightnessAffectCloudAlpha`. `cloudBrightness` matters only with `lightAffectCloud`, which no
shipped base profile sets, so the viewer ignores both. texture mode 0 takes
`cloudOpacityR`/`cloudOpacityG` per channel. contrast and rotation apply as authored. the tint goes
in raw, like the game's C# passes it; decoding it from sRGB makes some skies near-black.

the sky is fogged as if at `sky.skyDistance`.

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
  shadow-map comparison and the shadow's strength and sun-off override, with a Henyey-Greenstein
  phase of `volumetricFogScatteringDistribution` towards the atmosphere's sun direction) and the
  ambient probe's linear part (times `volumetricFogSkyLightingScatteringIntensity` / π), and adds
  `volumetricFogEmissive` / 1000 per metre. a column is integrated front to back, fading in over
  `volumetricFogNearFadeInDistance`.
  - while it's on, the height fog integrates only the part of each ray past `volumetricFogDistance`
    of view depth, though its start and cutoff ramps and opacity cap still measure the whole ray.
    nothing nearer than the start distance is fogged.
  - so the height-fog set's start distance and inscatter colour are the far fog's, not the near
    fog's: drawing them alone puts a hard, bright fog wall at the start distance inside caves.
  - each froxel is lit at a point that moves through it from frame to frame, and the temporal
    antialiasing averages them; the game also reprojects the grid's history, which the viewer
    doesn't.

the volumetric fog's local fog volumes and flow noise are not drawn; its local lights are (see
[local lights](#local-lights)), unshadowed.

## post chain

[`render/post-process.ts`](../../packages/viewer/src/render/post-process.ts), after the main pass:

| pass                                                                                                                                      | inputs                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| GTAO, half resolution, depth-aware upsample ([`gtao.wgsl`](../../packages/viewer/src/render/shaders/gtao.wgsl))                           | post `ambientOcclusion`: see [below](#ambient-occlusion)                                  |
| composite: AO on the ambient part, sky, fog                                                                                               | as above                                                                                  |
| water                                                                                                                                     | see [water.md](water.md)                                                                  |
| bloom: thresholded mip chain, scattered upsample ([`bloom.wgsl`](../../packages/viewer/src/render/shaders/bloom.wgsl))                    | post `bloom`: see [below](#bloom)                                                         |
| tonemap ([`tonemap.wgsl`](../../packages/viewer/src/render/shaders/tonemap.wgsl)): exposure, bloom, vignette, grading, curve, sRGB encode | post `vignette`; `colorGrading`; the auto exposure and the viewer's exposure compensation |

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
- the volumetric fog's grid size and depth distribution come from quality presets that aren't
  recovered (the viewer uses Unreal's defaults), and its sky term takes the ambient probe without
  the native diffuse-ambient scale.
- not rendered: light shafts, lens flare, cloud shadows, celestial bodies, stars and aurora, local
  reflection probes, SSR, local light shadows and light beams, precipitation and wetness.
- the sun's units: the game shades its sun with the same lobe as local lights (no 1/π on diffuse),
  while the viewer treats the sun's colour as illuminance and divides diffuse by π. unless the CPU
  folds a 1/π into the sun's colour, the viewer's sun is π too dark. unchecked against a shot.
- the cap on local lights per frame comes from a quality setting that isn't recovered (the viewer
  takes the hard maximum, 256).
- interiors outside the game's sun-off volumes receive the outdoor sun wherever no drawn geometry
  shadows them.
