# viewer

`packages/viewer` is a React shell around a WebGPU renderer. see
[package-format.md](../package-format.md) for the package contract and
[driving-the-viewer.md](../driving-the-viewer.md) for agent automation and profiling.

CPU-only domain code (materials, particles, instance rows, environment blending, scene states,
camera/tree math) stays free of WebGPU and DOM dependencies so it runs under `node --test`.

implementation pages (each links to its corresponding [game-data](../architecture.md) findings):

| page                                  | covers                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------- |
| [loading](loading.md)                 | package sources, dev package server, opening, decode workers, URL params   |
| [streaming](streaming.md)             | tile tree, instance and terrain selection, LOD, priority, residency        |
| [frame](frame.md)                     | frame passes and render targets                                            |
| [GPU resources](gpu-resources.md)     | bind groups, pipelines, buffers, textures                                  |
| [performance](performance.md)         | frame optimizations and optimization candidates                            |
| [scene states](scene-states.md)       | scene control evaluation and the scene conditions panel                    |
| [environment](environment.md)         | environment volume blending and wetness                                    |
| [lighting](lighting.md)               | units, sun, shadows, ambient, reflections, local lights, irradiance volume |
| [materials](materials.md)             | material-to-look conversion and unsupported materials                      |
| [effects](effects.md)                 | scenery effects in the transparent pass                                    |
| [terrain](terrain.md)                 | terrain layers, puddles, foliage grids                                     |
| [water](water.md)                     | water pass                                                                 |
| [sky and fog](sky-and-fog.md)         | sky, celestial layers, fogs                                                |
| [post-processing](post-processing.md) | post chain, AO, light shafts, lens flare, exposure, bloom, grading         |
| [particles](particles.md)             | billboards and particle evaluation                                         |

known gaps are indexed in [status](../status.md).
