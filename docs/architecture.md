# architecture

endfield-noclip is four workspace packages under `packages/`. the extractor reads a local Endfield
install with the decoders in `formats` and writes a viewer package to disk in the layout
`package-format` defines; the viewer streams that package in the browser and renders it with WebGPU.

| page                                                         | covers                                                                              |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| [extraction.md](extraction.md)                               | the extractor's commands, keys, container layers and `pack`; per-topic stages below |
| [package-format.md](package-format.md)                       | the package layout, tables and binary encodings                                     |
| [viewer/index.md](viewer/index.md)                           | the viewer: loading, streaming, the frame, and how it draws each topic              |
| [driving-the-viewer.md](driving-the-viewer.md)               | opening, posing, inspecting and profiling the viewer from an agent                  |
| [status.md](status.md)                                       | the index of known gaps                                                             |
| [game-data/world.md](game-data/world.md)                     | scenes, maps, levels, chunk files, stream areas, terrain, LOD and HLOD              |
| [game-data/assets.md](game-data/assets.md)                   | Unity objects, asset resolution, asset classes, prefabs, dynamic structures         |
| [game-data/interactives.md](game-data/interactives.md)       | interactive placements, templates and models, view states                           |
| [game-data/animation.md](game-data/animation.md)             | clips and their curves, ACL, scenery Animators, spinning scenery                    |
| [game-data/scene-states.md](game-data/scene-states.md)       | scene states, load gates, progressions, facility forms, script groups               |
| [game-data/environment.md](game-data/environment.md)         | environment phases and volumes, blending, weather                                   |
| [game-data/lighting.md](game-data/lighting.md)               | sun, shadows, ambient, reflections, local lights                                    |
| [game-data/irradiance.md](game-data/irradiance.md)           | the baked irradiance volume                                                         |
| [game-data/materials.md](game-data/materials.md)             | HGRP surface shaders                                                                |
| [game-data/effects.md](game-data/effects.md)                 | `HGRP/Effect/*` scenery effects, particle systems, effect LOD tables                |
| [game-data/sky-and-fog.md](game-data/sky-and-fog.md)         | atmosphere, clouds, celestial layers, fogs                                          |
| [game-data/post-processing.md](game-data/post-processing.md) | exposure, light shafts, lens flare, bloom, GTAO, grading                            |
| [game-data/water.md](game-data/water.md)                     | open-world water, water volumes, foam boxes                                         |

`game-data/` holds only what we know about the game: its formats, its shaders' behaviour and what it
shows in game, with unchecked facts marked as such. how our code implements any of it lives in the
[viewer](viewer/index.md) pages, [extraction.md](extraction.md) and its subpages, and
[package-format.md](package-format.md), and what it lacks in [status.md](status.md). links run from
those pages to game-data, never the reverse.

## data flow

```
install (Endfield_Data)                      local, read-only
  │  VFS catalogs + chunks → HG bundles → Unity SerializedFiles, world data, tables
  ▼
extractor (node, offline)                    pnpm extract pack <scene>
  │  decode with formats, convert meshes/textures, build tables and the tile tree
  ▼
package on disk (out/<scene>/)               core.czar + shards/ + assets/ + irradiance/
  │  served by the dev server, or opened from a local directory
  ▼
viewer (browser, WebGPU)                     range-reads blobs, streams around the camera
```

the viewer never touches the install. everything it needs is precomputed into the package, so the
runtime reads finished GPU-ready data (meshopt geometry, raw BC texel blocks, binary instance
blocks) and does no game format parsing.

## packages

| package          | owns                                                                                                                                                                                                                                                                                                                                                                | depends on                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `formats`        | decoders for the game's on-disk formats: binary primitives (`binary/`: reader, LZ4 incl. the inverted variant, KTX2, PE, flatbuffers), Hypergryph containers and tables (`hg/`), Unity serialization and asset classes (`unity/`), Endfield world data (`endfield/`)                                                                                                | `@noble/ciphers`                                 |
| `extractor`      | the CLI, local config and keys, the VFS and bundle readers with file I/O, cross-bundle asset resolution, game-data interpretation (`game/`, a folder per topic: assets, world, state, materials, effects, prefabs, interactives, dynamic, water), the packer (`pack/`: content sources, tables, instances, conversion, storage), glTF/PNG debug exports (`export/`) | `formats`, `package-format`, czar, meshoptimizer |
| `package-format` | the package contract: manifest and table types, enums, path constants, binary codecs for hot data, scene-control condition evaluation                                                                                                                                                                                                                               | nothing                                          |
| `viewer`         | package sources (HTTP, File System Access, OPFS), decode workers, streaming and tile selection, WebGPU rendering, the React UI                                                                                                                                                                                                                                      | `package-format`, czar, meshoptimizer, zstddec   |

