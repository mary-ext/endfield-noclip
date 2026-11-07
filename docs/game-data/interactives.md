# interactives

the placed gameplay objects: switches, doors, chests, campfires, collectibles, harvestable plants,
shops. this page covers where their models come from and the looks their view states settle in. how
clips store their poses is in [animation.md](animation.md); what sets an interactive's runtime state
(server, scripts, progression) is in [scene-states.md](scene-states.md).

## placements and models

an interactive's model comes from four sources:

1. LevelData files (from LevelConfig `levelDataPathHashes`) place them. the sequential prefix up to
   the interactive list holds, per interactive: interactive id, `createState`, position, rotation,
   scale, `modelScale` (0 = no override), `isLocked`, the placement's own values for its entity's
   properties (`properties`, overriding the template's) and the per-component parameters (keyed by
   the game's interactive component type). `createState` 0 means created with the level.
2. `Data/Json/Interactive/InteractiveTable.json` maps each interactive id to a template and each
   template to its data file. many ids share one template: the Wuling switch variants all
   instantiate `int_switch_wuling`.
3. the template `Data/Json/Interactive/InteractiveData/data_<template>.json` (pooled MemoryPack).
   its leading component is the model component (model id and scale). its last members are the
   [variant table](#the-variant-table), keyed by interactive id, whose entries can override the
   model id.
4. `Data/Json/GameplayConfig/ModelTable.json` maps each model id to a prefab path and `scaleFactor`.

level scripts place interactives too: a script's `interactives` dictionary maps slots (40001, 40002,
…) to rows of the same `LevelInteractiveData` shape, with `levelLogicId` 0 and `belongLevelScriptId`
naming the script, which addresses them by slot. they exist while the script runs
([script groups](scene-states.md#what-sets-a-script-group)). across the install thousands of such
rows sit in hundreds of scripts: racing courses' coins and moving platforms, open-world butterflies,
bubble chests, mission beacons and puzzle pieces.

a placement's model is its variant's, else the template's. a variant whose model override is enabled
but empty has no model of its own, rather than the template's. templates without a model (triggers,
logic) have nothing to draw. a model that is a doodad-group shell draws nothing itself; one form per
group level attaches to it instead ([doodad groups](scene-states.md#doodad-groups)). templates carry
no display name, only their id.

six of the install's 332 interactive templates have a model-upgrade component
(`InteractiveModelLevelUpComponentData`), which lists model ids in visual-form order and contains
the base model id: `int_system_domain_shop`, `int_system_domain_depot`, `int_doodad_core_recycle`,
`int_system_kite_station`, `int_system_farm_terminal` (placed in map02_lv002 and map02_lv010) and
`int_system_simulation_training` (map02_lv006)
([facility visual forms](scene-states.md#facility-visual-forms)).

### the variant table

between the model component and the variant table sit hundreds of component and action-graph types.
the table is followed only by the template's temporary properties and two flags, and its keys are
exactly the InteractiveTable ids that name this template, other than the template's own id, which is
never a key (this holds for every shipped template). variant entries are 14-member objects in name
order; `Optional<T>` is an object of (enabled, value) for managed `T` and a raw struct (enabled,
padding, value) for unmanaged `T`.

### the LevelData format

LevelData is a sequential format that stores no field lengths, so a field can only be passed by
reading it, and misreading one misframes every later row. polymorphic fields are MemoryPack unions
whose tag indexes the subclasses in name order, with each subclass's members also in name order.
gameplay tags are unmanaged four-byte values.

## gameplay locks

LevelData's `interactiveLockData`, the member after the interactive list, gives interactives their
gameplay locks: per logic id (`logicIdGlobal`), a list of locks, each with an unlock type
(`InteractiveUnlockType`: 1 script lock, 2 mini-game, 3 submit, 4 quest, 5 sludge) and its mini-game
ids, submit id and panel texts. the placement's own `isLocked` flag is separate. across the
install's decodable LevelData there are 1030 script, 127 mini-game, 19 submit, 57 quest and 58
sludge locks.

a mini-game or submit lock can swap the model's look. the game looks up an `UnlockEffectConfigMono`
on the model's root GameObject, and when its `useDifferentModel` is set, switches its `lockedModel`
on and its `unlockedModel` off while the interactive is locked by gameplay, the other way once
unlocked, whether or not the component is enabled. other lock types never swap, so such a prefab
keeps the models as saved. the lock opens when the player solves it, which the server saves; a fresh
world starts with it locked.

in map01_lv006's Origin Lodespring, the crane controllers (`int_crane_controller_2`) carry this
component, with a `Broken` model (sparks and smoke, saved off) and a `Fixed` one (saved on).
3500021687 (near 430, 36, 182) has a mini-game lock (`M01L06_B1_easy_1_1`), so it starts broken;
3500021688 (near 435, 36, 187) has only a script lock, so it stays fixed.

## interactive view states

a model's runtime looks are view states:
`Data/Json/Interactive/ModelViewStateControllerData/<model id>.json` (MemoryPack, root
`MVSCModelViewStateControllerData`) holds, per animator (`modelName`, `$$ROOT$$` for the prefab
root) and layer, a state machine. each state names an AnimationClip, behaviours (`SetActive`
switches a GameObject by name on or off; others play effects, audio or navmesh changes) and
transitions that wait on blackboard keys. `clipAssetInfos` gives each clip's StringPathHash. an
Animator without a controller of its own takes its clips from these states. a model's `effectIds`
name prefabs its states' `EffectBehavior`s play.

a model whose `ModelTable` row sets `hasModelViewData` and names another model in
`dependModelViewDataId` has no file of its own and uses that model's view states (the field sits on
the table's `ModelData` and on the interactive model component). eight rows do: the small campfire
(`int_campfire_smaller`, the full campfire's prefab at 0.8 scale, placed by the
`int_campfire_v2_smaller` variant in Dijiang's central hall at 0, 0.9, 57.1), recycling station
forms 2–4, the long erosion pops 2–4 and the common chest (`int_trchest_common_normal`, on
`int_trchest_common_low`'s states). all but the campfire borrow states written for a different
prefab.

a layer starts in its `isStartingNode` state and takes the first transition whose conditions all
hold (`comparison` 0 =, 1 >, 2 <, 3 ≥, 4 ≤ against a bool, float, int or trigger value, `isInvert`
negating it); a transition without conditions is taken when its state's clip ends. a layer comes to
rest in a state none of whose transitions holds. later layers of one animator override earlier ones.

a settled state's look is its clip's end pose plus its `SetActive` switches, unless the clip loops:
then it keeps playing, as the balloon's tube sways through its 14 s idle
(`A_interactive_balloon+1_001_01_idle_01`). a facility's visual forms are models with view states of
their own: the monitoring terminal's forms 1–4 (`int_system_kiteStation_<n>_postmodel`) rest in an
`Initial` state whose loop (`A_anm_fac_syspoikitestation+1_001_01a`…`01d`) flies the kites, and form
0 has no clip. when each placement's loop starts is unknown. how clips store poses, switches and
material values is in [animation clips](animation.md#animation-clips).

### effects states play

a state's effect behaviour (`MVSCEffectBehaviorData`) plays an effect by name when the state is
entered. the game loads it from
`Assets/Beyond/DynamicAssets/Gameplay/Effects/Prefabs/<name>.prefab`. it plays on the GameObject
`effectNodeName` names, or on the animator's GameObject when that's empty or the model has no such
GameObject. it follows that GameObject, turning with it only with `followRot`; with
`dontFollowTrans` it's placed once at the GameObject's position and rotation instead. a
fire-and-forget effect (`fireAndForget`) is left to play out on its own. otherwise:

- a persistent effect (`isPersistence`) is switched on or off (`active`) by each state that names
  it, so it outlasts the state that started it
- any other effect replaces the instance the same behaviour played before; that it ends when its
  state is left is assumed (`EffectPlayBehavior.ForceEnd` isn't read)

so at rest a model plays the persistent effects its states left on and the other effects of the
states it rests in. an effect whose `EffectSetting`s don't loop has run out by then
([one-shot effects](effects.md#one-shot-effects)). across the install's view states there are about
1800 effect behaviours: about 1060 on named GameObjects, 755 persistent and 110 fire-and-forget.

### the `state` key

an interactive whose template has a common-perform component (`InteractiveCommonPerformComponent`)
always passes its entity's int `state` property to its view states under the same key: once when the
view controller starts, and again whenever the property changes. the property starts at the
template's saved property (`saveProperties`), which a variant's `diffProperties` and then the
placement's own `properties` override (3582 placements in the install set `state` there); the
server's saved value and level scripts can change it later. some placements set `state` among a
component's parameters instead; that those reach the entity property too is assumed, since how
component parameters reach the entity isn't read.

the jump pads are the commonest case. `int_jumpmachine` saves `state` 1, so it starts on: its
`BaseLayer` plays the ring's opening turn (`A_anm_zmdspring+1_001_open_01`, 3.3 s) into a looping
idle turn, and its `EffectLayer` rests in `On`, which plays `P_common_bouncingplatform_01`. at 0 it
rests in a one-frame closed idle with no effect. `int_jumpmachine_vertical` and
`int_jumpmachine_electric` save 0. every jump pad placement in the install sets its own `state`: all
31 vertical pads and 216 of the 223 plain, free, rock and Xirang pads start at 1, and 12 of the 14
electric pads at 0. lifters, fans, attack switches, hydrants and ball receivers start at a nonzero
`state` too.

apart from its view states, a jump pad (`JumpMachineComponent`) that isn't locked or a free jump
places a stationary effect named by its `effect` parameter (`P_common_bouncingplatform_arrow_01`, a
looping arrow) at its own position. it counts as locked while its `state` is off (0, the logic
components' off value; 1 is on), and then switches the arrow off; its `is_locked` property isn't
read for this. so an off pad shows neither its `On` glow nor its arrow. `free_jump` and `effect` are
the component's own parameters, which the component reads apart from its entity's properties: the
template component's `propertyList`, overridden by the variant's `componentDiffProperties` entry
(`Comp_JumpMachine`) and then the placement's parameters under component type 169. the entity's
`free_jump` property, which variants set alongside, isn't what decides. `int_jumpmachine_free` turns
it on, but all 13 of its placements turn it back off, so they show an arrow; 4 `int_jumpmachine`
placements turn it on, and 12 of the 32 rock pads keep the variant's free jump. the effect turns
about the vertical only, towards its `target_position` property: its rotation looks along the
horizontal part of the target minus the pad's position. 237 pad placements set their own target. the
template's (−8.3, 0.6, −0.07) is used as a world position all the same, so pads that keep it point
towards about the world origin.

the vertical jump pads (`int_jumpmachine_vertical`, a cave vent rock,
`P_interactive_cavewell+1_001_01`) have a component of their own (`JumpMachineVerticalComponent`)
and no view-state effects or arrow. while the entity's `state` is on (1) and its cooldown is done,
which it is at start, the component plays `P_interactive_cavewell+1_001_01_loop` (two smoke emitters
and a spark emitter) on the entity's root, and switches it off at any other `state`. the name is
fixed in the game's code, not read from the template. whether the loop turns with the entity isn't
read.

### lengths view states set

a state's length behaviour (`MVSCEffectLengthBehaviorData`) sets the length of the effect-length
component (`VFXAdjustLength`) on the GameObject `nodeName` names. the length is the blackboard float
`dependFloatKey` names when `dependBlackBoard` is set (nothing is set while that float is missing),
else `val`, plus `deviation`. the length stays once its state is left. setting it applies the
component's ratio `length / presetLength`:

- **scale targets** (`useScaleTransform`): each listed Transform's local scale becomes the ratio
  along `axisDir` (0 x, 1 y, 2 z) and 1 on the other axes
- **tiling** (`useTillingOffset`): each listed renderer's property block sets the texture's `_ST`
  from its material's: along `tillingDir` (0 u, 1 v) the scale is multiplied by the ratio (by its
  inverse with `revertScale`) and the offset becomes `scale · offset · (1 − ratio)`
- renderer bounds, particle lifetimes and moved Transforms have switches of their own

a `PositionFollower` moves its GameObject to its `source` Transform's world position every frame,
keeping its own rotation and scale, which is how something hangs off a stretched part's end.

### vertical rope lifts

a vertical rope lift is two placements of `int_rope_port`: the top port (`int_rope_port_top_right`
or `_top`), whose arm holds the rope, and the bottom port. the top's `target` property names the
bottom's logic id. its vertical-rope component (`InteractiveVerticalRopeComponent`) sets the float
`RopeLength` to the height between the two ports' entities before its view states start. the top
port's model (`int_rope_port_topright_postmodel`) starts in `start`. at `state` 0 it rests in the
folded `off_idle`. above 0 it goes through `set_rope`, whose length behaviour sets the rope
(`P_iprop_com_rope+1_001_02`, preset 0.5 m along y, colour and normal maps tiled along v) to
`RopeLength` plus 1.4 m, into `on_idle`, which swings the arm 45° out over the bottom port. the
rope's end block (`P_anm_com_machine+1_001_04`) follows the rope's `rope_mount_point`, so it hangs
about a metre above the bottom port. as saved, the rope is 0.5 m long and the block sits under the
arm. indie_race001's lift near 88, 116–123, 102 sets `state` 1, so it starts unrolled.

### lifts

a lift (template `int_lifter_v2` and its variants) has a lift core component (`LifterCoreComponent`,
type 154) that moves a platform between floors. the entity's `state` is the floor, and the entity
property `position_list` lists each floor's platform position in world space (type 12, three floats
per floor). a `state` past the list's end is an error the game only logs. as the lift starts, and
whenever it's set to a floor:

- the postmodel MonoBehaviour on the model's root (`InteractiveMovingPlatformPostmodelMono`) names
  the moving part (`MovingPartRoot`, the `platform` GameObject), an optional pole (`Pole`), the
  pole's saved height (`PoleHeight`) and the platform's thickness (`PlacformThickness`). the moving
  part's world position becomes the floor's position.
- with a pole, its local scale becomes (1, s, 1) with s = (floor y − pole y − thickness) / height,
  the pole's y taken as placed, before the platform moves. so its top meets the platform's
  underside, and at a bottom floor that sits a thickness above the pole's foot it shrinks to
  nothing.
- the component's own `doorside_list` (template parameters, then the placement's under type 154)
  entry for the floor sets the view-state bools `left_opened` (bit 1 clear) and `right_opened` (bit
  0 clear); `moving` is false at rest. the template's list is all 0, both doors open.

the component switches no GameObject. the pole lifts' models (`int_lifter_v2_postmodel_lv005_only`,
`_pole_only`) keep the cabin (`P_interactive_elevatorcar+1_001_01`) and the call-button frame
(`int_lifter_button_postmodel`) the cabin lift (`_door_only`) shows, switched off, and their view
states (only `MovingLayer`'s camera shakes) switch nothing either, so those never show. the server
saves the floor as the player rides; a fresh world starts at the placement's `state`. The Hub's lift
2100010064 (−84, 132.9, −88.2) starts at floor 1, its platform 14 m up at y 146.9 on a pole scaled
1.49 times its 9 m.

### broken robots

a broken robot (`int_fixable_robot`) has a fixable-robot component (`FixableRobotComponent`,
type 97) that passes its int parameters `level`, `damage_type` and `exit_type` to its view states
under the same keys when its view controller starts. they're the component's own parameters
(template 0, then the placement's under type 97), not entity properties. its model's effect layer
picks the SOS sign by `level`: at 0 it rests in `damage_type_yellow`, the yellow sign
(`P_interactive_robotemoji_sos_01` on `EmojiEffects`, `P_interactive_robotsos_middle_01` on
`HeadEffects`); above 0 in `damage_type_red`, the red sign (`P_interactive_robotemoji_sos_02`,
`P_interactive_robotsos_large_01`). both also play `P_fxmap_uninteractive_storehous_01` and
`P_lv005_smokeblack_small_01` on `Effect`. its base layer lies in `damage_type_01` at `damage_type`
0 and `damage_type_02` above it; `exit_type` only matters once it's fixed (`state` 1). of the
install's 91 placements, 43 set `level` 1, including map02_lv010's robot 37900200005 at 491,
237, 1231.

### keys the player sets

some blackboard keys follow the player:

- **`Distance`**: an interactive with a main-character interest component
  (`MainCharacterInterestComponent`) measures, every frame, the distance from the player's position
  to its entity and sets `Distance` true while it's at most the component's
  `main_character_interest_distance` (talosites: 15 m), false beyond; it sets it once when it starts
  too. that the distance is a plain 3D one is assumed; the helper measuring it isn't read.
- **`InZone`**: a campfire sets it while the player is inside its trigger (the template's
  `TriggerObserverComponent`, a sphere of `radius` 2.5 m), but only once it's activated. inside, it
  swaps the trigger's radius for a second value held at runtime, so leaving takes another distance.

keys that only fights or the server set (`InBattle`, `isDead`) have no offline value.

Dijiang's clue wall (`int_system_spaceship_clue_collection`, a mechanical arm over the clue board at
−94.2, 5.8, −17.3 in base01_lv001) is one. its model's `model` layer rests in `InActive`, a
one-frame closed pose (`A_anm_map01_zmdarm+1_001_closeidle_01`), until the bool `Active` holds; then
`Active` loops the arm through a 16 s idle (`…_openidle_01`) and its `effect` layer plays
`P_fxmap_base01_lv001_ship_cluewall_01` on `vfx_point`. `Active` isn't an entity property and no
template action sets it: the clue-collection component (`SpaceshipClueCollectionSystemComponent`)
passes the system layer's runtime active state (`ESystemState.IsActive`, delivered by the Dijiang
system's state-change events; the getter itself is VM-protected and wasn't read). no client data
feeds it, so it has no offline default and the arm rests closed.

### template animator parameters

an interactive's template can set its model's [Animator](animation.md#scenery-animators) parameters
as it loads: a simple-animator component (`SimpleAnimatorComponentData`) and, in the template's
action map, an on-start chain (`OnEntityStart`) of `SetAnimatorBool` actions whose value is a
constant (`paramSource` 0), a config property (200) or a saved property (300). six templates have
such a chain.

The Hub's comm terminal (`int_001_comm_terminal`, row `2100130029` in
`map01_lv001_lv_data_sub_e1m3`, under the hanging sculpture at −26.4, 98, −373.6) is the only one
with a saved bool placed in The Hub: it sets `seamless` from its config property (false) and `fixed`
from its saved property (false in the template), then fires `switchState`, which plays a one-shot
transition on the second layer. the base layer of `int_001_comm_terminal_controller` starts on
`error_idle`, the red crosses on the pedestal, and rests on `normal_idle` while `fixed` holds
(`seamless` selects a third pair). no mission, level script or table names the terminal or sets
`fixed`, so the server sets it; the user reports it's fixed once the story is done.

## talosites

the talosites (`int_collection_trstar_postmodel`, white; `int_collection_trstar_high_postmodel`,
blue; template `int_collection_trstar`, a `TreasureStar` component) are effect prefabs: three
crystal shards (mesh particles holding one particle each), a 2D star icon, billboard glows, a light
column and a ground glow. their `FX` layer rests in `IdleLoop` while the player is beyond 15 m, and
plays `InteractStart` into `InteractLoop` within it (`Distance`), returning through `InteractEnd`.
idle dims the glows below their saved values (the blue bubble `glow02` to a third of its
`_TintColorAlpha`) and holds the shards' pivots at 0, so they cluster; near brightens the glows and
moves the shards' pivots apart, and scales the star icon up 1.8×. the white model reuses the blue
model's clips but for its own activation start.

## campfires

a campfire's template has a campfire component (`InteractiveCampfireComponent`). its model
(`int_campfire_postmodel_v2`) has two animators with three layers between them, testing three keys:
`Enabled` (the player has activated it, from the player's saved activations), `InZone` (the player
stands in it) and `InBattle`.

| layer                                     | not activated        | activated, nobody near | player in it | in a fight  |
| ----------------------------------------- | -------------------- | ---------------------- | ------------ | ----------- |
| model (`P_interactive_campfire+1_003_01`) | `CloseIdle` (folded) | `Open_Idle` (unfolded) | `Open_Idle`  | `Open_Idle` |
| color (same animator, VAT clips)          | `Empty`              | `Empty`                | `On`         | `Off`       |
| effect (`P_interactive_campfire_effect`)  | `Locking`            | `Working`              | `Using`      | `Stopping`  |

the effect prefab holds one group per look: `moren` (the locked look: red and blue rings, a text
ring, a glow column), `shouquan` (two slowly turning rings), `yunzhuan` and `duankai`, plus
`qiehuan*` bursts for the transitions between them. the prefab as saved has every group switched on,
so drawn as saved it shows all of them at once, including the transition bursts' heat-haze cylinders
(`HGRP/Effect/VFXRefract`). `Locking` leaves only `moren`'s resident effects on; `Working` only
`shouquan`'s rings (its `lizi` sparks and, in `yunzhuan/qiehuan2`, the leftover of the switch burst,
are particles).

## interactive doors

a door's template has a door component (`InteractiveDoorCommonComponent`, or Dijiang's
`SpaceshipRoomDoorSystem`), and its model's states include a settled state (a clip, and every
transition waits on a condition) whose clip is an open idle (`…openidle…`). its closed state is
where the open one returns to: its one transition, then any unconditional states, up to the next
settled one. a Dijiang room door goes `built` → `built_to_unlocked` → `unlocked`; a Power Plateau
gate `on_idle` → `on_to_off` → `off_idle`. what opens each door is in
[doors](scene-states.md#doors).

## telescopic bridges

`int_telescopic` is a bridge that extends out of a wall in pieces. its template's logic controller
has `logicType` 8, an int `state` property (0 retracted, 1 extended) and a `pieces` config property
(3; a placement's own `pieces` would override it, but no map01 placement sets one). its prefab's
root has a MonoBehaviour (`InteractiveTelescopicPostmodelMono`) naming four children: the start
port, the end port, the horizontal track and a platform piece, plus the piece's length (4 m), width
and thickness. the piece is switched off in the prefab: the game draws copies of it, never the piece
itself, so its saved position (5.3 m out) means nothing.

all offsets are along the prefab root's +z, with n pieces of length L:

| part       | retracted (`state` 0)       | extended (`state` 1)               |
| ---------- | --------------------------- | ---------------------------------- |
| start port | as saved                    | as saved                           |
| end port   | at the start port (0, 0, 0) | (0, 0, n·L)                        |
| track      | switched off                | switched on, local scale (1, 1, n) |
| copies     | switched off                | copy i at (0, 0, i·L), unrotated   |

each copy's Animator plays its open idle state when extended, which raises the piece's rails (bones
below the piece), and its close idle state when retracted. the prefab as saved is neither: its end
port sits 13.35 m out with no pieces between. what sets `state` is in
[telescopic bridges](scene-states.md#telescopic-bridges).

## Wuling bridges

the `int_bridge_wuling` template covers two kinds of bridge. its own model,
`int_bridge_wuling_90_postmodel`, and the `_78` and `_102` variants' models are drawbridges: a leaf
that an animator raises and lowers (`closeidle`, `<angle>_open`, `<angle>_openidle`, `<angle>_close`
clips on `int_door_base_layer`, keyed by the int `state` property). the `_12m`, `_18m`, `_24m`,
`_24m_02` and `_94m` variants are magic bridges that appear with an effect: each variant's model
override is enabled but empty, and its `Comp_InteractiveCommonPerform` diff properties set
`use_dynamic_res` true (and a `model_id` naming `int_bridge_wuling_<length>_postmodel`, which
nothing in that component reads). the bridge itself is a DynamicStreaming prefab row of that model
at the placement; with `use_dynamic_res` set, the interactive's common-perform component takes its
view controller from the DynamicStreaming entity named by its `dynamic_entity_id` property instead
of its own model, so its `state` switches that row's `on`/`off` states (`SetActive` on the deck
copies, effects on the way). the magic bridge's model has no clips. that the empty model override
alone keeps the game from loading the template's drawbridge there is inferred from the data; the
model component's loading isn't read.

## auto-moving platforms

`int_platform_automove` (variants `_4m_4m`, `_5m_5m`, `_floatingtower`, …) is a platform that rides
a spline. its template has an auto-move platform component
(`InteractiveAutoMovePlatformComponentData`) and a custom curve move component
(`CustomCurveMoveComponentData`, component type 107 in placements' parameters), whose parameters
come from the template, then the variant's `Comp_InteractiveCustomCurveMove` diff, then the
placement's own.

- **starting**: the auto-move component starts the move when the entity's `state` is 1, on start and
  whenever `state` becomes 1; another value pauses it. the template saves 0, so only placements that
  set `state` 1 move with their level. nothing reacts to the player stepping on.
- **the spline**: `spline_id` names a spline of the level's LevelData (`splines`, `LevelSplineData`:
  `splineId`, `position`, Euler `rotation`, `closed`, Unity Splines `BezierKnot`s with tangents in
  the knot's frame). an id with no spline (the template's 0) or a `speed` of 0 or less never moves.
- **position**: `rotation · EvaluatePosition(spline, ratio) + position`, replacing the platform's
  own position; its rotation stays unless `curve_move_direction` is 1 (along the tangent). the ratio
  is the distance travelled from knot 0 over the spline's length, so the platform moves at `speed`
  metres per second along the curve. `sync_speed_to_audio` only feeds the speed to an audio
  parameter.
- **speed ramp**: `tween` 0 is uniform. `tween` 1 (EaseInOutExpo by name, but a linear ramp in code)
  ramps each trip over `distance` metres at both ends (half the trip each when the two would
  overlap): the speed rises linearly with distance from 0.1 m/s to `speed` over the first `distance`
  metres, and falls linearly with distance from `speed` towards 0 over the last. it never drops
  below 0.1 m/s, so a trip ends at that speed. each frame takes the speed at the distance reached so
  far, then moves.
- **the trip**: it starts at `curve_start_index` and travels to `curve_target_index`; equal indices
  close the spline for the trip and go round it whole. a later start than target runs backwards.
  `curve_move_mode` 0 stops at the target, 1 starts over from the start knot (dropping the
  overshoot), 2 goes back and forth, swapping start and target. `initial_phase` starts it that
  fraction of the trip on. `curve_start_index_list`, `curve_target_index_list` and
  `curve_segment_speed` set a speed per stretch of knots, and `use_curve_control_speed` drives the
  speed from a curve. `knotProgresses` and the spline's `keyNodeIndexList` aren't read.
- **knots**: every knot of the spline is a key node, and a trip fires each one it reaches (its
  distance from the trip's start ≤ the distance travelled). that includes its start knot just after
  setting off and its target on arrival, so a back-and-forth platform fires its end knot twice as it
  turns round. a whole-spline trip fires only the knots from its start index on (back to it when
  backwards), at their distance from the start. `curve_move_suppress_start_key_node` skips the start
  knot on the very first trip only. a fired knot listed in `curve_node_index_list` stops the
  platform, the entry at the same position in `wait_for_nearby_list` and `curve_node_wait_time_list`
  saying how. one that waits for nearby pauses until the player (the formation's centre) comes
  within `radius` metres of the platform. otherwise it pauses for the wait time, resumes, and the
  ramp carries on where it was. so a platform waiting 1 s at both ends of a back-and-forth trip
  stops 2 s at each end.

map02's floating towers (`int_platform_automove_floatingtower`, map02_lv007 near unity −415,
250, 690) go back and forth on two-knot splines at 3 or 4 m/s with a 1 m ramp and 1 s waits.
10200030167 and 10200030408 set `state` 1 and move. 10200030166 does too, but its start knot waits
for nearby, so it parks there until the player comes within 2 m. 10200030295 and 10200030247 keep
the template's `state` 0. 10200030295 (−402.6, 256.3, 696.7) is a step of the fire seed altar
10200030288's puzzle: level script 10200030031, which lists it as the interactive it puts at risk
and whose objective is the altar's `state` being 1, sends only a server call (`CallServer`) when the
player first enters a 5 × 10 × 5 m box on the platform. no client data sets its `state`, so the
server starts it, and a fresh world shows it still at its placement.

in indie_race001 every moving platform belongs to a level script: script 12800025038 places eight 4
m platforms on spline 25012, a 144 m loop under the crane rails near unity 80, 122, 92, an eighth of
the loop apart at 4 m/s. the level's own LevelData places eleven more that keep `state` 0, four of
them (12800025316–19, near 104, 118, 85) without a spline, so those stand still.

## crane towers

a crane puzzle is a tower (`int_crane_tower`, a crane tower component, `CraneTowerComponent`), the
container it carries (`int_crane_container`, its `_2` and `_stackedThree` variants) and switches
(`int_crane_controller_2`) whose `target` names the tower. the tower's component parameters (the
template's, overridden by the placement's own under component type 172) hold three step lists and
the container's logic id (`target`); the entity properties `state_1`, `state_2` and `state_3` pick a
step from each, clamped to the list, and the game saves them as the player operates the crane:

| state     | list            | sets                                                       |
| --------- | --------------- | ---------------------------------------------------------- |
| `state_1` | `position_list` | the rope length                                            |
| `state_2` | `rotation_list` | the arm's world yaw (the base Transform's world rotation)  |
| `state_3` | `euler_angles`  | the hook's world yaw (the header Transform's), independent |

the tower model (`int_crane_tower_postmodel`) has no view states. a MonoBehaviour on its root
(`InteractiveCraneTowerPostmodelMono`) names the base (`BasePoint`), the hook's header
(`RotatePoint`), the rope's end (`RopeEnd`, under `RopeStart` 18.07 m up and 22.25 m out along the
arm), the rope's scale Transform (`ScaleBase`) and the attach point (`AttachPoint`, 1.71 m below the
header). setting a rope length L sets the scale Transform's local scale to (1, 1, L + 1) and the
rope end's local position to (0, −L, 0); the yaws set world rotations about the vertical.

on its first tick the tower moves its container to the attach point's world position lowered by the
container's `height` entity property (4 m when absent; 4.28 for the plain container, 6.6 for
`_stackedThree`), and gives it the attach point's world rotation, wherever the container was placed.
so a container's own placement is only where it was authored, often at another rope length.
map01_lv006's Origin Lodespring has four towers: two containers were authored within about a metre
of where their towers' starting steps hang them (3500021667 under 3500021670, 3500022098 under
3500022095); tower 3500021909 (near 479, 58, 224) starts at its shorter rope, so its container
(3500021665) hangs 5.5 m above where it was authored, and tower 3500021686 (near 420, 59, 192) at
its longer one, so its container (3500021691) hangs 8.8 m below, just above the ground.

## laser gates

a laser gate's frame (`int_electric_fence_e` and its variants, e.g. `int_electric_fence_elower`,
model `int_electric_fence_4_postmodel`) holds no beam: its component (`ElectricFenceComponent`,
component type 130) plays the beams as effects. when it starts, and whenever the entity's `state`
changes, it plays each name in the `effectsOnActive` list of the fence postmodel MonoBehaviour
(`InteractiveElectricFencePostModelMono`) on its model's root while `state` is on (1), attached to
the entity at no offset, and recycles them at any other `state`. the 4 m gate plays
`P_interactive_electricfence_03_Variant` and `…_04_Variant`. the template saves `state` 0, and The
Hub's five placements set 1, so they start shut, beams on.

a gate is opened through power: its placement's switch (`int_switch_electric`) names the gate in its
`connected_node_list` (component 134), and the switch can only be used while its `has_power` is set.
nothing in the client's data sets `has_power`, so it comes from the server's factory power network.
the AIC buildings the world places for that network, such as The Hub's power ports
(`map01_lv001_power_port_1_*`, labelled "Electric Nexus" in game, each standing at the far end of a
cable model `p_imod_tundra_lv001line+1_001_*` that runs to a switch), are only partly in client
data: LevelData's `predefinedParams` (in `*_lv_data_sub_factory`) give each port's parameters,
including the interactive it powers (`powerPort.target`), and `FactorySpecialPowerPoleTable` its
name and description, but no client file holds a port's position or building. the factory regions'
`initialBuildings` are empty on the open-world maps, and The Hub's port targets
(`2100391045`–`2100391053`, `2100040058`) aren't in any client LevelData, so which port powers which
switch isn't known either. where the ports stand is held by the server.

`int_electric_fence` (the older fence) is driven by a logic controller
(`InteractiveLogicElectricFence`) instead, which recomputes its `state` from its electric node's net
power against a threshold before playing the same kind of effect list, so its start depends on
server power.
