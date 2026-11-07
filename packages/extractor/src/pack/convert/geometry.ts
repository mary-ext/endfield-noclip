import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import {
	type DecodedMesh,
	decodeOctahedral,
	type MeshAttribute,
	MeshTopology,
	OCT10_RANGE,
	TEXCOORD_COUNT,
	unpackOct10,
	VertexAttributeFormat,
} from '@endfield-noclip/formats/unity/mesh';
import {
	encodeGeometryBlob,
	GEOMETRY_VERTEX_FORMATS,
	GeometryFlags,
	type GeometryStream,
	GeometryStreamFlags,
	type GeometrySubmesh,
	GeometryVertexFormat,
	type ReadyGeometry,
	type SkinAnimation,
	VertexAttribute,
} from '@endfield-noclip/package-format/geometry';

import { MeshoptEncoder } from 'meshoptimizer/encoder';
import { MeshoptTangents } from 'meshoptimizer/tangents';

import type { SkinMotion } from '../../game/prefabs/prefab.ts';
import { aabbBounds } from '../instances/bounds.ts';

// converts a decoded Unity mesh into a geometry blob (layout and per-attribute encodings in
// `docs/package-format.md#geometry-blob-mesh-efgm`): tangents generated where normal maps need them, each
// submesh given its own vertex-cache/fetch-optimized vertex range, attributes quantized, streams and indices
// meshopt-encoded.

/** resolves once the meshopt wasm modules are instantiated; await before {@link convertMesh} */
export const geometryReady: Promise<unknown> = Promise.all([MeshoptEncoder.ready, MeshoptTangents.ready]);

/** a mesh converted for the package */
export interface ConvertedGeometry {
	/** the geometry blob, before the blob codec */
	blob: Uint8Array;
	/** the table entry's fields that describe the blob */
	entry: Omit<ReadyGeometry, 'status' | 'blob'>;
	/** bytes of the decoded vertex and index buffers, for reports */
	gpuBytes: number;
}

/**
 * how far a swaying material (`LitSway`) can move a vertex horizontally: `weight · (flat + perHeight · |y|)`
 * metres, with `weight` the vertex colour's alpha and `y` its object-space height
 */
export interface SwayReach {
	flat: number;
	perHeight: number;
}

/** what a mesh is converted with besides its UV set for tangents */
export interface MeshConversionOptions {
	/**
	 * the farthest sway of any material drawing the mesh; the position stream's W then carries each vertex's
	 * sway weight (its colour's alpha), and the bounds grow horizontally to hold the sway
	 */
	sway?: SwayReach;
	/**
	 * the skeletal animation a skinned mesh plays, given in its bind space; the blob then keeps the mesh
	 * unposed, with its bone weights and indices, and its bounds hold every frame
	 */
	motion?: SkinMotion;
}

/** the largest UV span stored as dequantized unorm16, keeping the error below 2^-13 */
const UV_UNORM16_SPAN = 16;

/**
 * @param mesh the decoded mesh
 * @param tangentUv UV set to generate MikkTSpace tangents from (because a normal-mapped material draws the
 *   mesh), or `null`. ignored when the mesh has its own tangents, or lacks normals or that UV set
 * @param options the sway and skeletal animation the mesh is drawn with, if any
 * @returns the blob and its entry fields
 * @throws {FormatError} on topologies other than triangles and quads, out-of-range indices or an empty mesh,
 *   or with a motion, a mesh without bone weights and indices, more than four influences or 256 bones, or
 *   bone indices past the motion's bones
 */
