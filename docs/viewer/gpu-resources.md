# GPU resource management

- **device** ([`gfx/device.ts`](../../packages/viewer/src/gfx/device.ts)): the effect and water
  pipelines exceed WebGPU's default of 16 sampled textures per stage, so the device asks for the
  adapter's limit. without BC support, package BC textures cannot stream and materials use their
  untextured look. optional stencil support enables effect portals; timestamp queries enable GPU
  profiling. what each pipeline's fragment stage binds, against the defaults the device keeps for
  samplers and storage buffers:

  | pipeline | sampled textures (16) | samplers (16) | storage buffers (8) |
  | -------- | --------------------- | ------------- | ------------------- |
  | mesh     | 13                    | 8             | 3                   |
  | terrain  | 12                    | 7             | 4                   |
  | effects  | 18                    | 14            | 3                   |
  | water    | 19                    | 7             | 3                   |

- **range allocator**
  ([`gfx/range-allocator.ts`](../../packages/viewer/src/gfx/range-allocator.ts)): first-fit over
  units, with frees coalescing neighbours so streaming in and out doesn't fragment the space without
  bound. it sub-allocates the instance-row mega storage buffer (one range per block), the irradiance
  cell buffer and the terrain height page pool (one unit per page), all
  [`GrowableBuffer`s](../../packages/viewer/src/gfx/growable-buffer.ts): they start at 128k 96-byte
  rows (12 MiB), 32 MiB and 1024 pages (8 MiB) and, when a range doesn't fit, copy themselves into a
  buffer twice the size, up to 1.5M rows (137 MiB), 192 MiB and 4096 pages (33 MiB); rect decal
  placements get a buffer of their own the same way. a level's view holds a few MiB of rows, 20–40
  MiB of cells and 4–7 MiB of heights, so they grow only as content from several views piles up
  under a large budget; they never shrink, since the budget bounds them. owners rebuild their bind
  groups when the buffer's `version` changes. surface pages use a pair of BC3 texture arrays, one
  layer per page (1024 layers, or the device's array-layer limit if lower; 34 MiB); splat pages use
  256 slots of an RGBA8 control array, a BC3 tint array and an index buffer (22 MiB); the package's
  layer textures get two BC7 arrays sized at load. the surface and splat arrays are allocated at
  full size up front, since a texture array can't grow without copying every layer. geometry gets
  one vertex and one index buffer per blob; an animated one also gets its bind pose, frames and
  skinning parameters, and its vertex buffer is writable from compute.
- **uniform ring** ([`gfx/uniform-ring.ts`](../../packages/viewer/src/gfx/uniform-ring.ts)): one
  uniform buffer in 3 per-frame regions, sub-allocated at `minUniformBufferOffsetAlignment`. callers
  fill CPU views; `flush` uploads the frame's region in one `writeBuffer`, and draws bind group 0 at
  a dynamic offset. a frame needs the main block plus one per shadow layer.
  [`render/frame/frame-uniform-writer.ts`](../../packages/viewer/src/render/frame/frame-uniform-writer.ts)
  holds the block's layout and packs it from plain inputs; a shadow layer's block is a copy with the
  layer's view-projection.
- **bind layouts**
  ([`render/frame/bind-layouts.ts`](../../packages/viewer/src/render/frame/bind-layouts.ts)): group
  0 is the frame (uniforms, shadow map, reflection cubemap, irradiance clipmaps, shadow ramp, local
  lights and their bins, cloud shadow) for every family and the volumetric fog, so a pass binds it
  once; group 1 is per family; meshes add group 2 (per-draw parameters) and group 3 (material
  textures). shadow passes bind a placeholder in place of the shadow map they render into.
  [`render/frame/frame-bindings.ts`](../../packages/viewer/src/render/frame/frame-bindings.ts)
  builds both group 0s; the streamed textures in them (reflection cubemap, shadow ramp, cloud
  shadow) are placeholders until resident, and setting one rebuilds the groups only when its view
  changes.
- **pipeline cache** ([`gfx/pipeline-cache.ts`](../../packages/viewer/src/gfx/pipeline-cache.ts)):
  modules by label, pipelines by a state key such as `mesh/opaque/back/unorm16x2`, compiled with
  `createRenderPipelineAsync` (or `createComputePipelineAsync` through `prepareCompute`, for the
  volumetric fog, the irradiance update, the auto exposure's histogram and the skinning of animated
  geometry), so they compile once per session rather than per package. renderers `prepare` the
  pipelines they use at construction, so streaming compiles nothing; only the stencil variants of
  effect pipelines compile on first use
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
  levels over; releasing a piece shrinks it the same way at the next `commit`. a piece that arrives
  before its coarser neighbour waits. BC blocks upload as stored, without transcoding. replaced textures are destroyed one commit
  later, because bindings from before the swap are still in that frame's command buffer; bind groups
  rebuild when a binding's `version` changes
  ([`gfx/bind-group-cache.ts`](../../packages/viewer/src/gfx/bind-group-cache.ts) keeps the
  material, effect and water groups by the versions and views they were built from).
