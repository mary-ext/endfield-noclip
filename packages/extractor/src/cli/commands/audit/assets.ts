import { join } from 'node:path';

import type { Bounds } from '@endfield-noclip/package-format/values';

import { DEBUG_DIR } from '../../../pipeline/debug.ts';
import { PackedPackage } from '../../../pipeline/read-package.ts';
import { matchesWhere, type WherePredicate } from '../../query.ts';

import type { AuditSubArgs } from './parser.ts';
import {
	listPackedDirs,
	outRootOf,
	packageDirsOf,
	projectAuditRows,
	readDebugJson,
	readOptionalJson,
	tallyBy,
} from './shared.ts';

const toIdSet = (ids: readonly number[]): Set<number> | undefined =>
	ids.length === 0 ? undefined : new Set(ids);

/**
 * runs `endfield-extract audit materials`
 *
 * @param args parsed CLI arguments
 */
export const runAuditMaterials = async (args: AuditSubArgs<'materials'>): Promise<void> => {
	const options: AuditMaterialsOptions = {
		ids: toIdSet(args.ids),
		shader: args.shader,
		name: args.name,
		reason: args.reason,
		gap: args.gap,
		unsupported: args.unsupported,
		undrawn: args.undrawn,
		error: args.error,
		packed: args.packed,
		group: args.group,
		where: [...args.where],
		pick: [...args.pick],
		limit: args.limit,
		json: args.json,
	};
	if (args.scene === 'all') {
		await auditMaterialsMulti(await listPackedDirs(outRootOf(args.dir)), options);
		return;
	}
	const { packageDir, debugDir } = packageDirsOf(args.scene, args.dir);
	await auditMaterials(packageDir, debugDir, options);
};

/**
 * runs `endfield-extract audit geometries`
 *
 * @param args parsed CLI arguments
 */
export const runAuditGeometries = async (args: AuditSubArgs<'geometries'>): Promise<void> => {
	const options: AuditGeometriesOptions = {
		ids: toIdSet(args.ids),
		name: args.name,
		unanimated: args.unanimated,
		error: args.error,
		tangentUv: args.tangentUv,
		packed: args.packed || args.minSpan !== undefined || args.stats,
		minSpan: args.minSpan,
		stats: args.stats,
		where: [...args.where],
		pick: [...args.pick],
		limit: args.limit,
		json: args.json,
	};
	if (args.scene === 'all') {
		await auditGeometriesMulti(await listPackedDirs(outRootOf(args.dir)), options);
		return;
	}
	const { packageDir, debugDir } = packageDirsOf(args.scene, args.dir);
	await auditGeometries(packageDir, debugDir, options);
};

/**
 * runs `endfield-extract audit textures`
 *
 * @param args parsed CLI arguments
 */
export const runAuditTextures = async (args: AuditSubArgs<'textures'>): Promise<void> => {
	const options: AuditTexturesOptions = {
		ids: toIdSet(args.ids),
		name: args.name,
		error: args.error,
		where: [...args.where],
		pick: [...args.pick],
		limit: args.limit,
		json: args.json,
	};
	if (args.scene === 'all') {
		await auditTexturesMulti(await listPackedDirs(outRootOf(args.dir)), options);
		return;
	}
	const { debugDir } = packageDirsOf(args.scene, args.dir);
	await auditTextures(debugDir, options);
};

interface DebugMaterialRow {
	hash: string;
	path: string | null;
	object?: string;
	name?: string;
	shader?: string;
	error?: string | null;
	unsupported?: string | null;
	undrawn?: string | null;
	keywordsNotDrawn?: string[];
	slotErrors?: Record<string, string>;
}

interface DebugGeometryRow {
	hash: string;
	path: string | null;
	object?: string;
	name?: string;
	error?: string | null;
	unanimated?: string;
	tangentUvs?: number[];
}

interface DebugTextureRow {
	id?: number;
	object?: string;
	name?: string;
	error?: string | null;
}

