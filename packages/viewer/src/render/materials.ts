/**
 * how the viewer's stand-in shading draws each package material: whether at all, which base colour texture,
 * and the colours with and without that texture bound.
 *
 * @module
 */

import type { MaterialTable } from '@endfield-noclip/package-format/format';

/** the Unity material property tinting the base colour */
const BASE_COLOR = '_BaseColor';
/** the Unity material property holding the base colour texture */
const BASE_COLOR_MAP = '_BaseColorMap';

/** shader families that aren't drawn as opaque stand-ins (fog volumes) */
const SKIPPED_FAMILIES = new Set(['fogSimple']);

const DEFAULT_COLOUR: [r: number, g: number, b: number] = [0.5, 0.5, 0.5];

/** untextured stand-in colour per shader family, linear */
const FAMILY_COLOURS: Record<string, [r: number, g: number, b: number]> = {
	lit: [0.5, 0.48, 0.45],
	litTransparent: [0.45, 0.55, 0.65],
	leaf: [0.2, 0.34, 0.12],
	grass: [0.26, 0.4, 0.15],
	cardMesh: [0.22, 0.36, 0.13],
	trunk: [0.3, 0.22, 0.16],
	hlod: [0.46, 0.44, 0.4],
};

/** floats of a material's draw parameters: colour (rgb, alpha-test threshold), UV transform (scale, offset) */
export const LOOK_FLOATS = 8;

/** one material as the mesh shader draws it */
export interface MaterialLook {
	/** `false` for materials not drawn at all (fog volumes, additive blending) */
	drawn: boolean;
	/** base colour texture id, or -1 */
	texture: number;
	/** largest UV scale of the base colour slot, for picking the mip level to stream */
	uvScale: number;
	/** {@link LOOK_FLOATS} draw parameters without the texture: family colour × `_BaseColor`, no alpha test */
	untextured: Float32Array;
	/** {@link LOOK_FLOATS} draw parameters with the texture bound: `_BaseColor`, alpha clip, slot UV transform */
	textured: Float32Array;
}

/** colours are authored gamma-encoded */
const linear = (value: number): number => value ** 2.2;

const look = (drawn: boolean, colour: readonly number[]): MaterialLook => ({
	drawn,
	texture: -1,
	uvScale: 1,
	untextured: new Float32Array([colour[0], colour[1], colour[2], -1, 1, 1, 0, 0]),
	textured: new Float32Array([1, 1, 1, -1, 1, 1, 0, 0]),
});

/**
 * @param materials the package's material table
 * @returns a look per material id
 */
export const materialLooks = (materials: MaterialTable): MaterialLook[] => {
	const looks: MaterialLook[] = [];
	for (const entry of materials.entries) {
		if (entry.status !== 'ready') {
			looks[entry.id] = look(true, DEFAULT_COLOUR);
			continue;
		}
		const shader = materials.shaders[entry.shader];
		if (SKIPPED_FAMILIES.has(shader.family) || entry.blend === 'additive') {
			looks[entry.id] = look(false, DEFAULT_COLOUR);
			continue;
		}
		const family = FAMILY_COLOURS[shader.family] ?? DEFAULT_COLOUR;
		const base = entry.colors[BASE_COLOR] ?? shader.colors[BASE_COLOR];
		const tint =
			base === undefined
				? family
				: [family[0] * linear(base[0]), family[1] * linear(base[1]), family[2] * linear(base[2])];
		const result = look(true, tint);
		const slot = entry.slots[BASE_COLOR_MAP];
		if (slot !== undefined) {
			result.texture = slot.texture;
			result.uvScale = Math.max(Math.abs(slot.scale[0]), Math.abs(slot.scale[1]), 1e-3);
			result.textured.set([...slot.scale, ...slot.offset], 4);
		}
		if (base !== undefined) {
			result.textured.set([linear(base[0]), linear(base[1]), linear(base[2])]);
		}
		result.textured[3] = entry.alphaClip ?? -1;
		looks[entry.id] = result;
	}
	return looks;
};
