import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TextureSlot } from '@endfield-noclip/package-format/materials';
import type {
	LitLayer,
	LitSurface,
	LitVertexOffset,
	MaskChannel,
} from '@endfield-noclip/package-format/surfaces';

import {
	EmissivePulseRow,
	LayerBlendRow,
	LayerSource,
	LeafBlendRow,
	SwayRow,
	TRI_CHANNEL_IN_EMISSIVE_SLOT,
	TrunkRow,
	VertexOffsetRow,
} from './lit-look.ts';
import { GAPS_FLOAT, LookFlags, LookRow, UV1_SHIFT } from './look.ts';
import { materialLooks } from './material-looks.ts';
import { described } from './test-materials.ts';

test('glass is transparent and shadowless with its blending flag', () => {
	const [blended, premultiplied] = materialLooks({
		entries: [
			described(litSurface({ blend: 'alphaBlend', opacity: 0.5, alphaClip: 0.5, alphaFromNormal: true })),
			described(litSurface({ blend: 'premultiplied' })),
		],
	});
	assert.deepEqual(
		[blended.queue, blended.castsShadows, blended.params[LookRow.detail2 + 2]],
		['transparent', false, 0],
	);
	assert.equal(blended.params[LookRow.emissive2 + 3], 0.5);
	assert.notEqual(blended.flags & LookFlags.AlphaNormal, 0);
	assert.deepEqual([premultiplied.queue, premultiplied.params[LookRow.detail2 + 2]], ['transparent', 1]);
});

/** a two-basemap Lit surface with no optional parts */
const litSurface = (overrides: Partial<LitSurface> = {}): LitSurface => ({
	kind: 'lit',
	layout: 'twoBasemap',
	metallicFromBaseAlpha: false,
	textures: { base: null, normal: null, mro: null, emissive: null },
	alphaClip: null,
	alphaFromNormal: false,
	blend: 'opaque',
	opacity: 1,
	tint: [1, 1, 1],
	tintCover: 0,
	brighterScale: 1,
	roughness: [0, 1],
	metallic: 0,
	normalScale: 1,
	occlusionStrength: 1,
	f0: 0.04,
	transmission: 0,
	emission: null,
	triChannel: null,
	detail: null,
	overlay: null,
	foliage: null,
	trunk: null,
	sway: null,
	vertexOffset: null,
	keepsLitDecalsOff: false,
	...overrides,
});

test('a swaying Lit surface keeps its sway in the sway rows', () => {
	// M_prop_map02_kite+1_001_01a: a kite swinging along its own direction, and a wave along the wind's
	const [look, wind] = materialLooks({
		entries: [
			described(
				litSurface({
					sway: { intensity: 1.5, frequency: 7.4, softness: 0.12, kite: 1, tendency: 0, direction: [1, 0] },
				}),
			),
			described(
				litSurface({
					sway: { intensity: 1, frequency: 1, softness: 0, kite: 0, tendency: 0.5, direction: null },
				}),
			),
		],
	});
	assert.deepEqual(
		[...look.params.subarray(SwayRow.sway, SwayRow.sway + 4)],
		[1.5, 7.4, 0.12, 1].map(Math.fround),
	);
	assert.deepEqual([...look.params.subarray(SwayRow.direction, SwayRow.direction + 4)], [0, 1, 1, 0]);
	assert.deepEqual([...wind.params.subarray(SwayRow.direction, SwayRow.direction + 4)], [0.5, 0, 0, 0]);
});

