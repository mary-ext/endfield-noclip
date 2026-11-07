import type { MaterialCull, MaterialTable } from '@endfield-noclip/package-format/materials';
import type {
	EffectStackSurface,
	EffectStencil,
	StencilMaskSurface,
} from '@endfield-noclip/package-format/surfaces';

import type { EffectLook } from './effects/effect-look.ts';
import { lightBeamLook } from './effects/light-beam.ts';
import { litDecalLook } from './effects/lit-decal.ts';
import { mistCardLook, mistVolumeLook } from './effects/mist.ts';
import { refractLook } from './effects/refract.ts';
import { sixWaySmokeLook } from './effects/six-way-smoke.ts';
import { multipliesScene, stackLook } from './effects/stack.ts';
import { waterFoamLook } from './effects/water-foam.ts';
import { waterSheetLook } from './effects/water-sheet.ts';
import { litLook } from './lit-look.ts';
import {
	emptyLook,
	LookFlags,
	type LookQueue,
	LookRow,
	type LookStencil,
	type MaterialLook,
} from './look.ts';
import { ditheredLook, erosionLook, mattePaintingLook } from './special-looks.ts';

/** {@link unsupportedLook}'s colour, linear magenta */
const UNSUPPORTED_COLOR: [r: number, g: number, b: number] = [1, 0, 1];

/** the side of {@link unsupportedLook}'s checker cells, in metres */
const UNSUPPORTED_CELL = 0.5;

/**
 * unsupported material: a world-space magenta/black checker, unlit and exposure-independent. draws both faces
 * and casts no shadow. also the look of `DrawRole.Unsupported` stand-ins
 *
 * @returns a new look
 */
export const unsupportedLook = (): MaterialLook => {
	const look = emptyLook({ drawn: true });
	look.unsupported = true;
	look.castsShadows = false;
	look.flags |= LookFlags.Unlit;
	look.params.set([...UNSUPPORTED_COLOR, -1], LookRow.tint);
	look.params.set([1, 0, UNSUPPORTED_CELL], LookRow.surface);
	look.params[LookRow.emissive2 + 2] = 1;
	return look;
};

// #region stencils

/** a depth comparison under the viewer's reversed-Z */
const reversedDepthCompare = (compare: GPUCompareFunction): GPUCompareFunction => {
	switch (compare) {
		case 'less': {
			return 'greater';
		}
		case 'less-equal': {
			return 'greater-equal';
		}
		case 'greater': {
			return 'less';
		}
		case 'greater-equal': {
			return 'less-equal';
		}
		default: {
			return compare;
		}
	}
};

/** an effect's stencil state as the viewer draws it: the depth test under reversed-Z */
const lookStencilOf = (stencil: EffectStencil): LookStencil => ({
	...stencil,
	depthCompare: reversedDepthCompare(stencil.depthCompare),
});

/** the stencil-only look of a portal's mask ({@link StencilMaskSurface}) */
const stencilMaskLook = (mask: StencilMaskSurface, cull: MaterialCull): MaterialLook => {
	const look = emptyLook({ drawn: true });
	look.cull = cull;
	look.queue = 'stencilMask';
	look.castsShadows = false;
	look.stencil = lookStencilOf(mask.stencil);
	return look;
};

// #endregion

/**
 * @param materials the package's material table
 * @returns a look per material id
 */
