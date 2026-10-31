# sky and fog

the atmosphere, clouds, sun disc and the layers beyond the atmosphere, then the fogs applied over
them, with the environment-profile fields that drive each. units, pre-exposure and the sun
directions each effect takes are in [lighting.md](lighting.md#units); the profile and its blending
are in [environment.md](environment.md), and the passes that draw these in
[post-processing.md](post-processing.md#post-chain).

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

## sun disc

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

those factors are pre-exposed, so the disc reaches the
[light shafts](post-processing.md#light-shafts)' threshold.

## beyond the atmosphere

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
  shadow-map comparison times the [cloud shadow](lighting.md#cloud-shadows), then the shadow's
  sun-off override and strength, with a Henyey-Greenstein phase of
  `volumetricFogScatteringDistribution` towards the atmosphere's sun direction) and the ambient
  probe's linear part (times `volumetricFogSkyLightingScatteringIntensity` / π), and adds
  `volumetricFogEmissive` / 1000 per metre. a column is integrated front to back, fading in over
  `volumetricFogNearFadeInDistance`.
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

the volumetric fog scatters the [local lights](lighting.md#local-lights) too, unshadowed.

not drawn: the volumetric fog's local fog volumes and its volumetric light flow noise.

## flow noise

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

## open

- the sky's absolute brightness: the CPU factors live in native engine code, so `sky_scale` is an
  approximation.
- the volumetric fog's grid size, depth distribution and history weight come from quality presets
  that aren't recovered (the viewer uses Unreal's defaults), and its sky term takes the ambient
  probe without the native diffuse-ambient scale.
- not rendered: the moon's sky-wide ring (`HG_RING`), aurora, precipitation (rain wetness does
  render: [environment](environment.md#wetness)).
- celestial bodies ([beyond the atmosphere](#beyond-the-atmosphere)): the sky planets' ring thinning
  the stars, their blend modes (the viewer always adds them), and the brightness of the ray-traced
  planet's light (taken as the viewer's pre-exposed sun) are unchecked against a shot.
