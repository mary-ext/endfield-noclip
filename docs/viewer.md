# viewer

the viewer (`packages/viewer`) is a React shell around a raw WebGPU renderer. this page covers how
it opens a package, picks and streams content each frame, encodes the frame, manages GPU memory, and
keeps idle frames free. the package layout it reads is in [package-format.md](package-format.md);
what the shaders implement is on the rendering pages [lighting.md](game-data/lighting.md) indexes,
and the environment blend in [game-data/environment.md](game-data/environment.md). driving and
profiling it from an agent is in [driving-the-viewer.md](driving-the-viewer.md).

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

every range read passes the archive's size from the manifest. a source whose file has another size
throws `PackageChangedError`; the stream manager then stops fetching shards (resident content stays
drawn) and the stats panel offers a reload, instead of decoding wrong bytes into dozens of failed
blobs.

the package panel ([`ui/package-panel.tsx`](../packages/viewer/src/ui/package-panel.tsx)) offers all
three. where both `showDirectoryPicker` and OPFS exist, "copy into browser storage" imports the
picked folder into OPFS (skipping `debug/`, which the viewer never reads) so it can be reopened
without picking it again.

### dev package server

[`vite-plugins/package-server.ts`](../packages/viewer/vite-plugins/package-server.ts) serves
extracted packages under `/packages/` on both `vite dev` and `vite preview`. the root defaults to
the repo's `out/`; set `NOCLIP_PACKAGES=/path` to point it elsewhere
([`vite.config.ts`](../packages/viewer/vite.config.ts)).

- files are served as a static host would, by `sirv`: `Range` support, `ETag` and `Last-Modified`
  validators, `cache-control: no-cache`, nothing package-specific. keep it that way, so the dev
  setup behaves like a deployment. a deployment's host needs range requests and revalidation too,
  because archives keep their names across re-packs; the packer never rewrites a file in place (it
  swaps in a new package), so ordinary validators suffice.
- `GET /packages/index.json` lists subdirectories that hold a core archive, with its size, skipping
  hidden directories (the packer's staging and replaced packages). it's the one dev-only addition.

### opening

`Viewer.load` → `openViewerPackage`
([`package/viewer-package.ts`](../packages/viewer/src/package/viewer-package.ts)) reads the whole
core archive, checks the manifest's format and version (a mismatch throws `PackageError` rather than
guessing at fields), and decodes its tables (tree, blob table, LOD chains, geometry, material,
texture, water, light, particle and irradiance tables). shard JSON headers are never fetched: the
blob table gives each shard blob's absolute byte range, so a blob costs one range read.

