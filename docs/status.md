# status

what the extractor and viewer cover, where they knowingly differ from the game, and what is still
unknown. topic pages carry the detail; this page is the index of gaps. update it in the same commit
that closes or opens one.

map01 and map02 are the tested scenes. a scene listed by `world scenes` is not evidence that it
packs or renders correctly.

## covered

- container-aware asset resolution, conversion workers and the pack cache
  ([extraction](extraction.md))
- one level at a time over shared terrain, with level-owned streaming, LOD and HLOD
  ([world](game-data/world.md), [viewer](viewer.md))
- initial and alternative dynamic structures, active prefab hierarchies and skinned meshes in their
  authored pose ([assets](game-data/assets.md))
- quest, mission and variable state as preview controls, with scene states derived from them and
  dynamic load gates reading them; story progress picked per mission or across the main story;
  progressions, facility visual forms (shops, depots, recycling stations, monitoring terminals),
  Dijiang cabins, tree harvest state, stream areas and script/event groups as controls, each listed
  for the levels it gates; script groups list what sets them in game (quests, switches, areas,
  dungeons), from the level scripts ([scene states](game-data/scene-states.md))
- static stream areas switched by the camera through the game's trigger zones
  ([world](game-data/world.md#stream-areas))
- terrain heights, baked surface pages and the close-up layer blend
  ([world](game-data/world.md#terrain))
- environment profiles and volume blending, water, post-processing, base-bake irradiance and local
  point, spot and tube lights ([environment](game-data/environment.md),
  [lighting](game-data/lighting.md), [water](game-data/water.md))

## look and lighting

- baked GI brightness is unverified against in-game shots; the native ambient scale is missing, and
  the lighting lookup has no jitter or forward-shifted clipmap centres. next: compare GPU clipmap
  samples with the bake at one point, and check clipmap seams (L0 repeats, L1 clamps)
- several ambient and sky-LUT constants are computed in native engine code and not yet recovered
- irradiance: only the base bake is packed; scene-state bakes, partial clipmap updates, the game's
  forward-shifted centres and jitter, fallback textures for cells without probes, the meaning of two
  index tables, and other index magics
- the game's own vignette (the viewer uses URP's); bloom dirt, additive upsampling and character
  bloom; colour curves are not packed
- weather: snow isn't packed and precipitation (streaks, splashes, ripples) doesn't render; rain
  wetness ignores shelter, since the rain occlusion map isn't rendered
  ([environment](game-data/environment.md#wetness)). the weather-script activation and property
  initialization are unknown, so weather stays a manual preview
- environment volume initial enablement and `EnvironmentEnable` script conditions, needed before any
  automatic gating
- volumetric fog: local fog volumes and the volumetric light's flow noise (`enableVLFlowNoise`)
  aren't drawn, and the grid size and history weight are Unreal's defaults rather than the game's
  quality preset. the height fog's [flow noise](game-data/lighting.md#flow-noise) is unchecked on
  water and glass, and its volume blend is read from the height-fog section's and assumed for the
  volumetric one
- local lights ([lighting](game-data/lighting.md#local-lights)): no shadows, shadow-only lights,
  flicker or multiple-scattering term; light beams aren't drawn; lights inside prefabs and dynamic
  structures aren't packed
- the sun may be π too dark against local lights and the game (the two conventions differ);
  unchecked
- interiors, in order of impact:
  - per-instance emission overrides aren't read
  - normal-map roughness is read only when the mesh has tangents; normals are transformed by the
    model matrix rather than its inverse transpose, and every material lights the side facing the
    camera
  - shadow-only proxies are skipped, and off-screen casters reach only 250 m, so the sun can leak
    through roofs they stand in for or past that reach
  - local reflection probes, GTAO in specular occlusion, contact shadows
- the packed tangent frame isn't decoded; tangents are regenerated
- terrain close up: smooth triplanar replaces the game's random plane choice, and the cliff
  projection and cone-map parallax aren't drawn; the blend's GPU cost is unprofiled
- puddles ([world](game-data/world.md#puddles)) stop past the leaf splat pages' load distance,
  ignore the parallax layers' height, and have no ripples
- screen-space reflections ([lighting](game-data/lighting.md#screen-space-reflections)): the rain
  wetness variant's ripple normals aren't drawn, the GPU cost is unprofiled, and off-screen
  reflections fall back to the sky cubemap
- glass ([glass](game-data/lighting.md#glass)): refraction and Fresnel opacity aren't drawn, glass
  in front of water is lost, glass against the sky isn't fogged, and nothing checks whether the game
  lets glass cast shadows
- foliage ([foliage](game-data/lighting.md#foliage)): wind, the grass and card-mesh shaders' own
  GBuffer inputs, trunk ramps and vertex AO, sphere-shadow proxies; decals, layered materials. grass
  and tree grids ([world](game-data/world.md#foliage-grids)) draw every instance at the cluster's
  LOD, without the game's sparsity thinning or per-instance parameters
- Lit layers ([lit layers](game-data/lighting.md#lit-layers)): tri-channel switch textures, the
  parallax glow's global highlight and its world-space, PBR and deform variants, the top layer's
  `_BaseHeightMap` and UV set 2, the noise and parallax mask blends, mask layers on emissive-mapped
  materials, and `_TERRAIN_BLEND`'s fade into the terrain
- erosion rock ([erosion](game-data/lighting.md#erosion)): the soft blend into what lies behind,
  fake translucency, and `HGRP/ErosionDynamic` (only on clearable patches, hidden by default)
- water ([water](game-data/water.md#open)): sector flow tiles (packed but unread), the LOD surfaces'
  displaced wave grid, rain ripples and wetness; other fluid types are unverified
- scene effects ([scene effects](game-data/lighting.md#scene-effects)): only VFXBaseV2, VFXDecal,
  the mist (FogSimple, VFXFakeVolumeFog) and VFXDitherAlpha's plain variant draw, without the first
  two's additive, vertex-offset mask, polar-UV, lighting and particle variants, the effects' own
  fog, the game's global scene-effect colour adjustment (the Jingyu blight reads less saturated than
  in game), the mist boxes' 3D noise or VFXDitherAlpha's dither fade; other effect shaders are
  suppressed rather than drawn opaque. stencil [portals](game-data/lighting.md#portals) draw without
  their masks' own colour and depth, and only where the GPU has `depth32float-stencil8`
- particles ([prefabs](game-data/assets.md#prefabs), [viewer](viewer.md#particles)): billboard
  systems (sparkles, smoke, the crater column's glitter) aren't packed. mesh particles frozen in
  place lose their start colour and take the midpoint of random start values. other mesh systems
  play only without colour, force, noise, sub-emitter and other modules without a closed form, from
  the viewer's own random values, and move only while frames render; per-particle colour and custom
  data never reach the effect shaders. texture sheets play in grid mode only (no sprite lists or
  speed timing), and all copies of one flipbook step in phase. Marker Stone's low mist banks over
  the valley are still missing; their source is unknown. rect decals (`HGRP/DecalLit`,
  `HGRP/TerrainDecalLit`, InitChunkData components 27 and 28) aren't packed
- temporal smoothing of effects
- light shafts ([light shafts](game-data/lighting.md#light-shafts)): the occlusion term and the
  cloud mask aren't drawn; unchecked against an in-game shot facing the sun. the
  [sun disc](game-data/lighting.md#sun-disc) is unchecked against one too
- lens flare ([lens flare](game-data/lighting.md#lens-flare)): polygon elements, inverse SDFs and
  key weights aren't drawn, and the flare component's own settings (when the environment's flare is
  off) aren't known. at Origin Lodespring's overview the viewer's flare is fainter than the game's:
  the crystal mountain behind the sun occludes it in the viewer's depth buffer (the game may not
  write it there), and Unity's random-number mapping is assumed
- the sky's celestial layers are unchecked against in-game shots
  ([beyond the atmosphere](game-data/lighting.md#beyond-the-atmosphere))
- HLOD/detail, LOD and mip swaps pop without cross-fade; ground-blend and decal meshes z-fight
  without the game's depth offsets

## renderer and performance

- GPU culling and indirect draws
- per-cascade shadow caster culling and cascade caching
- terrain pass cost, budget churn in dense areas
- temporal antialiasing sharpening
- per-subtree level masks in the tile tree so traversal skips other levels
- terrain outside the shown level is drawn bare; clipping or dimming it is undecided
- teleport points as viewpoints: where the game stores them is unknown

## coverage and conditional content

- separate scenes (interiors, offices, arenas) are unvalidated
- interactives ([assets](game-data/assets.md#interactives)) draw their model's default pose and
  ignore per-placement component properties and view states (`ModelViewStateControllerData`), so
  doors stay as authored and every state's effects show at once (range rings, lock marks).
  interactives whose model id is missing from the model table, and LevelData with populated blackbox
  settings, are reported in `out/<map>/debug/unsupported-interactives.json` and omitted
- resource nodes (doodad groups) share one level control per level; the game's per-group level and
  its source in LevelData aren't read ([scene states](game-data/scene-states.md#doodad-groups))
- interactive facilities are gathered from levels whose map is the packed scene, so a scene streamed
  by levels of other maps (`base01_lv001`, streamed by `base01_lv003` and `indie_dg014`) probably
  loses their facilities; select levels by `defaultState.exportedSceneConfigPath` instead
- irradiance scene-state bakes are not selected by the active scene states
- variable ids are unnamed; variables that drive entity level or animator state (doors, bridges,
  puzzles: `ModelViewStateControllerData` state machines) aren't controls yet
- scene states that scripts set by name (`SetOverrideSceneState`), LevelData rows created later
  (`createState` ≠ 0), script-driven water levels and map02's sprayable sludge aren't represented;
  the shop, depot and terminal level → visual form mapping, and the resource-node level's link to
  regional development, aren't recovered
- script-group drivers are found from client scripts only: stages, properties and events the server
  sets show as "server", and groups no client script names have none
- story-state expressions and script relationships beyond what client data proves; event and server
  conditions may never be recoverable
- control labels still show internal identifiers or representative mesh names in many places
- animated poses and nonzero blend shapes; vertex-animation-texture meshes (`_vat`, e.g. floating
  rocks) draw their rest pose
- DynamicStreaming entities ignore stream areas (their `VisibleAreaGroup` values aren't read), and
  the game's HLOD-unload triggers aren't decoded
- some mesh/material references are missing from the install's path-hash table. failed exact lookups
  stay explicit

## packaging

- cache material conversion; remember failed conversions so a warm pack starts no worker; skip
  compressing duplicate textures
- the entities pass (~7 s on map02) re-reads every chunk file on a warm pack; it could be remembered
  like terrain and irradiance
- prefab renderers keep only LOD 0, with unbounded thresholds, so prefab content never switches LOD
  or culls by size
- a mesh or material reached both by path hash (static entities) and by object (prefabs) gets two
  table entries and converts twice
- a level's base environment is found by matching phase names; `LevelInfo` could name its volume
- texture zstd level and a max-texture-size option for a lite package (textures dominate package
  size)
- place global scenery by its own bounds instead of pulling it all into `assets/common`
- port the game's path hash so lookups stop reverse-scanning the path-hash table
- move the viewer's environment-agnostic package loading into `package-format` so packer tests read
  packages through the viewer's code
- the terrain shader assumes 65² pages

## open unknowns

- HLOD switch distances (the package uses a placeholder error) and the HLOD material/atlas mapping
- per-controller meaning of progression bit 0 ("unbuilt" versus "level 1")
- weather/time state ids
- runtime: BC texture support in Safari, the texture-array layer limit on Apple GPUs
