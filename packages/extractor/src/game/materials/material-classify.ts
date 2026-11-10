/**
 * sorts a material into the HGRP shader family the viewer draws it as, and reads its render state: blend,
 * alpha test, cull and the Lit texture layout. stays out of the conversion worker's imports, so changing it
 * keeps the mesh and texture cache.
 */

import type { MaterialRecord, ShaderSummary } from '@endfield-noclip/formats/unity/material';
import type { MaterialCull } from '@endfield-noclip/package-format/materials';

import type { MaterialBlend, ShaderFamily } from './material-values.ts';

const FAMILIES: [RegExp, ShaderFamily][] = [
	[/^HGRP\/Lit$/i, 'lit'],
	[/^HGRP\/LitTransparent$/i, 'litTransparent'],
	[/^HGRP\/LitEffect$/i, 'litEffect'],
	[/^HGRP\/LitForward$/i, 'litForward'],
	[/^HGRP\/Foliage\/Leaf$/i, 'leaf'],
	[/^HGRP\/Foliage\/Trunk$/i, 'trunk'],
	[/^HGRP\/Foliage\/Grass$/i, 'grass'],
	// `HGRP/Foliage/TreeFoliageCardMeshLod`, `HGRP/Foliage/Grass Cardmesh Lod`
	[/^HGRP\/Foliage\/.*card\s*mesh\s*lod$/i, 'cardMesh'],
	[/^HGRP\/FogSimple$/i, 'fogSimple'],
	[/^HGRP\/WaterProxy$/i, 'waterProxy'],
	[/^HGRP\/WaterDecal$/i, 'waterDecal'],
	// VFXDitherAlpha's passes under another name, for waterfall splashes
	[/^HGRP\/Effect\/VFXWaterDitherAlpha$/i, 'vfxDitherAlpha'],
	[/water/i, 'water'],
	[/decal/i, 'decal'],
	[/^HGRP\/Effect\/VFXBase/i, 'vfxBase'],
	[/^HGRP\/Effect\/VFXAdvance/i, 'vfxAdvance'],
	// VFXAdvance's slots, drawn over characters
	[/^HGRP\/CharacterNPR_VFX$/i, 'vfxAdvance'],
	[/^HGRP\/Effect\/VFXRefract/i, 'vfxRefract'],
	[/^HGRP\/Effect\/VFXDitherAlpha/i, 'vfxDitherAlpha'],
	[/^HGRP\/Effect\/VFXSmoke_SixWay$/i, 'vfxSmokeSixWay'],
	[/FakeVolumeFog/i, 'vfxFakeVolumeFog'],
	[/^Hidden\/VLB_/i, 'volumetricBeam'],
	[/terrain/i, 'terrain'],
	[/hlod/i, 'hlod'],
	[/^HGRP\/MattePainting$/i, 'mattePainting'],
	[/^HGRP\/Erosion$/i, 'erosion'],
];

/**
 * @param shaderName e.g. `HGRP/Foliage/Leaf`
 * @returns its family
 */
export const shaderFamily = (shaderName: string): ShaderFamily => {
	return FAMILIES.find(([pattern]) => pattern.test(shaderName))?.[1] ?? 'unknown';
};

/** Unity `BlendMode` factors */
export const BlendFactor = {
	Zero: 0,
	One: 1,
	DstColor: 2,
	SrcColor: 3,
	OneMinusDstColor: 4,
	SrcAlpha: 5,
	OneMinusSrcColor: 6,
	DstAlpha: 7,
	OneMinusDstAlpha: 8,
	SrcAlphaSaturate: 9,
	OneMinusSrcAlpha: 10,
} as const;

