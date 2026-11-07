import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
	BlendSchema,
	EnvironmentPhaseInfo,
	FieldBlend,
	EnvironmentProfile,
	EnvironmentVolumeInfo,
	EnvironmentVolumeShape,
	EnvironmentBlend,
} from '@endfield-noclip/package-format/environment';
import type { LevelEnvironment } from '@endfield-noclip/package-format/manifest';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import {
	applyBlend,
	type BlendPlan,
	EnvironmentFades,
	type EnvironmentScene,
	eyeInLevelVolume,
	planBlend,
} from './blend.ts';

// only the fields the blend reads; sections are opaque records to it
const phase = (name: string, density: number): EnvironmentPhaseInfo =>
	sectionsPhase(name, { heightFog: { heightFogDensity: density, enable: true } }, ['heightFog']);

const sectionsPhase = (
	name: string,
	sections: Record<string, unknown>,
	active: string[],
): EnvironmentPhaseInfo =>
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a minimal stand-in
	({ name, active, sections }) as unknown as EnvironmentPhaseInfo;

/** the fixture's visibility groups */
const LEVEL_1 = 0;
const LEVEL_2 = 1;
const LEVEL_1_WITH_STATE = 2;
const LEVEL_2_SWITCHED = 3;
const groups = [
	{ level: 0, condition: null },
	{ level: 1, condition: null },
	{ level: 0, condition: 0 },
	{ level: 1, condition: 1 },
];

const volume = (patch: Partial<EnvironmentVolumeInfo>): EnvironmentVolumeInfo => ({
	name: 'v',
	group: LEVEL_1,
	control: null,
	shape: { kind: 'global' },
	blend: depth(10),
	priority: 100,
	phase: 0,
	...patch,
});

const REPLACE: EnvironmentBlend = { kind: 'replace' };

/** @returns a blend by depth over `distance` m */
const depth = (distance: number): EnvironmentBlend => ({ kind: 'depth', distance });

/** a box the camera never enters */
const FAR: EnvironmentVolumeShape = {
	kind: 'box',
	center: [1e6, 0, 1e6],
	toBox: [1, 0, 0, 0, 1, 0, 0, 0, 1],
	halfExtents: [0.5, 0.5, 0.5],
};

/** the fixtures' fields: numbers lerp unless listed (`…Mode` fields switch), everything else switches */
const SCHEMA_OVERRIDES: Record<string, FieldBlend> = { rotation: 'round' };

/** @returns a schema covering every field of the given sections, guessed from their values */
const schemaOf = (value: Record<string, unknown>): BlendSchema =>
	Object.fromEntries(
		Object.entries(value).map(([field, v]): [string, FieldBlend | BlendSchema] => {
			if (Object.hasOwn(SCHEMA_OVERRIDES, field) || field.endsWith('Mode')) {
				return [field, SCHEMA_OVERRIDES[field] ?? 'switch'];
			}
			if (typeof v === 'number' || (Array.isArray(v) && v.every((n) => typeof n === 'number'))) {
				return [field, 'lerp'];
			}
			if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fixture records
				return [field, schemaOf(v as Record<string, unknown>)];
			}
			return [field, 'switch'];
		}),
	);

/**
 * @param base the base phase's sections, all inactive; the base volume is appended last, out of the camera's
 *   reach, so the blend starts from these sections
 */
