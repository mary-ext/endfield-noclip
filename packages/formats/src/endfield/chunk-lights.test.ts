import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FormatError } from '../binary/binary-reader.ts';
import { FlatBufferWriter as Writer } from '../binary/flatbuffer-writer.ts';

import { LightType, readChunkLights } from './chunk-lights.ts';
import { parseInitChunk } from './init-chunk-data.ts';

const encoder = new TextEncoder();

/**
 * builds a chunk with one light entity (a spot, or blobs of the given sizes) and one renderer-less entity
 * without the light columns, each with a name row; the light's row carries the two-blob property table
 */
const buildChunk = (options: { coreSize?: number } = {}): Uint8Array => {
	const w = new Writer();
	const lightId = (3 << 27) | 0x77;
	const otherId = (3 << 27) | 0x78;
	const ids = [lightId, otherId];
	const fields = w.chunkRoot();
	w.u32s(fields[3], ids);
	w.u8s(fields[4], [2, 2]);
	const rowLinks = w.offsets(fields[5], ids.length);

	// the light's row: name, then the property table at slot 3
	const row = w.table([4, 0, 0, 4]);
	w.link(rowLinks[0], row.at);
	const name = encoder.encode('Spot Light (4)#3_77');
	const nameVector = w.vector(1, name.length);
	w.bytes.set(name, nameVector.start);
	w.link(row.fields[0], nameVector.at);
	const properties = w.table([0, 0, 0, 4, 4, 4]);
	w.link(row.fields[3], properties.at);
	w.u32s(properties.fields[3], [0xff000000, 0xff010000]);
	w.u8s(properties.fields[4], [17, 17]);
	const valueLinks = w.offsets(properties.fields[5], 2);
	const blob = (link: number, size: number): DataView => {
		const outer = w.table([4]);
		w.link(link, outer.at);
		const inner = w.table([4]);
		w.link(outer.fields[0], inner.at);
		const bytes = w.vector(1, size);
		w.link(inner.fields[0], bytes.at);
		return new DataView(w.bytes.buffer, bytes.start, size);
	};
	const core = blob(valueLinks[0], options.coreSize ?? 236);
	const settings = blob(valueLinks[1], 448);
	if (core.byteLength === 236) {
		core.setFloat32(16, 5, true);
		[10, 20, 30].forEach((v, i) => core.setFloat32(28 + i * 4, v, true));
		[0, -1, 0].forEach((v, i) => core.setFloat32(44 + i * 4, v, true));
		[5, 2.75, 1.25].forEach((v, i) => core.setFloat32(60 + i * 4, v, true));
		core.setFloat32(76, 12, true);
		core.setUint32(88, LightType.Spot, true);
	}
	settings.setUint32(12, LightType.Spot, true);
	settings.setFloat32(20, 0.5, true);
	settings.setFloat32(36, 60, true);
	settings.setFloat32(40, 40, true);
	settings.setUint32(80, 4, true);
	settings.setUint8(92, 1);
	settings.setFloat32(112, 2, true);
	settings.setFloat32(136, 0.8, true);
	settings.setUint8(94, 1);
	settings.setFloat32(144, -1, true);
	settings.setFloat32(152, 50, true);
	settings.setFloat32(156, 30, true);
	settings.setFloat32(440, 10, true);
	settings.setFloat32(444, -1, true);

	const other = w.table([4]);
	w.link(rowLinks[1], other.at);
	const otherName = encoder.encode('P_rock#3_78');
	const otherVector = w.vector(1, otherName.length);
	w.bytes.set(otherName, otherVector.start);
	w.link(other.fields[0], otherVector.at);

	// groups: the light with columns 42 and 63 (zero-filled, as in the files), the other with a name column
	const groups: { ids: number[]; columns: [number, number][] }[] = [
		{
			ids: [lightId],
			columns: [
				[42, 244],
				[63, 448],
			],
		},
		{ ids: [otherId], columns: [[21, 64]] },
	];
	const wrapperLinks = w.offsets(fields[6], groups.length);
	const groupLinks = w.offsets(fields[7], groups.length);
	groups.forEach((group, g) => {
		const wrapper = w.table([4]);
		w.link(wrapperLinks[g], wrapper.at);
		w.u32s(wrapper.fields[0], group.ids);
		const table = w.table([16, 4, 0, 4, 4]);
		w.link(groupLinks[g], table.at);
		w.view.setUint32(table.fields[1], group.ids.length, true);
		const descriptors = w.vector(8, group.columns.length);
		w.link(table.fields[3], descriptors.at);
		group.columns.forEach(([id, stride], i) => {
			w.view.setUint16(descriptors.start + i * 8, id, true);
			w.view.setUint16(descriptors.start + i * 8 + 2, stride, true);
		});
		const blobWrapper = w.table([4]);
		w.link(table.fields[4], blobWrapper.at);
		const size = group.columns.reduce((sum, [, stride]) => sum + stride * group.ids.length, 0);
		w.link(blobWrapper.fields[0], w.vector(1, size).at);
	});
	return w.finish();
};

test('readChunkLights decodes the light entities from their rows', () => {
	const data = buildChunk();
	const lights = readChunkLights(data, parseInitChunk(data));
	assert.equal(lights.length, 1);
	const [light] = lights;
	assert.equal(light.levelTag, 3);
	assert.equal(light.name, 'Spot Light (4)#3_77');
	assert.equal(light.type, LightType.Spot);
	assert.deepEqual(light.position, [10, 20, 30]);
	assert.deepEqual(light.direction, [0, -1, 0]);
	assert.deepEqual(light.colour, [5, 2.75, 1.25]);
	assert.equal(light.range, 12);
	assert.deepEqual([light.spotAngle, light.innerSpotAngle], [60, 40]);
	assert.equal(light.specularIntensity, 0.5);
	assert.equal(light.tubeLength, 0);
	assert.deepEqual(light.distanceFade, { falloff: 30, culling: 50 });
	assert.deepEqual(light.cullingBox?.halfExtents, [2, 0, 0]);
	assert.equal(Math.fround(light.cullingBox?.falloffThreshold ?? 0), Math.fround(0.8));
	assert.equal(light.volumetricIntensity, 10);
	assert.equal(light.falloffExponent, -1);
});

test('readChunkLights rejects blobs of another size', () => {
	const data = buildChunk({ coreSize: 240 });
	assert.throws(() => readChunkLights(data, parseInitChunk(data)), FormatError);
});
