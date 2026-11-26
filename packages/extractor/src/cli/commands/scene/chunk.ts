import { basename } from 'node:path/posix';

import {
	FoliageGridType,
	hasFoliageGrids,
	readFoliageGrids,
} from '@endfield-noclip/formats/endfield/foliage-grids';
import { parseInitChunk } from '@endfield-noclip/formats/endfield/init-chunk-data';
import { levelOfTag } from '@endfield-noclip/formats/endfield/level-partition';
import {
	DECAL_MATERIAL_KEY,
	parseStreamingChunk,
	WATER_DECAL_MESH_KEY,
} from '@endfield-noclip/formats/endfield/streaming-chunk-data';

import type { ChunkFile, WorldIndex } from '../../../game/world/world-index.ts';
import { withContext } from '../../../install/context.ts';
import { compareStrings } from '../../../util/compare.ts';
import { hashText, jsonReplacer } from '../../helpers.ts';

import type { SceneSubArgs } from './parser.ts';
import { type AssetNames, entityJson, findLevel, formatHlodLink, layerName } from './shared.ts';

/**
 * runs `endfield-extract scene chunk`
 *
 * @param args parsed CLI arguments
 */
export const runSceneChunk = async (args: SceneSubArgs<'chunk'>): Promise<void> => {
	await withContext(args.config, async (context) => {
		await inspectChunk(context.world, args.scene, args.chunk, {
			pattern: args.name,
			hlodStats: args.hlodStats,
			foliage: args.foliage,
			limit: args.limit,
			json: args.json,
		});
	});
};

const resolveChunkFile = async (
	world: WorldIndex,
	sceneOrLevel: string,
	query: string,
): Promise<{ scene: string; file: ChunkFile }> => {
	const allFiles = await world.chunkFiles();
	let scene = sceneOrLevel;
	let files = allFiles.filter((file) => file.scene === scene);
	if (files.length === 0) {
		const resolved = await findLevel(world, sceneOrLevel).catch(() => null);
		if (resolved !== null) {
			scene = resolved.partition.mapId;
			files = allFiles.filter((file) => file.scene === scene);
		}
	}
	if (files.length === 0) {
		throw new Error(`unknown streaming scene or level ${sceneOrLevel}`);
	}
	const exact = files.find(
		(file) =>
			file.name === query ||
			basename(file.name) === query ||
			basename(file.name) === `InitChunkData_${query}.bytes`,
	);
	if (exact !== undefined) {
		return { scene, file: exact };
	}
	const defaultArea = files.find((file) => basename(file.name) === `InitChunkData_${query}_0_0.bytes`);
	if (defaultArea !== undefined) {
		return { scene, file: defaultArea };
	}
	const partial = files.filter((file) => basename(file.name).includes(query));
	if (partial.length === 1) {
		return { scene, file: partial[0] };
	}
	const hint =
		partial.length === 0
			? ''
			: `\nmatching chunks:\n${partial
					.slice(0, 10)
					.map((f) => `  ${basename(f.name)}`)
					.join('\n')}`;
	throw new Error(
		partial.length === 0
			? `chunk ${query} not found in ${scene}`
			: `chunk ${query} matched ${partial.length} files in ${scene}${hint}`,
	);
};

