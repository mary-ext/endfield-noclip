# prefabs, dynamic structures and interactives

how `pack` places non-chunk geometry: prefab hierarchies,
[dynamic structures](../game-data/assets.md#fb_main-grids), and level interactives with their poses.
see [scene controls](scene-controls.md) for their controls and
[how the packer files instances](../extraction.md#how-the-packer-files-instances) for instance
storage.

## prefabs

prefabs are walked in authored child order (stopping on cycles) with the root at identity, following
[prefab rules](../game-data/assets.md#prefabs). light, environment-volume, and Animator-default
passes prune inactive subtrees; renderer collection walks inactive subtrees to collect their
Transforms. cross-node passes (followers, force fields) settle after the full hierarchy is placed.

- **LODGroups**: under an enabled `LODGroup`, each LOD's renderers (matched by object identity,
  never name) get the screen-relative height span they show at (consecutive LODs merge into one
  span). distance bands override LODGroup thresholds when both exist.
- **skinned renderers**: bounds are the union of mesh bounds across all bones. renderers bake to
  their authored pose ([skin pose](../extraction.md#asset-classes)) unless a
  [looping clip](#looping-clips) animates their bones. optimized skeletons
  (`Animator.m_HasTransformHierarchy == false`, empty `m_Bones`) expand from the enclosing
  Animator's `Avatar` skeleton (`m_AvatarSkeleton` + `m_DefaultPose` / `m_AvatarSkeletonPose`) and
  match `Mesh.m_BoneNameHashes`, so static poses and looping clips run through the same path.
- **decal projectors**: draw the shared decal cube inside the GameObject's box; they skip clip,
  skin, and billboard paths and stay at their saved placement.
- **line renderers**: enabled local-space `LineRenderer`s bake collinear segment runs into synthetic
  ribbon meshes carrying `widthCurve` widths, linearised `colorGradient` vertex colours, and
  `textureMode` UVs. view-aligned lines (`alignment == 0`) use `ChainFlags.BillboardAxial` to turn
  about their segment axis; `TransformZ` lines stay in their GameObject's XY plane. world-space
  lines are skipped.
- **locked looks**: a root `UnlockEffectConfigMono` that swaps models draws its locked model for
  placements with a mini-game or submit lock, and its unlocked model otherwise
  ([gameplay locks](../game-data/interactives.md#gameplay-locks)); the inactive model is omitted,
  not a stand-in. lock types come from LevelData's `interactiveLockData`, decoded whole. if a
  level's LevelData fails MemoryPack decoding (Dijiang), it reports `gameplay locks` in
  `unsupported-interactives.json` and treats placements as unlocked.
- **raft wakes**: the two wake subtrees named by a root `InteractiveSummonTeamPostmodelMono` only
  show while moving ([bamboo rafts](../game-data/interactives.md#bamboo-rafts)) and are omitted (not
  stand-ins).
- **highlight overlays**: `_highlightObject` and `_outlineObject` named by an
  `InteractHighlightMono` on an active GameObject are switched off in `Awake`
  ([highlight overlays](../game-data/interactives.md#highlight-overlays)) and are omitted (not
  stand-ins).
- **emission overrides**: an enabled `AnimationProperties_Emissive` on an active GameObject passes
  non-zero-alpha colours and breathing to listed renderers
  ([emission](../game-data/materials.md#emission)), creating a material variant. emissive configs
  set by settled view states
  ([emission view states set](../game-data/interactives.md#emission-view-states-set)) override saved
  values (last config along each layer's path wins).
- **resolution**: prefabs resolve from their StringPathHash key, which must match exactly one
  manifest path.
- **other prefab contents**: environment volumes ([prefab volumes](environments.md#prefab-volumes))
  and lights ([lights](../package-format.md#lights)) are read separately. particle systems become
  particle draws ([particles](../package-format.md#particles)); billboarded renderers become
  billboard chains ([chains](../package-format.md#binary-encodings)).

## dynamic structures

the [fb_main grids](../game-data/assets.md#fb_main-grids) reader validates every slice and throws on
layout mismatches instead of truncating, checks effect rows' repeated position (+116) to confirm
stride, and decodes ECS `fb_init`/`fb_streaming` pairs with the InitChunkData group decoder.

for each model or effect row ([payloads](../game-data/assets.md#payloads)), the packer resolves the
prefab and places its renderers under the row's TRS. prefab renderers, prefab lights, and stand-ins
lack game entity ids, so each gets a synthetic id: the level tag over an index counting down from
the top of the 27-bit id space.

- models and ECS entities deduplicate by stored reference, unioning visibility alternatives across
  all groups that show them
- `ResourceComp.LodInfo` (`LodGridResource`) chains swap between LOD 0 (near prefab or detailed ECS)
  and coarser far-distance stand-ins (ECS static mesh or `farmod`); the extractor keeps only the
  finest present LOD so they don't draw on top of each other
- each structure gets its resource group's `levelNum` level tag
- static chunks win when an ECS entity already exists in static chunks; local lights of selected ECS
  groups keep the same rule ([lights](../package-format.md#lights))
- rect decal materials read from `fb_streaming` and draw the shared decal cube
- entities with a spin component (column 54,
  [spinning scenery](../game-data/animation.md#spinning-scenery); static or dynamic) become spinning
  rows, expanding tile/level bounds by the swept cylinder

## interactives

interactive rows are claimed in fixed precedence: bridges → doors → rest looks (incl. lifts) →
animator starts → region walls → crane towers, falling back to
[graded doodad forms](scene-controls.md#graded-doodads),
[doodad-group forms](scene-controls.md#doodad-groups), plain models, or facility forms. switches,
blight core, model scale, ride, crane hang, and lock apply to emitted models; resting effects place
last.

### templates and models

- placed rows come from LevelData's sequential prefix ([interactives](../game-data/interactives.md))
  and `InteractiveTable.json`.
- a placement uses its variant model if present, else the template model. an enabled but empty
  variant override draws nothing (e.g. magic
  [Wuling bridges](../game-data/interactives.md#wuling-bridges) show only their DynamicStreaming
  row, not the template drawbridge). a doodad-group shell places one form per group level
  ([doodad groups](scene-controls.md#doodad-groups)).
- because hundreds of component/action-graph types sit before the
  [variant table](../game-data/interactives.md#the-variant-table), the reader locates it from EOF: a
  candidate offset matches when parsing reaches exact EOF and its keys match all InteractiveTable
  ids naming that template (excluding the template's own id).
- every placed template is also decoded whole via [MemoryPack](../extraction.md#memorypack-data) to
  detect model-upgrade components. templates with one emit one model per visual form under a
  per-facility control ([facility visual forms](scene-controls.md#facility-visual-forms)). known
  facilities get English labels; others use the template id. unusable model-upgrade components log
  to `unsupported-interactives.json` and fall back to the base model.

### view-state poses

view states come from the model's own file or its `ModelTable` row's `dependModelViewDataId`
([interactive view states](../game-data/interactives.md#interactive-view-states)), for doors, rest
looks, and facility forms alike.

an interactive with view states settles every animator layer with all keys false, except `state`
(set to the placement's starting [`state`](../game-data/interactives.md#the-state-key) when the
template has a common-perform component) and `Active` (set true for
[spore mushrooms](../game-data/interactives.md#spore-mushrooms)). each pose holds one clip end pose
per animator: local transforms, GameObject switches, renderer material values, and particle pivots.

- transforms and switches apply during the prefab walk so skinned meshes follow their bones.
- inside a clip that switches GameObjects, nodes saved off and untouched by the clip draw nothing
  (not stand-ins).
- clip material hashes resolve against each material's saved property names (unsaved properties are
  dropped) and produce a [posed copy](../package-format.md#materials).
- an empty switch name targets the animator's own GameObject. if the root animator switches the root
  off, the pose is `hidden` and emits no renderers, lights, or effects.
- facility visual forms pose under their own model id with all keys false (player-set keys aren't
  read). doodad-group shells aren't posed.

**lengths and followers**: poses also carry
[lengths](../game-data/interactives.md#lengths-view-states-set) set along every layer's path (not
just its resting state). vertical ropes settle per placement with `RopeLength` from `target`;
[broken robots](../game-data/interactives.md#broken-robots) settle with `level`, `damage_type`, and
`exit_type`. during the walk, `VFXAdjustLength` scales target local scales (before clip transforms),
stretches renderer material texture scale/offset, scales target particle systems'
`startLifetime.constantMax`, and moves target Transforms with their subtrees after the walk finishes
(before `PositionFollower`s). a `VFXAdjustLength` that also modifies renderer bounds fails the
prefab (becomes a stand-in box). `PositionFollower`s move with their subtrees after the walk
finishes so forward references resolve.

**controlled poses**:

- **doors**: template has a door component and model has exactly one settled open-idle clip
  ([interactive doors](../game-data/interactives.md#interactive-doors)). emitted once per pose (clip
  end pose + `SetActive` switches) under a [door control](scene-controls.md#doors).
- **campfires**: template has a campfire component; emitted with `Enabled` false and true under
  `activation:<id>` (0 off, 1 on default), grouped with progressions.
- **proximity**: template drives a
  [player-set key](../game-data/interactives.md#keys-the-player-sets) (`Distance`, `InZone`);
  settled again with those keys true. if any settled state changes, both poses emit under
  `proximity:<id>` (0 away, 1 near) with the largest radius, driven by camera position
  ([proximity](../package-format.md#proximity)).
- **telescopic bridges**: template has a
  [telescopic bridge](../game-data/interactives.md#telescopic-bridges) controller; posed with the
  prefab root as Animator: retracted (end port moved back, track/piece off), extended (end port
  moved out, track scaled), plus one placement per piece (everything else off, moved to its slot,
  open-idle clip re-keyed from piece Animator to root; [bridges](scene-controls.md#bridges)).

### effects at rest

rest looks (not doors, bridges, or facility forms) also place persistent effects left playing by
their states ([effects states play](../game-data/interactives.md#effects-states-play)). tracing each
layer from start keeps persistent effects enabled along the way plus the resting state's other
effects, skipping fire-and-forget ones.

each effect prefab places under the look's visibility unless its `EffectSetting`s don't loop or it
is missing from the manifest (logged in `unsupported-interactives.json`). node matrices come from
the clip end pose (ignoring looping-clip motion); effects that don't rotate with their GameObject
keep world axes with the GameObject's scale.

also placed this way:

- **jump pad arrows** ([the `state` key](../game-data/interactives.md#the-state-key)): at pad
  position, yawed toward target, unit scale, under pad visibility only.
- **vertical jump pad vents** (when starting on): placement position/rotation/scale (without model
  scale).
- **laser gates** ([laser gates](../game-data/interactives.md#laser-gates), when starting on): each
  name in model root's `effectsOnActive` (`ElectricFences`), using placement transform without model
  scale.

## animation and poses

### looping clips

a settled state whose clip loops keeps playing
([playing a clip](../game-data/interactives.md#interactive-view-states)), re-posing the recorded
hierarchy at each frame (`duration × sampleRate`) while other clips hold their end poses:

- **skinned renderers**: if bones move across frames, emits an animated geometry (prefab-space bone
  matrix × bind pose per frame, bounds unioned over all frames) keeping bind-space vertices,
  weights, bone indices, and frames ([geometry blob](../package-format.md#geometry-blob-mesh-efgm)).
- **mesh renderers (non-billboarded)**: if Transform moves, emits a rigid motion with the Transform
  as bone 0 (identity bind pose; every vertex binds to bone 0 at weight 1, ignoring any mesh bone
  weights).
- **animated material floats**: sampled per frame; conversion runs the material describer per frame
  and keeps changing numbers as `motion` tracks (e.g. soft-body frame, tint alpha, dissolve
  threshold). structural surface changes across frames drop the motion and record the gap
  `material values a looping clip plays`. vector/colour components, ACL clip material curves, and
  looping clips after a renderer's first hold their end values.
- **particle systems**: placed at end pose with per-frame emitter offsets, capped at 30 fps
  ([particles](../package-format.md#particles)).
- unreadable clips hold their end pose.

examples: `int_balloon_postmodel` (balloon tube) and `int_system_fac_region_upgrade_postmodel`
(upgrade terminal robot) animate skinned; Qingbo Stockade's octagonal waterwheels
([scenery animators](../game-data/animation.md#scenery-animators)) animate rigidly over >1000 frames
each.

### scenery animators

prefabs without a view-state pose play what their own Animators settle into
([scenery animators](../game-data/animation.md#scenery-animators)):

- **default pose**: walks active GameObjects for enabled Animators with plain AnimatorControllers
  and takes each showing layer's settled state clip under saved parameters (end pose, or looping
  motion at state speed). skips blended layers, blend trees, sub-machine transitions, and override
  controllers.
- **template animator bools**
  ([template animator parameters](../game-data/interactives.md#template-animator-parameters)):
  applies template-set bools to every Animator in the prefab (unverified which Animators the game
  targets). a bool read from a saved property emits one placement per value under
  `activation:<row id>` (default set, matching a finished save).
- **decoration animators** ([decoration animators](../game-data/animation.md#decoration-animators)):
  traces each scene script from `ScriptEvent_OnScriptActive` through `nextID`, branch lists, and
  saved-property if/else nodes, keeping constant or single-property-split
  `SetDecorationAnimatorInt`/`Bool` values. groups set past other conditions, by multiple scripts,
  or with multiple values on one path stay as saved (`decorationAnimatorGroupsUntraced`). other
  events and `PlayDecorationAnimation` aren't read. split groups emit one placement per value under
  `activation:<script>:<property>` (default set). view-state-posed models and effect rows keep their
  look.

### ACL clips

[ACL-compressed clips](../game-data/animation.md#acl-compressed-clips) decode via a TypeScript port
of ACL 2.1 transform-track decompression (MIT), supporting full/w-dropping rotations, full/variable
vectors, multi-segment clips, and stripped keyframes. it decodes all stored samples with float32
w-rebuild and range reduction (near `w = 0`, rounding picks `w`), interpolates stripped samples, and
agrees with upstream ACL to ~`1e-5` translation and ~`1e-4` rotation on Wuling City's spinning cube.
sampling between frames matches the dense block (wrapping when the buffer wraps), mapping tracks via
sub-track masks and holding constant bindings fixed.

## special interactives

### moving platforms

[auto-moving platforms](../game-data/interactives.md#auto-moving-platforms) with starting
`state === 1` and a valid `spline_id` ride their spline:

1. decode the level's LevelData whole via [MemoryPack](../extraction.md#memorypack-data) once per
   level to read splines.
2. build world-space Bézier curves with a 30-sample arc-length table per curve, simulate one loop
   (one-way or round-trip) in `1/240` s steps with speed ramps and knot waits, and sample at 15 fps
   from the initial phase (loop length within one step per trip of the game). a knot waiting for the
   player stops simulation and parks the platform (1-frame path).
3. store each frame's world-axis offset from placement as a block
   [ride](../package-format.md#instance-block-inst-efin). the prefab still runs its own Animators
   and view states, and [resting effects](#effects-at-rest) inherit the ride; lights stay at the
   placement.

platforms that rotate along the curve, vary speed by segment/curve, or stop at target (mode 0) log
to `unsupported-interactives.json` and stay fixed.

### crane towers

[crane towers](../game-data/interactives.md#crane-towers) are posed before placements draw:

1. merge tower component parameters with the placement's component type 172; `state_*` entity
   properties pick the active steps.
2. walk the prefab for the postmodel MonoBehaviour's five Transforms and build one root clip: rope
   scale, rope-end position, and base/hook rotations (world yaws converted to local rotations under
   posed parents).
3. draw the tower's `target` container at the posed attach point (lowered by its `height`) instead
   of at its own placement.

towers with an empty step list or missing MonoBehaviour log to `unsupported-interactives.json` and
draw as saved; missing `target` containers still pose the tower and log.

### lifts

[lifts](../game-data/interactives.md#lifts) are rest looks whose template has the lift core
component:

- reads the starting floor, its position, and door bools (which settle view states).
- adds a root clip moving the cabin to the floor (world position converted to parent's saved space)
  and scaling the pole.
- if no view state switches a GameObject, the pose is `closed` (nodes saved off draw nothing, not
  stand-ins).
- floors missing from `position_list`, or prefabs without the MonoBehaviour, log to
  `unsupported-interactives.json` and draw as saved.
