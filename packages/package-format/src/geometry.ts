import {
	align4,
	viewOf,
	checkHeader,
	enumGuard,
	checkLength,
	writeHeader,
	type HeaderShape,
} from './binary.ts';
import type { UnconvertedEntry } from './entries.ts';
import { PackageFormatError } from './errors.ts';
import type { Bounds } from './values.ts';

/**
 * what a geometry stream holds. the numbering is Unity's shader channel order, so `TexCoord0 + n` is UV set
 * `n` (the {@link TextureSlot.uv} of a material slot)
 */
export const VertexAttribute = {
	/**
	 * `unorm16x4`, always dequantized: `position = offset + value.xyz · scale` (`w` is 0). the mesh's own frame
	 * (Unity, left-handed)
	 */
	Position: 0,
	/**
	 * `snorm16x2`: an octahedral unit vector `(x, y)`, dequantized first when the stream is flagged (the game's
	 * 10-bit normals are stored as their integers with a scale of 32767/511). decode in the shader: `n = (x, y,
	 * 1 - |x| - |y|)`; where `n.z < 0`, `n.xy = (1 - |n.yx|) · sign(n.xy)` (sign of 0 taken as +1); normalize
	 */
	Normal: 1,
	/**
	 * `snorm8x4`: `xy` is the tangent, octahedral like {@link VertexAttribute.Normal}; `z` is the bitangent sign
	 * (±1). `bitangent = cross(normal, tangent) · sign`, in the mesh's frame; like Unity, multiply by the sign
	 * of the object-to-world determinant (negative under the viewer's mirroring root). MikkTSpace tangents over
	 * UV set {@link GeometryEntry.tangentUv} unless the source mesh had its own
	 */
	Tangent: 2,
	/** `unorm8x4`, or `float16x4` when the source has values outside `[0, 1]` */
	Color: 3,
	/**
	 * UV sets 0–7: `unorm16x2` dequantized like positions when that keeps the error below 2^-13 (a span of at
	 * most 16), else `float32x2`; `snorm8x4` or `unorm8x4` where the source stores 8-bit normalized values (the
	 * game's UV2/UV3 on foliage), and `float32x4` for sets of more than two components. UVs are the game's,
	 * unflipped: texture row 0 is `v = 0`, matching how texel data is stored
	 */
	TexCoord0: 4,
	TexCoord7: 11,
} as const;

/** a {@link VertexAttribute} value; UV sets fill the range `TexCoord0`…`TexCoord7` */
export type VertexAttribute = number;

/**
 * a geometry stream's element format, indexing {@link GEOMETRY_VERTEX_FORMATS}. every format is a whole
 * WebGPU vertex format, and each stream is its own vertex buffer (stride = the format's size)
 */
export const GeometryVertexFormat = {
	Unorm16x4: 0,
	Snorm16x2: 1,
	Snorm8x4: 2,
	Unorm8x4: 3,
	Float16x4: 4,
	Unorm16x2: 5,
	Float32x2: 6,
	Float32x4: 7,
} as const;

export type GeometryVertexFormat = (typeof GeometryVertexFormat)[keyof typeof GeometryVertexFormat];

/** WebGPU name and byte size of each {@link GeometryVertexFormat} */
export const GEOMETRY_VERTEX_FORMATS: Record<GeometryVertexFormat, { gpu: string; size: number }> = {
	[GeometryVertexFormat.Unorm16x4]: { gpu: 'unorm16x4', size: 8 },
	[GeometryVertexFormat.Snorm16x2]: { gpu: 'snorm16x2', size: 4 },
	[GeometryVertexFormat.Snorm8x4]: { gpu: 'snorm8x4', size: 4 },
	[GeometryVertexFormat.Unorm8x4]: { gpu: 'unorm8x4', size: 4 },
	[GeometryVertexFormat.Float16x4]: { gpu: 'float16x4', size: 8 },
	[GeometryVertexFormat.Unorm16x2]: { gpu: 'unorm16x2', size: 4 },
	[GeometryVertexFormat.Float32x2]: { gpu: 'float32x2', size: 8 },
	[GeometryVertexFormat.Float32x4]: { gpu: 'float32x4', size: 16 },
};

/** geometry blob flag bits */
export const GeometryFlags = {
	/** indices are u32; otherwise u16 */
	IndexU32: 1 << 0,
	/** the tangent stream was generated (MikkTSpace) rather than taken from the source mesh */
	GeneratedTangents: 1 << 1,
} as const;

/** geometry stream flag bits */
export const GeometryStreamFlags = {
	/**
	 * apply `offset + value · scale` per component (up to three) to the value as the GPU reads it (normalized
	 * formats already in [0, 1] or [-1, 1]); position, unorm16 UVs and the game's packed normals use it
	 */
	Dequantize: 1 << 0,
} as const;

