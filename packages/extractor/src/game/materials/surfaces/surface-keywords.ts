/** the keywords the surface describers read, for listing the ones a surface is drawn without */

/** keywords every surface reads: the alpha test and both emission sources */
const SURFACE_KEYWORDS = ['_ALPHATEST_ON', '_EMISSIVE_MAP', '_EMISSIVE_MASK'];

/** Lit's own layers, which `HGRP/LitEffect` shares */
const LIT_KEYWORDS = [
	...SURFACE_KEYWORDS,
	'_TWO_BASEMAP',
	'_EMISSIVE_ANIM',
	'_TRI_CHANNEL_MASK',
	// only the R channel blends (docs/status.md)
	'_TRI_CHANNEL_MASK_SWITCH_TEXTURE',
	'_TRI_CHANNEL_MASK_SWITCH_TEXTURE_GWITHNORMAL',
	'_DETAIL_MAP',
	'_PARALLAX_MAP',
	'_LAYERBLEND_TOP',
	'_LAYERBLEND_MASK',
	'_LAYERBLEND_MOSS',
];

/**
 * the keywords the surface describers read, by surface shader; a describer that starts reading one adds it
 * here
 */
const DRAWN_KEYWORDS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
	Object.entries({
		// only `HGRP/Lit`'s sway and vertex offset are decoded
		'HGRP/Lit': [
			...LIT_KEYWORDS,
			'_SIMPLE_VERTEXANIM',
			'_SIMPLE_VERTEXANIM_CLOTH',
			'_USE_VERTOFFSET',
			'_USE_VERTOFFSETMASK',
		],
		'HGRP/LitEffect': LIT_KEYWORDS,
		'HGRP/LitTransparent': [...SURFACE_KEYWORDS, '_TWO_BASEMAP'],
		// its own cubemap reflection (`_CUSTOM_IBL`) isn't drawn: the viewer lights Lit surfaces deferred
		'HGRP/LitForward': [...SURFACE_KEYWORDS, '_TWO_BASEMAP'],
		'HGRP/Foliage/Trunk': [...SURFACE_KEYWORDS, '_TWO_BASEMAP'],
		'HGRP/Foliage/Leaf': [...SURFACE_KEYWORDS, '_NORMAL_MAP', '_CANOPY_COLOR_RAMP', '_BLEND_COLOR'],
		'HGRP/Foliage/Grass': [...SURFACE_KEYWORDS, '_NORMAL_MAP', '_USE_CAMERA_BASED_TILLING'],
		'HGRP/Foliage/Grass Cardmesh Lod': [...SURFACE_KEYWORDS, '_NORMAL_MAP', '_USE_CAMERA_BASED_TILLING'],
		// the tree card LOD's own inputs aren't decoded
		'HGRP/Foliage/TreeFoliageCardMeshLod': [...SURFACE_KEYWORDS, '_NORMAL_MAP'],
		'HGRP/LitHLOD': SURFACE_KEYWORDS,
		'HGRP/MattePainting': SURFACE_KEYWORDS,
		'HGRP/Erosion': SURFACE_KEYWORDS,
	}).map(([shader, keywords]) => [shader, new Set(keywords)]),
);

/**
 * a surface shader's keywords its describer doesn't read, which the surface is drawn without; for the pack's
 * debug index. effect describers mark materials with keywords they don't draw unsupported instead
 *
 * @param shader a material's shader name
 * @param keywords its enabled keywords
 * @returns the keywords not drawn; empty for effect shaders
 */
export const keywordsNotDrawn = (shader: string, keywords: readonly string[]): string[] => {
	const drawn = DRAWN_KEYWORDS.get(shader);
	return drawn === undefined ? [] : keywords.filter((keyword) => !drawn.has(keyword));
};
