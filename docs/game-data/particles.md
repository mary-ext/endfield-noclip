# particles and spline movers

how the game's effects emit and move things inside prefabs: Unity `ParticleSystem`s, read from the
engine as the game's effects set them, and Beyond's spline movers. the shaders particles draw with,
and what they read of a particle's custom data, are in [effects.md](effects.md); prefabs and
billboards are in [assets.md](assets.md#prefabs).

## particle systems

a `ParticleSystemRenderer`'s `m_RenderMode` is 4 for meshes, otherwise a quad: billboard 0,
stretched 1, horizontal 2, vertical 3.

### emission and lifetime

- **rate over time.** `EmissionModule.rateOverTime` is particles per second; a curve is read at the
  system's time over its duration (`lengthInSec`), so it repeats every loop, as Unity documents it
  (the engine's step isn't traced; how it draws between two curves isn't either). effects time their
  emission to an animation this way: the water pouring off the scoops of Qingbo's waterwheels
  (`bigwater_01` in `p_igroup_map02_sfwaterwheel+2_004_01`) emits 32 a second from 12% to 77% of a
  3.125 s loop and nothing in its last 15%.
- **cap.** without a ring buffer, the cap (`maxNumParticles`) only limits emission: each emission,
  by rate or burst, makes at most the cap minus the live particles, none when the system is full,
  and the skipped ones aren't made up later. live particles are never cut short to make room. the
  Very Large Rift's ripple rings (`wenli_02` and the others in
  `p_fxmap_dung02_dg005_boss_semicircle_ripple_01`) rely on this: a burst every 0.1 s loop with a
  cap of 1 lets in one ring per 6 s lifetime. a cap of 0 emits nothing, except with a looping ring
  buffer, which doesn't cap emission and replaces each particle as it's emitted, so each lives its
  lifetime once (below): the tilted torch flames (`P_fxmap_common_tiltedflame_2501`) show so.
- **ring buffer.** `ringBufferMode` 1 holds a particle's age at its end until a newer one replaces
  it, 2 replays `ringBufferLoopRange` (its position goes on integrating while the age loops). a held
  particle isn't frozen: every module goes on moving and turning it, reading its curves at their
  end, and it moves by its velocity as before. emission isn't capped; an emission past the cap takes
  the slots in order, oldest first, so the particle emitted `maxNumParticles` before it is replaced.
  mode 1 drops the replaced particle and only then fires its death sub-emitters. mode 2 keeps it,
  moved past the cap, where its age no longer loops: it lives out the cycle it was in and dies at
  the end of its lifetime, so a colour over lifetime fades it out instead of it vanishing. Wuling
  City's bamboo smoke (`p_fxmap_map02_lv002_bamboo_watersmoke_2501`) relies on this: two of its
  systems cap at 2 particles but emit four per loop, each puff fading in and out over its life.
  Jingyu Valley's fish school relies on mode 1: its one burst lives 5–10 s, then swims on in its
  force field for good.
- **simulation space.** `moveWithTransform` is Unity's simulation space: 0 Local, where the
  particles move with the system's Transform, 1 World, where each stays where it was emitted and
  moves on its own, and 2 Custom, relative to `moveWithCustomTransform`. it shows only on an emitter
  that moves: the pour emitters of Qingbo's octagonal waterwheels (`bigwater_01 (6)` and `(7)` in
  `p_igroup_map02_sfwaterwheel+2_004_01`) are World systems their prefab's clip carries round
  ([scenery animators](animation.md#scenery-animators)), so the water falls from where each scoop
  was. the splash at the wheel's foot (`huihuagenbu (2)`) holds still.
- **donut shape.** `ShapeModule.type` 17 emits from a torus: `radius` around the shape's z,
  `donutRadius` the tube's, `radiusThickness` the tube's outer part used, each particle leaving
  outwards from the tube's centre line, as Unity documents it (not checked against the engine). the
  accelerate mushroom's coin motes (`lizi1` in `int_acceleratemushroom_postmodel`) burst from one
  stretched tall by the shape's scale.
- **mesh shape.** `ShapeModule.type` 6 emits from `m_Mesh`. its primitives are every submesh's, or
  only `m_MeshMaterialIndex`'s (clamped) with `m_UseMeshMaterialIndex`: triangles, lines, strips of
  either (read as lists), and a submesh without indices as a line strip through its vertices; quads
  and points make the mesh invalid and nothing is emitted. whether a primitive has two or three
  corners is taken from the last submesh read, so a mesh mixing lines and triangles samples
  inconsistently.
  - `placementMode` 0 (vertex) picks a primitive evenly, then one of its corners, so vertices shared
    by more primitives come up more often; 1 (edge) picks a triangle by area (a line by length),
    then a point along its outline by parameter, each side a third whatever its length; 2 (triangle)
    picks by area and a point evenly within, always at random.
  - `m_MeshSpawn.mode` steps vertex placement through the vertex buffer itself (ignoring the
    material index), one vertex per emitted particle from a running count, wrapping (Loop) or back
    and forth (PingPong and BurstSpread), without reading `speed` or `spread`. edge placement in
    those modes walks the outline by `m_MeshSpawn.speed` over time, and its `spread` snaps the place
    to steps (random mode too).
  - the particle leaves along the point's interpolated normal, normalized ((0, 0, 1) without
    normals), `m_MeshNormalOffset` moving it along the unnormalized normal first, in the mesh's
    space, so the shape's scale scales the move. with `m_UseMeshColors` and vertex colours, its
    start colour is multiplied by the point's Color32, and a shape texture multiplies in after. the
    shape's placement then applies as for other shapes.
  - the red mission portals' sparks (`dot_Line` in
    `p_fxint_s_missionportal_entrance_red_narrowloop_2103`) start on the edges of a ring mesh.

