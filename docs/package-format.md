# viewer package format

a package is what `pnpm -s extract pack <scene>` writes and the viewer streams: one streaming scene
(one world, one coordinate frame) as czar archives holding content-addressed blobs and a few tables.
see [extraction](extraction.md#pack) for packing, [loading](viewer/loading.md) for reading, and
[game-data](game-data/) for the source formats.

the types are the contract: [package-format](../packages/package-format/src/) has one module per
concern, each holding that concern's types and binary codec (`manifest`, `tiles`, `tree`,
`instances` for chains and instance blocks, `geometry`, `textures`, `materials`, `terrain`,
`environment`, `water`, `lights`, `particles`, `irradiance`, `states`, `conditions`, `stream-areas`,
`story`, `blobs`, `blob-table`, plus shared helpers). the packer and the viewer share them, and
their JSDoc wins where this page is less precise. `package-format` stays free of node APIs and of
other workspace packages so both sides can import it.

| side   | code                                                                                                                                               |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| packer | [pack/packer.ts](../packages/extractor/src/pack/packer.ts) and its siblings in [pack/](../packages/extractor/src/pack/)                            |
| viewer | [package/](../packages/viewer/src/package/): `viewer-package.ts` opens the core, `package-source.ts` reads files, `decode-worker.ts` decodes blobs |

## layout

```
<package>/
  core.czar                       read whole when the package opens
    blobs/<tile>/<hash>.hgt       terrain height pages coarser than the 128 m cells
    blobs/<tile>/<hash>.tsp       terrain surface pages, likewise
    blobs/<hash>.inst             HLOD and global instance blocks, one of each per visibility group
    manifest.json.zst             PackageManifest
    tables/blobs.bin              blob index → archive, codec, kind, offset, lengths
    tables/chains.bin             LOD-chain templates
    tables/geometries.json.zst    geometry table
    tables/materials.json.zst     shader defaults + material table
    tables/textures.json.zst      texture table
    tables/water.json.zst         water table
    tables/lights.json.zst        local lights
    tables/particles.json.zst     particle systems
    tables/environment.json.zst   environment volumes, phases and post profiles
    tables/irradiance.bin         irradiance cell keys → blobs, per bake
    tree.bin                      tile nodes + content refs
  shards/<l>_<x>_<z>-<id>.czar        content of one shard-level tile's subtree
    blobs/<tile>/<hash>.hgt           terrain height pages at the cell level and finer
    blobs/<tile>/<hash>.tsp           terrain surface pages, likewise
    blobs/<tile>/<hash>.tsl           terrain splat pages (leaves)
    blobs/<tile>/<hash>.inst          detail and conditional instance blocks
  assets/<l>_<x>_<z>[.<n>]-<id>.czar  geometry and texture blobs whose uses all lie under that tile
  assets/common[.<n>]-<id>.czar       ... used by global content or under several root tiles
  assets/terrain-layers-<id>.czar     terrain layer textures (.tly)
    blobs/<hash>.mesh                 one mesh
    blobs/<tail>.<i>/<hash>.tex       mip levels of one texture, piece i under its tail's hash
  irradiance/<x>_<z>-<id>.czar        irradiance cells over one 512 m square
    blobs/<cell key>/<hash>.iv
  debug/                              provenance; never loaded by the viewer
```

`CORE_PATHS` names the core's fixed members. every other archive is named by its content,
`<stem>[.<part>]-<id>.czar` (`archiveName`): the stem is its group (`shardStem`, `assetStem`,
`irradianceStem`), and the id is 16 hex digits of the SHA-256 of its czar head, which lists every
member's path (a blob hash), offset, size and CRC. so a name changes exactly when the archive's
bytes do. `manifest.archives` lists every archive with its `role` (`core`, `shards`, `assets`,
`irradiance`) and `tile`; the core is entry 0, the rest follow sorted by name.

**locality**: czar lays members out in path order, so a blob's path leads with a locality key
(`blobPath`) that puts blobs read together next to each other, and the viewer's
[coalescing](viewer/streaming.md#residency-and-budgets) reads them in one request: a tile node's
terrain pages and instance blocks share its key (its level, then a Morton code of x and z, so nearby
tiles sit close), a texture's pieces sort coarse to fine under its tail's hash, and irradiance cells
by cell key. keys come from content, never from table ids, so a path changes only with what it
holds. meshes, the core's blobs and terrain layers are read alone and have none.

**parts**: a group whose blobs total more than 1 GiB is split into a power-of-two number of parts by
the top bits of a hash of each blob's locality set (the key before its first `.`; its own hash
without one), so parts land at 0.5–1 GiB (u32 offsets allow 4 GiB, and the size suits HTTP and OPFS)
and blobs read together stay in one part. splitting by hash rather than by fill order keeps each
part's membership stable: adding or changing an asset changes one part, and the split itself only
changes when a group doubles.

**reuse**: content names make a re-pack cheap. the packer hard-links each archive whose name (and
size) the package it replaces already has, instead of streaming it from the blob store again; an
archive is never written once made, so the link shares its bytes on any file system. where linking
fails it falls back to a copy-on-write clone (APFS, Btrfs, reflinked XFS), else a plain copy. a warm
map02 re-pack writes the core and nothing else (20 s → 5 s for the write phase with clones). it also
means a reader caching archives by name can't pair a stale archive with a newer core.

**replacing**: the packer replaces a previous package in its output directory but refuses a
directory holding anything else, so a mistyped `-o` can't wipe unrelated files. it writes the new
package into a hidden sibling (`.<out>.staging`, whose `.spool` holds scratch blobs when there's no
pack cache) and renames it into place once complete, so the previous package stays readable during a
pack and survives a failed one, and a reader never sees a mix of the two.

## containers and blobs

