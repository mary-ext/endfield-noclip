# scene states and conditional content

this page covers everything that decides whether a piece of authored content is visible: MapConfig
scene states and their quest, mission and variable conditions; the load gates on DynamicStreaming
entities; progression levels (outposts, POI facilities, factory regions); facility visual forms;
script-loaded groups; and how the package encodes all of these as one control/condition system that
the viewer exposes as preview controls. spatial stream areas (interiors, caves, off-map places) are
a separate axis, covered in [world.md](world.md#stream-areas); the package encodes them as controls
the viewer sets from the camera.

the controls hold the game's own state, not one switch per condition: one control per quest, mission
and variable that some condition reads, and scene states derived from those. conditions on the same
quest therefore stay consistent: no selection makes `quest = completed` and `quest ≠ completed` both
hold.

## the selectors at a glance

| selector                   | stored in                                                                                               | package control                                     | default                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------- |
| quest / mission state      | read by MapConfig conditions and mission gates                                                          | `quest:<id>` / `mission:<id>` (state values)        | completed (a finished story)                                      |
| map / global variable      | read by MapConfig conditions and variable gates                                                         | `mapVar:<map>:<name>` / `globalVar:<name>` (ranges) | the highest value the scene compares it against                   |
| MapConfig scene state      | `Data/Json/MapConfig/<map>.json`; referenced by static chunk file names and dynamic visible-state lists | `sceneState:<index>`, derived from its condition    | its condition under the defaults above; condition-less states off |
| mission gate               | `MissionControlComp` on a dynamic entity                                                                | requirements on quest and mission controls          | —                                                                 |
| variable gate              | `GlobalVarControlComp` / `MapVarControlComp` with `controlLoad` set                                     | a requirement on the variable's control             | —                                                                 |
| progression                | resource-group `logicState` bitmask under a settlement / POI / factory-region controller                | `<kind>:<key>`                                      | lowest authored level                                             |
| facility visual form       | interactive template model-upgrade list                                                                 | `facility:<entity id>`                              | the template's base model                                         |
| doodad group level         | doodad-shell postmodel's form list                                                                      | `doodadGroups:<level id>`                           | the highest level (4)                                             |
| tree harvest state         | resource-group `logicState` on tree entities                                                            | `harvest:<level tag>`, standing / felled            | standing                                                          |
| script group               | script-control component's default-load flag                                                            | `script:<entity id>`                                | the stored default                                                |
| controller-less logic gate | resource-group `logicState` on an entity with no controller                                             | `logic:<entity id>:<mask>`                          | off                                                               |

## MapConfig scene states

implemented by [`map-config.ts`](../../packages/formats/src/endfield/map-config.ts) (parsing),
[`scene-conditions.ts`](../../packages/extractor/src/game/scene-conditions.ts) (controls) and
[`game-state.ts`](../../packages/extractor/src/game/game-state.ts) (the quests and variables
conditions read, and turning conditions into required control values).

the MapConfig JSON has `sceneStates` (state name → index) and `sceneStateConditions`, an ordered
list of `{ stateName, condition }`. a condition is a serialized `ConditionRuntimeBase` identified by
its `$type`:

| `$type` (in `Beyond.Gameplay`)     | fields                                                          | our `SceneCondition.kind` |
| ---------------------------------- | --------------------------------------------------------------- | ------------------------- |
| `SimpleConditionCheckQuestState`   | `questId`, `compareOperator`, `compareTarget`                   | `quest`                   |
| `SimpleConditionCheckMissionState` | `missionId`, `compareOperator`, `compareTarget`                 | `mission`                 |
| `SimpleConditionCheckMapVar`       | `belongMapId`, `mapVarName`, `compareOperator`, `compareTarget` | `mapVar`                  |
| `SimpleConditionCheckGlobalVar`    | `globalVarName`, `compareOperator`, `compareTarget`             | `globalVar`               |
| `CombinedConditionRuntime`         | `conditionOperator` (0 and, 1 or), `reverse`, `subConditions`   | `all` / `any`             |

`CompareOperator`: 0 =, 1 ≠, 2 >, 3 ≥, 4 <, 5 ≤, applied as `value <op> target`. quest and mission
targets are `QuestState` / `MissionState` values: none 0, available 1 (missions only), processing 2,
completed 3, failed 4, disabled 5. `reverse` negates the combined result.

these five classes are the only ones the installed client uses. the parser throws on any other class
or a malformed field, so a new class surfaces as an extraction error instead of a guessed truth
value.

### how the game applies them

the client always enables streaming scene state 0, then sets streaming state `index + 1` to each
condition entry's result. a state with no condition entry changes only when the game sets it by
name; dungeons and scripts that reuse the open-world map are the presumed writers. so a state can
be:

- **conditioned**: its value follows quest/mission/variable state
- **condition-less**: off unless something sets it by name, which offline extraction cannot see

### where states are referenced

- **static chunk files**: `InitChunkData_<x>_<z>_<sceneStateId>_<areaId>`. `sceneStateId` is the
  MapConfig index + 1, with 0 meaning always loaded; `areaId` is the stream area. the world index
  exposes these as `ChunkFile.sceneState` / `ChunkFile.area`, and `world entities` / `asset cell`
  take `--scene-state` and `--area` filters.
- **dynamic entities**: `RootComp` and each `ResourceGroupWithStateDesc` carry a visible-state list
  (a span of the grid's integer vector) holding MapConfig indices directly, without the +1. read by
  [`dynamic-resources.ts`](../../packages/formats/src/endfield/dynamic-resources.ts) as `states` and
  `groupStates`. the resource group's separate `sceneState` field (offset 24) is a different value;
  use the visible-state lists, never that field, for gating.
- **irradiance volume**: besides the base bake, the irradiance index stores bakes for these states
  and combinations of them, which the game selects by its active scene-state mask; only the base
  bake is packed (see [lighting.md](lighting.md)).

### what they gate

- **static renderers** in a non-zero scene-state file become conditional instances visible while any
  of the files' states is on. the packer reads state-0 files first, so an entity that also appears
  in an always-loaded file stays unconditional. scene-state content streams as conditional detail
  only; HLOD clusters exist only in always-loaded files.
- **environment and post volumes**: a volume's states are collected from every chunk file it appears
  in; any appearance in a state-0 file makes it unconditional
  ([`environment.ts`](../../packages/extractor/src/game/environment.ts)). each level's base
  environment is chosen among the volumes loaded under the default states (see
  [environment.md](environment.md)).
- **water surfaces**: same collection rule
  ([`water-source.ts`](../../packages/extractor/src/game/water-source.ts), see
  [water.md](water.md)).
- **dynamic entities**: the entity's list and the resource group's list each need one of their
  states on (an AND of two ORs), combined with the entity's other requirements.

### defaults

a state with a condition is derived: it follows the quest and variable controls its condition reads,
unless the user picks a value. its control's `rule` spells out the condition. the defaults of those
inputs are those of a player who finished the story:

- every quest and mission is completed (3)
- every variable holds the highest value the scene compares it against (see
  [variables](#variables)); variables are server state and the client ships no defaults for them
  (map02's `mapVarClientDefaultValues` is empty)
- condition-less states are off, because nothing offline sets them
- a state index that a visibility list requires but the MapConfig doesn't name gets an off control
  (`unnamedSceneStateControl`)

example (map01 in one client build, for illustration):

| index | state                          | condition                    | default |
| ----- | ------------------------------ | ---------------------------- | ------- |
| 0     | `001_normal`                   | quest `e1m8_q#3` = completed | on      |
| 1     | `001_damaged`                  | quest `e1m8_q#3` ≠ completed | off     |
| 2     | `001_overcast_rainy`           | quest `e1m2_q#6` ≠ completed | off     |
| 3     | `001_sunny`                    | quest `e1m2_q#6` = completed | on      |
| 6     | `dung01_rdg008_006_liino`      | none                         | off     |
| 7     | `dung01_rdg008_006_liino_hide` | mission `e0m2` = completed   | on      |

variable-driven states have no offline value; the highest-compared default is a guess. map02's field
and flower states read two variables, so they switch together through those, while its lv009
day/night pair doesn't: day is map variable `State` = 0, and night has no condition.

### variables

a variable's control takes one value per range of values the scene's conditions tell apart: below,
at and between the values they compare it against, and above the highest. a load gate fails while
its variable is unset, so a variable some gate reads also has an "unset" value; a MapConfig test
reads an unset variable as 0 (an assumption). the default is the highest compared value, on the
reading that the story moves variables forward (erosion cleansed, machines repaired, the last stage
of a staged change). MapConfig names its variables (`mapVarName`, `globalVarName`) while gates use
numeric game-variable ids, so the two never share a control.

## dynamic load gates

decoded by [`dynamic-scene.ts`](../../packages/formats/src/endfield/dynamic-scene.ts) into
`DynamicEntity.gates`; turned into requirements on quest, mission and variable controls by
[`game-state.ts`](../../packages/extractor/src/game/game-state.ts). every gate on an entity must
pass.

- **mission gate** (`MissionControlComp`): a list of
  `MissionCondition { id, isQuest, state, isSame }`. a condition holds when the quest/mission state
  equals `state` (`isSame` 1) or differs from it (otherwise). `compareType` 0 needs all conditions,
  any other value one. the entity loads while the combined result equals `toBeTrue == 1`. we express
  it as a combined condition (`all`/`any`, `reverse = !loadWhen`) over the quest and mission
  controls.
- **variable gate** (`GlobalVarControlComp`, `MapVarControlComp`): with `controlLoad` 1 the entity
  loads while `variable <compareType> compareValue` holds, and not while the variable is unset. with
  `controlLoad` 0 the variable doesn't gate loading; it drives the entity's level and animator state
  (e.g. a bridge raised or lowered in place), so it isn't listed as a gate and that presentation is
  not reproduced.

variable keys are numeric client game-variable ids, not root strings. the table naming them isn't
read, so controls show `#<key>`. a gate's variable is a [variable control](#variables) like a
MapConfig one.

`ActivityControlComp` (activity/event conditions) is not read; entities controlled only by it are
not gated.

## progressions

implemented in [`scenery-variants.ts`](../../packages/extractor/src/game/scenery-variants.ts);
`variants <scene>` prints them with the scene's stream areas.

settlements (outposts), POI facilities (Trial of Swordmancy, archery range, inn parts) and factory
regions are DynamicStreaming entities with a `SettlementControlComp`, `PoiControlComp` or
`FactoryRegionControlComp`. the controller's logic state is the progression's level. each
`ResourceGroupWithStateDesc` has a `logicState` bitmask: bit n set means the group is shown at level
n, and 0 means the group ignores logic state. `levelNum` is the LevelConfig idNum of the level the
group belongs to. all variants are stored side by side; nothing is a file swap. variants are mostly
exclusive per level, some groups span several levels, and group counts need not grow with level.

a progression is keyed `<kind>:<key>` (settlement id, POI id, or region level id); settlements have
a main and a secondary controlling entity that share one progression. its selectable levels are the
bits any of its groups use, and its default is the lowest. whether bit 0 means "unbuilt" or "level
1" is unknown, so the default shows the first authored appearance rather than claiming a progress
point. each progression is selected independently, because the player's progress is per facility and
no single completion percentage describes it.

a resource group with a non-zero mask on an entity with no controller: if bit 0 is set it shows in
the default state and needs no control; otherwise it gets a `logic:<grid>:<ordinal>:<mask>` toggle,
off, because nothing recovered drives that entity's logic state.

trees (entity type 19, no controller) use bits 0/1 for standing/felled under the same mechanism;
that is harvest state, not progression. the player fells each tree at runtime, so one `harvest`
control per level previews them all, standing by default.

## facility visual forms

implemented in
[`interactive-facilities.ts`](../../packages/extractor/src/game/interactive-facilities.ts), with the
templates decoded as MemoryPack (`InteractiveTemplateData`, see [level scripts](#level-scripts)).

stock redistribution facilities (`int_system_domain_shop`), depots (`int_system_domain_depot`),
recycling stations (`int_doodad_core_recycle`) and environment monitoring terminals
(`int_system_kite_station`, in Wuling City and Marker Stone) are placed by LevelData interactive
rows rather than DynamicStreaming. their template's model component
(`InteractiveModelComponentData`) names the base model, and its model-upgrade component
(`InteractiveModelLevelUpComponentData`, `modelLevelList`) lists ModelTable ids in authored order;
each entry is one visual form with its own prefab (a terminal's five forms are its upgrades,
`int_system_kiteStation_<n>_postmodel`). every placement (`createState` 0, deduplicated by id)
becomes a `facility:<id>` progression whose levels are the list indices and whose default is the
index of the template's base model (a recycling station starts at form 1).

form numbers are positions in that list, not gameplay upgrade levels: how shop channel levels, depot
levels or terminal levels (`KiteStationLevelTable`) map onto the list isn't recovered, so the viewer
labels them "Visual form", not "Level". LevelData files with an unsupported layout are skipped whole
and reported, never partially scanned.

every other template draws only the base model its leading model component names, always shown:
Dijiang's guest terminal desk, screens and doors, for instance. that ignores whatever runtime state
the game keeps for them (open doors, unlocked region walls), and rows with another `createState` are
left out. templates without a data file of their own (the weapon-wall racks, some doors) and
templates that name no model are reported or skipped.

## doodad groups

implemented in [`doodad-shell.ts`](../../packages/extractor/src/game/doodad-shell.ts) and
[`interactive-facilities.ts`](../../packages/extractor/src/game/interactive-facilities.ts).

resource nodes (ore outcrops, rabbit-hole plant mounds, special stones) are the centres of doodad
groups, placed as interactives (`int_doodad_core_*` variants). their model is an empty shell: a
script on the prefab root names one ModelTable id per group level 1 to 4, and lists one slot
GameObject per level (slot 0 is empty) that the loaded form attaches under. every shell in the
install has identity slots (a shell without them is reported and keeps only its own renderers).
which slots the prefab leaves active varies (level 4 alone, or all four), so it says nothing about
the shown level. form postmodels carry the same script with every form empty, so they aren't shells.

the game sets each group's level at runtime from progression that isn't recovered, so every level
with doodad groups gets one `doodadGroups:<level id>` progression ("Resource nodes") over the group
levels its shells name, defaulting to the highest. each form is placed at the interactive's
transform and shown under `1 << level`.

## script groups

an entity with a script-control component stores a default-load flag (0 or 1): 0 means a script must
explicitly enable it. each such entity gets a `script:<entity id>` control defaulting to that flag
([`dynamic-structures.ts`](../../packages/extractor/src/game/dynamic-structures.ts)). the id is the
entity's global id (its IdComp `uniqueId`), which level scripts use to show and hide it. event
content such as a limited-time race course lands here, typically off.

toggle names for script and logic controls are the one or two most frequent renderer names under
them. they are labels for finding the control, not evidence of what activates it.

### what sets a script group

implemented in [`script-drivers.ts`](../../packages/extractor/src/game/script-drivers.ts) over the
level scripts the [MemoryPack decoder](#level-scripts) reads.

level scripts (`Data/Json/LevelScriptData/<level>/<script id>.json`) show and hide groups with
`ShowSceneDecorationNew` (also `…WithHandle`, `ForceShowDecorationWithHandle`): a constant
`targetDynamicEntity` (the group's entity id) and a `visible` flag. the client shows a group at the
value a script last set, else at its default-load flag. a script is a graph: `actionList` and
`headerList` nodes by `ID`, linked by `nextID`, `IfElseAction.onTrueID`/`onFalseID` (the guard is
its `condition` param), switch `caseIDList`/`defaultID` (guard `value`), branch `idList` and other
`…ID` fields. a param is a constant (`paramSource` 0), the current script (1002), or a
`$<id>@_<field>` path into a getter node (`CheckQuestState`, `CompareQuestState`, …). headers are
the events:

- `ScriptEvent_OnScriptActive` (`…OnScriptStart`, `…OnScriptPreActive`): the script running. the
  server sets script state by progress, and a script runs while the player is inside its start or
  active shape (`startShapeList`/`activeShapeList`: `offset`, `radius`). `ManualStartLevelScript` in
  another script also starts it
- `ScriptEvent_OnLeaderEnterTriggerVolume` (and leave, list): the player entering one of the
  script's `triggerVolumes` (shape `position`, `radius`)
- `EntityEvent_*`: an interactive's event; `targetEntity` names a slot of the script's own
  `interactives` (template `entityDataIdKey`, `position`) or a LevelData placement by logic id
- `LevelEvent_OnQuestStateChanged` / `…OnMissionStateChanged`: a quest event (`filtedQuestId`)
- `ScriptEvent_OnCustomEvent` / `LevelEvent_OnCustomEvent`: raised by `RaiseCustomScriptEvent` (to a
  receiver script) or `RaiseCustomLevelEvent` (to the level) with the same key, so the raiser's own
  causes apply
- stage, property and other events: no client node sets script stages or properties; the server does

the packer follows every path from each header to each show/hide action (up to 16 guard sets per
node), and custom events and script starts back up to five hops. each root cause becomes a
`ControlDriver` of the group's control, with the `visible` the action sets: quest ids found on the
way (in guards and quest events), a switch, a trigger area, the script's own area, or the server.
scripts of other levels that name a scene's group (dungeons reusing the open world, such as the
racing courses) become `level` drivers; they're found by the group's id in their bytes. missions
whose objectives check a script (stage, property) are listed as quest drivers of its activation,
since the server runs such scripts as those missions progress. the viewer lists each control's
drivers and flies to a driver's position.

### level scripts

level scripts and other MemoryPack game data are decoded by
[`memory-pack.ts`](../../packages/formats/src/endfield/memory-pack.ts), with the schema read at
extract time from the install's IL2CPP metadata (`il2cpp_data/Metadata/global-metadata.dat`,
version 29) and `GameAssembly.dll` ([`il2cpp/`](../../packages/formats/src/il2cpp)): the generated
`<Type>ForMemoryPack` wrappers' setter properties give each object's members in order, and their
`MemoryPackUnion` attributes the union tags. the formatting rules beyond the wrappers are described
in the decoder. 5503 of the client's 5505 level scripts decode to their exact length; two hold an
NPC dictionary with an unknown header.

## how the package encodes conditions

types in [`states.ts`](../../packages/package-format/src/states.ts) (`StatesInfo`, `SceneControl`,
`ConditionalSetInfo`); evaluation in
[`conditions.ts`](../../packages/package-format/src/conditions.ts). the container layout is in
[package-format.md](../package-format.md#controls).

- every control has an integer value below 32: a quest's state, a variable's range, a progression's
  level or form index, 0 or 1 for on/off controls. `resolveSceneValues` turns the user's picks into
  every control's value: picks, then defaults, then derived controls from their formulas.
- a `ConditionalSetInfo` is `alternatives: SceneRequirement[][]`, a disjunction of conjunctions. a
  requirement `{ control, mask }` passes when bit `value` of `mask` is set. an on/off requirement
  uses mask 2 (value 1); a quest or variable requirement the values its test accepts; a progression
  requirement the group's `logicState`; a facility form `1 << form`, a doodad form `1 << level`.
- a combined condition becomes alternatives by distributing conjunctions over disjunctions, with
  `reverse` pushed down to the tests (each test's mask complemented within its control's values);
  requirements on one control in a conjunction merge, and impossible conjunctions drop.
- `conditionVisible` is true when every requirement of some alternative passes. a missing or
  out-of-range value fails, so a control absent from the manifest hides its content instead of
  showing it.
- one dynamic resource group yields the conjunction of its progression, logic or harvest
  requirement, its script requirement, its gates' requirements, and one state from each
  visible-state list. a model or ECS group referenced by several resource groups collects all their
  alternatives, so any complete alternative shows it.
- static renderers, lights and water surfaces of scene-state or stream-area files get one
  alternative per file holding them: the file's `sceneState:<index>` requirement, its `area:<id>`
  requirement, or both. environment volumes come from default-area files only, so they have state
  requirements alone. groups store a `condition` index into `conditionalSets`, `null` when always
  loaded.
- `area:<id>` controls hold whether a stream area shows. unless the user picks a value, the viewer
  sets them to 1 for the areas shown at the camera and 0 otherwise (see
  [package-format.md](../package-format.md#stream-areas)); their stored default (shown) only holds
  without a camera.
- the packer canonicalises and deduplicates sets (`Collector.condition`), so equivalent expressions
  share one index. quests, missions and variables come first in `controls`, then progressions,
  facilities, stream areas, script, logic and harvest controls, then scene states.
- only controls some visibility group requires, directly or through a derived scene state, are
  listed. each control's `levelTags` are those of the groups it gates, and a derived state passes
  its tags on to the quests and variables it reads.

## quest and mission labels

implemented by [`mission-runtime.ts`](../../packages/formats/src/endfield/mission-runtime.ts)
(parsing) and [`story.ts`](../../packages/extractor/src/game/story.ts) (labels).

missions are defined in `Data/Json/MissionRuntimeAsset/<missionId>.json` (plain JSON; a `_meta` file
beside each holds accept mode and reward). a quest id is its mission id, `_q#` and a step name
(`e1m8_q#3`, `e1m1_q#Deco_showLandslide`); a `d` in an id is a decimal point added later (`e1m9d5`
is mission 9.5). text keys resolve through `TextTable` (key → text id) and `I18nTextTable_EN` (id →
string, with `<@…>…</>` rich-text tags, stripped for labels).

- **mission**: `missionName.key` names it; `missionType` (0 Main, 1 Char, 2 Factory, 4 Hide, 5 Misc,
  7 World, 8 WeekRaid, 9 FakeMain, 10 Side, 11 Activity, 12 TBCMain) gives the quest log tab, as the
  client's mission type table groups them (main, side, discovery, events; the rest as other).
  internal flag missions (`hidden*`, `dm*`) have no name. `levelId` is where it takes place; its
  quests can switch scenery of other levels (Valley Pass's fort mission switches The Hub's states),
  so the panel lists a quest for the levels it gates and shows where its mission takes place.
- **chapter**: `missionChapterBitmask` bit 1 is chapter one, 2 chapter two (texts `chapter<n>_num`,
  `chapter<n>_name`); 4 is indie, without text. prologue missions (`e0m…`) carry chapter one's bit,
  so only their id marks them as `chapter0`.
- **episode**: nothing links a mission to an episode; main story ids `e<n>m…` match the episode
  texts `ep<n>_name`, so the label is inferred from the id.
- **quest**: `questDic[<quest id>]`. its label is its first objective's text, else the mission
  description it shows while running (`descriptionOverride`). `mainPathQuests` lists the main flow
  in order, hidden steps included, and gives the step number; a quest off it (`flowIndex` 1, a side
  branch) starts once its predecessors (`prevQuestIdList`) complete, so it sits half a step after
  them. hidden quests (`showMode` 1000, no objectives) exist only to drive scenery and are labelled
  "hidden step" with their id's suffix.
- quests whose mission the client lacks keep their raw id; some ids that conditions name are absent
  from the client (stale or unreleased), and event day locks (`a1m3_q#Day2Lock`) are stages the
  server times.

missions never change the world themselves: their actions are presentation (radio, guides, chapter
panels) and most objectives are evaluated by the server. the world reads quest state through scene
state conditions, mission gates and level scripts.

## viewer controls

[`scene-controls.tsx`](../../packages/viewer/src/ui/scene-controls.tsx) shows the "Scene conditions"
panel; the viewer resolves every control's value when a pick changes, recomputes `conditionVisible`
for every set and passes the results to the instance selector, the water renderer and the
environment blend.

- **scene states**: a select per state, "Follow game (on/off)" for derived states, else on/off
- **quests and missions**: quests run in order, so progress is picked as a story point rather than
  per quest ([`story.ts`](../../packages/package-format/src/story.ts)). "Main story progress" lists
  the main story's missions in id order (episode, mission, decimal) with a point at each mission's
  start and at each step a listed quest sits at; picking one completes every quest and mission
  before it, sets that step and its mission in progress and leaves the rest not started. each
  mission below, grouped by quest log tab (with chapter, episode and where it takes place), has the
  same "Progress" select over its own steps, and its quests' individual state selects under
  "Quests". rules elsewhere show quests by mission and quest name instead of id
- **variables**: a select of ranges, the default marked "(initial)"
- **progression**: one select per progression, "Level n", "Visual form n" or "Group level n"
- **stream areas**: a select per area, "Follow camera (shown/hidden)", shown or hidden
- **harvest**: standing or felled
- **script / event scenery**, **logic-gate previews**: checkboxes; a script group lists its drivers
  ("Shown when the player uses …", "Hidden by quest progress: …"), with "Go" flying to a driver's
  place
- **lighting / environment volumes**: volumes owned by the shown level or reaching into it. a volume
  follows its scene-state condition unless ticked or unticked here, which overrides it.
  scripted-blend volumes (blend mode 3) are off unless ticked. packed volumes carry
  `activation: 'unknown'` because their script enablement isn't recovered (see
  [environment.md](environment.md))

every row shows the control's rule and the assumption behind its default. controls are listed where
their `levelTags` include 0 or the shown level's tag. "Reset" drops every pick. the settings panel's
"stream areas at camera" toggle switches every area that follows the camera between following it and
showing. conditional detail ignores HLOD refinement and stops streaming once its tile is below the
screen error threshold.

## rules

- **preserve uncertain gates as manual overrides, initially off.** condition-less scene states,
  unnamed state indices and controller-less logic gates have no recoverable runtime writer; showing
  them by default would overlay content the player sees only in specific events or dungeons (e.g.
  concert props and map-wide night volumes on map01). script groups follow their stored default-load
  flag instead, because that flag is authored data.
- **never infer activation from names** such as night, battle, rainy or liino. names describe
  content, not when it loads; a guessed rule hides or shows the wrong things with no signal that
  it's a guess. gate only on stored conditions and say in the control text what the default assumes.
- **controls are game state, not conditions.** a control holds something the game holds (a quest's
  state, a variable, a level); conditions are requirements on those. one switch per condition would
  let the viewer show combinations no player state produces, such as both sides of a quest check.
- **keep compound requirements combined.** an entity can need a progression level, a script flag, a
  quest gate and two state lists at once; flattening that into independent controls would show
  variants in combinations the data never authors. shared resources union alternatives, never merge
  requirements.
- **this is not a complete story-state evaluator.** defaults model one player (story finished,
  variables at fixed assumptions) and ignore by-name state writers, script overrides, activity
  conditions and server state. describe the controls as authored previews; don't present a default
  as what a given player sees.
- **fail on unknown data.** unknown condition classes, operators, out-of-range spans and invalid
  flags throw during extraction, so a format change is noticed instead of silently evaluated.

## open

- writers of condition-less states: presumably dungeons reusing the map (their own MapConfigs, e.g.
  `dung01_rdg010`, carry conditions) and level scripts setting or overriding states by name; not
  traced
- variable names and offline values: the client game-variable id table isn't read, and the server
  values are unavailable
- `ActivityControlComp` gates (many map02 owners; those inspected have no conditions)
- variable-driven entity levels and animator states (`controlLoad` 0), e.g. the bridge between The
  Hub and Valley Pass
- irradiance scene-state bakes selected by the active states
- the gameplay-level → visual-form mapping for shops and depots, and the runtime state of other
  interactives, which draw their base model
- meaning of progression bit 0 per controller kind, and which entity's state the server sets
