import { parseArgs } from 'node:util';

import { writeKtx2 } from '@endfield-noclip/formats/binary/ktx2';
import { DrawFlags } from '@endfield-noclip/formats/endfield/init-chunk-data';
import type { DecodedMesh } from '@endfield-noclip/formats/unity/mesh';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import { type DecodedTexture, toKtx2Texture } from '@endfield-noclip/formats/unity/texture';

import {
	parseInteger,
	parseOptionalInteger,
	parsePathId,
	save as saveFile,
	separatePositionals,
} from '../cli-args.ts';
import { withContext } from '../context.ts';
import { errorText, failureReason } from '../errors.ts';
import { type GlbScene, writeGlb } from '../export/glb.ts';
import { loadMaterial, loadMesh, loadTexture, type LoadedMaterial } from '../game/asset-decode.ts';
import { type AssetResolver, objectKey, type ObjectRef } from '../game/assets.ts';
import type { IndexedEntity, WorldIndex } from '../game/world-index.ts';
import { zstdSync } from '../zstd.ts';

export const summary =
	'decode assets: mesh|texture|material <bundle> --path-id N [-o file] | entity <map> <x> <z> <index|id> [-o file.glb] | cell <map> <x> <z> -o file.glb';

const USAGE = `usage:
  asset mesh <bundle> --path-id=N [-o file.glb]       mesh summary; -o exports it alone as glTF
  asset texture <bundle> --path-id=N [-o file.ktx2] [--zstd level]
                                                      texture summary; -o writes KTX2 (zstd per level if given)
  asset material <bundle> --path-id=N                 material record, classification and its textures
  asset entity <map> <x> <z> <index|id> [-o file.glb] [--lod n]
                                                      follows an entity's draws to decoded summaries
  asset cell <map> <x> <z> -o file.glb [--lod n] [--layer n] [--state n]
                                                      exports every entity's draws of one LOD as glTF

<bundle> is a bundle hex id, main/<hex>.ab or initial/<hex>.ab. glTF output mirrors Unity's X axis and uses
material base colours only. negative path ids need the --path-id=-N form.`;

const OPTIONS = {
	config: { type: 'string' },
	'path-id': { type: 'string' },
	output: { type: 'string', short: 'o' },
	zstd: { type: 'string' },
	lod: { type: 'string', default: '0' },
	layer: { type: 'string' },
	state: { type: 'string' },
} as const;

export const run = async (args: string[]): Promise<void> => {
	const { values, positionals } = parseArgs({
		args: separatePositionals(args, OPTIONS),
		allowPositionals: true,
		options: OPTIONS,
	});
	const [sub, ...rest] = positionals;
	const pathId = parsePathId(values['path-id'], '--path-id');
	const output = values.output;
	const lod = parseInteger(values.lod, '--lod');

	await withContext(values.config, async (context) => {
		const { world } = context;
		const resolver = await context.resolver();
		const objectArg = async (): Promise<ObjectRef> => {
			const [bundle] = rest;
			if (bundle === undefined || pathId === undefined) {
				throw new Error(`${sub} needs <bundle> --path-id=N\n${USAGE}`);
			}
			return resolver.object(resolver.bundleIndex(bundle), pathId);
		};
		switch (sub) {
			case 'mesh': {
				const mesh = await loadMesh(resolver, await objectArg());
				console.log(JSON.stringify(meshSummary(mesh), null, '\t'));
				if (output !== undefined) {
					const scene: GlbScene = {
						meshes: new Map([['mesh', mesh]]),
						materials: new Map([['white', { name: 'white', baseColor: [1, 1, 1, 1], doubleSided: false }]]),
						draws: mesh.submeshes.map((_, submesh) => ({
							mesh: 'mesh',
							submesh,
							material: 'white',
							matrix: IDENTITY,
							name: `${mesh.name}#${submesh}`,
						})),
					};
					await save(output, writeGlb(scene, [0, 0, 0]));
				}
				break;
			}
			case 'texture': {
				const texture = await loadTexture(resolver, await objectArg());
				console.log(JSON.stringify(textureSummary(texture), null, '\t'));
				if (output !== undefined) {
					await save(output, encodeKtx2(texture, parseOptionalInteger(values.zstd, '--zstd')));
				}
				break;
			}
			case 'material': {
				const material = await loadMaterial(resolver, await objectArg());
				console.log(JSON.stringify(await materialJson(resolver, material), jsonReplacer, '\t'));
				break;
			}
			case 'entity': {
				const [map, x, z, which] = rest;
				if (map === undefined || x === undefined || z === undefined || which === undefined) {
					throw new Error(USAGE);
				}
				const entities = await cellEntities(world, map, x, z, {});
				const index = parseInteger(which, 'entity index or id');
				const entity =
					entities.find((candidate) => candidate.id === index) ??
					(index < entities.length ? entities[index] : undefined);
				if (entity === undefined) {
					throw new Error(`no entity ${which} among the ${entities.length} of ${map} ${x},${z}`);
				}
				const scene = newScene();
				const report = await exportEntity(world, resolver, entity, lod, scene);
				console.log(JSON.stringify(report, jsonReplacer, '\t'));
				if (output !== undefined) {
					await save(output, writeGlb(scene, origin(entity)));
				}
				break;
			}
			case 'cell': {
				const [map, x, z] = rest;
				if (map === undefined || x === undefined || z === undefined || output === undefined) {
					throw new Error(USAGE);
				}
				const entities = await cellEntities(world, map, x, z, {
					layer: parseOptionalInteger(values.layer, '--layer'),
					state: parseOptionalInteger(values.state, '--state'),
				});
				const scene = newScene();
				const failures = new Map<string, number>();
				let draws = 0;
				for (const entity of entities) {
					const report = await exportEntity(world, resolver, entity, lod, scene);
					for (const draw of report.draws) {
						draws++;
						if ('error' in draw) {
							failures.set(draw.error, (failures.get(draw.error) ?? 0) + 1);
						}
					}
				}
				const first = entities.find((entity) => entity.pivot !== null);
				await save(output, writeGlb(scene, first === undefined ? [0, 0, 0] : origin(first)));
				console.log(
					`${entities.length} entities, ${draws} lod-${lod} draws, ${scene.meshes.size} meshes, ${scene.materials.size} materials`,
				);
				for (const [reason, count] of [...failures].toSorted((a, b) => b[1] - a[1])) {
					console.log(`  ${String(count).padStart(5)} × ${reason}`);
				}
				break;
			}
			default: {
				throw new Error(USAGE);
			}
		}
	});
};

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const save = async (path: string, bytes: Uint8Array): Promise<void> => {
	await saveFile(path, bytes);
	console.error(`wrote ${bytes.length} bytes to ${path}`);
};