test('a vertex offset takes the parallax slots and rows of an alpha-tested Lit surface', () => {
	// M_cloth_map02_sfcanvas+1_001_01a: ribbons flapping along the world's axes, masked towards their tops
	const slot = (texture: number): TextureSlot => ({ texture, uv: 0, scale: [1, 1], offset: [0, 0] });
	const vertexOffset: LitVertexOffset = {
		texture: { texture: 13, uv: 1, scale: [1, 1.3], offset: [0, 0] },
		scroll: [-1, -2],
		direction: [2, 2, 2],
		space: 'world',
		intensity: 0.4,
		bias: 0,
		vertexAlphaWeight: false,
		mask: { texture: { texture: 14, uv: 1, scale: [1, 1], offset: [0, 1] }, scroll: [0, 0], strength: 1 },
	};
	const ribbon = {
		textures: { base: slot(1), normal: slot(2), mro: null, emissive: null },
		alphaClip: 0.5,
		alphaFromNormal: true,
		vertexOffset,
	};
	const [look, unmasked, object, opaque, normal, layered] = materialLooks({
		entries: [
			described(litSurface(ribbon)),
			described(litSurface({ ...ribbon, vertexOffset: { ...vertexOffset, mask: null } })),
			described(
				litSurface({
					...ribbon,
					vertexOffset: { ...vertexOffset, space: 'object', vertexAlphaWeight: true },
				}),
			),
			// only alpha-tested draws read the UV sets and textures in their depth passes
			described(litSurface({ ...ribbon, alphaClip: null })),
			described(litSurface({ ...ribbon, vertexOffset: { ...vertexOffset, space: 'normal' } })),
			described(litSurface({ ...ribbon, overlay: topLayer() })),
		],
	});
	const row = (params: Float32Array, at: number) => Array.from(params.subarray(at, at + 4));
	const offsetFlags =
		LookFlags.VertexOffset |
		LookFlags.ParallaxMap |
		LookFlags.ParallaxNoiseMap |
		(1 << (UV1_SHIFT + 5)) |
		(1 << (UV1_SHIFT + 6));
	assert.equal(look.queue, 'cutout');
	assert.equal(look.flags & offsetFlags, offsetFlags);
	assert.deepEqual(look.textures.slice(5), [13, 14]);
	assert.deepEqual(row(look.params, LookRow.uv + 5 * 4), [1, 1.3, 0, 0].map(Math.fround));
	assert.deepEqual(row(look.params, LookRow.uv + 6 * 4), [1, 1, 0, 1]);
	assert.deepEqual(row(look.params, VertexOffsetRow.direction), [2, 2, 2, 1]);
	assert.deepEqual(row(look.params, VertexOffsetRow.shape), [0.4, 0, 0, 1].map(Math.fround));
	assert.deepEqual(row(look.params, VertexOffsetRow.scroll), [-1, -2, 0, 0]);

	assert.deepEqual(unmasked.textures.slice(5), [13, null]);
	assert.equal(unmasked.flags & LookFlags.ParallaxNoiseMap, 0);
	assert.equal(unmasked.params[VertexOffsetRow.shape + 3], 0);
	assert.equal(object.params[VertexOffsetRow.direction + 3], 0);
	assert.equal(object.params[VertexOffsetRow.shape + 2], 1);
	for (const still of [opaque, normal, layered]) {
		assert.equal(still.flags & LookFlags.VertexOffset, 0);
		assert.ok(!still.textures.includes(13));
	}
	assert.notEqual(layered.flags & LookFlags.LayerBlend, 0);
});

test('pulsing emission takes the free parallax rows; a surface with a glow keeps its emission still', () => {
	const slot = (texture: number): TextureSlot => ({ texture, uv: 0, scale: [1, 1], offset: [0, 0] });
	const emission = {
		color: [23.97, 23.97, 23.97] as [number, number, number],
		source: 'map' as const,
		maskChannel: 0,
		channels: null,
		albedoAffect: 1,
		ignorePostExposure: 1,
		albedoTint: null,
		pulse: { rate: 1 / Math.PI, phase: 0, interval: 1, minimum: 0, depth: 1 },
	};
	const glow = {
		kind: 'parallax' as const,
		pattern: { ...slot(6), scale: [2, 2] as [number, number] },
		noise: { ...slot(7), scale: [3, 3] as [number, number] },
		depth: 0.314,
		steps: 3,
		fresnelPower: 1,
		pulseRate: 0,
		pulsePhasePerMetre: 0,
		pulseMinimum: 0.2,
		bright: [2.8, 0.7, 0] as [number, number, number],
		dark: [0, 0, 0] as [number, number, number],
		maskChannel: 2,
		ignorePostExposure: 1,
		near: { outer: 25, inner: 3, strength: 20 },
	};
	const textures = { base: slot(1), normal: null, mro: null, emissive: slot(2) };
	const [pulsing, glowing, flat] = materialLooks({
		entries: [
			described(litSurface({ textures, emission })),
			described(litSurface({ textures, emission, overlay: glow })),
			described(litSurface({ textures, emission, overlay: { ...glow, noise: null } })),
		],
	});
	// without a noise map only the pattern binds, and the march reads height 0
	assert.equal(flat.flags & (LookFlags.ParallaxMap | LookFlags.ParallaxNoiseMap), LookFlags.ParallaxMap);
	assert.equal(flat.textures[5], 6);
	const pulse = Array.from(pulsing.params.subarray(EmissivePulseRow.pulse, EmissivePulseRow.pulse + 4));
	assert.deepEqual(pulse, [1 / Math.PI, 0, 1, 0].map(Math.fround));
	assert.equal(pulsing.params[EmissivePulseRow.strength], 1);
	assert.deepEqual(
		Array.from(pulsing.params.subarray(LookRow.emissive, LookRow.emissive + 3)),
		[23.97, 23.97, 23.97].map(Math.fround),
	);
	assert.equal(pulsing.flags & (LookFlags.ParallaxMap | LookFlags.LayerBlend), 0);
	// the glow's rows: three steps, a pulse between 0.2 and 1, the HDR colour as stored
	const row = (at: number) => Array.from(glowing.params.subarray(at, at + 4));
	assert.deepEqual(glowing.textures.slice(5), [6, 7]);
	assert.deepEqual(row(LookRow.uv + 5 * 4), [2, 2, 0, 0]);
	assert.deepEqual(row(LookRow.uv + 6 * 4), [3, 3, 0, 0]);
	assert.deepEqual(row(LookRow.parallax), [0.314, 3, 1, 0.4].map(Math.fround));
	assert.equal(glowing.params[LookRow.parallax2 + 3], Math.fround(0.6));
	assert.deepEqual(row(LookRow.parallaxColor), [2.8, 0.7, 0, 2].map(Math.fround));
	assert.deepEqual(row(LookRow.parallaxBright).slice(0, 3), [25, 3, 20]);
});

