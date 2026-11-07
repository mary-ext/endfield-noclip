# scene controls

the packer turns the game's conditional content ([scene states](../game-data/scene-states.md)) into
one control/condition system, which the viewer exposes as preview controls
([viewer scene states](../viewer/scene-states.md)). spatial stream areas
([stream areas](../game-data/world.md#stream-areas)) are a separate axis, encoded as controls the
viewer sets from the camera. the encoding of controls and conditional sets is in
[conditions](../package-format.md#conditions).

the controls hold the game's own state, not one switch per condition: one control per quest, mission
and variable that some condition reads, and scene states derived from those. conditions on the same
quest therefore stay consistent: no selection makes `quest = completed` and `quest ≠ completed` both
hold.

the package side of [the selectors](../game-data/scene-states.md#the-selectors-at-a-glance):

| selector                   | package control                                    | default                                                           |
| -------------------------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| quest / mission state      | `quest:<id>` / `mission:<id>` (state values)       | completed (a finished story)                                      |
| map / global variable      | `mapVar:<map>:#<id>` / `globalVar:<name>` (ranges) | the highest value the scene compares it against                   |
| MapConfig scene state      | `sceneState:<index>`, derived from its condition   | its condition under the defaults above; condition-less states off |
| mission gate               | requirements on quest and mission controls         | —                                                                 |
| variable gate              | a requirement on the variable's control            | —                                                                 |
| progression                | `<kind>:<key>`                                     | highest authored level (a finished world)                         |
| facility visual form       | `facility:<interactive id>`                        | the last visual form (fully upgraded)                             |
| campfire activation        | `activation:<interactive id>`                      | activated (a finished save)                                       |
| saved Animator bool        | `activation:<row id>`                              | set (a finished save)                                             |
| player proximity           | `proximity:<interactive id>`                       | follows the camera                                                |
| interactive created later  | `created:<level id>`, not created / created        | not created                                                       |
| doodad group level         | `doodadGroups:<level id>`                          | the highest level its shells name                                 |
| Dijiang cabin slot         | `cabin:<entity id>`, empty / built                 | empty                                                             |
| growth chamber level       | `cabinLevel:<entity id>`, the table's levels       | level 1                                                           |
| Dijiang region wall        | `controlNexus:<level id>`                          | level 1                                                           |
| door                       | `door:<interactive id>`, closed / open             | closed; a cabin's follows its slot                                |
| telescopic bridge          | `bridge:<interactive id>`, retracted / extended    | retracted                                                         |
| tree harvest state         | `harvest:<level tag>`, standing / felled           | standing                                                          |
| script group               | `script:<entity id>`                               | the stored default, or its scripts' quest checks on activation    |
| script-shown interactive   | `script:<logic id>`                                | shown, or its scripts' quest checks on activation                 |
| controller-less logic gate | `logic:<entity id>:<mask>`                         | off                                                               |
| environment volume         | `environmentVolume:<index>`                        | on, except scripted volumes                                       |
| water volume fill          | `waterLevel:<id>`                                  | the authored fill; drained for a pool a quest needs drained       |
| fire seed level            | `fireSeed:player`, not carried / levels 1–5        | the highest level                                                 |

the control's kind is the selector's name in its id (`door`, `script`, …). every control is built by
`sceneControl` in [scene-control.ts](../../packages/extractor/src/game/state/scene-control.ts),
which files it under its kind's category (the panel section); a new mechanism adds its kind there,
and registers its controls with the packer's
[control registry](../../packages/extractor/src/pack/control-registry.ts) in any order.

the interactive controls' poses come from
[prefabs, dynamic structures and interactives](prefabs-and-interactives.md#view-state-poses); the
environment volume and water level controls are described with their tables
([environments](../package-format.md#environments), [water](../package-format.md#water)). the
[fire seed](../game-data/effects.md#invisible-bridges)'s control exists in scenes whose level
scripts set its level, listed under "Player nearby" with those scripts as drivers and placed at
their middle, since it gates no content of its own. it defaults to the highest level, so the bridges
show around the camera; `PackageManifest.fireSeed` gives each value's reveal radii, read from
`FireSeedGameplayConfig`.

## MapConfig scene states

[MapConfig scene states](../game-data/scene-states.md#mapconfig-scene-states) are implemented by
[map-config.ts](../../packages/formats/src/endfield/map-config.ts) (parsing),
[scene-conditions.ts](../../packages/extractor/src/game/state/scene-conditions.ts) (controls) and
[game-state.ts](../../packages/extractor/src/game/state/game-state.ts) (the quests and variables
conditions read, and turning conditions into required control values).

the condition classes map to `SceneCondition.kind` as: `SimpleConditionCheckQuestState` → `quest`,
`SimpleConditionCheckMissionState` → `mission`, `SimpleConditionCheckMapVar` → `mapVar`,
`SimpleConditionCheckGlobalVar` → `globalVar`, `CombinedConditionRuntime` → `all` / `any`. the
parser throws on any other class or a malformed field, so a new class surfaces as an extraction
error instead of a guessed truth value.

the world index exposes chunk files' suffixes as `ChunkFile.sceneState` / `ChunkFile.area`, and
`world entities` / `asset cell` take `--scene-state` and `--area` filters. dynamic visible-state
lists are read by [dynamic-resources.ts](../../packages/formats/src/endfield/dynamic-resources.ts)
as `states` and `groupStates`, visible-area lists as `areas` and `groupAreas`; gating uses those
lists, never the resource group's `sceneState` field.

[what they gate](../game-data/scene-states.md#what-they-gate), all by one collection rule (a file's
scene state; an appearance in an always-loaded file makes the content unconditional):

- **static renderers** in a non-zero scene-state file become conditional instances, visible while
  any of their files' states is on, streamed as conditional detail only
  ([how the packer files instances](../extraction.md#how-the-packer-files-instances))
- **environment and post volumes** ([volumes](environments.md#volumes)); each level's base
  environment is chosen among the volumes loaded under the default states
  ([the level's base environment](environments.md#the-levels-base-environment))
- **water surfaces** ([water-source.ts](../../packages/extractor/src/game/water/water-source.ts),
  [water table](../package-format.md#water)) and **local lights**
  ([lights](../package-format.md#lights))

## defaults

a state with a condition is derived: it follows the quest and variable controls its condition reads,
unless the user picks a value. its control's `rule` spells out the condition. the defaults of those
inputs are those of a player who finished the story:

- every quest and mission is completed (3)
- every variable holds the highest value the scene compares it against ([variables](#variables));
  the client ships no variable defaults ([variables](../game-data/scene-states.md#variables)), so
  this is a guess
- condition-less states are off, because nothing offline sets them
- a state index that a visibility list requires but the MapConfig doesn't name gets an off control
  (`unnamedSceneStateControl`)

under these defaults, the map01 example in
[how the game applies them](../game-data/scene-states.md#how-the-game-applies-them) gives:
`001_normal` on, `001_damaged` off, `001_overcast_rainy` off, `001_sunny` on,
`dung01_rdg008_006_liino` off, `dung01_rdg008_006_liino_hide` on.

## variables

a variable's control takes one value per range of values the scene's conditions tell apart: below,
at and between the values they compare it against, and above the highest, plus "unset", which fails
every test ([variables](../game-data/scene-states.md#variables)).

the default is the highest compared value, on the reading that the story moves variables forward
(erosion cleansed, machines repaired, the last stage of a staged change). the guess fails at Origin
Lodespring (map01_lv006), where an in-game shot matches value 2 of the light column's variable, not
the default 4; the red-ringed spires there are gated on a sentinel-looking 9999, which shouldn't set
the default ([variables](../game-data/scene-states.md#variables)).

a map variable is keyed by the map's numeric id and its numeric variable id (`mapVar:85:#125`)
wherever the scene's MapConfig names it: a MapConfig condition's name resolves through
`mapVarName2NumId`, and the control is labelled from `mapVarNumId2Name`, so a scene state and a load
gate on the same variable share one control. a map variable the MapConfig doesn't name (map01 names
none) keeps the key its source gives it. global variables have no name table, so MapConfig's named
ones and gates' numbered ones stay apart.

a map variable that is an interactive's saved property
([variables](../game-data/scene-states.md#variables)) is named after that interactive and placed at
it ([interactive-variables.ts](../../packages/extractor/src/game/state/interactive-variables.ts)):
what its template is ("Sludge core", "Outfall", "Wuling bridge", from a short list by template id,
else the template id), plus the property when it isn't `state`. its assumption says which
interactive and property it is and the value a fresh world starts at; its default stays as for other
variables.

a blight's variable ([blight and its cores](../game-data/scene-states.md#dynamic-load-gates)),
map01's erosion and map02's sludge alike, gets a control described for it instead, from
[dynamic-structures.ts](../../packages/extractor/src/game/dynamic/dynamic-structures.ts): still
`mapVar:<map>:#<id>`, named `Blight (x, z)` after the erosion root's core position or the sludge
patch's position, with two values, present (the core alive: an erosion variable other than 2, a
sludge variable of 0) and cleansed (destroyed, the default, as in a finished world). its patches and
its core both require present. `GameState.claimVariable` hands the variable over only when no other
condition reads it; otherwise the patches keep the generic control and the core stays unconditional.

## dynamic load gates

[dynamic load gates](../game-data/scene-states.md#dynamic-load-gates) are decoded by
[dynamic-scene.ts](../../packages/formats/src/endfield/dynamic-scene.ts) into `DynamicEntity.gates`
and turned into requirements on quest, mission and variable controls by
[game-state.ts](../../packages/extractor/src/game/state/game-state.ts). a mission gate is a combined
condition (`all`/`any`, `reverse = !loadWhen`) over the quest and mission controls; a gate's
variable is a variable control like a MapConfig one. variables with `controlLoad` 0 aren't listed as
gates.

server-set variable gates stay plain variable controls: Yinglung Pass's
[outpost tiers](../game-data/scene-states.md#dynamic-load-gates) (#321–324) and energy point towers
(`defenceFnish`) each follow their own control. every tier variable defaults to 1, its highest
compared value, so all four tiers show until the user turns some off.

**outpost upgrade missions.**
[upgrade missions](../game-data/scene-states.md#outpost-upgrade-missions) are read from
`SettlementBasicDataTable` by
[settlement-upgrades.ts](../../packages/extractor/src/game/state/settlement-upgrades.ts) and passed
to `GameState`, which reads a test of one completing (`= completed`, `≠ completed`) as the outpost's
level control instead of a mission control: complete above the level that names the mission. a test
that tells the mission's unfinished states apart keeps the mission control, and so does a mission
whose outpost isn't in the scene or has no authored level above that one. an outpost defaults to its
highest authored level, at or above every one of its missions completing, so content gated on its
upgrade missions (Cardiac Remediation Station's light column, on `f1m19d3`) shows by default. the
upgrade missions are factory missions, not main story ones, so "Main story progress" doesn't move
these outposts; their own level control does.

## progressions

[progressions](../game-data/scene-states.md#progressions) are implemented in
[scenery-variants.ts](../../packages/extractor/src/game/state/scenery-variants.ts);
`variants <scene>` prints them with the scene's stream areas.

a progression is keyed `<kind>:<key>` (settlement id, POI id, or region level id); a settlement's
main and secondary controlling entity share one progression. its selectable levels are the bits any
of its groups use, and its default is the highest, the finished world. groups shown only at lower
levels (scaffolding, an unbuilt site) are hidden by default; the control still picks any authored
level. each progression is selected independently, because the player's progress is per facility and
no single completion percentage describes it.

a resource group with a non-zero mask on an entity with no controller follows the entity's variable
when it reads one ([variable-driven view states](#variable-driven-view-states)). without one, it
shows in the default state and needs no control if bit 0 is set; otherwise it gets a
`logic:<entity id>:<mask>` toggle, off, because nothing recovered drives that entity's logic state.
the entity id is its global id, or `<grid>:<ordinal>` for an entity without an `IdComp`.

trees' standing/felled bits get one `harvest` control per level that previews them all, standing by
default, since the player fells each tree at runtime.

## facility visual forms

[facility visual forms](../game-data/scene-states.md#facility-visual-forms) are implemented in
[template-models.ts](../../packages/extractor/src/game/interactives/template-models.ts) and
[facility-forms.ts](../../packages/extractor/src/game/interactives/facility-forms.ts), with the
templates decoded as [MemoryPack](../extraction.md#memorypack-data) (`InteractiveTemplateData`).
placements are deduplicated by id
([placed-interactives.ts](../../packages/extractor/src/game/interactives/placed-interactives.ts)), a
row created with its level (`createState` 0) winning over one created later. a row created later
(any other `createState`) is placed like the rest and also requires its level's `created:<level id>`
control, one per level, off by default, since the server or a level script creates those rows during
play. every facility placement becomes a `facility:<id>` progression whose levels are the list
indices and whose default is the last form, fully upgraded as in a finished world (the template's
base model, form 1 for a recycling station, is still selectable). form numbers aren't gameplay
levels, so the viewer labels them "Visual form", not "Level".

## Dijiang cabins and region walls

[Dijiang cabins](../game-data/scene-states.md#dijiang-cabins) are implemented in
[cabins.ts](../../packages/extractor/src/game/dynamic/cabins.ts). the packer gives a slot the
largest cabin whose row pivots fit its box, else the smallest, which puts the growth chamber in the
medium slot and manufacturing cabins in the small ones. that rule is ours: no client data assigning
a cabin type to a slot was found, so a slot shows the type that fits, not necessarily the one the
game builds there. the small slot with no door and no room-table row is offered like the others. the
cabin types' room type ids (which name their rooms' bakes) are matched to `SpaceshipRoomTypeTable`
rows by hand, by the rows' icon names (`…_icon_manufacturing_station` is 1, `…_icon_grow_cabin` 2):
the table names no cabin types. each slot is a `cabin:<id>` control, empty by default. a slot's
region bake goes with the built cabin ([irradiance cells](../package-format.md#irradiance-cells)).

the packer numbers a growth chamber's planting boxes in the order the cabin scene's entity lists
them in its resource groups
([grow-boxes.ts](../../packages/extractor/src/game/dynamic/grow-boxes.ts)). a growth chamber slot
gets a `cabinLevel:<id>` control with the table's levels, level 1 by default, and each box gets two
rows: the prefab as saved below its field's level, and with the shutter hidden from it on. a planted
crop and the box's status bar aren't drawn.

[region walls](../game-data/scene-states.md#dijiang-region-walls) are implemented in
[region-walls.ts](../../packages/extractor/src/game/interactives/region-walls.ts): one
`controlNexus:<level id>` control, level 1 by default, offering level 1 and each level that unlocks
an area (levels between them change no wall). each wall shows at the offered levels below its area's
unlock level. the cabin slot behind a locked wall stays selectable.

## doors

[doors](../game-data/scene-states.md#doors) are implemented in
[doors.ts](../../packages/extractor/src/game/interactives/doors.ts) and
[cabins.ts](../../packages/extractor/src/game/dynamic/cabins.ts), with the
[door poses](prefabs-and-interactives.md#view-state-poses). each placed interactive whose model has
door poses gets a `door:<interactive id>` control, closed (0) or open (1), with its closed and open
poses placed under it. what opens doors in game isn't in client data, so:

- a door defaults to closed, its state before the player or the server opens it
- a Dijiang cabin's door follows its cabin slot: derived, open while the slot is built and closed
  while it's empty. each door goes to the nearest slot origin within 12 m in plan; the spare small
  slot has none
- Dijiang's reception room door stays closed by default, since its unlock is server-only

## bridges

[telescopic bridges](../game-data/scene-states.md#telescopic-bridges) are implemented in
[bridges.ts](../../packages/extractor/src/game/interactives/bridges.ts). each placed bridge gets a
`bridge:<interactive id>` control, retracted (0, the default and the template's initial state) or
extended (1), with its [poses](prefabs-and-interactives.md#view-state-poses) placed under it. a
bridge whose prefab can't be read as one is reported in `unsupported-interactives.json` and drawn as
saved.

## variable-driven view states

a DynamicStreaming entity whose view-state controller (current version) a variable drives
([view states on dynamic entities](../game-data/scene-states.md#view-states-on-dynamic-entities)) is
posed by that variable's control
([dynamic-structures.ts](../../packages/extractor/src/game/dynamic/dynamic-structures.ts)): the
values its state machine compares `state` against (`testedValues`) are noted as tests of the
variable, so its control tells them apart, and the entity's model is placed once per value, posed as
the machine settles with `state` at that value (`settledPose`), and once as saved for every other
value and while unset. the variable's default, the highest value tested, gives the finished-world
look: The Hub → Valley Pass bridge lowered, the magic Wuling bridges extended. an entity with
several variables follows its first. the same variable sets a controller-less entity's level: a
resource group with logic-state bits loads while the variable equals one of them (or, for a mask of
more than 16 levels, none of the others), replacing the off `logic:` toggle such groups got before.

## doodad groups

[doodad groups](../game-data/scene-states.md#doodad-groups) are implemented in
[doodad-shell.ts](../../packages/extractor/src/game/interactives/doodad-shell.ts) and
[doodad-groups.ts](../../packages/extractor/src/game/interactives/doodad-groups.ts). a shell without
identity slots is reported and keeps only its own renderers. every level with doodad groups gets one
`doodadGroups:<level id>` progression ("Resource nodes") over the group levels its shells name,
defaulting to the highest. each form is placed at the interactive's transform and shown under
`1 << level`.

## script groups

each [script-control entity](../game-data/scene-states.md#script-groups) gets a `script:<entity id>`
control defaulting to its default-load flag
([dynamic-structures.ts](../../packages/extractor/src/game/dynamic/dynamic-structures.ts)), unless
its scripts' quest checks settle it ([below](#following-quest-checks-on-activation)). event content
such as a limited-time race course lands here, typically off. a level interactive that one of the
scene's own scripts shows or hides by a constant entity pointer gets a `script:<logic id>` control
too, shown by default (as placed), and its placements also require it
([interactive-row.ts](../../packages/extractor/src/game/interactives/interactive-row.ts)). the
packer reads the scene's level scripts once, collects those targets before placing interactives,
then finds drivers for both kinds. pointers to a script's own slots and computed targets aren't
followed; the pack report counts them (`scriptVisibilityUntraced`).

toggle names for script and logic controls are the one or two most frequent renderer names under
them: labels for finding the control, not evidence of what activates it.

### drivers

[what sets a script group](../game-data/scene-states.md#what-sets-a-script-group) is found by
[script-drivers.ts](../../packages/extractor/src/game/script-drivers.ts) over the decoded level
scripts. the packer follows every path from each header to each show/hide action (up to 16 guard
sets per node), and custom events and script starts back up to five hops. each root cause becomes a
`ControlDriver` of the group's control, with the `visible` the action sets: quest ids found on the
way (in guards and quest events), a switch, a trigger area, the script's own area, or the server.

header types map to causes by an explicit list: an interactive's use events
(`OnInteractiveStateChanged`, `OnUIInteract`, unlocks, saved-property changes, being scanned) are
switches; script stage, property and lifecycle events are the server; fights, spawners and deaths,
dialogues and cutscenes, variable changes, and entity starts or custom events are `event` drivers of
those kinds. any other header type becomes an `unknown` driver naming it, and the pack report counts
and logs those types (`scriptEventTypesUnmapped`). scripts of other levels that name a scene's group
(dungeons reusing the open world, such as the racing courses), found by the group's id in their
bytes, become `level` drivers. missions whose objectives check a script (stage, property) are listed
as quest drivers of its activation. the viewer lists each control's drivers and flies to a driver's
position.

a script group that a level script's spherical trigger volume swaps as the player enters and leaves
derives from a `proximity:volume:<script id>:<slot id>` control
([proximity](../package-format.md#proximity)), which the viewer sets from the camera.

### following quest checks on activation

a script that checks a quest when it runs is built to run on both sides of that check
([following quest checks](../game-data/scene-states.md#following-quest-checks-on-activation)), so
such a group follows the check rather than its stored flag. when every path from one of the scene's
own scripts' activation headers (`OnScriptActive`, `…Start`, `…PreActive`) to a group's show or hide
action passes only `CheckMissionOrQuestIsComplete` / `…IsProcessing` guards (and constants), each
path is a conjunction of quest and mission tests. the group's control is then derived: shown while a
show path holds, or, for a group authored to load, while no hide path holds. a path without any
quest test (the script running is the only cause), a guard of another kind, or a state under which
both a show and a hide path hold leaves the control at its stored flag. other drivers (switches,
areas, quest events, other levels) don't enter the formula: they act after activation, until the
script runs again. under the finished-story defaults the Power Plateau gate is open and the props
are shown, and both follow "Main story progress".

## quest and mission labels

[quest and mission labels](../game-data/scene-states.md#quest-and-mission-labels) are implemented by
[mission-runtime.ts](../../packages/formats/src/endfield/mission-runtime.ts) (parsing) and
[story.ts](../../packages/extractor/src/game/state/story.ts) (labels), and land in the package as
[story places](../package-format.md#controls). rich-text tags (`<@…>…</>`) are stripped. a quest's
label is its first objective's text, else the mission description it shows while running
(`descriptionOverride`). a quest off the main flow sits half a step after its predecessors. hidden
quests are labelled "hidden step" with their id's suffix. quests whose mission the client lacks keep
their raw id. the episode label is inferred from the id.

## places

the control registry gives each control a [place](../package-format.md#controls). its position is
the spot the mechanism names (an interactive's placement for doors, bridges, campfires and the
interactives scripts show; a cabin slot; a blight's core), else the centre of the box around the
instances the control gates, carried back through the controls it derives. content wider or deeper
than 1024 m counts as spread over the scene and gets no place, unless the mechanism names a spot.
lights, water surfaces and environment volumes don't add to the box yet.

the label names the position in the game's words
([map-labels.ts](../../packages/extractor/src/game/world/map-labels.ts)): the display name of the
level owning its cell, and the nearest of that level's
[map place names](../game-data/world.md#map-place-names) within 150 m ("The Hub · Bridge Approach",
"Wuling City · Tianjing Courtyard"). since the place says where, control names say what: "Door
(int_door_common_v2)", "Campfire", "Blight core", rather than coordinates.

## rules

- gate content on stored conditions; names do not establish activation. show the assumption behind
  each default ([defaults](#defaults)).
- preserve compound requirements and union alternatives for shared resources
  ([conditional sets](../package-format.md#conditional-sets)).
- present controls as previews. by-name state writers, script overrides, activity conditions and
  server state remain incomplete ([status](../status.md#scene-states-and-controls)).
- unknown condition classes, operators, out-of-range spans and invalid flags throw during
  extraction.
