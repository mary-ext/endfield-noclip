# world: maps, levels, streaming and terrain

streaming scenes and their coordinate frames, levels as sets of 128 m cells, entity level tags, the
static and dynamic streaming files, stream areas, terrain tiles, LOD/HLOD data and how the game
streams them by layer. which scenery a scene state, quest or variable switches on is in
[scene-states.md](scene-states.md).

## scenes, maps and levels

the game has three units:

- a **scene** is a streaming scene (`Data/Streaming/PC/<scene>/`, described by a
  `StreamingSceneConfig` asset): `map01`, `map02`, `base01_lv001` (Dijiang), `indie_dg007`, and
  about a hundred more. each scene has one Unity coordinate frame. LevelConfig rects, entity
  matrices, terrain tiles and MapRegion shapes are all in that frame, and nothing is relocated per
  level.
- a **map** is a MapConfig (`mapIdStr`): the ownership grid and scene states of a playable space.
  the open-world maps `map01` and `map02` share their scene's name; their `domainName` (`domain_1`,
  `domain_2`) is the region the game shows as Valley IV and Wuling.
- a **level** (`map02_lv001`, …) is a LevelConfig: an area inside a map, not a separate scene.
  open-world levels share their map's streaming scene and are `isSeamless`. a non-seamless level is
  usually its own map but streams another level's scene (`dung02_gdg001` streams `map02`,
  `base01_lv003` streams `base01_lv001`), so a level's scene comes from
  `defaultState.exportedSceneConfigPath`, never from its `mapId`. interiors, arenas and Dijiang are
  separate scenes with their own frames (some interiors sit at world-like coordinates but still
  stream from their own scene).

### scene names

scene ids follow `<owner>_<kind><number>`. the owner says what the scene belongs to: `map01` and
`map02` are the open-world regions, `base01` is Dijiang, `dung01`/`dung02` are instances tied to
region 01 or 02, and `indie` instances belong to neither. `blackbox01/02_dg001` hold the AIC
tutorials. the kind is not stored anywhere, but `Data/TableCfg/DungeonTable` maps each dungeon entry
(`dungeonId`) to its `sceneId` (or `levelId`) and a `dungeonCategory`, and the kinds line up with
the categories:

| kind    | `dungeonCategory`                         | what it is                                                          |
| ------- | ----------------------------------------- | ------------------------------------------------------------------- |
| `dg`    | `dungeon_story`, `dungeon_train`, or none | story interiors and cities; base01 training rooms                   |
| `cdg`   | `dungeon_challenge`, `dungeon_actmonster` | puzzle and mechanic stages                                          |
| `rdg`   | `dungeon_char`, a few `dungeon_story`     | operator story dungeons, e.g. `dung02_rdg008` is `dung_lizhiyan_01` |
| `bdg`   | `dungeon_bossrush`                        | boss-rush arenas                                                    |
| `gdg`   | `dungeon_archery`                         | archery stages                                                      |
| `rcdg`  | `dungeon_wuling_racing`                   | Wuling tracks                                                       |
| `sdg`   | `dungeon_resource`                        | Protocol Space resource stages                                      |
| `ssdg`  | none (`dungeon_ss` rows point at levels)  | Protocol Space advanced progression                                 |
| `ttdg`  | `dungeon_takestwo`                        | wave arena                                                          |
| `swdg`  | `dungeon_gamblingdungeon`                 | Arena of Games                                                      |
| `wrdg`  | `dungeon_weeklyraid`                      | weekly raid                                                         |
| `hdg`   | `dungeon_highdifficulty`                  | high-difficulty boss arenas                                         |
| `ccdg`  | `dungeon_contract`                        | Contingency Contract                                                |
| `check` | `dungeon_worldlevel`                      | Zoetic Session level checks                                         |
| `race`  | `dungeon_race`                            | race                                                                |
| `tower` | `dungeon_seasontower`                     | season tower                                                        |

the number counts up within an owner and kind; it carries no other meaning. a scene can serve
several dungeon entries (`indie_tower001` serves dozens) and some scenes have none: story quests can
send the party to a scene directly, and each mission's
`Data/Json/MissionRuntimeAsset/<mission>.json` names the scenes it uses (`sceneId`, `_mapId`), so
`e11m5` is how the main story reaches `dung02_rdg008`. a dungeon and a puzzle stage can share a
display name with a quest (`dung02_cdg005` and quest `e11m7` are both "Homecoming").

a dungeon's id names a level, not necessarily a scene: many operator-story levels stream another
scene. Liino's and Gilberta's stream `map01`, Typhoeus's `dung02_rdg009` and `rdg015` stream
`map02`, Mi Fu's `rdg006`/`rdg007` stream `rdg004`, and Li Zhiyan's `dung02_rdg012` streams
`rdg008`. so `rdg` numbers skipped in the scene list (`dung01_rdg002`, `rdg008`–`rdg014`) are still
dungeons, and only `dung01_rdg006` and `rdg009` have no LevelConfig at all. the `rdg` rows leave
`dungeonName` and `relatedCharId` empty; the operator comes from the character missions that lead
there (`charId`, and the `c<n>` mission prefix matches `chr_00<n>`). a mission names a level in
`levelId`, quests' `levelIdOverride`, tracking entries' `sceneId` and conditions' `_mapId`
(`{ constValue }`). some entries no mission names: `dung02_rdg012` (`dung_lizhiyan_02`), and
`dung02_rdg015`, which its mission (`c34m3d6`) spells `dung02_rdg0015`.

`dung02_rdg012` is most likely Deep Dale Street's revisit, where Arcane (Li Zhiyan) sends the player
after chapter 11 (inferred, not traced to the dialogue): it streams `dung02_rdg008`'s scene, spawns
the player in the ruined plaza (3.4, 63.1, 89.6) rather than at the story's start (-77, 103, 231),
and its LevelData holds only a checkpoint, a rope-port pair from the plaza up to the street (-77,
64.7 → 82.5, 128) and a sub-file for `e11m8d5`, the post-story "keep exploring" mission. no plain
JSON, table or pooled file names `dung_lizhiyan_02` outside its own rows, so whatever enters it is
elsewhere.

### LevelConfig

`Data/Json/LevelConfig/<level>.json` is a binary MemoryPack-style payload with strings pooled in
`Data/Json/StringPool/StringPool<n>.byte`, despite its extension. the root has 18 members and
`defaultState` 3, and the payload ends exactly at EOF. fields with known meaning:

| field                                             | meaning                                                                                                                                |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `idNum`                                     | string id and the numeric id MapConfig's grid stores                                                                                   |
| `mapId`                                           | the level's map (stored as `mapIdStr`), e.g. `map02`; not always its streaming scene, see above                                        |
| `defaultState.exportedSceneConfigPath`            | streaming scene asset, e.g. `map02/map02_streaming.asset`                                                                              |
| `defaultState.sourceSceneName`                    | the level's art sub-scene, e.g. `map02_lv001_art`                                                                                      |
| `levelGrids`                                      | the 128 m cells the level owns                                                                                                         |
| `levelDataPathHashes`                             | StringPathHash keys (stored as `levelDataPaths`) of the level's LevelData files (interactives, see [interactives.md](interactives.md)) |
| `rectLeftBottom`, `rectRightTop`, `playerInitPos` | the level's playable rect and the player's spawn point                                                                                 |

