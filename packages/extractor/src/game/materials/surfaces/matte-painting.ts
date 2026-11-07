import type { MattePaintingSurface } from '@endfield-noclip/package-format/surfaces';

import { linearRgb, type MaterialReader, scaleRgb } from '../material-values.ts';

/**
 * `HGRP/MattePainting` (`docs/game-data/materials.md#matte-paintings`)
 *
 * @param reader the material's properties
 * @returns its surface
 */
export const describeMattePainting = (reader: MaterialReader): MattePaintingSurface => {
	const { float, color, material } = reader;
	const slot = reader.slot('_MainTex');
	const tint = color('_TintColor') ?? [1, 1, 1, 1];
	const intensity = float('_TintColorIntensity', 1);
	// the alpha test on the texture's alpha alone: saturate(a · scale) < clip ⇔ a < clip / scale while clip ≤ 1;
	// past 1 everything is discarded
	let alphaClip: number | null = null;
	const clip = material.alphaClipThreshold;
	if (clip !== null && clip > 0) {
		const scale = tint[3] * float('_TintColorAlpha', 1);
		alphaClip = clip > 1 || scale <= 0 ? 2 : clip / scale;
	}
	return {
		kind: 'mattePainting',
		texture: slot !== undefined && slot.uv === 0 ? slot : null,
		color: scaleRgb(linearRgb(tint), intensity),
		alphaClip,
		highlight: { threshold: float('_ExpThreshold', 1), intensity: float('_ExpIntensity', 0) },
		ignorePostExposure: float('_IgnorePostExposure', 1),
	};
};