export const convertMesh = (
	mesh: DecodedMesh,
	tangentUv: number | null,
	{ sway, motion }: MeshConversionOptions = {},
): ConvertedGeometry => {
	const corners = submeshCorners(mesh);
	if (corners.every((list) => list.length === 0)) {
		throw new FormatError(`mesh ${mesh.name} has no triangles`);
	}

	// #region tangents: one per source vertex, or per corner split into new vertices
	let origin: Uint32Array | null = null;
	let tangents: Float32Array | null = null;
	let generated = false;
	const tangentSource = tangentUv === null ? null : mesh.uvs[tangentUv];
	if (mesh.tangents !== null && mesh.normals !== null && mesh.tangents.dimension >= 4) {
		tangents = mesh.tangents.data;
	} else if (tangentSource !== null && tangentSource !== undefined && mesh.normals !== null) {
		const split = splitByTangent(mesh, tangentSource, corners);
		origin = split.origin;
		tangents = split.tangents;
		generated = true;
	}
	const vertexOf = origin === null ? (v: number): number => v : (v: number): number => origin[v];
	// #endregion

	// #region per-submesh vertex ranges, cache and fetch optimized
	const submeshes: GeometrySubmesh[] = [];
	const order: number[] = [];
	const localIndices: Uint32Array[] = [];
	let firstIndex = 0;
	let maxSubmeshVertices = 0;
	for (const [s, list] of corners.entries()) {
		const local = new Uint32Array(list.length);
		const vertices: number[] = [];
		const seen = new Map<number, number>();
		for (const [i, vertex] of list.entries()) {
			local[i] = seen.getOrInsertComputed(vertex, () => vertices.push(vertex) - 1);
		}
		let vertexCount = 0;
		if (local.length > 0) {
			// rewrites `local` in place to the optimized vertex order
			const [remap, unique] = MeshoptEncoder.reorderMesh(local, true, false);
			const placed = Array.from({ length: unique }, () => 0);
			for (const [i, vertex] of vertices.entries()) {
				placed[remap[i]] = vertex;
			}
			vertexCount = unique;
			for (const vertex of placed) {
				order.push(vertex);
			}
		}
		submeshes.push({
			firstIndex,
			indexCount: local.length,
			baseVertex: order.length - vertexCount,
			vertexCount,
			bounds: aabbBounds(mesh.submeshes[s].bounds),
		});
		localIndices.push(local);
		firstIndex += local.length;
		maxSubmeshVertices = Math.max(maxSubmeshVertices, vertexCount);
	}
	const vertexCount = order.length;
	// #endregion

	// #region streams
	const streams: Omit<GeometryStream, 'data'>[] = [];
	const raw: Uint8Array[] = [];
	const add = (stream: Omit<GeometryStream, 'data'>, data: Uint8Array): void => {
		streams.push(stream);
		raw.push(data);
	};

	const positions = mesh.positions;
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	for (const v of order) {
		const source = vertexOf(v) * 3;
		for (let k = 0; k < 3; k++) {
			min[k] = Math.min(min[k], positions[source + k]);
			max[k] = Math.max(max[k], positions[source + k]);
		}
	}
	const scale = [0, 1, 2].map((k) => max[k] - min[k]);
	// the farthest any vertex sways
	let swayReach = 0;
	{
		const out = new Uint16Array(vertexCount * 4);
		const colors = sway === undefined ? null : mesh.colors;
		for (const [i, v] of order.entries()) {
			const source = vertexOf(v) * 3;
			for (let k = 0; k < 3; k++) {
				out[i * 4 + k] =
					scale[k] === 0 ? 0 : Math.round(((positions[source + k] - min[k]) / scale[k]) * 65535);
			}
			// W: the sway weight, the colour's alpha (white, so 1, without colours)
			if (sway !== undefined) {
				let weight = 1;
				if (colors !== null && colors.dimension >= 4) {
					weight = Math.min(Math.max(colors.data[vertexOf(v) * colors.dimension + 3], 0), 1);
				}
				out[i * 4 + 3] = Math.round(weight * 65535);
				const y = Math.abs(positions[source + 1]);
				swayReach = Math.max(swayReach, weight * (sway.flat + sway.perHeight * y));
			}
		}
		add(
			{
				attribute: VertexAttribute.Position,
				format: GeometryVertexFormat.Unorm16x4,
				flags: GeometryStreamFlags.Dequantize,
				offset: [min[0], min[1], min[2]],
				scale: [scale[0], scale[1], scale[2]],
			},
			bytesOf(out),
		);
	}

	if (mesh.normals !== null) {
		const { normals, packedNormals } = mesh;
		const out = new Int16Array(vertexCount * 2);
		const oct: [number, number] = [0, 0];
		for (const [i, v] of order.entries()) {
			const source = vertexOf(v);
			if (packedNormals === null) {
				encodeOctahedral(normals[source * 3], normals[source * 3 + 1], normals[source * 3 + 2], 16, oct);
			} else {
				// the game's normal is already a 10-bit octahedral pair over the same mapping. its integers are
				// stored as they are and the stream's scale restores ÷511: exact, and ~30% smaller after
				// meshopt + zstd than respreading them over 16 bits
				unpackOct10(packedNormals[source], oct);
			}
			out[i * 2] = oct[0];
			out[i * 2 + 1] = oct[1];
		}
		const stream = plain(VertexAttribute.Normal, GeometryVertexFormat.Snorm16x2);
		if (packedNormals !== null) {
			stream.flags = GeometryStreamFlags.Dequantize;
			stream.scale = [OCT10_SCALE, OCT10_SCALE, 0];
		}
		add(stream, bytesOf(out));
	}

	if (tangents !== null) {
		const out = new Int8Array(vertexCount * 4);
		const oct: [number, number] = [0, 0];
		for (const [i, v] of order.entries()) {
			// `v` is a new vertex for generated tangents and a source vertex otherwise; either way it indexes them
			const source = v * 4;
			encodeOctahedral(tangents[source], tangents[source + 1], tangents[source + 2], 8, oct);
			out[i * 4] = oct[0];
			out[i * 4 + 1] = oct[1];
			out[i * 4 + 2] = tangents[source + 3] < 0 ? -127 : 127;
		}
		add(plain(VertexAttribute.Tangent, GeometryVertexFormat.Snorm8x4), bytesOf(out));
	}

	if (mesh.colors !== null) {
		const { format, data } = colorStream(mesh.colors, order, vertexOf);
		add(plain(VertexAttribute.Color, format), data);
	}

	for (let set = 0; set < TEXCOORD_COUNT; set++) {
		const uv = mesh.uvs[set];
		if (uv !== null && uv !== undefined) {
			const { stream, data } = uvStream(uv, order, vertexOf);
			add({ ...stream, attribute: VertexAttribute.TexCoord0 + set }, data);
		}
	}

	let animation: SkinAnimation | null = null;
	let bounds = { min, max };
	if (motion !== undefined) {
		const skin = skinStreams(mesh, order.map(vertexOf), motion.boneCount);
		add(plain(VertexAttribute.BlendWeight, GeometryVertexFormat.Unorm16x4), bytesOf(skin.weights));
		add(plain(VertexAttribute.BlendIndices, GeometryVertexFormat.Uint8x4), bytesOf(skin.bones));
		bounds = motionBounds(mesh, order.map(vertexOf), skin, motion);
		animation = {
			...motion,
			offset: [bounds.min[0], bounds.min[1], bounds.min[2]],
			scale: [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]],
		};
	}
	if (swayReach > 0) {
		// the sway is horizontal in world space; growing X and Z by its reach holds it under yaw-only rotation
		// and near-unit scale, which is how scenery is placed
		bounds = {
			min: [bounds.min[0] - swayReach, bounds.min[1], bounds.min[2] - swayReach],
			max: [bounds.max[0] + swayReach, bounds.max[1], bounds.max[2] + swayReach],
		};
	}
	// #endregion

	const wide = maxSubmeshVertices > 0x1_00_00;
	const indexCount = firstIndex;
	const indices = wide ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
	{
		let at = 0;
		for (const local of localIndices) {
			indices.set(local, at);
			at += local.length;
		}
	}
	const indexSize = wide ? 4 : 2;
	const blob = encodeGeometryBlob({
		flags: (wide ? GeometryFlags.IndexU32 : 0) | (generated ? GeometryFlags.GeneratedTangents : 0),
		vertexCount,
		indexCount,
		streams: streams.map((stream, i) => ({
			...stream,
			data: MeshoptEncoder.encodeVertexBuffer(
				raw[i],
				vertexCount,
				GEOMETRY_VERTEX_FORMATS[stream.format].size,
			),
		})),
		submeshes,
		indices: MeshoptEncoder.encodeIndexBuffer(bytesOf(indices), indexCount, indexSize),
		animation,
	});

	let attributes = 0;
	for (const stream of streams) {
		attributes |= 1 << stream.attribute;
	}
	return {
		blob,
		entry: {
			bounds: {
				min: vertexCount === 0 ? [0, 0, 0] : [bounds.min[0], bounds.min[1], bounds.min[2]],
				max: vertexCount === 0 ? [0, 0, 0] : [bounds.max[0], bounds.max[1], bounds.max[2]],
			},
			vertexCount,
			indexCount,
			submeshCount: submeshes.length,
			attributes,
			tangentUv: generated ? tangentUv : null,
			animationFrames: animation?.frameCount ?? null,
		},
		gpuBytes: raw.reduce(
			(sum, data) => sum + data.byteLength,
			indexCount * indexSize + (animation?.matrices.byteLength ?? 0),
		),
	};
};

