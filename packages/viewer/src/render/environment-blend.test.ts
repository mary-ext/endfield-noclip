import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
	EnvironmentPhaseInfo,
	EnvironmentProfile,
	EnvironmentVolumeInfo,
	EnvironmentVolumeShape,
} from '@endfield-noclip/package-format/environment';
import type { PackageManifest } from '@endfield-noclip/package-format/manifest';

import type { Vec3 } from '../scene/camera.ts';

import { blendEnvironment, EnvironmentFades, eyeInLevelVolume, volumeReaches } from './environment-blend.ts';

// only the fields the blend reads; sections are opaque records to it
const profile = (density: number): EnvironmentProfile =>
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a minimal stand-in
	({
		name: 'base',
		heightFog: { heightFogDensity: density, enable: true },
		post: null,
	}) as unknown as EnvironmentProfile;

const phase = (name: string, density: number): EnvironmentPhaseInfo =>
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- as above
	({
		name,
		active: ['heightFog'],
		sections: { heightFog: { heightFogDensity: density, enable: true } },
	}) as unknown as EnvironmentPhaseInfo;

/** the fixture's visibility groups */
const LEVEL_1 = 0;
const LEVEL_2 = 1;
const LEVEL_1_WITH_STATE = 2;
const groups = [
	{ levelTag: 1, condition: null },
	{ levelTag: 2, condition: null },
	{ levelTag: 1, condition: 0 },
];

const volume = (patch: Partial<EnvironmentVolumeInfo>): EnvironmentVolumeInfo => ({
	name: 'v',
	group: LEVEL_1,
	shape: { kind: 'global' },
	blendMode: 1,
	priority: 100,
	blendDistance: 10,
	fadeInDuration: 0,
	fadeOutDuration: 0,
	phase: 0,
	activation: 'unknown',
	...patch,
});

const manifest = (phases: EnvironmentPhaseInfo[], volumes: EnvironmentVolumeInfo[]): PackageManifest =>
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the blend reads only these lists
	({
		environmentPhases: phases,
		environmentVolumes: volumes,
		states: { groups },
	}) as unknown as PackageManifest;

const density = (result: ReturnType<typeof blendEnvironment>): number =>
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the stand-in's field
	(result.profile.heightFog as unknown as { heightFogDensity: number }).heightFogDensity;

const square = {
	kind: 'prism',
	points: [
		[0, 0],
		[100, 0],
		[100, 100],
		[0, 100],
	],
	bottom: 0,
	top: 50,
} as const satisfies EnvironmentVolumeShape;
const options = { pinnedPhase: null };

