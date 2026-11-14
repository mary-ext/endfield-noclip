import type {
	LitDecalSurface,
	UndrawnSurface,
	UnsupportedSurface,
} from '@endfield-noclip/package-format/surfaces';

import { undrawnKeywords } from '../describe-steps.ts';
import { type MaterialReader, unsupported } from '../material-values.ts';

/** lit decal keywords that are drawn; the others change the surface in ways the viewer doesn't */
const LIT_DECAL_KEYWORDS = new Set([
	'_COMPLETE_PBR',
	'_NORMAL_ANGLE_BLEND',
	'_BLEND_WATER_FLOW',
	'_BLEND_EMISSIVE',
	'_BLEND_SLUDGE_EROSION',
	'_BLEND_WETNESS',
]);

/** Unity's `ColorWriteMask` bits */
const WRITE_RED = 8;
const WRITE_GREEN = 4;
const WRITE_BLUE = 2;

/**
 * `HGRP/DecalLit`, the projected decals of the scenery (`docs/game-data/materials.md#decals`), written over
 * the surface through the colour masks the material sets (`_ColorMask1` metallic and occlusion, `_ColorMask2`
 * normal and roughness, `_ColorMask3` albedo)
 *
 * @param reader the material's properties; each placement's colour and UV transform are its instance row's
 * @returns its surface, `undrawn` when it changes nothing the viewer draws, or `unsupported`
 */
export const describeLitDecal = (
	reader: MaterialReader,
): LitDecalSurface | UndrawnSurface | UnsupportedSurface => {
	const { float, colorOrVector: color, has } = reader;
	const keywords = undrawnKeywords(reader, LIT_DECAL_KEYWORDS);
	if (keywords !== null) {
		return keywords;
	}
	const invisible: UndrawnSurface = { kind: 'undrawn', reason: 'writes nothing the viewer draws' };
	const waterFlow = has('_BLEND_WATER_FLOW');
	// the emission target's mask is fixed, so emissive decals always write it
	const emissive = !waterFlow && has('_BLEND_EMISSIVE');
	let sludge: LitDecalSurface['sludge'] = null;
	if (has('_BLEND_SLUDGE_EROSION')) {
		// the game compiles the sludge only alone or with the PBR map and the angle fade
		if (waterFlow || emissive) {
			return unsupported('_BLEND_SLUDGE_EROSION with a water flow or emission');
		}
		const texture = reader.slot('_SludgeDecalTex');
		if (texture === undefined) {
			return unsupported('no sludge texture');
		}
		sludge = {
			texture: texture.texture,
			scale: [...texture.scale],
			alphaScale: float('_SludgeDecalAlphaScale', 1),
			heightFalloff: float('_SludgeDecalHeightFalloff', 0),
		};
	}
	const relight = (float('_ColorMask3', 0) & WRITE_RED) === 0;
	let wetness: LitDecalSurface['wetness'] = null;
	if (has('_BLEND_WETNESS')) {
		// the game compiles the wetness only with the PBR map
		if (waterFlow || emissive || sludge !== null || has('_NORMAL_ANGLE_BLEND')) {
			return unsupported('_BLEND_WETNESS with a water flow, emission, sludge or an angle fade');
		}
		if (relight) {
			return unsupported('_BLEND_WETNESS without an albedo to darken');
		}
		wetness = float('_Wetness', 0);
	}
	const surfaceMask = float('_ColorMask2', 0);
	if (relight && !emissive && (surfaceMask & (WRITE_RED | WRITE_GREEN | WRITE_BLUE)) === 0) {
		return invisible;
	}
	const base = reader.slot('_BaseColorMap');
	if (base === undefined) {
		return unsupported('no base colour map');
	}
	const pbrBase = !waterFlow && float('_BaseTexChannel', 0) !== 0;
	let pbr: LitDecalSurface['pbr'] = null;
	if (waterFlow) {
		// the water's normal map projects at world positions; its `_ST` scale is per metre
		const water = reader.slot('_WaterNormalTex');
		if (water !== undefined) {
			pbr = { texture: water.texture, ownTransform: { scale: [...water.scale], offset: [0, 0] } };
		}
	} else {
		const map = pbrBase ? base : reader.slot('_SampleTex1');
		if (map !== undefined) {
			// its own `_ST` applies to the box's UVs only with `_SampleTex1UVSet`
			const own = !pbrBase && float('_SampleTex1UVSet', 0) !== 0;
			pbr = {
				texture: map.texture,
				ownTransform: own ? { scale: [...map.scale], offset: [...map.offset] } : null,
			};
		}
	}
	// a relit decal changes the surface only through the PBR map and its emission
	if (relight && pbr === null && !emissive) {
		return invisible;
	}
	const pbrMask = float('_ColorMask1', 0);
	const emission = color('_EmissiveColor') ?? [0, 0, 0, 1];
	return {
		kind: 'litDecal',
		base: base.texture,
		opacity: float('_DecalOpacity', 1),
		pbr,
		relight,
		roughness: [float('_RoughnessMin', 0), float('_RoughnessMax', 1)],
		normalScale: float('_NormalScale', 1),
		angleFade: has('_NORMAL_ANGLE_BLEND') ? Math.max(float('_AngleBlendFallOff', 1), 1e-3) : 0,
		writesNormal: pbr !== null && (surfaceMask & (WRITE_RED | WRITE_GREEN)) !== 0,
		writesRoughness: pbr !== null && (surfaceMask & WRITE_BLUE) !== 0,
		writesMetallic: (pbrMask & WRITE_RED) !== 0,
		writesOcclusion: (pbrMask & WRITE_GREEN) !== 0,
		blendSceneNormal: float('_BlendSceneNormal', 0),
		metallic: float('_Metallic', 0),
		occlusionStrength: float('_OcclusionStrength', 1),
		pbrBase,
		metallicChannel: float('_MetallicChannel', 0),
		occlusionChannel: float('_OcclusionChannel', 0),
		affectNormal: float('_AffectNormal', 0),
		waterFlow: waterFlow
			? {
					normalScale: float('_WaterNormalScale', 1),
					roughness: float('_WaterRoughness', 0),
					normalFactor: float('_NormalFactor', 0),
					movement: color('_UVMovement') ?? [0, 0, 1, 1],
					levelFade: Math.max(float('_AngleBlendFallOff2', 1), 1e-3),
				}
			: null,
		sludge,
		wetness,
		emission: emissive
			? {
					color: [emission[0], emission[1], emission[2]],
					channel: float('_EmissiveChannel', 0),
					albedoAffect: float('_AlbedoAffectEmissive', 1),
					ignorePostExposure: float('_IgnorePostExposure', 1),
				}
			: null,
	};
};