// #region topology

/**
 * @returns per submesh, its triangle corners as source vertex indices (quads split into two triangles)
 * @throws {FormatError} on other topologies, index counts that don't fill whole primitives, or indices past
 *   the vertex count
 */
const submeshCorners = (mesh: DecodedMesh): Uint32Array[] => {
	return mesh.submeshes.map((submesh, s) => {
		const { firstIndex, indexCount, baseVertex, topology } = submesh;
		const index = (i: number): number => {
			const vertex = mesh.indices[firstIndex + i] + baseVertex;
			if (vertex >= mesh.vertexCount) {
				throw new FormatError(
					`mesh ${mesh.name} submesh ${s} indexes vertex ${vertex} of ${mesh.vertexCount}`,
				);
			}
			return vertex;
		};
		const whole = (corners: number): void => {
			if (indexCount % corners !== 0) {
				throw new FormatError(
					`mesh ${mesh.name} submesh ${s} has ${indexCount} indices, not whole ${corners}-corner primitives`,
				);
			}
		};
		switch (topology) {
			case MeshTopology.Triangles: {
				whole(3);
				const out = new Uint32Array(indexCount);
				for (let i = 0; i < indexCount; i++) {
					out[i] = index(i);
				}
				return out;
			}
			case MeshTopology.Quads: {
				whole(4);
				const quads = indexCount / 4;
				const out = new Uint32Array(quads * 6);
				for (let q = 0; q < quads; q++) {
					const [a, b, c, d] = [index(q * 4), index(q * 4 + 1), index(q * 4 + 2), index(q * 4 + 3)];
					out.set([a, b, c, a, c, d], q * 6);
				}
				return out;
			}
			default: {
				throw new FormatError(`mesh ${mesh.name} submesh ${s} has unsupported topology ${topology}`);
			}
		}
	});
};