/** shape of `debug/assets.json` */
export interface DebugAssetsFile {
	geometries: DebugGeometryRow[];
	materials: DebugMaterialRow[];
	textures?: DebugTextureRow[];
}

interface AuditMaterialsOptions {
	ids: ReadonlySet<number> | undefined;
	shader: RegExp | undefined;
	name: RegExp | undefined;
	reason: RegExp | undefined;
	gap: RegExp | undefined;
	unsupported: boolean;
	undrawn: boolean;
	error: boolean;
	packed: boolean;
	group: boolean;
	where: readonly WherePredicate[];
	pick: readonly string[];
	limit: number;
	json: boolean;
}

const filterMaterials = (
	materials: readonly DebugMaterialRow[],
	options: AuditMaterialsOptions,
): (DebugMaterialRow & { id: number })[] => {
	const matched: (DebugMaterialRow & { id: number })[] = [];
	for (const [id, row] of materials.entries()) {
		if (options.ids !== undefined && !options.ids.has(id)) {
			continue;
		}
		if (options.shader !== undefined && !options.shader.test(row.shader ?? '')) {
			continue;
		}
		if (
			options.name !== undefined &&
			!options.name.test(row.name ?? '') &&
			!options.name.test(row.path ?? '')
		) {
			continue;
		}
		if (options.reason !== undefined) {
			const hay = [row.unsupported, row.undrawn, row.error].filter(Boolean).join(' ');
			if (!options.reason.test(hay)) {
				continue;
			}
		}
		if (options.unsupported && !row.unsupported) {
			continue;
		}
		if (options.undrawn && !row.undrawn) {
			continue;
		}
		if (options.error && !row.error && Object.keys(row.slotErrors ?? {}).length === 0) {
			continue;
		}
		if (
			options.gap !== undefined &&
			!(row.keywordsNotDrawn ?? []).some((keyword) => options.gap!.test(keyword))
		) {
			continue;
		}
		matched.push({ id, ...row });
	}
	return matched;
};

const materialGroupKey = (row: DebugMaterialRow): string => {
	const shader = row.shader ?? '(no shader)';
	if (row.error) {
		return `${shader}  [error: ${row.error}]`;
	}
	if (row.unsupported) {
		return `${shader}  [unsupported: ${row.unsupported}]`;
	}
	if (row.undrawn) {
		return `${shader}  [undrawn: ${row.undrawn}]`;
	}
	if ((row.keywordsNotDrawn?.length ?? 0) > 0) {
		return `${shader}  [gaps: ${row.keywordsNotDrawn!.join(' ')}]`;
	}
	return shader;
};

const formatMaterialStatus = (row: DebugMaterialRow): string => {
	const status: string[] = [];
	if (row.error) {
		status.push(`ERROR: ${row.error}`);
	}
	if (row.unsupported) {
		status.push(`unsupported: ${row.unsupported}`);
	}
	if (row.undrawn) {
		status.push(`undrawn: ${row.undrawn}`);
	}
	if ((row.keywordsNotDrawn?.length ?? 0) > 0) {
		status.push(`gaps: ${row.keywordsNotDrawn!.join(' ')}`);
	}
	return status.join('; ');
};

