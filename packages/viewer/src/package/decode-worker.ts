/**
 * decode worker: undoes the blob codec (zstd) and turns height pages, instance blocks and geometry (meshopt)
 * into GPU-ready arrays, transferring the results back.
 *
 * @module
 */

import {
	decodeGeometryBlob,
	decodeHeightPage,
	decodeInstanceBlock,
} from '@endfield-noclip/package-format/codec';
import {
	BlobCodec,
	GEOMETRY_VERTEX_FORMATS,
	type GeometryBlob,
	GeometryFlags,
	type GeometryStream,
	GeometryStreamFlags,
	GeometryVertexFormat,
	VertexAttribute,
} from '@endfield-noclip/package-format/format';

import { decompress } from 'fzstd';
import { MeshoptDecoder } from 'meshoptimizer/decoder';

import { buildInstanceRows } from '../render/instance-rows.ts';

import type { DecodedGeometry, DecodeRequest, DecodeResponse } from './decode-protocol.ts';

const unwrap = (data: ArrayBuffer, codec: BlobCodec, rawLength: number): Uint8Array<ArrayBuffer> => {
	const stored = new Uint8Array(data);
	switch (codec) {
		case BlobCodec.None: {
			return stored;
		}
		case BlobCodec.Zstd: {
			const raw = new Uint8Array(rawLength);
			decompress(stored, raw);
			return raw;
		}
		default: {
			throw new Error(`unknown blob codec ${String(codec)}`);
		}
	}
};

/** @returns the bytes' buffer if they span all of it, else a copy, so it can be transferred */
const ownBuffer = (bytes: Uint8Array<ArrayBuffer>): ArrayBuffer => {
	if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
		return bytes.buffer;
	}
	return bytes.slice().buffer;
};

let meshoptReady = false;

const findStream = (blob: GeometryBlob, attribute: number): GeometryStream | undefined => {
	return blob.streams.find((candidate) => candidate.attribute === attribute);
};

/** @returns the stream's vertices in its stored format */
const decodeVertices = (blob: GeometryBlob, stream: GeometryStream): Uint8Array<ArrayBuffer> => {
	const size = GEOMETRY_VERTEX_FORMATS[stream.format].size;
	const target = new Uint8Array(blob.vertexCount * size);
	MeshoptDecoder.decodeVertexBuffer(target, blob.vertexCount, size, stream.data);
	return target;
};

/** @returns an attribute's vertices, which must be stored in `format`, or `null` if the mesh has none */
const decodeAttribute = (
	blob: GeometryBlob,
	attribute: number,
	format: GeometryVertexFormat,
): ArrayBuffer | null => {
	const stream = findStream(blob, attribute);
	if (stream === undefined) {
		return null;
	}
	if (stream.format !== format) {
		throw new Error(`geometry attribute ${attribute} has format ${stream.format}, expected ${format}`);
	}
	return decodeVertices(blob, stream).buffer;
};

/**
 * decodes the normals to plain `snorm16x2` octahedral pairs. the game's 10-bit normals are stored as their
 * integers with a dequantization scale, which is applied here so every mesh shares one vertex format
 */
const decodeNormals = (blob: GeometryBlob): ArrayBuffer | null => {
	const stream = findStream(blob, VertexAttribute.Normal);
	if (stream === undefined) {
		return null;
	}
	if (stream.format !== GeometryVertexFormat.Snorm16x2) {
		throw new Error(`geometry normals have format ${stream.format}, expected snorm16x2`);
	}
	const raw = decodeVertices(blob, stream);
	if ((stream.flags & GeometryStreamFlags.Dequantize) === 0) {
		return raw.buffer;
	}
	const values = new Int16Array(raw.buffer);
	for (let i = 0; i < values.length; i++) {
		const k = i & 1;
		const value = (stream.offset[k] + (values[i] / 32_767) * stream.scale[k]) * 32_767;
		values[i] = Math.max(-32_767, Math.min(32_767, Math.round(value)));
	}
	return raw.buffer;
};