// #endregion

// #region tangents

/** corners whose tangents differ by less than this (cosine) share a vertex */
const SAME_TANGENT = 0.9999;

/**
 * generates MikkTSpace-compatible tangents per triangle corner and gives each vertex as many copies as it has
 * distinct tangent frames (mirrored UV seams). rewrites `corners` to the new vertex ids
 *
 * @returns new vertex → source vertex, and a tangent (xyz, sign) per new vertex
 */
const splitByTangent = (
	mesh: DecodedMesh,
	uv: MeshAttribute,
	corners: Uint32Array[],
): { origin: Uint32Array; tangents: Float32Array } => {
	const all = new Uint32Array(corners.reduce((sum, list) => sum + list.length, 0));
	{
		let at = 0;
		for (const list of corners) {
			all.set(list, at);
			at += list.length;
		}
	}
	const uvs = uv.dimension >= 2 ? uv.data : padComponents(uv.data, uv.dimension, 2);
	const perCorner = MeshoptTangents.generateTangents(
		all,
		mesh.positions,
		3,
		mesh.normals!,
		3,
		uvs,
		Math.max(2, uv.dimension),
		['Compatible'],
	);

	const origin: number[] = [];
	const tangents: number[] = [];
	// per source vertex, the new vertices made for it so far
	const variants = new Map<number, number[]>();
	let at = 0;
	for (const list of corners) {
		for (let i = 0; i < list.length; i++, at++) {
			const vertex = list[i];
			const t = at * 4;
			const [x, y, z, w] = [perCorner[t], perCorner[t + 1], perCorner[t + 2], perCorner[t + 3]];
			const candidates = variants.getOrInsertComputed(vertex, () => []);
			let id = candidates.find((candidate) => {
				const c = candidate * 4;
				return (
					Math.sign(tangents[c + 3]) === Math.sign(w) &&
					tangents[c] * x + tangents[c + 1] * y + tangents[c + 2] * z >= SAME_TANGENT
				);
			});
			if (id === undefined) {
				id = origin.length;
				origin.push(vertex);
				tangents.push(x, y, z, w < 0 ? -1 : 1);
				candidates.push(id);
			}
			list[i] = id;
		}
	}
	return { origin: Uint32Array.from(origin), tangents: Float32Array.from(tangents) };
};

