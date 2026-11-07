# extraction

the extractor (`packages/extractor`) is a node CLI that reads a local Endfield install and writes
viewer packages in the [package format](package-format.md). game formats and behaviour are in
[game-data](game-data/); this page covers the CLI, keys, container layers, decoders and the `pack`
pipeline. per-topic pack stages have their own pages:

| page                                                               | covers                                                                      |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| [prefabs and interactives](extraction/prefabs-and-interactives.md) | prefab hierarchies, dynamic structures, interactives and their poses, clips |
| [environments](extraction/environments.md)                         | phase sections, the blend schema, volumes, each level's base environment    |
| [scene controls](extraction/scene-controls.md)                     | how conditional content becomes controls, and how their defaults are chosen |

## running it

node and pnpm come from mise (`mise.toml`); node runs the TypeScript sources directly, with no build
step.

```sh
pnpm extract init --game <install root or Endfield_Data> [--keys-from <dir>...]
pnpm extract pack map02 [--level map02_lv001]
pnpm run dev    # the viewer lists packages under out/
pnpm extract --help
```

`cli.ts` loads every file in `commands/` as a subcommand exporting `summary`, `usage` and
`run(args)`, so a new command is a new file there; shared argument helpers live outside that
directory, in `cli-args.ts`. run a command without arguments or with `--help` / `-h` for its usage,
which works without a config or install. every command takes `--config <file>` (default
`endfield.local.json` in the working directory) and, except for `init`, opens the install through
`withContext` in `context.ts`, which mounts the VFS, builds the world index and creates the asset
resolver on first use.

