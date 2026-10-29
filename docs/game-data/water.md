# open-world water

this page covers how the game stores open-world water: surface placements, per-surface `WaterConfig`
assets, and the scene-wide `Global_Water_Config` with its flow, caustic and wave-normal maps. it
then covers how the packer turns them into `tables/water.json.zst` and how the viewer draws them.
for the generic container (blobs, archives, texture and geometry tables) see
[package-format.md](../package-format.md); for scene-state conditions see
[scene-states.md](scene-states.md).

## game data

three sources join per surface: an InitChunkData row places it, the StreamingChunkData record with
the same entity id binds its mesh and config, and a per-level object binds the scene's global
config.

| source                                               | decoder                                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| InitChunkData component 30                           | `readWaterSurfaces` in [water.ts](../../packages/formats/src/endfield/water.ts)                               |
| StreamingChunkData property tables                   | [streaming-chunk-data.ts](../../packages/formats/src/endfield/streaming-chunk-data.ts)                        |
| `WaterConfig` / `Global_Water_Config` MonoBehaviours | `readWaterSurfaceConfig`, `readWaterGlobalConfig` in [water.ts](../../packages/formats/src/endfield/water.ts) |
| scene-wide join over chunk files, asset loading      | [water-source.ts](../../packages/extractor/src/game/water-source.ts)                                          |

the component layout follows An1X3R/Endfield-map-extractor (MIT, `extractor_core/water.py`).

### placements: InitChunkData component 30

every water surface is an entity of a **Global** chunk (no cell chunk holds one in any scene of the
current client). the groups holding them have the bounds columns 0–5, an unread 24-byte column 7,
the name column 21 and component 30, whose rows are 104 bytes:

| offset | type   | field            | notes                                                                                |
| ------ | ------ | ---------------- | ------------------------------------------------------------------------------------ |
| 0      | u32    | render type mask | 1 or 2; meaning unknown. 1 is mostly paddy pools and small planes                    |
| 4      | i32    | runtime mesh id  | always 0                                                                             |
| 8      | f32×16 | object-to-world  | column-major, translation at floats 12–14, same convention as the renderer component |
| 72     | f32×4  | param0           | always 0                                                                             |
| 88     | f32×4  | param1           | `w` always 1; `x`, `y`, `z` vary, meaning unknown                                    |

`readWaterSurfaces` rejects a row with a zero mask, a non-finite value or a missing binding, because
each of those has never occurred and would mean the layout moved.

the level tag is `id >>> 27` as for every entity; tag 0 is shared content shown with every level.

a surface can appear in several chunk files. `readSceneWater` keeps the first copy by id (files in
name order) and records the scene state of every file holding it. a surface found in an
always-loaded file (scene state 0) is unconditional; otherwise it loads while any of its files'
MapConfig scene states is active. map02's paddy-field pools are the main example of scene-state
water.

### bindings: StreamingChunkData

the StreamingChunkData sibling of each chunk file (same name with `StreamingChunkData_`) holds a
kind-2 record per surface id. its property table binds two u64 StringPathHash keys (property type
15):

| key          | binds                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------- |
| `0xff000000` | surface mesh                                                                                |
| `0xff010000` | surface `WaterConfig` MonoBehaviour                                                         |
| `0x20000000` | the scene's `Global_Water_Config`, on a kind-1 object named `Water#<tag>_…` (one per level) |

keys are `component << 24 | field << 16 | index`. the `0xff` component is archetype-specific: other
entity archetypes reuse those keys for their own bindings (rect decals bind their material under
`0xff010000`), so read them as water bindings only on entities that carry component 30. `0x20` is
the HGWaterGlobalConfig streaming component bit.

### surface meshes

four kinds occur, and all resolve with `AssetResolver.findUnique(…, UnityClass.Mesh)`:

| mesh                                                          | transform                                    | notes                                 |
| ------------------------------------------------------------- | -------------------------------------------- | ------------------------------------- |
| `com/water/models/s_waterquad.fbx`                            | scales a 0.1 m quad up to the surface's size | 4 vertices, uv0                       |
| the render pipeline's `plane.fbx`                             | scales a 0.1 m Unity plane                   | 121 vertices; paddy fields            |
| `<map>/water/water_<map>_pcgwater…_lod0.fbx`, `s_river_*.fbx` | mostly identity: authored in world space     | river meshes, uv0                     |
| `<level>/Water/PolygonMeshes/S_polygon_water_*.asset`         | identity                                     | flat world-space polygons, **no UVs** |

the water shading works in world x, z, so positions are the only attribute it needs.

### surface `WaterConfig`

