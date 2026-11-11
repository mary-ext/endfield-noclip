import { BlobCodec } from '@endfield-noclip/package-format/blobs';
import {
	decodeGeometryBlob,
	GEOMETRY_VERTEX_FORMATS,
	type GeometryBlob,
	GeometryFlags,
	type GeometryStream,
	GeometryStreamFlags,
	GeometryVertexFormat,
	type SkinAnimation,
	VertexAttribute,
} from '@endfield-noclip/package-format/geometry';
import { decodeInstanceBlock } from '@endfield-noclip/package-format/instances';
import {
	decodeHeightPage,
	decodeSplatPage,
	decodeSurfacePage,
} from '@endfield-noclip/package-format/terrain';

import { MeshoptDecoder } from 'meshoptimizer/decoder';

import { buildInstanceRows } from '../content/instance-rows.ts';

import type {
	DecodedGeometry,
	DecodedSkin,
	DecodeRequest,
	DecodeResponse,
	UvTransform,
	WorkerMessage,
} from './decode-protocol.ts';
import { decompressZstd, zstdReady } from './zstd.ts';

/** buffers sent by the pool, by id, until no request reads them */
const buffers = new Map<number, ArrayBuffer>();

/** a request's blob with its codec undone */
interface Unwrapped {
	raw: Uint8Array<ArrayBuffer>;
	/** nothing else reads {@link raw}'s buffer, so it may be transferred */
	owned: boolean;
}

