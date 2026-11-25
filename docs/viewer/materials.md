# materials

viewer implementation of [game-data/materials.md](../game-data/materials.md); full gaps in
[status.md](../status.md).

the mesh shader has 9 texture slots (slots 0–6 shared with scene effects, plus dedicated `TriMask`
and `OverlayMask` slots at 7 and 8) and dedicated tail rows in `Look` for emissive pulse/breathing
and sway. only features sharing the parallax slots still conflict when combined:

| feature                      | skipped / conflicts when       |
| ---------------------------- | ------------------------------ |
| `FlowGlow` (glowing foliage) | parallax slots hold anything   |
| `vertexOffset`               | parallax glow or layer present |

**animated materials**: materials with [motion](../package-format.md#materials) rebuild only their
parameters at each loop step (textures, queue, and flags stay fixed), advancing in lockstep with
skin animation (e.g. Qingbo's waterwheels) and moving only while frames render.

## emission

- post exposure for [emission](../game-data/materials.md#emission) is
  `autoExposure * viewerExposure`; `_IgnorePostExposure` divides out both.
- `_EMISSIVE_ANIM` pulse runs on the animation clock (only while frames render) in dedicated `Look`
  tail rows, so it coexists with parallax glow, layer blend, and transparent Fresnel.
  `_EnableEmissiveAnimFlicker` draws steady; `_EmissiveSpeed` scroll is unread.
- `_EMISSIVE_ANIM_SWEEP` omits the moving band: the packer scales each emission colour by
  `1 − alpha` (steady value outside the band). `_EMISSIVE_NOMAP` emits nothing.
- static scenery per-draw emission is taken as zero (uses `_EmissiveColor`). prefab
  `AnimationProperties_Emissive` resting colours and view-state emissive configs bake into renderer
  emission at pack time; albedo tint applies before emission reads albedo. breathing is unread.

## lit layers

`HGRP/LitEffect` draws as Lit (without dissolve or disturb), and `Hidden/HGRP/LitEffectBlend` draws
as Lit (without `_ObjectBlend*` soft depth blending).

- **`_TRI_CHANNEL_MASK`**: binds in its dedicated `TriMask` slot (slot 7), coexisting with `_MROMap`
  and `_EmissiveMap`. only switch-texture R blends (no slots for G/B).
  `_UseMaskRUVSetAndTilingScale` is unread.
- **`_PARALLAX_MAP`**: [pulse](../game-data/materials.md#lit-layers) runs while frames render
  ([performance](performance.md); `continuous` keeps it running); player brightening uses the camera
  as the player. without a noise map, only the pattern binds and the march reads height 0.
  `_PARALLAX_MAP_WORLDSPACE` binds `_ParallaxMaskMap` in the dedicated `OverlayMask` slot (slot 8)
  and omits `_ParallaxSignControl` (unused on map02). omitted: non-world-space `_UseParallaxMask`
  and native `_VFXParams2` global highlight.
- **`_MATCAP`**: omitted (campfire crystals lack sheen).
- **`_LAYERBLEND_TOP` / `_LAYERBLEND_MASK`**: binds `_LayerBlendMaskMap` in the dedicated
  `OverlayMask` slot (slot 8), coexisting with `_EmissiveMap`. UV set 2 falls back to UV0; missing
  UV1 falls back to UV0 (matching game). `_BaseHeightMap` has no slot and reads 0.5. omitted:
  `_LAYERBLEND_NOISEBLEND` and `_LAYERBLEND_MASK_PARALLAX_PBR`.

## foliage

- foliage sun and local lighting evaluate the [foliage model](../game-data/materials.md#foliage) per
  pixel.
- leaves and grass without `_TwoSidedNormal` keep their normal on back faces; with it (and on all
  other materials), back faces flip their normal by face winding (corrected for mirrored instances).
  grass `h` is object-space vertex height. grass card LOD omits bend and masks (normal decoding
  unread).
- `HGRP/Foliage/Trunk` adds `_FOLIAGE_TRUNK` vertex AO/ramp to Lit.
  `HGRP/Foliage/TreeFoliageCardMeshLod` draws as alpha-tested foliage.
- [glowing foliage](../game-data/materials.md#glowing-foliage) draws as Lit with a flow-glow overlay
  (`t` in seconds, unchecked). terrain blend is omitted (marked in gaps view).
- [mushroom animation](../game-data/materials.md#mushroom-animation)
  (`HGRP/Foliage/MushroomAnimation`) draws with leaf foliage lighting, no-map and Fresnel emission
  (in the unused parallax rows), and LUT-driven sway (`Slot.Parallax`, `SwayRow` with
  `SwayKind.Mushroom`) across shading, depth, cutout-depth, and shadow passes on the animation
  clock, emitting dynamic motion vectors. omits character interaction and `_EmissiveNoMapMode` 1
  vertex-colour emission (unused on map02).

## swaying cloth

[swaying cloth](../game-data/materials.md#swaying-cloth) and
[swinging pendulums](../game-data/materials.md#swinging-pendulums) apply across shading, depth,
cutout-depth, and shadow passes.

- vertex-colour alpha arrives in position W
  ([geometry blob](../package-format.md#geometry-blob-mesh-efgm)), so depth passes need no extra
  stream. skinned geometry drops the weight (swaying animated meshes stay still).
- wind clock advances with the animation clock at the blended environment's
  [wind](../game-data/environment.md#wind) rate (one clock for all placements; still air without an
  environment; pauses when idle). `_DisableAnimateVert` is 0; writes dynamic motion vectors from the
  previous wind clock.
- pendulums use exact sin/cos instead of Taylor series (within 10⁻³); the packer grows bounds by
  turn reach on all axes. pendulums with gravity, custom anchor, or no swing (none on map02) stay
  still and record a gap.
- **cloth simulation** ([game-data](../game-data/materials.md#cloth-simulation)): `ClothSimulator`
  runs `cloth-sim-shader.ts` (compute port of `ClothSingleDispatchCS`) once per frame at fixed
  `dt = 0.023333333 s` (up to 2 substeps) over all cloths in the package's `.clth` blob using
  `WindNoiseTex` and the blended environment's wind intensity/direction. the mesh vertex stage
  (`vsMain`, `vsDepth`, `vsDepthFade`, `vsCutoutDepth`) binds vertex colour (stream 5) and skins
  object-space positions from the resulting 3×4 skeleton buffer before sway, also reading the
  previous frame's skeleton buffer (`@group(1) @binding(5)`) to emit dynamic motion vectors for TAA
  and SSR. omits character capsule colliders.

## vertex animation textures

the packer bakes [VATs](../game-data/materials.md#vertex-animation-textures) into
[skeletal animations](../package-format.md#geometry-blob-mesh-efgm) (one bone per rigid piece/soft
point, or existing bones; [extraction](../extraction.md#asset-classes)). surfaces read nothing of
them.

- keywords record a gap only for skipped cases (per-draw frame, particle data, kept mesh normals,
  missing rotation texture).
- bone weights are normalized at pack time (game blends as stored). soft-body normals/tangents
  rotate `+y`/`−x` by the bone; tangent keeps the mesh's bitangent sign (game uses 0).
- loops run on the animation clock, interpolating frames (game steps them) in sync across
  placements. meshes with multiple animations (e.g. map02 machine parts at 5 speeds) or on
  posed/animated renderers stay still (listed in `debug/assets.json` under `unanimated`).

## vertex offset

[vertex offset](../game-data/materials.md#vertex-offset) adds to sway in the vertex stage:

- **passes**: applies only to alpha-tested looks (opaque depth reads positions only; all map02
  materials with the keyword are alpha-tested). stays off while alpha or offset textures stream so
  colour and depth never split.
- **clock**: scrolls on the animation clock (seconds), in step across placements.
- **weights and bounds**: vertex-colour alpha reads from position W; packer expands mesh bounds by
  offset reach. skinned meshes drop the weight (weighted offsets stay still; unweighted ones, like
  the balloon, apply after skinning). object-space directions transform by the draw transform
  (prefab transform for posed skinned meshes).
- **omitted**: normal-direction offset (`_OffsetSwitchDir` 2; depth passes lack normals), offset
  colliding with parallax glow or layer, unset offset texture. fractional `_OffsetUVSet` rounds to
  the nearest set.

## glass

[glass](../game-data/materials.md#glass) shades like Lit, with opacity from `_AlphaMaskChannel`
times `_BaseColor.a` (tint alpha alone while streaming; × vertex R with
`_Use_VerexTexColorAsOpacity`, discarding below 0.01 on non-premultiplied glass), no shadows.
premultiplied glass (src factor 1) adds full radiance and dims behind by opacity. `_USE_FRESNEL`
adds Fresnel emission and modulates opacity; `_SUBSURFACE` forces dielectric shading and scatters
through the subsurface model; `_Zwrite` routes to `transparentDepthWrite`.

draws in the [transparent pass](frame.md) far-to-near with effects over the composited scene, fogged
at its own distance before blending (so distant effects behind glass, like the corroded planet's
plume behind Dijiang's deck, dim through the pane).

## decals

[decals](../game-data/materials.md#decals) draw back-face cubes without depth test directly into the
G-buffer after the main pass and before AO, SSR, and deferred lighting:

- **shared look & placement**: placements share one material look and draw the VFXDecal cube with
  per-placement colour and UV transform. `_DrawOrder` is unread (no set overlap order).
- **G-buffer blending**: `HGRP/DecalLit` reads main-pass depth plus copies of G-buffer A and B,
  blends normal/roughness/metallic/occlusion in 3D/linear space while leaving unwritten channels
  untouched, adds emission, and hardware-blends albedo (and `_BLEND_WETNESS` darkening) into
  G-buffer C via premultiplied-over blending. SSR and deferred lighting automatically see the
  updated G-buffer surface.
- **stencil emulation**: a flag bit in G-buffer B replaces the stencil bit for looks writing
  `_StencilRef` with bit 32; lit decals and wetness decals skip those pixels, and VFXDecal boxes
  with read mask 32 test it (other read masks are unsupported).
- **wetness decals**: `HGRP/WetnessDecal` writes into a `rg8unorm` wetness mask using `max` blending
  (matching the game's `WetnessDecal` pass, so overlapping boxes never double-wet), and deferred
  lighting applies wetness once per pixel using G-buffer A's porosity.
- **unsupported**: keywords beyond `_COMPLETE_PBR`, `_NORMAL_ANGLE_BLEND`, `_BLEND_WATER_FLOW`,
  `_BLEND_EMISSIVE`, `_BLEND_SLUDGE_EROSION`, `_BLEND_WETNESS` (footprints, UV noise, arcs); sludge
  without texture or combined with water flow/emission; wetness with another blend keyword or
  without albedo write.

## matte paintings

[matte paintings](../game-data/materials.md#matte-paintings) fold alpha scale into the cutout
threshold (reusing alpha-test depth), fog in composite, and wait for texture residency.
`_UseMainTexAsAlpha` is unread; non-UV0 textures are dropped.

## forward Lit

[forward Lit](../game-data/materials.md#forward-lit) (`HGRP/LitForward`, e.g. golden chest) draws as
standard Lit in the main pass without optional layers. it reflects the scene sky cubemap and SSR
instead of its `_CUSTOM_IBL` cubemap, making metal darker than in-game.

## erosion

[erosion rock and clearable blight patches](../game-data/materials.md#erosion) plus map02's
[sprayable sludge](../game-data/scene-states.md#sludge-and-miasma) reuse Lit texture slots and omit
`_ObjectBlend*` / `_LineBlend*` soft blending, `HGRP/ErosionDynamic`'s `_ANIMATION_FEATURE_*` vertex
displacement, and `HGRP/SludgeV2`'s `SludgeDecal` / `SludgeBlend` passes.

## unsupported materials

unhandled materials can display a 0.5 m world-space magenta/black checker (double-sided, unlit,
exposure-invariant, no shadows) via two off-by-default toggles:

- **"unsupported materials"**: meshes whose material lacks a viewer look.
- **"missing content"**: package [stand-ins](../package-format.md#stand-ins)
  (`DrawRole.Unsupported`).
- when off, both are skipped.

what becomes unsupported: effect shaders without a look ([effects](effects.md)); effect materials
with unhandled keywords, blend modes, stencil ops, texture combos, or UV sets (>1, or >0 for
VFXWater/VFXRefract); unhandled lit decals or ones lacking placement/base map; non-effect additive
materials; shaders without a family (`HGRP/CharacterNPR`, etc.); failed conversions.

the extractor classifies these when [describing surfaces](../package-format.md#materials) and writes
`unsupported`, `keywordsNotDrawn`, and `slotErrors` into `debug/assets.json`. surface shaders draw
without unread keywords (marked in the [gaps view](#gaps)) rather than checkering whole scenes.

intentionally undrawn (invisible in game): `HGRP/WaterProxy`, lit decals writing nothing the viewer
draws, and ink-wash-only VFXBaseV2 materials ([effects](../game-data/effects.md#vfxbasev2)).

## gaps

the `gaps` debug view turns surfaces grey, stripes materials with known gaps amber/black, and lists
missing features in view (nearest first). inspect programmatically via `viewer.gapsInView()`
([driving the viewer](../driving-the-viewer.md#inspecting)).

gaps come from two sources:

- **package [`gaps`](../package-format.md#materials)**: unread keywords and skipped property cases.
- **viewer look conflicts**: slot collisions (`vertexOffset` alongside parallax glow or layer).

not tracked by `gaps`: misread properties, effect materials (marked unsupported instead), terrain,
water, dropped content, runtime per-draw values, and [cloth simulation](#swaying-cloth).
