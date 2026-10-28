import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LevelConfig } from './level-config.ts';
import {
	buildLevelPartition,
	classifyEntity,
	levelOfCell,
	levelOfTag,
	voteLevelTags,
} from './level-partition.ts';
import { cellOwnerIdNum, parseMapConfig } from './map-config.ts';

// a 4×4 map (cells -2..1) with levels lv001 (idNum 21), lv002 (idNum 2) and lv005 (idNum 34): lv004 is missing,
// as in map01, so lv005 gets tag 3
const GRID = [
	[0, 0, 0, 0],
	[21, 21, 2, 0],
	[21, 34, 2, 0],
	[0, 34, 0, 0],
];

// the game's JSON files start with a byte-order mark
const BOM = String.fromCharCode(0xfeff);

const mapConfig = () =>
	parseMapConfig(
		BOM +
			JSON.stringify({
				mapIdStr: 'map09',
				mapId: 9,
				isSeamless: true,
				sideGridNum: 4,
				levelIds: GRID.flat(),
			}),
	);

const level = (id: string, idNum: number, cells: [number, number][], mapId = 'map09'): LevelConfig => ({
	id,
	idNum,
	mapId,
	defaultState: { exportedSceneConfigPath: null, name: null, sourceSceneName: null },
	dimensionSourceLevelId: null,
	enableFactoryBuildingSnowCoverage: false,
	isDimensionLevel: false,
	isSeamless: true,
	levelDataPathHashes: null,
	levelGrids: cells.map(([x, z]) => ({ x, z })),
	playerInitPos: [0, 0, 0],
	playerInitRot: [0, 0, 0],
	rectLeftBottom: [0, 0],
	rectRightTop: [0, 0],
	scope: 0,
	startPos: [0, 0, 0],
	waterStartAudio: null,
	waterStopAudio: null,
});

const configs = () => [
	level('map09_lv005', 34, [
		[-1, 0],
		[-1, 1],
	]),
	level('map09_lv001', 21, [
		[-2, -1],
		[-1, -1],
		[-2, 0],
	]),
	level('map09_lv002', 2, [
		[0, -1],
		[0, 0],
	]),
	level('dung09_dg001', 99, [[0, 0]], 'dung09'),
];

test('map config grid indexing', () => {
	const map = mapConfig();
	assert.equal(cellOwnerIdNum(map, -2, -1), 21);
	assert.equal(cellOwnerIdNum(map, -1, 1), 34);
	assert.equal(cellOwnerIdNum(map, 1, 1), 0);
	assert.equal(cellOwnerIdNum(map, 2, 0), undefined);
});

test('levels get ordinal tags and agree with the grid', () => {
	const partition = buildLevelPartition(mapConfig(), configs());
	assert.deepEqual(
		partition.levels.map((l) => [l.id, l.tag]),
		[
			['map09_lv001', 1],
			['map09_lv002', 2],
			['map09_lv005', 3],
		],
	);
	assert.deepEqual(partition.issues, []);
	assert.equal(levelOfTag(partition, 3)?.id, 'map09_lv005');
	assert.equal(levelOfTag(partition, 0), undefined);
	assert.equal(levelOfCell(partition, 0, 0)?.id, 'map09_lv002');
});

test('disagreeing cell lists are reported', () => {
	const broken = configs();
	broken[0].levelGrids?.pop();
	broken[1].levelGrids?.push({ x: 1, z: 1 });
	const { issues } = buildLevelPartition(mapConfig(), broken);
	assert.deepEqual(issues.map((i) => i.level).toSorted(), ['map09_lv001', 'map09_lv005']);
});

test('classifyEntity separates ownership from placement', () => {
	const partition = buildLevelPartition(mapConfig(), configs());
	const tagged = (tag: number) => ((tag << 27) | 5) >>> 0;
	const at = (cx: number, cz: number) => ({ x: cx * 128 + 1, z: cz * 128 + 1 });

	const own = classifyEntity(partition, tagged(1), at(-2, -1));
	assert.deepEqual([own.bucket, own.level?.id, own.placement], ['level', 'map09_lv001', 'own']);

	const neighbour = classifyEntity(partition, tagged(1), at(0, 0));
	assert.deepEqual([neighbour.placement, neighbour.cellOwner?.id], ['neighbour', 'map09_lv002']);

	const backdrop = classifyEntity(partition, tagged(3), at(1, 1));
	assert.deepEqual([backdrop.level?.id, backdrop.placement], ['map09_lv005', 'backdrop']);

	assert.equal(classifyEntity(partition, tagged(0), at(0, 0)).bucket, 'shared');
	assert.equal(classifyEntity(partition, tagged(31), at(0, 0)).bucket, 'unassigned');
	assert.equal(classifyEntity(partition, tagged(2), null).placement, 'unplaced');
});

test('voteLevelTags finds each tag in its level and ignores the backdrop', () => {
	const partition = buildLevelPartition(mapConfig(), configs());
	const votes = voteLevelTags(partition, [
		{ tag: 3, x: -100, z: 10 },
		{ tag: 3, x: 200, z: 200 },
		{ tag: 3, x: 200, z: 210 },
		{ tag: 2, x: 10, z: -10 },
	]);
	assert.deepEqual(
		votes.map((v) => [v.tag, v.rule, v.majority, v.count]),
		[
			[2, 'map09_lv002', 'map09_lv002', 1],
			[3, 'map09_lv005', 'map09_lv005', 3],
		],
	);
});

test('a single-level scene owns tag 0', () => {
	const map = parseMapConfig(
		JSON.stringify({ mapIdStr: 'dung09_dg001', sideGridNum: 2, levelIds: [99, 99, 0, 0] }),
	);
	const partition = buildLevelPartition(map, [
		level(
			'dung09_dg001',
			99,
			[
				[-1, -1],
				[0, -1],
			],
			'dung09_dg001',
		),
	]);
	assert.equal(partition.levels[0].tag, 0);
	const membership = classifyEntity(partition, 5, { x: 1, z: -1 });
	assert.deepEqual(
		[membership.bucket, membership.level?.id, membership.placement],
		['level', 'dung09_dg001', 'own'],
	);
});