describe('environment blend', () => {
	it('applies volumes by priority, higher over lower', () => {
		const m = manifest(
			[phase('global', 1), phase('cave', 3)],
			[volume({ priority: 300, phase: 1, shape: square, blendMode: 0 }), volume({ phase: 0 })],
		);
		const inside = blendEnvironment(m, profile(0), [50, 25, 50], options);
		assert.equal(density(inside), 3);
		assert.deepEqual(
			inside.applied.map(({ phase: name }) => name),
			['global', 'cave'],
		);
	});

	it('leaves a prism outside its height band', () => {
		const m = manifest([phase('cave', 3)], [volume({ shape: square, blendMode: 0 })]);
		assert.equal(density(blendEnvironment(m, profile(0), [50, 60, 50], options)), 0);
	});

	it('lerps distance-blended volumes by depth inside over the blend distance', () => {
		const m = manifest([phase('cave', 4)], [volume({ shape: square, blendDistance: 10 })]);
		// 5 m from the nearest edge (x = 5): halfway in
		assert.equal(density(blendEnvironment(m, profile(0), [5, 25, 50], options)), 2);
	});

	it('previews volumes with unknown activation without classifying their names', () => {
		for (const name of ['night', 'fight', 'ordinary']) {
			const m = manifest([phase(name, 9)], [volume({ name, activation: 'unknown' })]);
			assert.equal(density(blendEnvironment(m, profile(0), [0, 0, 0], options)), 9);
		}
	});

	it('skips volumes whose scene states are off, unless previewed by hand', () => {
		const m = manifest([phase('night', 5)], [volume({ group: LEVEL_1_WITH_STATE, blendMode: 0 })]);
		const at: Vec3 = [0, 0, 0];
		assert.equal(density(blendEnvironment(m, profile(0), at, { ...options, loaded: [false] })), 0);
		assert.equal(density(blendEnvironment(m, profile(0), at, { ...options, loaded: [true] })), 5);
		assert.equal(
			density(blendEnvironment(m, profile(0), at, { ...options, loaded: [false], enabled: { 0: true } })),
			5,
		);
	});

	it('reaches a level by footprint, whichever level owns the volume', () => {
		const rect = { minX: 50, minZ: 50, maxX: 200, maxZ: 200 };
		assert.equal(volumeReaches(volume({ shape: square }), rect), true);
		assert.equal(volumeReaches(volume({ shape: square }), { ...rect, minX: 150 }), false);
		assert.equal(volumeReaches(volume({}), rect), true);
		const box: EnvironmentVolumeShape = {
			kind: 'box',
			position: [300, 0, 100],
			rotation: [0, 0, 0],
			scale: [10, 10, 10],
		};
		assert.equal(volumeReaches(volume({ shape: box }), rect), false);
	});

	it('pins one phase instead of the volumes', () => {
		const m = manifest([phase('a', 1), phase('b', 2)], [volume({ phase: 0 })]);
		assert.equal(density(blendEnvironment(m, profile(0), [0, 0, 0], { pinnedPhase: 1 })), 2);
	});

	it('fades time-blended volumes over their durations, and snaps on a jump', () => {
		const m = manifest(
			[phase('cave', 6)],
			[volume({ shape: square, blendMode: 2, fadeInDuration: 2, fadeOutDuration: 3 })],
		);
		const fades = new EnvironmentFades();
		const at = (eye: [number, number, number], dt: number) =>
			density(blendEnvironment(m, profile(0), eye, options, { fades, dt }));
		// the first frame counts as a jump: fully in at once
		assert.equal(at([98, 25, 50], 0.1), 6);
		// walking out (under 5 m a frame): fades out over 3 s
		assert.equal(at([101, 25, 50], 1), 4);
		assert.equal(fades.animating, true);
		assert.equal(at([102, 25, 50], 2), 0);
		// walking back in fades in over 2 s
		assert.ok(Math.abs(at([99, 25, 50], 1) - 3) < 1e-9);
	});
});

describe('eyeInLevelVolume', () => {
	const target: [number, number, number] = [50, 10, 50];

	it('keeps a viewpoint the level volume already holds', () => {
		const m = manifest([phase('base', 1)], [volume({ shape: square })]);
		assert.deepEqual(eyeInLevelVolume(m, 1, profile(0), target, [50, 30, 50], {}), [50, 30, 50]);
	});

	it('pulls a viewpoint above the height band down the view line, past the blend distance', () => {
		const m = manifest([phase('base', 1)], [volume({ shape: square, blendDistance: 10 })]);
		const eye = eyeInLevelVolume(m, 1, profile(0), target, [50, 210, 50], {});
		assert.ok(eye !== null);
		const [x, y, z] = eye;
		assert.deepEqual([x, z], [50, 50]);
		assert.ok(y <= 40 && y > 30, `y ${y}`);
	});

	it('pulls a viewpoint out of a neighbour level’s volume', () => {
		const neighbour = {
			...square,
			points: [
				[-100, 0],
				[20, 0],
				[20, 100],
				[-100, 100],
			],
		} as const satisfies EnvironmentVolumeShape;
		const m = manifest(
			[phase('base', 1), phase('next door', 2)],
			[volume({ shape: square, blendDistance: 1 }), volume({ group: LEVEL_2, phase: 1, shape: neighbour })],
		);
		const eye = eyeInLevelVolume(m, 1, profile(0), target, [-50, 10, 50], {});
		assert.ok(eye !== null);
		const [x] = eye;
		assert.ok(x > 20 && x <= 22, `x ${x}`);
	});

	it('counts only volumes the blend would apply', () => {
		const elsewhere = {
			...square,
			points: [
				[200, 0],
				[300, 0],
				[300, 100],
				[200, 100],
			],
		} as const satisfies EnvironmentVolumeShape;
		const m = manifest(
			[phase('base', 1), phase('next door', 2)],
			[
				volume({ shape: elsewhere, blendMode: 3 }),
				volume({ shape: square, blendDistance: 1 }),
				volume({ group: LEVEL_2, phase: 1, shape: square }),
			],
		);
		// the scripted volume isn't the level's own, and the switched-off neighbour doesn't block the view
		const eye = eyeInLevelVolume(m, 1, profile(0), target, [50, 30, 50], { enabled: { 2: false } });
		assert.deepEqual(eye, [50, 30, 50]);
		assert.equal(eyeInLevelVolume(m, 1, profile(0), target, [50, 30, 50], {}), null);
	});

	it('finds no viewpoint without a volume for the base phase', () => {
		const m = manifest([phase('elsewhere', 1)], [volume({ shape: square })]);
		assert.deepEqual(eyeInLevelVolume(m, 1, profile(0), target, [50, 210, 50], {}), null);
	});
});