| command    | what it does                                                                                                                                                                                                                                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`     | writes `endfield.local.json`: the `Endfield_Data` path and validated keys                                                                                                                                                                                                                                                                                                 |
| `pack`     | writes a viewer package for one streaming scene, optionally one level (`--level`) or a world rectangle (`--bounds`)                                                                                                                                                                                                                                                       |
| `world`    | the world index: client scenes (`scenes`), dungeon entries with the scene they stream and the missions that reach them (`dungeons`), a map's levels and their cells, a cell's entities, a level's members, the chosen base environment per level (`env`), path ↔ hash ↔ bundle resolution, catalog search (`paths`) and search over everything placed in a scene (`find`) |
| `variants` | a scene's stream areas and progression controllers, and which chunk files a stream-area selection loads                                                                                                                                                                                                                                                                   |
| `vfs`      | lists VFS groups and their files, and extracts one logical file                                                                                                                                                                                                                                                                                                           |
| `bundle`   | inspects bundles: header and per-class counts, objects as JSON, an object's stream data, searching container paths and individually addressable class objects in main or initial bundles                                                                                                                                                                                  |
| `asset`    | decodes one mesh, texture or material by bundle and path id or by asset path, follows an entity's draws, or exports a cell as glTF                                                                                                                                                                                                                                        |
| `terrain`  | lists terrain scenes and tiles, and exports heightmaps as PNG                                                                                                                                                                                                                                                                                                             |
| `water`    | lists water surfaces by map, level or cell, counts them, and dumps water configs                                                                                                                                                                                                                                                                                          |

only `init` and `pack` are needed to produce a package; the others are for research and debugging.
their glTF/PNG/KTX2 exports (`export/`) mirror Unity's X axis and use base colours only.

### finding assets and scenery

```sh
pnpm extract world paths 'water.*material' --limit 50 --json
pnpm extract world find map02 --near=-476.6,181.8,734.3 --radius 20 --max-size 50
pnpm extract world find map02 --name 'rock|cliff' --kind static --json
pnpm extract bundle find --class Shader --group initial --limit 20
```

`world paths` searches both StringPathHash catalogs with a case-insensitive regular expression. rows
give the hex hash, full path and every matching manifest bundle; identical hash/path pairs are
emitted once, while different hashes for the same path stay apart. an empty bundle list means the
catalog entry has no manifest asset; `world resolve` gives its dependency details.

`world find` searches everything a scene places, in every scene state and stream area, and says what
gates each row. `--kind` picks sources (default all):

| kind       | source                                                                                          | visibility from                       |
| ---------- | ----------------------------------------------------------------------------------------------- | ------------------------------------- |
| `static`   | chunk entities ([world](game-data/world.md))                                                    | the chunk file's scene state and area |
| `dynamic`  | ECS entities of [dynamic structures](extraction/prefabs-and-interactives.md#dynamic-structures) | the owner's gates, states and areas   |
| `model`    | DynamicStreaming prefab rows                                                                    | as `dynamic`                          |
| `effect`   | DynamicStreaming effect prefab rows                                                             | as `dynamic`                          |
| `facility` | [interactives](extraction/prefabs-and-interactives.md#interactives), including unfound models   | facility, door and bridge controls    |
| `cabin`    | rows of built [Dijiang cabins](extraction/scene-controls.md#dijiang-cabins-and-region-walls)    | the slot's cabin control              |

visibility prints as the scene controls the package would carry, under the default game state:
alternatives joined by `|`, requirements by `&`, each `control=values` with the values that satisfy
it (`always` when nothing gates the row).

- `--name` matches entity names, mesh and material paths, prefab paths and row sources.
- `--near x,y,z --radius n` keeps rows whose world bounds (else pivot or placement position) lie
  within `n` m, in Unity coordinates, sorted nearest first and, among rows whose bounds hold the
  point, smallest first. `--max-size n` drops rows whose bounds' longest side exceeds `n` m, such as
  HLOD clusters and wide volumes. prefab rows have positions but no bounds.
- `--scene-state` and `--area` filter static chunk files before entity-id deduplication and leave
  other kinds alone.
- when `out/<scene>/debug/stand-ins.json` exists, rows the package drew as
  [stand-ins](package-format.md#stand-ins) are marked with the reasons: a prefab's renderers by its
  asset path, placed cubes by name within 2 m.

every kind but `static` comes from the packer's own placement sources
([survey.ts](../packages/extractor/src/pack/survey.ts)), level scripts included, so rows are gated
as in the package. if they fail to load, that's reported on stderr and static rows are still
searched. each text line gives the distance, kind, level, position, name, size, visibility, the
first draw's mesh, material and material bundle (the prefab path and bundle for prefab rows, the
component ids for entities without a renderer) for `asset` and `bundle dump`, and the source chunk,
dynamic row, LevelData row or cabin row. JSON adds every draw, matrices, bounds, the raw visibility
alternatives and rotation and scale for prefabs.

both searches default to 100 results; `--limit` must be positive. summaries and limit notices go to
stderr, leaving `--json` as one JSON array (`[]` for no matches). without `--near`, reaching the
limit stops the scan, so the notice doesn't imply more matches exist; with it, every source is
searched and the nearest rows are kept.

`bundle find --class` prints one row per object with bundle, SerializedFile node, path id, class,
name and container paths, ready for `bundle dump` or `asset`. `--filter` matches container paths;
with `--class`, it selects objects of that class in matching SerializedFiles. `--group` selects
`main` (default), `initial` or `all`. `--limit` counts output rows and `--scan` counts bundles.

`variants --areas` lists every selected chunk, including area zero. with `--json`, it adds a
`selection` object of sorted area ids and chunk file names to the variants object, without trailing
text.

## local config and keys

`endfield.local.json` holds the install path (`gameData`, the `Endfield_Data` directory) and the key
material the containers need (`keys.vfsKey` for catalogs and encrypted logical files, `keys.bundle`
for the bundle cipher). it matches the gitignored `*.local.json` pattern and is written with mode
0600; keys never go into committed files or bundled code ([decisions](architecture.md#decisions)).
`config.ts` validates its shape and key lengths on load and tells the user to run `init` when it's
missing.

`pack` also reads the install's IL2CPP metadata
(`Endfield_Data/il2cpp_data/Metadata/global-metadata.dat`) and `GameAssembly.dll` beside
`Endfield_Data`, for the schema of [MemoryPack data](#memorypack-data). the schema is derived on
each run, in under a second, and never written out.

`init` builds the keys in three steps (`hg/key-derive.ts`):

1. derive what the install yields: the bundle cipher's substitution box, key and IV are recovered
   from the installed client, and the chain XOR constant (`chainXor`) is searched for there too.
2. take the rest from `--keys-from`: the VFS key, and `chainXor` when the search finds none (the
   case for the current client), aren't stored in the install in a recoverable form.
   `hg/key-import.ts` reads them from local checkouts of tools that embed them
   (Endfield-map-extractor for the VFS key, AnimeStudio for the bundle cipher). without
   `--keys-from`, `init` fails naming the missing key.
3. validate every key against the install before saving: the VFS key must decrypt a `.blc` catalog
   into a parseable layout, and the bundle cipher must decrypt and decompress the first data block
   of a few small bundles into a valid SerializedFile header. a supplied key that fails is an error,
   not a warning. `init` then reopens the VFS with the final keys and mounts the Bundle group, so a
   bad key fails during setup rather than partway through a pack.

## container layers

the install is read through three nested layers. each is decoded by a `formats` module; the
extractor adds file handles, caching and cross-file lookups on top.

| layer          | what it is                                                                                                                                                                                                    | decoder                                                         | extractor side                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------- |
| VFS            | `VFS/<group hash>/` directories per data group, each with a ChaCha20-encrypted `.blc` catalog listing logical files and the `.chk` chunk files that store them; some logical files are encrypted individually | `formats/src/hg/vfs-catalog.ts`                                 | `extractor/src/hg/vfs.ts`             |
| HG bundle      | Unity's UnityFS bundle with the signature, header, block table and directory scrambled, blocks passed through a keyed XOR pad, and data compressed with a nibble-interleaved ("inverted") LZ4                 | `formats/src/hg/bundle.ts`, `bundle-cipher.ts`, `binary/lz4.ts` | `extractor/src/hg/bundles.ts`         |
| SerializedFile | Unity 2021.3 assets files (format 22) with embedded TypeTrees, inside bundles                                                                                                                                 | `formats/src/unity/serialized-file.ts`, `type-tree.ts`          | `extractor/src/game/assets/assets.ts` |

**VFS.** the install has two layers, `Persistent/VFS` (patches) and `StreamingAssets/VFS`. a group's
Persistent catalog is complete and supersedes the StreamingAssets one, while its chunks may live in
either layer (Persistent first). every logical file carries the MD5 of its decrypted bytes, which
`readVerified` checks. the well-known group hashes are in `VfsGroup` (`hg/vfs.ts`): Bundle and
InitialBundle hold asset bundles, BundleManifest the bundle manifest, ExtendData the StringPathHash
tables, Streaming and DynamicStreaming the world chunk data, Terrain the terrain tiles, JsonData
pooled LevelConfig/LevelData, and Table the SparkBuffer config tables. Streaming, DynamicStreaming
and terrain files are wrapped in a size-prefixed inverted-LZ4 envelope
(`formats/src/hg/payload.ts`); a few terrain files are stored raw.

**bundles.** `UnityBundle` is a random-access reader: it parses the header and directory, then
decodes only the blocks overlapping a requested range, so pulling one CAB out of a large bundle
reads little. the descrambling is ported from AnimeStudio.

### asset resolution

world data references assets by 64-bit path hash; the StringPathHash tables map hashes to paths and
the bundle manifest maps asset paths to bundles and their dependency closures
([lookup tables](game-data/assets.md#lookup-tables)). StringPathHash lookups try the main table,
then the initial one. path → hash (`WorldIndex.hashesOf`) scans both tables, about a second per
lookup, because the [path hash function](game-data/assets.md#open) isn't ported.
`world resolve <path|hash>` prints both directions plus the holding bundle and its dependencies.
code: [string-path-hash.ts](../packages/formats/src/hg/string-path-hash.ts),
[bundle-manifest.ts](../packages/formats/src/hg/bundle-manifest.ts),
[world-index.ts](../packages/extractor/src/game/world/world-index.ts).

`AssetResolver` ([assets.ts](../packages/extractor/src/game/assets/assets.ts)) turns a hash or a
PPtr into an `ObjectRef` (bundle index, SerializedFile, object info), relying on
[how a reference reaches an object](game-data/assets.md#how-a-reference-reaches-an-object):

- it opens dependency directories in batches and caches each CAB location.
- sub-asset lookup checks the main asset and same-bundle preload pointers, skipping dependency
  preloads. `findUnique` requires exactly one match; missing containers, class mismatches, ambiguous
  sub-assets and invalid preload ranges fail, and the pack's debug index keeps the errors.
- a PPtr into Unity's built-in files resolves to the bundled copy of a
  [built-in mesh](game-data/assets.md#built-in-meshes) (the Cube and Quad;
  [builtin-resources.ts](../packages/extractor/src/game/assets/builtin-resources.ts)), looked up on
  first use; any other throws a `FormatError` naming its path id.
- an `AssetRef` reached through a prefab carries an `ObjectLocator` (bundle, CAB, path id),
  bypassing path lookup. `objectKey` (`CAB-<hex>:<pathId>`) identifies objects for deduplication and
  caching.

### objects

`type-tree.ts` reads any object generically from its file's TypeTree, so no per-class layout code is
needed and Hypergryph's added fields decode like any other. values map to JS as: integers up to 32
bits and floats → `number`, 64-bit integers (including `m_PathID`) → `bigint`, `bool` → `boolean`,
byte arrays (`UInt8`, `TypelessData`, `SInt8`) → `Uint8Array` / `Int8Array` views without copying,
other numeric arrays → aligned typed-array copies, `bool` arrays → plain arrays, classes → objects
in serialized field order. `readTypeTreeField` materializes a single field, which the shader reader
uses to read only `m_ParsedForm`.

class decoders ([below](#decoders)) read fields through the narrowing accessors in `values.ts`
(`numberField`, `pptrField`, `aabbField`, …), which throw a `FormatError` naming the field when the
shape differs. `toPlainObject` (`plain-object.ts`) converts configuration objects (the environment's
`HG*Config` sections) to plain JSON, with Unity math structs as arrays and `UInt8` bools as
booleans. code: [serialized-file.ts](../packages/formats/src/unity/serialized-file.ts),
[type-tree.ts](../packages/formats/src/unity/type-tree.ts),
[values.ts](../packages/formats/src/unity/values.ts),
[plain-object.ts](../packages/formats/src/unity/plain-object.ts).

## decoders

`formats` modules validate layouts while decoding and throw on a mismatch. the linked game-data
sections describe each format.

### asset classes

the loaders in [asset-decode.ts](../packages/extractor/src/game/assets/asset-decode.ts) bind each
decoder to the resolver so stream data and PPtrs are followed across bundles.

**mesh.** [mesh.ts](../packages/formats/src/unity/mesh.ts) decodes `Mesh` (class 43) vertex channels
and streams, the index buffer and submeshes into typed arrays, reading vertex data from
`m_StreamData` when present. packed normals ([mesh](game-data/assets.md#mesh)) are decoded by
`unpackHgNormal`, and the raw words are kept as `packedNormals`. skinned meshes expose weights, bone
indices and bind pose counts in `skin`. it fails a mesh on:

- channels whose packing nibble the decoder hasn't seen
- submeshes whose index count leaves a partial triangle or quad
- collision-only meshes (`m_CollisionMeshBaked`) and vertices stored in `m_CompressedMesh`

meshes with f32 tangents use them as is. for packed-normal meshes the packer generates MikkTSpace
tangents from the UV set a normal-mapped material draws the mesh with
([geometry blob](package-format.md#geometry-blob-mesh-efgm)), the lowest when its materials
disagree; the report counts those meshes and `debug/assets.json` lists their sets (`tangentUvs`). a
mesh any swaying material draws is converted with the strongest of their sways, which puts the sway
weights in position W and grows its bounds
([swaying geometry](package-format.md#geometry-blob-mesh-efgm)).

**skin pose.** [skin-pose.ts](../packages/formats/src/unity/skin-pose.ts) bakes linear blend
skinning into a new static mesh: positions, normals, tangents and bounds move into the space of the
supplied pose (bone matrix × bind pose per bone). it throws on missing influences, bad bone indices
or singular transforms. skinned prefab renderers are drawn in their authored pose this way unless a
[looping clip](extraction/prefabs-and-interactives.md#looping-clips) moves their bones.

**texture.** [texture.ts](../packages/formats/src/unity/texture.ts) handles `Texture2D`, `Cubemap`,
`Texture2DArray`, `CubemapArray` and `Texture3D`. it reads format, colour space, sampler settings
and the raw mip chain and regroups the data into KTX2's level-major order, passing BC blocks through
unchanged. sRGB-ness is taken from the texture, never from the material slot. alpha-only textures
(`TextureFormat` Alpha8, `GraphicsFormat` 54) are stored as `r8unorm`, so shaders read their alpha
from red. formats without a WebGPU equivalent fail conversion and are listed in the report and
`assets.json`.

**material and shader.** [material.ts](../packages/formats/src/unity/material.ts) copies a
`Material`'s serialized state (shader PPtr, keywords, custom queue, tags, texture slots with
scale/offset and HGRP's per-slot `m_UVSetIndex`, floats, colours;
[material and shader](game-data/assets.md#material-and-shader)). the packer replaces `m_UVSetIndex`
with the Lit shader's UV-set floats where it declares them
([lit layers](game-data/materials.md#lit-layers)). `summarizeShader` reads a shader's name,
first-subshader tags and declared properties from `m_ParsedForm`. then, in the extractor:

- `loadMaterial` ([material-load.ts](../packages/extractor/src/game/materials/material-load.ts))
  locates a material's shader and textures and classifies it. a texture slot whose PPtr can't be
  followed is left empty and the material still converts; `pack` counts it as a `texture slot`
  failure and lists it in the material's debug row.
- `classifyHgrpMaterial`
  ([material-classify.ts](../packages/extractor/src/game/materials/material-classify.ts)) derives
  the shader family (from the shader name), blend kind, queue, alpha-test threshold, cull mode and
  the Lit normal/MRO layout. Unity's queue boundaries (≥2450 alpha test, ≥3000 transparent) are
  refined by HGRP's own surface, blend, alpha-test and cull properties. it reads only properties the
  shader declares, falling back to the shader's defaults, because materials keep the properties of
  shaders they used before: map02's Lit materials carrying LitTransparent's `_SurfaceType` and blend
  factors would otherwise classify as glass.
- `describeMaterial`
  ([material-describe.ts](../packages/extractor/src/game/materials/material-describe.ts)) interprets
  the converted material into its [surface](package-format.md#materials): the surface shaders in
  [material-surfaces.ts](../packages/extractor/src/game/materials/material-surfaces.ts), the effects
  in [material-effects.ts](../packages/extractor/src/game/materials/material-effects.ts), each
  reading its properties through
  [material-values.ts](../packages/extractor/src/game/materials/material-values.ts), which falls
  back to the shader's declared defaults.

all of these live apart from asset-decode.ts, outside the conversion worker's imports, so changing
them keeps the [pack cache](#pack-cache)'s conversions.

**transform.** [transform.ts](../packages/formats/src/unity/transform.ts) builds column-major TRS
matrices, applying Unity Euler angles in the game's order
([transform](game-data/assets.md#transform)).

**lens flare data.** `LensFlareDataSRP` ships without a TypeTree
([lens flare](game-data/post-processing.md#lens-flare)), so
[lens-flare-data.ts](../packages/formats/src/unity/lens-flare-data.ts) reads its bytes in SRP core
12's field order, every bool padded to four bytes. the packer keeps its elements under SRP core's
field names, curves as keys and gradients as colour and alpha keys.

### world

- **LevelConfig** ([LevelConfig](game-data/world.md#levelconfig),
  [level-config.ts](../packages/formats/src/endfield/level-config.ts)): the decoder checks the
  member counts (18 at the root, 3 in `defaultState`) and that the payload ends exactly at EOF.
- **MapConfig**
  ([MapConfig and the ownership grid](game-data/world.md#mapconfig-and-the-ownership-grid),
  [map-config.ts](../packages/formats/src/endfield/map-config.ts)); its scene-state conditions are
  in [MapConfig scene states](extraction/scene-controls.md#mapconfig-scene-states).
- **InitChunkData and StreamingChunkData**
  ([static scenery](game-data/world.md#static-scenery-initchunkdata-and-streamingchunkdata),
  [init-chunk-data.ts](../packages/formats/src/endfield/init-chunk-data.ts),
  [streaming-chunk-data.ts](../packages/formats/src/endfield/streaming-chunk-data.ts)):
  `WorldIndex.chunkFiles()` parses the chunk file names; `world cells <level>` lists a level's files
  as `sceneState/area`, `world entities <scene> <x> <z>|global` dumps one cell. the InitChunkData
  decoder accepts versions 47 and 49 and throws on any other
  ([layout](game-data/world.md#initchunkdata-layout)). `readChunkEntities` turns a component group
  into `ChunkEntity` rows with id, tag, name, matrix, bounds, decal flag and a `StaticRenderer`
  (draws with mesh/material StringPathHash keys, submesh, flags and LOD range), throwing on any
  stride or count disagreement. kind-1 object rows are read by
  [mono-objects.ts](../packages/formats/src/endfield/mono-objects.ts); local lights' runtime and
  settings blocks are laid out by
  [chunk-lights.ts](../packages/formats/src/endfield/chunk-lights.ts).
- **foliage grids** ([foliage grids](game-data/world.md#foliage-grids),
  [foliage-grids.ts](../packages/formats/src/endfield/foliage-grids.ts)).
- **stream areas** ([stream areas](game-data/world.md#stream-areas),
  [stream-area.ts](../packages/formats/src/endfield/stream-area.ts)).
- **terrain** ([terrain](game-data/world.md#terrain),
  [terrain.ts](../packages/formats/src/hg/terrain.ts),
  [terrain-source.ts](../packages/extractor/src/game/world/terrain-source.ts)): the parser checks
  the mip chain fills the payload exactly. `terrain scenes|tiles|export-heights`
  ([commands/terrain.ts](../packages/extractor/src/commands/terrain.ts)) inspects and exports the
  data.

**the level partition.** `buildLevelPartition`
([level-partition.ts](../packages/formats/src/endfield/level-partition.ts)) cross-checks the three
sources of level membership ([the level partition](game-data/world.md#the-level-partition):
MapConfig `levelIds`, LevelConfig `levelGrids`, the entity id's level tag). disagreements are
collected as `issues` rather than thrown, and `world levels <map>` prints them.
`world levels <map> --verify` checks the tag rule by a majority vote of where each tag's pivots
fall; backdrop cells don't vote, since skyline props would outvote small levels. because content
ownership follows the tag, not position, the extractor:

- selects a level's content by tag; clipping by its cells or rect cuts real scenery
- keeps unowned cells; they are part of their tag's level
- treats MapRegionTable polygons as UI overlays (mist, toasts), never as clip volumes, since they
  overhang the level's cells

`classifyEntity` returns a bucket (`level`, `shared` for tag 0, `unassigned`) and a placement
relative to the grid (`own`, `neighbour`, `backdrop`, `unplaced`); `world members <level>` counts a
level's entities by placement.

### water

decoders for the [water data](game-data/water.md):

| source                                               | decoder                                                                                                    |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| InitChunkData component 30                           | `readWaterSurfaces` in [water.ts](../packages/formats/src/endfield/water.ts)                               |
| StreamingChunkData property tables                   | [streaming-chunk-data.ts](../packages/formats/src/endfield/streaming-chunk-data.ts)                        |
| `WaterConfig` / `Global_Water_Config` MonoBehaviours | `readWaterSurfaceConfig`, `readWaterGlobalConfig` in [water.ts](../packages/formats/src/endfield/water.ts) |
| scene-wide join over chunk files, asset loading      | [water-source.ts](../packages/extractor/src/game/water/water-source.ts)                                    |
| LevelData water volumes and their floaters           | [water-volumes.ts](../packages/extractor/src/game/water/water-volumes.ts)                                  |
| fills the level scripts set                          | [water-volume-scripts.ts](../packages/extractor/src/game/water/water-volume-scripts.ts)                    |

- **surfaces**: the component layout follows An1X3R/Endfield-map-extractor (MIT,
  `extractor_core/water.py`). `readWaterSurfaces` rejects a row with a zero mask, a non-finite value
  or a missing binding, which violate the observed layout. a surface can appear in several chunk
  files; `readSceneWater` keeps the first copy by id (files in name order) and records the scene
  state of every file holding it. surface meshes resolve with
  `AssetResolver.findUnique(…, UnityClass.Mesh)`.
- **configs**: `readWaterSurfaceConfig` keeps every top-level numeric field of a `WaterConfig` under
  its serialized camelCase name, flags as 0/1 and Unity math structs as `[x, y(, z, w)]` /
  `[r, g, b, a]`. configs are bound to surfaces by asset key, never by the config's `materialIndex`
  ([surface `WaterConfig`](game-data/water.md#surface-waterconfig)). `readWaterGlobalConfig` keeps
  only sectors with `sectorDataExists` set, takes each sector's `(x, z)` from its path
  (`…/Sector/T_<x>_<z>.asset`) rather than its array index, and turns the signed
  `sectorDataAssetHashes` entry into an unsigned 64-bit key.
- **volumes**: [water volumes](game-data/water.md#water-volumes) come from LevelData, decoded whole
  through the [MemoryPack schema](#memorypack-data), since `waterVolumes` lies past the interactives
  that `readLevelInteractives`' prefix reader stops after. water-volumes.ts reads each volume and
  the interactives whose component 39 names one (the floaters), skipping a file the schema can't
  decode whole (only Dijiang's two, whose spaceship data holds a tuple the schema has no wrapper
  for).
- **scripted fills**: water-volume-scripts.ts collects the constant fills the scene's level scripts
  set volumes to, with the fill speed set just before a smooth move, from the scripts the packer
  decoded once for [script groups](extraction/scene-controls.md#script-groups). actions whose volume
  or value the script computes at runtime aren't listed; the pack report counts them
  (`waterScriptActionsComputed`). `WaterVolumeSetAmount` is listed as moving the surface at the
  volume's speed, a guess: whether it moves or snaps isn't recovered.

`water surfaces|census|config` ([commands/water.ts](../packages/extractor/src/commands/water.ts))
dumps placements, counts per level, chunk file, mask, mesh and config, and single config assets. how
`pack` turns all of this into the water table is in [water](package-format.md#water).

### irradiance

the [irradiance volume](game-data/irradiance.md)'s parser is
[hg/irradiance.ts](../packages/formats/src/hg/irradiance.ts) (`parseIrradianceRegion` there reads
Dijiang's [room bakes](game-data/irradiance.md#region-bakes)); compressed cells are one block of
inverted LZ4, decoded by `decodeInvertedLz4Block` in
[binary/lz4.ts](../packages/formats/src/binary/lz4.ts). the parser:

- rejects index magics other than `0x03000004` and `0x03000003` (gacha and legacy indices), and
  skips the top-level spatial hash header and the pair table
- checks that records tile each payload contiguously from 0 and that every payload has records; the
  packer also checks that each payload ends where its last record does
- takes the payload index from directory word 7, never from filename order
- moves every cell key to the 8192 m layout (`0x03000004`'s, world 0 at 128), so the package and
  viewer share one origin

how the cells are stored is in [irradiance cells](package-format.md#irradiance-cells).

### MemoryPack data

[level scripts](game-data/scene-states.md#level-scripts), interactive templates and LevelData are
MemoryPack, decoded by [memory-pack.ts](../packages/formats/src/endfield/memory-pack.ts) with the
schema read at extract time from the install's IL2CPP metadata and `GameAssembly.dll`
([il2cpp/](../packages/formats/src/il2cpp); see [local config and keys](#local-config-and-keys)).
the formatting rules beyond the wrappers are described in the decoder. every level script and
interactive template of the client decodes to its exact length.

LevelData files with populated blackbox settings (factory puzzle scenes) are listed in
`unsupported-interactives.json` rather than partially read.

## pack

a package holds one scene ([scenes, maps and levels](game-data/world.md#scenes-maps-and-levels));
`world scenes` lists the scenes the client ships. `world dungeons`
([game/world/dungeons.ts](../packages/extractor/src/game/world/dungeons.ts)) lists every
DungeonTable entry with its level, the scene that level streams (`=` for its own; pack that scene),
its operator, and the missions whose definition names the level. an entry no mission names is
entered from a menu (training, challenges), an NPC or interaction, or not at all yet. `--level`
takes only levels of the scene's own map, so a level streaming another map's scene, such as
`dung02_rdg012` on `dung02_rdg008`'s, can't be selected
([status](status.md#scene-states-and-controls)).

`pack <scene>` ([pack/packer.ts](../packages/extractor/src/pack/packer.ts), `packScene`) writes one
streaming scene to `out/<scene>` or `out/<scene>-<level>` at the repo root by default, or to
`-o <dir>`. the output directory must be absent, empty, or hold a previous package (plus, at most, a
`.DS_Store`); anything else aborts the pack. the package is built in a hidden sibling and renamed
into place when complete, so a failed pack leaves the previous package as it was
([layout](package-format.md#layout)). the full option list is in the command's usage text.

`--level` keeps the content one level owns plus the terrain under its cells; `--bounds` keeps
content whose centre lies in a world x/z rectangle. both record the subset in the manifest.
`--no-assets` skips mesh, material and texture conversion and leaves their table entries pending,
for fast iteration on everything else.

### phases

the phases run in this order, and the report times each one:

| phase                  | work                                                                                                                                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| setup                  | check and stage the output directory, open the cache, index the scene: level partition, terrain surface and tile grid, the subset, scene states, chunk files                                                                                  |
| entities               | read the scene's chunk files with read-ahead, then dynamic structures and the level scripts driving them, interactive facilities, cabins and the prefabs they place; intern draw chains and file every instance by level, visibility and tile |
| terrain                | encode and store terrain height, surface and splat pages and layer textures, or recall them from the cache                                                                                                                                    |
| environments and water | plan per-level environment profiles, environment volumes, and water surfaces and sectors, concurrently; then give volumes, water surfaces and lights their visibility groups and add the scene-state controls                                 |
| irradiance             | store the base and scene-state bakes' irradiance cells, or recall them from the cache                                                                                                                                                         |
| instances              | encode and store instance blocks, attaching detail and HLOD blocks to the tile tree                                                                                                                                                           |
| materials              | decode materials and build the shader and material tables; with `--no-assets`, one `assets` phase that only lists pending entries replaces this phase and the next two                                                                        |
| geometry               | convert meshes                                                                                                                                                                                                                                |
| textures               | convert textures                                                                                                                                                                                                                              |
| states                 | build the manifest's levels and scene controls                                                                                                                                                                                                |
| write                  | build the tree and tables and write the archives, cloning those the replaced package already has                                                                                                                                              |
| debug                  | write `debug/`; the staged package is then renamed into place                                                                                                                                                                                 |
| cache sweep            | with a cache: record the package and delete what no package uses                                                                                                                                                                              |

### code layout

`packScene` in [packer.ts](../packages/extractor/src/pack/packer.ts) runs the phases in order and
does little else; each phase lives in its own module under [pack/](../packages/extractor/src/pack/):

| module                                                                                                                                                                                                                                                                                                                                   | does                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [scene-index.ts](../packages/extractor/src/pack/scene-index.ts)                                                                                                                                                                                                                                                                          | setup: the partition, terrain, tile grid, HLOD grid fit, chunk file order and the `--level`/`--bounds` subset              |
| [content/](../packages/extractor/src/pack/content/)                                                                                                                                                                                                                                                                                      | the entities phase: one module per content source, run in order by `collectEntities` (`entities.ts`)                       |
| [environments.ts](../packages/extractor/src/pack/tables/environments.ts), [water.ts](../packages/extractor/src/pack/tables/water.ts), [lights.ts](../packages/extractor/src/pack/tables/lights.ts), [terrain.ts](../packages/extractor/src/pack/tables/terrain.ts), [irradiance.ts](../packages/extractor/src/pack/tables/irradiance.ts) | one core table each: planned, gated (visibility groups and controls), then finished once texture and control ids are known |
| [instance-blocks.ts](../packages/extractor/src/pack/instances/instance-blocks.ts)                                                                                                                                                                                                                                                        | encodes and stores the collected instance rows ([collector.ts](../packages/extractor/src/pack/instances/collector.ts))     |
| [states.ts](../packages/extractor/src/pack/states.ts)                                                                                                                                                                                                                                                                                    | the scene's own controls (quests, progressions, stream areas, scene states), finished and indexed                          |
| [write.ts](../packages/extractor/src/pack/write.ts), [debug.ts](../packages/extractor/src/pack/debug.ts), [report.ts](../packages/extractor/src/pack/report.ts)                                                                                                                                                                          | the core archive from a list of members, `debug/` from a list of files, and the report                                     |

every content source writes through one `PackContent`
([pack-content.ts](../packages/extractor/src/pack/content/pack-content.ts)): it interns draws into
the chain, geometry, material and particle tables, files rows (`addStructure`, `addStandInCube`),
registers controls and lights, counts what it read for the report and records what it skipped or
couldn't read. so:

- **a new kind of placed prefab** (a game system that places models) returns its placements as
  `StructureModel`s and joins the placement list in `collectPlacementSources`; its renderers,
  lights, environment volumes and stand-ins follow from
  [prefab-placements.ts](../packages/extractor/src/pack/content/prefab-placements.ts), which reads
  each prefab's root once for all of them, and `world find` and `world env` list it too, as they run
  the placement sources on their own ([survey.ts](../packages/extractor/src/pack/survey.ts)).
- **a new kind of content** is a module in `content/` called from `collectEntities` at a fixed point
  in the order.
- **a new table** adds its type and `CORE_PATHS` entry to package-format, a module here that plans
  and gates it, and one entry in `packScene`'s core member list; a new debug output is one entry in
  its debug file list, and new counts go through `PackContent.count`, which the report prints
  without further code.

the order of the sources matters, and is why they're called explicitly rather than registered:
geometry and material ids follow first reference, synthetic entity ids (prefab renderers, lights and
stand-ins, `PackContent.nextSyntheticId`) follow call order, and a chunk entity keeps its files'
gating over a dynamic structure's copy because chunk files are read first.

ids for geometries and materials are handed out in first-reference order and every parallel step
commits its results in id order, so the same install and options produce byte-identical archives
whether the pack is cold, warm or uncached. keep any new parallel work committing in a fixed order
for the same reason.

chains keep the ids of the package the pack replaces (`ChainTable.stableOrder` in
[pack/instances/chains.ts](../packages/extractor/src/pack/instances/chains.ts)): every instance row
names its chain, so a chain whose id shifted would change every shard's blocks and rename every
shard archive. each chain is keyed by a hash of what its draws are (asset identities, not table ids,
which shift), and `debug/chains.json` lists the keys by id. a chain with a known key keeps its id,
new chains take the ids of chains that are gone and then follow at the end, both in key order, and
an id left free holds an empty chain. so the pack after a change reuses every archive whose blocks
didn't change, and packing the same install twice gives the same bytes; a pack into a fresh
directory starts from key order.

### how the packer files instances

the entity pass ([static-chunks.ts](../packages/extractor/src/pack/content/static-chunks.ts)) reads
the scene's chunk files in a fixed order (always-loaded before scene-state files, the default area
before stream areas, then by name). an entity first met in an always-loaded file of the default area
stays unconditional; any other entity collects every file holding it and loads while any of them
does: the file's scene state and stream area both on. DynamicStreaming entities' area lists
([stream areas](game-data/world.md#stream-areas)) gate them the same way. entities without a
renderer, matrix or bounds are skipped and tallied in `debug/skipped-entities.json` (lights and
water surfaces among them, which other passes pack); rect decals draw the decal cube instead
([rect decals](package-format.md#materials)).

every row goes to a block of one visibility group (its level tag and the condition that loads it,
see [visibility groups](package-format.md#visibility-groups)), so a level, a scene state or a stream
area can be shown or hidden as a whole:

| destination | what goes there                                                                                                                                                | where it lives                           |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| HLOD        | scene-state-0 entities whose name matches the HLOD pattern, gated by their stream areas; attached to their named cell's tile at `hlodLevels[t]`                | one block per group, in the core archive |
| global      | other entities of `Global` chunks, with their files' condition                                                                                                 | one block per group, in the core archive |
| detail      | other scene-state-0 entities, gated by their stream areas, filed under the 64 m leaf containing their bounds centre; HLOD clusters of the same area stand in   | one block per (leaf, group)              |
| conditional | entities of scene-state cell files, plus dynamic structures and facilities, with a visibility expression; dynamic rows keep the `fb_main` grid that loads them | one block per (leaf, group, grid)        |

a dynamic model or effect row keeps its own grid; an ECS entity takes the coarsest grid of the
resource groups naming its component group, the one that loads it from farthest
([dynamic load grids](game-data/world.md#dynamic-load-grids)). facilities and Dijiang's cabin scenes
have no such grid. HLOD clusters stand in for instances already counted, so they're left out of a
level's instance count. with `--level`, the subset keeps entities with that level's tag and terrain
tiles touching its cells. the packer keeps the game's
[LOD and HLOD](game-data/world.md#lod-and-hlod):

- per-entity LOD chains are kept whole, thresholds included. foliage cards are ordinary chain draws,
  not told apart.
- HLOD clusters: setup reads the Global chunks' clusters and fits the scene's HLOD grid to their
  names; the pack report gives the grid, how many names it explains, and how many clusters' bounds
  centres lie in the tile they're filed under. a cluster whose name leaves several tiles (a clamped
  coordinate, or a cell straddling tiles) is filed under the one whose detail instances it contains
  most often ([hlod-cells.ts](../packages/extractor/src/pack/instances/hlod-cells.ts),
  [tile tree](package-format.md#tile-tree)).
- [foliage grids](game-data/world.md#foliage-grids): each grass and tree instance is an ordinary row
  with its cluster's bounds, so a cluster culls and changes LOD as a whole.

prefabs, dynamic structures and interactives are placed as
[their page](extraction/prefabs-and-interactives.md) describes.

### asset conversion and workers

[pack/convert/assets.ts](../packages/extractor/src/pack/convert/assets.ts) converts materials first,
on the main thread with bounded concurrency, because materials decide which meshes need generated
tangents and which textures are used. meshes and textures then convert on worker threads
([pack/convert/convert-pool.ts](../packages/extractor/src/pack/convert/convert-pool.ts),
[pack/convert/convert-worker.ts](../packages/extractor/src/pack/convert/convert-worker.ts)):
conversion is CPU-bound (LZ4, meshopt, zstd, hashing), so each worker opens the install itself,
writes its blobs straight into the blob directory, and returns only small results. workers start as
jobs need them, so a pack whose conversions all come from the cache starts none. texture objects
with identical content are merged into one table entry after conversion (the report counts them).

an asset reached both by path hash (static entities) and by object (prefabs) is interned under each
key, so it gets two table entries and converts twice (`AssetIds` in pack/convert/assets.ts).

`--jobs` defaults to one worker per core but one, capped at 8, since each worker holds its own
catalogs, manifest and block caches (a few hundred MB). `--zstd-level` (default 19) applies to
geometry, instance blocks and terrain height and splat pages; `--texture-zstd-level` (default 9)
applies to textures, terrain surface pages and layer textures, and is the main lever on cold pack
time while barely changing size or decode speed. irradiance cells and the core's JSON tables always
use level 9. a blob keeps its zstd frame only when compression pays
([codec](package-format.md#containers-and-blobs)).

### pack cache

unless `--no-cache` is given, packs share a cache (default `out/.cache`, `--cache <dir>` to move
it), implemented in [pack/store/pack-cache.ts](../packages/extractor/src/pack/store/pack-cache.ts):

- `blobs/` is the pack's blob store: every blob is written there once and archives are streamed from
  it. without a cache the same store lives in the staging package's `.spool` and is deleted after
  the pack.
- `memo/` holds mesh and texture conversion results keyed by the job (the mesh or texture, the
  tangent UV set, the sway, the zstd level) and a fingerprint of the converter: every workspace
  module `convert-worker.ts` transitively imports, the extractor's `package.json` and node's zstd
  version. each memo records the bundles the conversion read and their catalog MD5s; it's used only
  while those MD5s match and its blobs exist. so an install update or a change to converter code
  reconverts exactly what it affects, without reading bundle bytes to find out. code outside the
  worker's import graph doesn't invalidate conversions, which is why anything that changes
  conversion output belongs in that graph.
- `memo/` also holds whole steps whose output depends only on VFS files: terrain
  ([pack/tables/terrain.ts](../packages/extractor/src/pack/tables/terrain.ts)) and irradiance
  ([pack/tables/irradiance.ts](../packages/extractor/src/pack/tables/irradiance.ts)). a step's key
  covers its own module's import graph, its options, the tiles or cells the subset keeps and the
  catalog data MD5 of every file it reads; the memo lists its blobs in commit order plus what else
  the step returns, so a hit commits the cached blobs without reading the terrain or the irradiance
  payloads (map02: 12 s → 0.3 s and 7 s → 0.1 s).
- `memo/` also holds the stored form of every blob the packer compresses itself (instance blocks
  above all), keyed by a hash of its raw bytes, the zstd level and node's zstd version: a block that
  encodes to the same bytes as in an earlier pack takes its stored blob without compressing again,
  which at the default level 19 was most of a warm pack's instance phase.
- `roots/` has one file per package directory listing its blobs and memos. after each pack, roots
  whose directory no longer holds a `core.czar` are dropped and anything no root references is
  deleted, so the cache holds the union of the live packages' content. deleting a package directory
  by hand releases its share at the next pack, and deleting the whole cache is always safe.
- `lock` holds the packing process's pid; one pack uses a cache at a time, and a lock left by a dead
  process is taken over.

not cached: material conversion, the entities phase (which re-reads every chunk file, ~7 s on
map02), and failed mesh and texture conversions, which are retried on every pack, so a warm pack can
still start workers.

### report and debug outputs

`pack` prints a summary (sizes, phase timings, entity and instance counts, asset readiness,
conversion failures by reason, per-level environments, water, cache hits, peak RSS); `--json` prints
the full `PackReport` instead. each package also gets a `debug/` directory, which the viewer
ignores:

| file                            | contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assets.json`                   | per geometry and material id: path hash, path, located object and failure reason if any; per material also its shader, why the viewer has no look for it, its undrawn surface keywords and its texture slots whose reference couldn't be followed ([unsupported materials](viewer/materials.md#unsupported-materials)); per texture object: its texture-table id, name, failure reason and the sampler settings WebGPU can't express (Unity's mirror-once wrap, drawn as mirror-repeat) |
| `instances.jsonl`               | one line per stored instance block: its blob hash and, per row, entity id, entity name and chunk-file index (−1 for dynamic structures and the prefab renderers they place, which get synthetic entity ids)                                                                                                                                                                                                                                                                             |
| `chains.json`                   | per chain id, its key, which the next pack into the directory keeps the ids of ([phases](#phases)); empty for a free id                                                                                                                                                                                                                                                                                                                                                                 |
| `chunk-files.json`              | the chunk files read, indexed by `instances.jsonl`                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `environments.json`             | `levels`: per level, the chosen base environment and where each section came from; `problems`: volumes dropped for their shape or an unknown blend mode, volumes kept without a phase (unset or unreadable), references a phase couldn't resolve (left `null`), and resources not found                                                                                                                                                                                                 |
| `water.json`                    | water surfaces and sectors packed versus present, sectors whose asset names no tile, and assets that failed to load                                                                                                                                                                                                                                                                                                                                                                     |
| `terrain.json`                  | kept tiles without a surface page, leaves without a splat page, channel pages of tiles that have no height page, and why the layer textures didn't pack; absent without terrain                                                                                                                                                                                                                                                                                                         |
| `unsupported-interactives.json` | interactive LevelData files skipped as a whole, and templates or models that couldn't be resolved                                                                                                                                                                                                                                                                                                                                                                                       |
| `unsupported-prefabs.json`      | prefabs that couldn't be instantiated, with reasons                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `stand-ins.json`                | content packed as [stand-ins](package-format.md#stand-ins): what it belongs to, its name, why, and for placed cubes the position of their centre (prefab renderers are listed once per prefab)                                                                                                                                                                                                                                                                                          |
| `skipped-entities.json`         | chunk and DynamicStreaming entities that became no instance row, by reason and [component set](game-data/world.md#initchunkdata-layout): a count and a few names each                                                                                                                                                                                                                                                                                                                   |

start from these when something is missing in the viewer: `instances.jsonl` maps a drawn block back
to entities and chunk files, and `assets.json` says why an asset didn't convert.

## open

- path → hash lookups reverse-scan StringPathHash ([asset resolution](#asset-resolution)).
- not cached: material conversion, the entities phase and failed conversions
  ([pack cache](#pack-cache)); duplicate textures are compressed before they're merged.
- assets reached both by path hash and by object convert twice
  ([asset conversion](#asset-conversion-and-workers)).
- LevelData with populated blackbox settings isn't read ([MemoryPack data](#memorypack-data)).
- texture formats without a WebGPU equivalent aren't convertible ([texture](#asset-classes)).
