/**
 * steps every kind of surface describer takes: the checks that mark a material `unsupported`, and slot
 * transforms
 */

import type { TextureSlot } from '@endfield-noclip/package-format/materials';
import type { UnsupportedSurface } from '@endfield-noclip/package-format/surfaces';

import { type MaterialBlend, type MaterialReader, unsupported } from './material-values.ts';

/** @returns `unsupported` naming the material's blend unless it's one of `drawn`, else `null` */
export const undrawnBlend = (
	reader: MaterialReader,
	drawn: readonly MaterialBlend[],
): UnsupportedSurface | null =>
	drawn.includes(reader.material.blend) ? null : unsupported(`${reader.material.blend} blending`);

/** @returns `unsupported` naming the material's keywords outside `drawn`, or `null` when it has none */
export const undrawnKeywords = (
	reader: MaterialReader,
	drawn: Pick<ReadonlySet<string>, 'has'>,
): UnsupportedSurface | null => {
	const undrawn = reader.material.keywords.filter((keyword) => !drawn.has(keyword));
	return undrawn.length === 0 ? null : unsupported(`keywords ${undrawn.join(', ')}`);
};

/** @returns `unsupported` for a slot on a UV set past 1: the geometry carries sets 0 and 1 only */
export const pastUvSets = (name: string, slot: Pick<TextureSlot, 'uv'>): UnsupportedSurface | null =>
	slot.uv > 1 ? unsupported(`${name} on UV set ${slot.uv}`) : null;

/**
 * @param slot a bound slot
 * @param tiling the scale of both UV axes, in place of the slot's `_ST`
 * @param uv the UV set it samples
 * @returns the slot tiled by its own scale
 */
export const tiledSlot = (slot: TextureSlot, tiling: number, uv: number): TextureSlot => ({
	texture: slot.texture,
	uv,
	scale: [tiling, tiling],
	offset: [0, 0],
});