/** JSON.stringify replacer for bigints and typed arrays */
const jsonReplacer = (_key: string, value: unknown): unknown => {
	if (typeof value === 'bigint') {
		return value.toString();
	}
	if (ArrayBuffer.isView(value)) {
		return `<${value.constructor.name} ${value.byteLength} bytes>`;
	}
	return value;
};

/**
 * @param texture decoded texture
 * @param level zstd level, or `undefined` for no supercompression
 * @returns KTX2 bytes
 */
const encodeKtx2 = (texture: DecodedTexture, level: number | undefined): Uint8Array => {
	return writeKtx2(toKtx2Texture(texture), {
		writer: 'endfield-noclip extractor',
		zstd: level === undefined ? undefined : (data) => zstdSync(data, level),
	});
};

// #region summaries

const meshSummary = (mesh: DecodedMesh) => {
	return {
		name: mesh.name,
		vertexCount: mesh.vertexCount,
		triangles: mesh.submeshes.reduce((sum, s) => sum + (s.topology === 0 ? s.indexCount / 3 : 0), 0),
		indexFormat: mesh.indices instanceof Uint16Array ? 'u16' : 'u32',
		bounds: mesh.bounds,
		submeshes: mesh.submeshes,
		channels: mesh.channels
			.filter((channel) => channel.dimension > 0)
			.map(
				(c) =>
					`${c.channel}: stream ${c.stream} +${c.offset} format ${c.format} ×${c.dimension}${c.packing ? ` packing ${c.packing}` : ''}`,
			),
		normals: mesh.normals === null ? null : mesh.packedNormals === null ? 'float' : 'packed',
		tangents: mesh.tangents !== null,
		colors: mesh.colors?.dimension ?? null,
		uvs: mesh.uvs.map((uv) => uv?.dimension ?? null),
		skin: mesh.skin,
	};
};

const textureSummary = (texture: DecodedTexture) => {
	return {
		name: texture.name,
		kind: texture.kind,
		size: [texture.width, texture.height, texture.depth],
		layers: texture.layers,
		faces: texture.faces,
		mipCount: texture.mipCount,
		format: texture.format,
		vkFormat: texture.vkFormat,
		srgb: texture.srgb,
		colorSpace: texture.colorSpace,
		sampler: texture.sampler,
		levelBytes: texture.levels.map((level) => level.length),
	};
};

const materialJson = async (resolver: AssetResolver, material: LoadedMaterial) => {
	const textures: Record<string, object> = {};
	for (const [slot, resolved] of Object.entries(material.textures)) {
		const source = material.record.textures[slot];
		if (resolved.ref === null) {
			if (resolved.error !== undefined) {
				textures[slot] = { error: resolved.error };
			}
			continue;
		}
		try {
			const texture = await loadTexture(resolver, resolved.ref);
			textures[slot] = {
				object: objectKey(resolved.ref),
				bundle: resolver.manifest.bundle(resolved.ref.bundleIndex).name,
				name: texture.name,
				format: texture.format.name,
				size: [texture.width, texture.height],
				mipCount: texture.mipCount,
				srgb: texture.srgb,
				uvSet: source.uvSet,
				scale: source.scale,
				offset: source.offset,
			};
		} catch (error) {
			textures[slot] = { object: objectKey(resolved.ref), error: errorText(error) };
		}
	}
	const { record } = material;
	return {
		name: record.name,
		shader: material.shader.name,
		classification: material.classification,
		keywords: record.keywords,
		customRenderQueue: record.customRenderQueue,
		tags: record.tags,
		disabledPasses: record.disabledPasses,
		textures,
		floats: record.floats,
		colors: record.colors,
		ints: record.ints,
	};
};

