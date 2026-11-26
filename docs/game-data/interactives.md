# interactives

placed gameplay objects: switches, doors, chests, campfires, collectibles, harvestable plants, and
shops. this page covers model resolution and settled view-state looks. clip formats are in
[animation.md](animation.md); runtime state drivers (server, scripts, progression) are in
[scene-states.md](scene-states.md).

## placements and models

an interactive's model comes from four sources:

1. **LevelData** (`LevelConfig.levelDataPathHashes`): the sequential prefix up to the interactive
   list stores per placement: interactive id, `createState` (0 = created with the level), position,
   rotation, scale, `modelScale` (0 = no override), `isLocked`, entity `properties` (overriding the
   template), and per-component parameters (keyed by component type).
2. **`Data/Json/Interactive/InteractiveTable.json`**: maps each interactive id to a template, and
   each template to its data file. many ids share one template (e.g. Wuling switch variants
   instantiate `int_switch_wuling`).
3. **`Data/Json/Interactive/InteractiveData/data_<template>.json`** (pooled MemoryPack): starts with
   the model component (model id, scale) and ends with the [variant table](#the-variant-table),
   keyed by interactive id, whose entries can override the model id.
4. **`Data/Json/GameplayConfig/ModelTable.json`**: maps each model id to a prefab path and
   `scaleFactor`.

level scripts also place interactives: a script's `interactives` dictionary maps slots (`40001`,
`40002`, …) to `LevelInteractiveData` rows with `levelLogicId` 0 and `belongLevelScriptId` naming
the script. they exist while the script runs
([script groups](scene-states.md#what-sets-a-script-group)). thousands of such rows span hundreds of
scripts (racing coins and moving platforms, open-world butterflies, bubble chests, mission beacons,
puzzle pieces).

model resolution rules:

- a placement uses its variant's model, else its template's, unless a
  [graded doodad](scene-states.md#graded-doodads) swaps it for a form.
- a variant with its model override enabled but empty has no model (it does not fall back to the
  template).
- templates without a data file (weapon-wall racks, some doors) or without a model (triggers, logic)
  draw nothing.
- doodad-group shells draw nothing themselves; one form per group level attaches to them
  ([doodad groups](scene-states.md#doodad-groups)).
- templates carry only an id, no display name.

six templates have a model-upgrade component (`InteractiveModelLevelUpComponentData`), listing model
ids in visual-form order including the base model id: `int_system_domain_shop`,
`int_system_domain_depot`, `int_doodad_core_recycle`, `int_system_kite_station`,
`int_system_farm_terminal` (map02_lv002, map02_lv010), and `int_system_simulation_training`
(map02_lv006) ([facility visual forms](scene-states.md#facility-visual-forms)).

### spawning

the server spawns LevelData interactives with their saved state, and the client joins each to its
row by logic id. the client spawns only `autoSpawnedInteractives` (a few dozen logic ids on map02)
and level scripts' own interactives.

| `CreateState` | name               | role (inferred server policy)     |
| ------------- | ------------------ | --------------------------------- |
| −1            | `None`             | —                                 |
| 0             | `EnableAndShow`    | spawned with the level            |
| 1             | `Disable`          | enabled later by server or script |
| 2             | `EnableAndHide`    | enabled later by server or script |
| 3             | `EnableAndPreload` | enabled later by server or script |

no client code reads `createState`. `LevelConfig.levelDataPathHashes` lists a level's LevelData
layers (a few hundred files on map02) with no per-layer condition, so mission-named layers (e.g.
`sub_e12m1`) load with the level and are gated only by `createState` and scripts.

most rows use `createState` 0. roughly a tenth on map01 and map02 use 1 (mostly pickups and
gameplay: ore clusters, chests, collectibles, photo spots, narrative triggers, reading terminals;
scenery includes `int_move_bamboo`, `int_jumpmachine_xirang`, `int_super_pressure_board`,
`int_rope_port__bottom_ver2`, and `int_painting_scroll*` on map02). map02 has a few state-2 rows
(`int_switch_waterdrone_floating_target`).

examples:

- Dijiang's Control Nexus terminal is server-created; its `e1m9` completion condition only locks
  interaction.
- Dijiang's operator summon point (`int_system_spaceship_summon`, near unity −24, 1, −13) has
  `createState` `Disable` and no script, mission, or Lua reference. its map marker
  (`mark_ss_contact_center`) appears only after the server reports `SpaceshipSystem` unlocked.

### the variant table

hundreds of component and action-graph types sit between the model component and the variant table.
only the template's temporary properties and two flags follow it. its keys are every
InteractiveTable id naming this template except the template's own id (true for all shipped
templates). each entry is a 14-member [MemoryPack](containers.md#memorypack) object.

### the LevelData format

LevelData is a sequential [MemoryPack](containers.md#memorypack) payload with no field lengths.
every field must be parsed in order; misreading one misframes all later rows.

## gameplay locks

LevelData's `interactiveLockData` (immediately after the interactive list) stores gameplay locks per
`logicIdGlobal`. each lock has an `InteractiveUnlockType`, mini-game ids, a submit id, and panel
texts. this is separate from the placement's `isLocked` flag.

| `InteractiveUnlockType` | kind        | approximate count across install | swaps model? |
| ----------------------- | ----------- | -------------------------------- | ------------ |
| 1                       | script lock | ~1000                            | no           |
| 2                       | mini-game   | >100                             | yes          |
| 3                       | submit      | a few dozen                      | yes          |
| 4                       | quest       | a few dozen                      | no           |
| 5                       | sludge      | a few dozen                      | no           |

for mini-game and submit locks, the game checks `UnlockEffectConfigMono` on the model root (even if
the component is disabled). when `useDifferentModel` is set, it enables `lockedModel` and disables
`unlockedModel` while locked, and flips them once unlocked. other lock types keep the saved models.
solved locks are saved by the server; a fresh world starts locked.

in map01_lv006's Origin Lodespring, crane controllers (`int_crane_controller_2`) carry a `Broken`
model (sparks and smoke, saved off) and a `Fixed` model (saved on). placement 3500021687 (near 430,
36, 182) has a mini-game lock (`M01L06_B1_easy_1_1`), so it starts broken. placement 3500021688
(near 435, 36, 187) has only a script lock, so it stays fixed.

## highlight overlays

interactive post-models such as `int_switch_union_postmodel` and `int_switch_union_v2_postmodel`
carry `InteractHighlightMono` (`Beyond.Gameplay.View.InteractHighlightMono`), whose
`_highlightObject` (`Highlight`, `HGRP/Factory/UnlitFactoryBuildingPlacement`) and `_outlineObject`
(`Outline`, `HGRP/Factory/UnlitFactoryBuildingOutline`) child subtrees are saved active.
`InteractHighlightMono.Awake` calls `SetIsShow(false)`, which disables both GameObjects on load
regardless of `m_Enabled`; nothing else in the client calls `SetIsShow` (runtime proximity
highlights are instead played as effects by `InteractHighlightComponent`).

## interactive view states

`Data/Json/Interactive/ModelViewStateControllerData/<model id>.json` (MemoryPack, root
`MVSCModelViewStateControllerData`) defines a state machine per animator (`modelName`, `$$ROOT$$`
for the prefab root) and layer.

each state holds:

- an `AnimationClip` (`clipAssetInfos` maps clips to StringPathHashes; Animators without their own
  controller play these clips)
- behaviours: `SetActive` toggles a named GameObject on/off (empty name targets the animator's own
  GameObject, so a `$$ROOT$$` empty toggle hides or shows the whole model); others play effects
  (from the model's `effectIds`), audio, or navmesh changes
- transitions guarded by blackboard conditions

if a `ModelTable` row (or interactive model component) sets `hasModelViewData` and
`dependModelViewDataId`, it has no file of its own and borrows that model's view states. examples:
`int_campfire_smaller` (the full campfire prefab at 0.8 scale, placed by `int_campfire_v2_smaller`
in Dijiang's central hall at 0, 0.9, 57.1), recycling station forms 2–4, long erosion pops 2–4, and
`int_trchest_common_normal` (borrowing `int_trchest_common_low`). all except the campfire borrow
states authored for a different prefab.

evaluation rules:

- a layer starts in its `isStartingNode` state and takes the first transition whose conditions all
  hold (`comparison`: 0 =, 1 >, 2 <, 3 ≥, 4 ≤; `type`: 0 bool, 1 float, 2 int, 3 trigger; `isInvert`
  negates).
- an unconditional transition fires when the state's clip ends.
- a layer rests when no transition holds. later layers on the same animator override earlier ones.

a settled state shows its clip's end pose plus its `SetActive` switches. if the clip loops, it keeps
playing (e.g. the balloon's 14 s idle `A_interactive_balloon+1_001_01_idle_01`, or monitoring
terminal forms 1–4 `int_system_kiteStation_<n>_postmodel` looping
`A_anm_fac_syspoikitestation+1_001_01a`…`01d` in `Initial`; form 0 has no clip). per-placement loop
start phases are unknown. clip internals are in [animation clips](animation.md#animation-clips).

### effects states play

`MVSCEffectBehaviorData` plays `Assets/Beyond/DynamicAssets/Gameplay/Effects/Prefabs/<name>.prefab`
when its state is entered. it attaches to `effectNodeName` (or the animator's GameObject if empty or
missing). it follows that GameObject's position, and its rotation only if `followRot` is set; with
`dontFollowTrans` it spawns once at that position and rotation instead.

lifetime rules:

- **`fireAndForget`**: plays out on its own.
- **`isPersistence`**: toggled on or off (`active`) by each state that names it; outlasts the state
  that started it.
- **other**: replaces any previous instance from the same behaviour; assumed to end when the state
  is left (`EffectPlayBehavior.ForceEnd` isn't read).

at rest, a model plays persistent effects left on plus the effects of its resting states;
non-looping `EffectSetting`s have already finished
([one-shot effects](effects.md#one-shot-effects)). the install has nearly 2000 effect behaviours:
over half target named GameObjects, ~40% are persistent, and a small share are fire-and-forget.

### the `state` key

`InteractiveCommonPerformComponent` forwards the entity's int `state` property to its view states
under key `state` on controller start and on every change. value precedence:

1. template `saveProperties`
2. variant `diffProperties`
3. placement `properties` (thousands of placements set `state` here)
4. server saved value and level scripts

some placements set `state` in component parameters instead; assumed to reach the entity property
(how component parameters map to entity properties isn't read).

jump pads are the commonest case:

- **`int_jumpmachine`** saves `state` 1. at 1, `BaseLayer` plays the 3.3 s opening turn
  (`A_anm_zmdspring+1_001_open_01`) into a looping idle, and `EffectLayer` rests in `On` playing
  `P_common_bouncingplatform_01`. at 0, it rests in a 1-frame closed idle with no effect.
- **`int_jumpmachine_vertical`** and **`int_jumpmachine_electric`** save 0. every jump pad placement
  overrides `state`: vertical and nearly all plain, free, rock, and Xirang pads start at 1; most
  electric pads start at 0. lifters, fans, attack switches, hydrants, and ball receivers also start
  nonzero.
- **jump arrow (`JumpMachineComponent`)**: when not locked (`state` ≠ 0; `is_locked` isn't read) and
  not `free_jump`, places stationary effect `effect` (`P_common_bouncingplatform_arrow_01`) at the
  pad's position. `free_jump` and `effect` are component parameters (template `propertyList` →
  variant `componentDiffProperties` `Comp_JumpMachine` → placement component type 169; the entity's
  `free_jump` property is ignored). `int_jumpmachine_free` sets `free_jump` on, but all its
  placements turn it off; a few `int_jumpmachine` placements and ~1/3 of rock pads keep it on. the
  arrow rotates about Y only, facing the horizontal vector from the pad to `target_position`. most
  placements set a target; the template default (−8.3, 0.6, −0.07) is used as a world position,
  pointing near the world origin.
- **vertical jump pads (`int_jumpmachine_vertical`, `P_interactive_cavewell+1_001_01`)**:
  `JumpMachineVerticalComponent` has no view-state effects or arrow. while `state` is 1 and cooldown
  is done (true at start), it plays hardcoded `P_interactive_cavewell+1_001_01_loop` (two smoke and
  one spark emitter) on the entity root, turning it off otherwise. unverified whether it rotates
  with the entity.

### lengths view states set

`MVSCEffectLengthBehaviorData` sets `VFXAdjustLength` on `nodeName`. the length is the blackboard
float `dependFloatKey` (when `dependBlackBoard` is set; skipped if missing) or `val`, plus
`deviation`. the length persists after the state is left.

setting it applies `ratio = length / presetLength`:

- **scale targets (`useScaleTransform`)**: sets each listed Transform's local scale to `ratio` along
  `axisDir` (0 x, 1 y, 2 z) and 1 on the other axes.
- **tiling (`useTillingOffset`)**: updates each listed renderer's property block `_ST` from its
  material along `tillingDir` (0 u, 1 v): scale multiplies by `ratio` (or `1 / ratio` with
  `revertScale`), and offset becomes `scale · offset · (1 − ratio)`.
- **moved Transforms (`useMoveTransformPositions`)**: sets each listed Transform's world position to
  `TransformPoint(axis · length)` in the `VFXAdjustLength` Transform's frame.
- **particle lifetimes (`useParticleSystemLifeTimes`)**: sets each listed ParticleSystem's
  `startLifetime.constantMax` to `(offsetLength + length) / startSpeed.constantMax`.
- a separate switch (`useMultiRenderersEnable`) handles renderer bounds.

`PositionFollower` copies its `source` Transform's world position every frame while keeping its own
rotation and scale, anchoring objects to a stretched part's end.

### emission view states set

`MVSCEmissiveBehaviorData` applies an `InteractiveEmissiveConfig` (`emissiveConfigHash`, under
`Assets/Beyond/DynamicAssets/Gameplay/Interactives/InteractiveEmissiveConfig/`) to
`AnimationProperties_Emissive` on `emissiveNodeName`. node lookup matches `SetActive`: empty means
the animator's GameObject, else that GameObject if its name matches, else the first matching
descendant. the config persists after leaving the state; `isBlend` fades to it over `blendTime`.

applying it replaces the component's saved fields ([emission](materials.md#emission)):

- `emissiveColor` ← `colorConfig` (required)
- `emissiveAlbedoColor` ← `baseColorConfig` with its alpha, or white at alpha 0 if absent (no tint)
- `breathFrequency` ← `1 / cycleDuration` and `breathIntensity` ← `clamp(cycleIntensity, 0, 1)` when
  `cycleConfig` has `!isConst`, `cycleDuration > 0`, and `cycleIntensity > 0` (else `0, 0`;
  `cycleCurve` is unused, and breathing only takes effect on `_EMISSIVE_ANIM_SWEEP` materials)

Wuling interactives share three configs:

| config                               | `emissiveColor`     | `emissiveAlbedoColor`     | breathing        |
| ------------------------------------ | ------------------- | ------------------------- | ---------------- |
| `IntEmissiveConfig_Available_Wuling` | (16.86, 2.22, 2.66) | (0.47, 0.16, 0.16, a = 1) | 3 s, intensity 1 |
| `IntEmissiveConfig_Disabled_Wuling`  | (1.11, 1.84, 1.59)  | (0.15, 0.25, 0.27, a = 1) | constant         |
| `IntEmissiveConfig_On_Wuling`        | (0, 7.34, 2.70)     | (0, 0.55, 0.24)           | constant         |

- water hydrants (`int_water_hydrant_postmodel`) apply the disabled config to their root in `off`
  and the on config while working.
- xiranite hydrants (`int_xiranite_hydrant_postmodel`) apply the disabled config to their pillar
  (`P_igroup_map02_pool+1_003_02`) in `Idle` and the on config while working. every map02 placement
  sets `state` 0, so they rest locked: `broken` → `locked_Idle` hides the `fixed` pool (pillar
  included), leaving the saved `abandoned` pool (overgrown basin, unlit pillar) plus
  `P_fxint_l_hydrantbase_xirang_lowlight_801`. `state` 1 (`unlocked_Idle`) restores `fixed`.

### vertical rope lifts

a vertical rope lift pairs two `int_rope_port` placements: a top port (`int_rope_port_top_right` or
`_top`) and a bottom port named by the top's `target` property. `InteractiveVerticalRopeComponent`
sets blackboard float `RopeLength` to their vertical distance before view states start.

the top model (`int_rope_port_topright_postmodel`) starts in `start`:

- `state` 0: rests in folded `off_idle`.
- `state` > 0: enters `set_rope`, stretching `P_iprop_com_rope+1_001_02` (preset 0.5 m along y;
  colour and normal maps tiled along v) to `RopeLength + 1.4` m, then rests in `on_idle` (arm swung
  45° out).

the end block (`P_anm_com_machine+1_001_04`) follows `rope_mount_point`, hanging ~1 m above the
bottom port. as saved, the rope is 0.5 m long with the block under the arm. indie_race001's lift
near 88, 116–123, 102 sets `state` 1, starting unrolled.

### lifts

a lift (`int_lifter_v2` and variants) uses `LifterCoreComponent` (type 154) to move a platform
between floors. entity `state` is the floor index, and entity `position_list` (type 12, 3 floats per
floor) gives world positions per floor. an out-of-range `state` only logs an error.

on start and on every floor change:

- root `InteractiveMovingPlatformPostmodelMono` names `MovingPartRoot` (`platform`), optional
  `Pole`, `PoleHeight`, and `PlacformThickness`. `MovingPartRoot` moves to the floor's world
  position.
- if `Pole` is present, its local scale becomes `(1, s, 1)` where
  `s = (floor y − pole y − thickness) / height`, using `pole y` as placed before the platform moves.
  its top meets the platform's underside, shrinking to 0 at a bottom floor one thickness above the
  pole's foot.
- component `doorside_list` (template parameters → placement parameters under type 154; template is
  all 0, both doors open) sets view-state bools `left_opened` (bit 1 clear) and `right_opened` (bit
  0 clear). `moving` is false at rest.

the component toggles no GameObjects. pole-lift models (`int_lifter_v2_postmodel_lv005_only`,
`_pole_only`) keep the cabin (`P_interactive_elevatorcar+1_001_01`) and call-button frame
(`int_lifter_button_postmodel`, shown on `_door_only`) switched off, and their view states
(`MovingLayer` camera shakes only) never toggle them.

the server saves the floor; a fresh world uses the placement's `state`. The Hub's lift 2100010064
(−84, 132.9, −88.2) starts at floor 1 (y 146.9, 14 m up, pole scaled 1.49× of 9 m).

### broken robots

`int_fixable_robot` carries `FixableRobotComponent` (type 97), which passes its component int
parameters `level`, `damage_type`, and `exit_type` (template 0 → placement type 97; not entity
properties) to its view states on start:

- **effect layer (`level`)**: 0 → `damage_type_yellow` (`P_interactive_robotemoji_sos_01` on
  `EmojiEffects`, `P_interactive_robotsos_middle_01` on `HeadEffects`); >0 → `damage_type_red`
  (`P_interactive_robotemoji_sos_02`, `P_interactive_robotsos_large_01`). both play
  `P_fxmap_uninteractive_storehous_01` and `P_lv005_smokeblack_small_01` on `Effect`.
- **base layer (`damage_type`)**: 0 → `damage_type_01`; >0 → `damage_type_02`.
- **`exit_type`**: applies only once fixed (`state` 1).

about half of the install's placements set `level` 1, including map02_lv010's robot 37900200005 at
491, 237, 1231.

### spore mushrooms

`int_spore_mushroom_mint` (`int_spore_mushroom_mint_postmodel`) and `int_spore_mushroom_flame`
(`int_spore_mushroom_flame_postmodel`) in Old Dam (`map02_lv011`) carry `SporeMushroomComponent`. on
`OnStart`, it unconditionally sets view-state bool `Active` to `true`, moving the `effect` layer
from `idle` to `active` and playing the looping sphere aura at `EffectRoot`
(`P_fxint_l_map02_011_mushroom_Mintbuff_001` or `…_Firebuff_001`, after the one-shot `…_appear`).
triggering the bud switches `Active` to `false` for a local cooldown, then back to `true`.

### keys the player sets

- **`Distance`**: `MainCharacterInterestComponent` measures distance from the player to the entity
  on start and every frame, setting `Distance` true while ≤ `main_character_interest_distance`
  (talosites: 15 m). assumed plain 3D distance (helper not read).
- **`InZone`**: an activated campfire sets it while the player is inside its
  `TriggerObserverComponent` sphere (`radius` 2.5 m). once inside, it swaps the trigger radius to a
  second runtime value for leaving.

combat and server keys (`InBattle`, `isDead`) have no offline value.

Dijiang's clue wall (`int_system_spaceship_clue_collection`, −94.2, 5.8, −17.3 in base01_lv001) is
another server-driven key. its `model` layer rests in `InActive` (1-frame closed pose
`A_anm_map01_zmdarm+1_001_closeidle_01`) until bool `Active` holds, then loops a 16 s open idle
(`…_openidle_01`) while `effect` plays `P_fxmap_base01_lv001_ship_cluewall_01` on `vfx_point`.
`SpaceshipClueCollectionSystemComponent` forwards `ESystemState.IsActive` from Dijiang system events
(getter VM-protected). no client data feeds `Active`, so it rests closed offline.

### template animator parameters

a few templates set [Animator](animation.md#scenery-animators) parameters on load via
`SimpleAnimatorComponentData` and an `OnEntityStart` chain of `SetAnimatorBool` actions
(`paramSource`: 0 constant, 200 config property, 300 saved property).

The Hub's comm terminal (`int_001_comm_terminal`, row `2100130029` in
`map01_lv001_lv_data_sub_e1m3`, −26.4, 98, −373.6) is the only one with a saved bool in The Hub. it
sets `seamless` (config, false) and `fixed` (saved, false), then triggers `switchState` (one-shot on
layer 2). `int_001_comm_terminal_controller`'s base layer starts in `error_idle` (red crosses) and
rests in `normal_idle` while `fixed` holds (`seamless` selects a third pair). no client mission,
script, or table sets `fixed`; the server sets it (fixed after the story).

## talosites

talosites (`int_collection_trstar_postmodel`, white; `int_collection_trstar_high_postmodel`, blue;
template `int_collection_trstar`, `TreasureStar` component) are effect prefabs containing three
crystal shards (1-particle mesh emitters), a 2D star icon, billboard glows, a light column, and a
ground glow.

their `FX` layer rests in `IdleLoop` beyond 15 m, plays `InteractStart` → `InteractLoop` within 15 m
(`Distance`), and returns via `InteractEnd`:

- **idle**: dims glows (blue `glow02` to 1/3 `_TintColorAlpha`) and holds shard pivots at 0
  (clustered).
- **near**: brightens glows, spreads shard pivots apart, and scales the star icon 1.8×.

the white model reuses the blue model's clips except for its activation start.

## monster hearts

Feranmut hearts (`int_monster_heart_postmodel`, skinned jade frame with two jade pieces;
`int_monster_heart02_postmodel` in indie_dg007 has identical states) publish `state` as a map
variable ([scene states](scene-states.md)). their `$$ROOT$$` layer `HeartSwitch` settles by `state`:

| `state` | resting state | look                                                                                          |
| ------- | ------------- | --------------------------------------------------------------------------------------------- |
| 0–2     | `Fix_0`–`2`   | 0–2 jade pieces in; loops `A_anm_map02_jade+1_001_01`/`_02` (3 s)                             |
| 3       | `Finsh`       | opened, pieces gone, ink portals `…_inkportal_2102`/`2103` on; loops `…_03_openidle_01` (2 s) |
| 4       | `Dis`         | empty `SetActive` hides the root (nothing shows)                                              |

every loop bobs the frame and pieces 12 cm up and down (all bones translate together). `Dis` can
transition back to any state — it is an off switch, and some indie_dg007 hearts start a fresh world
at 4. no quest, mission, or script sets `state` directly (scripts only play sounds, switch
decorations, and `CallServer`), so the server controls it. map02_lv004's heart (23400083242, at
−1248, 284.1, −1220.3) starts a fresh world at 2.

## campfires

a campfire (`InteractiveCampfireComponent`, model `int_campfire_postmodel_v2`) has two animators and
three layers testing `Enabled` (saved player activation), `InZone`, and `InBattle`:

| layer                                     | not activated        | activated, nobody near | player in it | in a fight  |
| ----------------------------------------- | -------------------- | ---------------------- | ------------ | ----------- |
| model (`P_interactive_campfire+1_003_01`) | `CloseIdle` (folded) | `Open_Idle` (unfolded) | `Open_Idle`  | `Open_Idle` |
| colour (same animator, VAT clips)         | `Empty`              | `Empty`                | `On`         | `Off`       |
| effect (`P_interactive_campfire_effect`)  | `Locking`            | `Working`              | `Using`      | `Stopping`  |

the effect prefab contains one group per look (`moren` locked: red/blue rings, text ring, glow
column; `shouquan`: two turning rings; `yunzhuan`; `duankai`) plus `qiehuan*` transition bursts
(including `HGRP/Effect/VFXRefract` heat-haze cylinders). all groups are saved enabled. `Locking`
leaves only `moren`'s resident effects on; `Working` leaves only `shouquan`'s rings (`lizi` sparks
and `yunzhuan/qiehuan2` are particles).

## interactive doors

doors use `InteractiveDoorCommonComponent` or Dijiang's `SpaceshipRoomDoorSystem`. their view states
include a settled open state (conditional transitions only, clip `…openidle…`). the closed state is
the next settled state reached from open via its single transition plus any unconditional states
(e.g. Dijiang: `built` → `built_to_unlocked` → `unlocked`; Power Plateau gate: `on_idle` →
`on_to_off` → `off_idle`). what opens doors is in [doors](scene-states.md#doors).

## telescopic bridges

`int_telescopic` extends from a wall in segments. its logic controller has `logicType` 8, int
`state` (0 retracted, 1 extended), and config `pieces` (3; no map01 placement overrides it). root
`InteractiveTelescopicPostmodelMono` names the start port, end port, horizontal track, and platform
piece, plus piece length (4 m), width, and thickness. the piece is saved off (its 5.3 m position is
unused); the game draws instanced copies instead.

offsets along the prefab root's +z for `n` pieces of length `L`:

| part       | retracted (`state` 0) | extended (`state` 1)                 |
| ---------- | --------------------- | ------------------------------------ |
| start port | as saved              | as saved                             |
| end port   | (0, 0, 0)             | (0, 0, `n·L`)                        |
| track      | off                   | on, local scale (1, 1, `n`)          |
| copies     | off                   | copy `i` at (0, 0, `i·L`), unrotated |

each copy's Animator plays open idle when extended (raising rails via bones below the piece) and
close idle when retracted. as saved, the prefab puts the end port at 13.35 m with no pieces. state
drivers are in [telescopic bridges](scene-states.md#telescopic-bridges).

## Wuling bridges

`int_bridge_wuling` covers two bridge kinds:

- **drawbridges** (base `int_bridge_wuling_90_postmodel`, variants `_78` and `_102`): an Animator
  raises and lowers a leaf via `closeidle`, `<angle>_open`, `<angle>_openidle`, and `<angle>_close`
  on `int_door_base_layer`, keyed by `state`.
- **magic bridges** (variants `_12m`, `_18m`, `_24m`, `_24m_02`, `_94m`): model override is enabled
  but empty (inferred to prevent loading the template drawbridge; model loader not read).
  `Comp_InteractiveCommonPerform` diff sets `use_dynamic_res` true (and an unread `model_id`
  `int_bridge_wuling_<length>_postmodel`). the bridge itself is a DynamicStreaming prefab row named
  by `dynamic_entity_id`; common-perform drives that row's view controller (`on`/`off` `SetActive`
  on deck copies plus effects; no clips).
- **switches**: `WaterSwitch` (component 98), `CommonSwitchComponent` (component 102, e.g.
  `int_switch_wuling`), and `SwitchCommonNoElectric` (component 175, e.g. `int_switch_common`) list
  the interactives they toggle in component parameter `target_list`. activating the switch requests
  `state` 1 from the server, which updates both the switch (e.g. `int_switch_wltech01_postmodel`
  `closeidle` red → `openidle` green) and its targets (magic bridges, doors, telescopic bridges).

## auto-moving platforms

`int_platform_automove` (`_4m_4m`, `_5m_5m`, `_floatingtower`, …) rides a spline using
`InteractiveAutoMovePlatformComponentData` and `CustomCurveMoveComponentData` (component type 107;
parameters: template → variant `Comp_InteractiveCustomCurveMove` → placement).

- **starting**: moves when entity `state` is 1 (on start and on change); other values pause it.
  template saves 0, so only placements setting `state` 1 move on load. stepping on does not trigger
  motion.
- **spline**: `spline_id` names a LevelData `splines` entry (`LevelSplineData`: `splineId`,
  `position`, Euler `rotation`, `closed`, Unity Splines `BezierKnot`s with local-frame tangents).
  missing spline (template 0) or `speed` ≤ 0 never moves.
- **position**: `rotation · EvaluatePosition(spline, ratio) + position`, replacing placement
  position. rotation stays fixed unless `curve_move_direction` is 1 (aligns to tangent). `ratio` is
  arc distance from knot 0 over total length, giving uniform `speed` m/s along the curve.
  `sync_speed_to_audio` feeds an audio parameter only.
- **speed ramp**: `tween` 0 is uniform. `tween` 1 (named EaseInOutExpo, implemented as linear) ramps
  over `distance` metres at both ends (capped at half the trip each): rises linearly from 0.1 m/s to
  `speed`, then falls linearly towards 0, clamped ≥ 0.1 m/s. each frame samples speed at current
  distance, then advances.
- **trip**: travels from `curve_start_index` to `curve_target_index` (equal indices close the spline
  for a full loop; start > target runs backwards). `curve_move_mode`: 0 stop at target, 1 restart
  from start (dropping overshoot), 2 ping-pong (swapping start and target). `initial_phase` sets the
  starting trip fraction. `curve_start_index_list`, `curve_target_index_list`, and
  `curve_segment_speed` set per-stretch speeds; `use_curve_control_speed` reads a speed curve.
  `knotProgresses` and spline `keyNodeIndexList` aren't read.
- **knots**: every knot is a key node, firing when reached (distance from trip start ≤ distance
  travelled), including start right after launch and target on arrival (so ping-pong fires end knots
  twice). whole-spline trips fire knots from start index onwards (or backwards).
  `curve_move_suppress_start_key_node` skips the start knot on the first trip only. if a fired knot
  appears in `curve_node_index_list`, matching entries in `wait_for_nearby_list` and
  `curve_node_wait_time_list` pause the platform: waiting for nearby pauses until the player
  (formation centre) enters `radius` m; otherwise it pauses for the wait time and resumes the ramp
  (so a 1 s wait at both ends of a ping-pong pauses 2 s per end).

examples:

- **map02 floating towers** (`int_platform_automove_floatingtower`, map02_lv007 near unity −415,
  250, 690): ping-pong on 2-knot splines at 3–4 m/s with 1 m ramps and 1 s waits. 10200030167 and
  10200030408 set `state` 1 and move; 10200030166 sets 1 but waits at its start knot until the
  player is within 2 m; 10200030295 and 10200030247 stay at `state` 0. 10200030295 (−402.6, 256.3,
  696.7) belongs to fire seed altar 10200030288's puzzle (script 10200030031 calls `CallServer` when
  the player enters a 5 × 10 × 5 m box on it), so the server starts it.
- **indie_race001**: all moving platforms belong to level scripts (e.g. script 12800025038 places
  eight 4 m platforms on 144 m loop spline 25012 near unity 80, 122, 92, spaced 1/8 apart at 4 m/s).
  LevelData places 11 more at `state` 0, four without a spline (12800025316–19, near 104, 118, 85).

## bamboo rafts

`int_bambooraft_postmodel` (Wuling City near unity −908, 242, 108) ferries the team along a spline
via `BambooRaftComponent` (logic type 62). root `InteractiveSummonTeamPostmodelMono` references
`WaterAnchor/Head` (`headAnchorRoot`) and `Tail` (`tailAnchorRoot`), each holding a wake: three
water-sheet particle systems and a `P_waterdecal_01` foam box
([water decals](water.md#waterproxy-and-waterdecal)).

both wakes are saved off. every update, the logic switches both off when still or hidden, and
enables only the trailing end while moving, setting foam opacity to `speed / topSpeed`.
`EffectRoot`'s `HeadEffect` and `TailEffect` hold empty anchors only. the wake update caller isn't
traced (assumed to run even when unmounted; saved state at rest is off either way).

## crane towers

a crane puzzle links a tower (`int_crane_tower`, `CraneTowerComponent`, component type 172), its
container (`int_crane_container`, `_2`, `_stackedThree`), and switches (`int_crane_controller_2`,
`target` = tower). component parameters (template → placement type 172) hold `target` (container
logic id) and three step lists indexed by clamped entity properties `state_1`–`state_3` (saved on
use):

| state     | list            | sets                                                       |
| --------- | --------------- | ---------------------------------------------------------- |
| `state_1` | `position_list` | rope length                                                |
| `state_2` | `rotation_list` | arm world yaw (base Transform world rotation)              |
| `state_3` | `euler_angles`  | hook world yaw (header Transform world rotation), separate |

`int_crane_tower_postmodel` has no view states. root `InteractiveCraneTowerPostmodelMono` names
`BasePoint`, `RotatePoint`, `RopeEnd` (under `RopeStart`, 18.07 m up and 22.25 m out along the arm),
`ScaleBase`, and `AttachPoint` (1.71 m below header). rope length `L` sets `ScaleBase` local scale
to `(1, 1, L + 1)` and `RopeEnd` local position to `(0, −L, 0)`; yaws set world rotations about Y.

on its first tick, the tower snaps its container to `AttachPoint`'s world position lowered by the
container's `height` entity property (default 4 m; 4.28 plain, 6.6 `_stackedThree`) and copies
`AttachPoint`'s world rotation, ignoring the container's authored placement. in map01_lv006's Origin
Lodespring (four towers): two containers sit within ~1 m of authored (3500021667 under 3500021670;
3500022098 under 3500022095); tower 3500021909 (near 479, 58, 224) hangs 3500021665 5.5 m higher;
tower 3500021686 (near 420, 59, 192) hangs 3500021691 8.8 m lower, just above the ground.

## laser gates

`int_electric_fence_e` (and variants like `int_electric_fence_elower`, model
`int_electric_fence_4_postmodel`) has no beam geometry in its frame. `ElectricFenceComponent`
(component type 130) plays every effect in root
`InteractiveElectricFencePostModelMono.effectsOnActive` at entity root (no offset) on start and on
`state` change while `state` is 1, recycling them otherwise. the 4 m gate plays
`P_interactive_electricfence_03_Variant` and `…_04_Variant`. the template saves 0; The Hub's
placements set 1 (shut, beams on).

a switch (`int_switch_electric`, component 134) lists its gate in `connected_node_list` and works
only while `has_power` is set by the server's factory power network. power ports
(`map01_lv001_power_port_1_*`, "Electric Nexus", standing at the ends of
`p_imod_tundra_lv001line+1_001_*` cables) are only partly in client data:

- LevelData `predefinedParams` (`*_lv_data_sub_factory`) stores `powerPort.target`
- `FactorySpecialPowerPoleTable` stores name and description
- no client file holds port positions or buildings (`initialBuildings` is empty on open-world maps,
  and The Hub's port targets `2100391045`–`2100391053` and `2100040058` aren't in client LevelData)

the older `int_electric_fence` uses `InteractiveLogicElectricFence`, which recomputes `state` from
its electric node's net power against a threshold before playing the same effect list.

## open

- per-placement start phase of looping view-state clips
- whether `ForceEnd` ends a non-persistent view-state effect with its state (assumed)
- whether `Distance` is a plain 3D distance (assumed) and how `InZone` swaps to its runtime radius
- whether the empty model override alone suppresses the Wuling bridges' template drawbridge
  (inferred)
- how bamboo raft wakes update while moving (assumed)
- where server AIC factory power ports stand (absent from client files)