// #endregion

// #region skinning

/** the most bones a vertex's `uint8x4` indices can name */
const MAX_BONES = 256;

/**
 * @param mesh a mesh a renderer draws rigidly
 * @returns a copy whose every vertex follows bone 0 alone, replacing any bone weights it had, for a motion
 *   that moves the renderer's own Transform as its one bone
 */
export const rigidSkin = (mesh: DecodedMesh): DecodedMesh => ({
	...mesh,
	skin: {
		bonesPerVertex: 1,
		bindPoseCount: 1,
		boneNameHashCount: 0,
		hasBlendWeights: true,
		hasBlendIndices: true,
		weights: {
			dimension: 1,
			format: VertexAttributeFormat.Float32,
			data: new Float32Array(mesh.vertexCount).fill(1),
		},
		indices: {
			dimension: 1,
			format: VertexAttributeFormat.Float32,
			data: new Float32Array(mesh.vertexCount),
		},
	},
});

/** per output vertex, four quantized weights summing to 65,535 and their bones */
interface SkinStreams {
	weights: Uint16Array;
	bones: Uint8Array;
}

/**
 * @param mesh a skinned mesh
 * @param sources per output vertex, its source vertex
 * @param boneCount the bones its motion animates
 * @returns its four weights per vertex, normalized and quantized, and their bones
 */
const skinStreams = (mesh: DecodedMesh, sources: readonly number[], boneCount: number): SkinStreams => {
	const weights = mesh.skin?.weights;
	const indices = mesh.skin?.indices;
	if (weights === undefined || weights === null || indices === undefined || indices === null) {
		throw new FormatError(`mesh ${mesh.name} has no bone weights and indices to animate`);
	}
	if (weights.dimension > 4 || indices.dimension !== weights.dimension) {
		throw new FormatError(
			`mesh ${mesh.name} has ${weights.dimension} influences, more than four or mismatched`,
		);
	}
	if (boneCount > MAX_BONES) {
		throw new FormatError(`mesh ${mesh.name} is animated by ${boneCount} bones, more than ${MAX_BONES}`);
	}
	const n = weights.dimension;
	const out: SkinStreams = {
		weights: new Uint16Array(sources.length * 4),
		bones: new Uint8Array(sources.length * 4),
	};
	for (const [i, source] of sources.entries()) {
		let sum = 0;
		for (let k = 0; k < n; k++) {
			sum += Math.max(weights.data[source * n + k], 0);
		}
		let remaining = 65_535;
		for (let k = 0; k < n; k++) {
			const bone = indices.data[source * n + k];
			if (!Number.isInteger(bone) || bone < 0 || bone >= boneCount) {
				throw new FormatError(`mesh ${mesh.name} vertex ${source} names bone ${bone} of ${boneCount}`);
			}
			out.bones[i * 4 + k] = bone;
			// a vertex without weights follows its first bone; the last influence takes the rounding
			const share = sum > 0 ? Math.max(weights.data[source * n + k], 0) / sum : Number(k === 0);
			const quantized = k === n - 1 ? remaining : Math.min(Math.round(share * 65_535), remaining);
			out.weights[i * 4 + k] = quantized;
			remaining -= quantized;
		}
	}
	return out;
};

