/**
 * which range a mesh bucket draws in and its place there: pure functions of the bucket, its look and its
 * material's state
 *
 * @module
 */

import { LookFlags, type MaterialLook } from '../../looks/look.ts';
import type { MeshBucket } from '../../streaming/mesh-buckets.ts';
import type { ListedSpan } from '../instances/instance-renderer.ts';

import type { DrawRange, RangeOrder } from './draw-ranges.ts';
import type { MaterialState } from './material-bindings.ts';
import { FACE_CULLS, UV_FORMATS, faceCullOf, uvFormatOf } from './pipeline-variants.ts';

/**
 * @param look a bucket's look
 * @param context whether the bucket only casts shadows, whether the depth buffer has a stencil, and its
 *   material's state
 * @returns the range the bucket's draws join this frame, or `null` if they don't draw
 */
export const drawRangeOf = (
	look: MaterialLook,
	{
		castOnly,
		stencil,
		state,
	}: { castOnly: boolean; stencil: boolean; state: Pick<MaterialState, 'slots' | 'alphaReady' | 'complete'> },
): DrawRange | null => {
	const queue = look.queue;
	if (castOnly && (!look.castsShadows || (queue !== 'opaque' && queue !== 'cutout'))) {
		return null;
	}
	// a portal's effects would show unmasked, and its mask would draw as a solid surface
	if (look.stencil !== null && !stencil) {
		return null;
	}
	if (queue === 'stencilMask') {
		return queue;
	}
	// unlit looks are their texture, so they wait for it rather than draw as solid cards. the unsupported
	// checker has none to wait for
	if ((look.flags & LookFlags.Unlit) !== 0 && look.textures[0] !== null && state.slots[0] === null) {
		return null;
	}
	switch (queue) {
		case 'opaque':
		case 'transparent': {
			return queue;
		}
		// without the texture holding its alpha there's nothing to test yet, so it draws opaque
		case 'cutout': {
			return state.alphaReady ? queue : 'opaque';
		}
		// effects are made of their textures, so they wait for all of them
		case 'effect':
		case 'effectOpaque':
		case 'effectDecal':
		case 'mist':
		case 'mistVolume':
		case 'decalRelight':
		case 'screenMultiply':
		case 'refract':
		case 'waterFoam':
		case 'waterFoamBehind': {
			return state.complete ? queue : null;
		}
	}
};

/**
 * @returns the bucket's place in the draw order within the opaque, alpha-tested and alpha-blended draws:
 *   cast-only draws, then the other shadow casters, so shadow passes draw a prefix and the main pass skips
 *   one; then face culling and UV format (one pipeline each), geometry, material and submesh, packed into one
 *   number (50 bits) to keep the sort cheap
 */
export const sortKeyOf = (bucket: MeshBucket): number => {
	let key = bucket.castOnly ? 0 : 1;
	key = key * 2 + (bucket.look.castsShadows ? 0 : 1);
	key = key * 4 + FACE_CULLS.indexOf(faceCullOf(bucket));
	key = key * 2 + UV_FORMATS.indexOf(uvFormatOf(bucket));
	key = key * 2 ** 21 + Math.min(bucket.geometry.blob, 2 ** 21 - 1);
	key = key * 2 ** 16 + Math.min(bucket.material, 2 ** 16 - 1);
	return key * 2 ** 8 + Math.min(bucket.submesh, 2 ** 8 - 1);
};

/** a bucket queued to draw this frame, with where its rows landed in the visible list */
export interface DrawEntry {
	bucket: MeshBucket;
	span: ListedSpan;
	/** {@link sortKeyOf} the bucket */
	key: number;
}

const byBindings = (a: DrawEntry, b: DrawEntry): number => a.key - b.key;

/** 0 for a bucket whose draws write the stencil, else 1 */
const stencilWriteRank = ({ bucket }: DrawEntry): number => (bucket.look.stencil?.replace === true ? 0 : 1);

/**
 * draw order for effects: as {@link byBindings}, but those that write the stencil first, so the effects
 * testing it see the whole mask
 */
const byStencilWritesThenBindings = (a: DrawEntry, b: DrawEntry): number =>
	stencilWriteRank(a) - stencilWriteRank(b) || byBindings(a, b);

/** the part of {@link sortKeyOf} above the geometry: the shadow role and the pipeline */
const PIPELINE_KEY = 2 ** 45;

/**
 * draw order for depth-writing draws: as {@link byBindings} up to the pipeline, then nearest first, so early
 * depth testing skips more of the shading behind
 */
const byPipelineThenNearest = (a: DrawEntry, b: DrawEntry): number =>
	Math.floor(a.key / PIPELINE_KEY) - Math.floor(b.key / PIPELINE_KEY) || a.bucket.nearest - b.bucket.nearest;

/** the comparator of each {@link RangeOrder} */
export const COMPARATORS: Record<RangeOrder, (a: DrawEntry, b: DrawEntry) => number> = {
	pipelineThenNearest: byPipelineThenNearest,
	bindings: byBindings,
	stencilWritesThenBindings: byStencilWritesThenBindings,
};