const auditMaterials = async (
	packageDir: string,
	debugDir: string,
	options: AuditMaterialsOptions,
): Promise<void> => {
	const { materials } = await readDebugJson<DebugAssetsFile>(debugDir, 'assets.json');
	let matched: (DebugMaterialRow & { id: number; packed?: unknown })[] = filterMaterials(materials, options);

	if (options.packed) {
		await using pkg = await PackedPackage.open(packageDir);
		const table = await pkg.materials();
		matched = matched.map((row) => ({ ...row, packed: table.entries[row.id] ?? null }));
	}
	if (options.where.length > 0) {
		matched = matched.filter((row) => matchesWhere(row, options.where));
	}

	if (options.group) {
		const groups = tallyBy(matched, materialGroupKey, (row) => row.name ?? row.path ?? row.hash);
		const shown = groups.slice(0, options.limit);
		if (options.json) {
			console.log(JSON.stringify(shown, null, '\t'));
		} else {
			for (const g of shown) {
				console.log(`${String(g.count).padStart(5)}  ${g.key}  (e.g. ${g.samples.join(', ')})`);
			}
		}
		console.error(`${matched.length} materials in ${groups.length} groups`);
		return;
	}

	const shown = matched.slice(0, options.limit);
	if (options.packed || options.json || options.pick.length > 0) {
		const out = projectAuditRows(shown, options.pick);
		const single = options.ids !== undefined && options.ids.size === 1 && out.length === 1;
		console.log(JSON.stringify(single ? out[0] : out, null, '\t'));
	} else {
		for (const row of shown) {
			const label = row.path ?? row.object ?? row.hash;
			console.log(
				`${String(row.id).padStart(5)}  ${(row.shader ?? '-').padEnd(34)} ${(row.name ?? '-').padEnd(40)} ${formatMaterialStatus(row)}  ${label}`,
			);
		}
	}
	console.error(
		`${shown.length} of ${matched.length} matching materials${matched.length > options.limit ? ' (raise --limit for more)' : ''}`,
	);
};

const auditMaterialsMulti = async (
	packages: readonly { name: string; dir: string }[],
	options: AuditMaterialsOptions,
): Promise<void> => {
	let matched: (DebugMaterialRow & { package: string; id: number; packed?: unknown })[] = [];
	for (const { name, dir } of packages) {
		// oxlint-disable-next-line no-await-in-loop -- reads small debug files per package
		const assets = await readOptionalJson<DebugAssetsFile>(join(dir, DEBUG_DIR, 'assets.json'));
		if (assets === null) {
			continue;
		}
		const rows = filterMaterials(assets.materials, options);
		if (rows.length === 0) {
			continue;
		}
		if (options.packed) {
			// oxlint-disable-next-line no-await-in-loop -- opens core.czar only for packages with matches
			await using pkg = await PackedPackage.open(dir);
			// oxlint-disable-next-line no-await-in-loop -- paired with open above
			const table = await pkg.materials();
			for (const row of rows) {
				matched.push({ package: name, ...row, packed: table.entries[row.id] ?? null });
			}
		} else {
			for (const row of rows) {
				matched.push({ package: name, ...row });
			}
		}
	}
	if (options.where.length > 0) {
		matched = matched.filter((row) => matchesWhere(row, options.where));
	}
	if (options.group) {
		const groups = tallyBy(
			matched,
			materialGroupKey,
			(row) => `${row.package}:${row.name ?? row.path ?? row.hash}`,
		);
		const shown = groups.slice(0, options.limit);
		if (options.json) {
			console.log(JSON.stringify(shown, null, '\t'));
		} else {
			for (const g of shown) {
				console.log(`${String(g.count).padStart(5)}  ${g.key}  (e.g. ${g.samples.join(', ')})`);
			}
		}
		console.error(
			`${matched.length} materials in ${groups.length} groups across ${packages.length} packages`,
		);
		return;
	}
	const shown = matched.slice(0, options.limit);
	if (options.json || options.packed || options.pick.length > 0) {
		console.log(JSON.stringify(projectAuditRows(shown, options.pick), null, '\t'));
	} else {
		for (const row of shown) {
			const label = row.path ?? row.object ?? row.hash;
			console.log(
				`${row.package.padEnd(18)} ${String(row.id).padStart(5)}  ${(row.shader ?? '-').padEnd(30)} ${(row.name ?? '-').padEnd(36)} ${formatMaterialStatus(row)}  ${label}`,
			);
		}
	}
	console.error(
		`${shown.length} of ${matched.length} matching materials across ${packages.length} packages${matched.length > options.limit ? ' (raise --limit for more)' : ''}`,
	);
};

// #endregion

// #region geometries & textures

