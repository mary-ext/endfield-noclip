# sky and fog

the atmosphere, clouds, sun disc and the layers beyond the atmosphere, then the fogs applied over
them, with the environment-profile fields that drive each. units and pre-exposure are in
[lighting.md](lighting.md#units), and the sun directions each effect takes under
[sun](lighting.md#sun); the profile and its blending are in [environment.md](environment.md), and
post-processing in [post-processing.md](post-processing.md).

## sky

the game's `atmosphereConfig` parameterises a Hillaire-style atmosphere (transmittance,
multiple-scattering and sky-view LUTs), Unreal's SkyAtmosphere model: kilometres and per-kilometre
coefficients, scale × colour per term, ozone as a tent. the sky-view LUT holds radiance per unit sun
illuminance; the game's C# scales it by `atmosphere.outerSunIrradianceColor` (raw) ×
`light.directIntensity` (the exposed sun, `directLux · preExposure`) × `sky.proceduralSkyLuxFactor`
when it renders the LUT, and the sky pass samples it unscaled. the LUT fades out just below the
horizon, where it also takes a ground bounce from `atmosphere.groundAlbedo`. the procedural sky then
applies a global colour adjustment (`_VFXParams1`, desaturation and tint) set by native code, not
recovered.

the cloud panorama (`cloud.cloudTexture`) is blended over the sky by its alpha above the horizon. it
covers only the upper hemisphere: u is the azimuth (`atan2(x, z)`) turned back by `rotation`
degrees, and v runs from the horizon (0, Unity's bottom row) to the zenith (1), so the texture's
height spans 90° of elevation. it's tinted by `cloudTint × cloudFadeAlpha × brightness`, where the
brightness is `cloudAbsoluteBrightness`, or with `lightAffectCloud`
`(cloudBrightness + light.directIntensityDividePi) × sky.proceduralSkyLuxFactor`, so lit clouds
follow the exposed sun as the sun disc does. the brightness reaches alpha only with
`brightnessAffectCloudAlpha`. the base profiles leave `lightAffectCloud` off, but local phases set
it with a small tint alpha that only the sun term makes visible: Power Plateau's overcast
(`Env_map01_lv007_art_overcast_brightness`, ≈ 4.3×) and its boss phases. texture mode 0 takes
`cloudOpacityR`/`cloudOpacityG` per channel. the game's C# passes the tint raw, not decoded from
sRGB.

the sky is fogged as if at `sky.skyDistance`.

## sun disc

with `sky.enableSunDisc`, a disc is added onto the atmosphere's sky around the light config's
`rotationSunDisc` sun, before the planets and clouds, so clouds cover it. with d the view direction
and s the direction towards that sun:

- `c = saturate(s · d)^20`, and the lobe is
  `0.0100164 (1 + c²) / max((1.9801 − 1.98 c)^(8 · sunDiscRadius^0.65), 1e-4)`, a forward-scattering
  phase function about 0.99 sharp
- `sunDiscRampIntensity` keeps the lobe's soft skirt: the disc takes
  `mix(smoothstep(0.5, 1, lobe) · lobe, lobe, ramp)`
- times the raw `sunDiscColor`, the light's `directIntensityDividePi` and the sky's
  `proceduralSkyLuxFactor`, clamped to 0–3

those factors are pre-exposed, so the disc reaches the
[light shafts](post-processing.md#light-shafts)' threshold.

## beyond the atmosphere

the game shades everything past the atmosphere inside its one sky-dome draw, switched by keywords
and fed from the phase's `celestial` and `star` sections. in the game's order:

- **nebula** (`star.enableNebula`): the equirectangular `nebulaMap`, turned by `nebulaMapRotation`
  about the vertical, times the raw `nebulaTint` × 2. sky planets hide it by
  `celestialNebulaConverage`.
- **stars** (`star.enableStars`): one candidate per cell of a grid over the direction
  (`starsTilling` × 200 cells per radian), kept where a hash clears `1 − starsDensity`, sized
  between `minMaxRange`, tinted between `starsTint` and `starsTint1`, twinkling at
  `starsFlickerSpeed`, scaled by `starsExposure` and thinned by `skyBoxStarRangeMap`, the nebula's
  brightness (`nebulaStarConverage`) and a sky planet's ring in front of them.
- **the ray-traced planet** (`advancedPlanetConfig`, Dijiang's view of Talos-II): its material
  (`HGRP/Planet/PlanetBillboard`) is only a parameter source, whose colours reach the shader
  linearised. a sphere of `_RealPlanetRadius` at
  `_PlanetWSBase + (−sin φ, sin θ, −cos θ cos φ) · _Dist` (`_Phi2`, `_Theta2`), textured in a
  cylindrical equal-area mapping after the `_Pitch`/`_Roll` tilt, with sea colours from the RSM map
  (g depth, b sea mask), a cloud atlas (four quadrants of longitude × hemisphere in RGBA,
  point-sampled) and its cloud shadows, URP's minimal GGX, a soft terminator
  `1 / (1 + e^(−20 n·l))`, a rim and a flat ambient. a three-sample single-scattering atmosphere
  runs over it, with the sun's transmittance from the material's lookup texture. it's lit from
  `_CustomLightDir` when `_CustomLightDirection` is set, and its disc replaces the sky behind.
- **sky planets** (`planetConfig`, `talosAlphaConfig`, when `drawPlanetInSkydome`): spheres seen
  from `moonConfig.orbitRadius − moonConfig.radius` (the moon is the body the map stands on) in the
  direction of `skydomeDrawer.pitchYaw`, lit from `incidentLightingPitchYaw`. the body's frame is
  `Euler(selfTiltX, 0, selfTiltZ)` spun by `selfRotationY` about its pole; the game hands the
  frame's right vector to the shader as "forward" and its forward as "right". the disc samples
  `_MainTex` and `_EmissiveTex` of the draw material, with a ring (`_RingTex`, inner to outer radius
  over v) shadowed by the planet, and a single-scattering rim placed 2000 units out. they're faded
  below the horizon when `drawPlanetBelowHorizon` is set. each goes onto the sky by its draw
  material's `_BlendMode`: 0 alpha-blended, 1 additive, 2 premultiplied. the first slot's colour
  also takes the global colour adjustment; the second's doesn't.
- **the moon's ring** (`HG_RING`, from `moonConfig` when `enableRing` is set with a nonzero
  `ring.width` and a non-black `ringColor`): an arc across the whole sky, the ring of the body the
  map stands on, seen from the map's latitude and longitude on it (`worldLatitude`,
  `worldLongitude`, turned by `rotationAroundUp`). `planetRingMap` times the raw `ringColor` is
  added where the view crosses the ring's plane on the far side from the pole, faded below the
  horizon with `drawPlanetBelowHorizon`. Dijiang's moon sets `enableRing` with width 0, so it draws
  none; which phases draw one, and where it falls in this order, aren't recorded.

the cloud panorama sits between these: the sky planets go onto the sky first, then the clouds cover
them (with `drawCloudAfterPlanet`, as Wuling City's phases set; without it the discs show in front
and only their glow off the disc is covered), then the nebula and stars are added, the stars thinned
behind the clouds by `cloudRingStarCoverage`, and the ray-traced planet goes over everything.

the game's sky also has an aurora, not looked at. the aurora curtains seen in Snowy Forest are
placed effects instead, which a level script swaps by where the player is
([trigger volume shapes](scene-states.md#trigger-volume-shapes)).

## fog

two analytic fogs and the volumetric fog in front of them, applied to opaque surfaces, the sky and
water in this order: the atmosphere fog first, then the height fog over it, then the froxels.

- **atmosphere fog** (`fogConfig`, when `enable`): single scattering in a medium thinning
  exponentially with height, from `startDistance`. Rayleigh and Mie scattering come from the fog
  section (a negative `rayleighScatteringScale` defers to the atmosphere's), absorption from
  `atmosphereConfig`'s Mie absorption, the sun from `light.directColor` × the pre-exposed sun
  intensity, plus `inscatterAmbientColor`. colours raw.
- **height fog**: two exponential layers (density, falloff, start height each), a constant inscatter
  colour, a max opacity, start and cutoff ramps, and a directional inscatter lobe towards its own
  light past a start distance. densities and falloffs are in packed base-2 units, and
  `heightFogInscatter` is used raw: it is already pre-exposed radiance. while
  `volumetricFogConfig.enable` is set (the PC path) the game takes the layers from the volumetric
  section's own height-fog set, which often differs a lot from `heightFogConfig`'s; on/off still
  follows `heightFogConfig.enable`.
- **volumetric fog** (`volumetricFogConfig`, when `enable`): a froxel grid over the view from
  `volumetricFogStartDistance` out to `volumetricFogDistance` of view depth. each froxel takes the
  height fog's layer density at its height, halved and times `volumetricFogExtinctionScale`, as
  extinction; `volumetricFogAlbedo` times it scatters. it scatters the sun (raw `directColor` times
  the pre-exposed intensity and `volumetricFogDirectLightingScatteringIntensity`, through one
  shadow-map comparison times the [cloud shadow](lighting.md#cloud-shadows), then the shadow's
  sun-off override and strength, with a Henyey-Greenstein phase of
  `volumetricFogScatteringDistribution` towards the atmosphere's sun direction) and the ambient
  probe's linear part (times `volumetricFogSkyLightingScatteringIntensity` / π and a native
  diffuse-ambient scale that isn't recovered), and adds `volumetricFogEmissive` / 1000 per metre. a
  column is integrated front to back, fading in over `volumetricFogNearFadeInDistance`.
  - the grid's cells are at least a preset number of pixels across, and the grid at most a preset
    size, so large views get a near-constant grid. slices are spaced logarithmically: slice
    `s = log2(z · B + O) · S` at view depth z, the first starting 0.095 m past the near plane or the
    start distance (whichever is farther) and the last at `volumetricFogDistance`, S slices per
    doubling of depth. the pixel size, grid cap, S, jitter scales and history weight come from
    quality presets that aren't recovered.
  - while it's on, the height fog integrates only the part of each ray past `volumetricFogDistance`
    of view depth, though its start and cutoff ramps and opacity cap still measure the whole ray.
    nothing nearer than the start distance is fogged.
  - so the height-fog set's start distance and inscatter colour are the far fog's, not the near
    fog's.
  - each froxel is lit at a point that moves through its cell from frame to frame (a Halton sequence
    shared by every froxel), and is blended with the last frame's lit medium (scattered light and
    extinction) reprojected to the froxel's centre. where the last frame's grid didn't cover the
    froxel, a preset number (up to 16) of jittered samples are averaged instead.

the volumetric fog scatters the [local lights](lighting.md#local-lights) too, except character-only
lights; a shadow-only light adds nothing and multiplies the local lights' sum by its shadow. it also
has local fog volumes (voxelized into the grid) and a volumetric light flow noise
(`enableVLFlowNoise`, a scrolling, perturbed noise on the scattering), neither described here.

## flow noise

a phase's height-fog set can make the fog drift: `enableFlowNoise` sways how much fog each opaque
surface gets with a scrolling 3D noise, the drifting fog banks at Marker Stone. the set is the
volumetric section's while volumetric fog is on, else the height-fog section's, as for the layers.
the game applies it in its deferred lighting after all the fog.

- the noise is the render pipeline's `HeightFogFlowNoise`, a 64³ alpha-only texture. it's sampled
  with repeat at the surface's world position × `flowNoiseTilling`, plus
  `flowNoiseDir · flowNoiseSpeed` × time.
- strength `k = flowNoiseIntensity · saturate(1 − distance / flowNoiseDistance)`; the surface
  becomes `mix(unfogged, fogged, min(1 − k + 2 · noise · k, 1 + T))`, `T` the mean of what the fog
  lets through. so noise 0.5 leaves the fog as it is, low noise clears it and high noise thickens it
  up to twice as much.
- across volumes, two noises with the same speed and tiling blend their intensity, distance and
  direction; otherwise the first fades out to the halfway point and the second fades in. a noise on
  one side only fades in from zero intensity with that side's settings.

where a phase without the noise applies fully, there is none: Wuling City's own phase turns off what
its outskirts' phase sets.

## open

- the procedural sky's global colour adjustment (`_VFXParams1`).
- the volumetric fog's quality presets (cell size, grid cap, depth distribution, history weight) and
  the native diffuse-ambient scale on its sky term; its local fog volumes' shader.
- the [flow noise](#flow-noise)'s blend in the volumetric section's height-fog set: read for the
  height-fog section's and assumed the same.
- whether the height fog's flow noise also reaches the sky, water and forward-shaded surfaces (only
  the deferred lighting is checked).
- the aurora.
