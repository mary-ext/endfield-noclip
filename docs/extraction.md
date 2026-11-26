# extraction

`packages/extractor` is a node CLI that reads a local Endfield install and writes packages in the
[package format](package-format.md). for game formats and behavior, see [game-data](game-data/).
per-topic pack stages have dedicated pages:

| page                                                               | covers                                                                |
| ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| [prefabs and interactives](extraction/prefabs-and-interactives.md) | prefab hierarchies, dynamic structures, interactives and poses, clips |
| [environments](extraction/environments.md)                         | phase sections, blend schema, volumes, per-level base environment     |
| [scene controls](extraction/scene-controls.md)                     | turning conditional content into controls and choosing defaults       |

## running it

node and pnpm come from mise (`mise.toml`). node executes TypeScript sources directly with no build
step.

```sh
pnpm extract init --game <install root or Endfield_Data> [--keys-from <dir>...]
pnpm extract pack map02 [--level map02_lv001]
pnpm run dev    # viewer lists packages under out/
pnpm extract --help
```

pass `--help` / `-h` or `help <command> [subcommand]` for full usage without requiring a config or
install. every install-reading command accepts `--config <file>` (default `endfield.local.json`).

| command   | purpose                                                                                    |
| --------- | ------------------------------------------------------------------------------------------ |
| `init`    | writes `endfield.local.json` with `Endfield_Data` path and validated keys                  |
| `pack`    | writes a viewer package for one streaming scene (or repacks existing packages)             |
| `scene`   | browses scenes/dungeons, levels, spatial placements, chunks, placed prefabs, env, controls |
| `inspect` | decodes and summarizes a prefab, material, shader, mesh, texture, or water config          |
| `audit`   | queries packed packages under `out/` without opening the install                           |
| `data`    | searches path catalogs, resolves hashes, and decodes SparkBuffer tables & level data       |
| `vfs`     | lists VFS groups/files and extracts logical files                                          |
| `bundle`  | inspects bundle headers, dumps objects, extracts `.resS` streams, and searches bundles     |

only `init` and `pack` are needed to build packages; the rest are for research and debugging. run
`pnpm extract <command> [subcommand] --help` for full flags, choices, and defaults.

### finding assets and scenery

```sh
pnpm extract data paths 'water.*material' --limit 50 --json
pnpm extract scene find map02 --near -476.6,181.8,734.3 --radius 20 --max-size 50 --no-hlod
pnpm extract scene env map02 --at -1072.4,197.0,-1410.9
pnpm extract inspect prefab main/dcd0a8888ee70d437e1d553e.ab
pnpm extract audit materials map02 --unsupported --group
pnpm extract bundle find --class Shader --group initial --limit 20
```

