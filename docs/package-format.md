# viewer package format

`pnpm -s extract pack <scene>` writes one streaming scene (one world, one coordinate frame) as czar
archives of content-addressed blobs and tables. see [extraction](extraction.md#pack) for packing,
[loading](viewer/loading.md) for reading, and [game-data](game-data/) for source formats.

`packages/package-format` defines the shared types and binary codecs (its JSDoc is authoritative)
and has no Node API or workspace dependencies.

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
    tables/geometries.bin.zst     geometry table
    tables/materials.json.zst     material table
    tables/textures.bin.zst       texture table
    tables/water.json.zst         water table
    tables/lights.bin.zst         local lights (EFLT TLV)
    tables/reflection-probes.bin.zst  local reflection probes (EFRP TLV)
    tables/cloth.bin.zst          GPU cloth simulation table (EFCT TLV)
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
    blobs/<cell key>/<hash>.iv        (a room's own bake: blobs/<hash>.iv)
  debug/                              provenance; never loaded by the viewer
```

- **archive naming**: `CORE_PATHS` lists the core's fixed members. all other archives use
  `<stem>[.<part>]-<id>.czar` (`archiveName`), where `<stem>` is the group (`shardStem`,
  `assetStem`, `irradianceStem`) and `<id>` is the first 16 hex digits of the SHA-256 of the czar
  header. `manifest.archives` lists entry 0 as the core, followed by all other archives sorted by
  name, each with its `role` (`core`, `shards`, `assets`, `irradiance`) and `tile`.
- **locality**: czar stores members in path order, so `blobPath` prefixes blobs read together with a
  content-derived locality key (enabling range
  [coalescing](viewer/streaming.md#residency-and-budgets)):
  - tile terrain pages and instance blocks: tile level + Morton(x, z)
  - texture pieces: `<tailHash>.<i>`, coarse to fine
  - irradiance cells: cell key
  - meshes, core instance blocks, room irradiance bakes, terrain layers: no key
- **parts**: groups exceeding 1 GiB split into a power-of-two number of parts (0.5–1 GiB each,
  within the u32 4 GiB offset limit) by the top bits of a hash of each blob's locality set (prefix
  before the first `.`, or own hash). co-read blobs stay in one part, and part membership stays
  stable across incremental updates.
- **reuse**: repacking hard-links any unchanged archive (matching name and size) from the replaced
  package, falling back to a CoW clone (APFS, Btrfs, reflinked XFS), then a copy.
- **replacing**: the packer refuses an output directory containing non-package files. it stages into
  `.<out>.staging` (using `.spool` when no pack cache exists) and atomically renames into place on
  success.

## containers and blobs

archives use **czar** ([`@mary-ext/czar`](https://www.npmjs.com/package/@mary-ext/czar)): magic,
JSON header (path, offset, size, CRC-32), and 16-byte-aligned member data in path order.
`tables/blobs.bin` stores each blob's archive, data-section offset, and lengths so readers
range-read blobs without fetching shard JSON headers.

- **blob identity**: first 128 bits of the SHA-256 of the **stored** (post-codec) bytes as 32
  lowercase hex digits; member path `blobs/[<locality>/]<hash>.<ext>` (`blobPath`). duplicate stored
  bytes share one blob in the archive and locality of first use.
- **codec** (`BlobCodec`): `0` none, `1` single zstd frame. zstd is kept only when it saves at least
  1/32 of the bytes ([settings](extraction.md#asset-conversion-and-workers)).
- **offsets**: u32 (max 4 GiB per archive).
- **core offsets**: `ArchiveInfo.dataOffset` is `null` for `core.czar`. readers load the core whole
  and measure core blob offsets from the first member's byte offset. `blobs/…` sorts before all
  fixed members so blob offsets never depend on table sizes.
- **generation**: `manifest.generation` hashes the core's binary and table members (excluding the
  manifest). equal generations guarantee identical tables for cache keying.
- **determinism**: blob compression and hashing run concurrently, while blob indices are assigned in
  deterministic input order.

## coordinates

all geometry and transforms use Unity's coordinate frame: left-handed, +Y up, +Z north, metres.
right-handed consumers apply `scale(1, 1, -1)` at the root and reverse front-face winding. the
viewer keeps Unity coordinates in its projection.

- transforms are `rows3x4`: top three rows of object-to-world, row-major (matches WGSL
  `array<vec4f, 3>`).
- instance translations and bounds centres are relative to their block's origin to preserve f32
  precision.

## tile tree

`TreeInfo` defines a quadtree forest on an unbounded grid matching the game's
[terrain](game-data/terrain.md) quadtree. `origin` and `rootSize` are the terrain square's corner
and edge (4096 m centred on the origin when there is no terrain). level `l` tiles have edge
`rootSize / 2^l`. `(l, x, z)` may be negative or `≥ 2^l` for off-square content. terrain page keys
equal tree keys.

| level           | role (map02: 4096 m root)                                    |
| --------------- | ------------------------------------------------------------ |
| `leafLevel`     | 64 m: terrain leaves, detail leaves, HLOD tier 0             |
| `cellLevel`     | 128 m: game streaming and level-ownership cells, HLOD tier 1 |
| `hlodLevels[2]` | 256 m: HLOD tier 2                                           |
| `shardLevel`    | `max(0, leafLevel − 3)` (512 m): groups shard archives       |

`hlodLevels[t]` is `leafLevel − t` (or one level coarser when HLOD0 cells are 128 m). the packer
fits the scene's [HLOD grid](game-data/world.md#lod-and-hlod) to cluster names
(`HLOD<tier>_<i>_<j>_Cluster_…`, failing if < 80% match), snaps it to tree tiles within 8 m, and
attaches each cluster to its named cell rather than its bounds centre. when multiple tiles qualify
(axis named `0`, which clamps negative coordinates, or a tier offset by half a cell), the packer
picks the candidate holding the most always-loaded detail instances inside the cluster's bounds
(falling back to the candidate nearest the centre).

**refinement contract** (REPLACE at HLOD-cell granularity):

- outside a node's HLOD tier ring ([HLOD rings](game-data/world.md#streaming-layers)): draw its
  coarse content.
- inside the ring: refine to children; a refined leaf draws its `Detail` blocks (per-instance LOD
  uses chain thresholds).
- `Conditional` blocks have no HLOD stand-in. they draw within the detail ring regardless of
  refinement, or while the camera is inside their world XZ `reach`
  ([instance selection](viewer/streaming.md#instance-selection)). dynamic structures receive the 3×3
  cell reach of their [load grid](game-data/world.md#dynamic-load-grids) (infinite at clamped frame
  edges).
- global content (Global chunk scenery) draws whenever its group shows and is never replaced.
- `geometricError` (`edge / 16`, 4 m at 64 m leaf) orders requests only.

see [extraction.md](extraction.md#how-the-packer-files-instances) for how entities map to these
categories.

**content refs** (`ContentRef`, `ContentKind`):

| kind                 | points at                                                                 | `tier`    | `reach`                  |
| -------------------- | ------------------------------------------------------------------------- | --------- | ------------------------ |
| `TerrainHeights` (0) | one height page                                                           | 0         | `null`                   |
| `Hlod` (1)           | rows `[first, first + count)` of a group's shared HLOD block              | HLOD tier | `null`                   |
| `Detail` (2)         | whole instance block replaced by HLODs                                    | 0         | `null`                   |
| `Conditional` (3)    | whole instance block without HLOD stand-in (scene-state, dynamic content) | 0         | `null` or camera's reach |
| `TerrainSurface` (4) | one surface page covering the same tile as the height page                | 0         | `null`                   |
| `TerrainSplat` (5)   | one leaf splat page                                                       | 0         | `null`                   |

every ref names a [visibility group](#visibility-groups); terrain uses group 0. detail and
conditional blocks are one per `(leaf, group, reach)`, filed under the leaf containing each
instance's bounds centre. HLOD and global rows form one block per group in `core.czar`, with HLOD
rows sorted by node into contiguous runs. global refs follow node refs in `tree.bin` with kind
`Detail`; scene-state Global chunks become conditional global blocks.

## manifest

`manifest.json.zst` (`PackageManifest`, zstd-compressed JSON):

| field                                              | contents                                                                                                                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format`, `version`                                | `'endfield-noclip.package'`, `PACKAGE_VERSION` (major version 2, [versioning](#versioning))                                                                    |
| `minReaderVersion`, `features`, `requiredFeatures` | forward-compatibility envelope validated by `validateManifest`                                                                                                 |
| `generation`                                       | hash of core binary and table members ([containers and blobs](#containers-and-blobs))                                                                          |
| `source`                                           | bundle manifest build guid and content hash                                                                                                                    |
| `scene`                                            | streaming scene id and display name                                                                                                                            |
| `subset`, `maxTextureSize`                         | `--level` / `--bounds` filter, and optional `--max-texture-size` lite-package cap                                                                              |
| `archives`                                         | `ArchiveInfo[]` by `role`: core (name only), or streamed archive (name, size, `dataOffset`, tile for shards/assets)                                            |
| `tree`                                             | `TreeInfo`                                                                                                                                                     |
| `terrain`                                          | `baseHeight`, `heightScale`, levels with pages, close-up `splat`; `null` without terrain                                                                       |
| `levels`                                           | every level of the scene (even in subsets): id, name, rect, `playerInitPos`, owned `cellLevel` cells, packed instance count, `contentBounds`, base environment |
| `states`                                           | scene controls, conditional sets, visibility groups, stream areas, missions ([conditions](#conditions))                                                        |
| `irradianceRegions`                                | room irradiance bakes ([irradiance cells](#irradiance-cells))                                                                                                  |
| `fireSeed`                                         | [fire seed](game-data/effects.md#invisible-bridges) control and global reveal radii per value (`FireSeedInfo`), or `null` when no level script sets it         |

`levels` contains only the scene's own map's levels (non-overlapping). a group's `level` indexes
`levels` (`null` = shared; entity-id level tags stay in the extractor, [world](extraction.md#world),
and unowned tags count as shared). each level's rect and `playerInitPos` come from
[LevelConfig](game-data/world.md#levelconfig) (`rectLeftBottom`, `rectRightTop`, `playerInitPos`)
and drive initial camera framing.

## binary encodings

all v2 binary tables and blobs use the shared FourCC TLV container: a 16-byte little-endian header
(`u32 magic, u16 majorVersion, u16 flags, u32 sectionCount, u32 reserved`), a `sectionCount × 24`
directory (`u32 tag, u32 flags, u32 offset, u32 byteLength, u32 count, u32 stride`), and
16-byte-aligned payloads (enabling zero-copy typed-array views). unknown optional sections are
skipped, unknown `Required` sections fail explicitly, and fixed-stride record sections advance by
`stride` so trailing fields added later don't break older readers. `.bin.zst` tables are single zstd
frames; `.bin` tables are uncompressed.

| member                             | magic                    | sections                                                                                                                                                                                                                                                           |
| ---------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tree.bin`                         | `EFTR`                   | `NODE` (52 B, includes `parent: i32`), `REFS` (24 B, includes `streamingLayer`), `GLOB` (24 B), optional `RCHS` (16 B), optional `HLOD` (16 B cluster links)                                                                                                       |
| `tables/chains.bin`                | `EFCH`                   | `CHNS` (16 B, includes `u64 contentHash`), `DRWS` (32 B, includes `sortingBand`), optional `DORG` (16 B: `chainIndex` + `distanceOrigin`)                                                                                                                          |
| `tables/blobs.bin`                 | `EFBX`                   | `BLBS` (16 B: `kind`, `codec`, `archive`, `offset`, `length`, `rawLength`)                                                                                                                                                                                         |
| `tables/irradiance.bin`            | `EFIV`                   | `KEYS` (`u32[]`), `BLBS` (`u32[]`), `GRPS` (`u32[]`)                                                                                                                                                                                                               |
| `tables/geometries.bin.zst`        | `EFGE`                   | `GEOM` (44 B records, [asset tables](#asset-tables))                                                                                                                                                                                                               |
| `tables/textures.bin.zst`          | `EFTX`                   | `SAMP` (12 B), `TEXS` (20 B, includes `droppedMips`), `PCES` (8 B) ([asset tables](#asset-tables))                                                                                                                                                                 |
| `tables/lights.bin.zst`            | `EFLT`                   | `LGHT` (100 B), optional `SHDW` (32 B), optional `CBOX` (52 B)                                                                                                                                                                                                     |
| `tables/reflection-probes.bin.zst` | `EFRP`                   | `PRBS` (140 B: group, texture, importance, shape, flags, intensity, bounds, half-extents, `invBlendDistance`, `worldToLocal`, luminance L1 SH)                                                                                                                     |
| `tables/luts.bin.zst`              | `EFLU`                   | optional `CRVH`/`CRVS`, `GRDH`/`GRDS`, `PMSH`/`PMPO`/`PMNM`/`PMCL`/`PMPR`/`PMCD` (particle shape meshes + precomputed area CDFs)                                                                                                                                   |
| `tables/assemblies.bin.zst`        | `EFAS`                   | `ASMB` (20 B), `NODE` (56 B), optional `STAT` (12 B) (moving/stateful prefab assemblies)                                                                                                                                                                           |
| `tables/cloth.bin.zst`             | `EFCT`                   | `HEAD` (16 B: `blob`, `windNoiseTexture`, `clothCount`, `totalNodes`), `CLTH` (12 B: `hash`, `nodeOffset`, `nodeCount`)                                                                                                                                            |
| `.inst`                            | `EFIN`                   | `HEAD`, optional `PLTT` (`u64[]` chain hash palette), `CHNS`, `XFRM`, `BNDS`, optional `FLAG` (`RowFlags`), optional `HLOD`, optional sparse `DECL`/`SPIN`/`FLOT`/`RIDE`/`MOTN`/`LODG`/`ASMB`/`CLTH`, optional `PATH`                                              |
| `.clth`                            | `EFCL`                   | `HEAD` (16 B: counts), `META` (176 B `ClothMetaData`), `BTCH` (16 B `vec4i` batch pairs), `CACH` (16 B `vec4u` cache pairs), `NODE` (192 B `ClothNodeData`)                                                                                                        |
| `.mesh`                            | `EFGM`                   | `HEAD`, `STRM` (36 B), `SUBM` (40 B), `VBUF`, `IBUF`, optional `ANIM`                                                                                                                                                                                              |
| `.hgt` / `.tsp` / `.tsl`           | `EFHT` / `EFTS` / `EFSL` | `HEAD` + `HGTS` / (`ALBD`, `NORM`) / (`CTRL`, `TINT`, `INDX`)                                                                                                                                                                                                      |
| `.anim`                            | `EFAN`                   | `HEAD` + kind-specific section (`SKIN`, `TRNS`, `SPIN`, `FLOT`, `VATC`, or `MATR` + `MSMP`)                                                                                                                                                                        |
| `.fol`                             | `EFFL`                   | `HEAD`, optional `PLTT` (`u64[]`), `CLST` (40 B), `INST` (24 B quantized grass instances: `u16×3` position in cluster AABB, `u16×3` smallest-three quaternion + mirrored flag, `f16×3` scale, `u8×4` custom param), optional `SPST` (`f32[]` per-cluster sparsity) |

tree nodes sort coarse to fine (`level`, `z`, `x`). children of `(l, x, z)` are
`(l + 1, 2x + dx, 2z + dz)`. node bounds enclose the node, its descendants, and overhang.

**chains** are LOD-chain templates deduplicated by ordered draws and f32 threshold bit patterns,
sorted deterministically by 64-bit `contentHash`. `.inst` blocks store a local `PLTT` (`u64[]`) of
the chain hashes they reference so their bytes are independent of global chain numbering across
packs; decoders remap local palette indices to global chain IDs.

- **thresholds**: a draw is active while `minSquared < s² ≤ maxSquared`, where `s` is Unity's
  screen-relative height (negative `minSquared` disables size culling). the viewer computes `s` as
  `2 · maxHalfExtent / distance` relative to screen height. prefab renderers under an enabled
  `LODGroup` emit one draw per active `screenRelativeHeight` span (evaluated against the row's own
  bounds).
- **roles**: `Lit`, `ShadowOnly` (from ECS flag bit 10 or prefab shadow-casting mode), and
  `Unsupported` ([stand-ins](#stand-ins)). HLOD clusters use `Lit` under a `Hlod` tree ref.
- **draw flags** (`ChainDrawFlags`): `CastsCascades` (sharp cascades) and `CastsStatic` (cached far
  map). static draws read them from the renderer flag word ([lighting](game-data/lighting.md));
  prefab, decal, and stand-in draws set both.
- **`material` / `particles`**: `0xffffffff` decodes to `null` (unknown stand-in material, or
  non-particle draw). otherwise `particles` indexes `tables/particles.json.zst`.
- **`sortingLayer` / `sortingOrder`**: prefab `m_SortingLayer` / `m_SortingOrder` (used by the
  transparent pass before distance); `0` for static draws.
- **billboards**: `BillboardFacing` (mode 0), `BillboardUpright` (other `VFXBillBoard` modes, around
  world +Y), and `BillboardAxial` (view-aligned `LineRenderer` ribbons, around local +X) mark
  camera-relative rotation; stored bounds enclose all orientations
  ([billboards](game-data/assets.md#billboards)). the transform stores the offset times the
  renderer's rotation relative to the billboard at the renderer's own position.
- **`CameraDistance`**: thresholds are squared camera distances (m²) measured from the chain's
  instance-space distance origin transformed to world space. used for prefab
  [effect LOD tables](game-data/effects.md#effect-lod-tables) (origin at the effect GameObject,
  rounded to 1 mm) and static component-58 [distance LODs](game-data/world.md#lod-and-hlod) (origin
  at LOD centre). switches without fade. dynamic-structure effects follow their LOD proxy instead,
  placing one copy per proxy-level [reach](#tile-tree) rectangle.

### asset tables

`tables/geometries.bin.zst` and `tables/textures.bin.zst` store fixed-size records read in place.
ID = array index. `EntryStatus`: `0` ready, `1` pending (`--no-assets`), `2` failed (reason in
`debug/assets.json`). unconverted records are zeroed and skipped by draws.

- **geometries**: `.mesh` blob id, local bounds, vertex/index/submesh counts, `VertexAttribute`
  bitmask, `tangentUv` (`0xff` if no generated tangents), and `animationFrames` (`0` for static).
- **textures**: `kind` (`TEXTURE_KIND_CODES`: `0` `2d`, `1` `cube`, `2` `2d-array`, `3`
  `cube-array`, `4` `3d`), `format` (index into `TEXTURE_FORMAT_CODES` → WebGPU name in
  `TEXTURE_FORMATS`), dimensions, `depthOrArrayLayers`, `mipCount`, `sampler` palette index, and
  pieces `[firstPiece, nextFirstPiece)` sorted coarse to fine ([textures](#textures-tex)). sampler
  codes: address modes `0` `repeat`, `1` `clamp-to-edge`, `2` `mirror-repeat`; filters `0`
  `nearest`, `1` `linear`; plus Unity `mipBias`.

### irradiance cells

every cell whose centre lies in the package—from the base bake and every MapConfig scene-state
bake—packs as a zstd-compressed decompressed `Irradiance` blob in `irradiance/<x>_<z>-<id>.czar`
(512 m squares), keeping the game's GPU layout
([cells and probes](game-data/irradiance.md#cells-and-probes)).

- `tables/irradiance.bin`: ascending cell keys (shifted to one origin,
  [parser](extraction.md#irradiance)), blob indices, and visibility groups. duplicate keys list
  scene-state bakes first (most states first, requiring all states active;
  [scene-state bakes](game-data/irradiance.md#scene-state-bakes)), then the base bake under group 0.
  readers take the first entry for a key whose group is visible.
- `manifest.irradianceRegions`: `IrradianceRegionInfo[]` (visibility group, probe grid origin and
  size, `.iv` blob) for room bakes that override the finest clipmap probes inside their grid while
  visible ([region bakes](game-data/irradiance.md#region-bakes),
  [Dijiang cabins](extraction/scene-controls.md#dijiang-cabins-and-region-walls)).

### instance block (`.inst`, `EFIN`)

44-byte header: `u32 magic, u16 version, u16 0, u32 count, f32×3 origin`, four `u32` row-section
counts (`decals`, `spins`, `floaters`, `rides`), and `u32 pathCount`.

struct-of-arrays sections of `count` elements follow:

- `u32 chain`
- `f32×12 transform` (`rows3x4`, translation relative to `origin`; full 3×4 preserves Unity shear
  and non-uniform scale)
- `f32×6 bounds` (world AABB centre relative to `origin`, then half-extents)

sparse **row sections** (`RowSection`: ascending `u32` row indices, then fixed 32-bit values per
row):

- **decals**: `f32×8` — RGBA8 colour (RGB premultiplied by intensity), UV scale and offset for
  `local.xz + 0.5`.
- **spins** ([spinning scenery](game-data/animation.md#spinning-scenery)): `f32×7` — pivot relative
  to `origin`, unit axis, speed (rad/s). at time `t`, transform and bounds centre rotate `speed · t`
  around the axis through the pivot (`Quaternion.AngleAxis`); stored half-extents still bound by
  sphere. tree bounds enclose the swept cylinder.
- **floaters** ([floaters](game-data/water.md#floaters)): `u32` — index into `water.volumes`. row
  shifts vertically with that volume's delta from its packed fill ([water](#water)).
- **rides** ([auto-moving platforms](game-data/interactives.md#auto-moving-platforms)): `u32` —
  index into the block's paths. mutually exclusive with float and spin.
- **cloth** (`CLTH`, [cloth simulation](game-data/materials.md#cloth-simulation)): `u32` — index
  into `tables/cloth.bin.zst` (`CLTH` entry). maps a `clothSimulated` row to its GPU cloth's
  skeleton range.

**paths** (`RowPath`): `f32 frameRate, u32 frameCount`, then `f32×3` world-axis metre offsets per
frame from the row's stored translation. at time `t`, evaluate frame
`(t · frameRate) mod frameCount` with linear wrap interpolation (`pathOffset`); rotation and scale
stay fixed. stored transform is the pre-departure placement. tree bounds cover the full path; rows
file under the leaf at the reach's midpoint.

`origin` is the leaf's min corner (`y = 0`) for detail blocks and the tree origin for core blocks.
rows sort by `(HLOD node, chain)`. `debug/instances.jsonl` maps rows to source entities.

### height page (`.hgt`, `EFHT`)

8-byte header: `u32 magic, u16 version, u16 side`. followed by `side²` u16 samples (rows along +Z)
split into two byte planes (all low bytes, then all high bytes) of zigzag deltas:

- predictor: `left + above − aboveLeft` (first row: `left`; first column: `above`; `(0, 0)`: `0`),
  wrapping at 16 bits to preserve the hole bit.
- decode (`terrainHeight`, `isTerrainHole`): `y = baseHeight + (h & 0x7fff) · heightScale / 32768`.

all pyramid levels are packed for native CDLOD; node bounds span non-hole samples. `maxHeightError`
is omitted ([terrain](game-data/terrain.md#tiles-and-placement)). scenes with terrain tiles but no
`HGTerrainSurfacesData` fail the pack.

fixed format constants (validated by the packer): `TERRAIN_PAGE_SAMPLES` (65), `TERRAIN_HOLE_BIT`,
`TERRAIN_SURFACE_TEXELS` (132), `TERRAIN_SURFACE_BORDER` (2), `TERRAIN_LEAF_METRES` (64),
`TERRAIN_SPLAT_CELL_METRES` (8).

### surface page (`.tsp`, `EFTS`)

8-byte header: `u32 magic, u16 version, u16 side`. followed by two BC3 images of `side²` texels
(rows along +Z, `writeTexture` block order, 1 mip each): albedo (`A`) then normal (`N`)
([channels](game-data/terrain.md#tiles-and-placement)).

`side` is `TERRAIN_SURFACE_TEXELS` (132) with `TERRAIN_SURFACE_BORDER` (2) outer texels per edge:
`u = border / side + (x − tile.minX) / tile.size · (side − 2 · border) / side`. tiles missing either
page omit the ref and log to `debug/terrain.json`.

### splat page (`.tsl`, `EFSL`) and layer textures (`.tly`)

12-byte header: `u32 magic, u16 version, u16 side, u16 cells, u16 0`. followed by:

1. `S` page RGBA8 texels (`side²`)
2. `T` page BC3 sRGB blocks
3. `cells²` cells × 4 layer ordinals, row-major from the leaf's min corner

images share the surface page's layout ([close-up layers](game-data/terrain.md#close-up-layers)).
leaves missing either page omit the ref and log to `debug/terrain.json`.

`terrain.splat` (`TerrainSplatInfo`) stores the named layer table (repeats/m, offsets, mean colour,
scales, remaps), `textureSize`, `textureLevels`, and `TerrainLayer` blob refs (raw BC7 levels
largest-first, `< 4²` padded to 1 block; top 1024² level dropped, starting at 512²) in
`assets/terrain-layers-<id>.czar`. `splat` is `null` if layer data is missing or inconsistent
(`debug/terrain.json` `layerProblem`).

### geometry blob (`.mesh`, `EFGM`)

- **32-byte header**:
  `u32 magic, u16 version, u16 flags, u32 vertexCount, u32 indexCount, u16 streamCount, u16 submeshCount, u32 indexPayloadLength, u32 animationLength, u32 0`
- **32-byte stream records**:
  `u8 attribute, u8 format, u8 flags, u8 0, u32 payloadLength, f32×3 offset, f32×3 scale`
- **40-byte submesh records**:
  `u32 firstIndex, u32 indexCount, u32 baseVertex, u32 vertexCount, f32×3 min, f32×3 max`
- **payloads**: meshopt-encoded (codec v1, no filters) stream buffers, index buffer, then optional
  animation. `package-format` treats payloads as opaque; the viewer decodes with `meshoptimizer`.

**animated geometry** (`SkinAnimation`): bind-pose streams with bone weights/indices (rigid meshes
bind all vertices to bone 0 at weight 1). animation payload:

- 32-byte header: `u16 boneCount, u16 frameCount, f32 frameRate, f32×3 offset, f32×3 scale`
- `frameCount × boneCount` `rows3x4` f32 matrices (frame-major, bind space → draw space)

at time `t`, frame `(t · frameRate) mod frameCount` blends linearly into the next (wrapping last →
first): `Σ weight · matrix · bindPosition`. `offset + [0, 1]³ · scale` encloses all frames and is
stored as the geometry table's `bounds`; `animationFrames > 0` indicates an animation payload.

each stream is one vertex buffer, numbered by Unity's `VertexAttribute`:

| attribute  | format                                                                                                                                                                                                                         | notes                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| 0 position | `unorm16x4` (xyz dequantized to mesh AABB) when animated or span ≤ 4 m, else `float32x4` (identity transform); w = sway/offset weight (vertex alpha, or 1 without colour) when a swaying/alpha-offset material uses it, else 0 | depth passes read position W directly without fetching colour; float32 keeps closely offset trim separated on wide meshes |
| 1 normal   | `snorm16x2` octahedral, shader-decoded                                                                                                                                                                                         | 10-bit octahedral sources keep exact integers with dequant scale `32767/511`; float normals encode at 16 bits             |
| 2 tangent  | `snorm8x4`: oct `xy`, bitangent sign `z`                                                                                                                                                                                       | source tangents or MikkTSpace-compatible (`meshoptimizer`) generated only when bound to a normal-mapped material          |
| 3 color    | `unorm8x4`, or `float16x4` if values leave `[0, 1]`                                                                                                                                                                            |                                                                                                                           |
| 4–11 UV0–7 | `unorm16x2` dequantized when span ≤ 16, else `float32x2`; 8-bit sources keep `snorm8x4`/`unorm8x4`; > 2 components use `float32x4`                                                                                             |                                                                                                                           |
| 12 weights | `unorm16x4`, summing to 1                                                                                                                                                                                                      | animated geometries only                                                                                                  |
| 13 bones   | `uint8x4`, or `uint16x4` past 256 bones                                                                                                                                                                                        | animated geometries only (up to 65,536 bones)                                                                             |

- **tangents**: normal-mapped materials are detected by shader `[Normal]` flags (fallback: slot name
  containing `normal` or `bump`). tangents use Unity's left-handed frame
  (`bitangent = cross(n, t) · sign`); the shader multiplies `sign` by the world matrix determinant
  sign for mirrored instances. vertices split across mirrored UV seams.
- **swaying and vertex-offset bounds**: swaying meshes
  ([swaying cloth](game-data/materials.md#swaying-cloth),
  [pendulums](game-data/materials.md#swinging-pendulums)) expand table `bounds` by
  `weight · (flat + perHeight · |y|)` in XZ and `weight · perDistance · |p|` on all axes.
  [vertex-offset](game-data/materials.md#vertex-offset) meshes expand `bounds` by the offset
  components in object space, or full offset length on all axes for world/normal-space offsets.
- **submeshes**: each submesh compacts and optimizes its own vertex range so indices stay local
  (`drawIndexed(indexCount, …, firstIndex, baseVertex)`). indices are `u16` when every submesh has ≤
  65,536 vertices, else `GeometryFlags.IndexU32`. quads are split; non-triangle topologies fail.
- **UV orientation**: UVs and textures are unflipped (texel row 0 at `v = 0`).

### textures (`.tex`)

raw BC or float blocks unchanged (no transcoding, no KTX2); sRGB comes from the texture asset. each
texture splits into pieces:

- **tail**: longest run of smallest mip levels totalling ≤ `TEXTURE_TAIL_BYTES` (64 KiB) as one
  blob.
- **larger levels**: one blob per mip level.

within each piece, levels run largest-first in `writeTexture` order across all layers, faces, and
depth slices (`textureLevelLayout` computes sizes, `bytesPerRow`, `rowsPerImage`). textures with
identical shape, format, sampler, and texels share one entry.

## JSON tables

each table is one zstd frame (level 9) wrapping JSON. material ID = index in `entries` (ready or
`UnconvertedEntry`, matching [asset tables](#asset-tables)).

| table         | contents                                                                                                                                                                                                                                                              |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment` | `EnvironmentTable`: posts, blend schema, deduplicated phase sections, phases, `flowNoise`, volumes ([environments](#environments))                                                                                                                                    |
| `materials`   | `entries`: `ReadyMaterial` with cull mode, render queue, `surface`, `gaps` ([materials](#materials))                                                                                                                                                                  |
| `water`       | `WaterTable` ([water](#water))                                                                                                                                                                                                                                        |
| `lights`      | `LightEntry[]`: kind (`spot`, `point`), entity id, group, position, direction, linear colour, range, cone angles, tube length, soft radius, falloff exponent, specular/volumetric intensity, priority, distance fade, rows3x4 inverse culling box ([lights](#lights)) |
| `particles`   | `ParticlesTable` ([particles](#particles))                                                                                                                                                                                                                            |

### environments

`tables/environment.json.zst` (`EnvironmentTable`, [packing rules](extraction/environments.md)):

- `posts`: post-processing profiles deduplicated by name.
- `schema`: per-field blend mode (lerp, lerp-and-round, or switch at 0.5; unlisted fields switch;
  [blend schema](extraction/environments.md#blend-schema)).
- `sections`: deduplicated phase section values.
- `phases`: uncomposed phases (name, active sections, indices into `sections`; `resolveEnvironment`
  expands them).
- `flowNoise`: texture id of the 3D height-fog flow noise, or `null`
  ([flow noise](game-data/sky-and-fog.md#flow-noise)).
- `volumes`: global, box, and prism volumes (name without `#…`, visibility `group`,
  `environmentVolume:<index>` `control`, world shape, `blend` mode
  `replace`/`depth`/`fade`/`scripted`, priority, phase index or `null`).

`LevelInfo.environment` names each level's base volume and post profile. volume activation follows
`group` (`scripted` controls default off, others on).

### materials

each `ReadyMaterial` holds cull mode, render queue, `gaps` (undrawn keywords/properties for the
[gaps view](viewer/materials.md#gaps)), and a resolved `surface` union. `undrawn` marks invisible
materials; `unsupported` records the reason.

- **rect decals**: draw the game's VFXDecal cube with row-provided colour and UV transform
  ([instance block](#instance-block-inst-efin)). `litDecal` stores `_DecalOpacity`; `wetnessDecal`
  stores `_OverallOpacity` (multiplies placement alpha).
- **posed copies**: prefab renderers whose settled view state overrides material values
  ([view-state poses](extraction/prefabs-and-interactives.md#view-state-poses)) reference a copied
  material with those values baked in.
- **motion**: a posed copy whose looping clip animates float properties
  ([looping clips](extraction/prefabs-and-interactives.md#looping-clips)) carries `motion`: loop
  duration and per-property tracks (path from surface root + stepped per-frame values). frame count
  and clock match the prefab's [skin animation](#geometry-blob-mesh-efgm).

### lights

`tables/lights.json.zst` stores spot and point lights (positive tube length = tube light along
`direction`). directional, shadow-only, and character-only lights are omitted.

- **sources**: chunk lights inherit their chunk files' scene-state groups; dynamic-structure ECS
  lights inherit their structure's group; prefab lights derive linear colour
  (`linear(sRGB) × intensity × temperatureTint`), inherit placement visibility, and rotate their
  culling boxes with the placement.
- **`shadow`** (`LightShadow`): populated for static-scenery cached shadow casters (shadows on,
  non-moving, static casters enabled, ≥ 1 face for point lights); `null` otherwise.

### water

`tables/water.json.zst` ships whole in `core.czar` since water is resident (Global chunks only).

```
WaterTable
  global     WaterGlobal | null   null without water or packed surfaces
  configs    WaterConfigEntry[]   { name, values } deduplicated by asset key
  surfaces   WaterSurfaceEntry[]  { kind: 'placed' | 'volume', entityId, group, geometry,
                                    transform, bounds, config, volume (kind 'volume') }
  volumes    WaterVolumeEntry[]   { entityId, base, heightMax, initial, fillSpeed,
                                    levels: { fraction, speed }[], control, parent }
WaterGlobal  { mapSize, sectorSize, center, flowmapPrecision,
               flowMap, causticMap, normalMaps, rainMap, sectors: { x, z, texture }[] }
```

packing contract:

- **subset**: surfaces pass `includesEntity(levelTag, centreX, centreZ)`. surfaces do not count
  toward `LevelInfo.instances`.
- **configs**: pre-transformed at pack time: `normalMipBias = (0.5 − envSpecularDesaturation) · 10`,
  `foamFadeRate = 1 / max(foamFadeDistance, 1e-4)`, `largeWaveSignedSpeed = ±largeWaveFlowSpeed` (by
  `largeWaveInvDir`), `useFlowMap` and `FlowmapOption` as booleans. failed or incomplete configs
  drop their surfaces (logged to `debug/water.json`; never fatal).
- **meshes & transforms**: meshes go to `assets/common` (position + normal only, no tangents).
  `transform` is absolute `rows3x4` (no block origin). raw render type mask and `param1` stay in
  `debug/water.json`.
- **textures**: global maps go to `assets/common`; sector tiles go to the shard-level tile asset
  archive under each sector's centre (subsets keep only sectors overlapping packed surface bounds;
  untiled sectors log to `debug/water.json`).
- **visibility**: `group` indexes `StatesInfo.groups` (`gateWater`).
- **water volumes** ([extraction](extraction.md#water)): triangulated flat mesh at `y = 0`, raised
  by `transform` to authored fill, always loaded under owning level. `levels` merges (within 1e-4)
  the authored fill, constant script fills, and empty/full for
  [pumpable pools](game-data/water.md#depletable-pools), each with its `fillSpeed` (m/s). multi-fill
  volumes emit a `waterLevel:<id>` control defaulting to authored fill (or empty when a quest
  objective checks `CheckFluidVolume ≤ 0.05`). following basins set `parent` to their leader's index
  (`null` if unpacked) and have no control.
- **floaters**: interactive renderers with component 39 store their volume index in the instance
  block's [floaters section](#instance-block-inst-efin) (omitted if volume unpacked or row rides a
  path).

### particles

`tables/particles.json.zst` (`ParticlesTable`) interns deduplicated `ParticleSystemInfo` entries
referenced by chain draws. values use Unity `MinMaxCurve` and `MinMaxGradient` unions (key times
normalized to `[0, 1]`). Unity enums keep integer values; package-added discriminants (`motion`,
`clamp`, `rows`) are strings.

an emitter is a normal instance row whose bounds enclose particle reach. mesh renderers draw their
meshes (one emitter per mesh `m_Mesh`…`m_Mesh3`); billboard/stretched/horizontal/vertical renderers
draw Unity's unit quad
(`Packages/com.hg.render-pipelines/Runtime/RenderPipelineResources/Mesh/Quad.fbx`). the renderer's
second material is reserved for trails.

each `ParticleSystem` playing on awake packs in one of three ways:

1. **frozen particle**: max 1 particle, `ringBufferMode ≠ 0`, no texture sheet, non-camera
   alignment, no curves. baked as a static mesh at shape centre with Euler ZXY start rotation, pivot
   offset, scaling-mode transform, and midpoint of constant random ranges.
2. **played system**: evaluated closed-form from birth time + RNG, or stepped at 30 Hz under speed
   limits or force fields. matrix encodes the [scaling mode](game-data/particles.md#size-and-pose)
   (`Hierarchy`, `Local`, `Shape`), with `sizedByScale` false for `Shape`. entry stores:
   - render mode, stretched length/velocity scales, quad `screenSize` limits, `sizedByScale`, render
     alignment (`Facing` stored as `View`), pivot (pre-multiplied by mesh size for mesh particles),
     optional `flip` probabilities (`m_Flip`, omitted when zero)
   - `duration`, `looping`, `startDelay` (constants only), particle cap (cap 0 stays 0 for looping
     ring buffers, else set to emission bound), simulation speed, emission bound
   - `MinMaxCurve`s (start lifetime/speed/size/rotation, gravity, rate), bursts, `MinMaxGradient`s
     (start colour, colour over lifetime)
   - `shape`: `sphere`, `hemisphere`, `cone`, `coneVolume`, `box` (unit cube), `circle`, `donut`, or
     `mesh` (positions to 0.1 mm, normals, optional byte vertex colours, 2/3-vertex primitives,
     spawn mode, edge spread, normal offset)
   - `motion`: `free` (velocity module: linear, orbital, radial, speed modifier; size/rotation over
     lifetime; `clamp` from Limit Velocity drag or whole-speed limit; `forces` from same-prefab
     sphere External Force fields with `fromEmitter` matrices) or `spline`
   - `emitterMotion`: when a looping clip moves the emitter's Transform (world vs local simulation,
     per-frame `rows3x4` matrices into end-pose frame at ≤ 30 Hz, rounded to `1e-5`)
   - `ringBufferMode`, `ringBufferLoopRange`
   - texture sheet (`UVModule` grid mode ≤ 64×64, whole sheet or `rows`, lifetime/fps timing,
     `startFrame`, `uvChannels` `SheetUvChannels` bitmask)
   - UV1 custom data (`m_UseCustomVertexStreams` + `CustomDataModule` stream 0 vector components;
     effect `*UVSpeed.zw` stored as `customScroll`; VFXDecal `*CustomData` folded into offset)
   - **trails**: supported trails emit an extra unit-quad emitter using the second material with
     `trail` populated (ratio, lifetime multiplier, width, colour gradients, size/colour flags).
     unsupported trails (ribbon mode, other texture modes, outliving particles, or on
     looping-ring-buffer/force-field/speed-limited systems) are omitted (or stand in if no particle
     render mode exists).
3. **[stand-in](#stand-ins)**: any other system (including non-play-on-awake, curve start delay,
   unsupported shape/mesh/force-field, no render mode + no supported trails). draws `m_Mesh` or
   `BillboardFacing` unit quad at emitter transform, sized by scaling mode.

**[spline movers](game-data/particles.md#spline-movers)** pack as `spline` particle systems: one
entry per LOD0 renderer of up to 4 LOD groups at the mover's GameObject; start lifetime =
`clampedFraction · splineLength / maxSpeed`. `hasAlphaControl` fade is omitted. movers with noise,
non-box emission, curves, or > 4 groups stand in as their first group at origin.

## stand-ins

unrenderable game content packs as `Unsupported` chain draws and logs reasons to
`debug/stand-ins.json` ([extraction](extraction.md)):

| content                                                                                                                                                                 | drawn as                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| unplayable particle systems ([particles](#particles))                                                                                                                   | `m_Mesh` or `BillboardFacing` unit quad at emitter, scaled as its particles |
| skinned meshes with unposable skeletons                                                                                                                                 | unposed mesh at renderer                                                    |
| skinned meshes with nonzero blend shapes                                                                                                                                | posed mesh without blend shapes                                             |
| unreadable prefabs (`unsupported-prefabs.json`)                                                                                                                         | 1 m unit cube (`synthetic:cube`, `[−0.5, 0.5]³`) at placement pivot         |
| interactives with missing/unreadable template or unknown model id                                                                                                       | 1 m unit cube at placement pivot                                            |
| prefab renderers/particles under saved-inactive GameObjects (excluding pose-switched, one-shot effects, Animator-never-shown, effect-LOD-listed, and bamboo-raft wakes) | the renderer or particle stand-in                                           |

`material` preserves the game material when known, else `0xffffffff`.

## asset placement

geometries and textures are placed in the asset archive of the **lowest common ancestor** (at or
above `shardLevel`) of all tiles using them, or `assets/common` for global uses or uses spanning
multiple root tiles. a tile's dependencies therefore reside solely in its archive, its ancestors'
archives, and `common`. textures inherit the merged placement of materials referencing them; water
and environment textures are placed explicitly ([water](#water)).

## conditions

`manifest.states` (`StatesInfo`) controls content visibility. derivation rules live in
[scene controls](extraction/scene-controls.md).

### visibility groups

every placed item (instance refs, lights, water surfaces, environment volumes) carries a `group`
index into `StatesInfo.groups`: `{ level, condition }`, where `level` indexes `manifest.levels`
(`null` = shared) and `condition` indexes `conditionalSets` (`null` = always loaded). equal pairs
are interned; group `0` is always `{ level: null, condition: null }`.

`groupsShown` evaluates `condition` only—`level` organizes UI listings and never hides content.
environment volumes apply wherever they contain the camera regardless of `level`.

### conditional sets

each `ConditionalSetInfo` is a DNF expression (`alternatives: SceneRequirement[][]`) of
`{ control, mask }` terms (`control` indexes `StatesInfo.controls`). a term holds when bit `value`
of `mask` is set (out-of-range values fail); a set holds when any alternative has all terms met
(`conditionVisible`).

the packer drops unused controls before resolving IDs to indices, prunes impossible alternatives,
and canonicalises/interns sets:

- **masks**: on/off = `2` (value 1); quest/variable = accepted values; progression = `logicState`;
  facility form = `1 << form`; doodad group = `1 << level`; graded doodad = matching levels.
- **combination**: conjunctions distribute over disjunctions; `reverse` complements masks within
  each control's value domain; same-control terms in a conjunction intersect (empty drops the
  alternative).
- **dynamic content**: conjunction of progression/logic/harvest, script, gate, visible-state, and
  non-zero `area:<id>` requirements; shared models/ECS groups union their resource groups'
  alternatives.
- **file-gated content**: one alternative per chunk file holding the item (`sceneState:<index>`,
  `area:<id>`, or both). environment volumes come from default-area files (state requirements only).

### controls

each `SceneControl` represents one piece of game state: `id` (`<namespace>:<key>`), `kind`
(descriptive), `name`, `category` (index into `StatesInfo.categories`), `values` (each `< 32`, with
label), `default`, `assumption`, `source`, `levels` (gated `manifest.levels` indices), `story`,
`drivers`, and `place`. all internal references use control indices; `id` is for search, debugging,
and viewer state.

only consumed controls (by a group, listed derived control, or consumer like `waterLevel`) are
emitted. derived controls appear after all controls they read, so `resolveSceneValues` resolves all
values in one linear pass (user pick → derived formula → camera value → default).

- **source** (`ControlSource`):
  - `user`: holds `default` unless overridden by a pick.
  - `derived`: `1` when `conditionalSets[condition]` holds, else `0`; `rule` (`RuleText`, joined by
    `ruleText`) describes the formula with control-index references (`null` for unlisted state).
  - `camera`: evaluated from camera position/path: [stream areas](#stream-areas),
    [proximity](#proximity), or [triggers](#triggers).
- **story**: quest/mission controls link to `StatesInfo.missions` (`MissionInfo`: English name,
  category, chapter, episode, location). `StatesInfo.mainStory` orders main-story mission indices by
  parsed id (`e<episode>m<mission>[d<decimal>]`).
- **drivers**: `ControlDriver[]` from level scripts (quests, switch, trigger/script area, other
  level, server, classified or `unknown` game event), each with target value and optional position.
- **place** (`ControlPlace`): `position`, `bounds` of affected content, and `label`, or `null` if
  scene-wide/empty.

### stream areas

`StatesInfo.streamAreas` (`StreamAreasInfo`, `null` when unused) holds the root list, per-zone area
lists, and zone triggers (XZ box, height range, XZ ring). non-default-area content requires its
`area:<id>` camera control (`area` test), which activates areas shown for the zones containing the
camera.

### proximity

a `proximity:<id>` camera control (`near` test) holds one or more `{ position, radius }` reaches and
evaluates to `1` while the camera is within 3D distance of any reach, else `0` (used for away/near
interactive [view-state poses](extraction/prefabs-and-interactives.md#view-state-poses)).

### triggers

a `triggers` camera test holds `Trigger[]` volumes (`TriggerShape`: global, oriented box, vertical
prism, or sphere) with `enter` and `leave` values (`null` = no change). it tracks camera crossings
using `TriggerMemory` passed through `cameraValues`:

- holds `default` until the first crossing, then the last triggered value.
- within one step, leaves apply before enters; a fresh camera enters all containing volumes.
- used by `script:` controls driven solely by trigger-volume crossings
  ([volume crossings](extraction/scene-controls.md#following-trigger-volumes)).

## versioning

- `PACKAGE_VERSION` (`2`) is the major format version, paired with `minReaderVersion`, `features`,
  and `requiredFeatures`. additive optional JSON fields and optional FourCC binary sections do not
  bump `PACKAGE_VERSION`.
- each binary encoding (`EFTR`, `EFCH`, `EFBX`, `EFGE`, `EFTX`, `EFLT`, `EFIV`, `EFIN`, `EFGM`,
  `EFHT`, `EFTS`, `EFSL`, `EFAN`, `EFLU`) uses the shared FourCC TLV container (`majorVersion = 2`)
  with per-section `Required` flags and fixed-stride record growth.

## reading a package

1. read `core.czar` whole and verify `manifest.format` and `manifest.version`.
2. decode binary tables and inflate JSON tables.
3. range-read non-core blobs at `[dataOffset + offset, dataOffset + offset + length)` (`blobRange`);
   core blobs use the same offset from the core's first member position.
4. verify archive `size` against the manifest to detect replaced archives. range reads skip czar
   CRCs (`czar verify` checks archives offline).

see [loading](viewer/loading.md) for sources, decode workers, and zstd decoding.

## debug

`debug/` holds per-asset provenance and diagnostics (never loaded by the viewer). see
[report and debug outputs](extraction.md#report-and-debug-outputs).

## alternatives ruled out

- **3D Tiles / glTF tiles**: glb embeds meshes per tile (preventing sharing without external
  buffers) and does not map to HGRP materials. the package keeps only the implicit quadtree and
  REPLACE refinement.
- **Draco**: slower decode, ~300 KB wasm, reorders vertices (breaking cache/fetch order and
  index-aligned side data), no instance-table support. (for scale, Jingyu's LOD0 meshes: ~83 MB f32
  → 42 MB quantized → 19 MB meshopt → 11 MB zstd 19; brotli/gzip within 1 MB.)
- **cluster hierarchies (Nanite-style)**: scenes are instancing-dominated (map02: ~470k instances of
  ~21k meshes, ~5k unique at LOD0) with discrete LODs/HLODs; WebGPU lacks mesh shaders and 64-bit
  atomics.
- **hash-digit asset shards**: loses spatial locality; replaced by
  [lowest common ancestor](#asset-placement).
- **czar member index instead of `tables/blobs.bin`**: `ArchiveFile` lacks sub-range reads, per-blob
  compression, and requires reading each shard's full JSON header.
- **pack-time texture arrays / virtual texturing**: textures ship individually; the viewer builds
  arrays at runtime.

known format limitations are tracked in [status.md](status.md#packaging).