/**
 * a geometry blob's container. payloads are meshopt-encoded (meshoptimizer ≥ 1.0 codec, version 1): decode
 * each stream with `MeshoptDecoder.decodeVertexBuffer(target, vertexCount, stride, data)` and the indices
 * with `decodeIndexBuffer(target, indexCount, indexSize, data)`. no meshopt filters are used, so the decoded
 * bytes are the GPU vertex buffers as they are
 */
export interface GeometryBlob {
	/** {@link GeometryFlags} */
	flags: number;
	vertexCount: number;
	/** total indices over all submeshes */
	indexCount: number;
	streams: GeometryStream[];
	/** ranges of the index buffer; indices are local to each submesh's vertex range */
	submeshes: GeometrySubmesh[];
	/**
	 * meshopt-encoded index buffer of `indexCount` u16 or u32 ({@link GeometryFlags.IndexU32}) triangle-list
	 * indices
	 */
	indices: Uint8Array;
}

/** one vertex buffer of a {@link GeometryBlob} */
export interface GeometryStream {
	/** {@link VertexAttribute} */
	attribute: VertexAttribute;
	format: GeometryVertexFormat;
	/** {@link GeometryStreamFlags} */
	flags: number;
	/** dequantization for {@link GeometryStreamFlags.Dequantize}: `offset + value · scale`, per component */
	offset: [x: number, y: number, z: number];
	scale: [x: number, y: number, z: number];
	/** meshopt-encoded `vertexCount × stride` bytes */
	data: Uint8Array;
}

/**
 * a submesh: what a {@link ChainDraw.submesh} draws. one `drawIndexed(indexCount, …, firstIndex, baseVertex)`;
 * the submesh's vertices are `[baseVertex, baseVertex + vertexCount)`, contiguous and owned by it alone, so
 * the indices fit u16 whenever every submesh has at most 65,536 vertices
 */
export interface GeometrySubmesh {
	firstIndex: number;
	indexCount: number;
	baseVertex: number;
	vertexCount: number;
	/** the submesh's local bounds, from the game */
	bounds: Bounds;
}

/** `tables/geometries.json`; entry `i` has id `i` */
export interface GeometryTable {
	entries: GeometryEntry[];
}

/** one mesh asset */
export type GeometryEntry = UnconvertedEntry | ReadyGeometry;

/** a converted mesh */
export interface ReadyGeometry {
	id: number;
	status: 'ready';
	/** the {@link BlobKind.Geometry} blob */
	blob: number;
	/** local bounds of the vertices */
	bounds: Bounds;
	vertexCount: number;
	indexCount: number;
	submeshCount: number;
	/** bit `a` set when the blob has a stream for {@link VertexAttribute} `a` */
	attributes: number;
	/** the UV set tangents were generated from, or `null` without generated tangents */
	tangentUv: number | null;
}

/** 'EFGM' */
const GEOMETRY_HEADER: HeaderShape = {
	magic: 0x4d_47_46_45,
	version: 1,
	size: 32,
	label: 'geometry blob',
};

const GEOMETRY_HEADER_SIZE = GEOMETRY_HEADER.size;

const GEOMETRY_STREAM_SIZE = 32;

const GEOMETRY_SUBMESH_SIZE = 40;

const isGeometryVertexFormat = enumGuard(GeometryVertexFormat);

/**
 * geometry blob: 32-byte header (`'EFGM'`, u16 version, u16 flags, u32 vertexCount, u32 indexCount, u16
 * streamCount, u16 submeshCount, u32 index payload length, u32×2 0), 32-byte stream records (u8 attribute, u8
 * format, u8 flags, u8 0, u32 payload length, f32×3 offset, f32×3 scale), 40-byte submesh records (u32
 * firstIndex, u32 indexCount, u32 baseVertex, u32 vertexCount, f32×3 min, f32×3 max), then the stream
 * payloads in record order and the index payload, each starting 4-byte aligned.
 *
 * @param blob the container; payloads are stored as given
 * @returns the encoded blob
 * @throws {RangeError} on more than 65,535 streams or submeshes
 */
