import type { Chain } from '@endfield-noclip/package-format/instances';
import { assetStem } from '@endfield-noclip/package-format/manifest';
import { type TileKey, tileAncestor } from '@endfield-noclip/package-format/tiles';

// where geometry and texture blobs go. an asset lives in the archive of the smallest tile (at or above the
// shard level) whose subtree contains every use of it, so fetching a region means its tile archives and their
// ancestors' (plus common); it's never spread over sibling regions. assets used under different root tiles or
// by global content go to the common archive.

/** an asset's placement: a tile, `null` for the common archive, `undefined` while unused */
export type Place = TileKey | null | undefined;

/**
 * @param a a tile
 * @param b another tile
 * @returns the deepest tile containing both, or `null` if they lie under different roots
 */
export const commonAncestor = (a: TileKey, b: TileKey): TileKey | null => {
	let level = Math.min(a.level, b.level);
	let x = tileAncestor(a, level);
	let y = tileAncestor(b, level);
	while (x.x !== y.x || x.z !== y.z) {
		if (level === 0) {
			return null;
		}
		level--;
		x = tileAncestor(x, level);
		y = tileAncestor(y, level);
	}
	return x;
};

/**
 * @param a a placement
 * @param b another placement
 * @returns the placement covering both
 */
export const mergePlaces = (a: Place, b: Place): Place => {
	if (a === undefined) {
		return b;
	}
	if (b === undefined) {
		return a;
	}
	if (a === null || b === null) {
		return null;
	}
	return commonAncestor(a, b);
};

/** collects where chains are drawn, then derives geometry and material placements */
export class AssetPlacement {
	readonly #shardLevel: number;
	readonly #chains: Place[] = [];
	/** geometry uses outside chains */
	readonly #geometries: Place[] = [];

	/** @param shardLevel uses are recorded at this level's tiles (finer tiles are lifted to it) */
	constructor(shardLevel: number) {
		this.#shardLevel = shardLevel;
	}

	/**
	 * records a use of a chain
	 *
	 * @param chain chain id
	 * @param tile the tile whose content draws it, or `null` for content outside the tile tree (global)
	 */
	note(chain: number, tile: TileKey | null): void {
		this.#chains[chain] = mergePlaces(this.#chains[chain], this.#lift(tile));
	}

	/**
	 * records a use of a geometry outside the chain table
	 *
	 * @param geometry geometry id
	 * @param tile the tile whose content draws it, or `null` for global content
	 */
	noteGeometry(geometry: number, tile: TileKey | null): void {
		this.#geometries[geometry] = mergePlaces(this.#geometries[geometry], this.#lift(tile));
	}

	#lift(tile: TileKey | null): TileKey | null {
		return tile === null || tile.level <= this.#shardLevel ? tile : tileAncestor(tile, this.#shardLevel);
	}

	/**
	 * @param chains the chain table
	 * @param geometryCount geometry ids in use
	 * @param materialCount material ids in use
	 * @returns each geometry's and material's placement, over chain and direct uses
	 */
	resolve(
		chains: readonly Chain[],
		geometryCount: number,
		materialCount: number,
	): { geometries: Place[]; materials: Place[] } {
		const geometries = Array.from({ length: geometryCount }, (_, id): Place => this.#geometries[id]);
		const materials = Array.from({ length: materialCount }, (): Place => undefined);
		for (const [id, chain] of chains.entries()) {
			const place = this.#chains[id];
			for (const draw of chain.draws) {
				geometries[draw.geometry] = mergePlaces(geometries[draw.geometry], place);
				materials[draw.material] = mergePlaces(materials[draw.material], place);
			}
		}
		return { geometries, materials };
	}
}

/** names the asset archive groups (stems) blobs go to, remembering each one's tile */
export class AssetArchives {
	/** every stem handed out, with its tile */
	readonly #tiles = new Map<string, TileKey | null>();

	/**
	 * @param place the asset's placement; unused assets (none, in practice) go to common too
	 * @returns the archive group to put its blobs in; the blob store splits large groups into parts
	 */
	stem(place: Place): string {
		const tile = place ?? null;
		const stem = assetStem(tile);
		this.#tiles.set(stem, tile);
		return stem;
	}

	/**
	 * @param stem an archive group
	 * @returns its placement tile (`null` for common), or `undefined` if this didn't name it
	 */
	tileOf(stem: string): TileKey | null | undefined {
		return this.#tiles.get(stem);
	}
}
