import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FormatError } from '../binary/binary-reader.ts';
import { FlatBufferWriter as Writer } from '../binary/flatbuffer-writer.ts';
import type { TypeTreeNode } from '../unity/serialized-file.ts';

import { parseInitChunk } from './init-chunk-data.ts';
import { ValueCode } from './mono-objects.ts';
import { parseStreamingChunk } from './streaming-chunk-data.ts';
import {
	isWaterGlobalConfig,
	readWaterGlobalBindings,
	readWaterGlobalConfig,
	readWaterSurfaceConfig,
	readWaterSurfaces,
	WATER_SURFACE_COMPONENT,
	WaterProperty,
} from './water.ts';

// #region synthetic chunks

/** writes the parallel id / kind / row vectors into root slots 3–5; returns the row slots */
const writeObjects = (w: Writer, root: number[], objects: { id: number; kind: number }[]): number[] => {
	w.u32s(
		root[3],
		objects.map((object) => object.id),
	);
	w.u8s(
		root[4],
		objects.map((object) => object.kind),
	);
	return w.offsets(root[5], objects.length);
};

/** writes a property table of asset values (StringPathHash key, ScriptableObject kind) at `table` slots 3–5 */
const writeProperties = (
	w: Writer,
	table: { fields: number[] },
	entries: [key: number, hash: bigint][],
): void => {
	w.u32s(
		table.fields[3],
		entries.map(([key]) => key),
	);
	w.u8s(
		table.fields[4],
		entries.map(() => ValueCode.Asset),
	);
	const values = w.offsets(table.fields[5], entries.length);
	entries.forEach(([, hash], i) => {
		const value = w.reserve(12, 4);
		w.view.setBigUint64(value, hash, true);
		w.view.setUint32(value + 8, 6, true);
		w.link(values[i], value);
	});
};

const encoder = new TextEncoder();

const SURFACE_ID = (2 << 27) | 0x123;
const GLOBAL_ID = (2 << 27) | 0x7a4;
const MESH = 0x1111n;
const CONFIG = 0x2222n;
const GLOBAL_CONFIG = 0x3333n;

/**
 * an Init chunk: one named water surface in a group with bounds, name and water columns, plus a `Water`
 * object
 */
const buildInit = (options: { stride?: number } = {}): Uint8Array => {
	const w = new Writer();
	const fields = w.chunkRoot();
	const objects = [
		{ id: SURFACE_ID, kind: 2, name: 'RectWaterPlane#2_123' },
		{ id: GLOBAL_ID, kind: 1, name: 'Water#2_7A4' },
	];
	const rows = writeObjects(w, fields, objects);
	objects.forEach((object, i) => {
		const row = w.table([4]);
		w.link(rows[i], row.at);
		const bytes = encoder.encode(object.name);
		const vector = w.vector(1, bytes.length);
		w.bytes.set(bytes, vector.start);
		w.reserve(1, 1);
		w.link(row.fields[0], vector.at);
	});

	const idWrappers = w.vector(4, 1);
	w.link(fields[6], idWrappers.at);
	const wrapper = w.table([4]);
	w.link(idWrappers.start, wrapper.at);
	const groupIds = w.vector(4, 1);
	w.link(wrapper.fields[0], groupIds.at);
	w.view.setUint32(groupIds.start, SURFACE_ID, true);

	const groups = w.vector(4, 1);
	w.link(fields[7], groups.at);
	const group = w.table([16, 4, 24, 4, 4]);
	w.link(groups.start, group.at);
	w.view.setUint32(group.fields[1], 1, true);
	const stride = options.stride ?? 104;
	const descriptors: [number, number][] = [
		[0, 4],
		[1, 4],
		[2, 4],
		[3, 4],
		[4, 4],
		[5, 4],
		[21, 64],
		[WATER_SURFACE_COMPONENT, stride],
	];
	const descriptorVector = w.vector(8, descriptors.length);
	w.link(group.fields[3], descriptorVector.at);
	descriptors.forEach(([id, size], i) => {
		w.view.setUint16(descriptorVector.start + i * 8, id, true);
		w.view.setUint16(descriptorVector.start + i * 8 + 2, size, true);
	});
	const blobWrapper = w.table([4]);
	w.link(group.fields[4], blobWrapper.at);
	const blob = w.vector(
		1,
		descriptors.reduce((sum, [, size]) => sum + size, 0),
	);
	w.link(blobWrapper.fields[0], blob.at);
	let column = blob.start;
	for (const [id, size] of descriptors) {
		if (id <= 5) {
			w.view.setFloat32(column, [-593, 242, -193.5, 121.5, 0, 78.75][id], true);
		} else if (id === WATER_SURFACE_COMPONENT) {
			w.view.setUint32(column, 2, true);
			const matrix = [2430, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1575, 0, -593, 242, -193.5, 1];
			matrix.forEach((v, k) => w.view.setFloat32(column + 8 + k * 4, v, true));
			[0.25, 1, 0, 1].forEach((v, k) => w.view.setFloat32(column + 88 + k * 4, v, true));
		}
		column += size;
	}
	return w.finish();
};

