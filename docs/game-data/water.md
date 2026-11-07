# open-world water

open-world water uses surface placements, per-surface `WaterConfig` assets and a scene-wide
`Global_Water_Config`; gameplay [water volumes](#water-volumes) and [WaterDecal](#waterdecal) foam
boxes draw through the same pipeline. for scene-state conditions see
[scene-states.md](scene-states.md); the lighting the water shares with surfaces is in
[lighting.md](lighting.md), and waterfall sheets are [effects](effects.md#waterfalls).

three sources join per surface: an InitChunkData row places it, the StreamingChunkData record with
the same entity id binds its mesh and config, and a per-level object binds the scene's global
config.

## placements: InitChunkData component 30

every water surface is an entity of a **Global** chunk (no cell chunk holds one in any shipped
scene), so water is resident. the groups holding them have the bounds columns 0–5, a 24-byte column
7 (see below), the name column 21 and component 30, whose rows are 104 bytes:

| offset | type   | field            | notes                                                                                        |
| ------ | ------ | ---------------- | -------------------------------------------------------------------------------------------- |
| 0      | u32    | render type mask | bits of the game's `HGWaterRenderType`: 1 proxy, 2 LOD (below)                               |
| 4      | i32    | runtime mesh id  | always 0: filled in at load                                                                  |
| 8      | f32×16 | object-to-world  | column-major, translation at floats 12–14, same convention as the renderer component         |
| 72     | f32×4  | param0           | (material index, 0, 0, 0); the index is filled in at load from the bound config, so 0 here   |
| 88     | f32×4  | param1           | (wetness offset (m), height layer 0–3, 1 to sort by distance, 1 to wet the ground around it) |

in every shipped row the mask is nonzero, every value is finite and both bindings are present.

map02's 872 LOD surfaces are its open water; the 431 proxy-only ones are mostly paddy-field pools.
the wetness offset raises the surface when the game darkens the ground it touches. the 24-byte
column 7 is the generic render-object info every renderable entity carries: layer mask, flags, scene
mask, an art tag and a squared sorting distance.

surfaces have no materials of their own: the render pipeline draws them all with its own
`HGRP/WaterProxy` and `HGRP/WaterRendering` shaders, indexing the configs by material index.

### how surfaces are drawn

every camera-visible surface is drawn into the water G-buffer as its own mesh, shaded around the
mesh's normals. a **LOD** surface is also drawn top-down into the height layer `param1.y` names, and
what that view sees near the camera is redrawn as a camera-centred grid displaced by the waves,
whose normals point up. the grid draws first and writes 3 into the stencil; the mesh pass draws only
where the stencil isn't 3. so near the camera an LOD surface shows the grid, and beyond the grid's
reach (its exact extent isn't recovered, see [`Global_Water_Config`](#global_water_config)) its own
mesh. both passes cull back faces, test depth LessEqual and write it, so only the nearest front face
at a pixel is shaded. this is read off the passes' render states, not checked in game.

the level tag is `id >>> 27` as for every entity; tag 0 is shared content shown with every level.

a surface can appear in several chunk files under the same id. a surface found in an always-loaded
file (scene state 0) is unconditional; otherwise it loads while any of its files' MapConfig scene
states is active. map02's paddy-field pools are the main example of scene-state water.

## bindings: StreamingChunkData

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
`0xff010000`), so they are water bindings only on entities that carry component 30. `0x20` is the
HGWaterGlobalConfig streaming component bit.

## surface meshes

four kinds occur:

| mesh                                                          | transform                                    | notes                                 |
| ------------------------------------------------------------- | -------------------------------------------- | ------------------------------------- |
| `com/water/models/s_waterquad.fbx`                            | scales a 0.1 m quad up to the surface's size | 4 vertices, uv0                       |
| the render pipeline's `plane.fbx`                             | scales a 0.1 m Unity plane                   | 121 vertices; paddy fields            |
| `<map>/water/water_<map>_pcgwater…_lod0.fbx`, `s_river_*.fbx` | mostly identity: authored in world space     | river meshes, uv0                     |
| `<level>/Water/PolygonMeshes/S_polygon_water_*.asset`         | identity                                     | flat world-space polygons, **no UVs** |

the water shading works in world x, z, so positions are the only attribute it needs. some polygon
meshes have triangles whose normals point down.

## surface `WaterConfig`

a MonoBehaviour per look (`…/WaterData/WaterConfigs/Config_water_<Map>_<n>.asset`, plus the shared
`Config_paddy_filed_water.asset`). field groups:

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
- character interaction (`interactive*`, `ripple*`)

a surface's config is the asset its StreamingChunkData record binds. the config's `materialIndex`
doesn't identify it: it is meant to index the global config's `hgWaterConfigs`, but the paddy config
isn't in that list and its index collides with another config's. the game uploads each config into
the shading's slot `materialIndex` (32 static slots) when its asset loads, listed or not, and
surfaces find their config through that slot. so configs sharing an index overwrite each other, and
wherever both are loaded every surface of either shades with the one loaded last.

## `Global_Water_Config`

one per scene with water, at `…/<Map>/ReleaseData/WaterData/Global_Water_Config.asset`; every
level's binding names the same asset.

| field                                                                           | meaning                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sceneCenterOffset` {x, y}                                                      | world x, z the grid is centred on                                                                                                                                                                                                     |
| `mapSize`                                                                       | edge of the square the global flow map and the sector grid cover, metres                                                                                                                                                              |
| `sectorSize`                                                                    | edge of one sector, metres                                                                                                                                                                                                            |
| `flowmapPrecision`                                                              | metres per texel of a sector flow tile                                                                                                                                                                                                |
| `useSectorData`, `sectorDataPaths`, `sectorDataAssetHashes`, `sectorDataExists` | the sector grid, parallel arrays over every grid cell                                                                                                                                                                                 |
| `hgWaterConfigs`                                                                | PPtrs to surface configs (incomplete, see above)                                                                                                                                                                                      |
| `flowMap`                                                                       | 2D flow map over the whole grid, linear BC7, one mip                                                                                                                                                                                  |
| `causticMap`                                                                    | caustic pattern, sRGB BC7                                                                                                                                                                                                             |
| `rainMap`                                                                       | rain ripple map, linear BC7                                                                                                                                                                                                           |
| `normalMapArray`                                                                | Texture2DArray of wave normals (two layers), linear BC7                                                                                                                                                                               |
| `lodNum`, `meshNumPerLOD`, `meshSize`, `heightMap*`                             | the game's camera-centred grid that LOD surfaces are redrawn on, displaced by the waves by `waveVertexDisplacementScaler` (mostly 0 on map02; map02: 4 rings of 16² cells, 2 m); the top-down view bounding its reach isn't recovered |

a sector has data only where `sectorDataExists` is set. its `(x, z)` is in its path
(`…/Sector/T_<x>_<z>.asset`), and its `sectorDataAssetHashes` entry is the StringPathHash key stored
as a signed 64-bit integer. sector `(x, z)` covers world
`[center.x + x·sectorSize, +sectorSize) × [center.z + z·sectorSize, +sectorSize)`, the game's own
sector lookup. each sector MonoBehaviour's `waterSectorTexture0` is a flow tile (256², linear BC7,
one mip) holding the global flow map's content at `flowmapPrecision`. the data flag doesn't promise
a tile: some sector assets leave `waterSectorTexture0` empty (8 of map01's 154 sectors with data, 24
of map02's 284). near the camera the game reads the flow (and most authored foam) from the sector
tiles, blending to the global map at the edge of a 3 × 3 window of sectors; that lookup assumes 128
m sectors, map02's size.

## shading

the game writes water's normal, roughness and foam into its own G-buffer before the screen-space
reflections run, then lights it in one full-screen pass after the opaque scene, with the sun through
its shadow maps, the [irradiance volume](irradiance.md) and the sky reflection. the normal the waves
bend is the grid's or the mesh's ([how surfaces are drawn](#how-surfaces-are-drawn)).

- **flow**: the global map at `uv = (world.xz − center) / mapSize + 0.5` holds the direction in rg
  (`· 2 − 1`, green negated so it points along −z), foam in b and the wave amplitude in a. without
  `useFlowMap` the direction is `flowDirectionVector2`, encoded the same way. the amplitude scales
  the waves unless `FlowmapOption` is 1, which makes the game read it as coverage; no map02 config
  sets it.
- **waves**: two layers from the normal array (rg the normal, a the small layer's foam shape), each
  at its tiling, speed and cycle; `largeWaveInvDir` reverses the large layer. with a flow map each
  cross-fades two phases that jump by a cycle-dependent offset; without one it scrolls continuously.
  the array is sampled with mip bias `(0.5 − envSpecularDesaturation) · 10`. a fade
  `1 − saturate(distance · saturate(1 − N·V) / distanceFade)` scales the small waves (also by N·V)
  and the large ones down to `distanceNormalMinStrength`, so far water flattens into a mirror; the
  layers combine by reoriented normal mapping around the mesh normal.
- **roughness and foam**: roughness falls from the config's towards 0.01 as the fade rises (a mirror
  near the camera) and moves to `foamRoughness` under foam. foam is the flow's b times the small
  layer's shape over `foamShapeOffset`, times `foamOpacity`, fading out over `foamFadeDistance`; its
  colour is `foamColorG` as authored. it takes the sun's diffuse light, a see-through glow when lit
  from behind (`waterBaseColorSubsurfaceScaler`), the irradiance volume, and `emissiveStrength`.
- **refraction**: the surface point is pushed sideways against the waves (their xz scaled by
  `waterIOR`) by at most 0.5 m, less near the screen's edges and the camera, and the water looks at
  the scene under the pushed point, unless that lies in front of the water. the column's view
  direction then follows the refracted ray, and so does its thickness, except beyond about 20 m,
  where water less than half a metre to a metre deep keeps the straight-through thickness.
- **water column**, between the surface and the ground below (at most 50 m): it absorbs and scatters
  with the per-metre coefficients, `waterRayleighAbsorptionMeter2` (shallow) blending toward
  `waterRayleighAbsorptionMeter` (deep) as the thickness approaches `safeFullAbsorpDistance`. light
  scattered towards the eye is integrated over the column, with each source's extinction lengthened
  by its slant: `1 + 1.394 |V.y|` for the ambient and, as the game writes it, `1 + 20 |V.y|` for a
  risen sun. sources are the irradiance volume (scaled by `envLightIntensity`) and the shadowed sun
  through a phase mix that `rayleighMieLerpFactor` moves from a Henyey–Greenstein lobe (g 0.854) to
  Rayleigh, with less sun let in at grazing incidence; the scene behind adds to both by
  `sceneColorEnvInfluence`. the column takes the sun the way the atmosphere fog does, raw colour
  times intensity. the sun's shadow is looked up 2 m off the surface along the waves' horizontal
  tilt, which dapples it.
- **caustics**: the caustic map, planar in world xz on the ground under the water, twice (the second
  mirrored in z) and distorted by the waves, brighten the scene behind by the fog's sun ·
  `causticOpacity` between `causticStartDepth` and `causticEndDepth` of thickness, fading out by 50
  m of view depth.
- **sun highlight**: GGX off a normal whose vertical part is scaled by `dirSpecNormalScaler`, which
  widens the glitter path, times the sun's specular intensity, aimed at the nearest point of the
  sun's disc, plus multiple scattering.
- **reflection**: water is written into the inputs of the game's
  [screen-space reflections](lighting.md#screen-space-reflections) and reflected through that same
  pass: the reflected ray is stretched to the screen's edge, so it has no reach limit in metres,
  with its edge and head-on fades. the sky reflection fills in (normalised the same way as on
  surfaces, scaled by `envLightSpecularIntensity`) where the march finds nothing. the environment
  BRDF weighs it, with f0 = 0.08 · `specular` and f90 = saturate(4 · `specular`).
- **fog and composition**: the surface's own light (highlight, foam, reflection, column) is fogged
  at the surface's distance; the scene behind, already fogged, shows through by the column's
  transmittance, and the fog's in-scatter covers the rest. where the march hits, the colour then
  leans towards the reflection by its weight times the column's opacity and the fog's transmittance,
  so deep water mirrors its surroundings.
- **shore**: `distanceEdgeBlendFactor` fades shallow water into what's under it; at a distance the
  thickness counts less at grazing angles.

## water volumes

besides the surfaces above, levels place gameplay water whose surface moves: LevelData
`waterVolumes` (and `riftVolumes`, same record). 14 scenes have them: map02 (61 in the levels whose
map is map02, 13 moved by scripts), Suiming, a race, three dungeons and eight factory puzzle scenes.
a volume holds:

| field                                                        | meaning                                                                                                     |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `id`                                                         | entity id; scripts and floaters name the volume by it                                                       |
| `pivot`                                                      | the volume's floor; `pivot.y` is where its height counts from                                               |
| `points`                                                     | the outline, world positions at `pivot.y`; the game triangulates it in x, z into a flat surface mesh        |
| `heightMax`                                                  | metres from the pivot to a full volume                                                                      |
| `amountCurrent`, `amountMax`                                 | the authored fill; the surface sits at `pivot.y + heightMax · amountCurrent / amountMax`                    |
| `isInfinite`                                                 | the fill is a fraction scripts set directly (`WaterVolumeInfiniteSetHeight`) rather than an amount of water |
| `fillSpeed`                                                  | fixed-speed moves: metres a second on an infinite volume, amount units a second on others (below)           |
| `flowSpeed`, `flowDirection` (degrees)                       | the surface's flow                                                                                          |
| `isUseLunaConfig`, `lunaConfigPathHash`                      | a surface `WaterConfig` drawn in place of its water type's (below)                                          |
| `waterItemType`, `meshPathHash`                              | the liquid, which picks its surface prefab (below), and an optional prebuilt surface mesh                   |
| `obbCenter`, `obbRotation`, `obbSize`                        | the volume's box, for gameplay (swimming, the danger area)                                                  |
| `waterNameLangKey`, `isPrototype`, nav-mesh and audio fields | gameplay; `isPrototype` false makes a volume factory water ([below](#depletable-pools))                     |

a volume with id 0 is static and builds no mesh. every other volume's surface is an instance of a
surface prefab picked by its **water type**, the `FacItemSubType` that FactoryItemTable gives its
`waterItemType` (`item_liquid_acid` 0, `item_liquid_sewage` 3, `item_liquid_water` 4, xiranite 7).
`…/GameMech/WaterVolumeManagerConfig.prefab` maps it:

- `waterTypeToSurfaceDict` first remaps a type to the one whose surface it borrows (Plant2 13 →
  Plant 2 on the current client)
- `waterSurfaceSettingDict` then gives the type's `surfacePrefab`
  (`…/GameMech/WaterVolumeSurface_<name>.prefab`: acid, dirty, clear, foliage, xiranite,
  hyper_xiranite), an optional foam `decalPrefab` placed beside it, and per-level multipliers for
  the flow cycles, large-wave scale and displacement
- a type it doesn't list, or whose prefab is null, takes `waterSurfaceMissingFallback` (on map02 the
  same prefab as water's)

a surface prefab is a MeshFilter, MeshCollider and an `HGWaterRendererV2` whose `waterConfig` names
an ordinary surface `WaterConfig` (render type 1, proxy; wetness offset 0.25 m). the game fills the
MeshFilter with the outline triangulated in x, z, or, when the volume's `meshPathHash` is set, with
that mesh: the `…/Gameplay/Water/<item type>#<volume id>_WaterSurface.asset` files, the same outline
triangulated ahead of time around the pivot (30 of map02's 61 volumes). a volume that sets
`isUseLunaConfig` swaps its own `lunaConfigPathHash` config in over the prefab's. most map02 volumes
don't (54 of 61, sewage and acid among them). the surface moves vertically as the fill changes and
is drawn by the water pipeline like any surface. a volume with a flow speed or a direction other
than the default gets a config slot of its own with its flow applied; the default takes the type's
shared slot.

level scripts move volumes:

- `WaterVolumeInfiniteSetHeight` sets the fill (0–1). without `isSmooth` the surface jumps there;
  with `isSmooth` and `isFixedSpeed` it moves linearly at the volume's fill speed and eases in over
  the last metres; with `isSmooth` alone it eases over a time the game derives from the distance and
  the fill speed (map02's switch drain, fill speed 50, takes about a second)
- `WaterVolumeSetFillSpeed` changes the fill speed, so a script sets the speed and then moves the
  surface
- `WaterVolumeSetAmount`, `WaterVolumeTransfer(All)` set or move amounts; `…PauseHeightChange`
  freezes a move

what triggers the scripts varies: switches (map02's Marker Stone pit, a one-use
`int_switch_wltech01` that drains volume 23400080003 from full to half), quests, map variables and
script stages. in Suiming (`indie_dg016`) a server-side clock drives a round: script 46300000013
reads the map variable `timer` (minutes since the round started) and lowers the pit (volume
46300000002, floor y 51.19, 110 m) in stages, each snapping to where the water should be at that
minute and then receding to the stage's level at a fixed speed:

| minutes | level (y)                  | speed (m/s) | takes |
| ------- | -------------------------- | ----------- | ----- |
| 0 → 2   | 0.50 → 0.37 (106.2 → 91.9) | 0.119       | 120 s |
| 2 → 5   | 0.37 → 0.31 (85.3)         | 0.0367      | 180 s |
| 5 → 8   | 0.31 → 0.13 (65.5)         | 0.11        | 180 s |
| 8 → 11  | 0.13 → 0.07 (58.9)         | 0.0367      | 180 s |

the lily-pad pool beside it (46300010001) recedes from 107 to 91 over the first few minutes, a
server event drains the pit to 0.08 when the round is solved, and another resets every volume. that
one minute is one `timer` step is inferred from the speeds, which cover each stage's drop in exactly
a minute per step; the server sets `timer`.

the only waterfall code in the game is gameplay: interactives with component 168
(`InteractiveWaterFallComponent`) spawn named waterfall and splash effects bound to a volume. the
water pipeline has nothing waterfall-specific; scenery falls are [effects](effects.md#waterfalls)
over river surfaces.

### depletable pools

a volume with `isPrototype` false is **factory water**: every map02 volume and the factory puzzle
scenes' (`blackbox_*`); the dungeons' script-only volumes are prototypes. the server's factory keeps
a factory volume's liquid and amount, which replace the authored `amountCurrent` once it reports,
and a map reset doesn't restore them. an infinite one ignores the server's amounts; a finite one is
a pool the player empties with Fluid Pumps (`pump_1`, `pump_2` for acid too) and fills with Fluid
Supply Units, which refuse sewage, so a sewage pool only goes down. its amount stays within 0 and
`amountMax`, the surface following it linearly; no client code refills a pool, and an empty pool's
surface stays at its pivot (unchecked in game). its `fillSpeed` is in amount units a second, so a
surface moves at `fillSpeed · heightMax / amountMax` metres a second: 6 m/s in the Test Area's pits,
0.026 m/s in Wuling City's Tianjing Courtyard pond.

a volume with a `parentId` follows its parent: its surface sits at the parent's, clamped between its
own pivot and full (basins beside a pool).

missions wait on pools through objective conditions (`CheckFluidVolume`: level, volume, operator,
amount):

| pool                                                            | quest                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------- |
| Tianjing Courtyard pond, Wuling City (22800060004, 40000, 35 m) | `gm02m10` "Treasure Beneath the Pond", q#2: at 800 or less    |
| Pool 1, Test Area (23200010000, sewage, 4000, 12 m)             | `gm02m14` "Divvy Up the Trouble", q#2 "Drain Pool 1": under 1 |

their beds hold content that's always placed (the pond's gate, statue keys and chests, the Test Area
pits' valve wheels), submerged until drained. nothing else switches with the drain. Pool 2
(23200010003) beside Pool 1 drains the same way, but no quest needs it.

### floaters

interactives with component 39 (`BelongToWaterVolume`) ride a volume's surface: lily pads
(`int_water_volume_floater*`), ice floes and art groups of lotus plants. their parameters:

| key               | meaning                                                                               |
| ----------------- | ------------------------------------------------------------------------------------- |
| `water_volume`    | the volume's id                                                                       |
| `lock_offset`     | x, z offset from the volume's surface position (the authored position less the pivot) |
| `surface_offset`  | height above the surface once following it (absent, so 0, on the floaters seen)       |
| `ground_distance` | not recovered; values near the pit floor's height suggest a lowest height             |
| `is_locked`       | whether it starts locked to the surface                                               |

floaters are placed on the authored surface. once the water moves they follow it with an ease that
lags more the further it moves. the floaters' own `surface_offset` (0) rather than their authored
height (some sit up to 0.5 m above the surface) is then what keeps them above it.

## WaterProxy and WaterDecal

no static InitChunkData renderer uses an `HGRP/WaterProxy` or `HGRP/WaterDecal` material; both
arrive through prefab content, and WaterDecal boxes also through InitChunkData component 31
([world](world.md#initchunkdata-layout)), which isn't read. `HGRP/WaterProxy` has only the water
pipeline's passes (top-down prepass, wetness mask, depth, the water G-buffer), none of which a scene
renderer draws in the main view; ten map02 river meshes carry it (`M_river_proxy_22`).

### WaterDecal

WaterDecal boxes put foam on the pools and channels at the foot and lip of waterfalls: a `Cube`
`MeshRenderer` with the material and an `HGWaterDecalRenderer` component beside it. they don't draw
into the scene. after the water's G-buffer, the pipeline draws them (pass `WaterDecalDeferred`) into
the water's 8-bit foam colour target (`R8G8B8A8_UNorm`, rgb the foam colour, a the config index),
which the water lighting then lights as its foam: diffuse sun and ambient, transmission and
`emissiveStrength` ([shading](#shading)). a box therefore shows only where water is, and the foam
colour, its own and the boxes', saturates at 1.

per covered pixel, the box takes the water surface's depth (the water prepass's, which the pipeline
binds just before), reconstructs the world position there and moves it into the box's frame:

- **UVs.** `local.xz + 0.5`, through `_UVScaleOffset`. each texture picks its source by a switch
  (`_BaseColorSwitchUV`, `_DisturbSwitchUV`, `_MaskUVSet`, `_DissolveSwitchUV`): 0 those box UVs, 1
  polar coordinates about their centre (the angle as a fraction of a turn, twice the distance), 2
  the world's x and z over 10 m, 3 the mesh's UV0. fractional values blend between neighbours.
- **distortion.** `_USE_DISTURB`: `_DisturbTex1`'s red (UVs scrolled by `_DisturbUVSpeed1.xy`, then
  its `_ST`), remapped by `_Bi_Disturb`, times `_DisturbU/VIntensity1`, shifts the base, mask and
  dissolve UVs by their `_…UseDisturb` fractions. its sample takes a mip bias from a material value
  the shader's parameter table doesn't name.
- **mip bias.** the base colour map is sampled with a bias of `floor(_MinMipLevel) + floor(_Bias)`
  levels and the mask with `floor(_Bias)`; the bamboo raft's wake has `_Bias` 2.3.
- **colour.** `_BaseColorMap` at its UVs through `_ST` (scaled by the placement's tiling), then
  scrolled by `_BaseColorSpeed.xy` (times the placement's speed).
  `a' = _UseAChannelAsAlpha ? a : 1`; colour `= _BaseColor + rgb · a' · _BaseColorTint` (`[HDR]`),
  times `_MaskTex` (`_USE_MASK`; its UVs turned about 0.5 by `_MaskTexUVRotateMatrix`, then `_ST`,
  then scrolled), and its alpha with `_UseMaskTexAsAlpha`. the output is that times `1 + a'`, the
  edge fade, `_OverallOpacity`, and the placement's opacity, brightness and tint.
- **dissolve.** `_USE_DISSOLVE`: `_DissolveTex`'s red at mip level `floor(_Bias)` (UVs scrolled,
  then `_ST`) less `_DissolveScheduleOffset · 2.02 − 1.01`, as in VFXBaseV2, scales colour and
  alpha, with `_DissolveEmissiveColor` on the edge.
- **fades.** `_UseEdgeFade`: `saturate(1 − |abs(uv − 0.5) + _EdgeFadeRange.xy| · √2)`, radial, 0 at
  the corners. `_USE_SOFTBLEND`: `saturate((saturate(water − face) + _SoftBias) / _SoftDistance)`,
  both reversed-Z device depths, the face being the box's fragment. `_MeshType` ≠ 0 drops positions
  outside the box; otherwise only the edge fade bounds it.
- **blending.** fixed by the pass, not the material: premultiplied (One, OneMinusSrcAlpha) into rgb
  alone, alpha `(1 + a') · (1 − _BlendMode)`; every map02 material is `_BlendMode` 1, adding its
  foam. the pass also draws only where stencil bit 0 is set (compare Equal, reference 1), which the
  water's passes set on its pixels ([how surfaces are drawn](#how-surfaces-are-drawn)). the box is
  culled by `_CullMode` and depth-tested by `_ZTest` (4, LessEqual, for most; 5, Greater, with front
  faces culled, for `M_fx_map02_lv001_waterfall_2105_05`; 8, Always, for the bamboo raft's wake
  `M_fx_interactive_bambooraft_waterdecal_802`), and writes no depth. which depth it's tested
  against isn't confirmed: the camera's depth buffer holds the scene without water, since the water
  writes its depth into a copy (`depthWithWater`).

the placement's `HGWaterDecalRenderer` holds `tilling`, `speed`, `opacity`, `brightness`,
`tintColor` (the values above), `displacement` (the WaterDecalDisplacement pass, for the water's
tessellated displacement), `enableMovement`, `renderType`, `heightLayer`, `sortingOrder` and
`waterStreamingType`. every map02 prefab's renderer has tiling, speed, opacity and brightness 1 and
a white tint; only `displacement` and `enableMovement` vary.

map02's prefab WaterDecal materials use `_BLEND_BASECOLOR` with `_USE_DISTURB` and `_USE_MASK`, plus
`_USE_SOFTBLEND` or `_USE_DISSOLVE`; the shader also has `_USE_SEQUENCE_FRAME`,
`_USE_TWO_LAYER_FLOATING_MAP`, `_BLEND_BASECOLOR2`, `_USE_WATER_EROSION` and `_USE_BUBBLE` variants.
