# lighting

how the viewer lights surfaces: the sun and its shadows, ambient and reflections, and local lights,
with the environment-profile fields that drive each. the profile itself (phases, volumes, blending)
is in [environment.md](environment.md), and the render frame's passes are in
[viewer.md](../viewer.md#the-render-frame). the other rendering pages split by topic:

| page                                     | covers                                                        |
| ---------------------------------------- | ------------------------------------------------------------- |
| [materials.md](materials.md)             | HGRP surface shaders: Lit layers, emission, foliage, glass, … |
| [effects.md](effects.md)                 | `HGRP/Effect/*`: VFX cards and decals, waterfalls, mist       |
| [sky-and-fog.md](sky-and-fog.md)         | atmosphere, clouds, sun disc, celestial layers, fogs          |
| [post-processing.md](post-processing.md) | auto exposure, light shafts, lens flare, bloom, GTAO, grading |
| [irradiance.md](irradiance.md)           | the baked irradiance volume's format, packing and clipmaps    |
| [water.md](water.md)                     | water surfaces                                                |

## units

the game (HGRP, a deferred PBR pipeline in Hypergryph's Unity fork) lights in physical units,
pre-exposed by a fixed exposure from the profile. the viewer does the same:
`preExposure = 1 / (1.2 · 2^directEV100)`, and the sun, ambient probe and fog colours are all
pre-exposed, so shaded values reach the tonemapper around 0–2. emission is authored in those units
already ([emission](materials.md#emission)); [auto exposure](post-processing.md#auto-exposure)
adjusts on top.

the game packs most profile fields into shader constants on the CPU. where that packing is known,
the viewer follows it; where it isn't, the viewer substitutes and the gap is listed under
[open](#open). [`render/environment.ts`](../../packages/viewer/src/render/environment.ts)
(`deriveEnvironment`) turns a blended profile into the renderer's `Environment`; packages without
profiles get a built-in default look.

## sun

| input                                  | effect                                            |
| -------------------------------------- | ------------------------------------------------- |
| `light.directLux`, `light.directEV100` | pre-exposed illuminance `directLux · preExposure` |
| `light.directColor`                    | sun colour (decoded from sRGB)                    |
| `light.directPitchYaw`                 | direction of the shading and shadow-casting sun   |
| `light.directSpecularIntensity`        | scales the sun's specular lobe                    |

the game gives every sun-drawn effect its own direction (`<effect>PitchYawMode` 0 follows the light,
1 uses `<effect>PitchYaw`; the `rotation*` quaternions are the resolved results). art direction
often moves these away from the light, so the viewer never substitutes the shading sun for them:

| direction                                  | used for                                            |
| ------------------------------------------ | --------------------------------------------------- |
| `atmospherePitchYaw` (per its mode)        | the sky's LUTs                                      |
| `rotationAtmosphere`                       | the atmosphere fog and the volumetric fog's sun     |
| `rotationHeightFogDirectionalInscattering` | the height fog's directional term                   |
| `rotationSunDisc`                          | the [sun disc](sky-and-fog.md#sun-disc)             |
| `rotationCloudShadow`                      | the [cloud shadows](#cloud-shadows)' skew           |
| `rotationLightShaft`                       | the [light shafts](post-processing.md#light-shafts) |

direct lighting is GGX with height-correlated Smith visibility and Lambert diffuse in
[`shaders/frame.wgsl`](../../packages/viewer/src/render/shaders/frame.wgsl); foliage takes the
game's two-sided model ([foliage](materials.md#foliage)).

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
- against acne, receivers move along the normal by about a texel and casters take a slope-scaled
  depth bias. the game instead pushes receivers towards the sun by its contact-shadow pass's clear
  ray length, and biases casters in hardware.
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
  contact shadows' and other fields are packed but unused. contact shadows aren't drawn; the game's
  are Bend Studio's screen-space shadows, on from PC low quality up, at intensity 0.5 in the open
  world.

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
  ([irradiance](irradiance.md#the-viewers-clipmaps)), blended between levels near each level's edge.
  the probes' validity decides how much of the ambient probe fills in, including the game's vertical
  correction term at the volume's boundary. the game also jitters the lookup and shifts the clipmaps
  along the view; the viewer does neither.
- diffuse ambient is darkened by the lower of
  [ambient occlusion](post-processing.md#ambient-occlusion) and material occlusion, through
  Jimenez's multi-bounce fit so bright surfaces darken less. the game fits per channel; the viewer
  uses the albedo's luminance. with AO off, material occlusion applies alone and linearly, as in the
  game.
- specular ambient gets Lagarde's specular occlusion from material occlusion only; the game also
  feeds GTAO into it.

specular ambient samples `sky.reflectionMap` (a BC6H cubemap, prefiltered by roughness across its
mips) along the roughness-bent reflection vector, or the ambient probe until the cubemap streams in;
it's weighted by an analytic split-sum environment BRDF and `light.indirectSpecularFactor`. a
profile's cubemap can be black: Dijiang's (`T_reflectionprobe_envdefault0`) is, so its metal
reflects nothing without local reflection probes.

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
  gradient noise per frame, or by about a pixel where a step is shorter than one.
- **colour.** the hit reads last frame's composited scene (with its fog, transparents, water and
  reflections) where the hit point was on last frame's screen.
- **fade.** the product of three ramps: towards the screen's edges over `fadenessOnScreen` of uv;
  for surfaces seen head-on, `1 − saturate(|N·V| · fadenessOnMirrorMul + fadenessOnMirrorAdd)`,
  whose rays turn back off the screen; and, unless roughness is below 0.1, between 90 and 100 m.
  these come from the post profile's `ScreenSpaceReflectionVolume`; every shipped profile sets 0.1,
  2 and −1.
- **temporal filter.** colour (kept as `c / (1 + max(c))`) and fade blend 97% of last frame's,
  reprojected and clipped to the 3 × 3 neighbourhood's box (the plus and full extremes averaged,
  widened to the mean ± 1.25 σ), times a confidence
  `exp(−screen motion in px) · saturate(ln(0.02 · view depth) + 0.01)`. that confidence is about 0
  nearer than 50 m, so close reflections are left to the main antialiasing.
- **blur.** both go into a pyramid of up to 7 mips, each a 4 × 4 binomial (1 3 3 1)² of the finer
  mip weighted by `exp(−0.01 · |Δ view depth|)` against the nearest depth under the texel. the
  resolve picks the mip the reflected cone covers: a Blinn-Phong lobe's half-angle
  `acos(0.244^(1 / (2/α² − 1)))` seen through the mirror at the hit's distance, its footprint in
  pixels → `log2`. it blends the same depth-weighted binomial at the two mips around it (below a
  quarter mip, the filtered colour as is); the fade is read at the lower mip.

the viewer runs these as fullscreen passes rather than the game's compute kernels, reprojects
through the depth buffer and the previous camera instead of motion vectors (the scenery is static),
and needs no rain-wetness variant: the game's variant re-derives the wet roughness the deferred
wetness computes, which the viewer's surfaces already carry ([environment](environment.md#wetness)),
plus rain ripple normals the viewer doesn't draw. off-screen reflections keep the sky reflection.

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

## open

- the CPU packing of the diffuse-ambient scale and the irradiance volume's default SH
  (`skyAmbientSH` vs `customIVDefaultSH`). these live in native engine code; the viewer's ambient
  brightness is an approximation.
- not rendered: local reflection probes, local light shadows and light beams.
- the sun's units: the game shades its sun with the same lobe as local lights (no 1/π on diffuse),
  while the viewer treats the sun's colour as illuminance and divides diffuse by π. unless the CPU
  folds a 1/π into the sun's colour, the viewer's sun is π too dark. unchecked against a shot.
- the cap on local lights per frame comes from a quality setting that isn't recovered (the viewer
  takes the hard maximum, 256).
- interiors outside the game's sun-off volumes receive the outdoor sun wherever no drawn geometry
  shadows them.
