# world: maps, levels, streaming and terrain

how Endfield lays out its worlds and how the extractor reads them: streaming scenes and their
coordinate frames, levels as exact sets of 128 m cells, entity level tags, the static and dynamic
streaming files, stream areas, terrain tiles, and the game's LOD/HLOD data with the way the packer
turns it into per-level blocks. which scenery a scene state, quest or variable switches on is
covered in [scene-states.md](scene-states.md); the package layout these blocks land in is in
[../package-format.md](../package-format.md).

## worlds and levels

a **world** is a streaming scene (`Data/Streaming/PC/<scene>/`): `map01` (Valley IV), `map02`
(Wuling), `base01_lv001` (Dijiang), `indie_dg007`, and about a hundred more. each world has one
Unity coordinate frame. LevelConfig rects, entity matrices, terrain tiles and MapRegion shapes are
all in that frame, and nothing is relocated per level. `world maps` lists the scenes the client
ships; a scene being listed says nothing about whether it packs or renders.

a **level** (`map02_lv001`, …) is an area inside a world, not a separate scene. open-world levels
share their map's streaming scene and are `isSeamless`. many dungeon levels reuse an open-world
map's art scene too, so they need no separate handling; interiors, arenas and Dijiang are separate
worlds with their own frames (some interiors sit at world-like coordinates but still stream from
their own scene).

### LevelConfig

`Data/Json/LevelConfig/<level>.json` is a binary MemoryPack-style payload with strings pooled in
`Data/Json/StringPool/StringPool<n>.byte`, despite its extension. the decoder checks the member
counts (18 at the root, 3 in `defaultState`) and that the payload ends exactly at EOF, so any layout
change fails loudly. fields the project uses:

| field                                             | meaning                                                                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `id`, `idNum`                                     | string id and the numeric id MapConfig's grid stores                                                                 |
| `mapId`                                           | the streaming world, e.g. `map02`                                                                                    |
| `defaultState.exportedSceneConfigPath`            | streaming scene asset, e.g. `map02/map02_streaming.asset`                                                            |
| `defaultState.sourceSceneName`                    | the level's art sub-scene, e.g. `map02_lv001_art`                                                                    |
| `levelGrids`                                      | the 128 m cells the level owns                                                                                       |
| `levelDataPathHashes`                             | StringPathHash keys of the level's LevelData files (interactives, see [assets.md](assets.md#interactive-facilities)) |
| `rectLeftBottom`, `rectRightTop`, `playerInitPos` | level rect and spawn point, used for the viewer's level list                                                         |

code: [level-config.ts](../../packages/formats/src/endfield/level-config.ts)

### MapConfig and the ownership grid

`Data/Json/MapConfig/<map>.json` is plain JSON (UTF-8 with BOM). `levelIds` is a row-major
`sideGridNum × sideGridNum` grid of LevelConfig `idNum`s centred on the origin, 0 meaning no level.
cell `(x, z) = (floor(worldX / 128), floor(worldZ / 128))` is at index `(z + N/2)·N + (x + N/2)`.
map02's grid is 32² (4096 m), map01's 16² (2048 m). MapConfig also carries `sceneStates` and
`sceneStateConditions`, which [scene-states.md](scene-states.md) covers.

code: [map-config.ts](../../packages/formats/src/endfield/map-config.ts)

### the level partition

three sources describe level membership, and `buildLevelPartition` cross-checks them:

1. MapConfig `levelIds`: which level owns each cell
2. LevelConfig `levelGrids`: the same cells, listed per level
3. the entity id's top 5 bits (`id >>> 27`), the **level tag**: which level authored the entity

the two cell sources agree exactly on map01 and map02; disagreements are collected as `issues`
rather than thrown, and `world levels <map>` prints them.