/** the matching Streaming chunk: the surface's mesh + config bindings and the `Water` object's global config */
const buildStreaming = (options: { surfaceProperties?: [number, bigint][] } = {}): Uint8Array => {
	const w = new Writer();
	const fields = w.chunkRoot();
	const rows = writeObjects(w, fields, [
		{ id: SURFACE_ID, kind: 2 },
		{ id: GLOBAL_ID, kind: 1 },
	]);

	const surface = w.table([4, 4, 4, 4, 16, 4]);
	w.link(rows[0], surface.at);
	const surfaceTable = w.table([0, 0, 0, 4, 4, 4]);
	w.link(surface.fields[3], surfaceTable.at);
	writeProperties(
		w,
		surfaceTable,
		options.surfaceProperties ?? [
			[WaterProperty.SurfaceMesh, MESH],
			[WaterProperty.SurfaceConfig, CONFIG],
		],
	);

	// kind 1: slot 3 is an inline mask, slot 4 a vector of component tables
	const global = w.table([4, 4, 0, 8, 4]);
	w.link(rows[1], global.at);
	w.view.setBigUint64(global.fields[3], (1n << 32n) | 1n, true);
	const components = w.vector(4, 2);
	w.link(global.fields[4], components.at);
	const transform = w.table([4, 0, 0, 4, 4, 4]);
	w.link(components.start, transform.at);
	writeProperties(w, transform, []);
	const config = w.table([4, 4, 0, 4, 4, 4]);
	w.link(components.start + 4, config.at);
	writeProperties(w, config, [[WaterProperty.GlobalConfig, GLOBAL_CONFIG]]);
	return w.finish();
};

// #endregion

test('parseStreamingChunk reads kind-2 and kind-1 property tables', () => {
	const chunk = parseStreamingChunk(buildStreaming());
	assert.equal(chunk.version, 49);
	assert.deepEqual(
		chunk.records.map((record) => [
			record.id,
			record.kind,
			record.properties.map((p) => [p.key, p.component, p.value.type === 'asset' ? p.value.hash : null]),
		]),
		[
			[
				SURFACE_ID,
				2,
				[
					[WaterProperty.SurfaceMesh, 0, MESH],
					[WaterProperty.SurfaceConfig, 0, CONFIG],
				],
			],
			[GLOBAL_ID, 1, [[WaterProperty.GlobalConfig, 1, GLOBAL_CONFIG]]],
		],
	);
});

test('readWaterSurfaces joins the placement column to its bindings', () => {
	const [surface, ...rest] = readWaterSurfaces(
		parseInitChunk(buildInit()),
		parseStreamingChunk(buildStreaming()),
	);
	assert.equal(rest.length, 0);
	assert.equal(surface.id, SURFACE_ID);
	assert.equal(surface.levelTag, 2);
	assert.equal(surface.name, 'RectWaterPlane#2_123');
	assert.equal(surface.renderTypeMask, 2);
	assert.equal(surface.runtimeMeshId, 0);
	assert.deepEqual(
		[surface.matrix[0], surface.matrix[5], surface.matrix[12], surface.matrix[14]],
		[2430, 0.5, -593, -193.5],
	);
	assert.deepEqual(surface.bounds, { center: [-593, 242, -193.5], extents: [121.5, 0, 78.75] });
	assert.deepEqual(surface.param0, [0, 0, 0, 0]);
	assert.deepEqual(surface.param1, [0.25, 1, 0, 1]);
	assert.equal(surface.meshHash, MESH);
	assert.equal(surface.configHash, CONFIG);
});

test('readWaterSurfaces rejects a wrong stride or a missing binding', () => {
	const streaming = parseStreamingChunk(buildStreaming());
	assert.throws(() => readWaterSurfaces(parseInitChunk(buildInit({ stride: 96 })), streaming), FormatError);
	const unbound = parseStreamingChunk(
		buildStreaming({ surfaceProperties: [[WaterProperty.SurfaceMesh, MESH]] }),
	);
	assert.throws(() => readWaterSurfaces(parseInitChunk(buildInit()), unbound), FormatError);
	const twice = parseStreamingChunk(
		buildStreaming({
			surfaceProperties: [
				[WaterProperty.SurfaceMesh, MESH],
				[WaterProperty.SurfaceMesh, MESH],
				[WaterProperty.SurfaceConfig, CONFIG],
			],
		}),
	);
	assert.throws(() => readWaterSurfaces(parseInitChunk(buildInit()), twice), FormatError);
});

