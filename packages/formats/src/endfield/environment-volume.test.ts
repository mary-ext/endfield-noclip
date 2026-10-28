import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FormatError } from '../binary/binary-reader.ts';
import { FlatBufferWriter as Writer } from '../binary/flatbuffer-writer.ts';

import {
	EnvironmentBlendMode,
	EnvironmentVolumeType,
	parsePolyLineShape,
	polygonArea,
	polygonContains,
	readEnvironmentVolume,
	readPostVolume,
} from './environment-volume.ts';
import { hasMonoComponents, MonoComponentType, readMonoObjects } from './mono-objects.ts';

// #region synthetic chunk

/** a component value: its type code and how to write it, given the element linking to it */
interface Value {
	key: number;
	code: number;
	write: (w: Writer, element: number) => void;
}

const raw = (code: number, key: number, fill: (view: DataView) => void, size: number): Value => ({
	key,
	code,
	write: (w, element) => {
		const at = w.reserve(size);
		fill(new DataView(w.bytes.buffer, at, size));
		w.link(element, at);
	},
});
const int = (key: number, value: number) => raw(2, key, (v) => v.setInt32(0, value, true), 4);
const float = (key: number, value: number) => raw(4, key, (v) => v.setFloat32(0, value, true), 4);
const bool = (key: number, value: boolean) => raw(1, key, (v) => v.setUint8(0, value ? 1 : 0), 4);
const vec3 = (key: number, value: number[]) =>
	raw(9, key, (v) => value.forEach((x, i) => v.setFloat32(i * 4, x, true)), 12);
const asset = (key: number, hash: bigint) =>
	raw(
		15,
		key,
		(v) => {
			v.setBigUint64(0, hash, true);
			v.setUint32(8, 6, true);
		},
		12,
	);
const blob = (key: number, bytes: Uint8Array): Value => ({
	key,
	code: 17,
	write: (w, element) => {
		const outer = w.table([4]);
		w.link(element, outer.at);
		const inner = w.table([4]);
		w.link(outer.fields[0], inner.at);
		w.u8s(inner.fields[0], bytes);
	},
});

interface ObjectSpec {
	id: number;
	name: string;
	mask: number;
	components: { type: number; values: Value[] }[];
}

/** a chunk FlatBuffer whose root slots 3–5 list the given tag-1 objects */
const chunk = (objects: ObjectSpec[]): Uint8Array => {
	const w = new Writer(1 << 14);
	const root = w.chunkRoot();
	w.u32s(
		root[3],
		objects.map((object) => object.id),
	);
	w.u8s(
		root[4],
		objects.map(() => 1),
	);
	const rows = w.offsets(root[5], objects.length);
	for (const [i, object] of objects.entries()) {
		const row = w.table([4, 0, 0, 8, 4]);
		w.link(rows[i], row.at);
		w.u8s(row.fields[0], new TextEncoder().encode(object.name));
		w.view.setBigUint64(row.fields[3], BigInt(object.mask), true);
		const components = w.offsets(row.fields[4], object.components.length);
		for (const [c, component] of object.components.entries()) {
			const table = w.table([4, 0, 0, 4, 4, 4]);
			w.link(components[c], table.at);
			w.view.setUint32(table.fields[0], component.type, true);
			w.u32s(
				table.fields[3],
				component.values.map((value) => value.key),
			);
			w.u8s(
				table.fields[4],
				component.values.map((value) => value.code),
			);
			const elements = w.offsets(table.fields[5], component.values.length);
			component.values.forEach((value, v) => value.write(w, elements[v]));
		}
	}
	return w.finish();
};

// #endregion

/** a polyline blob: a 10 × 20 m rectangle at (100, 50, 200), with a dummy BVH between points and heights */
const polyline = (pointCount = 4): Uint8Array => {
	const points = [
		[0, 0],
		[10, 0],
		[10, 20],
		[0, 20],
	].slice(0, pointCount);
	const length = 32 + points.length * 8 + 12 + 8;
	const view = new DataView(new ArrayBuffer(length));
	view.setUint32(0, length, true);
	[100, 50, 200, 0, 0, 0].forEach((value, i) => view.setFloat32(4 + i * 4, value, true));
	view.setUint32(28, points.length, true);
	points.flat().forEach((value, i) => view.setFloat32(32 + i * 4, value, true));
	view.setFloat32(length - 8, 30, true);
	view.setFloat32(length - 4, -5, true);
	return new Uint8Array(view.buffer);
};

const ENV = 0x0e << 24;
const PHASE = 0x059ee0e7ddeb398cn;