interface AuditGeometriesOptions {
	ids: ReadonlySet<number> | undefined;
	name: RegExp | undefined;
	unanimated: boolean;
	error: boolean;
	tangentUv: boolean;
	packed: boolean;
	minSpan: number | undefined;
	stats: boolean;
	where: readonly WherePredicate[];
	pick: readonly string[];
	limit: number;
	json: boolean;
}

interface DetailedGeometryRow extends DebugGeometryRow {
	id: number;
	package?: string;
	vertexCount?: number;
	indexCount?: number;
	submeshCount?: number;
	bounds?: Bounds;
	span?: number;
	attributes?: number;
}

const boundsSpan = (bounds: Bounds): number =>
	Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]);

const collectGeometries = async (
	packageDir: string,
	debugDir: string,
	options: AuditGeometriesOptions,
	pkgName?: string,
): Promise<{ matched: DetailedGeometryRow[]; totalReady: number; totalVerts: number }> => {
	const { geometries } = await readDebugJson<DebugAssetsFile>(debugDir, 'assets.json');
	const anyFilter =
		options.ids !== undefined ||
		options.name !== undefined ||
		options.unanimated ||
		options.error ||
		options.tangentUv ||
		options.packed ||
		options.minSpan !== undefined ||
		options.stats ||
		options.where.length > 0;

	let table: Awaited<ReturnType<PackedPackage['geometries']>> | null = null;
	if (options.packed) {
		await using pkg = await PackedPackage.open(packageDir);
		table = await pkg.geometries();
	}

	let totalReady = 0;
	let totalVerts = 0;
	const matched: DetailedGeometryRow[] = [];
	for (const [id, row] of geometries.entries()) {
		const entry = table !== null && id < table.count ? table.entry(id) : null;
		const ready = entry !== null && entry.status === 'ready' ? entry : null;
		if (ready !== null) {
			totalReady++;
			totalVerts += ready.vertexCount;
		}
		if (!anyFilter) {
			if (row.error || row.unanimated || (row.tangentUvs?.length ?? 0) > 1) {
				matched.push({ ...(pkgName === undefined ? {} : { package: pkgName }), id, ...row });
			}
			continue;
		}
		if (options.ids !== undefined && !options.ids.has(id)) {
			continue;
		}
		if (
			options.name !== undefined &&
			!options.name.test(row.name ?? '') &&
			!options.name.test(row.path ?? '')
		) {
			continue;
		}
		if (options.unanimated && !row.unanimated) {
			continue;
		}
		if (options.error && !row.error) {
			continue;
		}
		if (options.tangentUv && (row.tangentUvs?.length ?? 0) <= 1) {
			continue;
		}
		const span = ready === null ? undefined : boundsSpan(ready.bounds);
		if (options.minSpan !== undefined && (span === undefined || span < options.minSpan)) {
			continue;
		}
		const detail: DetailedGeometryRow = {
			...(pkgName === undefined ? {} : { package: pkgName }),
			id,
			...row,
			...(ready === null
				? {}
				: {
						vertexCount: ready.vertexCount,
						indexCount: ready.indexCount,
						submeshCount: ready.submeshCount,
						bounds: ready.bounds,
						span: +span!.toFixed(3),
						attributes: ready.attributes,
					}),
		};
		if (options.where.length > 0 && !matchesWhere(detail, options.where)) {
			continue;
		}
		matched.push(detail);
	}
	return { matched, totalReady, totalVerts };
};

const SPAN_THRESHOLDS = [6.5, 10, 16, 32, 64] as const;

const summarizeGeometryStats = (
	label: string,
	rows: readonly DetailedGeometryRow[],
	totalReady: number,
	totalVerts: number,
) => {
	const readyRows = rows.filter((r) => r.vertexCount !== undefined);
	const matchedVerts = readyRows.reduce((sum, r) => sum + (r.vertexCount ?? 0), 0);
	const bySpan = SPAN_THRESHOLDS.map((threshold) => {
		const over = readyRows.filter((r) => (r.span ?? 0) > threshold);
		const verts = over.reduce((sum, r) => sum + (r.vertexCount ?? 0), 0);
		return { threshold, meshes: over.length, vertices: verts };
	});
	return { label, totalReady, totalVerts, matchedMeshes: readyRows.length, matchedVerts, bySpan };
};

