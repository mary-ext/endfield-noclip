import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import {
	ChainFlags,
	DrawRole,
	type Chain,
	type InstanceBlock,
} from '@endfield-noclip/package-format/instances';
import { CONTENT_KIND_NAMES, ContentKind, type Tree } from '@endfield-noclip/package-format/tree';
import type { Bounds, Rect } from '@endfield-noclip/package-format/values';

import { DEBUG_DIR } from '../../../pack/debug.ts';
import { PackedPackage } from '../../../pack/read-package.ts';

import type { DebugAssetsFile } from './assets.ts';
import type { AuditSubArgs } from './parser.ts';
import { packageDirsOf, readOptionalJson } from './shared.ts';
import { boundsDistance, boundsDistanceXZ, formatReach } from './tree.ts';

/**
 * runs `endfield-extract audit instances`
 *
 * @param args parsed CLI arguments
 */
export const runAuditInstances = async (args: AuditSubArgs<'instances'>): Promise<void> => {
	const { packageDir } = packageDirsOf(args.scene, args.dir);
	await auditInstances(packageDir, {
		name: args.name,
		id: args.id,
		blob: args.blob?.toLowerCase(),
		chain: args.chain,
		from: args.from,
		limit: args.limit,
		json: args.json,
	});
};

interface InstanceLogLine {
	blob: string;
	rows: [id: number, name: string, fileIndex: number][];
}

interface TreePlacement {
	where: string;
	nodeIndex: number | null;
	level: number | null;
	x: number | null;
	z: number | null;
	kind: string;
	tier: number;
	group: number;
	bounds: Bounds | null;
	reach: Rect | null;
}

const indexBlobPlacements = (tree: Tree): Map<number, TreePlacement[]> => {
	const map = new Map<number, TreePlacement[]>();
	const add = (blob: number, placement: TreePlacement): void => {
		map.getOrInsertComputed(blob, () => []).push(placement);
	};
	for (const [nodeIndex, node] of tree.nodes.entries()) {
		for (let i = node.refFirst; i < node.refFirst + node.refCount; i++) {
			const ref = tree.refs[i];
			add(ref.blob, {
				where: `node #${nodeIndex} L${node.level} (${node.x},${node.z})`,
				nodeIndex,
				level: node.level,
				x: node.x,
				z: node.z,
				kind: ref.kind === ContentKind.Hlod ? `hlod${ref.tier}` : CONTENT_KIND_NAMES[ref.kind],
				tier: ref.tier,
				group: ref.group,
				bounds: node.bounds,
				reach: ref.reach === null ? null : tree.reaches[ref.reach],
			});
		}
	}
	for (const ref of tree.global) {
		add(ref.blob, {
			where: 'global',
			nodeIndex: null,
			level: null,
			x: null,
			z: null,
			kind: 'global',
			tier: ref.tier,
			group: ref.group,
			bounds: null,
			reach: ref.reach === null ? null : tree.reaches[ref.reach],
		});
	}
	return map;
};

const drawRoleName = (role: DrawRole): string => {
	switch (role) {
		case DrawRole.Lit: {
			return 'lit';
		}
		case DrawRole.ShadowOnly: {
			return 'shadow';
		}
		case DrawRole.Unsupported: {
			return 'stand-in';
		}
	}
};

const formatThreshold = (squared: number, isDistance: boolean): string => {
	if (squared < 0) {
		return '-inf';
	}
	if (squared >= 1e30) {
		return 'inf';
	}
	const value = Math.sqrt(squared);
	return isDistance ? `${value.toFixed(1)}m` : value.toFixed(4);
};

