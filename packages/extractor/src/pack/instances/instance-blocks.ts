import { BlobKind } from '@endfield-noclip/package-format/blobs';
import { encodeInstanceBlock } from '@endfield-noclip/package-format/instances';
import { CORE_ARCHIVE } from '@endfield-noclip/package-format/manifest';
import { tileFootprint } from '@endfield-noclip/package-format/tiles';
import { ContentKind, type ContentRef, type TreeInfo } from '@endfield-noclip/package-format/tree';

import { decodeDynamicGrid, dynamicGridReach } from '../../game/dynamic/dynamic-grids.ts';
import { type ArchiveLayout, compressedBlob } from '../archives.ts';
import type { DebugLog } from '../debug.ts';
import { type BlobStore, tileLocality } from '../store/blob-store.ts';

import { type Collector, countRows, type Group } from './collector.ts';
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
		chainIds,
		volumes,
	}: { grid: TreeInfo; chainIds: Uint32Array; volumes: ReadonlyMap<string, number> },
): Promise<{ rows: InstanceCounts; global: ContentRef[]; hlodClusters: number; tierCounts: number[] }> => {
	const { store, layout, builder, debugLog } = output;
	const rows = {
		detail: countRows(collector.detail.values()),
		hlod: countRows(collector.hlod.values()),
		global: countRows(collector.global.values()),
	};

	const detailGroups = [...collector.detail.values()].toSorted(
		(a, b) => a.key.z - b.key.z || a.key.x - b.key.x || a.visibility - b.visibility,
	);
	for (let start = 0; start < detailGroups.length; start += BLOB_BATCH) {
		const encoded = detailGroups.slice(start, start + BLOB_BATCH).map((group) => {
			const { minX, minZ } = tileFootprint(grid, group.key);
			const { block, order } = group.rows.toBlock([minX, 0, minZ], chainIds, volumes);
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
				reach: group.grid === null ? null : builder.reach(dynamicGridReach(decodeDynamicGrid(group.grid))),
			});
			builder.extend(group.key, group.bounds!);
			// oxlint-disable-next-line no-await-in-loop -- lines go out in block order
			await debugLog.block(store.hashOf(blobs[i]), group, order);
		}
	}

	// HLOD and global rows form one block per visibility group, in the core
	const coreBlocks = async (groups: Map<number, Group>) => {
		const encoded = [...groups]
			.toSorted((a, b) => a[0] - b[0])
			.map(([visibility, group]) => {
				const { block, order } = group.rows.toBlock([grid.origin[0], 0, grid.origin[1]], chainIds, volumes);
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
	return { rows, global, hlodClusters, tierCounts };
};
