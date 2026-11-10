# animation

how scenery moves: how an AnimationClip stores its bindings and curves, how a prefab's own Animators
pick the clips they play, and the spinning ECS scenery the game turns from the gameplay clock. which
clip an interactive's view state rests in is in
[interactives.md](interactives.md#interactive-view-states).

## animation clips

### bindings

a generic clip's muscle clip stores every animated value's start and stop (`m_ValueArrayDelta`) in
the order of its bindings (`m_ClipBindingConstant.genericBindings`): three values per position,
scale or Euler-rotation binding (attributes 1, 3 and 4), four per rotation (2), one per other float,
none per PPtr curve. a binding's `path` is the CRC32 of the GameObject path below the Animator's
own, `/`-joined (`Root/Bone001`), 0 for the Animator's GameObject. a clip loops when
`m_MuscleClip.m_LoopTime` is set.

- **Euler rotations** are in degrees, applied in the Unity `RotationOrder` the binding's
  `customType` holds: 0 XYZ (x first, then y, then z), 1 XZY, 2 YZX, 3 YXZ, 4 ZXY
  (`Quaternion.Euler`'s), 5 ZYX; only 0 and 4 have been seen. the locked chest
  (`int_trchest_lock_postmodel`) rests in a clip whose Euler bindings are all XYZ; read as ZXY, a
  third of its bones turn wrong and the chest sinks into the floor.
- **activity.** a GameObject binding (class 1) whose attribute is the CRC32 of `m_IsActive` switches
  that GameObject on (1) or off (0). effect clips switch whole groups of effects this way; in their
  subtree, what the clip leaves alone keeps its saved activity, so a node saved off stays off.
- **material properties** (`customType` 22) on a renderer (mesh renderer class 23, skinned 137,
  particle system renderer 199) apply to its materials. the attribute's low 28 bits are the low 28
  bits of the CRC32 of the property's name; its top four bits pick a vector's x to w (0–3), a
  colour's r to a (4–7) or a float (8). the talosites' clips set `_TintColorAlpha` and `_BlendTint`;
  the campfire's effect clips set a vector's components (kinds 0–3, read as x–w, unconfirmed against
  a material that saves the property).
- **other renderer properties** (`customType` 0) are named by the CRC32 of their path, such as the
  particle pivot's `m_Pivot.x`.

### curves

a clip's curves (`m_MuscleClip.m_Clip.data`) hold their scalars in binding order: the streamed
block's first, then the dense block's, then the constant block's.

- **streamed** is Unity's: frames of a time, a key count and per key the curve index and a cubic's
  coefficients, evaluated from the key's time to the curve's next key, with a frame at −FLT_MAX for
  the values before the first key and one at +∞ to end.
- **dense.** the game's dense blocks leave `m_SampleArray` empty and store `m_ACLType` 16 instead:
  `m_ACLArray` holds a u16 per frame and curve, frame-major, decoding to `(u16 − 32767.5) / 32767.5`
  times the curve kind's factor (`m_PositionFactor`, `m_ScaleFactor`, `m_EulerFactor`,
  `m_FloatFactor`; 1 for rotations, which are quaternion components). sampled at the clip's start
  and stop, this matches `m_ValueArrayDelta` to within one 16-bit step on the balloon's clips
  (positions, rotations and scales).
- **ACL.** many clips leave the streamed and dense blocks empty (`m_DenseClip.m_ACLType` 0) and keep
  their curves in `m_AclCompressedBuffer` ([below](#acl-compressed-clips)).

### ACL-compressed clips

`m_AclCompressedBuffer` holds up to three buffers: `TransformBufferData` the Transform curves,
`FloatBufferData` the other float curves (the spinning cube's are Animator parameters) and
`RootMotionBufferData` root motion. each is a stock buffer of the
[Animation Compression Library](https://github.com/nfrechette/acl) 2.1 (`compressed_tracks`, tag
`0xac11ac11`, version 10, whose hash checks out; the record's `Header.Version` repeats the 10):
upstream ACL decodes Wuling City's spinning cube's three buffers as 15 transform tracks (qvvf), 21
and 14 float tracks, 1600 samples at 30 Hz, wrapping (the last sample interpolates into the first,
so 1600 samples last the clip's 53.3 s). the game's buffers drop rotations' w
(`quatf_drop_w_variable`), quantize translations (`vector3f_variable`), and strip keyframes, which
playback interpolates.

the buffer's tracks map to the clip's bindings through `TransformSubTrackMasks`: three bit sets, one
each for position, rotation and scale, of `⌈OutputTrackCount / 8⌉` bytes, most significant bit first
for track 0, the whole padded to 4 bytes. the k-th position binding (in `genericBindings` order) is
the k-th track whose position bit is set, and likewise for rotations and scales; a Transform with
only a rotation binding is a track without its position bit. bindings whose index `m_ConstantIndexs`
lists take their values from `m_ConstantValues` instead (in listing order, three or four values per
Transform binding, one per other float), and a track can disagree with them: a few car clips
(`A_actor_car_e2m5_1_007` and kin) hold a different position in the ACL track than the clip's start
and stop.

checked over the first few thousand ACL clips of the install (in bundle order, about a tenth of its
AnimationClips): decoding every one and sampling it this way gives `m_ValueArrayDelta`'s start and
stop values within 1e-2 for nearly all of them (most far closer), and a few dozen character run and
sprint loops within 0.06 at their stop only, where wrapping replaces the last frame with the first.
none had Euler bindings. what the root motion buffer and `RootPosIndex`, `RootRotIndex` and
`RootTrackCount` add isn't traced.

## scenery animators

a prefab placed without view states can carry its own Animator with an AnimatorController. Unity
starts each layer in its default state (`m_DefaultState`) on load: the base layer at full weight
whatever its saved `m_DefaultWeight`, later layers at theirs. the layer then takes the first
transition whose conditions all hold, any-state transitions (`m_AnyStateTransitionConstantArray`)
before the state's own, and so on until none holds. conditions test parameters by id, the CRC32 of
the parameter's name (`m_ConditionMode` 1 if, 2 if not, 3 greater, 4 less, 6 equals, 7 not equal
against `m_EventThreshold`); a parameter's saved value is in `m_DefaultValues`, in the array of its
type (`m_Values`: 1 float, 3 int, 4 bool, 9 trigger) at its `m_Index`. a trigger isn't set at rest,
and a transition without conditions waits for its exit time, a timed sequence. a state whose blend
tree has one node plays the clip `m_ClipID` indexes in the controller's `m_AnimationClips`, at the
state's `m_Speed`; a clip that doesn't loop then holds its end pose. an interactive's template can
set its model's parameters as it loads
([template animator parameters](interactives.md#template-animator-parameters)).

- Wuling City's spinning cube (`p_anm_map02_machine+1_002_01`, at −1442, 330, −336 in map02_lv002,
  placed by mission `e6m1`'s level data): its controller `AC_anm_map02_machine+1_002_01` has one
  state, `idle_loop`, playing the looping 53.3 s clip `A_anm_map02_machine+1_002_01` (1602 frames at
  30 fps, [ACL-compressed](#acl-compressed-clips)) on 15 Transforms of a skinned mesh: four of them
  turn a full circle over the loop.
- Qingbo Stockade's octagonal waterwheels (`p_igroup_map02_sfwaterwheel+2_004_01`, two in
  map02_lv003 at −530.4, 246.9, −1074.6 and −551.8, 247.5, −1103.8, model rows of a dynamic
  structure gated by script group `23300000004`), built of plain mesh renderers: the root's
  controller `AC_imod_map02_sfwaterwheel+2_004_01` has one state, `on_idle`, looping
  `A_imod_map02_sfwaterwheel+2_004_01_openidle_01` (25 s, streamed curves at 60 fps). three Euler
  bindings (ZXY) turn the wheel's Transforms about their z: two from 0° to −360°, one from 45° to
  360°, which wraps by an eighth of a turn and so looks seamless on the eight-sided wheel. the same
  clip sets a value on two water-sheet MonoBehaviours, switches three GameObjects and sets renderer
  material properties.

### decoration animators

level scripts drive the Animators of a script-controlled group's prefabs
([script groups](scene-states.md#script-groups)): `SetDecorationAnimatorInt` and
`SetDecorationAnimatorBool` set `animatorParamName` to `targetValue`, and `PlayDecorationAnimation`
plays the state `animationName`, each naming the group by `targetDynamicEntity` (with its
`groupName` and `sceneName`). until a script sets a value the controller rests under its saved
parameters, as for any scenery animator.

Origin Lodespring's two luffing cranes (map01_lv006) are such groups. group `3500030000` places
`p_igroup_gtmachine+1_001_01` as a model row at the origin; its hierarchy is authored in world
space: a skinned jib on `Bone_Prop_Crane_*` bones over the mast at 646.2, 49.3, 412.0, and a
container on `Bone_box_001`. the Animator's controller `AC_interactive_gtmachine+1_001_01_004` has
one int, `state`, saved as 0, which rests in `empty`, a state without a clip, so the saved pose
shows: the jib raised, the hook at 628.2, 45.1, 406.1 and the container 7 m below it and 4.5 m to
the side, floating over the gap. `state` 1 to 4 lead to `close_idle`, `close_idle_2`, `open_idle`
and `open_idle_2`. level script `3500030021` (start shape 240 m around 535.5, 38.6, 428.7) sets it
on activation: 3 when its saved property `state_1` holds, else 1; the second crane (group
`3500030001`, `p_igroup_gtmachine+1_001_02`, near 420, 85, 350) gets 4 or 2 by `state_2`.
`open_idle` swings the jib out over the gap with the container hanging under the hook; `close_idle`
draws the jib in and holds the container level at 641.4, 46.3, 390.7. mission e2m7's custom events
(`action_e2m7_1`, `action_e2m7_2`) play `open` and `open_2` and then call the server; no client data
sets `state_1` or `state_2`, so that the server saves them then is inferred, not read.

## spinning scenery

Qingbo Stockade's other waterwheels (map02_lv003) turn without a clip. each is a dynamic structure:
its ECS renderers carry a spin component (InitChunkData column 54,
[layout](world.md#initchunkdata-layout)) and a model row places a collider prefab at the wheel's hub
whose GameObject has a `DynamicSceneSimpleRotate` (a `TickableMono` with one field, `angleSpeed`, in
degrees per second). that component sets its transform's world rotation (`Transform.rotation`, so
the row's own rotation is overridden) to `Euler(0, 0, TimeManager.gameplayTime · angleSpeed)` on
enable and every tick: an absolute angle from the gameplay clock, so the wheel's phase doesn't
depend on when it loaded. the renderers' column 54 holds the same spin as `|angleSpeed|` in radians
per second about ±z, the axis taking the sign, through the hub:

| wheel                                             | hub                                                                    | collider prefab `angleSpeed`                            | column 54               |
| ------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------- |
| `sfwaterwheel+1_002`, three (owner `23300000004`) | −278.5, 292.9, −1403.6; −233.4, 303.6, −1426.2; −237.2, 300.3, −1359.3 | −3 (`…sfwaterwheel_collider_effect+1_002_01_postmodel`) | 0.0524 about (0, 0, −1) |
| the large wheel above them (`sfwaterwheel+1_001`) | −233.8, 438.9, −1408.0                                                 | 2 (`p_igroup_map02_sfwaterwheel+1_001_01_col`)          | 0.0349 about (0, 0, 1)  |

no other scene's static or dynamic chunks have column 54. the native system that turns column 54
entities isn't read: that it turns them `speed · gameplayTime` about the axis through the pivot,
from their stored pose, is inferred from the data agreeing with the collider's script. the small
wheels load with their owner's script group (default on,
[script groups](scene-states.md#script-groups)).

the originium hub frames (`zmdhubframe+1_001`: four in base01_lv001 around −68, 15, −105 and −64,
40, −164, three in dung01_rdg003) roll about their long axis. their prefab's root carries an
`HGTransformAnimatedBehaviour`, a native component whose one motion phase has `eulerAngleSpeed` (0,
3.5, 0) degrees per second, no translation and its rotation anchor at the origin; the system that
runs it is fed an absolute time. the baked ECS entities hold it as column 52: 3.5° in radians per
second (0.0611) about local +y, which their matrices lay horizontal along the frame. no other entity
in any scene has column 52. that the entity turns `speed · t` about its local axis through its own
origin, from the stored pose, is inferred from the profile, not read from the native system.
