/**
 * the viewer package: what the extractor's `pack` command writes and the viewer streams, one streaming scene
 * (one world, one coordinate frame) per package. this module holds the manifest and archive layout; each
 * other module of package-format holds one concern's types and binary codec. stays free of node APIs so both
 * sides can import it.
 *
 * a package is czar archives: a small always-resident `core.czar` holding the manifest, the tile tree, the
 * tables and the coarse layer, and archives holding everything else. archive members are content-addressed
 * blobs (`blobs/<hash>.<ext>`) plus the core's fixed paths in {@link CORE_PATHS}.
 *
 * @module
 */

import type { IrradianceRegionInfo } from './irradiance.ts';
import type { StatesInfo } from './states.ts';
import type { TerrainInfo } from './terrain.ts';
import { type TileKey, tileId } from './tiles.ts';
import type { TreeInfo } from './tree.ts';
import type { Rect, Bounds } from './values.ts';

/** value of {@link PackageManifest.format} */
export const PACKAGE_FORMAT = 'endfield-noclip.package';

/**
 * bumped on any incompatible change to the manifest or a table. binary encodings carry their own versions in
 * their headers
 */
export const PACKAGE_VERSION = 109;

/** the archive every package has; the viewer opens it first */
export const CORE_ARCHIVE = 'core.czar';

/** index of {@link CORE_ARCHIVE} in {@link PackageManifest.archives} */
export const CORE_ARCHIVE_INDEX = 0;

/**
 * fixed member paths inside {@link CORE_ARCHIVE}. `.zst` members are one zstd frame each (the JSON shrinks
 * several times over that way); the rest are stored as they are
 */
export const CORE_PATHS = {
	manifest: 'manifest.json.zst',
	tree: 'tree.bin',
	blobs: 'tables/blobs.bin',
	chains: 'tables/chains.bin',
	geometries: 'tables/geometries.bin.zst',
	materials: 'tables/materials.json.zst',
	textures: 'tables/textures.bin.zst',
	water: 'tables/water.json.zst',
	lights: 'tables/lights.json.zst',
	particles: 'tables/particles.json.zst',
	environment: 'tables/environment.json.zst',
	irradiance: 'tables/irradiance.bin',
} as const;

/**
 * `manifest.json.zst` in the core archive: what the package is and how it's laid out. placed content lives in
 * the tree and the tables.
 *
 * every package is in the game's Unity frame: left-handed, +X east, +Y up, +Z north (forward on the game
 * map), metres. a right-handed renderer applies `scale(1, 1, -1)` at its root and swaps its front-face
 * winding. matrices are `rows3x4` (see {@link InstanceBlock.transforms})
 */
export interface PackageManifest {
	format: typeof PACKAGE_FORMAT;
	version: number;
	/**
	 * hash over the core's binary and table members (not this manifest): equal generations mean equal tables
	 * and blob placement, so a reader can key caches of decoded tables by it
	 */
	generation: string;
	/** identifies the game build the package came from; per-asset provenance lives in the debug index */
	source: SourceFingerprint;
	scene: SceneInfo;
	/** the slice of the scene that was packed, or `null` for all of it */
	subset: SubsetInfo | null;
	/** archives by index; {@link BlobRecord.archive} indexes this list. entry 0 is the core */
	archives: ArchiveInfo[];
	tree: TreeInfo;
	terrain: TerrainInfo | null;
	/**
	 * every level of the scene, whether or not the package's subset includes its content; they don't overlap,
	 * so a viewer shows them all at once. `VisibilityGroup.level` and `SceneControl.levels` index this list.
	 * empty for scenes without levels
	 */
	levels: LevelInfo[];
	states: StatesInfo;
	/** rooms' own irradiance bakes, each applying while its group shows */
	irradianceRegions: IrradianceRegionInfo[];
	/** the player's fire seed, or `null` when no level script of the scene sets it */
	fireSeed: FireSeedInfo | null;
}

/**
 * the fire seed the player carries, which reveals invisible bridges around them
 * (`docs/game-data/effects.md#invisible-bridges`): the scene control holding its level and, per value of that
 * control, the global reveal radii the game sets
 */
export interface FireSeedInfo {
	/** index into `StatesInfo.controls` */
	control: number;
	/**
	 * by control value, the inner and outer radius (m) every effect with a global reveal adds to its own
	 * (`_VFXParams3.xy`)
	 */
	radii: [inner: number, outer: number][];
}

/** the streaming scene */
export interface SceneInfo {
	/** streaming scene name, e.g. `map02` */
	id: string;
	/** display name, e.g. `Wuling` */
	name: string | null;
}