### motion

each step the engine adds gravity to the particle's own velocity, lets the external forces change
it, adds Velocity over Lifetime's terms beside it, limits and drags the whole speed, then moves the
particle by the whole velocity times the speed modifier.

- **Limit Velocity.** with `dampen` 0 the speed limit does nothing, and the module only applies its
  drag: each frame the whole speed loses `k · dt`, or `k · s² · dt` with
  `multiplyDragByParticleVelocity` (k the amount, times `π (size / 2)²` with
  `multiplyDragByParticleSize`), stopping at 0. the splashes at the foot of Jingyu Valley's falls
  (`shuihua` in `P_fxmap_common_splashes_middle_2501`) rely on it to hang in the air rather than
  drop under their 2–6× gravity. with `dampen` above 0 the module limits the whole speed `s`, the
  particle's own velocity plus the velocity-over-lifetime part: above the limit `L` (`magnitude`,
  read at the particle's age; two constants pick a random value per particle) the speed becomes
  `s + (L − s)·k` with `k = 1 − (1 − dampen)^(30·dt)`, frame-rate independent against 30 fps, and
  the excess comes out of the particle's own velocity alone, so the velocity-over-lifetime part is
  added in full again next frame. a particle moved only by velocity over lifetime thus builds up an
  opposing velocity of its own and settles at the limit. the challenge start point's rising rock
  cards (`stone` in `int_challenge_start_point_once_postmodel`) start still, are pushed up at 0.2–1
  m/s and limited to 0.1–1 m/s with a dampen of 0.1. the module limits first and then drags the
  limited speed, both out of the particle's own velocity; drag reads the particle's current size
  (the largest axis of a 3D size). the smoke rising off Marker Stone Interiors' rift monsters
  (`smoke_loop`, `smoke_end` in `p_fxmap_map02_lv004_liexi_only_*`) uses both. how the per-axis
  limit (`separateAxis`) and drag curves behave isn't traced.
