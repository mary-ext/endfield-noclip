import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TextureSlot } from '@endfield-noclip/package-format/materials';

import { LookFlags, LookRow, UV1_SHIFT } from './look.ts';
import { materialLooks } from './material-looks.ts';
import { DitherFlags, DitherRow, ErosionRow } from './special-looks.ts';
import { described } from './test-materials.ts';

test('matte paintings are unlit, cast no shadows and test the texture alpha against their threshold', () => {
	const entry = described({
		kind: 'mattePainting',
		texture: { texture: 7, uv: 0, scale: [1, 1], offset: [0, 0] },
		color: [2, 2, 2],
		alphaClip: 0.2,
		highlight: { threshold: 1, intensity: 4 },
		ignorePostExposure: 1,
	});
	const [look] = materialLooks({ entries: [entry] });
	assert.equal(look.castsShadows, false);
	assert.equal(look.queue, 'cutout');
	assert.equal(look.textures[0], 7);
	assert.deepEqual(Array.from(look.params.subarray(0, 4)), [2, 2, 2, Math.fround(0.2)]);
	assert.deepEqual(Array.from(look.params.subarray(LookRow.surface, LookRow.surface + 2)), [1, 4]);
});

test('dithered effects shade as opaque shadowless surfaces, or unlit, and dither through the normal slot by a red alpha', () => {
	const main = { texture: 6, uv: 0, scale: [2, 2] as [number, number], offset: [0, 0] as [number, number] };
	const [rock, spot, mask] = materialLooks({
		entries: [
			described(
				{
					kind: 'dithered',
					baseMap: { ...main, texture: 3, scale: [4, 4] },
					normalMap: { ...main, texture: 5, scale: [1, 1] },
					color: [10, 2.14, 0],
					dither: null,
					lighting: { roughness: 1, metallic: 0, normalScale: 1.5, subsurface: null },
					ignorePostExposure: 1,
				},
				'none',
			),
			described({
				kind: 'dithered',
				baseMap: main,
				normalMap: null,
				color: [0.2, 0.2, 0.2],
				dither: {
					texture: main,
					redAlpha: false,
					alphaScale: 0.75,
					exponent: 1,
					tiling: 1,
					vertexAlpha: false,
					near: null,
					mask: null,
				},
				lighting: null,
				ignorePostExposure: 1,
			}),
			described({
				kind: 'dithered',
				baseMap: null,
				normalMap: null,
				color: [0.2, 0.2, 0.2],
				dither: {
					texture: main,
					redAlpha: true,
					alphaScale: 0.5,
					exponent: 14,
					tiling: 0.1,
					vertexAlpha: false,
					near: null,
					mask: null,
				},
				lighting: null,
				ignorePostExposure: 1,
			}),
		],
	});
	assert.deepEqual([rock.queue, rock.castsShadows, rock.cull], ['opaque', false, 'none']);
	assert.deepEqual(rock.textures.slice(0, 3), [3, 5, null]);
	assert.equal(rock.flags, LookFlags.BaseMap | LookFlags.NormalMap | LookFlags.NormalRag);
	assert.deepEqual(Array.from(rock.params.subarray(LookRow.surface, LookRow.surface + 4)), [1, 1, 0, 1.5]);
	assert.deepEqual(Array.from(rock.params.subarray(LookRow.uv, LookRow.uv + 4)), [4, 4, 0, 0]);
	assert.equal(spot.queue, 'cutout');
	assert.notEqual(spot.flags & LookFlags.Unlit, 0);
	assert.equal(spot.params[LookRow.tint + 3], -1);
	assert.deepEqual(Array.from(spot.params.subarray(DitherRow.dither, DitherRow.dither + 4)), [0.75, 1, 1, 0]);
	assert.deepEqual(mask.textures.slice(0, 2), [null, 6]);
	assert.equal(mask.flags & (LookFlags.BaseMap | LookFlags.AlphaNormal), LookFlags.AlphaNormal);
	assert.deepEqual(Array.from(mask.params.subarray(LookRow.uv + 4, LookRow.uv + 8)), [2, 2, 0, 0]);
	assert.deepEqual(Array.from(mask.params.subarray(DitherRow.dither, DitherRow.dither + 4)), [
		0.5,
		14,
		Math.fround(0.1),
		1,
	]);
});

