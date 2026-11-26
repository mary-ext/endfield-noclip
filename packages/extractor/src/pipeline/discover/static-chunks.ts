import type { ClothGroup } from '@endfield-noclip/formats/endfield/cloth-groups';
import { FoliageGridType } from '@endfield-noclip/formats/endfield/foliage-grids';
import { levelTagOf } from '@endfield-noclip/formats/endfield/level-partition';
import type { MonoObject } from '@endfield-noclip/formats/endfield/mono-objects';
import { readReflectionProbe } from '@endfield-noclip/formats/endfield/reflection-probe';
import type { WaterGlobalBinding, WaterSurface } from '@endfield-noclip/formats/endfield/water';
import type { Aabb } from '@endfield-noclip/formats/unity/values';
import type { ChainDraw } from '@endfield-noclip/package-format/instances';
import { type TileKey, tileAt, tileId } from '@endfield-noclip/package-format/tiles';

import { collectSceneVolumes, type SceneVolumes } from '../../game/environment.ts';
import type { Visibility } from '../../game/state/scene-control.ts';
import { collectSceneWater, type SceneWater } from '../../game/water/water-source.ts';
import type { ChunkContent, ChunkFile, ChunkSource, WorldIndex } from '../../game/world/world-index.ts';
import { VfsGroup } from '../../install/vfs.ts';
import { compareStrings } from '../../util/compare.ts';
import { orderedPool } from '../../util/pool.ts';
import type { PackCache } from '../cache/pack-cache.ts';
import { chunkEntityPlacement } from '../instances/chains.ts';
import type { CollectedRow } from '../instances/collector.ts';
import { HLOD_NAME, type HlodCandidates, hlodCandidates, pickHlodTile } from '../instances/hlod-cells.ts';
import { type InstanceInput, rowReach } from '../instances/instances.ts';

import { decalPlacement, type PackContent } from './pack-content.ts';

const WORLD_INDEX_ENTRY = new URL('../../game/world/world-index.ts', import.meta.url);

// the scene's chunk files: static entities, foliage grids and local lights, filed as
// docs/extraction.md#how-the-packer-files-instances describes

/** reads ahead this many chunk files while decoding the current one */
const READ_AHEAD = 8;

const STATIC_COUNTS = [
	'read',
	'unique',
	'noRenderer',
	'decal',
	'decalSkipped',
	'noMatrix',
	'noBounds',
	'excluded',
	'packed',
	'clothSimulated',
	'foliageGrids',
	'foliageInstances',
];

/** an HLOD cluster entity waiting for its cell */
interface HlodCluster extends CollectedRow {
	tier: number;
	/** the tiles its named cell may be */
	candidates: HlodCandidates;
	/** a conditional set index for clusters of a stream area, else `null` */
	condition: number | null;
}

/** rows of one entity or foliage grid and where it was first met */
interface StaticRows {
	rows: InstanceInput[];
	/** when set, `rows` came from foliage clusters (grass clusters pack into `.fol`, trees into `.inst`) */
	foliageClusters?: {
		grass: boolean;
		chain: number;
		bounds: Aabb;
		rendererHalfSize: number;
		sparsity: number;
		entityId: number;
		instances: Float32Array;
	}[];
	tag: number;
	name: string;
	/** chunk-file index */
	file: number;
	/** from a Global chunk file */
	global: boolean;
	/** an HLOD cluster's name match, or `null` for other renderers */
	hlod: RegExpExecArray | null;
}

/** what {@link collectStaticChunks} produces besides rows filed into {@link PackContent} */
export interface StaticChunkSummary {
	/** how many HLOD clusters' bounds centres lie in the tile they're filed under */
	hlodNameMatches: number;
	/** environment and post-processing volumes of the scene's default-area chunks */
	chunkVolumes: SceneVolumes;
	/** placed water surfaces and global config bindings of the scene's Global chunks */
	sceneWater: SceneWater;
	/** unique cloth simulation groups whose cloths are referenced by packed entities */
	clothGroups: ClothGroup[];
}

/**
 * reads the scene's chunk files into the pack's content: static entities, foliage grids and local lights,
 * collecting chunk environment/post volumes and Global-chunk water in the same pass. decoded chunk files are
 * memoized individually in `cache` by their Init/Streaming catalog MD5s
 *
 * @param world the world index
 * @param content the pack's content; rows, lights, counts and skipped entities are added
 * @param cache optional pack cache for per-chunk-file memos
 * @returns HLOD name-match tally, chunk environment volumes and Global-chunk water
 */
