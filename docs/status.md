# status

what the extractor and viewer cover, where they knowingly differ from the game, and what is still
unknown. topic pages carry the detail; this page is the index of gaps. update it in the same commit
that closes or opens one.

map01 and map02 are the tested scenes. a scene listed by `world scenes` is not evidence that it
packs or renders correctly.

## covered

- container-aware asset resolution, conversion workers and the pack cache
  ([extraction](extraction.md))
- a scene's levels shown together over shared terrain, streaming around the camera, then the current
  level ([world](game-data/world.md), [streaming](viewer/streaming.md#levels))
- static and dynamic stream areas switched by the camera through the game's trigger zones
  ([world](game-data/world.md#stream-areas))
- terrain heights, baked surface pages and the close-up layer blend ([terrain](viewer/terrain.md))
- initial and alternative dynamic structures, active prefab hierarchies and skinned meshes; looping
  clips of interactives' settled view states and of prefabs' own Animators (skinned and rigid
  renderers, ACL-compressed or not); spinning ECS scenery ([assets](game-data/assets.md),
  [animation](game-data/animation.md))
- quest, mission and variable state as preview controls, with scene states derived from them and
  dynamic load gates reading them; story progress picked per mission or across the main story;
  progressions, facility visual forms (shops, depots, recycling stations, monitoring terminals),
  Dijiang cabins and Control Nexus level (region walls), doors, telescopic bridges, campfire
  activation, blight with its cores, outpost upgrade missions as outpost levels, tree harvest state,
  stream areas and script/event groups as controls, each listed for the levels it gates. script
  groups list what sets them in game (quests, switches, areas, dungeons), from the level scripts,
  follow the quests their scripts check when they run, and follow the camera where a script swaps
  them as the player enters and leaves a spherical trigger volume; so do looks that the player's
  presence changes ([scene states](game-data/scene-states.md),
  [scene controls](extraction/scene-controls.md))
- environment profiles and volume blending, spatial rain, water, post-processing, baked irradiance
  with its scene-state bakes (plus the bakes of Dijiang's rooms with a cabin built) and local point,
  spot and tube lights ([environment](game-data/environment.md), [lighting](game-data/lighting.md),
  [water](game-data/water.md))
- scene effects in six effect shaders, mist, six-way smoke, portals, and particle systems with their
  custom data ([effects](game-data/effects.md), [particles](viewer/particles.md))

## lighting and post-processing

- baked GI ([irradiance](game-data/irradiance.md), [ambient](game-data/lighting.md#ambient)):
  brightness is unchecked against in-game shots; the native scalar on all diffuse ambient, the
  specular ambient's scale (taken as `indirectSpecularFactor`) and the volume's default SH aren't
  recovered ([open](game-data/lighting.md#open)); the lookup has no jitter or forward-shifted
  clipmap centres, and levels refill whole rather than partially. next: compare GPU clipmap samples
  with the bake at one point, and check clipmap seams (L0 repeats, L1 clamps)
- irradiance ([viewer](viewer/lighting.md#irradiance-volume)): room bakes reach only the finest
  clipmap; which [scene-state bake](game-data/irradiance.md#scene-state-bakes) applies is inferred
  from the bakes, not read from the game's native selection; the index's pair table, trailing rows,
  three directory words and other index magics are unread
- the sun may be π too dark against local lights and the game (the two conventions differ,
  [open](game-data/lighting.md#open)); unchecked
- local lights ([lighting](game-data/lighting.md#local-lights)): no shadows (on surfaces or in the
  volumetric fog), cookies, flicker or multiple-scattering term; directional, shadow-only and
  character-only lights aren't packed; the per-frame cap is the game's maximum of 256, since its
  quality cap isn't recovered; [light beams](viewer/effects.md#light-beams) lack their 3D noise, a
  per-renderer scale and a global tint, and aren't checked against an in-game shot
- interiors, in order of impact:
  - per-draw emission overrides set at runtime by scripts aren't known
    ([emission](#surfaces-and-terrain))
  - meshes without tangents draw their normal map flat (what the game's bump does there is
    unchecked); normals are transformed by the model matrix rather than its inverse transpose, and
    every material lights the side facing the camera
  - off-screen casters reach only 250 m, so the sun can leak past that reach, and `_ShadowCullMode`
    isn't read
  - outside the game's sun-off volumes, rooms get the outdoor sun wherever no drawn geometry shadows
    them. map02's 61 `shadowOC_CAVE_*` entities (InitChunkData component 61,
    [world](game-data/world.md#initchunkdata-layout)) are likely the game's cave shadow occluders;
    they aren't packed and what they do is unchecked
  - local reflection probes (placements not found), GTAO in specular occlusion, contact shadows; the
    AO multi-bounce fit uses the albedo's luminance rather than each channel, and the specular
    ambient falls back to the ambient probe until the reflection cubemap streams in
  - the far shadow layer filters with a 3×3 bilinear grid rather than the game's tent, and acne is
    biased by a normal offset rather than the game's push towards the sun
    ([shadows](viewer/lighting.md#shadows))
  - GTAO takes normals from depth and one depth-aware blur instead of the game's temporal and two
    spatial filters ([ambient occlusion](viewer/post-processing.md#ambient-occlusion))
- the packed tangent frame isn't decoded; tangents are generated (MikkTSpace) from a UV set
- screen-space reflections ([lighting](game-data/lighting.md#screen-space-reflections)): the rain
  wetness variant's ripple normals aren't drawn, and the GPU cost is unprofiled
- auto exposure can sit off in-game shots where characters or effects the viewer doesn't draw would
  count ([auto exposure](game-data/post-processing.md#auto-exposure))
- the vignette's extra mode and fields (the viewer draws URP's); bloom's compute-shader variant,
  dirt, additive upsampling, character bloom and anamorphic stretch; colour curves aren't packed
  ([post-processing](viewer/post-processing.md))
- light shafts ([light shafts](game-data/post-processing.md#light-shafts)): the occlusion term and
  the cloud mask aren't drawn; unchecked against an in-game shot facing the sun. the
  [sun disc](game-data/sky-and-fog.md#sun-disc) is unchecked against one too
- lens flare ([lens flare](game-data/post-processing.md#lens-flare)): polygon elements and inverse
  SDFs aren't drawn; the flare component's own settings (when the environment's flare is off) aren't
  known, so no flare draws then; per-light curves take SRP core's directional-light defaults, and
  Unity's random-number mapping is assumed. at Origin Lodespring's overview the viewer's flare is
  fainter than the game's: the crystal mountain behind the sun occludes it in the viewer's depth
  buffer (the game may not write it there)

## environment, sky and fog

- environment volume initial enablement and `EnvironmentEnable` script conditions, needed before any
  automatic gating: every loaded, non-manual volume counts as enabled, which is visibly wrong at The
  Hub (night and destruction volumes) and Snowy Forest (night volume), and the base-environment vote
  is wrong wherever level scripts switch volumes. cylinder volumes (`volumeType` 4) and prefab
  prisms under a non-identity placement are dropped (listed in `debug/environments.json`), local
  post `Volume`s are read but not applied, `world env` votes on chunk volumes only, and scenes
  without levels get no environment ([viewer](viewer/environment.md#environment-volumes))
- environment phases ([environment](game-data/environment.md#environment-phases)): `windConfig`
  drives only the [wind clock](viewer/materials.md#swaying-cloth) (wind motors aren't read), and
  `snowConfig`, `volumetricCloudConfig` and other sections aren't extracted. the blend's rules for
  directions, integers and the fog's deferred Rayleigh scale are the viewer's
  ([blending](viewer/environment.md#blending-at-the-camera)). packed but unread: the cloud flow
  (`cloudFlowType`, `cloudFlowMap`, `flowSpeed`, so the panorama never moves), `skyMaterialType` 1
  and its `skyboxCubeMap` (three boss phases), `reflectionType`, `useCustomIVDefaultSH` and
  `heightFogConfig.enableVolumetricFog` (the PC fog path switches on `volumetricFogConfig.enable`
  alone) ([viewer](viewer/environment.md#environment-phases))
- weather ([weather](game-data/environment.md#weather)): spatial rain applies with its volumes, but
  quest-driven rain lives in LevelData's dynamic volumes, which aren't extracted (and what starts
  their scripts is unknown); snow isn't packed and falling precipitation (streaks, splashes,
  ripples) doesn't render. rain wetness ignores shelter, since the rain occlusion map isn't
  rendered, assumes a 100 m occlusion range, and has no jittered coverage edges, water running down
  walls or flooding of normal-mapped dips ([wetness](game-data/environment.md#wetness))
- sky ([sky](game-data/sky-and-fog.md#sky)): the sky-view LUT's ground bounce and the procedural
  sky's colour adjustment (`_VFXParams1`) aren't drawn; at Power Plateau's overcast the sky stays
  15–20 sRGB levels brighter than the in-game shot, while Wuling's matches
- the sky's celestial layers
  ([beyond the atmosphere](game-data/sky-and-fog.md#beyond-the-atmosphere)) are unchecked against
  in-game shots: sky planets are always added rather than blended by their `_BlendMode`, stars
  aren't thinned behind their rings, the ray-traced planet takes the viewer's sun as its light, and
  the moon's sky-wide ring (`HG_RING`) and the aurora aren't drawn
- volumetric fog ([fog](game-data/sky-and-fog.md#fog)): local fog volumes and the volumetric light's
  flow noise (`enableVLFlowNoise`) aren't drawn, the grid size, slices per doubling and history
  weight are Unreal's defaults rather than the game's quality preset, and its sky term lacks the
  native diffuse-ambient scale. the height fog's [flow noise](game-data/sky-and-fog.md#flow-noise)
  is unchecked on water and glass, and its volume blend is read from the height-fog section's and
  assumed for the volumetric one

## surfaces and terrain

- emission ([emission](game-data/materials.md#emission), [viewer](viewer/materials.md#emission)):
  `_EMISSIVE_ANIM_SWEEP`'s moving band isn't drawn (colours that glow only inside it stay dark,
  steady ones glow), so `_EMISSIVE_NOMAP` emits nothing; flicker and the emissive map's scroll
  (`_EmissiveSpeed`; Dijiang's shaft cargo rings) are drawn still, the pulse stops on looks with a
  parallax glow or layer, and the emission Fresnel term is left out. of the per-draw emission
  overrides, only prefabs' `AnimationProperties_Emissive` resting colour is read: its breathing,
  albedo tint and an `EntityRenderHelper` target aren't, nor are overrides other scripts set at
  runtime
- glass ([glass](game-data/materials.md#glass)): refraction, Fresnel opacity, planar reflections and
  subsurface scattering aren't drawn; overlapping layers share one fog distance; premultiplied glass
  is read from the blend state, and whether the game lets glass cast shadows is unchecked
- foliage ([foliage](game-data/materials.md#foliage), [viewer](viewer/materials.md#foliage)): wind,
  the grass's per-instance colour and terrain albedo blend (`_BLEND_TERRAIN_ALBEDO`), the card LOD's
  normal decoding (so it takes neither the bend nor the masks), trunk ramps and vertex AO (trunks
  take only Lit's texture layout, so no detail map or layers), `TreeFoliageCardMeshLod`'s own inputs
  (shaded as plain alpha-tested foliage), the card LODs' view and height culling, sphere-shadow
  proxies, the vertical-normal AO boost, broadleaf indirect transmission and contact shadows. grass
  and tree grids ([terrain](viewer/terrain.md#foliage-grids)) draw every instance at the cluster's
  LOD, without the game's sparsity thinning; the cluster LOD measure (`rendererHalfSize`), the
  per-instance parameters and column 7 aren't read
- Lit layers ([lit layers](viewer/materials.md#lit-layers)): `HGRP/LitEffect` (98 map02 materials)
  draws as Lit without dissolve and disturb; the tri-channel mask on MRO-layout materials, G and B
  of its switch-texture variants, `_UseMaskRUVSetAndTilingScale`, the parallax glow's separate mask
  (`_UseParallaxMask`; those don't glow), global highlight and world-space, PBR and deform variants,
  matcaps (the campfires' crystal glows without its sheen), mask layers on emissive-mapped materials
  and with noise or parallax, the top layer's `_BaseHeightMap` (read as grey) and `_TERRAIN_BLEND`'s
  fade into the terrain aren't drawn
- other surface keywords the viewer ignores, listed per material in `debug/assets.json`
  ([unsupported materials](viewer/materials.md#unsupported-materials)), on map02:
  `_MACRO_NORMAL_MAP` (92 materials), `_SUBSURFACE*`, `_FAKE*` (glints, cracks, dust, volume,
  refraction), interior parallax and mapping, `_ZWRITE_OFF`, Lit's `_USE_VERTOFFSET` (the balloon
  tube's wobble), and vertex animation other than `HGRP/Lit`'s
  [swaying cloth](viewer/materials.md#swaying-cloth) (`_SIMPLE_VERTEXANIM_PENDULUM`, `…_ROPE`,
  `HGRP/LitTransparent`'s cloth, `_VAT_*`, `_COMMONVAT_*`, `_GPU_CLOTH`, `_MOVING_BAMBOO`). the
  cloth sway is unchecked against an in-game shot
- shaders without a look, shown as [unsupported](viewer/materials.md#unsupported-materials) and
  counted per shader by `pack`: on map02 `Hidden/HGRP/Effect/VFXInkWashPaint`,
  `HGRP/Effect/VFXRadialBlur`, `HGRP/CharacterNPR` and `…_VFX`, `Hidden/HGRP/LitEffectBlend`,
  `HGRP/Effect/VFXTransparentDepthOnly`, `HGRP/Foliage/Glow` and the factory placement and outline
  shaders
- forward Lit ([viewer](viewer/materials.md#forward-lit)): the golden treasure chest reflects the
  scene instead of its own `_CUSTOM_IBL` cubemap; the shader's other variants aren't decoded
- matte paintings ([viewer](viewer/materials.md#matte-paintings)): `_UseMainTexAsAlpha` isn't read
  (no map01 material sets it)
- erosion rock ([viewer](viewer/materials.md#erosion)): the soft blend into what lies behind
  (`_ObjectBlend*`) and fake translucency aren't drawn; `HGRP/ErosionDynamic` (only on clearable
  patches, hidden by default) has no look and shows as unsupported
- decals ([decals](viewer/materials.md#decals)): `HGRP/DecalLit`'s wetness, sludge, footprint,
  UV-noise and arc variants, and placements without their colour and UV, show as unsupported;
  overlaps ignore `_DrawOrder`; decals that write no albedo relight the surface from an estimate of
  its colour, as a dielectric, leave its screen-space reflections, ambient occlusion and metallic as
  they were, and add their emission over the surface's; under a laid-over decal that doesn't write
  them, the surface's occlusion and metallic are taken as 1 and 0. terrain decals (InitChunkData
  component 28) aren't packed and `HGRP/DecalUnlit` has no look; prefabs' `HGDecalProjector`s (20
  and 18 on the Qingbo waterwheels' prefabs) aren't read, and their drop isn't reported in `debug/`
- terrain close up ([terrain](viewer/terrain.md#close-up-layers)): smooth triplanar replaces the
  game's random plane choice; the cliff projection, cone-map parallax and the `A` page's subsurface
  curvature aren't drawn; the fade distances are the viewer's own and the blend's GPU cost is
  unprofiled. terrain LOD uses the viewer's own sample-spacing rule, since what the game uses
  `maxHeightError` for isn't known ([streaming](viewer/streaming.md#terrain-selection))
- puddles ([terrain](viewer/terrain.md#puddles)) stop past the leaf splat pages' load distance,
  ignore the parallax layers' height, and have no ripples
- HLOD/detail, LOD and mip swaps pop without cross-fade; ground-blend and decal meshes z-fight
  without the game's depth offsets (the viewer applies none)

## water

- water ([viewer](viewer/water.md#shading)): sector flow tiles and the rain map are packed but
  unread (flow and foam come from the global map); the LOD grid's wave displacement, rain and
  character ripples and ground wetness around water aren't drawn. LOD surfaces face up at every
  distance, where the game shades them around their mesh normals beyond its grid's reach
  ([how surfaces are drawn](game-data/water.md#how-surfaces-are-drawn)), and back faces are drawn,
  where the game culls them. `FlowmapOption` 1's coverage mask isn't applied, the sun highlight
  isn't aimed at the nearest point of the sun's disc and has no multiple scattering, configs sharing
  a `materialIndex` keep their own looks where the game gives both the last loaded's, and effects
  below the surface show over it, unchecked against the game
- [foam boxes](viewer/water.md#foam-boxes) (`HGRP/WaterDecal`) ignore their per-placement
  `HGWaterDecalRenderer` values (neutral on every map02 prefab) and their displacement; which depth
  the game tests them against is unconfirmed, their variants beyond `_USE_DISTURB`, `_USE_MASK`,
  `_USE_SOFTBLEND` and `_USE_DISSOLVE`, and those with a `_ZTest` other than 4 or 5, show as
  [unsupported](viewer/materials.md#unsupported-materials) (2 of map02's 22), and the Wuling falls'
  foam is unchecked against an in-game shot; map02's 248 static boxes (InitChunkData component 31,
  [world](game-data/world.md#initchunkdata-layout)) aren't packed, counted in
  `debug/skipped-entities.json`; other fluid types are unverified
- water volumes ([viewer](viewer/water.md#water-volumes)): volumes without a `WaterConfig` of their
  own draw with their water type's surface prefab config, but without its foam decal or per-level
  multipliers ([game data](game-data/water.md#water-volumes)); moves are linear; floaters keep their
  authored height and don't lag; `ground_distance`, flow and amount transfers aren't read; volumes
  coinciding with a placed surface draw twice, unverified against the game; Suiming's lily pads end
  0.9 m under the pit's surface at the first stage, as the data says, unverified in game; no
  shoreline wetness. [pumped pools](game-data/water.md#depletable-pools) offer only empty, authored
  and full, not the fills between that a pump can stop at; whether the server's starting amount
  always equals the authored one, and whether an empty pool's surface still draws in game, aren't
  checked
- waterfalls missing: Jingyu's pool falls (near unity −763, 209, −1190) and the small cascades
  beside it show white in game, but the viewer's VFXWater sheet there sits inside the rocks in front
  of it, and the steep river surface running down the lip draws as clear water. what the game draws
  there is unknown; the leads are the static foam boxes (component 31) and the steep segment's own
  mesh normals

## effects and particles

- scene effects ([scene effects](game-data/effects.md), [viewer](viewer/effects.md)): drawn are
  VFXBaseV2, VFXDecal, VFXDitherAlpha, VFXRefract, VFXWater sheets, six-way smoke and the mist
  (FogSimple, VFXFakeVolumeFog). other effect shaders (VFXAdvance, …) and these shaders' undrawn
  variants show as [unsupported](viewer/materials.md#unsupported-materials)
  - VFXBaseV2 and VFXDecal: additive blend states, `_BlendMode` 2 outside a multiplying blend or
    with a stencil, opaque blending with a stencil, a soft blend or an edge colour (opaque layers
    are fogged by the composite and the falling gravel is unchecked in game), the sixth sample
    texture alongside a vertex offset, a vertex offset mask alongside all five other sample
    textures, object-relative screen UVs, brightening that is a scan line or centred on a fixed
    point (the player-centred one is left out), rigid-body, fluid and particle vertex animation,
    soft bodies that are lit, take a Fresnel term or a vertex offset, or play from particle data
    (the Aurelyne blob is unchecked in game), [water blending](game-data/effects.md#water-blending)
    (fragments below the authored height show the checker; the height a water surface would set
    isn't followed), VFXDecal's `_USE_IN_PARTICLE`, lighting, parallax and 3D-texture variants, and
    local lights and the post-exposure division on lit effects
  - VFXBaseV2's breathing pulses every placement in step (per-draw time scale and offset untraced);
    Dijiang's clue board and the aisle-guide panels' edge colour are unchecked in game
  - VFXDitherAlpha's effect variants blend rather than dither and write no depth; lit ones, other
    dither modes and non-red masks stay unsupported; the plain variant's dither leaves out the
    vertex alpha and the near-camera fade, and `_USE_MAIN2` draws only as a mask. the Very Large
    Rift's escaping trails are unchecked in game
  - [VFXRefract](game-data/effects.md#refraction): its blend, saturation, spread, Fresnel mask and
    trail aren't drawn, its scene copy includes the water and fog (unchecked against the game's),
    and on meshes it ignores the second UV set the game reads as custom data; Deep Dale Street's
    fog-wall haze and the balloons' glitch are unchecked in game
  - VFXWater: `VFX_WATER_REFRACT`, `_VAT_SOFTBODY`, punctual lights, matcaps, and
    `VFX_WATER_SIMPLE_LIGHT`'s probe (lit the full way instead)
  - [six-way smoke](game-data/effects.md#six-way-smoke): no shadow ramp texture, local lights or
    main texture; a mask or dissolve on UV set 1 stays unsupported on meshes; unchecked in game
  - [mist](game-data/effects.md#mist): lit cards light by the mesh normal rather than their normal
    map, the cards' own fog and the boxes' depth prepass and vertex colour aren't drawn, and only
    additive boxes draw; Suiming's cave-exit light card is unchecked in game
  - across effects: the game's global scene-effect colour adjustment (`_VFXParams1`, set natively;
    the Jingyu blight reads less saturated than in game)
  - stencil [portals](game-data/effects.md#portals) draw without their masks' own colour and depth,
    support only keep and replace, and need `depth32float-stencil8`
- [reflection-only effects](game-data/effects.md#reflection-only-effects) aren't drawn, as in the
  game, but don't write the normal, roughness and depth the reflections march from either. next:
  compare the reflections behind the Very Large Rift's portal ring with an in-game shot
- effect distance bands ([effect LOD tables](game-data/effects.md#effect-lod-tables)) switch without
  the game's fade; a billboarded renderer's offset from the effect's origin doesn't turn with the
  camera; only prefab renderers take them (whether static scenery has banded effects is unchecked);
  the quality half of an entry (`settingLodLevel`, `platformLayer`) is ignored, as for the highest
  preset; a band an entry has no info for is read as on (unchecked)
- particles ([particle systems](game-data/effects.md#particle-systems),
  [viewer](viewer/particles.md#particles)):
  - frozen mesh particles lose their start colour and their drift and spin over lifetime (a held
    particle goes on moving in game), and take the midpoint of random start values
  - played systems ignore the noise, collision, trigger, sub-emitter, light, trail and by-speed
    modules, use the viewer's own random values and move only while frames render (so the fish
    school circles without its noise's wobble); all copies of one flipbook step in phase
  - stand-ins at the emitter: systems that don't play on awake; a start delay, rate or drag curve; a
    per-axis speed limit or one alongside drag; speed-modifier curves alongside drag; force fields
    alongside drag, other than spheres or with a vector field; shapes other than sphere, hemisphere,
    cone, box, circle, donut and mesh (map02's 16 single-sided edge and 2 box-edge systems); mesh
    shapes with a shape texture, edge placement in Loop or PingPong, or quads, points or lines mixed
    with triangles; sprite-mode sheets, sheet time modes other than lifetime or frames per second,
    sheets over 64 tiles a side
  - approximations: drag slows only the start velocity and the fall; orbits turn the whole path
    (exact only along the orbit's axis); force fields push only from within the system's own prefab
    (no wind zones or scene fields); a particle replaying a ring buffer's loop range replays its
    path; `Facing` turns to the camera's plane like `View`; velocity-aligned billboards roll by the
    viewer's choice; vertex Loop and PingPong mesh shapes pick at random for bursts and count the
    rate's emissions from the start delay (when the game's count restarts isn't traced); cones and
    circles ignore the arc's mode and spread (about 20 map02 systems set one), sphere and hemisphere
    arcs aren't applied; stretched quads ignore the camera's velocity (no map02 system scales by
    it), the freeform mode and an `m_NormalDirection` below 1
  - limits: at most 1024 live particles per emitter (two map01 systems can hold up to 1201), bounds
    that a ring-buffered particle moving far past its lifetime can outrun, colours clamped to 1
    (RGBA8), custom data in colour mode isn't packed (no map02 system uses it)
- [spline movers](game-data/effects.md#spline-movers) (Dijiang's shaft cargo) take their lifetime
  span as the spline's length over the speed (unverified) and draw each LOD group's renderers at the
  group's origin; those with noise, rotation over lifetime, an alpha fade, a speed or lifetime
  curve, an emission type other than the box, or more than four LOD groups stand in
- temporal smoothing of effects: moving particles, scrolling and animated effects have no motion
  vectors, and transparent layers write no depth, so the temporal antialiasing reprojects them by
  the opaque scene behind ([frame](viewer/frame.md)). the game's effect variants carry
  `HG_ENABLE_MV`; how the result differs on screen is unchecked
- Marker Stone's low mist banks over the valley are missing; their source is unknown
- seen through glass, distant alpha-blended effects vanish: the transparent pass's
  [weights](viewer/materials.md#glass) favour near layers so steeply (at most 100×) that a pane 10 m
  away swamps an effect kilometres behind it, where the game sorts the two and draws the glass over
  it. from Dijiang's exterior deck (unity 0.9, 10, −110.5) its glass hides the corroded planet's
  plume (`P_fxmap_base01_lv001_planetcorrode_01`), which shows once the glass is hidden or from
  outside

## scenes and conditional content

### world and streaming

- separate scenes (interiors, offices, arenas) are unvalidated
- the game's HLOD-unload volumes (`FBStreamArea` root slots 7–9) aren't decoded
  ([world](game-data/world.md#stream-areas)). the viewer follows the game's HLOD rings at its
  highest preset but measures them in 3D to the tile's bounds rather than in XZ from the player,
  keeps HLOD2 drawn past 2048 m, and doesn't apply the other layers' radii (`Tiny`, `Lighting`, …),
  since an entity's layer isn't known ([streaming layers](game-data/world.md#streaming-layers))
- dynamic structures load by their game grid's block around the camera rather than the player,
  without the ~10 m unload hysteresis or the per-row radius test (which the shipped radii almost
  never fail); facilities and Dijiang's cabin scenes, which no `fb_main` grid stores, still draw
  within `detailDistance` of their tile
  ([dynamic load grids](game-data/world.md#dynamic-load-grids))
- HLOD clusters never stand in for global content, which always draws, so wherever a cluster covers
  global scenery both draw until its tile refines
  ([instance selection](viewer/streaming.md#instance-selection)); in indie_dg005 every static
  renderer is global. making it refinable needs each entity's streaming layer, whose storage isn't
  found ([LOD and HLOD](game-data/world.md#lod-and-hlod)). HLOD tiers whose grid sits half a cell
  off the tile tree (indie_dg005, dung02_dg002's HLOD1) are filed under one of the two tiles each
  cell straddles ([tile tree](package-format.md#tile-tree))
- billboards turn only mesh renderers; skinned meshes and particle systems under a `VFXBillBoard`
  stay as authored; a renderer away from the `VFXBillBoard`'s origin turns in place instead of
  swinging around it, and modes 2–3 turn about the world's vertical rather than their own up, so
  tilted placements face wrong ([billboards](game-data/assets.md#billboards))
- the AIC buildable-grid data (`factorygrids/fbgrids_*.bytes`, a FlatBuffer of per-1 m column height
  spans and buildable/water flags on the 128 m cells) has no decoder
- some mesh/material references are missing from the install's path-hash table; failed exact lookups
  stay explicit (the report counts hashes without a path)

### interactives and animation

- interactives ([interactives](game-data/interactives.md)) with view states draw the pose their
  state machines settle in from the placement's starting `state`, ignoring its other component
  properties; a `state` the server or a level script sets later isn't followed. of the floats
  components set before view states start, only a vertical rope's `RopeLength` is read; of
  `VFXAdjustLength`, only scale targets and tiling (a component switching anything else boxes its
  prefab), and a `PositionFollower` holds its walk position under a looping clip.
  [one-shot effects](game-data/effects.md#one-shot-effects) and transitions' bursts (the talosites'
  activation) aren't drawn. looping effects that rest looks' states play are
  ([effects at rest](extraction/prefabs-and-interactives.md#effects-at-rest)), but not doors',
  bridges' or facility forms'; that a non-persistent effect ends with its state is assumed, effects
  on a looping clip's GameObjects hold its end pose, and of the effects components place themselves
  only the jump pad's arrow and the vertical jump pad's vent are drawn, unchecked against an in-game
  shot. a settled loop clip moves skinned bones and the Transforms of mesh renderers, including ones
  under its bones, but not billboarded renderers or particle systems; its material values and
  GameObject switches hold their end values
  ([looping clips](extraction/prefabs-and-interactives.md#looping-clips)). every placement plays in
  step from the viewer's clock (the game's start per placement is unknown), the animation moves only
  while frames render, each moving renderer stores every frame of its own, and the balloon's sway is
  unchecked against an in-game shot
- facility visual forms settle with every key false. looks the player's presence changes follow the
  camera ([keys the player sets](game-data/interactives.md#keys-the-player-sets)); a campfire's
  `InZone` sphere uses the template's 2.5 m radius, not the runtime radius the game swaps in once
  inside, and `Distance` is assumed a plain 3D distance. `InBattle` and `isDead` stay false
- two-state interactives preview both states, since what switches them in game (a level script
  reacting to a mission's cutscene, the server) isn't followed: doors draw open or closed
  ([interactive doors](game-data/interactives.md#interactive-doors)), closed by default except a
  Dijiang cabin's; campfires draw not activated or activated
  ([campfires](game-data/interactives.md#campfires)), activated by default, without their fight look
  or the colour layer's VAT clips; a template's saved Animator bool (The Hub's comm terminal,
  `fixed`) draws unset or set
  ([template animator parameters](game-data/interactives.md#template-animator-parameters)), set by
  default, and int and trigger parameters aren't set; telescopic bridges draw retracted or extended
  ([telescopic bridges](game-data/interactives.md#telescopic-bridges)), retracted by default
- level scripts' own interactives (indie_race001's moving platforms and coins, open-world event
  pieces) aren't placed: they exist while their script runs, and which scripts the server starts
  (the player's distance to its start shape, missions, activities) isn't known from the data
- [auto-moving platforms](game-data/interactives.md#auto-moving-platforms) ride their splines from
  the viewer clock's zero, and drop no overshoot at the end of a loop. ones that turn along the
  curve, wait at knots, ease, or stop at their target stay at their placement
  (`unsupported-interactives.json`); effects, particles and billboards on a moving platform stay
  behind; other curve movers (coins, butterflies, kickable balls), which scripts start, hold still
- [crane towers](game-data/interactives.md#crane-towers) draw their placement's starting steps, with
  the container hung from the hook; the steps the player's operations save on the server aren't
  offered as controls
- interactives with a mini-game or submit lock draw their model's locked look
  ([gameplay locks](game-data/interactives.md#gameplay-locks)); the unlocked look the player's
  repair saves on the server isn't offered as a control, and the effects a lock mounts on the model
  aren't drawn
- rows created later (`createState` ≠ 0) draw only with their level's "created during play" toggle,
  off by default; one toggle covers a level's rows, since which of them the server or a script
  creates isn't followed
- interactives whose model id is missing from the model table, templates without a data file of
  their own (weapon-wall racks, some doors), templates where zero or several positions frame the
  variant table, door models with an ambiguous open-idle state (not drawn as doors), and LevelData
  with any populated field or condition the reader doesn't implement (the blackbox scenes' blackbox
  settings; the placement reader decodes no LevelData members after the interactive list, and
  gameplay locks and splines come from decoding the whole file, which fails for Dijiang's) are
  reported in `out/<map>/debug/unsupported-interactives.json`; those whose template or model wasn't
  found are [stand-ins](package-format.md#stand-ins), the rest omitted
- skeletons the reader can't pose and nonzero blend shapes (meshes with them are stand-ins);
  characters' skeletal animation isn't played. prefab
  [scenery animators](game-data/animation.md#scenery-animators) play their controllers' settled
  states; a looping clip's material values and GameObject switches hold their end values, and each
  moving renderer stores every frame (Qingbo's octagonal waterwheels: 44 renderers × 1500 frames).
  of [ACL-compressed clips](game-data/animation.md#acl-compressed-clips) only the Transform tracks
  play: float tracks and root motion aren't decoded, and buffers with a database, non-trivial
  default values or Euler bindings hold their end pose. blend-tree states, additive or
  partial-weight layers, override controllers and the Animators of models with view states hold
  their saved pose. vertex-animation-texture meshes (`_vat`, e.g. floating rocks) draw their rest
  pose
- [spinning scenery](game-data/animation.md#spinning-scenery) (Qingbo's other waterwheels) turns
  from its stored pose at the viewer clock's zero rather than at the game's gameplay-clock phase,
  and how the native system turns it is inferred from the data, not read. renderers under
  MonoBehaviour rotators (`DynamicSceneSimpleRotate`, `TransformRotateAroundAxis`) in prefabs hold
  still; whether any placed prefab has such renderers isn't surveyed (the waterwheels' rotators turn
  only colliders and decals)
- runtime world-space UI, including Dijiang's cabin nameplates and assigned-operator panels, is not
  drawn ([cabins](game-data/scene-states.md#dijiang-cabins)); neither are the Images and Text of
  world-space canvases inside prefabs, such as the counters on Dijiang's weapon wall displays

### scene states and controls

- entities controlled only by `ActivityControlComp` aren't gated; every owner's component is empty
  ([dynamic load gates](game-data/scene-states.md#dynamic-load-gates))
- event photo spots share one control per scene, not one per event; other kinds of event placement
  are recognised only through missions and dungeon scripts
  ([event placements](game-data/scene-states.md#event-placements))
- resource nodes (doodad groups) share one level control per level; the game's per-group level and
  its source in LevelData aren't read ([scene states](game-data/scene-states.md#doodad-groups))
- interactive facilities are gathered from levels whose map is the packed scene, so a scene streamed
  by levels of other maps (`base01_lv001`, streamed by `base01_lv003` and `indie_dg014`) probably
  loses their facilities; select levels by `defaultState.exportedSceneConfigPath` instead. for the
  same reason `pack <scene> --level` only takes the scene's own map's levels, so such a level
  (`dung02_rdg012` on `dung02_rdg008`) can't be packed with its own spawn and LevelData. packing
  such levels would put overlapping levels in one package, which the viewer would then need to show
  one at a time again
- global variables gates number and MapConfig names stay separate controls (no name table is known);
  map variables that aren't an interactive's property show as their MapConfig names or numbers;
  Yinglung Pass's server-set outpost tier variables are separate controls, so all four tiers show by
  default ([outpost tiers](game-data/scene-states.md#outpost-tiers)). variable-driven view states on
  DynamicStreaming entities
  ([view states on dynamic entities](game-data/scene-states.md#view-states-on-dynamic-entities))
  pose only by their first variable, and draw as saved for values their state machine doesn't test
  and while unset, where the game keeps the starting state; old-version controllers (type 5) and
  trigger-driven ones (the lotus leaves) still draw as saved. whether the empty model override alone
  keeps the game from loading the Wuling bridges' template drawbridge is inferred from the data, not
  read in the model component
- whether completing an outpost's `upgradeMissionId` raises its level at once or only unlocks the
  raise is unverified; the viewer treats them as one, reading the mission as complete exactly above
  the level that names it ([upgrade missions](game-data/scene-states.md#outpost-upgrade-missions))
- scene states that scripts set by name (`SetOverrideSceneState`) and map02's sprayable sludge
  surface ([sludge and miasma](game-data/scene-states.md#sludge-and-miasma)) aren't represented
  (only its cores are drawn, under their blight control); script-driven water levels are picked by
  hand: their controls list what sets each fill but don't follow it; scripted environment volumes
  (blend mode 3) default off and preview at full strength rather than following their script's
  factor; fills a script computes at runtime aren't offered (`waterScriptActionsComputed`); a set
  amount is assumed to move the surface rather than snap it; the shop, depot and terminal level →
  visual form mapping, and the resource-node level's link to regional development, aren't recovered
- script-group drivers are found from client scripts only: stages, properties and events the server
  sets show as "server", and groups no client script names have none. groups swapped by trigger
  volumes follow the camera only when every shape is a sphere and nothing else sets them; box and
  polyline volumes, and groups also set by other events, are picked by hand, and the volume script
  is assumed to be running
- interactives level scripts show and hide default to shown, since whether they start hidden isn't
  known; show and hide targets that are a script's own slots or computed at runtime aren't followed
  (counted as `scriptVisibilityUntraced` in the pack report). LevelData function areas that hide
  entities by type while the player is inside aren't applied (listed in
  `unsupported-interactives.json`)
- story-state expressions and script relationships beyond what client data proves; event and server
  conditions may never be recoverable
- control labels still show internal identifiers or representative mesh names in many places

## renderer and performance

- with every level shown, HLOD clusters the game would unload through its HLOD-unload volumes
  (stream area slots 7–9, undecoded) may draw over neighbouring levels; none were seen on map02
- teleport points as viewpoints: where the game stores them is unknown
  ([world](game-data/world.md#open))
- GPU culling and indirect draws ([performance](viewer/performance.md#optimization-candidates))
- shadow layers redraw whole on every new selection; caching them per layer across selections, and
  the game's cached, tiled far map, are open ([frame](viewer/frame.md))
- terrain pass cost, budget churn in dense areas
- temporal antialiasing sharpening

## packaging

- material conversion, the entities phase (~7 s on map02) and failed mesh/texture conversions aren't
  cached, so a warm pack can still start workers; duplicate textures are compressed before they're
  merged ([pack cache](extraction.md#pack-cache))
- a mesh or material reached both by path hash (static entities) and by object (prefabs) gets two
  table entries and converts twice ([asset conversion](extraction.md#asset-conversion-and-workers))
- prefab LODGroups switch on each renderer's own bounds rather than the LODGroup's size and
  reference point, and without its fade or the game's LOD bias
- a max-texture-size option for a lite package (textures dominate package size)
- place global scenery by its own bounds instead of pulling it all into `assets/common`
- port the game's path hash so lookups stop reverse-scanning the path-hash table (about a second
  each; [asset resolution](extraction.md#asset-resolution))
- meshes: collision-only meshes and vertices in `m_CompressedMesh` are rejected; PPtrs into Unity's
  built-in resources resolve only for the Quad and Cube; prefabs failing with a `FormatError` are
  stand-in cubes ([mesh](extraction.md#asset-classes))
- move the viewer's environment-agnostic package loading into `package-format` so packer tests read
  packages through the viewer's code

## open unknowns

- what the game measures an HLOD ring's distance to, and the HLOD material/atlas mapping
  ([LOD and HLOD](game-data/world.md#lod-and-hlod),
  [streaming layers](game-data/world.md#streaming-layers))
- per-controller meaning of progression bit 0 ("unbuilt" versus "level 1";
  [progressions](game-data/scene-states.md#progressions))
- weather/time state ids
- runtime: BC texture support in Safari, the texture-array layer limit on Apple GPUs
