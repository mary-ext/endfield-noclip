/**
 * Unity `Mesh` (class 43) decoder for Unity 2021.3 as shipped by Endfield: vertex channels/streams, the index
 * buffer and submeshes, out of a TypeTree-decoded object plus its `m_StreamData` payload.
 *
 * channel/stream layout and the vertex format enum follow AssetStudio/AnimeStudio's `Mesh.cs` (MIT). most
 * Endfield meshes pack the normal into one 32-bit word, flagged by the dimension byte's high nibble
 * ({@link unpackHgNormal}, `docs/game-data/assets.md#mesh`).
 */

import { FormatError } from '../binary/binary-reader.ts';

import type { TypeTreeObject } from './type-tree.ts';
import {
	type Aabb,
	aabbField,
	arrayField,
	booleanField,
	bytesField,
	isObject,
	numberField,
	objectField,
	optionalNumberField,
	streamingInfo,
	stringField,
} from './values.ts';

// #region enums

/** Unity 2019+ `VertexAttributeFormat` */
export const VertexAttributeFormat = {
	Float32: 0,
	Float16: 1,
	UNorm8: 2,
	SNorm8: 3,
	UNorm16: 4,
	SNorm16: 5,
	UInt8: 6,
	SInt8: 7,
	UInt16: 8,
	SInt16: 9,
	UInt32: 10,
	SInt32: 11,
} as const;

/** byte size of one component, by {@link VertexAttributeFormat} */
const FORMAT_SIZES = [4, 2, 1, 1, 2, 2, 1, 1, 2, 2, 4, 4];

/** Unity 2018+ `VertexAttribute`, the order of `m_VertexData.m_Channels` */
export const VertexAttribute = {
	Position: 0,
	Normal: 1,
	Tangent: 2,
	Color: 3,
	TexCoord0: 4,
	BlendWeight: 12,
	BlendIndices: 13,
} as const;

/** number of texture coordinate channels (`TexCoord0`…`TexCoord7`) */
export const TEXCOORD_COUNT = 8;

/** `MeshTopology` */
export const MeshTopology = {
	Triangles: 0,
	Quads: 2,
	Lines: 3,
	LineStrip: 4,
	Points: 5,
} as const;

// #endregion

// #region types

/** one entry of `m_VertexData.m_Channels`, in source form */
export interface VertexChannelInfo {
	/** shader channel index, see {@link VertexAttribute} */
	channel: number;
	stream: number;
	/** byte offset within the stream's vertex */
	offset: number;
	/** {@link VertexAttributeFormat} */
	format: number;
	/** component count (low nibble of the dimension byte) */
	dimension: number;
	/** high nibble of the dimension byte; Endfield sets 3 on packed normals */
	packing: number;
}

/** a submesh: a range of the index buffer */
export interface MeshSubmesh {
	/** first index (not byte) in {@link DecodedMesh.indices} */
	firstIndex: number;
	indexCount: number;
	/** {@link MeshTopology} */
	topology: number;
	/** added to every index of the submesh */
	baseVertex: number;
	firstVertex: number;
	vertexCount: number;
	bounds: Aabb;
}

/** a decoded vertex attribute: `dimension` floats per vertex */
export interface MeshAttribute {
	dimension: number;
	/** the source {@link VertexAttributeFormat}, for choosing a packed output format */
	format: number;
	data: Float32Array;
}

/** vertex influences for baking or animating a skinned mesh */
export interface MeshSkinInfo {
	bonesPerVertex: number;
	bindPoseCount: number;
	boneNameHashCount: number;
	hasBlendWeights: boolean;
	hasBlendIndices: boolean;
	weights: MeshAttribute | null;
	indices: MeshAttribute | null;
}

/** a mesh as engine-neutral typed arrays */
export interface DecodedMesh {
	name: string;
	vertexCount: number;
	/** source channel layout, for diagnostics */
	channels: VertexChannelInfo[];
	/** xyz per vertex */
	positions: Float32Array;
	/** unit xyz per vertex, or `null` if the mesh has no normals */
	normals: Float32Array | null;
	/** the source words when normals were packed (see {@link unpackHgNormal}), else `null` */
	packedNormals: Uint32Array | null;
	/** xyzw per vertex (w is the bitangent sign), or `null` */
	tangents: MeshAttribute | null;
	/** rgba per vertex in [0, 1] (or HDR for float colors), or `null` */
	colors: MeshAttribute | null;
	/** `TexCoord0`…`TexCoord7`; absent sets are `null` */
	uvs: (MeshAttribute | null)[];
	indices: Uint16Array | Uint32Array;
	submeshes: MeshSubmesh[];
	bounds: Aabb;
	/** `null` for static meshes */
	skin: MeshSkinInfo | null;
}

