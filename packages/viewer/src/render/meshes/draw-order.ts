/**
 * which range a mesh bucket draws in and its place there: pure functions of the bucket, its look and its
 * material's state
 *
 * @module
 */

import { GAPS_FLOAT, LookFlags, LookRow, Slot, type MaterialLook } from '../../looks/look.ts';
import type { ListedSpan } from '../instances/instance-renderer.ts';

import type { DrawRange, RangeOrder } from './draw-ranges.ts';
import type { MaterialState } from './material-bindings.ts';
import type { MeshBucket } from './mesh-buckets.ts';

/** look flags that bail out of the lean `opaqueLit` shader into the full `opaque` uber-shader */
const COMPLEX_OPAQUE_FLAGS =
	LookFlags.Unlit |
	LookFlags.Erosion |
	LookFlags.DetailMap |
	LookFlags.LayerBlend |
	LookFlags.TriChannelMask |
	LookFlags.ParallaxMap |
	LookFlags.ParallaxNoiseMap |
	LookFlags.Foliage |
	LookFlags.FoliageLeaf |
	LookFlags.Trunk |
	LookFlags.VertexOffset |
	LookFlags.Effect |
	LookFlags.MaskMap |
	LookFlags.EmissiveMap |
	LookFlags.EmissiveMask;

/**
 * @returns whether an opaque look uses only base + normal PBR terms and can run the lean `fs_opaque_lit`
 *   shader
 */
export const isSimpleOpaqueLit = (look: MaterialLook): boolean =>
	(look.flags & COMPLEX_OPAQUE_FLAGS) === 0 &&
	look.extraFlags === 0 &&
	look.stencil === null &&
	look.params[LookRow.emissivePulse + 2] === 0 &&
	look.params[LookRow.foliage + 3] === 0 &&
	look.params[LookRow.canopy + 3] === 0 &&
	look.params[GAPS_FLOAT] === 0;

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
	}: {
		castOnly: boolean;
		stencil: boolean;
		state: Pick<MaterialState, 'slots' | 'alphaReady' | 'complete'> & { simpleOpaque?: boolean };
	},
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
		case 'opaque': {
			return (state.simpleOpaque ?? isSimpleOpaqueLit(look)) ? 'opaqueLit' : 'opaque';
		}
		case 'transparent':
		case 'transparentDepthWrite':
		case 'transparentDepthOnly': {
			return queue;
		}
		// without the texture holding its alpha there's nothing to test yet, so it draws opaque.
		// sludge heightfields wait for their heightmap (slot 6) rather than flashing a flat square
		case 'cutout': {
			if ((look.flags & LookFlags.Erosion) !== 0 && look.params[LookRow.emissive2 + 3] > 1.5) {
				return state.slots[Slot.ParallaxNoise] !== null ? queue : null;
			}
			return state.alphaReady ? queue : 'opaque';
		}
		// mesh decals without depth write wait for their alpha texture rather than covering the floor as solids
		case 'cutoutOverlay': {
			return state.alphaReady ? queue : null;
		}
		// effects are made of their textures, so they wait for all of them
		case 'effect':
		case 'effectOpaque':
		case 'effectDecal':
		case 'mist':
		case 'mistVolume':
		case 'litDecal':
		case 'wetnessDecal':
		case 'screenMultiply':
		case 'refract':
		case 'refractOpaque':
		case 'radialBlur':
		case 'radialBlurThrough':
		case 'waterFoam':
		case 'waterFoamBehind':
		case 'waterFoamThrough': {
			return state.complete ? queue : null;
		}
	}
};

/**
 * @returns the upper part of {@link sortKeyOf}: shadow role, face culling, position format, UV format, and
 *   vertex buffer order, as a small integer
 */
export const pipelineKeyOf = (bucket: MeshBucket): number => {
	const resident = bucket.geometry.resident;
	const formatVariant = resident?.kind === 'geometry' ? resident.formatVariant : 0;
	const order = resident?.kind === 'geometry' ? resident.vertices.order : 3;
	return ((bucket.shadowRank * 4 + bucket.cullIndex) * 4 + formatVariant) * 4 + order;
};

/**
 * @returns the bucket's place in the draw order within the opaque, alpha-tested and alpha-blended draws:
 *   cast-only draws, then the other shadow casters, so shadow passes draw a prefix and the main pass skips
 *   one; then face culling and UV format (one pipeline each), the geometry's vertex buffers (a pool's, so
 *   draws from one pool bind them once), geometry, material and submesh, packed into one number (52 bits) to
 *   keep the sort cheap
 */
export const sortKeyOf = (bucket: MeshBucket, pipelineKey = pipelineKeyOf(bucket)): number => {
	let key = pipelineKey * 2 ** 21 + Math.min(bucket.geometry.blob, 2 ** 21 - 1);
	key = key * 2 ** 16 + Math.min(bucket.material, 2 ** 16 - 1);
	return key * 2 ** 8 + Math.min(bucket.submesh, 2 ** 8 - 1);
};

/**
 * packs pipeline key and clamped nearest distance into one sortable float so depth-writing draws sort with a
 * single subtraction instead of a two-field comparator
 */
export const pipelineNearestKeyOf = (pipelineKey: number, nearest: number): number =>
	pipelineKey * 1e6 + Math.min(999_999, Math.max(0, nearest));

/** a bucket queued to draw this frame, with where its rows landed in the visible list */
export interface DrawEntry {
	bucket: MeshBucket;
	span: ListedSpan;
	state: MaterialState;
	/** sort key for the entry's range (`pipelineNearestKeyOf` or `sortKeyOf`) */
	key: number;
}

const byKey = (a: DrawEntry, b: DrawEntry): number => a.key - b.key;

/** 0 for a bucket whose draws write the stencil, else 1 */
const stencilWriteRank = ({ bucket }: DrawEntry): number => (bucket.look.stencil?.replace === true ? 0 : 1);

/**
 * draw order for effects: as {@link byKey}, but those that write the stencil first, so the effects testing it
 * see the whole mask
 */
const byStencilWritesThenBindings = (a: DrawEntry, b: DrawEntry): number =>
	stencilWriteRank(a) - stencilWriteRank(b) || a.key - b.key;

/** the comparator of each {@link RangeOrder} */
export const COMPARATORS: Record<RangeOrder, (a: DrawEntry, b: DrawEntry) => number> = {
	pipelineThenNearest: byKey,
	bindings: byKey,
	stencilWritesThenBindings: byStencilWritesThenBindings,
};
