# loading a package

## sources

a package is read through a `PackageSource`
([`package/package-source.ts`](../../packages/viewer/src/package/package-source.ts)), which offers
whole-file reads, byte-range reads and reads of several ranges of one file at once:

| source            | used for                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `httpSource`      | the dev/preview server, or any static host; one HTTP range request per read or per several, tolerating servers that ignore `Range` |
| `directorySource` | a folder picked with the File System Access API (`showDirectoryPicker`), or a package copied into OPFS                             |
| `fileListSource`  | a `<input webkitdirectory>` fallback where `showDirectoryPicker` is missing                                                        |

`httpSource` reads several ranges with one multi-range request (`Range: bytes=a-b,c-d,…`), which a
server answers as `multipart/byteranges`, a part per range; `parseByteRanges` cuts the body by each
part's `Content-Range`, and takes a range from whichever part holds it, since a server may reorder
or merge them. some hosts answer such a request with the whole file or one range instead (Amazon S3
documents that it does; nginx and Apache answer in parts; other hosts aren't surveyed): the first
answer that isn't in parts is dropped unread, and from then on the source issues a request per
range. a cross-origin host must also allow the `Range` request header in its CORS preflight, which
only a single range goes without.

every range read passes the archive's size from the manifest. a source whose file has another size
throws `PackageChangedError`; the stream manager stops fetching shards, keeps resident content
drawn, and the stats panel offers a reload. this is a size check, not content verification; it
cannot detect same-sized edits. repacks normally change
[archive names](../package-format.md#layout), so an open page may instead get a missing-file error
when an old archive is removed.

the package panel ([`ui/package-panel.tsx`](../../packages/viewer/src/ui/package-panel.tsx)) offers
all three. where both `showDirectoryPicker` and OPFS exist, "copy into browser storage" imports the
picked folder into OPFS (skipping `debug/`, which the viewer never reads) so it can be reopened
without picking it again. a failed copy, or a stored package that can't be reopened, is reported in
the panel.

## dev package server

[`vite-plugins/package-server.ts`](../../packages/viewer/vite-plugins/package-server.ts) serves
extracted packages under `/packages/` on both `vite dev` and `vite preview`. the root defaults to
the repo's `out/`; set `NOCLIP_PACKAGES=/path` to point it elsewhere
([`vite.config.ts`](../../packages/viewer/vite.config.ts)).

- files are served as a static host would, by `sirv`: `Range` support, `ETag` and `Last-Modified`
  validators and `cache-control: no-cache`. deployments need range support and revalidation for
  `core.czar`, whose name is fixed. other archives have content-derived names.
- a `GET` for several explicit ranges (`bytes=a-b,c-d,…`), which `sirv` doesn't answer, gets
  `multipart/byteranges` from the plugin itself, the parts in the order asked.
- `GET /packages/index.json` lists subdirectories that hold a core archive, with its size, skipping
  hidden directories (the packer's staging and replaced packages). it's the one dev-only addition;
  the package panel reads it through `fetchDevPackages`
  ([`package/dev-packages.ts`](../../packages/viewer/src/package/dev-packages.ts)), and lists
  nothing where it's missing.

## opening

`Viewer.load` → `openViewerPackage`
([`package/viewer-package.ts`](../../packages/viewer/src/package/viewer-package.ts)) reads the whole
core archive, checks the manifest's format and version (a mismatch throws `PackageError` rather than
guessing at fields), and decodes its tables (tree, blob table, LOD chains, geometry, material,
texture, water, light, particle, environment and irradiance tables). shard JSON headers are never
fetched: the blob table gives each shard blob's offset in its archive's data section, whose start
the manifest's archive entry holds, so a blob costs one range read.

`load` then sets the irradiance volume to the package's and `openScene`
([`viewer/scene-loader.ts`](../../packages/viewer/src/viewer/scene-loader.ts)) builds the linked
tile tree, the texture store, the stream manager and the selectors, and pins the coarse layer (see
[residency](streaming.md#residency-and-budgets)); `load` then picks the initial level and poses the
camera over it. the `MeshSelector` exists only when at least one geometry converted; without it
instances draw as boxes. terrain page sizes are `package-format` constants; the terrain renderer
throws on a page of any other size, which fails that blob.

## decode workers and zstd

[`package/decode-pool.ts`](../../packages/viewer/src/package/decode-pool.ts) runs 2–4 module workers
(half the hardware threads, clamped) and hands each job to the least busy one. each worker holds at
most 64 jobs at once; the rest wait in the pool, so the jobs of an unloaded package that no worker
has taken yet are dropped instead of keeping the workers busy. a worker's answers reach the main
thread only between its frames, so the jobs in hand are what a frame can take in: with four per
worker the pool turned over a few dozen blobs a frame while the workers idled, which bounded loading
(a map02 teleport took 2.4 s to settle, and 0.9 s with 64).

a job is a range of a `SharedBytes` buffer: a whole coalesced range read, or a core blob copied out
of the core's bytes (which stay on the main thread). the pool transfers the buffer to the worker
that takes its first job, uncopied, and sends the buffer's later jobs to that worker too, so a full
worker can hold them back while another idles; the workers' time isn't what bounds loading (see
[decoding](streaming.md#residency-and-budgets)), so this costs little. the buffer counts its jobs
not yet posted: the stream manager releases the ones it drops instead of decoding, and once none is
left the worker frees the buffer. until then the whole read stays in memory, gaps included, for its
last waiting blob. per-blob copies remain only for uncompressed texture, layer and irradiance blobs
that share their read, whose bytes the worker copies out to transfer back; every other kind is
decoded into new arrays anyway. flying between map02 levels, about a third of the decoded blobs
shared a read; copying each out on the main thread would be tens of MB per flight, where the workers
copy a few KiB.

[`package/decode-worker.ts`](../../packages/viewer/src/package/decode-worker.ts) undoes the blob
codec and builds GPU-ready arrays:

| kind                       | worker output                                                                                                                                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| heights                    | raw `u16` samples, padded to whole words for the storage buffer                                                                                                                                                                                 |
| instances                  | instance rows, per-row cull data, (chain, first, count) runs, decal placements, and the rows that spin or float on a water volume, built by `buildInstanceRows`; the bounds the mesh selection culls them by (`buildRowBounds`)                 |
| geometry                   | meshopt-decoded vertex streams (quantized positions, `snorm16x2` octahedral normals, UV0, UV1, tangents, `unorm8x4` colours), indices padded to 4 bytes, the UV sets' format and transforms, and an animated mesh's bind pose and bone matrices |
| surface                    | the albedo and normal BC3 images, each in its own buffer                                                                                                                                                                                        |
| splat                      | the control, tint and index arrays                                                                                                                                                                                                              |
| texture, layer, irradiance | the decompressed bytes as stored                                                                                                                                                                                                                |

a 16-bit UV set stays `unorm16x2`, dequantized in the vertex shader, unless the mesh's other set is
stored as floats; then both are `float32x2`. a mesh without UV1 draws UV0 in its place.

zstd uses `zstddec`'s wasm build ([`package/zstd.ts`](../../packages/viewer/src/package/zstd.ts)),
which is an order of magnitude faster than a JS decoder on texture blobs. each realm instantiates
its own module, so workers and the main thread (core tables) each await `zstdReady`. `zstddec`
reports no errors, so `decompressZstd` checks the decoded length and throws on a short frame.

## URL parameters

| parameter | meaning                                                                                                                                                                                                                                 |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package` | a dev package name (served from `/packages/<name>/`), or a URL/path of a package directory if it starts with `/`, `./`, `../`, `http:/` or `https:/` ([`package/package-param.ts`](../../packages/viewer/src/package/package-param.ts)) |
| `level`   | the current level's id: the level to look over first. if it isn't in the package or has no instances, the first level with instances                                                                                                    |

the app keeps both in sync with `history.replaceState`, so a reload or a shared link reopens the
same package over the same level (every level shows either way; see [levels](streaming.md#levels)).
packages opened from local folders have no `package` value.