test('readWaterGlobalBindings finds the Water object', () => {
	assert.deepEqual(
		readWaterGlobalBindings(parseInitChunk(buildInit()), parseStreamingChunk(buildStreaming())),
		[{ id: GLOBAL_ID, levelTag: 2, name: 'Water#2_7A4', configHash: GLOBAL_CONFIG }],
	);
});

/** builds a flattened TypeTree from `[level, type, name]` rows */
const tree = (rows: [number, string, string][]): TypeTreeNode[] =>
	rows.map(([level, type, name]) => ({
		type,
		name,
		level,
		byteSize: -1,
		typeFlags: 0,
		metaFlag: 0,
		version: 1,
		index: 0,
		refTypeHash: 0n,
	}));

/** float members of a math struct, one per letter of `names` */
const components = (level: number, names: string): [number, string, string][] =>
	names.split('').map((name) => [level, 'float', name]);

test('readWaterSurfaceConfig keeps numbers, flags, vectors and colours', () => {
	const nodes = tree([
		[0, 'MonoBehaviour', 'Base'],
		[1, 'string', 'm_Name'],
		[1, 'PPtr<MonoScript>', 'm_Script'],
		[2, 'int', 'm_FileID'],
		[2, 'SInt64', 'm_PathID'],
		[1, 'int', 'materialIndex'],
		[1, 'UInt8', 'useFlowMap'],
		[1, 'Vector2f', 'flowDirectionVector2'],
		...components(2, 'xy'),
		[1, 'ColorRGBA', 'absorptionTint'],
		...components(2, 'rgba'),
		[1, 'Vector4f', 'waterRayleighScatteringMeter'],
		...components(2, 'xyzw'),
		[1, 'string', 'label'],
		[1, 'HGWaterRipple', 'ripple'],
		...components(2, 'xy'),
	]);
	const config = readWaterSurfaceConfig(nodes, {
		m_Name: 'Config_water_Map02_15',
		m_Script: { m_FileID: 1, m_PathID: 1n },
		materialIndex: 15,
		useFlowMap: 1,
		flowDirectionVector2: { x: 1, y: 0.5 },
		absorptionTint: { r: 0.25, g: 0.5, b: 0.75, a: 0 },
		waterRayleighScatteringMeter: { x: 1, y: 2, z: 3, w: 4 },
		label: 'ignored',
		ripple: { x: 1, y: 2 },
	});
	assert.deepEqual(config, {
		name: 'Config_water_Map02_15',
		values: {
			materialIndex: 15,
			useFlowMap: 1,
			flowDirectionVector2: [1, 0.5],
			absorptionTint: [0.25, 0.5, 0.75, 0],
			waterRayleighScatteringMeter: [1, 2, 3, 4],
		},
	});
	assert.equal(isWaterGlobalConfig({ m_Name: 'Config_water_Map02_15' }), false);
	assert.equal(isWaterGlobalConfig({ m_Name: 'Global_Water_Config', hgWaterConfigs: [] }), true);
});

test('readWaterGlobalConfig keeps the sectors that have data', () => {
	const pptr = (pathId: bigint) => ({ m_FileID: 0, m_PathID: pathId });
	const root = 'Assets/Scene/WaterData/Sector/';
	const config = readWaterGlobalConfig({
		m_Name: 'Global_Water_Config',
		scenePath: 'Assets/Scene',
		sceneCenterOffset: { x: 0, y: 0 },
		useSectorData: 1,
		sectorDataPaths: [`${root}T_-1_-1.asset`, `${root}T_-1_0.asset`],
		sectorDataAssetHashes: new BigInt64Array([-1n, -2n]),
		sectorDataExists: new Uint8Array([0, 1]),
		mapSize: 256,
		sectorSize: 128,
		flowmapPrecision: 0.5,
		lodNum: 4,
		meshNumPerLOD: 16,
		meshSize: 2,
		heightMapXZ: 128,
		heightMapY: 64,
		heightMapOffset: 0,
		hgWaterConfigs: [pptr(5n)],
		flowMap: pptr(1n),
		causticMap: pptr(2n),
		rainMap: pptr(3n),
		normalMapArray: pptr(4n),
	});
	assert.deepEqual(config.sectors, [{ x: -1, z: 0, path: `${root}T_-1_0.asset`, assetHash: 2n ** 64n - 2n }]);
	assert.deepEqual(config.surfaceConfigs, [{ fileId: 0, pathId: 5n }]);
	assert.equal(config.useSectorData, true);
	assert.equal(config.grid.meshNumPerLOD, 16);
	assert.deepEqual(config.normalMapArray, { fileId: 0, pathId: 4n });
});