test("the emissive map's G, B and A colours take the rows effect looks keep for themselves", () => {
	const slot = (texture: number): TextureSlot => ({ texture, uv: 0, scale: [1, 1], offset: [0, 0] });
	// M_fx_base01_lv001_ship_line_1123, the stripe ring round Dijiang's shaft cargo
	const [ring] = materialLooks({
		entries: [
			described(
				litSurface({
					textures: { base: null, normal: null, mro: null, emissive: slot(1) },
					emission: {
						color: [1, 0, 0],
						source: 'map',
						maskChannel: 0,
						channels: [
							[0, 1, 0],
							[0, 0, 1],
							[0, 0, 0],
						],
						albedoAffect: 1,
						ignorePostExposure: 1,
						albedoTint: null,
						pulse: null,
					},
				}),
			),
		],
	});
	const rows = [0, 1, 2].map((i) =>
		Array.from(ring.params.subarray(LookRow.emissiveChannels + i * 4, LookRow.emissiveChannels + i * 4 + 3)),
	);
	assert.deepEqual(rows, [
		[0, 1, 0],
		[0, 0, 1],
		[0, 0, 0],
	]);
});

test('a per-draw albedo tint takes its own row; without one the row tints nothing', () => {
	const slot = (texture: number): TextureSlot => ({ texture, uv: 0, scale: [1, 1], offset: [0, 0] });
	const emission = {
		color: [1.11, 1.84, 1.59] as [number, number, number],
		source: 'mask' as const,
		maskChannel: 3,
		channels: null,
		albedoAffect: 0,
		ignorePostExposure: 1,
		pulse: null,
	};
	const textures = { base: slot(1), normal: null, mro: null, emissive: null };
	// a water hydrant's lamps under IntEmissiveConfig_Disabled_Wuling
	const [tinted, plain] = materialLooks({
		entries: [
			described(
				litSurface({
					textures,
					emission: { ...emission, albedoTint: { color: [0.15, 0.25, 0.27], weight: 1 } },
				}),
			),
			described(litSurface({ textures, emission: { ...emission, albedoTint: null } })),
		],
	});
	const row = (look: typeof tinted) =>
		Array.from(
			look.params.subarray(LookRow.emissiveAlbedo, LookRow.emissiveAlbedo + 4),
			(v) => Math.round(v * 100) / 100,
		);
	assert.deepEqual(row(tinted), [0.15, 0.25, 0.27, 1]);
	assert.deepEqual(row(plain), [0, 0, 0, 0]);
});