/** a material's family and render state */
export interface MaterialClassification {
	family: ShaderFamily;
	shaderName: string;
	/** the custom queue, else the shader's, else 2000 */
	renderQueue: number;
	blend: MaterialBlend;
	/** source/destination factors for blended materials, as {@link BlendFactor} values */
	blendFactors: [number, number] | null;
	/** alpha-test threshold, or `null` without alpha testing */
	alphaClipThreshold: number | null;
	cull: MaterialCull;
	zWrite: boolean;
	/**
	 * Lit-family `_BaseTextureMapCount`, from the `_TWO_BASEMAP` keyword when the float is absent
	 * (`docs/game-data/materials.md#texture-layouts`). `null` for shaders without the switch (the Lit families
	 * and the shaders that declare `_BaseTextureMapCount` have it)
	 */
	baseTextureMapCount: number | null;
}

/**
 * classifies a material for rendering. the queue boundaries follow Unity (≥2450 alpha test, ≥3000
 * transparent); HGRP's `_SurfaceType`/`_EnableAlphaBlend`, `_SrcBlend`/`_DstBlend`,
 * `_EnableAlphaTest`/`_ALPHATEST_ON` and `_CullMode` refine it.
 *
 * @param material the material record
 * @param shader its shader's summary
 * @returns the classification
 */
export const classifyHgrpMaterial = (
	material: MaterialRecord,
	shader: ShaderSummary,
): MaterialClassification => {
	const { floats, keywords } = material;
	// a material keeps the properties of shaders it used before, so only properties the shader declares count,
	// falling back to the shader's default as Unity does. a shader without property info keeps every material
	// value
	const declared = new Map(shader.properties.map((property) => [property.name, property.default[0]]));
	// property names are Unity's, underscores included
	const float = (name: string): number | undefined => {
		if (declared.size > 0 && !declared.has(name)) {
			return undefined;
		}
		return Object.hasOwn(floats, name) ? floats[name] : declared.get(name);
	};
	const family = shaderFamily(shader.name);
	const renderQueue =
		material.customRenderQueue >= 0 ? material.customRenderQueue : (shader.renderQueue ?? 2000);

	const blended =
		renderQueue >= 3000 ||
		float('_SurfaceType') === 1 ||
		float('_EnableAlphaBlend') === 1 ||
		family === 'fogSimple' ||
		family === 'litTransparent';
	const alphaTested = keywords.includes('_ALPHATEST_ON') || float('_EnableAlphaTest') === 1;

	let blend: MaterialBlend;
	let blendFactors: [number, number] | null = null;
	if (blended) {
		const src = float('_SrcBlend') ?? BlendFactor.SrcAlpha;
		const dst = float('_DstBlend') ?? BlendFactor.OneMinusSrcAlpha;
		blendFactors = [src, dst];
		if (src === BlendFactor.SrcAlpha && dst === BlendFactor.OneMinusSrcAlpha) {
			blend = 'alphaBlend';
		} else if (src === BlendFactor.One && dst === BlendFactor.OneMinusSrcAlpha) {
			blend = 'premultiplied';
		} else if (dst === BlendFactor.One) {
			blend = 'additive';
		} else {
			blend = 'custom';
		}
	} else {
		blend = alphaTested || renderQueue >= 2450 ? 'alphaTest' : 'opaque';
	}

	const alphaClipThreshold =
		blend === 'alphaTest' || alphaTested ? (float('_AlphaClipThreshold') ?? float('_Cutoff') ?? 0.5) : null;

	let cull: MaterialCull;
	switch (float('_CullMode') ?? float('_Cull') ?? 2) {
		case 0: {
			cull = 'none';
			break;
		}
		case 1: {
			cull = 'front';
			break;
		}
		default: {
			cull = 'back';
		}
	}

	// the Lit families, and shaders sharing their layout switch (`HGRP/Foliage/Trunk`, `HGRP/LitEffect`)
	const litLike = family === 'lit' || family === 'litTransparent' || declared.has('_BaseTextureMapCount');
	const baseTextureMapCount = litLike
		? (float('_BaseTextureMapCount') ?? (keywords.includes('_TWO_BASEMAP') ? 2 : 0))
		: null;

	return {
		family,
		shaderName: shader.name,
		renderQueue,
		blend,
		blendFactors,
		alphaClipThreshold,
		cull,
		zWrite: float('_ZWrite') === undefined ? !blended : float('_ZWrite') !== 0,
		baseTextureMapCount,
	};
};
