# assets: meshes, textures, materials and prefabs

how the extractor finds and decodes the Unity assets that world data points at: the TypeTree reader
and the mesh, texture, material, transform and skin decoders, how a StringPathHash key or PPtr
becomes exactly one object across bundles, how prefabs and the dynamic ECS scene become placed
renderers, and how interactive facilities expose their visual forms. bundle decryption and the VFS
are in [../extraction.md](../extraction.md); which structures a progression, quest or scene state
shows is in [scene-states.md](scene-states.md); where entity data comes from is in
[world.md](world.md).

## Unity objects

Endfield ships Unity 2021.3 SerializedFiles (format version 22) with TypeTrees embedded. the reader
is TypeTree-driven, so no per-class layout code is needed and Hypergryph's added fields decode like
any other. values map to JS as: integers up to 32 bits and floats → `number`, 64-bit integers
(including `m_PathID`) → `bigint`, byte arrays → `Uint8Array` views without copying, other numeric
arrays → typed arrays, classes → objects in serialized field order. `readTypeTreeField` materializes
a single field, which the shader reader uses to read only `m_ParsedForm`.

class decoders read fields through the narrowing accessors in `values.ts` (`numberField`,
`pptrField`, `aabbField`, …), which throw a `FormatError` naming the field when the shape differs. a
class decoder reads like the class definition and fails with a useful message on a layout change
instead of producing garbage. `toPlainObject` converts configuration objects (the environment's
`HG*Config` sections) to plain JSON, with Unity math structs as arrays and `UInt8` bools as
booleans.

a `PPtr` is `(m_FileID, m_PathID)`: file 0 is the same SerializedFile, `n ≥ 1` is
`externals[n − 1]`, path id 0 is null.

code: [serialized-file.ts](../../packages/formats/src/unity/serialized-file.ts),
[type-tree.ts](../../packages/formats/src/unity/type-tree.ts),
[values.ts](../../packages/formats/src/unity/values.ts),
[plain-object.ts](../../packages/formats/src/unity/plain-object.ts)

## resolving assets

world data names assets two ways:

- **StringPathHash keys** (InitChunkData draws, StreamingChunkData properties, dynamic model rows,
  LevelConfig `levelDataPathHashes`). the key is a 64-bit hash of the lowercased path. paths are
  `<container path>` or, for a sub-asset of an FBX, `<container path>##<sub-asset name>`.
- **PPtrs**, inside a prefab, material or renderer once an object has been reached.

### lookup tables

| file                                                                                        | maps                                                                                                                               |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `Data/ExtendData/Main/StringPathHash.bin`, `Data/ExtendData/Initial/InitStringPathHash.bin` | hash → path; lookups try main, then initial                                                                                        |
| `Data/Bundles/Windows/manifest.hgmmap`                                                      | hash → `AssetInfo` (bundle index, size, compressed path); bundle → name, direct dependencies and the transitive dependency closure |

the path hash (the game's `ManifestDataBinary.HashCodeEx`, over the lowercased path) isn't ported,
so path → hash (`WorldIndex.hashesOf`) scans the StringPathHash tables, about a second per lookup.
`world resolve <path|hash>` prints both directions plus the holding bundle and its dependencies.

code: [string-path-hash.ts](../../packages/formats/src/hg/string-path-hash.ts),
[bundle-manifest.ts](../../packages/formats/src/hg/bundle-manifest.ts),
[world-index.ts](../../packages/extractor/src/game/world-index.ts)

### the resolver

`AssetResolver` ([assets.ts](../../packages/extractor/src/game/assets.ts)) turns a hash or a PPtr
into an `ObjectRef` (bundle index, SerializedFile, object info):

1. **hash → bundle.** the manifest's `AssetInfo` rows for the hash give the bundles holding it.
2. **path → object.** in each such bundle, the `AssetBundle` object's container maps the lowercased
   container path to a main-asset PPtr and a preload range. without a sub-asset name, the main asset
   is the match. with one, candidates are the main asset plus preload pointers that stay inside the
   same bundle (a sub-asset ships in its container's bundle, so preloads into dependency bundles are
   skipped without opening them), kept when their class matches and their `m_Name` equals the
   sub-asset name case-insensitively.
3. **PPtr → object.** an external's CAB name (`archive:/CAB-<hex>/CAB-<hex>`) isn't derivable from
   bundle names, but it's always inside the referencing bundle's dependency closure, so the resolver
   opens that closure's directories in batches until the CAB turns up, and remembers every CAB it
   sees. `m_StreamData` (`.resS`) is located the same way.

`findUnique` requires exactly one match. an `AssetRef` reached through a prefab carries an
`ObjectLocator` (bundle, CAB, path id) and bypasses path lookup entirely. `objectKey`
(`CAB-<hex>:<pathId>`) is the identity used for dedupe and caching.

### exact lookups only

every lookup is exact: a hash resolves through its manifest bundle and container entry, a PPtr
through its file and path id, and anything else is a failure. the resolver never falls back to a
bundle-wide class match, a same-named object elsewhere, or the first of several ambiguous matches.
the reasons:

- names don't identify objects. sub-asset names repeat across FBX containers, LOD meshes and
  collision meshes (`*_COL*`) sit beside render meshes with near-identical names, and prefab
  variants share renderer names. a by-name pick draws a plausible but wrong mesh or material.
- a substitute hides the defect. a failed lookup stays a `failed` entry in the pack's debug index
  with its error, where it can be traced to the game data or a decoder bug; a substitute looks
  finished and nobody revisits it.
- the identities the game uses (hash → bundle → container, PPtr → CAB → path id) are available, so
  exactness costs nothing but the explicit failure.

the resolver's tests pin this down (missing containers and mismatched main assets never match by
class; ambiguous sub-assets stay ambiguous; invalid preload ranges throw). keep failed lookups
explicit when adding asset kinds, and fix the reference path instead of adding a fallback.

