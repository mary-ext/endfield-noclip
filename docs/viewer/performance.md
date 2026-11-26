# performance

measurement instructions are in [driving the viewer](../driving-the-viewer.md#profiling).

- **redraw only when dirty.** frames render when the camera moved, canvas resized, an option or
  scene value changed, a water level is moving, streaming uploaded/evicted, a pipeline compiled, tab
  visibility returned (works around a Firefox R/B swap bug on hidden tabs), or `continuous` is on.
  - renders 32 more frames after any change so TAA converges (skipped if `antialiasing` is off).
  - keeps rendering while auto exposure adapts (or awaits its first histogram), but meters new
    histograms only during changes/settling so water and particles don't prevent convergence.
  - animated content (scrolling UVs, water, clouds, particles, drifting
    [flow noise](../game-data/sky-and-fog.md#flow-noise)) reads one animation clock that advances
    only on rendered frames with `animate` on, pausing cleanly when idle.
  - settle/adapt frames reuse the last selection; when only non-casting particles animate on a still
    idle view, active emitter rows update in place (falling back to a full traversal if any emitter
    grows). spinning or riding rows still re-traverse.
  - traverses without rendering while streaming is active or while a saturated stream may raise
    [texture reduction](streaming.md#residency-and-budgets); does nothing when still and idle.
  - environment re-blends only when eye, settings, or a fade changes.
- **throttled stats and UI.** stats publish every 250 ms and notify subscribers only on change.
  environment UI tracks a separate revision used only by the settings panel's applied volumes and
  look legend. scene conditions sections render lazily when expanded, cutting map02 re-renders from
  > 100 ms to a few tens of ms (still re-renders on level change).
- **group culling.** mesh selection rejects 32-row groups before testing individual rows
  ([per-instance LOD](streaming.md#per-instance-lod)), cutting ~20% off dense map02 views.
- **GPU culling and occlusion.** resident groups cull in compute and emit indirect draws
  ([GPU culling](streaming.md#gpu-culling)), cutting ~25% off dense Jingyu frames (halving mesh
  selection). last-frame depth-pyramid occlusion culling cuts ~5% GPU time flying over Jingyu. small
  shadow casters are culled per layer on both CPU and GPU using the game's camera-view screen-size
  minimums (`0.005` / `0.01` / `0.02` for cascades 0–2, `0.01` for the far layer).
- **game detail radius.** detail draws within `detailDistance` (default 160 m, game's high preset)
  and HLOD past it ([instance selection](streaming.md#instance-selection)); mesh selection scales
  with rows in reach (a few hundred thousand foliage rows in Jingyu ≈ half the frame).
- **capped particle replay.** full emitters jump directly to the earliest particle death time using
  a min-heap of end times, avoiding hundreds-of-ms hitches on map02 effects emitting 10M/s capped at
  1 particle.
- **one traversal, many passes.** shadow layers reuse the frame's selection buckets and track
  per-cascade fits. still views keep cached shadow layers when only non-casting particles animate
  (or during settle/adapt frames unless a fit moved or pipelines were compiling).
- **few draws, pooled geometry.** terrain is 1 draw/pass, ordered by first reachable shadow layer
  (cutting lv008 sharp shadow layer time to ~1/3). each mesh bucket is 1 instanced `drawIndexed`.
  depth-writing draws sort by `(pipeline, pool, nearest-first)` for early-Z; others by
  `(pipeline, pool, geometry, material)`. [geometry pools](gpu-resources.md#buffers-and-pools) share
  vertex/index buffers, cutting encoding by 33–50% on map02 views of a few thousand draws.
- **depth prepass.** opaque meshes write depth only (no fragment shader), then terrain skips covered
  pixels, then opaque meshes shade at `depthCompare: 'equal'` using the same `@invariant` position
  function. saves ~1/7 GPU time on dense RDNA 2 2560×1600 views.
- **early depth with alpha test.** opaque pipelines never discard (shadow pipelines have no fragment
  stage). alpha-tested meshes write cut-out depth before terrain (sampling only the map that holds
  their alpha, plus the dither mask when needed), then shade at `depthCompare: 'equal'` without
  discarding, cutting main-pass time ~25% at dense Jingyu views. alpha-tested materials draw opaque
  until their [alpha texture](../game-data/materials.md#alpha-testing) streams in.
- **lean Lit opaque pipeline.** plain base+normal opaque Lit materials (~86% of map02 opaque
  materials) route to a compact pipeline (2 texture samples, no parallax/layer/foliage/erosion/unlit
  branches), cutting main-pass GPU time ~13% on dense views while complex materials use the full
  opaque shader.
- **16-bit shadow maps.** when `depth-clip-control` is supported, the sun shadow map uses
  `depth16unorm` (32 MiB instead of 64 MiB) with near-plane clamping and a tighter `2·radius + 64 m`
  depth range, halving shadow write and PCF gather bandwidth (without it, falls back to
  `depth32float`). the local-light shadow atlas (32 MiB) and weather vertical occlusion map also use
  `depth16unorm`.
- **packed HDR post targets.** when `rg11b10ufloat-renderable` is supported, TAA history, bloom, and
  light shafts use `rg11b10ufloat` instead of `rgba16float`, halving their VRAM (~44 MiB at
  2560×1600) and post-chain bandwidth.
- **no MSAA.** at 2560×1600 on Apple M-series, 4× MSAA cost ~3× the GPU time of TAA (< 1 ms) and
  > 2× target memory. `renderScale` 0.5 cuts GPU time to ~1/3.
- **half-resolution SSR and AO.** [SSR](lighting.md#screen-space-reflections) runs at half
  resolution (matching PC high). `ao depth` downsamples depth once; GTAO marches half-res depth and
  depth-aware blur upsamples.
- **cached work.** transmittance and multiple-scattering LUTs render once per environment;
  irradiance clipmaps update only on re-centre or new cells; local lights select/bin/upload only on
  camera, size, or visibility changes.
- **mip feedback.** [mip feedback](streaming.md#mip-feedback) cut resident textures at
  street/interior stops by 33–67%, downloads by 25–40%, and map02 walk frame median/p95 from ~15/34
  ms to 12/23 ms (eliminating > 50 ms upload stalls). target costs 4 B/px; compute/readback overhead
  unprofiled.
- **staged uploads.** uploads ≥ 128 KiB use [staged writes](gpu-resources.md#pipelines-and-uploads),
  avoiding 15–30 ms/MiB main-thread stalls.
- **decode and fetch pipeline.** 64 jobs/worker (64 MiB cap;
  [decode workers](loading.md#decode-workers-and-zstd)) cut map02 teleport settle from 2.5 s to ~1 s
  and page load from 5 s to ~2 s; [multi-range requests](streaming.md#residency-and-budgets) halved
  flight request counts.
- **tabulated, cached, and off-thread particles.** immutable per-particle birth attributes and
  over-lifetime random draws are cached while particles live; velocity/spin curve integrals are
  pre-resolved per system, single-curve `sizeOverLifetime`/`colorOverLifetime` and sRGB conversion
  use lookup tables, and constant-zero motion/spin/custom modules are skipped
  ([motion](particles.md#motion)). after an emitter's first synchronous frame, per-frame simulation
  and row packing run on a dedicated Web Worker with ping-pong transferred buffers, cutting dense
  map02 `mesh select` by 47–63%.
- **zero per-frame hot-path allocation.** selections, buckets, sort scratch, particle worker
  buffers, and plane arrays reuse storage across frames; per-bucket texture requests allocate
  nothing and deduplicate within a frame; eviction biases LRU toward textures before
  geometry/instances.

target reuse: `composite` needs its own HDR target so next frame's SSR can read it after `main`
overwrites radiance; `celestial` reuses the sky reflection target after SSR finishes.

## optimization candidates

see [quality settings](../game-data/quality-settings.md) for what the game toggles.

- **GPU LOD selection.** moving slot picking and bucket allocation to GPU (count, prefix sum, write)
  at 64-row group granularity over-requests geometry (~2×) and expands empty indirect draws (~2.6×)
  because loose group spheres widen LOD bands and cross-group chain unions widen shadow layers; a
  viable GPU-LOD path would need tighter per-LOD bounds or GPU-driven draw compaction.
- **eviction policy.** sizing the stream budget to the device or adding mip hysteresis without
  triggering saturation.
- **empty GPU-culled draws.** segment-range picking leaves empty buckets the CPU still encodes.
- **settle-frame selection reuse for moving rows.** spinning/riding rows have exact finite swept
  bounds (so their 64-row groups stay GPU-cullable), and reusing their selection across settle
  frames would let still views skip re-traversal too.
- **shadow caching.** cache cascades across selections when fit and casters match; tiling the far
  shadow layer (200 m / 256² tiles, ≤ 8/frame) only pays off with per-tile CPU draw culling, since
  the full far layer is already amortized to ~0.04 ms/frame GPU via an 8-frame redraw interval.
- **pack ambient + sky reflection.** combine both `rgba16float` targets (16 B/px, reflection alpha
  unused) into one `rg32uint` (shared-exponent or 11-11-10) to save ~32 MiB at 2560×1600 and
  matching reads (`celestial` would need its own target).
- **geometry pool compaction.** compact or shrink pools when mostly free so unused capacity returns
  to the device ([geometry pools](gpu-resources.md#buffers-and-pools)).
- **AO blur reads.** pack depth with AO or use `textureGather`.
- **terrain close-up blending.** profile stochastic projection or lower anisotropy.
- **timestamp queries.** measure overhead before restricting queries to when the stats panel is
  open.
