import {
	AnimationFlags,
	AnimationKind,
	encodeAnimationBlob,
} from '@endfield-noclip/package-format/animation';
import type { AssembliesTable, AssemblyInfo, AssemblyNode } from '@endfield-noclip/package-format/assemblies';
import { BlobKind } from '@endfield-noclip/package-format/blobs';
import {
	encodeFoliageBlock,
	FOLIAGE_INSTANCE_BYTES,
	type FoliageBlock,
	type FoliageCluster,
	packFoliageInstance,
} from '@endfield-noclip/package-format/foliage';
import { encodeInstanceBlock, type RowPath } from '@endfield-noclip/package-format/instances';
import { CORE_ARCHIVE } from '@endfield-noclip/package-format/manifest';
import { tileFootprint } from '@endfield-noclip/package-format/tiles';
import { ContentKind, type ContentRef, type TreeInfo } from '@endfield-noclip/package-format/tree';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import { type ArchiveLayout, compressedBlob } from '../archives.ts';
import { type BlobStore, tileLocality } from '../cache/blob-store.ts';
import type { DebugLog } from '../debug.ts';

import { type Collector, countRows, type FoliageGroup, type Group } from './collector.ts';
import type { TileTreeBuilder } from './tile-tree.ts';

/** terrain tiles and detail blocks encoded and compressed at once; bounds memory, keeps blob order stable */
export const BLOB_BATCH = 64;

/** instance rows by destination */
export interface InstanceCounts {
	detail: number;
	hlod: number;
	global: number;
}

/**
 * stores every instance block, attaching detail and HLOD blocks to the tree
 *
 * @param output where blocks go: the blob store, archive layout, tree and debug index
 * @param collector the collected instances
 * @param inputs the package's tile tree, per interned chain id its id in the package, and by water volume id
 *   its index in the water table, for the rows floating on it
 * @returns row counts, the global content refs and HLOD tallies
 */