const printGeometryStats = (stats: ReturnType<typeof summarizeGeometryStats>): void => {
	console.log(
		`${stats.label}: ${stats.matchedMeshes}/${stats.totalReady} ready meshes, ${(stats.matchedVerts / 1e6).toFixed(2)}M/${(stats.totalVerts / 1e6).toFixed(2)}M verts`,
	);
	for (const b of stats.bySpan) {
		const pct = stats.totalVerts === 0 ? 0 : (b.vertices / stats.totalVerts) * 100;
		console.log(
			`  span > ${String(b.threshold).padStart(4)}m: ${String(b.meshes).padStart(5)} meshes  ${(b.vertices / 1e6).toFixed(2).padStart(6)}M verts (${pct.toFixed(1)}%)`,
		);
	}
};

const auditGeometries = async (
	packageDir: string,
	debugDir: string,
	options: AuditGeometriesOptions,
): Promise<void> => {
	const { matched, totalReady, totalVerts } = await collectGeometries(packageDir, debugDir, options);
	if (options.stats) {
		const stats = summarizeGeometryStats(packageDir, matched, totalReady, totalVerts);
		if (options.json) {
			console.log(JSON.stringify(stats, null, '\t'));
		} else {
			printGeometryStats(stats);
		}
		return;
	}
	if (options.minSpan !== undefined) {
		matched.sort((a, b) => (b.span ?? 0) - (a.span ?? 0));
	}
	const shown = matched.slice(0, options.limit);
	if (options.json || options.pick.length > 0) {
		console.log(JSON.stringify(projectAuditRows(shown, options.pick), null, '\t'));
	} else {
		for (const row of shown) {
			const notes: string[] = [];
			if (row.span !== undefined) {
				notes.push(`span=${row.span.toFixed(2)}m verts=${row.vertexCount}`);
			}
			if (row.error) {
				notes.push(`ERROR: ${row.error}`);
			}
			if (row.unanimated) {
				notes.push(`unanimated: ${row.unanimated}`);
			}
			if ((row.tangentUvs?.length ?? 0) > 1) {
				notes.push(`tangentUvs: ${row.tangentUvs!.join(',')}`);
			}
			console.log(
				`${String(row.id).padStart(5)}  ${(row.name ?? '-').padEnd(32)} ${notes.join('; ')}  ${row.path ?? row.object ?? row.hash}`,
			);
		}
	}
	console.error(`${shown.length} of ${matched.length} geometries`);
};

const auditGeometriesMulti = async (
	packages: readonly { name: string; dir: string }[],
	options: AuditGeometriesOptions,
): Promise<void> => {
	if (options.stats) {
		const allStats = [];
		for (const { name, dir } of packages) {
			// oxlint-disable-next-line no-await-in-loop -- reads one package at a time
			const { matched, totalReady, totalVerts } = await collectGeometries(
				dir,
				join(dir, DEBUG_DIR),
				options,
				name,
			);
			const stats = summarizeGeometryStats(name, matched, totalReady, totalVerts);
			allStats.push(stats);
			if (!options.json) {
				printGeometryStats(stats);
			}
		}
		if (options.json) {
			console.log(JSON.stringify(allStats, null, '\t'));
		}
		return;
	}

	const matched: DetailedGeometryRow[] = [];
	for (const { name, dir } of packages) {
		// oxlint-disable-next-line no-await-in-loop -- reads one package at a time
		const result = await collectGeometries(dir, join(dir, DEBUG_DIR), options, name);
		matched.push(...result.matched);
	}
	if (options.minSpan !== undefined) {
		matched.sort((a, b) => (b.span ?? 0) - (a.span ?? 0));
	}
	const shown = matched.slice(0, options.limit);
	if (options.json || options.pick.length > 0) {
		console.log(JSON.stringify(projectAuditRows(shown, options.pick), null, '\t'));
	} else {
		for (const row of shown) {
			const span = row.span === undefined ? '' : `span=${row.span.toFixed(2)}m verts=${row.vertexCount}  `;
			console.log(
				`${(row.package ?? '').padEnd(18)} ${String(row.id).padStart(5)}  ${(row.name ?? '-').padEnd(32)} ${span}${row.path ?? row.object ?? row.hash}`,
			);
		}
	}
	console.error(`${shown.length} of ${matched.length} geometries across ${packages.length} packages`);
};