a MonoBehaviour per look (`…/WaterData/WaterConfigs/Config_water_<Map>_<n>.asset`, plus the shared
`Config_paddy_filed_water.asset`). `readWaterSurfaceConfig` keeps every top-level numeric field
under its serialized camelCase name: flags as 0/1, Unity math structs as `[x, y(, z, w)]` /
`[r, g, b, a]`. field groups:

- flow and waves: `useFlowMap`, `flowDirectionVector2`, `flowSpeed`, `flowFullCycle`,
  `normalTilling`, `normalScale`, `smallWaveNormalType`, `largeWaveNormalType`,
  `largeWaveFlowSpeed`, `largeWaveNormalTilling`, `largeWaveNormalScale`, `flowFullCycleLarge`,
  `largeWaveInvDir`, displacement scalers
- optics: `waterRayleighScatteringMeter`, `waterRayleighAbsorptionMeter`,
  `waterRayleighAbsorptionMeter2`, `absorptionTint(2)`, `scatterTint`, `absorptionScale`,
  `scatterScale`, `safeFullAbsorpDistance`, `envLightIntensity`, `sceneColorEnvInfluence`,
  `rayleighMieLerpFactor`, `distanceEdgeBlendFactor`
- appearance: `roughness`, `specular`, `waterIOR` (a screen-space distortion strength, not an index
  of refraction), `flowBaseColor`, `foam*`, `distanceFade`, `envLightSpecularIntensity`,
  `punctualLightSpecularIntensity`, `emissiveStrength`
- caustics: `causticTilling`, `causticOpacity`, `causticDistort`, `causticSpeed`,
  `causticStartDepth`, `causticEndDepth`
- character interaction (`interactive*`, `ripple*`): irrelevant without a player

bind configs to surfaces by asset key, never by the config's `materialIndex`. `materialIndex` is
meant to index the global config's `hgWaterConfigs`, but the paddy config isn't in that list and its
index collides with another config's.

### `Global_Water_Config`

one per scene with water, at `…/<Map>/ReleaseData/WaterData/Global_Water_Config.asset`; every
level's binding names the same asset.

| field                                                                           | meaning                                                                                                  |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `sceneCenterOffset` {x, y}                                                      | world x, z the grid is centred on                                                                        |
| `mapSize`                                                                       | edge of the square the global flow map and the sector grid cover, metres                                 |
| `sectorSize`                                                                    | edge of one sector, metres                                                                               |
| `flowmapPrecision`                                                              | metres per texel of a sector flow tile                                                                   |
| `useSectorData`, `sectorDataPaths`, `sectorDataAssetHashes`, `sectorDataExists` | the sector grid, parallel arrays over every grid cell                                                    |
| `hgWaterConfigs`                                                                | PPtrs to surface configs (incomplete, see above)                                                         |
| `flowMap`                                                                       | 2D flow map over the whole grid, linear BC7, one mip                                                     |
| `causticMap`                                                                    | caustic pattern, sRGB BC7                                                                                |
| `rainMap`                                                                       | rain ripple map, linear BC7                                                                              |
| `normalMapArray`                                                                | Texture2DArray of wave normals (two layers), linear BC7                                                  |
| `lodNum`, `meshNumPerLOD`, `meshSize`, `heightMap*`                             | the game's own clipmap water mesh; nothing in the placements references them, so the viewer ignores them |

`readWaterGlobalConfig` keeps only sectors with `sectorDataExists` set. it takes each sector's
`(x, z)` from its path (`…/Sector/T_<x>_<z>.asset`) rather than from its array index, and turns the
signed `sectorDataAssetHashes` entry into an unsigned 64-bit key. sector `(x, z)` covers world
`[centre.x + x·sectorSize, +sectorSize) × [centre.z + z·sectorSize, +sectorSize)`; clearly more
surface centres land in sectors with data under this mapping than under swapped or flipped axes.
each sector MonoBehaviour's `waterSectorTexture0` is a flow tile (256², linear BC7, one mip) holding
the global flow map's content at `flowmapPrecision`. its `rippleLayerBuffer` is unread.

## package: `tables/water.json.zst`

[pack/water.ts](../../packages/extractor/src/pack/water.ts) plans the table before asset conversion
and fills in texture ids after it (`planWater` → `finishWater`, the same split as environments). the
types, with field-level JSDoc, are `WaterTable`, `WaterGlobal`, `WaterSector`, `WaterConfigEntry`,
`WaterConfig` and `WaterSurfaceEntry` in [format.ts](../../packages/package-format/src/format.ts).

```
WaterTable
  global     WaterGlobal | null   null without water, or when the package holds no surface
  configs    WaterConfigEntry[]   { name, values } deduplicated by asset key
  surfaces   WaterSurfaceEntry[]  { id, level, condition, geometry, transform, bounds, config,
                                    renderTypeMask, param1 }
WaterGlobal  { mapSize, sectorSize, centre, flowmapPrecision,
               flowMap, causticMap, normalMaps, rainMap, sectors: { x, z, texture }[] }
```

