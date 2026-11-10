# irradiance volume

the game's GI uses a baked probe volume (`HGIrradianceVolume` v3). ambient sampling is described in
[lighting.md](lighting.md#ambient); the scene states that select bakes are in
[scene-states.md](scene-states.md).

## files

`Data/IrradianceVolume/PC/<scene>/v3/` holds an `index.bytes` and payloads
`iv_<stateGroupHash>_<n>.bytes`. the index names the payloads and gives every cell's byte range in
them; a payload is the cells back to back.

## index.bytes

little-endian, read front to back to EOF:

1. `u32` magic: `0x03000004` (map02) or `0x03000003` (map01), same layout. other magics belong to
   gacha and legacy indices. the magic sets the volume's extent (below).
2. scene-state names: `u32` count, each a `u32` byte length + UTF-16LE (e.g. `Map02_lv002_sunny`).
   these are MapConfig scene states; the game picks bakes by its active scene-state mask.
3. state groups: `u32` count, each `u32 hash` + counted `u32` indices into the names. hash 0 with no
   members is the base bake; payload filenames carry these hashes.
4. payload filenames: counted, length-prefixed UTF-16LE.
5. the scene's top-level spatial hash header (`u32` table size, `u32 O`, `O³` offset words; the
   GPU's top-level hash is built like the cells' below, keyed `x | y << 10 | z << 20` on cell
   coordinates, and maps each cell to its byte offset in the GPU's cell buffer), then a counted
   table of `(u32 value, u32 state-group hash)` pairs. neither is needed to read cells. the pair
   table has one entry per level-2 cell record, so it is probably per-level-2-cell data.
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

the records tile each payload contiguously from 0 and end where it ends, and every payload has
records. the payload index comes from word 7, not from filename order.

cell keys are `x | y << 8 | z << 16 | level << 24`, 8 bits per axis in 32 m units from the volume's
minimum corner, with world 0 at the middle of its extent: 8192 m for `0x03000004` (world 0 at 128)
and 4096 m for `0x03000003` (world 0 at 64). the extents are inferred from the data: map01's cells
line up with its levels only with world 0 at 64. a level-`n` cell spans `32 · 2^n` m, its
coordinates are multiples of `2^n`, and its probes are `0.5 · 4^n` m apart. levels 1 and 2 cover the
map; level 0 (0.5 m probes) is sparse.

## cells and probes

a stored cell is raw when its stored length equals its size, else one block of Hypergryph's inverted
LZ4. decompressed, it is the structure the game's GPU update pass reads (all `u32`):

- a perfect spatial hash over blocks of 4³ probes: `u32 T`, `u32 O`, `O³` offset words (byte
  triples, x lowest), then `T³` entries (both x fastest) of
  `(block key, probe offset, mask lo, mask hi)`. a block `b` (its coordinates within the cell) sits
  at entry `(b + offset[b mod O]) mod T` per axis, and matches when the entry's key is
  `bx | by << 8 | bz << 16`.
- the 64-bit mask marks which of the block's 64 probes exist, a probe's bit interleaving its
  coordinates within the block (x in bits 0 and 3, y in 1 and 4, z in 2 and 5). its address is the
  entry's probe offset (in bytes, relative to the cell) + 16 × the number of set mask bits below its
  own.
- a probe is 16 bytes: L0 rgb as R11G11B10F, then three rgba8 words, the L1 direction of red, green
  and blue (unpacked as `· 4 − 2`, relative to that channel's L0) with the probe's validity in
  alpha.

about half of a level-0 cell's stored probes are black (L0 0, every L1 byte 128): they lie inside
geometry. their validity is 0.5, the same as lit probes, so validity doesn't mark them.

the update pass fills camera-centred clipmaps, one per level. where a level has no probe (no cell,
no block, or a clear mask bit), the clipmap texel takes the next coarser level's filtered value at
that position; at the coarsest level it is zero light with full validity. level 0 is sparse, so most
of the finest clipmap comes from level 1.

## scene-state bakes

scene-state bakes (e.g. sunny, sunrise and night variants, or map01's damaged and overcast-rainy
states) are full copies of base cells: map01's scene-state groups store them with the same sizes and
probe masks and relit probes (in one Hub cell about half the level-0 probes differ), so a state most
likely replaces whole cells rather than overlaying them.

the game passes the irradiance volume a mask with one bit per active MapConfig scene state (bit =
the state's MapConfig index) whenever the scene's states change; the volume's native code picks the
bakes from it. that selection wasn't read, but the bakes show its rule: a group applies while all of
its states are on.

- map01's two Hub groups cover the same cells. `001_damaged + 001_overcast_rainy` is the red,
  storm-lit Hub, whose two states are on together until the early quests complete.
  `001_normal + dung01_rdg010_liino` is near-black blue, a dungeon's lighting over the Hub; its
  second state has no MapConfig condition, so it's set only by name. if one state sufficed, the
  finished open-world Hub (`001_normal` on) would go dark; the base bake is the bright, finished
  Hub.
- map02's groups are single states. the base bake is the stormy one: in Wuling City (near unity
  −884, 250, −40) the base cells are red-amber (L0 hue about 1.00, 0.54, 0.45) and the
  `Map02_lv002_sunny` copies neutral (0.98, 1.00, 0.91). sunny is on once quest `e6m4_q#44` is
  complete, so the finished city takes the sunny bake. the other groups are
  `Map02_lv005_fields_unrise` and `Map02_lv009_night`.

which bake wins when two groups hold a cell and both apply isn't known; no stored pair of groups can
both apply under the MapConfig conditions without a state set by name.

## region bakes

Dijiang's cabin rooms each have their own bakes, one per room type the room can hold, lit with that
cabin built: `regionIv_<room>_<roomType>.bytes` beside the index (e.g. `regionIv_room_b_1_2` is the
growth chamber's room with type 2, GrowCabin; ManufacturingStation is 1). the index doesn't list
them; the game streams one in over the scene's bake when a cabin is built in a slot. a growth
chamber's bake is strongly yellow-green, which gives the room its colour.

a region bake is little-endian: `u32` 0x1000, `u32` header size (44), the room's world box as `f32`
min and max corners, `u32` probes per axis, then a dense grid of 16-byte probes in the cells' probe
layout, x fastest, then y, then z. the grid is the finest level's 0.5 m lattice inside the box:
probe `i` on an axis sits at `(ceil(2 · min) + i) / 2` m, and the probe count per axis is the number
of lattice points from `min` to `max`, which holds for every bake. the cabin slots are in
[Dijiang cabins](scene-states.md#dijiang-cabins).

## open

- scene-state bakes: confirming they replace whole cells rather than overlay them, and reading the
  native selection that the all-states rule above is inferred for
- region bakes: whether the game also applies them to the coarser levels, and how it blends their
  edge with the scene's bake
- the index's pair table and trailing rows, directory words 1, 7 (high bits) and 8, and the other
  index magics