const summarizeChain = (
	chain: Chain,
	assets: DebugAssetsFile | null,
): { flags: string[]; draws: object[]; lines: string[] } => {
	const isDistance = (chain.flags & ChainFlags.CameraDistance) !== 0;
	const flags: string[] = [];
	if ((chain.flags & ChainFlags.BillboardFacing) !== 0) {
		flags.push('billboard-facing');
	}
	if ((chain.flags & ChainFlags.BillboardUpright) !== 0) {
		flags.push('billboard-upright');
	}
	if ((chain.flags & ChainFlags.BillboardAxial) !== 0) {
		flags.push('billboard-axial');
	}
	if (isDistance) {
		flags.push('camera-distance');
	}
	const draws: object[] = [];
	const lines: string[] = [];
	for (const draw of chain.draws) {
		const geo = assets?.geometries[draw.geometry];
		const mat = draw.material === null ? null : assets?.materials[draw.material];
		const geoName = geo?.name ?? geo?.path ?? `geo#${draw.geometry}`;
		const matName = draw.material === null ? '(none)' : (mat?.name ?? mat?.path ?? `mat#${draw.material}`);
		const minText = formatThreshold(draw.minSquared, isDistance);
		const maxText = formatThreshold(draw.maxSquared, isDistance);
		draws.push({
			lod: draw.lod,
			role: drawRoleName(draw.role),
			geometry: draw.geometry,
			geometryName: geoName,
			material: draw.material,
			materialName: matName,
			submesh: draw.submesh,
			minSquared: draw.minSquared,
			maxSquared: draw.maxSquared,
			range: `${minText}..${maxText}`,
		});
		lines.push(
			`lod${draw.lod} [${minText}..${maxText}] ${drawRoleName(draw.role)}  ${geoName} (sub ${draw.submesh})  ${matName}`,
		);
	}
	return { flags, draws, lines };
};

const rowGeometry = (
	block: InstanceBlock,
	rowIndex: number,
): { chain: number; position: [number, number, number]; bounds: Bounds } => {
	const [ox, oy, oz] = block.origin;
	const t = rowIndex * 12;
	const b = rowIndex * 6;
	const cx = ox + block.bounds[b];
	const cy = oy + block.bounds[b + 1];
	const cz = oz + block.bounds[b + 2];
	const ex = block.bounds[b + 3];
	const ey = block.bounds[b + 4];
	const ez = block.bounds[b + 5];
	return {
		chain: block.chains[rowIndex],
		position: [ox + block.transforms[t + 3], oy + block.transforms[t + 7], oz + block.transforms[t + 11]],
		bounds: { min: [cx - ex, cy - ey, cz - ez], max: [cx + ex, cy + ey, cz + ez] },
	};
};

