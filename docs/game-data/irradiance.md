# irradiance volume

the game's GI is a baked probe volume (`HGIrradianceVolume` v3), not lightmaps or Unity APV. this
page covers its files, how the packer stores them and how the viewer samples them. how the ambient
term uses the result is in [lighting.md](lighting.md#ambient); the scene states that select bakes
are in [scene-states.md](scene-states.md).

## files

`Data/IrradianceVolume/PC/<scene>/v3/` holds an `index.bytes` and payloads
`iv_<stateGroupHash>_<n>.bytes`. the index names the payloads and gives every cell's byte range in
them; a payload is the cells back to back. parser:
[`hg/irradiance.ts`](../../packages/formats/src/hg/irradiance.ts).

## index.bytes

little-endian, read front to back to EOF:

1. `u32` magic: `0x03000004` (map02) or `0x03000003` (map01), same layout. other magics (gacha and
   legacy indices) are rejected. the magic sets the volume's extent (below).
2. scene-state names: `u32` count, each a `u32` byte length + UTF-16LE (e.g. `Map02_lv002_sunny`).
   these are MapConfig scene states; the game picks bakes by its active scene-state mask.
3. state groups: `u32` count, each `u32 hash` + counted `u32` indices into the names. hash 0 with no
   members is the base bake; payload filenames carry these hashes.
4. payload filenames: counted, length-prefixed UTF-16LE.
5. the scene's top-level spatial hash header (`u32` table size, `u32 O`, `O³` offset words), then a
   counted table of `(u32 value, u32 state-group hash)` pairs. neither is needed to read cells; both
   are skipped. the pair table has one entry per level-2 cell record (3898 on map02), so it is
   probably per-level-2-cell data.
6. the cell directory: `u32` count, each nine `u32`:

   | word | meaning                                            |
   | ---- | -------------------------------------------------- |
   | 0    | cell key (below)                                   |
   | 1    | unknown                                            |
   | 2, 3 | byte offset and stored length in the payload       |
   | 4    | decompressed size = word 5 + word 6                |
   | 5    | the cell's hash-header bytes                       |
   | 6    | probe bytes (16 per probe)                         |
   | 7    | low 16 bits: payload file index; high bits unknown |
   | 8    | unknown                                            |

7. a counted table of five-word rows, meaning unknown, ending exactly at EOF. like the pair table it
   has one row per level-2 cell record.

the parser checks that records tile each payload contiguously from 0 and that every payload has
records; the packer also checks that each payload ends where its last record does. the payload index
comes from word 7, never from filename order.

cell keys are `x | y << 8 | z << 16 | level << 24`, 8 bits per axis in 32 m units from the volume's
minimum corner, with world 0 at the middle of its extent: 8192 m for `0x03000004` (world 0 at 128)
and 4096 m for `0x03000003` (world 0 at 64). the extents are inferred from the data: map01's cells
line up with its levels only with world 0 at 64. the parser moves every key to the 8192 m layout, so
the package and viewer share one origin. a level-`n` cell spans `32 · 2^n` m, its coordinates are
multiples of `2^n`, and its probes are `0.5 · 4^n` m apart. levels 1 and 2 cover the map; level 0
(0.5 m probes) is sparse.

## cells and probes

a stored cell is raw when its stored length equals its size, else one block of Hypergryph's inverted
LZ4 (`decodeInvertedLz4Block` in [`binary/lz4.ts`](../../packages/formats/src/binary/lz4.ts)).
decompressed, it is the structure the game's GPU update pass reads (all `u32`):

- a perfect spatial hash over blocks of 4³ probes: `u32 T`, `u32 O`, `O³` offset words (byte
  triples), then `T³` entries of `(block key, probe offset, mask lo, mask hi)`. a block key is
  `bx | by << 8 | bz << 16`.
- the 64-bit mask marks which of the block's 64 probes exist; a probe's address is the entry's probe
  offset + 16 × the number of set mask bits below its own (relative to the cell).
- a probe is 16 bytes: L0 rgb as R11G11B10F, then three rgba8 words, the L1 direction of red, green
  and blue (unpacked as `· 4 − 2`, relative to that channel's L0) with the probe's validity in
  alpha.

about half of a level-0 cell's stored probes are black (L0 0, every L1 byte 128): they lie inside
geometry. their validity is 0.5, the same as lit probes, so validity doesn't mark them.

where a level has no probe (no cell, no block, or a clear mask bit), the clipmap texel takes the
next coarser level's filtered value at that position; at the coarsest level it is zero light with
full validity. level 0 is sparse, so most of the finest clipmap comes from level 1.

## packing

[`pack/irradiance.ts`](../../packages/extractor/src/pack/irradiance.ts) stores every **base-bake**
cell (state group hash 0) whose centre the package covers as one decompressed `Irradiance` blob,
zstd-compressed, in the 512 m archive `irradiance/<x>_<z>.czar` over it. `tables/irradiance.bin`
lists cell keys ascending with their blob indices (see [package-format.md](../package-format.md)).
cells stay in the game's GPU layout so the viewer uploads them unchanged.

scene-state bakes (e.g. sunny, sunrise and night variants, or map01's damaged and overcast-rainy
states) are not packed. map01's scene-state groups store full copies of base cells, with the same
sizes and probe masks and relit probes (in one Hub cell about half the level-0 probes differ), so a
state most likely replaces whole cells rather than overlaying them.

## the viewer's clipmaps

[`render/irradiance-volume.ts`](../../packages/viewer/src/render/irradiance-volume.ts) keeps three
3D clipmaps of 128 × 64 × 128 texels with probes 0.5, 2 and 8 m apart (A: L0 rgb; B: three slabs
along y for the L1 of each channel). per level it wants the window of cells its texels fall in,
streams them into one storage buffer (coarse levels first, ahead of scenery), and refills the level
with
[`shaders/irradiance-update.wgsl`](../../packages/viewer/src/render/shaders/irradiance-update.wgsl)
when the camera moves more than 4 texels from its centre or a cell arrives or leaves. levels refill
coarse to fine, and a refilled level refills every finer one, because their probe-less texels copy
it. the update pass looks cells up in that window instead of the game's top-level hash. the clipmaps
are sampled toroidally in `ambient_irradiance`
([`frame.wgsl`](../../packages/viewer/src/render/shaders/frame.wgsl)).

## open

- scene-state bakes: selecting them by the active scene states, and confirming they replace whole
  cells
- the index's pair table and trailing rows, directory words 1, 7 (high bits) and 8, and the other
  index magics
- the lookup's jitter and the game's forward-shifted clipmap centres
- partial clipmap updates: the viewer refills a whole level at a time