export const encodeGeometryBlob = (blob: GeometryBlob): Uint8Array => {
	if (blob.streams.length > 0xff_ff || blob.submeshes.length > 0xff_ff) {
		throw new RangeError('geometry has more than 65,535 streams or submeshes');
	}
	const tables =
		GEOMETRY_HEADER_SIZE +
		blob.streams.length * GEOMETRY_STREAM_SIZE +
		blob.submeshes.length * GEOMETRY_SUBMESH_SIZE;
	const size =
		blob.streams.reduce((sum, stream) => sum + align4(stream.data.byteLength), tables) +
		align4(blob.indices.byteLength);
	const out = new Uint8Array(size);
	const view = viewOf(out);
	writeHeader(view, GEOMETRY_HEADER);
	view.setUint16(6, blob.flags, true);
	view.setUint32(8, blob.vertexCount, true);
	view.setUint32(12, blob.indexCount, true);
	view.setUint16(16, blob.streams.length, true);
	view.setUint16(18, blob.submeshes.length, true);
	view.setUint32(20, blob.indices.byteLength, true);

	let at = GEOMETRY_HEADER_SIZE;
	for (const stream of blob.streams) {
		view.setUint8(at, stream.attribute);
		view.setUint8(at + 1, stream.format);
		view.setUint8(at + 2, stream.flags);
		view.setUint32(at + 4, stream.data.byteLength, true);
		for (let i = 0; i < 3; i++) {
			view.setFloat32(at + 8 + i * 4, stream.offset[i], true);
			view.setFloat32(at + 20 + i * 4, stream.scale[i], true);
		}
		at += GEOMETRY_STREAM_SIZE;
	}
	for (const submesh of blob.submeshes) {
		view.setUint32(at, submesh.firstIndex, true);
		view.setUint32(at + 4, submesh.indexCount, true);
		view.setUint32(at + 8, submesh.baseVertex, true);
		view.setUint32(at + 12, submesh.vertexCount, true);
		for (let i = 0; i < 3; i++) {
			view.setFloat32(at + 16 + i * 4, submesh.bounds.min[i], true);
			view.setFloat32(at + 28 + i * 4, submesh.bounds.max[i], true);
		}
		at += GEOMETRY_SUBMESH_SIZE;
	}
	for (const stream of blob.streams) {
		out.set(stream.data, at);
		at += align4(stream.data.byteLength);
	}
	out.set(blob.indices, at);
	return out;
};

/**
 * @param data a geometry blob
 * @returns its container; payloads are views into `data`
 * @throws {PackageFormatError} on a bad header, an unknown vertex format or a length mismatch
 */
export const decodeGeometryBlob = (data: Uint8Array): GeometryBlob => {
	const view = viewOf(data);
	checkHeader(view, GEOMETRY_HEADER);
	const streamCount = view.getUint16(16, true);
	const submeshCount = view.getUint16(18, true);
	const indexLength = view.getUint32(20, true);
	let at = GEOMETRY_HEADER_SIZE;
	let payloadAt =
		GEOMETRY_HEADER_SIZE + streamCount * GEOMETRY_STREAM_SIZE + submeshCount * GEOMETRY_SUBMESH_SIZE;
	if (payloadAt > data.byteLength) {
		throw new PackageFormatError('geometry blob tables run past its end');
	}

	const streams: GeometryStream[] = [];
	for (let s = 0; s < streamCount; s++) {
		const format = view.getUint8(at + 1);
		if (!isGeometryVertexFormat(format)) {
			throw new PackageFormatError(`geometry stream ${s} has unknown vertex format ${format}`);
		}
		const length = view.getUint32(at + 4, true);
		if (payloadAt + length > data.byteLength) {
			throw new PackageFormatError(`geometry stream ${s} runs past the blob`);
		}
		const f = (offset: number): number => view.getFloat32(at + offset, true);
		streams.push({
			attribute: view.getUint8(at),
			format,
			flags: view.getUint8(at + 2),
			offset: [f(8), f(12), f(16)],
			scale: [f(20), f(24), f(28)],
			data: data.subarray(payloadAt, payloadAt + length),
		});
		payloadAt += align4(length);
		at += GEOMETRY_STREAM_SIZE;
	}
	const submeshes: GeometrySubmesh[] = [];
	for (let s = 0; s < submeshCount; s++) {
		const f = (offset: number): number => view.getFloat32(at + offset, true);
		submeshes.push({
			firstIndex: view.getUint32(at, true),
			indexCount: view.getUint32(at + 4, true),
			baseVertex: view.getUint32(at + 8, true),
			vertexCount: view.getUint32(at + 12, true),
			bounds: { min: [f(16), f(20), f(24)], max: [f(28), f(32), f(36)] },
		});
		at += GEOMETRY_SUBMESH_SIZE;
	}
	checkLength(data, payloadAt + align4(indexLength), 'geometry blob');
	return {
		flags: view.getUint16(6, true),
		vertexCount: view.getUint32(8, true),
		indexCount: view.getUint32(12, true),
		streams,
		submeshes,
		indices: data.subarray(payloadAt, payloadAt + indexLength),
	};
};
