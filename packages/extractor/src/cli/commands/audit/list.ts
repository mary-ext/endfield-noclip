import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { DEBUG_DIR, STAND_INS_FILE, type StandInReport } from '../../../pipeline/debug.ts';
import { PackedPackage } from '../../../pipeline/read-package.ts';
import { compareStrings } from '../../../util/compare.ts';
import { ignoreMissing } from '../../../util/errors.ts';

import type { DebugAssetsFile } from './assets.ts';
import type { AuditSubArgs } from './parser.ts';
import { outRootOf, readOptionalJson } from './shared.ts';
import type { DebugWaterFile } from './water.ts';

/**
 * runs `endfield-extract audit list`
 *
 * @param args parsed CLI arguments
 */
export const runAuditList = async (args: AuditSubArgs<'list'>): Promise<void> => {
	await auditList(outRootOf(args.dir), {
		has: args.has,
		json: args.json,
	});
};

const HAS_FILTERS = new Set(['water-volumes', 'stand-ins', 'errors']);

interface PackageSummary {
	dir: string;
	scene: string;
	name: string | null;
	version: number;
	levels: number;
	instances: number;
	archives: number;
	subset: string | null;
	waterSurfaces: number | null;
	waterVolumes: number | null;
	standIns: number | null;
	errors: number;
}

const auditList = async (
	outRoot: string,
	options: { has: string | undefined; json: boolean },
): Promise<void> => {
	if (options.has !== undefined && !HAS_FILTERS.has(options.has)) {
		throw new Error(`--has must be one of ${[...HAS_FILTERS].join(', ')}`);
	}
	const entries = await ignoreMissing(readdir(outRoot, { withFileTypes: true }), []);
	const dirs = entries
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
		.map((entry) => entry.name)
		.toSorted(compareStrings);

	const rows: PackageSummary[] = [];
	for (const name of dirs) {
		const dir = join(outRoot, name);
		// oxlint-disable-next-line no-await-in-loop -- few packed directories, keeps handle count low
		const pkg = await ignoreMissing(PackedPackage.open(dir), null);
		if (pkg === null) {
			continue;
		}
		let manifest;
		try {
			manifest = pkg.manifest;
		} finally {
			// oxlint-disable-next-line no-await-in-loop -- paired with open above
			await pkg[Symbol.asyncDispose]();
		}
		const debugDir = join(dir, DEBUG_DIR);
		// oxlint-disable-next-line no-await-in-loop -- reads small debug files per package
		const [water, standIns, assets] = await Promise.all([
			readOptionalJson<DebugWaterFile>(join(debugDir, 'water.json')),
			readOptionalJson<StandInReport[]>(join(debugDir, STAND_INS_FILE)),
			readOptionalJson<DebugAssetsFile>(join(debugDir, 'assets.json')),
		]);
		const assetErrors =
			assets === null
				? 0
				: assets.materials.filter((m) => Boolean(m.error) || Object.keys(m.slotErrors ?? {}).length > 0)
						.length + assets.geometries.filter((g) => Boolean(g.error)).length;
		const errors = assetErrors + (water?.errors.length ?? 0);
		let subset: string | null = null;
		if (manifest.subset !== null) {
			const parts: string[] = [];
			if (manifest.subset.level !== null) {
				parts.push(manifest.subset.level);
			}
			if (manifest.subset.bounds !== null) {
				const b = manifest.subset.bounds;
				parts.push(`bounds(${b.minX}..${b.maxX},${b.minZ}..${b.maxZ})`);
			}
			subset = parts.join(' ');
		}
		const row: PackageSummary = {
			dir: name,
			scene: manifest.scene.id,
			name: manifest.scene.name,
			version: manifest.version,
			levels: manifest.levels.length,
			instances: manifest.levels.reduce((sum, level) => sum + level.instances, 0),
			archives: manifest.archives.length,
			subset,
			waterSurfaces: water?.surfaces.packed ?? null,
			waterVolumes: water?.volumes.packed ?? null,
			standIns: standIns?.length ?? null,
			errors,
		};
		if (options.has === 'water-volumes' && (row.waterVolumes ?? 0) === 0) {
			continue;
		}
		if (options.has === 'stand-ins' && (row.standIns ?? 0) === 0) {
			continue;
		}
		if (options.has === 'errors' && row.errors === 0) {
			continue;
		}
		rows.push(row);
	}

	if (options.json) {
		console.log(JSON.stringify(rows, null, '\t'));
		return;
	}
	console.log('package               ver  levels  instances  water(s/v)  stand-ins  errors  subset');
	for (const row of rows) {
		const water = row.waterSurfaces === null ? '-' : `${row.waterSurfaces}/${row.waterVolumes ?? 0}`;
		const standIns = row.standIns === null ? '-' : String(row.standIns);
		console.log(
			`${row.dir.padEnd(20)} ${String(row.version).padStart(4)}  ${String(row.levels).padStart(6)}  ${String(row.instances).padStart(9)}  ${water.padStart(10)}  ${standIns.padStart(9)}  ${String(row.errors).padStart(6)}  ${row.subset ?? ''}`,
		);
	}
	console.error(`${rows.length} packed packages in ${outRoot}`);
};

// #endregion
