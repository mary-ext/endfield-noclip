import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Aabb } from '@endfield-noclip/formats/unity/values';
import type { Bounds } from '@endfield-noclip/package-format/values';
import type { WaterGlobal, WaterTable, WaterVolumeEntry } from '@endfield-noclip/package-format/water';

import type { LevelWaterVolume } from '../game/water-volumes.ts';

import {
	configEntry,
	finishWater,
	sectorsOverlapping,
	selectSurfaces,
	volumeEntry,
	type WaterPlan,
} from './water.ts';

describe('configEntry', () => {
	const vectors = [
		'waterRayleighScatteringMeter',
		'waterRayleighAbsorptionMeter',
		'waterRayleighAbsorptionMeter2',
	];
	const raw = (overrides: Record<string, number | number[]>): Record<string, number | number[]> => {
		const values: Record<string, number | number[]> = {
			foamColorG: [1, 0.5, 0.25, 1],
			flowDirectionVector2: [0.5, 0.75],
			// fields the shading doesn't take
			absorptionTint: [1, 1, 1, 1],
			rippleNormalStrength: 3,
		};
		for (const field of vectors) {
			values[field] = [0.1, 0.2, 0.3, 0];
		}
		for (const field of [
			'safeFullAbsorpDistance',
			'envLightIntensity',
			'sceneColorEnvInfluence',
			'rayleighMieLerpFactor',
			'distanceEdgeBlendFactor',
			'roughness',
			'specular',
			'waterIOR',
			'envLightSpecularIntensity',
			'distanceFade',
			'distanceNormalMinStrength',
			'envSpecularDesaturation',
			'dirSpecNormalScaler',
			'foamOpacity',
			'foamRoughness',
			'foamShapeOffset',
			'foamFadeDistance',
			'waterBaseColorSubsurfaceScaler',
			'emissiveStrength',
			'causticTilling',
			'causticOpacity',
			'causticDistort',
			'causticSpeed',
			'causticStartDepth',
			'causticEndDepth',
			'useFlowMap',
			'FlowmapOption',
			'flowSpeed',
			'flowFullCycle',
			'normalTilling',
			'normalScale',
			'smallWaveNormalType',
			'largeWaveNormalType',
			'largeWaveFlowSpeed',
			'largeWaveNormalTilling',
			'largeWaveNormalScale',
			'flowFullCycleLarge',
			'largeWaveInvDir',
		]) {
			values[field] = 1;
		}
		return { ...values, ...overrides };
	};

	it("applies the game's transforms and keeps only what the shading takes", () => {
		const { values } = configEntry({
			name: 'Config_water_test',
			values: raw({
				envSpecularDesaturation: 0.31,
				foamFadeDistance: 4,
				largeWaveFlowSpeed: 2,
				FlowmapOption: 0,
			}),
		});
		assert.ok(Math.abs(values.normalMipBias - 1.9) < 1e-9);
		assert.equal(values.foamFadeRate, 0.25);
		assert.equal(values.largeWaveSignedSpeed, -2);
		assert.equal(values.useFlowMap, true);
		assert.equal(values.flowMapCoverage, false);
		assert.deepEqual(values.flowDirectionVector2, [0.5, 0.75]);
		assert.ok(!('absorptionTint' in values) && !('rippleNormalStrength' in values));
	});

	it('keeps the foam fade rate finite', () => {
		assert.equal(configEntry({ name: 'c', values: raw({ foamFadeDistance: 0 }) }).values.foamFadeRate, 1e4);
	});

	it('names a missing or misshapen field', () => {
		assert.throws(() => configEntry({ name: 'c', values: raw({ foamColorG: [1, 1] }) }), /c: foamColorG/);
		const { roughness: _, ...missing } = raw({});
		assert.throws(() => configEntry({ name: 'c', values: missing }), /c: roughness is missing/);
	});
});

