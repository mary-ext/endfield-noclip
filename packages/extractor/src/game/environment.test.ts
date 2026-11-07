import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	type EnvironmentVolume,
	EnvironmentVolumeType,
} from '@endfield-noclip/formats/endfield/environment-volume';
import {
	ENVIRONMENT_SECTIONS,
	type EnvironmentPhase,
	type EnvironmentSectionName,
} from '@endfield-noclip/formats/hg/environment-phase';

import {
	composeEnvironment,
	environmentBlend,
	resolveLevelEnvironment,
	type SceneEnvironmentVolume,
	type SceneVolumes,
	unitCubeShape,
} from './environment.ts';

test('a box volume is the unit cube under its transform, rotated back as Unity turns z, x, then y', () => {
	const shape = unitCubeShape([100, 10, 0], [0, 90, 0], [20, 10, -40]);
	assert.deepEqual(shape.center, [100, 10, 0]);
	assert.deepEqual(shape.halfExtents, [10, 5, 20]);
	// a world offset along +x lies along the box's +z
	const expected = [0, 0, -1, 0, 1, 0, 1, 0, 0];
	assert.ok(shape.toBox.every((value, i) => Math.abs(value - expected[i]) < 1e-12));
	// a roll of 90° turns the box's y axis to world −x, and the pitch after it leaves that be
	const tilted = unitCubeShape([0, 0, 0], [90, 0, 90], [1, 1, 1]);
	const along = (v: number[]) =>
		[0, 1, 2].map((row) => tilted.toBox.slice(row * 3, row * 3 + 3).reduce((sum, m, i) => sum + m * v[i], 0));
	assert.ok(along([-1, 0, 0]).every((value, i) => Math.abs(value - [0, 1, 0][i]) < 1e-12));
});

test('a volume blends as its blend mode says', () => {
	const of = (blendMode: number) =>
		environmentBlend({
			...rect(1, 0, [0, 0, 1, 1]),
			blendMode,
			blendDistance: 7,
			fadeInDuration: 2,
			fadeOutDuration: 3,
		});
	assert.deepEqual(of(0), { kind: 'replace' });
	assert.deepEqual(of(1), { kind: 'depth', distance: 7 });
	assert.deepEqual(of(2), { kind: 'fade', fadeIn: 2, fadeOut: 3 });
	assert.deepEqual(of(3), { kind: 'scripted' });
	assert.equal(typeof of(4), 'string');
});

/** a polyline volume over the world rectangle `[x0, x1) × [z0, z1)` */
const rect = (id: number, priority: number, [x0, z0, x1, z1]: number[]): EnvironmentVolume => ({
	id,
	name: `volume ${id}`,
	transform: null,
	volumeType: EnvironmentVolumeType.PolyArea,
	blendMode: 2,
	priority,
	blendDistance: 5,
	fadeInDuration: 3,
	fadeOutDuration: 3,
	envPhase: BigInt(id),
	shape: {
		position: [0, 0, 0],
		rotation: [0, 0, 0],
		points: [
			[x0, z0],
			[x1, z0],
			[x1, z1],
			[x0, z1],
		],
		height: 100,
		baseHeightOffset: 0,
	},
});

const globalVolume: EnvironmentVolume = {
	...rect(1, 100, [0, 0, 0, 0]),
	volumeType: EnvironmentVolumeType.Global,
	shape: null,
};

/** a chunk volume of a level, loaded with any of `sceneStates` (always when empty) */
const chunk = (tag: number, volume: EnvironmentVolume, sceneStates: number[]): SceneEnvironmentVolume => ({
	tag,
	sceneStates,
	volume,
	phaseObject: null,
	condition: null,
	loadedByDefault: true,
});

/** no scene state active */
const none: ReadonlySet<number> = new Set();

/** a level of two 128 m cells side by side, (0, 0) and (1, 0) */
const level = {
	tag: 3,
	config: {
		levelGrids: [
			{ x: 0, z: 0 },
			{ x: 1, z: 0 },
		],
	},
};