test('merges an environment volume from its Init and Streaming rows', () => {
	const id = (1 << 27) | 0x3688db4;
	const init = chunk([
		{
			id,
			name: 'Env_test#1_3688DB4',
			mask: 0x4001,
			components: [
				{ type: 0x1, values: [vec3(0, [1, 2, 3]), vec3(0x10000, [0, 90, 0]), vec3(0x20000, [1, 1, 1])] },
				{
					type: 0x4000,
					values: [
						int(ENV, 3),
						int(ENV | (1 << 16), 2),
						int(ENV | (2 << 16), 200),
						float(ENV | (3 << 16), 5),
						float(ENV | (4 << 16), 3),
						float(ENV | (5 << 16), 3),
						blob(ENV | (7 << 16), polyline()),
					],
				},
			],
		},
	]);
	const streaming = chunk([
		{ id, name: '', mask: 0x4001, components: [{ type: 0x4000, values: [asset(ENV | (6 << 16), PHASE)] }] },
	]);

	assert.ok(hasMonoComponents(init, BigInt(MonoComponentType.HGEnvironmentVolume)));
	assert.ok(!hasMonoComponents(init, BigInt(MonoComponentType.Volume)));
	const [object] = readMonoObjects(init, streaming);
	assert.equal(object.name, 'Env_test#1_3688DB4');
	const volume = readEnvironmentVolume(object);
	assert.ok(volume !== undefined);
	assert.equal(readPostVolume(object), undefined);
	assert.deepEqual(
		{ ...volume, shape: null },
		{
			id,
			name: 'Env_test#1_3688DB4',
			transform: { position: [1, 2, 3], rotation: [0, 90, 0], scale: [1, 1, 1] },
			volumeType: EnvironmentVolumeType.PolyLine,
			blendMode: EnvironmentBlendMode.Time,
			priority: 200,
			blendDistance: 5,
			fadeInDuration: 3,
			fadeOutDuration: 3,
			envPhase: PHASE,
			shape: null,
		},
	);
	assert.deepEqual(volume.shape?.points, [
		[100, 200],
		[110, 200],
		[110, 220],
		[100, 220],
	]);
	assert.equal(volume.shape?.height, 30);
	assert.equal(volume.shape?.baseHeightOffset, -5);
});

test('reads a global post volume and its profile reference', () => {
	const VOLUME = 0x0f << 24;
	const id = 0x2e9067d;
	const init = chunk([
		{
			id,
			name: 'Global Volume#0_2E9067D',
			mask: 0x8001,
			components: [
				{
					type: 0x8000,
					values: [
						bool(VOLUME, true),
						float(VOLUME | (1 << 16), 0),
						float(VOLUME | (2 << 16), 0),
						float(VOLUME | (3 << 16), 1),
					],
				},
			],
		},
	]);
	const streaming = chunk([
		{ id, name: '', mask: 0x8001, components: [{ type: 0x8000, values: [asset(VOLUME | (4 << 16), 42n)] }] },
	]);
	const post = readPostVolume(readMonoObjects(init, streaming)[0]);
	assert.deepEqual(post, {
		id,
		name: 'Global Volume#0_2E9067D',
		transform: null,
		isGlobal: true,
		priority: 0,
		blendDistance: 0,
		weight: 1,
		profile: 42n,
		box: null,
	});
});

test('leaves the phase unset without a Streaming row, and rejects mismatched pairs', () => {
	const spec = (id: number): ObjectSpec => ({
		id,
		name: 'Global Env#0_5C15F3',
		mask: 0x4001,
		components: [{ type: 0x4000, values: [int(ENV, 0), int(ENV | (2 << 16), 100)] }],
	});
	const volume = readEnvironmentVolume(readMonoObjects(chunk([spec(1)]), null)[0]);
	assert.equal(volume?.volumeType, EnvironmentVolumeType.Global);
	assert.equal(volume?.priority, 100);
	assert.equal(volume?.envPhase, null);
	assert.equal(volume?.shape, null);
	assert.throws(() => readMonoObjects(chunk([spec(1)]), chunk([spec(2)])), FormatError);
});

test('polygon helpers and shape framing', () => {
	const shape = parsePolyLineShape(polyline());
	assert.equal(polygonArea(shape.points), 200);
	assert.ok(polygonContains(shape.points, 105, 210));
	assert.ok(!polygonContains(shape.points, 115, 210));
	const truncated = polyline().slice(0, 40);
	new DataView(truncated.buffer).setUint32(0, 40, true);
	assert.throws(() => parsePolyLineShape(truncated), FormatError);
});