describe('volumeEntry', () => {
	// Suiming's receding pit: authored half full, scripts snap it and move it down at their own speeds
	const volume: LevelWaterVolume = {
		id: '46300000002',
		levelId: 'indie_dg016',
		levelTag: 0,
		pivot: [79.57, 51.187, -43.87],
		points: [
			[0, 0],
			[1, 0],
			[0, 1],
		],
		heightMax: 110,
		fraction: 0.5,
		amountMax: 100,
		fillSpeed: 0.11,
		itemType: 'item_liquid_water',
		configHash: 1n,
		factory: false,
		infinite: true,
		parent: null,
		source: 'indie_dg016_lv_data.json#46300000002',
	};

	it('offers a pumped pool empty and full, moving it at its fill speed in amount units', () => {
		// Wuling City's Tianjing Courtyard pond: factory water, 40000 units over 35 m, 30 units a second
		const pond: LevelWaterVolume = {
			...volume,
			id: '22800060004',
			heightMax: 35,
			fraction: 1,
			amountMax: 40000,
			fillSpeed: 30,
			factory: true,
			infinite: false,
		};
		const { entry, sources } = volumeEntry(pond, []);
		assert.equal(entry.control, 'waterLevel:22800060004');
		assert.deepEqual(
			entry.levels.map(({ fraction }) => fraction),
			[0, 1],
		);
		assert.equal(entry.fillSpeed, (30 * 35) / 40000);
		assert.deepEqual(
			sources.map(({ authored, pumped: end }) => [authored, end]),
			[
				[false, true],
				[true, true],
			],
		);
		// a basin following it gets no fills of its own
		const basin = volumeEntry({ ...pond, id: '22800060019', parent: '22800060004' }, []);
		assert.equal(basin.entry.control, null);
		assert.equal(basin.parent, '22800060004');
	});

	it('merges the authored fill with script fills, taking the speed scripts move it at', () => {
		const level = (
			script: string,
			node: number,
			kind: 'fraction' | 'amount',
			value: number,
			smooth: boolean,
			speed: number | null,
			id = volume.id,
		) => ({ volume: id, script, node, kind, value, smooth, speed });
		const actions = [
			level('13', 1, 'fraction', 0.5, false, null),
			level('13', 2, 'fraction', 0.37, true, 0.1192),
			level('13', 3, 'fraction', 0.37, false, null),
			level('2', 4, 'amount', 8, true, null),
			level('2', 5, 'fraction', 0.9, false, null, 'other'),
		];
		const { entry, sources } = volumeEntry(volume, actions);
		assert.equal(entry.base, 51.187);
		assert.equal(entry.initial, 0.5);
		assert.equal(entry.control, 'waterLevel:46300000002');
		assert.deepEqual(entry.floaters, []);
		assert.deepEqual(entry.levels, [
			{ fraction: 0.08, speed: 0.11 },
			{ fraction: 0.37, speed: 0.1192 },
			{ fraction: 0.5, speed: 0.11 },
		]);
		assert.deepEqual(sources, [
			{ authored: false, actions: [actions[3]], pumped: false },
			{ authored: false, actions: [actions[1], actions[2]], pumped: false },
			{ authored: true, actions: [actions[0]], pumped: false },
		]);
	});
});

const surface = (levelTag: number, x: number, z: number, extent = 1): { levelTag: number; bounds: Aabb } => ({
	levelTag,
	bounds: { center: [x, 10, z], extents: [extent, 0, extent] },
});

describe('selectSurfaces', () => {
	it('applies the subset predicate to the level tag and bounds centre', () => {
		const surfaces = [surface(1, 5, 5, 100), surface(1, 50, 5), surface(2, 5, 5)];
		const inLevelOneRect = (tag: number, x: number, z: number) =>
			tag === 1 && x >= 0 && x < 10 && z >= 0 && z < 10;
		// the first reaches far past the rectangle, but its centre is inside
		assert.deepEqual(selectSurfaces(surfaces, inLevelOneRect), [surfaces[0]]);
		assert.equal(selectSurfaces(surfaces, () => true).length, 3);
	});
});

describe('sectorsOverlapping', () => {
	const global: Pick<WaterGlobal, 'center' | 'sectorSize'> = { center: [100, -100], sectorSize: 128 };
	const box = (minX: number, minZ: number, maxX: number, maxZ: number): { bounds: Bounds } => ({
		bounds: { min: [minX, 0, minZ], max: [maxX, 0, maxZ] },
	});

	it('keeps sectors whose square, offset by the centre, overlaps a surface', () => {
		const sectors = [
			{ x: 0, z: 0 },
			{ x: -1, z: 0 },
			{ x: 0, z: -1 },
			{ x: 3, z: 3 },
		];
		// sector (0, 0) is [100, 228) × [-100, 28); (-1, 0) is [-28, 100) × [-100, 28)
		assert.deepEqual(sectorsOverlapping(sectors, global, [box(110, -90, 120, -80)]), [{ x: 0, z: 0 }]);
		assert.deepEqual(sectorsOverlapping(sectors, global, [box(90, -90, 110, -80)]), [
			{ x: 0, z: 0 },
			{ x: -1, z: 0 },
		]);
		// touching an edge isn't overlapping
		assert.deepEqual(sectorsOverlapping(sectors, global, [box(228, 28, 240, 40)]), []);
		assert.deepEqual(sectorsOverlapping(sectors, global, []), []);
	});
});