export const collectStaticChunks = async (
	world: WorldIndex,
	content: PackContent,
	cache: PackCache | null = null,
): Promise<StaticChunkSummary> => {
	const { scene, collector, controls, seen } = content;
	const { grid, subset } = scene;
	// listed in the report even at zero
	for (const key of STATIC_COUNTS) {
		content.count(key, 0);
	}
	const chunkFp = cache === null ? null : await cache.fingerprint(WORLD_INDEX_ENTRY);
	const partitionKey = scene.partition?.levels.map(({ id, tag }) => `${id}:${tag}`) ?? null;
	// rows of scene-state and stream-area files, by entity or foliage grid id, with every file holding them;
	// added once all files are read
	const gatedRows = new Map<number, StaticRows & { sources: ChunkSource[] }>();
	let hlodNameMatches = 0;
	/** HLOD clusters whose name leaves more than one tile: clamped coordinates, or a misaligned tier */
	const unresolvedHlod: (HlodCluster & { visibility: Visibility | null })[] = [];
	/** bounds of always-loaded detail instances by `tileId/levelTag` */
	const detailBounds = new Map<string, Aabb[]>();
	const volumeFiles: { file: ChunkFile; objects: readonly MonoObject[] }[] = [];
	const waterFiles: {
		file: ChunkFile;
		surfaces: readonly WaterSurface[];
		globals: readonly WaterGlobalBinding[];
	}[] = [];
	const allClothGroups = new Map<number, ClothGroup>();
	const usedClothHashes = new Set<number>();

	const addHlod = (cluster: HlodCluster & { visibility: Visibility | null }, key: TileKey): void => {
		const [x, , z] = cluster.row.bounds.center;
		const at = tileAt(grid, key.level, x, z);
		if (at.x === key.x && at.z === key.z) {
			hlodNameMatches++;
		}
		collector.addHlod({ ...cluster, key });
		content.uses.note(cluster.row.chain, key);
	};

	/** sends a row to its destination: HLOD node, Global block, detail leaf or conditional leaf */
	const addRow = (
		{ row, tag, name, file, global, hlod }: Omit<StaticRows, 'rows'> & { row: InstanceInput },
		/** when it loads, `null` for always */
		visibility: Visibility | null,
		/** whether a scene state gates it, so no HLOD stands in for it */
		stateGated: boolean,
	): void => {
		const entry = { tag, row, name, file };
		const condition = visibility === null ? null : controls.condition(visibility);
		if (hlod !== null && !stateGated) {
			const tier = Number(hlod[1]);
			const candidates = hlodCandidates({
				tree: grid,
				layout: scene.hlod,
				sample: { tier, x: Number(hlod[2]), z: Number(hlod[3]) },
				bounds: row.bounds,
			});
			const cluster = { ...entry, tier, candidates, condition, visibility };
			if (candidates.x[0] === candidates.x[1] && candidates.z[0] === candidates.z[1]) {
				addHlod(cluster, { level: candidates.level, x: candidates.x[0], z: candidates.z[0] });
			} else {
				// resolved once every detail instance is known
				unresolvedHlod.push(cluster);
			}
			return;
		}
		if (global) {
			collector.addGlobal({ ...entry, condition });
			content.uses.note(row.chain, null);
			return;
		}
		const key = tileAt(grid, grid.leafLevel, row.bounds.center[0], row.bounds.center[2]);
		if (stateGated && visibility !== null) {
			collector.addConditional({ ...entry, key, visibility, reach: null });
		} else {
			collector.addDetail({ ...entry, condition, key });
			detailBounds.getOrInsertComputed(`${tileId(key)}/${tag}`, () => []).push(row.bounds);
		}
		content.uses.note(row.chain, key);
	};

	const emitRows = (rows: StaticRows, visibility: Visibility | null, stateGated: boolean): void => {
		if (rows.foliageClusters !== undefined) {
			for (const cluster of rows.foliageClusters) {
				const key = tileAt(grid, grid.leafLevel, cluster.bounds.center[0], cluster.bounds.center[2]);
				if (cluster.grass) {
					collector.addFoliage({
						tag: rows.tag,
						key,
						cluster: {
							chain: cluster.chain,
							bounds: cluster.bounds,
							rendererHalfSize: cluster.rendererHalfSize,
							sparsity: cluster.sparsity,
							instances: cluster.instances,
						},
						visibility,
						conditional: stateGated && visibility !== null,
					});
					if (!stateGated) {
						detailBounds.getOrInsertComputed(`${tileId(key)}/${rows.tag}`, () => []).push(cluster.bounds);
					}
					content.uses.note(cluster.chain, key);
				}
			}
			for (const row of rows.rows) {
				addRow({ ...rows, row }, visibility, stateGated);
			}
			return;
		}
		for (const row of rows.rows) {
			addRow({ ...rows, row }, visibility, stateGated);
		}
	};

	/** files rows met first in `file`, or holds them back when the file is gated */
	const place = (id: number, rows: StaticRows, file: ChunkSource): void => {
		if (file.sceneState !== 0 || file.area !== 0) {
			gatedRows.set(id, { ...rows, sources: [file] });
			return;
		}
		emitRows(rows, null, false);
	};

	const readCachedChunk = async (file: ChunkFile): Promise<ChunkContent> => {
		const cached = scene.globalChunks.get(file.name);
		if (cached !== undefined) {
			scene.globalChunks.delete(file.name);
			return cached;
		}
		if (cache === null || chunkFp === null) {
			return world.readChunkContent(file, scene.partition);
		}
		const [initFile, streamingFile] = await Promise.all([
			world.vfs.find(VfsGroup.Streaming, file.name),
			world.vfs.find(VfsGroup.Streaming, file.name.replace('/InitChunkData_', '/StreamingChunkData_')),
		]);
		const key = cache.keyWith(chunkFp, {
			kind: 'chunkContent',
			file: file.name,
			initMd5: initFile?.entry.dataMd5 ?? null,
			streamingMd5: streamingFile?.entry.dataMd5 ?? null,
			partition: partitionKey,
		});
		const recalled = await cache.recallValue<ChunkContent>(key);
		if (recalled !== undefined) {
			return recalled;
		}
		const decoded = await world.readChunkContent(file, scene.partition);
		await cache.rememberValue(key, decoded);
		return decoded;
	};

	// files are settled in order, for a deterministic dedupe
	await orderedPool(scene.files, READ_AHEAD + 1, readCachedChunk, (read, file, fileIndex) => {
		if (read instanceof Error) {
			throw read;
		}
		if (read.monoObjects.length > 0) {
			volumeFiles.push({ file, objects: read.monoObjects });
			for (const object of read.monoObjects) {
				const probe = readReflectionProbe(object);
				if (probe !== undefined && subset.includesPoint(levelTagOf(probe.id), probe.center)) {
					content.reflectionProbes.add(probe, file);
				}
			}
		}
		if (read.waterSurfaces.length > 0 || read.waterGlobals.length > 0) {
			waterFiles.push({ file, surfaces: read.waterSurfaces, globals: read.waterGlobals });
		}
		for (const light of read.lights) {
			if (subset.includesPoint(light.levelTag, light.position)) {
				content.lights.add(light, file);
			}
		}
		/** @returns whether the entity or grid was met before, adding the file to its sources if so */
		const repeat = (id: number): boolean => {
			if (!seen.has(id)) {
				seen.add(id);
				return false;
			}
			gatedRows.get(id)?.sources.push(file);
			return true;
		};
		for (const entity of read.entities) {
			content.count('read');
			if (repeat(entity.id)) {
				continue;
			}
			content.count('unique');
			const { renderer } = entity;
			let decalMaterial: bigint | undefined;
			let waterDecalMesh: bigint | undefined;
			if (entity.decal !== null) {
				decalMaterial = read.decalMaterials.get(entity.id);
				if (decalMaterial === undefined || content.decalCubeHash() === undefined) {
					content.count('decalSkipped');
					content.skipped.add('static', decalSkipReason(decalMaterial), entity);
					continue;
				}
				content.count('decal');
			} else if (entity.waterDecal !== null) {
				decalMaterial = read.decalMaterials.get(entity.id);
				waterDecalMesh = read.waterDecalMeshes.get(entity.id);
				if (decalMaterial === undefined || waterDecalMesh === undefined) {
					content.count('waterDecalSkipped');
					content.skipped.add('static', 'water decal without its mesh or material', entity);
					continue;
				}
				content.count('waterDecal');
			} else if (renderer === null) {
				content.count('noRenderer');
				content.skipped.add('static', 'no renderer', entity);
				continue;
			}
			if (entity.matrix === null) {
				content.count('noMatrix');
				content.skipped.add('static', 'no matrix', entity);
				continue;
			}
			// without bounds a row can't be filed, culled or sized for LOD
			if (entity.bounds === null) {
				content.count('noBounds');
				content.skipped.add('static', 'no bounds', entity);
				continue;
			}
			if (!subset.includesPoint(entity.levelTag, entity.bounds.center)) {
				content.count('excluded');
				continue;
			}
			content.count('packed');
			if (entity.clothHash !== null) {
				content.count('clothSimulated');
				usedClothHashes.add(entity.clothHash);
			}
			let draws: ChainDraw[];
			if (renderer !== null) {
				draws = renderer.draws.map((draw) => content.rendererDraw(draw));
			} else if (entity.decal !== null) {
				draws = [content.decalDraw(decalMaterial!)!];
			} else {
				draws = [content.waterDecalDraw(waterDecalMesh!, decalMaterial!, entity.waterDecal!)];
			}
			const placement = chunkEntityPlacement({ ...entity, matrix: entity.matrix });
			const row: InstanceInput = {
				chain: content.chains.intern(draws, placement),
				matrix: entity.matrix,
				bounds: entity.bounds,
				entityId: entity.id,
			};
			if (entity.decal !== null) {
				row.decalPlacement = decalPlacement(entity.decal);
			}
			if (entity.rotator !== null) {
				row.spin = entity.rotator;
			}
			if (entity.clothHash !== null) {
				row.clothHash = entity.clothHash;
			}
			place(
				entity.id,
				{
					rows: [row],
					tag: entity.levelTag,
					name: entity.name,
					file: fileIndex,
					global: file.cell === null,
					// an entity named as a cluster that nothing links to is never hidden: plain scenery
					hlod: read.hlodClusters.has(entity.id) ? HLOD_NAME.exec(entity.name) : null,
				},
				file,
			);
			collector.noteOwner(entity.levelTag, rowReach(row));
		}
		for (const group of read.clothGroups) {
			if (!allClothGroups.has(group.groupHash)) {
				allClothGroups.set(group.groupHash, group);
			}
		}
		for (const foliage of read.foliage) {
			if (repeat(foliage.id)) {
				continue;
			}
			content.count('foliageGrids');
			const isGrass = foliage.type === FoliageGridType.Grass;
			// grass clusters pack into compact `.fol` blobs; tree grids stay in `.inst`
			const rows: InstanceInput[] = [];
			const foliageClusters: NonNullable<StaticRows['foliageClusters']> = [];
			let instanceTotal = 0;
			for (const cluster of foliage.clusters) {
				if (!subset.includesPoint(foliage.levelTag, cluster.bounds.center)) {
					continue;
				}
				const draws = cluster.renderer.draws.map((draw) => content.rendererDraw(draw));
				const chain = content.chains.intern(draws);
				instanceTotal += cluster.instanceCount;
				if (!isGrass) {
					for (let i = 0; i < cluster.instanceCount; i++) {
						const matrix = cluster.instances.subarray(i * 16, i * 16 + 16);
						rows.push({ chain, matrix, bounds: cluster.bounds, entityId: foliage.id });
					}
				}
				if (isGrass && cluster.instanceCount > 0) {
					let sparsity = 0;
					for (const draw of cluster.renderer.draws) {
						if (draw.sparsity !== undefined && draw.sparsity > sparsity) {
							sparsity = draw.sparsity;
						}
					}
					foliageClusters.push({
						grass: true,
						chain,
						bounds: cluster.bounds,
						rendererHalfSize: cluster.rendererHalfSize,
						sparsity: sparsity > 0 ? sparsity : 1,
						entityId: foliage.id,
						instances: cluster.instances.subarray(0, cluster.instanceCount * 16),
					});
				}
				collector.noteOwner(foliage.levelTag, cluster.bounds);
			}
			content.count('foliageInstances', instanceTotal);
			place(
				foliage.id,
				{
					rows,
					foliageClusters: isGrass ? foliageClusters : undefined,
					tag: foliage.levelTag,
					name: foliage.name,
					file: fileIndex,
					global: false,
					hlod: null,
				},
				file,
			);
		}
	});
	content.count('gatedRenderers', gatedRows.size);
	for (const { sources, ...rows } of gatedRows.values()) {
		const visibility = controls.sourceVisibility(sources);
		// HLOD clusters stand in for the rows of their own area, so area-only content keeps HLOD refinement;
		// scene-state content has no HLODs and streams as conditional detail
		const stateGated = visibility !== null && sources.some((source) => source.sceneState !== 0);
		emitRows(rows, visibility, stateGated);
	}
	for (const cluster of unresolvedHlod) {
		const key = pickHlodTile({
			tree: grid,
			leafLevel: grid.leafLevel,
			candidates: cluster.candidates,
			bounds: cluster.row.bounds,
			detailAt: (leaf) => detailBounds.get(`${tileId(leaf)}/${cluster.tag}`) ?? [],
		});
		addHlod(cluster, key);
	}
	volumeFiles.sort(byFileName);
	waterFiles.sort(byFileName);
	const chunkVolumes = collectSceneVolumes(volumeFiles);
	const sceneWater = collectSceneWater(waterFiles);
	const clothGroups = [...allClothGroups.values()].filter((group) =>
		group.cloths.some((cloth) => usedClothHashes.has(cloth.hash)),
	);
	return { hlodNameMatches, chunkVolumes, sceneWater, clothGroups };
};

const byFileName = (a: { file: ChunkFile }, b: { file: ChunkFile }): number =>
	compareStrings(a.file.name, b.file.name);

/** @returns why a rect decal makes no row: no material, or no decal cube in the install */
export const decalSkipReason = (material: bigint | null | undefined): string =>
	material == null ? 'rect decal without a material' : 'no decal cube mesh';