### MapConfig and the ownership grid

`Data/Json/MapConfig/<map>.json` is plain JSON (UTF-8 with BOM). `levelIds` is a row-major
`sideGridNum × sideGridNum` grid of LevelConfig `idNum`s centred on the origin, 0 meaning no level.
cell `(x, z) = (floor(worldX / 128), floor(worldZ / 128))` is at index `(z + N/2)·N + (x + N/2)`.
map02's grid is 32² (4096 m), map01's 16² (2048 m). MapConfig also carries `sceneStates` and
`sceneStateConditions`, which [scene-states.md](scene-states.md) covers.

### the level partition

three sources describe level membership:

1. MapConfig `levelIds`: which level owns each cell
2. LevelConfig `levelGrids`: the same cells, listed per level
3. the entity id's top 5 bits (`id >>> 27`), the **level tag**: which level authored the entity

the two cell sources agree exactly on map01 and map02.

the tag is the 1-based ordinal of the level among the map's grid-owning levels sorted by id, not the
`lvNNN` number. in map02 these coincide because lv001–lv010 all exist; map01 has no lv004, so
lv005–lv007 carry tags 4–6. tag 0 is a small map-wide shared set and tag 31 holds generated
colliders. a single-level scene (a dungeon, Dijiang) tags everything 0, so there the one level owns
tag 0. a majority vote of the cells where each tag's entity pivots fall confirms the rule, with
backdrop cells left out, since their skyline props would outvote small levels.

**content ownership follows the tag, not position.** a level's scenery can sit in a neighbour's cell
or in a cell no level owns (backdrop and skyline; map02 has more such cells than owned ones). border
cells hold several levels' entities without duplicating them, and an entity spanning cells repeats
by id in each cell's chunk. so:

- a level's content is its tag's entities; its cells and rect don't bound it, and clipping by them
  cuts real scenery
- unowned cells hold content of their tag's level
- MapRegionTable polygons are UI overlays (mist, toasts). they don't tile the level and overhang its
  cells

### map place names

the in-game map's place names are `Data/Json/UILevelMapLoadConfig/<level>.json` static elements of
type 2: a `textId` (`scene_<level>_…_location_tips_<n>`, through `TextTable`) at a world `position`
(x, z; y is 0), such as "Bridge Approach" in The Hub and "Tianjing Courtyard" in Wuling City. a map
with `basic.needInverseXZ` set swaps x and z; none of the packed scenes' levels were seen to. the
same files give interior floor names (`tierNames`, `scene_<level>_layer_tips_<n>`) with per-tier
bounds (`tierInfos`); how tiers relate to stream areas isn't established. level display names are
`LevelDescTable.showName`.

## static scenery: InitChunkData and StreamingChunkData

static scenery streams per 128 m cell:

```
Data/Streaming/PC/<scene>/Streaming/InitChunkData_<x>_<z>_<sceneState>_<area>.bytes
Data/Streaming/PC/<scene>/Streaming/InitChunkData_Global_<sceneState>_<area>.bytes
Data/Streaming/PC/<scene>/Streaming/StreamingChunkData_…   (same suffixes)
```

the suffixes are the game's `GridIdentifier` fields (`pos`, `sceneStateId`, `areaId`); the game
calls the 128 m cell a grid.

- `<x>_<z>` is the cell. most entity pivots fall inside their file's cell; large objects are filed
  by bounds and repeat in each cell they touch. the `Global` file has no cell: it holds the entities
  of the [streaming layers](#streaming-layers) that don't load by file (`Persistent`, the three HLOD
  layers and `Water`), so only its `Persistent` entities are always resident.
- `<sceneState>` is 0 for always-loaded content and `n` for content shown only while MapConfig scene
  state `n − 1` is active (see [scene-states.md](scene-states.md)).
- `<area>` is a stream-area id from `FBStreamArea` (below); 0 is the default area.

every file is a u32 clear size and an inverted-LZ4 block (the HG payload envelope) around a
FlatBuffer.

### InitChunkData layout

