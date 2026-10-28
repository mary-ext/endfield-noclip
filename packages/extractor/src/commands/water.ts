import { parseArgs } from 'node:util';

import { levelOfTag, type LevelPartition } from '@endfield-noclip/formats/endfield/level-partition';
import { CELL_SIZE } from '@endfield-noclip/formats/endfield/map-config';
import {
	isWaterGlobalConfig,
	readWaterGlobalConfig,
	readWaterSurfaceConfig,
	type WaterGlobalConfig,
} from '@endfield-noclip/formats/endfield/water';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import type { PPtr } from '@endfield-noclip/formats/unity/values';

import {
	hashText as hex,
	jsonReplacer,
	need as needArg,
	parseHash,
	parseInteger,
	separatePositionals,
} from '../cli-args.ts';
import { type Context, withContext } from '../context.ts';
import { errorText } from '../errors.ts';
import { loadMesh, loadTexture } from '../game/asset-decode.ts';
import { type AssetResolver, objectKey, type ObjectRef } from '../game/assets.ts';
import {
	loadSectorTexture,
	loadWaterSurfaceConfig,
	readSceneWater,
	type SourcedWaterSurface,
} from '../game/water-source.ts';
import type { WorldIndex } from '../game/world-index.ts';
import { mapPool } from '../pool.ts';

/** assets decoded at once by `--resolve` */
const RESOLVE_CONCURRENCY = 16;

export const summary =
	'water surfaces: surfaces <map> [<level> | <x> <z>] [--resolve] [--json] | census <map> | config <path|hash>';

const USAGE = `usage:
  water surfaces <map> [<level> | <x> <z>] [--resolve] [--json]
                              water surfaces of a map, of one level (by id tag) or overlapping one cell;
                              --resolve loads each distinct mesh and config
  water census <map>          surface counts by level, chunk file, render mask, mesh and config
  water config <path|hash>    a surface WaterConfig or a Global_Water_Config as JSON; the global one also
                              resolves its textures and surface configs`;

const OPTIONS = {
	config: { type: 'string' },
	json: { type: 'boolean', default: false },
	resolve: { type: 'boolean', default: false },
} as const;

export const run = async (args: string[]): Promise<void> => {
	const { values, positionals } = parseArgs({
		args: separatePositionals(args, OPTIONS),
		allowPositionals: true,
		options: OPTIONS,
	});
	const [sub, ...rest] = positionals;

	await withContext(values.config, async (context) => {
		switch (sub) {
			case 'surfaces': {
				await listSurfaces(context, need(rest[0], 'map'), rest.slice(1), {
					json: values.json,
					resolve: values.resolve,
				});
				break;
			}
			case 'census': {
				await census(context.world, need(rest[0], 'map'));
				break;
			}
			case 'config': {
				await dumpConfig(context, need(rest[0], 'path or hash'));
				break;
			}
			default: {
				throw new Error(USAGE);
			}
		}
	});
};

const need = (value: string | undefined, what: string): string => needArg(value, what, USAGE);

// #region surfaces

const listSurfaces = async (
	context: Context,
	mapId: string,
	where: string[],
	options: { json: boolean; resolve: boolean },
): Promise<void> => {
	const { world } = context;
	const partition = await world.partition(mapId);
	const { surfaces } = await readSceneWater(world, mapId);

	let selected = surfaces;
	if (where.length === 1) {
		const level = partition?.levels.find((candidate) => candidate.id === where[0]);
		if (level === undefined) {
			throw new Error(`${where[0]} isn't a level of ${mapId}`);
		}
		selected = surfaces.filter((surface) => surface.levelTag === level.tag);
	} else if (where.length === 2) {
		const x = parseInteger(where[0], 'cell x');
		const z = parseInteger(where[1], 'cell z');
		selected = surfaces.filter((surface) => overlapsCell(surface, x, z));
	}

	const lookup = await world.pathLookup();
	let resolved = new Map<bigint, object>();
	if (options.resolve) {
		const resolver = await context.resolver();
		const kinds = new Map<bigint, 'mesh' | 'config'>();
		for (const surface of selected) {
			if (!kinds.has(surface.meshHash)) {
				kinds.set(surface.meshHash, 'mesh');
			}
			if (!kinds.has(surface.configHash)) {
				kinds.set(surface.configHash, 'config');
			}
		}
		resolved = new Map(
			await mapPool([...kinds], RESOLVE_CONCURRENCY, async ([hash, kind]): Promise<[bigint, object]> => [
				hash,
				await resolveAsset(resolver, hash, lookup(hash) ?? null, kind),
			]),
		);
	}

	if (options.json) {
		const rows = selected.map((surface) => ({
			id: surface.id,
			levelTag: surface.levelTag,
			level: levelName(partition, surface.levelTag),
			name: surface.name,
			source: surface.source.name,
			renderTypeMask: surface.renderTypeMask,
			runtimeMeshId: surface.runtimeMeshId,
			matrix: [...surface.matrix],
			bounds: surface.bounds,
			param0: surface.param0,
			param1: surface.param1,
			mesh: lookup(surface.meshHash) ?? hex(surface.meshHash),
			config: lookup(surface.configHash) ?? hex(surface.configHash),
			...(options.resolve
				? { meshAsset: resolved.get(surface.meshHash), configAsset: resolved.get(surface.configHash) }
				: {}),
		}));
		console.log(JSON.stringify(rows, jsonReplacer, '\t'));
		return;
	}

	console.log(`${selected.length} of ${surfaces.length} water surfaces`);
	console.log(
		'        id lvl  m  position (x,y,z)            size (x,z)       param1           mesh / config',
	);
	for (const surface of selected) {
		const m = surface.matrix;
		const position = `${m[12].toFixed(1)},${m[13].toFixed(1)},${m[14].toFixed(1)}`;
		const size = `${(surface.bounds.extents[0] * 2).toFixed(1)}×${(surface.bounds.extents[2] * 2).toFixed(1)}`;
		const meshPath = lookup(surface.meshHash) ?? hex(surface.meshHash);
		const configPath = lookup(surface.configHash) ?? hex(surface.configHash);
		console.log(
			`${String(surface.id).padStart(10)} ${String(surface.levelTag).padStart(3)}  ${surface.renderTypeMask}  ${position.padEnd(27)} ${size.padEnd(16)} ${surface.param1
				.map((v) => +v.toFixed(2))
				.join(',')
				.padEnd(16)} ${shortPath(meshPath)} / ${shortPath(configPath)}  ${surface.name}`,
		);
	}
	if (options.resolve) {
		console.log('\nresolved assets:');
		for (const [hash, asset] of resolved) {
			console.log(`  ${shortPath(lookup(hash) ?? hex(hash))}: ${JSON.stringify(asset, jsonReplacer)}`);
		}
	}
};