// #endregion

// #region decoding

/**
 * decodes a mesh. vertex data is read from `streamData` when the mesh streams it (see `streamingInfo` in
 * `values.ts`), else from `m_VertexData.m_DataSize`. all data is little-endian, as Unity stores it for PC
 * targets.
 *
 * @param mesh a decoded `Mesh` object
 * @param streamData the `m_StreamData` bytes, required when `streamingInfo` returns a value
 * @returns the decoded mesh; arrays are freshly allocated
 * @throws {FormatError} on compressed or collision-only meshes, missing stream data, or data that doesn't fit
 *   the declared layout
 */
export const decodeMesh = (mesh: TypeTreeObject, streamData: Uint8Array | undefined): DecodedMesh => {
	const name = stringField(mesh, 'm_Name');
	if (Object.hasOwn(mesh, 'm_CollisionMeshBaked') && booleanField(mesh, 'm_CollisionMeshBaked')) {
		throw new FormatError(`mesh ${name} is collision-only`);
	}
	// `m_MeshCompression` is an import setting; the data only moves into m_CompressedMesh when that has items
	const compressed = mesh.m_CompressedMesh;
	if (
		isObject(compressed) &&
		isObject(compressed.m_Vertices) &&
		numberField(compressed.m_Vertices, 'm_NumItems') > 0
	) {
		throw new FormatError(`mesh ${name} stores its vertices in m_CompressedMesh, which isn't supported`);
	}

	const vertexData = objectField(mesh, 'm_VertexData');
	const vertexCount = numberField(vertexData, 'm_VertexCount');
	const channels = arrayField(vertexData, 'm_Channels').map((value, channel) => {
		if (typeof value !== 'object' || Array.isArray(value) || ArrayBuffer.isView(value)) {
			throw new FormatError(`m_Channels[${channel}] is not an object`);
		}
		const dimensionByte = numberField(value, 'dimension');
		return {
			channel,
			stream: numberField(value, 'stream'),
			offset: numberField(value, 'offset'),
			format: numberField(value, 'format'),
			dimension: dimensionByte & 0xf,
			packing: dimensionByte >> 4,
		};
	});

	let data: Uint8Array;
	if (streamingInfo(mesh) === undefined) {
		data = bytesField(vertexData, 'm_DataSize');
	} else if (streamData === undefined) {
		throw new FormatError(`mesh ${name} streams its vertex data, but no stream data was given`);
	} else {
		data = streamData;
	}

	const streams = streamLayout(channels, vertexCount);
	const end = streams.reduce((max, stream) => Math.max(max, stream.offset + stream.stride * vertexCount), 0);
	if (end > data.length) {
		throw new FormatError(`mesh ${name} needs ${end} bytes of vertex data, has ${data.length}`);
	}
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const present = (channel: number): VertexChannelInfo | undefined => {
		const info = channels[channel];
		return info !== undefined && info.dimension > 0 ? info : undefined;
	};
	const read = (info: VertexChannelInfo): MeshAttribute => {
		const stream = streams[info.stream];
		return {
			dimension: info.dimension,
			format: info.format,
			data: readChannel(view, info, stream.offset, stream.stride, vertexCount),
		};
	};

	const position = present(VertexAttribute.Position);
	if (position === undefined || position.dimension < 3) {
		throw new FormatError(`mesh ${name} has no 3D positions`);
	}
	const positions = read(position).data;

	let normals: Float32Array | null = null;
	let packedNormals: Uint32Array | null = null;
	const normal = present(VertexAttribute.Normal);
	if (normal !== undefined) {
		if (normal.dimension === 1 && FORMAT_SIZES[normal.format] === 4) {
			const stream = streams[normal.stream];
			packedNormals = new Uint32Array(vertexCount);
			normals = new Float32Array(vertexCount * 3);
			const out: [number, number, number] = [0, 0, 0];
			for (let v = 0; v < vertexCount; v++) {
				const word = view.getUint32(stream.offset + stream.stride * v + normal.offset, true);
				packedNormals[v] = word;
				unpackHgNormal(word, out);
				normals.set(out, v * 3);
			}
		} else if (normal.dimension >= 3) {
			// some meshes store a 4th (unused) component
			const values = read(normal).data;
			normals = normal.dimension === 3 ? values : takeComponents(values, normal.dimension, 3);
		} else {
			throw new FormatError(`mesh ${name} has a ${normal.dimension}-component unpacked normal`);
		}
	}

	const tangent = present(VertexAttribute.Tangent);
	const color = present(VertexAttribute.Color);
	const uvs: (MeshAttribute | null)[] = [];
	for (let i = 0; i < TEXCOORD_COUNT; i++) {
		const uv = present(VertexAttribute.TexCoord0 + i);
		uvs.push(uv === undefined ? null : read(uv));
	}

	const indexFormat = optionalNumberField(mesh, 'm_IndexFormat') ?? 0;
	const indexSize = indexFormat === 0 ? 2 : 4;
	const indexBytes = bytesField(mesh, 'm_IndexBuffer');
	if (indexBytes.length % indexSize !== 0) {
		throw new FormatError(`mesh ${name} index buffer isn't a whole number of ${indexSize}-byte indices`);
	}
	const indexCopy = indexBytes.slice().buffer;
	const indices = indexSize === 2 ? new Uint16Array(indexCopy) : new Uint32Array(indexCopy);

	const submeshes = arrayField(mesh, 'm_SubMeshes').map((value, i): MeshSubmesh => {
		if (typeof value !== 'object' || Array.isArray(value) || ArrayBuffer.isView(value)) {
			throw new FormatError(`m_SubMeshes[${i}] is not an object`);
		}
		const firstByte = numberField(value, 'firstByte');
		const submesh = {
			firstIndex: firstByte / indexSize,
			indexCount: numberField(value, 'indexCount'),
			topology: numberField(value, 'topology'),
			baseVertex: numberField(value, 'baseVertex'),
			firstVertex: numberField(value, 'firstVertex'),
			vertexCount: numberField(value, 'vertexCount'),
			bounds: aabbField(value, 'localAABB'),
		};
		if (!Number.isInteger(submesh.firstIndex) || submesh.firstIndex + submesh.indexCount > indices.length) {
			throw new FormatError(`mesh ${name} submesh ${i} lies outside the index buffer`);
		}
		return submesh;
	});

	const bindPoseCount = arrayField(mesh, 'm_BindPose').length;
	const boneNameHashCount = arrayField(mesh, 'm_BoneNameHashes').length;
	const weightChannel = present(VertexAttribute.BlendWeight);
	const indexChannel = present(VertexAttribute.BlendIndices);
	const hasBlendWeights = weightChannel !== undefined;
	const hasBlendIndices = present(VertexAttribute.BlendIndices) !== undefined;
	const bonesPerVertex = optionalNumberField(mesh, 'm_BonesPerVertex') ?? 0;
	let weights = weightChannel === undefined ? null : read(weightChannel);
	const boneIndices = indexChannel === undefined ? null : read(indexChannel);
	// a rigid skin stores only indices: the one declared influence has an implicit unit weight.
	if (weights === null && boneIndices !== null && bonesPerVertex === 1) {
		const implicitWeights = new Float32Array(vertexCount * boneIndices.dimension);
		for (let v = 0; v < vertexCount; v++) {
			implicitWeights[v * boneIndices.dimension] = 1;
		}
		weights = {
			dimension: boneIndices.dimension,
			format: VertexAttributeFormat.Float32,
			data: implicitWeights,
		};
	}
	const skinned = bindPoseCount > 0 || boneNameHashCount > 0 || hasBlendWeights || hasBlendIndices;

	return {
		name,
		vertexCount,
		channels,
		positions: position.dimension === 3 ? positions : takeComponents(positions, position.dimension, 3),
		normals,
		packedNormals,
		tangents: tangent === undefined ? null : read(tangent),
		colors: color === undefined ? null : read(color),
		uvs,
		indices,
		submeshes,
		bounds: aabbField(mesh, 'm_LocalAABB'),
		skin: skinned
			? {
					bonesPerVertex,
					bindPoseCount,
					boneNameHashCount,
					hasBlendWeights,
					hasBlendIndices,
					weights,
					indices: boneIndices,
				}
			: null,
	};
};

