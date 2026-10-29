import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DynamicEntity, DynamicResourceGroup } from '@endfield-noclip/formats/endfield/dynamic-scene';
import type { StreamAreaTable } from '@endfield-noclip/formats/endfield/stream-area';

import {
	labelProgression,
	maskLevels,
	resolveChunkFiles,
	selectedAreas,
	shownResourceGroups,
	summarizeProgressions,
	type SceneStates,
} from './scene-states.ts';
import type { ChunkFile } from './world-index.ts';

const group = (index: number, logicState: number): DynamicResourceGroup => ({
	resources: { type: 5, grid: 1, index, count: 1 },
	sceneState: 0,
	logicState,
	levelNum: 101,
	factoryIndex: -1,
});

const outpost: DynamicEntity = {
	grid: 0x070000,
	uid: 1n,
	entityType: 16,
	components: [15, 27, 30],
	controllers: [{ kind: 'settlement', settlementId: 'stm_hongs_1', isMain: true }],
	resourceGroups: [group(0, 0b00011), group(1, 0b00100), group(2, 0b11100), group(3, 0)],
};

const tree: DynamicEntity = {
	grid: 0x040000,
	uid: 2n,
	entityType: 19,
	components: [15, 30],
	controllers: [],
	resourceGroups: [group(0, 0b01), group(1, 0b10)],
};

test('summarizes progressions with their levels and defaults to the lowest authored level', () => {
	const [progression, ...rest] = summarizeProgressions([outpost, tree]);
	assert.deepEqual(rest, []);
	assert.deepEqual(progression, {
		kind: 'settlement',
		key: 'stm_hongs_1',
		levels: [0, 1, 2, 3, 4],
		defaultLevel: 0,
		entities: 1,
		groupsPerLevel: { 0: 1, 1: 1, 2: 2, 3: 1, 4: 1 },
		levelNum: 101,
	});
	assert.deepEqual(maskLevels(0b10100), [2, 4]);
});

test('selected levels pick resource groups; entities without a controller use logic state 0', () => {
	const states: SceneStates = {
		map: 'map02',
		areas: [],
		progressions: summarizeProgressions([outpost]).map((summary) =>
			labelProgression(summary, 'map02_lv001', 'Jingyu Valley'),
		),
	};
	const indices = (entity: DynamicEntity, levels: Record<string, number>) =>
		shownResourceGroups(entity, states, { areas: 'all', levels }).map((g) => g.resources.index);
	assert.deepEqual(indices(outpost, {}), [0, 3]);
	assert.deepEqual(indices(outpost, { 'settlement:stm_hongs_1': 1 }), [0, 3]);
	assert.deepEqual(indices(outpost, { 'settlement:stm_hongs_1': 2 }), [1, 2, 3]);
	assert.deepEqual(indices(tree, {}), [0]);
});

test('area selections resolve to chunk files of state 0 plus the chosen areas', () => {
	const file = (area: number, scene = 'map02'): ChunkFile => ({
		name: `Data/Streaming/PC/${scene}/Streaming/InitChunkData_0_0_0_${area}.bytes`,
		scene,
		cell: { x: 0, z: 0 },
		sceneState: 0,
		area,
	});
	const files = [file(0), file(5), file(6), file(7), file(5, 'map01')];
	const table: StreamAreaTable = {
		totalAreas: [0, 5, 6, 7, 9],
		rootVisible: [0, 5],
		visibleWhileInside: new Map([[9, [0, 6]]]),
		triggers: [],
		bounds: { min: { x: 0, z: 0 }, max: { x: 0, z: 0 }, minHeight: 0, maxHeight: 0 },
	};
	const states: SceneStates = {
		map: 'map02',
		areas: [5, 6, 7].map((id) => ({
			id,
			levelId: null,
			levelName: null,
			rootVisible: id === 5,
			shownInside: [],
			chunkFiles: 1,
			entities: 1,
		})),
		progressions: [],
	};
	const loaded = (areas: 'all' | 'root' | number[]) =>
		resolveChunkFiles(files, 'map02', selectedAreas(states, table, { areas, levels: {} })).map((f) => f.area);
	assert.deepEqual(loaded('all'), [0, 5, 6, 7]);
	assert.deepEqual(loaded('root'), [0, 5]);
	assert.deepEqual(loaded([7]), [0, 7]);
});

test('secondary progression entities do not choose their own later starting level', () => {
	const secondary = { ...outpost, uid: 99n, resourceGroups: [group(5, 0b10000)] };
	const states: SceneStates = {
		map: 'map02',
		areas: [],
		progressions: summarizeProgressions([outpost, secondary]).map((summary) =>
			labelProgression(summary, null, null),
		),
	};
	assert.deepEqual(shownResourceGroups(secondary, states, { areas: 'all', levels: {} }), []);
});
