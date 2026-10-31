# environment

how the game decides what a place looks like (sun, sky, fog, clouds, grading), what the packer
stores for it, and how the viewer blends it at the camera. the game has no per-level environment
setting: environment volumes placed in the world apply environment phases, blended by priority
wherever the camera is. a level's "base" environment is something the extractor derives. weather
sits in the same system: it is a section of a phase, not a separate timer. how the renderer turns a
blended profile into pixels is in [lighting.md](lighting.md).

## environment phases

an `HGEnvironmentPhase` (`EnvParse/Env_*.asset`, a MonoBehaviour read through its embedded TypeTree)
is one complete look, stored as a list of `HG*Config` sections. each section carries `m_active`:
whether the phase sets that section at all. an inactive section leaves whatever is under it (a
lower-priority volume, or the scene's global phase) unchanged, even if its own fields hold plausible
values. read sections only after checking `m_active`.

the extractor reads these sections
([`hg/environment-phase.ts`](../../packages/formats/src/hg/environment-phase.ts),
`ENVIRONMENT_SECTIONS`), renamed in the package:

| phase field           | package key     | used by the viewer                                            |
| --------------------- | --------------- | ------------------------------------------------------------- |
| `lightConfig`         | `light`         | sun, exposure, ambient scale, effect directions               |
| `skyConfig`           | `sky`           | ambient SH, reflection cubemap, sky distance                  |
| `atmosphereConfig`    | `atmosphere`    | sky LUTs, fog absorption                                      |
| `fogConfig`           | `fog`           | atmosphere (distance) fog                                     |
| `heightFogConfig`     | `heightFog`     | height fog                                                    |
| `volumetricFogConfig` | `volumetricFog` | volumetric fog, and its own height-fog set used while it's on |
| `cloudConfig`         | `cloud`         | cloud panorama                                                |
| `windConfig`          | `wind`          | packed, not used                                              |
| `lightShaftConfig`    | `lightShaft`    | sun shafts                                                    |
| `colorGradingConfig`  | `colorGrading`  | grading                                                       |
| `autoExposureConfig`  | `autoExposure`  | packed, not used                                              |
| `shadowConfig`        | `shadow`        | sun shadow softness, strength, penumbra ramp, sun-off         |
| `celestialConfig`     | `celestial`     | planets in the sky                                            |
| `starConfig`          | `star`          | star field and nebula                                         |
| `rainConfig`          | `rain`          | rain wetness ([wetness](#wetness)); falling rain isn't drawn  |

other sections the phase has (`snowConfig`, `volumetricCloudConfig`, `lensFlareConfig`, …) are not
extracted. to add one, extend `ENVIRONMENT_SECTIONS` and `mapSections`, the `SECTION_KEYS` map in
[`pack/environments.ts`](../../packages/extractor/src/pack/environments.ts), and the matching
interface in
[`package-format/src/environment.ts`](../../packages/package-format/src/environment.ts).

section values keep the game's field names. colours stay raw (no sRGB decode; HDR colours exceed 1),
because the game feeds them to its shaders raw. `SphericalHarmonicsL2` is 27 numbers, channel-major.
colour curves, `m_*` editor fields and object references other than textures and materials are
dropped; texture references become texture-table ids. material references (the celestial bodies'
draw materials) become the material flattened: shader name, keywords, floats, colours as stored,
texture-table ids and texture scale/offset per slot. the textures that resolve in practice are the
sky reflection cubemap (BC6H), the cloud panorama, its flow map and the cloud-shadow texture.
editor-only previews (`*ForEdit`) are skipped.

## environment volumes

volumes are tag-1 chunk objects (the mono-object rows of InitChunkData, with asset references in the
paired StreamingChunkData; see [world.md](world.md)), not prefabs or LevelData. a volume is repeated
in every cell chunk it overlaps; the extractor dedupes by object id
([`game/environment.ts`](../../packages/extractor/src/game/environment.ts), `loadSceneVolumes`). the
level tag of the entity id says which level owns it (0 = scene-wide).

`HGEnvironmentVolume` component fields
([`endfield/environment-volume.ts`](../../packages/formats/src/endfield/environment-volume.ts)):

| field | type  | meaning                                                                            |
| ----- | ----- | ---------------------------------------------------------------------------------- |
| 0     | int   | `volumeType` (`EnvVolumeType`): 0 global, 1 box, 2 sphere, 3 poly area, 4 cylinder |
| 1     | int   | `blendMode` (`EnvBlendMode`): 0 none, 1 distance, 2 time, 3 manual                 |
| 2     | int   | priority                                                                           |
| 3     | float | blend distance (m)                                                                 |
| 4, 5  | float | fade-in / fade-out duration (s)                                                    |
| 6     | asset | the `HGEnvironmentPhase` (Streaming half only)                                     |
| 7     | blob  | polyline shape                                                                     |

shapes:

- **global**: applies everywhere.
- **box**: a unit cube under the object's transform (position, Euler rotation, scale). it has no
  shape blob.
- **prism** (`PolyArea`): the polyline blob is `u32 byteLength`, `f32×3` position, `f32×3` Euler
  rotation, `u32 n`, `n × (x, z)` relative to the position, an edge BVH, then `f32 height` and
  `f32 baseHeightOffset` as the last eight bytes. points are rotated by the yaw and made absolute at
  parse time. the prism spans `y ∈ [position.y + baseHeightOffset, + height]`; volumes are 3D, so a
  cave volume under a hill doesn't apply on the hilltop.

each scene has one global volume (tag 0). each level typically has one broad polygon or box volume
over most of its ground, often named `*global*`, under dozens of smaller, higher-priority ones for
caves, interiors and set pieces.

Unity post-processing `Volume`s (component `Volume`: `isGlobal`, priority, blend distance, weight, a
`VolumeProfile`) share the same rows; local ones carry a `BoxCollider`. every level has its own
global post volume; local post volumes are read but unused.

## scene states

the extractor reads volumes from the default stream area's chunk files of every scene state. a
volume present in state 0's files always loads; otherwise it loads with any of the MapConfig scene
states whose files hold it. the packer interns that set as the volume's `condition` (an index into
the manifest's conditional sets), and the viewer skips a volume whose condition the selected scene
values don't satisfy. see [scene-states.md](scene-states.md).

## the level's base environment

`resolveLevelEnvironment` picks one volume per level, used as `LevelInfo.environment` and as the
profile the viewer blends over. it samples a 32 m grid (4 × 4 per 128 m level cell) over the level's
`levelGrids`, among volumes the level owns that load with the default scene states:

1. at each sample, the volume shown is the highest-priority one containing it; on equal priority the
   smaller footprint wins. that tie rule is an assumption; the viewer's blend orders equal
   priorities by shape kind instead.
2. the base is the volume covering the most samples among those shown at least once, the lower
   priority on a tie. a volume always beaten everywhere can't be the level's look.
3. without one, the scene's global volume stands in.

heights are ignored here: the vote is 2D, on the volume's footprint. the base phase is then stacked
over the scene's global phase per section (`composeEnvironment`): the level's section if active
there, else the global's if active, else the level's own inactive values. the post profile is the
level's own global `Volume`, else the scene's, highest priority first. its `Bloom`,
`GTAmbientOcclusion`, `Vignette` and `ScreenSpaceReflectionVolume` components go into the profile's
`post`.

every loaded volume counts as enabled during this vote, which is wrong wherever level scripts switch
volumes (see [activation](#activation)). the pack report lists each level's base volume, its
coverage and where it's shown, and which sections were inherited; check it when a level looks wrong.

## package contents

the manifest carries three lists
([`pack/environments.ts`](../../packages/extractor/src/pack/environments.ts)):

- `environments`: composed base profiles (base phase over the global phase, plus the post profile),
  deduplicated by phase and post-profile name. `LevelInfo.environment` indexes it.
- `environmentPhases`: every phase a volume applies, uncomposed, with the list of sections it marks
  active. deduplicated by name.
- `environmentVolumes`: every volume with a shape the packer understands (global, box, prism): name
  without its `#…` suffix, visibility `group` (owning level tag and loading condition), shape in
  world coordinates, blend mode, priority, blend distance, fade durations, phase index (or `null`
  when the phase can't be read; the viewer skips those), and `activation: 'unknown'`.

## blending at the camera

[`render/environment-blend.ts`](../../packages/viewer/src/render/environment-blend.ts) follows the
game's environment manager, which blends `HGEnvironmentPhase`s into an interpolated phase (a
"profile" here is a phase plus the post profile, not a Unity `VolumeProfile`):

- start from the shown level's base profile.
- visit volumes in ascending priority, then shape kind (global, box, prism). each that applies and
  contains the camera blends its phase's active sections in by a factor:
  - **none (0)**: 1 inside.
  - **distance (1)**: distance inside the shape over the blend distance, clamped to 1 (global
    volumes: 1). for a prism the distance is the nearest of the 2D edge distance and the distances
    to the top and bottom.
  - **time (2)**: a per-camera factor that rises over the fade-in duration while inside and falls
    over the fade-out duration after leaving
    ([`EnvironmentFades`](../../packages/viewer/src/render/environment-blend.ts)). a camera move
    over 5 m in one frame (teleports, level switches) snaps the fades, as the game does.
  - **manual (3)**: the game drives the factor from scripts, which aren't recovered. these volumes
    stay off unless ticked in the scene-conditions panel, which previews them at full strength.
- a factor ≥ 1 copies the section. below that, numbers and colours lerp, mode/type fields and
  references switch at ½, and the cloud panorama crossfades through `cloudFadeAlpha` (the old
  texture fades out to ½, the new one in after), as the game's cloud lerp does. the height fog's
  flow noise has its own rule ([flow noise](lighting.md#flow-noise)). the game's per-section lerps
  have more special cases (the precipitation transitions, for one); the generic lerp is an
  approximation.

the "volumes at camera" toggle turns blending off (the base profile alone). a pinned phase replaces
the volume blend with that one phase over the base. per-volume checkboxes override the scene-state
decision either way. `eyeInLevelVolume` moves a level's initial viewpoint along its view line until
the base volume holds it fully and no other level's volume does, because neighbours' volumes overlap
a level's rectangle.

## activation

nothing in the default chunk data says whether a volume starts enabled; the stored rows carry no
enable field. level scripts toggle volumes at runtime (`EnvironmentEnable` actions), and quest-state
volumes (night, battle, destroyed-town looks) sit in the same lists as permanent ones. the package
therefore marks every volume `activation: 'unknown'`, and the viewer treats a loaded, non-manual
volume as enabled and leaves the rest to the user's checkboxes and phase pin.

keep it that way until script activation is recovered. filtering volumes by name (`night`,
`zhandou`, `fight`, …) guesses wrong both ways, and showing an authored state as the default
misrepresents the game more than an honest manual toggle does. examples where all-enabled is visibly
wrong:

- map01's The Hub: a night volume covering the whole map and a destruction-state volume with the
  exact outline of the level's regular volume both outrank it, so the regular look is never shown.
- map02's Snowy Forest: a night-named whole-level volume at a higher priority than the level's
  global one wins everywhere.
- map02's Si's Painting is several disjoint painting worlds, each with its own priority-200 global
  volume, so a single base profile fits only one of them.

## weather

precipitation is part of the environment phase. rain and snow are sections of their own
(`rainConfig`, `snowConfig`), blended with the rest; the game reports "raining" and the current rain
or snow intensity from the phase in effect at the camera. there is no evidence of an independent
weather schedule; a server or random weather controller has not been found.

field rules, from the authored data:

- `m_active` decides whether the section participates in blending. `enable` decides whether
  precipitation is on in that section. `intensity` is an authored 0–100 value. inactive sections can
  hold `enable` = 1 and intensity 100, and disabled sections can keep a nonzero intensity, so
  evaluate the three together.
- wetness is separate (`enableWetness`, `wetness`) and can stay on in a dry section. render it apart
  from falling rain.
- art-named phases carry weather too: Marker Stone's dam-area art phases include an enabled
  heavy-rain phase over the lake islet and dry, disabled-rain overrides at the outposts. a phase
  name is no evidence of what its sections hold.

weather appears in three ways:

- **spatial overrides**: ordinary chunk volumes whose phases enable or disable precipitation, such
  as the Marker Stone lake-islet rain or Snowy Forest's snow with drier cave overrides.
- **dynamic volumes**: LevelData carries an environment-volume table (phase path, bounds and
  transform, priority, blend mode, fades) that `EnvironmentEnable` script actions load and unload.
  these never appear in chunk data, so the packer doesn't see them. Marker Stone's outposts have
  such quest-driven rain volumes at higher priority than the dry outpost phase.
- **shelter**: characters' rain and snow exposure is "sky-exposed and the active phase
  precipitates". that is a gameplay sensor; the renderer's own occlusion for falling precipitation
  is a separate mechanism.

the viewer renders no precipitation, and the packer doesn't extract the snow section. the absence of
rain in the viewer says nothing about whether the game's active phase is dry there.

### wetness

the game's deferred lighting wets every surface it shades (not forward-shaded glass or effects) from
the blended rain section, whether or not rain falls; the viewer does the same in `rain_wet_surface`
([`shaders/frame.wgsl`](../../packages/viewer/src/render/shaders/frame.wgsl),
[`render/wetness.ts`](../../packages/viewer/src/render/wetness.ts)):

- **blend.** with `enableWetness` on both sides, the fields lerp. with it on one side only, the
  result is wet with that side's settings and `wetness` fading in from 0
  ([`environment-blend.ts`](../../packages/viewer/src/render/environment-blend.ts), `lerpRain`).
- **coverage.** full out to the rain occlusion range around the camera (measured as the larger of
  the x and z distances), then fading to `farSceneWetnessValue` by `farSceneWetnessDistanceFactor`
  times that range. surfaces the rain can't reach take `baseWetnessLevel`, and vertical faces
  `verticalWetnessScalar` against 1 for faces looking up.
- **porosity** `= saturate(smoothness · wetnessPorosityFactor + wetnessBasePorosity)`, 1 for metal.
  porous surfaces darken, the albedo down to a quarter at `wetness` 1 (not metal, not faces looking
  down); the smoothness rises towards `mix(0.9, 0.6, porosity) + mix(−0.6, 0.4, √smoothness)`,
  capped at 0.99 and never lowered.
- **standing water.** with `rippleRoughnessMaskThreshold` above 0 (the game's high-quality wetness),
  flat ground facing straight up holds water: its normal turns up and its roughness drops to a
  tenth, a near mirror for the screen-space reflections. it fades out between 15 m and about 80 m of
  view depth, and needs the material occlusion to be high.

not reproduced: the rain occlusion map (a depth map from above that keeps sheltered surfaces at
`baseWetnessLevel`; the viewer treats everything as open to the sky), its range (the presetting
asset holding it wasn't found; the viewer assumes 100 m), the jitter noise that breaks up the
coverage edges, rain ripples and splashes, flowing water on walls, and the geometric-flatness test
that also floods normal-mapped dips. Marker Stone's dam-side volumes keep wetness on at 0.5–1 in
both dry and rainy phases, so its stone floors read wet even without rain.

## open

- script activation of chunk volumes, and the starting state of each; which volumes are permanent vs
  story state.
- extraction of `snowConfig` and dynamic LevelData volumes, and a precipitation render (streaks,
  splashes, ripples, snow) with the game's enable/disable transition rules.
- `volumeType` 4 (cylinder; one map02 waterfall volume, no shape blob) and the game's equal-priority
  order beyond shape kind.
- scenes without levels (indoor and instance scenes) get no environment; their global volume could
  serve.
- local post `Volume`s are read but not applied.