export const packInstances = async (
	output: { store: BlobStore; layout: ArchiveLayout; builder: TileTreeBuilder; debugLog: DebugLog },
	collector: Collector,
	{
		grid,
		chainHashes,
		volumes,
		cloths,
	}: {
		grid: TreeInfo;
		chainHashes: BigUint64Array;
		volumes: ReadonlyMap<string, number>;
		cloths: ReadonlyMap<number, number>;
	},
): Promise<{
	rows: InstanceCounts;
	global: ContentRef[];
	hlodClusters: number;
	tierCounts: number[];
	assemblies: AssembliesTable;
}> => {
	const { store, layout, builder, debugLog } = output;
	const rows = {
		detail: countRows(collector.detail.values()),
		hlod: countRows(collector.hlod.values()),
		global: countRows(collector.global.values()),
	};
	for (const group of collector.foliage.values()) {
		rows.detail += group.instanceCount;
	}

	// encode unique riding paths as `.anim` blobs (`AnimationKind.Transform`, `TranslationOnly`) and build the
	// scene's `tables/assemblies.bin.zst` for moving entities
	const uniquePaths: RowPath[] = [];
	const seenPaths = new Set<RowPath>();
	const noteGroupPaths = (group: Group): void => {
		for (const path of group.rows.ridePaths()) {
			if (!seenPaths.has(path)) {
				seenPaths.add(path);
				uniquePaths.push(path);
			}
		}
	};
	for (const group of collector.detail.values()) {
		noteGroupPaths(group);
	}
	for (const group of collector.hlod.values()) {
		noteGroupPaths(group);
	}
	for (const group of collector.global.values()) {
		noteGroupPaths(group);
	}
	const motionBlobs = new Map<RowPath, number>();
	if (uniquePaths.length > 0) {
		const animBlobIds = await store.putMany(
			uniquePaths.map((path) => {
				const frameCount = path.offsets.length / 3;
				const duration = path.frameRate > 0 ? frameCount / path.frameRate : 0;
				return {
					raw: encodeAnimationBlob({
						kind: AnimationKind.Transform,
						flags: AnimationFlags.Loop | AnimationFlags.TranslationOnly,
						duration,
						frameRate: path.frameRate,
						frameCount,
						frames: path.offsets,
					}),
					options: compressedBlob(BlobKind.Animation, CORE_ARCHIVE, null),
				};
			}),
		);
		for (const [i, path] of uniquePaths.entries()) {
			motionBlobs.set(path, animBlobIds[i]);
		}
	}

	const assemblyList: AssemblyInfo[] = [];
	const assemblyNodeList: AssemblyNode[] = [];
	const assemblyNodeByEntity = new Map<number, number>();
	const IDENTITY_3X4: AssemblyNode['localTransform'] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
	const recordAssemblies = (visibility: number, group: Group): void => {
		for (const { entityId, ride } of group.rows.movingEntities()) {
			if (assemblyNodeByEntity.has(entityId)) {
				continue;
			}
			const nodeIndex = assemblyNodeList.length;
			assemblyNodeByEntity.set(entityId, nodeIndex);
			assemblyNodeList.push({
				parent: -1,
				animBlob: ride === null ? null : (motionBlobs.get(ride) ?? null),
				localTransform: IDENTITY_3X4,
			});
			assemblyList.push({
				firstNode: nodeIndex,
				nodeCount: 1,
				flags: 0,
				group: visibility,
				firstState: 0,
				stateCount: 0,
				defaultState: 0,
			});
		}
	};
	for (const group of collector.detail.values()) {
		recordAssemblies(group.visibility, group);
	}
	for (const [visibility, group] of collector.hlod) {
		recordAssemblies(visibility, group);
	}
	for (const [visibility, group] of collector.global) {
		recordAssemblies(visibility, group);
	}
	const assemblies: AssembliesTable = {
		assemblies: assemblyList,
		nodes: assemblyNodeList,
		states: [],
	};

	const detailGroups = [...collector.detail.values()];
	detailGroups.sort((a, b) => a.key.z - b.key.z || a.key.x - b.key.x || a.visibility - b.visibility);
	for (let start = 0; start < detailGroups.length; start += BLOB_BATCH) {
		const encoded = detailGroups.slice(start, start + BLOB_BATCH).map((group) => {
			const { minX, minZ } = tileFootprint(grid, group.key);
			const { block, order } = group.rows.toBlock(
				[minX, 0, minZ],
				chainHashes,
				volumes,
				cloths,
				motionBlobs,
				assemblyNodeByEntity,
			);
			return { group, block, order };
		});
		// oxlint-disable-next-line no-await-in-loop -- batches bound memory and keep blob order stable
		const blobs = await store.putMany(
			encoded.map(({ group, block }) => ({
				raw: encodeInstanceBlock(block),
				options: compressedBlob(BlobKind.Instances, layout.stemOf(group.key), tileLocality(group.key)),
			})),
		);
		for (const [i, { group, order }] of encoded.entries()) {
			builder.addRef(group.key, {
				kind: group.conditional ? ContentKind.Conditional : ContentKind.Detail,
				tier: 0,
				group: group.visibility,
				blob: blobs[i],
				first: 0,
				count: group.rows.length,
				reach: group.reach === null ? null : builder.reach(group.reach),
			});
			builder.extend(group.key, group.bounds!);
			// oxlint-disable-next-line no-await-in-loop -- lines go out in block order
			await debugLog.block(store.hashOf(blobs[i]), group, order);
		}
	}

	const foliageGroups = [...collector.foliage.values()];
	foliageGroups.sort(
		(a, b) =>
			a.key.z - b.key.z ||
			a.key.x - b.key.x ||
			a.visibility - b.visibility ||
			Number(a.conditional) - Number(b.conditional),
	);
	for (let start = 0; start < foliageGroups.length; start += BLOB_BATCH) {
		const encoded = foliageGroups.slice(start, start + BLOB_BATCH).map((group) => {
			const { minX, minZ } = tileFootprint(grid, group.key);
			return { group, block: buildFoliageBlock(group, [minX, 0, minZ], chainHashes) };
		});
		// oxlint-disable-next-line no-await-in-loop -- batches bound memory and keep blob order stable
		const blobs = await store.putMany(
			encoded.map(({ group, block }) => ({
				raw: encodeFoliageBlock(block),
				options: compressedBlob(BlobKind.Foliage, layout.stemOf(group.key), tileLocality(group.key)),
			})),
		);
		for (const [i, { group }] of encoded.entries()) {
			builder.addRef(group.key, {
				kind: group.conditional ? ContentKind.Conditional : ContentKind.Detail,
				tier: 0,
				group: group.visibility,
				blob: blobs[i],
				first: 0,
				count: group.instanceCount,
				reach: null,
			});
			builder.extend(group.key, group.bounds!);
		}
	}

	// HLOD and global rows form one block per visibility group, in the core
	const coreBlocks = async (groups: Map<number, Group>) => {
		const sorted = [...groups];
		sorted.sort((a, b) => a[0] - b[0]);
		const encoded = sorted.map(([visibility, group]) => {
			const { block, order } = group.rows.toBlock(
				[grid.origin[0], 0, grid.origin[1]],
				chainHashes,
				volumes,
				cloths,
				motionBlobs,
				assemblyNodeByEntity,
			);
			return { visibility, group, block, order };
		});
		const blobs = await store.putMany(
			encoded.map(({ block }) => ({
				raw: encodeInstanceBlock(block),
				options: compressedBlob(BlobKind.Instances, CORE_ARCHIVE, null),
			})),
		);
		for (const [i, { group, order }] of encoded.entries()) {
			// oxlint-disable-next-line no-await-in-loop -- lines go out in block order
			await debugLog.block(store.hashOf(blobs[i]), group, order);
		}
		return encoded.map(({ visibility, group, order }, i) => ({ visibility, group, order, blob: blobs[i] }));
	};

	let hlodClusters = 0;
	const tierCounts = [0, 0, 0];
	for (const { visibility, group, order, blob } of await coreBlocks(collector.hlod)) {
		// rows are sorted by node, so each node's clusters are one run
		const groups = group.rows.groupsInOrder(order);
		for (let first = 0; first < groups.length;) {
			let end = first + 1;
			while (end < groups.length && groups[end] === groups[first]) {
				end++;
			}
			const node = collector.hlodNodes.get(groups[first])!;
			builder.addRef(node.key, {
				kind: ContentKind.Hlod,
				tier: node.tier,
				group: visibility,
				blob,
				first,
				count: end - first,
				reach: null,
			});
			builder.extend(node.key, node.bounds);
			tierCounts[node.tier] += end - first;
			hlodClusters += end - first;
			first = end;
		}
	}

	const global = (await coreBlocks(collector.global)).map(({ visibility, group, blob }): ContentRef => ({
		kind: ContentKind.Detail,
		tier: 0,
		group: visibility,
		blob,
		first: 0,
		count: group.rows.length,
		reach: null,
	}));
	return { rows, global, hlodClusters, tierCounts, assemblies };
};