the tag is the 1-based ordinal of the level among the map's grid-owning levels sorted by id, not the
`lvNNN` number. in map02 these coincide because lv001–lv010 all exist; map01 has no lv004, so
lv005–lv007 carry tags 4–6. tag 0 is a small map-wide shared set and tag 31 holds generated
colliders. a single-level scene (a dungeon, Dijiang) tags everything 0, so there the one level owns
tag 0. `world levels <map> --verify` checks the rule by a majority vote of where each tag's pivots
fall; backdrop cells don't vote, since skyline props would outvote small levels.

**content ownership follows the tag, not position.** a level's scenery can sit in a neighbour's cell
or in a cell no level owns (backdrop and skyline; map02 has more such cells than owned ones). border
cells hold several levels' entities without duplicating them, and an entity spanning cells repeats
by id in each cell's chunk. so:

- select a level's content by tag. clipping by its cells or rect cuts real scenery
- keep unowned cells; they are part of their tag's level
- treat MapRegionTable polygons as UI overlays (mist, toasts). they don't tile the level and
  overhang its cells, so using them as clip volumes cuts scenery

`classifyEntity` returns a bucket (`level`, `shared` for tag 0, `unassigned`) and a placement
relative to the grid (`own`, `neighbour`, `backdrop`, `unplaced`); `world members <level>` counts a
level's entities by placement.

code: [level-partition.ts](../../packages/formats/src/endfield/level-partition.ts)

## static scenery: InitChunkData and StreamingChunkData

static scenery streams per 128 m cell:

```
Data/Streaming/PC/<scene>/Streaming/InitChunkData_<x>_<z>_<sceneState>_<area>.bytes
Data/Streaming/PC/<scene>/Streaming/InitChunkData_Global_<sceneState>_<area>.bytes
Data/Streaming/PC/<scene>/Streaming/StreamingChunkData_…   (same suffixes)
```

- `<x>_<z>` is the cell. most entity pivots fall inside their file's cell; large objects are filed
  by bounds and repeat in each cell they touch. the `Global` file has no cell and is always
  resident.
- `<sceneState>` is 0 for always-loaded content and `n` for content shown only while MapConfig scene
  state `n − 1` is active (see [scene-states.md](scene-states.md)).
- `<area>` is a stream-area id from `FBStreamArea` (below); 0 is the default area.

`WorldIndex.chunkFiles()` parses these names; `world cells <level>` lists a level's files as
`sceneState/area`, `world entities <map> <x> <z>|global` dumps one cell.

every file is the HG payload envelope (see [../extraction.md](../extraction.md)) around a
FlatBuffer.

### InitChunkData layout