/**
 * computes stream offsets and strides the way Unity 2018+ lays them out: streams are consecutive, each one
 * `vertexCount × stride` bytes, aligned to 16
 *
 * @param channels source channels
 * @param vertexCount vertex count
 * @returns per-stream offset and stride, indexed by stream number
 */
export const streamLayout = (
	channels: readonly VertexChannelInfo[],
	vertexCount: number,
): { offset: number; stride: number }[] => {
	const streamCount = channels.reduce(
		(max, info) => Math.max(max, info.dimension > 0 ? info.stream + 1 : 0),
		0,
	);
	const streams: { offset: number; stride: number }[] = [];
	let offset = 0;
	for (let s = 0; s < streamCount; s++) {
		let stride = 0;
		for (const info of channels) {
			if (info.stream === s && info.dimension > 0) {
				const size = FORMAT_SIZES[info.format];
				if (size === undefined) {
					throw new FormatError(`channel ${info.channel} has unknown vertex format ${info.format}`);
				}
				stride += info.dimension * size;
			}
		}
		streams.push({ offset, stride });
		offset = (offset + vertexCount * stride + 15) & ~15;
	}
	return streams;
};

const readChannel = (
	view: DataView,
	info: VertexChannelInfo,
	streamOffset: number,
	stride: number,
	vertexCount: number,
): Float32Array => {
	const { dimension, format } = info;
	const size = FORMAT_SIZES[format];
	const out = new Float32Array(vertexCount * dimension);
	for (let v = 0; v < vertexCount; v++) {
		const base = streamOffset + stride * v + info.offset;
		for (let d = 0; d < dimension; d++) {
			const at = base + d * size;
			let value: number;
			switch (format) {
				case VertexAttributeFormat.Float32: {
					value = view.getFloat32(at, true);
					break;
				}
				case VertexAttributeFormat.Float16: {
					value = view.getFloat16(at, true);
					break;
				}
				case VertexAttributeFormat.UNorm8: {
					value = view.getUint8(at) / 255;
					break;
				}
				case VertexAttributeFormat.SNorm8: {
					value = Math.max(view.getInt8(at) / 127, -1);
					break;
				}
				case VertexAttributeFormat.UNorm16: {
					value = view.getUint16(at, true) / 65535;
					break;
				}
				case VertexAttributeFormat.SNorm16: {
					value = Math.max(view.getInt16(at, true) / 32767, -1);
					break;
				}
				case VertexAttributeFormat.UInt8: {
					value = view.getUint8(at);
					break;
				}
				case VertexAttributeFormat.SInt8: {
					value = view.getInt8(at);
					break;
				}
				case VertexAttributeFormat.UInt16: {
					value = view.getUint16(at, true);
					break;
				}
				case VertexAttributeFormat.SInt16: {
					value = view.getInt16(at, true);
					break;
				}
				case VertexAttributeFormat.UInt32: {
					value = view.getUint32(at, true);
					break;
				}
				case VertexAttributeFormat.SInt32: {
					value = view.getInt32(at, true);
					break;
				}
				default: {
					throw new FormatError(`channel ${info.channel} has unknown vertex format ${format}`);
				}
			}
			out[v * dimension + d] = value;
		}
	}
	return out;
};