/** @returns the box every frame's skinned positions lie in */
const motionBounds = (
	mesh: DecodedMesh,
	sources: readonly number[],
	skin: SkinStreams,
	motion: SkinMotion,
): { min: number[]; max: number[] } => {
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	const { matrices, boneCount } = motion;
	for (let frame = 0; frame < motion.frameCount; frame++) {
		for (const [i, source] of sources.entries()) {
			const [x, y, z] = [
				mesh.positions[source * 3],
				mesh.positions[source * 3 + 1],
				mesh.positions[source * 3 + 2],
			];
			const out = [0, 0, 0];
			for (let k = 0; k < 4; k++) {
				const weight = skin.weights[i * 4 + k] / 65_535;
				if (weight === 0) {
					continue;
				}
				const m = (frame * boneCount + skin.bones[i * 4 + k]) * 12;
				for (let row = 0; row < 3; row++) {
					const r = m + row * 4;
					out[row] +=
						weight * (matrices[r] * x + matrices[r + 1] * y + matrices[r + 2] * z + matrices[r + 3]);
				}
			}
			for (let k = 0; k < 3; k++) {
				min[k] = Math.min(min[k], out[k]);
				max[k] = Math.max(max[k], out[k]);
			}
		}
	}
	return { min, max };
};

// #endregion

// #region attribute encodings

const plain = (attribute: number, format: GeometryVertexFormat): Omit<GeometryStream, 'data'> => ({
	attribute,
	...flat(format),
});

const bytesOf = (view: ArrayBufferView): Uint8Array =>
	new Uint8Array(view.buffer, view.byteOffset, view.byteLength);

const padComponents = (data: Float32Array, from: number, to: number): Float32Array => {
	const count = data.length / from;
	const out = new Float32Array(count * to);
	for (let i = 0; i < count; i++) {
		for (let k = 0; k < Math.min(from, to); k++) {
			out[i * to + k] = data[i * from + k];
		}
	}
	return out;
};

/** turns snorm16-normalized 10-bit integers (`k / 32767`) back into the game's `k / 511` */
const OCT10_SCALE = 32_767 / OCT10_RANGE;

/**
 * octahedral encoding into signed `bits`-bit integers, choosing the rounding (of four) that decodes closest
 * to the input
 *
 * @param x unit vector x
 * @param y unit vector y
 * @param z unit vector z
 * @param bits integer width, 8 or 16
 * @param out receives the two integers
 * @returns `out`
 */
export const encodeOctahedral = (
	x: number,
	y: number,
	z: number,
	bits: number,
	out: [number, number],
): [number, number] => {
	const range = (1 << (bits - 1)) - 1;
	const l1 = Math.abs(x) + Math.abs(y) + Math.abs(z);
	if (!(l1 > 0)) {
		out[0] = 0;
		out[1] = 0;
		return out;
	}
	let u = x / l1;
	let v = y / l1;
	if (z < 0) {
		const fu = (1 - Math.abs(v)) * (u >= 0 ? 1 : -1);
		const fv = (1 - Math.abs(u)) * (v >= 0 ? 1 : -1);
		u = fu;
		v = fv;
	}
	const length = Math.hypot(x, y, z);
	let best = -Infinity;
	const decoded: [number, number, number] = [0, 0, 0];
	for (const qu of [Math.floor(u * range), Math.ceil(u * range)]) {
		for (const qv of [Math.floor(v * range), Math.ceil(v * range)]) {
			decodeOctahedral(qu / range, qv / range, decoded);
			const dot = (decoded[0] * x + decoded[1] * y + decoded[2] * z) / length;
			if (dot > best) {
				best = dot;
				out[0] = qu;
				out[1] = qv;
			}
		}
	}
	return out;
};