water is resident in the game (Global chunks only) and small, so the whole table ships in the core
archive and every surface is always available to the viewer.

packing rules:

- **chunk files**: only Global files are read, since no cell file holds water.
- **subset**: a surface is kept when the packer's `includesEntity(levelTag, centre x, centre z)`
  accepts its bounds centre, the same rule as instances.
- **configs**: loaded once per distinct asset key. every field `WaterConfig` names must be present
  with its declared shape, so the viewer can read them as typed; a config failing that or failing to
  load drops its surfaces. the remaining numeric fields ride along under their own names.
- **meshes**: interned into the geometry table and placed in the common asset archive, because
  surfaces are resident. no chain draws them, so no tangents are generated; polygon meshes come out
  with position and normal only.
- **transform**: the column-major matrix becomes rows3x4 like instance transforms, but absolute (no
  block origin).
- **conditions**: surfaces with scene states get a `condition` index into
  `StatesInfo.conditionalSets` (`gateByScene` in
  [packer.ts](../../packages/extractor/src/pack/packer.ts)), shared with instances and environment
  volumes.
- **global maps** go to the common archive. **sector tiles** go to the asset archive of the
  shard-level tile under the sector's centre, so a region import carries the tiles it needs. full
  packages keep every sector with data; subset packages keep the sectors overlapping a packed
  surface's bounds.
- **errors** (failed configs, missing global binding, unresolvable maps or sectors) go to
  `debug/water.json` with per-surface rows (id, name, chunk file, mesh and config paths). they never
  fail the pack.
- surfaces aren't instances and don't count toward `LevelInfo.instances`.

for inspection without packing, `pnpm -s extract water surfaces|census|config` dumps placements,
counts per level, chunk file, mask, mesh and config, and single config assets
([commands/water.ts](../../packages/extractor/src/commands/water.ts)).

## viewer

[water-renderer.ts](../../packages/viewer/src/render/water-renderer.ts) and
[water.wgsl](../../packages/viewer/src/render/shaders/water.wgsl).

- **selection**, per frame: surfaces whose `level` is the shown level or 0, whose condition passes
  the current scene values, and whose geometry entry is ready. each wants its geometry blob at a
  priority falling with horizontal distance from the camera; resident ones inside the frustum are
  drawn, up to 4096.
- **pass**: drawn in the post chain after compositing, over a copy of the HDR scene, and only in the
  `lit` debug view. both faces are drawn so water reads from below. transforms are made eye-relative
  on the CPU; the vertex stage reads only the dequantized `unorm16x4` positions.
- **textures**: the wave-normal array and the global flow map are streamed whole. caustic, rain and
  sector tiles are packed but unused.
- **shading**, in the config's terms: the water column between the surface and the scene depth below
  absorbs and scatters with the per-metre coefficients (`waterRayleighAbsorptionMeter2` blending
  toward `waterRayleighAbsorptionMeter` as the thickness approaches `safeFullAbsorpDistance`), lit
  by the sun through a Rayleigh/Mie phase mix (`rayleighMieLerpFactor`) and ambient sky
  (`envLightIntensity`). two wave layers from the normal array (`smallWaveNormalType`,
  `largeWaveNormalType`) flow along the flow map (`useFlowMap`) or `flowDirectionVector2`,
  cross-fading two phases per layer; `largeWaveInvDir` reverses the large layer. the waves offset
  the refracted lookup by `waterIOR`, and Fresnel (f0 0.02 scaled by `specular / 0.5`) mixes in the
  sky reflection and a GGX sun highlight. `distanceEdgeBlendFactor` fades shallow water into what's
  under it. foam isn't drawn.

the flow-map orientation (`uv = (world.xz − centre) / mapSize + 0.5`), the flow and normal channel
meanings, and the blend between the two absorptions come from community tooling, not the game's
shaders. treat them as the first suspects when the water looks wrong.

### WaterProxy and WaterDecal

no static InitChunkData renderer uses an `HGRP/WaterProxy` or `HGRP/WaterDecal` material, so water
in static scenery is only the surfaces above. these shader families can arrive through prefab
content. the mesh renderer skips `waterDecal` and has no dedicated path for `waterProxy`.

## open

- `renderTypeMask` and `param1.xyz`: likely a pass split and per-surface flow or foam options; needs
  the game's water rendering code.
- the unread 24-byte column 7 beside component 30.
- flow and normal channel meanings and the flow-map UV orientation (see above).
- what WaterProxy meshes render (possibly water inside prefabs writing the same inputs as surfaces)
  and what WaterDecal projects.
- caustics, foam, rain and sector tiles aren't used by the viewer yet.
