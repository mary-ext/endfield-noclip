/**
 * the Lit model (`docs/game-data/materials.md`); its overlays, foliage inputs and sway are modules of their
 * own
 */

import type { TextureSlot } from '@endfield-noclip/package-format/materials';
import type {
	LitDetail,
	LitEmission,
	LitSurface,
	MaskChannel,
	UnsupportedSurface,
} from '@endfield-noclip/package-format/surfaces';
import type { Rgb } from '@endfield-noclip/package-format/values';

import { linearRgb, type MaterialReader, scaleRgb, unsupported } from '../material-values.ts';

import { grassInputsOf, leafInputsOf } from './foliage.ts';
import { layerOf, parallaxGlowOf } from './lit-overlays.ts';
import { swayOf } from './lit-sway.ts';

/** shaders whose G-buffer pass writes the material's `_StencilRef` into the stencil */
const STENCIL_REF_SHADERS = new Set([
	'HGRP/Lit',
	'HGRP/Foliage/Leaf',
	'HGRP/Foliage/Grass',
	'HGRP/Foliage/Trunk',
	'HGRP/Foliage/TreeFoliageCardMeshLod',
	'HGRP/Foliage/Grass Cardmesh Lod',
]);

/** the stencil bit `HGRP/DecalLit` draws only where clear */
const LIT_DECAL_STENCIL_BIT = 32;

const GRASS_CARD_SHADER = 'HGRP/Foliage/Grass Cardmesh Lod';

/** the tri-channel mask's properties per channel, R, G, B */
const MASK_CHANNELS = [
	{
		albedo: '_MaskAlbedoR',
		roughness: '_MaskRoghnessR',
		metallic: '_MaskMetallicR',
		scale: '_MaskRScale',
		offset: '_MaskROffset',
	},
	{
		albedo: '_MaskAlbedoG',
		roughness: '_MaskRoghnessG',
		metallic: '_MaskMetallicG',
		scale: '_MaskGScale',
		offset: '_MaskGOffset',
	},
	{
		albedo: '_MaskAlbedoB',
		roughness: '_MaskRoghnessB',
		metallic: '_MaskMetallicB',
		scale: '_MaskBScale',
		offset: '_MaskBOffset',
	},
] as const;

/** the leaf's reflectance, quantized to 3 bits as the GBuffer stores it, as F0 */
const reflectanceF0 = (reflectance: number): number =>
	0.08 * (0.5 + 0.75 * (Math.round(Math.min(Math.max(reflectance, 0), 1) * 7) / 7));

/**
 * the Lit model's shaders (`docs/game-data/materials.md`): the Lit families with their optional layers,
 * glass, HLODs and foliage
 *
 * @param reader the material's properties
 * @returns its surface, or `unsupported` for textures on UV sets the meshes don't carry
 */