## decoders

the loaders in [asset-decode.ts](../../packages/extractor/src/game/asset-decode.ts) bind each
decoder to the resolver so stream data and PPtrs are followed across bundles.

### mesh

[mesh.ts](../../packages/formats/src/unity/mesh.ts) decodes `Mesh` (class 43) vertex channels and
streams, the index buffer and submeshes into typed arrays, reading vertex data from `m_StreamData`
when present.

- **packed normals.** most meshes pack the normal into one 32-bit word; the channel's dimension byte
  reads `0x31` (low nibble = real dimension 1, high nibble = packing flag 3). bits 0–19 are two
  signed 10-bit octahedral coordinates (÷511), decoded by `unpackHgNormal`. bits 20–31 hold a third
  signed field and two flag bits that the game's vertex shader uses for the tangent frame; they
  aren't decoded, and the raw words are kept as `packedNormals`.
- **tangents.** meshes with plain f32 normals carry f32×4 tangents (w = bitangent sign), which are
  used as is. for packed-normal meshes the packer generates MikkTSpace tangents from the UV set a
  normal-mapped material draws the mesh with
  ([geometry.ts](../../packages/extractor/src/pack/geometry.ts)).
- other channels seen: uv0/uv1 f32×2; vertex colour unorm8×4; uv2/uv3 snorm8×4 with dimension byte
  `0x24` (high nibble 2, meaning unknown).
- **rejected.** collision-only meshes (`m_CollisionMeshBaked`) and meshes whose vertices live in
  `m_CompressedMesh` throw. `m_MeshCompression` is only an import setting; a non-zero value with an
  empty `m_CompressedMesh` decodes normally.
- skinned meshes expose weights, bone indices and bind pose counts in `skin`.

### skin pose

[skin-pose.ts](../../packages/formats/src/unity/skin-pose.ts) bakes linear blend skinning into a new
static mesh: positions, normals, tangents and bounds move into the space of the supplied pose (bone
matrix × bind pose per bone). it throws on missing influences, bad bone indices or singular
transforms. skinned prefab renderers are drawn in their authored pose this way; animation playback
isn't implemented.

### texture

[texture.ts](../../packages/formats/src/unity/texture.ts) handles `Texture2D`, `Cubemap`,
`Texture2DArray`, `CubemapArray` and `Texture3D`. it reads format, colour space, sampler settings
and the raw mip chain and regroups the data into KTX2's level-major order; pixel data isn't decoded,
so BC blocks pass through unchanged. `Texture2D`-family classes name their format with
`TextureFormat` and their colour space with `m_ColorSpace` (1 = sRGB); array and 3D classes use
`GraphicsFormat`, which encodes sRGB itself. sRGB-ness comes from the texture, never from the
material slot. scenery textures are overwhelmingly BC7 with full mip chains, plus BC5 normals, a few
BC1 and RGBAHalf vertex-animation textures. alpha-only textures (`TextureFormat` Alpha8,
`GraphicsFormat` 54, one byte per texel) are stored as `r8unorm`, so shaders read their alpha from
red.

### material and shader