const inspectChunk = async (
	world: WorldIndex,
	sceneOrLevel: string,
	query: string,
	options: {
		pattern: RegExp | undefined;
		hlodStats: boolean;
		foliage: boolean;
		limit: number;
		json: boolean;
	},
): Promise<void> => {
	const { scene, file } = await resolveChunkFile(world, sceneOrLevel, query);
	const [initBytes, streamingBytes, partition, pathOf] = await Promise.all([
		world.readInitPayload(file),
		world.readStreamingPayload(file),
		world.partition(scene),
		world.pathLookup(),
	]);
	const init = parseInitChunk(initBytes);
	const streaming = streamingBytes === null ? null : parseStreamingChunk(streamingBytes);

	if (options.foliage) {
		const grids =
			hasFoliageGrids(init.rows) && streaming !== null ? readFoliageGrids(init.rows, streaming.raw) : [];
		const matched =
			options.pattern === undefined ? grids : grids.filter((grid) => options.pattern!.test(grid.name));
		const rows = matched.map((grid) => {
			const instances = grid.clusters.reduce((sum, cluster) => sum + cluster.instanceCount, 0);
			const meshes = new Set<string>();
			for (const cluster of grid.clusters) {
				for (const draw of cluster.renderer.draws) {
					if (meshes.size < 4) {
						meshes.add((pathOf(draw.meshHash) ?? hashText(draw.meshHash)).split('##').pop()!);
					}
				}
			}
			return {
				id: grid.id,
				type: grid.type === FoliageGridType.Tree ? 'tree' : 'grass',
				level: (partition && levelOfTag(partition, grid.levelTag)?.id) ?? `tag ${grid.levelTag}`,
				name: grid.name,
				clusters: grid.clusters.length,
				instances,
				sampleMeshes: [...meshes],
			};
		});
		if (options.json) {
			console.log(JSON.stringify({ chunk: basename(file.name), foliage: rows }, null, '\t'));
			return;
		}
		console.log(`${basename(file.name)}: ${rows.length} foliage grids`);
		for (const row of rows) {
			console.log(
				`  ${row.type.padEnd(5)} id=${String(row.id).padEnd(11)} ${String(row.clusters).padStart(5)} clusters  ${String(row.instances).padStart(7)} instances  ${row.name}  (${row.sampleMeshes.join(', ')})`,
			);
		}
		return;
	}

	const entities = await world.readChunk(file, partition);
	const matched =
		options.pattern === undefined
			? entities
			: entities.filter((entity) => options.pattern!.test(entity.name));

	if (options.hlodStats) {
		const stats = new Map<
			string,
			{ layer: string; total: number; withParent: number; clusters: number; noHlod: number }
		>();
		let totalWithParent = 0;
		let totalClusters = 0;
		let totalNoHlod = 0;
		for (const entity of matched) {
			const layer = layerName(entity.layer);
			const bucket = stats.getOrInsertComputed(layer, () => ({
				layer,
				total: 0,
				withParent: 0,
				clusters: 0,
				noHlod: 0,
			}));
			bucket.total++;
			const link = streaming?.hlodLink(entity.id) ?? null;
			const hasParent = link !== null && link.parent !== null;
			const isCluster = link !== null && link.childCount > 0;
			if (hasParent) {
				bucket.withParent++;
				totalWithParent++;
			}
			if (isCluster) {
				bucket.clusters++;
				totalClusters++;
			}
			if (!hasParent && !isCluster) {
				bucket.noHlod++;
				totalNoHlod++;
			}
		}
		const layers = [...stats.values()].toSorted(
			(a, b) => b.total - a.total || compareStrings(a.layer, b.layer),
		);
		if (options.json) {
			console.log(
				JSON.stringify(
					{
						chunk: basename(file.name),
						hasStreaming: streaming !== null,
						total: matched.length,
						withParent: totalWithParent,
						clusters: totalClusters,
						noHlod: totalNoHlod,
						layers,
					},
					null,
					'\t',
				),
			);
			return;
		}
		console.log(
			`${basename(file.name)}: ${matched.length} entities (withParent=${totalWithParent}, clusters=${totalClusters}, noHlod=${totalNoHlod})`,
		);
		console.log('  layer              total  withParent  clusters  noHlod');
		for (const row of layers) {
			console.log(
				`  ${row.layer.padEnd(17)} ${String(row.total).padStart(6)}  ${String(row.withParent).padStart(10)}  ${String(row.clusters).padStart(8)}  ${String(row.noHlod).padStart(6)}`,
			);
		}
		return;
	}

	const shown = matched.slice(0, options.limit);
	const names: AssetNames = { pathOf, assetPathOf: () => undefined, bundleOf: () => null };
	if (options.json) {
		console.log(
			JSON.stringify(
				{
					chunk: basename(file.name),
					hasStreaming: streaming !== null,
					entities: shown.map((entity) => {
						const decalKey =
							entity.decal !== null || entity.waterDecal !== null
								? streaming?.assetProperty(entity.id, DECAL_MATERIAL_KEY)
								: undefined;
						const waterMeshKey =
							entity.waterDecal !== null
								? streaming?.assetProperty(entity.id, WATER_DECAL_MESH_KEY)
								: undefined;
						return {
							...entityJson(entity, partition, names),
							...(decalKey === undefined ? {} : { decalMaterial: pathOf(decalKey) ?? hashText(decalKey) }),
							...(waterMeshKey === undefined
								? {}
								: { waterDecalMesh: pathOf(waterMeshKey) ?? hashText(waterMeshKey) }),
							hlodLink: streaming?.hlodLink(entity.id) ?? null,
						};
					}),
				},
				jsonReplacer,
				'\t',
			),
		);
		return;
	}
	console.log(`${basename(file.name)}: ${matched.length} matching entities`);
	for (const entity of shown) {
		const pos =
			entity.pivot === null
				? '-'
				: `${entity.pivot.x.toFixed(1)},${entity.pivot.y.toFixed(1)},${entity.pivot.z.toFixed(1)}`;
		const size = entity.bounds === null ? '-' : `${(2 * Math.max(...entity.bounds.extents)).toFixed(0)}m`;
		const link = formatHlodLink(streaming?.hlodLink(entity.id) ?? null);
		let lods = 'no-renderer';
		if (entity.renderer !== null) {
			lods = `${entity.renderer.lodCount} lods`;
		} else if (entity.waterDecal !== null) {
			lods = 'water-decal';
		} else if (entity.decal !== null) {
			lods = 'rect-decal';
		}
		console.log(
			`  ${String(entity.id).padEnd(11)} ${layerName(entity.layer).padEnd(14)} ${link.padEnd(22)} ${lods.padEnd(11)} ${size.padStart(5)}  ${pos.padEnd(22)} ${entity.name}`,
		);
	}
	console.error(
		`${shown.length} of ${matched.length} entities${matched.length > options.limit ? ' (raise --limit for more)' : ''}`,
	);
};

// #endregion
