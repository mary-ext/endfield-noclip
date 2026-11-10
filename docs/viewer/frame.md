# the render frame

`encodeFrame`
([`render/frame/frame-graph.ts`](../../packages/viewer/src/render/frame/frame-graph.ts)) encodes one
command buffer per frame from a `FrameContext` (camera, sizes, frame groups, frame index, clock and
the settings in effect, which debug views turn the lit-only passes off in once per frame). the post
chain runs in two halves around the passes over the composited scene (`encodeComposite`, then water,
the transparent pass and screen effects, then `encodeAfterScene`). passes in order:

| #   | pass                                                                 | when                                                                                                                                                                                                                                                      |
| --- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `irradiance update 0–2` (compute)                                    | a clipmap level re-centred or got new cells ([`render/lighting/irradiance-volume.ts`](../../packages/viewer/src/render/lighting/irradiance-volume.ts))                                                                                                    |
| 1b  | `skin` (compute)                                                     | an animated geometry is drawn and the clock moved it to another frame ([`render/meshes/skin-animation.ts`](../../packages/viewer/src/render/meshes/skin-animation.ts))                                                                                    |
| 1c  | `depth pyramid`, `instance cull` (compute)                           | a new selection left rows to the GPU ([GPU culling](streaming.md#gpu-culling)); `depth pyramid` only with `occlusionCulling` on and a last frame to test against                                                                                          |
| 2   | `shadow layer 0–3`                                                   | `shadows` on, a package loaded and `debugView` `lit`. layers 0–2: the casters or their fit changed since they were drawn, or `skin` ran. layer 3: its fit moved to another cell of its grid, or the casters changed and it was drawn 8 or more frames ago |
| 3   | `volumetric fog` (compute)                                           | `heightFog` on, a package loaded, `lit`, and the environment's volumetric fog on ([`render/sky/volumetric-fog.ts`](../../packages/viewer/src/render/sky/volumetric-fog.ts))                                                                               |
| 4   | `main`                                                               | always (empty without a package)                                                                                                                                                                                                                          |
| 4b  | `decal relight`                                                      | a package loaded                                                                                                                                                                                                                                          |
| 6   | `transmittance lut`, `multiple scattering lut`                       | once per environment                                                                                                                                                                                                                                      |
| 7   | `sky view lut`                                                       | `sky` on                                                                                                                                                                                                                                                  |
| 8   | `ao depth`, `gtao`, `gtao blur`                                      | `ao` on, `lit`, and the environment has AO settings                                                                                                                                                                                                       |
| 9   | `ssr march`, `ssr temporal`, `ssr downsample` ×n, `ssr resolve`      | `reflections` on, `lit`, and the environment has reflection settings; otherwise `ssr off` only clears the output ([`render/post/screen-space-reflections.ts`](../../packages/viewer/src/render/post/screen-space-reflections.ts))                         |
| 10  | `celestial`                                                          | always; writes nothing with `sky` off or nothing beyond the atmosphere                                                                                                                                                                                    |
| 10b | `water depth`                                                        | always; draws the nearest water surface's depth when the `water` pass will run, else only clears it                                                                                                                                                       |
| 11  | `composite`                                                          | always                                                                                                                                                                                                                                                    |
| 12  | scene copy, `water foam`, `water`                                    | `water` on, `lit`, and visible water surfaces; `water foam` only when foam effects are drawn                                                                                                                                                              |
| 12a | `transparent`                                                        | glass or effects are drawn                                                                                                                                                                                                                                |
| 12b | `effect multiply`, scene copy + `effect refract`                     | effects that multiply or refract the composited scene are drawn ([effects](effects.md#over-the-composited-scene))                                                                                                                                         |
| 13  | `light shaft downsample`, `light shaft blur` ×n, `light shaft apply` | `lit`, the environment has light shafts, and the sun is in front of the camera ([`render/post/light-shafts.ts`](../../packages/viewer/src/render/post/light-shafts.ts))                                                                                   |
| 14  | `lens flare`                                                         | `lit`, the environment has a flare, and the sun is on screen (or the flare allows it off screen) ([`render/post/lens-flare.ts`](../../packages/viewer/src/render/post/lens-flare.ts))                                                                     |
| 15  | `taa`                                                                | always ([`render/post/temporal-aa.ts`](../../packages/viewer/src/render/post/temporal-aa.ts)); with `antialiasing` off it only scales to the output size                                                                                                  |
| 16  | `auto exposure histogram` (compute)                                  | `autoExposure` on, `lit`, the profile meters, the view is changing or settling (or nothing is metered yet), and a readback buffer is free ([`render/post/auto-exposure.ts`](../../packages/viewer/src/render/post/auto-exposure.ts))                      |
| 17  | `bloom down` ×n, `bloom up` ×n                                       | `bloom` on, `lit`, and a canvas large enough for the mip chain                                                                                                                                                                                            |
| 18  | `tonemap`                                                            | always, into the swapchain                                                                                                                                                                                                                                |

passes up to the lens flare run at the render size, the canvas's device-pixel size times
`renderScale` (clamped to [0.25, 1]); `taa` and everything after it run at the output (canvas) size.
what each post pass computes is in [post-processing](post-processing.md) and
[sky and fog](sky-and-fog.md).

- **depth.** reversed-Z `depth32float`, cleared to 0 and tested with `greater`, with an infinite far
  plane and a 0.25 m near plane; logarithmic depth is avoided because writing fragment depth
  disables early-Z and, on tile-based GPUs, hidden-surface removal. where the GPU has the
  `depth32float-stencil8` feature, depth carries a stencil, cleared to 0, which only effect
  [portals](effects.md#portals) use; post passes sample the depth aspect alone
  ([`render/frame/render-targets.ts`](../../packages/viewer/src/render/frame/render-targets.ts),
  [`scene/camera.ts`](../../packages/viewer/src/scene/camera.ts)). everything renders
  camera-relative: instance block origins are rebased to the eye on the CPU in f64 each frame, so
  f32 precision holds at any distance.
- **main pass.** one sample per pixel into radiance and its ambient part (`rgba16float`), plus what
  lit surfaces hand the screen-space reflections: the sky reflection the radiance holds
  (`rgba16float`) and the normal, roughness and hit weight packed in `rg32uint`, which fills
  WebGPU's default 32 bytes per sample; depth is stored for post. draw order: the opaque meshes'
  depth and the alpha-tested meshes' cut-out depth, terrain, meshes (opaque, then alpha-tested, both
  shading at equal depth, then opaque [effects](effects.md#vfxbasev2-and-vfxdecal), then
  stencil-only portal masks), instance boxes, box outlines (boxes larger than `outlineMetres`),
  terrain wireframe.
- **decal relight pass.** lit decals that change only a surface's normal, roughness or occlusion add
  the change in its light to the radiance, reading the depth, packed surface and ambient targets
  ([decals](materials.md#decals)).
- **transparent pass.** as in the game
  ([transparent draw order](../game-data/materials.md#transparent-draw-order); the pass's steps are
  under [blending](../game-data/effects.md#blending)), glass and alpha-blended effects draw after
  the water, straight over the composited scene, far to near: testing the main pass's depth without
  writing it (the stencil stays writable), each fogs its own colour at its own distance
  ([`render/sky/fog.wgsl`](../../packages/viewer/src/render/sky/fog.wgsl), whose inputs the mesh
  draw group carries) and blends it premultiplied over what's there, additive light with an opacity
  of 0 ([blending](effects.md#blending)). the order is by instance: the selection keeps each
  transparent row's distance to the camera and its draw's sort band (the prefab renderer's sorting
  layer, then order; 0 for static scenery), sorts each bucket's rows by band, then far to near, and
  the mesh renderer merges every draw of the pass into one list of runs in that order
  (`mergeFarToNear` in
  [`render/meshes/sorted-runs.ts`](../../packages/viewer/src/render/meshes/sorted-runs.ts)),
  neighbouring instances of one draw sharing a call. draws that write the stencil go first, whole,
  so the effects testing it see the whole mask.
- **antialiasing** is temporal with upsampling, as in the game, which has no MSAA. the main pass's
  projection is offset by a Halton (2, 3) subpixel jitter each frame (8 positions per cycle, more
  when upsampling), and the post passes that reconstruct view rays undo it. `taa` reconstructs each
  output pixel from the 3×3 render-size samples around it (a Gaussian fit to Blackman-Harris),
  reprojects the previous output through the depth buffer and the previous camera only, with no
  motion vectors, so moving content (particles, animated and spinning geometry, swaying cloth)
  reprojects as if it stood still; samples it with Catmull-Rom, clips it to the neighbourhood's
  colour box in YCoCg and blends in 10% of the new frame, less where upsampling leaves no sample
  near the pixel. colours are weighted by `1 / (1 + luminance · exposure)` while filtering. two
  output-size histories alternate. a cut (a new package, the first pose, a debug view or
  antialiasing toggle) drops the history. below the output size, material textures sample with a mip
  bias of `log2(renderScale)` (terrain layers by scaling their gradients), and selection, LOD and
  texture streaming measure screen sizes in output pixels, so `renderScale` trades shading cost
  only.
- **shadows.** four depth layers, fitted, filtered and fed with off-screen casters as
  [lighting](lighting.md#shadows) describes
  ([`render/shadows/shadow-map.ts`](../../packages/viewer/src/render/shadows/shadow-map.ts)). each
  layer's pass reuses this frame's main-pass selection and gets its own copy of the frame uniforms
  with its view-projection. off-screen casters land in cast-only buckets, drawn first in each phase
  so the shadow passes draw a prefix and the main pass skips it; only their alpha texture is
  requested, they never draw as boxes, and their tiles never hold back the HLOD refinement of tiles
  in view. each bucket's rows are grouped by the first layer they can cast into (within the layer's
  radius across the light, and up to the caster reach towards the sun), so a layer draws a prefix of
  each bucket: the three sharp cascades skip everything beyond their 80 m, and instances no layer
  reaches don't draw into the shadow map at all. this cuts shadow draws by more than half at every
  profiled pose. the depth-only stages (shadow casters, alpha-tested depth) bind only the vertex
  streams they read: positions, plus the UV sets for alpha testing.
- **animated geometries** ([package format](../package-format.md#geometry-blob-mesh-efgm)) are
  skinned on the GPU before anything draws: each frame, for each drawn geometry whose vertices don't
  hold the clock's frame yet, `skin` blends the two current frames' bone matrices, skins the bind
  pose (kept in its own storage buffer with the weights and bones) and writes positions, normals and
  tangents over the geometry's own vertex streams (an animated geometry stays out of the
  [geometry pools](gpu-resources.md)), in the formats every mesh pipeline already reads, positions
  quantized to the animation's box. so the prepass, shading and shadow passes need no variants, and
  every placement of a geometry shows the same frame of the viewer's clock. normals and tangents
  turn by the blended matrix itself, as Unity's skinning turns them. a frame that skins one redraws
  the sharp shadow layers, so with the clock stopped they stay as drawn.
- **post** ([`render/post/post-process.ts`](../../packages/viewer/src/render/post/post-process.ts))
  is fullscreen triangles with `auto` layouts
  ([`gfx/fullscreen-pass.ts`](../../packages/viewer/src/gfx/fullscreen-pass.ts)), except the lens
  flare's instanced quads and the water; `taa` and the screen-space reflections reproject their
  histories through the previous camera
  ([`render/post/camera-history.ts`](../../packages/viewer/src/render/post/camera-history.ts)).
  composite adds the screen-space reflections ([lighting](lighting.md#screen-space-reflections)),
  then applies AO, sky, atmosphere fog and height fog; `heightFog` and `atmosphereFog` change what
  composite does, not which passes run. water draws over a copy of the composited scene so it can
  refract and reflect it, before anything transparent, as the game lights its water first
  ([`render/water/water-renderer.ts`](../../packages/viewer/src/render/water/water-renderer.ts),
  [water](water.md)). its layout is explicit because it also binds the main pass's frame group for
  the sun shadow, irradiance volume and sky reflection; its shader moves the post uniforms to group
  3 ([`render/post/shader-source.ts`](../../packages/viewer/src/render/post/shader-source.ts)). WGSL
  helpers that several shaders share (noise, colour conversions, luminance weights, the screen-space
  projection, the octahedral codec, the reflection surface's packing, the Henyey–Greenstein phase,
  normal-map texels) are in
  [`render/shaders/common/`](../../packages/viewer/src/render/shaders/common/); TS constants a
  shader reads are declared into its source with `wgslConst`
  ([`render/shaders/wgsl-const.ts`](../../packages/viewer/src/render/shaders/wgsl-const.ts)).
- **debug views** (`albedo`, `normals`, `roughness`, `ambient`, and `clouds` for the raw cloud
  panorama) show the main pass as it is: no shadows, local lights, cloud shadows, exposure,
  tonemapping, fog, AO, reflections, bloom, light shafts, lens flare or water. temporal antialiasing
  still applies.
