# prefabs, dynamic structures and interactives

how `pack` places content that isn't a static chunk renderer: prefab hierarchies, the
[dynamic structures](../game-data/assets.md#fb_main-grids) that place them, and level interactives
with their poses. the controls these placements sit under are in
[scene controls](scene-controls.md); how the rows are filed and stored is in
[how the packer files instances](../extraction.md#how-the-packer-files-instances).

## prefabs

`readPrefabRenderers` ([prefab.ts](../../packages/extractor/src/game/prefabs/prefab.ts)) returns a
prefab's drawable renderers relative to the prefab root; the caller supplies the root's placement.
it follows the hierarchy rules in [prefabs](../game-data/assets.md#prefabs) and walks inactive
subtrees for their Transforms.

### hierarchy walks

every prefab reader walks the hierarchy with `walkPrefab`
([prefab-walk.ts](../../packages/extractor/src/game/prefabs/prefab-walk.ts)). it reads each
GameObject, resolves its components through their exact PPtrs (reading each once, when first asked),
takes its Transform (a UI node's RectTransform), places it in prefab space with the root at the
identity, stops at a cycle, and goes on to the children in authored order, so whatever a reader
hands out in walk order stays stable. a reader is a visitor: `enter` prunes a GameObject or derives
the state its children start from (its path below an Animator, a switched-off ancestor), `local`
replaces the saved local transform (a pose's), and `visit` collects once the matrix is known. the
light, environment volume and Animator default readers prune inactive subtrees; the others walk
them. clip binding paths and posed local transforms are shared in
[pose-paths.ts](../../packages/extractor/src/game/prefabs/pose-paths.ts).

the renderer walk ([renderer-walk.ts](../../packages/extractor/src/game/prefabs/renderer-walk.ts))
decides at each GameObject whether it's switched off, hands each component to the first reader that
accepts it (those acting on other GameObjects, the subtree or the pose: `VFXAdjustLength`, a root
`UnlockEffectConfigMono`, emission overrides, view-state controllers, `EffectSetting`s, Animators),
then once it's placed runs the steps that need its matrix (followers, force fields, distance
origins, billboards) and, when it draws, the candidate sources
([renderer-candidates.ts](../../packages/extractor/src/game/prefabs/renderer-candidates.ts)):
LODGroups, skinned and mesh renderers, the particle system and spline movers, in the order their
renderers are kept. a new component kind is one reader, one step or one source. what depends on the
whole hierarchy being placed, followers and force fields, settles after the walk
([renderer-passes.ts](../../packages/extractor/src/game/prefabs/renderer-passes.ts)); skinned poses
and looping-clip frames are in
[skin-pose.ts](../../packages/extractor/src/game/prefabs/skin-pose.ts) and pose material values in
[material-values.ts](../../packages/extractor/src/game/prefabs/material-values.ts).

### what the renderers carry

- **LODGroups**: under an enabled `LODGroup`, each LOD's renderers, matched by object identity,
  never by name, carry the span of screen-relative heights they show at (a renderer in consecutive
  LODs gets one span), and the packer makes those the chain's thresholds; distance bands win on a
  renderer that has both.
- **skinned renderers**: bounds are the union of the mesh bounds under every bone, so weighted
  vertices stay inside. a renderer is drawn in its authored pose
  ([skin pose](../extraction.md#asset-classes)) unless a looping clip moves its bones
  ([looping clips](#looping-clips)).
- **locked looks**: a root `UnlockEffectConfigMono` that swaps models draws its locked model for a
  placement with a mini-game or submit lock and its unlocked model otherwise
  ([gameplay locks](../game-data/interactives.md#gameplay-locks)); whichever model the lock leaves
  off is left out rather than standing in. the lock types come from LevelData's
  `interactiveLockData` ([level-locks.ts](../../packages/formats/src/endfield/level-locks.ts)),
  decoded whole, so a level whose LevelData the MemoryPack schema can't decode (Dijiang's) reports
  `gameplay locks` in `unsupported-interactives.json` and its placements count as unlocked.
- **emission overrides**: an enabled `AnimationProperties_Emissive` on an active GameObject folds
  its colour into `_EmissiveColor` of the renderers it lists, as the shader mixes it
  ([emission](../game-data/materials.md#emission);
  [emissive-override.ts](../../packages/extractor/src/game/prefabs/emissive-override.ts)); those
  renderers get a material variant, like a pose's material values. an emissive config the pose's
  settled view states leave on the component
  ([emission view states set](../game-data/interactives.md#emission-view-states-set)) replaces the
  saved colour: `settledPose` reads the configs each layer's path applies, last one winning. its
  breathing and albedo tint aren't read.
- **resolution**: the packer resolves a prefab from its StringPathHash key, which must name exactly
  one manifest path.
- **what else a prefab holds**: its environment volumes
  ([prefab-environment.ts](../../packages/extractor/src/game/prefabs/prefab-environment.ts),
  [prefab volumes](environments.md#prefab-volumes)) and lights
  ([lights](../package-format.md#lights)) are read separately. particle system renderers become
  particle draws ([particles](../package-format.md#particles)), and renderers under a billboard
  become billboard chains ([chains](../package-format.md#binary-encodings)).

## dynamic structures

the [fb_main grids](../game-data/assets.md#fb_main-grids) reader
([dynamic-scene.ts](../../packages/formats/src/endfield/dynamic-scene.ts),
[dynamic-resources.ts](../../packages/formats/src/endfield/dynamic-resources.ts)) validates every
slice and throws on a layout change (e.g. a resource slice not typed as resource groups) instead of
truncating. it checks an effect row's repeated position (+116) to confirm the stride, and
`parseDynamicChunk` reads ECS rows' `fb_init`/`fb_streaming` pairs with the InitChunkData group
decoder.

for a model or effect row ([payloads](../game-data/assets.md#payloads)), the packer resolves the
prefab, reads its renderers and places each one under the row's TRS. prefab renderers, prefab lights
and stand-ins have no game entity id, so the packer gives each a synthetic one: the level tag over
an index counted down from the top of the 27-bit id space, away from the game's ids.

`loadDynamicStructures`
([dynamic-structures.ts](../../packages/extractor/src/game/dynamic/dynamic-structures.ts)):

- deduplicates models and ECS entities by their stored reference, merging the visibility
  alternatives of every group that shows them
- gives each structure the level tag of its resource group's `levelNum`
- keeps the static copy of an ECS entity already present in static chunks, and keeps the local
  lights of the selected ECS groups the same way ([lights](../package-format.md#lights))
- takes a rect decal's material from the chunk's `fb_streaming` payload; it draws the decal cube as
  static ones do
- turns an entity with a spin component (column 54,
  [spinning scenery](../game-data/animation.md#spinning-scenery); static or dynamic) into a spinning
  row of its block, growing its tile and level bounds by the cylinder its box sweeps (`sweptBounds`
  in [bounds.ts](../../packages/extractor/src/pack/instances/bounds.ts)) so a turned row never
  leaves them

## interactives

code: [level-interactives.ts](../../packages/formats/src/endfield/level-interactives.ts),
[interactive-model.ts](../../packages/formats/src/endfield/interactive-model.ts),
[animation-clip.ts](../../packages/formats/src/unity/animation-clip.ts),
[interactive-facilities.ts](../../packages/extractor/src/game/interactives/interactive-facilities.ts),
[view-state-poses.ts](../../packages/extractor/src/game/interactives/view-state-poses.ts),
[animator-defaults.ts](../../packages/extractor/src/game/prefabs/animator-defaults.ts),
[door-poses.ts](../../packages/extractor/src/game/interactives/door-poses.ts),
[telescopic-bridge.ts](../../packages/extractor/src/game/interactives/telescopic-bridge.ts),
[prefab.ts](../../packages/extractor/src/game/prefabs/prefab.ts).

`loadInteractiveFacilities` runs fixed steps: it reads the placed rows, reads and decodes each
placed template file once for its models (`template-models.ts`) and its traits
(`template-traits.ts`), reads doodad shells, then hands each single-model template's traits to every
kind's `prepare`, in first-placement order. after the region walls' unlock table and the crane
towers' poses, each row is drawn by the first kind whose `place` claims it (bridges, doors, rest
looks (lifts among them), animator starts, region walls, crane towers), else as its plain model with
any doodad forms, else as facility forms. every model goes through the row's `InteractiveRow`
(`interactive-row.ts`), which adds its switches, blight core, model scale, ride, crane hang and
lock; resting effects are placed last. a new kind of interactive is one module implementing
`InteractiveKind`, a trait it's detected by, and a place in that list. the order is the order
models, controls and diagnostics come out in, which ids follow.

### templates and models

`readLevelInteractives` decodes LevelData's sequential prefix through the interactive list
([interactives](../game-data/interactives.md)); `readInteractiveTable` reads
`InteractiveTable.json`; `readInteractiveBaseModel` reads a template's model component and
`readInteractiveVariantModels` its variant table. a placement draws its variant's model, else the
template's. a variant whose override is enabled but empty draws nothing, so the magic
[Wuling bridges](../game-data/interactives.md#wuling-bridges) show only their DynamicStreaming row,
not the template's drawbridge too. a doodad-group shell places one form per group level instead
([doodad groups](scene-controls.md#doodad-groups)).

hundreds of component and action-graph types sit between the model component and the variant table,
so the reader locates the [variant table](../game-data/interactives.md#the-variant-table) from the
end of the file: a position frames the table when the parse ends exactly at the end of the file and
its keys are exactly the InteractiveTable ids that name this template (other than the template's own
id).

every placed template is decoded whole, through the
[MemoryPack schema](../extraction.md#memorypack-data), for a model-upgrade component. a template
that has one places one model per visual form, each under its form's bit of a per-facility control
([facility visual forms](scene-controls.md#facility-visual-forms)). the known facilities get our own
English labels; others are labelled by template id. a model-upgrade component the reader can't use
is reported in `unsupported-interactives.json`, and the template draws its base model.

### view-state poses

view states are read from the model's own file, or from the model its `ModelTable` row names in
`dependModelViewDataId`
([interactive view states](../game-data/interactives.md#interactive-view-states)), for doors, rest
looks and facility forms alike.

an interactive whose model has view states is drawn in its settled pose: every animator layer
settled with its keys false, except `state`, which holds the placement's starting
[`state`](../game-data/interactives.md#the-state-key) when its template has a common-perform
component (a model is settled once per starting value its placements use). a pose holds one clip end
pose per animator, each with its GameObject switches, the material values it sets on renderers and
their particle pivots. `readPrefabRenderers` takes the pose, sets the bound local transforms and
switches while walking the hierarchy, so skinned parts follow their bones. inside a clip that
switches GameObjects, a node saved off and left alone by the clip draws nothing rather than a
stand-in. clips name material properties by a hash, resolved against the saved property names of the
renderer's materials (a property the material doesn't save is dropped); a renderer whose materials
take posed values draws a [posed copy](../package-format.md#materials) of its material. a switch
with an empty name applies to its animator's GameObject; a pose whose root animator switches the
root off is `hidden`, and its placement places no renderers, lights or effects. each facility visual
form with view states is posed the same way, under its own model id, with every key false (a
facility's player-set keys aren't read). doodad-group shells aren't posed.

a pose also carries the [lengths](../game-data/interactives.md#lengths-view-states-set) its layers'
length behaviours leave set, along every layer's path rather than only its resting state. a vertical
rope's top port is settled per placement with `RopeLength` from its `target` port, and a
[broken robot](../game-data/interactives.md#broken-robots) with its component's `level`,
`damage_type` and `exit_type`. while walking, a GameObject whose `VFXAdjustLength` gets a length
scales its targets' local scale (before the Transform's clips apply) and its renderers' posed
materials carry the stretched texture scale and offset. a component that also switches renderer
bounds, particle lifetimes or moved Transforms fails the prefab, which then stands in as a box.
`PositionFollower`s are moved once the whole hierarchy is placed, together with their subtrees,
since the source can come later in the walk.

poses with their own controls:

- **doors**: an interactive is a door when its template has a door component and its model's states
  include exactly one settled state whose clip is an open idle
  ([interactive doors](../game-data/interactives.md#interactive-doors)); other models aren't treated
  as doors. the placement is emitted once per pose (the state's clip end pose plus its `SetActive`
  switches) under a [door control](scene-controls.md#doors).
- **campfires**: a template with a campfire component is drawn with `Enabled` false and true, under
  a per-campfire `activation:<id>` control (0 not activated; 1 activated, the default), listed with
  the progressions.
- **proximity**: a template whose components drive a
  [player-set key](../game-data/interactives.md#keys-the-player-sets) (`Distance`, `InZone`) is
  settled once more with those keys true. where that changes a settled state, the two poses sit
  under a `proximity:<id>` control (0 away, 1 near) with the key's radius (the largest, if several),
  which a viewer sets from the camera ([proximity](../package-format.md#proximity)).
- **telescopic bridges**: a template whose logic controller is a
  [telescopic bridge](../game-data/interactives.md#telescopic-bridges) is drawn through the same
  poses, all with the prefab root as the Animator: retracted (the end port moved back, track and
  piece switched off), extended (the end port moved out, the track scaled), and one more placement
  of the whole prefab per piece that switches everything but the piece off, moves it to its slot and
  applies its open-idle clip. that clip binds below the piece's own Animator, so its paths are
  re-keyed to paths below the root ([bridges](scene-controls.md#bridges)).

### effects at rest

a rest look (not a door, bridge or facility form) also places the effects its states leave playing
([effects states play](../game-data/interactives.md#effects-states-play)): `settledPath` follows
each layer from its starting state, and `restingEffects` keeps the persistent effects switched on
along the way plus the resting state's other effects, skipping fire-and-forget ones. each effect's
prefab is placed as a model of its own under the look's visibility, unless its `EffectSetting`s
don't loop (`isOneShotEffect`) or the manifest lacks it (reported in
`unsupported-interactives.json`). its GameObject's matrix comes from `prefabNodeMatrices`, which
walks the model in the look's pose (clip end poses, so a looping clip's motion isn't followed); an
effect that doesn't turn with its GameObject keeps the world's axes but the GameObject's scale.

a jump pad's arrow ([the `state` key](../game-data/interactives.md#the-state-key)) is placed the
same way, at the pad's position with its yaw towards the target and unit scale, under the pad's own
visibility only. a vertical jump pad that starts on places its vent effect the same way, with the
placement's position, rotation and scale but not its model scale, and so does a
[laser gate](../game-data/interactives.md#laser-gates) that starts on, for each name in its model
root's `effectsOnActive` (`ElectricFences`).

### looping clips

a settled state whose clip loops keeps playing it
([playing a clip](../game-data/interactives.md#interactive-view-states)): its pose clip carries the
curves (`readClipMotion`), and the walk records every Transform so `poseFrames` can pose the
hierarchy again at each of the clip's frames (its duration times its sample rate), the pose's other
clips holding their end poses.

- a skinned renderer whose bones move between those frames gets a `motion`: its bones' skinning
  matrices (prefab-space bone matrix × bind pose) per frame, with bounds over every frame. the
  packer interns it as an animated geometry, which keeps the mesh in its bind space with its
  weights, bone indices and frames ([geometry blob](../package-format.md#geometry-blob-mesh-efgm)),
  rather than baking the end pose.
- a mesh renderer (not billboarded) whose own Transform moves between those frames gets a `rigid`
  motion the same way, its Transform as the one bone with an identity bind pose: conversion gives
  every vertex bone 0 at full weight (`rigidSkin`) and never reads the mesh's own bone weights.
- a clip the sampler can't read holds its end pose.

the balloon's tube (`int_balloon_postmodel`) and the regional upgrade terminal's robot
(`int_system_fac_region_upgrade_postmodel`) play skinned; Qingbo Stockade's octagonal waterwheels
([scenery animators](../game-data/animation.md#scenery-animators)) play rigidly, most of their mesh
renderers moving, over more than a thousand frames each.

### scenery animators

a prefab drawn without a view-state pose (every model placement but posed interactives) is drawn in
what its own Animators play ([scenery animators](../game-data/animation.md#scenery-animators)).
`animatorDefaultPose` walks the hierarchy's active GameObjects for enabled Animators with a plain
AnimatorController and takes, per showing layer, the single clip of the state the layer settles in
under the controller's saved parameters, as a pose clip like a view state's: its end pose, or its
motion at the state's speed when it loops. layers that blend, blend-tree states, transitions into
sub-machines and override controllers are left out.

an interactive whose template sets Animator bools on load
([template animator parameters](../game-data/interactives.md#template-animator-parameters)) is posed
by `animatorPose` with those values on every Animator in the prefab (which Animators the game's
component reaches isn't checked). one bool read from a saved property places the model once per
value under an `activation:<row id>` control, set by default, as in a finished save.

a dynamic structure's model whose group a level script sets
[decoration animator](../game-data/animation.md#decoration-animators) values on as it starts is
posed by `animatorPose` with those values instead
([decoration-animators.ts](../../packages/extractor/src/game/dynamic/decoration-animators.ts)).
`decorationAnimatorStarts` follows each of the scene's own scripts from its
`ScriptEvent_OnScriptActive` headers through `nextID`, branch lists and if/else nodes on a saved
property, and keeps a group's `SetDecorationAnimatorInt`/`Bool` values when they're constant or
split on one saved property; a group set past another condition, by two scripts, or with two values
on one path is left as saved (`decorationAnimatorGroupsUntraced`). values set by other events and
`PlayDecorationAnimation` aren't read. a split places the model once per value under an
`activation:<script>:<property>` control, set by default as in a finished save.
`collectPlacementSources` poses them once the level scripts are read, since those load with the
interactives after the dynamic structures; models already posed by view states and effect rows keep
their look.

### ACL clips

`readClipMotion` plays an [ACL-compressed clip](../game-data/animation.md#acl-compressed-clips)
through [acl.ts](../../packages/formats/src/unity/acl.ts), a TypeScript port of ACL 2.1's
transform-track decompression (MIT; its notice is in the file) for the formats the game uses: full
or w-dropping rotations, full or variable vectors, any number of segments, stripped keyframes. it
decodes every stored sample, rebuilding w and range-reducing in float32 as ACL does (near w = 0 the
rounding decides w), and interpolates stripped samples as ACL plays them; on Wuling City's spinning
cube it agrees with upstream ACL's decompressor to about 1e-5 in translations and 1e-4 in rotations.
the clip then samples between frames like the dense block, wrapping when the buffer does, with
tracks mapped to bindings through the sub-track masks and constant bindings held at their listed
values.

### moving platforms

an [auto-moving platform](../game-data/interactives.md#auto-moving-platforms)
([curve-move.ts](../../packages/extractor/src/game/interactives/curve-move.ts)) whose starting
`state` is 1 and whose `spline_id` names a spline rides it. its level's LevelData files are decoded
whole through the [MemoryPack schema](../extraction.md#memorypack-data) for their splines
(`readLevelSplines`, [level-splines.ts](../../packages/formats/src/endfield/level-splines.ts)), once
per level that has such a platform. `curvePath` builds the spline's Bézier curves in world space and
measures them with a 30-sample arc-length table per curve. it then simulates one loop (one trip, or
there and back) in 1/240 s steps, with the trip's speed ramp and its knot waits, and samples it at
15 frames per second from where the initial phase puts the platform; the loop's length is within a
step per trip of the game's. a knot that waits for the player ends the simulation and parks the
platform there (a two-frame still path). each frame is the prefab root's translation in the
placement's space, the pose's `path`; `poseFrames` poses the hierarchy on those frames, so every
mesh renderer gets a `rigid` motion and skinned ones a `skinned` one, as for
[looping clips](#looping-clips). a platform that turns along the curve, varies its speed by segment
or curve, or stops at its target (mode 0) is reported in `unsupported-interactives.json` and stays
at its placement.

### crane towers

a [crane tower](../game-data/interactives.md#crane-towers)
([crane-tower.ts](../../packages/extractor/src/game/interactives/crane-tower.ts)) is posed from its
starting steps before the placements are drawn. `craneTowerOf` merges the tower component's
parameters with the placement's own (component type 172), the `state_*` entity properties pick the
steps, and `readCraneLook` walks the prefab for the postmodel MonoBehaviour's five Transforms. the
pose is one clip on the prefab root: the rope's scale Transform, the rope end's position, and the
base and hook rotations, each world yaw turned into a local rotation under its parent's posed world
rotation. the same walk gives the attach point's world position and rotation; the tower's `target`
container is drawn there, lowered by its `height`, instead of at its own placement. a tower whose
step list is empty or whose prefab lacks the MonoBehaviour is reported in
`unsupported-interactives.json` and drawn as saved; one whose container isn't placed is posed and
reported.

### lifts

a [lift](../game-data/interactives.md#lifts)
([lifters.ts](../../packages/extractor/src/game/interactives/lifters.ts)) is a rest look whose
template has the lift core component. `lifterStart` reads its floor and the floor's position, and
the door bools, which settle its view states with the other numbers; `readLifterLook` adds one clip
on the prefab root that moves the moving part to the floor (the world position taken into its
parent's saved space) and scales the pole. when no view state of the model switches a GameObject,
the pose is `closed`: the walk draws nothing, not stand-ins, for what's switched off as saved. a
floor missing from `position_list`, or a prefab without the MonoBehaviour, is reported in
`unsupported-interactives.json` and drawn as saved.
