# post-processing

the passes after the main pass, and which environment-profile fields drive each: ambient occlusion,
light shafts, lens flare, auto exposure, bloom, colour grading and tonemapping. screen-space
reflections are on [lighting.md](lighting.md#screen-space-reflections), the sky and fog on
[sky-and-fog.md](sky-and-fog.md), and the profile and its blending on
[environment.md](environment.md).

after lighting, fog and transparents the game runs, in order: light shafts, a `Parafin` pass
(purpose unknown), depth of field, motion blur, the transparents drawn after depth of field, lens
flare, temporal antialiasing with upscaling, sharpening, fisheye, the grading LUT, the bloom chain,
frosted glass, the exposure histogram, cutscene effects and the uber pass.

## ambient occlusion

the game's GTAO is XeGTAO at half the render size. the graphics quality setting picks the kernel,
not the volume's `qualityLevel`: PC high marches 3 slices × 3 steps (low and medium 2 × 2, ultra 9 ×
3). unless `ambientOcclusion.custom` is set, the game ignores the volume's march settings for a
fixed preset: radius 4 m, falloff range 1, sample distribution power 1, thin-occluder compensation
2; only `finalValuePower` comes from the volume (6 on map02). thin-occluder compensation scales
depth differences by `1 + thin` in the falloff distance. the result occludes the ambient part of the
radiance ([ambient](lighting.md#ambient)). the game marches over prefiltered depth mips, reads
GBuffer normals and filters the result temporally and twice spatially before upsampling.

## light shafts

the game's sun shafts are Unreal's light shaft bloom, added onto the composited scene before
temporal antialiasing, so the auto exposure meters them:

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

where the sky has no [sun disc](sky-and-fog.md#sun-disc), only bright fog and sky near the sun pass
the threshold.

the game's shafts also have an occlusion-term variant (`enableOcclusion`) and a cloud mask
(`enableLightShaftCloudMask`).

## lens flare

the game's sun flare is SRP core's data-driven lens flare (version 12), drawn after the light shafts
(which don't see it) and before temporal antialiasing, so bloom and the auto exposure do. the game
draws flares for its flare components; the sun's takes its settings from the environment's
`lensFlare` section while `enable` is set: the flare asset, intensity, scale, occlusion and whether
it may show off screen. its direction is the light config's `rotationLensFlare`, its light colour
the raw `directColor`. with `enable` off the component's own settings apply; those aren't known
([open](#open)), as the sun's flare component is created at runtime rather than stored in the scene.
Origin Lodespring's overview (`Env_map01_lv006_art_entry_overview_01`) turns it on while the level's
own phase turns the [sun disc](sky-and-fog.md#sun-disc) off, so the flare is the sun there.

- **the asset.** `LensFlareDataSRP` ships without a TypeTree; its bytes are in SRP core 12's field
  order, every bool padded to four bytes.
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

no flare an environment references in map01, map02 or the dungeon, base and race scenes checked uses
polygon elements or inverse SDFs.

## auto exposure

on top of the fixed [pre-exposure](lighting.md), the game adapts a post exposure to the view,
following the profile's `autoExposure` section (blended across volumes like the rest):

- a 16-bin histogram of log2 luminance over `autoExposureEv100Range`, from one pixel per 16 × 16
  block of the antialiased scene before bloom, each sample split between its two nearest bins.
  `autoExposureMeteringMode` 1 weights samples towards the screen's centre
  (`1 − 0.75 · (1 − 2^(−170.6 · r²))`, `r` from the centre in uv).
- the average counts each bin as its lower edge, clamped to `autoExposureEv100HistogramRange`, keeps
  only the samples between the `autoExposurePixelLuminanceRange` fractions (5 % and 95 %) and
  divides by all samples.
- the target is `2^autoExposureManualEvCompensationAuto · 0.18 / clamp(2^average, 0.01, 8)`, or
  `2^autoExposureManualEvCompensationManual` with `autoExposureMode` 1, clamped to
  `2^autoExposureEvClampRange`. most profiles on map01 and map02 clamp to 0…8 EV (the Hub's to
  −0.2…8), so daylight stays at the fixed exposure and dark interiors brighten; a few allow
  darkening.
- the exposure moves `clamp(speed · dt)` of the way to the target each frame, with
  `autoExposureLerpUpSpeed` when brightening, else `autoExposureLerpDownSpeed`.

the game reads the histogram back a frame or two late.

## bloom

the game's bloom is HDRP's in structure, driven by the profile's high-quality fields:

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

the game also has a compute-shader variant of the chain, besides the pixel-shader one above. its
bloom also has dirt, an additive upsample mode, character bloom and anamorphic stretch.

## colour grading and tonemapping

the game's uber pass multiplies the scene by the exposure, adds bloom, then vignettes in HDR before
grading. the post profile's `vignette` is URP's (colour, centre, intensity, smoothness, roundness,
rounded) plus the game's `mode`, `blink` and `opacity`; the uber shader has an aspect or ellipse
variant, and what selects it and what the extra fields do isn't read.

`colorGradingConfig` maps onto URP's colour utilities (white balance, colour adjustments, channel
mixer, shadows/midtones/highlights, lift/gamma/gain, split toning, colour curves); each sub-section
that's off reads as its neutral default. the game bakes grading and curve into a LogC LUT, with its
HG-specific contrast and its modified-ACES curve (the only tonemapper the game ships besides none;
every profile sets `tonemappingMode` 5, `ACES_modified`, and modes 1–4, `Neutral`, `ACES`, `Custom`
and `External`, are hidden from the game's inspector), and dithers the output by half an 8-bit step.
no shipped profile enables the external lookup texture.

## open

- the vignette's extra mode and fields (above).
- whether PC runs bloom's compute-shader variant or the pixel-shader one.
- the flare component's own settings, which apply while the environment's flare is off.
- unverified: at Origin Lodespring's overview the game's flare seems not to be occluded by the
  crystal mountain behind the sun, as if the mountain weren't in its depth buffer.
