# extraction

the extractor (`packages/extractor`) is a node CLI that reads a local Endfield install and writes
viewer packages. this page covers running it, the local config and keys, the container layers it
reads through, and how `pack` builds a package: its phases, conversion workers, cache and debug
outputs. what the game data means is in the `game-data/` pages; the package it writes is in
[package-format.md](package-format.md); where the extractor sits among the packages is in
[architecture.md](architecture.md).

## running it

node and pnpm come from mise (`mise.toml`); node runs the TypeScript sources directly, with no build
step.

```sh
pnpm extract init --game <install root or Endfield_Data> [--keys-from <dir>...]
pnpm extract pack map02 [--level map02_lv001]
pnpm run dev    # the viewer lists packages under out/
pnpm extract --help
```

`cli.ts` loads every file in `commands/` as a subcommand exporting `summary` and `run(args)`, so a
new command is a new file there. shared argument helpers live in `cli-args.ts`, outside `commands/`,
because every file in that directory is treated as a command. each command's `--help`-style usage
text is in its module; run it without arguments for the details. every command except `init` takes
`--config <file>` (default `endfield.local.json` in the working directory) and opens the install
through `withContext` in `context.ts`, which mounts the VFS, builds the world index and creates the
asset resolver on first use.

| command    | what it does                                                                                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`     | writes `endfield.local.json`: the `Endfield_Data` path and validated keys                                                                                                                           |
| `pack`     | writes a viewer package for one streaming scene, optionally one level (`--level`) or a world rectangle (`--bounds`)                                                                                 |
| `world`    | the world index: client scenes (`scenes`), a map's levels and their cells, a cell's entities, a level's members, the chosen base environment per level (`env`), and path ↔ hash ↔ bundle resolution |
| `variants` | a scene's stream areas and progression controllers, and which chunk files a stream-area selection loads                                                                                             |
| `vfs`      | lists VFS groups and their files, and extracts one logical file                                                                                                                                     |
| `bundle`   | inspects bundles: header and per-class counts, objects as JSON, an object's stream data, searching container paths and classes                                                                      |
| `asset`    | decodes one mesh, texture or material by bundle and path id, follows an entity's draws, or exports a cell as glTF                                                                                   |
| `terrain`  | lists terrain scenes and tiles, and exports heightmaps as PNG                                                                                                                                       |
| `water`    | lists water surfaces by map, level or cell, counts them, and dumps water configs                                                                                                                    |

the inspection commands (`world`, `variants`, `vfs`, `bundle`, `asset`, `terrain`, `water`) are for
research and debugging; only `init` and `pack` are needed to produce a package. their glTF/PNG/KTX2
exports (`export/`) mirror Unity's X axis and use base colours only.

## local config and keys

`endfield.local.json` holds the install path (`gameData`, the `Endfield_Data` directory) and the key
material the containers need (`keys.vfsKey` for catalogs and encrypted logical files, `keys.bundle`
for the bundle cipher). it matches the gitignored `*.local.json` pattern and is written with mode
0600; keys never go into committed files or bundled code (see
[architecture.md](architecture.md#decisions) for why). `config.ts` validates its shape and key
lengths on load and tells the user to run `init` when it's missing.

`init` builds the keys in three steps (`hg/key-derive.ts`):

1. derive what the install yields: the bundle cipher's substitution box, key and IV are recovered
   from the installed client, and the chain XOR constant (`chainXor`) is searched for there too.
2. take the rest from `--keys-from`: the VFS key, and `chainXor` when the search finds none (the
   case for the current client), aren't stored in the install in a recoverable form.
   `hg/key-import.ts` reads them from local checkouts of tools that embed them
   (Endfield-map-extractor for the VFS key, AnimeStudio for the bundle cipher). without
   `--keys-from`, `init` fails naming the missing key.
3. validate every key against the install with an oracle before saving: the VFS key must decrypt a
   `.blc` catalog into a parseable layout, and the bundle cipher must decrypt and decompress the
   first data block of a few small bundles into a valid SerializedFile header. a supplied key that
   fails is an error, not a warning. `init` then reopens the VFS with the final keys and mounts the
   Bundle group, so a bad key fails during setup rather than partway through a pack.

## container layers

the install is read through three nested layers. each is decoded by a `formats` module; the
extractor adds file handles, caching and cross-file lookups on top.

| layer          | what it is                                                                                                                                                                                                    | decoder                                                         | extractor side                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------ |
| VFS            | `VFS/<group hash>/` directories per data group, each with a ChaCha20-encrypted `.blc` catalog listing logical files and the `.chk` chunk files that store them; some logical files are encrypted individually | `formats/src/hg/vfs-catalog.ts`                                 | `extractor/src/hg/vfs.ts`      |
| HG bundle      | Unity's UnityFS bundle with the signature, header, block table and directory scrambled, blocks passed through a keyed XOR pad, and data compressed with a nibble-interleaved ("inverted") LZ4                 | `formats/src/hg/bundle.ts`, `bundle-cipher.ts`, `binary/lz4.ts` | `extractor/src/hg/bundles.ts`  |
| SerializedFile | Unity 2021.3 assets files (format 22) with embedded TypeTrees, inside bundles                                                                                                                                 | `formats/src/unity/serialized-file.ts`, `type-tree.ts`          | `extractor/src/game/assets.ts` |

**VFS.** the install has two layers, `Persistent/VFS` (patches) and `StreamingAssets/VFS`. a group's
Persistent catalog is complete and supersedes the StreamingAssets one, while its chunks may live in
either layer (Persistent first). every logical file carries the MD5 of its decrypted bytes, which
`readVerified` checks. the well-known group hashes are in `VfsGroup` (`hg/vfs.ts`): Bundle and
InitialBundle hold asset bundles, BundleManifest the bundle manifest, ExtendData the StringPathHash
tables, Streaming and DynamicStreaming the world chunk data, Terrain the terrain tiles, JsonData
pooled LevelConfig/LevelData, and Table the SparkBuffer config tables. Streaming and terrain files
are wrapped in a size-prefixed inverted-LZ4 envelope (`formats/src/hg/payload.ts`).

**bundles.** `UnityBundle` is a random-access reader: it parses the header and directory, then
decodes only the blocks overlapping a requested range, so pulling one CAB out of a large bundle
reads little. the descrambling is ported from AnimeStudio.

**asset resolution.** world data references assets by 64-bit path hash; the StringPathHash tables
map hashes to paths and the bundle manifest maps asset paths to bundles and their dependency
closures. a `PPtr` names its external SerializedFile by CAB name, which can't be derived from a
bundle name, so `AssetResolver` opens the directories of the referencing bundle's dependency closure
until the CAB turns up, remembering every CAB it sees. lookups are exact: a missing hash or path is
reported, never replaced by a similarly named asset, because a substituted asset renders plausibly
and hides the gap.

**objects.** `type-tree.ts` reads any object generically from its file's TypeTree, so Hypergryph's
added fields need no per-class code. class decoders (`unity/mesh.ts`, `texture.ts`, `material.ts`,
`transform.ts`, `skin-pose.ts`) and `plain-object.ts` (configuration objects copied field by field)
build on it.

## pack

`pack <scene>` (`pack/packer.ts`, `packScene`) writes one streaming scene to `out/<scene>` or
`out/<scene>-<level>` at the repo root by default, or to `-o <dir>`. the output directory must be
empty, absent, or hold a previous package; replacing a package removes only the package's own
entries, and any other file there aborts the pack. the full option list is in the command's usage
text.

`--level` keeps the content one level owns plus the terrain under its cells; `--bounds` keeps
content whose centre lies in a world x/z rectangle. both record the subset in the manifest.
`--no-assets` skips mesh, material and texture conversion and leaves their table entries pending,
for fast iteration on everything else.

### phases

the phases run in this order and are timed individually in the report:

| phase                  | work                                                                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| setup                  | prepare the output directory, index the scene: level partition, terrain surface and tile grid, the subset, scene states, chunk files                                                                                           |
| entities               | read the scene's static chunk files with read-ahead, then dynamic structures, interactive facilities and the prefabs they place; intern draw chains and sort instances into detail, HLOD and resident groups by level and tile |
| terrain                | encode and store terrain height pages                                                                                                                                                                                          |
| environments and water | plan per-level environment profiles and volumes and the water surfaces and sectors, concurrently; then gate entities, volumes and water by scene state                                                                         |
| irradiance             | store the base-bake irradiance volume cells                                                                                                                                                                                    |
| instances              | encode and store instance blocks, attaching detail and HLOD blocks to the tile tree                                                                                                                                            |
| assets                 | convert materials, then meshes, then textures (below)                                                                                                                                                                          |
| states                 | build the manifest's levels and scene controls                                                                                                                                                                                 |
| write                  | build the tree and tables and write every archive                                                                                                                                                                              |
| debug                  | write `debug/`                                                                                                                                                                                                                 |
| cache sweep            | record this package in the cache and delete what no package uses                                                                                                                                                               |

ids for chains, geometries and materials are handed out in first-reference order and every parallel
step commits its results in id order, so the same install and options produce byte-identical
archives whether the pack is cold, warm or uncached. keep any new parallel work committing in a
fixed order for the same reason.

### asset conversion and workers

`pack/assets.ts` converts materials first, on the main thread with bounded concurrency, because
materials decide which meshes need generated tangents and which textures are used. meshes and
textures then convert on worker threads (`pack/convert-pool.ts`, `pack/convert-worker.ts`):
conversion is CPU-bound (LZ4, meshopt, zstd, hashing), so each worker opens the install itself,
writes its blobs straight into the blob directory, and returns only small results.

`--jobs` defaults to one worker per core but one, capped at 8, since each worker holds its own
catalogs, manifest and block caches (a few hundred MB). geometry blobs use `--zstd-level` (default
19, also used for other blobs); texture blobs use `--texture-zstd-level` (default 9), which is the
main lever on cold pack time and barely changes size or decode speed. a blob keeps its zstd frame
only when compression pays.

### pack cache

unless `--no-cache` is given, packs share a cache (default `out/.cache`, `--cache <dir>` to move
it), implemented in `pack/pack-cache.ts`:

- `blobs/` is the pack's blob store: every blob is written there once and archives are streamed from
  it. without a cache the same store lives in the staging package's `.spool` (see
  [package-format.md](package-format.md#layout)) and is deleted after the pack.
- `memo/` holds conversion results keyed by the job (asset, tangent UV, zstd level) and a
  fingerprint of the converter: every workspace module `convert-worker.ts` transitively imports, the
  extractor's `package.json` and node's zstd version. each memo records the bundles the conversion
  read and their catalog MD5s; a memo is used only while those MD5s match and its blobs exist. so an
  install update or a change to converter code reconverts exactly what it affects, without reading
  bundle bytes to find out. code outside the worker's import graph doesn't invalidate conversions,
  which is why anything that changes conversion output belongs in that graph.
- `roots/` has one file per package directory listing its blobs and memos. after each pack, roots
  whose directory no longer holds a `core.czar` are dropped and anything no root references is
  deleted, so the cache holds the union of the live packages' content. deleting a package directory
  by hand releases its share at the next pack, and deleting the whole cache is always safe.
- `lock` holds the packing process's pid; one pack uses a cache at a time, and a lock left by a dead
  process is taken over.

failed conversions aren't memoized, so they're retried on every pack.

### report and debug outputs

`pack` prints a summary (sizes, phase timings, entity and instance counts, asset readiness,
conversion failures by reason, per-level environments, water, cache hits, peak RSS); `--json` prints
the full `PackReport` instead. each package also gets a `debug/` directory, which the viewer
ignores:

| file                            | contents                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `assets.json`                   | per geometry, material and texture id: path hash, path, located object, and failure reason if any           |
| `instances.jsonl`               | one line per stored instance block: its blob hash and, per row, entity id, entity name and chunk-file index |
| `chunk-files.json`              | the chunk files read, indexed by `instances.jsonl`                                                          |
| `environments.json`             | per level, the chosen base environment and where each section came from                                     |
| `water.json`                    | water surfaces and sectors packed versus present, and assets that failed to load                            |
| `unsupported-interactives.json` | interactive LevelData files skipped as a whole because their layout isn't supported                         |
| `unsupported-prefabs.json`      | prefabs that couldn't be instantiated, with reasons                                                         |

start from these when something is missing in the viewer: `instances.jsonl` maps a drawn block back
to entities and chunk files, and `assets.json` says why an asset didn't convert.

## open

- path → hash lookups reverse-scan StringPathHash because the game's path hash isn't ported; it
  diverges from XXH3 at 128 UTF-8 bytes (see AnimeStudio's `EndfieldVfsHash`).
- warm packs still rewrite every archive from the cache; unchanged archives of the previous package
  aren't reused.
- material conversion isn't cached, and failed conversions aren't remembered, so a warm pack can
  still start workers.
- interactive LevelData decoding covers the supported facility layouts only; other files are listed
  in `unsupported-interactives.json` rather than partially read.
- some texture formats aren't convertible (e.g. GraphicsFormat 54); they appear as failures in the
  report and `assets.json`.
