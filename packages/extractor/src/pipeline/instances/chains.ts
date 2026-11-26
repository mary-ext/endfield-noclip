import { hash as cryptoHash } from 'node:crypto';

import { type ChunkEntity, DrawFlags } from '@endfield-noclip/formats/endfield/init-chunk-data';
import { inverseTransformPoint } from '@endfield-noclip/formats/unity/transform';
import {
	type Chain,
	ChainDrawFlags,
	ChainFlags,
	type ChainDraw,
} from '@endfield-noclip/package-format/instances';

// float bits make the dedupe key exact: two thresholds are the same only if their f32 bits are
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const bits = (value: number): number => {
	f32[0] = value;
	return u32[0];
};

/** {@link ChainDraw.flags} of a draw casting into every shadow map: prefab renderers, which carry no flag word */
export const CASTS_EVERYWHERE = ChainDrawFlags.CastsCascades | ChainDrawFlags.CastsStatic;

/**
 * which sun shadow maps a draw casts into, by the game's rule (the lighting page's shadows)
 *
 * @param renderFlags a static renderer draw's flag word
 * @returns its {@link ChainDraw.flags}
 */
export const chainDrawFlagsOf = (renderFlags: number): number => {
	if ((renderFlags & DrawFlags.CastShadow) === 0) {
		return 0;
	}
	let flags = 0;
	if ((renderFlags & DrawFlags.RealtimeShadowCaster) !== 0 && (renderFlags & DrawFlags.Cascades) !== 0) {
		flags |= ChainDrawFlags.CastsCascades;
	}
	if ((renderFlags & DrawFlags.StaticShadowCaster) !== 0) {
		flags |= ChainDrawFlags.CastsStatic;
	}
	return flags;
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
 * a camera-distance chain's origin ({@link ChainPlacement.distanceOrigin})
 *
 * @param matrix an instance's transform
 * @param origin a world point
 * @returns the point in the instance's frame, to the millimetre so placements of one prefab share chains; the
 *   instance's own origin when its transform has no inverse (a zero scale, so nothing draws)
 */
export const chainDistanceOrigin = (
	matrix: Float32Array,
	origin: readonly number[],
): [number, number, number] => {
	let local: [number, number, number] = [0, 0, 0];
	try {
		local = inverseTransformPoint(matrix, origin);
	} catch (error) {
		if (!(error instanceof RangeError)) {
			throw error;
		}
	}
	return [
		Math.round(local[0] * 1000) / 1000,
		Math.round(local[1] * 1000) / 1000,
		Math.round(local[2] * 1000) / 1000,
	];
};

/**
 * @param entity a chunk entity with a matrix
 * @returns its chain's placement: measured by camera distance from its LOD centre when the game stores its
 *   thresholds as distances (`ChunkEntity.lodDistanceFrom`), else by screen-relative size
 */
export const chunkEntityPlacement = (
	entity: Pick<ChunkEntity, 'lodDistanceFrom'> & { matrix: Float32Array },
): ChainPlacement => {
	if (entity.lodDistanceFrom === null) {
		return SCREEN_SIZED;
	}
	return { billboard: 0, distanceOrigin: chainDistanceOrigin(entity.matrix, entity.lodDistanceFrom) };
};

/** LOD-chain templates, deduplicated by their ordered draws, billboard mode and distance origin */
export class ChainTable {
	readonly chains: Chain[] = [];
	readonly #ids = new Map<string, number>();

	/**
	 * @param draws a renderer's draws in the game's order
	 * @param placement billboard mode and distance origin
	 * @returns the chain id; equal inputs return equal ids
	 */
	intern(draws: readonly ChainDraw[], placement: ChainPlacement = SCREEN_SIZED): number {
		const { billboard, distanceOrigin } = placement;
		let key = `${billboard},${distanceOrigin?.map(bits).join(',')}`;
		for (const draw of draws) {
			key += `|${draw.geometry},${draw.material},${draw.particles},${draw.submesh},${draw.lod},${draw.role},${bits(draw.minSquared)},${bits(draw.maxSquared)},${draw.flags},${draw.sortingLayer},${draw.sortingOrder}`;
		}
		return this.#ids.getOrInsertComputed(
			key,
			() =>
				this.chains.push({
					flags: billboard | (distanceOrigin === null ? 0 : ChainFlags.CameraDistance),
					draws: draws.map((draw) => ({ ...draw })),
					distanceOrigin: distanceOrigin === null ? null : [...distanceOrigin],
				}) - 1,
		);
	}

	/**
	 * assigns each chain its 64-bit canonical content hash and sorts chains ascending by hash. instance blocks
	 * store a local hash palette (`PLTT`) resolved against `chains.bin` on decode, so shard bytes are 100%
	 * deterministic and isolated from chains added or removed elsewhere in the scene
	 *
	 * @param keys names geometries, materials and particle systems by what they are (`AssetIds.keyOf`)
	 * @returns chains sorted by `contentHash` and per interned id its 64-bit `contentHash`
	 */
	canonicalOrder(keys: {
		geometry: (id: number) => string;
		material: (id: number) => string;
		particles: (id: number) => string;
	}): { chains: Chain[]; hashes: BigUint64Array } {
		const hashes = new BigUint64Array(this.chains.length);
		const order: number[] = [];
		for (const [id, chain] of this.chains.entries()) {
			let key = `${chain.flags},${chain.distanceOrigin?.map(bits).join(',')}`;
			for (const draw of chain.draws) {
				const material = draw.material === null ? '-' : keys.material(draw.material);
				const particles = draw.particles === null ? '-' : keys.particles(draw.particles);
				key += `|${keys.geometry(draw.geometry)},${material},${particles},${draw.submesh},${draw.lod},${draw.role},${bits(draw.minSquared)},${bits(draw.maxSquared)},${draw.flags},${draw.sortingLayer},${draw.sortingOrder}`;
			}
			// non-zero 64-bit hash (0n is reserved for absent hash)
			const hash = BigInt(`0x${cryptoHash('sha256', key, 'hex').slice(0, 16)}`) || 1n;
			hashes[id] = hash;
			order.push(id);
		}
		order.sort((a, b) => (hashes[a] < hashes[b] ? -1 : hashes[a] > hashes[b] ? 1 : a - b));
		const chains: Chain[] = [];
		for (const id of order) {
			const chain = this.chains[id];
			chains.push({
				contentHash: hashes[id],
				flags: chain.flags,
				draws: chain.draws,
				distanceOrigin: chain.distanceOrigin,
			});
		}
		return { chains, hashes };
	}
}
