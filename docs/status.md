# status

what the extractor and viewer cover, where they knowingly differ from the game, and what is still
unknown. topic pages carry the detail; this page is the index of gaps. update it in the same commit
that closes or opens one.

map01 and map02 are the tested regions. a scene listed by `world maps` is not evidence that it packs
or renders correctly.

## covered

- container-aware asset resolution, conversion workers and the pack cache
  ([extraction](extraction.md))
- one level at a time over shared terrain, with level-owned streaming, LOD and HLOD
  ([world](game-data/world.md), [viewer](viewer.md))
- initial and alternative dynamic structures, active prefab hierarchies and skinned meshes in their
  authored pose ([assets](game-data/assets.md))
- scene states, progressions, facility visual forms, script/event groups and dynamic load gates as
  manual preview controls with stored defaults ([scene states](game-data/scene-states.md))
- environment profiles and volume blending, water, post-processing and base-scenario irradiance
  ([environment](game-data/environment.md), [lighting](game-data/lighting.md),
  [water](game-data/water.md))

## look and lighting

- baked GI brightness is unverified against in-game shots; the native ambient scale is missing, and
  the lighting lookup has no jitter or forward-shifted clipmap centres. next: compare GPU clipmap
  samples with the bake at one point, and check clipmap seams (L0 repeats, L1 clamps)
- several ambient and sky-LUT constants are computed in native engine code and not yet recovered
- irradiance: only the base scenario is packed; scenario overlays, partial clipmap updates, the
  game's forward-shifted centres and jitter, fallback textures for cells without probes, the meaning
  of two index tables, and other index magics
- the game's own vignette (the viewer uses URP's); bloom dirt, additive upsampling and character
  bloom; colour curves are not packed
- weather: rain/snow configs are not packed, and precipitation and wetness don't render. the
  weather-script activation and property initialization are unknown, so weather stays a manual
  preview
- environment volume initial enablement and `EnvironmentEnable` script conditions, needed before any
  automatic gating
- froxel volumetric fog
- interiors, in order of impact:
  - per-instance emission overrides aren't read
  - normal-map roughness is read only when the mesh has tangents; normals are transformed by the
    model matrix rather than its inverse transpose, and every material lights the side facing the
    camera
  - shadow casters are only what's on screen and shadow-only proxies are skipped, so the sun leaks
    through roofs behind the camera
  - local point and spot lights and light beams aren't drawn
  - local reflection probes, GTAO in specular occlusion, contact shadows
- the packed tangent frame isn't decoded; tangents are regenerated
- terrain textures and blending, foliage wind and transmission, grass instancing, decals, layered
  materials
- water foam, caustics, flow tiles (packed but unread) and geometry reflections; other fluid types
  are unverified
- celestial bodies, VFX and temporal smoothing. unsupported effect meshes are suppressed rather than
  drawn opaque
- HLOD/detail, LOD and mip swaps pop without cross-fade; ground-blend and decal meshes z-fight
  without the game's depth offsets

## renderer and performance

- GPU culling and indirect draws
- per-cascade shadow caster culling and cascade caching
- terrain pass cost, composite/water reading MSAA depth, budget churn in dense areas
- per-subtree level masks in the tile tree so traversal skips other levels
- terrain outside the shown level is drawn bare; clipping or dimming it is undecided
- teleport points as viewpoints: where the game stores them is unknown

## coverage and conditional content

- separate scenes (interiors, offices, arenas) are unvalidated
- interactive LevelData decoding is strict: files with unsupported layouts are reported in
  `out/<map>/debug/unsupported-interactives.json` and omitted rather than partially scanned
- irradiance scenarios are not selected by active scene state; map and global variables are assumed
  0
- variable ids are unnamed; variables that drive entity level or animator state need a view-state
  controller and animation playback
- story-state expressions and script relationships beyond what client data proves; event and server
  conditions may never be recoverable
- control labels still show internal identifiers or representative mesh names in many places
- animated poses and nonzero blend shapes
- some mesh/material references are missing from the install's path-hash table, and one texture
  format (`GraphicsFormat` 54) fails conversion. failed exact lookups stay explicit

## packaging

- reuse unchanged archives from the previous package instead of rewriting all of them
- cache material conversion; remember failed conversions so a warm pack starts no worker; skip
  compressing duplicate textures
- texture zstd level and a max-texture-size option for a lite package (textures dominate package
  size)
- place always-resident scenery by its own bounds instead of pulling it all into `assets/common`
- port the game's path hash so lookups stop reverse-scanning the path-hash table
- move the viewer's environment-agnostic package loading into `package-format` so packer tests read
  packages through the viewer's code
- the terrain shader assumes 65² pages

## open unknowns

- HLOD switch distances (the package uses a placeholder error) and the HLOD material/atlas mapping
- per-controller meaning of progression bit 0 ("unbuilt" versus "level 1")
- weather/time state ids
- runtime: BC texture support in Safari, the texture-array layer limit on Apple GPUs
