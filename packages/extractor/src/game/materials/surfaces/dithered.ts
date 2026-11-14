import type { DitheredSurface, UnsupportedSurface } from '@endfield-noclip/package-format/surfaces';
import type { Rgb } from '@endfield-noclip/package-format/values';

import { undrawnKeywords } from '../describe-steps.ts';
import { linearRgb, type MaterialReader, scaleRgb, unsupported } from '../material-values.ts';

/** keywords a `HGRP/Effect/VFXDitherAlpha` material can have and still be drawn as a dithered surface */
const DITHERED_KEYWORDS = new Set(['_NORMAL_MAP', '_USE_MAIN2', '_SUBSURFACE']);

const NO_LIGHTING_SHADER = 'HGRP/Effect/VFXDitherAlphaNoLighting';

/** a colour's hue, saturation and value, each 0–1, as Unity's `Color.RGBToHSV` gives them */
const hsvOf = ([r, g, b]: Rgb): Rgb => {
	const max = Math.max(r, g, b);
	const span = max - Math.min(r, g, b);
	if (max <= 0 || span <= 0) {
		return [0, 0, max];
	}
	let sixth: number;
	switch (max) {
		case r: {
			sixth = (g - b) / span;
			break;
		}
		case g: {
			sixth = 2 + (b - r) / span;
			break;
		}
		default: {
			sixth = 4 + (r - g) / span;
		}
	}
	return [(sixth / 6 + 1) % 1, span / max, max];
};

/**
 * `_SUBSURFACE`'s values, which the game's lighting takes from a table the material registers its
 * `_SubsurfaceColor` (as stored) and `_SubsurfaceIndirect` in while `_EnableSubsurface` is set; unregistered,
 * it reads zeros
 */
const subsurfaceOf = ({
	float,
	color,
}: MaterialReader): NonNullable<DitheredSurface['lighting']>['subsurface'] => {
	if (float('_EnableSubsurface', 0) <= 0) {
		return [0, 0, 0, 0];
	}
	const [r, g, b] = color('_SubsurfaceColor') ?? [1, 1, 1, 1];
	return [...hsvOf([r, g, b]), float('_SubsurfaceIndirect', 1)];
};

/**
 * `HGRP/Effect/VFXDitherAlpha`, its variants and `HGRP/Effect/VFXWaterDitherAlpha` (the same passes) as an
 * opaque G-buffer surface (`docs/game-data/effects.md#solid-effects`)
 *
 * @param reader the material's properties
 * @returns its surface, or `unsupported` with keywords or texture combinations the viewer doesn't draw
 */
export const describeDithered = (reader: MaterialReader): DitheredSurface | UnsupportedSurface => {
	const { float, color, has } = reader;
	const keywords = undrawnKeywords(reader, DITHERED_KEYWORDS);
	if (keywords !== null) {
		return keywords;
	}
	let second: Rgb = [1, 1, 1];
	if (has('_USE_MAIN2')) {
		if (float('_UseMainTex2AsAlpha', 0) === 0 || float('_MainTex2BlendMode', 0) !== 0) {
			return unsupported('a second texture that colours or blends rather than masks');
		}
		second = linearRgb(color('_MainTex2Color') ?? [1, 1, 1, 1]);
	}
	const redAlpha = float('_UseMainTexAsAlpha', 0) !== 0;
	const main = reader.slot('_MainTex');
	const normal = has('_NORMAL_MAP') ? reader.slot('_NormalMap') : undefined;
	// the geometry's UV set 0 is all the shader reads
	if ((main !== undefined && main.uv !== 0) || (normal !== undefined && normal.uv !== 0)) {
		return unsupported('a texture on a UV set other than 0');
	}
	// the NoLighting variant draws only in an unlit forward pass and doesn't declare `_UseLighting`, whose
	// default would otherwise make it lit
	const lit = reader.shader.name !== NO_LIGHTING_SHADER && float('_UseLighting', 1) !== 0;
	// the depth pass's dithered alpha test, drawn for the main texture's alpha (or red, as the alpha alone) in
	// the default dither mode
	let dither: DitheredSurface['dither'] = null;
	if (main !== undefined && !has('_USE_MAIN2') && float('_DitherAlphaMode', 0) === 0) {
		dither = {
			texture: main,
			redAlpha,
			alphaScale: (color('_TintColor') ?? [1, 1, 1, 1])[3] * float('_TintColorAlpha', 1),
			exponent: float('_DitherAlphaExp', 1),
			tiling: float('_DitherTilling', 1),
		};
	}
	const tint = scaleRgb(linearRgb(color('_TintColor') ?? [1, 1, 1, 1]), float('_TintColorIntensity', 1));
	return {
		kind: 'dithered',
		baseMap: redAlpha ? null : (main ?? null),
		normalMap: normal ?? null,
		color: [tint[0] * second[0], tint[1] * second[1], tint[2] * second[2]],
		dither,
		lighting: lit
			? {
					roughness: float('_Roughness', 1),
					metallic: float('_Metallic', 0),
					normalScale: float('_NormalScale', 1),
					subsurface: has('_SUBSURFACE') ? subsurfaceOf(reader) : null,
				}
			: null,
		ignorePostExposure: float('_IgnorePostExposure', 1),
	};
};
