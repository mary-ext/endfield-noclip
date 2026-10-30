# viewer

the viewer (`packages/viewer`) is a React shell around a raw WebGPU renderer. this page covers how
it opens a package, picks and streams content each frame, encodes the frame, manages GPU memory, and
keeps idle frames free, plus how to drive and profile it from an agent. the package layout it reads
is in [package-format.md](package-format.md); the lighting model the shaders implement is in
[game-data/lighting.md](game-data/lighting.md), and the environment blend in
[game-data/environment.md](game-data/environment.md).

the entry points are [`src/app.tsx`](../packages/viewer/src/app.tsx) (UI, URL state) and
[`src/viewer.ts`](../packages/viewer/src/viewer.ts) (`Viewer`: device, frame loop, camera, loaded
scene). the UI drives the viewer through `setOptions`, `showLevel`, `flyToLevel` and
`setSceneValue`, and reads `stats` through `subscribe`.

## loading a package

### sources

a package is read through a `PackageSource`
([`package/package-source.ts`](../packages/viewer/src/package/package-source.ts)), which offers
whole-file reads and byte-range reads:

| source            | used for                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| `httpSource`      | the dev/preview server, or any static host; one HTTP range request per read, tolerating servers that ignore `Range` |
| `directorySource` | a folder picked with the File System Access API (`showDirectoryPicker`), or a package copied into OPFS              |
| `fileListSource`  | a `<input webkitdirectory>` fallback where `showDirectoryPicker` is missing                                         |

the package panel ([`ui/package-panel.tsx`](../packages/viewer/src/ui/package-panel.tsx)) offers all
three. "copy to browser storage" imports a picked folder into OPFS (skipping `debug/`, which the
viewer never reads) so it can be reopened without picking it again.

### dev package server

[`vite-plugins/package-server.ts`](../packages/viewer/vite-plugins/package-server.ts) serves
extracted packages under `/packages/` on both `vite dev` and `vite preview`. the root defaults to
the repo's `out/`; set `NOCLIP_PACKAGES=/path` to point it elsewhere
([`vite.config.ts`](../packages/viewer/vite.config.ts)).

- `GET /packages/index.json` lists subdirectories that hold a core archive, with its size.
- files are served with single-range `Range` support, since the viewer reads individual blobs out of
  shard archives.
- responses carry `cache-control: no-cache` plus `Last-Modified`, because archives keep their names
  across re-packs and a cached copy would be read at the new package's offsets.
- paths are confined to the root.

### opening

`Viewer.load` → `openViewerPackage`
([`package/viewer-package.ts`](../packages/viewer/src/package/viewer-package.ts)) reads the whole
core archive, checks the manifest's format and version (a mismatch throws `PackageError` rather than
guessing at fields), and decodes its tables (tree, blob table, LOD chains, geometry, material,
texture, water and irradiance tables). shard JSON headers are never fetched: the blob table gives
each shard blob's absolute byte range, so a blob costs one range read.

