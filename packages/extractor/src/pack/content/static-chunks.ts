import type { Aabb } from '@endfield-noclip/formats/unity/values';
import type { ChainDraw } from '@endfield-noclip/package-format/instances';
import { type TileKey, tileAt, tileId } from '@endfield-noclip/package-format/tiles';

import type { Visibility } from '../../game/scene-control.ts';
import type { ChunkSource, WorldIndex } from '../../game/world-index.ts';
import { orderedPool } from '../../pool.ts';
import type { CollectedRow } from '../collector.ts';
import { HLOD_NAME, type HlodCandidates, hlodCandidates, pickHlodTile } from '../hlod-cells.ts';
import { type InstanceInput, rowReach } from '../instances.ts';

import { decalPlacement, type PackContent } from './pack-content.ts';

// the scene's chunk files: static entities, foliage grids and local lights. an entity first met in an
// always-loaded file of the default area stays unconditional; any other collects every file holding it and
// loads while any of them does (docs/extraction.md#how-the-packer-files-instances)

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
	tag: number;
	name: string;
	/** chunk-file index */
	file: number;
	/** from a Global chunk file */
	global: boolean;
	/** the HLOD name match, or `null` for other renderers */
	hlod: RegExpExecArray | null;
}

/**
 * reads every chunk file of the scene, in order, and files each entity, foliage instance and light
 *
 * @param world the world index
 * @param content the pack's content; rows, lights, counts and skipped entities are added
 * @returns how many HLOD clusters' bounds centres lie in the tile they're filed under
 */
export const collectStaticChunks = async (world: WorldIndex, content: PackContent): Promise<number> => {
	const { scene, collector, controls, seen } = content;
	const { grid, subset } = scene;
	// listed in the report even at zero
	for (const key of STATIC_COUNTS) {
		content.count(key, 0);
	}
	// rows of scene-state and stream-area files, by entity or foliage grid id, with every file holding them;
	// added once all files are read
	const gatedRows = new Map<number, StaticRows & { sources: ChunkSource[] }>();
	let hlodNameMatches = 0;
	/** HLOD clusters whose name leaves more than one tile: clamped coordinates, or a misaligned tier */
	const unresolvedHlod: HlodCluster[] = [];
	/** bounds of always-loaded detail instances by `tileId/levelTag` */
	const detailBounds = new Map<string, Aabb[]>();

	const addHlod = (cluster: HlodCluster, key: TileKey): void => {
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
			const cluster = { ...entry, tier, candidates, condition };
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
			collector.addConditional({ ...entry, key, visibility, grid: null });
		} else {
			collector.addDetail({ ...entry, condition, key });
			detailBounds.getOrInsertComputed(`${tileId(key)}/${tag}`, () => []).push(row.bounds);
		}
		content.uses.note(row.chain, key);
	};

	/** files rows met first in `file`, or holds them back when the file is gated */
	const place = (id: number, rows: StaticRows, file: ChunkSource): void => {
		if (file.sceneState !== 0 || file.area !== 0) {
			gatedRows.set(id, { ...rows, sources: [file] });
			return;
		}
		for (const row of rows.rows) {
			addRow({ ...rows, row }, null, false);
		}
	};

	// files are settled in order, for a deterministic dedupe
	await orderedPool(
		scene.files,
		READ_AHEAD + 1,
		(file) => world.readChunkContent(file, scene.partition),
		(read, file, fileIndex) => {
			if (read instanceof Error) {
				throw read;
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
				/** a decal's draw; a renderer's are interned once the entity is known to pack */
				let decal: ChainDraw | null = null;
				if (entity.decal !== null) {
					const material = read.decalMaterials.get(entity.id);
					decal = material === undefined ? null : content.decalDraw(material);
					if (decal === null) {
						content.count('decalSkipped');
						content.skipped.add('static', decalSkipReason(material), entity);
						continue;
					}
					content.count('decal');
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
				let draws: ChainDraw[] = [];
				if (renderer !== null) {
					draws = renderer.draws.map((draw) => content.rendererDraw(draw));
				} else if (decal !== null) {
					draws = [decal];
				}
				const row: InstanceInput = {
					chain: content.chains.intern(draws),
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
				place(
					entity.id,
					{
						rows: [row],
						tag: entity.levelTag,
						name: entity.name,
						file: fileIndex,
						global: file.cell === null,
						hlod: HLOD_NAME.exec(entity.name),
					},
					file,
				);
				collector.noteOwner(entity.levelTag, rowReach(row));
			}
			for (const foliage of read.foliage) {
				if (repeat(foliage.id)) {
					continue;
				}
				content.count('foliageGrids');
				// every instance of a cluster carries the cluster's bounds, so a cluster culls and switches LOD as
				// one, the way the game draws it
				const rows: InstanceInput[] = [];
				for (const cluster of foliage.clusters) {
					if (!subset.includesPoint(foliage.levelTag, cluster.bounds.center)) {
						continue;
					}
					const chain = content.chains.intern(
						cluster.renderer.draws.map((draw) => content.rendererDraw(draw)),
					);
					for (const matrix of cluster.instances) {
						rows.push({ chain, matrix, bounds: cluster.bounds, entityId: foliage.id });
					}
					collector.noteOwner(foliage.levelTag, cluster.bounds);
				}
				content.count('foliageInstances', rows.length);
				place(
					foliage.id,
					{ rows, tag: foliage.levelTag, name: foliage.name, file: fileIndex, global: false, hlod: null },
					file,
				);
			}
		},
	);
	content.count('gatedRenderers', gatedRows.size);
	for (const { sources, ...rows } of gatedRows.values()) {
		const visibility = controls.sourceVisibility(sources);
		// HLOD clusters stand in for the rows of their own area, so area-only content keeps HLOD refinement;
		// scene-state content has no HLODs and streams as conditional detail
		const stateGated = visibility !== null && sources.some((source) => source.sceneState !== 0);
		for (const row of rows.rows) {
			addRow({ ...rows, row }, visibility, stateGated);
		}
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
	return hlodNameMatches;
};

/** @returns why a rect decal makes no row: no material, or no decal cube in the install */
export const decalSkipReason = (material: bigint | null | undefined): string =>
	material == null ? 'rect decal without a material' : 'no decal cube mesh';