the root table has 8 slots: version (47 and 49 seen), the chunk origin (`x·128, z·128`; Global
stores `INT32_MAX, INT32_MIN`), the object rows (ids, union kinds and tables, each row's field 0
being the full object name and field 1 its [streaming layer](#streaming-layers), a `StreamingLayer`
byte left out for `Default`), and parallel vectors of per-group entity ids and **component groups**.

a component group is an ECS archetype stored column-major: a descriptor list of
`(component id, stride)` and one blob of `count · Σ stride` bytes. component ids are anonymous
column selectors; the ones with established meaning:

| id    | content                                                                                                                                                                                                                                                                                                      |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0–5   | world AABB, centre xyz then extents xyz (f32 each)                                                                                                                                                                                                                                                           |
| 8–14  | draw infos for capacity `2^(id − 8)`: count, 24-byte infos (the game's `RendererInfo`: submesh, `renderFlags`), then `(max², min²)` LOD bounds                                                                                                                                                               |
| 18    | 256-byte instance constants starting with the object-to-world matrix                                                                                                                                                                                                                                         |
| 21    | 64-byte name prefix (root object names win when present)                                                                                                                                                                                                                                                     |
| 27    | rect decal constants (160 bytes): matrix, inverse, UV scale and offset, RGBA8 colour, intensity, an angle the decal's shaders don't read (270 and 90 seen), flags (0 on every decal seen); material in StreamingChunkData under `0xff010000` ([materials](materials.md#decals))                              |
| 28    | terrain decal constants in 27's layout (matrix, inverse, params, packed colour); material in StreamingChunkData, `HGRP/TerrainDecalLit`                                                                                                                                                                      |
| 30    | a water surface placement ([water](water.md#placements-initchunkdata-component-30))                                                                                                                                                                                                                          |
| 31    | water decal constants (172 bytes, unread); StreamingChunkData names the render pipeline's cube under `0xff000000` and its material under `0xff010000` (map02's `P_waterdecal_01`, all Global)                                                                                                                |
| 42    | a local light's runtime data, zero-filled in the file (244 bytes); the values are in the object row (below)                                                                                                                                                                                                  |
| 44    | on collider-only entities (`…_COL1`, `P_box_collider`, `MergedCollider_…`), always with 21 alone (tens of thousands on map02); content unread                                                                                                                                                                |
| 52    | a constant spin about the entity's own origin (16 bytes): speed (rad/s, non-negative), unit axis (local); only on the originium hub frames ([spinning scenery](animation.md#spinning-scenery))                                                                                                               |
| 54    | a constant spin (92 bytes): speed (rad/s, non-negative), unit axis, pivot (world), six floats not checked (a local box, by their values), then the stored position, rotation quaternion xyzw and scale; only on Qingbo Stockade's waterwheels' renderers ([spinning scenery](animation.md#spinning-scenery)) |
| 60    | a cloth hash (u32): the entity's vertices follow the [cloth](#cloth-groups) with that hash ([cloth simulation](materials.md#cloth-simulation))                                                                                                                                                               |
| 61    | an oriented box (44 bytes): u32 0, centre xyz, a size xyz (half or full unchecked), rotation quaternion xyzw; with 21 and the 1-byte 62 on map02's `shadowOC_CAVE_*` entities, the only ones seen                                                                                                            |
| 63    | the same light's settings, zero-filled (448 bytes)                                                                                                                                                                                                                                                           |
| 67    | LOD ranges: LOD count and cumulative draw count per LOD                                                                                                                                                                                                                                                      |
| 68–74 | draw refs for capacity `2^(id − 68)`: `(u64 material hash, u64 mesh hash, …)`                                                                                                                                                                                                                                |

object row kinds by census: 1 = GameObjects the client rebuilds as MonoBehaviours (environment and
post volumes, probes, water, terrain root), 2 = component-group entities, 3 = proxies: audio, grass
and tree grids ([below](#foliage-grids)) and surface data. kind 1's volumes and water are described
in [environment.md](environment.md) and [water.md](water.md).

local lights are kind-2 entities in groups with columns 42 and 63. their row's slot 3 is a keyed
property table in kind 1's layout, holding two blobs, a 236-byte runtime block and a 448-byte
settings block. map01 has about a thousand and map02 about two thousand;
[lighting.md](lighting.md#local-lights) covers how they shade.

the runtime block (key `0xff000000`) is the light as the renderer consumes it:

| offset | type   | content                                                       |
| ------ | ------ | ------------------------------------------------------------- |
| 0      | f32×4  | colour, sRGB as authored                                      |
| 16     | f32    | intensity                                                     |
| 20     | f32    | colour temperature (K)                                        |
| 24     | u32    | use temperature                                               |
| 28     | f32×4  | position, 1                                                   |
| 44     | f32×4  | direction (the transform's +z), 0                             |
| 60     | f32×4  | linear colour · intensity · temperature tint (rgb), intensity |
| 76     | f32    | range (m)                                                     |
| 80     | f32    | 25 / range²                                                   |
| 84     | f32    | spot angle (degrees; −1 for point lights)                     |
| 88     | u32    | Unity `LightType`: 0 spot, 1 directional, 2 point             |
| 92     | f32×4  | copy of 60                                                    |
| 108    | f32×16 | object-to-world, column-major                                 |
| 172    | f32×16 | world-to-object                                               |

the settings block (key `0xff010000`) is the authored settings of HG's light, then its additional
data:

| offset | type  | content                                                |
| ------ | ----- | ------------------------------------------------------ |
| 12     | u32   | type, as in the runtime block                          |
| 20     | f32   | specular intensity                                     |
| 24     | f32   | range                                                  |
| 36     | f32   | spot angle (full cone, degrees)                        |
| 40     | f32   | inner spot angle                                       |
| 48     | f32   | cot(spot / 2)                                          |
| 52     | f32   | 1 / cos(spot / 2)                                      |
| 80     | u32   | Unity `LightmapBakeType`: 4 realtime, 1 mixed, 2 baked |
| 91     | u8    | shadow only                                            |
| 92     | u8    | culling box on                                         |
| 94     | u8    | culling distance on                                    |
| 100    | f32×3 | culling box offset                                     |
| 112    | f32×3 | culling box half extents                               |
| 124    | f32×3 | culling box rotation (Euler degrees)                   |
| 136    | f32   | culling box falloff threshold                          |
| 140    | i32   | priority                                               |
| 144    | f32   | tube length (−1 or 0: not a tube)                      |
| 148    | f32   | soft source radius                                     |
| 152    | f32   | culling distance                                       |
| 156    | f32   | falloff distance                                       |
| 160    | u32   | shadows: 0 none, 2 soft                                |
| 172    | f32   | shadow strength                                        |
| 176    | f32   | shadow depth bias (the rasteriser's)                   |
| 180    | f32   | shadow normal bias                                     |
| 184    | f32   | shadow near plane                                      |
| 256    | f32   | shadow far plane                                       |
| 260    | f32   | shadow cull distance                                   |
| 264    | f32   | shadow fade ratio                                      |
| 268    | f32   | shadow guard angle (degrees)                           |
| 272    | i32   | point light shadow faces (a bit each, −1 all)          |
| 276    | i32   | shadow caster properties (bits, below)                 |
| 436    | u8    | character only                                         |
| 440    | f32   | volumetric scattering intensity                        |
| 444    | f32   | falloff exponent (negative: inverse square)            |

both layouts were found by census over map01 and map02: a value per offset against the authored
properties of Unity's `Light` and their defaults (30° and 21.80208° for the angles, 6570 K for the
temperature), and the order of the properties of HG's light. the shadow fields are the ones the
game's light getters read, and match a prefab `Light`'s `m_Shadows` values. the caster properties'
bits are 1 for a light that moves, 2 when static objects cast and 4 when dynamic objects do; what
they select is under [local light shadows](lighting.md#local-light-shadows).

#### render flags

a draw info's `renderFlags` word (the game's `HGRenderFlags`). the shadow bits' meanings are read
from what the shadow maps draw; the others are taken from the game's names for them, unchecked:

| bit                      | name                   | meaning                                                          |
| ------------------------ | ---------------------- | ---------------------------------------------------------------- |
| `0x2`                    | `ShadowTwoSided`       | casts shadows from both faces                                    |
| `0x10`                   | `AlphaTest`            | alpha-tested material                                            |
| `0x100`                  | `Opaque`               | set at runtime for opaque-queue materials                        |
| `0x200`                  | `Transparent`          | transparent material                                             |
| `0x400`                  | `ShadowOnly`           | casts shadows without drawing (shadow proxies)                   |
| `0x80000`                | `CastShadow`           | casts shadows at all                                             |
| `0x100000 << i`, i = 0–3 | `CSMShadowCascade<i>`  | casts into sharp cascade i; all four or none on every chunk draw |
| `0x1000000`              | `StaticShadowCaster`   | casts into the cached far map                                    |
| `0x2000000`              | `RealtimeShadowCaster` | casts into the sharp cascades                                    |
| `0x8000000`              | `RayTracing`           | included in ray tracing                                          |
| `0x20000000`             | `MaterialTwoSided`     | two-sided material                                               |

map02's chunk draws come in two families: `0x0bf80000` (ray tracing, both caster kinds, every
cascade, cast) and `0x08080000` (ray tracing and cast only: about ten thousand draws that cast into
no sun shadow map). which maps a caster reaches is under [shadows](lighting.md#shadows). prefab
renderers have no such word; their inputs are the renderer's serialized `m_CastShadows`,
`m_StaticShadowCaster` and `m_RealtimeShadowCaster`, with no per-cascade field.

### StreamingChunkData

the sibling of each InitChunkData file. it shares the root layout and object ids and adds, per
object, a keyed property table whose values point at assets by StringPathHash key. keys read as
`component << 24 | field << 16 | index`. a kind-1 object's properties are split, per component,
between its Init and Streaming rows: Init carries the name and the inline values, Streaming the
asset references and some nested blobs.

a property table is three parallel vectors in slots 3–5: u32 keys, u8 value types and offsets to the
values. rows hold them by kind:

| kind | row                                                                                                                                                  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | 5 slots: 0 the name (Init; empty in Streaming), 1 the streaming layer, 3 an inline u64 `StreamingComponentType` mask, 4 a vector of component tables |
| 2    | 6 slots in Streaming: 3 a property table, 4 sixteen zero bytes, 5 an empty vector. a light's Init row holds its property table in slot 3 too         |
| 3    | 4 slots: 3 a property table ([foliage grids](#foliage-grids))                                                                                        |

a kind-1 component table is a property table with the component's type, one mask bit, as a u32 in
slot 0. its keys' component is that bit's index (0 `Transform`, 4 `BoxCollider`, 14
`HGEnvironmentVolume`, 15 `Volume`, 32 `HGWaterGlobalConfig`), the field is the field's index in its
class, and the index is the element of a fixed array (matrix rows, curve keys). `0xff` keys are per
entity archetype, so their meaning depends on the entity's InitChunkData components.

| value type | value                                                                                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1          | bool (u8)                                                                                                                                                   |
| 2, 3       | i32, u32                                                                                                                                                    |
| 4          | f32                                                                                                                                                         |
| 6          | u64                                                                                                                                                         |
| 9, 10      | f32×3, f32×4                                                                                                                                                |
| 13         | i32×4; only seen as a renderer entity's [HLOD link](#lod-and-hlod) under `0xff000000`                                                                       |
| 14         | bounds: centre and extents, f32×3 each                                                                                                                      |
| 15         | asset: u64 StringPathHash key, then a u32 code for its kind (6 for ScriptableObjects; 1, 3, 4, 7 and 8 seen)                                                |
| 16         | string: a table whose slot 0 holds the bytes                                                                                                                |
| 17         | blob: a table holding a table holding the bytes of a struct the client parses itself (polyline shapes, probe data); empty structs leave the inner slots out |

the kind-1 layout was checked against `Env_*` volumes, whose phase keys resolve to
`EnvParse/Env_*.asset`, and Global Volumes.

### foliage grids

most small vegetation isn't placed as entities. it sits in kind-3 proxy objects named
`GrassGrid_<x>_<z>#<level tag>_<id>` and `TreeGrid_…`, one per 64 m cell and file, whose row slot 2
holds the game's `ProxyEntityType` (7 grass, 9 tree). each is a batch of ECS archetypes the client
instantiates itself, serialized into the row's keyed property table:

| key                    | file      | content                                                                                     |
| ---------------------- | --------- | ------------------------------------------------------------------------------------------- |
| `0xff000000`           | Init      | archetype count                                                                             |
| `0xff01xxxx`           | Init      | archetype bounds                                                                            |
| `0xff02xxxx`           | Init      | entity count                                                                                |
| `0xff03xxxx`           | Init      | column descriptors, 8 bytes each: `u16 component id, u16 stride, u32 0`                     |
| `0xff04xxxx`           | Init      | the column-major blob, as a component group's                                               |
| `0xff050000`           | Streaming | batch table length                                                                          |
| `0xff06xxxx`–`0xff09…` | Streaming | per batch entry: u32 key (value code 3), material, mesh (StringPathHash assets) and submesh |

archetypes reuse the bounds (0–5) and draw-info (8–14) columns, but a draw names a batch entry
instead of holding asset keys: grass draws (`GrassRendererInfo`) carry a u16 of keywords at byte 0,
the entry's key at 4, a sparsity at 8 and the renderer flags at 12; tree draws (`RendererInfo`)
carry a submesh byte at 2, the entry's index at 12 and the flags at 16. there's no LOD-range column,
so a draw's LOD is the rank of its upper threshold. instances are a column-major object-to-world
matrix and two vec4 parameters (96 bytes): a grass entity is a cluster of nearby instances (column
`37 + k`, `GrassClusterK{4,8,16,32}Component`: a count and room for `4 · 2^k`), a tree entity one
instance (column 80, `HGTreeComponent`). column 6 (20 bytes) starts with a point and a squared size;
column 7 (24 bytes) isn't identified. the layout comes from a census over map01 and map02, the
component names from the IL2CPP metadata.

map02 holds about a million grass and bush instances in tens of thousands of clusters, and under
twenty thousand trees; map01 a few hundred thousand grass instances and no tree grids. grids repeat
in every file they overlap, under one id. the game measures a cluster's LOD by `rendererHalfSize`
and thins grass by its sparsity at a quality setting; the second instance parameter is the grass
shader's per-instance colour ([materials](materials.md#foliage)).

### cloth groups

the input of the game's [cloth simulation](materials.md#cloth-simulation) sits in kind-3 proxy
objects named `ClothGroupInfo_<group hash>#<level tag>_<id>` (`ProxyEntityType` 8) in the cell files
of the cloths' entities. a group holds up to four cloths, 512 nodes in all, as blobs in the row's
keyed property table (the Streaming row holds only the group hash, under `0xff050000`):

| key          | content                                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `0xff000000` | the group (80 bytes): cloth count, group hash, world XZ, then four each of cloth hashes, node counts, batch counts and cache counts |
| `0xff010000` | 176 bytes per cloth, below                                                                                                          |
| `0xff020000` | 192 bytes per node, below, the group's cloths one after another                                                                     |
| `0xff030000` | batch records, 4 × i32 each (all zero in the cells read)                                                                            |
| `0xff040000` | batch cache records, 4 × i32 each (all zero in the cells read)                                                                      |

a cloth: its node range in the group (u32 start, end), u32 first batch, u32 iterations (3 seen),
then f32 damping, wind frequency factor, wind balance factor and wind intensity scale; 4 × i32 the
game fills at runtime; a vec4 whose x is the longest anchor distance; the cloth's normal; and the
rows of its 3 × 4 local-to-world and world-to-local matrices.

a node, in world space: two anchor node indices (−1 for none) and their rest distances; its UV; two
floats of a collision plane; the rest position (w a weight that grows down the cloth from its
anchors), normal and tangent; the previous and current positions and the current normal, which start
at rest; and eight neighbour node indices (−1 for none) with their rest distances (1e7 for none).

an entity's [component 60](#initchunkdata-layout) holds its cloth's hash, one of the group's four.
the layouts follow the game's `ClothGroupMeta`, `ClothMetaData` and `ClothNodeData` structs, checked
against one Sword Vault Dale cell, whose node positions lie on its canvases; what the batch records
and the unnamed fields hold isn't read.

## stream areas

`Data/DynamicStreaming/PC/Scene/<scene>/FBStreamArea.bytes` lists every area of a scene, the areas
visible by default (`RootVisible`), and trigger volumes: an XZ polygon with a box and height range
per area. while the streaming centre is inside one or more triggers, the client shows the union of
those areas' visible slices; otherwise it shows `RootVisible`. area ids are the `<area>` suffix of
chunk file names and the visibility groups of DynamicStreaming entities.

the file is a FlatBuffer whose root (`FBStreamAreaTotalData`) holds:

| slot | content                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------ |
| 0    | `TotalAreas`: i32 area ids, including 0                                                                      |
| 1    | `RootVisible`: i32 area ids                                                                                  |
| 2    | `AreaVisibleGroups`: i32 area ids, sliced by the areas                                                       |
| 3    | the scene's bounds, inline (24 bytes): min and max (f32 world x, z each), f32 min height, f32 max height     |
| 4    | areas, 12 bytes each: i32 area id, i32 start and count of its slice of slot 2                                |
| 5    | triggers, 36 bytes each: i32 area id, i32 start and count of its slice of slot 6 (a closed ring), its bounds |
| 6    | points, 8 bytes each: f32 world x, z                                                                         |

root slots 7–9 (`HlodUnloadBounds`, `HlodUnloadTriggers`, `HlodUnloadPoints`) are HLOD-unload
trigger volumes in the same layout, each with an unload mask. while the streaming centre is inside
one or more of them the game unloads the meshes of the HLOD clusters the union of their masks
selects, whether or not the clusters are [hidden](#lod-and-hlod), which leaves them nothing to draw;
outside them, or in a scene without any, nothing extra unloads. a mask bit selects the clusters
carrying that index in a per-cluster byte, a sub-scene by the mask's name; where the byte is stored
isn't found.

areas are not interiors only: a level can hold several versions of the same place's backdrop, each
shown from its own zone. map02's Si's Painting has a cliff and floating-rock backdrop (area
701638228 in one client build) that loads only inside a zone west of the inn; shown everywhere,
those rocks would stand in front of the inn's view.

of map01, map02, base01_lv001 and base01_lv002, only map02 has static content in non-default areas.
that content only adds to area 0: none of its entity ids or placements repeat an area-0 entity.
DynamicStreaming entities carry areas too
([scene-states.md](scene-states.md#where-states-are-referenced)): on map02, about one in twenty of
their area lists names one of a couple dozen areas other than the default, among them the falls
pouring over Si's Painting's backdrop cliff.

## dynamic streaming

`Data/DynamicStreaming/PC/Scene/<scene>/` holds the dynamic ECS scene: `fb_main_<L>_<i>_<j>` grid
files, paired `fb_init_*`/`fb_streaming_*` ECS chunks and the stream-area table. it carries prefab
placements, interactives, and scenery gated by progression, quests and variables. its format and how
structures are selected are in [assets.md](assets.md#dynamic-structures).

### dynamic load grids

the dynamic scene streams by its `fb_main` grids, not by the static layers above. a grid id is
`L << 16 | z << 8 | x`: level `L`'s cells are `32 · 2^L` m on a 4096 m frame from −2048 to 2048 on x
and z, and levels 0–5 and 7 exist (no level 6 is scanned or shipped). level 7 is one cell covering
the frame.

- **load.** per level, the grids of the 3×3 block of cells around the streaming centre's cell load,
  the centre clamped into the frame. so a row enters within 1.5 cells of its cell's centre (XZ,
  Chebyshev): 48 m at level 0, 96, 192, 384, 768 and 1536 m at level 5, and level-7 rows are always
  loaded.
- **unload.** a grid stays until the centre leaves a square of side `min(3 · cell + 20, 3.2 · cell)`
  around its cell's centre, about 10 m of hysteresis. the scan reruns when the centre moves 0.1 m.
- **centre.** the same streaming centre as static streaming, most likely the player; a second centre
  can load its own blocks (extra streaming at a position).
- **which level.** a row's level is the grid that stores it, so large or far-reaching content sits
  in coarse grids: Dijiang's corroded planet effect, placed at its deck, is a level-4 row, the
  satellites around the station level 7, and its props level 0. an entity's owner sits in a grid at
  least as coarse as its rows (owners are levels 2–7 on map02 and base01_lv001), so a row's own grid
  is the binding one.
- **per-row radius.** each row of a loaded grid also has a [visibility record](assets.md#payloads).
  importance 3 is always visible and importance 0 isn't tested; any other row shows while a centre
  is within its radius in XZ: the base radius, or if larger the distance from the centre to the
  farthest corner of the 3×3 block of 128 m cells around it (181–362 m), plus a margin of a tenth of
  that, between 2 and 30 m. the shipped base radii reach the far corner of the row's own 3×3 block
  (within about 1 m on over 99 % of rows, the rest larger), so the test almost never hides a row
  whose grid is loaded. map02's rows are mostly importance 1, with far fewer at 0 and 3. whether an
  untested row starts visible, and how far the centre moves before rows are tested again (5 m, by
  the setting's name), is unchecked.
- once loaded, a prefab's renderers are culled only by their own LODGroups and effect LOD tables
  ([effects](effects.md#effect-lod-tables)). the LOD proxies the dynamic scene builds for models and
  effects never hide them: a proxy names a near and a far grid containing the row (the satellites'
  are a level-3 and a level-5 cell, small effects' levels 0 and 1, the corroded planet's its own
  grid twice) and sets the animator's or effect's LOD level to the first of them that's loaded, else
  to 2. an effect's level is the band its root's LOD table shows, the same index (High, Mid, Low);
  the camera's distance and the table's cull distance play no part.

## terrain

terrain lives in VFS group `F84BF5E6`:

```
Data/Terrain/PC/<scene>/Terrain_<level>_<x>_<z>_<H|N|T|A|S|C>.bytes
Data/Terrain/PC/<scene>/Layers/LAYER_<D|N|C>_<index>.bytes
```

each file is a u32 clear size and an inverted-LZ4 block (a few are stored raw, e.g.
`dung02_dg005/Layers/LAYER_C_3`), and the clear bytes are a 20-byte little-endian `TRET` header
(magic, `u32` version 1, `u16` width, height, mip count and Unity `GraphicsFormat`, `u32` payload
size) followed by one texture's mip chain, which fills the payload exactly. the mip count field is
inferred from layer files, whose payloads are exactly the sum of their mip chains.

tiles form a quadtree over the scene's terrain square: level `l` splits it into `2^l × 2^l` tiles,
`x` along +X and `z` along +Z. the finest tiles are 64 m (map02's leaf is level 6, map01's level 5).

| channel  | content                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------- |
| `H`      | 65² heights, R8G8 read as little-endian u16, 1 m spacing; outer samples are shared with neighbours |
| `N`, `A` | baked normal and albedo pages, DXT5                                                                |
| `T`      | tint page, DXT5 sRGB                                                                               |
| `S`      | splat control, RGBA8                                                                               |
| `C`      | 34² cliff index, R8G8, driving the cliff projection                                                |

pages are 132² with a 2-texel border around a 128² core that covers the tile edge to edge, and have
one level. every tile with a height page has all six channels, at every level. layers are per-scene
material textures addressed by index ([close-up layers](#close-up-layers)): `D` diffuse (BC7 sRGB),
`N` normal (BC7), `C` cone maps for parallax (R8). the terrain shader binds the tile channels as
`_HeightmapAtlas` (`H`), `_NormalmapAtlas` (`N`), `_TintColorAtlas` (`T`), `_AlbedoAtlas` (`A`),
`_SplatCtrlAtlas` (`S`) and `_CliffIndexAtlas` (`C`), and the layers as the texture arrays `_Splats`
(`D`), `_Normals` (`N`) and `_ConeMaps` (`C`).

the baked `A` and `N` pages are what the game draws where its close-up layer blend doesn't reach:

| channel | r                   | g                   | b                    | a                          |
| ------- | ------------------- | ------------------- | -------------------- | -------------------------- |
| `A`     | albedo, linear      | albedo              | albedo               | subsurface curvature input |
| `N`     | world normal x ·2−1 | world normal z ·2−1 | perceptual roughness | occlusion                  |

`A` is linear despite its UNorm format, and the normal's y is `√(1 − x² − z²)`. the normal's
orientation was checked against normals from the height page (r = +X, g = +Z, rows along +Z).

the terrain's placement isn't in the tiles. it comes from the scene's `HGTerrainSurfacesData`
MonoBehaviour at
`assets/beyond/dynamicassets/scenes/pc/<scene>/terrain/hgterrainsurfacesdata.asset`:

- `terrainPosition`: world position of the square's minimum corner; `y` is the height of a zero
  sample
- `heightScale`: metres spanned by the 15-bit height range
- `terrainSize`: root edge length, a power-of-two multiple of 64 m
- `nodeData`: a complete breadth-first quadtree (`index = (4^l − 1)/3 + z·2^l + x`) down to the leaf
  level, whether or not a node has tile files, with per-node `nodeLevel` (0 for the root and for
  levels above the coarsest tiles), `parent`, `allHole`, min/max height (metres above
  `terrainPosition.y`) and a `maxHeightError` (metres). on map02 `localMaxHeight` is the maximum of
  the node's samples with the hole bit masked off, and `localMinHeight` counts holes as 0. despite
  its name, `maxHeightError` isn't the error of drawing the node instead of its children: leaves,
  with nothing finer, carry hundreds of metres on map02, and against the children's samples it runs
  from about equal to over a hundred times the measured error. it follows the node's page's largest
  step between neighbouring samples (per level, typically most of it, rarely above). what the game
  uses it for isn't known
- `layerData`: the close-up material layers by ordinal; see below
- `sectorSplatInfo`: one u64 per 64 m sector, a bitmask of the layer ordinals the sector uses
  (checked against the index map on map02)

world Y of a sample is `position.y + (h & 0x7fff) · heightScale / 32768`. bit 15 marks a hole. on
map01 and map02 about 95% of holes have no height (their low bits are 0, the terrain's base); only
some beside solid ground keep one. holes are cut per vertex: the terrain's vertex shader gives a
vertex on a hole sample no position, so every triangle touching it is dropped whole, and a solid
sample ringed by holes draws nothing. the pass draws patches of 16 × 16 quads cut along alternating
diagonals: a quad whose x + z in the patch is even is cut from its minimum corner to its maximum
corner, an odd one across. so of a quad with one hole corner, the triangle away from that corner
draws only if the diagonal doesn't end on the hole. that a patch's quads fall on its page's samples
with the page's parity (16 samples a patch, pages being 64 quads wide) is inferred, not traced.

the game's subdivision passes (`TerrainDepthOnlySubdivision` and its like) instead read the four
samples around a vertex, drop it only when all four are holes, and take its height from the solid
ones alone. the pipeline turns them on only while terrain deformation is enabled; which scenes
enable it isn't surveyed.

### close-up layers

near the camera the game draws a blend of tiling material layers instead of the baked pages.

- **index**: `terrain/splatindexmap.tga`, an RGBA32 Texture2D of `terrainSize / 8` texels (row 0 at
  the minimum z), names 4 layer ordinals per 8 m cell, each stored times 4
- **weights**: the leaf's `S` page; rgb weight the cell's slots 0–2, slot 3 gets `1 − r − g − b`.
  the weights belong to that cell's layers
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
- **projection**: world position times the layer's repeats per metre, on the x, y and z planes. the
  game picks one plane per pixel at random

### puddles

the `S` page's alpha is a puddle level, independent of weather. water stands where it rises above
the ground: close up the ground is the layers' heights weighted by the splat weights (`Σ w · h`, the
same `w` as above), far away a flat 0.5. with `w = sat((S.a − ground) / 0.46)`:

- albedo × `1 − 0.35 w`
- roughness → 0 and occlusion × `1 − 0.1 w`
- the normal bends towards straight up by `0.98 w`

layers with parallax enabled use a parallax-weighted height instead of `Σ w · h`.

## LOD and HLOD

the game ships per-entity LODs and three tiers of HLOD clusters with their own materials and
atlases.

- **per-entity LOD chains.** every static draw carries its LOD index and a
  `(minSquared, maxSquared]` range of squared screen-relative height, as in Unity's LODGroup.
  `maxSquared` is `FLT_MAX` on the nearest LOD. a negative `minSquared` would read as never culled
  by size, but every one seen is `−k²` with `k` between 0.005 and 0.05 (−0.000225 on many map02
  draws, −0.0001 on every map02 HLOD cluster, −0.0025 on every indie_dg005 one, −0.0004, −0.000025),
  so they may be ordinary cull heights stored negated.
- **foliage cards.** imposter card meshes (`…_cardmesh`) appear as ordinary LODs, usually the last
  but not always: thousands of map02 card draws are an earlier LOD with a size cull (LOD 3 of 5, 4
  of 6).
- **shadow proxies.** draws with the `ShadowOnly` [render flag](#render-flags) only cast shadows.
- **HLOD clusters.** auto-generated per-level clusters in three tiers, placed as ordinary entities
  named `HLOD<tier>_<i>_<j>_Cluster_<hash>…`, `i`/`j` being the tier's grid cell, with negative
  coordinates clamped to 0 (west and south of the grid origin every cluster is named on cell 0). one
  large member can stretch a cluster's bounds hundreds of metres past its cell. their draw range is
  unbounded, so HLOD visibility is decided by the HLOD links below, not by LODGroup. they occur only
  in Global chunk files, on the [streaming layer](#streaming-layers) of their tier, and only the
  `pc` HLOD platform variant ships. Jingyu's tiers run from a few hundred meshes and about 450k
  triangles (HLOD0) to a few dozen meshes and about 45k (HLOD2). the number after a cluster's hash
  (`_250`, `_600`) is its height rounded to 50 m, not a switch distance.
- **HLOD links.** a renderer entity's StreamingChunkData row holds its place in the HLOD tree under
  `0xff000000` (the game's `HLODInfo`): its own entity id, its parent cluster's id (0 without one),
  how many children name it as their parent, and its index among its parent's children (−1 without
  one); all zero for an entity outside every tree. an HLOD2 cluster's children are HLOD1 clusters,
  an HLOD1's are HLOD0 clusters, and an HLOD0's are the renderers it was built from, in the cell
  files on the `Default` and `RendererWithCollider` layers. top tiers are missing where a scene has
  none (map01 has no HLOD2), and a few clusters have no parent. the game counts each cluster's
  loaded children as entities enter and leave the scene:
  - a cluster hides once every one of its children is loaded, and shows again when one unloads
  - a child hides while its parent is loaded and one of its siblings isn't; with the parent not
    loaded it shows
  - so a child that never loads (a few HLOD1 clusters count more children than the files hold, and
    children in a scene-state or area file load only with it) keeps its cluster shown and its
    siblings hidden
- **unlinked clusters.** an entity named as a cluster whose link is zero is never hidden: it's
  ordinary scenery on its layer. indie_dg005's are all like that, about 240 HLOD0 clusters on the
  `Persistent` layer that are Wuling City seen from the office windows, with the buildings they were
  built from not shipped; map02 and dung02_rdg008 have a handful on their tier's layer.
- **HLOD grids.** each tier's cells double the previous tier's, but the tier-0 cell and the grid
  origin vary by scene, and where the game stores them isn't found. fitted to cluster names (the
  origin most cluster centres agree with, over 95 % per axis): HLOD0 cells are 64 m with the origin
  on the terrain square's corner in map01, map02, indie_dg002, indie_dg016 and the 1024 m dungeons
  except dung02_rdg008, whose origin is (−256, −256) inside its (−512, −512) square. dung02_dg002's
  is (−1664, −832) on a 4096 m square, and indie_dg005's cells are 128 m from (−1728, −832), so its
  cells and dung02_dg002's HLOD1 cells are offset from the terrain quadtree by half a cell.

## streaming layers

the game streams static scenery by layer, each with its own grid and load radius around a streaming
centre (most likely the player character, not the camera). the 128 m cell is the unit of file I/O;
within the loaded files each layer's grid cell is the unit that enters the scene. the game calls an
HLOD tier an HLOD level.

| layer                  | grid  | its entities' file | priority |
| ---------------------- | ----- | ------------------ | -------- |
| `Persistent`           | —     | Global             | 0        |
| `HLOD2`                | 256 m | Global             | 1        |
| `HLOD1`                | 128 m | Global             | 2        |
| `HLOD0`                | 64 m  | Global             | 3        |
| `Collider`             | 64 m  | cell               | 4        |
| `RendererWithCollider` | 64 m  | cell               | 5        |
| `Lighting`             | 64 m  | cell               | 6        |
| `Audio`                | 32 m  | cell               | 7        |
| `Water`                | 128 m | Global             | 8        |
| `Default`              | 64 m  | cell               | 9        |
| `Tiny`                 | 32 m  | cell               | 10       |

layers that read their entities from Global are why HLOD clusters and water decals occur only in
Global chunk files. a lower priority loads first, then the nearer cells. an entity's layer is a byte
in its [object row](#initchunkdata-layout), and the HLOD layers hold more than clusters: scenery
meant to show as far as a tier does sits on that tier's layer without a link, so it loads within the
tier's radius and never hides. that's about 17 thousand map02 entities across the three HLOD layers
(most of its `farmod` far-field assets among them, the rest being `Persistent` or `Default`) and
nearly every static renderer of indie_dg005, on `HLOD1`. `Tiny` holds about 70 thousand of map02's
small renderers.

the radii come from the settings INI TextAssets (`assets/beyond/initialassets/settings/*.ini` in the
initial bundles; PC reads `desktopsettings.ini`), sections `[Streaming@<preset>]`, over defaults in
code. the preset is the scene detail quality: 1000 lowest to 5000 highest, 4000 being the high
preset and 5000 very high (`windowsplayer_qualitymap.json`; a medium device defaults to 3500). 2000
has no section and takes 1000's; values in brackets are inherited from a lower preset, which is
assumed:

| radius, m   | 1000 | 3000 | 4000  | 5000  | code default |
| ----------- | ---- | ---- | ----- | ----- | ------------ |
| chunk files | 128  | 128  | 160   | 256   | 256          |
| `Default`   | 96   | 128  | 160   | 256   | 128          |
| `HLOD0`     | 256  | 384  | 512   | 640   | 256          |
| `HLOD1`     | 1024 | 1024 | 1024  | 1024  | 512          |
| `HLOD2`     | 2048 | 2048 | 2048  | 2048  | 1024         |
| `Collider`  | 128  | 128  | 128   | 128   | 128          |
| `Tiny`      | 96   | 128  | (128) | (128) | 32           |
| `Lighting`  | 96   | 128  | (128) | (128) | 128          |

`Water` (128 m) and `Audio` (16 m) take code defaults. `RendererWithCollider` uses the larger of
`Collider` and `Default`, and a scene can override `Default`'s radius. a low-memory device is forced
to preset 1000 for streaming, LOD streaming and texture streaming, unloads before it loads, and on
maps whose streaming config sets `useLowMemoryHLODLoadParameter` (map02 does, map01 doesn't) takes
HLOD radii of 256, 1024 and 2048 m (256, 512 and 1024 by code default). the mobile INI's preset 1000
has `Default` 64, `HLOD0` 128, `HLOD1` 896 and `HLOD2` 1280 m.

- **selection.** distances are measured in XZ only. every 128 m file whose square meets the circle
  of the chunk radius is read (with each scene-state and area file that exists for it), plus the
  Global files; every layer cell whose square meets that layer's circle loads (`Persistent` is one
  cell). a layer can be switched off for the default area. a second source can load around another
  position (seamless and extra loads).
- **hysteresis.** cells are added on a pass after the centre has moved 4 m and removed on a pass
  after 20 m (12 m by code default and on mobile), so a cell unloads at up to 20 m past its radius.
- **HLOD rings.** no distance hides a cluster: the [HLOD links](#lod-and-hlod) do, once all its
  children are loaded, so the rings follow from the layers' radii. a cluster's children load within
  the next finer layer's radius, which puts HLOD0 clusters out from about `Default`'s radius, HLOD1
  from HLOD0's and HLOD2 from HLOD1's: at preset 5000 detail to 256 m, HLOD0 to 640 m, HLOD1 to 1024
  m and HLOD2 to 2048 m, with nothing streamed beyond. the swap is per cluster and waits for the
  last child, so a cluster whose children span several cells shows until the farthest one is in
  range, hiding its nearer children meanwhile.
- **HLOD resources.** separately, a hidden cluster's meshes unload while the camera (in 3D, to a
  point stored per cluster) is within the next finer layer's radius, and load again beyond it; a
  cluster that isn't hidden keeps them. the [HLOD-unload volumes](#stream-areas) unload them
  regardless.
- **time budget.** loading gets 1.5 ms and unloading 2.5 ms per frame (3.5 and 0.5 by code default),
  scaled by the smoothed frame time over 33.3 ms (0.1–2×), so about 0.75 and 1.25 ms at 60 fps;
  teleports have no limit.
- **why 128 m** isn't stated anywhere. at the lower presets the chunk radius is one cell, so a few
  files cover the detail radius, while the finer layer grids pick what enters the scene more closely
  than the files are read.
- the renderer's screen-size cull is off on PC. the LOD bias is 2 at preset 1000, 1.5 at 2000 and 1
  from 3000 up.

### texture streaming

the PC settings turn on Unity's texture streaming (`TextureStreaming`: 256 renderers a frame, 512
from preset 3500; 32 file reads in flight, 36 from 2000, 48 from 3500). its budget is for textures
alone and comes from the GPU's memory, not the preset (`TextureQuality_<n>GB`, read as MB, the unit
of Unity's `streamingMipmapsMemoryBudget`):

| VRAM  | preset 1000 | 2000 | 3000+ |
| ----- | ----------- | ---- | ----- |
| 6 GB  | 1000        | 1300 | 1500  |
| 8 GB  | 2000        | 2300 | 2500  |
| 10 GB | 2500        | 3000 | 3500  |
| 12 GB | 3000        | 3500 | 4500  |
| 16 GB | 3500        | 4500 | 5500  |

the budget is capped at 5500 MB, and 5500 MB is reserved for meshes and render targets. effect
textures skip one mip on 6 GB cards. Unity's streaming picks each texture's mip from the renderers
using it and, when the wanted mips don't fit the budget, drops mips (Unity's documented behaviour;
the game's `streamingMipmapsMaxLevelReduction` isn't found in its settings).

## teleport points

teleport destinations are five MemoryPack tables in the JsonData group,
`Data/Json/GameplayConfig/<source>TeleportValidationDataTable.json` (`TeleportValidationDataTable`:
id → level id, position, Euler rotation, a reason and a permitted deviation), one per kind of
caller:

| source        | ids                                                                |
| ------------- | ------------------------------------------------------------------ |
| `Map`         | `TpForMap_ent_<interactive id>`: the map's fast-travel points      |
| `LevelScript` | `TpForLs_…`: level script teleports (not decoded, below)           |
| `Cinematic`   | `TpForCs_<guid>`: where a cutscene puts the player; often no level |
| `Guide`       | `TpForGd_<guide group>_…`                                          |
| `CommonSys`   | `TpForComSys_Mp:/CabinPoints/<room>`: Dijiang's three cabin rooms  |

a `Map` entry's id names the interactive the player travels to, and its position is where they
arrive, a few metres from it facing the stored yaw: `TpForMap_ent_2100000031` in map01_lv001 is a
campfire's LevelData id, with the arrival point 4.3 m from the campfire.
`GameplayConfig/LevelMapMark.json` holds the map marks that point at these ids; it isn't read.

## named places

the place name the HUD shows as the player walks ("Wuling City · Fangxing Avenue") comes from
volumes in LevelData, not from the map: each LevelData file's `functionArea` holds parallel lists,
`baseData` (a volume: type, shape, position, Euler rotation, size or outline, a unique id),
`specificDatas` (what the volume does), `ranges` (its world bounding box) and
`functionAreaConditions` (a condition per unique id, for volumes that exist only in some quest
states). a volume whose specific data is a `SceneToastUIData` names a place:

- `mainTitle`, `subTitle` and `depthText` are TextTable keys
  (`scene_map02_lv002_regiontoast_tips_8`). the main title is the level's name, the subtitle the
  place's and the depth text a flavour line ("Depth: 0.0461±0.0057")
- `priority` 1 volumes are the places. each open-world level also has one priority 0 volume over all
  of it, titled with the region and the level ("Wuling · Test Area"), which shows where no place
  does
- the shape is a box (`shapeType` 1: `size` about `postion`, turned by `euler`) or a polygon (3:
  `posList`, x and z relative to `postion`). the range gives the height span, so places stack
  (Yuanyuan Manor's two floors)

map02 has about 120 of them and map01 about 80; story interiors have a handful (Suiming, the Marker
Stone) and most dungeons none. a level keeps them in its main LevelData file or a sub-file of their
own (`map02_lv002_lv_data_sub_RegionToast.json`).

these aren't the `mapVolumeDatas` of the same files (`LevelMapRegionData`, also collected in
`GameplayConfig/MapRegionTable.json`): those are the map screen's regions, by `mapRegionType` the
fog-of-war pieces (mist), multi-floor containers and their tiers, and oxygen zones, and carry no
name.

LevelData also says where the ground people use is: `worldWayPointData` is the graph ambient NPCs
walk (points with links to their neighbours; Wuling City and the Marker Stone have several hundred
each), and NPCs, interactives, enemy spawners and patrol points stand on it. air walls (`airWalls`,
polylines with a height range) fence it.

## open

- terrain: the distance where the close-up layers give way to the baked pages and how they fade; how
  the cliff projection (`C` page) and the cone-map parallax (`LAYER_C`) shade; what `maxHeightError`
  is for
- the meaning of a negative `minSquared` (never culled by size, or culled below `√−minSquared`)
- the size the LODGroup thresholds are authored against (the object's bounds, a LODGroup size, …)
- the HLOD generated-material channel layout
- where a scene's HLOD grid (the cell and origin cluster names count on) is defined, why it leaves
  the terrain quadtree in some scenes, and how it relates to the HLOD layers' own grids
- where a cluster's sub-scene index is stored, which an HLOD-unload volume's mask selects
  ([stream areas](#stream-areas))
- the dynamic rows' `Dis` and `MinDis`, which nothing reads at runtime; a third kind of LOD proxy
  that does cull by the visibility record isn't followed
- what dungeon levels that reuse an open-world scene add of their own: a census of map02's chunk
  files found no tags but 0, 31 and lv001–lv010's, so it can only come from LevelData and
  DynamicStreaming
- [teleport points](#teleport-points): the `LevelScript` table (the largest) doesn't decode with the
  layout the other four share, and which mark of `LevelMapMark.json` uses which destination isn't
  read
