import type { DitheredSurface, UnsupportedSurface } from '@endfield-noclip/package-format/surfaces';
import type { Rgb } from '@endfield-noclip/package-format/values';

import { linearRgb, type MaterialReader, scaleRgb, unsupported } from '../material-values.ts';

/** keywords a `HGRP/Effect/VFXDitherAlpha` material can have and still be drawn as a dithered surface */
const DITHERED_KEYWORDS = new Set(['_NORMAL_MAP', '_USE_MAIN2']);

/**
 * `HGRP/Effect/VFXDitherAlpha` and its variants as an opaque G-buffer surface
 * (`docs/game-data/effects.md#solid-effects`)
 *
 * @param reader the material's properties
 * @returns its surface, or `unsupported` with keywords or texture combinations the viewer doesn't draw
 */
export const describeDithered = (reader: MaterialReader): DitheredSurface | UnsupportedSurface => {
	const { float, color, has, material } = reader;
	const unknown = material.keywords.filter((keyword) => !DITHERED_KEYWORDS.has(keyword));
	if (unknown.length > 0) {
		return unsupported(`keywords ${unknown.join(', ')}`);
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
	const lit = float('_UseLighting', 1) !== 0;
	// the depth pass's dithered alpha test, which shapes meshes such as the soft dark disc at the centre of
	// Power Plateau's sky vortex. the viewer draws it for the main texture's alpha (or red, as the alpha alone,
	// on unlit surfaces) in the default dither mode
	let dither: DitheredSurface['dither'] = null;
	if (main !== undefined && !has('_USE_MAIN2') && float('_DitherAlphaMode', 0) === 0 && (!redAlpha || !lit)) {
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
				}
			: null,
		ignorePostExposure: float('_IgnorePostExposure', 1),
	};
};