export const describeLit = (reader: MaterialReader): LitSurface | UnsupportedSurface => {
	const { float, color, has, material, shader } = reader;
	const family = shader.family;
	// Lit's optional layers. LitEffect declares a subset of Lit's properties plus its dissolve and disturb
	// effects, which aren't drawn; trunks and glass share only the texture layout
	const lit = family === 'lit' || family === 'litEffect';
	const foliage = family === 'leaf' || family === 'grass' || family === 'cardMesh';
	const count = material.baseTextureMapCount;

	// the maps the material's layout and keywords sample; the geometry carries UV sets 0 and 1
	const used = new Map<string, TextureSlot>();
	const bound = (name: string, on = true): TextureSlot | null => {
		const slot = on ? reader.slot(name) : undefined;
		if (slot === undefined) {
			return null;
		}
		used.set(name, slot);
		return slot;
	};
	// HLOD normal maps aren't tangent-space maps the shader can read
	const base = bound('_BaseColorMap');
	const normal = bound('_NormalMap', family !== 'hlod');
	const mro = bound('_MROMap', count === 0);
	const emissiveMap = bound('_EmissiveMap', has('_EMISSIVE_MAP'));
	const triMask = bound('_MaskMap', lit && has('_TRI_CHANNEL_MASK'));
	const detailMap = bound('_DetailMap', lit && has('_DETAIL_MAP'));
	// a separate parallax mask texture (`_UseParallaxMask`) has no slot; such materials stay dark
	const parallax = lit && has('_PARALLAX_MAP') && float('_UseParallaxMask', 0) === 0;
	const pattern = bound('_ParallaxMap', parallax);
	const noise = bound('_ParallaxNoiseMap', parallax);
	for (const [name, slot] of used) {
		if (slot.uv > 1) {
			return unsupported(`${name} on UV set ${slot.uv}`);
		}
	}

	let layout: LitSurface['layout'] = 'plain';
	if (count === 0) {
		layout = 'mro';
	} else if (count !== null) {
		layout = 'twoBasemap';
	} else if (foliage) {
		layout = 'roughnessInB';
	}

	const tint = color('_BaseColor');
	const blend =
		material.blend === 'alphaBlend' || material.blend === 'premultiplied' ? material.blend : 'opaque';

	let emission: LitEmission | null = null;
	{
		const emissive = color('_EmissiveColor');
		const channel = float('_EmissiveMaskChannel', 0);
		let source: LitEmission['source'] | null = null;
		if (has('_EMISSIVE_MAP')) {
			source = emissiveMap === null ? null : 'map';
		} else if (has('_EMISSIVE_MASK') && channel > 0) {
			source = 'mask';
		}
		if (source !== null && emissive !== undefined) {
			// `_EMISSIVE_ANIM_SWEEP`'s band isn't drawn, so each colour keeps the share that glows outside it:
			// one minus its alpha (docs/game-data/materials.md#emission)
			const sweep = lit && has('_EMISSIVE_ANIM_SWEEP');
			const resting = (rgba: readonly [number, number, number, number], scale: number): Rgb =>
				scaleRgb(rgba, sweep ? scale * (1 - Math.min(Math.max(rgba[3], 0), 1)) : scale);
			// the map's G, B and A add colours of their own, scaled by `_EmissiveType` (0 leaves them out)
			let channels: LitEmission['channels'] = null;
			const type = float('_EmissiveType', 0);
			if (source === 'map' && type !== 0) {
				// HDR like `_EmissiveColor`: as stored
				const scaled = (name: string): Rgb => resting(color(name) ?? [0, 0, 0, 1], type);
				const added: [Rgb, Rgb, Rgb] = [
					scaled('_EmissiveColorG'),
					scaled('_EmissiveColorB'),
					scaled('_EmissiveColorA'),
				];
				if (added.some((rgb) => rgb.some((value) => value !== 0))) {
					channels = added;
				}
			}
			emission = {
				// HDR, authored linear: as stored
				color: resting(emissive, 1),
				source,
				maskChannel: channel,
				channels,
				albedoAffect: float('_AlbedoAffectEmissive', 1),
				ignorePostExposure: float('_IgnorePostExposure', 1),
				// `_EnableEmissiveAnimFlicker`'s noise isn't drawn: those emitters keep still
				pulse:
					lit && has('_EMISSIVE_ANIM') && float('_EnableEmissiveAnimFlicker', 0) <= 0.5
						? {
								// the phase is `_Time.x` (seconds / 20; docs/game-data/materials.md#clock) / 2π times the speed
								rate: float('_EmissiveAnimSpeed', 0) / (40 * Math.PI),
								phase: float('_EmissiveAnimRandom', 0),
								interval: float('_EmissiveAnimInterval', 1),
								minimum: float('_EmissiveMinBrightness', 0),
								depth: emissive[3],
							}
						: null,
			};
		}
	}

	let triChannel: LitSurface['triChannel'] = null;
	if (triMask !== null) {
		// the switch-texture variants take G and B from textures of their own, which have no slot: only R blends
		const switched = material.keywords.some((keyword) =>
			keyword.startsWith('_TRI_CHANNEL_MASK_SWITCH_TEXTURE'),
		);
		const channel = (i: number): MaskChannel => {
			const names = MASK_CHANNELS[i];
			const albedo = color(names.albedo) ?? [1, 1, 1, 0];
			return {
				albedo: linearRgb(albedo),
				strength: switched && i > 0 ? 0 : albedo[3],
				roughness: float(names.roughness, 1),
				metallic: float(names.metallic, 0),
				scale: float(names.scale, 0),
				offset: float(names.offset, 0),
			};
		};
		triChannel = { mask: triMask, channels: [channel(0), channel(1), channel(2)] };
	}

	let detail: LitDetail | null = null;
	if (detailMap !== null) {
		const overlay = color('_DetailOverlayColor') ?? [0, 0, 0, 0];
		detail = {
			texture: detailMap,
			mode: float('_DetailMode', 1),
			maskMode: float('_DetailMaskMode', 0),
			normalIntensity: float('_DetailNormalIntensity', 1),
			pbrIntensity: float('_DetailPBRIntensity', 0),
			fade: [float('_DetailFalloffStart', 0), float('_DetailFalloffEnd', 0)],
			brighterScale: float('_DetailBaseColorBrighterScale', 1),
			overlay: linearRgb(overlay),
			overlayCover: overlay[3],
		};
	}

	let overlay: LitSurface['overlay'] = null;
	// an empty noise slot reads as the shader's black default and still glows
	// (docs/game-data/materials.md#lit-layers). an empty pattern would glow in the dark colour alone; none is
	// seen
	if (pattern !== null) {
		overlay = parallaxGlowOf(reader, pattern, noise);
	} else if (lit && !parallax) {
		overlay = layerOf(reader);
	}

	let f0 = 0.08 * float('_Specular', 0.5);
	let transmission = foliage ? float('_Transmission', 0.2) : 0;
	let foliageInputs: LitSurface['foliage'] = null;
	if (family === 'leaf') {
		f0 = reflectanceF0(float('_Reflectance', 0));
		foliageInputs = leafInputsOf(reader);
	} else if (family === 'grass' || shader.name === GRASS_CARD_SHADER) {
		// both shaders write a reflectance of 4/7 and half the transmission
		f0 = reflectanceF0(4 / 7);
		transmission = 0.5 * float('_Transmission', 0.2);
		foliageInputs = grassInputsOf(reader, family === 'cardMesh');
	} else if (family === 'cardMesh') {
		foliageInputs = { kind: 'card' };
	}

	return {
		kind: 'lit',
		layout,
		metallicFromBaseAlpha: layout === 'twoBasemap' && count !== null && count < 1.5,
		textures: { base, normal, mro, emissive: emissiveMap },
		alphaClip: material.alphaClipThreshold,
		// `_AlphaMaskChannel` picks the alpha the Lit family tests: 0 the base colour's, 1 the normal map's
		alphaFromNormal: count !== null && float('_AlphaMaskChannel', 0) === 1,
		blend,
		opacity: tint?.[3] ?? 1,
		// the HLOD shader ignores the tint
		tint: tint === undefined || family === 'hlod' ? [1, 1, 1] : linearRgb(tint),
		// untextured: the tint alone
		tintCover: base === null ? 1 : float('_BaseColorTintCover', 0),
		brighterScale: float('_BaseColorBrighterScale', 1),
		roughness: [float('_RoughnessMin', 0), float('_RoughnessMax', 1)],
		metallic: float('_Metallic', 0),
		normalScale: float('_NormalScale', 1),
		occlusionStrength: float('_OcclusionStrength', 1),
		f0,
		transmission,
		emission,
		triChannel,
		detail,
		overlay,
		foliage: foliageInputs,
		sway: shader.name === 'HGRP/Lit' ? swayOf(reader) : null,
		keepsLitDecalsOff:
			STENCIL_REF_SHADERS.has(shader.name) && (float('_StencilRef', 0) & LIT_DECAL_STENCIL_BIT) !== 0,
	};
};