[material.ts](../../packages/formats/src/unity/material.ts) copies a `Material`'s serialized state
(shader PPtr, keywords, custom queue, tags, texture slots with scale/offset and HGRP's per-slot
`m_UVSetIndex`, floats, colours). the packer replaces `m_UVSetIndex` with the Lit shader's UV-set
floats where it declares them ([lit layers](lighting.md#lit-layers)). `summarizeShader` reads a
shader's name, first-subshader tags and declared properties from `m_ParsedForm`.
`classifyHgrpMaterial` derives the shader family (from the shader name), blend kind, queue,
alpha-test threshold, cull mode and the Lit normal/MRO layout; Unity's queue boundaries (≥2450 alpha
test, ≥3000 transparent) are refined by HGRP's own surface, blend, alpha-test and cull properties. a
texture slot whose PPtr can't be followed is recorded with its error and left empty; the material
still converts.

the viewer maps families to shading in `packages/viewer/src/render/materials.ts`.

### transform

[transform.ts](../../packages/formats/src/unity/transform.ts) builds column-major TRS matrices.
Unity Euler angles (degrees) apply Z, then X, then Y; dynamic model rows store rotations this way.

## prefabs

`readPrefabRenderers` ([prefab.ts](../../packages/extractor/src/game/prefab.ts)) walks a prefab's
GameObject hierarchy through exact PPtrs and returns its drawable renderers relative to the prefab
root:

- a GameObject draws only if it and all its ancestors are active. inactive subtrees are still walked
  for their Transforms, because an active skinned mesh can use bones under an inactive GameObject.
- enabled `MeshRenderer`s (with a `MeshFilter`'s mesh) and enabled `SkinnedMeshRenderer`s are
  candidates.
- for an enabled `LODGroup` (class 205), only renderers of LOD 0 are kept. other LODs' renderers are
  excluded by object identity, never by name.
- material slots keep their order (a null slot draws nothing for that submesh); `m_CastShadows` 3 or
  4 (Unity's `ShadowsOnly`, `ShadowsOnlyTwoSided`) marks a shadow-only renderer.
- a skinned renderer's pose is each bone's prefab-space matrix times its bind pose; bounds are the
  union of the mesh bounds under every bone so weighted vertices stay inside. non-zero blend shape
  weights throw, since baking ignores them.

a prefab that fails with a `FormatError` is skipped and listed in the pack's unsupported-prefab
report; other errors fail the pack.

## dynamic structures

the dynamic ECS scene (`Data/DynamicStreaming/PC/Scene/<scene>/`) holds scenery that appears,
changes or disappears with progression: initial structures, their alternative forms, and gated
props.

### fb_main grids

each `fb_main_<L>_<i>_<j>` file is a FlatBuffer of grids. a grid stores component vectors; an entity
is a `RootComp` row whose component slice lists `DataIndex` entries `(type, grid, index)`.
referenced rows may sit in another grid of the same file. the reader decodes the components that
matter for visuals and selection:

| component                                        | content                                                                                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ResourceComp`                                   | a slice of resource groups                                                                                                                                         |
| resource group                                   | a typed slice of model (5), effect (6) or ECS (7) rows, possibly in another grid; `logicState` mask; `levelNum` (LevelConfig `idNum`); scene-state visibility list |
| `IdComp`                                         | the entity's global id                                                                                                                                             |
| settlement / factory-region / POI control        | what drives the entity's logic state (its progression level)                                                                                                       |
| mission / global-variable / map-variable control | load gates                                                                                                                                                         |
| script control                                   | default load flag for script-enabled entities                                                                                                                      |

a resource group with `logicState` 0 ignores logic state; otherwise bit `n` shows it while the
entity's logic state is `n`. the reader validates every slice and throws on a layout change (e.g. a
resource slice not typed as resource groups) instead of truncating. how these masks, gates and
scene-state lists combine into a visibility expression is in [scene-states.md](scene-states.md).

code: [dynamic-scene.ts](../../packages/formats/src/endfield/dynamic-scene.ts),
[dynamic-resources.ts](../../packages/formats/src/endfield/dynamic-resources.ts)

### payloads

- **model rows** (type 5, 96 bytes): prefab StringPathHash key, position, Unity Euler rotation and
  scale. the packer resolves the prefab through the manifest (exactly one path is required), reads
  its renderers, and places each one under the row's TRS.
- **ECS rows** (type 7): `(sceneIndex, chunk, index)` naming component group `index` of the paired
  `fb_init_<ss>_<chunk>` / `fb_streaming_<ss>_<chunk>` files. `fb_init` holds the component groups
  and `fb_streaming` the matching entity ids; `parseDynamicChunk` reads them with the same group
  decoder as InitChunkData.
- **effect rows** (type 6) are counted and skipped.

`loadDynamicStructures`
([dynamic-structures.ts](../../packages/extractor/src/game/dynamic-structures.ts)) deduplicates
models and ECS entities by their stored reference, merging the visibility alternatives of every
group that shows them. each structure keeps the level tag of its resource group's `levelNum`. prefab
renderers have no game entity id, so the packer gives them a synthetic one: the level tag over an
index counted down from the top of the 27-bit id space, away from the game's ids. ECS entities
already present in static chunks keep their static copy.

## interactives

interactives are the placed gameplay objects: switches, doors, chests, campfires, collectibles,
harvestable plants, shops. their models come from four sources:

1. LevelData files (from LevelConfig `levelDataPathHashes`) place them. `readLevelInteractives`
   decodes the sequential prefix through the interactive list: interactive id, `createState`,
   position, rotation, scale, `modelScale` (0 = no override). only `createState` 0 (created with the
   level) is drawn.
2. `Data/Json/Interactive/InteractiveTable.json` maps each interactive id to a template and each
   template to its data file (`readInteractiveTable`). many ids share one template: the Wuling
   switch variants all instantiate `int_switch_wuling`.
3. the template `Data/Json/Interactive/InteractiveData/data_<template>.json` (pooled MemoryPack).
   its leading component is the model component (`readInteractiveBaseModel`: model id and scale).
   its last members are the variant table, keyed by interactive id, whose entries can override the
   model id (`readInteractiveVariantModels`).
4. `Data/Json/GameplayConfig/ModelTable.json` maps each model id to a prefab path and `scaleFactor`.

a placement draws its variant's model, else the template's, always visible. templates without a
model (triggers, logic) draw nothing. a model that is a doodad-group shell draws nothing itself and
places one form per group level instead ([scene-states.md](scene-states.md#doodad-groups)).

the three facility templates (`int_system_domain_shop`, `int_system_domain_depot`,
`int_doodad_core_recycle`) instead walk their components up to the model-upgrade component
(`InteractiveModelLevelUpComponentData`, `readInteractiveModel`), which lists model ids in
visual-form order and must contain the base model id. their placements are emitted one model per
visual form, each visible under its form's bit of a per-facility progression control
([scene-states.md](scene-states.md#facility-visual-forms)).

### reading the variant table

between the model component and the variant table sit hundreds of component and action-graph types
that aren't decoded, so the table is located from the end of the file: it is followed only by the
template's temporary properties and two flags. a position frames the table when the parse ends
exactly at the end of the file and its keys are exactly the InteractiveTable ids that name this
template (other than the template's own id, which is never a key; this holds for every shipped
template). zero or several such positions is an error, and that template is reported and skipped.
variant entries are 14-member objects in name order; `Optional<T>` is an object of (enabled, value)
for managed `T` and a raw struct (enabled, padding, value) for unmanaged `T`.

### reading LevelData

LevelData is a sequential format: an unread field's length is unknown, so scanning past it would
misframe every later row. the reader fails closed with `UnsupportedLevelData` on any populated field
or condition it doesn't implement, and the whole file is omitted and listed in the pack's
unsupported-interactives report. never decode a partial file. polymorphic fields are MemoryPack
unions whose tag indexes the subclasses in name order, with each subclass's members also in name
order. gameplay tags are unmanaged four-byte values. every map01 and map02 file decodes; the
blackbox (factory puzzle) scenes' populated blackbox settings are unsupported.

code: [interactive-model.ts](../../packages/formats/src/endfield/interactive-model.ts),
[level-interactives.ts](../../packages/formats/src/endfield/level-interactives.ts),
[interactive-facilities.ts](../../packages/extractor/src/game/interactive-facilities.ts)

the AIC buildable-grid data (`factorygrids/fbgrids_*.bytes`, a FlatBuffer of per-1 m column height
spans and buildable/water flags on the 128 m cells) is a separate system with no decoder here; the
viewer doesn't use it.

## open

- decoding the packed tangent frame in normal bits 20–31 (its layout is identified; tangents are
  regenerated), and the meaning of the uv dimension byte's high nibble 2
- animated poses and non-zero blend shapes
- LevelData members after the interactive list, and populated blackbox settings
- the per-controller meaning of progression bit 0 ("unbuilt" versus level 1)
- the path hash function, which would replace the StringPathHash table scans in path → hash lookups
