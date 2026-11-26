import type { DecodedMesh } from '@endfield-noclip/formats/unity/mesh';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';

import { mapDefined } from '@mary-ext/array-fns';

import { loadMesh } from '../../../game/assets/asset-decode.ts';
import { objectKey } from '../../../game/assets/assets.ts';
import { withContext } from '../../../install/context.ts';
import { collectTargets } from '../../helpers.ts';

import type { InspectSubArgs } from './parser.ts';
import { resolveObjectArg } from './shared.ts';

/**
 * runs `endfield-extract inspect mesh`
 *
 * @param args parsed CLI arguments
 */
export const runInspectMesh = async (args: InspectSubArgs<'mesh'>): Promise<void> => {
	const targets = await collectTargets(args.targets, args.stdin);
	if (targets.length === 0) {
		throw new Error('inspect mesh needs at least one target or --stdin');
	}
	await withContext(args.config, async (context) => {
		const resolver = await context.resolver();
		const results = [];
		for (const raw of targets) {
			// oxlint-disable-next-line no-await-in-loop -- preserves target order
			const ref = await resolveObjectArg(context, resolver, raw, UnityClass.Mesh, {
				pathId: args.pathId,
				nameFilter: args.name,
			});
			// oxlint-disable-next-line no-await-in-loop -- preserves target order
			const mesh = await loadMesh(resolver, ref);
			if (args.submesh !== undefined && (args.submesh < 0 || args.submesh >= mesh.submeshes.length)) {
				throw new Error(`--submesh must be 0..${mesh.submeshes.length - 1}, got ${args.submesh}`);
			}
			const sampleLimit =
				args.vertices ?? (args.near !== undefined || args.submesh !== undefined ? 20 : undefined);
			results.push({
				object: objectKey(ref),
				...meshSummary(mesh),
				...(sampleLimit === undefined
					? {}
					: {
							vertices: sampleMeshVertices(mesh, sampleLimit, {
								submesh: args.submesh,
								near: args.near,
								radius: args.radius,
							}),
						}),
			});
		}
		console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, '\t'));
	});
};

const round4 = (n: number): number => +n.toFixed(4);

const attributeRange = (
	data: Float32Array,
	dimension: number,
	vertexCount: number,
): { min: number[]; max: number[]; constant: boolean } | null => {
	if (vertexCount === 0 || dimension === 0) {
		return null;
	}
	const min = Array.from({ length: dimension }, () => Infinity);
	const max = Array.from({ length: dimension }, () => -Infinity);
	for (let i = 0; i < vertexCount; i++) {
		const base = i * dimension;
		for (let c = 0; c < dimension; c++) {
			const v = data[base + c];
			if (v < min[c]) {
				min[c] = v;
			}
			if (v > max[c]) {
				max[c] = v;
			}
		}
	}
	const constant = min.every((v, c) => v === max[c]);
	return { min: min.map(round4), max: max.map(round4), constant };
};

const sampleMeshVertices = (
	mesh: DecodedMesh,
	limit: number,
	options: { submesh?: number; near?: readonly number[]; radius?: number } = {},
): object[] => {
	let indices: number[];
	if (options.submesh !== undefined) {
		const sm = mesh.submeshes[options.submesh];
		const seen = new Set<number>();
		indices = [];
		for (let i = sm.firstIndex; i < sm.firstIndex + sm.indexCount; i++) {
			const v = mesh.indices[i];
			if (!seen.has(v)) {
				seen.add(v);
				indices.push(v);
			}
		}
	} else {
		indices = Array.from({ length: mesh.vertexCount }, (_, i) => i);
	}
	if (options.near !== undefined) {
		const [nx, ny, nz] = options.near;
		const maxR2 = (options.radius ?? 2) ** 2;
		indices = indices.filter((i) => {
			const dx = mesh.positions[i * 3] - nx;
			const dy = mesh.positions[i * 3 + 1] - ny;
			const dz = mesh.positions[i * 3 + 2] - nz;
			return dx * dx + dy * dy + dz * dz <= maxR2;
		});
	}
	const out: object[] = [];
	for (const i of indices.slice(0, limit)) {
		const row: Record<string, unknown> = {
			index: i,
			position: [
				round4(mesh.positions[i * 3]),
				round4(mesh.positions[i * 3 + 1]),
				round4(mesh.positions[i * 3 + 2]),
			],
		};
		if (mesh.normals !== null) {
			row.normal = [
				round4(mesh.normals[i * 3]),
				round4(mesh.normals[i * 3 + 1]),
				round4(mesh.normals[i * 3 + 2]),
			];
		}
		if (mesh.colors !== null) {
			const d = mesh.colors.dimension;
			row.color = Array.from({ length: d }, (_, c) => round4(mesh.colors!.data[i * d + c]));
		}
		for (const [uvIndex, uv] of mesh.uvs.entries()) {
			if (uv !== null) {
				const d = uv.dimension;
				row[`uv${uvIndex}`] = Array.from({ length: d }, (_, c) => round4(uv.data[i * d + c]));
			}
		}
		out.push(row);
	}
	return out;
};

const submeshBounds = (mesh: DecodedMesh, firstIndex: number, indexCount: number) => {
	if (indexCount === 0) {
		return null;
	}
	let minX = Infinity;
	let minY = Infinity;
	let minZ = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	let maxZ = -Infinity;
	for (let i = firstIndex; i < firstIndex + indexCount; i++) {
		const v = mesh.indices[i] * 3;
		const x = mesh.positions[v];
		const y = mesh.positions[v + 1];
		const z = mesh.positions[v + 2];
		if (x < minX) {
			minX = x;
		}
		if (y < minY) {
			minY = y;
		}
		if (z < minZ) {
			minZ = z;
		}
		if (x > maxX) {
			maxX = x;
		}
		if (y > maxY) {
			maxY = y;
		}
		if (z > maxZ) {
			maxZ = z;
		}
	}
	return { min: [round4(minX), round4(minY), round4(minZ)], max: [round4(maxX), round4(maxY), round4(maxZ)] };
};

const meshSummary = (mesh: DecodedMesh) => ({
	name: mesh.name,
	vertexCount: mesh.vertexCount,
	triangles: mesh.submeshes.reduce((sum, s) => sum + (s.topology === 0 ? s.indexCount / 3 : 0), 0),
	indexFormat: mesh.indices instanceof Uint16Array ? 'u16' : 'u32',
	bounds: mesh.bounds,
	submeshes: mesh.submeshes.map((sm) => ({
		firstIndex: sm.firstIndex,
		indexCount: sm.indexCount,
		topology: sm.topology,
		bounds: submeshBounds(mesh, sm.firstIndex, sm.indexCount),
	})),
	channels: mapDefined(mesh.channels, (c) =>
		c.dimension > 0
			? `${c.channel}: stream ${c.stream} +${c.offset} format ${c.format} ×${c.dimension}${c.packing ? ` packing ${c.packing}` : ''}`
			: undefined,
	),
	normals: mesh.normals === null ? null : mesh.packedNormals === null ? 'float' : 'packed',
	tangents: mesh.tangents !== null,
	colors: mesh.colors?.dimension ?? null,
	...(mesh.colors === null
		? {}
		: { colorStats: attributeRange(mesh.colors.data, mesh.colors.dimension, mesh.vertexCount) }),
	uvs: mesh.uvs.map((uv) => uv?.dimension ?? null),
	uvRanges: mapDefined(mesh.uvs, (uv, channel) =>
		uv === null ? undefined : { channel, ...attributeRange(uv.data, uv.dimension, mesh.vertexCount) },
	),
	skin: mesh.skin,
});
