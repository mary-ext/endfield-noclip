# viewer package format

a package is what `pnpm -s extract pack <scene>` writes and the viewer streams: one streaming scene
(one world, one coordinate frame) as czar archives holding content-addressed blobs and a few tables.
this page covers the layout on disk, every table and binary encoding, the versioning rule, and the
design reasons behind them. the types are the contract:
[package-format](../packages/package-format/src/) has one module per concern (`manifest`, `tree`,
`instances`, `geometry`, `textures`, `materials`, `terrain`, `environment`, `water`, `lights`,
`irradiance`, `states`, `blobs`, `blob-table`), each holding that concern's types and binary codec.
the packer and the viewer share them, and their JSDoc wins where this page is less precise.
`package-format` stays free of node APIs and of other workspace packages so both sides can import
it.

| side   | code                                                                                                                                               |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| packer | [pack/packer.ts](../packages/extractor/src/pack/packer.ts) and its siblings in [pack/](../packages/extractor/src/pack/)                            |
| viewer | [package/](../packages/viewer/src/package/): `viewer-package.ts` opens the core, `package-source.ts` reads files, `decode-worker.ts` decodes blobs |

## versioning

`PACKAGE_VERSION` (17) is written to `manifest.version` and covers the manifest, the JSON tables and
how the parts fit together. each binary encoding (tree, chains, blob table, irradiance table,
instance blocks, height, surface and splat pages, geometry blobs) carries its own version in its
header, next to its codec. readers accept exactly the versions they know and reject any other, and
nothing migrates old packages: a package from another version is re-extracted. bump the package
version on any incompatible change to the manifest or a table, and an encoding's version when its
layout changes. the JSON tables carry no version of their own and are trusted once the manifest's
version matches.

the pack cache fingerprints the converter's code, which imports only the `geometry`, `textures` and
`blobs` modules of `package-format`. versioning encodings separately keeps it that way: a change to
the manifest, the tree or instance blocks leaves cached mesh and texture conversions valid.

## layout

```
<package>/
  core.czar                       read whole when the package opens
    blobs/<hash>.hgt              terrain height pages coarser than the 128 m cells
    blobs/<hash>.tsp              terrain surface pages, likewise
    blobs/<hash>.inst             HLOD and global instance blocks, one of each per visibility group
    manifest.json                 PackageManifest
    tables/blobs.bin              blob index → archive, codec, kind, offset, lengths
    tables/chains.bin             LOD-chain templates
    tables/geometries.json.zst    geometry table
    tables/materials.json.zst     shader defaults + material table
    tables/textures.json.zst      texture table
    tables/water.json.zst         water table
    tables/lights.json.zst        local lights
    tables/irradiance.bin         irradiance cell keys → blobs
    tree.bin                      tile nodes + content refs
  shards/<l>_<x>_<z>.czar         content of one shard-level tile's subtree
    blobs/<hash>.hgt              terrain height pages at the cell level and finer
    blobs/<hash>.tsp              terrain surface pages, likewise
    blobs/<hash>.tsl              terrain splat pages (leaves)
    blobs/<hash>.inst             detail and conditional instance blocks
  assets/<l>_<x>_<z>[.<n>].czar   geometry and texture blobs whose uses all lie under that tile
  assets/common[.<n>].czar        ... used by global content or under several root tiles
  assets/terrain-layers.czar      terrain layer textures (.tly)
    blobs/<hash>.mesh             one mesh
    blobs/<hash>.tex              mip levels of one texture
  irradiance/<x>_<z>.czar         irradiance cells over one 512 m square
    blobs/<hash>.iv
  debug/                          never loaded by the viewer (and skipped by the OPFS import)
```

`CORE_PATHS` names the core's fixed members; `shardArchiveName`, `assetArchiveName` and
`irradianceArchiveName` name the others. `manifest.archives` lists every archive with its `role`
(`core`, `shards`, `assets`, `irradiance`) and `tile`; the core is entry 0, the rest follow sorted
by name.

the packer replaces a previous package in its output directory but refuses a directory holding
anything else, so a mistyped `-o` can't wipe unrelated files. it writes the new package into a
hidden sibling (`.<out>.staging`) and renames it into place once complete, so the previous package
stays readable during a pack and survives a failed one, and a reader never sees a mix of the two.

## containers and blobs

