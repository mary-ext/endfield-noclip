# status

coverage, known divergences from the game, open unknowns, and [code follow-ups](#code-follow-ups).
topic docs hold the details; this page is the index. update it in the same commit that closes or
opens a gap.

only `map01` and `map02` are tested. other scenes listed by `scene list` are unverified.

## covered

- **extraction**: container-aware asset resolution, conversion workers, and pack cache
  ([extraction](extraction.md))
- **world & streaming**: multi-level scenes over shared terrain, camera-based streaming, static and
  dynamic stream areas via trigger zones ([world](game-data/world.md),
  [streaming](viewer/streaming.md#levels))
- **terrain**: heights, baked surface pages, and close-up layer blending
  ([terrain](viewer/terrain.md))
- **scenery & animation**: initial/alternative dynamic structures, active prefabs, skinned meshes,
  settled view-state and prefab Animator looping clips (skinned/rigid, ACL or uncompressed), GPU
  cloth simulation, and spinning ECS scenery ([assets](game-data/assets.md),
  [animation](game-data/animation.md), [cloth](viewer/materials.md#swaying-cloth))
- **scene controls**: quests, missions, variables, derived scene states, dynamic load gates, story
  progress, progressions, facility forms (shops, depots, recycling stations, monitoring terminals),
  Dijiang cabins and Control Nexus region walls, doors, telescopic bridges, campfires, blight/cores,
  outpost upgrades, tree harvest, stream areas, variable-driven view states, start-time decoration
  animators, and script/event groups (with script drivers, quest tracking, and repeatable trigger
  volumes) ([scene states](game-data/scene-states.md),
  [scene controls](extraction/scene-controls.md))
- **environment & lighting**: environment profiles and volume blending, spatial rain, water,
  post-processing, baked irradiance (with scene-state and Dijiang room bakes), local reflection
  probes, and local point/spot/tube lights ([environment](viewer/environment.md),
  [lighting](viewer/lighting.md), [water](viewer/water.md))
- **effects & particles**: six scene-effect shaders, mist, six-way smoke, stencil portals, and
  particle systems with custom data ([effects](game-data/effects.md),
  [particles](game-data/particles.md), [viewer](viewer/particles.md))

## lighting and post-processing

- **ambient** ([viewer](viewer/lighting.md#ambient), [open](game-data/lighting.md#open)):
  - verified against an in-game shot only at Jingyu's cave arch.
  - missing: lookup jitter, forward-shifted clipmap centres, and prefab-placed reflection probes
    (`p_lightingdeco_*_reflectionprobe`; none in Yinglung Pass).
  - specular ambient falls back to the ambient probe until the sky cubemap streams in; local
    reflection probes evaluate up to 32 frustum-visible probes per frame (64×64 screen-tile binned
    in deferred lighting) and fall back to the sky cubemap while their cubemaps stream.
  - next: compare GPU clipmap samples with the bake at one point and check clipmap seams (L0
    repeats, L1 clamps).
- **irradiance volume** ([viewer](viewer/lighting.md#irradiance-volume),
  [open](game-data/irradiance.md#open)):
  - levels refill whole rather than partially; room bakes reach only the finest clipmap.
  - scene-state bake selection is inferred, not read from the game's native selector.
  - index pair table, trailing rows, three directory words, and other index magics are unread.
- **sun shadows** ([viewer](viewer/lighting.md#shadows)):
  - missing: contact shadows, per-layer screen-size caster culling (measure undecoded),
    `_ShadowCullMode`, and map02's `shadowOC_CAVE_*` cave shadow occluders (InitChunkData component
    61, [world](game-data/world.md#initchunkdata-layout)).
  - divergences: far layer uses a 3×3 bilinear filter instead of the game's tent over cached tiles;
    acne uses normal-offset bias instead of pushing toward the sun; realtime-only listed casters
    also cast into the far layer; prefab renderers cast into all layers (`m_StaticShadowCaster` and
    `m_RealtimeShadowCaster` unread, [render flags](game-data/world.md#render-flags)); cascade
    selection and sharp-to-far fade are unverified.
  - interiors: off-screen casters reach only 250 m (sun leaks past that), and rooms outside sun-off
    volumes receive outdoor sun wherever no drawn geometry blocks it.
- **local lights** ([viewer](viewer/lighting.md#local-lights)):
  - missing: cookies, flicker, multiple-scattering term, directional/shadow-only/character-only
    lights, and per-frame shadow tiles for moving lights/objects.
  - [shadows](viewer/lighting.md#local-light-shadows) use static cached tiles only, drawn from sun
    far-layer casters at camera LODs (not light-view/culling-box culled), with sun bias and a 3×3
    filter (vs 5×5 tent), redrawn as casters stream in, and toggled off with sun shadows.
  - verified only at Jingyu's cherry-tree pit and cave arch (lit blossoms read slightly paler).
  - [light beams](viewer/effects.md#light-beams) lack 3D noise, per-renderer scale, and global tint
    (unverified in game).
- **surface shading (most visible indoors)**:
  - tangentless meshes draw normal maps flat (game bump behavior unchecked); packed tangent frame is
    undecoded (MikkTSpace generated from UVs, [geometry](package-format.md#binary-encodings)).
  - normals transform by model matrix rather than inverse transpose; all materials except leaves
    without `_TwoSidedNormal` light the camera-facing side.
- **screen-space reflections** ([viewer](viewer/lighting.md#screen-space-reflections)):
  - rain-wetness ripple normals not drawn; reflection-only effects listed under
    [effects and particles](#effects-and-particles).
- **ambient occlusion** ([viewer](viewer/post-processing.md#ambient-occlusion)): single depth-aware
  blur (vs temporal + two spatial filters), no depth mips, reach capped at 48 half-res pixels.
- **auto exposure** ([viewer](viewer/post-processing.md#auto-exposure)): can differ from in-game
  shots where undrawn characters or effects contribute.
- **post passes** ([viewer](viewer/post-processing.md)):
  - missing: depth of field, motion blur, fisheye, frosted glass, cutscene effects, vignette extra
    mode/fields (URP only), bloom compute variant/dirt/additive upsampling/character
    bloom/anamorphic stretch, and colour curves.
- **post profiles** ([extraction](extraction/environments.md#the-levels-base-environment)):
  non-overridden bloom/AO/vignette/reflection parameters pack their authored values instead of game
  defaults, blocking lower-priority volumes (impact on shipped profiles unchecked).
- **light shafts & sun disc** ([light shafts](viewer/post-processing.md#light-shafts),
  [sun disc](game-data/sky-and-fog.md#sun-disc)): occlusion term and cloud mask not drawn; both
  unverified against sun-facing in-game shots.
- **lens flare** ([viewer](viewer/post-processing.md#lens-flare)):
  - missing: polygon elements, inverse SDFs, and flare component's own settings when environment
    flare is off.
  - per-light curves use SRP core defaults; Unity RNG mapping is assumed.
  - fainter than game at Origin Lodespring's overview (crystal mountain occludes it in viewer depth
    buffer).

## environment, sky and fog

- **environment volume activation** ([game-data](game-data/environment.md#activation),
  [viewer](viewer/environment.md#activation)):
  - story-state chunk volume triggers are unknown, so all loaded volumes count as enabled
    (manual-blend ones default off and preview at full strength). visibly wrong at The Hub (night
    and destruction volumes) and Snowy Forest (night volume), and skews the base-environment vote.
  - tie-breaking among equal-priority volumes is assumed.
- **unpacked environment volumes** ([extraction](extraction/environments.md#volumes)): cylinder
  volumes (`volumeType` 4), prefab prisms under non-identity placements, local post `Volume`s (read
  but not applied), and scenes without levels (no environment).
- **environment phases** ([game-data](game-data/environment.md#environment-phases),
  [viewer](viewer/environment.md#environment-phases)):
  - `windConfig` drives only the [wind clock](viewer/materials.md#swaying-cloth) (wind motors
    unread); `volumetricCloudConfig` and other sections are not extracted.
  - blending rules for directions, integers, and deferred Rayleigh scale are the viewer's; cloud
    shadow crossfade and weighted `drawCloudAfterPlanet` are skipped
    ([blending](viewer/environment.md#blending-at-the-camera)).
  - packed but unread: cloud flow (`cloudFlowType`, `cloudFlowMap`, `flowSpeed`), `skyMaterialType`
    1 + `skyboxCubeMap` (boss phases), `reflectionType`, and `heightFogConfig.enableVolumetricFog`
    (PC path uses `volumetricFogConfig.enable` alone).
- **weather** ([game-data](game-data/environment.md#weather),
  [viewer](viewer/environment.md#weather)):
  - vertical occlusion map, high-quality wetness (jitter, ripples, wall runoff), falling rain, far
    rain curtains/waves, rain splashes, falling snow with collision, screen-space camera lens
    raindrops (`ScreenRainDropFX`), and LevelData dynamic environment volumes (default off,
    toggleable under scene controls) are implemented and verified on Marker Stone and Snowy Forest
    (unverified against an in-game video; `EnvironmentEnable` script triggers are not evaluated
    automatically).
- **sky** ([viewer](viewer/sky-and-fog.md#sky)):
  - sky-view LUT ground bounce not drawn; PC cloud-alpha path selection unchecked.
  - Power Plateau overcast reads 15–20 sRGB levels brighter with lighter/thinner clouds than in game
    (Wuling matches).
- **celestial layers** ([viewer](viewer/sky-and-fog.md#beyond-the-atmosphere)): sky planets
  unverified in game; planets always add (ignoring `_BlendMode`) without global colour adjustment;
  stars are not thinned behind rings; moon ring (`HG_RING`) and aurora are not drawn.
- **volumetric & height fog** ([viewer](viewer/sky-and-fog.md#fog),
  [flow noise](viewer/sky-and-fog.md#flow-noise)):
  - missing: local fog volumes and `enableVLFlowNoise`.
  - grid is fixed 160×90×64 (vs up to 240×135×128 at PC high,
    [quality settings](game-data/quality-settings.md)); slice distribution and history weight use
    Unreal defaults; history misses take 1 sample instead of 16.
  - height-fog flow noise draws on opaque surfaces only (sky/water/glass unchecked); volumetric
    volume blend is assumed from height fog.

## surfaces and terrain

- **emission** ([game-data](game-data/materials.md#emission),
  [viewer](viewer/materials.md#emission)):
  - missing: `_EMISSIVE_ANIM_SWEEP` moving band (`_EMISSIVE_NOMAP` emits nothing), Fresnel term,
    emissive breathing/cycle, `EntityRenderHelper` targets, and runtime script overrides.
  - flicker and `_EmissiveSpeed` scroll (Dijiang shaft cargo rings) draw still.
  - albedo tint applies after tri-channel mask and detail blends (game tints before them).
- **glass** ([game-data](game-data/materials.md#glass)): no refraction, Fresnel opacity, planar
  reflections, or subsurface scattering; premultiplied glass inferred from blend state; shadow
  casting unchecked.
- **foliage** ([game-data](game-data/materials.md#foliage), [viewer](viewer/materials.md#foliage),
  [grids](viewer/terrain.md#foliage-grids)):
  - missing: wind, grass per-instance colour and `_BLEND_TERRAIN_ALBEDO`, card LOD normal decoding,
    trunk detail/layers/terrain blend (`HGRP/Lit` `_FOLIAGE_TRUNK` unread), `TreeFoliageCardMeshLod`
    inputs (`_BLEND_COLOR` — blossom trees lose colour at card distance unless baked in atlas), leaf
    `_AO_MASK_TUNE_COLOR`, card LOD view/height culling, sphere-shadow proxies, vertical-normal AO
    boost, broadleaf indirect transmission, and contact shadows.
  - grass/tree grids draw all instances at cluster LOD without sparsity thinning
    (`rendererHalfSize`, per-instance params, and column 7 unread).
  - glowing foliage: flow clock assumed seconds; Deep Dale Street mushrooms unverified in game.
  - mushroom animation: omits character interaction and `_EmissiveNoMapMode` 1 vertex-colour
    emission (unused on map02); sway unverified against an in-game video.
- **Lit layers** ([viewer](viewer/materials.md#lit-layers)):
  - `HGRP/LitEffect` (~100 map02 materials) draws as Lit without dissolve/disturb;
    `Hidden/HGRP/LitEffectBlend` draws as Lit without `_ObjectBlend*` soft depth blend.
  - `_PARALLAX_MAP_WORLDSPACE` (Hongshan great tree and plinths, unverified in game) omits
    `_ParallaxSignControl` (unused on map02).
  - missing: switch-texture G/B, `_UseMaskRUVSetAndTilingScale`, non-world-space parallax separate
    mask (`_UseParallaxMask`), global highlight, PBR/deform parallax variants, matcaps (campfire
    crystals lack sheen), mask layers with noise/parallax, top-layer `_BaseHeightMap` (read as
    grey), and `_TERRAIN_BLEND` fade.
- **ignored surface keywords** (listed in `debug/assets.json` and striped by the
  [gaps view](viewer/materials.md#gaps), which excludes effects, terrain, water, and per-entity
  gaps): on map02, `_MACRO_NORMAL_MAP` (~90 materials), `_SUBSURFACE*`, `_FAKE*` (glints, cracks,
  dust, volume, refraction), interior parallax/mapping, `_SIMPLE_VERTEXANIM_ROPE`, pendulum
  gravity/anchor and alpha-blended pendulums (e.g. lamp glass `M_prop_map02_light+1_003_01h`),
  `HGRP/LitTransparent` cloth, and `_MOVING_BAMBOO`. cloth sway and
  [pendulums](viewer/materials.md#swaying-cloth) are unverified in game.
- **vertex animation textures** ([viewer](viewer/materials.md#vertex-animation-textures)): baked per
  mesh, so meshes shared by different animations hold still (map02 `s_zmdmachinevat_lod*` and one
  Hongshan waterway mesh). frames interpolate (game steps); unverified in game.
- **cloth simulation** ([game-data](game-data/materials.md#cloth-simulation),
  [viewer](viewer/materials.md#swaying-cloth)): runs `ClothSingleDispatchCS` physics, vertex
  skinning across all passes, and dynamic motion vectors; omits character capsule colliders (Qingbo
  Stockade red emblem banners verified animating; unverified against an in-game video).
- **Lit vertex offset (`_USE_VERTOFFSET`)** ([game-data](game-data/materials.md#vertex-offset)):
  alpha-tested materials only (all 4 on map02). opaque, normal-direction, parallax/layered, and
  alpha-weighted animated meshes hold still. clock assumed seconds; unverified in game beyond
  Jingyu's cherry-tree islet ribbons flapping.
- **unimplemented shaders** ([unsupported](viewer/materials.md#unsupported-materials), counted by
  `pack`): on map02, `Hidden/HGRP/Effect/VFXInkWashPaint` and `HGRP/CharacterNPR`.
- **forward Lit** ([viewer](viewer/materials.md#forward-lit)): golden treasure chest reflects the
  scene instead of `_CUSTOM_IBL`; other variants undecoded.
- **matte paintings** ([viewer](viewer/materials.md#matte-paintings)): `_UseMainTexAsAlpha` unread
  (unused on map01).
- **erosion rock, dynamic blight & sludge** ([viewer](viewer/materials.md#erosion)): `_ObjectBlend*`
  / `_LineBlend*` soft blend, fake translucency, `HGRP/ErosionDynamic` `_ANIMATION_FEATURE_*` vertex
  animation, and `HGRP/SludgeV2`'s `SludgeDecal` / `SludgeBlend` passes are not drawn (clearable
  patches and sludge unverified in game).
- **decals** ([viewer](viewer/materials.md#decals), [game-data](game-data/materials.md#decals)):
  - unsupported: `HGRP/DecalLit` footprint/UV-noise/arc variants, placements without colour/UV,
    non-box prefab `HGDecalProjector`s, and `HGRP/DecalUnlit`. terrain decals (InitChunkData
    component 28) are unpacked.
  - divergences: overlaps ignore `_DrawOrder`; prefab projectors ignore
    `m_LODScreenSizeMin`/`m_SortOrderOffset` and do not follow looping-clip Transforms.
  - wetness decals (Qingbo's big waterwheel) use Lit default porosity (ignoring `_PorosityFactor*`,
    `_DisableVerticalFlow`) and ignore the global wetness gate.
  - unverified in game: sludge erosion/wetness variants (Yinglung Pass puddles), water-flow wet
    rock, and wetness decals.
- **terrain** ([viewer](viewer/terrain.md), [streaming](viewer/streaming.md#terrain-selection)):
  - close-up: smooth triplanar replaces random plane choice; cliff projection, cone-map parallax,
    and `A`-page subsurface curvature not drawn; fade distances are viewer-chosen; GPU cost
    unprofiled; LOD uses sample spacing (`maxHeightError` purpose unknown).
  - holes ([game-data](game-data/terrain.md#heights-and-holes)): follow base pass (alternating
    diagonals inferred); deformed-terrain subdivision passes aren't drawn (solid ground extends up
    to 1 sample further into holes in game; scenes unsurveyed); hole-touching triangles rasterize
    then discard.
  - [puddles](viewer/terrain.md#puddles): stop past leaf splat distance, ignore parallax height, no
    ripples.
- **transitions & depth offsets**: per-instance LOD and mip swaps pop without cross-fade
  (HLOD/detail, conditional, and dynamic-reach boundaries cross-fade over 0.35 s); ground-blend and
  decal meshes z-fight (no depth offsets applied).

## water

- **shading** ([viewer](viewer/water.md#shading),
  [game-data](game-data/water.md#how-surfaces-are-drawn)):
  - rain map is packed but unread.
  - missing: LOD-grid wave displacement, rain/character ripples, shoreline wetness, `FlowmapOption`
    1 coverage mask, sun-disc nearest-point highlight, and multiple scattering.
  - divergences: LOD surfaces draw as meshes (not resampled grid); shared-`materialIndex` configs
    keep distinct looks (game uses last loaded); underwater effects draw over water (unchecked).
- **foam boxes (`HGRP/WaterDecal`)** ([viewer](viewer/water.md#foam-boxes)):
  - missing: `_BLEND_DISPLACEMENT`, prefab `HGWaterDecalRenderer` values (neutral on map02), and
    unnamed distortion mip bias.
  - unsupported: keywords beyond `_BLEND_BASECOLOR2`, `_USE_DISTURB`, `_USE_MASK`, `_USE_SOFTBLEND`,
    `_USE_DISSOLVE`, `_USE_WATER_EROSION`, `_USE_BUBBLE`, `_USE_TWO_LAYER_FLOATING_MAP`, `_ZTest`
    outside 4/5/8, erosion combined with dissolve/distortion/mask/bubble/floating/base2, and
    `_BLEND_BASECOLOR2` with `_USE_BUBBLE` (0 unsupported `HGRP/WaterDecal` materials on map02).
  - unverified in game: Wuling falls foam, Wuling City red tide
    ([erosion](game-data/water.md#water-erosion), clamped samplers approximated), and non-acid fluid
    types.
- **water volumes** ([viewer](viewer/water.md#water-volumes),
  [game-data](game-data/water.md#water-volumes)):
  - moves are linear; floaters keep authored height with no lag; `ground_distance` and inter-volume
    transfers unread; no shoreline wetness; coinciding placed surfaces draw twice (unchecked).
  - [pumped pools](game-data/water.md#depletable-pools) offer only empty/authored/full (server start
    amount and empty-surface visibility unchecked).
  - unverified in game: Suiming lily pads (0.9 m under pit surface at stage 1 per data) and Test
    Area sewage opacity.
- **waterfalls**: Jingyu pool falls (−763, 209, −1190) and Si's Painting lily pool cascade (980,
  293, 972) read grey-teal instead of white (unverified from matching pose); at Jingyu, the VFXWater
  sheet sits inside the rocks in front of the falls.

## effects and particles

- **scene effects** ([game-data](game-data/effects.md), [viewer](viewer/effects.md)): drawn are
  VFXBaseV2, VFXDecal, VFXDitherAlpha, simpler VFXAdvance variants, CharacterNPR_VFX, VFXRefract,
  VFXWater sheets, six-way smoke, and mist (FogSimple, VFXFakeVolumeFog). all other shaders and
  variants show as [unsupported](viewer/materials.md#unsupported-materials).
  - **VFXAdvance** ([game-data](game-data/effects.md#vfxadvance)): missing second disturb texture,
    polar/screen UVs, edge colour, interiors, `_FogIntensity`, and ink simulation. lit
    (`_USE_LIGHTING`) VFXBaseV2 Fresnel mixes before lighting (unchecked). unverified in game: Deep
    Dale Street normal-mapped floating rocks, dissolving walls, Yinglung Pass ink rooms
    (`…_inkroom_floor_*`, `inkarea_*` shown within 8 m), and Si's Painting ink road over cave falls
    (draws mostly white).
  - **ink wash** ([game-data](game-data/effects.md#vfxbasev2)): screen effect not drawn, so
    ink-wash-only VFXBaseV2 materials are `undrawn` (`debug/assets.json`).
  - **CharacterNPR_VFX** ([game-data](game-data/effects.md#characternpr_vfx)): drawn as VFXAdvance
    without dissolve, nonzero `_VertCameraOffset`, or other keywords. Marker Stone Interiors rift
    monsters measure shell screen UVs from prefab origin (unverified in game).
  - **invisible bridges** ([game-data](game-data/effects.md#invisible-bridges)): fire seed reveals
    around camera at max level by default without radius easing; northern bridge's server-driven
    group stays hidden; look and pre-script reveal radii (0 without fire seed) unverified in game.
  - **VFXBaseV2 & VFXDecal**: unsupported/missing — VFXBaseV2 additive blends; VFXDecal outside
    `_BlendMode` 1; `_BlendMode` 2 non-multiply or stenciled; opaque with stencil, soft blend, or
    edge colour (opaque fogged by composite; falling gravel unchecked); 6th texture + vertex offset;
    vertex offset mask + all 5 textures; scan-line/fixed-point/player brightening; non-autoplaying
    or particle-driven rigid-body VAT; fluid/particle VAT; lit/Fresnel/vertex-offset/particle-driven
    soft bodies (Aurelyne blob unchecked); [water blending](game-data/effects.md#water-blending)
    (below-height fragments show checker, surface height ignored); VFXDecal `_USE_IN_PARTICLE`,
    lighting, 3D textures, parallax + blend layer, stencil masks outside 0/32; local lights on lit
    effects (irradiance sampled per-pixel, not per-renderer). VFXBaseV2 breathing pulses in sync
    across placements; Dijiang clue board and aisle-guide edge colour unchecked.
  - **VFXDitherAlpha**:
    - effect variants blend without dithering/depth and support distortion, mask, dissolve,
      polar/screen UVs, vertex offset, and `_USE_MAIN2` (unsupported: lit, other dither modes,
      object-relative screen UVs, lone vertex offset, `_INK_COLOR_DISTORT`; on NoLighting, dissolve,
      polar/screen UVs, `_USE_MAIN2` — e.g. Si's Painting `…_inkpattern_huge_01_fj_12`; G-buffer
      path draws still textures only, leaving Marker Stone Interiors
      `p_fxmap_map02_lv004_inkpattern_801`/`_802` unsupported).
    - lit still-mask surfaces draw (Qingbo reeds/leaves, Yinglung Pass camphor leaves, unchecked)
      without `_IgnorePostExposure` scaling.
    - plain variant ignores mesh vertex alpha (uses particle alpha), steps dither by viewer jitter,
      and draws `_USE_MAIN2` without dither (Wuling City red-tide walls, unchecked).
    - unverified in game: NoLighting fogging, Si's Painting ink plane, North Wuling
      `M_fxmap_map02_lv008_wind_water_2501_nld`, cave ink sheet `…_crack_cave_01_fj_01_d`, and Very
      Large Rift escaping trails.
  - **VFXWaterDitherAlpha** ([game-data](game-data/effects.md#solid-effects)): drawn as plain
    VFXDitherAlpha; `_SUBSURFACE` uses sun + ambient only (no local lights); sequence-frame variants
    unsupported (1 map02 material); Si's Painting cave-falls and Wuling City dam splashes
    unverified.
  - **VFXRefract** ([game-data](game-data/effects.md#refraction)): no saturation, Fresnel mask,
    trail, or mesh UV1 custom data; scene copy includes water/fog (unchecked). Deep Dale Street
    fog-wall haze, balloon glitch, and Valley Pass fire-column haze unverified.
  - **VFXWater**: missing punctual lights, matcaps, `VFX_WATER_SIMPLE_LIGHT` probe (uses full
    lighting), `_UseVertexColorAlphaAsDissolveWeight`, and 4-tap normal-offset sun-shadow lookup.
    soft bodies with flipbook/normal-map/particle data stay unsupported (frame offset = 0);
    waterwheel pouring water and `VFX_WATER_REFRACT` liquid falls unverified in game.
  - **six-way smoke** ([game-data](game-data/effects.md#six-way-smoke)): no shadow ramp, local
    lights, or main texture; UV1 mask/dissolve unsupported on meshes; unverified in game (including
    Valley Pass fire column and its screen-space blend).
  - **mist** ([game-data](game-data/effects.md#mist)): lit cards use mesh normal (not normal map);
    no card fog, box depth prepass, vertex colour, or non-additive boxes; distance-LOD centre
    inferred. Suiming cave-exit card unverified; Si's Painting lily-pool box (946, 295, 973) hazes
    pads 15 m out too strongly (PC exposure divisor and `Material.SetColor` linearisation untraced).
  - **global effect overrides**: `VFXSceneDark` `_VFXParams1` overrides not run (Jingyu blight reads
    less saturated).
  - **portals** ([game-data](game-data/effects.md#portals)): no mask colour/depth, keep/replace
    only, requires `depth32float-stencil8`.
- **reflection-only effects** ([game-data](game-data/effects.md#reflection-only-effects)): not drawn
  and do not write SSR normal/roughness/depth. next: compare reflections behind the Very Large Rift
  portal ring with an in-game shot.
- **effect distance bands** ([game-data](game-data/effects.md#effect-lod-tables)):
  - switch without fade; billboarded offset does not turn with camera; prefab renderers only (static
    scenery unchecked); quality fields (`settingLodLevel`, `platformLayer`) ignored; missing band
    info treated as on (unchecked).
  - non-dynamic prefabs band all settings by camera (game's per-setting driver untraced); dynamic
    structures follow LOD proxy, fall back to last band on gaps, and leave unlisted saved-off roots
    off.
- **particles** ([game-data](game-data/particles.md#particle-systems),
  [viewer](viewer/particles.md#particles)):
  - **frozen mesh particles**: lose start colour, drift, and spin; take midpoint of random
    constants.
  - **played systems**: ignore noise, collision, trigger, light, by-speed, and non-Birth/Death
    sub-emitter modules; use viewer RNG; advance only while rendering (fish school circles without
    noise wobble); flipbook copies step in phase.
  - **trails** ([game-data](game-data/particles.md#trails)): follow Unity docs (unverified, e.g.
    purification swirls `dung01_wrdg001` ~2, 355, 208); fixed 9 points/trail (ignoring
    `minVertexDistance`); `worldSpace` unread (moving emitter drags trails). omitted: ribbon mode,
    other texture modes, trails outliving particles, and trails on looping-ring-buffer/force-field/
    speed-limited systems.
  - **stand-ins**: non-play-on-awake; renderless systems without supported trails (map02 water
    ribbons) or driving active particle lights / non-Birth/Death sub-emitters (empty renderless
    systems with null targets are omitted); curve start delay/drag; per-axis speed limit;
    speed-modifier curve + drag without speed limit; non-sphere or vector-field force fields;
    unsupported shapes (< 20 map02 systems: single-sided/box edges); mesh shapes with texture,
    Loop/PingPong edges, or mixed topologies; sprite sheets, non-lifetime/fps sheet timing, sheets
    > 64×64.
  - **approximations**: random-range rate emits at mean; rate curve uses exact integral (waterwheel
    pouring water unverified); unclamped drag slows only start velocity and gravity; orbits rotate
    whole path; force fields limited to same prefab (no wind zones/scene fields); ring-buffer loop
    replays path; `Facing` → `View`; velocity-billboard roll is viewer-chosen; Loop/PingPong mesh
    bursts pick randomly and count from start delay; cone/circle arc mode/spread (~20 map02 systems)
    and sphere/hemisphere arcs ignored; stretched quads ignore camera velocity and
    `m_NormalDirection < 1`; sheared Hierarchy particles size by axis lengths instead of lossy scale
    (Jingyu big waterwheel splashes ~1/3 wider).
  - **limits**: 1024 live particles/emitter (a few map01 systems exceed slightly); ring-buffered
    particles can outrun bounds; colours clamped to `[0, 1]` (RGBA8); colour-mode custom data
    unpacked (unused on map02).
- **spline movers** ([game-data](game-data/particles.md#spline-movers)): Dijiang shaft cargo
  lifetime formula (`length / maxSpeed`) unverified; LOD renderers draw at group origin; noise,
  speed/lifetime curves, non-box emission, or > 4 LOD groups stand in; `hasAlphaControl` fade
  omitted (Qingbo buckets and Sword Vault Dale floating stones pop in/out).
- **missing mist**: Marker Stone's low valley mist banks are missing (source unknown).
- **transparent sorting** ([frame](viewer/frame.md)): sorts by sorting band (static scenery fixed at
  0; ECS band byte untraced), render queue, then distance to bounding-sphere centre (game measure
  untraced); renderer priority ignored; only adjacent identical draws batch. corroded planet plume
  through Dijiang deck glass unverified for brightness.

## scenes and conditional content

### world and streaming

- separate scenes (interiors, offices, arenas) are unvalidated.
- HLOD-unload volumes (`FBStreamArea` root slots 7–9) are undecoded
  ([world](game-data/world.md#stream-areas)).
- **HLOD/detail swaps** ([streaming](viewer/streaming.md#instance-selection),
  [HLOD](game-data/world.md#lod-and-hlod)): swap per tile at a ring, not per cluster via HLOD links
  (unpacked). multi-leaf clusters swap early, children in other leaves can double-draw or vanish,
  and unloaded children still hide their cluster. rings use PC high (4000) in 3D from camera to tile
  bounds (vs XZ from player to cells), and HLOD2 stays drawn past 2048 m.
- **streaming layers** ([world](game-data/world.md#streaming-layers)): read but unapplied (`Tiny`/
  `Lighting` draw to `Default` radius; global HLOD-layer scenery draws at any distance).
- **dynamic structures** ([load grids](game-data/world.md#dynamic-load-grids)): load around camera
  (not player), without per-row radius test. facilities and Dijiang cabin scenes (no `fb_main` grid)
  draw within `detailDistance`.
- **straddling HLOD tiers** (e.g. `dung02_dg002` HLOD1): filed under one of the two straddled tiles
  ([tile tree](package-format.md#tile-tree)).
- **billboards** ([assets](game-data/assets.md#billboards)): mesh renderers only (skinned meshes and
  particles stay as authored); offset renderers turn in place rather than orbiting; modes 2–3 use
  world +Y instead of local up (tilted placements face wrong).
- **AIC buildable grid** (`factorygrids/fbgrids_*.bytes`): no decoder.
- **path-hash misses**: some mesh/material hashes are absent from the install's path-hash table
  (counted in pack report).

### interactives and animation

- **interactives & view states** ([game-data](game-data/interactives.md)):
  - draw settled pose from starting `state` only (server/script updates unfollowed).
  - only vertical rope `RopeLength`, lift door bools (lifts stay at starting floor), and broken
    robot `level`/`damage_type`/`exit_type` are read before view states start.
  - `VFXAdjustLength` omits renderer bounds (boxes the prefab); `PositionFollower` holds its walk
    position under looping clips.
- **interactive effects** ([one-shot](game-data/effects.md#one-shot-effects),
  [at rest](extraction/prefabs-and-interactives.md#effects-at-rest)):
  - one-shot effects, transition bursts (talosite activation), and door/bridge/facility-form looping
    effects are not drawn; effects on looping-clip GameObjects hold end pose.
  - component-placed effects draw only jump-pad arrows, vertical jump-pad vents, and laser-gate
    beams (unverified in game); `int_electric_fence` (server-powered) draws without beams; factory
    power-network AIC buildings (The Hub power ports) have no client positions
    ([laser gates](game-data/interactives.md#laser-gates)).
- **looping clips** ([extraction](extraction/prefabs-and-interactives.md#looping-clips)):
  - move skinned bones and mesh-renderer Transforms, not billboards or particles.
  - float material properties step per frame (not interpolated); vectors, colours, non-numeric float
    effects, ACL curves, and GameObject switches hold end values.
  - all placements play in sync from viewer clock 0 (advance only while rendering); per-renderer
    frame storage (Qingbo octagonal waterwheels: dozens of renderers × >1000 frames). balloon sway
    and tube [vertex offset](viewer/materials.md#vertex-offset) unverified in game.
- **player-presence & facility keys** ([game-data](game-data/interactives.md#keys-the-player-sets)):
  facility forms settle with all keys false; campfire `InZone` uses 2.5 m template radius (not
  runtime inner radius); `Distance` assumed 3D; `InBattle` and `isDead` stay false.
- **two-state interactives** (server/script switches unfollowed; both states previewable):
  [doors](game-data/interactives.md#interactive-doors) default closed (open for Dijiang cabins);
  [campfires](game-data/interactives.md#campfires) default activated (no fight look or colour-layer
  VAT); [template Animator bools](game-data/interactives.md#template-animator-parameters) (The Hub
  comm terminal `fixed`) default set (ints/triggers unset);
  [telescopic bridges](game-data/interactives.md#telescopic-bridges) default retracted.
- **script-spawned interactives**: not placed (`indie_race001` moving platforms/coins, open-world
  event pieces — server script triggers unknown).
- **auto-moving platforms** ([game-data](game-data/interactives.md#auto-moving-platforms)):
  - start at viewer clock 0 without loop-end overshoot.
  - stay at placement: player-wait knots, curve-turning/variable-speed/stopping platforms
    (`unsupported-interactives.json`), server-started platforms (map02 floating tower `10200030295`
    at fire seed altar), and other scripted curve movers (coins, butterflies, kickable balls).
  - prefab lights and component-placed effects stay behind; world-space particles move with the
    platform instead of trailing.
- **bamboo rafts** ([game-data](game-data/interactives.md#bamboo-rafts)): stay at placement (docks,
  spline, and server dock unread); wakes not drawn.
- **crane towers** ([game-data](game-data/interactives.md#crane-towers)): draw starting steps with
  hung container only (no controls for server-saved steps).
- **gameplay locks** ([game-data](game-data/interactives.md#gameplay-locks)): draw locked look only
  (no unlocked control, no lock-mounted effects).
- **late-spawned rows (`createState ≠ 0`)** ([spawning](game-data/interactives.md#spawning)): gated
  by one per-level "created during play" toggle (default off).
- **unsupported interactives** (`debug/unsupported-interactives.json`): missing model IDs, data-less
  templates (weapon-wall racks, some doors), ambiguous variant positions, ambiguous door open-idle
  states, and unimplemented LevelData fields (locks/splines decode fails on Dijiang). missing
  template/model → [stand-ins](package-format.md#stand-ins); rest omitted.
- **skeletons & animators** ([animation](game-data/animation.md)):
  - unposable skeletons and nonzero blend shapes → stand-ins; character skeletal animation unplayed.
  - [scenery animators](game-data/animation.md#scenery-animators): blend trees, additive/partial
    layers, override controllers, and view-state model Animators hold saved pose.
  - [moving emitters](viewer/particles.md#moving-emitters): world-space velocity/forces keep
    end-pose frame; local gravity uses instantaneous frame; emitters ending at zero scale hold end
    pose.
  - [ACL clips](game-data/animation.md#acl-compressed-clips): Transform tracks only (no float tracks
    or root motion); databases, non-trivial defaults, and Euler bindings hold end pose.
  - [decoration animators](game-data/animation.md#decoration-animators): start-time constant/single-
    property sets only (`PlayDecorationAnimation` and quest/custom/volume sets unread; saved
    properties assumed set).
  - non-Lit VAT meshes (`_vat`, e.g. floating rocks) draw rest pose.
- **spinning scenery** ([game-data](game-data/animation.md#spinning-scenery)): Qingbo waterwheels
  and originium hub frames start from stored pose at clock 0 (native system inferred). prefab
  MonoBehaviour rotators (`DynamicSceneSimpleRotate`, `TransformRotateAroundAxis`) hold still
  (unsurveyed; waterwheel rotators turn only colliders/decals).
- **world-space UI**: runtime UI (Dijiang cabin nameplates, operator panels;
  [cabins](game-data/scene-states.md#dijiang-cabins)) and prefab world-space canvas Images/Text
  (weapon-wall counters) are not drawn.

### scene states and controls

- `ActivityControlComp`-only entities are ungated (every owner's component is empty,
  [open](game-data/scene-states.md#open)).
- **runtime-moved scenery** ([other runtime state](game-data/scene-states.md#other-runtime-state)):
  draws as authored (bamboo puzzles, rune columns, script-moved/attached entities, scripted factory
  buildings, conveyor motion, scripted water look overrides); LevelData energy-point environment
  volumes unread.
- **event placements** ([game-data](game-data/scene-states.md#event-placements)): photo spots share
  one control per scene; other event placements recognised only via missions/dungeon scripts.
- **doodads**: resource nodes ([doodad groups](game-data/scene-states.md#doodad-groups)) share one
  level control per level (per-group LevelData source unread);
  [graded doodads](game-data/scene-states.md#graded-doodads) (breakable crates) use one map-wide
  development level (per-level overrides unread; rest-look claims keep template model).
- **cross-map streaming levels**: facilities and `pack <scene> --level` only include levels
  belonging to the scene's own map, dropping levels from other maps (`base01_lv003`/`indie_dg014` on
  `base01_lv001`; `dung02_rdg012` on `dung02_rdg008`). selecting by
  `defaultState.exportedSceneConfigPath` would require the viewer to separate overlapping levels.
- **variables & dynamic view states**:
  - numbered global variables and MapConfig-named ones stay separate controls (no name table);
    non-interactive map variables show raw names/numbers.
  - server-set variables stay separate or at default max: Yinglung Pass outpost tiers (all 4 show,
    [outpost tiers](game-data/scene-states.md#outpost-tiers)), gateway blockers (`007to009`,
    `008go010deco_v1d6`, [variables](game-data/scene-states.md#variables)), and Snowy Forest cabin
    `woodhouse` (pre-ritual look).
  - [cross-map variable gates](game-data/scene-states.md#gates-on-another-maps-variable) never load
    (e.g. Typhoeus's after-ritual cabin).
  - [dynamic view states](game-data/scene-states.md#view-states-on-dynamic-entities) pose by first
    variable only and draw as saved for untested/unset values, type-5 controllers, trigger-driven
    controllers (lotus leaves), and script-named states. Wuling bridges' empty-model-override
    suppression is inferred.
- **outpost upgrades** ([game-data](game-data/scene-states.md#outpost-upgrade-missions)): whether
  `upgradeMissionId` raises the level immediately or only unlocks it is unverified (treated as one).
- **scripted state & water**:
  - unrepresented: `SetOverrideSceneState`, runtime-computed water fills
    (`waterScriptActionsComputed`), and shop/depot/terminal/doodad form-to-level mappings; map02
    sludge cores hide active vs inactive (`1` vs `0`) under one present/cleansed toggle
    ([sludge and miasma](game-data/scene-states.md#sludge-and-miasma)).
  - manual only: script-driven water levels (don't follow drivers; set amounts assumed to animate,
    not snap) and scripted environment volumes (blend mode 3, default off, preview at full
    strength).
- **script groups**: drivers come from client scripts only (server-driven show as "server"; unnamed
  groups have none). trigger-volume groups follow the camera only when nothing else sets them
  (mixed-driver, tilted-polyline, and leave-only volumes are manual; assumes script running, fresh
  camera enters, ignores player capsule radius).
- **script visibility**: script-shown/hidden interactives default shown; script-slot and
  runtime-computed targets untraced (`scriptVisibilityUntraced`). LevelData type-hiding function
  areas unapplied (`unsupported-interactives.json`).
- **unrecoverable conditions**: server/event conditions and script relationships beyond client data.
- **labels**: many controls still display internal IDs or representative mesh names.

## renderer and performance

- **viewpoints**: game [teleport points](game-data/world.md#teleport-points) are not packed
  ([named places](game-data/world.md#named-places) from region toasts are packed in
  `manifest.places` and shown in the levels panel).
- **CPU selection**: `.fol` foliage blocks use a whole-block GPU-cull fast path; GPU-culled buckets
  still emit one encoded draw each ([performance](viewer/performance.md#optimization-candidates)).
- **shadows**: layers redraw whole on selection changes (no tiled far-map cache,
  [performance](viewer/performance.md#optimization-candidates)).
- **geometry pools**: never shrink, leaving spare capacity outside the stream budget
  ([GPU resources](viewer/gpu-resources.md#buffers-and-pools)).
- **profiling & budgets**: close-up terrain blending and timestamp-query overhead are unprofiled;
  large regions evict content during flight at the default budget.
- **texture mips** ([mip feedback](viewer/streaming.md#mip-feedback)): feedback-driven loading blurs
  newly uncovered surfaces briefly (vs game's CPU estimate). glass, effects, shadow-only casters,
  parallax/layer slots, and feedback-incapable devices fall back to instance screen size. textures
  and meshes share one budget (game budgets textures alone).
- **TAA** ([frame](viewer/frame.md)): dynamic motion vectors cover GPU cloth,
  cloth/pendulum/mushroom sway, vertex-offset meshes, and sludge waves, while skinned/VAT,
  spinning/riding instances, particles, and transparent effects still reproject by static depth.

## packaging

- **pack cache** ([extraction](extraction.md#pack-cache)): entities phase (~20 s on map02) isn't
  cached.
- **duplicate asset IDs** ([conversion](extraction.md#asset-conversion-and-workers)): assets reached
  both by path hash (static) and object (prefab) still convert twice on a cold pack, then compact
  into one geometry/material table entry before emission.
- **prefab LODGroups**: switch on packed `LODG` reference spheres without cross-fade or game LOD
  bias.
- **textures**: formats without WebGPU equivalents fail
  ([asset classes](extraction.md#asset-classes)).
- **instance blocks**: full f32 rows could shrink ~50% with meshopt filters or quantization
  ([instance block](package-format.md#instance-block-inst-efin)).
- **archive grouping**: global scenery pulls assets into `assets/common` instead of placing by
  bounds ([asset placement](package-format.md#asset-placement)); off-square edges create sub-KB
  shards.
- **`geometricError`**: placeholder (`edge / 16`) used only for request ordering
  ([tile tree](package-format.md#tile-tree)).
- **terrain**: cliff-index pages and cone maps are not packed
  ([terrain](game-data/terrain.md#tiles-and-placement)).
- **path hashing**: port the game's hash to avoid reverse-scanning the path-hash table
  ([asset resolution](extraction.md#asset-resolution)).
- **meshes**: collision-only meshes, `m_CompressedMesh`, and line/point topologies are rejected;
  built-in Unity PPtrs resolve only Quad and Cube; `FormatError` prefabs become stand-in cubes
  ([mesh](extraction.md#asset-classes), [geometry blob](package-format.md#geometry-blob-mesh-efgm)).
- **shared loader**: move environment-agnostic package loading into `package-format` so packer tests
  exercise viewer code.

## open unknowns

- HLOD material/atlas mapping ([LOD and HLOD](game-data/world.md#lod-and-hlod))
- per-controller meaning of progression bit 0 ("unbuilt" vs "level 1",
  [progressions](game-data/scene-states.md#progressions))
- runtime: BC texture support in Safari; texture-array layer limit on Apple GPUs

## code follow-ups

noticed during code reading; none verified as a visible bug. paths are under `packages/`. delete
entries once resolved or ruled out.

### possible bugs

- `extractor/src/game/prefabs/animator-defaults.ts` `transitionHolds`: mode 5 (exit time) holds,
  while conditionless transitions wait on exit time and are never taken.
- `extractor/src/game/interactives/bridges.ts` `telescopicPieces`: undocumented 64-piece cap.
- `extractor/src/game/materials/surfaces/dithered.ts`: drops dither test for `_USE_MAIN2`, though
  the game's depth pass still dithers.
- `extractor/src/game/effects/particle-system.ts`: speed-modifier curve + drag + force fields
  without speed limit stands in, though the stepped path supports it.
- `extractor/src/pipeline/tables/water.ts` `volumeSurface`: hardcodes `meshNormals: false` where
  `surfaceEntry` gives `true` for proxy surfaces (equivalent on flat polygons).
- `extractor/src/game/interactives/template-data.ts`: `state` lookup falls back saved → config →
  temporary, whereas [interactives](game-data/interactives.md) describes `saveProperties` alone.

### duplication

- **extractor interactives**: `toFloat` (`crane-tower.ts`, `curve-move.ts`) vs `atomFloat`
  (`template-data.ts`); `craneTowerOf` duplicates `componentParams` merge; `cranes.ts` duplicates
  `InteractiveRow.scaleOf`; `startState` and `entityProperties` both parse `templateVariant`;
  `propertyAtomBits` and `templateAtoms` are near-duplicates.
- **extractor state & dynamic**: `plain` closure duplicated in `state/story.ts`; `levelCondition`
  duplicates `maskLevels`; raw literals where constants exist (resource types 5/6/7, `compare: 0` in
  `dynamic-structures.ts`).
- **extractor materials**: `_USE_MAIN2` check and `_MainTex2Color` read duplicated in
  `surfaces/dithered.ts` and `effects/dither-effect.ts`.
- **formats**: `expect`/`count`/`list`/`bool` redefined 3× in `interactive-model.ts`;
  `stream-area.test.ts` has its own FlatBuffer writer; `level-config.test.ts` holds a string pool
  test.

### CLI candidates

- `world vars <scene>`: join AutoName, MapConfig, LevelData, and DynamicStreaming variables
- `world scripts find <type>`: print level-script nodes of a type
- `vfs table <name>`: dump a config table
