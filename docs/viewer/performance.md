# performance

how to measure is in [driving the viewer](../driving-the-viewer.md#profiling).

- **redraw only when dirty.** the frame loop (`Viewer`'s `#tick`) renders when the camera moved, the
  canvas resized, an option or scene value changed (`#dirty`), a water volume's level is moving, the
  stream's `version` changed, a pipeline finished compiling, or `continuous` is on. showing the page
  again also marks it dirty, because Firefox re-shows a hidden tab's last frame with red and blue
  swapped until a new one is presented. after any of those it renders 32 more frames of the same
  view (`SETTLE_FRAMES`) so the temporal antialiasing converges, unless `antialiasing` is off. it
  also renders while the auto exposure is still moving (or waiting on its first histogram), but
  meters new histograms only while the view changes or settles, so it eases to a fixed target and
  stops even though water and particles change what it would meter every frame. only loading keeps
  it rendering indefinitely; animated content (scrolling textures, water, clouds, particles,
  drifting [flow noise](../game-data/sky-and-fog.md#flow-noise)) moves on the frames that render
  anyway and stops when they do. it all reads one animation clock that advances by the frame time
  only on rendered frames (and only with the `animate` option on), so it resumes where it stopped
  instead of jumping by the time the view idled. frames that only settle or adapt reuse the last
  selection, unless it drew particles or spinning or riding rows and `animate` is on, which are
  re-evaluated so they keep moving until the view idles. it traverses without rendering while
  streaming is in progress (`!stream.idle`) or a saturated stream may still raise its
  [texture reduction](streaming.md#residency-and-budgets), and does nothing at all when the view is
  still and streaming is idle. replaying the last traversal's requests on frames where nothing was
  uploaded or evicted would save nothing: over several map02 teleports, every loading frame had
  something new resident. the environment re-blends only when the eye, its settings or a fade
  changed.
- **stats** publish every 250 ms and notify subscribers only when the JSON differs, so the React
  panels don't re-render on a still view. the environment at the camera has its own revision, bumped
  only when its name or the applied volumes' phases and rounded weights change, which only the
  settings panel's applied volumes and look legend follow: the blend changes on most frames while
  the camera moves, and each re-render of the scene conditions panel took over 100 ms on map02. its
  collapsed sections build nothing until opened (`LazyDetails`), which brought a re-render down to a
  few tens of milliseconds there; it still re-renders when the camera moves into another level.
- **culled in groups.** the mesh selection rejects groups of 32 rows by their bounds before testing
  rows ([per-instance LOD](streaming.md#per-instance-lod)); on map02 this took about a fifth off its
  time at dense views, where most rows walked are drawn.
- **rows culled on the GPU.** groups whose LODs are resident hand their rows to a compute pass,
  which writes the visible list and indirect draws ([GPU culling](streaming.md#gpu-culling)). at a
  dense Jingyu view this took about a quarter off the frame, mostly by halving mesh selection. rows
  in view hidden behind last frame's depth skip the main pass, which took about 5% off the GPU time
  flying over Jingyu.
- **the game's detail radius.** detail draws within 160 m (the `detailDistance` option's default,
  the game's high preset) and HLOD clusters past it
  ([instance selection](streaming.md#instance-selection)); a screen-space rule would draw detail
  several times as far out. mesh selection scales with the rows in reach, and dense foliage near the
  camera (a few hundred thousand rows in Jingyu) keeps it at about half the frame.
- **capped particles replayed in steps of a lifetime.** an emitter whose cap turns emissions away
  replays a few lifetimes of emissions when it first shows. a full system jumps to the moment its
  first particle dies, and the live ones are counted with a heap of end times: some map02 effects
  emit ten million a second capped at one particle, and walking them took hundreds of milliseconds,
  the worst hitches when flying.
- **one traversal, many passes.** selection runs once per frame; shadow layers reuse its buckets.
  frames that reuse the last selection (settling the antialiasing, adapting the exposure) keep the
  shadow layers from the frame that drew them, unless a layer's fit moved or pipelines were still
  compiling.
- **few draws.** terrain is one draw per pass. its patches are written in order of the first shadow
  layer their bounds reach, as mesh rows are grouped, so each layer draws a prefix of them rather
  than all; at the lv008 overview this cut each sharp layer's time to about a third. each mesh
  bucket is one instanced `drawIndexed` over its slice of the visible list. depth-writing draws are
  sorted by pipeline and geometry pool, then nearest first, which early depth testing rewards; the
  rest by pipeline, pool, geometry and material, so runs share bindings
  ([`render/meshes/draw-order.ts`](../../packages/viewer/src/render/meshes/draw-order.ts)). drawing
  the depth-equal shading and the shadow layers of the depth-writing draws in binding order instead
  doesn't shorten encoding on map02 and costs sorting time: neighbouring buckets rarely share a
  geometry. pooled geometry ([GPU resources](gpu-resources.md)) does: draws from one pool share
  vertex and index buffers instead of rebinding up to six vertex streams and the indices each, and
  encoding got a third to a half shorter at map02 views of a few thousand draws.
- **each pixel shades once.** a depth prepass draws the opaque meshes' positions alone (no fragment
  work) before anything else; the terrain then skips what they cover, and the opaque meshes shade
  with `depthCompare: 'equal'`. the prepass and the shading compute positions through the same
  `@invariant` function, so their depths match exactly. on an RDNA 2 GPU at 2560×1600 this saved
  roughly a seventh of the GPU time at dense views and cost next to nothing where little overlaps.
- **early depth survives alpha testing.** a shader that may discard loses early depth and, on
  tile-based GPUs, hidden-surface removal. opaque meshes use non-discarding pipelines, and shadow
  pipelines for them have no fragment stage. alpha-tested meshes lay down cut-out depth in the
  prepass, before the terrain, then shade with `depthCompare: 'equal'` and a non-discarding shader,
  so overlapping leaf cards shade each pixel once and the terrain isn't shaded under them (at a
  dense Jingyu view the main pass takes about a quarter less than with the cut-out depth after the
  terrain). an alpha-tested material draws as opaque until the texture holding its alpha
  ([alpha testing](../game-data/materials.md#alpha-testing)) has streamed, since there's no alpha to
  test yet.
- **no MSAA.** at 2560×1600 on an Apple M-series GPU, a dense Wuling City view took about three
  times the GPU time with 4× MSAA as with temporal antialiasing (the `taa` pass is under 1 ms), and
  render targets more than twice as large. `renderScale` 0.5 cut the same view's time to about a
  third.
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

composite needs a separate HDR target: the next frame's reflections read it after the main pass
rewrites radiance. the celestial pass reuses the sky reflection target after reflections finish.

## baseline

one run of map02 on RDNA 4 at 2560×1600, 2026-11-07, on a quiet machine. the figures are indicative
of that machine, package and build, something to compare a new run against, not a specification:

| measure                                                             | value         |
| ------------------------------------------------------------------- | ------------- |
| frame while flying (40 m/s, 40 m above ground), median/p95          | about 7/20 ms |
| frame settled at Jingyu, Jingyu at ground level, the lv008 overview | 6–7 ms        |
| GPU at those views                                                  | about 5 ms    |
| `mesh select` at those views                                        | 3.5–4 ms      |
| `encode`, `prepare`                                                 | under 1.5 ms  |
| teleport to idle, page load to idle                                 | 3 s, 5 s      |
| GPU pool bytes (geometry pools and their spare capacity included)   | about 800 MiB |

the hitches while flying (a few frame times long) are bursts of mesh selection and draw preparation,
not uploads, instance block builds or material derivations.

## optimization candidates

what the game's settings say it does is in [quality settings](../game-data/quality-settings.md).

- mesh selection is the largest CPU cost: picking LOD slots and making room in buckets on the GPU
  (count, prefix sum, write) would leave the CPU one item per row group instead of per segment.
- GPU culling leaves the buckets it picked empty in draws the CPU still encodes. flying over Jingyu,
  preparing and encoding draws took nearly half the CPU frame before geometry was pooled.
- settle frames re-run the whole selection while particles or spinning or riding rows are in view;
  giving emitters fixed row spans and moving rows bounds that hold their whole motion would let them
  reuse it.
- cache shadow layers across new selections when their fit and casters are unchanged. the game
  doesn't cache its cascades on PC, but caches its far map in 200 m tiles and redraws only the ones
  that changed, at most 8 a frame, where the viewer redraws the whole far layer when its casters or
  fit change.
- the game culls shadow casters below a size per layer (`CSMScreenSizeMin`, `ASMScreenSizeMin`),
  where the viewer draws every caster into every layer from its first; how the game measures the
  size isn't decoded, so check a candidate rule against an in-game shot of small props 30–80 m away
  first.
- the shadow map is `depth32float` with a reach of 1500 m towards the sun; the game uses 16-bit
  depth. tightening each layer's depth range (the casters' bounds, or clamping casters to the near
  plane with `depth-clip-control`) would make `depth16unorm` precise enough, halving the map (64 to
  32 MiB) and the bandwidth of every shadow sample; the bias needs retuning.
- the ambient and sky reflection targets are rgba16f each (16 bytes a pixel together, the
  reflection's alpha unused); packing them into one `rg32uint` (shared-exponent or 11-11-10 colour)
  would save about 32 MiB at 2560×1600 and the matching reads in composite and reflections. the
  celestial pass, which reuses the reflection target, would need its own.
- geometry pools never shrink, and the stream budget counts the ranges in them, not their spare
  capacity ([geometry pools](gpu-resources.md)); compacting or shrinking pools once they're mostly
  free would return it.
- reduce the AO blur's reads by packing depth with AO or using `textureGather`.
- profile terrain close-up blending; stochastic projection or fewer anisotropy taps may reduce cost.
- measure timestamp-query overhead before limiting profiling to the stats panel.