**czar** ([`@mary-ext/czar`](https://www.npmjs.com/package/@mary-ext/czar)) is the container: a
magic, a JSON header listing members (path, offset, size, CRC-32), then member data in path order on
16-byte boundaries. **our blob table is the index**: `tables/blobs.bin` records each blob's archive,
offset (relative to the archive's data section) and length, so the viewer issues one range read per
blob and never fetches a shard's JSON header. czar contributes CRCs, deterministic output,
`list`/`verify`/`extract` tooling and Blob/OPFS readers; a hand-rolled pack format would only add
control over member order, which content-hash names defeat anyway. 16-byte alignment lets decoders
view uncompressed members as typed arrays.

- **blob identity**: the first 128 bits of the SHA-256 of the **stored** (post-codec) bytes, as 32
  lowercase hex digits. equal stored bytes are one blob, kept in the archive of its first use.
  member path is `blobs/<hash>.<ext>` (`BLOB_EXTENSIONS`).
- **codec** (`BlobCodec`): `0` none, `1` one zstd frame. the packer keeps the zstd frame only when
  it saves at least 1/32 of the bytes, since a frame costs a decode pass and small BC7 mip tails
  barely compress. levels: 19 for instance, height page, splat page and geometry blobs; 9 for
  textures, terrain surface pages, layer textures and irradiance cells (19 saves about 2 % more at
  roughly 10× the time). the viewer decodes zstd with zstddec's wasm build, because browsers'
  `DecompressionStream` can't be relied on for zstd.
- **offsets** are u32, so every archive stays below 4 GiB; asset archives roll over to a `.<n>` part
  at 1 GiB, which also suits HTTP and OPFS.
- **the core's offsets**: `ArchiveInfo.dataOffset` is `null` for the core, because the core's header
  holds the sizes and CRCs of the tables that contain the offsets. the viewer reads the core whole
  and gets core blobs through czar. blob paths (`blobs/…`) sort before every fixed member, so blob
  offsets inside the core don't depend on table sizes; `BlobStore.writeCore` refuses a fixed member
  that would sort first.
- **generation**: `manifest.generation` hashes the core's binary and table members. equal
  generations mean identical packages; a viewer keys decoded-table caches by it.

blob indices are assigned at commit, in a deterministic order (`BlobStore.prepare` compresses and
hashes concurrently, `commit` indexes in input order), so repacking the same install yields the same
package.

## coordinates

everything is in the game's Unity frame: left-handed, +Y up, +Z north, metres
(`COORDINATE_CONVENTIONS`). the viewer applies `scale(1, 1, -1)` once at its root and swaps its
front-face winding. matrices are `rows3x4`: the top three rows of object-to-world, row-major,
matching a WGSL `array<vec4f, 3>`. instance translations and bounds centres are relative to their
block's origin, which keeps f32 precise anywhere in the world.

## tile tree

`TreeInfo` describes a forest of quadtrees on one unbounded grid that coincides with the game's
terrain quadtree: `origin` and `rootSize` are the terrain square's corner and edge (scenes without
terrain get a 4096 m square centred on the origin). level `l` tiles are `rootSize / 2^l`;
`(l, x, z)` may be negative or past `2^l − 1` for content off the terrain square, such as far
skyline props. terrain page keys equal tree keys.

| level           | role (map02: 4096 m root)                                          |
| --------------- | ------------------------------------------------------------------ |
| `leafLevel`     | 64 m: terrain leaves, detail leaves, HLOD tier 0                   |
| `cellLevel`     | 128 m: the game's streaming and level-ownership cells, HLOD tier 1 |
| `hlodLevels[2]` | 256 m: HLOD tier 2                                                 |
| `shardLevel`    | `leafLevel − 3` (512 m): groups shard archives                     |

HLOD cluster names (`HLOD<tier>_<i>_<j>_Cluster_…`) give the tier and the cell on a `64 · 2^tier` m
grid from the terrain origin, and the packer attaches each cluster to that named cell rather than to
its bounds centre, because clusters overhang their cells. names clamp negative coordinates to 0, so
along an axis named 0 the packer tries each spanned cell at or below 0 and picks the one with the
most always-loaded detail instances inside the cluster's bounds (the cell nearest the centre without
any). a cluster left on a cell without that detail can't refine, so it would draw over the detail it
stands for.

**refinement contract** (REPLACE, at HLOD-cell granularity): a node draws its coarse content while
its screen-space error, `geometricError · viewportHeight / (2 · distance · tan(fovY / 2))`, is
within the threshold; otherwise it refines to its children, and a refined leaf draws its detail
blocks. this is how the game swaps HLODs, seams included. per-instance LOD inside detail uses the
chain thresholds. `manifest.global` content (the game's Global chunk scenery) is drawn whenever its
group shows and never replaced. `geometricError` is a placeholder, `edge / 16` (64 m leaf → 4 m),
until the game's HLOD switch distances are known.

**content refs** (`ContentRef`, `ContentKind`):

| kind                 | points at                                                                      | `tier`    | `param`                        |
| -------------------- | ------------------------------------------------------------------------------ | --------- | ------------------------------ |
| `TerrainHeights` (0) | one height page                                                                | 0         | the game's `maxHeightError`, m |
| `Hlod` (1)           | rows `[first, first + count)` of a group's shared HLOD block                   | HLOD tier | 0                              |
| `Detail` (2)         | a whole instance block the HLODs stand in for                                  | 0         | 0                              |
| `Conditional` (3)    | a whole instance block no HLOD stands in for (scene-state and dynamic content) | 0         | 0                              |
| `TerrainSurface` (4) | one surface page, covering the same tile as the height page                    | 0         | 0                              |
| `TerrainSplat` (5)   | a leaf's splat page                                                            | 0         | 0                              |

every ref names a [visibility group](#visibility-groups); terrain refs use group 0 (shared, always
loaded). detail and conditional blocks are one per (leaf, group); an instance goes to the leaf under
its bounds centre. HLOD and global rows form one block per group in the core, HLOD rows sorted by
node so each node's refs are one run. global refs live in `manifest.global` with kind `Detail`;
Global chunks of scene states become conditional global blocks, drawn whole while their state is on.

## manifest

`manifest.json`, `PackageManifest`:

| field                                                     | contents                                                                                                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format`, `version`                                       | `'endfield-noclip.package'`, `PACKAGE_VERSION`                                                                                                                            |
| `generation`                                              | see above                                                                                                                                                                 |
| `scene`                                                   | streaming scene id and display name                                                                                                                                       |
| `coordinates`                                             | `COORDINATE_CONVENTIONS`                                                                                                                                                  |
| `tree`                                                    | `TreeInfo` plus node and ref counts                                                                                                                                       |
| `terrain`                                                 | position, `heightScale`, `terrainSize`, page size, hole bit, levels with pages, surface page size and border, close-up `detail`; `null` without terrain                   |
| `levels`                                                  | every level of the scene, even in a subset: id, tag, name, rect, `playerInitPos`, owned cells at `cellLevel`, packed instance count and `contentBounds`, base environment |
| `environments`, `environmentPhases`, `environmentVolumes` | see [environment.md](game-data/environment.md)                                                                                                                            |
| `states`                                                  | progressions, toggles, conditional sets and visibility groups; see [conditions](#conditions)                                                                              |
| `archives`                                                | `ArchiveInfo`: name, role, tile, size, `dataOffset`                                                                                                                       |
| `global`                                                  | content refs drawn regardless of refinement                                                                                                                               |
| `subset`                                                  | what `--level` / `--bounds` kept, or `null`                                                                                                                               |
| `source`                                                  | the bundle manifest's build guid and content hash: identifies the game build                                                                                              |

a viewer shows one level at a time: content whose group carries the level's tag or tag 0 (shared
content), over the shared terrain. scenes without levels show everything.

## binary encodings

all little-endian, every section 4-byte aligned. the tables share a 16-byte header:
`u32 magic, u16 version, u16 0, u32 count, u32 count-or-0`.

| member                  | magic  | layout                                                                                                                                                                                                                                                      |
| ----------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tree.bin`              | `EFTR` | header (nodes, refs); 48-byte nodes: `u8 level, u8 childMask, u16 flags, i32 x, i32 z, f32×3 min, f32×3 max, f32 geometricError, u32 refFirst, u32 refCount`; 24-byte refs: `u8 kind, u8 tier, u16 0, u32 group, u32 blob, u32 first, u32 count, f32 param` |
| `tables/chains.bin`     | `EFCH` | header (chains, draws); 8-byte chains: `u32 firstDraw, u16 drawCount, u8 lodCount, u8 flags`; 24-byte draws: `u32 geometry, u32 material, u16 submesh, u8 lod, u8 role, f32 minSquared, f32 maxSquared, u32 sourceFlags`                                    |
| `tables/blobs.bin`      | `EFBX` | header (blobs, 0); 32-byte records: `16-byte hash, u16 archive, u8 codec, u8 kind, u32 offset, u32 length, u32 rawLength`                                                                                                                                   |
| `tables/irradiance.bin` | `EFIV` | header (cells, 0); u32 cell keys ascending, then u32 blob indices                                                                                                                                                                                           |

nodes are ordered coarse to fine (level, then z, then x); a node's `childMask` bit `dz·2 + dx` marks
child `(2x + dx, 2z + dz)`, and its bounds cover everything it and its descendants draw, overhang
included.

**chains** are LOD-chain templates deduplicated across the scene by LOD count and ordered draws,
thresholds compared by f32 bit pattern ([chains.ts](../packages/extractor/src/pack/chains.ts)). a
draw shows while `minSquared < s² ≤ maxSquared`, `s` being Unity's LODGroup screen-relative height;
a negative `minSquared` never culls by size. roles: `Lit`, `ShadowOnly` (shadow proxies), `Card`
(foliage imposter `_cardmesh` geometry), `Hlod`. `sourceFlags` keeps the game's renderer flag word
for bits not yet understood.

### instance block (`.inst`, `EFIN`)

32-byte header: `u32 magic, u16 version, u16 flags, u32 count, f32×3 origin, u32×2 0`. then
struct-of-arrays sections of `count` elements: `u32 chain`, `f32×12 transform` (rows3x4, translation
relative to origin), `f32×6 bounds` (world AABB centre relative to origin, then half-extents, as the
game stores them), `u32 entity id`. origin is the leaf's minimum corner (y 0) for detail blocks and
the tree origin for core blocks. rows are sorted by (HLOD node, chain) (`SortedByChain`), so equal
chains form instanced ranges. the entity id traces a row through the debug index (prefab renderers
get made-up ids); who owns a row and when it loads is the block's group, not the id.

full 3×4 matrices are kept rather than quantized TRS because Unity hierarchies bake shear and
non-uniform scale into them.

### height page (`.hgt`, `EFHT`)

8-byte header: `u32 magic, u16 version, u16 side`, then the `side²` raw u16 samples (rows along +Z)
as two byte planes (all low bytes, then all high bytes) of zigzag deltas. interior samples are
predicted by `left + above − aboveLeft`, the first row by its left neighbour, the first column by
the sample above. arithmetic wraps at 16 bits so the hole bit survives. the gradient predictor beats
left-only prediction by about 10 % after zstd. the packer ships every level of the game's pyramid,
not only leaves, so the viewer can run CDLOD from native data. `terrainHeight` and `isTerrainHole`
decode samples: `y = position.y + (h & 0x7fff) · heightScale / 32768`.

### surface page (`.tsp`, `EFTS`)

8-byte header: `u32 magic, u16 version, u16 side`, then two BC3 images of `side²` texels (rows along
+Z), albedo then normal, each in `writeTexture` block order. they are the game's baked `A` and `N`
tile pages as stored, one level each; [world.md](game-data/world.md#terrain) gives their channels.
`terrain.surfaceSize` (132) is the side, and the outer `terrain.surfaceBorder` (2) texels of each
edge lie outside the tile, so world `x` maps to
`u = border / side + (x − tile.minX) / tile.size · (side − 2 · border) / side`. a tile missing
either page has no surface ref. on map02 the 3,393 pages are 118 MB raw and 64 MB stored.

### splat page (`.tsl`, `EFSL`) and layer textures (`.tly`)

a leaf's close-up blend inputs, the game's splat control, tint and index pages
([world.md](game-data/world.md#close-up-layers)). 12-byte header:
`u32 magic, u16 version, u16 side, u16 cells, u16 0`, then the `S` page's RGBA8 texels (`side²`),
the `T` page's BC3 sRGB blocks, and `cells²` cells of 4 layer ordinals cut from the scene's index
map, row-major from the leaf's minimum corner. the images share the surface page's layout. a leaf
missing either page has no splat ref. map02's 2,492 are 218 MB raw and 40 MB stored.

`terrain.splat` (`TerrainSplatInfo`) holds the cell size, the layer table (repeats per metre,
offsets, mean colour, scales and remaps, named rather than the game's packed vectors), and the layer
textures: one `TerrainLayer` blob per texture and role, raw BC7 levels from `textureSize` down,
largest first, levels under 4² padded to one block. the packer drops the game's top level (1024²),
since 512² already gives 57–230 texels per metre; map02's 38 pairs are 22 MB in
`assets/terrain-layers.czar`. `detail` is `null` when the scene's layer table, index map or textures
are missing or disagree (the pack log says which).

### geometry blob (`.mesh`, `EFGM`)

32-byte header
(`u32 magic, u16 version, u16 flags, u32 vertexCount, u32 indexCount, u16 streamCount, u16 submeshCount, u32 index payload length, u32×2 0`),
32-byte stream records
(`u8 attribute, u8 format, u8 flags, u8 0, u32 payload length, f32×3 offset, f32×3 scale`), 40-byte
submesh records
(`u32 firstIndex, u32 indexCount, u32 baseVertex, u32 vertexCount, f32×3 min, f32×3 max`), then
stream payloads and the index payload. payloads are meshopt-encoded (codec v1, no filters), so the
decoded bytes are the GPU buffers as they are; `package-format` treats them as opaque and the viewer
decodes with `meshoptimizer/decoder`. conversion is in
[geometry.ts](../packages/extractor/src/pack/geometry.ts).

each stream is its own vertex buffer. attributes use Unity's channel numbering (`VertexAttribute`):

| attribute  | format                                                                                                                                                    | why                                                                                                                                                                                                                                                                                                                                   |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 position | `unorm16x4`, dequantized to the mesh AABB                                                                                                                 | sub-3 mm steps on the largest meshes                                                                                                                                                                                                                                                                                                  |
| 1 normal   | `snorm16x2` octahedral, decoded in the shader                                                                                                             | the game's packed normals are 10-bit octahedral: their integers are stored exactly with a dequant scale of 32767/511, about 30 % smaller after meshopt + zstd than respreading over 16 bits. float normals are oct-encoded at 16 bits. meshopt's oct filter decodes to 4–8 GPU bytes and at 8 bits drops below the source's precision |
| 2 tangent  | `snorm8x4`: oct `xy`, bitangent sign `z`                                                                                                                  | generated (MikkTSpace-compatible via `meshoptimizer`'s tangents) only when a normal-mapped material draws the mesh, or the source's own                                                                                                                                                                                               |
| 3 color    | `unorm8x4`, `float16x4` when values leave [0, 1]                                                                                                          |                                                                                                                                                                                                                                                                                                                                       |
| 4–11 UV0–7 | `unorm16x2` dequantized when the span is ≤ 16, else `float32x2`; 8-bit sources keep `snorm8x4`/`unorm8x4`; sets with more than two components `float32x4` | half floats step 1/128 at 12, too coarse for tiling UVs; dequantized unorm16 at span ≤ 16 errs below 2^-13                                                                                                                                                                                                                            |

tangents are computed in the game's left-handed frame, so `bitangent = cross(n, t) · sign` holds
there; under the viewer's mirroring root multiply by the sign of the object-to-world determinant, as
Unity does. vertices whose corners disagree on the tangent frame (mirrored UV seams) are split.

**submeshes own their vertices**: each submesh's triangles are compacted to their own vertex range
and optimized there (vertex cache, then fetch order), indices stay local, and a submesh is one
`drawIndexed(indexCount, …, firstIndex, baseVertex)`. so indices are u16 whenever every submesh has
at most 65,536 vertices (`GeometryFlags.IndexU32` otherwise). quads are split; other topologies fail
conversion.

**UVs and textures are both unflipped**: Unity stores texel row 0 at v = 0, so does the package, and
a WebGPU upload of the bytes as they are samples correctly with the game's UVs.

## JSON tables

each is one zstd frame around JSON. entry `i` has id `i`. an entry is either ready or an
`UnconvertedEntry` (`pending` when packed with `--no-assets`, `failed` with the reason in
`debug/assets.json`); draws referencing an unconverted entry are skipped. `--no-assets` exists for
fast iteration on the instance side.

| table        | contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `geometries` | `ReadyGeometry`: blob, local bounds, vertex/index/submesh counts, attribute bitmask, `tangentUv`                                                                                                                                                                                                                                                                                                                                                                                            |
| `materials`  | `shaders`: each shader's declared properties and defaults (floats, colours as authored: gamma-encoded, or linear for HDR colours, vectors, texture built-in defaults, `[Normal]` slots) and its `ShaderFamily`. `entries`: `ReadyMaterial` with shader index, keywords, render queue, blend, cull, `zWrite`, alpha clip threshold, `baseTextureMapCount`, bound `slots` (texture id, UV set, `_ST` scale/offset) and only the floats/colours/vectors that differ from the shader's defaults |
| `textures`   | `ReadyTexture`: kind, WebGPU format, size, `depthOrArrayLayers`, mip count, sampler as `GPUSamplerDescriptor` fields plus Unity's `mipBias`, `pieces` coarse to fine                                                                                                                                                                                                                                                                                                                        |
| `water`      | see [water.md](game-data/water.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `lights`     | `LightEntry`: kind (spot, point), entity id, visibility group, position, direction, final linear colour, range, cone angles, tube length, soft source radius, falloff exponent, specular and volumetric scattering intensity, priority, camera-distance fade, culling box as a rows3x4 inverse; see [lighting.md](game-data/lighting.md#local-lights)                                                                                                                                       |

materials store overrides only because lit materials declare ~190 floats each; undeclared (stale)
properties Unity keeps from earlier shaders are dropped
([materials.ts](../packages/extractor/src/pack/materials.ts)).

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
piece is a whole czar member, so czar reads verify it. texture objects with identical shape, format,
sampler and texels share one entry.

## asset placement

geometry, material textures and other textures go to the asset archive of the **lowest common
ancestor** (at or above the shard level) of the tiles that use them, or to `common` for global uses
or uses under different root tiles
([asset-placement.ts](../packages/extractor/src/pack/asset-placement.ts)). everything a tile draws
therefore lives in the asset archives of that tile and its ancestors plus common, which suits a
region import into OPFS or CDN grouping. the viewer itself range-reads single blobs and ignores the
grouping. textures inherit the merged placement of the materials binding them; water and environment
textures are placed explicitly (see [water.md](game-data/water.md)).

an asset used on both sides of a quadrant border climbs to the coarse ancestor. first-use or
majority placement would give smaller per-tile archives but lose the ancestor guarantee.

## conditions

### visibility groups

every piece of placed content (instance blocks through their refs, lights, water surfaces,
environment volumes) names one `StatesInfo.groups` entry: the level that owns it (`levelTag`, 0 for
content every level shows) and the conditional set that loads it (`condition`, `null` for content
that always loads). the packer interns equal pairs into one group, and group 0 is always the shared,
always-loaded one. a viewer evaluates `groupsShown` once whenever the shown level or a scene value
changes, and every consumer filters by that one array, so "belongs to this level and is loaded" has
a single definition. environment volumes are the exception that reads the parts: they apply wherever
they hold the camera, whichever level owns them, so only their condition gates them.

### conditional sets

a `ConditionalSetInfo` is a list of alternatives, each a list of `{ control, mask }` requirements;
the content is visible when any alternative has every requirement met, and a requirement is met when
bit `value` of `mask` is set for the control's selected value. controls are `ProgressionInfo` ids
(value = progression level) and `SceneToggleInfo` ids (value 0/1). unknown controls fail closed.
equivalent expressions are interned to one set by the packer.
[conditions.ts](../packages/package-format/src/conditions.ts) holds `conditionVisible`,
`conditionResults`, `groupsShown` and `defaultSceneValues`; what the controls mean and how their
defaults are chosen is in [scene-states.md](game-data/scene-states.md).

## viewer side

`openViewerPackage` reads `core.czar` whole, checks `format` and `version`, decodes the binary
tables and inflates the JSON ones. a `PackageSource` reads files over HTTP range requests (a server
ignoring `Range` still works, slower), a directory handle (File System Access or OPFS) or a
`webkitdirectory` file list. `blobRange` turns a blob index into `[dataOffset + offset, +length)` of
its archive for coalesced range reads; the decode worker undoes the codec and decodes height pages,
instance blocks and geometry off the main thread. range reads skip czar's CRC; the blob's SHA-256
name is the integrity check when one is needed.

## debug

`debug/` holds provenance the viewer never reads: `assets.json` (per id: StringPathHash key, path,
located object, failure reason; textures per source object), `chunk-files.json`, `instances.jsonl`
(per instance block: blob hash and per row `[entity id, name, chunk-file index]`),
`environments.json`, `water.json`, `unsupported-interactives.json` and `unsupported-prefabs.json`.
per-asset provenance lives here rather than in the manifest, which only identifies the build.

## open

- **geometricError** is a placeholder; calibrate against the game's HLOD switch distances.
- **content-named shards**: shard and asset archives are named by tile, so a stale cached archive
  can pair with a newer core. naming them `<tile>-<hash8>.czar` would close that, since archives are
  written before the core.
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
- **unsupported**: line and point topologies; skinned meshes are packed static or posed; the game's
  packed tangent bits are undecoded (generated tangents replace them); rect decals are skipped.
