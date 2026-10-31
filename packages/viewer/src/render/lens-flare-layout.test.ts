import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
	AnimationCurve,
	LensFlareConfig,
	LensFlareElement,
} from '@endfield-noclip/package-format/environment';

import {
	type LensFlareInput,
	UnityRandom,
	evaluateCurve,
	evaluateGradient,
	flareQuads,
	lensFlareLook,
} from './lens-flare-layout.ts';

const line = (from: number, to: number): AnimationCurve => ({
	keys: [
		{
			time: 0,
			value: from,
			inSlope: to - from,
			outSlope: to - from,
			weightedMode: 0,
			inWeight: 0,
			outWeight: 0,
		},
		{
			time: 1,
			value: to,
			inSlope: to - from,
			outSlope: to - from,
			weightedMode: 0,
			inWeight: 0,
			outWeight: 0,
		},
	],
	preWrapMode: 2,
	postWrapMode: 2,
});

const element = (patch: Partial<LensFlareElement>): LensFlareElement => ({
	visible: true,
	position: 0,
	positionOffset: [0, 0],
	angularOffset: 0,
	translationScale: [1, 1],
	localIntensity: 1,
	lensFlareTexture: null,
	uniformScale: 1,
	sizeXY: [1, 1],
	allowMultipleElement: false,
	count: 1,
	preserveAspectRatio: false,
	rotation: 0,
	tint: [1, 1, 1, 1],
	blendMode: 0,
	autoRotate: false,
	flareType: 1,
	modulateByLightColor: false,
	distribution: 0,
	lengthSpread: 1,
	positionCurve: line(0, 1),
	scaleCurve: line(1, 1),
	seed: 0,
	colorGradient: { mode: 0, colorKeys: [], alphaKeys: [] },
	intensityVariation: 0,
	positionVariation: [0, 0],
	scaleVariation: 0,
	rotationVariation: 0,
	enableRadialDistortion: false,
	targetSizeDistortion: [1, 1],
	distortionCurve: line(0, 1),
	distortionRelativeToCenter: false,
	fallOff: 1,
	edgeOffset: 0.5,
	sideCount: 6,
	sdfRoundness: 0,
	inverseSDF: false,
	uniformAngle: 0,
	uniformAngleCurve: line(0, 0),
	...patch,
});

const input = (elements: LensFlareElement[], patch: Partial<LensFlareConfig> = {}): LensFlareInput => ({
	lensFlare: {
		enable: true,
		lensFlareData: { name: 'test', elements },
		intensity: 0.5,
		scale: 4,
		useOcclusion: true,
		occlusionRadius: 0.1,
		sampleCount: 32,
		occlusionOffset: 0,
		allowOffScreen: false,
		...patch,
	},
	// 180° about y: the light travels along −z, so the sun lies towards +z
	light: { rotationLensFlare: [0, 1, 0, 0], directColor: [1, 0.5, 0.25, 1] },
});

describe('lensFlareLook', () => {
	it('keeps the visible image and circle elements of an enabled flare', () => {
		const look = lensFlareLook(
			input([
				element({}),
				element({ visible: false }),
				element({ flareType: 0, lensFlareTexture: null }),
				element({ flareType: 0, lensFlareTexture: 7 }),
				element({ flareType: 2 }),
			]),
		);
		assert.ok(look !== null);
		assert.deepEqual(
			look.elements.map(({ flareType }) => flareType),
			[1, 0],
		);
		const [x, y, z] = look.direction;
		assert.ok(Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9 && Math.abs(z - 1) < 1e-9);
		assert.equal(lensFlareLook(input([element({})], { enable: false })), null);
		assert.equal(lensFlareLook(null), null);
	});
});

