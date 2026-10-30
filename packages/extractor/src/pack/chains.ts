import { type Chain, ChainFlags, type ChainDraw, DrawRole } from '@endfield-noclip/package-format/instances';

// float bits make the dedupe key exact: two thresholds are the same only if their f32 bits are
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const bits = (value: number): number => {
	f32[0] = value;
	return u32[0];
};

/**
 * LOD-chain templates, deduplicated by their ordered draws (geometry, material, submesh, LOD, role,
 * thresholds, source flags) and LOD count
 */
export class ChainTable {
	readonly chains: Chain[] = [];
	readonly #ids = new Map<string, number>();

	/**
	 * @param lodCount the renderer's LOD count
	 * @param draws its draws in the game's order
	 * @returns the chain id; equal inputs return equal ids
	 */
	intern(lodCount: number, draws: readonly ChainDraw[]): number {
		let key = `${lodCount}`;
		for (const draw of draws) {
			key += `|${draw.geometry},${draw.material},${draw.submesh},${draw.lod},${draw.role},${bits(draw.minSquared)},${bits(draw.maxSquared)},${draw.sourceFlags}`;
		}
		let id = this.#ids.get(key);
		if (id === undefined) {
			id = this.chains.length;
			this.chains.push({ lodCount, flags: chainFlags(draws), draws: draws.map((draw) => ({ ...draw })) });
			this.#ids.set(key, id);
		}
		return id;
	}
}

const chainFlags = (draws: readonly ChainDraw[]): number => {
	let flags = 0;
	for (const draw of draws) {
		switch (draw.role) {
			case DrawRole.ShadowOnly: {
				flags |= ChainFlags.HasShadowOnly;
				break;
			}
			case DrawRole.Card: {
				flags |= ChainFlags.HasCard;
				break;
			}
			case DrawRole.Hlod: {
				flags |= ChainFlags.Hlod;
				break;
			}
		}
	}
	return flags;
};