`load` then rejects terrain surface pages of a size or border the terrain renderer wasn't built for,
builds the linked tile tree, the texture store, the irradiance volume and the stream manager, pins
the coarse layer (see [residency](#residency-and-budgets)), picks the initial level, and poses the
camera. the `MeshSelector` exists only when at least one geometry converted; without it instances
draw as boxes.

### decode workers and zstd

[`package/decode-pool.ts`](../packages/viewer/src/package/decode-pool.ts) runs 2–4 module workers
(half the hardware threads, clamped) and hands each job to the least busy one, transferring the
blob's buffer. [`package/decode-worker.ts`](../packages/viewer/src/package/decode-worker.ts) undoes
the blob codec and builds GPU-ready arrays:

| kind                       | worker output                                                                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| heights                    | raw `u16` samples, padded to whole words for the storage buffer                                                                                            |
| instances                  | instance rows, per-row cull data and (chain, first, count) runs, built by `buildInstanceRows`                                                              |
| geometry                   | meshopt-decoded vertex streams (quantized positions, `snorm16x2` octahedral normals, UV0, UV1, tangents, `unorm8x4` colours) and indices padded to 4 bytes |
| surface                    | the albedo and normal BC3 images, each in its own buffer                                                                                                   |
| splat                      | the control, tint and index arrays                                                                                                                         |
| texture, layer, irradiance | the decompressed bytes as stored                                                                                                                           |

a 16-bit UV set stays `unorm16x2`, dequantized in the vertex shader, unless the mesh's other set is
stored as floats; then both are `float32x2`. a mesh without UV1 draws UV0 in its place.

zstd uses `zstddec`'s wasm build ([`package/zstd.ts`](../packages/viewer/src/package/zstd.ts)),
which is an order of magnitude faster than a JS decoder on texture blobs. each realm instantiates
its own module, so workers and the main thread (core tables) each await `zstdReady`. `zstddec`
reports no errors, so `decompressZstd` checks the decoded length and throws on a short frame.

## URL parameters

| parameter | meaning                                                                                                                                                                                                                    |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package` | a dev package name (served from `/packages/<name>/`), or a URL/path of a package directory if it starts with `/`, `./`, `../`, `http:/` or `https:/` ([`ui/package-param.ts`](../packages/viewer/src/ui/package-param.ts)) |
| `level`   | the level id to show first. if it isn't in the package or has no instances, the first level with instances is shown                                                                                                        |

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
surface page, a leaf's terrain splat page, HLOD refs (with a tier), detail refs and conditional
refs. each node at or below the cell level records its cell id, for level focus.

### instance selection

[`streaming/selection.ts`](../packages/viewer/src/streaming/selection.ts) uses 3D Tiles-style
REPLACE refinement on screen-space error, `geometricError · pixelFactor / distance`:

- a node draws its HLOD while SSE ≤ `maxSse` (default 12 px), otherwise its children; a node with no
  shown HLOD always refines. with `detail` on, a leaf refines into its detail blocks, even when it
  has none: some clusters stand for scenery filed under neighbouring leaves or as global scenery,
  which draws anyway, so keeping the cluster would overlay it.
- until everything a refinement needs is resident, the node keeps drawing its own HLOD, so streaming
  never opens holes. disabled HLOD tiers are refined past.
- conditional content has no HLOD stand-in, so it follows its own rule: drawn, while `detail` is on,
  while its tile spans more than `maxSse` pixels.
- manifest `global` refs are pinned and drawn whenever they're resident, never requested.
- every ref is drawn only while its visibility group shows. the viewer evaluates `groupsShown` (see
  [package-format.md](package-format.md#visibility-groups)) whenever the level, a scene value or the
  stream areas at the camera change, and hands the same array to the selector, the water and the
  local lights, which is how one level is shown alone over the shared terrain and how scene states
  switch content.

### terrain selection

terrain is CDLOD. each level's distance range comes from its sample spacing and `terrainPixels`
(default 3 px per sample). a node subdivides while the next finer range reaches it; a quadrant whose
child page isn't resident is drawn from the parent page while the child is requested, and vertices
morph to the coarser grid over the last 30% of a level's range (the coarsest level never morphs).
every selected page quadrant is an instance of one shared grid, so terrain is a single draw
([`render/terrain-renderer.ts`](../packages/viewer/src/render/terrain-renderer.ts)).

each visited node also wants its surface page at the same priority. a patch is shaded from the
finest resident surface page at or above its node, magnified when it's an ancestor's, so the ground
keeps its colours while finer pages stream. the shader draws the pages as stored: albedo, normal,
roughness and occlusion ([world.md](game-data/world.md#terrain)). patches with no resident page, or
with `terrainSurface` off or no BC textures, fall back to stand-in colours by slope.

leaves within `DETAIL_DISTANCE` (160 m) also want their splat page. once it and all of the package's
layer textures (pinned at load) are resident, the shader blends the leaf's close-up layers as
[world.md](game-data/world.md#close-up-layers) describes, with a smooth triplanar projection in
place of the game's random one, and fades them into the baked page between 96 and 144 m. the layers
sample with explicit gradients so slots and planes without weight are skipped. `terrainSplat` turns
this off. on an Apple M-series GPU at 1600×1000 the blend added about 7 ms of GPU time over open
ground (terrain only), unprofiled.

### per-instance LOD

[`streaming/mesh-selection.ts`](../packages/viewer/src/streaming/mesh-selection.ts) runs on the CPU
over the selected row ranges. per instance it:

1. culls by projected bounding-sphere radius (`minBoxPixels`, default 1.5 px) and by frustum planes;
2. computes Unity's LODGroup metric (object size relative to screen height) and picks every chain
   draw whose `(minSquared, maxSquared]` band contains it. an instance past the chain's smallest
   threshold, or with nothing drawn in its band, is culled, matching the game;
3. if all picked geometries are resident, appends the row to a bucket keyed by (geometry, submesh,
   material, mirrored). otherwise it requests the geometry at a priority of its projected pixel
   height and draws the nearest LOD whose geometry is all resident (coarser first on ties), which is
   usually the one it drew before the switch. that stand-in is kept from eviction but not requested;
   only an instance with no resident LOD draws its box (particle emitters and shadow-only instances
   never do). an instance is mirrored when its transform's determinant is negative, which flips its
   triangles' winding.

meshes cull the faces their material culls (front faces are clockwise, as Unity's are), with front
and back swapped for mirrored buckets. each mesh phase, shadows included, has a pipeline per face
culling and UV format, and draws are sorted by both. the vertex shader dequantizes 16-bit UVs with
per-draw transforms, so the fragment shader sees one kind of UV.

shadow-only draws and materials that aren't drawn are dropped from the chain once, when it's first
used. textures are then requested per bucket, coarse to fine, down to the mip that gives about one
texel per pixel across the largest on-screen use, scaled by the UV tiling, then `textureBias` levels
coarser (0 by default; each level quarters the textures' memory). sky, reflection and water textures
are streamed whole (`streamWholeTexture`).

the output (a visible row list plus per-bucket ranges) has the shape a GPU cull pass would write
next to indirect draw arguments ([open](#open)).

### particles

a chain draw that names a particle system ([package format](package-format.md#particles)) makes its
instance an emitter: the emitter culls and streams its geometry like any instance, but its bucket
takes the rows of its live particles instead of its own
([`render/particles.ts`](../packages/viewer/src/render/particles.ts)). `ParticleField` keeps
`min(maxParticles, 1024)` rows per emitter in the instance buffer, using the emitter's block origin,
and rewrites them once per frame the emitter is selected. so every mesh shader draws particles
unchanged, and shadow and effect passes need nothing of their own. a system whose start colour isn't
white writes it into its rows (`ROW_COLORED` in
[`render/instance-rows.ts`](../packages/viewer/src/render/instance-rows.ts)), where it multiplies
the mesh's vertex colours in the mesh and effect shaders.

each particle follows in closed form from its emission time and random values hashed from the
emitter's place, the system and its index, so any moment can be evaluated on its own:

- emissions are the rate's steady stream (one every `1 / rate` seconds, a random rate taking its
  mean) and each loop's bursts (count rounded, each fired with its probability), within the window
  the longest lifetime reaches back; non-looping systems stop emitting after one duration. the
  newest live ones that fit the rows are kept. with a ring buffer a particle stays until newer ones
  replace it, so the window reaches back far enough for that many emissions; past its lifetime it
  shows its end (or replays its loop range).
- a texture sheet picks each particle's frame from its start frame plus its age (over its lifetime,
  or by frames per second), and its row at random, by mesh index or fixed, or plays the whole grid.
  the tile goes into the row's info word next to its kind (`rowInfo`), and `sheet_uv` in
  `frame.wgsl` remaps the mesh's UVs into it in the mesh and effect vertex stages; other rows carry
  a 1×1 sheet, which leaves UVs alone.
- start values read their curves at the emission's place in its loop. the shape gives the start
  position and direction (cones towards the matching point of their far end, volumes anywhere up to
  their length), placed by the shape's own transform.
- at age `a` a particle has moved `(start speed + linear velocity) · m · a`, where `m` is the
  velocity module's speed modifier and a world-space linear velocity is first turned into the
  emitter's frame, plus `½ g a²` down the world's y (Unity's gravity, 9.81 m/s² times the gravity
  modifier) and the radial push times `m`, then turned about the orbit's centre by `ω · m · a`.
  turning the whole path is exact when the rest of the motion runs along the orbit's axis. the mesh
  is then offset by the system's pivot, scaled by the particle's size and turned with it.
- size is the start size times the size over lifetime at `a / lifetime`; rotation is the start Euler
  angles (Unity's Z, X, Y order) plus the angular velocity times `a`, applied in the emitter's frame
  (Local), the world's (World) or the camera's (View, so the meshes turn with the camera, as the
  game's do).
- a renderer with several meshes is several emitters at one place; they share their random values,
  so each draws the particles that picked its mesh.

the game's random sequence can't be reproduced, so particles start elsewhere than in the game with
the same distributions. looping systems are evaluated as if they had played since long before the
package opened; others start when their emitter is first selected. particles move by the time of the
frame that renders them, so they hold still while the view does, like the effects' scrolling
textures (`continuous` keeps them moving).

### priority

priority is SSE (or projected pixels for geometry and textures). content in the focused level's
cells is boosted 8×. nodes outside the frustum are requested at 0.1× where the traversal still
reaches them: terrain children of a node in view (prefetch around the camera) and instance tiles in
the shadow casters' volume; shadow-only geometry is requested at 0.1× of its pixel height. a
texture's pieces are requested at the bucket's priority divided by one plus the piece's index, so
coarse levels come first. irradiance cells and whole-streamed textures (sky, reflection) use fixed
priorities above all scenery.

### residency and budgets

[`streaming/stream-manager.ts`](../packages/viewer/src/streaming/stream-manager.ts) owns each blob's
lifecycle (`idle → queued → fetching → decoding → uploading → ready`, or `failed`, which isn't
retried).

- **wanting.** the traversal calls `want(blob, priority)` every frame. a resident blob that's wanted
  counts as used, even when a coarser stand-in is drawn, so a refinement in progress isn't evicted
  and refetched.
- **pinning.** the core archive's height pages and instance blocks (coarse terrain, every HLOD
  block, global scenery) are pinned at load, plus, where BC textures are supported, its surface
  pages and the terrain layer textures. pinned blobs come first (core ones are read from memory at
  once), upload first and are never evicted. pinned height pages keep their samples on the CPU for
  ground-height queries (the first pose).
- **fetching.** at most 32 range reads in flight (`maxRequests`): a dense view wants thousands of
  blobs averaging ~60 KiB, so latency, not bandwidth, bounds loading. from the dev server, 32
  instead of 8 brought Wuling's first views from 9–12 s to 3–4 s; 64 gained little more, neither did
  dispatching freed request slots between frames, and coalescing more widely saved less while
  fetching up to 75% more bytes. queued blobs are sorted by priority, and each seed coalesces
  neighbours in the same archive (gaps ≤ 64 KiB, span ≤ 2 MiB, ≤ 96 blobs) into one range read. core
  blobs are read from memory without a request slot. requests whose blobs nobody wanted for more
  than 2 frames are aborted; queued blobs not wanted this frame return to idle.
- **uploading.** pinned first, then by priority, until the frame has uploaded 24 MiB. decoded
  content nobody has wanted for 30 frames is dropped instead. a full pool evicts up to 16 resident,
  unpinned blobs of the same kind that weren't used this frame and have no higher priority, oldest
  first, and retries.
- **budget.** resident bytes of all kinds count against `budgetMiB` (default 768, since the densest
  views, such as Wuling City at street level, want 550–700 MiB). over budget, the least recently
  used unpinned blobs not used this frame are evicted. if the budget is still exceeded by content in
  use, the manager is _saturated_: unpinned fetches and uploads pause (queued blobs return to idle
  and decoded ones are dropped) until something falls out of use, because evicting fresh uploads
  only to refetch them would thrash.
- `version` is bumped on every upload and eviction; the frame loop redraws on a change.

## the render frame

`#render` encodes one command buffer per frame. passes in order:

| #   | pass                                                                 | when                                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `irradiance update 0–2` (compute)                                    | a clipmap level re-centred or got new cells ([`render/irradiance-volume.ts`](../packages/viewer/src/render/irradiance-volume.ts))                                                                                    |
| 2   | `shadow layer 0–3`                                                   | `shadows` on, a package loaded, `debugView` is `lit`, and the casters or a layer's fit changed since the layers were drawn                                                                                           |
| 3   | `volumetric fog` (compute)                                           | `heightFog` on, a package loaded, `lit`, and the environment's volumetric fog on ([`render/volumetric-fog.ts`](../packages/viewer/src/render/volumetric-fog.ts))                                                     |
| 4   | `main`                                                               | always (empty without a package)                                                                                                                                                                                     |
| 5   | `transparent`                                                        | always, so the composite reads cleared targets                                                                                                                                                                       |
| 6   | `transmittance lut`, `multiple scattering lut`                       | once per environment                                                                                                                                                                                                 |
| 7   | `sky view lut`, `sky mean`                                           | `sky` on                                                                                                                                                                                                             |
| 8   | `ao depth`, `gtao`, `gtao blur`                                      | `ao` on, `lit`, and the environment has AO settings                                                                                                                                                                  |
| 9   | `ssr march`, `ssr temporal`, `ssr downsample` ×n, `ssr resolve`      | `reflections` on, `lit`, and the environment has reflection settings; otherwise `ssr off` only clears the output ([`render/screen-space-reflections.ts`](../packages/viewer/src/render/screen-space-reflections.ts)) |
| 10  | `celestial`                                                          | always; writes nothing with `sky` off or nothing beyond the atmosphere                                                                                                                                               |
| 11  | `composite`                                                          | always                                                                                                                                                                                                               |
| 12  | scene copy + `water`                                                 | `water` on, `lit`, and visible water surfaces                                                                                                                                                                        |
| 13  | `light shaft downsample`, `light shaft blur` ×n, `light shaft apply` | `lit`, the environment has light shafts, and the sun is in front of the camera ([`render/light-shafts.ts`](../packages/viewer/src/render/light-shafts.ts))                                                           |
| 14  | `lens flare`                                                         | `lit`, the environment has a flare, and the sun is on screen (or the flare allows it off screen) ([`render/lens-flare.ts`](../packages/viewer/src/render/lens-flare.ts))                                             |
| 15  | `taa`                                                                | always ([`render/temporal-aa.ts`](../packages/viewer/src/render/temporal-aa.ts)); with `antialiasing` off it only scales to the output size                                                                          |
| 16  | `auto exposure histogram` (compute)                                  | `autoExposure` on, `lit`, the profile meters, and a readback buffer is free ([`render/auto-exposure.ts`](../packages/viewer/src/render/auto-exposure.ts))                                                            |
| 17  | `bloom down` ×n, `bloom up` ×n                                       | `bloom` on, `lit`, and a canvas large enough for the mip chain                                                                                                                                                       |
| 18  | `tonemap`                                                            | always, into the swapchain                                                                                                                                                                                           |

passes up to the lens flare run at the render size, the canvas's device-pixel size times
`renderScale` (clamped to [0.25, 1]); `taa` and everything after it run at the output (canvas) size.
what each post pass computes and which profile fields drive it is in
[post-processing.md](game-data/post-processing.md).

- **depth.** reversed-Z `depth32float`, cleared to 0 and tested with `greater`, with an infinite far
  plane and a 0.25 m near plane; logarithmic depth is avoided because writing fragment depth
  disables early-Z and, on tile-based GPUs, hidden-surface removal. where the GPU has the
  `depth32float-stencil8` feature, depth carries a stencil, cleared to 0, which only effect
  [portals](game-data/effects.md#portals) use; post passes sample the depth aspect alone
  ([`gfx/render-targets.ts`](../packages/viewer/src/gfx/render-targets.ts),
  [`scene/camera.ts`](../packages/viewer/src/scene/camera.ts)). everything renders camera-relative:
  instance block origins are rebased to the eye on the CPU in f64 each frame, so f32 precision holds
  at any distance.
- **main pass.** one sample per pixel into radiance and its ambient part (`rgba16float`), plus what
  lit surfaces hand the screen-space reflections: the sky reflection the radiance holds
  (`rgba16float`) and the normal, roughness and hit weight packed in `rg32uint`, which fills
  WebGPU's default 32 bytes per sample; depth is stored for post. draw order: the opaque meshes'
  depth, terrain, meshes (opaque, then alpha-tested, then stencil-only portal masks), instance
  boxes, box outlines (boxes larger than `outlineMetres`), terrain wireframe.
- **transparent pass.** alpha-blended meshes draw after the main pass, testing its depth without
  writing it (the stencil stays writable), into a weighted sum and a revealage that the composite
  resolves ([glass](game-data/materials.md#glass)). a third target, the glow, sums additively
  blended light, which the other two can't hold; the composite adds it after the fog, unfogged, and
  its alpha holds the weight of the layers kept out of the fog
  ([blending](game-data/effects.md#blending)).
- **antialiasing** is temporal with upsampling, as in the game, which has no MSAA. the main pass's
  projection is offset by a Halton (2, 3) subpixel jitter each frame (8 positions per cycle, more
  when upsampling), and the post passes that reconstruct view rays undo it. `taa` reconstructs each
  output pixel from the 3×3 render-size samples around it (a Gaussian fit to Blackman-Harris),
  reprojects the previous output through the depth buffer and the previous camera (the scenery is
  static, so there are no motion vectors), samples it with Catmull-Rom, clips it to the
  neighbourhood's colour box in YCoCg and blends in 10% of the new frame, less where upsampling
  leaves no sample near the pixel. colours are weighted by `1 / (1 + luminance · exposure)` while
  filtering. two output-size histories alternate. a cut (a new package, the first pose, a debug view
  or antialiasing toggle) drops the history. below the output size, material textures sample with a
  mip bias of `log2(renderScale)` (terrain layers by scaling their gradients), and selection, LOD
  and texture streaming measure screen sizes in output pixels, so `renderScale` trades shading cost
  only.
- **shadows.** four depth layers, fitted, filtered and fed with off-screen casters as
  [lighting.md](game-data/lighting.md#shadows) describes
  ([`render/shadow-map.ts`](../packages/viewer/src/render/shadow-map.ts)). each layer's pass reuses
  this frame's main-pass selection and gets its own copy of the frame uniforms with its
  view-projection. off-screen casters land in cast-only buckets, drawn first in each phase so the
  shadow passes draw a prefix and the main pass skips it; only their alpha texture is requested,
  they never draw as boxes, and their tiles never hold back the HLOD refinement of tiles in view.
  each bucket's rows are grouped by the first layer they can cast into (within the layer's radius
  across the light, and up to the caster reach towards the sun), so a layer draws a prefix of each
  bucket: the three sharp cascades skip everything beyond their 80 m, and instances no layer reaches
  don't draw into the shadow map at all. this cut draws by more than half at every profiled pose.
  the depth-only stages (shadow casters, alpha-tested depth) bind only the vertex streams they read:
  positions, plus the UV sets for alpha testing.
- **post** ([`render/post-process.ts`](../packages/viewer/src/render/post-process.ts)) is fullscreen
  triangles with `auto` layouts. composite adds the screen-space reflections
  ([lighting.md](game-data/lighting.md#screen-space-reflections)), then applies AO, sky, atmosphere
  fog and height fog; `heightFog` and `atmosphereFog` change what composite does, not which passes
  run. water draws over a copy of the composited scene so it can refract and reflect it
  ([`render/water-renderer.ts`](../packages/viewer/src/render/water-renderer.ts),
  [game-data/water.md](game-data/water.md)). it's the one post pass with an explicit layout, because
  it also binds the main pass's frame group for the sun shadow, irradiance volume and sky
  reflection; its shader moves the post uniforms to group 3.
- **debug views** (`albedo`, `normals`, `roughness`, `ambient`, and `clouds` for the raw cloud
  panorama) show the main pass as it is: no shadows, local lights, cloud shadows, exposure,
  tonemapping, fog, AO, reflections, bloom, light shafts, lens flare or water. temporal antialiasing
  still applies.

## GPU resource management

- **device** ([`gfx/device.ts`](../packages/viewer/src/gfx/device.ts)): high-performance adapter;
  requests `texture-compression-bc`, `float32-filterable`, `indirect-first-instance`,
  `timestamp-query` and `depth32float-stencil8` when present, and raises the buffer,
  storage-binding, array-layer, storage-buffer and sampled-texture limits to the adapter's maximum
  (the mesh pipeline samples 17 textures per stage, one over the default). without BC support, BC
  textures are reported unstreamable and materials fall back to their untextured look.
- **range allocator** ([`gfx/range-allocator.ts`](../packages/viewer/src/gfx/range-allocator.ts)):
  first-fit over units, with frees coalescing neighbours so streaming in and out doesn't fragment
  the space without bound. it sub-allocates the instance-row mega storage buffer (one range per
  block), the irradiance cell buffer and the terrain height page pool (one unit per page), all
  [`GrowableBuffer`s](../packages/viewer/src/gfx/growable-buffer.ts): they start at 10, 32 and 8 MiB
  and, when a range doesn't fit, copy themselves into a buffer twice the size, up to 1.5M rows (114
  MiB), 192 MiB and 4096 pages (33 MiB). a level's view holds 2–5 MiB of rows, 20–40 MiB of cells
  and 4–7 MiB of heights, so they grow only as content from several views piles up under a large
  budget; they never shrink, since the budget bounds them. owners rebuild their bind groups when the
  buffer's `version` changes. surface pages use a pair of BC3 texture arrays, one layer per page
  (1024 layers, or the device's array-layer limit if lower; 34 MiB); splat pages use 256 slots of an
  RGBA8 control array, a BC3 tint array and an index buffer (22 MiB); the package's layer textures
  get two BC7 arrays sized at load. the surface and splat arrays are allocated at full size up
  front, since a texture array can't grow without copying every layer. geometry gets one vertex and
  one index buffer per blob.
- **uniform ring** ([`gfx/uniform-ring.ts`](../packages/viewer/src/gfx/uniform-ring.ts)): one
  uniform buffer in 3 per-frame regions, sub-allocated at `minUniformBufferOffsetAlignment`. callers
  fill CPU views; `flush` uploads the frame's region in one `writeBuffer`, and draws bind group 0 at
  a dynamic offset. a frame needs the main block plus one per shadow layer.
- **bind layouts** ([`gfx/bind-layouts.ts`](../packages/viewer/src/gfx/bind-layouts.ts)): group 0 is
  the frame (uniforms, shadow map, reflection cubemap, irradiance clipmaps, shadow ramp, local
  lights and their bins, cloud shadow) for every family and the volumetric fog, so a pass binds it
  once; group 1 is per family; meshes add group 2 (per-draw parameters) and group 3 (material
  textures). shadow passes bind a placeholder in place of the shadow map they render into.
- **pipeline cache** ([`gfx/pipeline-cache.ts`](../packages/viewer/src/gfx/pipeline-cache.ts)):
  modules by label, pipelines by a state key such as `mesh/opaque/x4`, compiled with
  `createRenderPipelineAsync`. renderers `prepare` the pipelines they use at construction, so
  streaming compiles nothing; only the stencil variants of effect pipelines compile on first use. a
  draw whose pipeline isn't ready yet is skipped, and the frame loop renders again once it is.
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
  or scene value changed (`#dirty`), the stream's `version` changed, a pipeline finished compiling,
  the auto exposure is still moving (or waiting on its first histogram), or `continuous` is on.
  after any of those it renders 32 more frames of the same view (`SETTLE_FRAMES`, reusing the last
  selection) so the temporal antialiasing converges, unless `antialiasing` is off. drifting fog
  ([flow noise](game-data/sky-and-fog.md#flow-noise)) also renders every frame, reusing the last
  selection, while `flowNoisePlaying` is on and the environment has it; turning that off freezes its
  time. it traverses without rendering while streaming is in progress (`!stream.idle`), and does
  nothing at all when the view is still and streaming is idle. the environment re-blends only when
  the eye, its settings or a fade changed.
- **stats** publish every 250 ms and notify subscribers only when the JSON differs, so the React
  panels don't re-render on a still view.
- **one traversal, many passes.** selection runs once per frame; shadow layers reuse its buckets.
  frames that reuse the last selection (settling the antialiasing, drifting fog) keep the shadow
  layers from the frame that drew them, unless a layer's fit moved or pipelines were still
  compiling.
- **few draws.** terrain is one draw; each mesh bucket is one instanced `drawIndexed` over its slice
  of the visible list. depth-writing draws are sorted by pipeline, then nearest first, which early
  depth testing rewards; the rest by pipeline, geometry and material, so runs share bindings
  ([`render/mesh-renderer.ts`](../packages/viewer/src/render/mesh-renderer.ts)).
- **each pixel shades once.** a depth prepass draws the opaque meshes' positions alone (no fragment
  work) before anything else; the terrain then skips what they cover, and the opaque meshes shade
  with `depthCompare: 'equal'`. the prepass and the shading compute positions through the same
  `@invariant` function, so their depths match exactly. on an RDNA 2 GPU at 2560×1600 this saved
  1.1–1.6 ms of 7–11 ms at dense views and cost about 0.1 ms where little overlaps.
- **early depth survives alpha testing.** a shader that may discard loses early depth and, on
  tile-based GPUs, hidden-surface removal. opaque meshes use non-discarding pipelines, and shadow
  pipelines for them have no fragment stage. alpha-tested meshes lay down cut-out depth first, then
  shade with `depthCompare: 'equal'` and a non-discarding shader, so overlapping leaf cards shade
  each pixel once. an alpha-tested material draws as opaque until the texture holding its alpha
  ([alpha testing](game-data/materials.md#alpha-testing)) has streamed, since there's no alpha to
  test yet.
- **no MSAA.** at 2560×1600 on an Apple M-series GPU, a dense Wuling City view took ~46 ms of GPU
  time with 4× MSAA and ~16 ms with temporal antialiasing (the `taa` pass is under 1 ms), and the
  render targets shrank from ~440 to ~200 MiB. `renderScale` 0.5 brought the same view to ~5 ms.
- **AO at half resolution.** `ao depth` reduces the depth once into half-resolution view depth; GTAO
  marches that (keeping its scattered reads in cache) and the blur upsamples with depth weights.
- **cached work.** the transmittance and multiple-scattering LUTs render once per environment;
  irradiance clipmaps update only on re-centre or new cells.
- **no per-frame allocation on hot paths.** selections, buckets and plane arrays are reused across
  frames.

## open

- per-instance culling and LOD selection run on the CPU and dominate CPU time at dense views; a
  compute cull pass writing the visible list plus indirect arguments would replace them.
- shadow layers are kept only across frames that reuse the last selection; any new selection redraws
  every layer's casters, even a layer whose snapped fit didn't move. the terrain still draws whole
  into every layer. off-screen casters added about 14k rows and roughly 2–3 ms of CPU time at a
  street-level Wuling City view (unprofiled beyond that).
- the temporal antialiasing has no sharpening, and nothing handles moving surfaces beyond the
  neighbourhood clip: water waves and the GTAO noise pattern rely on it. with temporal smoothing in
  place, the terrain's close-up layers could sample one projection plane per pixel at random, as the
  game does, instead of blending all three.
- composite writes a separate `hdr scene` target: the main pass's radiance target can't hold it,
  because the next frame's screen-space reflections read it after the main pass rewrites radiance.
  the celestial pass already reuses the sky reflection target, which the reflections are done with.
- the AO blur's loads per pixel could be cut by packing depth with AO or using `textureGather`.
- terrain's GPU cost at high resolution is unexamined.
- the profiler times every pass whenever `timestamp-query` exists; gate it on the stats panel if it
  shows up in measurements.
- terrain surface pages swap with their level, without cross-fade. the close-up blend's cost is
  unprofiled; sampling one projection plane per pixel, as the game does, or fewer anisotropy taps
  are the obvious cuts, and layer tiling repeats visibly in open grass.
