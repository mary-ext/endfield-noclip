# performance

- **redraw only when dirty.** the frame loop (`Viewer`'s `#tick`) renders when the camera moved, the
  canvas resized, an option or scene value changed (`#dirty`), the stream's `version` changed, a
  pipeline finished compiling, or `continuous` is on. showing the page again also marks it dirty,
  because Firefox re-shows a hidden tab's last frame with red and blue swapped until a new one is
  presented. after any of those it renders 32 more frames of the same view (`SETTLE_FRAMES`) so the
  temporal antialiasing converges, unless `antialiasing` is off. it also renders while the auto
  exposure is still moving (or waiting on its first histogram), but meters new histograms only while
  the view changes or settles, so it eases to a fixed target and stops even though water and
  particles change what it would meter every frame. only loading keeps it rendering indefinitely;
  animated content (scrolling textures, water, clouds, particles, drifting
  [flow noise](../game-data/sky-and-fog.md#flow-noise)) moves on the frames that render anyway and
  stops when they do. it all reads one animation clock that advances by the frame time only on
  rendered frames (and only with the `animate` option on), so it resumes where it stopped instead of
  jumping by the time the view idled. frames that only settle or adapt reuse the last selection,
  unless it drew particles or spinning rows and `animate` is on, which are re-evaluated so they keep
  moving until the view idles. it traverses without rendering while streaming is in progress
  (`!stream.idle`), and does nothing at all when the view is still and streaming is idle. replaying
  the last traversal's requests on frames where nothing was uploaded or evicted would save nothing:
  over four map02 teleports, every one of 1,523 loading frames had something new resident. the
  environment re-blends only when the eye, its settings or a fade changed.
- **stats** publish every 250 ms and notify subscribers only when the JSON differs, so the React
  panels don't re-render on a still view. the environment at the camera has its own revision, bumped
  only when its name or the applied volumes' phases and rounded weights change, which only the
  settings panel's applied volumes and look legend follow: the blend changes on most frames while
  the camera moves, and each re-render of the scene conditions panel took over 100 ms on map02. its
  collapsed sections build nothing until opened (`LazyDetails`), which brought a re-render from
  120–190 ms to about 35 ms there; it still re-renders when the camera moves into another level.
- **culled in groups.** the mesh selection rejects groups of 32 rows by their bounds before testing
  rows ([per-instance LOD](streaming.md#per-instance-lod)); on map02 this took 15–30% off its time
  at dense views, where most rows walked are drawn.
- **rows culled on the GPU.** groups whose LODs are resident hand their rows to a compute pass,
  which writes the visible list and indirect draws ([GPU culling](streaming.md#gpu-culling)). at a
  dense Jingyu view this took the frame from 10.4 to 7.9 ms (mesh selection 7.2 to 3.8 ms, GPU 8.8
  to 7.4 ms). rows in view hidden behind last frame's depth skip the main pass, which took flying
  over Jingyu from 9.9 to 9.4 ms of GPU time.
- **the game's detail radius.** detail draws within 256 m and HLOD clusters past it
  ([instance selection](streaming.md#instance-selection)); the screen-space rule this replaced drew
  detail three times as far out. mesh selection scales with the rows in reach, and dense foliage
  near the camera (over 200k rows within 128 m in Jingyu) still keeps it at about half the frame.
- **capped particles replayed in steps of a lifetime.** an emitter whose cap turns emissions away
  replays a few lifetimes of emissions when it first shows. a full system jumps to the moment its
  first particle dies, and the live ones are counted with a heap of end times: some map02 effects
  emit ten million a second capped at one particle, and walking them took 140–320 ms, the worst
  hitches when flying.
- **one traversal, many passes.** selection runs once per frame; shadow layers reuse its buckets.
  frames that reuse the last selection (settling the antialiasing, adapting the exposure) keep the
  shadow layers from the frame that drew them, unless a layer's fit moved or pipelines were still
  compiling.
- **few draws.** terrain is one draw; each mesh bucket is one instanced `drawIndexed` over its slice
  of the visible list. depth-writing draws are sorted by pipeline, then nearest first, which early
  depth testing rewards; the rest by pipeline, geometry and material, so runs share bindings
  ([`render/meshes/draw-order.ts`](../../packages/viewer/src/render/meshes/draw-order.ts)). drawing
  the depth-equal shading and the shadow layers of the depth-writing draws in binding order instead
  didn't shorten encoding at all on map02 (1.3 ms at a dense Jingyu view either way) and cost 0.2 ms
  of sorting: neighbouring buckets rarely share a geometry, so each draw rebinds anyway.
- **each pixel shades once.** a depth prepass draws the opaque meshes' positions alone (no fragment
  work) before anything else; the terrain then skips what they cover, and the opaque meshes shade
  with `depthCompare: 'equal'`. the prepass and the shading compute positions through the same
  `@invariant` function, so their depths match exactly. on an RDNA 2 GPU at 2560×1600 this saved
  1.1–1.6 ms of 7–11 ms at dense views and cost about 0.1 ms where little overlaps.
- **early depth survives alpha testing.** a shader that may discard loses early depth and, on
  tile-based GPUs, hidden-surface removal. opaque meshes use non-discarding pipelines, and shadow
  pipelines for them have no fragment stage. alpha-tested meshes lay down cut-out depth in the
  prepass, before the terrain, then shade with `depthCompare: 'equal'` and a non-discarding shader,
  so overlapping leaf cards shade each pixel once and the terrain isn't shaded under them (on RDNA 4
  at 2560×1600, the main pass at a dense Jingyu view went from 3.5 to 2.4–2.8 ms when the cut-out
  depth moved ahead of the terrain). an alpha-tested material draws as opaque until the texture
  holding its alpha ([alpha testing](../game-data/materials.md#alpha-testing)) has streamed, since
  there's no alpha to test yet.
- **no MSAA.** at 2560×1600 on an Apple M-series GPU, a dense Wuling City view took ~46 ms of GPU
  time with 4× MSAA and ~16 ms with temporal antialiasing (the `taa` pass is under 1 ms), and the
  render targets shrank from ~440 to ~200 MiB. `renderScale` 0.5 brought the same view to ~5 ms.
- **reflections at half resolution**, as the game runs them at PC high quality
  ([screen-space reflections](lighting.md#screen-space-reflections)).
- **AO at half resolution.** `ao depth` reduces the depth once into half-resolution view depth; GTAO
  marches that (keeping its scattered reads in cache) and the blur upsamples with depth weights.
- **cached work.** the transmittance and multiple-scattering LUTs render once per environment;
  irradiance clipmaps update only on re-centre or new cells; local lights are selected, binned and
  uploaded only when the camera, render size or shown lights change, not on settle frames.
- **no per-frame allocation on hot paths.** selections (their arrays and the instance range, terrain
  patch and surface objects in them), buckets and plane arrays are reused across frames, and texture
  requests per bucket allocate nothing. the stream manager evicts from a set of its ready, unpinned
  blobs rather than sweeping every blob it has seen, and reads each shard blob's byte range once.

## optimization candidates

- GPU culling leaves the buckets it picked empty in draws the CPU still encodes; pooling geometry so
  draws share vertex buffers would make each cheaper. flying over Jingyu, preparing and encoding
  draws take about 5 ms of an 11 ms CPU frame.
- cache shadow layers across new selections when their fit and casters are unchanged; terrain still
  draws into every layer.
- reduce the AO blur's reads by packing depth with AO or using `textureGather`.
- profile terrain close-up blending; stochastic projection or fewer anisotropy taps may reduce cost.
- measure timestamp-query overhead before limiting profiling to the stats panel.

composite needs a separate HDR target: the next frame's reflections read it after the main pass
rewrites radiance. the celestial pass reuses the sky reflection target after reflections finish.