/** a level (named area) of the scene */
export interface LevelInfo {
	/** LevelConfig id, e.g. `map02_lv001` */
	id: string;
	name: string | null;
	/** LevelConfig rect */
	rect: Rect;
	/** where the game spawns the player, Unity world coordinates */
	playerInitPos: [x: number, y: number, z: number];
	/** owned 128 m cells as tile coordinates at {@link TreeInfo.cellLevel} */
	cells: [x: number, z: number][];
	/** instances the level owns in this package, not counting HLOD clusters */
	instances: number;
	/** world bounds of the instances the level owns in this package, or `null` if none were packed */
	contentBounds: Bounds | null;
	/** the level's base environment, or `null` if the level has none */
	environment: LevelEnvironment | null;
}

/**
 * a level's base environment: the volume whose phase the game applies over most of the level's ground, and
 * its post-processing. the game has no per-level environment; this is the extractor's choice. blending at the
 * camera starts from that phase's sections, inactive ones included, so a section no applying volume sets
 * keeps the base phase's own values (an assumption)
 */
export interface LevelEnvironment {
	/** index into `EnvironmentTable.volumes`; its phase is never `null` */
	volume: number;
	/** index into `EnvironmentTable.posts`, or `null` if the level has none */
	post: number | null;
}

/**
 * one archive of the package. every archive but the core is content-named (see {@link archiveName}): a group
 * over the size cap is split into a power-of-two number of parts, so adding a blob changes one part
 */
export type ArchiveInfo =
	| {
			role: 'core';
			/**
			 * {@link CORE_ARCHIVE}. its size and header depend on this manifest and the tables holding the offsets,
			 * so a reader reads it whole and takes its blobs from the position of its first member
			 */
			name: typeof CORE_ARCHIVE;
	  }
	| (StreamedArchive & {
			/** `shards/<l>_<x>_<z>-<id>.czar` */
			role: 'shards';
			/** the {@link TreeInfo.shardLevel} tile whose subtree content it holds */
			tile: TileKey;
	  })
	| (StreamedArchive & {
			/**
			 * `assets/<l>_<x>_<z>[.<part>]-<id>.czar`, `assets/common[.<part>]-<id>.czar` or
			 * `assets/terrain-layers-<id>.czar`
			 */
			role: 'assets';
			/**
			 * the tile at or above the shard level whose subtree is the smallest one containing every use of each
			 * asset in it, or `null` for common and terrain layer archives (global content, or uses under different
			 * root tiles). so everything a tile draws lives in the `assets` archives of that tile and its
			 * ancestors, plus common
			 */
			tile: TileKey | null;
	  })
	| (StreamedArchive & {
			/** `irradiance/<x>_<z>-<id>.czar`: the cells over one 512 m square (see `irradianceStem`) */
			role: 'irradiance';
	  });

/** what every archive but the core records */
export interface StreamedArchive {
	/** path relative to the package root */
	name: string;
	/** total byte length, which a reader can compare to notice an archive replaced by a re-pack */
	size: number;
	/** byte position of the archive's data section, which {@link BlobRecord.offset} is relative to */
	dataOffset: number;
}

/** what a partial package holds */
export interface SubsetInfo {
	/** only content owned by this level (by tag), and terrain under its cells */
	level: string | null;
	/** only content whose centre lies in this world x, z rectangle, and terrain intersecting it */
	bounds: Rect | null;
}

/** the game build */
export interface SourceFingerprint {
	/** the bundle manifest's build guid */
	buildGuid: string;
	/** the bundle manifest's content hash */
	contentHash: string;
}

/**
 * @param tile the shard-level tile whose subtree content the archive holds
 * @returns the stem of the archive (see {@link archiveName})
 */
export const shardStem = (tile: TileKey): string => `shards/${tileId(tile)}`;

/**
 * @param tile the tile the archive's assets are placed at, or `null` for the common archive
 * @returns the stem of the archives (see {@link archiveName})
 */
export const assetStem = (tile: TileKey | null): string =>
	`assets/${tile === null ? 'common' : tileId(tile)}`;

/** hex digits of the content id in an archive name */
export const ARCHIVE_ID_LENGTH = 16;

/**
 * names an archive by what it holds, so an archive's name changes exactly when its bytes do: a reader can't
 * pair a cached archive with a newer core, and a re-pack reuses unchanged archives of the previous package
 *
 * @param stem the group the archive belongs to: `shards/<tile>`, `assets/<tile>`, `assets/common`,
 *   `assets/terrain-layers` or `irradiance/<x>_<z>`
 * @param part the archive's bucket when its group is split over several, else `null`
 * @param id the first {@link ARCHIVE_ID_LENGTH} hex digits of the SHA-256 of the archive's czar head (prelude
 *   and header: every member's path, offset, size and CRC)
 * @returns the archive's package-relative path, `<stem>[.<part>]-<id>.czar`
 */
export const archiveName = (stem: string, part: number | null, id: string): string =>
	`${stem}${part === null ? '' : `.${part}`}-${id}.czar`;
