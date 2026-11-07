import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DynamicEntity, DynamicResourceGroup } from '@endfield-noclip/formats/endfield/dynamic-scene';
import type { StreamAreaTable } from '@endfield-noclip/formats/endfield/stream-area';

import type { ChunkFile } from '../world/world-index.ts';

import {
	labelProgression,
	maskLevels,
	resolveChunkFiles,
	selectedAreas,
	summarizeProgressions,
	type SceneryVariants,
} from './scenery-variants.ts';

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
	gates: [],
	variables: [],
	viewState: null,
	resourceGroups: [group(0, 0b00011), group(1, 0b00100), group(2, 0b11100), group(3, 0)],
	extraScene: null,
	erosionCore: null,
	sludgeCore: null,
};

const tree: DynamicEntity = {
	grid: 0x040000,
	uid: 2n,
	entityType: 19,
	components: [15, 30],
	controllers: [],
	gates: [],
	variables: [],
	viewState: null,
	resourceGroups: [group(0, 0b01), group(1, 0b10)],
	extraScene: null,
	erosionCore: null,
	sludgeCore: null,
};

test('summarizes progressions with their levels and defaults to the highest authored level', () => {
	const [progression, ...rest] = summarizeProgressions([outpost, tree]);
	assert.deepEqual(rest, []);
	assert.deepEqual(progression, {
		kind: 'settlement',
		key: 'stm_hongs_1',
		levels: [0, 1, 2, 3, 4],
		defaultLevel: 4,
		entities: 1,
		groupsPerLevel: { 0: 1, 1: 1, 2: 2, 3: 1, 4: 1 },
		levelNum: 101,
	});
	assert.deepEqual(maskLevels(0b10100), [2, 4]);
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
	const variants: SceneryVariants = {
		scene: 'map02',
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
		resolveChunkFiles(files, 'map02', selectedAreas(variants, table, areas)).map((f) => f.area);
	assert.deepEqual(loaded('all'), [0, 5, 6, 7]);
	assert.deepEqual(loaded('root'), [0, 5]);
	assert.deepEqual(loaded([7]), [0, 7]);
});

test("a progression's levels and default cover every entity it controls", () => {
	const secondary = { ...outpost, uid: 99n, resourceGroups: [group(5, 0b100000)] };
	const [progression] = summarizeProgressions([outpost, secondary]).map((summary) =>
		labelProgression(summary, null, null),
	);
	assert.equal(progression.defaultLevel, 5);
	assert.equal(progression.entities, 2);
});
