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

import { composeEnvironment, resolveLevelEnvironment, type SceneVolumes } from './environment.ts';

/** a polyline volume over the world rectangle `[x0, x1) × [z0, z1)` */
const rect = (id: number, priority: number, [x0, z0, x1, z1]: number[]): EnvironmentVolume => ({
	id,
	name: `volume ${id}`,
	transform: null,
	volumeType: EnvironmentVolumeType.PolyLine,
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
			{ tag: 0, volume: globalVolume },
			{ tag: 3, volume: broad },
			{ tag: 3, volume: local },
			{ tag: 4, volume: foreign },
		],
		post: [],
	};
	const choice = resolveLevelEnvironment(level, volumes);
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
		environment: [
			{ tag: 0, volume: globalVolume },
			{ tag: 3, volume: hidden },
			{ tag: 3, volume: overlay },
		],
		post: [],
	};
	assert.equal(resolveLevelEnvironment(level, volumes).volume, overlay);
	assert.equal(
		resolveLevelEnvironment({ tag: 5, config: { levelGrids: level.config.levelGrids } }, volumes).volume,
		globalVolume,
	);
});

const phase = (name: string, inactive: EnvironmentSectionName[]): EnvironmentPhase => {
	const sections = {} as EnvironmentPhase['sections'];
	for (const section of ENVIRONMENT_SECTIONS) {
		sections[section] = { active: !inactive.includes(section), value: { from: name }, textures: [] };
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
