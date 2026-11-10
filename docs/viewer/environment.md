# environment

how the viewer blends the environment that [game-data/environment.md](../game-data/environment.md)
describes at the camera, and applies its wetness.

## environment phases

the package's [phase sections](../extraction/environments.md) retain the game's field names. they
feed lighting, sky, fog, post-processing and the rain wetness; `wind` only clocks
[swaying cloth](materials.md#swaying-cloth). the fields the
[game-data page](../game-data/environment.md#environment-phases) can't explain (`cloudFlowType`,
`skyMaterialType`, `reflectionType`, `useCustomIVDefaultSH`, `heightFogConfig.enableVolumetricFog`)
are packed but unread: the cloud panorama never moves, and the PC fog path switches on
`volumetricFogConfig.enable` alone.

## environment volumes

`eyeInLevelVolume` moves a level's initial viewpoint along its view line until the base volume holds
it fully and no other level's volume does, because neighbours' volumes overlap a level's rectangle.

the viewer blends the chunk and [prefab](../game-data/environment.md#prefab-volumes) volumes the
package holds, which leaves out some of the game's
([volumes](../extraction/environments.md#volumes)): cylinder volumes, the volumes of a prefab with a
prism under a moved placement, LevelData's dynamic volumes and local post `Volume`s, so each level
takes only its global post profile. a scene without levels has no environment.

## scene states

the viewer skips a volume whose visibility group's condition the selected scene values don't
satisfy.

## blending at the camera

[`environment/blend.ts`](../../packages/viewer/src/environment/blend.ts) follows the
[game's blend](../game-data/environment.md#blending-at-the-camera). a "profile" here is a phase plus
the post profile, not a Unity `VolumeProfile`.

- start from every section of the [current level's](streaming.md#levels) base phase, inactive ones
  included, plus its post profile; moving into another level's cells switches the base, keeping the
  fades. the scene's global volume and the level's base volume then apply as volumes like any other.
- `planBlend` works out the volumes and factors at the camera, and a key of them; the viewer blends
  the sections (`applyBlend`) only when the key changes.
  [`viewer/environment-state.ts`](../../packages/viewer/src/viewer/environment-state.ts) re-plans
  only when the eye, the volume settings, the condition results or a fade changed, and hands the
  renderers one derived look (environment, celestial layers, lens flare, wetness) per change.
- visit volumes in ascending priority, then shape kind (global, box, prism), then list order. the
  game's order among equal priorities isn't known, so this tie-break is an assumption. the order and
  the shape tests are
  [`package-format/environment-volumes.ts`](../../packages/package-format/src/environment-volumes.ts),
  which the extractor's
  [base-environment vote](../extraction/environments.md#the-levels-base-environment) shares.
- time-mode factors are kept per camera in `EnvironmentFades`, which snaps them after a move of more
  than 5 m in a frame.
- a factor ≥ 1 copies the section. below that, each field blends as the environment table's `schema`
  says ([schema](../extraction/environments.md#blend-schema)): lerp, lerp and round, or switch at ½.
  the cloud panorama, height-fog flow noise, lens flare and rain wetness follow the game's special
  cases. the cloud shadow's crossfade isn't followed (its fields lerp or switch by the schema), and
  `drawCloudAfterPlanet` switches at ½ rather than blending as a weight. the falling rain's case has
  no use while rain isn't drawn, and snow isn't packed.
- where the game's lerp of a plain field isn't known
  ([blending](../game-data/environment.md#blending-at-the-camera)), the viewer picks one that keeps
  the value meaningful: the sun's and every effect's direction lerp as pitch and yaw (the yaw the
  short way round), each effect starting from the direction in effect on its side, so directions
  stay unit vectors; integer counts round (the schema's `round`); a fog whose
  `rayleighScatteringScale` defers to the atmosphere's (negative) takes its atmosphere's scale
  before lerping against one that doesn't.

the "volumes at camera" toggle turns blending by position off: the scene-wide global volumes and the
level's base volume apply fully wherever the camera is, giving the level's own look. a pinned phase
goes over that look instead of the volume blend; the pin offers the phases of the volumes the scene
conditions panel lists for the current level
([listing](scene-states.md#the-scene-conditions-panel)), neighbours' volumes reaching into it
included. `volumeApplies` is the one place that decides whether a volume may apply: it has a phase
and its visibility group's condition holds.

## activation

a volume's group requires its `environmentVolume` control on, alongside its scene states, so the
volume checkboxes are scene controls like any other: picks, "Reset" and level listing work the same
way. the package defaults manual-blend volumes (`blend.kind` `scripted`) off, since the scripts that
drive their factor aren't followed, and every other volume on; a scripted volume that is on applies
at full strength inside it. so story-state chunk volumes count as enabled, which is wrong where the
game keeps them off ([activation](../game-data/environment.md#activation)).

## weather

rain sections apply wherever their chunk or prefab volumes do, so spatial rain such as Marker
Stone's lake islet shows its wetness; quest-driven rain lives in LevelData's dynamic volumes, which
aren't extracted. falling rain and snow aren't drawn, and `snowConfig` isn't packed.

### wetness

`rain_wet_surface` ([`frame.wgsl`](../../packages/viewer/src/render/frame/frame.wgsl), fed by
[`environment/wetness.ts`](../../packages/viewer/src/environment/wetness.ts)) wets the mesh and
terrain surfaces as the [game's deferred lighting](../game-data/environment.md#wetness) does,
standing water included. the one-sided `enableWetness` blend is `lerpRain` in
[`environment/blend.ts`](../../packages/viewer/src/environment/blend.ts), where a profile without a
rain section counts as dry. the rain occlusion map isn't rendered, so every surface counts as open
to the sky, and the coverage range is the occlusion map's 100 m; the coverage edges have no jitter,
there are no ripples or splashes, and walls don't run with water nor normal-mapped dips flood.