the root table has 8 slots: version (47 and 49 are accepted; anything else throws), the chunk origin
(`x·128, z·128`; Global stores `INT32_MAX, INT32_MIN`), the object rows (ids, union kinds and
tables, each row's field 0 being the full object name), and parallel vectors of per-group entity ids
and **component groups**.

a component group is an ECS archetype stored column-major: a descriptor list of
`(component id, stride)` and one blob of `count · Σ stride` bytes. component ids are anonymous
column selectors; the ones with established meaning:

| id    | content                                                                                                         |
| ----- | --------------------------------------------------------------------------------------------------------------- |
| 0–5   | world AABB, centre xyz then extents xyz (f32 each)                                                              |
| 8–14  | draw infos for capacity `2^(id − 8)`: count, 24-byte infos (submesh, flag word), then `(max², min²)` LOD bounds |
| 18    | 256-byte instance constants starting with the object-to-world matrix                                            |
| 21    | 64-byte name prefix (root object names win when present)                                                        |
| 27    | rect decal constants; the decal's material is in StreamingChunkData                                             |
| 42    | a local light's runtime data, zero-filled in the file (244 bytes); the values are in the object row (below)     |
| 63    | the same light's settings, zero-filled (448 bytes)                                                              |
| 67    | LOD ranges: LOD count and cumulative draw count per LOD                                                         |
| 68–74 | draw refs for capacity `2^(id − 68)`: `(u64 material hash, u64 mesh hash, …)`                                   |

`readChunkEntities` turns a group into `ChunkEntity` rows with id, tag, name, matrix, bounds, decal
flag and a `StaticRenderer` (draws with mesh/material StringPathHash keys, submesh, flags and LOD
range). the decoder throws on any stride or count disagreement instead of skipping, so a format
change can't silently drop draws.

object row kinds by census: 1 = GameObjects the client rebuilds as MonoBehaviours (environment and
post volumes, probes, water, terrain root), 2 = component-group entities, 3 = audio, grass grids and
surface data. kind 1 is read by
[mono-objects.ts](../../packages/formats/src/endfield/mono-objects.ts) and consumed by
[environment.md](environment.md) and [water.md](water.md).

local lights are kind-2 entities in groups with columns 42 and 63. their row's slot 3 is a keyed
property table in kind 1's layout, holding two blobs, a 236-byte runtime block and a 448-byte
settings block, which [chunk-lights.ts](../../packages/formats/src/endfield/chunk-lights.ts) lays
out. map01 has 1,025 and map02 2,153; [lighting.md](lighting.md#local-lights) covers how they shade.

### StreamingChunkData

the sibling of each InitChunkData file. it shares the root layout and object ids and adds, per
object, a keyed property table whose values point at assets by StringPathHash key. keys read as
`component << 24 | field << 16 | index`. kind-1 objects merge their Init and Streaming rows per
component.

code: [init-chunk-data.ts](../../packages/formats/src/endfield/init-chunk-data.ts),
[streaming-chunk-data.ts](../../packages/formats/src/endfield/streaming-chunk-data.ts)

## stream areas

`Data/DynamicStreaming/PC/Scene/<scene>/FBStreamArea.bytes` lists every area of a scene, the areas
visible by default (`RootVisible`), and trigger volumes: an XZ polygon with a box and height range
per area. while the streaming centre is inside one or more triggers, the client shows the union of
those areas' visible slices; otherwise it shows `RootVisible`. area ids are the `<area>` suffix of
chunk file names and the visibility groups of DynamicStreaming entities. root slots 7–9 exist but
are not decoded.

the packer draws a level with all of its areas, deduplicating entities shared between areas; the
trigger test (`visibleAreasAt`) exists for consumers that want the game's area switching.

code: [stream-area.ts](../../packages/formats/src/endfield/stream-area.ts)

## dynamic streaming

`Data/DynamicStreaming/PC/Scene/<scene>/` holds the dynamic ECS scene: `fb_main_<L>_<i>_<j>` grid
files (grid unique id `L << 16 | i << 8 | j`), paired `fb_init_*`/`fb_streaming_*` ECS chunks and
the stream-area table. it carries prefab placements, interactives, and scenery gated by progression,
quests and variables. its format and how structures are selected are in
[assets.md](assets.md#dynamic-structures).

## terrain

terrain lives in VFS group `F84BF5E6`:

```
Data/Terrain/PC/<scene>/Terrain_<level>_<x>_<z>_<H|N|T|A|S|C>.bytes
Data/Terrain/PC/<scene>/Layers/LAYER_<D|N|C>_<index>.bytes
```

each file is a u32 clear size and an inverted-LZ4 block (a few are stored raw), and the clear bytes
are a 20-byte `TRET` header (magic, version 1, width, height, mip count, Unity `GraphicsFormat`,
payload size) followed by one texture's mip chain. the parser checks the mip chain fills the payload
exactly.

tiles form a quadtree over the scene's terrain square: level `l` splits it into `2^l × 2^l` tiles,
`x` along +X and `z` along +Z. the finest tiles are 64 m (map02's leaf is level 6, map01's level 5).

| channel  | content                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------- |
| `H`      | 65² heights, R8G8 read as little-endian u16, 1 m spacing; outer samples are shared with neighbours |
| `N`, `A` | baked normal and albedo pages, DXT5                                                                |
| `T`      | tint page, DXT5 sRGB                                                                               |
| `S`      | splat control, RGBA8                                                                               |
| `C`      | 34² cliff index, R8G8                                                                              |

pages are 132² with a 2-texel border around a 128² core that covers the tile edge to edge, and have
one level. every tile with a height page has all six channels, at every level. layers are per-scene
material textures the renderer gathers into arrays by index: `D` diffuse (BC7 sRGB), `N` normal
(BC7), `C` cone maps (R8).

the baked `A` and `N` pages are what the game draws where its close-up layer blend doesn't reach:

| channel | r                   | g                   | b                    | a                                        |
| ------- | ------------------- | ------------------- | -------------------- | ---------------------------------------- |
| `A`     | albedo, linear      | albedo              | albedo               | subsurface curvature input (unused here) |
| `N`     | world normal x ·2−1 | world normal z ·2−1 | perceptual roughness | occlusion                                |

`A` is linear despite its UNorm format, and the normal's y is `√(1 − x² − z²)`. the normal's
orientation was checked against normals from the height page (r = +X, g = +Z, rows along +Z). the
packer stores both pages as one surface page per tile
([package format](../package-format.md#surface-page-tsp-efts)).

the terrain's placement isn't in the tiles. it comes from the scene's `HGTerrainSurfacesData`
MonoBehaviour at
`assets/beyond/dynamicassets/scenes/pc/<scene>/terrain/hgterrainsurfacesdata.asset`:

- `terrainPosition`: world position of the square's minimum corner; `y` is the height of a zero
  sample
- `heightScale`: metres spanned by the 15-bit height range
- `terrainSize`: root edge length, a power-of-two multiple of 64 m
- `nodeData`: a complete breadth-first quadtree (`index = (4^l − 1)/3 + z·2^l + x`) with per-node
  min/max height and a `maxHeightError`, which the packer uses as the terrain node's error
- `layerData`: the close-up material layers by ordinal; see below
- `sectorSplatInfo`: one u64 per 64 m sector, a bitmask of the layer ordinals the sector uses
  (checked against the index map on map02); the packer doesn't need it

world Y of a sample is `position.y + (h & 0x7fff) · heightScale / 32768`. bit 15 marks a hole; holes
keep a plausible height in the low bits, which suits skirts and morphing but not drawing. a scene
with terrain tiles but no `HGTerrainSurfacesData` fails the pack rather than guessing a placement.

the packer aligns its tile tree with this quadtree (root = the terrain square, leaf = 64 m) so tree
nodes never split the game's own units; scenes without terrain get a 4096 m tree centred on the
origin.

### close-up layers

near the camera the game draws a blend of tiling material layers instead of the baked pages:

- **index**: `terrain/splatindexmap.tga`, an RGBA32 Texture2D of `terrainSize / 8` texels (row 0 at
  the minimum z), names 4 layer ordinals per 8 m cell, each stored times 4
- **weights**: the leaf's `S` page; rgb weight the cell's slots 0–2, slot 3 gets `1 − r − g − b`.
  its filtering stays half a texel inside the cell, since the weights belong to that cell's layers
- **layers** (`layerData`): `splatST` (x: repeats across the terrain square, y: texture index, zw:
  uv offset), `packedSplatInfo` (mean albedo, normal xy scale), `diffuseRemapScale` (rgb multiplier,
  height-blend border in w), `maskMapRemapScale`/`Offset` (scale and offset for occlusion in y,
  height in z, roughness in w; the offset's x is a surface type id)
- **textures**: `LAYER_D` is sRGB albedo with height in alpha; `LAYER_N` is tangent-space normal xy,
  roughness in b, occlusion in a. on map02 they are 1024² BC7 with 11 levels and repeat every 2–9 m
- **blend**: with weighted heights `wh = w · h`, each slot gets
  `w · (max(0, wh − max(wh) + border) + ε)`, normalized. albedo is the blended
  `diffuse · diffuseScale`, plus `(tint − mean) · a⁴` from the leaf's `T` page, `mean` being the
  blended mean albedos. the blended tangent normal is oriented on the baked normal, with tangent
  `cross(n, +Z)`
- **projection**: world position times the layer's repeats per metre, on the x, y or z plane picked
  by the baked normal's `|n|⁸` weights (the game picks one plane per pixel at random)

not reproduced: the cliff projection driven by the `C` page, parallax from the cone maps, and
wetness from `S.a`.

`terrain scenes|tiles|export-heights` inspects and exports the data.

code: [terrain.ts](../../packages/formats/src/hg/terrain.ts),
[terrain-source.ts](../../packages/extractor/src/game/terrain-source.ts),
[commands/terrain.ts](../../packages/extractor/src/commands/terrain.ts)

## LOD and HLOD

the game ships a full far-field stack, and the packer reuses it rather than generating its own,
since the game's clusters are exact, come with their own materials and atlases, and cover a whole
level in very few triangles.

- **per-entity LOD chains.** every static draw carries its LOD index and a
  `(minSquared, maxSquared]` range of squared screen-relative height, as in Unity's LODGroup.
  `maxSquared` is `FLT_MAX` on the nearest LOD; a negative `minSquared` means never culled by size.
  the packer keeps whole chains, thresholds included.
- **foliage cards.** imposter card meshes (`…_cardmesh`) appear as ordinary far LODs; the packer
  marks a draw as a card when its mesh path contains `_cardmesh`.
- **shadow proxies.** draws with flag bit 10 only cast shadows.
- **HLOD clusters.** auto-generated per-level clusters in three tiers, placed as ordinary entities
  named `HLOD<tier>_<i>_<j>_Cluster_<hash>…`, `i`/`j` being the tier's grid cell, with negative
  coordinates clamped to 0 (west and south of the terrain origin every cluster is named on cell 0).
  one large member can stretch a cluster's bounds hundreds of metres past its cell. their draw range
  is unbounded, so HLOD visibility is decided by the HLOD/streaming system, not by LODGroup. they
  occur only in always-loaded (scene state 0) files. HLOD0 cells are 64 m, doubling per tier; the
  pack report counts how many cluster names agree with the tile computed from their position.

### how the packer files instances

the entity pass ([packer.ts](../../packages/extractor/src/pack/packer.ts), `collectEntities`) reads
the scene's chunk files in a fixed order (always-loaded before scene-state files, the default area
before stream areas, then by name) and keeps the first copy of each entity id, so an entity present
in an always-loaded file stays unconditional. entities without a renderer or matrix, and decals, are
skipped. every row keeps its level tag, and each destination is grouped per tag, so a level can be
shown or hidden as a whole:

| destination | what goes there                                                                                                       | where it lives                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| HLOD        | scene-state-0 entities whose name matches the HLOD pattern; attached to the tile of tier `t` at tree level `leaf − t` | one block per level tag, in the core archive |
| resident    | other entities of the `Global` chunk                                                                                  | one block per level tag, in the core archive |
| detail      | other always-loaded entities, filed under the 64 m leaf containing their bounds centre                                | one block per (leaf, level tag)              |
| conditional | entities of scene-state files, plus dynamic structures and facilities, with a visibility expression                   | one block per (leaf, level tag, condition)   |

HLOD clusters stand in for instances already counted, so they're left out of a level's instance
count. with `--level`, the subset keeps entities with that level's tag and terrain tiles touching
its cells.

the game's HLOD switch distances are unknown, so a node's geometric error is a placeholder (1/16 of
its edge, 4 m at the 64 m leaf) that the viewer's SSE threshold tunes.

## open

- the meaning of the draw flag bits other than shadow-only, and of a negative `minSquared` beyond
  "never culled by size"
- HLOD switch distances, and the HLOD generated-material channel layout
- the cell size of `fb_main` grids; the levels are known from file names, the metric size is not
  decoded
- stream-area root slots 7–9
- `farmod` far-field assets: whether they form a layer outside HLOD
- whether dungeon levels that reuse an open-world scene add content of their own beyond LevelData
  and DynamicStreaming
