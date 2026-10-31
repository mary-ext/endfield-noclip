# post-processing

the passes after the main pass, and which environment-profile fields drive each: ambient occlusion,
light shafts, lens flare, auto exposure, bloom, colour grading and tonemapping. screen-space
reflections are on [lighting.md](lighting.md#screen-space-reflections), the sky and fog the
composite draws on [sky-and-fog.md](sky-and-fog.md), the profile and its blending on
[environment.md](environment.md), and pass order, resolutions and targets on
[viewer.md](../viewer.md#the-render-frame).

## post chain

[`render/post-process.ts`](../../packages/viewer/src/render/post-process.ts) runs, after the main
pass:

| pass                                                                                                                                               | inputs                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| GTAO, half resolution, depth-aware upsample ([`gtao.wgsl`](../../packages/viewer/src/render/shaders/gtao.wgsl))                                    | post `ambientOcclusion`: see [below](#ambient-occlusion)                                  |
| screen-space reflections into last frame's scene ([`ssr.wgsl`](../../packages/viewer/src/render/shaders/ssr.wgsl))                                 | post `screenSpaceReflection`: see [lighting](lighting.md#screen-space-reflections)        |
| celestial: nebula, stars and planets at the sky pixels                                                                                             | `celestial`, `star`: see [beyond the atmosphere](sky-and-fog.md#beyond-the-atmosphere)    |
| composite: reflections, AO on the ambient part, sky, transparent layers, fog, glow                                                                 | see [sky and fog](sky-and-fog.md)                                                         |
| water                                                                                                                                              | see [water.md](water.md)                                                                  |
| light shafts: thresholded far pixels near the sun, radial blur ([`light-shafts.wgsl`](../../packages/viewer/src/render/shaders/light-shafts.wgsl)) | `lightShaft`: see [below](#light-shafts)                                                  |
| lens flare: quads around the sun, faded by its occlusion ([`lens-flare.wgsl`](../../packages/viewer/src/render/shaders/lens-flare.wgsl))           | `lensFlare`: see [below](#lens-flare)                                                     |
| temporal antialiasing, upsampling to the output size ([`taa.wgsl`](../../packages/viewer/src/render/shaders/taa.wgsl))                             | see [viewer.md](../viewer.md#the-render-frame)                                            |
| auto exposure histogram ([`auto-exposure.wgsl`](../../packages/viewer/src/render/shaders/auto-exposure.wgsl))                                      | `autoExposure`: see [below](#auto-exposure)                                               |
| bloom: thresholded mip chain, scattered upsample ([`bloom.wgsl`](../../packages/viewer/src/render/shaders/bloom.wgsl))                             | post `bloom`: see [below](#bloom)                                                         |
| tonemap ([`tonemap.wgsl`](../../packages/viewer/src/render/shaders/tonemap.wgsl)): exposure, bloom, vignette, grading, curve, sRGB encode          | post `vignette`; `colorGrading`; the auto exposure and the viewer's exposure compensation |

the viewer's toggles for sky, height fog, atmosphere fog, AO, reflections, bloom and vignette, and
its debug views (albedo, normals, roughness, ambient only, raw cloud panorama), turn passes off
without touching the profile.

## ambient occlusion

the game's GTAO is XeGTAO, and the viewer's march follows it at the game's high tier (3 slices × 3
steps, reach capped at 48 half-resolution pixels with the falloff radius shrunk to match). unless
`ambientOcclusion.custom` is set, the game ignores the volume's march settings for a fixed preset:
radius 4 m, falloff range 1, sample distribution power 1, thin-occluder compensation 2; only
`finalValuePower` comes from the volume (6 on map02). thin-occluder compensation scales depth
differences by `1 + thin` in the falloff distance. the composite applies the result to the ambient
part of the radiance ([ambient](lighting.md#ambient)).

the viewer derives normals from depth and filters with one depth-aware blur while upsampling; the
game reads GBuffer normals and filters temporally and twice spatially.

## light shafts

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

where the sky has no [sun disc](sky-and-fog.md#sun-disc), only bright fog and sky near the sun pass
the threshold.

not drawn: the occlusion-term variant (`enableOcclusion`) and the cloud mask
(`enableLightShaftCloudMask`).

## lens flare

the game's sun flare is SRP core's data-driven lens flare (version 12), drawn after the light shafts
(which don't see it) and before temporal antialiasing, so bloom and the auto exposure do
([`render/lens-flare-layout.ts`](../../packages/viewer/src/render/lens-flare-layout.ts),
[`render/lens-flare.ts`](../../packages/viewer/src/render/lens-flare.ts)). the game draws flares for
its flare components; the sun's takes its settings from the environment's `lensFlare` section while
`enable` is set: the flare asset, intensity, scale, occlusion and whether it may show off screen.
its direction is the light config's `rotationLensFlare`, its light colour the raw `directColor`.
with `enable` off the component's own settings would apply; those aren't known, so the viewer draws
no flare. Origin Lodespring's overview (`Env_map01_lv006_art_entry_overview_01`) turns it on while
the level's own phase turns the [sun disc](sky-and-fog.md#sun-disc) off, so the flare is the sun
there.

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

the per-light curves (radial screen attenuation, distance) take SRP core's directional-light
defaults. not drawn: polygon elements and inverse SDFs (map01's flares use neither), and curve key
weights.

## auto exposure

on top of the fixed [pre-exposure](lighting.md), the game adapts a post exposure to the view,
following the profile's `autoExposure` section (blended across volumes like the rest)
([`render/exposure.ts`](../../packages/viewer/src/render/exposure.ts),
[`render/auto-exposure.ts`](../../packages/viewer/src/render/auto-exposure.ts)):

- a 16-bin histogram of log2 luminance over `autoExposureEv100Range`, from every 16th pixel of the
  antialiased scene before bloom, each sample split between its two nearest bins.
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

the viewer reads the histogram back a frame or two late, as the game does, renders while the
exposure moves, and jumps straight to the first reading after loading or switching levels. the stats
panel shows the adjustment; the "auto exposure" toggle holds it at 0 EV. since the viewer meters the
same image the game does, a uniform EV offset against an in-game shot points at scene content the
viewer doesn't draw (effects, characters, local light shadows).

## bloom

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
one. not drawn: dirt, the additive upsample mode, character bloom and anamorphic stretch.

## colour grading and tonemapping

the tonemap pass multiplies the scene by the exposure, adds bloom, then applies URP's vignette in
HDR before grading, as the game's uber pass does.

colour grading ([`render/color-grading.ts`](../../packages/viewer/src/render/color-grading.ts))
packs `colorGradingConfig` the way URP's colour utilities do (white balance, colour adjustments,
channel mixer, shadows/midtones/highlights, lift/gamma/gain, split toning); each sub-section that's
off reads as its neutral default. the game bakes grading and curve into a LogC LUT; the viewer
evaluates them per pixel with the game's HG-specific contrast and its modified-ACES curve (the only
tonemapper the game ships besides none; every profile sets `tonemappingMode` 5). colour curves
aren't packed and stay neutral; no shipped profile enables the external lookup texture. the viewer
also offers Khronos PBR Neutral and a clamp, for separating lighting errors from grading.

## open

- light shafts and the lens flare are unchecked against in-game shots facing the sun.
- at Origin Lodespring's overview the viewer's flare is fainter than the game's: the crystal
  mountain behind the sun occludes it in the viewer's depth buffer (the game may not write it
  there). Unity's mapping of random bits onto `Random.Range` is assumed.
- the flare component's own settings, which apply while the environment's flare is off.
- bloom's compute-shader variant.
