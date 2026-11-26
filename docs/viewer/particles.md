# billboards and particles

viewer implementation of [billboards](../game-data/assets.md#billboards) and
[particle systems / spline movers](../game-data/particles.md); gaps in
[status.md](../status.md#effects-and-particles).

## billboards

billboarded rows rotate on the GPU in every mesh, effect, and shadow vertex stage by the camera
rotation (`Facing`) or vertical heading (`Upright`). culling and LOD use the stored
orientation-independent bounds.

divergences: rows store their renderer's position, so off-origin renderers pivot in place instead of
swinging around the billboard origin. modes 1–3 all play as `Upright` around world +Y (exact only on
upright placements).

## particles

a chain draw referencing a particle system ([package format](../package-format.md#particles)) acts
as an emitter: it culls and streams geometry normally, but submits its live particles' rows instead.

- each emitter reserves up to `min(maxParticles, 1024)` rows in the instance buffer and updates them
  each frame selected. emitters unselected for 600 frames (or in released blocks; pinned HLOD/global
  blocks never release) are freed.
- all mesh, effect, and shadow shaders render particles unchanged. particle colour packs into RGBA8
  per row and multiplies mesh vertex colour.
- multi-mesh renderers split into one emitter per mesh sharing random seeds, each drawing the
  particles that pick its mesh.
- frozen single-particle systems arrive as plain instances; empty `RenderMode.None` systems (no
  trails, no active light prefab, no active sub-emitters) are omitted; other unplayable systems
  arrive as [stand-ins](../package-format.md#stand-ins) (mesh or quad with
  [unsupported](materials.md#unsupported-materials) checker under "missing content").
- ignored modules: noise, collision, triggers, lights, by-speed modules, and non-Birth/Death
  sub-emitters (systems play without them).

### emission

particles derive deterministically from emission time and hashed random values (emitter position,
system, index):

- **stream & bursts**: start after a per-emitter start delay (random between constants). rate
  emissions fire when the rate integral reaches `n` (constant `1 / rate`, or curve-integral table;
  random rate uses its mean), plus per-loop bursts (rounded count, probability test) within the
  max-lifetime lookback. non-looping systems stop after one duration.
- **ring buffer**: particles persist until replaced `maxParticles` emissions later. past lifetime,
  held particles keep moving/spinning using end-of-curve values (matching game); loop-range
  particles replay their path too (game moves on). replaced loop-range particles age out from their
  cycle point until lifetime ends (lookback and row cap extend by one lifetime; newest live ones
  kept).
- **non-ring-buffer cap**: systems that can exceed `maxParticles` skip emissions while full, so
  emitters step forward from the previous frame (resetting from an empty state 4 lifetimes back on
  time rewind or large jumps; preserves e.g. Very Large Rift's 6 s ripple rings).
- **start shape**: start curves sample at the emission's loop phase. shapes set position and
  direction (cones toward matching far-end point, volumes across length, donuts outward from tube
  centreline) in shape space. mesh shapes sample primitives/points and multiply vertex colour;
  vertex Loop/PingPong numbers rate emissions from start delay, or bursts in emission order when
  rate is 0 and loops are identical (e.g. Wuling's 39-vertex tower lamps); other bursts pick
  randomly.

### motion

- **closed form**: at age `a`, displacement is `(startSpeed + linearVel) · m · a + ½ g m a²`
  (world-space linear velocity transformed into emitter space; `g = 9.81 m/s² * gravityModifier`
  down world Y) plus `radial · m`, then rotated about orbit centre by `ω · m · a` (exact when other
  motion is along the orbit axis). linear, orbital, and radial curves integrate via prebuilt tables
  (saving ~1/3 of particle placement time vs. per-frame sampling).
- **speed modifier curve**: replaces `m · a` with `∫ m dτ`, integrates velocity curves times `m(τ)`,
  and integrates fall as `∫ g τ m(τ) dτ`. systems combining a speed-modifier curve with drag and no
  speed limit become stand-ins.
- **drag**: without speed limit, force fields, or velocity-module linear/orbital/radial terms, slows
  start velocity by `k` or `k v²` per second (`k` scaled by `π (startSize / 2)²` if size-scaled);
  fall accelerates at `max(0, g − k)` or approaches terminal speed `√(g / k)`. speed modifier scales
  the result.
- **stepped path**: used when a speed limit, force fields, or drag alongside velocity-module terms
  are active. steps at 30 Hz (max 600 steps, coarser beyond) from birth on first draw or rewind,
  otherwise from last frame. each step: add gravity → apply sphere force fields term-by-term with
  viewer randoms → clamp total speed (including velocity-module linear, `ω × r` orbit, and radial
  terms; viewer random limit) → apply drag (using current X size on combined speed, subtracted from
  own velocity) → advance by `totalVel * modifier(age)`.
- **splines**: [spline movers](../game-data/particles.md#spline-movers) ignore the above, placing
  particles at `splinePoint(∫ speed dτ) + shapeStart` until past the end. spin uses rotation over
  lifetime with independent per-axis randoms (game shares one).

### pose and colour

- **pivot & scale**: mesh offsets by pivot, scales by `startSize * sizeOverLifetime(a / lifetime)`,
  and turns in its draw frame (camera-facing pivots rotate with camera). emitter scale applies only
  when `sizedByScale` is set; quads clamp to on-screen limits.
- **rotation & alignment**: start Euler (Unity Z, X, Y) + integrated angular velocity in Local,
  World, View/Facing (camera), or Velocity (look-rotation rolled level for meshes; shortest turn
  from +Z for velocity billboards, untraced). 2D Z rotation on quad billboards turns clockwise on
  screen (`cos·right − sin·up`, `sin·right + cos·up`), matching Unity. emitter scale applies along
  rotated axes.
- **quad render modes**: billboards follow render alignment; vertical faces camera heading;
  horizontal lies flat (+Y); legacy stretched extends back along `−vel` on quad X (`u = 0` at head,
  `1` at tail) with width across velocity in the view plane on quad Y, face normal
  (`m_NormalDirection == 1`, edge lean omitted), zero size when still or along sightline, no camera
  velocity subtraction; freeform stretched builds a centred camera-facing billboard rotated by Z
  (plus projected velocity when `rotateWithStretchDirection` is set) and linearly stretched along
  velocity.
- **GPU vs CPU turn**: camera-facing and vertical rows set [billboard](#billboards) bits to turn on
  the GPU; others rotate on the CPU.
- **texture sheet & colour**: frame from start frame + age (over lifetime or FPS); row random, by
  mesh index, fixed, or full grid; quad `flip` flips UVs while mesh `flip` negates particle size per
  axis. colour is `startColor * colorOverLifetime`, blended in authored space and linearized.

### trails

trail entries share the renderer's particle salt and evaluate every particle regardless of mesh.

- for each particle passing the trail ratio, 9 evenly spaced points are sampled back over
  `min(trailLifetime, moved)` (tracing actual elapsed motion on paused ring buffers), reading width
  and trail colour along the span (0 at head) and lifetime colour at current age.
- emits 8 quad rows per particle (stretched point-to-point along X, mean width across segment and
  sightline, −Z facing camera, mean colour, tile `j` of an 8×1 sheet).
- divergence: the game samples every `minVertexDistance`, giving smoother bends and continuous
  edges; here segments meet at ends only.

### sub-emitters

systems with `subEmitter` ([package format](../package-format.md#particles)) evaluate their parent
recursively over the window of parent particles that could still have live children (retaining
expired emissions on capped parents so children can outlive short-lived parents such as
`p_fxmap_map_spark_02`'s 0.15 s `light`).

- `Birth` evaluates the child's rate and bursts over each passing parent particle's life; `Death`
  fires the child's `t = 0` bursts at parent death. parent positions transform into child emitter
  space (falling back to per-axis inversion on zero-scale axes), and inherited
  Color/Size/Rotation/Lifetime/Duration apply at child birth.
- looping and settle time follow the parent, so non-looping children of looping parents (water-drop
  ripples, Marker Stone lightning clouds) play continuously.

### moving emitters

clip-driven emitters draw at the clip's end pose with frames stored relative to it (held without
interpolation). clip and looping emission both start at viewer clock 0 (offset by whole loops),
staying in sync (e.g. Qingbo's waterwheel pour emitters). world-space particles spawn from the clip
pose at emission time and simulate in the draw frame; local-space particles use the current clip
frame.

## custom data

`customData` ([package format](../package-format.md#particles)) evaluates each component curve at
`age / lifetime` with its own random value and packs f16 pairs per row.

only scene effects read it ([shared rule](../game-data/effects.md#particle-custom-data)):

- **x / y**: shifts slot UVs (x for slot 0, y for other slots) on texture stack, refraction, water
  sheets, and six-way smoke.
- **z**: added to dissolve schedule on those same four families.
- **w**: scales distortion on `particleDisturb` stacks; added to spread schedule on refraction.

## time and randomness

the game's RNG sequence is not reproduced, so particles have the same distributions at different
positions. looping systems evaluate as if already running; non-looping systems start on first
selection (and restart if re-selected after being [forgotten](#particles)). particles run on the
viewer's animation clock (pause when idle; `continuous` keeps them running; `animate` off freezes
them; [performance](performance.md)).
