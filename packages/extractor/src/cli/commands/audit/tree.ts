import {
	CONTENT_KIND_NAMES,
	ContentKind,
	type ContentRef,
	type TreeInfo,
	type TreeNode,
} from '@endfield-noclip/package-format/tree';
import type { Bounds, Rect } from '@endfield-noclip/package-format/values';

import { PackedPackage } from '../../../pipeline/read-package.ts';

import type { AuditSubArgs } from './parser.ts';
import { packageDirsOf } from './shared.ts';

/**
 * runs `endfield-extract audit tree`
 *
 * @param args parsed CLI arguments
 */
export const runAuditTree = async (args: AuditSubArgs<'tree'>): Promise<void> => {
	const { packageDir } = packageDirsOf(args.scene, args.dir);
	await auditTree(packageDir, {
		at: args.at,
		from: args.from,
		blob: args.blob,
		level: args.level,
		limit: args.limit,
		json: args.json,
	});
};

/** euclidean distance from a point to an AABB */
export const boundsDistance = (bounds: Bounds, point: readonly number[]): number => {
	const dx = Math.max(bounds.min[0] - point[0], 0, point[0] - bounds.max[0]);
	const dy = Math.max(bounds.min[1] - point[1], 0, point[1] - bounds.max[1]);
	const dz = Math.max(bounds.min[2] - point[2], 0, point[2] - bounds.max[2]);
	return Math.hypot(dx, dy, dz);
};

/** XZ distance from a point to an AABB */
export const boundsDistanceXZ = (bounds: Bounds, point: readonly number[]): number => {
	const dx = Math.max(bounds.min[0] - point[0], 0, point[0] - bounds.max[0]);
	const dz = Math.max(bounds.min[2] - point[2], 0, point[2] - bounds.max[2]);
	return Math.hypot(dx, dz);
};

/** computes a tile node's XZ rectangle */
export const tileRect = (info: TreeInfo, node: Pick<TreeNode, 'level' | 'x' | 'z'>): Rect => {
	const size = info.rootSize / (1 << node.level);
	const minX = info.origin[0] + node.x * size;
	const minZ = info.origin[1] + node.z * size;
	return { minX, maxX: minX + size, minZ, maxZ: minZ + size };
};

/** formats an AABB for text output */
export const formatBounds = (bounds: Bounds): string =>
	`[${bounds.min.map((v) => v.toFixed(1)).join(',')}]..[${bounds.max.map((v) => v.toFixed(1)).join(',')}]`;

/** formats an XZ rectangle for text output */
export const formatReach = (reach: Rect): string =>
	`[${reach.minX.toFixed(0)}..${reach.maxX.toFixed(0)}, ${reach.minZ.toFixed(0)}..${reach.maxZ.toFixed(0)}]`;

const formatRef = (
	ref: ContentRef,
	hashes: ReadonlyMap<number, string>,
	reaches: readonly Rect[],
): string => {
	const kind = ref.kind === ContentKind.Hlod ? `hlod${ref.tier}` : CONTENT_KIND_NAMES[ref.kind];
	const hash = hashes.get(ref.blob);
	const hashText = hash === undefined ? '' : ` (${hash.slice(0, 12)})`;
	const slice = ref.first === 0 ? `${ref.count} rows` : `${ref.first}+${ref.count} rows`;
	const reach = ref.reach === null ? '' : ` reach=${formatReach(reaches[ref.reach])}`;
	return `${kind}  blob#${ref.blob}${hashText}  group=${ref.group}  ${slice}${reach}`;
};

