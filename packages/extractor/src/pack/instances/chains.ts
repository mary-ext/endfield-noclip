import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DrawFlags } from '@endfield-noclip/formats/endfield/init-chunk-data';
import {
	type Chain,
	ChainDrawFlags,
	ChainFlags,
	type ChainDraw,
} from '@endfield-noclip/package-format/instances';

import { ignoreMissing } from '../../errors.ts';
import { DEBUG_DIR } from '../debug.ts';

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

/** what a package id no chain holds stores */
const EMPTY_CHAIN: Chain = { flags: 0, draws: [], distanceOrigin: null };

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
	 * interned ids follow the order chains are first met, so a chain added early would shift every later id and
	 * change every instance block naming one, renaming every shard archive. chains instead keep the ids the
	 * replaced package gave them, matched by what their draws are; new chains take the ids of chains that are
	 * gone, then follow at the end, both in key order. ids left free hold an empty chain
	 *
	 * @param keys names geometries, materials and particle systems by what they are (`AssetIds.keyOf`)
	 * @param previous the replaced package's chain keys by id (see the returned `keys`), or empty
	 * @returns per interned chain id, its id in the package, the chains in package order, and each one's key
	 *   (empty for a free id), for the next pack to follow
	 */
	stableOrder(
		keys: {
			geometry: (id: number) => string;
			material: (id: number) => string;
			particles: (id: number) => string;
		},
		previous: readonly string[],
	): { ids: Uint32Array; chains: Chain[]; keys: string[] } {
		const keyOf = (chain: Chain): string => {
			let key = `${chain.flags},${chain.distanceOrigin?.map(bits).join(',')}`;
			for (const draw of chain.draws) {
				const material = draw.material === null ? '-' : keys.material(draw.material);
				const particles = draw.particles === null ? '-' : keys.particles(draw.particles);
				key += `|${keys.geometry(draw.geometry)},${material},${particles},${draw.submesh},${draw.lod},${draw.role},${bits(draw.minSquared)},${bits(draw.maxSquared)},${draw.flags},${draw.sortingLayer},${draw.sortingOrder}`;
			}
			return createHash('sha256').update(key).digest('hex').slice(0, 32);
		};
		const was = new Map(previous.map((key, id) => [key, id]));
		const ids = new Uint32Array(this.chains.length);
		/** per package id, the interned chain that takes it, or `null` while free */
		const slots: (number | null)[] = previous.map(() => null);
		const chainKeys = this.chains.map(keyOf);
		const added: number[] = [];
		for (const [id, key] of chainKeys.entries()) {
			const kept = was.get(key);
			if (kept === undefined) {
				added.push(id);
			} else {
				ids[id] = kept;
				slots[kept] = id;
			}
		}
		added.sort((a, b) => Number(chainKeys[a] > chainKeys[b]) - Number(chainKeys[a] < chainKeys[b]));
		let free = 0;
		for (const id of added) {
			while (free < slots.length && slots[free] !== null) {
				free++;
			}
			ids[id] = free;
			slots[free] = id;
		}
		while (slots.length > 0 && slots.at(-1) === null) {
			slots.pop();
		}
		return {
			ids,
			chains: slots.map((id) => (id === null ? EMPTY_CHAIN : this.chains[id])),
			keys: slots.map((id) => (id === null ? '' : chainKeys[id])),
		};
	}
}

/**
 * the debug file a package records its chains' keys in, which the next pack into its directory keeps the ids
 * of
 */
export const CHAIN_KEYS_FILE = 'chains.json';

/**
 * @param packageDir a package the pack replaces
 * @returns its chains' keys by id ({@link ChainTable.stableOrder}), or empty when it has none
 */
export const readChainKeys = async (packageDir: string): Promise<string[]> => {
	const text = await ignoreMissing(readFile(join(packageDir, DEBUG_DIR, CHAIN_KEYS_FILE), 'utf8'), null);
	if (text === null) {
		return [];
	}
	const value: unknown = JSON.parse(text);
	return Array.isArray(value) && value.every((key) => typeof key === 'string') ? value : [];
};
