import { DrawFlags } from '@endfield-noclip/formats/endfield/init-chunk-data';
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
 * the game draws a caster into its cascades only with `CastShadow`, `RealtimeShadowCaster` and the cascade's
 * bit, and into its cached far map only with `CastShadow` and `StaticShadowCaster`
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
}