/** @returns whether the surface's world bounds overlap the cell's square */
const overlapsCell = (surface: SourcedWaterSurface, x: number, z: number): boolean => {
	const { center, extents } = surface.bounds;
	return (
		center[0] + extents[0] > x * CELL_SIZE &&
		center[0] - extents[0] < (x + 1) * CELL_SIZE &&
		center[2] + extents[2] > z * CELL_SIZE &&
		center[2] - extents[2] < (z + 1) * CELL_SIZE
	);
};

const resolveAsset = async (
	resolver: AssetResolver,
	hash: bigint,
	path: string | null,
	kind: 'mesh' | 'config',
): Promise<object> => {
	try {
		if (kind === 'mesh') {
			const ref = await resolver.findUnique({ hash, path }, UnityClass.Mesh);
			const mesh = await loadMesh(resolver, ref);
			return {
				object: objectKey(ref),
				name: mesh.name,
				vertexCount: mesh.vertexCount,
				submeshes: mesh.submeshes.length,
				bounds: mesh.bounds,
				uvs: mesh.uvs.map((uv) => uv?.dimension ?? null),
				colors: mesh.colors?.dimension ?? null,
			};
		}
		const { ref, config } = await loadWaterSurfaceConfig(resolver, { hash, path });
		return { object: objectKey(ref), name: config.name, materialIndex: config.values.materialIndex ?? null };
	} catch (error) {
		return { error: errorText(error) };
	}
};

// #endregion

// #region census

const census = async (world: WorldIndex, mapId: string): Promise<void> => {
	const partition = await world.partition(mapId);
	const { surfaces, globals } = await readSceneWater(world, mapId);
	const lookup = await world.pathLookup();
	const tally = (label: string, key: (surface: SourcedWaterSurface) => string): void => {
		const counts = new Map<string, number>();
		for (const surface of surfaces) {
			counts.set(key(surface), (counts.get(key(surface)) ?? 0) + 1);
		}
		console.log(`\nby ${label} (${counts.size}):`);
		for (const [value, count] of [...counts].toSorted((a, b) => b[1] - a[1])) {
			console.log(`  ${String(count).padStart(6)}  ${value}`);
		}
	};
	console.log(`${mapId}: ${surfaces.length} water surfaces, ${globals.length} global config bindings`);
	tally('level', (s) => `${String(s.levelTag).padStart(2)} ${levelName(partition, s.levelTag) ?? ''}`);
	tally('chunk file', (s) => s.source.name.split('/').pop() ?? '');
	tally('render type mask', (s) => String(s.renderTypeMask));
	tally('mesh', (s) => lookup(s.meshHash) ?? hex(s.meshHash));
	tally('config', (s) => shortPath(lookup(s.configHash) ?? hex(s.configHash)));
	tally('mask × mesh kind', (s) => `${s.renderTypeMask} ${meshKind(lookup(s.meshHash) ?? '')}`);
	tally('param1', (s) => s.param1.map((v) => +v.toFixed(3)).join(','));
	console.log('\nglobal config bindings:');
	for (const binding of globals) {
		console.log(
			`  ${String(binding.id).padStart(10)} t${binding.levelTag} ${binding.name} → ${lookup(binding.configHash) ?? hex(binding.configHash)}`,
		);
	}
};

