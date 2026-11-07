# streaming and selection

each frame that does work runs one traversal (`Traversal.run` in
[`viewer/traversal.ts`](../../packages/viewer/src/viewer/traversal.ts)):

1. `Selector.run` walks the tile tree for terrain patches and instance row ranges, and the selected
   blocks' spinning rows are turned ([per-instance LOD](#per-instance-lod)).
2. `MeshSelector.run` culls and LOD-selects instances in those ranges and buckets them for drawing.
3. sky textures, water surfaces and irradiance cells are requested.
4. `StreamManager.update` cancels, dispatches, uploads and evicts; `TextureStore.commit` applies
   texture shrinks.
5. if the frame renders, the renderers write their per-frame buffers (`prepare`).

## tile tree

[`scene/tile-tree.ts`](../../packages/viewer/src/scene/tile-tree.ts) links the package's quadtree
nodes to their children and splits each node's content refs by kind: one terrain height page, one
terrain surface page, a leaf's terrain splat page, HLOD refs (with a tier), detail refs and
conditional refs. each node at or below the cell level records its cell id, for the current level's
[priority](#priority).

## levels

every level of a package shows at once; a visibility group's level only says who owns the content.
the viewer keeps one current level
([`viewer/viewer.ts`](../../packages/viewer/src/viewer/viewer.ts),
[`scene/level-pose.ts`](../../packages/viewer/src/scene/level-pose.ts)): the `level` URL parameter
at load, the level picked in the levels panel (`flyToLevel`, which also flies over it), and after a
flight lands, the level owning the 128 m cell the camera moves into. the cell a flight lands in
doesn't count, since a level's vantage point can sit over a neighbour's cells, and cells no level
owns keep the last level. the current level gives the
[base environment](environment.md#blending-at-the-camera), streams right after what's near the
camera, and has its controls listed first in the
[scene conditions panel](scene-states.md#the-scene-conditions-panel).

## instance selection

[`streaming/selection.ts`](../../packages/viewer/src/streaming/selection.ts) uses 3D Tiles-style
REPLACE refinement on the game's [HLOD rings](../game-data/world.md#streaming-layers), by the
distance from the camera to the node's bounds (`hlodRing`):

- a node holding HLOD tier 0 refines within `detailDistance` (default 160 m, the game's at its high
  PC preset, 4000), tier 1 within HLOD0's radius (512 m) and tier 2 within HLOD1's (1024 m), each
  widened to `detailDistance` if that's larger. HLOD2 keeps drawing past the game's 2048 m, so an
  overview isn't empty. a node with no shown HLOD always refines, and a leaf with none refines
  within `detailDistance`.
- with `detail` on, a leaf refines into its detail blocks, even when it has none: some clusters
  stand for scenery filed under neighbouring leaves or as global scenery, which draws anyway, so
  keeping the cluster would overlay it.
- the viewer once refined on screen-space error over the packer's placeholder geometric error (1/16
  of a node's edge), which at 1600 px drew detail out to about 460 m, three times the game's area;
  the error now only orders requests ([priority](#priority)).
- until everything a refinement needs is resident, the node keeps drawing its own HLOD, so streaming
  never opens holes. disabled HLOD tiers are refined past.
- conditional content has no HLOD stand-in, so it follows its own rule while `detail` is on. a ref
  with a [reach](../package-format.md#tile-tree) draws while the camera, standing in for the game's
  streaming centre, is inside that rectangle: dynamic structures' blocks reach as far as their game
  grid loads them, so Dijiang's corroded planet and satellites show from its deck, though their
  renderers sit hundreds of metres to kilometres from it. those blocks are listed by reach
  (`TileTree.reached`), tested every frame a reach at a time (about 0.1 ms per traversal on map02's
  1,690 grids). the rest, scene-state content and facilities, draw within `detailDistance` of their
  tile.
- the tree's global refs are pinned and drawn whenever they're resident, never requested. they have
  no tile to refine, so where an HLOD cluster covers global scenery both draw until the cluster's
  tile refines.
- every ref is drawn only while its visibility group shows. the viewer evaluates `groupsShown` (see
  [package-format.md](../package-format.md#visibility-groups)) whenever a scene value or the stream
  areas at the camera change, and hands the same array to the selector, the water, the local lights
  and the irradiance volume, which is how scene states switch content.

## terrain selection

terrain is CDLOD, with the viewer's own LOD rule: the game's per-node `maxHeightError` isn't an
error bound ([terrain](../game-data/world.md#terrain)). each level's distance range comes from its
sample spacing and `terrainPixels` (default 3 px per sample). a node subdivides while the next finer
range reaches it; a quadrant whose child page isn't resident is drawn from the parent page while the
child is requested, and vertices morph to the coarser grid over the last 30% of a level's range (the
coarsest level never morphs). every selected page quadrant is an instance of one shared grid, so
terrain is a single draw
([`render/terrain/terrain-renderer.ts`](../../packages/viewer/src/render/terrain/terrain-renderer.ts)).

each visited node also wants its surface page at the same priority. a patch is shaded from the
finest resident surface page at or above its node, magnified when it's an ancestor's, so the ground
keeps its colours while finer pages stream. leaves within `DETAIL_DISTANCE` (160 m) also want their
splat page, which the [close-up layers](terrain.md#close-up-layers) need along with every layer
texture (pinned at load). `terrainSurface` and `terrainSplat` turn the two off; without BC textures
neither loads.

## per-instance LOD

before it runs, the selected blocks' [spinning rows](../package-format.md#instance-block-inst-efin)
are turned to the viewer's clock (`turnRows` in
[instance-rows.ts](../../packages/viewer/src/content/instance-rows.ts)): their transform and bounds
centre are rewritten from the stored ones in the CPU copy, and the runs of rows holding them (runs
bridge gaps of up to 8 still rows) are written to the GPU again. while any selected block has
spinning rows, frames that render traverse again, as with particles, so the shadows follow. every
wheel starts from its stored pose at the clock's zero; the game's phase is its gameplay clock's.

[`streaming/mesh-selection.ts`](../../packages/viewer/src/streaming/mesh-selection.ts) runs on the
CPU over the selected row ranges, with the sphere and shadow layer tests of
[`instance-culling.ts`](../../packages/viewer/src/streaming/instance-culling.ts) and the chain slots
and buckets of [`mesh-buckets.ts`](../../packages/viewer/src/streaming/mesh-buckets.ts). it first
tests each group of 32 consecutive rows of a block
([`row-groups.ts`](../../packages/viewer/src/streaming/row-groups.ts), built on a block's first
selection) against the same rules with the group's bounds: its sphere, its largest row radius and
its farthest LOD reach. a group that fails one has no row that passes it, so it's skipped whole.
rows are in placement order, which keeps a group's rows close together (a median radius of 20 m on
map02); groups holding spinning rows are never skipped. per instance it:

1. culls by projected bounding-sphere radius (`minBoxPixels`, default 1.5 px) and by frustum planes;
2. computes Unity's LODGroup metric (object size relative to screen height, the size being twice the
   largest half-extent of its world bounds; unverified, see
   [chains](../package-format.md#binary-encodings)), or for a `CameraDistance` chain the squared
   distance to its distance origin, and picks every chain draw whose `(minSquared, maxSquared]` band
   contains it. an instance past the chain's smallest threshold, or with nothing drawn in its band,
   is culled, matching the game;
3. if all picked geometries are resident, appends the row to a bucket keyed by (geometry, submesh,
   material, mirrored). otherwise it requests the geometry at a priority of its projected pixel
   height and draws the nearest LOD whose geometry is all resident (coarser first on ties), which is
   usually the one it drew before the switch. that stand-in is kept from eviction but not requested;
   only an instance with no resident LOD draws its box (particle emitters and shadow-only instances
   never do). an instance is mirrored when its transform's determinant is negative, which flips its
   triangles' winding.

### GPU culling

with `gpuCulling` on (the default, where the GPU has `indirect-first-instance`), most rows skip that
per-instance walk: the CPU does the bookkeeping per segment and the GPU tests the rows
([`gpu-cull-work.ts`](../../packages/viewer/src/streaming/gpu-cull-work.ts),
[`render/meshes/instance-culler.ts`](../../packages/viewer/src/render/meshes/instance-culler.ts),
`instance-cull.wgsl`). a segment is the rows of a group in one chain run, with its own bounds, its
rows' smallest and largest LOD size, and their handedness. for each segment of a group that passes
the group tests, the CPU:

1. picks the slots whose bands the segment's rows can reach, from its nearest and farthest row
   centre and its sizes, with the bands widened 2% for the GPU's f32 arithmetic;
2. requests their geometry at the segment's largest priority, capped at the top of each slot's band.
   a LOD with a slot not resident is drawn by the slots of its stand-in in that LOD's band, as on
   the CPU path;
3. makes room in each picked slot's bucket for every row of the segment in view, and in each shadow
   layer the slot can cast into from the first one the segment's sphere reaches.

the segment's largest priority puts its largest row at its nearest row centre, unless its row
centres spread wider than a quarter of their distance; then each row is measured, as the CPU path
does. near the camera that bound reaches the 0.1 m floor and rates every row as covering the screen,
which requested every texture at full detail: at a close indie_race001 view the textures in use grew
from 105 MiB on the CPU path to 973 MiB, filled the 768 MiB budget and left meshes as boxes.
measured and capped, they take 141 MiB.

each picked slot's GPU-culled bucket, one per (geometry, submesh, material, mirrored), holds the
segment's rows in view and its casters out of view alike, in a region of the visible list for its
rows in view and one per shadow layer. a pass of `instance cull` appends each row to the regions it
draws in, with its draw id, and another turns each region's count into indirect arguments (one draw
for the rows in view and one per shadow layer, clamped to the region's room). a shadow layer the
bucket has no room in skips its draw.

segments stay on the CPU path when their chain draws particles, has a `CameraDistance` band or a
slot outside the opaque and alpha-tested queues, when a LOD they reach has no resident stand-in and
the chain draws boxes, and when their group holds spinning rows. picking slots by a segment's range
leaves some buckets empty: at a dense Jingyu view (77k rows drawn) 7.1k draws against 4.6k on the
CPU path, which costs about 0.6 ms more to encode, against 3.4 ms less mesh selection. the in-view
instance and triangle stats of GPU-culled buckets are read back a few frames late.

with `occlusionCulling` on too (the default), rows in view hidden behind what the main pass drew
last frame skip it, while still casting shadows. before culling, `depth pyramid` reduces the depth
buffer, which still holds last frame's depth, into a pyramid of the farthest depth under each texel,
half its size at the first level
([`depth-pyramid.ts`](../../packages/viewer/src/render/meshes/depth-pyramid.ts)). each row's
bounding box goes through last frame's camera; it's hidden when its nearest corner is behind the
farthest depth over the texels it covers, widened a texel for the jitter, at the level where they
span at most three texels each way. a box reaching off last frame's screen or in front of its near
plane is drawn, as is everything on the first frame, after a cut, and when the eye moved over 8 m
since the last frame. a row coming out from behind something draws a frame late. flying over Jingyu
it left 4.4M of 6.3M triangles in view and took the GPU from 9.9 to 9.4 ms.

meshes cull the faces their material culls (front faces are clockwise, as Unity's are), with front
and back swapped for mirrored buckets. each mesh phase, shadows included, has a pipeline per face
culling and UV format, and draws are sorted by both. the vertex shader dequantizes 16-bit UVs with
per-draw transforms, so the fragment shader sees one kind of UV.

materials the game draws nothing visible with are dropped from the chain once, when it's first used
(the rest draw, the ones the viewer can't as [unsupported](materials.md#unsupported-materials)), as
are shadow-only draws whose material casts no shadow; the other shadow-only draws go to cast-only
buckets even for instances in view. textures are then requested per bucket, every piece at once, down
to the mip that gives about one texel per pixel across the largest on-screen use, scaled by the UV
tiling, then `textureBias` levels coarser (0 by default; each level quarters the textures' memory).
sky, reflection and water textures are streamed whole (`streamWholeTexture`; both ways are in
[`texture-requests.ts`](../../packages/viewer/src/streaming/texture-requests.ts)).

the output (a visible row list plus per-bucket ranges) has the shape a GPU cull pass would write
next to indirect draw arguments ([optimization candidates](performance.md#optimization-candidates)).

## priority

priority is SSE (or projected pixels for geometry and textures). tiles within 256 m of the camera
are boosted 64×, and farther tiles in the current level's cells 8×, so what surrounds the camera
loads first, then the rest of the current level, then the other levels. nodes outside the frustum
are requested at 0.1× where the traversal still reaches them: terrain children of a node in view
(prefetch around the camera) and instance tiles in the [off-screen casters'](lighting.md#shadows)
volume, whose instances' geometry is requested at 0.1× of its pixel height. a texture's pieces are
requested in the same frame, at the bucket's priority divided by one plus the piece's index, so
coarse levels come first but a sharp texture takes one round trip rather than one per piece (a
texture's pieces mostly sit side by side in one archive, so they're usually read together). irradiance cells and whole-streamed textures (sky, reflection) use fixed priorities above all
scenery.

## residency and budgets

[`streaming/stream-manager.ts`](../../packages/viewer/src/streaming/stream-manager.ts) owns each
blob's lifecycle (`idle → queued → fetching → fetched → decoding → uploading → ready`, or `failed`,
which isn't retried; a failed read returns the blob to idle twice before it fails, since a dev
server under load now and then answers a range request with no bytes). it doesn't know the kinds of
content: each kind (`heights`, `surface`, `splat`, `layer`, `instances`, `geometry`, `texture`,
`irradiance`) has a handler
([`streaming/residency.ts`](../../packages/viewer/src/streaming/residency.ts)) that uploads its
decoded blobs and frees them, and may build its decode job (instance blocks add their row kinds,
from [`content/row-kinds.ts`](../../packages/viewer/src/content/row-kinds.ts)). `openScene`
([`viewer/scene-loader.ts`](../../packages/viewer/src/viewer/scene-loader.ts)) wires the handlers to
the renderers and stores that own the GPU side; their residency shapes are in
[`streaming/resident.ts`](../../packages/viewer/src/streaming/resident.ts).

- **wanting.** the traversal calls `want(blob, priority)` every frame. a resident blob that's wanted
  counts as used, even when a coarser stand-in is drawn, so a refinement in progress isn't evicted
  and refetched.
- **pinning.** the core archive's height pages and instance blocks (coarse terrain, every HLOD
  block, global scenery) are pinned at load
  ([`streaming/core-blobs.ts`](../../packages/viewer/src/streaming/core-blobs.ts)), plus, where BC
  textures are supported, its surface pages and the terrain layer textures. pinned blobs come first
  (core ones are read from memory at once), upload first and are never evicted. pinned height pages
  keep their samples on the CPU for ground-height queries
  ([`scene/ground.ts`](../../packages/viewer/src/scene/ground.ts)), which place a level's first view
  ([`scene/level-pose.ts`](../../packages/viewer/src/scene/level-pose.ts)).
- **fetching.** at most 32 range reads in flight (`maxRequests`): a dense view wants thousands of
  blobs averaging ~60 KiB, so latency, not bandwidth, bounds loading. measured from the dev server
  on Wuling's first views: 32 takes 3–4 s where 8 took 9–12 s; 64, dispatching freed slots between
  frames, and wider coalescing (up to 75% more bytes fetched) gain little or nothing. queued blobs
  seed reads by priority, and each seed coalesces neighbours in the same archive (gaps ≤ 64 KiB,
  span ≤ 2 MiB, ≤ 96 blobs) into one range read
  ([`streaming/coalesce.ts`](../../packages/viewer/src/streaming/coalesce.ts)). every blob's place
  in byte order is sorted once when the stream opens (about 20 ms for map02's 113k blobs), so a
  dispatch heapifies the queue and walks neighbours instead of sorting it twice, which took 1.5 ms
  at 5k queued blobs and 7 ms at 20k. core blobs are read
  from memory without a request slot. requests whose blobs nobody wanted for more than 2 frames are
  aborted; queued blobs not wanted this frame return to idle. no new reads start while 384 blobs
  (`MAX_UNDECODED`) are fetched or being read and not yet decoding.
- **decoding.** fetched blobs wait in the stream manager, not in the decode pool, and each slot that
  frees on a worker (4 per worker, since a worker's answer waits for a busy main thread) takes the
  most wanted one; blobs nobody has wanted for 30 frames are dropped first. the pool once queued
  every fetched blob in arrival order: flying across map02 it held about 3,000 at once, so what came
  into view waited behind what the camera had left, while the workers sat idle 99% of the time.
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
