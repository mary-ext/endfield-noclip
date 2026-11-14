import type {
	MaterialCull,
	MaterialEntry,
	MaterialMotion,
	MaterialTable,
	ReadyMaterial,
} from '@endfield-noclip/package-format/materials';
import type {
	EffectStackSurface,
	EffectStencil,
	StencilMaskSurface,
	WaterFoamSurface,
} from '@endfield-noclip/package-format/surfaces';

import { skinFrame } from '../render/meshes/skin-frame.ts';

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
	GAPS_FLOAT,
	LookFlags,
	type LookMotion,
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

/** the queue of a WaterDecal box, whose pipeline carries its depth test */
const FOAM_QUEUES: Record<WaterFoamSurface['depthTest'], LookQueue> = {
	'less-equal': 'waterFoam',
	greater: 'waterFoamBehind',
	always: 'waterFoamThrough',
};

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

const materialLook = (entry: MaterialEntry): MaterialLook => {
	// a material that didn't convert (its reason is in debug/assets.json) has nothing to draw by
	if (entry.status !== 'ready') {
		return unsupportedLook();
	}
	const look = stillLook(entry);
	if (entry.motion !== null) {
		look.motion = lookMotion(entry, entry.motion, look.params);
	}
	return look;
};

/** a converted material's look as its surface stands, with its gaps */
const stillLook = (entry: ReadyMaterial): MaterialLook => {
	const look = surfaceLook(entry);
	look.gaps.unshift(...entry.gaps);
	// effect looks keep the float for their own; their describers turn what they can't draw unsupported
	if (look.gaps.length > 0 && (look.flags & LookFlags.Effect) === 0) {
		look.params[GAPS_FLOAT] = 1;
	}
	return look;
};

/**
 * plays a material's looping clip: at each of its steps the surface takes the tracks' values and its look is
 * built again, for the parameters alone. the textures, queue and flags stay the first build's, which tracks
 * of numbers leave alone
 *
 * @param entry the material
 * @param motion its motion
 * @param params the look's parameters, which each step overwrites
 * @returns the motion
 */
const lookMotion = (entry: ReadyMaterial, motion: MaterialMotion, params: Float32Array): LookMotion => {
	const steps = Math.min(...motion.tracks.map(({ values }) => values.length));
	let shown = -1;
	return {
		advance(time) {
			if (!(steps > 0 && motion.duration > 0)) {
				return false;
			}
			// the step a looping geometry of the same clip shows (`skinFrame`)
			const step = skinFrame(time, steps, steps / motion.duration).a;
			if (step === shown) {
				return false;
			}
			shown = step;
			const surface = structuredClone(entry.surface);
			for (const { path, values } of motion.tracks) {
				setAt(surface, path, values[step]);
			}
			params.set(stillLook({ ...entry, surface }).params);
			return true;
		},
	};
};

/** sets the number at a path of property names and array indices, where the path leads to one */
const setAt = (root: object, path: readonly (string | number)[], value: number): void => {
	let at: unknown = root;
	for (const [i, key] of path.entries()) {
		if (typeof at !== 'object' || at === null) {
			return;
		}
		if (i === path.length - 1) {
			if (typeof Reflect.get(at, key) === 'number') {
				Reflect.set(at, key, value);
			}
			return;
		}
		at = Reflect.get(at, key);
	}
};

/** a new look for a converted material's surface, with the gaps its builder leaves */
const surfaceLook = (entry: ReadyMaterial): MaterialLook => {
	const surface = entry.surface;
	switch (surface.kind) {
		case 'undrawn': {
			return emptyLook({ drawn: false });
		}
		case 'unsupported': {
			return unsupportedLook();
		}
		case 'mattePainting': {
			return mattePaintingLook(surface, entry.cull);
		}
		case 'erosion': {
			return erosionLook(surface, entry.cull);
		}
		case 'dithered': {
			return ditheredLook(surface, entry.cull);
		}
		case 'lit': {
			return litLook(surface, entry.cull);
		}
		case 'mistCard': {
			return effectMaterialLook(mistCardLook(surface), {
				queue: 'mist',
				cull: entry.cull,
			});
		}
		case 'mistVolume': {
			return effectMaterialLook(mistVolumeLook(surface), {
				queue: 'mistVolume',
				box: true,
				cull: entry.cull,
			});
		}
		case 'lightBeam': {
			return effectMaterialLook(lightBeamLook(surface), {
				queue: 'effect',
				cull: entry.cull,
			});
		}
		case 'effectStack': {
			return effectMaterialLook(stackLook(surface), {
				queue: stackQueue(surface),
				box: surface.variant === 'decal',
				cull: entry.cull,
				stencil: surface.stencil === null ? null : lookStencilOf(surface.stencil),
			});
		}
		case 'stencilMask': {
			return stencilMaskLook(surface, entry.cull);
		}
		case 'waterSheet': {
			return effectMaterialLook(waterSheetLook(surface), {
				queue: 'effect',
				cull: entry.cull,
			});
		}
		case 'sixWaySmoke': {
			return effectMaterialLook(sixWaySmokeLook(surface), {
				queue: 'effect',
				cull: entry.cull,
			});
		}
		case 'litDecal': {
			return effectMaterialLook(litDecalLook(surface), {
				// a wetness decal darkens the surface's own albedo, which only the relight pass estimates
				queue: surface.relight || surface.wetness !== null ? 'decalRelight' : 'litDecal',
				box: true,
				cull: entry.cull,
			});
		}
		case 'refract': {
			return effectMaterialLook(refractLook(surface), {
				queue: surface.opaque ? 'refractOpaque' : 'refract',
				cull: entry.cull,
			});
		}
		case 'waterFoam': {
			return effectMaterialLook(waterFoamLook(surface), {
				queue: FOAM_QUEUES[surface.depthTest],
				cull: entry.cull,
			});
		}
	}
};

/**
 * @param materials the package's material table
 * @returns a look per material id
 */
export const materialLooks = (materials: MaterialTable): MaterialLook[] =>
	materials.entries.map(materialLook);

/**
 * each material's look, built when first asked for: a package has tens of thousands of materials (tens of
 * milliseconds to build at open), and a view uses a fraction of them
 */
export class LazyMaterialLooks {
	#entries: readonly MaterialEntry[];
	// filled up front: an array written at scattered indices turns into a slow dictionary
	#looks: (MaterialLook | null)[];

	/** @param materials the package's material table */
	constructor(materials: MaterialTable) {
		this.#entries = materials.entries;
		this.#looks = Array.from({ length: materials.entries.length }, () => null);
	}

	/** how many materials there are */
	get count(): number {
		return this.#entries.length;
	}

	/**
	 * @param material material id, below {@link count}
	 * @returns its look
	 */
	look(material: number): MaterialLook {
		return (this.#looks[material] ??= materialLook(this.#entries[material]));
	}
}

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
	gaps: [],
	motion: null,
});