`load` then builds the linked tile tree, the texture store, the irradiance volume and the stream
manager, pins the coarse layer (see [residency](#residency-and-budgets)), picks the initial level,
and poses the camera. the `MeshSelector` exists only when the package has converted geometry;
without it instances draw as boxes.

### decode workers and zstd

[`package/decode-pool.ts`](../packages/viewer/src/package/decode-pool.ts) runs 2–4 module workers
(half the hardware threads, clamped) and hands each job to the least busy one, transferring the
blob's buffer. [`package/decode-worker.ts`](../packages/viewer/src/package/decode-worker.ts) undoes
the blob codec and builds GPU-ready arrays:

| kind                | worker output                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| heights             | raw `u16` samples, padded to whole words for the storage buffer                                                       |
| instances           | instance rows, per-row cull data and (chain, first, count) runs, built by `buildInstanceRows`                         |
| geometry            | meshopt-decoded vertex streams (quantized positions, octahedral normals, UV0, tangents) and indices padded to 4 bytes |
| texture, irradiance | the decompressed bytes as stored                                                                                      |

zstd uses `zstddec`'s wasm build ([`package/zstd.ts`](../packages/viewer/src/package/zstd.ts)),
which is an order of magnitude faster than a JS decoder on texture blobs. each realm instantiates
its own module, so workers and the main thread (core tables) each await `zstdReady`. `zstddec`
reports no errors, so `decompressZstd` checks the decoded length and throws on a short frame.

## URL parameters

| parameter | meaning                                                                                                                                                                                                           |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package` | a dev package name (served from `/packages/<name>/`), or a URL/path of a package directory if it starts with `/`, `./`, `../` or `http(s):` ([`ui/package-param.ts`](../packages/viewer/src/ui/package-param.ts)) |
| `level`   | the level id to show first. if absent from the package, the first level with instances is shown                                                                                                                   |

the app keeps both in sync with `history.replaceState`, so a reload or a shared link reopens the
same package and level. packages opened from local folders have no `package` value.

## streaming and selection

each frame that does work runs one traversal (`#traverseAndPrepare` in `viewer.ts`):

1. `Selector.run` walks the tile tree for terrain patches and instance row ranges.
2. `MeshSelector.run` culls and LOD-selects instances in those ranges and buckets them for drawing.
3. sky textures, water surfaces and irradiance cells are requested.
4. `StreamManager.update` cancels, dispatches, uploads and evicts; `TextureStore.commit` applies
   texture shrinks.
5. if the frame renders, the renderers write their per-frame buffers (`prepare`).

### tile tree

[`scene/tile-tree.ts`](../packages/viewer/src/scene/tile-tree.ts) links the package's quadtree nodes
to their children and splits each node's content refs by kind: one terrain height page, one terrain
surface page, a leaf's terrain detail page, HLOD refs (with a tier), detail refs and conditional
refs. each node at or below the cell level records its cell id, for level focus.

### instance selection

[`streaming/selection.ts`](../packages/viewer/src/streaming/selection.ts) uses 3D Tiles-style
REPLACE refinement on screen-space error, `geometricError · pixelFactor / distance`:

- a node draws its HLOD while SSE ≤ `maxSse` (default 12 px), otherwise its children; a leaf refines
  into its detail blocks.
- until everything a refinement needs is resident, the node keeps drawing its own HLOD, so streaming
  never opens holes. disabled HLOD tiers are refined past.
- conditional content has no HLOD stand-in, so it follows its own rule: drawn while its tile spans
  more than `maxSse` pixels and its conditional set evaluates true (see
  [game-data/scene-states.md](game-data/scene-states.md)).
- manifest `resident` refs are pinned and drawn whenever they're resident, never requested.
- `setLevel(tag)` limits content to that level's tag plus shared tag 0, which is how one level is
  shown alone over the shared terrain.

### terrain selection

terrain is CDLOD. each level's distance range comes from its sample spacing and `terrainPixels`
(default 3 px per sample). a node subdivides while the next finer range reaches it; a quadrant whose
child page isn't resident is drawn from the parent page, and vertices morph to the coarser grid over
the last 30% of a level's range. every selected page quadrant is an instance of one shared grid, so
terrain is a single draw
([`render/terrain-renderer.ts`](../packages/viewer/src/render/terrain-renderer.ts)).

each visited node also wants its surface page at the same priority. a patch is shaded from the
finest resident surface page at or above its node, magnified when it's an ancestor's, so the ground
keeps its colours while finer pages stream. the shader draws the pages as stored: albedo, normal,
roughness and occlusion ([world.md](game-data/world.md#terrain)). patches with no resident page, or
with `terrainSurface` off or no BC textures, fall back to stand-in colours by slope.

leaves within `DETAIL_DISTANCE` (160 m) also want their detail page. once it and all of the
package's layer textures (pinned at load) are resident, the shader blends the leaf's close-up layers
as [world.md](game-data/world.md#close-up-layers) describes, with a smooth triplanar projection in
place of the game's random one, and fades them into the baked page between 96 and 144 m. the layers
sample with explicit gradients so slots and planes without weight are skipped. `terrainDetail` turns
this off. on an Apple M-series GPU at 1600×1000 the blend added about 7 ms of GPU time over open
ground (terrain only), unprofiled.

### per-instance LOD

[`streaming/mesh-selection.ts`](../packages/viewer/src/streaming/mesh-selection.ts) runs on the CPU
over the selected row ranges. per instance it:

1. culls by projected bounding-sphere size (`minBoxPixels`, default 1.5 px) and by frustum planes;
2. computes Unity's LODGroup metric (object size relative to screen height) and picks every chain
   draw whose `(minSquared, maxSquared]` band contains it. an instance past the chain's smallest
   threshold is culled, matching the game;
3. if all picked geometries are resident, appends the row to a bucket keyed by (geometry, submesh,
   material, mirrored); otherwise draws its box and requests the geometry at a priority of its
   projected pixel height. an instance is mirrored when its transform's determinant is negative,
   which flips its triangles' winding.

meshes cull the faces their material culls (front faces are clockwise, as Unity's are), with front
and back swapped for mirrored buckets. each mesh phase, shadows included, has a pipeline per face
culling, and draws are sorted by it.

shadow-only draws and materials that aren't drawn are dropped from the chain once, when it's first
used. textures are then requested per bucket, coarse to fine, down to the mip that gives about one
texel per pixel across the largest on-screen use, scaled by the UV tiling. sky, reflection and water
textures are streamed whole (`streamWholeTexture`).

the output (a visible row list plus per-bucket ranges) has the shape a GPU cull pass would write
next to indirect draw arguments; that pass isn't built yet.

### priority

priority is SSE (or projected pixels for geometry and textures). content in the focused level's
cells is boosted 8×; terrain outside the frustum is still requested at 0.1× as prefetch around the
camera. irradiance cells and sky textures use fixed priorities above all scenery.

### residency and budgets

[`streaming/stream-manager.ts`](../packages/viewer/src/streaming/stream-manager.ts) owns each blob's
lifecycle (`idle → queued → fetching → decoding → uploading → ready`, or `failed`).

- **wanting.** the traversal calls `want(blob, priority)` every frame. a resident blob that's wanted
  counts as used, even when a coarser stand-in is drawn, so a refinement in progress isn't evicted
  and refetched.
- **pinning.** the core archive's height and surface pages and instance blocks (coarse terrain,
  every HLOD block, resident scenery), plus the terrain layer textures, are pinned at load: queued
  first, uploaded first, never evicted. pinned height pages keep their samples on the CPU for
  ground-height queries (the first pose).
- **fetching.** at most 8 requests in flight (`maxRequests`). queued blobs are sorted by priority,
  and each seed coalesces neighbours in the same archive (gaps ≤ 64 KiB, span ≤ 2 MiB, ≤ 96 blobs)
  into one range read. core blobs are read from memory without a request slot. requests whose blobs
  nobody wanted for more than 2 frames are aborted; queued blobs not wanted this frame return to
  idle.
- **uploading.** at most 24 MiB per frame, pinned first, then by priority. decoded content nobody
  has wanted for 30 frames is dropped instead. a full pool evicts up to 16 older, lower-priority
  blobs of the same kind and retries.
- **budget.** resident bytes of all kinds count against `budgetMiB` (default 384). over budget, the
  least recently used unpinned blobs not used this frame are evicted. if the budget is still
  exceeded by content in use, the manager is _saturated_: unpinned fetches and uploads pause until
  something falls out of use, because evicting fresh uploads only to refetch them would thrash.
- `version` is bumped on every upload and eviction; the frame loop redraws on a change.

## the render frame

`#render` encodes one command buffer per frame. passes in order:

| #   | pass                                           | when                                                                                                                                                      |
| --- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `irradiance update 0–2` (compute)              | a clipmap level re-centred or got new cells ([`render/irradiance-volume.ts`](../packages/viewer/src/render/irradiance-volume.ts))                         |
| 2   | `shadow layer 0–3`                             | `shadows` on, a package loaded, `debugView` is `lit`                                                                                                      |
| 3   | `main`                                         | always (empty without a package)                                                                                                                          |
| 4   | `transmittance lut`, `multiple scattering lut` | once per environment                                                                                                                                      |
| 5   | `sky view lut`, `sky mean`                     | `sky` on                                                                                                                                                  |
| 6   | `ao depth`, `gtao`, `gtao blur`                | `ao` on and the environment has AO settings                                                                                                               |
| 7   | `composite`                                    | always                                                                                                                                                    |
| 8   | scene copy + `water`                           | `water` on, `lit`, and visible water surfaces                                                                                                             |
| 9   | `auto exposure histogram` (compute)            | `autoExposure` on, `lit`, the profile meters, and a readback buffer is free ([`render/auto-exposure.ts`](../packages/viewer/src/render/auto-exposure.ts)) |
| 10  | `bloom down` ×n, `bloom up` ×n                 | `bloom` on                                                                                                                                                |
| 11  | `tonemap`                                      | always, into the swapchain                                                                                                                                |

details:

- **depth.** reversed-Z `depth32float`, cleared to 0 and tested with `greater`, with an infinite far
  plane and a 0.25 m near plane
  ([`gfx/render-targets.ts`](../packages/viewer/src/gfx/render-targets.ts),
  [`scene/camera.ts`](../packages/viewer/src/scene/camera.ts)). everything renders camera-relative:
  instance block origins are rebased to the eye on the CPU in f64 each frame, so f32 precision holds
  at any distance.
- **main pass.** 4× MSAA into two `rgba16float` targets, radiance and its ambient part, resolved by
  the pass; the MSAA colour is discarded and depth is stored for post. draw order: terrain, meshes
  (opaque, then alpha-tested), instance boxes, box outlines (boxes larger than `outlineMetres`),
  terrain wireframe.
- **shadows.** four depth layers, laid out and filtered as in
  [lighting.md](game-data/lighting.md#shadows)
  ([`render/shadow-map.ts`](../packages/viewer/src/render/shadow-map.ts)). each layer's pass reuses
  this frame's main-pass selection and gets its own copy of the frame uniforms with its
  view-projection.
- **post** ([`render/post-process.ts`](../packages/viewer/src/render/post-process.ts)) is fullscreen
  triangles with `auto` layouts. composite applies AO, sky, aerial perspective and height fog; `fog`
  and `aerialPerspective` change what composite does, not which passes run. water draws over a copy
  of the composited scene so it can refract it
  ([`render/water-renderer.ts`](../packages/viewer/src/render/water-renderer.ts),
  [game-data/water.md](game-data/water.md)).
- **debug views** (`albedo`, `normals`, `roughness`, `ambient`, `clouds`) show the main pass as it
  is: no shadows, exposure, tonemapping, AO, bloom or water.

## GPU resource management

- **device** ([`gfx/device.ts`](../packages/viewer/src/gfx/device.ts)): high-performance adapter;
  requests `texture-compression-bc`, `float32-filterable`, `indirect-first-instance` and
  `timestamp-query` when present, and raises buffer, storage-binding and array-layer limits to the
  adapter's maximum. without BC support, BC textures are reported unstreamable and materials fall
  back to their untextured look.
- **range allocator** ([`gfx/range-allocator.ts`](../packages/viewer/src/gfx/range-allocator.ts)):
  first-fit over units, with frees coalescing neighbours so streaming in and out doesn't fragment
  the space without bound. it sub-allocates the instance-row mega storage buffer (1.5M rows, one
  range per block) and the irradiance cell buffer. terrain height pages use a fixed slot pool (4096
  slots); surface pages use a pair of BC3 texture arrays, one layer per page (1024 layers, or the
  device's array-layer limit if lower; 34 MiB); detail pages use 256 slots of an RGBA8 control
  array, a BC3 tint array and an index buffer (22 MiB); the package's layer textures get two BC7
  arrays sized at load. geometry gets one vertex and one index buffer per blob.
- **uniform ring** ([`gfx/uniform-ring.ts`](../packages/viewer/src/gfx/uniform-ring.ts)): one
  uniform buffer in 3 per-frame regions, sub-allocated at `minUniformBufferOffsetAlignment`. callers
  fill CPU views; `flush` uploads the frame's region in one `writeBuffer`, and draws bind group 0 at
  a dynamic offset. a frame needs the main block plus one per shadow layer.
- **bind layouts** ([`gfx/bind-layouts.ts`](../packages/viewer/src/gfx/bind-layouts.ts)): group 0 is
  the frame (uniforms, shadow map, reflection cubemap, irradiance clipmaps) for every family, so a
  pass binds it once; group 1 is per family; meshes add group 2 (per-draw parameters) and group 3
  (material textures). shadow passes bind a placeholder in place of the shadow map they render into.
- **pipeline cache** ([`gfx/pipeline-cache.ts`](../packages/viewer/src/gfx/pipeline-cache.ts)):
  modules by label, pipelines by a state key such as `mesh/opaque/x4`. renderers `prepare` every
  pipeline they use with `createRenderPipelineAsync` at construction, so streaming never compiles
  anything; a draw whose pipeline isn't ready yet is skipped.
- **texture store** ([`render/texture-store.ts`](../packages/viewer/src/render/texture-store.ts)):
  textures arrive as pieces, the mip tail first and then one blob per larger level. the GPU texture
  holds a contiguous run of levels from the finest integrated piece down to 1×1. integrating a finer
  piece creates a texture one step larger and copies the coarser levels over; releasing a piece
  shrinks it the same way at the next `commit`. a piece that arrives before its coarser neighbour
  waits. BC blocks upload as stored, without transcoding. replaced textures are destroyed one commit
  later, because bindings from before the swap are still in that frame's command buffer; bind groups
  rebuild when a binding's `version` changes.

## how the frame stays cheap

- **redraw only when dirty.** `#tick` renders when the camera moved, the canvas resized, an option
  or scene value changed (`#dirty`), the stream's `version` changed, the auto exposure is still
  moving (or waiting on its first histogram), or `continuous` is on. it traverses without rendering
  while streaming is in progress (`!stream.idle`), and does nothing at all when the view is still
  and streaming is idle. the environment re-blends only when the eye, its settings or a fade
  changed.
- **stats** publish every 250 ms and notify subscribers only when the JSON differs, so the React
  panels don't re-render on a still view.
- **one traversal, many passes.** selection runs once per frame; shadow layers reuse its buckets.
- **few draws.** terrain is one draw; each mesh bucket is one instanced `drawIndexed` over its slice
  of the visible list; draws are sorted by geometry then material so runs share bindings
  ([`render/mesh-renderer.ts`](../packages/viewer/src/render/mesh-renderer.ts)).
- **early depth survives alpha testing.** a shader that may discard loses early depth and, on
  tile-based GPUs, hidden-surface removal. opaque meshes use non-discarding pipelines, and shadow
  pipelines for them have no fragment stage. alpha-tested meshes lay down cut-out depth first, then
  shade with `depthCompare: 'equal'` and a non-discarding shader, so overlapping leaf cards shade
  each pixel once. an alpha-tested material draws as opaque until its base colour has streamed,
  since there's no alpha to test yet.
- **AO at half resolution.** `ao depth` resolves the MSAA depth once into half-resolution view
  depth; GTAO marches that (keeping its scattered reads in cache) and the blur upsamples with depth
  weights.
- **cached work.** the transmittance and multiple-scattering LUTs render once per environment;
  irradiance clipmaps update only on re-centre or new cells.
- **no per-frame allocation on hot paths.** selections, buckets and plane arrays are reused across
  frames.

## driving the viewer from an agent

use the `agent-browser` CLI with WebGPU enabled; without `--webgpu` the canvas stays blank.

```sh
pnpm run dev --port 5199 --strictPort
agent-browser --webgpu open 'http://localhost:5199/?package=map02&level=map02_lv007'
```

- after `agent-browser close`, reopen with `--webgpu` again.
- `agent-browser console` keeps lines from before a reload; read only what follows
  `[vite] connected`.
- after re-packing, reload once without cache, so no shard range is served from the old archive.
- wrap multi-statement `agent-browser eval` code in an IIFE: top-level `const` collides across
  evals.

### posing

the dev build exposes the `Viewer` as `window.viewer`. because it renders only when dirty, set
`viewer.options.continuous = true` before posing or measuring. change other options with
`viewer.setOptions({...})`, which marks the frame dirty and applies the budget.

- `viewer.controls.flyTo({ position: [x, y, z], yaw, pitch })` takes **radians** (the on-screen
  camera readout shows degrees) and animates for up to 3 s; wait for it before reading results. yaw
  0 looks along +z, positive yaw turns towards +x, negative pitch looks down.
- writing `viewer.camera.position` directly moves the view only while `continuous` is on, since it
  doesn't mark the frame dirty; this is useful for walking the camera per frame.
- `viewer.showLevel(id)` shows one level alone; `viewer.flyToLevel(id)` only flies there.

### inspecting

- environment: `viewer.environmentName`, `viewer.appliedVolumes` (volumes blended at the camera, in
  order), `viewer.environmentPhases()`, and
  `viewer.options.environmentVolumes / environmentPin / environmentEnabled`. volumes have height
  bands, so pose near the ground to see a level's own look; a high camera gets only the scene's
  global environment.
- `viewer.scene.pkg.manifest` holds levels, environment profiles, `environmentVolumes` and
  `environmentPhases`. `await import('/src/render/environment.ts')` gives `deriveEnvironment` for
  checking derived values against a profile.
- scene states: `viewer.sceneValues`, `viewer.conditionResults`, `viewer.setSceneValue(id, value)`.
- look: `viewer.options.exposure` (EV on top of the level's and the auto exposure's),
  `viewer.options.autoExposure`, `viewer.stats.autoExposureEv` and `viewer.options.debugView`
  (`'clouds'` shows the raw cloud panorama).
- `viewer.stats` (refreshed every 250 ms): draws, triangles, instances, residency, queue and request
  counters, `cpuMs`, `cpuPhases` and `gpuMs`.

### profiling

- run `agent-browser set viewport 2560 1600` first to match a retina window.
- for each pose, fly there with `continuous` on, wait until streaming settles (`stats.queued`,
  `requestsInFlight`, `decoding` and `uploading` at 0), then sample `stats` over a couple of
  seconds.
- `stats.gpuMs` spans the first timed pass's start to the last one's end and matches frame time when
  GPU-bound. `stats.cpuPhases` splits CPU time into `controls`, `tree`, `mesh select`, `sky, water`,
  `stream`, `prepare`, `uniforms`, `encode` and `submit`.
- Apple GPUs (tile-based) overlap passes, so `stats.gpuPasses` are pass lifetimes, not costs, and
  can sum to far more than `gpuMs`. attribute cost by ablation: toggle one option (`shadows`, `ao`,
  `bloom`, `water`, `sky`, `terrain`, `instances`, HLOD tiers, …) at a fixed pose, take a fresh
  baseline before each variant, and compare `gpuMs`.
- ablate only frames well over the 16.7 ms budget (raise the viewport if needed): a lightly loaded
  GPU clocks down, and a variant can then read slower than its baseline.
- large regions at the default budget evict content during a run, so resident content differs
  between runs; compare numbers within one run.

## open

- per-instance culling and LOD selection run on the CPU and dominate CPU time at dense views; a
  compute cull pass writing the visible list plus indirect arguments is the planned replacement.
- shadows redraw every on-screen caster into all four layers on every rendered frame. per-layer
  culling and caching a cascade while its snapped fit doesn't move are unbuilt, and off-screen
  casters don't cast.
- composite and water read the 4× MSAA depth; the half-resolution depth or a full-resolution resolve
  could serve them.
- the AO blur's loads per pixel could be cut by packing depth with AO or using `textureGather`.
- terrain's GPU cost at high resolution is unexamined.
- the profiler times every pass whenever `timestamp-query` exists; gate it on the stats panel if it
  shows up in measurements.
- terrain surface pages swap with their level, without cross-fade. the close-up blend's cost is
  unprofiled; sampling one projection plane per pixel, as the game does, or fewer anisotropy taps
  are the obvious cuts, and layer tiling repeats visibly in open grass.
