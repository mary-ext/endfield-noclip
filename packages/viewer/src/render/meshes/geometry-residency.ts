import { createBufferWithData } from '../../gfx/buffers.ts';
import { GeometryFlags } from '../../looks/look.ts';
import type { DecodedGeometry } from '../../package/decode-protocol.ts';
import type { ResidentGeometry } from '../../streaming/resident.ts';

import { type GeometryPools, type GeometryVertices, STREAMS, type Stream } from './geometry-pools.ts';
import type { SkinAnimator } from './skin-animation.ts';
import type { VertexBindings } from './vertex-bindings.ts';

/** {@link GeometryVertices.order} of a geometry's own buffers, after the pools' */
const OWN_ORDER = 2;

/**
 * uploads a decoded geometry: a still one into ranges of the geometry pools; an animated one, which a compute
 * pass skins into its vertices, into buffers of its own, with its bind pose and frames. a still geometry the
 * pools have no room for gets its own buffers too
 *
 * @param device the device
 * @param owners `pools` holds still geometry, `skins` uploads the animation, `bindings` grows its zeros to
 *   cover streams a geometry with its own buffers lacks
 * @param blob the geometry's blob, for labels
 * @param decoded vertex streams and indices
 * @returns the residency
 */
export const uploadGeometry = (
	device: GPUDevice,
	{ pools, skins, bindings }: { pools: GeometryPools; skins: SkinAnimator; bindings: VertexBindings },
	blob: number,
	decoded: DecodedGeometry,
): ResidentGeometry => {
	const data: Record<Stream, ArrayBuffer | null> = {
		position: decoded.positions,
		normal: decoded.normals,
		uv0: decoded.uvs[0],
		uv1: decoded.uvs[1],
		tangent: decoded.tangents,
		color: decoded.colors,
	};
	const common = {
		kind: 'geometry' as const,
		streamFlags:
			(decoded.normals === null ? 0 : GeometryFlags.HasNormals) |
			(decoded.tangents === null ? 0 : GeometryFlags.HasTangents) |
			(decoded.colors === null ? 0 : GeometryFlags.HasColors),
		uvFormat: decoded.uvFormat,
		uvTransforms: decoded.uvTransforms,
		positionOffset: decoded.positionOffset,
		positionScale: decoded.positionScale,
	};
	const indexFormat: GPUIndexFormat = decoded.indexSize === 4 ? 'uint32' : 'uint16';
	const placed =
		decoded.skin === null
			? pools.place({
					vertexCount: decoded.vertexCount,
					uvFormat: decoded.uvFormat,
					streams: data,
					indices: decoded.indices,
					indexFormat,
				})
			: null;
	if (placed !== null) {
		return {
			...common,
			bytes: placed.bytes,
			vertices: placed.vertices,
			indices: placed.indices,
			submeshes: decoded.submeshes.map(({ firstIndex, indexCount, baseVertex }) => ({
				firstIndex: placed.firstIndex + firstIndex,
				indexCount,
				baseVertex: placed.baseVertex + baseVertex,
			})),
			placement: placed.placement,
			skin: null,
			buffers: [],
		};
	}

	// its own buffers: every stream it has in one vertex buffer
	const offsets: (number | null)[] = [];
	let size = 0;
	for (const stream of STREAMS) {
		offsets.push(data[stream] === null ? null : size);
		size += data[stream]?.byteLength ?? 0;
	}
	const buffer = device.createBuffer({
		label: `geometry ${blob}`,
		size: Math.max(4, size),
		// an animation skins its frames into the buffer
		usage:
			GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | (decoded.skin === null ? 0 : GPUBufferUsage.STORAGE),
	});
	STREAMS.forEach((stream, i) => {
		const bytes = data[stream];
		const offset = offsets[i];
		if (bytes !== null && offset !== null) {
			device.queue.writeBuffer(buffer, offset, bytes);
		}
	});
	if (offsets.includes(null)) {
		bindings.fitZeros(decoded.vertexCount);
	}
	// the game reads a UV set a mesh lacks as set 0
	const uv1 = offsets[3] ?? offsets[2];
	const vertices: GeometryVertices = {
		streams: STREAMS.map((stream, i) => {
			const offset = stream === 'uv1' ? uv1 : offsets[i];
			return {
				buffer: offset === null ? null : buffer,
				offset: offset ?? 0,
				// positions are sized, so that reading past them can't run into the next stream
				size: stream === 'position' ? decoded.positions.byteLength : undefined,
			};
		}),
		order: OWN_ORDER,
	};
	const indices = createBufferWithData(device, {
		label: `geometry ${blob} indices`,
		usage: GPUBufferUsage.INDEX,
		data: decoded.indices,
	});
	const skin =
		decoded.skin === null
			? null
			: skins.create(`geometry ${blob}`, decoded.skin, {
					vertices: buffer,
					vertexCount: decoded.vertexCount,
					normalOffset: offsets[1],
					tangentOffset: offsets[4],
					positionOffset: decoded.positionOffset,
					positionScale: decoded.positionScale,
				});
	return {
		...common,
		bytes: buffer.size + indices.size + (skin?.bytes ?? 0),
		vertices,
		indices: { buffer: indices, format: indexFormat },
		submeshes: decoded.submeshes,
		placement: null,
		skin,
		buffers: [buffer, indices],
	};
};

/**
 * @param resident a geometry from {@link uploadGeometry}; its pool ranges are freed, and its own buffers and
 *   its animation's destroyed
 * @param pools the pools it was uploaded into
 */
export const releaseGeometry = (resident: ResidentGeometry, pools: GeometryPools): void => {
	if (resident.placement !== null) {
		pools.free(resident.placement);
	}
	for (const buffer of [...resident.buffers, ...(resident.skin?.buffers ?? [])]) {
		buffer.destroy();
	}
};
