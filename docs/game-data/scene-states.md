# scene states and conditional content

this page covers everything that decides whether a piece of authored content is visible: MapConfig
scene states and their quest, mission and variable conditions; the load gates on DynamicStreaming
entities; progression levels (outposts, POI facilities, factory regions); facility visual forms;
script-loaded groups; and how the package encodes all of these as one control/condition system that
the viewer exposes as preview controls. spatial stream areas (interiors, caves, off-map places) are
a separate axis, covered in [world.md](world.md#stream-areas); the package encodes them as controls
the viewer sets from the camera.

## the selectors at a glance

| selector                   | stored in                                                                                               | package control                                  | default                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------ |
| MapConfig scene state      | `Data/Json/MapConfig/<map>.json`; referenced by static chunk file names and dynamic visible-state lists | toggle `sceneState:<index>`                      | condition evaluated for a finished story; condition-less states off      |
| mission gate               | `MissionControlComp` on a dynamic entity                                                                | toggle `mission:<condition text>`                | evaluated for a finished story                                           |
| variable gate              | `GlobalVarControlComp` / `MapVarControlComp` with `controlLoad` set                                     | toggle `<globalVar\|mapVar>:…:<compare>:<value>` | variable assumed to hold the highest value the scene compares it against |
| progression                | resource-group `logicState` bitmask under a settlement / POI / factory-region controller                | progression `<kind>:<key>`                       | lowest authored level                                                    |
| facility visual form       | interactive template model-upgrade list                                                                 | progression `facility:<entity id>`               | the template's base model                                                |
| script group               | script-control component's default-load flag                                                            | toggle `script:<grid>:<ordinal>`                 | the stored default                                                       |
| controller-less logic gate | resource-group `logicState` on an entity with no controller                                             | toggle `logic:…`                                 | off                                                                      |

## MapConfig scene states

implemented by [`map-config.ts`](../../packages/formats/src/endfield/map-config.ts) (parsing) and
[`scene-conditions.ts`](../../packages/extractor/src/game/scene-conditions.ts) (evaluation and
controls).

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

defaults are those of a player who finished the story:

- every quest and mission compares as completed (3)
- every map and global variable compares as 0, because variables are server state and the client
  ships no defaults for them (map02's `mapVarClientDefaultValues` is empty)
- condition-less states are off, because nothing offline sets them
- a state index that a visibility list requires but the MapConfig doesn't name gets an off control
  (`unnamedSceneStateControl`)

each control's `condition` text spells out the condition and the assumption behind its default, e.g.
`quest e1m8_q#3 = completed; default: story finished`. example (map01 in one client build, for
illustration):

| index | state                          | condition                    | default |
| ----- | ------------------------------ | ---------------------------- | ------- |
| 0     | `001_normal`                   | quest `e1m8_q#3` = completed | on      |
| 1     | `001_damaged`                  | quest `e1m8_q#3` ≠ completed | off     |
| 2     | `001_overcast_rainy`           | quest `e1m2_q#6` ≠ completed | off     |
| 3     | `001_sunny`                    | quest `e1m2_q#6` = completed | on      |
| 6     | `dung01_rdg008_006_liino`      | none                         | off     |
| 7     | `dung01_rdg008_006_liino_hide` | mission `e0m2` = completed   | on      |

the variables-are-0 assumption leaves some states without a meaningful offline value (map02's field
and flower states, and its lv009 day/night pair, where day is map variable `State` = 0 and night has
no condition). those need an explicit viewer choice.

## dynamic load gates

decoded by [`dynamic-scene.ts`](../../packages/formats/src/endfield/dynamic-scene.ts) into
`DynamicEntity.gates`; turned into toggles by
[`dynamic-gates.ts`](../../packages/extractor/src/game/dynamic-gates.ts). every gate on an entity
must pass.

- **mission gate** (`MissionControlComp`): a list of
  `MissionCondition { id, isQuest, state, isSame }`. a condition holds when the quest/mission state
  equals `state` (`isSame` 1) or differs from it (otherwise). `compareType` 0 needs all conditions,
  any other value one. the entity loads while the combined result equals `toBeTrue == 1`. we express
  it as a `SceneCondition` (`all`/`any`, `reverse = !loadWhen`) and evaluate it with the same
  finished-story rule.
- **variable gate** (`GlobalVarControlComp`, `MapVarControlComp`): with `controlLoad` 1 the entity
  loads while `variable <compareType> compareValue` holds, and not while the variable is unset. with
  `controlLoad` 0 the variable doesn't gate loading; it drives the entity's level and animator state
  (e.g. a bridge raised or lowered in place), so it isn't listed as a gate and that presentation is
  not reproduced.

variable keys are numeric client game-variable ids, not root strings. the table naming them isn't
read, so controls show `#<key>`. a variable gate defaults to the highest value any gate in the scene
compares that variable against, on the reading that the story moves these variables forward (erosion
cleansed, machines repaired, the last stage of a staged change). MapConfig conditions keep the plain
0 assumption, so the two can disagree about the same story moment; each control's text states which
assumption its default uses.

equal gates share one toggle. mission gates use the described condition as their id, so identical
conditions on different entities collapse into one control.

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

trees use bits 0/1 for standing/felled under the same mechanism; that is harvest state, not
progression.

## facility visual forms

implemented in
[`interactive-facilities.ts`](../../packages/extractor/src/game/interactive-facilities.ts) and
[`interactive-model.ts`](../../packages/formats/src/endfield/interactive-model.ts).

stock redistribution facilities (`int_system_domain_shop`), depots (`int_system_domain_depot`) and
recycling stations (`int_doodad_core_recycle`) are placed by LevelData interactive rows rather than
DynamicStreaming. their template's model-upgrade component (`InteractiveModelLevelUpComponentData`)
lists ModelTable ids in authored order; each entry is one visual form with its own prefab. every
placement (`createState` 0, deduplicated by id) becomes a `facility:<id>` progression whose levels
are the list indices and whose default is the index of the template's base model (a recycling
station starts at form 1).

form numbers are positions in that list, not gameplay upgrade levels: how shop channel levels or
depot levels map onto the list isn't recovered, so the viewer labels them "Visual form", not
"Level". LevelData files with an unsupported layout are skipped whole and reported, never partially
scanned.

every other template draws only the base model its leading model component names, always shown:
Dijiang's guest terminal desk, screens and doors, for instance. that ignores whatever runtime state
the game keeps for them (open doors, unlocked region walls), and rows with another `createState` are
left out. templates without a data file of their own (the weapon-wall racks, some doors) and
templates that name no model are reported or skipped.

## script groups

an entity with a script-control component stores a default-load flag (0 or 1): 0 means a script must
explicitly enable it. each such entity gets a `script:<grid>:<ordinal>` toggle defaulting to that
flag ([`dynamic-structures.ts`](../../packages/extractor/src/game/dynamic-structures.ts)). event
content such as a limited-time race course lands here, typically off. the ids are grid/ordinal
positions and change between builds, so they identify a control within one package only.

toggle names for script and logic controls are the one or two most frequent renderer names under
them. they are labels for finding the control, not evidence of what activates it.

## how the package encodes conditions

types in [`states.ts`](../../packages/package-format/src/states.ts) (`StatesInfo`,
`SceneToggleInfo`, `ProgressionInfo`, `ConditionalSetInfo`); evaluation in
[`conditions.ts`](../../packages/package-format/src/conditions.ts). the container layout is in
[package-format.md](../package-format.md).

- every control has an integer value: progressions hold their level or form index, toggles 0 or 1.
  `defaultSceneValues` builds the initial values from `defaultLevel` and `defaultEnabled`.
- a `ConditionalSetInfo` is `alternatives: SceneRequirement[][]`, a disjunction of conjunctions. a
  requirement `{ control, mask }` passes when bit `value` of `mask` is set. a toggle requirement
  uses mask 2 (value 1); a progression requirement uses the group's `logicState`; a facility form
  uses `1 << form`.
- `conditionVisible` is true when every requirement of some alternative passes. a missing or
  out-of-range value fails, so a control absent from the manifest hides its content instead of
  showing it.
- one dynamic resource group yields one alternative: its progression or logic requirement, script
  requirement and gate requirements, crossed with one state from each visible-state list. a model or
  ECS group referenced by several resource groups collects all their alternatives, so any complete
  alternative shows it.
- static renderers, lights and water surfaces of scene-state or stream-area files get one
  alternative per file holding them: the file's `sceneState:<index>` requirement, its `area:<id>`
  requirement, or both. environment volumes come from default-area files only, so they have state
  requirements alone. groups store a `condition` index into `conditionalSets`, `null` when always
  loaded.
- `area:<id>` controls aren't listed in `toggles` and get no default: the viewer sets them to 1 for
  the areas shown at the camera and 0 otherwise (see
  [package-format.md](../package-format.md#stream-areas)).
- the packer canonicalises and deduplicates sets (`Collector.condition`), so equivalent expressions
  share one index. MapConfig controls come first in `toggles`, then unnamed states, then gates,
  scripts and logic toggles.

## viewer controls

[`scene-controls.tsx`](../../packages/viewer/src/ui/scene-controls.tsx) shows the "Scene conditions"
panel; the viewer recomputes `conditionVisible` for every set when a value changes and passes the
results to the instance selector, the water renderer and the environment blend.

- **progression**: one select per progression of the shown level (or with no level), "Level n" or
  "Visual form n", the default marked "(initial)"
- **scene states**, **quest-gated scenery**, **variable-gated scenery**: checkboxes with the game's
  condition and default assumption
- **script / event scenery** and **logic-gate previews**: checkboxes with the control id and initial
  state
- **lighting / environment volumes**: volumes owned by the shown level or reaching into it. a volume
  follows its scene-state condition unless ticked or unticked here, which overrides it.
  scripted-blend volumes (blend mode 3) are off unless ticked. packed volumes carry
  `activation: 'unknown'` because their script enablement isn't recovered (see
  [environment.md](environment.md))

toggles are listed where their `levelTags` include 0 or the shown level's tag. "Reset" restores the
package defaults. stream areas have no controls here; the settings panel's "stream areas at camera"
toggle switches between following the camera and showing every area. conditional detail ignores HLOD
refinement and stops streaming once its tile is below the screen error threshold.

## rules

- **preserve uncertain gates as manual overrides, initially off.** condition-less scene states,
  unnamed state indices and controller-less logic gates have no recoverable runtime writer; showing
  them by default would overlay content the player sees only in specific events or dungeons (e.g.
  concert props and map-wide night volumes on map01). script groups follow their stored default-load
  flag instead, because that flag is authored data.
- **never infer activation from names** such as night, battle, rainy or liino. names describe
  content, not when it loads; a guessed rule hides or shows the wrong things with no signal that
  it's a guess. gate only on stored conditions and say in the control text what the default assumes.
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