- **speed modifier.** each frame the engine reads Velocity over Lifetime's `speedModifier` at the
  particle's age over its lifetime (the time the linear velocity curves are read at; two constants
  pick a random value per particle) and moves the particle by its whole velocity, its own plus the
  velocity-over-lifetime part, times that value. a curve thus scales the start speed as much as the
  module's own terms. the floating stones of Valley's Aberrants (`floatstone01` in
  `p_fxmap_map01_lv001_floatstone_*`) rise at 0.5–1.5 m/s under a modifier ramping from 0.39 to 1
  over their 5–10 s. gravity adds into the particle's own velocity, so the modifier scales its share
  too. the modifier only scales the move: the speed limit, run before it, sees the velocity without
  it.
- **external forces.** `ExternalForcesModule` pushes particles with `ParticleSystemForceField`s:
  those in `influenceList` (`influenceFilter` 1), those on the layers of `influenceMask` along with
  wind zones (0), or both (2), when active and enabled. the module does nothing unless its
  multiplier's scalar is above 0. each step, after gravity and before velocity over lifetime, noise
  and the speed limit, each field changes the particle's own velocity in turn. a sphere field
  measures the particle's distance from its centre in its own frame, scale included, so a field
  squashed up its y reaches less far vertically; outside `m_StartRange`…`m_EndRange` it does
  nothing, and its curves are read at the distance's place between the two. two constants pick one
  value per particle, the same for every field; the multiplier is read at the particle's age. in
  order: the direction curves add `direction · m · dt` along the field's axes; gravity adds
  `−n · gravity · m · dt · 30` (`n` from the centre to the particle, reversed within
  `m_GravityFocus` of the range); the swirl, only when both its speed and attraction scalars are
  nonzero, pulls the velocity `v` towards `t · speed` by `attraction · m · dt · 30` of the way, `t`
  the unit tangent about the field's +y tilted per particle by up to ± half a turn times
  `m_RotationRandomness` (about x, then z); drag takes `drag · m · dt` off the speed, times
  `π (size / 2)²` and the speed squared when its flags say so, to no less than 0. the ×30 makes the
  pulls frame-rate independent against 30 fps. the fish school's field (start 3 m, end 15 m,
  squashed to 0.2 up its y) swirls its fish at ±4 m/s with a 2–5% pull per 1/30 s, pulls them in at
  3–7.5 m/s² and drags them by their speed squared; the large fish's field has no swirl attraction,
  so it only holds them in and slows them. hemisphere, cylinder and box fields, vector fields and
  wind zones aren't traced.
- **rotation over lifetime.** `RotationModule`'s rates (`curve` about z, and `x`, `y` with
  `separateAxes`) are angular velocities read at the particle's age over its lifetime, so curves
  speed up or slow the spin. the mushroom's wind sheets (`wind01`/`wind02`) start spinning at up to
  60°/s either way, between two curves, and slow to a stop.

### size and pose

- **scaling.** `scalingMode` picks the scale that sizes particles: Hierarchy the whole hierarchy's,
  Local the system's own transform's, and Shape none, where the scale moves particles but leaves
  their size. effects stretch a spawn box this way: Jingyu Valley's bird flock
  (`p_fxmap_map_bird_03`) sits under a parent scaled 363 × 150 × 148 m, in Shape mode, so its birds
  stay their start size. the engine builds the emitter's matrix by mode too: Hierarchy takes the
  Transform's whole world matrix, while Local and Shape take its world position and world rotation
  (the product of the local rotations above it) and scale that by the system's own scale (Local) or
  nothing, scaling the shape by the lossy scale instead (Shape). under a non-uniform parent scale,
  then, only Hierarchy's axes are sheared, and Hierarchy sizes particles by the lossy scale (each
  world-rotation axis projected onto the matrix's), not by the sheared axes' lengths. Jingyu
  Valley's big waterwheel (`int_big_wheel_postmodel`, near −630, 246, −1251) carries
  `P_fxint_s_bambootube_waterfall_2501_variant` on each of its eight scoops, under a parent scaled
  0.1 × 1 × 1 and turned 90° about y: its Hierarchy splashes (`water001 (3)`, `water001 (6)`) shoot
  along the wheel's axle out of its side, sized about 0.13 wide and 1.2 tall, so they show as thin
  streaks spinning at random.