`scene find` searches all placements across every scene state and stream area, reusing the packer's
placement sources for non-static kinds and annotating [stand-ins](package-format.md#stand-ins) when
`out/<scene>/debug/stand-ins.json` exists:

| kind       | source                                                                                          | visibility from                     |
| ---------- | ----------------------------------------------------------------------------------------------- | ----------------------------------- |
| `static`   | chunk entities ([world](game-data/world.md))                                                    | chunk file's scene state and area   |
| `dynamic`  | ECS entities of [dynamic structures](extraction/prefabs-and-interactives.md#dynamic-structures) | owner's gates, states, and areas    |
| `model`    | DynamicStreaming prefab rows                                                                    | same as `dynamic`                   |
| `effect`   | DynamicStreaming effect prefab rows                                                             | same as `dynamic`                   |
| `facility` | [interactives](extraction/prefabs-and-interactives.md#interactives), incl. unfound models       | facility, door, and bridge controls |
| `cabin`    | built [Dijiang cabins](extraction/scene-controls.md#dijiang-cabins-and-region-walls)            | slot's cabin control                |
| `light`    | chunk local lights ([local lights](game-data/lighting.md#local-lights))                         | chunk file's scene state and area   |
| `water`    | placed water surfaces and gameplay water volumes ([water](game-data/water.md))                  | always                              |
| `env`      | chunk environment volumes ([environment](game-data/environment.md))                             | chunk file's scene states           |

visibility prints as package scene controls under default game state: alternatives joined by `|`,
requirements by `&`, each `control=values` (or `always` when ungated). `static` rows also show their
[streaming layer](game-data/world.md#streaming-layers), and rect/water decals show their material.
summaries and limit notices go to stderr so `--json` emits one JSON array.

## local config and keys

`endfield.local.json` stores `gameData` (the `Endfield_Data` path) and container keys (`keys.vfsKey`
for catalogs and encrypted logical files; `keys.bundle` for the bundle cipher). it matches
gitignored `*.local.json` and is written mode 0600 ([decisions](architecture.md#decisions)). shape
and key lengths are validated on load.

`pack` also reads `Endfield_Data/il2cpp_data/Metadata/global-metadata.dat` and `GameAssembly.dll`
(beside `Endfield_Data`) to derive the [MemoryPack](#memorypack-data) schema at runtime (<1 s, never
saved to disk).

`init` builds keys in three steps:

1. **derive from install**: recover the bundle cipher's S-box, key, and IV from the client, and
   search for `chainXor`.
2. **import missing keys (`--keys-from`)**: read keys not recoverable from the install (VFS key, and
   `chainXor` when not found, as in the current client) from local tool checkouts
   (Endfield-map-extractor for VFS key, AnimeStudio for bundle cipher). without `--keys-from`,
   `init` fails naming the missing key.
3. **validate before saving**: verify `vfsKey` decrypts a `.blc` catalog into a valid layout, and
   the bundle cipher decrypts/decompresses the first data block of several small bundles into a
   valid SerializedFile header. any failure aborts. `init` then reopens the VFS with the final keys
   and mounts the Bundle group.

## container layers

the install is read through three nested layers (formats in
[containers.md](game-data/containers.md)): `formats` decodes bytes, while `extractor` adds file
handles, caching, and cross-file lookups.

- **VFS**: reads verify MD5 by default; verification is skipped for large or high-volume files whose
  own framing already validates them (StringPathHash tables, LZ4-framed chunk payloads).
  `Persistent/index_main.json` and `CompressData.bin` are unused.
- **bundles**: reads headers/directories and decodes only blocks overlapping a requested byte range.
  descrambling is ported from AnimeStudio. the decompressed `manifest.hgmmap` is cached in
  `out/.cache/install/` keyed by its catalog MD5 so repeated CLI runs skip Brotli decompression
  (~430 ms).
- **IL2CPP metadata**: detects the extra `i32` per type-definition row by row size and feeds the
  MemoryPack schema reader.

### asset resolution

world data references assets by 64-bit path hash. StringPathHash tables map hashes to paths (main
table first, then initial); the bundle manifest maps paths to bundles and dependency closures
([lookup tables](game-data/assets.md#lookup-tables)).

because the [path hash function](game-data/assets.md#open) isn't ported, path → hash decodes paths
of matching length in both tables (first lookup indexes by length in <1 s; later lookups take ~1
ms). `data resolve <path|hash>` prints both directions, the holding bundle, and its dependencies.

resolving a hash or PPtr follows
[how a reference reaches an object](game-data/assets.md#how-a-reference-reaches-an-object):

- dependency directories open in batches and CAB locations are cached.
- sub-asset lookup checks the main asset and same-bundle preload pointers, skipping dependency
  preloads. unique lookups require exactly one match; missing containers, class mismatches,
  ambiguous sub-assets, and invalid preload ranges fail and record into the debug index.
- PPtrs into Unity built-in files resolve to the bundled copy of a
  [built-in mesh](game-data/assets.md#built-in-meshes) (Cube and Quad), looked up on first use; any
  other throws `FormatError` with its path id.
- assets reached via a prefab carry a direct bundle/CAB/path-id locator, bypassing path lookup.
  objects deduplicate and cache by `CAB-<hex>:<pathId>`.

### objects

Unity objects decode generically from their SerializedFile's TypeTree, so Hypergryph's custom fields
decode automatically without hardcoded class layouts. integers ≤32-bit and floats map to `number`,
64-bit integers (`m_PathID`) to `bigint`, byte arrays to zero-copy views, and other numeric arrays
to aligned typed arrays. class decoders validate expected field types and throw `FormatError` on
mismatch.

## decoders

decoders validate layouts during reading and throw on mismatch.

### asset classes

- **mesh**: decodes `Mesh` (class 43) vertex channels/streams, index buffer, and submeshes (reading
  `m_StreamData` if present), unpacking packed normals ([mesh](game-data/assets.md#mesh)) and
  exposing skin weights, bone indices, and bind pose counts. fails on unseen packing nibbles,
  partial triangles/quads in submeshes, collision-only meshes (`m_CollisionMeshBaked`), or
  `m_CompressedMesh` vertices.
  - **tangents**: f32 tangents are kept as is. for packed-normal meshes, the packer generates
    MikkTSpace tangents from the UV set used by normal-mapped materials (lowest set if materials
    disagree; [geometry blob](package-format.md#geometry-blob-mesh-efgm)). disagreements are counted
    in the report and listed in `debug/assets.json` (`tangentUvs`).
  - **sway & vertex offset**: meshes drawn with swaying materials use the strongest sway (weights in
    position W, grown bounds); meshes with texture vertex offsets use the farthest offset
    ([geometry blob](package-format.md#geometry-blob-mesh-efgm)).
  - **VAT baking**: meshes drawn with a
    [vertex animation texture](game-data/materials.md#vertex-animation-textures) bake into skeletal
    meshes. conversion creates a bone per rigid piece (distinct UV1 + pivot) or soft point (distinct
    UV1 + rest position), or copies bone-animation matrices using UV2/UV3 bones and weights (bone 0
    holds static vertices). soft-body moving vertices get `+y` normals and `-x` tangents turned by
    their bones. sampling at each baked frame's midpoint makes negative speeds play backwards.
    meshes whose draws disagree on the animation, or that a renderer poses/animates, stay static
    with the reason in `debug/assets.json` (`unanimated`).
- **skin pose**: bakes linear blend skinning (bone matrix × bind pose per bone) into a static mesh.
  throws on missing influences, bad bone indices, or singular transforms. skinned prefab renderers
  use this for their authored pose unless a
  [looping clip](extraction/prefabs-and-interactives.md#looping-clips) animates their bones.
- **texture**: decodes `Texture2D`, `Cubemap`, `Texture2DArray`, `CubemapArray`, and `Texture3D`
  into level-major mip order, passing BC blocks unchanged. sRGB-ness comes from the texture, never
  the material slot. alpha-only textures (`TextureFormat` Alpha8, `GraphicsFormat` 54) store as
  `r8unorm` (shaders read red). formats without a WebGPU equivalent fail conversion and appear in
  the report and `assets.json`.
- **material and shader**: copies serialized `Material` state (shader PPtr, keywords, custom queue,
  tags, texture slots with scale/offset and HGRP `m_UVSetIndex`, floats, colours;
  [material and shader](game-data/assets.md#material-and-shader)). the packer overrides
  `m_UVSetIndex` with Lit shader UV-set floats where declared
  ([lit layers](game-data/materials.md#lit-layers)).
  - unresolvable texture PPtrs leave the slot empty, count as a `texture slot` failure, and appear
    in the material's debug row.
  - classification derives shader family (from shader name), blend kind, queue, alpha-test
    threshold, cull mode, and Lit normal/MRO layout, refining Unity's queue boundaries (≥2450 alpha
    test, ≥3000 transparent) using HGRP properties. it reads only properties declared by the shader
    (falling back to shader defaults), ignoring leftover properties from previous shaders (e.g.
    map02 Lit materials retaining LitTransparent's `_SurfaceType` and blend factors).
  - per-shader describers map classified materials to package
    [surfaces](package-format.md#materials).
- **transform**: builds column-major TRS matrices using the game's Unity Euler order
  ([transform](game-data/assets.md#transform)).
- **lens flare data**: reads `LensFlareDataSRP` (which has no TypeTree;
  [lens flare](game-data/post-processing.md#lens-flare)) in SRP core 12 field order with 4-byte
  padded bools. curves store as keys; gradients store as colour and alpha keys.

### world

- **LevelConfig** ([LevelConfig](game-data/world.md#levelconfig)): verifies member counts (18 root,
  3 `defaultState`) and exact EOF.
- **MapConfig** ([MapConfig](game-data/world.md#mapconfig-and-the-ownership-grid)): scene-state
  conditions are covered in
  [MapConfig scene states](extraction/scene-controls.md#mapconfig-scene-states).
- **InitChunkData and StreamingChunkData**
  ([static scenery](game-data/world.md#static-scenery-initchunkdata-and-streamingchunkdata)):
  `InitChunkData` accepts only versions 47 and 49
  ([layout](game-data/world.md#initchunkdata-layout)) and throws on stride/count mismatches.
- **terrain** ([terrain](game-data/terrain.md)): validates that the mip chain fills the payload
  exactly.

**level partition**: cross-checks MapConfig `levelIds`, LevelConfig `levelGrids`, and entity-id
level tags ([the level partition](game-data/world.md#the-level-partition)), reporting disagreements
in `scene levels <map>`. `scene levels <map> --verify` checks tags by pivot majority vote (excluding
backdrop cells so skyline props don't outvote small levels). because ownership follows tag, not
position:

- `--level` filters by tag (clipping by cells or rects cuts real scenery)
- unowned cells are kept under their tag's level
- MapRegionTable polygons are UI overlays only, never clip volumes

### water

decoders for [water data](game-data/water.md):

- **surfaces**: component layout ported from An1X3R/Endfield-map-extractor (MIT). rejects zero
  masks, non-finite values, or missing bindings; deduplicates by id (first copy in filename order),
  unions chunk scene states, and resolves meshes uniquely.
- **configs**: keeps top-level numeric fields under serialized camelCase names, flags as 0/1, and
  Unity math structs as arrays. configs bind by asset key, never `materialIndex`
  ([surface `WaterConfig`](game-data/water.md#surface-waterconfig)). global water configs keep
  sectors with `sectorDataExists`, parse `(x, z)` from the path (`…/Sector/T_<x>_<z>.asset`) rather
  than array index, and convert signed `sectorDataAssetHashes` to unsigned 64-bit keys.
- **volumes**: decoded from LevelData via the [MemoryPack schema](#memorypack-data), along with
  floaters (interactives with component 39). skips files the schema can't decode (only Dijiang's,
  whose spaceship data contains an unwrapped tuple).
- **scripted fills**: extracts constant target fills (and the fill speed set immediately before a
  smooth move) from level scripts decoded for
  [script groups](extraction/scene-controls.md#script-groups). runtime-computed actions are skipped
  and counted (`waterScriptActionsComputed`). `WaterVolumeSetAmount` is treated as moving at the
  volume's speed (assumption: move vs snap is unverified).

`scene find <scene> --kind water` lists placements and volumes, `inspect water-config <ref>` dumps
configs, and `audit water <scene>` summarizes packed counts and errors. package layout is in
[water](package-format.md#water).

### irradiance

parses the [irradiance volume](game-data/irradiance.md) and Dijiang's
[room bakes](game-data/irradiance.md#region-bakes) (compressed cells use one inverted-LZ4 block):

- accepts only index magics `0x03000004` and `0x03000003` (rejecting gacha/legacy indices) and skips
  the spatial hash header and pair table
- verifies records tile each payload contiguously from 0 and every payload has records (the packer
  also checks payload EOF)
- reads payload index from directory word 7, never filename order
- normalizes cell keys to the 8192 m layout (`0x03000004`, world 0 at 128)

package storage is in [irradiance cells](package-format.md#irradiance-cells).

### MemoryPack data

decodes [level scripts](game-data/scene-states.md#level-scripts), interactive templates, and
LevelData using the runtime schema from IL2CPP metadata and `GameAssembly.dll`
([MemoryPack](game-data/containers.md#memorypack)). every level script, interactive template, and
LevelData interactive list in the client decodes cleanly.

## pack

one package holds one streaming scene
([scenes, maps and levels](game-data/world.md#scenes-maps-and-levels)). `scene list` lists all
scenes. `scene list --dungeons` lists DungeonTable entries with their level, streamed scene (`=` if
own), operator, and referencing missions (unlisted entries come from menus, NPCs, or are unused).
`--level` accepts only levels of the scene's own map, so cross-map levels like `dung02_rdg012` on
`dung02_rdg008` cannot be selected ([status](status.md#scene-states-and-controls)).

`pack <scene>` writes to `out/<scene>` or `out/<scene>-<level>` (override with `-o <dir>`). the
target directory must be absent, empty, or contain a previous package (plus at most `.DS_Store`), or
`pack` aborts. output is staged in a hidden sibling and atomically renamed on success
([layout](package-format.md#layout)).

- `--level <id>`: keeps content owned by that level plus terrain under its cells (recorded in
  manifest).
- `--bounds`: keeps content whose centre lies inside an x/z world rectangle (recorded in manifest).
- `--no-assets`: skips mesh, material, and texture conversion (leaves table entries pending) for
  fast iteration.
- `--existing`: repacks every package already under `out/` (or `-o <outDir>`), preserving each
  package's `scene`, `--level`, and `--bounds` from its manifest in one install session.

### phases

phases run in order and are timed individually in the report:

| phase                  | work                                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| setup                  | validate/stage output dir, open cache, index scene (level partition, terrain, tile grid, subset, scene states, chunk files)                                |
| entities               | read chunk files (with read-ahead), dynamic structures + level scripts, interactive facilities, cabins, and prefabs; intern draw chains and file instances |
| terrain                | encode/store terrain height, surface, splat pages, and layer textures (or recall from cache)                                                               |
| environments and water | plan per-level environment profiles, volumes, and water surfaces/sectors concurrently                                                                      |
| irradiance             | assign visibility groups and controls to volumes/water/lights; store base and scene-state irradiance cells (cached) and Dijiang room bakes (uncached)      |
| instances              | encode/store instance blocks and attach detail/HLOD blocks to the tile tree                                                                                |
| materials              | decode materials and build shader/material tables (replaced with one `assets` phase listing pending entries under `--no-assets`)                           |
| geometry               | convert meshes                                                                                                                                             |
| textures               | convert textures                                                                                                                                           |
| states                 | build manifest levels and scene controls                                                                                                                   |
| write                  | build tile tree and tables; write archives, hard-linking unchanged archives from the previous package ([reuse](package-format.md#layout))                  |
| debug                  | write `debug/`; rename staged package into place                                                                                                           |
| cache sweep            | record package root and delete unreferenced cache entries                                                                                                  |

### determinism and stable chain ids

- **determinism**: content sources run in a fixed order because geometry/material ids follow first
  reference, synthetic entity ids follow call order, and chunk entities win over dynamic duplicates
  by running first. parallel steps commit results in id order so cold, warm, and uncached packs
  produce byte-identical archives.
- **stable chain ids**: repacking into an existing directory preserves chain ids using content-key
  hashes recorded in `debug/chains.json` (keyed by asset identities, not shifting table ids).
  surviving keys keep their ids; new keys fill freed slots then append, both in key order; unused
  slots hold empty chains. unchanged shard archives therefore keep identical hashes and are reused.
  fresh directories start in key order.

### how the packer files instances

chunk files are read in fixed order: always-loaded before scene-state files, default area before
stream areas, then by name. an entity first seen in an always-loaded default-area file stays
unconditional; otherwise it loads whenever any file holding it has both its scene state and stream
area active. DynamicStreaming entities' area lists ([stream areas](game-data/world.md#stream-areas))
gate them the same way. entities without a renderer, matrix, or bounds are tallied in
`debug/skipped-entities.json` (lights and water surfaces are packed separately); rect decals draw
the shared decal cube ([rect decals](package-format.md#materials)).

every row belongs to one visibility group (level tag + loading condition;
[visibility groups](package-format.md#visibility-groups)):

| destination | contents                                                                                                                                                 | storage                             |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| HLOD        | scene-state-0 HLOD clusters (named as cluster, with linked children), gated by stream areas; attached to their named cell's tile at `hlodLevels[t]`      | one block per group, in `core.czar` |
| global      | other `Global` chunk entities (including childless clusters), with their files' condition                                                                | one block per group, in `core.czar` |
| detail      | other scene-state-0 entities, gated by stream areas, filed under the 64 m leaf containing their bounds centre; same-area HLOD clusters stand in for them | one block per `(leaf, group)`       |
| conditional | scene-state cell entities, dynamic structures, and facilities with a visibility expression; dynamic rows keep their loading `fb_main` grid               | one block per `(leaf, group, grid)` |

- **load grids**: dynamic model/effect rows keep their own grid; ECS entities take the coarsest grid
  among resource groups naming their component group
  ([dynamic load grids](game-data/world.md#dynamic-load-grids)). facilities and Dijiang cabins have
  no grid.
- **LOD and HLOD** ([LOD and HLOD](game-data/world.md#lod-and-hlod)):
  - per-entity LOD chains and thresholds are preserved whole (foliage cards are ordinary chain
    draws).
  - HLOD clusters require both a cluster name and linked children; childless clusters pack as global
    scenery (e.g. `indie_dg005` city backdrop). HLOD links aren't packed—the viewer swaps clusters
    and detail by tile ([instance selection](viewer/streaming.md#instance-selection)). HLOD clusters
    are excluded from a level's instance count.
  - setup fits the scene's HLOD grid to Global chunk cluster names (reported with match counts).
    ambiguous cluster names (clamped coords or straddling cells) assign to the tile containing the
    most of their detail instances ([tile tree](package-format.md#tile-tree)).
- **[foliage grids](game-data/world.md#foliage-grids)**: each grass/tree instance is an ordinary row
  carrying its cluster's bounds so the cluster culls and LODs as a unit.

for prefabs, dynamic structures, and interactives, see
[prefabs and interactives](extraction/prefabs-and-interactives.md).

### asset conversion and workers

materials convert first on the main thread (bounded concurrency) because materials determine
required mesh tangents and used textures. meshes and textures then convert on worker threads:

- each worker opens the install itself, writes blobs directly to the blob store, and returns small
  metadata. the bundle manifest is decompressed once into shared memory for all workers.
- workers spawn lazily (a fully cached pack starts none) and hold at most two jobs in flight to
  bound decoded texture memory.
- texture objects with identical content merge into one table entry after conversion (counted in the
  report).
- an asset reached both by path hash (static entities) and by object (prefabs) is interned under
  both keys and converts twice.

**flags and tuning**:

- `--jobs`: defaults to `cores - 1`, capped at 8. each worker holds ~150–200 MB of catalogs and
  block caches before in-flight assets; a cold `map02` pack peaks at several GB RSS.
- `--zstd-level` (default 19): geometry, instance blocks, terrain height/splat pages.
- `--texture-zstd-level` (default 9): textures, terrain surface pages, layer textures (main lever on
  cold pack time with minimal size/decode impact).
- irradiance cells and core JSON tables always use level 9. blobs omit zstd framing when compression
  doesn't pay ([codec](package-format.md#containers-and-blobs)).

### pack cache

enabled by default at `out/.cache` (`--cache <dir>` to relocate, `--no-cache` to disable):

- `blobs/`: shared blob store streamed into archives (without cache, lives in staging `.spool` and
  is deleted after pack).
- `cache.sqlite`: SQLite database (WAL mode) holding cached intermediate results for mesh/texture
  conversions, material loads, prefabs, dynamic structures/scripts/interactives/water volumes,
  static chunks/HLOD/environments, terrain/irradiance steps, and zstd-compressed blocks, plus the
  `roots` table listing each package dir's referenced blobs and memos. entries are fingerprinted by
  their code import graph, options, and touched bundle/catalog MD5s (geometry and texture converters
  are fingerprinted separately, and material description stays outside the conversion worker's
  import graph so material edits don't invalidate cached geometry/textures). failed asset
  conversions/loads are cached too. turning loaded materials into table entries and script driver
  linking are not cached. after packing, roots missing `core.czar` are dropped and unreferenced
  memos and blobs are swept. deleting a package dir frees its cache on next pack; deleting the whole
  cache is always safe.
- `lock`: holds packer PID to serialize cache access (stale locks from dead processes are taken
  over).

### report and debug outputs

`pack` prints a summary (sizes, phase timings, entity/instance counts, asset readiness, conversion
failures by reason, per-level environments, water, cache hits, peak RSS); `--json` emits the full
report. each package also writes a `debug/` directory ignored by the viewer:

| file                            | contents                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assets.json`                   | per geometry/material id: path hash, path, locator, failure reason; per material: shader, unsupported/invisible reason, undrawn keywords, broken texture slots ([unsupported materials](viewer/materials.md#unsupported-materials)); per texture: table id, name, failure reason, unsupported sampler settings (mirror-once drawn as mirror-repeat) |
| `instances.jsonl`               | one line per instance block: blob hash and per-row entity id, name, and chunk-file index (−1 for dynamic structures and prefab renderers, which use synthetic ids)                                                                                                                                                                                  |
| `chains.json`                   | chain key per chain id (empty for free slots), preserved across repacks ([determinism and stable chain ids](#determinism-and-stable-chain-ids))                                                                                                                                                                                                     |
| `chunk-files.json`              | chunk files read, indexed by `instances.jsonl`                                                                                                                                                                                                                                                                                                      |
| `environments.json`             | `levels` (base environment and per-section sources) and `problems` (dropped/phaseless volumes, unresolved phase refs, missing resources)                                                                                                                                                                                                            |
| `water.json`                    | packed vs present surfaces and sectors, sectors naming no tile, failed asset loads                                                                                                                                                                                                                                                                  |
| `terrain.json`                  | tiles missing surface pages, leaves missing splat pages, channel pages without height pages, failed layer textures (omitted without terrain)                                                                                                                                                                                                        |
| `unsupported-interactives.json` | skipped LevelData files and unresolved templates/models                                                                                                                                                                                                                                                                                             |
| `unsupported-prefabs.json`      | prefabs that failed instantiation, with reasons                                                                                                                                                                                                                                                                                                     |
| `stand-ins.json`                | [stand-ins](package-format.md#stand-ins): owner, name, reason, and centre position for placed cubes (prefab renderers listed once per prefab)                                                                                                                                                                                                       |
| `skipped-entities.json`         | chunk and DynamicStreaming entities producing no instance row, grouped by reason and [component set](game-data/world.md#initchunkdata-layout) with count and sample names                                                                                                                                                                           |

when something is missing in the viewer, trace it with `instances.jsonl` (block → entity/chunk) and
`assets.json` (why an asset didn't convert). extractor gaps are listed in
[status.md](status.md#packaging).