test('Lit slots: UV set 1 maps, the tri-channel mask in the mask slot or under an MRO map the emissive one, detail', () => {
	const slot = (texture: number, uv = 0, scale = 1): TextureSlot => ({
		texture,
		uv,
		scale: [scale, scale],
		offset: [0, 0],
	});
	const channel = (strength: number): MaskChannel => ({
		albedo: [1, 0.214, 0],
		strength,
		roughness: 1,
		metallic: 0,
		scale: 0,
		offset: 0,
	});
	const triChannel: LitSurface['triChannel'] = {
		mask: slot(4),
		channels: [channel(0.5), channel(0), channel(0)],
	};
	const detail = {
		texture: slot(5, 1, 5),
		mode: 1,
		maskMode: 0,
		normalIntensity: 1,
		pbrIntensity: 0,
		fade: [0, 0] as [number, number],
		brighterScale: 1,
		overlay: [0, 0, 0] as [number, number, number],
		overlayCover: 0,
	};
	const textures = { base: slot(1, 1, 5), normal: slot(2), mro: null, emissive: null };
	const mroTextures = { ...textures, mro: slot(3) };
	const [crystal, mro, glowing] = materialLooks({
		entries: [
			described(litSurface({ textures, triChannel, detail })),
			// M_cloth_map02_sfcanvas+1_001_01: a banner's emblem, masked over UV set 1
			described(
				litSurface({
					layout: 'mro',
					textures: mroTextures,
					triChannel: { ...triChannel, mask: slot(4, 1) },
				}),
			),
			{
				...described(
					litSurface({ layout: 'mro', textures: { ...mroTextures, emissive: slot(6) }, triChannel }),
				),
				gaps: ['_TERRAIN_BLEND'],
			},
		],
	});
	assert.deepEqual(crystal.textures, [1, 2, 4, null, 5, null, null]);
	assert.notEqual(crystal.flags & LookFlags.TriChannelMask, 0);
	assert.notEqual(crystal.flags & LookFlags.NormalOcclusion, 0);
	// base and detail sample UV set 1
	assert.equal((crystal.flags >> UV1_SHIFT) & 0x7f, 0b10001);
	const row = (at: number) => Array.from(crystal.params.subarray(at, at + 4));
	assert.deepEqual(row(LookRow.maskAlbedo), [1, 0.214, 0, 0.5].map(Math.fround));
	assert.equal(crystal.params[LookRow.maskAlbedo + 4 + 3], 0);
	assert.equal(crystal.params[TRI_CHANNEL_IN_EMISSIVE_SLOT], 0);
	// the MRO map takes the mask slot, so the tri-channel mask moves to the emissive slot
	assert.deepEqual(mro.textures, [1, 2, 3, 4, null, null, null]);
	assert.notEqual(mro.flags & LookFlags.TriChannelMask, 0);
	assert.equal(mro.params[TRI_CHANNEL_IN_EMISSIVE_SLOT], 1);
	assert.equal((mro.flags >> UV1_SHIFT) & 0x7f, 0b01001);
	assert.notEqual(mro.flags & LookFlags.NormalRag, 0);
	// an emissive map keeps its slot, and the mask isn't drawn
	assert.deepEqual(glowing.textures, [1, 2, 3, 6, null, null, null]);
	assert.equal(glowing.flags & LookFlags.TriChannelMask, 0);
	assert.equal(glowing.params[TRI_CHANNEL_IN_EMISSIVE_SLOT], 0);
	// which the gaps view shows, after what the package says the surface leaves out
	assert.deepEqual(glowing.gaps, ['_TERRAIN_BLEND', 'tri-channel mask: no free slot']);
	assert.equal(glowing.params[GAPS_FLOAT], 1);
	assert.deepEqual([mro.gaps, mro.params[GAPS_FLOAT]], [[], 0]);
});

/** a layer map, tiled and offset by the layer's own values */
const layerMap = (texture: number): TextureSlot => ({ texture, uv: 0, scale: [2, 2], offset: [0.25, 0.5] });

/** a top layer with no moss */
const topLayer = (overrides: Partial<LitLayer> = {}): LitLayer => ({
	kind: 'layer',
	base: layerMap(2),
	bump: layerMap(3),
	uvType: 'uv2',
	coverage: { kind: 'top' },
	top: { bumped: 0, threshold: -1, smoothness: 0.5 },
	heightTransition: 0.056,
	tint: [2, 0.42808229, 0],
	saturation: 0.75,
	colorBlendMode: 0,
	additiveIntensity: 1,
	metallicFromAlpha: false,
	metallic: 0,
	bumpScale: 1,
	baseNormalIntensity: 0,
	occlusionFromBump: true,
	aoStrength: 1,
	moss: null,
	...overrides,
});