it('overrides unknown activation without bypassing volume bounds or pinned phases', () => {
	const m = manifest([phase('scripted', 9)], [volume({ shape: square, blendMode: 3 })]);
	const base = profile(1);
	assert.equal(density(blendEnvironment(m, base, [50, 25, 50], { pinnedPhase: null })), 1);
	assert.equal(
		density(blendEnvironment(m, base, [50, 25, 50], { pinnedPhase: null, enabled: { 0: true } })),
		9,
	);
	assert.equal(
		density(blendEnvironment(m, base, [150, 25, 50], { pinnedPhase: null, enabled: { 0: true } })),
		1,
	);
	assert.equal(
		density(blendEnvironment(m, base, [50, 25, 50], { pinnedPhase: 0, enabled: { 0: false } })),
		9,
	);
	const automatic = manifest([phase('regular', 5)], [volume({})]);
	assert.equal(
		density(blendEnvironment(automatic, base, [0, 0, 0], { pinnedPhase: null, enabled: { 0: false } })),
		1,
	);
});

it('fades wetness in from dry with the wet side’s settings when only one side has it on', () => {
	const rain = (enableWetness: boolean, wetness: number, porosity: number) => ({
		enableWetness,
		wetness,
		wetnessBasePorosity: porosity,
	});
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a minimal stand-in
	const base = { name: 'base', rain: rain(false, 0.25, 0), post: null } as unknown as EnvironmentProfile;
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- as above
	const wet = {
		name: 'wet',
		active: ['rain'],
		sections: { rain: rain(true, 1, 0.8) },
	} as unknown as EnvironmentPhaseInfo;
	const m = manifest([wet], [volume({ shape: square, blendDistance: 20 })]);
	// 5 m inside a 20 m blend distance
	const result = blendEnvironment(m, base, [5, 25, 50], options).profile.rain;
	assert.equal(result?.enableWetness, true);
	assert.equal(result?.wetness.toFixed(6), '0.250000');
	assert.equal(result?.wetnessBasePorosity, 0.8);
});

it('fades the flow noise in from one side, and crossfades noises of different speeds at the halfway point', () => {
	const fog = (enableFlowNoise: boolean, flowNoiseIntensity: number, flowNoiseSpeed: number) => ({
		enableFlowNoise,
		flowNoiseIntensity,
		flowNoiseSpeed,
		flowNoiseTilling: 0.01,
		flowNoiseDistance: 100,
		flowNoiseDir: [0, 0, 1],
	});
	const blend = (from: ReturnType<typeof fog>, to: ReturnType<typeof fog>, x: number) => {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a minimal stand-in
		const base = { name: 'base', volumetricFog: from, post: null } as unknown as EnvironmentProfile;
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- as above
		const next = {
			name: 'next',
			active: ['volumetricFog'],
			sections: { volumetricFog: to },
		} as unknown as EnvironmentPhaseInfo;
		const m = manifest([next], [volume({ shape: square, blendDistance: 20 })]);
		// x m inside a 20 m blend distance
		return blendEnvironment(m, base, [x, 25, 50], options).profile.volumetricFog;
	};
	// a quarter in: the noise only the base has keeps its settings at three quarters of its intensity
	const fading = blend(fog(true, 0.8, 0.1), fog(false, 0, 0.5), 5);
	assert.equal(fading.enableFlowNoise, true);
	assert.equal(fading.flowNoiseIntensity.toFixed(6), '0.600000');
	assert.equal(fading.flowNoiseSpeed, 0.1);
	// three quarters in: the base's noise is gone and the next one is halfway faded in
	const crossing = blend(fog(true, 0.8, 0.1), fog(true, 0.4, 0.5), 15);
	assert.equal(crossing.flowNoiseIntensity.toFixed(6), '0.200000');
	assert.equal(crossing.flowNoiseSpeed, 0.5);
});
