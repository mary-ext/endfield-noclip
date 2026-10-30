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

import type { EnvironmentProfile, EnvironmentPhaseInfo, EnvironmentVolumeInfo } from './environment.ts';
import type { StatesInfo } from './states.ts';
import type { TerrainInfo } from './terrain.ts';
import { type TileKey, tileId } from './tiles.ts';
import type { TreeInfo, ContentRef } from './tree.ts';
import type { Rect, Bounds } from './values.ts';

/** value of {@link PackageManifest.format} */
export const PACKAGE_FORMAT = 'endfield-noclip.package';

/**
 * bumped on any incompatible change to the manifest or a table. binary encodings carry their own versions in
 * their headers
 */
export const PACKAGE_VERSION = 17;

/** the archive every package has; the viewer opens it first */
export const CORE_ARCHIVE = 'core.czar';

/**
 * fixed member paths inside {@link CORE_ARCHIVE}. `.zst` members are one zstd frame each (the JSON asset
 * tables shrink 6–50× that way); the rest are stored as they are
 */
export const CORE_PATHS = {
	manifest: 'manifest.json',
	tree: 'tree.bin',
	blobs: 'tables/blobs.bin',
	chains: 'tables/chains.bin',
	geometries: 'tables/geometries.json.zst',
	materials: 'tables/materials.json.zst',
	textures: 'tables/textures.json.zst',
	water: 'tables/water.json.zst',
	lights: 'tables/lights.json.zst',
	irradiance: 'tables/irradiance.bin',
} as const;

/** `manifest.json` in the core archive */
export interface PackageManifest {
	format: typeof PACKAGE_FORMAT;
	version: number;
	/**
	 * hash over the core's binary and table members. two packages with equal generations are identical; a
	 * viewer keys its caches of decoded tables by it and never mixes generations
	 */
	generation: string;
	scene: SceneInfo;
	coordinates: CoordinateConventions;
	tree: TreeInfo;
	terrain: TerrainInfo | null;
	/**
	 * every level of the scene, whether or not the package's subset includes its content. a viewer shows one
	 * level at a time: the content whose group carries its tag (each level's content includes its own
	 * backdrop), plus groups with tag 0 (shared content, on maps with several levels), over the shared terrain.
	 * empty for scenes without levels, whose content is all shown
	 */
	levels: LevelInfo[];
	/** environment profiles, deduplicated; {@link LevelInfo.environment} indexes this list */
	environments: EnvironmentProfile[];
	/** every phase an environment volume applies; {@link EnvironmentVolumeInfo.phase} indexes this list */
	environmentPhases: EnvironmentPhaseInfo[];
	/** the scene's environment volumes, for blending at the camera */
	environmentVolumes: EnvironmentVolumeInfo[];
	states: StatesInfo;
	/** archives by index; {@link BlobRecord.archive} indexes this list. entry 0 is the core */
	archives: ArchiveInfo[];
	/**
	 * content drawn regardless of the tree's refinement while its group shows (the game's Global chunk scenery,
	 * conditional where it comes from scene-state chunks)
	 */
	global: ContentRef[];
	/** the slice of the scene that was packed, or `null` for all of it */
	subset: SubsetInfo | null;
	/** identifies the game build the package came from; per-asset provenance lives in the debug index */
	source: SourceFingerprint;
}

/** the streaming scene */
export interface SceneInfo {
	/** streaming scene name, e.g. `map02` */
	id: string;
	/** display name, e.g. `Wuling` */
	name: string | null;
}

/**
 * all positions, matrices and bounds are in the game's Unity frame. the viewer converts to its own frame
 * exactly once, at the root
 */
export interface CoordinateConventions {
	frame: 'unity';
	/** Unity is left-handed: +X right, +Y up, +Z forward (north on the game map) */
	handedness: 'left';
	units: 'm';
	/**
	 * the transform a right-handed viewer applies at its root. it mirrors geometry, so the viewer also swaps
	 * its front-face winding
	 */
	viewerRoot: 'scale(1, 1, -1)';
	/** see {@link InstanceBlock.transforms} */
	matrices: 'rows3x4';
}

/** the conventions every package uses */
export const COORDINATE_CONVENTIONS: CoordinateConventions = {
	frame: 'unity',
	handedness: 'left',
	units: 'm',
	viewerRoot: 'scale(1, 1, -1)',
	matrices: 'rows3x4',
};

/** a level (named area) of the scene */
export interface LevelInfo {
	/** LevelConfig id, e.g. `map02_lv001` */
	id: string;
	idNum: number;
	/** entity-id tag (`id >>> 27`) of the content the level owns; also on every instance's entity id */
	tag: number;
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
	/**
	 * index into {@link PackageManifest.environments}: the level's base environment, i.e. the one the game
	 * applies over most of the level's ground. `null` if the level has none
	 */
	environment: number | null;
}

/** one archive of the package */
export interface ArchiveInfo {
	/**
	 * path relative to the package root: `core.czar`, or a content-named archive (see {@link archiveName}) such
	 * as `shards/3_2_5-<id>.czar`, `assets/2_1_2-<id>.czar` or `assets/common.1-<id>.czar`. a group over the
	 * size cap is split by blob hash into a power-of-two number of parts, so adding a blob changes one part
	 */
	name: string;
	role: 'core' | 'shards' | 'assets' | 'irradiance';
	/**
	 * `null` for `irradiance` archives (`irradiance/<x>_<z>-<id>.czar`: the cells over one 512 m square, see
	 * `irradianceStem`). for `shards` archives: the {@link TreeInfo.shardLevel} tile whose subtree content it
	 * holds. for `assets` archives: the tile at or above the shard level whose subtree is the smallest one
	 * containing every use of each asset in it, or `null` for `assets/common*` (global content, or uses under
	 * different root tiles). so everything a tile draws lives in the `assets` archives of that tile and its
	 * ancestors, plus common
	 */
	tile: TileKey | null;
	/** total byte length; `null` for the core, whose size depends on this manifest */
	size: number | null;
	/**
	 * byte position of the archive's data section, which {@link BlobRecord.offset} is relative to. `null` for
	 * the core: read it from the core's own prelude, which the viewer parses when opening it
	 */
	dataOffset: number | null;
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