test('lit dithered effects with a red alpha dither through the base slot and take their albedo from the tint', () => {
	// a waterfall splash sheet (`M_fx_map_common_waterdecal_splashes_2504_01`)
	const main = { texture: 8, uv: 0, scale: [1, 1] as [number, number], offset: [0, 0] as [number, number] };
	const [splash] = materialLooks({
		entries: [
			described(
				{
					kind: 'dithered',
					baseMap: null,
					normalMap: { ...main, texture: 9 },
					color: [50, 50, 50],
					// its particles fade by their colour's alpha and with the camera's distance
					dither: {
						texture: main,
						redAlpha: true,
						alphaScale: 2,
						exponent: 2,
						tiling: 1,
						vertexAlpha: true,
						near: [1, 2, 120, 80],
						mask: null,
					},
					lighting: { roughness: 0.5, metallic: 0.8, normalScale: 1, subsurface: null },
					ignorePostExposure: 1,
				},
				'none',
			),
		],
	});
	assert.equal(splash.params[LookRow.surface + 2], Math.fround(0.8));
	assert.deepEqual(
		Array.from(splash.params.subarray(DitherRow.subsurface, DitherRow.subsurface + 4)),
		[0, 0, 0, 0],
	);
	assert.equal(splash.queue, 'cutout');
	assert.deepEqual(splash.textures.slice(0, 2), [8, 9]);
	assert.equal(splash.flags & LookFlags.AlphaNormal, 0);
	// the saturated tint covers the base map's colour (`emissive.w`)
	assert.deepEqual(Array.from(splash.params.subarray(LookRow.tint, LookRow.tint + 4)), [1, 1, 1, -1]);
	assert.equal(splash.params[LookRow.emissive + 3], 1);
	assert.equal(splash.params[DitherRow.dither + 3], DitherFlags.RedAlpha | DitherFlags.VertexAlpha);
	assert.deepEqual(Array.from(splash.params.subarray(DitherRow.near, DitherRow.near + 4)), [1, 2, 120, 80]);
});

test('a dithered surface tests its mask from the noise slot, which its shading never reads', () => {
	// the reeds Qingbo's wind blows about (`M_fx_map_common_bigwind_reed_01`)
	const slot = (texture: number): TextureSlot => ({ texture, uv: 0, scale: [1, 1], offset: [0, 0] });
	const [reed] = materialLooks({
		entries: [
			described(
				{
					kind: 'dithered',
					baseMap: slot(10),
					normalMap: slot(12),
					color: [2, 2, 2],
					dither: {
						texture: slot(10),
						redAlpha: false,
						alphaScale: 2,
						exponent: 1,
						tiling: 1,
						vertexAlpha: true,
						near: null,
						mask: { texture: { ...slot(11), scale: [3, 2] }, redAlpha: true },
					},
					lighting: { roughness: 1, metallic: 0, normalScale: 1, subsurface: null },
					ignorePostExposure: 1,
				},
				'none',
			),
		],
	});
	assert.equal(reed.queue, 'cutout');
	assert.deepEqual(reed.textures, [10, 12, null, null, null, null, 11]);
	// no slot flag, so the surface's shading doesn't take it for a vertex offset's or a layer's texture
	assert.equal(reed.flags & LookFlags.ParallaxNoiseMap, 0);
	assert.equal(
		reed.params[DitherRow.dither + 3],
		DitherFlags.VertexAlpha | DitherFlags.Mask | DitherFlags.MaskRed,
	);
	assert.deepEqual(Array.from(reed.params.subarray(LookRow.uv + 24, LookRow.uv + 28)), [3, 2, 0, 0]);
});

test('a lit dithered surface without a base map tests its texture from the base slot, coloured by the tint', () => {
	// a lone mask tested by its alpha, as Yinglung Pass's camphor leaves are by their mask's red
	const slot = (texture: number): TextureSlot => ({ texture, uv: 0, scale: [1, 1], offset: [0, 0] });
	const [leaf] = materialLooks({
		entries: [
			described(
				{
					kind: 'dithered',
					baseMap: null,
					normalMap: slot(12),
					color: [4.7, 4.7, 4.7],
					dither: {
						texture: slot(11),
						redAlpha: false,
						alphaScale: 1,
						exponent: 15,
						tiling: 15,
						vertexAlpha: true,
						near: null,
						mask: null,
					},
					lighting: { roughness: 1, metallic: 0.5, normalScale: 1.5, subsurface: null },
					ignorePostExposure: 1,
				},
				'none',
			),
		],
	});
	assert.equal(leaf.queue, 'cutout');
	assert.deepEqual(leaf.textures.slice(0, 2), [11, 12]);
	assert.equal(leaf.flags & LookFlags.AlphaNormal, 0);
	// the tested texture doesn't colour the surface
	assert.deepEqual(Array.from(leaf.params.subarray(LookRow.tint, LookRow.tint + 4)), [1, 1, 1, -1]);
	assert.equal(leaf.params[LookRow.emissive + 3], 1);
	assert.equal(leaf.params[DitherRow.dither + 3], DitherFlags.VertexAlpha);
});

