# viewer

the viewer (`packages/viewer`) is a React shell around a WebGPU renderer. the package layout is in
[package-format.md](../package-format.md). driving and profiling it from an agent is in
[driving-the-viewer.md](../driving-the-viewer.md).

the entry points are [`src/app.tsx`](../../packages/viewer/src/app.tsx) (UI, URL state) and
[`src/viewer/viewer.ts`](../../packages/viewer/src/viewer/viewer.ts) (`Viewer`: the loaded package,
camera, scene states, options and the frame loop). the UI drives the viewer through its public
methods (`load`, `setOptions`, `flyToLevel`, `flyToPoint`, `setSceneValue` and the like) and reads
`stats` through `subscribe`. beside it in `src/viewer/`, `Renderer` (`renderer.ts`) owns the GPU
systems and submits each frame, `Traversal` (`traversal.ts`) selects and streams a frame's content,
`openScene` (`scene-loader.ts`) wires an opened package to the renderers, `EnvironmentState`
(`environment-state.ts`) blends the environment at the camera, and `options.ts`, `stats.ts` and
`sky-textures.ts` hold the options, the stats and the sky texture requests.

## layout

| directory                                                   | holds                                                                                                                                                                                               |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/viewer/`                                               | the `Viewer` shell and what composes it: renderer, traversal, scene loading, environment state, options, stats                                                                                      |
| `src/render/`                                               | GPU code by feature (`frame`, `shadows`, `terrain`, `instances`, `meshes`, `textures`, `lighting`, `sky`, `water`, `post`, `shaders/common`); `render/frame/frame-graph.ts` orders a frame's passes |
| `src/gfx/`                                                  | device setup and feature-agnostic GPU helpers: pipelines, uniform ring, buffers, samplers, placeholders, profiler                                                                                   |
| `src/streaming/`                                            | residency and selection: the stream manager, per-kind residency handlers, tile and mesh selection, texture requests                                                                                 |
| `src/scene/`                                                | camera, controls, the tile tree, ground height and level poses                                                                                                                                      |
| `src/scene-states/`                                         | scene controls (`SceneState`), their listing for the panel, water levels                                                                                                                            |
| `src/environment/`                                          | environment profiles: blending at the camera and deriving what the renderers read                                                                                                                   |
| `src/looks/`, `src/particles/`, `src/content/`, `src/math/` | materials as looks, particle evaluation, instance rows, math                                                                                                                                        |
| `src/package/`                                              | package sources, opening and decode workers                                                                                                                                                         |
| `src/ui/`                                                   | the React panels                                                                                                                                                                                    |

the CPU-only domain directories (`looks`, `particles`, `content`, `math`, `environment`,
`scene-states`, `scene`) don't import `render/` or `viewer/`, so they run under `node --test`.
`render/` imports the domain directories, `gfx/`, `scene/`, the decoded blob types of `package/`,
and from `streaming/` its types plus the layouts the two share (the GPU culler's words, the first
shadow layer of a bounds, whole-texture requests). `streaming/` reaches into `render/` for the
shadow layers' constants, the texture store it requests into, the mesh draw ranges and sort bands
its buckets are keyed by, and the geometry pool and skin types a residency holds. nothing but `ui/`
and `app.tsx` imports `viewer/`.

implementation pages link to the corresponding [game-data](../game-data/lighting.md) findings:

| page                                  | covers                                                                           |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| [loading](loading.md)                 | package sources, the dev package server, opening, decode workers, URL parameters |
| [streaming](streaming.md)             | the tile tree, instance and terrain selection, LOD, priority, residency          |
| [frame](frame.md)                     | the passes of a frame and their targets                                          |
| [GPU resources](gpu-resources.md)     | bind groups, pipelines, buffers and textures                                     |
| [performance](performance.md)         | how the frame stays cheap, a measured baseline, optimization candidates          |
| [scene states](scene-states.md)       | evaluating scene controls and the scene conditions panel                         |
| [environment](environment.md)         | blending environment volumes at the camera                                       |
| [lighting](lighting.md)               | units, sun, shadows, ambient, reflections, local lights, the irradiance volume   |
| [materials](materials.md)             | how materials become looks, and unsupported materials                            |
| [effects](effects.md)                 | scenery effects in the transparent pass                                          |
| [terrain](terrain.md)                 | terrain layers, puddles and foliage grids                                        |
| [water](water.md)                     | the water pass                                                                   |
| [sky and fog](sky-and-fog.md)         | sky, celestial layers, fogs                                                      |
| [post-processing](post-processing.md) | the post chain, AO, light shafts, lens flare, exposure, bloom, grading           |
| [particles](particles.md)             | billboards and particle evaluation                                               |

known gaps are indexed in [status](../status.md).