/** keeps the first `keep` of every `stride` components */
const takeComponents = (data: Float32Array, stride: number, keep: number): Float32Array => {
	const count = data.length / stride;
	const out = new Float32Array(count * keep);
	for (let i = 0; i < count; i++) {
		for (let k = 0; k < keep; k++) {
			out[i * keep + k] = data[i * stride + k];
		}
	}
	return out;
};

// #endregion

// #region packed normals

/** the integer range of the 10-bit signed octahedral components; the game divides by 511, not 512 */
export const OCT10_RANGE = 511;

/**
 * @param word a packed normal word (see {@link unpackHgNormal})
 * @param out receives the two signed 10-bit octahedral integers from bits 0–9 and 10–19
 * @returns `out`
 */
export const unpackOct10 = (word: number, out: [number, number]): [number, number] => {
	out[0] = (word << 22) >> 22;
	out[1] = (word << 12) >> 22;
	return out;
};

/**
 * the standard octahedral unfold of a pair of coordinates in [-1, 1], normalized
 *
 * @param u first component
 * @param v second component
 * @param out receives the unit vector
 * @returns `out`
 */
export const decodeOctahedral = (
	u: number,
	v: number,
	out: [number, number, number],
): [number, number, number] => {
	let x = u;
	let y = v;
	const z = 1 - Math.abs(u) - Math.abs(v);
	if (z < 0) {
		x = (1 - Math.abs(v)) * (u >= 0 ? 1 : -1);
		y = (1 - Math.abs(u)) * (v >= 0 ? 1 : -1);
	}
	const length = Math.hypot(x, y, z);
	out[0] = x / length;
	out[1] = y / length;
	out[2] = z / length;
	return out;
};

const octScratch: [number, number] = [0, 0];

/**
 * decodes Hypergryph's packed vertex normal. bits 0–9 and 10–19 are signed 10-bit octahedral coordinates
 * (÷{@link OCT10_RANGE}); the normal is the standard octahedral unfold of them, normalized. bits 20–31 hold
 * tangent-frame data that isn't decoded.
 *
 * the decode mirrors AnimeStudio's `MeshHelper.DecompressEndfieldNormal` (MIT).
 *
 * @param word the 32-bit packed value
 * @param out receives the unit normal
 * @returns `out`
 */
export const unpackHgNormal = (word: number, out: [number, number, number]): [number, number, number] => {
	const [x, y] = unpackOct10(word, octScratch);
	return decodeOctahedral(x / OCT10_RANGE, y / OCT10_RANGE, out);
};

// #endregion
