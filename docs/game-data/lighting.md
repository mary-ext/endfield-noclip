# lighting

how the game lights surfaces: the sun and its shadows, ambient and reflections, and local lights,
with the environment-profile fields that drive each. the profile itself (phases, volumes, blending)
is in [environment.md](environment.md), the baked GI in [irradiance.md](irradiance.md), and the
passes after lighting in [post-processing.md](post-processing.md).

## units

the game (HGRP, a deferred PBR pipeline in Hypergryph's Unity fork) lights in physical units,
pre-exposed by a fixed exposure from the profile. emission is authored in those units already
([emission](materials.md#emission)); [auto exposure](post-processing.md#auto-exposure) adjusts on
top. the game packs most profile fields into shader constants on the CPU, in native engine code; the
packings not yet known are listed under [open](#open).

rendering features read their settings per quality level; these pages describe PC high (4000), and
[quality settings](quality-settings.md) has how a preset becomes settings and the other levels'
values.

## sun

| input                                  | effect                                          |
| -------------------------------------- | ----------------------------------------------- |
| `light.directLux`, `light.directEV100` | the sun's illuminance and the exposure value    |
| `light.directColor`                    | sun colour (stored as sRGB)                     |
| `light.directPitchYaw`                 | direction of the shading and shadow-casting sun |
| `light.directSpecularIntensity`        | scales the sun's specular lobe                  |

every sun-drawn effect has its own direction (`<effect>PitchYawMode` 0 follows the light, 1 uses
`<effect>PitchYaw`; the `rotation*` quaternions are the resolved results, and match the pitch, yaw
and mode in every shipped phase). art direction often moves these away from the light:

| effect (`<effect>PitchYaw`, `rotation<Effect>`) | used for                                                        |
| ----------------------------------------------- | --------------------------------------------------------------- |
| `atmosphere`                                    | the sky's LUTs, the atmosphere fog and the volumetric fog's sun |
| `heightFogDirectionalInscattering`              | the height fog's directional term                               |
| `sunDisc`                                       | the [sun disc](sky-and-fog.md#sun-disc)                         |
| `lensFlare`                                     | the [lens flare](post-processing.md#lens-flare)                 |
| `cloudShadow`                                   | the [cloud shadows](#cloud-shadows)' skew                       |
| `lightShaft`                                    | the [light shafts](post-processing.md#light-shafts)             |

the light config's other derived fields are not always current: `forwardDirect` disagrees with
`directPitchYaw` by tens of degrees in over a dozen shipped phases (map01's lv000 destruction and
cave phases, indie_race001's boss phases), and `directIntensity` disagrees with
`directLux · preExposure` in about as many.

the sun shades with the same lobe as the [local lights](#local-lights); foliage takes its two-sided
model ([foliage](materials.md#foliage)).

## shadows

PC high has three sharp cascades out to 12, 30 and 80 m, then a coarse layer the game keeps as a
cached, tiled shadow map out to 800 m (its ASM, `HGASMManager`, which the `asm*` shadow fields
configure). shadow-only renderers cast into the shadow maps without drawing, and interiors rely on
them: the plane roofing Dijiang (177 × 348 m at y 46) keeps the sun off its corridors, since the
walls such renderers stand in for cull their back faces. no Dijiang material changes
`_ShadowCullMode`.

- the sharp cascades filter with 16 gathers (64 depths) on a Poisson disk rotated per 4×4 pixel
  cell, at a radius of `csmShadowSoftness / split` (splits 12, 30 and, as the game computes it, 40
  m) in the game's 2 × 2 atlas uv. the blocked fraction goes through a curve that hardens edges
  where blockers are close in depth and leaves plain PCF where they're far.
- unverified: a point uses the first cascade containing it, dithered with the next one over the
  outer tenth of its bounding sphere's radius, and the sharp cascades fade into the far layer before
  their 80 m reach (the settings give a `CSMFadeInnerDistance` of 60 m at PC high).
- the cached far map is tent-filtered. it's a 16 × 16 grid of 200 m tiles, 256² each (about 0.78 m a
  texel), over the 800 m around the camera; only tiles that changed re-render, up to 8 a frame, and
  the whole cache after the camera moves far enough. it draws only static shadow casters, while the
  cascades, which re-render every frame on PC, draw only realtime ones: a renderer casts into a
  cascade with the [render flags](world.md#render-flags) `CastShadow`, `RealtimeShadowCaster` and
  the cascade's bit (all four or none), and into the far map with `CastShadow` and
  `StaticShadowCaster`. roughly one in seven of map02's chunk draws have `CastShadow` but neither,
  and cast into no sun shadow map. alpha-tested foliage isn't excluded from any map. each map also
  skips casters below a screen size in its own view (0.005, 0.01 and 0.02 for the cascades, 0.01 for
  a far-map tile); the measure is native and not decoded.
- the game's contact shadows are Bend Studio's screen-space shadows, on from PC low up. they
  multiply the sun's direct light by `mix(1, contact, contactShadowIntensity)` (0.5 in most of
  map02's open world, 0.9–1 in caves and interiors).
- against acne, the game pushes receivers towards the sun by the contact-shadow pass's clear ray
  length where that pass finds no blocker, and biases casters in hardware.
- the environment's `shadow` section (the phase's `shadowConfig`) sets the rest, blended across
  volumes like any other section. map02 has softness 0.01 and strength 1 everywhere:

  | input                                              | effect                                                                    |
  | -------------------------------------------------- | ------------------------------------------------------------------------- |
  | `csmShadowSoftness`                                | the filter radius numerator above                                         |
  | `disableCsmBlendFactor`, `csmSimulatedAttenuation` | the shadow is replaced by the attenuation by the factor (caves: 1 and 0)  |
  | `csmIntensity`                                     | sun visibility `mix(1, shadow, intensity)`                                |
  | `csmRampTexture`                                   | penumbra tint: the sun times `1 − (1 − ramp(v)) · (1 − v)`, black if none |

  without a ramp the sun is multiplied by the visibility `v`. on map02, Yinglung Pass's phases tint
  penumbrae purple, and some cave and interior volumes keep the sun out entirely.

### cloud shadows

the `cloud` section's `cloudShadowConfig` (on with `enable` and `enableCloudShadow`) darkens the sun
with a tiling texture skewed along the sun's light by height. an offset `d` from
`cloudShadowEnvCenter` becomes `d + l · d.y`, where `l` is `rotationCloudShadow`'s direction divided
by `|cos(pitch / 360)|` clamped to [0.001, 1], with the pitch (`cloudShadowPitchYaw` with mode 1,
else `directPitchYaw`) in degrees but the cosine taken in radians. the divisor is therefore within
1% of 1 at any pitch, so `l` is effectively the unit direction, even at the 0° pitch Wuling City's
outdoor phase ships.

- uv = the skewed offset (x, z) × `0.001 / cloudShadowCoverage` (coverage is the tile's span in
  kilometres), plus `flowDirection · flowSpeed / 1000` per second.
- past `cloudShadowScaleStartDistance` metres from the centre (horizontally), over the next
  `cloudShadowScaleEndDistance` metres, the sample smoothsteps to one taken at uv /
  `cloudShadowDistanceScale`.
- the sun visibility is multiplied by `mix(1, red, cloudShadowAlpha)` before the sun-off override,
  strength and ramp above.

no shipped phase enables the far texture set (`enableFarCloudShadowTexture`). rain phases set high
alphas: on Marker Stone 0.75–1 against 0.49–0.70 for its dry phases, which is most of what makes the
rain look overcast. the volumetric fog takes the same cloud shadow on its sun; where a phase sets
the alpha to 1, as Marker Stone's cave volumes do, fog under a dark patch gets no sun at all.

## ambient

diffuse ambient comes from the [irradiance volume](irradiance.md) where it reaches, and the
**ambient probe** elsewhere. all diffuse ambient (and the volumetric fog's sky term) is then scaled
by the blended phase's `light.indirectDiffuseFactor`, which the pipeline's managed code packs as
`_EnvironmentGlobalParams0.x`, with `light.indirectSpecularFactor` as `.y`.

- the ambient probe comes from `sky.skyAmbientSH` (Unity `SphericalHarmonicsL2`, 27 floats
  channel-major). the irradiance volume's default SH (`skyAmbientSH` or `customIVDefaultSH`) is set
  natively; which, and how it's scaled, is [open](#open).
- the irradiance volume's probes are used as stored: neither the clipmap update nor the lighting
  scales them, so they are already pre-exposed, and the phase's bake fields
  (`skyBakedIndirectIntensity`, `bakedIndirectMultiplier`, `giSkyMultiplier`,
  `giBakedIndirectMultiplier`) don't apply at runtime through them.
- the irradiance volume's L1 probes are sampled from three camera-centred clipmaps filled from its
  cells ([cells and probes](irradiance.md#cells-and-probes)). the levels reach ±29, ±116 and ±464 m
  horizontally and ±13, ±52 and ±208 m vertically from their centres, each fading over its last 2, 8
  and 32 m into the next coarser one. the probes' validity decides how much of the ambient probe
  fills in, with a vertical correction term at the volume's boundary. the game jitters the lookup
  and shifts the clipmap centres along the view.
- diffuse ambient is darkened by the lower of
  [ambient occlusion](post-processing.md#ambient-occlusion) and material occlusion, through
  Jimenez's multi-bounce fit per channel, so bright surfaces darken less. with AO off, material
  occlusion applies alone and linearly.
- specular ambient gets Lagarde's specular occlusion from the lower of material occlusion and GTAO.
- baked lightmaps are probably unused: no dynamic-prefab renderer has a lightmap index and all use
  light probes, and no VFS path names a lightmap. HLOD and terrain are unchecked.

specular ambient samples `sky.reflectionMap` (a BC6H cubemap, prefiltered by roughness across its
mips) along the roughness-bent reflection vector, weighted by a split-sum environment BRDF and a
scale of `light.indirectSpecularFactor` (the feature constant beside it,
`_GraphicsFeaturesGlobalParam0`, is AO on, SSR on, 1, 1, so it adds nothing). a profile's cubemap
can be black: Dijiang's (`T_reflectionprobe_envdefault0`) is, so its metal reflects only what local
reflection probes give it.

the reflection is scaled by how the surface's diffuse light compares with the sky probe's: with `d`
the luminance of the diffuse irradiance (above) and `p` the ambient probe's luminance L1 along the
normal, the factor is `(2 · min(d / p, 1) + d) / (2 + p)`. that's about `d / p` under cover, so
interiors don't mirror the bright sky, and about 1 in the open.

the game's local reflection probes are octahedral, box-projected and blended by priority over the
profile's cubemap, binned into screen tiles and depth slices like the [local lights](#local-lights),
and normalised the same way against their own probe. their textures ship as
`releasedata/reflectionprobedata/reflectionprobe-*.exr` (Dijiang has several); where their
placements are stored isn't found.

### screen-space reflections

at PC high quality, every lit surface, at any roughness, gets screen-space reflections on top. where
a hit is found, its colour replaces the sky reflection by a fade:
`specular = (hit · fade + sky · (1 − fade)) · environment BRDF · specular occlusion`, where only the
sky term carries the normalisation above and the indirect specular scale. where no hit is found, the
sky reflection stays.

every pass (march, resolve, temporal filter, fade) runs at half the render size on every PC tier.
the other levels' step counts, and which upsamples or turns the reflections off, are in
[quality settings](quality-settings.md#values-by-level).

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

the game runs these as compute kernels and reprojects through motion vectors. under rain it runs a
variant that re-derives the wet roughness the deferred wetness computes
([wetness](environment.md#wetness)) and adds rain ripple normals. forward-drawn reflectors (water,
[reflection-only effects](effects.md#reflection-only-effects)) write the normal, roughness and depth
the march reads.

## local lights

the scenes' point, spot and tube lights live in the chunk files
([world.md](world.md#initchunkdata-layout)); a point with a positive length is a tube along its
direction. dynamic structures' ECS groups hold lights in the same layout (a few hundred on map02,
such as the outposts' per-level lamps), which show with their structure
([dynamic structures](assets.md#dynamic-structures)). prefabs placed by model rows carry lights too,
as Unity `Light` components with HG's additional light data on the same GameObject: a Dijiang
cabin's lighting prefab (`lightingdeco_spaceship_*`) holds its room's only lights, six spots in the
growth chamber. a prefab light carries the same settings as a chunk light, but the chunk files store
the colour precomputed: the sRGB colour made linear, times intensity and, when the light uses one,
the colour temperature's tint from HDRP's published curve fit (pivot 6570 K), which reproduces every
stored chunk colour. a prefab light's culling box is authored in the prefab's axes (unverified: that
it turns with the placement, for turned cabins). the scenes also hold directional lights,
shadow-only lights (a dozen or so on map02), which emit nothing but darken the other local lights
through their [shadow maps](#local-light-shadows), and character-only lights (none on map02); how
the volumetric fog treats both is under [fog](sky-and-fog.md#fog). both bake types on the maps,
realtime and mixed, light directly.

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
1000 and the sum of all lights to 255, and a multiple-scattering term goes on top.

each frame the game's light list takes the spot and point lights within their culling distance and
in the view, sorts them by camera distance then priority, and keeps the nearest 256 (the cap at
every PC quality level, [quality settings](quality-settings.md#values-by-level)). compute shaders
bin them into 32 px screen tiles and 1 m view-depth slices from the near plane (2048 of them), each
a 256-bit mask; a pixel walks the lights set in both its tile's and its slice's mask. the volumetric
fog lights each froxel with the same lists, through the fog's Henyey-Greenstein phase times each
light's volumetric scattering intensity ([fog](sky-and-fog.md#fog)).

foliage takes the lights through its own two-sided model ([foliage](materials.md#foliage)), as it
does the sun: per unit of a light's colour and attenuation, the albedo × N·L of the shading normal,
the specular lobe dimmed for views from behind the leaf, the transmission lobe about the direction
to the light and the wrapped diffuse, all times the material's own sun shadow term (the vertex AO
and the fake directional shadow, which stays aimed by the sun) and without the 1/π.

lights can also carry cookies (no map02 light has one), a flicker component and
[light beams](#light-beams).

### local light shadows

about a thousand map02 lights are authored to cast shadows. each frame the game walks the frame's
lights nearest first and makes a shadow caster of every one with shadows on that is nearer the
camera than its shadow cull distance and than 200 m. a spot is one caster; a point light is one per
cube face its face mask enables. the light's caster properties say what casts into it:

- **static casters** (the light doesn't move and static objects cast, nearly every shadowed light on
  the maps) keep a cached map of the static scenery. their maps share a square atlas four tiles wide
  (4096² at high quality) in three sizes: the first 12 casters of the frame get a full tile (1024²),
  the next 12 a quarter of one (512²), the next 16 a sixteenth (256²), and casters past the fortieth
  draw unshadowed. each size is a 4 × 4 grid whose last quadrant holds the next size. one tile is
  drawn a frame: a caster whose rank moved it to another size first, then a caster without a tile. a
  tile stays cached while its light is within its cull distance, in view or not, and a full size
  evicts the tile used longest ago.
- **dynamic casters** (a moving light, or one dynamic objects cast into) get up to 6 still and 2
  moving lights' tiles beside the atlas, redrawn every frame with the dynamic objects.

a spot's map is a perspective view along the light with a field of view of its spot angle plus its
guard angle, from its shadow near plane to its shadow far plane, which is not its range. a point
light's faces are 92° wide. static tiles draw the scenery flagged as a static shadow caster, foliage
included, culled to the map's frustum and to the light's culling box when it has one, with the
light's depth bias on the rasteriser.

a surface looks the map up at its position pushed along its normal by a texel's size at 1 m times
the light's normal bias × 7.5, filters it with a 5 × 5 tent, and blends the result in by the
shadow's strength: the light's shadow strength, fading to nothing over the last `1 − fade ratio` of
the cull distance as the camera recedes. a spot's shadow also fades out over the last 0.2 m before
the far plane and the outer twentieth of its map. at high quality the volumetric fog's froxels take
the same shadows.

### light beams

light beams are a modified Volumetric Light Beam (a third-party Unity asset): a renderer on the
shared `ConeMesh.asset` with a per-beam material of `Hidden/VLB_HGRP_SinglePass` (about 150
materials across the packed scenes, most of them map02's). Wuling Very Large Rift (dung02_dg005) has
the largest, 781 m across, in script groups that pair each beam with its lights (a dark set on by
default, a bright set a level script shows).

the cone mesh is 64 sides with z 0 to 1 and a start cap; UV0's u marks the cap and v the outside
faces (1) against the inside ones (0), so one back-culled draw shows the inside from within. the
vertex stage squares z, scales the radius from `_ConeParams0.x` to `.y` (over the larger of the two)
and skews the side along `_ConeParams1.xyz`; the renderer's transform carries the rest of the size.
measured in the beam's own units (radius, and `_DistanceFallOff.z` along it), a pixel's opacity is
the product of:

| term           | from                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| side term      | the side's normal (`_ConeParams0.zw`) against the view, across the axis or straight on as the view lines up with the beam, to `_FresnelPow` |
| attenuation    | over `_DistanceFallOff.xy` along the beam: smooth linear, or `1 / (1 + 25t²)` with a tail fade, mixed by `_AttenuationLerpLinearQuad`       |
| start fade     | in over `_DistanceFallOff.w` from the start (none at 0)                                                                                     |
| facing         | inside faces fade as the view turns down the beam, outside faces as it turns back                                                           |
| depth blend    | `VLB_DEPTH_BLEND`: fades over `_DepthBlendDistance` towards the surface behind                                                              |
| near camera    | fades in over `_DistanceCamClipping` past the near plane                                                                                    |
| distance fade  | by the camera's view depth to the beam's origin, over `_DistanceFadeStart`–`End` and the second pair (equal ends: a step)                   |
| clipping plane | `_UseClippingPlane`: fades across `_AdditionalClippingPlaneWS` over `_ClippingPlaneTransition`                                              |
| cap            | caps show only when `_ConeParams1.w` is 1 (0 on every packed beam)                                                                          |

the colour is `_ColorFlat` (LDR) times `_AlphaInside` or `_AlphaOutside`. `_BlendMode` 1 adds it
(One One, nearly every material); 0 alpha-blends (a few). `VLB_NOISE_3D` multiplies by a global 3D
noise and `VLB_USE_FOG` applies the atmosphere and exponential fog. the shader also scales by a
per-renderer value and a global tint and saturation whose sources aren't recovered.

## open

- the irradiance volume's default SH (`skyAmbientSH` vs `customIVDefaultSH`, and its scale), packed
  in native engine code.
- the sun's units: the sun shades with the local lights' lobe (no 1/π on diffuse); whether the CPU
  folds a 1/π into the sun's colour is unknown. phases also carry a `directIntensityDividePi`.
- where local reflection probes are placed.
- [local light shadows](#local-light-shadows): what makes the game draw a cached tile again (a
  native flag on the light), the native cull of a tile's casters and its small-caster measure, how a
  light that is both a static and a dynamic caster combines its two tiles, and how the fog's froxels
  filter the map.