/** encodes one tile's collected grass clusters into a {@link FoliageBlock} with a local chain palette */
const buildFoliageBlock = (group: FoliageGroup, origin: Vec3, chainHashes: BigUint64Array): FoliageBlock => {
	const paletteMap = new Map<number, number>();
	const paletteHashes: bigint[] = [];
	const localChainOf = (globalChain: number): number => {
		let local = paletteMap.get(globalChain);
		if (local === undefined) {
			local = paletteHashes.length;
			paletteMap.set(globalChain, local);
			paletteHashes.push(chainHashes[globalChain]);
		}
		return local;
	};

	const sorted = group.clusters
		.map((cluster) => ({ cluster, localChain: localChainOf(cluster.chain) }))
		.toSorted((a, b) => a.localChain - b.localChain);

	const instances = new Uint8Array(group.instanceCount * FOLIAGE_INSTANCE_BYTES);
	const clusters: FoliageCluster[] = [];
	let firstInstance = 0;

	for (const { cluster, localChain } of sorted) {
		const count = cluster.instances.length / 16;
		// ensure the quantization box covers both the cluster AABB and every instance translation
		let minX = cluster.bounds.center[0] - cluster.bounds.extents[0] - origin[0];
		let minY = cluster.bounds.center[1] - cluster.bounds.extents[1] - origin[1];
		let minZ = cluster.bounds.center[2] - cluster.bounds.extents[2] - origin[2];
		let maxX = cluster.bounds.center[0] + cluster.bounds.extents[0] - origin[0];
		let maxY = cluster.bounds.center[1] + cluster.bounds.extents[1] - origin[1];
		let maxZ = cluster.bounds.center[2] + cluster.bounds.extents[2] - origin[2];
		for (let i = 0; i < count; i++) {
			const tx = cluster.instances[i * 16 + 12] - origin[0];
			const ty = cluster.instances[i * 16 + 13] - origin[1];
			const tz = cluster.instances[i * 16 + 14] - origin[2];
			if (tx < minX) {
				minX = tx;
			}
			if (ty < minY) {
				minY = ty;
			}
			if (tz < minZ) {
				minZ = tz;
			}
			if (tx > maxX) {
				maxX = tx;
			}
			if (ty > maxY) {
				maxY = ty;
			}
			if (tz > maxZ) {
				maxZ = tz;
			}
		}
		const center: Vec3 = [(minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5];
		const halfExtents: Vec3 = [(maxX - minX) * 0.5, (maxY - minY) * 0.5, (maxZ - minZ) * 0.5];

		for (let i = 0; i < count; i++) {
			const matrix = cluster.instances.subarray(i * 16, i * 16 + 16);
			packFoliageInstance(
				instances,
				(firstInstance + i) * FOLIAGE_INSTANCE_BYTES,
				matrix,
				origin,
				center,
				halfExtents,
			);
		}
		clusters.push({
			chain: localChain,
			firstInstance,
			instanceCount: count,
			center,
			halfExtents,
			rendererHalfSize: cluster.rendererHalfSize,
			sparsity: cluster.sparsity,
		});
		firstInstance += count;
	}

	return {
		origin,
		palette: BigUint64Array.from(paletteHashes),
		clusters,
		instances,
	};
};
