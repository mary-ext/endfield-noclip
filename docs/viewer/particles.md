# billboards and particles

how the viewer plays the [billboards](../game-data/assets.md#billboards) and the
[particle systems and spline movers](../game-data/particles.md) of the game's prefabs; what's left
out is in [status](../status.md#effects-and-particles).

## billboards

rows of a billboard chain ([assets](../game-data/assets.md#billboards)) turn to the camera on the
GPU. when an instance block is uploaded, `markBillboardRows`
([`content/instance-rows.ts`](../../packages/viewer/src/content/instance-rows.ts)) sets their
`RowBillboard` bits by chain run, and `row_basis` in `frame.wgsl` multiplies the stored rotation by
the camera's (`Facing`) or by its heading about the vertical (`Upright`) in every mesh and effect
vertex stage, shadows included. the cull and LOD tests use the stored bounds, which already hold
every orientation.

the package stores each row at its renderer's own position, so a renderer away from the billboard's
origin turns in place rather than swinging around it as the game's hierarchy would. billboard modes
1–3 all play as `Upright` about the world's vertical, which is their axis only on upright
placements.

## particles

a chain draw that names a particle system ([package format](../package-format.md#particles)) makes
its instance an emitter: the emitter culls and streams its geometry like any instance, but its
bucket takes the rows of its live particles instead of its own
([`particles/`](../../packages/viewer/src/particles/): `simulation.ts` plays a system, its motion,
forces and texture sheet in modules of their own, and `particle-rows.ts` writes the rows).
`ParticleField` keeps as many rows per emitter as the package's emission bound, up to
`min(maxParticles, 1024)`, in the instance buffer, using the emitter's block origin, and rewrites
them once per frame the emitter is selected. an emitter not selected for 600 frames is forgotten and
its rows freed, as are a block's emitters when it's released (pinned HLOD and global blocks never
are). so every mesh shader draws particles unchanged, and shadow and effect passes need nothing of
their own. each particle's colour goes into its row's colour word (`RowWord.color` in
[`content/instance-rows.ts`](../../packages/viewer/src/content/instance-rows.ts), RGBA8, white for
other rows), where it multiplies the mesh's vertex colours in the mesh and effect shaders. a
renderer with several meshes is several emitters at one place; they share their random values, so
each draws the particles that picked its mesh.

systems the packer froze into a single particle ([package format](../package-format.md#particles))
aren't emitters: they arrive as plain mesh instances. systems it can't make playable at all arrive
as stand-ins ([package format](../package-format.md#stand-ins)): one mesh or camera-facing quad at
the emitter in the [unsupported](materials.md#unsupported-materials) checker, shown with "missing
content". modules not listed below (noise, collision, triggers, sub-emitters, trails, lights and the
by-speed modules) are ignored, so systems that enable them play without their effect rather than not
at all.

### emission

each particle follows from its emission time and random values hashed from the emitter's place, the
system and its index, so any moment can be evaluated on its own:

- emissions start after the start delay, drawn once per emitter between its two constants, and are
  the rate's stream (the nth particle when the rate's integral reaches n: one every `1 / rate`
  seconds for a constant, and for a curve the time found in a table of its integral over one loop,
  `emission-rate.ts`; a random rate takes its mean) and each loop's bursts (count rounded, each
  fired with its probability), within the window the longest lifetime reaches back; non-looping
  systems stop emitting after one duration.
- with a ring buffer a particle stays until newer ones replace it, so the window reaches back far
  enough for that many emissions; past its lifetime it shows its end (or replays its loop range),
  and the newest live ones that fit the rows are kept. a particle held at its end keeps moving and
  spinning by its age, its curves read at their end, as the game goes on stepping it; one replaying
  its loop range replays its path too, where the game's moves on.
- without a ring buffer, a system whose emissions can outnumber its
  [cap](../game-data/particles.md#particle-systems) skips the emissions that come while it's full,
  so which particles live depends on every earlier emission: the emitter plays them forward from
  where the last frame stopped, and starts afresh from an empty system four lifetimes back when the
  time steps back or jumps further. the Very Large Rift's ripple rings (one particle, a burst every
  0.1 s) thus spread for their 6 s instead of restarting every loop.
- start values read their curves at the emission's place in its loop. the shape gives the start
  position and direction (cones towards the matching point of their far end, volumes anywhere up to
  their length, donuts outwards from the tube's centre line), placed by the shape's own transform.
  mesh shapes (`mesh-shape.ts`) pick a primitive and a point on it as the game does, from the
  particle's random values, and multiply the start colour by the point's vertex colour; vertex Loop
  and PingPong number the rate's emissions from the start delay. a system without the rate numbers
  its bursts' particles instead, in emission order, when it plays once or every loop emits the same
  particles (`#burstsNumbered` in `simulation.ts`), so Wuling's tower lamps
  (`p_fxmap_map02_lv002_citywall_lighting_02`, one 39-particle burst over a 39-vertex mesh) get one
  glow and one streak each. other bursts, and those of systems that also stream, pick at random.

### motion

- at age `a` a particle has moved `(start speed + linear velocity) · m · a`, where `m` is the
  velocity module's speed modifier and a world-space linear velocity is first turned into the
  emitter's frame, plus `½ g m a²` down the world's y (Unity's gravity, 9.81 m/s² times the gravity
  modifier) and the radial push times `m`, then turned about the orbit's centre by `ω · m · a`.
  linear, orbital and radial curves are integrated over the age, so Jingyu's drifting petals turn
  through their spin-up's integral. turning the whole path is exact when the rest of the motion runs
  along the orbit's axis. the integrals are read from tables built once per curve
  ([`curve-integrals.ts`](../../packages/viewer/src/particles/curve-integrals.ts)): a `MinMaxCurve`
  is a sum of at most two terms, each a factor holding the particle's random value times a curve of
  its age over its lifetime, so its integral, alone or times a speed modifier curve, is a sum of
  factors times integrals of the curves alone. summing samples per particle each frame took about a
  third of the time particles are placed in.
- a speed modifier curve (`modifierAt`) takes the place of `m · a` with its integral over the age,
  and the linear, orbital and radial curves are integrated times it, as the game
  [scales every step](../game-data/particles.md#particle-systems); the fall, built up in the
  velocity it scales, becomes `∫ g τ m(τ) dτ` (`½ g m a²` for a constant). systems with such a curve
  and drag but no speed limit stand in, since the closed form below takes the modifier as a
  constant.
- without a speed limit or force fields, drag (`dragged`, `draggedFall` in `motion.ts`) slows the
  start velocity alone, by `k` or `k v²` per second (k the amount, times the cross-section
  `π (size / 2)²` when it scales with size), and a fall gathers speed at `g − k` (none when drag
  outweighs gravity) or towards the terminal speed `√(g / k)` under `k v²`; the velocity module's
  own terms and orbits aren't slowed, and the size is the start size. the speed modifier then scales
  the slowed launch and fall alike.
- under a speed limit or force fields (`steppedPath`) there is no closed form, so the particle is
  stepped to its age at 30 Hz (at most 600 steps, longer ones beyond), from its birth the first time
  it's drawn and from where the previous frame left it after that; a step back in time starts it
  from its birth again. each step adds gravity to its own velocity, lets the force fields change it
  (`applyForces`, from its place and age before the step), limits the whole speed, the velocity
  module's terms included, as [the game does](../game-data/particles.md#particle-systems), drags it
  (by the size at the step's age, from the particle's own velocity), and moves it by the whole
  velocity times the speed modifier read at the step's age (the limit sees the velocity without it),
  so the collectible pieces' rings (`ringMid2`) slow as their modifier falls while held near their
  limit. the fields follow the [game's sphere fields](../game-data/particles.md#particle-systems)
  term by term, with the viewer's own random values; drag by size reads the particle's x size. the
  module's terms, each read at the step's age, are its linear velocity, the orbit's velocity at the
  particle's current place (`ω × r` about the orbit's centre, rather than the closed form's turn of
  the whole path) and the radial push away from that centre. the limit's random value is the
  particle's own, not the game's.
- a system with a spline ([spline movers](../game-data/particles.md#spline-movers)) ignores the
  above: a particle lies at the path's point its travelled distance reaches (the speed integrated
  over its age), plus its start position in the shape, and leaves once that distance passes the
  path's end. `splinePoint` finds the point as the game does.

### pose and colour

- the mesh is offset by the system's pivot, scaled by the particle's size and turned with it in the
  frame it's drawn in: a camera-facing particle's offset turns with the camera (`turnedByBillboard`,
  as `row_basis` turns its axes), so the blue talosite's pivoted shards keep their pinwheel facing
  the camera from every side.
- size is the start size times the size over lifetime at `a / lifetime`. rotation is the start Euler
  angles (Unity's Z, X, Y order) plus the angular velocity integrated over the age, applied in the
  emitter's frame (Local), the world's (World), the camera's (View and Facing, so the meshes turn
  with the camera, as the game's do) or, for meshes, the game's look rotation along the particle's
  world velocity, rolled level (Velocity; `velocityBasis`), with the emitter's scale applied along
  the particle's rotated axes as the game does. velocity-aligned billboards take the emitter's frame
  turned the shortest way from its +z onto the velocity (`turnFromZ`), the viewer's choice, not
  traced to the game's.
- quads turn by the render mode: billboards by their render alignment, like meshes (with the camera,
  where their rotation rolls them, or along the world's, the emitter's or the velocity's axes),
  vertical ones with its heading, horizontal ones lie flat facing up, and stretched ones run back
  from the particle along its velocity, as the game's legacy
  [stretching](../game-data/particles.md#particle-systems) does, their width across it as seen from
  the camera's position (`ParticleView.eye`), flattened onto the view plane, and their normal the
  face's own (the game's at `m_NormalDirection` 1; other values' lean towards the edges isn't
  drawn). like the game's, still streaks and those along the line of sight get no size, and the
  pivot moves the head and the streak as the game's does. the camera's velocity isn't taken off.
- the transform's scale sizes the particles only when the system is `sizedByScale`, and quads then
  keep to their [on-screen limits](../game-data/particles.md#particle-systems) (`screenLimited`).
- rows that turn with the camera (view-aligned meshes and billboards) or its heading (vertical
  quads) keep their own rotation and set the [billboard](#billboards) bits, so `row_basis` turns
  them on the GPU as it does billboard chains; the others are turned on the CPU.
- a texture sheet picks each particle's frame from its start frame plus its age (over its lifetime,
  or by frames per second), and its row at random, by mesh index or fixed, or plays the whole grid.
  the tile goes into the row's sheet word (`rowSheet`), and `sheet_uv` in `frame.wgsl` remaps the
  mesh's UVs into it in the mesh and effect vertex stages; other rows carry a 1×1 sheet, which
  leaves UVs alone.
- colour is the start colour (read at the emission's place in its loop) times the colour over
  lifetime, blended in the authored colour space, then made linear into the row's colour word.

## custom data

custom data (`customData` in the [package](../package-format.md#particles)) is read with the rest of
the particle, each component's curve at its age over its lifetime with its own random value, into
its row's two custom words as f16 pairs (`RowWord.custom`, `packRowCustom`), zero for every other
row. only `effect.wgsl` reads them, by the effect shaders'
[shared rule](../game-data/effects.md#particle-custom-data): the texture stack, refraction, water
sheets and six-way smoke add z to their dissolve schedule and shift each slot's UVs by the slot's
custom scroll (`EffectRow.customScroll`, `fx_custom_shift`) times x for slot 0 or y for the others,
a `particleDisturb` stack scales its distortion by w, and a refraction's spread adds w to its
schedule.

## time and randomness

the game's random sequence can't be reproduced, so particles start elsewhere than in the game with
the same distributions. looping systems are evaluated as if they had played since long before the
package opened; others start when their emitter is first selected, and again when it's selected
after being [forgotten](#particles). particles move by the viewer's animation clock, like the
effects' scrolling textures: they keep moving while the view settles and pause once the viewer idles
([performance](performance.md); `continuous` keeps them moving, and `animate` off freezes them).
