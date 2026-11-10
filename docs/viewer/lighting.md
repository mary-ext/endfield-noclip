# lighting

how the viewer lights what [game-data/lighting.md](../game-data/lighting.md) and
[game-data/irradiance.md](../game-data/irradiance.md) describe.

## units

like the game, the viewer lights in physical units, pre-exposed:
`preExposure = 1 / (1.2 · 2^directEV100)`, and the sun, ambient probe and fog colours are all
pre-exposed, so shaded values reach the tonemapper around 0–2.

[`environment/derive.ts`](../../packages/viewer/src/environment/derive.ts) (`deriveEnvironment`)
turns a blended profile into the renderer's `Environment`, following the game's CPU packing where
it's known and approximating it where it isn't ([open](../game-data/lighting.md#open)). packages
without profiles get a built-in default look.

## sun

the sun's pre-exposed illuminance is `light.directLux · preExposure`. every effect's direction comes
from its pitch, yaw and mode (`effectPitchYaw` in
[`environment/sun.ts`](../../packages/viewer/src/environment/sun.ts)), never from the shading sun
alone, so the [blend](environment.md#blending-at-the-camera) can lerp directions as angles. the
package leaves out the light fields the game derives from these, which some phases carry stale
([sun](../game-data/lighting.md#sun)).

direct sun lighting in [`frame.wgsl`](../../packages/viewer/src/render/frame/frame.wgsl)
(`shade_surface`) is GGX with height-correlated Smith visibility, scaled by
`directSpecularIntensity`, and Lambert diffuse times (1 − F), with the sun's colour taken as
illuminance and both terms carrying their 1/π. that's the local lights' lobe divided by π, with (1 −
F) on diffuse and without its clamps or multiple-scattering term; since the game's CPU scaling of
the sun is unknown, the sun may be π too dark ([open](../game-data/lighting.md#open)). foliage uses
the game's two-sided model.

## shadows

the viewer draws the game's four layers ([shadows](../game-data/lighting.md#shadows)) as 2048²
`depth32float` layers: the sharp cascades fitted to bounding spheres of frustum slices, the far
layer to the 832 m around the camera (the game's 800 m plus its grid cell) with its centre snapped
to a 32 m grid along the light's axes, all snapped to world texels so edges don't crawl
([`render/shadows/shadow-map.ts`](../../packages/viewer/src/render/shadows/shadow-map.ts)). turning
the camera doesn't change a sphere's fit. the layers are fitted once per frame, to the render size's
aspect, before the mesh selection groups casters by layer. which layers each caster draws into and
when the layers redraw is in [frame](frame.md).

- casters are what the main pass draws that frame, plus instances outside the view within 250 m
  whose shadows can reach it: the view frustum's planes are swept 250 m towards the sun, and
  instances inside the swept planes draw into the shadow layers only. off-screen casters smaller
  than 16 px (as if on screen) are skipped, the viewer's only size cull, and terrain outside the
  view doesn't cast.
- shadow-only renderers draw into the shadow layers only, in view or not. they cull back faces like
  any material, which is enough for Dijiang's roof; `_ShadowCullMode` isn't read.
- a draw casts into the sharp cascades only with its `CastsCascades` flag and into the far layer
  only with `CastsStatic` ([chains](../package-format.md#binary-encodings)); at a dense Jingyu view
  about two thirds of the shadow draws remain. listed rows (the CPU path) can't leave the far layer
  out, so a realtime-only caster there also casts into it.
- a point uses the first cascade sphere containing it, dithered with the next one over the outer
  tenth of the sphere's radius.
- the sharp cascades filter like the game's, in the game's 2 × 2 atlas uv.
- the sharp cascades fade into the far layer between 64 and 80 m by squared distance to the camera.
  the far layer is a 3×3 grid of bilinear comparisons, standing in for the game's tent-filtered
  cached map, and fades out towards its sphere's edge.
- against acne, receivers move along the normal by about a texel and casters take a slope-scaled
  depth bias, rather than the game's push towards the sun.
- contact shadows aren't drawn.
- the `shadow` section's fields apply as the game's do.

### cloud shadows

the cloud shadow darkens the sun on surfaces and the volumetric fog's sun
([cloud shadows](../game-data/lighting.md#cloud-shadows)). the fog's matters: without it, the haze
over places where a phase sets the alpha to 1, such as Marker Stone's caves, reads near-white.
`enableFarCloudShadowTexture` isn't read, as no shipped phase sets it.

## ambient

- the ambient probe is `sky.skyAmbientSH` scaled by `light.indirectDiffuseFactor`, converted to
  Unity's `ShadeSH9` vectors (`shaderSh`) and stored pre-exposed. the scaling is an assumption, so
  ambient brightness is approximate ([open](../game-data/lighting.md#open)); the native scalar on
  all diffuse ambient is left out, and `useCustomIVDefaultSH` and `customIVDefaultSH` aren't read.
- the [irradiance volume](#irradiance-volume) is sampled in `ambient_irradiance`, blended between
  levels near each level's edge as the game's are, with its validity fill-in and vertical correction
  term, but without its jitter or forward-shifted centres.
- AO's multi-bounce fit uses the albedo's luminance rather than fitting per channel.
- specular occlusion comes from material occlusion only, without GTAO.

the environment BRDF is Karis' analytic split-sum fit. specular ambient takes
`light.indirectSpecularFactor` as the game's specular scale. until a profile's reflection cubemap
streams in, it samples the ambient probe instead. local reflection probes aren't drawn.

### screen-space reflections

the viewer runs the game's screen-space reflections
([screen-space reflections](../game-data/lighting.md#screen-space-reflections)) in
[`ssr.wgsl`](../../packages/viewer/src/render/post/ssr.wgsl) and
[`screen-space-reflections.ts`](../../packages/viewer/src/render/post/screen-space-reflections.ts),
as fullscreen passes rather than compute kernels. like the game at PC high quality, every pass
(march, temporal filter, pyramid, resolve) runs at half the render size, reading the main pass's
targets at the pixel under each texel's centre, and the composite upsamples the result bilinearly
(about half a millisecond at 2560×1600). it reprojects through the depth buffer and the previous
camera instead of motion vectors (the scenery is static), and needs no rain-wetness variant: the
viewer's surfaces already carry the wet roughness ([wetness](../game-data/environment.md#wetness)),
so only the variant's ripple normals are missing. reflection-only effects don't draw into the
march's inputs. off the screen the sky reflection stays, as in the game.

## irradiance volume

the package stores the cells of the base bake and the scene-state bakes in the game's GPU layout
([package-format.md](../package-format.md#irradiance-cells)), so the viewer uploads them unchanged.

### scene-state bakes

each cell takes the first of its bakes whose visibility group shows, so a scene-state bake replaces
the base cell while all its states are on
([scene-state bakes](../game-data/irradiance.md#scene-state-bakes)). the cell window is rebuilt
every frame, so toggling a scene state swaps the cells and refills the levels holding them.

### clipmaps

[`render/lighting/irradiance-volume.ts`](../../packages/viewer/src/render/lighting/irradiance-volume.ts)
keeps three 3D clipmaps of 128 × 64 × 128 texels with probes 0.5, 2 and 8 m apart (A: L0 rgb; B:
three slabs along y for the L1 of each channel), centred on the camera. per level it wants the
window of cells its texels fall in, streams them into one storage buffer (coarse levels first, ahead
of scenery), and refills the whole level with
[`irradiance-update.wgsl`](../../packages/viewer/src/render/lighting/irradiance-update.wgsl) when
the camera moves more than 4 texels from its centre or a cell arrives or leaves, where the game
updates clipmaps partially. levels refill coarse to fine, and a refilled level refills every finer
one, because their probe-less texels copy it
([cells and probes](../game-data/irradiance.md#cells-and-probes)). the update pass looks cells up in
that window instead of the game's top-level hash. the clipmaps are sampled toroidally. the levels
stack along z in one A and one B texture, each level's slab with a copy of its last slice before it
and its first after it so A filters across the wrap
([`irradiance-clipmap.wgsl`](../../packages/viewer/src/render/lighting/irradiance-clipmap.wgsl));
the update pass writes a level to scratch textures and copies it into its slab, since it samples the
coarser level from the stacked ones. one volume lives for the session: loading a package swaps in
its cells and a fresh cell buffer, and empties the levels so they refill.

### region bakes

the finest level also takes the [region bakes](../game-data/irradiance.md#region-bakes) that show
and overlap it: a texel inside a resident region's grid reads that region's probe instead of the
cells', and the level refills when that set changes. the coarser levels keep the scene's bake, so a
room seen from beyond the finest level's reach (about 29 m) is lit as if empty.

## local lights

the package's `lights` table ([JSON tables](../package-format.md#json-tables)) holds the spot, point
and tube lights; directional, shadow-only and character-only lights are left out. it feeds
[`render/lighting/local-lights.ts`](../../packages/viewer/src/render/lighting/local-lights.ts), and
`local_lighting` in [`frame.wgsl`](../../packages/viewer/src/render/frame/frame.wgsl) follows the
game's lobe ([local lights](../game-data/lighting.md#local-lights)), without its multiple-scattering
term, shadows, cookies or flicker. lights load under their file's, structure's or placement's
visibility; a light the chunk files also hold keeps its files' conditions. a prefab light's culling
box turns with its placement.

each frame `local-lights.ts` takes the lights whose condition holds, that are within their culling
distance and in the view, sorts them by camera distance then priority and keeps the nearest 256, the
game's cap on PC. it bins them into the game's tiles and slices using conservative bounding spheres
on the CPU, and keeps the last upload while the camera, render size and shown lights stay the same.
the volumetric fog lights each froxel with the same lists.