test('dithered effects with subsurface lighting scatter by their metallic and are never metals', () => {
	const splash = (metallic: number) =>
		materialLooks({
			entries: [
				described({
					kind: 'dithered',
					baseMap: null,
					normalMap: null,
					color: [1, 1, 1],
					dither: null,
					// a half-saturated green at half value, a quarter of it into the ambient light
					lighting: { roughness: 0.5, metallic, normalScale: 1, subsurface: [1 / 3, 0.5, 0.5, 0.25] },
					ignorePostExposure: 1,
				}),
			],
		})[0];
	const scattering = splash(0.5);
	assert.equal(scattering.params[LookRow.surface + 2], 0);
	assert.deepEqual(
		Array.from(scattering.params.subarray(DitherRow.subsurface, DitherRow.subsurface + 4)),
		[0.125, 0.25, 0.125, 0.25],
	);
	assert.equal(scattering.params[DitherRow.subsurfaceIndirect], 0.25);
	// Wuling City's dam splashes (`M_fxmap_water_citywaterfall_820`) have no metallic, so nothing scatters
	const plain = splash(0);
	assert.deepEqual(
		Array.from(plain.params.subarray(DitherRow.subsurface, DitherRow.subsurface + 4)),
		[0, 0, 0, 0],
	);
});

test('erosion rock: its maps tile by their own scales on UV set 0, the ramp streams whole', () => {
	const tiled = (texture: number, tiling: number): TextureSlot => ({
		texture,
		uv: 0,
		scale: [tiling, tiling],
		offset: [0, 0],
	});
	const entry = described({
		kind: 'erosion',
		textures: {
			baseNormal: tiled(1, 1),
			metalMix: tiled(2, 1),
			flowRamp: tiled(3, 1),
			detailNormal: tiled(4, 5),
			noisePattern: tiled(5, 3),
		},
		baseColor: [0.214, 0.214, 0.214],
		roughness: 0,
		detailRoughnessCover: 0,
		metallic: 0,
		metallicOffset: 0,
		metallicColor: [1, 1, 1],
		normalScale: 1,
		detailNormalScale: 1,
		occlusionStrength: 1,
		f0: 0.04,
		noise: { depth: 0, tint: [1, 1, 1], alphaTint: [1, 1, 1], min: 0, emissiveStrength: 0, fadeDistance: 1 },
		flow: {
			tiling: 0,
			noiseStrength: 0,
			scroll: 0.05,
			speedOffset: 0,
			colorOffset: 0,
			top: [1, 1, 1],
			bottom: [4, 4, 4],
			colorStrength: 0,
			emissiveStrength: 0,
			roughness: 0,
		},
	});
	const [look] = materialLooks({ entries: [entry] });
	assert.deepEqual(look.textures, [null, 1, 2, 3, 4, 5, 5]);
	assert.equal(look.flags & (0x7f << UV1_SHIFT), 0);
	assert.notEqual(look.flags & LookFlags.Erosion, 0);
	assert.equal(look.uvScales[3], 0);
	const uv = (index: number) =>
		Array.from(look.params.subarray(LookRow.uv + index * 4, LookRow.uv + index * 4 + 4));
	assert.deepEqual(
		[uv(1), uv(4), uv(5), uv(6)],
		[
			[1, 1, 0, 0],
			[5, 5, 0, 0],
			[3, 3, 0, 0],
			[1, 1, 0, 0],
		],
	);
	assert.ok(Math.abs(look.params[ErosionRow.base] - 0.214) < 1e-3);
	assert.deepEqual(
		Array.from(look.params.subarray(ErosionRow.flowBottom, ErosionRow.flowBottom + 3)),
		[4, 4, 4],
	);
	assert.equal(look.params[ErosionRow.flow + 2], Math.fround(0.05));
});
