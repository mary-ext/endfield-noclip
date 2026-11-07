import { type Chain, ChainFlags, type ChainDraw } from '@endfield-noclip/package-format/instances';

// float bits make the dedupe key exact: two thresholds are the same only if their f32 bits are
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const bits = (value: number): number => {
	f32[0] = value;
	return u32[0];
};

/** how a chain's instances are placed and switched, beyond its draws */
export interface ChainPlacement {
	/** `ChainFlags.BillboardFacing` or `BillboardUpright` when the renderer turns to the camera, else 0 */
	billboard: number;
	/**
	 * where the draws' thresholds measure the camera's distance from, in the instance's frame, when they're
	 * distances ({@link Chain.distanceOrigin}); `null` for screen-relative sizes
	 */
	distanceOrigin: [x: number, y: number, z: number] | null;
}

const SCREEN_SIZED: ChainPlacement = { billboard: 0, distanceOrigin: null };

/**
 * LOD-chain templates, deduplicated by their ordered draws (geometry, material, submesh, LOD, role,
 * thresholds, source flags, particle system), LOD count, billboard mode and distance origin
 */
export class ChainTable {
	readonly chains: Chain[] = [];
	readonly #ids = new Map<string, number>();

	/**
	 * @param lodCount the renderer's LOD count
	 * @param draws its draws in the game's order
	 * @param placement billboard mode and distance origin
	 * @returns the chain id; equal inputs return equal ids
	 */
	intern(lodCount: number, draws: readonly ChainDraw[], placement: ChainPlacement = SCREEN_SIZED): number {
		const { billboard, distanceOrigin } = placement;
		let key = `${lodCount},${billboard},${distanceOrigin?.map(bits).join(',')}`;
		for (const draw of draws) {
			key += `|${draw.geometry},${draw.material},${draw.submesh},${draw.lod},${draw.role},${bits(draw.minSquared)},${bits(draw.maxSquared)},${draw.sourceFlags},${draw.sortingLayer},${draw.sortingOrder},${draw.particles}`;
		}
		return this.#ids.getOrInsertComputed(
			key,
			() =>
				this.chains.push({
					lodCount,
					flags: billboard | (distanceOrigin === null ? 0 : ChainFlags.CameraDistance),
					draws: draws.map((draw) => ({ ...draw })),
					distanceOrigin: distanceOrigin === null ? null : [...distanceOrigin],
				}) - 1,
		);
	}
}