describe('finishWater', () => {
	it('maps planned texture indices to texture-table ids and survives JSON', () => {
		const table: WaterTable = {
			global: {
				mapSize: 4096,
				sectorSize: 128,
				center: [0, 0],
				flowmapPrecision: 0.5,
				flowMap: 0,
				causticMap: 1,
				normalMaps: 2,
				rainMap: null,
				sectors: [
					{ x: -1, z: 2, texture: 3 },
					{ x: 0, z: 2, texture: 4 },
				],
			},
			configs: [],
			surfaces: [],
			volumes: [],
		};
		const plan: WaterPlan = {
			surfaceOwners: [],
			table,
			textures: [],
			floaterIds: [],
			levelSources: [],
			debug: {
				surfaces: { scene: 0, packed: 0 },
				volumes: { scene: 0, packed: 0 },
				global: null,
				sectors: { scene: 2, packed: 2, untiled: 0 },
				untiledSectors: [],
				rows: [],
				errors: [],
			},
		};
		const finished = finishWater(plan, [10, 11, 12, 13, null], new Map());
		assert.deepEqual(
			{ ...finished.global, sectors: finished.global?.sectors },
			{
				mapSize: 4096,
				sectorSize: 128,
				center: [0, 0],
				flowmapPrecision: 0.5,
				flowMap: 10,
				causticMap: 11,
				normalMaps: 12,
				rainMap: null,
				sectors: [
					{ x: -1, z: 2, texture: 13 },
					{ x: 0, z: 2, texture: null },
				],
			},
		);
		assert.deepEqual(JSON.parse(JSON.stringify(finished)), finished);
	});

	it("turns floater entity ids into their stored rows, reporting ids that weren't stored", () => {
		const volume = (id: string): WaterVolumeEntry => ({
			id,
			base: 0,
			heightMax: 1,
			initial: 0,
			fillSpeed: 1,
			levels: [],
			control: null,
			parent: null,
			floaters: [],
		});
		const plan: WaterPlan = {
			surfaceOwners: [],
			table: { global: null, configs: [], surfaces: [], volumes: [volume('1'), volume('2')] },
			textures: [],
			floaterIds: [[7, 8], [9]],
			levelSources: [[], []],
			debug: {
				surfaces: { scene: 0, packed: 0 },
				volumes: { scene: 2, packed: 2 },
				global: null,
				sectors: { scene: 0, packed: 0, untiled: 0 },
				untiledSectors: [],
				rows: [],
				errors: [],
			},
		};
		const rowsOf = new Map([
			[7, [{ blob: 3, row: 0 }]],
			[
				8,
				[
					{ blob: 3, row: 4 },
					{ blob: 5, row: 1 },
				],
			],
		]);
		const finished = finishWater(plan, [], rowsOf);
		assert.deepEqual(finished.volumes[0].floaters, [
			{ blob: 3, row: 0 },
			{ blob: 3, row: 4 },
			{ blob: 5, row: 1 },
		]);
		assert.deepEqual(finished.volumes[1].floaters, []);
		assert.deepEqual(plan.debug.errors, ['water volume 2: no stored row for floater entities 9']);
	});

	it('passes a table without global water through', () => {
		const plan: WaterPlan = {
			surfaceOwners: [],
			table: { global: null, configs: [], surfaces: [], volumes: [] },
			textures: [],
			floaterIds: [],
			levelSources: [],
			debug: {
				surfaces: { scene: 3, packed: 0 },
				volumes: { scene: 0, packed: 0 },
				global: null,
				sectors: { scene: 0, packed: 0, untiled: 0 },
				untiledSectors: [],
				rows: [],
				errors: [],
			},
		};
		assert.deepEqual(finishWater(plan, [], new Map()), {
			global: null,
			configs: [],
			surfaces: [],
			volumes: [],
		});
	});
});
