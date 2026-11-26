/**
 * what a surface is drawn without: the keywords the surface describers don't read, and the property values
 * they read past
 */

import type { MaterialReader } from '../material-values.ts';

import { VAT_KEYWORDS, vatKeyword, vatOf } from './vat-animation.ts';

/** keywords every surface reads: the alpha test and both emission sources */
const SURFACE_KEYWORDS = ['_ALPHATEST_ON', '_EMISSIVE_MAP', '_EMISSIVE_MASK'];

/**
 * Lit's own layers, which `HGRP/LitEffect` shares. `_EMISSIVE_ANIM_SWEEP` is intentionally omitted so
 * `surfaceGaps` flags the undrawn sweep band even though `describeLit` reads its steady emission share
 */
const LIT_KEYWORDS = [
	...SURFACE_KEYWORDS,
	'_TWO_BASEMAP',
	'_EMISSIVE_ANIM',
	'_TRI_CHANNEL_MASK',
	'_DETAIL_MAP',
	'_PARALLAX_MAP',
	'_PARALLAX_MAP_WORLDSPACE',
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
			// drawn but for gravity (its own keyword) or an anchor of its own (`_Use_Custom_Anchor`)
			'_SIMPLE_VERTEXANIM_PENDULUM',
			// changes nothing on its own: the simulation it allows runs per entity, and the pack counts the
			// entities that have one (`clothSimulated`)
			'_GPU_CLOTH',
			'_USE_VERTOFFSET',
			'_USE_VERTOFFSETMASK',
			// baked into the meshes they draw (`vatSkin`, `boneVatSkin`); the cases `vatOf` doesn't play are gaps
			'_VAT_RIGIDBODY',
			'_VAT_SOFTBODY',
			'_COMMONVAT_BONE_1',
			'_COMMONVAT_BONE_2',
			'_COMMONVAT_BONE_3',
			'_COMMONVAT_BONE_4',
			'_ZWRITE_OFF',
		],
		'HGRP/LitEffect': [...LIT_KEYWORDS, VAT_KEYWORDS.rigid, VAT_KEYWORDS.soft],
		'Hidden/HGRP/LitEffectBlend': LIT_KEYWORDS,
		'HGRP/LitTransparent': [...SURFACE_KEYWORDS, '_TWO_BASEMAP', '_USE_FRESNEL', '_SUBSURFACE'],
		// its own cubemap reflection (`_CUSTOM_IBL`) isn't drawn: the viewer lights Lit surfaces deferred
		'HGRP/LitForward': [...SURFACE_KEYWORDS, '_TWO_BASEMAP'],
		'HGRP/Foliage/Trunk': [...SURFACE_KEYWORDS, '_TWO_BASEMAP', '_FOLIAGE_TRUNK'],
		'HGRP/Foliage/Leaf': [...SURFACE_KEYWORDS, '_CANOPY_COLOR_RAMP', '_BLEND_COLOR'],
		'HGRP/Foliage/Grass': [...SURFACE_KEYWORDS, '_USE_CAMERA_BASED_TILLING'],
		'HGRP/Foliage/Grass Cardmesh Lod': [...SURFACE_KEYWORDS, '_USE_CAMERA_BASED_TILLING'],
		// the tree card LOD's own inputs aren't decoded
		'HGRP/Foliage/TreeFoliageCardMeshLod': [...SURFACE_KEYWORDS],
		// its blend into the terrain beneath (`_TERRAIN_BLEND`) isn't drawn, as Lit's isn't
		'HGRP/Foliage/Glow': ['_DISTORTION_FLOW'],
		'HGRP/Foliage/MushroomAnimation': ['_ALPHATEST_ON'],
		'HGRP/LitHLOD': SURFACE_KEYWORDS,
		'HGRP/MattePainting': SURFACE_KEYWORDS,
		'HGRP/Erosion': SURFACE_KEYWORDS,
		'HGRP/ErosionDynamic': SURFACE_KEYWORDS,
		'HGRP/SludgeV2': SURFACE_KEYWORDS,
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

/**
 * property values that switch on something a describer reads past, under a keyword it does read: the
 * property, the keyword its variant needs, and the value that leaves the feature off
 */
const PROPERTY_GAPS: readonly { property: string; keyword: string; off: number }[] = [
	// a parallax glow masked by a texture of its own, which has no slot: the glow isn't drawn
	{ property: '_UseParallaxMask', keyword: '_PARALLAX_MAP', off: 0 },
	// the pulse's random flicker: drawn steady
	{ property: '_EnableEmissiveAnimFlicker', keyword: '_EMISSIVE_ANIM', off: 0 },
	// the mask's R on a UV set and tiling of its own
	{ property: '_UseMaskRUVSetAndTilingScale', keyword: '_TRI_CHANNEL_MASK', off: 0 },
	// a pendulum's anchor of its own: it keeps still (`swayOf`)
	{ property: '_Use_Custom_Anchor', keyword: '_SIMPLE_VERTEXANIM_PENDULUM', off: 0 },
];

/** the shaders whose describer reads {@link PROPERTY_GAPS}' keywords */
const PROPERTY_GAP_SHADERS = new Set(['HGRP/Lit', 'HGRP/LitEffect', 'Hidden/HGRP/LitEffectBlend']);

/**
 * what the game draws of a material that its surface leaves out, for the viewer's gaps view: the keywords
 * {@link keywordsNotDrawn} lists, then the properties whose value asks for something the describer reads
 * past
 *
 * @param reader the properties of a material drawn as a surface
 * @returns the keywords and property names, empty when the surface holds all the game draws as far as is
 *   known; always empty for effect shaders
 */
export const surfaceGaps = (reader: MaterialReader): string[] => {
	const shader = reader.shader.name;
	const gaps = keywordsNotDrawn(shader, reader.material.keywords);
	if (PROPERTY_GAP_SHADERS.has(shader)) {
		for (const { property, keyword, off } of PROPERTY_GAPS) {
			if (property === '_UseParallaxMask' && reader.has('_PARALLAX_MAP_WORLDSPACE')) {
				continue;
			}
			if (reader.has(keyword) && reader.float(property, off) !== off) {
				gaps.push(property);
			}
		}
	}
	const hasVat =
		shader === 'HGRP/Lit' ||
		(shader === 'HGRP/LitEffect' && (reader.has(VAT_KEYWORDS.rigid) || reader.has(VAT_KEYWORDS.soft)));
	const vat = hasVat ? vatOf(reader) : null;
	const keyword = vat !== null && 'kind' in vat ? vatKeyword(reader) : null;
	if (keyword !== null) {
		gaps.push(keyword);
	}
	return gaps;
};