const unwrap = (request: DecodeRequest): Unwrapped => {
	const data = buffers.get(request.buffer);
	if (request.last) {
		buffers.delete(request.buffer);
	}
	if (data === undefined) {
		throw new Error(`decode request reads buffer ${request.buffer}, which this worker doesn't hold`);
	}
	const stored = new Uint8Array(data, request.offset, request.length);
	switch (request.codec) {
		case BlobCodec.None: {
			return { raw: stored, owned: request.last };
		}
		case BlobCodec.Zstd: {
			return { raw: decompressZstd(stored, request.rawLength), owned: true };
		}
		default: {
			throw new Error(`unknown blob codec ${String(request.codec)}`);
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

/** the decoders compile their wasm asynchronously; requests wait for it */
const wasmReady = Promise.all([MeshoptDecoder.ready, zstdReady]);

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

type DecodedUvs = Pick<DecodedGeometry, 'uvs' | 'uvFormat' | 'uvTransforms'>;

const IDENTITY_UV: UvTransform = [1, 1, 0, 0];

/** one UV set as decoded, before both sets agree on a format */
interface UvSet {
	data: ArrayBuffer;
	format: 'unorm16x2' | 'float32x2';
	transform: UvTransform;
}

/**
 * decodes one UV set: 16-bit UVs as stored, with their dequantization (most meshes; the shader applies it),
 * and anything else as `float32x2`
 */
const decodeUvSet = (blob: GeometryBlob, attribute: number): UvSet | null => {
	const stream = findStream(blob, attribute);
	if (stream === undefined) {
		return null;
	}
	const raw = decodeVertices(blob, stream);
	if (stream.format === GeometryVertexFormat.Unorm16x2) {
		const dequantize = (stream.flags & GeometryStreamFlags.Dequantize) !== 0;
		return {
			data: ownBuffer(raw),
			format: 'unorm16x2',
			transform: dequantize
				? [stream.scale[0], stream.scale[1], stream.offset[0], stream.offset[1]]
				: IDENTITY_UV,
		};
	}
	const data = decodeFloatUvs(blob, stream, raw);
	return data === null ? null : { data, format: 'float32x2', transform: IDENTITY_UV };
};

/** @returns a `unorm16x2` set as dequantized `float32x2` */
const widenUvSet = (set: UvSet): UvSet => {
	const values = new Uint16Array(set.data);
	const out = new Float32Array(values.length);
	const [su, sv, ou, ov] = set.transform;
	for (let i = 0; i < values.length; i += 2) {
		out[i] = ou + (values[i] / 65_535) * su;
		out[i + 1] = ov + (values[i + 1] / 65_535) * sv;
	}
	return { data: out.buffer, format: 'float32x2', transform: IDENTITY_UV };
};

/**
 * decodes UV sets 0 and 1 into one vertex format, so a pipeline per format covers both: a 16-bit set paired
 * with a float one is widened
 */
const decodeUvs = (blob: GeometryBlob): DecodedUvs => {
	let sets = [decodeUvSet(blob, VertexAttribute.TexCoord0), decodeUvSet(blob, VertexAttribute.TexCoord0 + 1)];
	if (sets.some((set) => set?.format === 'float32x2')) {
		sets = sets.map((set) => (set?.format === 'unorm16x2' ? widenUvSet(set) : set));
	}
	const [uv0, uv1] = sets;
	return {
		uvs: [uv0?.data ?? null, uv1?.data ?? null],
		uvFormat: uv0?.format ?? uv1?.format ?? 'float32x2',
		// a mesh without UV set 1 draws it from set 0 (`ResidentGeometry.vertices`), with set 0's dequantization
		uvTransforms: [uv0?.transform ?? IDENTITY_UV, uv1?.transform ?? uv0?.transform ?? IDENTITY_UV],
	};
};

/** @returns a UV set as dequantized `float32x2`, or `null` for a format the viewer doesn't read */
const decodeFloatUvs = (
	blob: GeometryBlob,
	stream: GeometryStream,
	raw: Uint8Array<ArrayBuffer>,
): ArrayBuffer | null => {
	const vertexCount = blob.vertexCount;
	const out = new Float32Array(vertexCount * 2);
	switch (stream.format) {
		case GeometryVertexFormat.Float32x2: {
			out.set(new Float32Array(raw.buffer, raw.byteOffset, vertexCount * 2));
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

/**
 * decodes the vertex colours to `unorm8x4`, so every mesh shares one vertex format. the shaders that read
 * them want weights in [0, 1], so wider half-float colours are clamped
 */
const decodeColors = (blob: GeometryBlob): ArrayBuffer | null => {
	const stream = findStream(blob, VertexAttribute.Color);
	if (stream === undefined) {
		return null;
	}
	const raw = decodeVertices(blob, stream);
	switch (stream.format) {
		case GeometryVertexFormat.Unorm8x4: {
			return raw.buffer;
		}
		case GeometryVertexFormat.Float16x4: {
			const view = new DataView(raw.buffer);
			const out = new Uint8Array(raw.length / 2);
			for (let i = 0; i < out.length; i++) {
				out[i] = Math.round(Math.min(Math.max(view.getFloat16(i * 2, true), 0), 1) * 255);
			}
			return out.buffer;
		}
		default: {
			throw new Error(`geometry colours have format ${stream.format}, expected unorm8x4 or float16x4`);
		}
	}
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
	const { uvs, uvFormat, uvTransforms } = decodeUvs(blob);
	const tangents = decodeAttribute(blob, VertexAttribute.Tangent, GeometryVertexFormat.Snorm8x4);
	const colors = decodeColors(blob);
	const indexSize = blob.flags & GeometryFlags.IndexU32 ? 4 : 2;
	// index buffers are bound whole and must be a multiple of 4 bytes
	const indices = new Uint8Array(Math.ceil((blob.indexCount * indexSize) / 4) * 4);
	MeshoptDecoder.decodeIndexBuffer(indices, blob.indexCount, indexSize, blob.indices);
	const skin =
		blob.animation === null
			? null
			: decodeSkin(blob, blob.animation, position, { positions, normals, tangents });
	const transfer: Transferable[] = [positions, indices.buffer];
	for (const extra of [normals, ...uvs, tangents, colors, skin?.source ?? null, skin?.matrices ?? null]) {
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
			// an animation's output is quantized to the box its frames lie in
			positionOffset: blob.animation?.offset ?? position.offset,
			positionScale: blob.animation?.scale ?? position.scale,
			positions,
			normals,
			uvs,
			uvFormat,
			uvTransforms,
			tangents,
			colors,
			submeshes: blob.submeshes.map(({ firstIndex, indexCount, baseVertex }) => ({
				firstIndex,
				indexCount,
				baseVertex,
			})),
			skin,
		},
		transfer,
	};
};

/** gathers the bind pose's streams, the weights and bones into the source an animation reads */
const decodeSkin = (
	blob: GeometryBlob,
	animation: SkinAnimation,
	position: GeometryStream,
	bind: { positions: ArrayBuffer; normals: ArrayBuffer | null; tangents: ArrayBuffer | null },
): DecodedSkin => {
	const weights = decodeAttribute(blob, VertexAttribute.BlendWeight, GeometryVertexFormat.Unorm16x4);
	const bones = decodeAttribute(blob, VertexAttribute.BlendIndices, GeometryVertexFormat.Uint8x4);
	if (weights === null || bones === null) {
		throw new Error('animated geometry has no bone weights or indices');
	}
	const parts = [bind.positions, bind.normals, bind.tangents, weights, bones];
	const words: number[] = [];
	let size = 0;
	for (const part of parts) {
		words.push(part === null ? -1 : size / 4);
		size += part?.byteLength ?? 0;
	}
	const source = new Uint8Array(size);
	for (const [i, part] of parts.entries()) {
		if (part !== null) {
			source.set(new Uint8Array(part), words[i] * 4);
		}
	}
	return {
		source: source.buffer,
		normalWord: words[1],
		tangentWord: words[2],
		weightWord: words[3],
		boneWord: words[4],
		bindOffset: position.offset,
		bindScale: position.scale,
		boneCount: animation.boneCount,
		frameCount: animation.frameCount,
		frameRate: animation.frameRate,
		matrices: animation.matrices.slice().buffer,
	};
};

const handle = (request: DecodeRequest): { response: DecodeResponse; transfer: Transferable[] } => {
	const unwrapped = unwrap(request);
	const raw = unwrapped.raw;
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
		case 'surface': {
			const page = decodeSurfacePage(raw);
			// copies, so each image is a buffer of its own for the upload
			const albedo = page.albedo.slice().buffer;
			const normal = page.normal.slice().buffer;
			return {
				response: { id: request.id, kind: 'surface', side: page.side, albedo, normal },
				transfer: [albedo, normal],
			};
		}
		case 'splat': {
			const page = decodeSplatPage(raw);
			const control = page.control.slice().buffer;
			const tint = page.tint.slice().buffer;
			const index = page.index.slice().buffer;
			return {
				response: {
					id: request.id,
					kind: 'splat',
					side: page.side,
					cells: page.cells,
					control,
					tint,
					index,
				},
				transfer: [control, tint, index],
			};
		}
		case 'layer':
		case 'texture':
		case 'irradiance': {
			// stored as the GPU reads them
			// copied where other requests read the same buffer
			const data = unwrapped.owned ? ownBuffer(raw) : raw.slice().buffer;
			return { response: { id: request.id, kind: request.kind, data }, transfer: [data] };
		}
		case 'instances': {
			const built = buildInstanceRows(decodeInstanceBlock(raw), request.rowKinds ?? []);
			return {
				response: { id: request.id, kind: 'instances', ...built },
				transfer: [
					built.rows.buffer,
					built.cull.buffer,
					built.runs.buffer,
					built.placements.buffer,
					...(built.spins === null
						? []
						: [
								built.spins.rows.buffer,
								built.spins.values.buffer,
								built.spins.base.buffer,
								built.spins.runs.buffer,
							]),
					...(built.floaters === null ? [] : [built.floaters.rows.buffer, built.floaters.volumes.buffer]),
					...(built.rides === null
						? []
						: [
								built.rides.rows.buffer,
								built.rides.pathOf.buffer,
								built.rides.base.buffer,
								built.rides.runs.buffer,
								...built.rides.paths.map((path) => path.offsets.buffer),
							]),
				],
			};
		}
		case 'geometry': {
			return decodeGeometry(request.id, raw);
		}
	}
};

const decode = (request: DecodeRequest): void => {
	try {
		const { response, transfer } = handle(request);
		// oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker posting to its owner
		self.postMessage(response, { transfer });
	} catch (err) {
		const response: DecodeResponse = { id: request.id, kind: 'error', message: String(err) };
		// oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker posting to its owner
		self.postMessage(response);
	}
};

self.addEventListener('message', async (event: MessageEvent<WorkerMessage>) => {
	const message = event.data;
	// every message waits, so they're handled in the order they came
	await wasmReady;
	switch (message.type) {
		case 'buffer': {
			buffers.set(message.buffer, message.data);
			return;
		}
		case 'release': {
			buffers.delete(message.buffer);
			return;
		}
		case 'decode': {
			decode(message.request);
			return;
		}
	}
});