// #endregion

// #region entities

const cellEntities = async (
	world: WorldIndex,
	map: string,
	xArg: string,
	zArg: string,
	filter: { layer?: number; state?: number },
): Promise<IndexedEntity[]> => {
	const x = parseInteger(xArg, 'cell x');
	const z = parseInteger(zArg, 'cell z');
	const partition = await world.partition(map);
	const files = await world.cellChunkFiles(map, { x, z }, filter);
	if (files.length === 0) {
		throw new Error(`no InitChunkData for ${map} ${x},${z}`);
	}
	const perFile = await Promise.all(files.map((file) => world.readChunk(file, partition)));
	return perFile.flat();
};

const newScene = (): GlbScene => ({ meshes: new Map(), materials: new Map(), draws: [] });

const origin = (entity: IndexedEntity): [number, number, number] => {
	const p = entity.pivot;
	return p === null ? [0, 0, 0] : [Math.round(p.x), Math.round(p.y), Math.round(p.z)];
};

type DrawReport =
	| { lod: number; submesh: number; mesh: object; material: object }
	| { lod: number; submesh: number; meshPath: string | undefined; error: string };

/**
 * resolves an entity's draws of one LOD (shadow-only draws skipped), adding them to `scene`
 *
 * @returns per-draw summaries, with an `error` reason for draws that failed
 */
const exportEntity = async (
	world: WorldIndex,
	resolver: AssetResolver,
	entity: IndexedEntity,
	lod: number,
	scene: GlbScene,
): Promise<{ id: number; name: string; draws: DrawReport[] }> => {
	const draws: DrawReport[] = [];
	for (const draw of entity.renderer?.draws ?? []) {
		if (draw.lod !== lod || (draw.flags & DrawFlags.ShadowOnly) !== 0 || entity.matrix === null) {
			continue;
		}
		const meshPath = await world.pathOf(draw.meshHash);
		try {
			const [meshKey, mesh] = await resolveMesh(resolver, draw.meshHash, meshPath, scene);
			const materialPath = await world.pathOf(draw.materialHash);
			const [materialKey, material] = await resolveMaterial(resolver, draw.materialHash, materialPath, scene);
			scene.draws.push({
				mesh: meshKey,
				submesh: draw.submesh,
				material: materialKey,
				matrix: entity.matrix,
				name: `${entity.name}#${draw.lod}.${draw.submesh}`,
			});
			draws.push({
				lod: draw.lod,
				submesh: draw.submesh,
				mesh: {
					name: mesh.name,
					vertexCount: mesh.vertexCount,
					submeshes: mesh.submeshes.length,
					bounds: mesh.bounds,
				},
				material: {
					name: material.record.name,
					shader: material.shader.name,
					...material.classification,
					textures: Object.fromEntries(
						Object.entries(material.textures)
							.filter(([, slot]) => slot.ref !== null || slot.error !== undefined)
							.map(([slot, resolved]) => [
								slot,
								resolved.ref === null ? { error: resolved.error } : objectKey(resolved.ref),
							]),
					),
				},
			});
		} catch (error) {
			draws.push({
				lod: draw.lod,
				submesh: draw.submesh,
				meshPath,
				error: failureReason(error),
			});
		}
	}
	return { id: entity.id, name: entity.name, draws };
};

const resolveMesh = async (
	resolver: AssetResolver,
	hash: bigint,
	path: string | undefined,
	scene: GlbScene,
): Promise<[string, DecodedMesh]> => {
	const key = hash.toString(16);
	const cached = scene.meshes.get(key);
	if (cached !== undefined) {
		return [key, cached];
	}
	const ref = await resolver.findUnique({ hash, path: path ?? null }, UnityClass.Mesh);
	const mesh = await loadMesh(resolver, ref);
	scene.meshes.set(key, mesh);
	return [key, mesh];
};

const materialCache = new WeakMap<GlbScene, Map<string, LoadedMaterial>>();

const resolveMaterial = async (
	resolver: AssetResolver,
	hash: bigint,
	path: string | undefined,
	scene: GlbScene,
): Promise<[string, LoadedMaterial]> => {
	const key = hash.toString(16);
	let cache = materialCache.get(scene);
	if (cache === undefined) {
		cache = new Map();
		materialCache.set(scene, cache);
	}
	const cached = cache.get(key);
	if (cached !== undefined) {
		return [key, cached];
	}
	const ref = await resolver.findUnique({ hash, path: path ?? null }, UnityClass.Material);
	const material = await loadMaterial(resolver, ref);
	cache.set(key, material);
	const color = material.record.colors['_BaseColor'] ?? [1, 1, 1, 1];
	scene.materials.set(key, {
		name: material.record.name,
		baseColor: [color[0], color[1], color[2], 1],
		doubleSided: material.classification.cull === 'none',
	});
	return [key, material];
};

// #endregion