/** a coarse mesh family, for the census */
const meshKind = (path: string): string => {
	const lower = path.toLowerCase();
	if (lower.includes('/polygonmeshes/')) {
		return 'polygon .asset';
	}
	if (lower.includes('pcgwater')) {
		return 'pcg water fbx';
	}
	return path.split('##').pop() ?? path;
};

// #endregion

// #region config

const dumpConfig = async (context: Context, query: string): Promise<void> => {
	const { world } = context;
	let hash = parseHash(query);
	let path: string | null;
	if (hash !== null) {
		path = (await world.pathOf(hash)) ?? null;
	} else {
		const hashes = await world.hashesOf(query);
		if (hashes.length === 0) {
			throw new Error(`${query} is not in StringPathHash`);
		}
		hash = hashes[0];
		path = query;
	}
	const resolver = await context.resolver();
	const ref = await resolver.findUnique({ hash, path }, UnityClass.MonoBehaviour);
	const value = await resolver.read(ref);
	const header = { path, object: objectKey(ref), bundle: resolver.manifest.bundle(ref.bundleIndex).name };
	if (isWaterGlobalConfig(value)) {
		const config = readWaterGlobalConfig(value);
		console.log(
			JSON.stringify({ ...header, ...(await globalJson(resolver, ref, config)) }, jsonReplacer, '\t'),
		);
		return;
	}
	console.log(
		JSON.stringify({ ...header, ...readWaterSurfaceConfig(ref.info.type.nodes, value) }, jsonReplacer, '\t'),
	);
};

const globalJson = async (
	resolver: AssetResolver,
	from: ObjectRef,
	config: WaterGlobalConfig,
): Promise<object> => {
	const texture = async (pptr: PPtr): Promise<object | null> => {
		try {
			const ref = await resolver.resolve(from, pptr);
			if (ref === null) {
				return null;
			}
			const t = await loadTexture(resolver, ref);
			return {
				object: objectKey(ref),
				bundle: resolver.manifest.bundle(ref.bundleIndex).name,
				name: t.name,
				kind: t.kind,
				size: [t.width, t.height],
				layers: t.layers,
				mipCount: t.mipCount,
				format: t.format.name,
				srgb: t.srgb,
				sampler: t.sampler,
			};
		} catch (error) {
			return { error: errorText(error) };
		}
	};
	const surfaceConfigs = await Promise.all(
		config.surfaceConfigs.map(async (pptr): Promise<object> => {
			try {
				const ref = await resolver.resolve(from, pptr);
				if (ref === null) {
					return { null: true };
				}
				const value: TypeTreeObject = await resolver.read(ref);
				return { object: objectKey(ref), name: value.m_Name, materialIndex: value.materialIndex };
			} catch (error) {
				return { error: errorText(error) };
			}
		}),
	);
	const xs = config.sectors.map((sector) => sector.x);
	const zs = config.sectors.map((sector) => sector.z);
	return {
		name: config.name,
		scenePath: config.scenePath,
		sceneCenterOffset: config.sceneCenterOffset,
		mapSize: config.mapSize,
		sectorSize: config.sectorSize,
		flowmapPrecision: config.flowmapPrecision,
		useSectorData: config.useSectorData,
		grid: config.grid,
		textures: {
			flowMap: await texture(config.flowMap),
			causticMap: await texture(config.causticMap),
			rainMap: await texture(config.rainMap),
			normalMapArray: await texture(config.normalMapArray),
		},
		surfaceConfigs,
		sectors: {
			count: config.sectors.length,
			range:
				config.sectors.length === 0
					? null
					: { x: [Math.min(...xs), Math.max(...xs)], z: [Math.min(...zs), Math.max(...zs)] },
			sample: config.sectors.slice(0, 3),
			sampleTexture: config.sectors.length === 0 ? null : await sectorTexture(resolver, config.sectors[0]),
		},
	};
};

const sectorTexture = async (
	resolver: AssetResolver,
	sector: WaterGlobalConfig['sectors'][number],
): Promise<object> => {
	try {
		const { sector: ref, texture: textureRef } = await loadSectorTexture(resolver, sector);
		if (textureRef === null) {
			return { object: objectKey(ref), texture: null };
		}
		const t = await loadTexture(resolver, textureRef);
		return {
			object: objectKey(ref),
			texture: {
				name: t.name,
				size: [t.width, t.height],
				mipCount: t.mipCount,
				format: t.format.name,
				srgb: t.srgb,
			},
		};
	} catch (error) {
		return { error: errorText(error) };
	}
};

// #endregion

// #region formatting

const levelName = (partition: LevelPartition | undefined, tag: number): string | null =>
	(partition && levelOfTag(partition, tag)?.id) ?? null;

/** drops the directory part of a path, keeping an FBX sub-asset suffix */
const shortPath = (path: string): string => path.split('/').pop() ?? path;

// #endregion
