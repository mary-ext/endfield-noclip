# status

what the extractor and viewer cover, where they knowingly differ from the game, and what is still
unknown, with [code follow-ups](#code-follow-ups) at the end. topic pages carry the detail; this
page is the index of gaps. update it in the same commit that closes or opens one.

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
  stream areas and script/event groups as controls, each listed for the levels it gates;
  variable-driven view states on dynamic entities and the decoration animator values scripts set as
  they start. script groups list what sets them in game (quests, switches, areas, dungeons), from
  the level scripts, follow the quests their scripts check when they run, and follow the camera's
  path where a script sets them only as the player crosses its trigger volumes; so do looks that the
  player's presence changes ([scene states](game-data/scene-states.md),
  [scene controls](extraction/scene-controls.md))
- environment profiles and volume blending, spatial rain, water, post-processing, baked irradiance
  with its scene-state bakes (plus the bakes of Dijiang's rooms with a cabin built) and local point,
  spot and tube lights ([environment](viewer/environment.md), [lighting](viewer/lighting.md),
  [water](viewer/water.md))
- scene effects in six effect shaders, mist, six-way smoke, portals, and particle systems with their
  custom data ([effects](game-data/effects.md), [particles](game-data/particles.md),
  [viewer](viewer/particles.md))

## lighting and post-processing

- ambient ([ambient](viewer/lighting.md#ambient)): checked against an in-game shot only at Jingyu's
  cave arch; the volume's default SH isn't recovered ([open](game-data/lighting.md#open)); the
  lookup has no jitter or forward-shifted clipmap centres; the AO multi-bounce fit uses the albedo's
  luminance rather than each channel; specular occlusion takes no GTAO; the specular ambient falls
  back to the ambient probe until the reflection cubemap streams in; local reflection probes aren't
  drawn (placements not found). next: compare GPU clipmap samples with the bake at one point, and
  check clipmap seams (L0 repeats, L1 clamps)
- irradiance volume ([irradiance volume](viewer/lighting.md#irradiance-volume)): levels refill whole
  rather than partially; room bakes reach only the finest clipmap; which scene-state bake applies is
  inferred from the bakes, not read from the game's native selection; the index's pair table,
  trailing rows, three directory words and other index magics are unread
  ([open](game-data/irradiance.md#open))
- sun ([sun](viewer/lighting.md#sun)): it may be π too dark against local lights and the game (the
  two conventions differ, [open](game-data/lighting.md#open)); unchecked
- sun shadows ([shadows](viewer/lighting.md#shadows)): no contact shadows; the far layer filters
  with a 3×3 bilinear grid rather than the game's tent over cached tiles; acne is biased by a normal
  offset rather than the game's push towards the sun; casters aren't culled by the game's per-layer
  screen sizes (its measure isn't decoded); a realtime-only caster among listed rows also casts into
  the far layer; prefab renderers cast into every layer, since the packer doesn't read their
  `m_StaticShadowCaster` and `m_RealtimeShadowCaster` fields
  ([render flags](game-data/world.md#render-flags)); cascade selection and the sharp-to-far fade
  follow an unverified reading. for interiors: off-screen casters reach only 250 m, so the sun can
  leak past that reach, `_ShadowCullMode` isn't read, and outside the game's sun-off volumes rooms
  get the outdoor sun wherever no drawn geometry shadows them. map02's `shadowOC_CAVE_*` entities
  (InitChunkData component 61, [world](game-data/world.md#initchunkdata-layout)) are likely the
  game's cave shadow occluders; they aren't packed and what they do is unchecked
- local lights ([local lights](viewer/lighting.md#local-lights)): no cookies, flicker or
  multiple-scattering term; directional, shadow-only and character-only lights aren't packed. their
  [shadows](viewer/lighting.md#local-light-shadows) come from static scenery through the game's
  cached tiles only (no per-frame tiles for moving lights or objects), drawn from the sun's
  far-layer casters at the camera's LODs rather than culled for the light's view and its culling
  box, with the sun passes' bias and a 3 × 3 filter for the game's 5 × 5 tent, and redrawn as
  casters stream in, which the game doesn't need; they go off with the sun's shadows. checked
  against in-game shots at Jingyu's cherry-tree pit and cave arch only, where lit blossoms still
  read a little paler than the game's. [light beams](viewer/effects.md#light-beams) lack their 3D
  noise, a per-renderer scale and a global tint, and aren't checked against an in-game shot
- surface shading that shows most indoors: per-draw emission colours other than prefabs'
  `AnimationProperties_Emissive` resting colour (or their view states' emissive config) aren't known
  ([emission](#surfaces-and-terrain)); meshes without tangents draw their normal map flat (what the
  game's bump does there is unchecked); normals are transformed by the model matrix rather than its
  inverse transpose; every material but leaves without `_TwoSidedNormal` lights the side facing the
  camera; the packed tangent frame isn't decoded, so tangents are generated (MikkTSpace) from a UV
  set ([geometry](package-format.md#binary-encodings))
- screen-space reflections
  ([screen-space reflections](viewer/lighting.md#screen-space-reflections)): the rain wetness
  variant's ripple normals aren't drawn, and reflection-only effects don't write the march's inputs
- ambient occlusion ([ambient occlusion](viewer/post-processing.md#ambient-occlusion)): normals come
  from depth, one depth-aware blur stands in for the game's temporal and two spatial filters, there
  are no depth mips, and the reach is capped at 48 half-resolution pixels
- auto exposure can sit off in-game shots where characters or effects the viewer doesn't draw would
  count ([auto exposure](viewer/post-processing.md#auto-exposure))
- post passes ([post-processing](viewer/post-processing.md)): depth of field, motion blur, fisheye,
  frosted glass and cutscene effects aren't drawn; the vignette's extra mode and fields (the viewer
  draws URP's); bloom's compute-shader variant, dirt, additive upsampling, character bloom and
  anamorphic stretch; colour curves aren't packed
- post profiles
  ([the level's base environment](extraction/environments.md#the-levels-base-environment)): a bloom,
  ambient occlusion, vignette or reflection parameter the profile doesn't override is packed with
  its authored value rather than the game's default, and a lower-priority volume never shows
  through; whether any shipped profile differs by it is unchecked
- light shafts ([light shafts](viewer/post-processing.md#light-shafts)): the occlusion term and the
  cloud mask aren't drawn; unchecked against an in-game shot facing the sun. the
  [sun disc](game-data/sky-and-fog.md#sun-disc) is unchecked against one too
- lens flare ([lens flare](viewer/post-processing.md#lens-flare)): polygon elements and inverse SDFs
  aren't drawn; the flare component's own settings (when the environment's flare is off) aren't
  known, so no flare draws then; per-light curves take SRP core's directional-light defaults, and
  Unity's random-number mapping is assumed. at Origin Lodespring's overview the viewer's flare is
  fainter than the game's: the crystal mountain behind the sun occludes it in the viewer's depth
  buffer (the game may not write it there)

## environment, sky and fog

- environment volume activation ([activation](game-data/environment.md#activation)): what switches
  story-state chunk volumes isn't known, so every loaded volume counts as enabled (manual-blend ones
  default off and preview at full strength), which is visibly wrong at The Hub (night and
  destruction volumes) and Snowy Forest (night volume), and the base-environment vote is wrong
  wherever the game keeps a volume off. the order among equal-priority volumes is assumed
  ([viewer](viewer/environment.md#activation))
- environment volumes not packed ([volumes](extraction/environments.md#volumes)): cylinder volumes
  (`volumeType` 4), the volumes of a prefab with a prism under a non-identity placement, and local
  post `Volume`s (read but not applied); scenes without levels get no environment
- environment phases ([environment](game-data/environment.md#environment-phases)): `windConfig`
  drives only the [wind clock](viewer/materials.md#swaying-cloth) (wind motors aren't read), and
  `snowConfig`, `volumetricCloudConfig` and other sections aren't extracted. the blend's rules for
  directions, integers and the fog's deferred Rayleigh scale are the viewer's, and it doesn't follow
  the game's cloud-shadow crossfade or its weighted `drawCloudAfterPlanet`
  ([blending](viewer/environment.md#blending-at-the-camera)). packed but unread: the cloud flow
  (`cloudFlowType`, `cloudFlowMap`, `flowSpeed`, so the panorama never moves), `skyMaterialType` 1
  and its `skyboxCubeMap` (a few boss phases), `reflectionType`, `useCustomIVDefaultSH` and
  `heightFogConfig.enableVolumetricFog` (the PC fog path switches on `volumetricFogConfig.enable`
  alone) ([viewer](viewer/environment.md#environment-phases))
- weather ([weather](game-data/environment.md#weather)): spatial rain applies with its volumes, but
  quest-driven rain lives in LevelData's dynamic volumes, which aren't extracted (and what starts
  their scripts is unknown); snow isn't packed and falling precipitation (streaks, splashes,
  ripples) doesn't render. rain wetness ignores shelter, since the rain occlusion map isn't
  rendered, and has no jittered coverage edges, water running down walls or flooding of
  normal-mapped dips ([wetness](viewer/environment.md#wetness))
- sky ([sky](viewer/sky-and-fog.md#sky)): the sky-view LUT's ground bounce and the procedural sky's
  colour adjustment (`_VFXParams1`) aren't drawn; at Power Plateau's overcast the sky stays 15–20
  sRGB levels brighter than the in-game shot and the clouds lighter and thinner, while Wuling's sky
  matches. which of the game's two cloud-alpha paths runs on PC is unchecked
- the sky's celestial layers ([beyond the atmosphere](viewer/sky-and-fog.md#beyond-the-atmosphere))
  are unchecked against in-game shots: sky planets are always added rather than blended by their
  `_BlendMode` and miss the global colour adjustment, stars aren't thinned behind their rings, the
  ray-traced planet takes the viewer's sun as its light, and the moon's sky-wide ring (`HG_RING`)
  and the aurora aren't drawn
- volumetric fog ([fog](viewer/sky-and-fog.md#fog)): local fog volumes and the volumetric light's
  flow noise (`enableVLFlowNoise`) aren't drawn, the grid is a fixed 160 × 90 × 64 against the
  game's up to 240 × 135 × 128 at PC high ([quality settings](game-data/quality-settings.md)), the
  slices per doubling and history weight are Unreal's defaults (the game's aren't recovered), a
  froxel the history misses takes one sample rather than the game's 16. the height fog's
  [flow noise](viewer/sky-and-fog.md#flow-noise) is drawn on opaque surfaces only (the game's is
  unchecked on the sky, water and glass), and its volume blend is read from the height-fog section's
  and assumed for the volumetric one

## surfaces and terrain

- emission ([emission](game-data/materials.md#emission), [viewer](viewer/materials.md#emission)):
  `_EMISSIVE_ANIM_SWEEP`'s moving band isn't drawn (colours that glow only inside it stay dark,
  steady ones glow), so `_EMISSIVE_NOMAP` emits nothing; flicker and the emissive map's scroll
  (`_EmissiveSpeed`; Dijiang's shaft cargo rings) are drawn still, the pulse stops on looks with a
  parallax glow or layer, and the emission Fresnel term is left out. of the per-draw emission
  overrides, only prefabs' `AnimationProperties_Emissive` resting colours, or the emissive config
  their view states leave on it, are read: its breathing (and a config's cycle) and an
  `EntityRenderHelper` target aren't, nor are overrides other scripts set at runtime; the albedo
  tint applies after the tri-channel mask and detail blends, where the game tints the base colour
  before them
- glass ([glass](game-data/materials.md#glass)): refraction, Fresnel opacity, planar reflections and
  subsurface scattering aren't drawn; premultiplied glass is read from the blend state, and whether
  the game lets glass cast shadows is unchecked
- foliage ([foliage](game-data/materials.md#foliage), [viewer](viewer/materials.md#foliage)): wind,
  the grass's per-instance colour and terrain albedo blend (`_BLEND_TERRAIN_ALBEDO`), the card LOD's
  normal decoding (so it takes neither the bend nor the masks), the trunks' detail map, layers and
  terrain blend (they take Lit's texture layout and their vertex AO and ramp; `HGRP/Lit`'s own
  `_FOLIAGE_TRUNK` isn't read), `TreeFoliageCardMeshLod`'s own inputs (shaded as plain alpha-tested
  foliage, so without its `_BLEND_COLOR`: blossom trees lose their colour at card distance, unless
  the card's atlas carries it), leaves' `_AO_MASK_TUNE_COLOR`, the card LODs' view and height
  culling, sphere-shadow proxies, the vertical-normal AO boost, broadleaf indirect transmission and
  contact shadows. grass and tree grids ([terrain](viewer/terrain.md#foliage-grids)) draw every
  instance at the cluster's LOD, without the game's sparsity thinning; the cluster LOD measure
  (`rendererHalfSize`), the per-instance parameters and column 7 aren't read
- Lit layers ([lit layers](viewer/materials.md#lit-layers)): `HGRP/LitEffect` (about 100 map02
  materials) draws as Lit without dissolve and disturb; the tri-channel mask on MRO-layout
  materials, G and B of its switch-texture variants, `_UseMaskRUVSetAndTilingScale`, the parallax
  glow's separate mask (`_UseParallaxMask`; those don't glow), global highlight and world-space, PBR
  and deform variants, matcaps (the campfires' crystal glows without its sheen), mask layers on
  emissive-mapped materials and with noise or parallax, the top layer's `_BaseHeightMap` (read as
  grey) and `_TERRAIN_BLEND`'s fade into the terrain aren't drawn
- other surface keywords the viewer ignores, listed per material in `debug/assets.json`
  ([unsupported materials](viewer/materials.md#unsupported-materials)), on map02:
  `_MACRO_NORMAL_MAP` (about 90 materials), `_SUBSURFACE*`, `_FAKE*` (glints, cracks, dust, volume,
  refraction), interior parallax and mapping, `_ZWRITE_OFF`, and vertex animation other than
  `HGRP/Lit`'s [swaying cloth](viewer/materials.md#swaying-cloth) and
  [vertex offset](viewer/materials.md#vertex-offset) (`_SIMPLE_VERTEXANIM_PENDULUM`, `…_ROPE`,
  `HGRP/LitTransparent`'s cloth, `_VAT_*`, `_COMMONVAT_*`, `_GPU_CLOTH`, `_MOVING_BAMBOO`). the
  cloth sway is unchecked against an in-game shot
- Lit's vertex offset (`_USE_VERTOFFSET`) is drawn only on alpha-tested materials, which all four on
  map02 are: an opaque one keeps still, as does one that offsets along the vertex normal, sits on a
  surface with a parallax glow or a layer, or weighs the offset by vertex alpha on an animated mesh.
  its scroll clock is [assumed](game-data/materials.md#vertex-offset) to be seconds, and it's
  unchecked against an in-game shot beyond the ribbons of Jingyu's cherry-tree islet being known to
  flap
- shaders without a look, shown as [unsupported](viewer/materials.md#unsupported-materials) and
  counted per shader by `pack`: on map02 `Hidden/HGRP/Effect/VFXInkWashPaint`,
  `HGRP/Effect/VFXRadialBlur`, `HGRP/CharacterNPR`, `Hidden/HGRP/LitEffectBlend`,
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
  component 28) aren't packed and `HGRP/DecalUnlit` has no look; prefabs' `HGDecalProjector`s (about
  20 on each of the Qingbo waterwheels' prefabs) aren't read, and their drop isn't reported in
  `debug/`
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
  `HGWaterDecalRenderer` values (neutral on every map02 prefab), their displacement and the
  distortion texture's mip bias (an unnamed material value); which depth the game tests them against
  is unconfirmed, their variants beyond `_USE_DISTURB`, `_USE_MASK`, `_USE_SOFTBLEND`,
  `_USE_DISSOLVE` and `_USE_WATER_EROSION`, those with a `_ZTest` other than 4, 5 or 8, and erosion
  alongside a dissolve, a distortion or a mask texture, show as
  [unsupported](viewer/materials.md#unsupported-materials) (none of map02's), and the Wuling falls'
  foam and Wuling City's red tide ([erosion](game-data/water.md#water-erosion), its clamped samplers
  approximated) are unchecked against an in-game shot; map02's static boxes (InitChunkData component
  31, [world](game-data/world.md#initchunkdata-layout)) aren't packed, counted in
  `debug/skipped-entities.json`; other fluid types are unverified
- water volumes ([viewer](viewer/water.md#water-volumes)): volumes without a `WaterConfig` of their
  own draw with their water type's surface prefab config, but without its foam decal or per-level
  multipliers ([game data](game-data/water.md#water-volumes)); moves are linear; floaters keep their
  authored height and don't lag; `ground_distance`, flow and transfers between volumes aren't read;
  volumes coinciding with a placed surface draw twice, unverified against the game; Suiming's lily
  pads end 0.9 m under the pit's surface at the first stage, as the data says, unverified in game;
  no shoreline wetness. [pumped pools](game-data/water.md#depletable-pools) offer only empty,
  authored and full, not the fills between that a pump can stop at; whether the server's starting
  amount always equals the authored one, and whether an empty pool's surface still draws in game,
  aren't checked
- waterfalls missing: Jingyu's pool falls (near unity −763, 209, −1190) and the small cascades
  beside it show white in game, but the viewer's VFXWater sheet there sits inside the rocks in front
  of it, and the steep river surface running down the lip draws as clear water. what the game draws
  there is unknown; the leads are the unpacked static [foam boxes](viewer/water.md#foam-boxes)
  (component 31), some of which enclose the falls, and the steep segment's own mesh normals

## effects and particles

- scene effects ([scene effects](game-data/effects.md), [viewer](viewer/effects.md)): drawn are
  VFXBaseV2, VFXDecal, VFXDitherAlpha, VFXAdvance's simpler variants, CharacterNPR_VFX, VFXRefract,
  VFXWater sheets, six-way smoke and the mist (FogSimple, VFXFakeVolumeFog). other effect shaders
  and these shaders' undrawn variants show as
  [unsupported](viewer/materials.md#unsupported-materials)
  - [VFXAdvance](game-data/effects.md#vfxadvance): the second disturb texture, polar and screen UVs,
    edge colour, interiors, `_FogIntensity` and a Fresnel colour aren't drawn. the dissolving walls,
    Yinglung Pass's ink rooms (`…_inkroom_floor_*`, the `inkarea_*` walls, shown only within 8 m of
    the camera) and Si's Painting's ink road over the cave falls (which draws mostly white) are
    unchecked against an in-game shot, and the ink simulation isn't run
  - [CharacterNPR_VFX](game-data/effects.md#characternpr_vfx): drawn as VFXAdvance's stack; its
    dissolve, a nonzero `_VertCameraOffset` and its other keywords aren't. on Marker Stone
    Interiors' rift monsters, the shell's screen UVs about the mesh's origin measure from the
    prefab's origin (the mesh is posed into the prefab), and the look is unchecked against an
    in-game shot
  - [invisible bridges](game-data/effects.md#invisible-bridges): the fire seed reveals them about
    the camera, at its highest level by default since the server holds its level, without its radius
    easing between levels; the northern bridge's group is server-driven and stays at its stored
    default (hidden). the bridges' look is unchecked against an in-game shot, as is the reveal radii
    before any script sets a level (0 in scenes without a fire seed)
  - VFXBaseV2 and VFXDecal: VFXBaseV2's additive blend states and VFXDecal's outside `_BlendMode` 1,
    `_BlendMode` 2 outside a multiplying blend or with a stencil, opaque blending with a stencil, a
    soft blend or an edge colour (opaque layers are fogged by the composite and the falling gravel
    is unchecked in game), the sixth sample texture alongside a vertex offset, a vertex offset mask
    alongside all five other sample textures, brightening that is a scan line or centred on a fixed
    point (the player-centred one is left out), rigid-body, fluid and particle vertex animation,
    soft bodies that are lit, take a Fresnel term or a vertex offset, or play from particle data
    (the Aurelyne blob is unchecked in game), [water blending](game-data/effects.md#water-blending)
    (fragments below the authored height show the checker; the height a water surface would set
    isn't followed), VFXDecal's `_USE_IN_PARTICLE`, lighting and 3D-texture variants and its
    parallax beside a blend layer, and local lights and the post-exposure division on lit effects
  - VFXBaseV2's breathing pulses every placement in step (per-draw time scale and offset untraced);
    Dijiang's clue board and the aisle-guide panels' edge colour are unchecked in game
  - VFXDitherAlpha's effect variants blend rather than dither and write no depth; lit ones, other
    dither modes, object-relative screen UVs and a vertex offset with none of the stack's other
    keywords stay unsupported, as do lit surfaces with a normal map and a distortion, mask or
    scroll, since the dithered G-buffer path draws only still textures (Marker Stone Interiors' ink
    patterns `p_fxmap_map02_lv004_inkpattern_801` and `…_802`); the plain variant's dither leaves
    out the vertex alpha and the near-camera fade, and `_USE_MAIN2` draws only where its second
    texture masks, as its colour times the tint, and on the plain variant without the dither (Wuling
    City's red-tide walls, unchecked in game). the NoLighting variant goes through the G-buffer path
    without its colour's extra factor of the alpha, so it's fogged and its soft edges are brighter
    than the game's; its effect variants stay unsupported (Si's Painting's ink sheet
    `…_inkpattern_huge_01_fj_12`, with `_INK_COLOR_DISTORT`). the Very Large Rift's escaping trails
    are unchecked in game
  - [VFXWaterDitherAlpha](game-data/effects.md#solid-effects) splashes draw as VFXDitherAlpha's
    plain variant; `_SUBSURFACE` and the sequence-frame variants stay unsupported (about a third of
    map02's), and the splash at the foot of Si's Painting's cave falls is unchecked against an
    in-game shot
  - [VFXRefract](game-data/effects.md#refraction): its saturation, Fresnel mask and trail aren't
    drawn, its scene copy includes the water and fog (unchecked against the game's), and on meshes
    it ignores the second UV set the game reads as custom data; Deep Dale Street's fog-wall haze,
    the balloons' glitch and Valley Pass's fire-column haze are unchecked in game
  - VFXWater: `VFX_WATER_REFRACT`, `_VAT_SOFTBODY`, punctual lights, matcaps, and
    `VFX_WATER_SIMPLE_LIGHT`'s probe (lit the full way instead)
  - [six-way smoke](game-data/effects.md#six-way-smoke): no shadow ramp texture, local lights or
    main texture; a mask or dissolve on UV set 1 stays unsupported on meshes; unchecked in game,
    including Valley Pass's fire column and its screen-space blend layer
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
- particles ([particle systems](game-data/particles.md#particle-systems),
  [viewer](viewer/particles.md#particles)):
  - frozen mesh particles lose their start colour and their drift and spin over lifetime (a held
    particle goes on moving in game), and take the midpoint of random start values
  - played systems ignore the noise, collision, trigger, sub-emitter, light, trail and by-speed
    modules, use the viewer's own random values and move only while frames render (so the fish
    school circles without its noise's wobble); all copies of one flipbook step in phase
  - stand-ins at the emitter: systems that don't play on awake; a start delay, rate or drag curve; a
    per-axis speed limit; speed-modifier curves alongside drag without a speed limit; force fields
    other than spheres or with a vector field; shapes other than sphere, hemisphere, cone, box,
    circle, donut and mesh (under 20 map02 systems, single-sided edges and box edges); mesh shapes
    with a shape texture, edge placement in Loop or PingPong, or quads, points or lines mixed with
    triangles; sprite-mode sheets, sheet time modes other than lifetime or frames per second, sheets
    over 64 tiles a side
  - approximations: without a limit or force fields, drag slows only the start velocity and the
    fall; orbits turn the whole path (exact only along the orbit's axis); force fields push only
    from within the system's own prefab (no wind zones or scene fields); a particle replaying a ring
    buffer's loop range replays its path; `Facing` turns to the camera's plane like `View`;
    velocity-aligned billboards roll by the viewer's choice; vertex Loop and PingPong mesh shapes
    pick at random for bursts and count the rate's emissions from the start delay (when the game's
    count restarts isn't traced); cones and circles ignore the arc's mode and spread (about 20 map02
    systems set one), sphere and hemisphere arcs aren't applied; stretched quads ignore the camera's
    velocity (no map02 system scales by it), the freeform mode and an `m_NormalDirection` below 1
  - limits: at most 1024 live particles per emitter (a couple of map01 systems can hold slightly
    more), bounds that a ring-buffered particle moving far past its lifetime can outrun, colours
    clamped to 1 (RGBA8), custom data in colour mode isn't packed (no map02 system uses it)
- [spline movers](game-data/particles.md#spline-movers) (Dijiang's shaft cargo) take their lifetime
  span as the spline's length over the speed (unverified) and draw each LOD group's renderers at the
  group's origin; those with noise, rotation over lifetime, an alpha fade, a speed or lifetime
  curve, an emission type other than the box, or more than four LOD groups stand in
- temporal smoothing of effects: moving particles, scrolling and animated effects have no motion
  vectors, and transparent layers write no depth, so the temporal antialiasing reprojects them by
  the opaque scene behind ([frame](viewer/frame.md)). the game's effect variants carry
  `HG_ENABLE_MV`; how the result differs on screen is unchecked
- Marker Stone's low mist banks over the valley are missing; their source is unknown
- the transparent pass sorts by the distance to each instance's bounding-sphere centre, where what
  the game measures (bounds centre, most likely) isn't traced; only instances of one draw that are
  neighbours in the order share a call. prefab renderers' sorting layers and orders sort first, but
  not the render queue (2900–3100 share the pass) or renderer priority, and static scenery takes
  band 0, since what fills its ECS band byte isn't traced ([frame](viewer/frame.md)). the corroded
  planet's plume through Dijiang's deck glass is unchecked against the in-game shot's brightness

## scenes and conditional content

### world and streaming

- separate scenes (interiors, offices, arenas) are unvalidated
- the game's HLOD-unload volumes (`FBStreamArea` root slots 7–9) aren't decoded or applied
  ([world](game-data/world.md#stream-areas)). the viewer follows the game's HLOD rings at its high
  preset (4000) but measures them in 3D from the camera to the tile's bounds rather than in XZ from
  the player, keeps HLOD2 drawn past 2048 m, and doesn't apply the other layers' radii (`Tiny`,
  `Lighting`, …), since an entity's layer isn't known
  ([instance selection](viewer/streaming.md#instance-selection),
  [streaming layers](game-data/world.md#streaming-layers))
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
- a refined leaf drops its HLOD cluster even when it has no detail to show for it, so scenery that
  exists only as clusters disappears within the detail distance: indie_dg005's Wuling City backdrop
  opens a hole in front of the office window. whether the game hides a cluster whose members aren't
  loaded is unknown ([streaming layers](game-data/world.md#streaming-layers)). likewise a very large
  object filed under one leaf by its centre disappears while that leaf shows its HLOD, unless the
  cluster covers it
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
  state machines settle in from the placement's starting `state`; a `state` the server or a level
  script sets later isn't followed. of the keys components set before view states start, only a
  vertical rope's `RopeLength`, a lift's door bools and a broken robot's `level`, `damage_type` and
  `exit_type` are read (a lift stays at its starting floor, which the server saves as the player
  rides); of `VFXAdjustLength`, only scale targets and tiling (a component switching anything else
  boxes its prefab), and a `PositionFollower` holds its walk position under a looping clip
- [one-shot effects](game-data/effects.md#one-shot-effects) and transitions' bursts (the talosites'
  activation) aren't drawn. looping effects that rest looks' states play are
  ([effects at rest](extraction/prefabs-and-interactives.md#effects-at-rest)), but not doors',
  bridges' or facility forms'; that a non-persistent effect ends with its state is assumed, and
  effects on a looping clip's GameObjects hold its end pose. of the effects components place
  themselves only the jump pad's arrow, the vertical jump pad's vent and laser gates' beams are
  drawn, unchecked against an in-game shot; the older `int_electric_fence`, whose state its logic
  computes from server power, draws without beams. the AIC buildings the world places for the
  factory power network (The Hub's power ports beside its laser-gate switches) aren't drawn: no
  client file holds their positions ([laser gates](game-data/interactives.md#laser-gates))
- a settled loop clip moves skinned bones and the Transforms of mesh renderers, including ones under
  its bones, but not billboarded renderers or particle systems; its material values and GameObject
  switches hold their end values
  ([looping clips](extraction/prefabs-and-interactives.md#looping-clips)). every placement plays in
  step from the viewer's clock (the game's start per placement is unknown), the animation moves only
  while frames render, each moving renderer stores every frame of its own, and the balloon's sway
  and its tube's [vertex offset](viewer/materials.md#vertex-offset), whose object-space direction
  the viewer turns by the prefab's transform, are unchecked against an in-game shot
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
  the viewer clock's zero, and drop no overshoot at the end of a loop. ones parked at a knot that
  waits for the player don't set off as the camera comes near; ones that turn along the curve, vary
  their speed by segment or curve, or stop at their target stay at their placement
  (`unsupported-interactives.json`). platforms a level script starts through the server, such as
  map02's floating tower 10200030295 at the fire seed altar, stay at their placement (see
  [auto-moving platforms](game-data/interactives.md#auto-moving-platforms)); effects, particles and
  billboards on a moving platform stay behind; other curve movers (coins, butterflies, kickable
  balls), which scripts start, hold still
- [crane towers](game-data/interactives.md#crane-towers) draw their placement's starting steps, with
  the container hung from the hook; the steps the player's operations save on the server aren't
  offered as controls
- interactives with a mini-game or submit lock draw their model's locked look
  ([gameplay locks](game-data/interactives.md#gameplay-locks)); the unlocked look the player's
  repair saves on the server isn't offered as a control, and the effects a lock mounts on the model
  aren't drawn
- rows created later (`createState` ≠ 0) draw only with their level's "created during play" toggle,
  off by default; one toggle covers a level's rows, since which of them the server or a script
  creates isn't followed ([spawning](game-data/interactives.md#spawning))
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
  moving renderer stores every frame (Qingbo's octagonal waterwheels: dozens of renderers over more
  than a thousand frames). of [ACL-compressed clips](game-data/animation.md#acl-compressed-clips)
  only the Transform tracks play: float tracks and root motion aren't decoded, and buffers with a
  database, non-trivial default values or Euler bindings hold their end pose. blend-tree states,
  additive or partial-weight layers, override controllers and the Animators of models with view
  states hold their saved pose. of the
  [decoration animator](game-data/animation.md#decoration-animators) values level scripts set, only
  those set on script start (constant or by one saved property) are read; `PlayDecorationAnimation`
  and values set by quest, custom or volume events aren't, and a saved property's default (set, as
  in a finished save) is assumed. vertex-animation-texture meshes (`_vat`, e.g. floating rocks) draw
  their rest pose
- [spinning scenery](game-data/animation.md#spinning-scenery) (Qingbo's other waterwheels, the
  originium hub frames) turns from its stored pose at the viewer clock's zero rather than at the
  game's clock phase, and how the native systems turn it is inferred from the data, not read.
  renderers under MonoBehaviour rotators (`DynamicSceneSimpleRotate`, `TransformRotateAroundAxis`)
  in prefabs hold still; whether any placed prefab has such renderers isn't surveyed (the
  waterwheels' rotators turn only colliders and decals)
- runtime world-space UI, including Dijiang's cabin nameplates and assigned-operator panels, is not
  drawn ([cabins](game-data/scene-states.md#dijiang-cabins)); neither are the Images and Text of
  world-space canvases inside prefabs, such as the counters on Dijiang's weapon wall displays

### scene states and controls

- entities controlled only by `ActivityControlComp` aren't gated; every owner's component is empty
  ([open](game-data/scene-states.md#open))
- scenery that scripts, switches or the player move at runtime draws as authored: water pipes'
  rotation, bamboo puzzle positions, rune columns, entities scripts move or attach, scripted factory
  buildings, conveyors' motion and the scripted water look override; LevelData's energy point
  environment volumes aren't read
  ([other runtime state](game-data/scene-states.md#other-runtime-state))
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
- the global variables that gates number and those MapConfig names stay separate controls (no name
  table is known); map variables that aren't an interactive's property show as their MapConfig names
  or numbers; Yinglung Pass's server-set outpost tier variables are separate controls, so all four
  tiers show by default ([outpost tiers](game-data/scene-states.md#outpost-tiers)), and the
  server-set gateway blockers (`007to009`, `008go010deco_v1d6`) show by default, at their highest
  compared value ([variables](game-data/scene-states.md#variables)), as does the Snowy Forest
  cabin's server-set `woodhouse` (its before-the-ritual look). gates on another map's variable never
  load, so scenery a dungeon dresses an open-world level with (Typhoeus's after-ritual cabin) isn't
  shown in any package
  ([gates on another map's variable](game-data/scene-states.md#gates-on-another-maps-variable)).
  variable-driven view states on DynamicStreaming entities
  ([view states on dynamic entities](game-data/scene-states.md#view-states-on-dynamic-entities))
  pose only by their first variable, and draw as saved for values their state machine doesn't test
  and while unset, where the game keeps the starting state; old-version controllers (type 5),
  trigger-driven ones (the lotus leaves) and the one a script sets by name draw as saved. whether
  the empty model override alone keeps the game from loading the Wuling bridges' template drawbridge
  is inferred from the data, not read in the model component
- whether completing an outpost's `upgradeMissionId` raises its level at once or only unlocks the
  raise is unverified; the viewer treats them as one, reading the mission as complete exactly above
  the level that names it ([upgrade missions](game-data/scene-states.md#outpost-upgrade-missions))
- scene states that scripts set by name (`SetOverrideSceneState`) and map02's sprayable sludge
  surface ([sludge and miasma](game-data/scene-states.md#sludge-and-miasma)) aren't represented
  (only its cores are drawn, under their blight control, whose two values don't tell an active core
  from an inactive one); script-driven water levels are picked by hand: their controls list what
  sets each fill but don't follow it; scripted environment volumes (blend mode 3) default off and
  preview at full strength rather than following their script's factor; fills a script computes at
  runtime aren't offered (`waterScriptActionsComputed`); a set amount is assumed to move the surface
  rather than snap it; the shop, depot and terminal level → visual form mapping, and the
  resource-node level's link to regional development, aren't recovered
- script-group drivers are found from client scripts only: stages, properties and events the server
  sets show as "server", and groups no client script names have none. groups swapped by trigger
  volumes follow the camera only when nothing else sets them; groups also set by other events, and
  volumes with tilted polylines or leave-only shapes, are picked by hand. the volume script is
  assumed to be running, a camera that starts inside a volume is assumed to enter it, and the
  player's capsule radius is ignored
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
  ([stream area](game-data/world.md#stream-areas) slots 7–9, undecoded) may draw over neighbouring
  levels; none were seen on map02
- teleport points as viewpoints: the game's fast-travel destinations aren't packed
  ([teleport points](game-data/world.md#teleport-points))
- mesh selection on the CPU is the largest frame cost (about half the frame over dense foliage), and
  GPU-culled buckets still cost an encoded draw each
  ([performance](viewer/performance.md#optimization-candidates))
- shadow layers redraw whole on every new selection, without the game's tiled cache of its far map
  or its per-layer cull of small casters, whose size measure isn't decoded
  ([performance](viewer/performance.md#optimization-candidates),
  [quality settings](game-data/quality-settings.md))
- geometry pools never shrink, so their spare capacity stays outside the stream budget
  ([GPU resources](viewer/gpu-resources.md))
- the terrain's close-up blending and the timestamp queries' own overhead are unprofiled; large
  regions at the default budget evict content during a flight
- texture mips are picked from an instance's screen size as if its texture spanned it once; Unity's
  streaming uses each mesh's UV density, which the packer doesn't store. the viewer's one budget
  holds textures and meshes together, where the game budgets textures alone, so dense views fall
  back on the [texture reduction](viewer/streaming.md#residency-and-budgets)
- temporal antialiasing has no sharpening (the game sharpens by 0.3), and reprojects by depth and
  camera alone, so moving content reprojects as if it stood still ([frame](viewer/frame.md))

## packaging

- the entities phase (about 20 s on map02) and failed conversions and material loads aren't cached,
  so a warm pack can still start workers; duplicate textures are compressed before they're merged
  ([pack cache](extraction.md#pack-cache))
- a mesh or material reached both by path hash (static entities) and by object (prefabs) gets two
  table entries and converts twice ([asset conversion](extraction.md#asset-conversion-and-workers))
- prefab LODGroups switch on each renderer's own bounds rather than the LODGroup's size and
  reference point, and without its fade or the game's LOD bias
- a max-texture-size option that drops leading levels, for a lite package: textures at native
  resolution dominate package size ([textures](package-format.md#textures-tex)); texture formats
  without a WebGPU equivalent don't convert ([texture](extraction.md#asset-classes))
- instance blocks store full f32 rows; meshopt filters or quantized rows could roughly halve them
  ([instance block](package-format.md#instance-block-inst-efin))
- place global scenery by its own bounds instead of pulling its assets into `assets/common`
  ([asset placement](package-format.md#asset-placement)); off-square edges produce sub-KB shard
  archives that could merge into a neighbour
- the tree's `geometricError` is a placeholder (`edge / 16`) that only orders requests
  ([tile tree](package-format.md#tile-tree))
- the terrain's cliff-index pages and cone maps aren't packed
  ([terrain](game-data/world.md#terrain))
- port the game's path hash so lookups stop reverse-scanning the path-hash table
  ([asset resolution](extraction.md#asset-resolution))
- meshes: collision-only meshes, vertices in `m_CompressedMesh` and line and point topologies are
  rejected; PPtrs into Unity's built-in resources resolve only for the Quad and Cube; prefabs
  failing with a `FormatError` are stand-in cubes ([mesh](extraction.md#asset-classes),
  [geometry blob](package-format.md#geometry-blob-mesh-efgm))
- move the viewer's environment-agnostic package loading into `package-format` so packer tests read
  packages through the viewer's code

## open unknowns

- what the game measures an HLOD ring's distance to, and the HLOD material/atlas mapping
  ([LOD and HLOD](game-data/world.md#lod-and-hlod),
  [streaming layers](game-data/world.md#streaming-layers))
- per-controller meaning of progression bit 0 ("unbuilt" versus "level 1";
  [progressions](game-data/scene-states.md#progressions))
- runtime: BC texture support in Safari, the texture-array layer limit on Apple GPUs

## code follow-ups

noticed while reading the code, none verified as a visible bug. paths are under `packages/`. delete
an entry when it's done or ruled out.

### possible bugs

- `formats/src/unity/animation-clip.ts`: `readClipActivity` doesn't check `m_ValueArrayDelta`
  against the bindings' total as `readClipEndPose` does, and `readAclMotion` doesn't skip
  `isPPtrCurve` bindings as `readClipMotion` does
- `extractor/src/game/prefabs/animator-defaults.ts` `transitionHolds`: condition mode 5 (exit time)
  holds, while a transition without conditions is treated as waiting on exit time and never taken
- `extractor/src/game/dynamic/cabins.ts`: `cabinLevel` controls default to `levels[0]`, which
  assumes the lowest level is 1 and is `undefined` when no field levels are read
- `extractor/src/game/interactives/bridges.ts` `telescopicPieces`: the piece count is capped at 64
  without a stated reason
- `extractor/src/game/materials/surfaces/dithered.ts` drops the dither test for `_USE_MAIN2`
  materials, though the game's depth pass has no `_USE_MAIN2` variant and still dithers
- `extractor/src/game/effects/particle-system.ts`: a speed-modifier curve with drag and force fields
  but no speed limit stands in, though the stepped path could play it
- `extractor/src/game/materials/surfaces/surface-keywords.ts`: `LIT_KEYWORDS` omits
  `_EMISSIVE_ANIM_SWEEP` although `describeLit` reads it (deliberate, to keep flagging the undrawn
  band?), and lists `_NORMAL_MAP` for the foliage shaders, which nothing tests
- `extractor/src/pack/tables/water.ts` `volumeSurface` hardcodes `meshNormals: false`, where
  `surfaceEntry`'s rule gives `true` for a proxy surface (same result on a flat polygon)
- `viewer/src/render/meshes/effect.wgsl` `fx_soft_body` divides by the look's frame count without a
  guard against 0
- `viewer/src/render/meshes/mesh.wgsl`: `Look.detail2.z` is the overlay scale on detail-mapped looks
  and the premultiplied flag on transparent ones, safe only while no look is both
- `viewer/src/looks/effects/effect-look.ts`: `EffectRow` entries are out of offset order
- `extractor/src/game/interactives/template-data.ts`: the `state` lookup falls back from saved to
  config to temporary properties, where [the `state` key](game-data/interactives.md) is described
  from `saveProperties` alone. settle which the game does

### duplication

- extractor prefabs: the field-name probe copied into six `is…Type` functions (`adjust-length.ts`,
  `billboard.ts`, `emissive-override.ts`, `prefab-environment.ts`, `renderer-walk.ts`); `xyz` in
  `prefab-walk.ts` and `prefab-environment.ts`; identity matrices in `prefab.ts`,
  `renderer-passes.ts` and `prefab-walk.ts`
- extractor interactives: `toFloat` in `crane-tower.ts` and `curve-move.ts` against `atomFloat` in
  `template-data.ts`; `craneTowerOf` re-implements `componentParams`' merge and `cranes.ts` the
  `InteractiveRow.scaleOf` rule; `startState` and `entityProperties` each parse `templateVariant`;
  `propertyAtomBits` and `templateAtoms` are near-duplicate walkers
- extractor state and dynamic: the `plain` closure twice in `state/story.ts`; `levelCondition`
  rebuilds what `maskLevels` computes; literals where constants exist (resource types 5/6/7 and
  `compare: 0` in `dynamic-structures.ts`, `LOD_GROUP = 205` in `renderer-candidates.ts`)
- extractor materials: the `_USE_MAIN2` check and `_MainTex2Color` read in both
  `surfaces/dithered.ts` and `effects/dither-effect.ts`
- extractor pack: `convertMesh` computes `order.map(vertexOf)` twice for a skinned mesh;
  `objectHash` in `asset-ids.ts` against three inline copies; `assetNames` in `commands/world.ts`
  looks an asset up twice
- formats: the record guard in `level-interactives.ts`, `level-locks.ts` and `level-splines.ts`
  against `isMemoryPackObject`; `expect`/`count`/`list`/`bool` helpers redefined three times in
  `interactive-model.ts`; `present(VertexAttribute.BlendIndices)` called twice in `decodeMesh`;
  `stream-area.test.ts` has its own FlatBuffer writer; `level-config.test.ts` holds a string pool
  test
- viewer: the `described` helper copied into nine look test files; `fx_smoothstep` (`effect.wgsl`)
  against `hermite` (`mesh.wgsl`); the reflection march duplicated between `water/ssr-trace.wgsl`
  and `fs_march` in `post/ssr.wgsl`
- the [materials](package-format.md#materials) section of the package-format page restates the
  `surfaces.ts` module header

### CLI candidates

- `world vars <scene>`: join AutoName, MapConfig, LevelData and DynamicStreaming variables
- `world scripts find <type>`: print level-script nodes of a type
- `vfs table <name>`: dump a config table