test('moss rock: the top layer takes the parallax slots and rows, its own tiling and the default grey height', () => {
	const normal: TextureSlot = { texture: 1, uv: 0, scale: [1, 1], offset: [0, 0] };
	const [look] = materialLooks({
		entries: [
			described(
				litSurface({ textures: { base: null, normal, mro: null, emissive: null }, overlay: topLayer() }),
			),
		],
	});
	assert.deepEqual(look.textures, [null, 1, null, null, null, 2, 3]);
	assert.notEqual(look.flags & LookFlags.LayerBlend, 0);
	const row = (at: number) => Array.from(look.params.subarray(at, at + 4));
	assert.deepEqual(row(LookRow.uv + 5 * 4), [2, 2, 0.25, 0.5]);
	assert.deepEqual(row(LookRow.uv + 6 * 4), [2, 2, 0.25, 0.5]);
	assert.deepEqual(row(LayerBlendRow.coverage), [0, -1, 0.5, 2]);
	assert.deepEqual(row(LayerBlendRow.height), [1, Math.fround(0.056), 0.5, LayerSource.Top]);
	// the tint linearized, times the brighter scale; saturation 1 − 0.25
	assert.deepEqual(row(LayerBlendRow.color), [2, 0.42808229, 0, 0.75].map(Math.fround));
	// no moss: the fuzzy shading is neutral
	assert.deepEqual(row(LayerBlendRow.fuzzy), [0, 0, 1, 0]);
	assert.deepEqual(row(LayerBlendRow.fuzzy2), [0, 1, 1, 0]);
});

test('moss mounds: the mask layer takes its mask map into the emissive slot, untiled on its UV set, and shades as moss', () => {
	const base: TextureSlot = { texture: 0, uv: 0, scale: [3, 3], offset: [0, 0] };
	const emissive: TextureSlot = { texture: 5, uv: 0, scale: [3, 3], offset: [0, 0] };
	const moss = {
		coreDarkness: 0.2,
		edgeBrightness: 0,
		edgeShadowRange: 0.01,
		edgeShadowOffset: 0,
		edgeShadowIntensity: 0,
		darkPower: 0.1,
		brightPower: 6,
		normalStrength: 0,
	};
	const maskLayer = topLayer({
		coverage: { kind: 'maskMap', map: { texture: 4, uv: 1, scale: [1, 1], offset: [0, 0] } },
		moss,
	});
	const [mound, channel, emissiveMapped] = materialLooks({
		entries: [
			described(
				litSurface({ textures: { base, normal: null, mro: null, emissive: null }, overlay: maskLayer }),
			),
			described(litSurface({ overlay: topLayer({ coverage: { kind: 'baseAlpha' } }) })),
			// an emissive map leaves no slot for the mask map
			described(litSurface({ textures: { base, normal: null, mro: null, emissive }, overlay: maskLayer })),
		],
	});
	assert.deepEqual(mound.textures, [0, null, null, 4, null, 2, 3]);
	assert.notEqual(mound.flags & LookFlags.LayerBlend, 0);
	assert.notEqual(mound.flags & LookFlags.EmissiveMap, 0);
	assert.notEqual(mound.flags & (1 << (UV1_SHIFT + 3)), 0);
	const row = (at: number) => Array.from(mound.params.subarray(at, at + 4));
	assert.deepEqual(row(LookRow.uv + 3 * 4), [1, 1, 0, 0]);
	assert.equal(row(LayerBlendRow.height)[3], LayerSource.MaskMap);
	assert.deepEqual(row(LayerBlendRow.fuzzy), [0.2, 0, 0.01, 0].map(Math.fround));
	assert.deepEqual(row(LayerBlendRow.fuzzy2), [0, 0.1, 6, 0].map(Math.fround));
	assert.equal(channel.params[LayerBlendRow.height + 3], LayerSource.BaseAlpha);
	assert.equal(channel.textures[3], null);
	assert.equal(emissiveMapped.flags & LookFlags.LayerBlend, 0);
	assert.deepEqual(emissiveMapped.textures.slice(3), [5, null, null, null]);
});