const auditInstances = async (
	packageDir: string,
	options: {
		name: RegExp | undefined;
		id: number | undefined;
		blob: string | undefined;
		chain: number | undefined;
		from: number[] | undefined;
		limit: number;
		json: boolean;
	},
): Promise<void> => {
	if (
		options.name === undefined &&
		options.id === undefined &&
		options.blob === undefined &&
		options.chain === undefined
	) {
		throw new Error('audit instances needs at least one of --name, --id, --blob, or --chain');
	}
	const debugDir = join(packageDir, DEBUG_DIR);
	const [chunkFiles, assets] = await Promise.all([
		readOptionalJson<string[]>(join(debugDir, 'chunk-files.json')),
		readOptionalJson<DebugAssetsFile>(join(debugDir, 'assets.json')),
	]);

	await using pkg = await PackedPackage.open(packageDir);
	const [tree, chains] = await Promise.all([pkg.tree(), pkg.chains()]);

	// if only --chain is given, show the chain summary directly and stop once enough rows match
	const preMatches: { blob: string; rowIndex: number; id: number; name: string; fileIndex: number }[] = [];
	const instancesPath = join(debugDir, 'instances.jsonl');
	const rl = createInterface({ input: createReadStream(instancesPath, 'utf8'), crlfDelay: Infinity });
	const idText = options.id === undefined ? undefined : String(options.id);
	const scanCap = options.chain === undefined ? options.limit : Math.max(options.limit * 20, 2000);
	for await (const line of rl) {
		if (line.length === 0) {
			continue;
		}
		if (options.blob !== undefined && !line.includes(options.blob)) {
			continue;
		}
		if (idText !== undefined && !line.includes(idText)) {
			continue;
		}
		const entry: InstanceLogLine = JSON.parse(line);
		if (options.blob !== undefined && entry.blob !== options.blob) {
			continue;
		}
		for (let i = 0; i < entry.rows.length; i++) {
			const [id, name, fileIndex] = entry.rows[i];
			if (options.id !== undefined && id !== options.id) {
				continue;
			}
			if (options.name !== undefined && !options.name.test(name)) {
				continue;
			}
			preMatches.push({ blob: entry.blob, rowIndex: i, id, name, fileIndex });
			if (preMatches.length >= scanCap) {
				break;
			}
		}
		if (preMatches.length >= scanCap) {
			rl.close();
			break;
		}
	}

	const blobHashes = new Set(preMatches.map((m) => m.blob));
	const located = await pkg.locateInstanceBlobs(blobHashes);
	const placements = indexBlobPlacements(tree);
	const decodedBlocks = new Map<number, InstanceBlock>();
	const blockFor = async (blobId: number): Promise<InstanceBlock> => {
		const cached = decodedBlocks.get(blobId);
		if (cached !== undefined) {
			return cached;
		}
		const block = await pkg.readInstanceBlock(blobId);
		decodedBlocks.set(blobId, block);
		return block;
	};

	const results: {
		id: number;
		name: string;
		source: string | null;
		blob: string;
		blobId: number | null;
		rowIndex: number;
		chain: number | null;
		position: [number, number, number] | null;
		bounds: Bounds | null;
		distance: number | null;
		distanceXZ: number | null;
		placements: (TreePlacement & { distance: number | null; distanceXZ: number | null })[];
		chainInfo: ReturnType<typeof summarizeChain> | null;
	}[] = [];

	for (const match of preMatches) {
		const blobId = located.get(match.blob) ?? null;
		// oxlint-disable-next-line no-await-in-loop -- few distinct blocks, cached per blobId
		const block = blobId === null ? null : await blockFor(blobId);
		const geom = block === null ? null : rowGeometry(block, match.rowIndex);
		if (options.chain !== undefined && geom?.chain !== options.chain) {
			continue;
		}
		const nodePlacements: (TreePlacement & { distance: number | null; distanceXZ: number | null })[] = [];
		for (const p of blobId === null ? [] : (placements.get(blobId) ?? [])) {
			nodePlacements.push({
				where: p.where,
				nodeIndex: p.nodeIndex,
				level: p.level,
				x: p.x,
				z: p.z,
				kind: p.kind,
				tier: p.tier,
				group: p.group,
				bounds: p.bounds,
				reach: p.reach,
				distance:
					options.from === undefined || p.bounds === null ? null : boundsDistance(p.bounds, options.from),
				distanceXZ:
					options.from === undefined || p.bounds === null ? null : boundsDistanceXZ(p.bounds, options.from),
			});
		}
		const chainObj = geom === null ? undefined : chains[geom.chain];
		results.push({
			id: match.id,
			name: match.name,
			source: chunkFiles?.[match.fileIndex] ?? null,
			blob: match.blob,
			blobId,
			rowIndex: match.rowIndex,
			chain: geom?.chain ?? null,
			position: geom?.position ?? null,
			bounds: geom?.bounds ?? null,
			distance:
				options.from === undefined || geom === null ? null : boundsDistance(geom.bounds, options.from),
			distanceXZ:
				options.from === undefined || geom === null ? null : boundsDistanceXZ(geom.bounds, options.from),
			placements: nodePlacements,
			chainInfo: chainObj === undefined ? null : summarizeChain(chainObj, assets),
		});
		if (results.length >= options.limit) {
			break;
		}
	}

	if (options.json) {
		console.log(
			JSON.stringify(
				results.map(({ chainInfo, ...rest }) => ({
					...rest,
					chainFlags: chainInfo?.flags ?? [],
					draws: chainInfo?.draws ?? [],
				})),
				null,
				'\t',
			),
		);
		return;
	}

	for (const r of results) {
		const pos = r.position === null ? '-' : r.position.map((v) => v.toFixed(1)).join(',');
		const dist = r.distance === null ? '' : `  d=${r.distance.toFixed(1)}m (xz ${r.distanceXZ!.toFixed(1)}m)`;
		console.log(
			`${r.name}  (id=${r.id}  pos=${pos}${dist}  chain=${r.chain ?? '-'}  blob=${r.blob.slice(0, 12)}#${r.blobId ?? '?'}[${r.rowIndex}])`,
		);
		if (r.source !== null) {
			console.log(`  source: ${r.source.split('/').pop()}`);
		}
		for (const p of r.placements) {
			const pDist =
				p.distance === null ? '' : `  d=${p.distance.toFixed(1)}m (xz ${p.distanceXZ!.toFixed(1)}m)`;
			const reach = p.reach === null ? '' : `  reach=${formatReach(p.reach)}`;
			console.log(`  tile: ${p.where}  ${p.kind}  group=${p.group}${pDist}${reach}`);
		}
		if (r.chainInfo !== null) {
			for (const line of r.chainInfo.lines) {
				console.log(`  ${line}`);
			}
		}
	}
	console.error(
		`${results.length} instances${results.length >= options.limit ? ' (limit reached; raise --limit for more)' : ''}`,
	);
};

// #endregion