test('the base is the broadest volume the level shows, not the one shown most', () => {
	const broad = rect(10, 200, [0, 0, 256, 128]);
	// higher priority over 3/4 of the level: shown more than the broad one, but not the base
	const local = rect(11, 300, [0, 0, 192, 128]);
	// as broad and higher priority, but on another level's tag
	const foreign = rect(12, 400, [0, 0, 256, 128]);
	const volumes: SceneVolumes = {
		environment: [
			chunk(0, globalVolume, []),
			chunk(3, broad, []),
			chunk(3, local, []),
			chunk(4, foreign, []),
		],
		post: [],
	};
	const choice = resolveLevelEnvironment(level, volumes, none);
	assert.equal(choice.volume, broad);
	assert.equal(choice.global, globalVolume);
	assert.equal(choice.samples, 32);
	assert.deepEqual(
		choice.shares.map(({ volume, covered, wins }) => [volume.id, covered, wins]),
		[
			[10, 32, 8],
			[11, 24, 24],
		],
	);
});

test('a volume that is never shown is skipped; without volumes the scene global stands in', () => {
	const hidden = rect(20, 200, [0, 0, 256, 128]);
	// as broad, higher priority: hides the first everywhere
	const overlay = rect(21, 300, [0, 0, 256, 128]);
	const volumes: SceneVolumes = {
		environment: [chunk(0, globalVolume, []), chunk(3, hidden, []), chunk(3, overlay, [])],
		post: [],
	};
	assert.equal(resolveLevelEnvironment(level, volumes, none).volume, overlay);
	assert.equal(
		resolveLevelEnvironment({ tag: 5, config: { levelGrids: level.config.levelGrids } }, volumes, none)
			.volume,
		globalVolume,
	);
});

test('volumes of inactive scene states are not candidates', () => {
	const base = rect(30, 200, [0, 0, 256, 128]);
	// The Hub's map-wide night: only loaded with scene state 8
	const night = rect(31, 320, [-4096, -4096, 4096, 4096]);
	// the normal look of a level that a story state hides: loaded with state 7 or 10
	const hidden = rect(32, 250, [0, 0, 256, 128]);
	const volumes: SceneVolumes = {
		environment: [
			chunk(0, globalVolume, []),
			chunk(3, base, []),
			chunk(3, night, [8]),
			chunk(3, hidden, [7, 10]),
		],
		post: [],
	};
	assert.equal(resolveLevelEnvironment(level, volumes, none).volume, base);
	assert.equal(resolveLevelEnvironment(level, volumes, new Set([10])).volume, hidden);
	assert.equal(resolveLevelEnvironment(level, volumes, new Set([8, 10])).volume, night);
});

const phase = (name: string, inactive: EnvironmentSectionName[]): EnvironmentPhase => {
	const sections = {} as EnvironmentPhase['sections'];
	for (const section of ENVIRONMENT_SECTIONS) {
		sections[section] = {
			active: !inactive.includes(section),
			value: { from: name },
			kinds: { from: 'string' },
			textures: [],
			materials: [],
			flares: [],
		};
	}
	return { name, sections };
};

test('inactive sections come from the global phase, if active there', () => {
	const composed = composeEnvironment(
		phase('level', ['colorGradingConfig', 'cloudConfig']),
		phase('global', ['cloudConfig']),
	);
	assert.deepEqual(
		{ source: composed.lightConfig.source, from: composed.lightConfig.section.value.from },
		{ source: 'level', from: 'level' },
	);
	assert.deepEqual(
		{ source: composed.colorGradingConfig.source, from: composed.colorGradingConfig.section.value.from },
		{ source: 'global', from: 'global' },
	);
	assert.deepEqual(
		{ source: composed.cloudConfig.source, from: composed.cloudConfig.section.value.from },
		{ source: 'inactive', from: 'level' },
	);
});

test('a placed volume counts only when its placement loads by default', () => {
	const art = rect(40, 200, [0, 0, 256, 128]);
	// Power Plateau's overcast: placed by an entity whose gate passes once a mission is complete
	const overcast = rect(41, 300, [0, 0, 256, 128]);
	const placed = (loadedByDefault: boolean): SceneEnvironmentVolume => ({
		...chunk(3, overcast, []),
		condition: { alternatives: [[{ control: 'mission:e3m5', mask: 8 }]] },
		loadedByDefault,
	});
	const volumes = (loadedByDefault: boolean): SceneVolumes => ({
		environment: [chunk(0, globalVolume, []), chunk(3, art, []), placed(loadedByDefault)],
		post: [],
	});
	assert.equal(resolveLevelEnvironment(level, volumes(true), none).volume, overcast);
	assert.equal(resolveLevelEnvironment(level, volumes(false), none).volume, art);
});