- **pivot.** the renderer's `m_Pivot` offsets each particle's mesh from the particle's position, in
  the particle's turned frame, in multiples of the particle's size. in mesh mode it is also measured
  in the mesh's own size, per axis twice the farthest its bounds reach from the origin
  (`2·(|centre| + extent)`), as the renderer's bounds code sizes it. Dijiang's robot lamps
  (`P_fxmap_common_robot_lamp_802`) offset their eyes, a 0.1 m plane, by ±0.95 of it: each eye sits
  7 cm off centre under the eyes' 30× scaled parent, not 70 cm.
- **meshes.** each particle draws one of up to four meshes (`m_Mesh` … `m_Mesh3`), evenly or by
  `m_MeshWeighting*` when `m_MeshDistribution` is 1.
- **render alignment.** `m_RenderAlignment` is Unity's: View 0, World 1, Local 2, Facing 3 and
  Velocity 4, which points a particle's +z along its motion. the accelerate mushroom's arrows
  (`dajiantou02`/`03`) are flat arrow meshes pointing along their +z, launched straight up a cone of
  angle 0 and lifted by a slightly negative gravity, so Velocity alignment stands them upright as
  they rise, spun about the vertical by their rotation over lifetime. for meshes, the velocity is
  turned into the world (through the emitter's whole matrix, scale included) and the particle takes
  a look rotation along it, rolled level by the world's +y: forward along the velocity, right
  `(F.z, 0, −F.x)` normalized (the world's +x when moving straight up or down), up their cross
  product; a still particle faces the world's +z. the mesh is offset by its pivot, sized, turned by
  the particle's own rotation, scaled by the emitter's scale (Hierarchy the lossy scale, Local the
  system's own, Shape none) along that rotation's axes, then turned into it. the fish
  (`p_fxmap_map02_lv001_fish_2101`) are modelled along their y and turned −90° about x, so they swim
  level along their path.
- **stretched quads.** with `m_FreeformStretching` off, a stretched particle is a streak from the
  particle back along its velocity, `size.y · m_LengthScale` (times the emitter's x scale) plus
  `speed · m_VelocityScale` long, with the camera's velocity times `m_CameraVelocityScale` taken off
  the velocity first (the camera's world velocity, not turned into the camera's frame). its width,
  `size.x`, runs across the velocity as seen from the camera's position (the cross product of the
  velocity and the camera-to-particle direction), flattened onto the view plane; the particle's
  rotation and `m_RotateWithStretchDirection` don't enter. turning the camera in place thus barely
  moves it, while a streak tilted off the line of sight turns about itself as the camera moves. a
  still particle, or one moving along the line of sight, has no width and isn't drawn. the pivot
  moves the head forward along the velocity by `pivot.y · size.y` (no length scale) and the whole
  streak across by `pivot.x` times half the width; `pivot.z` is unused. each corner's normal leans
  from the face's own normal (perpendicular to the width and the 3D streak, towards the camera) out
  along its edge by `cos(m_NormalDirection · 90°)`; at `m_NormalDirection` 1 every corner takes the
  face's normal. Suiming's drifting fog (`smoke` in `p_fxmap_map02_lv007_windice01`, 10–13 m streaks
  twice their size long, blown sideways at 5–15 m/s) is such a streak, faded by a steep Fresnel term
  on that normal. the freeform path isn't traced.
- **on-screen size.** for every quad mode the renderer holds a particle's larger side between
  `m_MinParticleSize` and `m_MaxParticleSize` times the viewport's width at the particle's view
  depth (`2·tan(fov/2)·aspect·depth`; twice the orthographic size times the aspect for orthographic
  cameras), scaling x and y together. behind the camera the minimum's bound is negative, which hides
  the particle only when `m_MinParticleSize` is above 0; the maximum's negative bound is ignored, so
  with no minimum a particle behind the camera keeps its whole size. a stretched quad's length is
  worked out from its size before the limit, so the limit only narrows it. a dead particle (age at
  or past 100% of its lifetime) gets no size.

### texture sheets and custom data

- **texture sheet.** `UVModule` in grid mode plays the whole sheet or one row (fixed, random or by
  mesh), timed over the lifetime by `frameOverTime` and `cycles` or by `fps`, offset by
  `startFrame`, on the UV sets of `uvChannelMask`.
- **custom data.** `CustomDataModule` in vector mode (`mode0` 1) gives each particle up to four
  values (`vectorComponentCount0`, the rest 0), each a MinMaxCurve read every step at the particle's
  age over its lifetime (clamped below 1). a random between two constants or curves is fixed per
  particle: it comes from the particle's random seed, salted per component, with no time input. with
  `m_UseCustomVertexStreams` the renderer packs its `m_VertexStreams` past position, normal, tangent
  and colour into 4-wide texture coordinate sets in list order (UV and UV2 two components each,
  Custom1XYZW four), the same on all four corners of a quad: with streams [0, 1, 3, 4, 5, 34] the
  first set is UV and UV2 (equal without a texture sheet) and the second is the custom data, which
  effect materials read ([particle custom data](effects.md#particle-custom-data)).

### examples

- Wuling City's threads swirling over the pillar array (`p_fxmap_lv002_fangyuzhenlie_*`) are single
  particles kept past their lifetime by a ring buffer, without a texture sheet.
- the floating rocks over Origin Lodespring's crater (`Rock02` in `P_fxmap_common_brokentree_01/02`)
  draw four rock meshes each.
- the campfire flames (`fire01`/`fire02` in `P_fxmap_common_damagefire_small_2501`) are one
  ring-buffered particle stepping through an 8×8 flipbook every loop.
- the spray and stretched mist cards at the foot of falls are `shuihua` and `shuiwu`.

## spline movers

Beyond's `HGSplineMovingObjects` MonoBehaviour emits whole prefabs along a spline, simulated in
native code rather than by a `ParticleSystem`. the cargo crates riding up and down Dijiang's central
shaft are such movers: ten of them in `p_fxmap_base01_lv001_zmdlogistics_02_01` (and `_01_01` for
the other scene state), placed with the shaft's effects in base01_lv001. it is recognised by its
`desc`, `knotData` and `fixedPostion` fields. `desc` holds Unity `MinMaxCurve`s in their managed
form (`m_Mode`, `m_ConstantMin/Max`, `m_CurveMultiplier`, `m_CurveMin/Max`), and the game:

- **emits** `emissionRateOverTime` objects per second of the mover's own time, the frame's time
  times `simulateSpeed` (the logic clock's with `useLogicDeltaTime`). an object emitted partway
  through a frame starts aged by the rest of it. each picks one of `lodGroups` at random and draws
  that LOD group's renderers as one object.
- **places** an object `d` metres along `knotData`, cubic Bézier segments (`p0`–`p3`) laid end to
  end, each taking up its stored `length`. the segment's parameter is `d`'s share of that length, so
  the speed along the curve follows the control points' spacing: the shaft's straight segments, with
  their handles on their ends, ease objects in and out. `d` grows by `velocityOverLifeTime`, read at
  the object's age over its lifetime, times the step. past the last segment the object is removed.
  with `emissionType` 0 it starts at a random point of the `aabb` box, an offset added to every
  spline point.
- **lives** `startLifeTime` clamped to 0–1, times a span the game derives per mover: a fraction of
  the trip, so the shaft's descending crates (lifetime 5) ride the whole 60 m and the rising ones
  (0.6–0.75) stop part of the way up. the span read as the spline's length over the speed is
  unverified.
- **sizes and turns** it: uniform scale `startSize` times `sizeOverLifeTime`, Euler angles in
  degrees from `startRotationX/Y/Z` in Unity's order (only z without `has3dStartRotation`), plus
  rotation over lifetime with `hasRotation` and a noise offset with `hasNoise`; the shaft's movers
  use neither. the object's matrix is the mover's `objectToWorld`, updated from its transform.
- **fades** with `hasAlphaControl`: an object whose `alphaOverLifeTime` falls below
  `transparentAlpha` draws transparent at that alpha. the shaft's movers set `transparentAlpha` 0,
  so they stay opaque.