export const materialLooks = (materials: MaterialTable): MaterialLook[] => {
	const looks: MaterialLook[] = [];
	for (const entry of materials.entries) {
		// a material that didn't convert (its reason is in debug/assets.json) has nothing to draw by
		if (entry.status !== 'ready') {
			looks[entry.id] = unsupportedLook();
			continue;
		}
		const surface = entry.surface;
		switch (surface.kind) {
			case 'undrawn': {
				looks[entry.id] = emptyLook({ drawn: false });
				break;
			}
			case 'unsupported': {
				looks[entry.id] = unsupportedLook();
				break;
			}
			case 'mattePainting': {
				looks[entry.id] = mattePaintingLook(surface, entry.cull);
				break;
			}
			case 'erosion': {
				looks[entry.id] = erosionLook(surface, entry.cull);
				break;
			}
			case 'dithered': {
				looks[entry.id] = ditheredLook(surface, entry.cull);
				break;
			}
			case 'lit': {
				looks[entry.id] = litLook(surface, entry.cull);
				break;
			}
			case 'mistCard': {
				looks[entry.id] = effectMaterialLook(mistCardLook(surface), {
					queue: 'mist',
					cull: entry.cull,
				});
				break;
			}
			case 'mistVolume': {
				looks[entry.id] = effectMaterialLook(mistVolumeLook(surface), {
					queue: 'mistVolume',
					box: true,
					cull: entry.cull,
				});
				break;
			}
			case 'lightBeam': {
				looks[entry.id] = effectMaterialLook(lightBeamLook(surface), {
					queue: 'effect',
					cull: entry.cull,
				});
				break;
			}
			case 'effectStack': {
				looks[entry.id] = effectMaterialLook(stackLook(surface), {
					queue: stackQueue(surface),
					box: surface.variant === 'decal',
					cull: entry.cull,
					stencil: surface.stencil === null ? null : lookStencilOf(surface.stencil),
				});
				break;
			}
			case 'stencilMask': {
				looks[entry.id] = stencilMaskLook(surface, entry.cull);
				break;
			}
			case 'waterSheet': {
				looks[entry.id] = effectMaterialLook(waterSheetLook(surface), {
					queue: 'effect',
					cull: entry.cull,
				});
				break;
			}
			case 'sixWaySmoke': {
				looks[entry.id] = effectMaterialLook(sixWaySmokeLook(surface), {
					queue: 'effect',
					cull: entry.cull,
				});
				break;
			}
			case 'litDecal': {
				looks[entry.id] = effectMaterialLook(litDecalLook(surface), {
					queue: surface.relight ? 'decalRelight' : 'effectDecal',
					box: true,
					cull: entry.cull,
				});
				break;
			}
			case 'refract': {
				looks[entry.id] = effectMaterialLook(refractLook(surface), {
					queue: 'refract',
					cull: entry.cull,
				});
				break;
			}
			case 'waterFoam': {
				looks[entry.id] = effectMaterialLook(waterFoamLook(surface), {
					queue: surface.depthTest === 'less-equal' ? 'waterFoam' : 'waterFoamBehind',
					cull: entry.cull,
				});
				break;
			}
		}
	}
	return looks;
};

/**
 * the queue of a VFXBaseV2 stack: opaque ones shade in the main pass, and those that multiply the scene draw
 * over the composited scene
 */
const stackQueue = (surface: EffectStackSurface): LookQueue => {
	if (surface.opaque) {
		return 'effectOpaque';
	}
	if (multipliesScene(surface)) {
		return 'screenMultiply';
	}
	return surface.variant === 'decal' ? 'effectDecal' : 'effect';
};

/**
 * @returns the look of a scene effect: blended and shadowless. boxes (decals, fog volumes) draw their back
 *   faces, so they still show with the camera inside them
 */
const effectMaterialLook = (
	effect: EffectLook,
	{
		queue,
		box = false,
		cull,
		stencil = null,
	}: {
		/** one of the effect queues */
		queue: LookQueue;
		/** whether the effect is a box drawn by its back faces */
		box?: boolean;
		cull: MaterialCull;
		stencil?: LookStencil | null;
	},
): MaterialLook => ({
	drawn: true,
	unsupported: false,
	queue,
	cull: box ? 'front' : cull,
	castsShadows: false,
	textures: effect.textures,
	uvScales: effect.uvScales,
	volumeTexture: effect.volumeTexture,
	flags: LookFlags.Effect,
	params: effect.params,
	stencil,
});