const auditTree = async (
	packageDir: string,
	options: {
		at: number[] | undefined;
		from: number[] | undefined;
		blob: string | undefined;
		level: number | undefined;
		limit: number;
		json: boolean;
	},
): Promise<void> => {
	await using pkg = await PackedPackage.open(packageDir);
	const [tree, blobs] = await Promise.all([pkg.tree(), pkg.blobs()]);
	const info = pkg.manifest.tree;

	let blobId: number | undefined;
	if (options.blob !== undefined) {
		if (/^\d+$/.test(options.blob)) {
			blobId = Number(options.blob);
		} else {
			const lower = options.blob.toLowerCase();
			const located = await pkg.locateInstanceBlobs(new Set([lower]));
			blobId = located.get(lower);
			if (blobId === undefined) {
				throw new Error(`blob hash ${options.blob} not found in ${packageDir} instance archives`);
			}
		}
	}

	const hasFilter = options.at !== undefined || blobId !== undefined || options.level !== undefined;
	if (!hasFilter) {
		const byLevel = new Map<number, number>();
		for (const node of tree.nodes) {
			byLevel.set(node.level, (byLevel.get(node.level) ?? 0) + 1);
		}
		const byKind: Record<string, number> = {};
		for (const ref of tree.refs) {
			const name = CONTENT_KIND_NAMES[ref.kind];
			byKind[name] = (byKind[name] ?? 0) + 1;
		}
		const overview = {
			scene: pkg.manifest.scene.id,
			tree: info,
			nodes: tree.nodes.length,
			nodesByLevel: Object.fromEntries([...byLevel.entries()].toSorted((a, b) => a[0] - b[0])),
			refs: tree.refs.length,
			refsByKind: byKind,
			globalRefs: tree.global.length,
			reaches: tree.reaches.length,
			blobs: blobs.length,
		};
		if (options.json) {
			console.log(JSON.stringify(overview, null, '\t'));
			return;
		}
		console.log(
			`${overview.scene}: origin=(${info.origin.join(',')}) rootSize=${info.rootSize} leaf=${info.leafLevel} cell=${info.cellLevel} hlod=${info.hlodLevels.join(',')} shard=${info.shardLevel}`,
		);
		console.log(
			`nodes: ${overview.nodes} (${Object.entries(overview.nodesByLevel)
				.map(([l, n]) => `L${l}:${n}`)
				.join(' ')})`,
		);
		console.log(
			`refs: ${overview.refs} (${Object.entries(byKind)
				.map(([k, n]) => `${k}:${n}`)
				.join(' ')})  global: ${overview.globalRefs}  reaches: ${overview.reaches}  blobs: ${overview.blobs}`,
		);
		return;
	}

	const matchedNodes: {
		index: number;
		node: TreeNode;
		refs: ContentRef[];
		d3d: number | null;
		dXZ: number | null;
	}[] = [];
	for (const [index, node] of tree.nodes.entries()) {
		if (options.level !== undefined && node.level !== options.level) {
			continue;
		}
		if (options.at !== undefined) {
			const [x, , z] = options.at;
			const rect = tileRect(info, node);
			if (x < rect.minX || x >= rect.maxX || z < rect.minZ || z >= rect.maxZ) {
				continue;
			}
		}
		const slice = tree.refs.slice(node.refFirst, node.refFirst + node.refCount);
		const refs = blobId === undefined ? slice : slice.filter((ref) => ref.blob === blobId);
		if (blobId !== undefined && refs.length === 0) {
			continue;
		}
		const d3d = options.from === undefined ? null : boundsDistance(node.bounds, options.from);
		const dXZ = options.from === undefined ? null : boundsDistanceXZ(node.bounds, options.from);
		matchedNodes.push({ index, node, refs, d3d, dXZ });
	}
	if (options.from !== undefined && options.at === undefined) {
		matchedNodes.sort((a, b) => (a.d3d ?? 0) - (b.d3d ?? 0));
	}
	const globalMatches = blobId === undefined ? [] : tree.global.filter((ref) => ref.blob === blobId);

	const shown = matchedNodes.slice(0, options.limit);
	const refBlobIds = new Set<number>();
	for (const entry of shown) {
		for (const ref of entry.refs) {
			refBlobIds.add(ref.blob);
		}
	}
	for (const ref of globalMatches) {
		refBlobIds.add(ref.blob);
	}
	const hashes = await pkg.blobHashes(refBlobIds);

	const refJson = (ref: ContentRef) => ({
		kind: CONTENT_KIND_NAMES[ref.kind],
		tier: ref.tier,
		group: ref.group,
		blob: ref.blob,
		hash: hashes.get(ref.blob) ?? null,
		first: ref.first,
		count: ref.count,
		reach: ref.reach === null ? null : tree.reaches[ref.reach],
	});

	if (options.json) {
		console.log(
			JSON.stringify(
				{
					nodes: shown.map(({ index, node, refs, d3d, dXZ }) => ({
						index,
						level: node.level,
						x: node.x,
						z: node.z,
						tile: tileRect(info, node),
						bounds: node.bounds,
						geometricError: node.geometricError,
						...(d3d !== null ? { distance: +d3d.toFixed(2), distanceXZ: +dXZ!.toFixed(2) } : {}),
						refs: refs.map(refJson),
					})),
					...(globalMatches.length > 0 ? { global: globalMatches.map(refJson) } : {}),
				},
				null,
				'\t',
			),
		);
		return;
	}

	for (const { index, node, refs, d3d, dXZ } of shown) {
		const rect = tileRect(info, node);
		const dist = d3d === null ? '' : `  d=${d3d.toFixed(1)}m (xz ${dXZ!.toFixed(1)}m)`;
		console.log(
			`node #${index}  L${node.level} (${node.x},${node.z})  tile=[${rect.minX}..${rect.maxX}, ${rect.minZ}..${rect.maxZ}]  err=${node.geometricError.toFixed(1)}  bounds=${formatBounds(node.bounds)}${dist}`,
		);
		for (const ref of refs) {
			console.log(`  ${formatRef(ref, hashes, tree.reaches)}`);
		}
	}
	for (const ref of globalMatches) {
		console.log(`global  ${formatRef(ref, hashes, tree.reaches)}`);
	}
	console.error(
		`${shown.length} of ${matchedNodes.length} nodes${globalMatches.length > 0 ? `, ${globalMatches.length} global refs` : ''}${matchedNodes.length > options.limit ? ' (raise --limit for more)' : ''}`,
	);
};

// #endregion