const colorStream = (
	colors: MeshAttribute,
	order: readonly number[],
	vertexOf: (v: number) => number,
): { format: GeometryVertexFormat; data: Uint8Array } => {
	const { dimension, data } = colors;
	const component = (v: number, k: number): number => (k < dimension ? data[vertexOf(v) * dimension + k] : 1);
	let unit = true;
	for (const value of data) {
		if (!(value >= 0 && value <= 1)) {
			unit = false;
			break;
		}
	}
	if (unit) {
		const out = new Uint8Array(order.length * 4);
		for (const [i, v] of order.entries()) {
			for (let k = 0; k < 4; k++) {
				out[i * 4 + k] = Math.round(component(v, k) * 255);
			}
		}
		return { format: GeometryVertexFormat.Unorm8x4, data: out };
	}
	const out = new Float16Array(order.length * 4);
	for (const [i, v] of order.entries()) {
		for (let k = 0; k < 4; k++) {
			out[i * 4 + k] = component(v, k);
		}
	}
	return { format: GeometryVertexFormat.Float16x4, data: bytesOf(out) };
};

/** a stream without dequantization, before its attribute is known */
const flat = (format: GeometryVertexFormat): Omit<GeometryStream, 'data' | 'attribute'> => ({
	format,
	flags: 0,
	offset: [0, 0, 0],
	scale: [1, 1, 1],
});

const uvStream = (
	uv: MeshAttribute,
	order: readonly number[],
	vertexOf: (v: number) => number,
): { stream: Omit<GeometryStream, 'data' | 'attribute'>; data: Uint8Array } => {
	const { dimension, format, data } = uv;
	const component = (v: number, k: number): number => (k < dimension ? data[vertexOf(v) * dimension + k] : 0);

	// 8-bit normalized sources keep their exact values
	if (format === VertexAttributeFormat.SNorm8 || format === VertexAttributeFormat.UNorm8) {
		const signed = format === VertexAttributeFormat.SNorm8;
		const out = signed ? new Int8Array(order.length * 4) : new Uint8Array(order.length * 4);
		const range = signed ? 127 : 255;
		for (const [i, v] of order.entries()) {
			for (let k = 0; k < 4; k++) {
				out[i * 4 + k] = Math.round(component(v, k) * range);
			}
		}
		return {
			stream: flat(signed ? GeometryVertexFormat.Snorm8x4 : GeometryVertexFormat.Unorm8x4),
			data: bytesOf(out),
		};
	}
	if (dimension > 2) {
		const out = new Float32Array(order.length * 4);
		for (const [i, v] of order.entries()) {
			for (let k = 0; k < 4; k++) {
				out[i * 4 + k] = component(v, k);
			}
		}
		return { stream: flat(GeometryVertexFormat.Float32x4), data: bytesOf(out) };
	}

	const min = [Infinity, Infinity];
	const max = [-Infinity, -Infinity];
	for (const v of order) {
		for (let k = 0; k < 2; k++) {
			const value = component(v, k);
			min[k] = Math.min(min[k], value);
			max[k] = Math.max(max[k], value);
		}
	}
	const span = [max[0] - min[0], max[1] - min[1]];
	if (
		order.length > 0 &&
		Number.isFinite(span[0] + span[1]) &&
		Math.max(span[0], span[1]) <= UV_UNORM16_SPAN
	) {
		const out = new Uint16Array(order.length * 2);
		for (const [i, v] of order.entries()) {
			for (let k = 0; k < 2; k++) {
				out[i * 2 + k] = span[k] === 0 ? 0 : Math.round(((component(v, k) - min[k]) / span[k]) * 65535);
			}
		}
		return {
			stream: {
				format: GeometryVertexFormat.Unorm16x2,
				flags: GeometryStreamFlags.Dequantize,
				offset: [min[0], min[1], 0],
				scale: [span[0], span[1], 0],
			},
			data: bytesOf(out),
		};
	}
	const out = new Float32Array(order.length * 2);
	for (const [i, v] of order.entries()) {
		out[i * 2] = component(v, 0);
		out[i * 2 + 1] = component(v, 1);
	}
	return { stream: flat(GeometryVertexFormat.Float32x2), data: bytesOf(out) };
};

// #endregion