const manifest = (
	phases: EnvironmentPhaseInfo[],
	volumes: EnvironmentVolumeInfo[],
	base: Record<string, unknown> = { heightFog: { heightFogDensity: 0, enable: true } },
): EnvironmentScene => {
	const all = [...phases, sectionsPhase('base', base, [])];
	const schema: Record<string, BlendSchema> = {};
	for (const { sections } of all) {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fixture records
		for (const [name, section] of Object.entries(
			sections as unknown as Record<string, Record<string, unknown>>,
		)) {
			schema[name] = { ...schemaOf(section), ...schema[name] };
		}
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the blend reads only these lists
	return {
		environment: {
			posts: [],
			schema,
			phases: all,
			volumes: [
				...volumes,
				volume({ name: 'base', shape: FAR, blend: REPLACE, priority: 0, phase: phases.length }),
			],
			flowNoise: null,
		},
		manifest: { states: { groups } },
	} as unknown as EnvironmentScene;
};

/** the fixture's base environment: its last volume */
const baseOf = (m: EnvironmentScene): LevelEnvironment => ({
	volume: m.environment.volumes.length - 1,
	post: null,
});

/** blends at `eye`; without `time`, a fresh fade state whose first frame (a jump) takes time fades fully in */
const blendAt = (
	m: EnvironmentScene,
	eye: Vec3,
	options: Parameters<typeof planBlend>[3],
	time: Parameters<typeof planBlend>[4] = { fades: new EnvironmentFades(), dt: 1 },
): { plan: BlendPlan; profile: EnvironmentProfile } => {
	const plan = planBlend(m, baseOf(m), eye, options, time);
	assert.ok(plan !== null);
	return { plan, profile: applyBlend(plan) };
};

const blended = (
	m: EnvironmentScene,
	eye: Vec3,
	options: Parameters<typeof planBlend>[3],
	time?: Parameters<typeof planBlend>[4],
): EnvironmentProfile => blendAt(m, eye, options, time).profile;

const density = (profile: EnvironmentProfile): number =>
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the stand-in's field
	(profile.heightFog as unknown as { heightFogDensity: number }).heightFogDensity;

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
const options = { volumes: true, pinnedPhase: null };

describe('environment blend', () => {
	it('applies volumes by priority, higher over lower', () => {
		const m = manifest(
			[phase('global', 1), phase('cave', 3)],
			[volume({ priority: 300, phase: 1, shape: square, blend: REPLACE }), volume({ phase: 0 })],
		);
		const inside = blendAt(m, [50, 25, 50], options);
		assert.equal(density(inside.profile), 3);
		assert.deepEqual(
			inside.plan.applied.map(({ phase: name }) => name),
			['global', 'cave'],
		);
	});

	it('starts from every section of the base phase, inactive ones included', () => {
		const m = manifest([], [], { heightFog: { heightFogDensity: 7, enable: true } });
		const { profile } = blendAt(m, [0, 0, 0], options);
		assert.equal(density(profile), 7);
		assert.equal(profile.name, 'base');
	});

	it('shares nothing with the manifest', () => {
		const m = manifest([phase('cave', 3)], [volume({ shape: square, blend: REPLACE })]);
		const { profile } = blendAt(m, [50, 25, 50], options);
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the stand-in's field
		(profile.heightFog as unknown as { heightFogDensity: number }).heightFogDensity = 0;
		assert.equal(density(blended(m, [50, 25, 50], options)), 3);
	});

	it('leaves a prism outside its height band', () => {
		const m = manifest([phase('cave', 3)], [volume({ shape: square, blend: REPLACE })]);
		assert.equal(density(blended(m, [50, 60, 50], options)), 0);
	});

	it('lerps distance-blended volumes by depth inside over the blend distance', () => {
		const m = manifest([phase('cave', 4)], [volume({ shape: square, blend: depth(10) })]);
		// 5 m from the nearest edge (x = 5): halfway in
		assert.equal(density(blended(m, [5, 25, 50], options)), 2);
	});

	it('applies volumes without classifying their names', () => {
		for (const name of ['night', 'fight', 'ordinary']) {
			const m = manifest([phase(name, 9)], [volume({ name })]);
			assert.equal(density(blended(m, [0, 0, 0], options)), 9);
		}
	});

	it('skips volumes whose condition (scene states, their own switch) fails', () => {
		const m = manifest([phase('night', 5)], [volume({ group: LEVEL_1_WITH_STATE, blend: REPLACE })]);
		const at: Vec3 = [0, 0, 0];
		assert.equal(density(blended(m, at, { ...options, loaded: [false, true] })), 0);
		assert.equal(density(blended(m, at, { ...options, loaded: [true, true] })), 5);
	});

	it('with volumes off, applies the scene-wide global volumes and the base volume wherever the camera is', () => {
		const m = manifest(
			[phase('scene', 2), phase('cave', 3)],
			[volume({ group: LEVEL_2, phase: 0 }), volume({ phase: 1, shape: square, blend: REPLACE })],
		);
		// the scene's global volume belongs to tag 0 here: a group the fixture doesn't have
		m.environment.volumes[0].group = 99;
		const off = { volumes: false, pinnedPhase: null };
		assert.equal(density(blended(m, [500, 25, 500], off)), 2);
		// the cave isn't the base volume, so it doesn't apply with volumes off
		assert.equal(density(blended(m, [50, 25, 50], off)), 2);
	});

	it('pins one phase over the level’s own look instead of the volumes', () => {
		const m = manifest([phase('a', 1), phase('b', 2)], [volume({ phase: 0 })]);
		assert.equal(density(blended(m, [0, 0, 0], { volumes: true, pinnedPhase: 1 })), 2);
	});

	it('fades time-blended volumes over their durations, and snaps on a jump', () => {
		const m = manifest(
			[phase('cave', 6)],
			[volume({ shape: square, blend: { kind: 'fade', fadeIn: 2, fadeOut: 3 } })],
		);
		const fades = new EnvironmentFades();
		const at = (eye: [number, number, number], dt: number) =>
			density(blended(m, eye, options, { fades, dt }));
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
	/** the level's base volume: the fixture's first */
	const own: LevelEnvironment = { volume: 0, post: null };

	it('keeps a viewpoint the level volume already holds', () => {
		const m = manifest([phase('base', 1)], [volume({ shape: square })]);
		assert.deepEqual(eyeInLevelVolume(m, 0, own, target, [50, 30, 50], {}), [50, 30, 50]);
	});

	it('pulls a viewpoint above the height band down the view line, past the blend distance', () => {
		const m = manifest([phase('base', 1)], [volume({ shape: square, blend: depth(10) })]);
		const eye = eyeInLevelVolume(m, 0, own, target, [50, 210, 50], {});
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
			[volume({ shape: square, blend: depth(1) }), volume({ group: LEVEL_2, phase: 1, shape: neighbour })],
		);
		const eye = eyeInLevelVolume(m, 0, own, target, [-50, 10, 50], {});
		assert.ok(eye !== null);
		const [x] = eye;
		assert.ok(x > 20 && x <= 22, `x ${x}`);
	});

	it('counts only volumes the blend would apply', () => {
		const m = manifest(
			[phase('base', 1), phase('next door', 2)],
			[
				volume({ shape: square, blend: depth(1) }),
				volume({ group: LEVEL_2_SWITCHED, phase: 1, shape: square }),
			],
		);
		// the switched-off neighbour doesn't block the view
		const eye = eyeInLevelVolume(m, 0, own, target, [50, 30, 50], { loaded: [true, false] });
		assert.deepEqual(eye, [50, 30, 50]);
		assert.equal(eyeInLevelVolume(m, 0, own, target, [50, 30, 50], { loaded: [true, true] }), null);
	});

	it('finds no viewpoint when the base volume doesn’t apply', () => {
		const m = manifest([phase('scripted', 1)], [volume({ group: LEVEL_1_WITH_STATE, shape: square })]);
		assert.deepEqual(eyeInLevelVolume(m, 0, own, target, [50, 210, 50], { loaded: [false] }), null);
	});
});

it('applies a switched-on scripted volume at full strength inside its bounds; a pinned phase applies anyway', () => {
	const m = manifest(
		[phase('scripted', 9)],
		[volume({ group: LEVEL_1_WITH_STATE, shape: square, blend: { kind: 'scripted' } })],
		{ heightFog: { heightFogDensity: 1, enable: true } },
	);
	assert.equal(density(blended(m, [50, 25, 50], { ...options, loaded: [false] })), 1);
	assert.equal(density(blended(m, [50, 25, 50], { ...options, loaded: [true] })), 9);
	assert.equal(density(blended(m, [150, 25, 50], { ...options, loaded: [true] })), 1);
	assert.equal(density(blended(m, [50, 25, 50], { volumes: true, pinnedPhase: 0, loaded: [false] })), 9);
});

/** blends a base phase's sections towards a phase setting `active`, `x` m inside a 20 m blend distance */
const blendSections = (
	base: Record<string, unknown>,
	sections: Record<string, unknown>,
	active: string[],
	x: number,
): EnvironmentProfile => {
	const m = manifest(
		[sectionsPhase('next', sections, active)],
		[volume({ shape: square, blend: depth(20) })],
		base,
	);
	return blended(m, [x, 25, 50], options);
};

it('fades wetness in from dry with the wet side’s settings when only one side has it on', () => {
	const rain = (enableWetness: boolean, wetness: number, porosity: number) => ({
		enableWetness,
		wetness,
		wetnessBasePorosity: porosity,
	});
	// 5 m inside a 20 m blend distance
	const result = blendSections(
		{ rain: rain(false, 0.25, 0) },
		{ rain: rain(true, 1, 0.8) },
		['rain'],
		5,
	).rain;
	assert.equal(result?.enableWetness, true);
	assert.equal(result?.wetness.toFixed(6), '0.250000');
	assert.equal(result?.wetnessBasePorosity, 0.8);
});

it('fades wetness in from dry over a profile without a rain section', () => {
	const result = blendSections(
		{ heightFog: { heightFogDensity: 0, enable: true } },
		{ rain: { enableWetness: true, wetness: 1, wetnessBasePorosity: 0.8 } },
		['rain'],
		5,
	).rain;
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
	const blend = (from: ReturnType<typeof fog>, to: ReturnType<typeof fog>, x: number) =>
		blendSections({ volumetricFog: from }, { volumetricFog: to }, ['volumetricFog'], x).volumetricFog;
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

it('fades a lens flare in from nothing, and crosses between two flares through nothing', () => {
	const flare = (enable: boolean, intensity: number, name: string) => ({
		enable,
		intensity,
		scale: 1,
		lensFlareData: { name, elements: [] },
	});
	const blend = (from: ReturnType<typeof flare>, to: ReturnType<typeof flare>, x: number) =>
		blendSections({ lensFlare: from }, { lensFlare: to }, ['lensFlare'], x).lensFlare;
	// a quarter in: only the next phase has a flare, at a quarter of its intensity
	const fading = blend(flare(false, 1, 'a'), flare(true, 0.5, 'b'), 5);
	assert.equal(fading?.enable, true);
	assert.equal(fading?.intensity, 0.125);
	assert.equal(fading?.lensFlareData?.name, 'b');
	// a quarter in between two flares: the base's, at half its intensity
	const crossing = blend(flare(true, 1, 'a'), flare(true, 0.5, 'b'), 5);
	assert.equal(crossing?.intensity, 0.5);
	assert.equal(crossing?.lensFlareData?.name, 'a');
});

it('lerps sun directions as pitch and yaw, each effect from the direction in effect on its side', () => {
	const light = (sun: [number, number], fogMode: number, fog: [number, number]) => ({
		directPitchYaw: sun,
		atmospherePitchYawMode: 0,
		atmospherePitchYaw: [0, 0],
		heightFogDirectionalInscatteringPitchYawMode: fogMode,
		heightFogDirectionalInscatteringPitchYaw: fog,
	});
	// halfway, with the yaws on either side of north
	const { light: result } = blendSections(
		{ light: light([30, 350], 0, [0, 0]) },
		{ light: light([50, 10], 1, [70, 90]) },
		['light'],
		10,
	);
	assert.deepEqual(result.directPitchYaw, [40, 360]);
	// both sides follow the sun
	assert.equal(result.atmospherePitchYawMode, 0);
	// the base side follows the sun, the other has its own
	assert.equal(result.heightFogDirectionalInscatteringPitchYawMode, 1);
	assert.deepEqual(result.heightFogDirectionalInscatteringPitchYaw, [50, 400]);
});

it('takes the atmosphere’s Rayleigh scale for the side whose fog defers to it', () => {
	const fog = (rayleighScatteringScale: number) => ({ rayleighScatteringScale });
	const atmosphere = { rayleighScatteringScale: 0.04 };
	// a quarter in: from the atmosphere's 0.04 towards the fog's own 0.08
	const deferring = blendSections({ fog: fog(-1), atmosphere }, { fog: fog(0.08) }, ['fog'], 5);
	assert.equal(deferring.fog.rayleighScatteringScale.toFixed(6), '0.050000');
	// both defer: the result still defers
	const both = blendSections({ fog: fog(-1), atmosphere }, { fog: fog(-1) }, ['fog'], 5);
	assert.ok(both.fog.rayleighScatteringScale < 0);
});

it('keeps integer fields whole', () => {
	const { cloud } = blendSections(
		{ cloud: { enable: false, cloudTexture: null, rotation: 10 } },
		{ cloud: { enable: false, cloudTexture: null, rotation: 21 } },
		['cloud'],
		5,
	);
	assert.equal(cloud.rotation, 13);
});
