# quality settings

how the PC client turns a quality preset into render settings, and the per-preset values the topic
pages leave out. those pages describe PC high (level 4000): [shadows](lighting.md#shadows),
[screen-space reflections](lighting.md#screen-space-reflections),
[streaming layers](world.md#streaming-layers), [texture streaming](world.md#texture-streaming),
[fog](sky-and-fog.md#fog), [post-processing](post-processing.md).

## from preset to settings

the settings are TextAssets in the game's initial bundles.

- **device score.** `SettingRules` scores the GPU by name: 500 for an RTX 3080 / 4070 / RX 7800 and
  up, 400 for an RTX 3070 / 4060 / RX 6800 / 7600, 300 for an RTX 3060 / RX 6600–6700, down to 0; an
  unlisted desktop GPU scores 100.
- **level.** `WindowsPlayer_QualityMap` maps the five user presets to a level by score:

  | score    | very low | low  | medium | high | very high | default    |
  | -------- | -------- | ---- | ------ | ---- | --------- | ---------- |
  | 500      | 1000     | 2000 | 3000   | 4000 | 5000      | 5000       |
  | 400      | 1000     | 2000 | 3000   | 4000 | 5000      | 4000       |
  | 300      | 1000     | 2000 | 3000   | 3500 | 5000      | 3500       |
  | 200, 100 | 1000     | 2000 | 3000   | 4000 | 5000      | 2000, 1000 |
  | 0        | 1000     | 2000 | 3000   | 3500 | 4000      | 1000       |

- **tier components.** `WindowsPlayer_QualityTierComponent` lists, per level (5000, 4000, 3000,
  2000, 1000), components that each set one tier or a few values: the pipeline's global tier, and a
  tier of their own for shadows, reflections, ambient occlusion, scene detail, grass sparsity,
  environment rendering, volumetric fog and volumetric clouds. a level that lacks a component takes
  the nearest level's (each component says whether upwards or downwards). on PC every tier equals
  its level, except that 5000 has no shadow or AO component and takes 4000's, grass sparsity is 2000
  from 2000 up, and environment rendering is 3000 from 3000 up.
- **INI sections.** `HGRenderPipelineSettings` includes `CommonSettings`, then the platform class's
  file (`DesktopSettings`; also `MobileSettings`, `ConsoleSettings`, `CinematicSettings`). a
  `[Feature@N]` section applies at tiers of N and up, a higher section overriding a lower one over
  the common base; a default built into the client fills what no INI sets. a component's tier picks
  the sections of its features: shadows `ShadowMap`; reflections `SSR`; ambient occlusion `GTAO` and
  `VisibilitySH`; scene detail `Streaming` and `ArtTags`; grass sparsity `Grass`; environment
  rendering `RainAndWetness` and `VerticalOcclusionMap`. everything else follows the global tier.
  that the fog and cloud components pick `VolumetricFog` and `VolumetricCloud` the same way is
  assumed.

## values by level

desktop values; a blank cell repeats the one to its left.

| setting                                                                 | 1000      | 2000      | 3000             | 4000               | 5000      |
| ----------------------------------------------------------------------- | --------- | --------- | ---------------- | ------------------ | --------- |
| reflections: march steps (`ssrRayMarchingSampleCount`)                  | off       | 16        | 32               |                    | 128       |
| reflections: upsampled to full size (`ssrV2Upsample`)                   | no        |           |                  |                    | yes       |
| cascade tile (`CSMTileResolution`)                                      | 1024      |           | 2048             |                    |           |
| cascade reach, fade start (`CSMMaxDistance`, `CSMFadeInnerDistance`), m | 40, 30    | 50, 40    | 60, 50           | 80, 60 (from 3500) |           |
| character shadow map                                                    | 512       |           | 1024             |                    |           |
| local-light shadow tile, atlas height                                   | 512, 1024 |           | 1024, 2048       |                    |           |
| contact shadows                                                         | off       | on        |                  |                    |           |
| GTAO slices × steps (`GTAOQualityLevel`)                                | 2 × 2     |           | 3 × 3            |                    |           |
| visibility SH range scale                                               | off       | 2         | 3.5              | 5                  |           |
| grass sparsity (`GrassGlobalSparsity`)                                  | 0.8       | 1         |                  |                    |           |
| terrain parallax (`TerrainPOM`)                                         | off       | on        |                  |                    |           |
| erosion blend                                                           | off       |           | on               |                    |           |
| volumetric fog cell (`gridPixelSize`), px                               | off       | 16        | 8                |                    |           |
| volumetric fog source cap (`maxSourceRT*`)                              | —         | 1920×1080 |                  |                    | 2560×1440 |
| volumetric fog samples where history misses                             | —         | 8         | 16               |                    |           |
| local-light shadows in the volumetric fog                               | —         | no        |                  | yes                |           |
| cloud downscale (`downResRatio`), march step scale                      | 2, 2      | 2, 2.5    | 2, 3             |                    | 1.5, 3    |
| light shaft downsample                                                  | 4         | 2         |                  |                    |           |
| lens flare occlusion samples                                            | off       | 8         |                  |                    | 32        |
| rain lighting (`EnableRainLighting`)                                    | off       |           | on               |                    |           |
| water prepass texture                                                   | —         | 512       | 1024 (from 2500) |                    |           |
| effect LOD setting (`settingLodLevel`)                                  | 1         |           | 2                | 4                  | 8         |
| factory entity cull distance, m                                         | 60        |           | 80               |                    | 100       |

the 2000 cells of the last two rows are inherited (the level lists neither); from which side is
unchecked. crowds are capped at 80 NPCs spawned and 50 rendered at 4000, 50 and 50 at 2000, and 40
and 40 at 1000.

the same at every desktop level:

- **resolution.** native render scale with temporal upsampling as the antialiasing (history weight
  0.95, 0.85 in motion; sharpen 0.3); DLSS, FSR and a lower render scale are user choices. the scene
  colour copy is full size.
- **shadows.** three cascades split at 0.15 and 0.375 of the reach (12, 30 and 80 m at high) in a 2
  × 2 atlas of tiles, 16-bit depth, hardware depth and normal bias 3, re-rendered every frame (the
  cascade cache is off) without occlusion culling of casters; casters under 0.005, 0.01 and 0.02 of
  the cascade's view are skipped. the far map reaches 800 m in 256² tiles, renders at most 8 tiles a
  frame and skips casters under 0.01. shadow views pick LODs as the camera does (there is no shadow
  LOD), shadow proxies are on, and the sun's shadow is resolved into a screen-space mask. local
  lights cast shadows only within 200 m, from at most 6 environment and 2 movable casters.
- **reflection march.** the step count falls with view depth, by
  `clamp(2 · e^(−0.07 · depth), 0.125, 1)`, to a floor of 32, so only very high's 128 steps change:
  they hold to about 10 m and reach the floor by about 30 m.
- **local lights.** at most 256 a frame (`PunctualLightMaxCount`; 32 on mobile).
- **culling.** the main view has no small-object cull (`CullingViewScreenSizeMin` 0). the client has
  CPU software occlusion culling against authored occluders at 320 × 160; GPU-driven grass is off.
- **LOD.** LOD streaming is off; the terrain LOD factor is 1200.
- **reflections.** planar reflection stand-ins are on; ray-traced reflections are a separate user
  toggle, off by default.
- **reflection probes** are 512² octahedral maps, at most 3 updated a frame.
- **rain occlusion map**: 512², over 100 m.
- **post.** bloom quality 2, depth of field quality 1, motion blur on, anamorphic streaks at 0.5
  (0.3 at 1000), chromatic aberration from 2000.

the volumetric fog's grid follows from its settings: at most `maxSourceRT / gridPixelSize` cells
across and down (240 × 135 at high), each cell the larger of `gridPixelSize` and what that cap needs
at the render size, and `gridSizeZ` (128) slices. at high that is 240 × 135 × 128 at 1920×1080 and
233 × 134 × 128 at 2560×1600.

## open

- how a shadow map measures a caster's screen size, and whether characters stay out of the third
  cascade (`CSMStopRenderCharacterCascade` 2)
- whether the software occlusion culling runs on PC, whether map data holds its occluders, and what
  its size threshold (0.05) gates
- whether the GPU-driven meshlet renderer the client contains is ever on (it looks gated by launch
  switches)
- the volumetric fog's history weight, and the cloud downscale's meaning (per axis is inferred from
  the name)
- how the LOD bias enters the screen-size test
