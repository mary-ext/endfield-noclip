import type { BlobKind } from '@endfield-noclip/package-format/blobs';
import {
	type ArchiveInfo,
	CORE_ARCHIVE,
	shardStem,
	type StreamedArchive,
} from '@endfield-noclip/package-format/manifest';
import { type TileKey, tileAncestor } from '@endfield-noclip/package-format/tiles';
import type { TreeInfo } from '@endfield-noclip/package-format/tree';

import { AssetArchives } from './convert/asset-placement.ts';
import type { PutOptions } from './store/blob-store.ts';

/**
 * an archive group whose blobs pass this size is split into parts by blob hash. parts land around 0.5–1× the
 * cap, well under the 4 GiB that u32 offsets allow, and sized for HTTP and OPFS
 */
export const ARCHIVE_CAP = 1024 ** 3;

/** the archive holding the terrain layer textures, which every splat page draws from */
export const TERRAIN_LAYER_STEM = 'assets/terrain-layers';

/** which archive group each blob goes to, and what the manifest says of each written archive */
export class ArchiveLayout {
	/** the asset archives' groups */
	readonly assets = new AssetArchives();
	readonly #grid: TreeInfo;
	/** shard archive stem → its shard-level tile */
	readonly #shardTiles = new Map<string, TileKey>();

	/** @param grid the package's tile tree */
	constructor(grid: TreeInfo) {
		this.#grid = grid;
	}

	/**
	 * @param key a tile
	 * @returns the archive group for a tile's content: the core for tiles coarser than the 128 m cells (the
	 *   always-resident coarse layer), else the shard of its {@link TreeInfo.shardLevel} ancestor
	 */
	stemOf(key: TileKey): string {
		if (key.level < this.#grid.cellLevel) {
			return CORE_ARCHIVE;
		}
		const tile = tileAncestor(key, this.#grid.shardLevel);
		const stem = shardStem(tile);
		this.#shardTiles.set(stem, tile);
		return stem;
	}

	/**
	 * @param stem a written archive's group, other than the core's
	 * @param archive the written archive
	 * @returns its manifest entry, its role and tile as recorded when its stem was handed out
	 */
	info(stem: string, archive: StreamedArchive): ArchiveInfo {
		if (stem.startsWith('irradiance/')) {
			return { role: 'irradiance', ...archive };
		}
		const shard = this.#shardTiles.get(stem);
		if (shard !== undefined) {
			return { role: 'shards', ...archive, tile: shard };
		}
		return { role: 'assets', ...archive, tile: this.assets.tileOf(stem) ?? null };
	}
}

/**
 * @param kind the blob's kind
 * @param stem its archive group
 * @param locality what to keep it near within the group, or `null`
 * @returns options for a blob the store compresses
 */
export const compressedBlob = (kind: BlobKind, stem: string, locality: string | null): PutOptions => ({
	kind,
	compress: true,
	stem,
	locality,
});
