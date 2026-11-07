# packing environments

how `pack` turns the game's [environment phases and volumes](../game-data/environment.md) into the
manifest's environment lists ([environments](../package-format.md#environments)), and how it picks
each level's base environment. code:
[hg/environment-phase.ts](../../packages/formats/src/hg/environment-phase.ts),
[game/environment.ts](../../packages/extractor/src/game/environment.ts),
[pack/environments.ts](../../packages/extractor/src/pack/environments.ts).

## sections

the extractor reads these sections of an
[`HGEnvironmentPhase`](../game-data/environment.md#environment-phases) (`ENVIRONMENT_SECTIONS`),
renamed in the package:

| phase field           | package key     |
| --------------------- | --------------- |
| `lightConfig`         | `light`         |
| `skyConfig`           | `sky`           |
| `atmosphereConfig`    | `atmosphere`    |
| `fogConfig`           | `fog`           |
| `heightFogConfig`     | `heightFog`     |
| `volumetricFogConfig` | `volumetricFog` |
| `cloudConfig`         | `cloud`         |
| `windConfig`          | `wind`          |
| `lightShaftConfig`    | `lightShaft`    |
| `colorGradingConfig`  | `colorGrading`  |
| `autoExposureConfig`  | `autoExposure`  |
| `shadowConfig`        | `shadow`        |
| `celestialConfig`     | `celestial`     |
| `starConfig`          | `star`          |
| `rainConfig`          | `rain`          |
| `lensFlareConfig`     | `lensFlare`     |

the light section leaves out the fields the game derives from the others (`DERIVED_LIGHT_FIELDS`:
the precomputed intensities, `forwardDirect`, `localToWorld` and the effects' `rotation*`
quaternions), which some phases carry stale ([sun](../game-data/lighting.md#sun)).

to extract another section (`snowConfig`, `volumetricCloudConfig`, …), extend `ENVIRONMENT_SECTIONS`
and `mapSections` in environment-phase.ts, `SECTION_KEYS` in pack/environments.ts, and the matching
interface in [package-format/src/environment.ts](../../packages/package-format/src/environment.ts).

### values

section values keep the game's field names. colours stay raw (no sRGB decode; HDR colours exceed 1),
because the game feeds them to its shaders raw. `SphericalHarmonicsL2` is 27 numbers, channel-major.
`m_*` editor fields and object references other than textures, materials and lens flare data are
dropped, and so are editor-only previews (`*ForEdit`).

- **textures** become texture-table ids. those that resolve in practice are the sky reflection
  cubemap (BC6H), the cloud panorama, its flow map, the cloud-shadow texture and the flares' images.
- **materials** (the celestial bodies' draw materials) become the material flattened: shader name,
  keywords, every float and colour property the shader declares (the material's value, else the
  declared default; properties left from earlier shaders are dropped, as the
  [material table](../package-format.md#materials) does), and texture-table ids and scale/offset per
  declared slot.
- **lens flares**: the `LensFlareDataSRP` reference becomes the flare's elements
  ([lens flare data](../extraction.md#asset-classes)), each image a texture-table id.

the render pipeline's `HeightFogFlowNoise` texture
([flow noise](../game-data/sky-and-fog.md#flow-noise)) is packed once, as the environment table's
`flowNoise`.

## blend schema

the environment table's `schema` tells the viewer how each section field blends between phases. the
extractor builds it from the fields' TypeTree types (`plainKinds` in
[unity/plain-object.ts](../../packages/formats/src/unity/plain-object.ts)), merged over every packed
phase: floats, colours, vectors and SH lerp; booleans, strings and references (textures, materials,
lens flares) switch at ½; integers round, except those named like an enum (`…Mode`, `…Type`), which
switch. Unity serializes C# enums as plain integers without their type, so that name rule is an
assumption.

## volumes

a volume is repeated in every cell chunk it overlaps; `loadSceneVolumes` dedupes by object id. the
component is decoded by
[endfield/environment-volume.ts](../../packages/formats/src/endfield/environment-volume.ts), which
rotates prism points by the yaw and makes them absolute.

volumes are read from the default stream area's chunk files of every scene state. each is filed
under a visibility group (its owning level and its loading condition; see
[scene states](../game-data/environment.md#scene-states)): its states are collected from every chunk
file it appears in, and any appearance in a state-0 file makes it unconditional. a volume dropped
for its shape or an unknown blend mode, or kept without a readable phase, is listed in
`debug/environments.json`. not packed:

- cylinder volumes (`volumeType` 4): only global, box and prism shapes are understood
- prefab prism volumes under a placement other than the identity
- the dynamic `environmentVolumes` of LevelData, which the interactives reader frames but skips
- local post `Volume`s: read, but only global ones become post profiles

a scene without levels gets an empty environment plan.

## prefab volumes

the packer finds [prefab volumes](../game-data/environment.md#prefab-volumes) by their components
(an `HGEnvironmentVolume` MonoBehaviour on an active GameObject), not by the
`P_lightingDeco_<entity id>_envvolume` name. phases embedded in prefabs are packed like the others.
the level base vote counts a prefab volume only when its placement's visibility holds under the
default scene values ([defaults](scene-controls.md#defaults)).

## the level's base environment

the game has no per-level environment setting, so the "base" environment is something the extractor
derives: `resolveLevelEnvironment` picks one volume per level, which `LevelInfo.environment` names
and whose phase the viewer's blend starts from. it samples a 32 m grid (4 × 4 per 128 m level cell)
over the level's `levelGrids`, among volumes the level owns that load with the default scene states:

1. at each sample, the volume shown is the one stacked on top among those whose footprint holds it
   (a box at its centre's height), in the order the viewer's blend stacks them: `compareVolumes` in
   [`package-format/environment-volumes.ts`](../../packages/package-format/src/environment-volumes.ts),
   whose tie rule among equal priorities is an assumption.
2. the base is the volume covering the most samples among those shown at least once, the lower
   priority on a tie. a volume beaten everywhere can't be the level's look.
3. without one, the scene's global volume stands in.

the vote is 2D, on the volume's footprint, and counts every loaded volume as enabled
([activation](../game-data/environment.md#activation)).

the package doesn't stack the base phase over anything: the viewer seeds its blend with every
section of the base phase, inactive ones included, and the scene's global volume applies over it
like any other. so a section is the level's if active there, else the global's if active, else the
level's own inactive values. that last fallback is an assumption: what the game shows for a section
no applying phase sets isn't known. `composeEnvironment` records the same per-section sources in the
debug index.

the post profile is the level's own global `Volume`, else the scene's, highest priority first; its
`Bloom`, `GTAmbientOcclusion`, `Vignette` and `ScreenSpaceReflectionVolume` components become a
environment table `posts` entry that `LevelInfo.environment.post` names.

the pack report lists each level's base volume, its coverage and where it's shown, and which
sections were inherited, and `world env` explains the choice (voting on chunk volumes only, not
prefab ones); check them when a level looks wrong.