test("a trunk's vertex AO and ramp fill the rows leaves keep their canopy ramp in", () => {
	// the Jingyu arch tree's bark has no ramp; the second trunk has one
	const [bark, ramped, plain] = materialLooks({
		entries: [
			described(litSurface({ layout: 'mro', trunk: { vertexAo: 0.9, ramp: null } })),
			described(
				litSurface({
					layout: 'mro',
					trunk: {
						vertexAo: 1,
						ramp: { color: [0.5, 0.25, 0.125], intensity: 0.75, range: 0.2, transition: 0.1 },
					},
				}),
			),
			described(litSurface({ layout: 'mro' })),
		],
	});
	const row = (look: typeof bark, at: number) => Array.from(look.params.subarray(at, at + 4));
	assert.deepEqual(row(bark, TrunkRow.shape), [0, 0, 0.9, 0].map(Math.fround));
	assert.deepEqual(row(ramped, TrunkRow.shape), [0.2, 0.1, 1, 0.75].map(Math.fround));
	assert.deepEqual(row(ramped, TrunkRow.color), [0.5, 0.25, 0.125, 0]);
	assert.deepEqual([...row(plain, TrunkRow.shape), ...row(plain, TrunkRow.color)], [0, 0, 0, 0, 0, 0, 0, 0]);
	assert.equal(bark.flags & LookFlags.Foliage, 0);
	// the flag, not the alpha-test threshold, tells the shader to read the rows: the bark is opaque
	assert.equal(bark.params[LookRow.tint + 3], -1);
	assert.notEqual(bark.flags & LookFlags.Trunk, 0);
	assert.equal(plain.flags & LookFlags.Trunk, 0);
});

test('foliage: leaves and grass fill the foliage rows, and surfaces keeping lit decals off set their bit', () => {
	const [leaf, grass] = materialLooks({
		entries: [
			described(
				litSurface({
					layout: 'roughnessInB',
					f0: 0.07,
					transmission: 0.2,
					foliage: {
						kind: 'leaf',
						occlusionShadow: 0.5,
						fakeShadow: { strength: 0.25, power: 2 },
						diffuseUsesVertexNormal: 1,
						twoSidedNormal: true,
						aoTransmission: [0, 0.01],
						aoSubsurface: [0, 0.01],
						subsurface: 0.3,
						transmissionDistanceFade: 1,
						canopy: null,
						blend: {
							color: [0.9, 0.5, 0.75],
							strength: 1,
							normalAdd: -0.75,
							normalPower: 2,
							withVertexNormal: 1,
						},
					},
					keepsLitDecalsOff: true,
				}),
			),
			described(
				litSurface({
					layout: 'roughnessInB',
					foliage: {
						kind: 'grass',
						bendNormalUpward: 0.5,
						cameraLean: 0.25,
						maskOnDiffuse: 1,
						maskOnTransmission: 0,
						twoSidedNormal: true,
						subsurface: 0.1,
						ao: [1, 2, 0.5],
						sunMask: [3, 4, 0.25],
					},
				}),
			),
		],
	});
	const row = (look: typeof leaf, at: number) => Array.from(look.params.subarray(at, at + 4));
	assert.notEqual(leaf.flags & (LookFlags.Foliage | LookFlags.FoliageLeaf | LookFlags.NormalRoughness), 0);
	assert.deepEqual(row(leaf, LookRow.foliage), [0.5, 0.25, 2, 1]);
	assert.deepEqual(row(leaf, LookRow.surface2).slice(1, 3), [0.07, 0.2].map(Math.fround));
	assert.equal(leaf.params[LookRow.detail2 + 3], 1);
	assert.deepEqual(row(leaf, LeafBlendRow.color), [0.9, 0.5, 0.75, 1].map(Math.fround));
	assert.deepEqual(row(leaf, LeafBlendRow.shape), [-0.75, 2, 1, 1]);
	// no canopy ramp leaves its colour white; the last value is `_TwoSidedNormal`
	assert.deepEqual(row(leaf, LookRow.canopyColor), [1, 1, 1, 1]);
	assert.equal(grass.flags & LookFlags.FoliageLeaf, 0);
	assert.deepEqual(row(grass, LeafBlendRow.shape), [0, 0, 0, 0]);
	assert.deepEqual(row(grass, LookRow.foliage), [0.5, 0.25, 1, 0]);
	assert.deepEqual(row(grass, LookRow.foliageAo), [1, 2, 0.5, 1]);
	assert.deepEqual(row(grass, LookRow.foliage2), [0.1, 3, 4, 0.25].map(Math.fround));
	assert.equal(grass.params[LookRow.detail2 + 3], 0);
});
