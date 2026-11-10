# GPU resource management

- **device** ([`gfx/device.ts`](../../packages/viewer/src/gfx/device.ts)): the effect pipelines
  exceed WebGPU's default of 16 sampled textures per stage, so the device asks for the adapter's
  limit, as it does for storage buffers per stage; samplers stay at the default. without BC support,
  package BC textures cannot stream and materials use their untextured look. optional stencil
  support enables effect portals; timestamp queries enable GPU profiling. what each pipeline's
  fragment stage binds, against WebGPU's defaults:

  | pipeline | sampled textures (16) | samplers (16) | storage buffers (8) |
  | -------- | --------------------- | ------------- | ------------------- |
  | mesh     | 14                    | 9             | 4                   |
  | terrain  | 12                    | 7             | 4                   |
  | effects  | 19                    | 15            | 4                   |
  | water    | 15                    | 7             | 3                   |

- **range allocator**
  ([`gfx/range-allocator.ts`](../../packages/viewer/src/gfx/range-allocator.ts)): first-fit over
  units, with frees coalescing neighbours so streaming in and out doesn't fragment the space without
  bound. it sub-allocates the instance-row mega storage buffer (one range per block), the irradiance
  cell buffer and the terrain height page pool (one unit per page), all
  [`GrowableBuffer`s](../../packages/viewer/src/gfx/growable-buffer.ts): they start at 128k 96-byte
  rows (12 MiB), 32 MiB and 1024 pages (8 MiB) and, when a range doesn't fit, copy themselves into a
  buffer twice the size, up to 1.5M rows (137 MiB), 192 MiB and 4096 pages (33 MiB); rect decal
  placements get a buffer of their own the same way. a level's view holds a few MiB of rows and
  heights and a few tens of MiB of cells, so they grow only as content from several views piles up
  under a large budget; they never shrink, since the budget bounds them. owners rebuild their bind
  groups when the buffer's `version` changes. surface pages use a pair of BC3 texture arrays, one
  layer per page (1024 layers, or the device's array-layer limit if lower; 34 MiB); splat pages use
  256 slots of an RGBA8 control array, a BC3 tint array and an index buffer (21 MiB); the package's
  layer textures get two BC7 arrays sized at load. the surface and splat arrays are allocated at
  full size up front, since a texture array can't grow without copying every layer.
- **geometry pools**
  ([`render/meshes/geometry-pools.ts`](../../packages/viewer/src/render/meshes/geometry-pools.ts)):
  still geometry is sub-allocated out of shared buffers, so draws of different geometries bind the
  same buffers once and pick their data with `baseVertex` and `firstIndex` (the residency's
  submeshes are offset to the geometry's ranges, and the GPU culler copies them into the indirect
  arguments). `baseVertex` applies to every vertex stream, so a vertex pool keeps one buffer per
  stream, all allocated by the same vertex range; a geometry pays for every stream its pool stores,
  missing ones written as the zeros or UV set 0 an unpooled geometry would bind. there are four
  vertex pools, by UV format and stream set: _compact_ for geometry with neither UV set 1 nor
  colours (about nine tenths of the vertices at a map02 view), which stores positions, normals, UV
  set 0 and tangents and binds UV set 0 for set 1 and the normals for the colours (ignored without
  `HasColors`), and _full_ for the rest, with all six; and one index pool per index format. at that
  view a single full pool per UV format would have held about a third as much again in padding for
  missing streams; the compact split leaves almost none. pools start at 64k vertices and 1 MiB of
  indices, grow 1.5× by copying into larger buffers (up to the device's `maxBufferSize`) when no
  free range fits, and never shrink, like the other pools, so they keep the size of the most
  geometry resident at once (after flying over map02 under a small budget, the compact pool was less
  than a fifth full). a geometry's residency counts only its ranges, and the stats' pool bytes count
  the whole buffers. draws are sorted by pool within each pipeline, so the main pass rebinds vertex
  buffers a handful of times instead of for nearly every draw. an animated geometry keeps one vertex
  buffer of its own, which its skinning pass writes from compute (its bind pose, frames and skinning
  parameters beside it), and binds a zero buffer for the streams it lacks; so does a still geometry
  the pools have no room for.
- **uniform ring** ([`gfx/uniform-ring.ts`](../../packages/viewer/src/gfx/uniform-ring.ts)): one
  uniform buffer in 3 per-frame regions, sub-allocated at `minUniformBufferOffsetAlignment`. callers
  fill CPU views; `flush` uploads the frame's region in one `writeBuffer`, and draws bind group 0 at
  a dynamic offset. a frame needs the main block plus one per shadow layer.
  [`render/frame/frame-uniform-writer.ts`](../../packages/viewer/src/render/frame/frame-uniform-writer.ts)
  holds the block's layout and packs it from plain inputs; a shadow layer's block is a copy with the
  layer's view-projection, and so is a local light's shadow tile's.
- **bind layouts**
  ([`render/frame/bind-layouts.ts`](../../packages/viewer/src/render/frame/bind-layouts.ts)): group
  0 is the frame (uniforms, shadow map, reflection cubemap, irradiance clipmaps, shadow ramp, local
  lights with their shadow records, their bins and their shadow atlas, cloud shadow) for every
  family and the volumetric fog, so a pass binds it once; group 1 is per family; meshes add group 2
  (per-draw parameters, the look table, the fog's inputs) and group 3 (material textures; the mesh
  shader's is laid out in
  [`mesh-pipelines.ts`](../../packages/viewer/src/render/meshes/mesh-pipelines.ts) beside the
  effects', since its vertex stage samples two of the slots for the
  [vertex offset](materials.md#vertex-offset)). a mesh draw's parameters are 16 floats rewritten
  every frame: the geometry's dequantization, the look flags with the material's streaming state and
  the geometry's streams, the UV set transforms, and the material's slot in the look table. the look
  table ([`mesh-renderer.ts`](../../packages/viewer/src/render/meshes/mesh-renderer.ts)) holds each
  drawn material's `LOOK_FLOATS` parameters, which don't change once built: a material gets the next
  slot and its upload the first time it's drawn, a frame's new slots going up in one write per run.
  it's a `GrowableBuffer` of 704-byte slots, starting at 4096 (2.75 MiB) and doubling as a view
  draws more materials; a package unload replaces it, since the next package's ids name other looks.
  shadow passes bind a placeholder in place of the shadow map they render into.
  [`render/frame/frame-bindings.ts`](../../packages/viewer/src/render/frame/frame-bindings.ts)
  builds both group 0s; the streamed textures in them (reflection cubemap, shadow ramp, cloud
  shadow) are placeholders until resident, and setting one rebuilds the groups only when its view
  changes.
- **pipeline cache** ([`gfx/pipeline-cache.ts`](../../packages/viewer/src/gfx/pipeline-cache.ts)):
  modules by label, pipelines by a state key such as `mesh/opaque/back/unorm16x2`, compiled with
  `createRenderPipelineAsync` (or `createComputePipelineAsync` through `prepareCompute`, for the
  volumetric fog, the irradiance update, the auto exposure's histogram, the skinning of animated
  geometry, the instance culler and the depth pyramid), so they compile once per session rather than
  per package. renderers `prepare` the pipelines they use at construction, so streaming compiles
  nothing; only a mesh pipeline's stencil variants (portal masks and the effects testing them)
  compile on first use. the fullscreen post passes and the lens flare create theirs outside the
  cache, synchronously at construction
  ([`render/meshes/mesh-pipelines.ts`](../../packages/viewer/src/render/meshes/mesh-pipelines.ts)
  for the meshes, whose phases and passes are listed in
  [`draw-ranges.ts`](../../packages/viewer/src/render/meshes/draw-ranges.ts)). a draw or dispatch
  whose pipeline isn't ready yet is skipped, and the frame loop renders again once it is. common
  blend components are in [`gfx/blend.ts`](../../packages/viewer/src/gfx/blend.ts), and the position
  and normal vertex streams' layouts, which water shares with the meshes, in
  [`vertex-bindings.ts`](../../packages/viewer/src/render/meshes/vertex-bindings.ts).
- **buffers** ([`gfx/buffers.ts`](../../packages/viewer/src/gfx/buffers.ts)): buffers that start
  with data (index buffers, configs, fixed per-pass uniforms) are filled mapped at creation rather
  than through a queue write; a pass's own uniform block is a `UNIFORM | COPY_DST` buffer it
  rewrites with `writeBuffer`.
- **texture sets** ([`gfx/texture-set.ts`](../../packages/viewer/src/gfx/texture-set.ts)): each post
  pass (and the water's foam) keeps its targets for the current render size in one set, which it
  destroys and refills on resize; the set counts its bytes from the formats and mip levels, which
  the passes report to the stats.
- **samplers** ([`gfx/samplers.ts`](../../packages/viewer/src/gfx/samplers.ts)): one sampler per
  distinct state for the whole device, keyed with WebGPU's defaults filled in, so passes and package
  textures that sample alike share it. named presets cover the common states (bilinear clamp for
  render targets, trilinear repeat for materials, which water and terrain layers take with 4× and 8×
  anisotropy).
- **placeholders** ([`gfx/placeholders.ts`](../../packages/viewer/src/gfx/placeholders.ts)): 1×1
  black (all zero) and white textures in each view dimension, one set per device, bound where a
  texture is missing or hasn't streamed in; passes tell a missing texture by comparing against them.
  the viewer destroys them with the device. the shadow passes' stand-in for the shadow map is a
  depth texture of its own in `FrameBindings`.
- **texture store**
  ([`render/textures/texture-store.ts`](../../packages/viewer/src/render/textures/texture-store.ts)):
  textures arrive as pieces, the mip tail first and then one blob per larger level. the GPU texture
  holds a contiguous run of levels from the finest integrated piece down to 1×1. integrating finer
  pieces creates a texture large enough for all that can integrate at once and copies the coarser
  levels over; releasing a piece shrinks it the same way. a piece that arrives before its coarser
  neighbour waits. BC blocks upload as stored, without transcoding. replaced textures are destroyed
  one commit later, because bindings from before the swap are still in that frame's command buffer;
  bind groups rebuild when a binding's `version` changes
  ([`gfx/bind-group-cache.ts`](../../packages/viewer/src/gfx/bind-group-cache.ts) keeps the
  material, effect and water groups by the versions and views they were built from).
