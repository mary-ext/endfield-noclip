# post-processing

how the viewer draws the passes after the main pass that
[game-data/post-processing.md](../game-data/post-processing.md) describes.

## post chain

[`render/post/post-process.ts`](../../packages/viewer/src/render/post/post-process.ts) orchestrates
the [frame's post passes](frame.md), whose order, resolutions and targets are on that page. each
pass is a module beside its shader that builds its own pipelines and sizes its own targets;
[`post-uniforms.ts`](../../packages/viewer/src/render/post/post-uniforms.ts) packs the `Post`
uniforms they share, the environment's lanes when it changes and the frame's each frame. toggles and
debug views change rendering without changing the profile
([`settings.ts`](../../packages/viewer/src/render/post/settings.ts)). of the
[game's passes](../game-data/post-processing.md), depth of field, motion blur, sharpening, fisheye,
frosted glass and cutscene effects aren't drawn.

## ambient occlusion

the march follows the [game's GTAO](../game-data/post-processing.md#ambient-occlusion) at its high
tier, with the reach capped at 48 half-resolution pixels and the falloff radius shrunk to match.
with `custom` set it takes the volume's radius (times `radiusMultiplier`), falloff range,
distribution power and thin-occluder compensation. the composite applies the result to the ambient
part of the radiance; specular occlusion doesn't take it ([ambient](lighting.md#ambient)).

the viewer marches the half-resolution depth without mips, derives normals from depth and filters
with one depth-aware blur while upsampling, where the game marches depth mips, reads GBuffer normals
and filters temporally and twice spatially.

## light shafts

[`render/post/light-shafts.ts`](../../packages/viewer/src/render/post/light-shafts.ts) follows the
[game's light shaft bloom](../game-data/post-processing.md#light-shafts). the occlusion term and the
cloud mask aren't drawn.

## lens flare

[`environment/lens-flare-look.ts`](../../packages/viewer/src/environment/lens-flare-look.ts) takes
the [game's flare](../game-data/post-processing.md#lens-flare) from the environment,
[`render/post/lens-flare-layout.ts`](../../packages/viewer/src/render/post/lens-flare-layout.ts)
lays it out on the CPU each frame, and
[`render/post/lens-flare.ts`](../../packages/viewer/src/render/post/lens-flare.ts) draws it. polygon
elements and inverse SDFs aren't drawn, the per-light curves (radial screen attenuation, distance)
take SRP core's directional-light defaults, and Unity's mapping of random bits onto `Random.Range`
is assumed. with the environment's flare off, no flare draws.

at Origin Lodespring's overview the viewer's flare is fainter than the game's: the crystal mountain
behind the sun occludes it in the viewer's depth buffer.

## auto exposure

[`environment/exposure.ts`](../../packages/viewer/src/environment/exposure.ts) and
[`render/post/auto-exposure.ts`](../../packages/viewer/src/render/post/auto-exposure.ts) follow the
[game's metering](../game-data/post-processing.md#auto-exposure). the viewer reads the histogram
back a frame or two late, as the game does, renders while the exposure moves, and jumps straight to
the first reading after loading or switching levels. the stats panel shows the adjustment; the "auto
exposure" toggle holds it at 0 EV. content the viewer doesn't draw (characters, effects) is missing
from the histogram, so an EV difference against an in-game shot doesn't by itself say whether
content or metering caused it.

## bloom

[`bloom.wgsl`](../../packages/viewer/src/render/post/bloom.wgsl) reads the post profile's `bloom`
settings and follows the [game's bloom](../game-data/post-processing.md#bloom) at high quality, in
its pixel-shader variant, without dirt, the additive upsample mode, character bloom or anamorphic
stretch.

## colour grading and tonemapping

[`tonemap.wgsl`](../../packages/viewer/src/render/post/tonemap.wgsl) applies exposure, bloom and
URP's vignette (post profile `vignette`, without the game's extra mode and fields) in HDR before
grading.

[`environment/color-grading.ts`](../../packages/viewer/src/environment/color-grading.ts) packs
`colorGradingConfig` as [described](../game-data/post-processing.md#colour-grading-and-tonemapping),
without the colour curves, which the package doesn't carry. where the game bakes grading and curve
into a LogC LUT, the viewer evaluates them per pixel. it also offers Khronos PBR Neutral and a
clamp, for separating lighting errors from grading.