/** decodes UV set 0 to `float32x2` whatever its stored format, so one pipeline layout fits every mesh */
const decodeUvs = (blob: GeometryBlob): ArrayBuffer | null => {
	const stream = findStream(blob, VertexAttribute.TexCoord0);
	if (stream === undefined) {
		return null;
	}
	const vertexCount = blob.vertexCount;
	const raw = decodeVertices(blob, stream);
	const out = new Float32Array(vertexCount * 2);
	switch (stream.format) {
		case GeometryVertexFormat.Float32x2: {
			out.set(new Float32Array(raw.buffer));
			break;
		}
		case GeometryVertexFormat.Unorm16x2: {
			const values = new Uint16Array(raw.buffer);
			for (let i = 0; i < values.length; i++) {
				out[i] = values[i] / 65_535;
			}
			break;
		}
		case GeometryVertexFormat.Snorm8x4: {
			const values = new Int8Array(raw.buffer);
			for (let v = 0; v < vertexCount; v++) {
				out[v * 2] = Math.max(-1, values[v * 4] / 127);
				out[v * 2 + 1] = Math.max(-1, values[v * 4 + 1] / 127);
			}
			break;
		}
		default: {
			return null;
		}
	}
	if ((stream.flags & GeometryStreamFlags.Dequantize) !== 0) {
		for (let v = 0; v < vertexCount; v++) {
			out[v * 2] = stream.offset[0] + out[v * 2] * stream.scale[0];
			out[v * 2 + 1] = stream.offset[1] + out[v * 2 + 1] * stream.scale[1];
		}
	}
	return out.buffer;
};

const decodeGeometry = (
	id: number,
	raw: Uint8Array,
): { response: DecodedGeometry; transfer: Transferable[] } => {
	const blob = decodeGeometryBlob(raw);
	const position = findStream(blob, VertexAttribute.Position);
	const positions = decodeAttribute(blob, VertexAttribute.Position, GeometryVertexFormat.Unorm16x4);
	if (position === undefined || positions === null) {
		throw new Error('geometry has no positions');
	}
	const normals = decodeNormals(blob);
	const uvs = decodeUvs(blob);
	const tangents = decodeAttribute(blob, VertexAttribute.Tangent, GeometryVertexFormat.Snorm8x4);
	const indexSize = blob.flags & GeometryFlags.IndexU32 ? 4 : 2;
	// index buffers are bound whole and must be a multiple of 4 bytes
	const indices = new Uint8Array(Math.ceil((blob.indexCount * indexSize) / 4) * 4);
	MeshoptDecoder.decodeIndexBuffer(indices, blob.indexCount, indexSize, blob.indices);
	const transfer: Transferable[] = [positions, indices.buffer];
	for (const extra of [normals, uvs, tangents]) {
		if (extra !== null) {
			transfer.push(extra);
		}
	}
	return {
		response: {
			id,
			kind: 'geometry',
			vertexCount: blob.vertexCount,
			indexSize,
			indices: indices.buffer,
			positionOffset: position.offset,
			positionScale: position.scale,
			positions,
			normals,
			uvs,
			tangents,
			submeshes: blob.submeshes.map(({ firstIndex, indexCount, baseVertex }) => ({
				firstIndex,
				indexCount,
				baseVertex,
			})),
		},
		transfer,
	};
};

const handle = (request: DecodeRequest): { response: DecodeResponse; transfer: Transferable[] } => {
	const raw = unwrap(request.data, request.codec, request.rawLength);
	switch (request.kind) {
		case 'heights': {
			const { side, samples } = decodeHeightPage(raw);
			// pad to a whole number of 32-bit words for the storage buffer upload
			const padded = new Uint16Array(samples.length + (samples.length & 1));
			padded.set(samples);
			return {
				response: { id: request.id, kind: 'heights', side, samples: padded },
				transfer: [padded.buffer],
			};
		}
		case 'instances': {
			const built = buildInstanceRows(decodeInstanceBlock(raw), request.rowKinds);
			return {
				response: { id: request.id, kind: 'instances', ...built },
				transfer: [built.rows.buffer, built.cull.buffer, built.runs.buffer],
			};
		}
		case 'geometry': {
			return decodeGeometry(request.id, raw);
		}
		case 'texture': {
			const data = ownBuffer(raw);
			return { response: { id: request.id, kind: 'texture', data }, transfer: [data] };
		}
	}
};

self.addEventListener('message', (event: MessageEvent<DecodeRequest>) => {
	const request = event.data;
	if (request.kind === 'geometry' && !meshoptReady) {
		// the decoder compiles its wasm asynchronously; queue behind it
		void MeshoptDecoder.ready.then(() => {
			meshoptReady = true;
			self.dispatchEvent(new MessageEvent('message', { data: request }));
		});
		return;
	}
	try {
		const { response, transfer } = handle(request);
		// oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker posting to its owner
		self.postMessage(response, { transfer });
	} catch (err) {
		const response: DecodeResponse = { id: request.id, kind: 'error', message: String(err) };
		// oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker posting to its owner
		self.postMessage(response);
	}
});