interface AuditTexturesOptions {
	ids: ReadonlySet<number> | undefined;
	name: RegExp | undefined;
	error: boolean;
	where: readonly WherePredicate[];
	pick: readonly string[];
	limit: number;
	json: boolean;
}

const filterTextures = (
	textures: readonly DebugTextureRow[],
	options: AuditTexturesOptions,
	pkgName?: string,
): (DebugTextureRow & { id: number; package?: string })[] => {
	const matched: (DebugTextureRow & { id: number; package?: string })[] = [];
	for (const [index, row] of textures.entries()) {
		const id = row.id ?? index;
		if (options.ids !== undefined && !options.ids.has(id)) {
			continue;
		}
		if (
			options.name !== undefined &&
			!options.name.test(row.name ?? '') &&
			!options.name.test(row.object ?? '')
		) {
			continue;
		}
		if (options.error && !row.error) {
			continue;
		}
		const item = { ...(pkgName === undefined ? {} : { package: pkgName }), ...row, id };
		if (options.where.length > 0 && !matchesWhere(item, options.where)) {
			continue;
		}
		matched.push(item);
	}
	return matched;
};

const auditTextures = async (debugDir: string, options: AuditTexturesOptions): Promise<void> => {
	const { textures = [] } = await readDebugJson<DebugAssetsFile>(debugDir, 'assets.json');
	const matched = filterTextures(textures, options);
	const shown = matched.slice(0, options.limit);
	if (options.json || options.pick.length > 0) {
		const out = projectAuditRows(shown, options.pick);
		const single = options.ids !== undefined && options.ids.size === 1 && out.length === 1;
		console.log(JSON.stringify(single ? out[0] : out, null, '\t'));
	} else {
		for (const row of shown) {
			const err = row.error ? `  ERROR: ${row.error}` : '';
			console.log(
				`${String(row.id).padStart(6)}  ${(row.name ?? '-').padEnd(44)} ${row.object ?? '-'}${err}`,
			);
		}
	}
	console.error(
		`${shown.length} of ${matched.length} textures${matched.length > options.limit ? ' (raise --limit for more)' : ''}`,
	);
};

const auditTexturesMulti = async (
	packages: readonly { name: string; dir: string }[],
	options: AuditTexturesOptions,
): Promise<void> => {
	const matched: (DebugTextureRow & { id: number; package?: string })[] = [];
	for (const { name, dir } of packages) {
		// oxlint-disable-next-line no-await-in-loop -- reads small debug files per package
		const assets = await readOptionalJson<DebugAssetsFile>(join(dir, DEBUG_DIR, 'assets.json'));
		if (assets === null) {
			continue;
		}
		matched.push(...filterTextures(assets.textures ?? [], options, name));
	}
	const shown = matched.slice(0, options.limit);
	if (options.json || options.pick.length > 0) {
		console.log(JSON.stringify(projectAuditRows(shown, options.pick), null, '\t'));
	} else {
		for (const row of shown) {
			const err = row.error ? `  ERROR: ${row.error}` : '';
			console.log(
				`${(row.package ?? '').padEnd(18)} ${String(row.id).padStart(6)}  ${(row.name ?? '-').padEnd(40)} ${row.object ?? '-'}${err}`,
			);
		}
	}
	console.error(
		`${shown.length} of ${matched.length} textures across ${packages.length} packages${matched.length > options.limit ? ' (raise --limit for more)' : ''}`,
	);
};

// #endregion