**czar** ([`@mary-ext/czar`](https://www.npmjs.com/package/@mary-ext/czar)) is the container: a
magic, a JSON header listing members (path, offset, size, CRC-32), then member data in path order on
16-byte boundaries. **blob index**: `tables/blobs.bin` records each blob's archive, offset (relative
to the archive's data section) and length, so a reader issues one range read per blob and never
fetches a shard's JSON header. czar contributes CRCs, deterministic output,
`list`/`verify`/`extract` tooling and Blob/OPFS readers. 16-byte alignment lets decoders view
uncompressed members as typed arrays.

- **blob identity**: the first 128 bits of the SHA-256 of the **stored** (post-codec) bytes, as 32
  lowercase hex digits. equal stored bytes are one blob, kept in the archive and locality of its
  first use. member path is `blobs/[<locality>/]<hash>.<ext>` (`blobPath`).
- **codec** (`BlobCodec`): `0` none, `1` one zstd frame. the packer keeps the zstd frame only when
  it saves at least 1/32 of the bytes, since a frame costs a decode pass and small BC7 mip tails
  barely compress. compression settings are in
  [asset conversion](extraction.md#asset-conversion-and-workers).
- **offsets** are u32, so every archive stays below 4 GiB; groups over 1 GiB split into
  [parts](#layout).
- **the core's offsets**: `ArchiveInfo.dataOffset` is `null` for the core, because the core's header
  holds the sizes and CRCs of the tables that contain the offsets. a reader reads the core whole and
  takes its data section's start from the position of its first member, which core blob offsets are
  relative to. blob paths (`blobs/…`) sort before every fixed member, so blob offsets inside the
  core don't depend on table sizes; `BlobStore.writeCore` refuses a fixed member that would sort
  first.
- **generation**: `manifest.generation` hashes the core's binary and table members (not the
  manifest). equal generations mean equal tables, so a reader can key decoded-table caches by it.

blob indices are assigned at commit, in a deterministic order (`BlobStore.prepare` compresses and
hashes concurrently, `commit` indexes in input order), so repacking the same install yields the same
package.

## coordinates

everything is in the game's Unity frame: left-handed, +Y up, +Z north, metres. every package uses
it, so the manifest doesn't record it. a right-handed scene can convert with `scale(1, 1, -1)` at
its root and reversed front-face winding. this viewer keeps Unity coordinates and constructs its
view-projection accordingly ([camera.ts](../packages/viewer/src/scene/camera.ts)). matrices are
`rows3x4`: the top three rows of object-to-world, row-major, matching a WGSL `array<vec4f, 3>`.
instance translations and bounds centres are relative to their block's origin, which keeps f32
precise anywhere in the world.

## tile tree

`TreeInfo` describes a forest of quadtrees on one unbounded grid that coincides with the game's
[terrain](game-data/world.md#terrain) quadtree, so tree nodes never split the game's own units:
`origin` and `rootSize` are the terrain square's corner and edge (scenes without terrain get a 4096
m square centred on the origin). level `l` tiles are `rootSize / 2^l`; `(l, x, z)` may be negative
or past `2^l − 1` for content off the terrain square, such as far skyline props. terrain page keys
equal tree keys.

| level           | role (map02: 4096 m root)                                          |
| --------------- | ------------------------------------------------------------------ |
| `leafLevel`     | 64 m: terrain leaves, detail leaves, HLOD tier 0                   |
| `cellLevel`     | 128 m: the game's streaming and level-ownership cells, HLOD tier 1 |
| `hlodLevels[2]` | 256 m: HLOD tier 2                                                 |
| `shardLevel`    | `leafLevel − 3` (512 m): groups shard archives                     |

`hlodLevels[t]` is the level whose tiles are tier `t`'s cells, `leafLevel − t` where HLOD0 cells are
64 m and one level coarser where they're 128 m (indie_dg005). HLOD cluster names
(`HLOD<tier>_<i>_<j>_Cluster_…`) give the tier and the cell on the scene's
[HLOD grid](game-data/world.md#lod-and-hlod), which the packer fits to the names (the pack report
prints it, and fails the pack when no grid explains 80 % of them) and snaps to tree tiles within 8
m. it attaches each cluster to the tile of its named cell rather than to its bounds centre, because
clusters overhang their cells. two cases leave several candidate tiles, and the packer picks the one
with the most always-loaded detail instances inside the cluster's bounds (the candidate nearest the
centre without any):

- names clamp negative coordinates to 0, so along an axis named 0 the candidates are the named tile
  and each spanned tile west or south of it.
- a tier whose grid is offset from the tree by half a cell (the report says which tiers straddle)
  has cells covering two tiles per axis.

a cluster left on a tile without that detail can't refine, so it would draw over the detail it
stands for.

**refinement contract** (REPLACE, at HLOD-cell granularity): a node draws its coarse content while
the camera is outside the ring of its HLOD tier, the game's
[HLOD rings](game-data/world.md#streaming-layers); otherwise it refines to its children, and a
refined leaf draws its detail blocks. per-instance LOD inside detail uses the chain thresholds.
conditional blocks have no HLOD stand-in, so they draw within the detail ring regardless of
refinement, or, with a `reach`, while the camera is inside that world x/z rectangle
([instance selection](viewer/streaming.md#instance-selection)). the packer gives dynamic structures'
blocks the reach where the game would load their [load grid](game-data/world.md#dynamic-load-grids)
(the 3×3 cells around it, running on to infinity at the game's clamped frame edges), so the viewer
needs no grid layout. global content (the game's Global chunk scenery) is drawn whenever its group
shows and never replaced. `geometricError` (`edge / 16`, 64 m leaf → 4 m) now only orders requests.
which entities become HLOD, detail, global and conditional content is in
[extraction.md](extraction.md#how-the-packer-files-instances).

**content refs** (`ContentRef`, `ContentKind`):

| kind                 | points at                                                                      | `tier`    | `reach`                       |
| -------------------- | ------------------------------------------------------------------------------ | --------- | ----------------------------- |
| `TerrainHeights` (0) | one height page                                                                | 0         | `null`                        |
| `Hlod` (1)           | rows `[first, first + count)` of a group's shared HLOD block                   | HLOD tier | `null`                        |
| `Detail` (2)         | a whole instance block the HLODs stand in for                                  | 0         | `null`                        |
| `Conditional` (3)    | a whole instance block no HLOD stands in for (scene-state and dynamic content) | 0         | `null`, or the camera's reach |
| `TerrainSurface` (4) | one surface page, covering the same tile as the height page                    | 0         | `null`                        |
| `TerrainSplat` (5)   | a leaf's splat page                                                            | 0         | `null`                        |

every ref names a [visibility group](#visibility-groups); terrain refs use group 0 (shared, always
loaded). detail and conditional blocks are one per (leaf, group, reach); an instance goes to the
leaf under its bounds centre. HLOD and global rows form one block per group in the core, HLOD rows
sorted by node so each node's refs are one run. global refs follow the nodes' refs in `tree.bin`,
with kind `Detail`; Global chunks of scene states become conditional global blocks, drawn whole
while their state is on.

## manifest

`manifest.json.zst`, `PackageManifest` (zstd-compressed JSON like the tables). it describes the
package (its scene, tree, levels, controls and archives); placed content lives in the tables:

| field               | contents                                                                                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format`, `version` | `'endfield-noclip.package'`, `PACKAGE_VERSION` (see [versioning](#versioning))                                                                                                               |
| `generation`        | see [containers and blobs](#containers-and-blobs)                                                                                                                                            |
| `source`            | the bundle manifest's build guid and content hash: identifies the game build                                                                                                                 |
| `scene`             | streaming scene id and display name                                                                                                                                                          |
| `subset`            | what `--level` / `--bounds` kept, or `null`                                                                                                                                                  |
| `archives`          | `ArchiveInfo`, by `role`: the core (name only), or a streamed archive's name, size and `dataOffset`, with its tile for shards and assets                                                     |
| `tree`              | `TreeInfo`                                                                                                                                                                                   |
| `terrain`           | `baseHeight`, `heightScale`, levels with pages, close-up `splat`; `null` without terrain. the square is the tree's root, and the page layout is fixed ([height page](#height-page-hgt-efht)) |
| `levels`            | every level of the scene, even in a subset: id, tag, name, rect, `playerInitPos`, owned cells at `cellLevel`, packed instance count and `contentBounds`, base environment                    |
| `states`            | scene controls, conditional sets, visibility groups, stream areas and missions; see [conditions](#conditions)                                                                                |
| `irradianceRegions` | rooms' own irradiance bakes; see [irradiance cells](#irradiance-cells)                                                                                                                       |

a package's levels are its scene's own map's, which don't overlap, so a viewer can show them all at
once; a group's level tag says who owns its content (0 for shared content). a level's rect and
`playerInitPos` come from its [LevelConfig](game-data/world.md#levelconfig) (`rectLeftBottom`,
`rectRightTop`, `playerInitPos`); the viewer lists levels with them and poses its first view of a
level over the playable rectangle, falling back to the spawn height while coarse terrain loads
([level-pose.ts](../packages/viewer/src/scene/level-pose.ts)).

### environments

`tables/environment.json.zst` (`EnvironmentTable`,
[pack/environments.ts](../packages/extractor/src/pack/environments.ts); how the extractor reads it
is in [packing environments](extraction/environments.md)):

- `posts`: the levels' post-processing profiles, deduplicated by name.
- `schema`: per section field, whether it lerps, lerps and rounds, or switches at ½
  ([blend schema](extraction/environments.md#blend-schema)); fields it doesn't list switch.
- `sections`: per section, every distinct value a phase holds. phases repeat most of each other's
  sections (map02's 393 phases hold 388 distinct section sets, and 101 distinct lens flares made up
  5.4 MB of JSON), so they're stored once.
- `phases`: every phase a volume applies, uncomposed: its name, the sections it marks active, and
  per section it holds, an index into that section's pool. deduplicated by name.
  `resolveEnvironment` looks the sections up, sharing their objects between phases.
- `flowNoise`: texture id of the height fog's 3D flow noise, packed once, or `null`
  ([flow noise](game-data/sky-and-fog.md#flow-noise)).
- `volumes`: every global, box and prism volume: name without its `#…` suffix, visibility `group`
  (owning level tag and loading condition), its `environmentVolume` `control`, shape in world
  coordinates (a box as its centre, half-extents and the rotation taking world offsets into its
  frame, which the packer works out from the game's Euler angles), `blend` (`EnvironmentBlend`:
  `replace`, `depth` over a distance, `fade` in and out over durations, or `scripted`, from the
  game's blend modes 0–3; a volume with any other mode is dropped and listed in
  `debug/environments.json`), priority, and phase index (or `null` when the phase can't be read;
  such a volume has no control and never applies).

`LevelInfo.environment` names a level's base volume (whose phase is never `null`) and post profile
([the level's base environment](extraction/environments.md#the-levels-base-environment)); a viewer
starts its blend from all of that phase's sections.

nothing in the chunk data says whether a volume starts enabled
([activation](game-data/environment.md#activation)), so each volume with a phase gets an
`environmentVolume:<index>` control, which its group requires on. it defaults on, except for a
`scripted` volume, whose fade-in script isn't followed: off, and at full strength when the user
turns it on. a viewer therefore decides whether a volume applies from its group alone.

## binary encodings

all little-endian, every section 4-byte aligned. the tables share a 16-byte header:
`u32 magic, u16 version, u16 0, u32 count, u32 count-or-0`.

| member                  | magic  | layout                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tree.bin`              | `EFTR` | 24-byte header (nodes, node refs, global refs, reaches); 48-byte nodes: `i32 x, i32 z, u8 level, u8×3 0, f32×3 min, f32×3 max, f32 geometricError, u32 refFirst, u32 refCount`; 24-byte refs, the nodes' then the global ones: `u8 kind, u8 tier, u16 0, u32 group, u32 blob, u32 first, u32 count, u32 reach` (`0xffffffff` for none); 16-byte reaches: `f32 minX, minZ, maxX, maxZ`, `[min, max)`, possibly infinite |
| `tables/chains.bin`     | `EFCH` | header (chains, draws); 8-byte chains: `u32 firstDraw, u16 drawCount, u8 flags, u8 0`; 32-byte draws: `u32 geometry, u32 material, u32 particles, u16 submesh, u8 lod, u8 role, f32 minSquared, f32 maxSquared, u8 flags, u8 0, i16 sortingLayer, i16 sortingOrder, u16 0`; then `f32×3` distance origins, one per `CameraDistance` chain in chain order                                                               |
| `tables/blobs.bin`      | `EFBX` | header (blobs, 0); 16-byte records: `u8 kind, u8 codec, u16 archive, u32 offset, u32 length, u32 rawLength`; a blob's hash is only its member path, which readers never need                                                                                                                                                                                                                                           |
| `tables/irradiance.bin` | `EFIV` | version 2; header (entries, 0); u32 cell keys ascending (repeats allowed), then u32 blob indices, then u32 visibility groups                                                                                                                                                                                                                                                                                           |

nodes are ordered coarse to fine (level, then z, then x); a node's children are the nodes at
`(l + 1, 2x + dx, 2z + dz)`, and its bounds cover everything it and its descendants draw, overhang
included.

**chains** are LOD-chain templates deduplicated across the scene by their ordered draws, thresholds
compared by f32 bit pattern ([chains.ts](../packages/extractor/src/pack/chains.ts)), with ids that
carry over between packs ([chain ids](extraction.md#phases)); a chain without draws is a free id. a
draw shows while `minSquared < s² ≤ maxSquared`, `s` being Unity's LODGroup screen-relative height;
a negative `minSquared` never culls by size. the viewer measures `s` as twice the largest
half-extent of the instance's world bounds over its distance, relative to the screen height; which
size the game's thresholds were authored against is unverified, and rotated objects' bounds
overstate it. roles: `Lit`, `ShadowOnly` (shadow proxies, from the game's flag bit 10 or a prefab
renderer's shadow casting mode) and `Unsupported` (a [stand-in](#stand-ins) for content the viewer
can't draw, drawn with its unsupported look); an HLOD cluster's draws are `Lit`, the tree ref
holding them (`Hlod`) says what they are. a draw's flags (`ChainDrawFlags`) say which shadow maps it
casts into when its material casts: `CastsCascades` for the sharp cascades, `CastsStatic` for the
cached far map. the packer reads them from a static draw's renderer flag word, as the
[game](game-data/lighting.md) does, and sets both on prefab, decal and stand-in draws, which have
none. `material` is `0xffffffff` for a stand-in whose material isn't known, and `particles` indexes
the [particles table](#particles) when the draw is a particle system's mesh, else it's `0xffffffff`;
both decode to `null`. `sortingLayer` and `sortingOrder` are a prefab renderer's `m_SortingLayer`
and `m_SortingOrder`, which the transparent pass sorts by before distance; static draws store 0.
prefab renderers under an enabled `LODGroup` get one draw per span of its `screenRelativeHeight`
thresholds they show at, measured on the row's own bounds rather than the LODGroup's size. the chain
flags say whether its instances are billboards (`BillboardFacing`, `BillboardUpright`): their
transform's rotation is then relative to the camera's, and their bounds hold every orientation
([billboards](game-data/assets.md#billboards)). `CameraDistance` makes the chain's thresholds
squared camera distances, in m², instead of screen-relative sizes, measured from the chain's
distance origin: a point in the instance's frame, which the instance's transform takes to the world.
the packer sets it on prefab renderers an [effect LOD table](game-data/effects.md#effect-lod-tables)
switches by distance, with one draw per span of distances they show at, and puts the origin on the
effect's own GameObject as the game measures it (to the millimetre, so placements of a prefab share
chains); under a billboard the stored rotation turns the offset, not the one the camera gives. it
switches without the game's fade. the nearest billboard up the hierarchy turns a mesh renderer
([billboard.ts](../packages/extractor/src/game/billboard.ts)): mode 0 flags the chain
`BillboardFacing`, the others `BillboardUpright` (about the world's vertical, which is their axis on
upright placements). the packer stores the offset times the renderer's rotation relative to the
billboard, at the renderer's own position, so a renderer away from the billboard's origin turns in
place rather than swinging around it.

### irradiance cells

[pack/irradiance.ts](../packages/extractor/src/pack/irradiance.ts) stores every cell whose centre
the package covers, of the base bake and of each scene-state bake whose states the scene's MapConfig
names, as one decompressed `Irradiance` blob
([cells and probes](game-data/irradiance.md#cells-and-probes)), zstd-compressed, in the 512 m
archive `irradiance/<x>_<z>-<id>.czar` over it. `tables/irradiance.bin` lists one entry per stored
cell: its key, in the game's layout moved to one origin ([parser](extraction.md#irradiance)), its
blob and a visibility group. keys ascend, and a cell held by several bakes repeats its key: the
scene-state bakes first, most states first, each under a group that needs all its states on
([scene-state bakes](game-data/irradiance.md#scene-state-bakes)), then the base bake under the
always-shown group. a viewer uses a key's first entry whose group shows. cells stay in the game's
GPU layout so the viewer uploads them unchanged.

the manifest's `irradianceRegions` lists rooms' own bakes (`IrradianceRegionInfo`: a visibility
group, the probe grid's origin and size, and an `.iv` blob of its probes), which replace the finest
probes inside their grid while their group shows
([region bakes](game-data/irradiance.md#region-bakes)). a cabin slot's region bake is the one whose
box holds the slot origin and whose room type is the slot's cabin's
([Dijiang cabins](extraction/scene-controls.md#dijiang-cabins-and-region-walls)); the packer stores
its probes as one blob and lists it with the visibility group of the built cabin, so it applies
exactly while the cabin shows.

### instance block (`.inst`, `EFIN`)

32-byte header: `u32 magic, u16 version, u16 0, u32 count, f32×3 origin`, then a `u32` row count per
row section (decals, spins). then struct-of-arrays sections of `count` elements: `u32 chain`,
`f32×12 transform` (rows3x4, translation relative to origin), `f32×6 bounds` (world AABB centre
relative to origin, then half-extents, as the game stores them). then each **row section**, values
only some rows carry: its ascending `u32 row`s, then a fixed number of floats per row (`RowSection`,
one codec for all of them):

- **decals**: `f32×8` rect decal placements (the RGBA8 colour, used as stored, with RGB times the
  intensity, then the UV scale and offset of the box's `local.xz + 0.5`).
- **spins** ([spinning scenery](game-data/animation.md#spinning-scenery)): `f32×7` (pivot relative
  to origin, unit axis, radians per second). at time `t` a spinning row's transform and bounds
  centre are its stored ones turned `speed · t` about the axis through the pivot, as Unity's
  `Quaternion.AngleAxis` turns; the stored half-extents still bound it by sphere. the tile tree's
  bounds hold the cylinder each spinning row's box sweeps.

origin is the leaf's minimum corner (y 0) for detail blocks and the tree origin for core blocks.
rows are sorted by (HLOD node, chain), so equal chains form instanced ranges. who owns a row and
when it loads is the block's group; `debug/instances.jsonl` traces each row to its entity.

full 3×4 matrices are kept rather than quantized TRS because Unity hierarchies bake shear and
non-uniform scale into them.

### height page (`.hgt`, `EFHT`)

8-byte header: `u32 magic, u16 version, u16 side`, then the `side²` raw u16 samples (rows along +Z)
as two byte planes (all low bytes, then all high bytes) of zigzag deltas. interior samples are
predicted by `left + above − aboveLeft`, the first row by its left neighbour, the first column by
the sample above. arithmetic wraps at 16 bits so the hole bit survives. the gradient predictor beats
left-only prediction by about 10 % after zstd. the packer ships every level of the game's pyramid,
not only leaves, so the viewer can run CDLOD from native data. a node's bounds span its page's
lowest and highest non-hole samples. the game's per-node `maxHeightError` isn't packed: it isn't an
error bound ([terrain](game-data/world.md#terrain)). a scene with terrain tiles but no
`HGTerrainSurfacesData` fails the pack rather than guessing a placement. `terrainHeight` and
`isTerrainHole` decode samples: `y = baseHeight + (h & 0x7fff) · heightScale / 32768`.

the page layout is the package format's, not the manifest's: `TERRAIN_PAGE_SAMPLES` (65) samples per
height page edge, `TERRAIN_HOLE_BIT`, `TERRAIN_SURFACE_TEXELS` and `TERRAIN_SURFACE_BORDER` for the
surface and splat pages, `TERRAIN_LEAF_METRES` (64) and `TERRAIN_SPLAT_CELL_METRES` (8) in
[terrain.ts](../packages/package-format/src/terrain.ts). every scene of the game shares this layout;
the packer checks the game's against these before packing, so a change to it fails the pack and
calls for a new package version. the terrain square is the tile tree's root.

### surface page (`.tsp`, `EFTS`)

8-byte header: `u32 magic, u16 version, u16 side`, then two BC3 images of `side²` texels (rows along
+Z), albedo then normal, each in `writeTexture` block order. they are the game's baked `A` and `N`
tile pages as stored, one level each; [world.md](game-data/world.md#terrain) gives their channels.
`TERRAIN_SURFACE_TEXELS` (132) is the side, and the outer `TERRAIN_SURFACE_BORDER` (2) texels of
each edge lie outside the tile, so world `x` maps to
`u = border / side + (x − tile.minX) / tile.size · (side − 2 · border) / side`. a tile missing
either page has no surface ref and is listed in `debug/terrain.json`. on map02 the 3,393 pages are
118 MB raw and 64 MB stored.

### splat page (`.tsl`, `EFSL`) and layer textures (`.tly`)

a leaf's close-up blend inputs, the game's splat control, tint and index pages
([world.md](game-data/world.md#close-up-layers)). 12-byte header:
`u32 magic, u16 version, u16 side, u16 cells, u16 0`, then the `S` page's RGBA8 texels (`side²`),
the `T` page's BC3 sRGB blocks, and `cells²` cells of 4 layer ordinals cut from the scene's index
map, row-major from the leaf's minimum corner. the images share the surface page's layout. a leaf
missing either page has no splat ref and is listed in `debug/terrain.json`. map02's 2,492 are 218 MB
raw and 40 MB stored.

`terrain.splat` (`TerrainSplatInfo`) holds the cell size, the layer table (repeats per metre,
offsets, mean colour, scales and remaps, named rather than the game's packed vectors), and the layer
textures: one `TerrainLayer` blob per texture and role, raw BC7 levels from `textureSize` down,
largest first, levels under 4² padded to one block. the packer drops the game's top level (1024²),
since 512² already gives 57–230 texels per metre; map02's 38 pairs are 22 MB in
`assets/terrain-layers-<id>.czar`. `splat` is `null` when the scene's layer table, index map or
textures are missing or disagree (the pack log and `debug/terrain.json`'s `layerProblem` say which).

### geometry blob (`.mesh`, `EFGM`)

32-byte header
(`u32 magic, u16 version, u16 flags, u32 vertexCount, u32 indexCount, u16 streamCount, u16 submeshCount, u32 index payload length, u32 animation length, u32 0`),
32-byte stream records
(`u8 attribute, u8 format, u8 flags, u8 0, u32 payload length, f32×3 offset, f32×3 scale`), 40-byte
submesh records
(`u32 firstIndex, u32 indexCount, u32 baseVertex, u32 vertexCount, f32×3 min, f32×3 max`), then
stream payloads, the index payload and the animation, if any. payloads are meshopt-encoded (codec
v1, no filters), so the decoded bytes are the GPU buffers as they are; `package-format` treats them
as opaque and the viewer decodes with `meshoptimizer/decoder`. conversion is in
[geometry.ts](../packages/extractor/src/pack/geometry.ts).

an **animated geometry** (`SkinAnimation`) plays a looping clip: its streams hold the bind pose,
with bone weights and indices (a rigid renderer's mesh is its own bind pose, every vertex on bone 0
at full weight), and the animation is a 32-byte header
(`u16 boneCount, u16 frameCount, f32 frameRate, f32×3 offset, f32×3 scale`) and then
`frameCount × boneCount` rows3x4 f32 matrices, frame-major, from the bind space to the space the
geometry is drawn in. at time `t` the frame is `(t · frameRate) mod frameCount`, blended linearly
into the next (the last into the first), and each vertex moves to
`Σ weight · matrix · bindPosition`. the box `offset + [0, 1]³ · scale` holds every frame's
positions, so a viewer can quantize them as it does still positions. the table's `bounds` are that
box, and `animationFrames` says the blob has an animation. matrices are stored as they are: the
balloon's tube, at 420 frames of 46 bones, takes 0.9 MB per LOD before zstd.

each stream is its own vertex buffer. attributes use Unity's channel numbering (`VertexAttribute`):

| attribute  | format                                                                                                                                                      | why                                                                                                                                                                                                                                                                                                                                   |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 position | `unorm16x4`, xyz dequantized to the mesh AABB; w is the sway weight, the colour's alpha (1 without colours), when a swaying material draws the mesh, else 0 | sub-3 mm steps on the largest meshes; the depth passes, which read only positions, need the weight too                                                                                                                                                                                                                                |
| 1 normal   | `snorm16x2` octahedral, decoded in the shader                                                                                                               | the game's packed normals are 10-bit octahedral: their integers are stored exactly with a dequant scale of 32767/511, about 30 % smaller after meshopt + zstd than respreading over 16 bits. float normals are oct-encoded at 16 bits. meshopt's oct filter decodes to 4–8 GPU bytes and at 8 bits drops below the source's precision |
| 2 tangent  | `snorm8x4`: oct `xy`, bitangent sign `z`                                                                                                                    | generated (MikkTSpace-compatible via `meshoptimizer`'s tangents) only when a normal-mapped material draws the mesh, or the source's own                                                                                                                                                                                               |
| 3 color    | `unorm8x4`, `float16x4` when values leave [0, 1]                                                                                                            |                                                                                                                                                                                                                                                                                                                                       |
| 4–11 UV0–7 | `unorm16x2` dequantized when the span is ≤ 16, else `float32x2`; 8-bit sources keep `snorm8x4`/`unorm8x4`; sets with more than two components `float32x4`   | half floats step 1/128 at 12, too coarse for tiling UVs; dequantized unorm16 at span ≤ 16 errs below 2^-13                                                                                                                                                                                                                            |
| 12 weights | `unorm16x4`, summing to 1                                                                                                                                   | the game's own precision; animated geometries only                                                                                                                                                                                                                                                                                    |
| 13 bones   | `uint8x4`, indexing the animation's bones                                                                                                                   | up to 256 bones; animated geometries only                                                                                                                                                                                                                                                                                             |

a material is normal-mapped when a bound slot is one its shader flags `[Normal]` or, as a fallback
for shaders that don't flag theirs, one whose name contains `normal` or `bump`; the name match is a
heuristic. tangents are computed in the game's left-handed frame, so
`bitangent = cross(n, t) · sign` holds there. the mesh shader multiplies the bitangent sign by the
object-to-world determinant's sign to handle mirrored instances. vertices whose corners disagree on
the tangent frame (mirrored UV seams) are split. against `mikktspace` 1.1.1 on 200 meshes (864k
corners), meshoptimizer's tangents agree to a mean dot product of 0.99978, 99.975 % within 2.5°,
with matching bitangent signs in 99.998 %.

**swaying geometry**: a mesh drawn with a swaying material (a Lit surface's `sway`,
[swaying cloth](game-data/materials.md#swaying-cloth)) carries its sway weights in position W, and
its table `bounds` grow in X and Z by the farthest any vertex sways,
`weight · (flat + perHeight · |y|)` from the strongest of its materials, so culling and tile bounds
hold the motion under the yaw-only, near-unit-scale placements scenery uses.

**submeshes own their vertices**: each submesh's triangles are compacted to their own vertex range
and optimized there (vertex cache, then fetch order), indices stay local, and a submesh is one
`drawIndexed(indexCount, …, firstIndex, baseVertex)`. so indices are u16 whenever every submesh has
at most 65,536 vertices (`GeometryFlags.IndexU32` otherwise). quads are split; other topologies fail
conversion.

**UVs and textures are both unflipped**: Unity stores texel row 0 at v = 0, so does the package, and
a WebGPU upload of the bytes as they are samples correctly with the game's UVs.

## JSON tables

each is one zstd frame (level 9) around JSON. entry `i` has id `i`. an entry is either ready or an
`UnconvertedEntry` (`pending` when packed with `--no-assets`, `failed` with the reason in
`debug/assets.json`); draws referencing an unconverted entry are skipped.

| table        | contents                                                                                                                                                                                                                                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `geometries` | `ReadyGeometry`: blob, local bounds, vertex/index/submesh counts, attribute bitmask, `tangentUv`                                                                                                                                                                                                                      |
| `materials`  | `entries`: `ReadyMaterial` with its cull mode and its `surface` ([materials](#materials))                                                                                                                                                                                                                             |
| `textures`   | `samplers`, the distinct samplers as `GPUSamplerDescriptor` fields plus Unity's `mipBias`; `entries`, `ReadyTexture`: kind, WebGPU format, size, `depthOrArrayLayers`, mip count, sampler index, `pieces` coarse to fine                                                                                              |
| `water`      | see [water](#water)                                                                                                                                                                                                                                                                                                   |
| `lights`     | `LightEntry`: kind (spot, point), entity id, visibility group, position, direction, final linear colour, range, cone angles, tube length, soft source radius, falloff exponent, specular and volumetric scattering intensity, priority, camera-distance fade, culling box as a rows3x4 inverse; see [lights](#lights) |
| `particles`  | see [particles](#particles)                                                                                                                                                                                                                                                                                           |

### materials

each material is its cull mode and its `surface`: the extractor's interpretation of its serialized
state ([material and shader](game-data/assets.md#material-and-shader), decoded as
[extraction.md](extraction.md#asset-classes) describes) into what it draws
([surfaces.ts](../packages/package-format/src/surfaces.ts),
[game/material-describe.ts](../packages/extractor/src/game/material-describe.ts)). a surface is one
model with its inputs resolved (the Lit model, a matte painting, erosion rock, a dithered effect, a
texture stack, a lit decal, a water sheet, refraction, mist, a light beam, a portal's stencil mask),
with Unity property names, keyword rules, colour spaces and the shaders' formulas already applied;
`undrawn` for materials the game draws nothing visible with; or `unsupported` with the reason the
viewer can't draw it. textures are texture-table ids with their UV set and transform. the viewer
packs a surface into its draw parameters without reading Unity properties.

**rect decals**: a rect decal placement draws the game's VFXDecal cube with its material
([decals](game-data/materials.md#decals)), its colour and UV transform being its row's
[placement](#instance-block-inst-efin); its `litDecal` surface holds the material's `_DecalOpacity`,
which multiplies the placement's alpha.

**posed copies**: a prefab renderer whose placement's pose sets material values (an interactive's
settled view state; [view-state poses](extraction/prefabs-and-interactives.md#view-state-poses))
draws a copy of its material with those values in place of the saved ones.

### lights

the packer keeps the spot and point lights (a point with a positive length is a tube along its
direction) in `tables/lights.json.zst` ([pack/lights.ts](../packages/extractor/src/pack/lights.ts)),
with conditions from the scene states of the files holding them, like instances. lights in dynamic
structures' ECS groups load under their structure's visibility; a light the chunk files also hold
keeps its files' conditions. the packer reads the lights of every placed prefab with the same
settings ([game/prefab-lights.ts](../packages/extractor/src/game/prefab-lights.ts)), deriving the
colour the chunk files store precomputed (the sRGB colour made linear, times intensity and, when the
light uses one, the colour temperature's tint; see
[local lights](game-data/lighting.md#local-lights)). they load with their placement's visibility,
and their culling boxes, authored in the prefab's axes, turn with the placement (unchecked against
the game for turned cabins). directional, shadow-only and character-only lights aren't packed.

### water

`tables/water.json.zst` holds the [water](game-data/water.md) surfaces and the scene's global water
data. [pack/water.ts](../packages/extractor/src/pack/water.ts) plans the table before asset
conversion and fills in texture ids after it (`planWater` → `finishWater`, the same split as
environments); the decoders it reads through are in [extraction.md](extraction.md#water). the types,
with field-level JSDoc, are `WaterTable`, `WaterGlobal`, `WaterSector`, `WaterConfigEntry`,
`WaterConfig` and `WaterSurfaceEntry` in [water.ts](../packages/package-format/src/water.ts).

```
WaterTable
  global     WaterGlobal | null   null without water, or when the package holds no surface
  configs    WaterConfigEntry[]   { name, values } deduplicated by asset key
  surfaces   WaterSurfaceEntry[]  { kind: 'placed' | 'volume', entityId, group, geometry,
                                    transform, bounds, config, meshNormals,
                                    volume (kind 'volume') }
  volumes    WaterVolumeEntry[]   { entityId, base, heightMax, initial, fillSpeed,
                                    levels: { fraction, speed }[], control, parent,
                                    floaters: { blob, row }[] }
WaterGlobal  { mapSize, sectorSize, center, flowmapPrecision,
               flowMap, causticMap, normalMaps, rainMap, sectors: { x, z, texture }[] }
```

water is resident in the game (Global chunks only) and small, so the whole table ships in the core
archive and every surface is always available to the viewer.

packing rules:

- **chunk files**: only Global files are read, since no cell file holds water.
- **subset**: a surface is kept when the packer's `includesEntity(levelTag, centre x, centre z)`
  accepts its bounds centre, the same rule as instances.
- **configs**: loaded once per distinct asset key, keeping only what the
  [shading](game-data/water.md#shading) takes. the game's own transforms are applied here:
  `normalMipBias` is `(0.5 − envSpecularDesaturation) · 10`, `foamFadeRate` is
  `1 / foamFadeDistance` (the distance clamped to 1e-4 m), `largeWaveSignedSpeed` is
  `largeWaveFlowSpeed` negated by `largeWaveInvDir`, and the `useFlowMap` and `FlowmapOption` flags
  become booleans. a config missing a field the shading takes, or failing to load, drops its
  surfaces.
- **meshes**: interned into the geometry table and placed in the common asset archive, because
  surfaces are resident. no chain draws them, so no tangents are generated; polygon meshes come out
  with position and normal only.
- **transform**: the column-major matrix becomes rows3x4 like instance transforms, but absolute (no
  block origin).
- **mesh normals**: `meshNormals` is set on placed surfaces whose render type mask lacks the LOD bit
  ([placements](game-data/water.md#placements-initchunkdata-component-30)). LOD and volume surfaces
  are drawn facing straight up, a choice of ours: the game shades LOD surfaces with their mesh
  normals beyond its wave grid's reach
  ([how surfaces are drawn](game-data/water.md#how-surfaces-are-drawn)). the raw mask and `param1`
  (nothing reads them) stay in `debug/water.json`'s rows.
- **visibility groups**: each surface's `group` indexes `StatesInfo.groups`, the owning level tag
  and the scene states of the files holding it (`gateByScene` in
  [packer.ts](../packages/extractor/src/pack/packer.ts)), shared with instances, lights and
  environment volumes.
- **global maps** go to the common archive. **sector tiles** go to the asset archive of the
  shard-level tile under the sector's centre, so a region import carries the tiles it needs. full
  packages keep every sector with data and a tile; subset packages keep those overlapping a packed
  surface's bounds. sectors whose asset names no tile are counted in the pack report and listed in
  `debug/water.json` (`untiledSectors`).
- **errors** (failed configs, missing global binding, unresolvable maps or sectors) go to
  `debug/water.json` with per-surface rows (id, name, chunk file, mesh and config paths). they never
  fail the pack.
- surfaces aren't instances and don't count toward `LevelInfo.instances`.
- **water volumes** ([extraction](extraction.md#water)) become a `volume` surface each, with
  `volume` indexing `volumes`: the outline triangulated into a synthetic flat mesh at y = 0, raised
  by the transform to the authored fill, drawn with the volume's config, owned by its level and
  always loaded. a volume without a config, or whose config fails, is left out and listed in
  `debug/water.json`. `levels` are the authored fill and every constant fill the scene's scripts
  set, plus empty and full for a [pool the player pumps](game-data/water.md#depletable-pools)
  (finite factory water following no other volume), merged within 1e-4; each takes the speed of a
  script's fill-speed action just before moving the volume there, else the volume's (`fillSpeed`, in
  metres a second: the authored one for an infinite volume, converted from amount units for the
  rest). a volume with more than one fill gets a `waterLevel:<id>` control, its values indexing
  `levels` (labelled with the fill's percentage and height, and whether the level authors it or it's
  a pool's drained or full end). it defaults to the authored fill, or for a pool a quest needs
  drained (an objective's `CheckFluidVolume` at or under a twentieth of the pool), to empty, as in a
  finished story; its drivers say what runs each script action setting a fill, and the quests
  needing it drained, with that fill as their `value`. it gates no content, so it's kept as a
  consumer of the volume, with the volume's level tag. `parent` indexes the volume whose surface a
  basin follows (`null` when that volume isn't packed); a following volume has no control.
  `floaters` are the stored instance rows, as (block blob, row index), of the renderers of every
  interactive placement whose component 39 names the volume; the packer finds them by entity id once
  the blocks are stored, and lists a floater with no stored row in `debug/water.json`.

### particles

`tables/particles.json.zst`, `ParticlesTable`: the particle systems chain draws emit, equal ones
interned to one entry ([particles.ts](../packages/package-format/src/particles.ts), read as
[assets.md](game-data/assets.md#prefabs) describes). each `ParticleSystemInfo` keeps only modules a
viewer can evaluate from its emission time and its own random values: in closed form, or, under a
speed limit or force fields, by stepping the particle from its birth. values are Unity
`MinMaxCurve`s (a constant, a curve times a scalar, or random between two of either), colours
`MinMaxGradient`s (likewise, plus a random point of a gradient). a system draws its meshes, or a
unit quad (the chain draw's geometry) that its render mode turns to the camera, stretches along the
particle's velocity, or lays flat. an emitter is an ordinary instance row: its transform is the
system's frame and its bounds cover everywhere a particle reaches, so the row culls like any other.
a ring-buffered system's particles outlive their lifetime until replaced, their age held at its end
(while they move on) or looping part of it; a texture sheet names the flipbook tile each particle's
mesh UVs are remapped into. a system's `motion` is `free` (start speed, gravity, the velocity module
and the Limit Velocity module's drag or speed limit) or a `spline` its particles follow at its speed
instead.

a [spline mover](game-data/effects.md#spline-movers) packs as such a system
([spline-movers.ts](../packages/extractor/src/game/spline-movers.ts)): one entry per renderer of
each LOD group's first LOD, the mesh index naming the group, all at the mover's GameObject. its
start lifetime becomes seconds: the clamped fraction times the spline's length over the speed. a
mover with noise, rotation over lifetime, an alpha fade, another emission type, a lifetime or speed
curve, or more than four groups draws its first group once at its origin as a stand-in.

a `ParticleSystemRenderer` ([particle systems](game-data/effects.md#particle-systems)) whose
`ParticleSystem` plays on awake is packed one of three ways. mesh-mode renderers draw their meshes;
the others (billboard, stretched, horizontal, vertical) draw the render pipeline's unit quad
(`Packages/com.hg.render-pipelines/Runtime/RenderPipelineResources/Mesh/Quad.fbx`), which the packer
looks up once per scene.

**a frozen particle**, read as a plain mesh
([particle-mesh.ts](../packages/extractor/src/game/particle-mesh.ts)): the system allows one
particle and keeps it past its lifetime (`ringBufferMode` not 0), without a texture sheet. the
particle takes the renderer's `m_Mesh` and materials at the shape's centre, oriented by world, local
or (for a box shape, which emits along the emitter's forward axis) velocity alignment, then its
start rotation (Euler, Z then X then Y) and start size, offset by its
[pivot](game-data/effects.md#particle-systems) and scaled and placed as its scaling mode sizes and
moves played particles (below). random ranges between two constants take their midpoint, since the
game's draws can't be reproduced; curves and camera-facing alignments disqualify a system.

**a played system**, mesh or quad, when a viewer can play it from the package alone
([particle-system.ts](../packages/extractor/src/game/particle-system.ts)): the renderer becomes an
emitter whose draw names a particles-table entry, its matrix the emitter's world transform (with
only its own scale, not its parents', when `scalingMode` is Local) and its bounds a box around
everywhere a particle can reach. the matrix's scale moves the particles in every mode and sizes them
unless the mode is Shape. the entry keeps:

- the render mode, a stretched quad's length scale and velocity scale, a quad's on-screen size
  limits (`screenSize`, fractions of the viewport's width at its depth), and whether the matrix's
  scale sizes the particles (`sizedByScale`, false in the `Shape` scaling mode), so a viewer reads
  no scaling mode
- the duration, looping, start delay (a constant or two; a curve makes the system a stand-in),
  particle cap and simulation speed, and the emission bound: the most one longest lifetime of
  emission holds, the top rate times the lifetime plus each loop's top burst counts times the loops
  that lifetime spans. a system that stores a cap of 0
  ([particle systems](game-data/effects.md#particle-systems)) gets the bound as its cap
- the start lifetime, speed, size and rotation, gravity modifier and emission rate as
  `MinMaxCurve`s, the bursts, and the start colour and colour over lifetime as `MinMaxGradient`s.
  their curves and gradients are the `AnimationCurve` and `Gradient` of
  [`curves.ts`](../packages/package-format/src/curves.ts), which lens flares use too, with key times
  over 0–1 (the game stores gradient key times as 0–65535)
- the shape (sphere, hemisphere, cone, cone volume, box, circle, donut or mesh, with its radius,
  thickness, donut radius, angle, length, arc, placement and random-direction and -position
  amounts). a [mesh shape](game-data/effects.md#particle-systems) carries its mesh: positions (to
  0.1 mm), normals, the vertex colours as bytes when it uses them, and the primitives it emits from
  (three or two corners each), with its placement, vertex spawn mode, edge spread and normal offset.
  a shape texture, edge placement stepping by Loop or PingPong, and meshes the engine refuses or
  that mix lines and triangles stand in
- the velocity module (linear, orbital about an offset, radial and speed modifier, as curves too,
  though a speed modifier curve not alongside drag), and size and rotation over lifetime (curves
  too)
- the Limit Velocity module as the free motion's `clamp`: its drag when its `dampen` is 0 (the
  amount and whether it scales with the particle's size and its speed squared), or its speed limit
  when the dampen is above 0 (the `magnitude` curve and the dampen), when it limits the whole speed
  rather than each axis and the system has no drag. the viewer steps such particles at 30 Hz,
  applying the limit as [the game does](game-data/effects.md#particle-systems)
- the External Forces module as the free motion's `forces`: its multiplier and the sphere fields it
  feels within the same prefab (by list, by layer or both; wind zones and fields elsewhere in the
  scene aren't followed), each with its ranges, gravity focus, swirl tilt, curves and drag flags and
  `fromEmitter`, the emitter's matrix as seen from the field's (the inverse of the field's
  prefab-space matrix times the emitter's). a field of another shape or with a vector field makes
  the system a stand-in, as do force fields alongside drag; a multiplier scalar of 0 packs no
  forces, as the engine skips the module. the viewer steps such particles at 30 Hz too
- the render alignment (Facing is kept as View; Velocity too) and pivot, in multiples of the
  particle's size: a mesh particle's pivot is first multiplied by the mesh's size
  ([pivot](game-data/effects.md#particle-systems))
- the ring buffer mode and `ringBufferLoopRange`
- the texture sheet: `UVModule` in grid mode, up to 64×64 tiles, the whole sheet or one row (fixed,
  random or by mesh), timed over the lifetime by `frameOverTime` and `cycles` or by `fps`, offset by
  `startFrame`, both read as fractions of the frames, on the UV sets of `uvChannelMask`
- the custom data the second texture coordinate set holds: with `m_UseCustomVertexStreams`, the
  streams past position, normal, tangent and colour fill 4-wide sets in the renderer's order, and
  the components of `CustomDataModule`'s first stream (vector mode, up to `vectorComponentCount0`)
  that land in the second set are kept per component, the rest 0. colour mode and the second stream
  aren't packed. effect textures keep their `*UVSpeed.zw` as `customScroll` (0 where the shader
  doesn't shift by custom data); VFXDecal folds its `*CustomData` constants' shift into the offset

a renderer with several meshes (`m_Mesh` … `m_Mesh3`) becomes one emitter per mesh, its entry naming
which.

**a [stand-in](#stand-ins)**, for any other system, including those that don't play on awake (a
script starts them): its `m_Mesh` in mesh mode, else the unit quad as a `BillboardFacing` chain,
drawn once at the emitter's transform, sized as its scaling mode sizes particles. a placement's
scale moves stand-ins and frozen particles but sizes them only under Hierarchy, or Local on the
prefab's root: Jingyu's drifting petals, placed 52× in Shape mode, stand in petal-sized.

### stand-ins

content the game draws but the viewer can't is packed as `Unsupported` draws, so the viewer can mark
where something is missing. each is listed with why in the debug index's `stand-ins.json`
([extraction](extraction.md)):

| content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | drawn as                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| particle systems the viewer can't play ([above](#particles))                                                                                                                                                                                                                                                                                                                                                                                                                              | the system's mesh or a camera-facing quad at the emitter, scaled as its particles ([scaling](game-data/effects.md#particle-systems)) |
| skinned meshes whose skeleton can't be posed                                                                                                                                                                                                                                                                                                                                                                                                                                              | the mesh unposed, at its renderer                                                                                                    |
| skinned meshes with nonzero blend shapes                                                                                                                                                                                                                                                                                                                                                                                                                                                  | the mesh posed without them                                                                                                          |
| prefabs that can't be read (see `unsupported-prefabs.json`)                                                                                                                                                                                                                                                                                                                                                                                                                               | a 1 m cube on the placement's pivot, scaled with it                                                                                  |
| interactives whose template is missing or unreadable, or whose model id is unknown                                                                                                                                                                                                                                                                                                                                                                                                        | a 1 m cube on the placement's pivot, scaled with it                                                                                  |
| prefab renderers and particle systems under GameObjects switched off as saved (a script or view state switches them on; not those a placement's pose switches off, whose states are placed on their own, nor [one-shot effects](game-data/effects.md#one-shot-effects), GameObjects the prefab's own Animator never shows or those an [effect LOD table](game-data/effects.md#effect-lod-tables) lists, its own GameObject included, outside a view state's effects, which aren't packed) | the renderer as it would draw, or the particle stand-in above                                                                        |

the material still names what the game draws where it's known, and is `0xffffffff` otherwise. cubes
are a synthetic geometry (`synthetic:cube` in the debug index), a unit cube from −0.5 to 0.5 the
instance transform scales.

### textures (`.tex`)

texel data is the game's BC or float blocks unchanged: no transcoding, no container (no KTX2 at
runtime), sRGB taken from the texture itself rather than from the material. each texture is cut into
pieces ([textures.ts](../packages/extractor/src/pack/textures.ts)):

- the **tail**: the longest run of smallest levels totalling at most `TEXTURE_TAIL_BYTES` (64 KiB),
  as one blob. for BC7 that's up to 128², and the next level (256²) is itself 64 KiB, so no streamed
  piece is much smaller than this (per-request latency dominates below it) and one small read makes
  any texture drawable.
- **each larger level** as its own blob.

inside a piece, levels run largest first, each holding every layer, face and depth slice in
`writeTexture` order; `textureLevelLayout` gives sizes, `bytesPerRow` and `rowsPerImage`. every
piece is a whole czar member, so `czar verify` checks it. texture objects with identical shape,
format, sampler and texels share one entry.

## asset placement

geometry, material textures and other textures go to the asset archive of the **lowest common
ancestor** (at or above the shard level) of the tiles that use them, or to `common` for global uses
or uses under different root tiles
([asset-placement.ts](../packages/extractor/src/pack/asset-placement.ts)). everything a tile draws
therefore lives in the asset archives of that tile and its ancestors plus common, which suits a
region import into OPFS or CDN grouping. the viewer itself range-reads single blobs and ignores the
grouping. textures inherit the merged placement of the materials binding them; water and environment
textures are placed explicitly (see [water](#water)).

an asset used on both sides of a quadrant border climbs to the coarse ancestor. first-use or
majority placement would give smaller per-tile archives but lose the ancestor guarantee.

## conditions

`manifest.states` (`StatesInfo`, [states.ts](../packages/package-format/src/states.ts)) decides
which placed content shows. what the controls mean, how the packer derives their conditions and how
their defaults are chosen is in [scene controls](extraction/scene-controls.md), over the game's
[scene states](game-data/scene-states.md); this section covers the encoding and its evaluation, in
[conditions.ts](../packages/package-format/src/conditions.ts) (`resolveSceneValues`,
`conditionVisible`, `conditionResults`, `groupsShown`).

### visibility groups

every piece of placed content (instance blocks through their refs, lights, water surfaces,
environment volumes) names one `StatesInfo.groups` entry: the level that owns it (`levelTag`, 0 for
content every level shows) and the conditional set that loads it (`condition`, `null` for content
that always loads). the packer interns equal pairs into one group, and group 0 is always the shared,
always-loaded one. a viewer evaluates `groupsShown` once whenever a scene value changes, and every
consumer filters by that one array, so "is loaded" has a single definition. `groupsShown` reads only
the condition: the level tag orders and groups a viewer's listings but doesn't hide content.
environment volumes read the parts too: they apply wherever they hold the camera, whichever level
owns them.

### conditional sets

a `ConditionalSetInfo` is a list of alternatives (`alternatives: SceneRequirement[][]`, a
disjunction of conjunctions), each a list of `{ control, mask }` requirements; the content is
visible when any alternative has every requirement met (`conditionVisible`), and a requirement is
met when bit `value` of `mask` is set for the control's value. a missing or out-of-range value
fails, so a control absent from the manifest hides its content instead of showing it. groups store a
`condition` index into `conditionalSets`, `null` when always loaded.

- **masks**: an on/off requirement uses mask 2 (value 1); a quest or variable requirement the values
  its test accepts; a progression requirement the group's `logicState`; a facility form `1 << form`,
  a doodad form `1 << level`.
- **combined conditions** become alternatives by distributing conjunctions over disjunctions, with
  `reverse` pushed down to the tests (each test's mask complemented within its control's values);
  requirements on one control in a conjunction merge, and impossible conjunctions drop.
- **dynamic content**: one dynamic resource group yields the conjunction of its progression, logic
  or harvest requirement, its script requirement, its gates' requirements, one state from each
  visible-state list, and one `area:<id>` from each visible-area list without area 0. a model or ECS
  group referenced by several resource groups collects all their alternatives, so any complete
  alternative shows it.
- **file-gated content**: static renderers, lights and water surfaces of scene-state or stream-area
  files get one alternative per file holding them: the file's `sceneState:<index>` requirement, its
  `area:<id>` requirement, or both. environment volumes come from default-area files only, so they
  have state requirements alone.
- **interning**: the packer canonicalises and deduplicates sets (`Collector.condition`), so
  equivalent expressions share one index.

### controls

a `SceneControl` holds one piece of game state, and a viewer treats every control alike: it lists
the control in its section, offers its values and follows its source unless the user picks a value.
a control has its `id` (`<namespace>:<key>`), its `kind` (the game mechanism it stands for,
open-ended and descriptive only, see [scene controls](extraction/scene-controls.md)), a `name`, its
`category` (the section it lists under, one of `StatesInfo.categories`, which give each section's
title and note in listing order), the selectable `values` (each below 32, with a label), a
`default`, the `assumption` the default rests on, its `source`, the `levelTags` of the content it
gates (directly or through a derived control), which a viewer uses to list a control only for the
levels it matters to, a `story` place, its `drivers` and its `place`. a value is a quest's state, a
variable's range, a progression's level or form index, a water volume's fill index, or 0/1 for
on/off controls.

only controls something consumes are listed: a visibility group, a derived control that is listed,
or other content that follows the control's value (a water volume's surface follows its `waterLevel`
control). a derived control passes its level tags on to the controls it reads. every derived control
comes after the controls it reads in `controls`; the packer's
[control registry](../packages/extractor/src/pack/control-registry.ts) orders, prunes and finishes
them.

- **source** (`ControlSource`): `user` controls only change by a pick and otherwise hold their
  default. a `derived` control is 1 while `conditionalSets[condition]` holds and 0 otherwise, and
  its `rule` gives that condition in words (`RuleText`: text runs and references to the controls it
  reads, so a viewer names them without parsing; `ruleText` joins them); its stored `default` is its
  value under no picks. a `camera` control is set from the camera, which stands in for the player,
  by its `test` ([stream areas](#stream-areas), [proximity](#proximity)); its stored default only
  holds without a camera. `resolveSceneValues` turns the picks and the camera's values
  (`cameraValues` in [camera.ts](../packages/package-format/src/camera.ts)) into every control's
  value in one pass: a pick, else the camera's value or the default, then derived controls from
  their formulas in order.
- **story**: quest and mission controls of a known mission carry a `story` place (whether it holds a
  quest's or the mission's state, the mission id, the main-flow step); their values are then the
  game's quest and mission states. `StatesInfo.missions` names those missions (`MissionInfo`: name,
  quest log category, chapter, episode, where it takes place), so a viewer can group them; the names
  are the install's English text, extracted at pack time
  ([quest and mission labels](extraction/scene-controls.md#quest-and-mission-labels)).
  `StatesInfo.mainStory` lists the main story's missions in story order, which the extractor reads
  from their ids (`e<episode>m<mission>[d<decimal>]`, compared number by number), not from game
  data. [story.ts](../packages/package-format/src/story.ts) turns a point in an ordered mission list
  into consistent picks for all of them.
- **drivers**: what sets a control in game according to the level scripts (`ControlDriver`: quests,
  a switch, a trigger area, the script's area, another level, the server, another classified game
  event, or an `unknown` event by its game name), each with the value it sets and a position where
  it has one ([script groups](extraction/scene-controls.md#script-groups), [water](#water)); empty
  when nothing found sets it.
- **place** (`ControlPlace`): where the control matters: its `position` (the spot it stands for,
  such as an interactive or a cabin slot, else the centre of its content), the `bounds` of the
  placed content it shows, hides or poses (directly or through derived controls), and a `label`
  naming where that is ([places](extraction/scene-controls.md#places)). `null` when its content is
  spread over the scene or it has none of its own.

### stream areas

`StatesInfo.streamAreas` (`StreamAreasInfo`, `null` when no packed content lies in a non-default
area) holds the root list, each zone's list, and the zones' triggers (XZ box, height range, XZ
ring). content of an area requires its `area:<id>` control (value 0/1), a camera control with an
`area` test: a viewer runs the game's trigger test at the camera (`zonesAt`), turns the zones into
the areas shown (`areasShownIn`, [stream-areas.ts](../packages/package-format/src/stream-areas.ts))
and gives each area control 1 while its area is among them. the packer gates non-default-area
content by its areas and ships the table. which content a stream area gates is in
[extraction.md](extraction.md#how-the-packer-files-instances), and the game's areas in
[stream areas](game-data/world.md#stream-areas).

### proximity

a `proximity:<id>` control is a camera control with a `near` test: one or more reaches, a position
and a radius each. it is 1 while the camera, standing in for the player, is within the 3D distance
of any of its reaches and 0 beyond all. two kinds exist:

- `proximity:<interactive id>`: one reach around an interactive, whose away and near poses require
  its values 0 and 1 ([view-state poses](extraction/prefabs-and-interactives.md#view-state-poses))
- `proximity:volume:<script id>:<slot id>`: a level script's trigger volume, a reach per sphere.
  script groups the script shows and hides as the player enters and leaves it derive from it
  ([what sets a script group](game-data/scene-states.md#what-sets-a-script-group))

## versioning

`PACKAGE_VERSION` ([manifest.ts](../packages/package-format/src/manifest.ts)) is written to
`manifest.version` and covers the manifest, the JSON tables and how the parts fit together. each
binary encoding (tree, chains, blob table, irradiance table, instance blocks, height, surface and
splat pages, geometry blobs) carries its own version in its header, next to its codec. readers
accept exactly the versions they know and reject any other, and nothing migrates old packages: a
package from another version is re-extracted. bump the package version on any incompatible change to
the manifest or a table, and an encoding's version when its layout changes. the JSON tables carry no
version of their own and are trusted once the manifest's version matches.

the [pack cache](extraction.md#pack-cache) fingerprints the converter's code, which imports only the
`geometry`, `textures` and `blobs` modules of `package-format` (and the helpers they share).
versioning encodings separately keeps it that way: a change to the manifest, the tree or instance
blocks leaves cached mesh and texture conversions valid.

## reading a package

a reader reads `core.czar` whole, checks `format` and `version` before anything else, decodes the
binary tables and inflates the JSON ones. a non-core blob is the byte range
`[dataOffset + offset, + length)` of its archive (`blobRange` in the viewer), so reads can be
coalesced; the archive's `size` from the manifest lets a reader notice an archive replaced by a
re-pack. range reads skip czar's CRC; `czar verify` checks an archive's members when needed. the
core's blobs are the same ranges of the core's bytes, from its first member's position. the viewer's
sources, decode workers and zstd decoder are in [loading](viewer/loading.md).

## debug

`debug/` is described in [extraction.md](extraction.md#report-and-debug-outputs). per-asset
provenance lives there rather than in the manifest, which only identifies the build.

## alternatives ruled out

- **3D Tiles / glTF tiles**: each glb re-embeds shared meshes, so tiles can't share them without
  external buffers, and HGRP materials don't map onto glTF loaders. the package keeps the concepts:
  implicit quadtree, screen-space-error refinement, REPLACE.
- **Draco**: slightly smaller positions than meshopt, but several times slower to decode, a ~300 KB
  wasm decoder, reordered vertices (breaking cache/fetch optimization and index-aligned side data)
  and nothing for instance tables. for scale, Jingyu's 645 LOD0 meshes are 83.2 MB as f32, 41.6 MB
  quantized, 19.1 MB after meshopt and 11.1 MB after zstd 19 (brotli 10.7, gzip 12.0).
- **cluster hierarchies (Nanite-style)**: the scenes are instancing-dominated (map02: ~470k
  instances of ~21k meshes, ~5k unique at LOD0) and ship discrete LODs and HLODs; WebGPU lacks mesh
  shaders and 64-bit atomics.
- **hash-digit asset shards**: no spatial locality; assets follow the
  [lowest common ancestor](#asset-placement) instead.
- **czar's own member index** in place of [`tables/blobs.bin`](#containers-and-blobs): `ArchiveFile`
  exposes no member offsets or sub-range reads, CRCs cover whole members only, members can't be
  compressed individually, and opening an archive reads its whole JSON header.
- **texture arrays or virtual texturing at pack time**: one entry per texture; the viewer builds
  arrays at runtime where it wants them.

## open

- **geometricError** is a placeholder the viewer uses only for request priority; the HLOD rings
  replaced it for refinement.
- **instance compression**: meshopt filters or quantized rows could roughly halve instance blobs.
- **detail placement by centre**: a very large object at a leaf disappears while that leaf shows its
  HLOD, unless the HLOD covers it, as the game assumes.
- **tiny shards**: off-square edges produce sub-KB shards that could merge into a neighbour.
- **common archive size**: global scenery pulls its assets into `common`; placing global content by
  its own bounds would spread it.
- **texture size**: textures at native resolution dominate package size; a cap that drops leading
  levels would make a lite package.
- **terrain cliffs**: the cliff-index pages and cone maps, which the game's cliff projection and
  parallax use, aren't packed.
- **unsupported**: line and point topologies; a looping clip's material values hold their end value;
  the game's packed tangent bits are undecoded (generated tangents replace them); terrain decals are
  skipped.