describe('flareQuads', () => {
	it('sizes and tints a single element as SRP core does', () => {
		const look = lensFlareLook(input([element({ sizeXY: [8, 3], localIntensity: 7, tint: [1, 0.5, 0, 1] })]));
		assert.ok(look !== null);
		const [quad] = flareQuads(look, [0.2, -0.3], 16 / 9, () => 1);
		// 0.1 · size · uniform scale · flare scale
		assert.ok(Math.abs(quad.data2[2] - 3.2) < 1e-9 && Math.abs(quad.data2[3] - 1.2) < 1e-9);
		assert.deepEqual(quad.color, [3.5, 1.75, 0, 3.5]);
		// at position 0 the quad sits on the sun, turned by 180°
		assert.deepEqual(quad.data2.slice(0, 2), [0.2, -0.3]);
		assert.ok(Math.abs(quad.data0[0] + 1) < 1e-9 && Math.abs(quad.data0[2]) < 1e-9);
	});

	it('mirrors a ghost at position 1 to the other side of the centre', () => {
		const look = lensFlareLook(input([element({ position: 1 })]));
		assert.ok(look !== null);
		const [quad] = flareQuads(look, [0.4, 0.2], 1, () => 1);
		// position 1 is twice along the ray: 2 · −sun from the sun, landing at −sun
		assert.ok(Math.abs(quad.data2[0] + quad.data0[2] + 0.4) < 1e-9);
		assert.ok(Math.abs(quad.data2[1] + quad.data0[3] + 0.2) < 1e-9);
	});

	it('spreads copies along the ray and takes their colours from the gradient', () => {
		const look = lensFlareLook(
			input([
				element({
					allowMultipleElement: true,
					count: 3,
					lengthSpread: 0.5,
					colorGradient: {
						mode: 0,
						colorKeys: [
							{ time: 0, color: [0, 0, 0] },
							{ time: 1, color: [1, 1, 1] },
						],
						alphaKeys: [],
					},
				}),
			]),
		);
		assert.ok(look !== null);
		const quads = flareQuads(look, [1, 0], 1, () => 1);
		assert.equal(quads.length, 3);
		assert.deepEqual(
			quads.map(({ data0 }) => data0[2] + 0),
			[0, -0.5, -1],
		);
		assert.deepEqual(
			quads.map(({ color }) => color[0]),
			[0, 0.25, 0.5],
		);
	});

	it('repeats the same random copies for the same seed', () => {
		const random = element({
			allowMultipleElement: true,
			count: 4,
			distribution: 2,
			seed: 16,
			intensityVariation: 1,
			scaleVariation: 1,
			positionVariation: [1, 0],
		});
		const look = lensFlareLook(input([random]));
		assert.ok(look !== null);
		assert.deepEqual(
			flareQuads(look, [0.3, 0.1], 1, () => 1),
			flareQuads(look, [0.3, 0.1], 1, () => 1),
		);
	});
});

describe('curves, gradients and randomness', () => {
	it('evaluates a curve between and beyond its keys', () => {
		assert.equal(evaluateCurve(line(0, 1), 0.5), 0.5);
		assert.equal(evaluateCurve(line(0, 1), 2), 1);
		assert.equal(evaluateCurve({ keys: [], preWrapMode: 2, postWrapMode: 2 }, 0.5), 0);
	});

	it('blends gradient keys, and holds them in fixed mode', () => {
		const colorKeys = [
			{ time: 0, color: [0, 0, 0] as [number, number, number] },
			{ time: 1, color: [1, 1, 1] as [number, number, number] },
		];
		assert.deepEqual(evaluateGradient({ mode: 0, colorKeys, alphaKeys: [] }, 0.25), [0.25, 0.25, 0.25, 1]);
		assert.deepEqual(evaluateGradient({ mode: 1, colorKeys, alphaKeys: [] }, 0.25), [1, 1, 1, 1]);
	});

	it('draws values within the range from a seeded xorshift', () => {
		const a = new UnityRandom(14);
		const b = new UnityRandom(14);
		for (let i = 0; i < 16; i++) {
			const value = a.range(-1, 1);
			assert.equal(value, b.range(-1, 1));
			assert.ok(value >= -1 && value <= 1);
		}
	});
});