dependencies point one way: `extractor → formats`, `extractor → package-format`,
`viewer → package-format`. the viewer never imports `formats` and `package-format` never imports
either, so game-format knowledge stays on the extractor side and a package can be read without it.

### boundaries

- **`formats` is environment-agnostic.** it takes bytes (or a `ByteSource` for random access) and
  returns plain values; it never opens files or uses `node:` APIs outside tests. code that touches
  the filesystem, caches open handles or knows install layout (`hg/vfs.ts`, `hg/bundles.ts`,
  `game/assets/assets.ts`) lives in the extractor.
- **`formats` decodes; the extractor interprets.** a `formats` module describes one layout (a
  catalog, a bundle, a TypeTree, a chunk file). rules about which records to use, how levels and
  scene states select content, and how game data maps onto package concepts live in
  `extractor/src/game/` and `extractor/src/pack/`.
- **`package-format` is the only shared contract.** the extractor writes and the viewer reads
  through its types and codecs, and the package and encoding versions are bumped on any incompatible
  change, so a stale package fails at load instead of rendering wrongly. it stays free of node and
  browser APIs for the same reason as `formats`.
- **failures are explicit.** decoders throw `FormatError` on layouts they don't recognize rather
  than guessing, and the packer records unsupported or failed inputs in its debug outputs instead of
  substituting something similar. a wrong mesh or texture is harder to notice and trace than a
  missing one.

## decisions

**extraction runs locally and offline, before viewing.** a TypeScript extractor on node reads the
install directly, with no .NET or Python step. converting a region takes minutes and gigabytes of
output, which a browser session can't redo on every visit, and keeping the install out of the
browser keeps the viewer a plain static app over prebuilt files. in-browser parsing of the install
is deferred, which is why `formats` stays environment-agnostic.

**one package per streaming scene, every level shown at once.** a package holds one scene (one world
and coordinate frame, e.g. `map02`), and every instance carries the level that owns it, but the
viewer shows all of a package's levels together, as the game streams map01's and map02's seamless
levels. a group's owning level is metadata: the current level (the `level` URL parameter, then
whichever level the camera moves into) picks the base environment, streams right after what's near
the camera, and orders the scene controls. the viewer once showed one level at a time, after Snowy
Forest's snow peaks showed over Test Area on map02; that overlap turned out to be stream-area
content, which the viewer switches by camera, and the levels themselves don't overlap. a package
holds only its scene's own map's levels, so a level streaming another scene (`dung02_gdg001` on
map02, `dung02_rdg012` on `dung02_rdg008`) never shares a package with the levels it would overlap.

**czar archives as the package container, with assets shared across levels.** a package is a small
always-resident `core.czar` plus shard and asset archives (layout in
[package-format.md](package-format.md)). czar supplies the container, per-member CRCs, deterministic
output and CLI tooling; the package keeps its own blob index in the core, so the viewer range-reads
any blob without parsing an archive header. blobs are content-addressed, so a mesh or texture used
by several levels or tiles is stored once.

**a custom WebGPU renderer.** three.js's WebGL renderer has no compute, so culling and LOD would
stay on the CPU, and its per-object scene graph cost a prototype 15 ms of CPU at 4.2k draws.
three.js's WebGPU renderer keeps per-object render lists and bind groups and compiles node materials
per material, so GPU-driven rendering would fight the abstraction. Babylon.js would put HGRP shaders
through ShaderMaterial in a heavy runtime and still leave GPU culling and LOD to us.
multi-draw-indirect isn't available in Chrome on macOS, so the draw loop stays replaceable by one
MDI call without depending on it. WebGL2 is out of scope.

**the repo holds code, never keys or game content.** the game's ToS bans reverse engineering, and
Hypergryph has had a VFS decryptor removed from GitHub by DMCA. keys are derived from the user's
install by `init` and kept in the gitignored `endfield.local.json`; extracted packages stay in the
gitignored `out/` or outside the repo; decompiled game code stays out of the repo. whoever deploys a
viewer with a package is responsible for that deployment.

**prior art is ported only from permissively licensed tools.** layouts ported from MIT projects are
credited in the module that implements them: [AnimeStudio](https://github.com/Escartem/AnimeStudio)
and AssetStudio (bundle descrambling, SerializedFile, mesh layout),
[An1X3R/Endfield-map-extractor](https://github.com/An1X3R/Endfield-map-extractor) (chunk framing,
water), [Variante/endfield_research_kit](https://github.com/Variante/endfield_research_kit) (bundle
manifest, StringPathHash, string pools, LevelConfig) and
[SaigyoujiYusora/Sora-Core](https://github.com/SaigyoujiYusora/Sora-Core) (16-bit dense animation
curves). GPL, AGPL and non-commercial tools are reference only.
