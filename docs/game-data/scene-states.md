# scene states and conditional content

everything that decides whether a piece of authored content is visible: MapConfig scene states and
their quest, mission and variable conditions; the load gates on DynamicStreaming entities;
progression levels (outposts, POI facilities, factory regions); facility visual forms, Dijiang's
cabins, doors, telescopic bridges and resource-node groups; script-loaded groups; and quest labels.
spatial stream areas (interiors, caves, off-map places) are a separate axis, covered in
[world.md](world.md#stream-areas). the dynamic ECS scene's format is in
[assets.md](assets.md#dynamic-structures), and the interactives' models and view states in
[interactives.md](interactives.md).

## the selectors at a glance

| selector                   | stored in                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| quest / mission state      | read by MapConfig conditions and mission gates                                                          |
| map / global variable      | read by MapConfig conditions and variable gates                                                         |
| MapConfig scene state      | `Data/Json/MapConfig/<map>.json`; referenced by static chunk file names and dynamic visible-state lists |
| mission gate               | `MissionControlComp` on a dynamic entity                                                                |
| variable gate              | `GlobalVarControlComp` / `MapVarControlComp` with `controlLoad` set                                     |
| progression                | resource-group `logicState` bitmask under a settlement / POI / factory-region controller                |
| facility visual form       | interactive template model-upgrade list                                                                 |
| doodad group level         | doodad-shell postmodel's form list                                                                      |
| Dijiang cabin slot         | `ExtraSceneSlot` entity; cabin scenes named by `SpaceshipCabinData.json`                                |
| growth chamber level       | `SpaceshipGrowCabinLvTable` planting fields; planting-box shutters                                      |
| door                       | interactive model view states                                                                           |
| telescopic bridge          | the interactive's `state` property                                                                      |
| tree harvest state         | resource-group `logicState` on tree entities                                                            |
| script group               | script-control component's default-load flag; level scripts                                             |
| controller-less logic gate | resource-group `logicState` on an entity with no controller                                             |

## MapConfig scene states

the MapConfig JSON has `sceneStates` (state name → index) and `sceneStateConditions`, an ordered
list of `{ stateName, condition }`. a condition is a serialized `ConditionRuntimeBase` identified by
its `$type`:

| `$type` (in `Beyond.Gameplay`)     | fields                                                          |
| ---------------------------------- | --------------------------------------------------------------- |
| `SimpleConditionCheckQuestState`   | `questId`, `compareOperator`, `compareTarget`                   |
| `SimpleConditionCheckMissionState` | `missionId`, `compareOperator`, `compareTarget`                 |
| `SimpleConditionCheckMapVar`       | `belongMapId`, `mapVarName`, `compareOperator`, `compareTarget` |
| `SimpleConditionCheckGlobalVar`    | `globalVarName`, `compareOperator`, `compareTarget`             |
| `CombinedConditionRuntime`         | `conditionOperator` (0 and, 1 or), `reverse`, `subConditions`   |

`CompareOperator`: 0 =, 1 ≠, 2 >, 3 ≥, 4 <, 5 ≤, applied as `value <op> target`. quest and mission
targets are `QuestState` / `MissionState` values: none 0, available 1 (missions only), processing 2,
completed 3, failed 4, disabled 5. `reverse` negates the combined result.

these five classes are the only ones the installed client uses.

### how the game applies them

the client always enables streaming scene state 0, then sets streaming state `index + 1` to each
condition entry's result, recomputing whenever a condition's inputs change. only states with a
condition entry are computed, so a state can be:

- **conditioned**: its value follows quest/mission/variable state
- **condition-less**: always off under this MapConfig. a dungeon that streams the open world brings
  its own MapConfig with its own conditions (`dung01_rdg010` conditions `dung01_rdg010_liino*` on
  map01's streaming scene), so such a state is shown by entering the level whose MapConfig
  conditions it, not by anything in the open world

a level script (`SetOverrideSceneState` / `RemoveOverrideSceneState`) or a dialogue timeline can
override a conditioned state by name. the override is transient: it lasts until that state's own
condition changes value, the MapConfig changes (entering a dungeon) or the scene is rebuilt, and it
isn't saved. an override of a condition-less state does nothing. every override found targets a
conditioned state (dung01_rdg010's platform, map02_lv005's rising fields), forcing it while its
condition holds.

the client holds no player state: quest and mission states and variable values come from the server.

example (map01 in one client build, for illustration):

| index | state                          | condition                    |
| ----- | ------------------------------ | ---------------------------- |
| 0     | `001_normal`                   | quest `e1m8_q#3` = completed |
| 1     | `001_damaged`                  | quest `e1m8_q#3` ≠ completed |
| 2     | `001_overcast_rainy`           | quest `e1m2_q#6` ≠ completed |
| 3     | `001_sunny`                    | quest `e1m2_q#6` = completed |
| 6     | `dung01_rdg008_006_liino`      | none                         |
| 7     | `dung01_rdg008_006_liino_hide` | mission `e0m2` = completed   |

map02's field and flower states read two variables, so they switch together through those, while its
lv009 day/night pair doesn't: day is map variable `State` = 0, and night has no condition.

### where states are referenced

- **static chunk files**: `InitChunkData_<x>_<z>_<sceneStateId>_<areaId>`. `sceneStateId` is the
  MapConfig index + 1, with 0 meaning always loaded; `areaId` is the stream area.
- **dynamic entities**: `RootComp` and each `ResourceGroupWithStateDesc` carry a visible-state list
  (a span of the grid's integer vector) holding MapConfig indices directly, without the +1. the
  resource group's separate `sceneState` field (offset 24) is a different value; the visible-state
  lists are what gate. each visible-state span is followed by a visible-area span in the same layout
  (`VisibleAreaGroup`: `RootComp` +60, resource group +64): stream area ids, any of which shows the
  entity; a list holding area 0, the default area, is shown everywhere.
- **irradiance volume**: besides the base bake, the irradiance index stores bakes for these states
  and combinations of them, which the game selects by its active scene-state mask (see
  [irradiance.md](irradiance.md)).

### what they gate

- **static renderers** in a non-zero scene-state file load while that file's state is on; an entity
  can sit in several files, and one in an always-loaded file always loads. HLOD clusters exist only
  in always-loaded files.
- **environment and post volumes** and **water surfaces** sit in chunk files the same way
  ([environment.md](environment.md), [water.md](water.md)). volumes in prefabs that dynamic entities
  place load with their placement instead ([prefab volumes](environment.md#prefab-volumes)).
- **dynamic entities**: the entity's list and the resource group's list each need one of their
  states on (an AND of two ORs), combined with the entity's other requirements.

### variables

variables are server state, which the server syncs on entering a map. a variable test fails while
its variable is unset, whatever its operator: a load gate and a MapConfig condition alike (so `≠ 1`
doesn't hold before the server sets the variable).

map variables are of two kinds:

- **interactive properties**: a template with `useMapVar` publishes its saved properties as map
  variables of the current map, and `Data/Json/GameplayConfig/AutoNameMapVarTable.json` lists them
  per map in parallel arrays: the numeric key gates read (`mapVarIntKeyList`), the owning
  interactive's LevelData logic id (`mapVarBelongEntityList`), the property (`state`, rarely
  `hp_ratio` or `is_enabled`) and a fresh world's value (`mapVarDefaultValueList`). 275 entries over
  10 maps (map01 51, map02 158), all from the 11 `useMapVar` templates: blight and sludge cores,
  anchor-wave cores, Wuling bridges, drawing puzzles, rifts, waterwheels, aqua pipelines, outfalls,
  monster hearts and the blue sword. other templates save their properties (a door's or a campfire's
  `state`) per entity where no other content can read them. `AutoNameGlobalVarTable.json`, its
  global twin, is empty
- **named variables**: the rest, which MapConfig names (`mapVarNumId2Name`; 241 of map02's 399
  keys). the client ships no values for them (map02's `mapVarClientDefaultValues` is empty), so
  their states have no offline value. global variables have no name table in client data

two of map02's named variables only block gateways out of a level while they equal 2: `007to009`
(#201) loads 39 rocks and props that fill Yinglung Pass's gateway to Snowy Forest near (-402, 258,
570), and `008go010deco_v1d6` (#388) loads 33 crystal spikes over a North Wuling Exclusion Zone gate
near (150, 275, 1205). no other content tests either variable, and no client table, level script or
Lua file names them besides MapConfig, so whether a world has them at 2 is up to the server.

at Origin Lodespring (map01_lv006) the crater's light column takes one effect prefab per value of a
global variable (0, 2, 3, 4), and an in-game shot matches 2. the red-ringed spires there are gated
on another variable equalling 9999, a value that reads as a sentinel; the game doesn't show them.
MapConfig names its variables (`mapVarName`, `globalVarName`) while gates use numeric game-variable
ids.

## dynamic load gates

every gate on an entity must pass.

- **mission gate** (`MissionControlComp`): a list of
  `MissionCondition { id, isQuest, state, isSame }`. a condition holds when the quest/mission state
  equals `state` (`isSame` 1) or differs from it (otherwise). `compareType` 0 needs all conditions,
  any other value one. the entity loads while the combined result equals `toBeTrue == 1`.
- **variable gate** (`GlobalVarControlComp`, `MapVarControlComp`): with `controlLoad` 1 the entity
  loads while `variable <compareType> compareValue` holds, and not while the variable is unset. with
  `controlLoad` 0 the variable doesn't gate loading; it drives the entity's level and view state
  ([below](#view-states-on-dynamic-entities)).

variable keys are numeric client game-variable ids, not root strings. MapConfig's `mapVarName2NumId`
and `mapVarNumId2Name` map a map's variable names to these ids and back, and a gate's map id is the
MapConfig's numeric `mapId` (85 for map02), so a MapConfig condition and a gate can read the same
variable: map02's `map02lv005stateflower` is #125, which 5 dynamic entities gate on. map01's tables
are empty.

### view states on dynamic entities

a DynamicStreaming entity can carry a view-state controller (`ModelViewStateControllerNewComp`)
whose `modelIdStrId` names a `ModelViewStateControllerData` file
([view states](interactives.md#interactive-view-states)). every variable component of an entity,
whatever its `controlLoad`, applies the variable's value on load and on every change: a value from 0
to 31 becomes the entity's level, which shows its resource groups by their `logicState` bits as a
progression level does, and the value goes to the state machine's int key `state` (an interactive
property other than `state`, such as `hp_ratio`, only sets a key of its name). a global variable
also sets the entity's Animator to the state `State_<value>`. an unset variable does neither, so the
entity keeps its starting pose. every view-state entity holds exactly one model row with
`logicState` 0, so a state changes the prefab's pose and switches, never swaps the prefab. by entity
type (owners on map01 / map02):

| type                               | owners   | driver                                                                                                             |
| ---------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| 3 `MVCByTrigger`                   | 0 / 244  | the entity's own `TriggerComp` box sets the bool `InTrigger`: the lotus leaves' reaction                           |
| 4 `MVCWithoutIdControlByGlobalVar` | 1 / 0    | a global variable: The Hub → Valley Pass bridge, raised or lowered                                                 |
| 5 `RefInteractiveState`            | 38 / 1   | an interactive's state (`InteractiveStateComp`), on an old-version controller of its own (`state_off`, `state_on`) |
| 34 `MVCWithIdControlByGlobalVar`   | 10 / 214 | a global variable; 199 of map02's floor tiles share 21 of them                                                     |
| 37 `InteractiveMapVarProxy`        | 3 / 116  | one map variable per owner: puzzles, the magic [Wuling bridges](interactives.md#wuling-bridges), rifts, wheels     |
| 40 `MVCWithIdControlByMapVar`      | 0 / 52   | a map variable: towers, bridges, dreamcatchers, altar rocks                                                        |

no level script writes these variables: scripts only read them, and the one view-state writer,
`SetDecorationViewState`, sets a state by name. so the server sets them. a few owners also set
`controlLoad` 1, gating their loading on the same variable.

### outpost tiers

Yinglung Pass (`stm_hongs_3`) has per-level scenery (its beacon beam, boards and screens) on map
variables rather than logic-state masks: one `ResourceWithIdControlByMapVar` owner per tier, each
loading while its variable equals 1 (`judianEffect1`–`4`, #321–324 on map02). its owners follow the
outpost's own (`u`) and its factory region's (`u + 1`) ids, on consecutive variable ids; no other
outpost on map01 or map02 has them. nothing in readable client data sets these variables: no table,
level script, mission or C# string names them, and MapConfig only names them (most Lua scripts are
encrypted, so those weren't searched). they're server-driven, and their link to the outpost's level
is only suggested by name and layout.

other variable gates are set by the server too. Yinglung Pass's energy point towers switch between a
red and a green set on map variable `defenceFnish` (#297, = 0 / = 1), presumably set when its
defence encounter is cleared; no client quest, script or scene state reads it, so it has no link to
story progress.

### blight and its cores

each patch of clearable blight (the glowing `P_erosion_map01_dynamic…` pieces,
[erosion](materials.md#erosion)) is an erosion root: a DynamicStreaming entity of type 36
(`ErosionMapVarControl`) whose `ErosionRootComp` names its core, by the core's level-data logic id
(`erosionCoreId`) and position, next to the patch meshes (`ResourceComp`) and a map variable gate
loading them while the variable ≠ 2. the core is an `int_erosion_core` interactive in level data,
placed with no condition of its own; its template has an `ErosionCoreComponent`, keeps its `state`
as a map-saved property (`useMapVar`), and the component names state 0 inactive, 1 active and 2
destroyed. map01 has 42 erosion roots, each naming a different placed core and gating on a variable
of its own (map 2, #3–#44; MapConfig names none), so a destroyed core and its cleansed blight go
together. the variable is the core's `state`: [AutoNameMapVarTable](#variables) gives every root's
key to the very core its `erosionCoreId` names (42 of 42 on map01, 6 of 6 in dung01_wrdg001), with a
fresh world's value 0. when a core is destroyed the client unloads its patches at once, before the
variable syncs. while the variable is unset the blight doesn't load. map02's
[sludge](#sludge-and-miasma) is paired with its cores the same way, through the sludge component's
core id.

## progressions

settlements (outposts), POI facilities (Trial of Swordmancy, archery range, inn parts) and factory
regions are DynamicStreaming entities with a `SettlementControlComp`, `PoiControlComp` or
`FactoryRegionControlComp`. the controller's logic state is the progression's level. each
`ResourceGroupWithStateDesc` has a `logicState` bitmask: bit n set means the group is shown at level
n, and 0 means the group ignores logic state. `levelNum` is the LevelConfig idNum of the level the
group belongs to. all variants are stored side by side; nothing is a file swap. variants are mostly
exclusive per level, some groups span several levels, and group counts need not grow with level.

settlements have a main and a secondary controlling entity. whether bit 0 means "unbuilt" or "level
1" is unknown: level scripts' upgrade presentation (`RequireSettlementShow`) targets levels 1–4 (2–4
at some settlements), which suggests bit 0 is the look before the first upgrade. among POIs, the
Trial of Swordmancy and the archery range use bits 0–4 while `SimulationTrainingLevelTable` lists 4
levels, and Si's Painting's inn table uses 1–4. the player's progress is per facility.

a resource group can carry a non-zero mask on an entity with no controller; nothing in client data
drives that entity's logic state.

trees (entity type 19, no controller) use bits 0/1 for standing/felled under the same mechanism;
that is harvest state, not progression, and the player fells each tree at runtime.

### outpost upgrade missions

an outpost's levels are `SettlementBasicDataTable`'s `settlementLevelMap` (levels 1 to 4, the last
flagged `isFinalMaxLevel`). each level but the last names an `upgradeMissionId`, the outpost mission
that takes it past that level; the later ones open with "Raise Outpost Prosperity to the current
limit". Cardiac Remediation Station (`stm_hongs_2`, Marker Stone) lists `f1m19d1`, `f1m19d2` and
`f1m19d3` ("OD Project: Remediation Station I–III") at levels 1, 2 and 3, and every other outpost
follows the same pattern. so an outpost stands above a level once that level's mission is complete.
unverified: whether completing it raises the level at once or only unlocks the raise. the level
numbers match logic-state bits: groups named for an outpost level (`lt_Map02_据点_lv4_r`, `…lv3_r`,
`…lv2_r`) are shown at the same bit.

scenery gated on a level-up mission is per-level outpost scenery: the station's green light column
(`p_fxmap_map02_lv004_landmark_poi_801`) loads once `f1m19d3` is complete, that is at level 4,
beside the level-4 form of its landmark building.

## facility visual forms

stock redistribution facilities (`int_system_domain_shop`), depots (`int_system_domain_depot`),
recycling stations (`int_doodad_core_recycle`), environment monitoring terminals
(`int_system_kite_station`, in Wuling City and Marker Stone), farm terminals
(`int_system_farm_terminal`) and simulation training (`int_system_simulation_training`) are the
templates with a model-upgrade component ([interactives](interactives.md#placements-and-models)),
placed by LevelData interactive rows rather than DynamicStreaming. their template's model component
(`InteractiveModelComponentData`) names the base model, and its model-upgrade component
(`InteractiveModelLevelUpComponentData`, `modelLevelList`) lists ModelTable ids in authored order;
each entry is one visual form with its own prefab (a terminal's five forms are its upgrades,
`int_system_kiteStation_<n>_postmodel`). a recycling station's base model is its form 1.

form numbers are positions in that list, not gameplay upgrade levels: how shop channel levels, depot
levels or terminal levels (`KiteStationLevelTable`) map onto the list isn't recovered.

every other interactive has one model (its variant's, else its template's; see
[interactives](interactives.md#placements-and-models)): Dijiang's guest terminal desk and screens,
for instance. [doors](#doors), [telescopic bridges](#telescopic-bridges) and
[region walls](#dijiang-region-walls) follow runtime state. the server spawns LevelData
interactives: it sends each into view with its saved state, which the client joins to the row by
logic id. the client spawns only the level's `autoSpawnedInteractives` (and level scripts' own
interactives) itself, and no client code reads a row's `createState`, which reads as the server's
spawn policy (0 spawned with the level). rows with another `createState` aren't created from client
data: Dijiang's Control Nexus terminal is one, so the server creates it; its mission condition,
`e1m9` completed, only locks interaction with it. Dijiang's operator summon point
(`int_system_spaceship_summon`, in the hall near unity −24, 1, −13) is another: its row is
`Disable`, no level script, mission or Lua names its id, and its map marker
(`mark_ss_contact_center`) shows only once the server reports the `SpaceshipSystem` unlock, so the
server creates it. some templates have no data file of their own (the weapon-wall racks, some
doors), and some templates name no model.

## event placements

limited-time photo events (`ActivityTable` rows of type 4 PhotoTaking, and the conditional
multi-stage event's photo stages) place their photo spots through ordinary LevelData rows with
`createState` 0, in per-event layers (`<level>_lv_data_sub_snapshot_activity_v0d8`, `_v1d1`,
`_v1d6`, and `base01_lv001_lv_data_sub_a1m10` for mission `a1m10`, "Snapshot: Etchings of Our Cosmic
Dreams"). LevelConfig lists those layers like any other, and nothing in client data opens or closes
them, so whether a spot exists is the server's call while its event runs. the spots are template
`int_activity_snap_shot` (model `int_system_snapshot_postmodel`, a yellow light column; Dijiang has
one in front of the logo wall at unity 12, 1, −16) and carry the `ActivitySnapshotComponent`
(component type 2000: `identify`, camera pose, `conflictQuestIds`). every placement with that
component in the install sits in an event layer: 25 rows in 15 layers. their `progressLockCondition`
names a main-story mission or quest, which locks interaction, not existence. the layers'
`int_snapshot_empty` rows are the invisible targets the photos check.

## destructible props

map01 and map02's type-20 dynamic destructibles have one resource group with `logicState` 0 and no
controller. they store the intact model, with no destroyed variant to select; destruction removes
the prop at runtime. interactive destructibles are separate placements whose scripts can react to
destruction.

## sludge and miasma

map02's sludge, cleared by spraying it, is 68 DynamicStreaming entities of type 25 with a
`SludgeComp` and a map variable gate but no resource group. each names one of 65 cores, LevelData
placements of the `int_erosion_sludge_core` family (some `empty` variants, presumably with no
visible core), and loads while its core's variable is 0; patches of one core share it. every drawn
core (40, all with the `int_erosion_sludge_core_official` model) is named by a patch. the core
template's component (`ErosionSludgeCoreComponent`) has the blight core's states, 0 inactive, 1
active and 2 destroyed, and the variable is the core's `state`, as on map01 (AutoNameMapVarTable
gives every patch's key to the core its sludge component names, 68 of 68 on map02 and 7 of 7 in
indie_dg016). so a patch loads only while its core is inactive and goes once the core is activated,
before it's destroyed. two map02 cores (#30, #35) start a fresh world at 1, their sludge hidden.
what an active core looks like in game isn't checked. the surface isn't a mesh: each patch has a
baked height map (`Slu__<level>__<local id>[__n]`, a 128² BC4 `.png` and a `.json` repeating the
component's fields, under `Assets/Beyond/DynamicAssets/Gameplay/Sludge/`) that the game builds into
a voxel heightfield over a `sludgeSize`² grid and draws with `M_sludgeV2` or `M_sludgeV2_high`.
sprayed sludge grows back (`rebornTime`) unless its core is cleared; the variable is the persistent
part.

North Wuling Exclusion Zone's blight miasma (map02_lv008) is five type-51 entities whose resource
groups hold effects (smoke, dust, fog walls, small fires), each loading while its map variable
(#191–195) is 0.

## Dijiang cabins

Dijiang (`base01_lv001`) has four cabin slots, `ExtraSceneSlot` entities (type 29) whose
`ExtraSceneComp` holds a box (corners stored swapped per axis), an origin and a direction; each slot
is stored on two entities with identical components. a cabin is a separately stored scene,
`Data/DynamicStreaming/PC/Extra/<scene>/fb_main_*` with model rows only, named per cabin type by
`Data/Json/SpaceshipCabinData.json` (`cabinSpawnInfos.<type>.dynamicSceneUniqueId`; manufacturing
cabins and growth chambers). a built cabin's rows go to the slot origin, turned by the direction in
quarter turns of yaw; with that convention each cabin's entrance (the start of its NPC walkway, at
local +x) meets the slot's door, and the medium slot's box holds the growth chamber exactly.

each slot holds one cabin type (the room tables allow one type per room). one of the small slots has
no door and no room-table row. a built cabin's room is lit by its own irradiance bake
([region bakes](irradiance.md#region-bakes)).

a growth chamber's level unlocks its planting boxes. each box is a model row whose prefab's script
names a shutter object (`nonTransparentPlate`) that closes the tank's lower half; the game hides it
once the box is unlocked. `SpaceshipGrowCabinLvTable` lists the planting fields each level unlocks
(`unlockPlantingField`: 1–3, 4–6, 7–9). unverified: the fields are numbered in the order the cabin
scene's entity lists the boxes in its resource groups; that order opens the three tanks facing the
console at level 1, as in game. a planted crop and the box's status bar are player state and runtime
UI. the room nameplate above a cabin door and the assigned-operator panel beside it are also
world-space UI, populated from the room's name, level, status and operators; they are not cabin
scene meshes. manufacturing cabins' levels change only runtime state.

## Dijiang region walls

Dijiang's "no entry" walls (`int_system_spaceship_region_wall`, a template with a
`SpaceshipRegionWall` component) each close off a construction area, named by the placement's
`system_inst_key` component parameter in LevelData. the game hides the wall's whole model once the
area is unlocked, and `SpaceshipAreaUnlockNeedCenterLvTable` gives the Control Nexus level that
unlocks each area (`construction_area_1` at 1, `construction_area_2` at 3). `construction_area_3`
and `_4` have no row, so their walls always show in this client.

## doors

door poses are in [interactives.md](interactives.md#interactive-doors). the game opens doors by
gameplay and server state the client doesn't hold (a Power Plateau gate opens when a level script
hears an event from a mission's cutscene and calls the server).

- a Dijiang cabin's door is open while its slot is built and closed (`unlocked`, its "to be
  constructed" panel showing) while it's empty. the slots don't name their doors; a small slot's
  door stands 9 m from its origin, the medium one's 10.2 m
- Dijiang's reception room door (`system_inst_key` `guest_room`) opens once the reception room is
  unlocked, and that unlock is server-only. the room's level-1 row in `SpaceshipRoomLvTable` has no
  condition, only the text "Progress through the main story to unlock this cabin"; the Control Nexus
  tables don't unlock it; the client gets its unlocked systems from the server, and no client table
  maps a mission to them. no mission or level script unlocks it either. mission `f1m22` (Control
  Nexus level 3) places an NPC in the room, so it's open by then, but that's no link to follow

## telescopic bridges

a telescopic bridge ([interactives.md](interactives.md#telescopic-bridges)) is retracted or extended
by its interactive's `state` property, which starts at 0 (retracted) in the template. what sets it
in game (a switch, a script, the server) isn't followed. map01 places ten, five in The Hub.

## doodad groups

resource nodes (ore outcrops, rabbit-hole plant mounds, special stones) are the centres of doodad
groups, placed as interactives (`int_doodad_core_*` variants). their model is an empty shell: a
script on the prefab root names one ModelTable id per group level 1 to 4, and lists one slot
GameObject per level (slot 0 is empty) that the loaded form attaches under. every shell in the
install has identity slots. which slots the prefab leaves active varies (level 4 alone, or all
four), so it says nothing about the shown level. form postmodels carry the same script with every
form empty, so they aren't shells.

the game sets each group's level at runtime from progression that isn't recovered.

## script groups

an entity with a script-control component stores a default-load flag (0 or 1): 0 means a script must
explicitly enable it. the entity's global id (its IdComp `uniqueId`) is what level scripts use to
show and hide it. the client keeps what a script last set per id for the scene's lifetime (a script
can set it before the entity streams in), and a map reset clears it; until then the group follows
its flag. its leading digits are the idNum of the level that authored the entity (`228…` for Wuling
City, `404…` for a racing dungeon), not necessarily the level it stands in. event content such as a
limited-time race course is among these groups.

### what sets a script group

level scripts (`Data/Json/LevelScriptData/<level>/<script id>.json`) show and hide groups with
`ShowSceneDecorationNew` (also `…WithHandle`, `ForceShowDecorationWithHandle`): a constant
`targetDynamicEntity` (the group's entity id) and a `visible` flag. the client shows a group at the
value a script last set, else at its default-load flag. a script is a graph: `actionList` and
`headerList` nodes by `ID`, linked by `nextID`, `IfElseAction.onTrueID`/`onFalseID` (the guard is
its `condition` param), `CheckBoolIfTrue`/`CheckBoolIfFalse`'s `nextID` (taken only while its
`value` param is true or false, so it guards that edge), switch `caseIDList`/`defaultID` (guard
`value`), branch `idList` and other `…ID` fields. Wuling City's dragon eye glow (map02_lv002, entity
22800080003) is one: the script around it shows it on activation past a `CheckBoolIfTrue` on mission
e10m4 being complete. a header fires only while its `validate` param holds, so a non-constant
`validate` is a guard too. a param is a constant (`paramSource` 0), the current script (1002), a
getter node (`CheckMissionOrQuestIsComplete`, `CompareQuestState`, …) named by `idRef`
(`paramSource` -1), or a `$<id>@_<field>` path into another node's output. headers are the events:

- `ScriptEvent_OnScriptActive` (`…OnScriptStart`, `…OnScriptPreActive`): the script running. the
  server sets script state by progress, and a script runs while the player is inside its start or
  active shape (`startShapeList`/`activeShapeList`: `offset`, `radius`). `ManualStartLevelScript` in
  another script also starts it
- `ScriptEvent_OnLeaderEnterTriggerVolume` (and leave, list): the player entering one of the
  script's `triggerVolumes`, picked by `triggerSlotIdFilter`. a volume is a `shapeList` of shapes
  (`shapeType` 1 box with `size` and `rotation`, 2 sphere with `radius`, 3 polyline, 4 infinite)
  around `position`; the player is inside while within any of them. `exitShapeStartIndex` is -1 in
  the volumes seen so far (shapes from that index presumably count only for leaving; unverified)
- `EntityEvent_*`: an interactive's event; `targetEntity` names a slot of the script's own
  `interactives` (template `entityDataIdKey`, `position`; they exist while the script runs, see
  [placements and models](interactives.md#placements-and-models)) or a LevelData placement by logic
  id
- `LevelEvent_OnQuestStateChanged` / `…OnMissionStateChanged`: a quest event (`filtedQuestId`)
- `ScriptEvent_OnCustomEvent` / `LevelEvent_OnCustomEvent`: raised by `RaiseCustomScriptEvent` (to a
  receiver script) or `RaiseCustomLevelEvent` (to the level) with the same key, so the raiser's own
  causes apply
- stage, property and other events: no client node sets script stages or properties; the server does

level interactives (LevelData placements: doors, switches, chests, rafts, moving platforms) are
shown and hidden by `EntityShow` / `EntityHide` (an `entityPtr`), `EntityShowList` /
`EntityHideList` (an `entityListPtr`) and `SetEntitiesVisibility` (`targetEntities`, with an
`isVisible` flag, a `resetVisible` flag and a `visibleSource` channel). an entity pointer names a
LevelData placement by `logicId` (`useSlotId` 0) or a slot of the script's own `interactives`. map01
and map02 scripts name 195 such targets, 104 of them LevelData interactive rows. a placement has no
stored hidden flag of its own, so whether an interactive starts hidden before its script runs isn't
known.

scripts of other levels can name a scene's group (dungeons reusing the open world, such as the
racing courses). missions whose objectives check a script (stage, property) drive its activation,
since the server runs such scripts as those missions progress.

### groups that follow the player

some groups are scenery swaps by where the player stands: one script hides a group on entering a
volume and shows it again on leaving (or the reverse), and nothing else sets it. Jingyu Valley's
tree cave (map02_lv001, near unity −1046, 229, −1400) is one: group 10100030008, four huge rocks
that roof over the cave's skylight, is hidden by script 10100030016 while the player is inside its
volume 80003 (three spheres of 78 to 92 m around the cave), so from inside the shaft opens onto the
tree; the same script shows group 10100030005 only inside volume 80004, east of the cave. such a
script still has to be running for its volume events to fire; 10100030016 has no quest checks and an
active shape of 350 m around unity −910, 249, −1255 that covers both volumes, but whether the server
starts it unconditionally isn't known.

### following quest checks on activation

some scripts set a group from quest state each time they run: Power Plateau's fortress gate scripts
show the open gate and hide the closed one on activation, guarded by `validate` = mission `e3m5`
complete, and another shows the plateau's construction props on activation if mission `e3m6` is
complete and hides them otherwise.

### level scripts

level scripts and other MemoryPack game data take their schema from the install's IL2CPP metadata
(`il2cpp_data/Metadata/global-metadata.dat`, version 29) and `GameAssembly.dll`: the generated
`<Type>ForMemoryPack` wrappers' setter properties give each object's members in order, and their
`MemoryPackUnion` attributes the union tags.

## quest and mission labels

missions are defined in `Data/Json/MissionRuntimeAsset/<missionId>.json` (plain JSON; a `_meta` file
beside each holds accept mode and reward). a quest id is its mission id, `_q#` and a step name
(`e1m8_q#3`, `e1m1_q#Deco_showLandslide`); a `d` in an id is a decimal point added later (`e1m9d5`
is mission 9.5). text keys resolve through `TextTable` (key → text id) and `I18nTextTable_EN` (id →
string, with `<@…>…</>` rich-text tags).

- **mission**: `missionName.key` names it; `missionType` (0 Main, 1 Char, 2 Factory, 4 Hide, 5 Misc,
  7 World, 8 WeekRaid, 9 FakeMain, 10 Side, 11 Activity, 12 TBCMain) gives the quest log tab, as the
  client's mission type table groups them (main, side, discovery, events; the rest as other).
  internal flag missions (`hidden*`, `dm*`) have no name. `levelId` is where it takes place; its
  quests can switch scenery of other levels (Valley Pass's fort mission switches The Hub's states).
  character missions carry their operator in `charId`.
- **chapter**: `missionChapterBitmask` bit 1 is chapter one, 2 chapter two (texts `chapter<n>_num`,
  `chapter<n>_name`); 4 is indie, without text. prologue missions (`e0m…`) carry chapter one's bit,
  so only their id marks them as `chapter0`.
- **episode**: nothing links a mission to an episode; main story ids `e<n>m…` match the episode
  texts `ep<n>_name`.
- **quest**: `questDic[<quest id>]` holds its objectives; `descriptionOverride` is the mission
  description it shows while running. `mainPathQuests` lists the main flow in order, hidden steps
  included, and gives the step number; a quest off it (`flowIndex` 1, a side branch) starts once its
  predecessors (`prevQuestIdList`) complete. hidden quests (`showMode` 1000, no objectives) exist
  only to drive scenery.
- some ids that conditions name are absent from the client (stale or unreleased), and event day
  locks (`a1m3_q#Day2Lock`) are stages the server times.

missions never change the world themselves: their actions are presentation (radio, guides, chapter
panels) and most objectives are evaluated by the server. the world reads quest state through scene
state conditions, mission gates and level scripts.

## open

- named and global variables' offline values: global variables have no known name table, and the
  server values are unavailable
- an entity's level before any variable reaches it (0 or its RootComp state), and what dropping a
  variable component whose map id isn't the current MapConfig's does to loading in a dungeon that
  streams the open world
- `ActivityControlComp` gates: on map01 and map02 every entity's component holds no conditions
  (compare type 255), and no level script reads activity state, so limited-time events reach the
  world only through missions, the scripts of event dungeons and
  [event placements](#event-placements)
- which event photo spots belong to which event: the placements name no activity, only their own
  `identify` key and, for some, the event mission's quests
- script groups with no client driver: groups whose id equals a level script's own id, ghost-wall
  module decorations (`GhostWallModuleData.outerEffectDecoId`), and ids that scripts reference only
  as animator or attach targets; what shows them isn't traced
- the gameplay-level → visual-form mapping for shops and depots, and the runtime state of other
  interactives
- meaning of progression bit 0 per controller kind, and which entity's state the server sets
