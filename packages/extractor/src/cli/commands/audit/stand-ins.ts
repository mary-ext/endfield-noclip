import { join } from 'node:path';

import { DEBUG_DIR, STAND_INS_FILE, type StandInReport } from '../../../pipeline/debug.ts';
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

/**
 * runs `endfield-extract audit stand-ins`
 *
 * @param args parsed CLI arguments
 */
export const runAuditStandIns = async (args: AuditSubArgs<'stand-ins'>): Promise<void> => {
	const options: AuditStandInsOptions = {
		reason: args.reason,
		name: args.name,
		near: args.near,
		radius: args.radius,
		group: args.group,
		where: [...args.where],
		pick: [...args.pick],
		limit: args.limit,
		json: args.json,
	};
	if (args.scene === 'all') {
		await auditStandInsMulti(await listPackedDirs(outRootOf(args.dir)), options);
		return;
	}
	const { debugDir } = packageDirsOf(args.scene, args.dir);
	await auditStandIns(debugDir, options);
};

interface AuditStandInsOptions {
	reason: RegExp | undefined;
	name: RegExp | undefined;
	near: number[] | undefined;
	radius: number;
	group: boolean;
	where: readonly WherePredicate[];
	pick: readonly string[];
	limit: number;
	json: boolean;
}

type StandInEntry = StandInReport & { package?: string; distance?: number };

const filterStandIns = (
	rows: readonly StandInReport[],
	options: AuditStandInsOptions,
	pkgName?: string,
): StandInEntry[] => {
	const matched: StandInEntry[] = [];
	for (const row of rows) {
		if (options.reason !== undefined && !options.reason.test(row.reason)) {
			continue;
		}
		if (options.name !== undefined && !options.name.test(row.name) && !options.name.test(row.path)) {
			continue;
		}
		let distance: number | undefined;
		if (options.near !== undefined) {
			if (row.position === null) {
				continue;
			}
			const dx = row.position[0] - options.near[0];
			const dy = row.position[1] - options.near[1];
			const dz = row.position[2] - options.near[2];
			distance = Math.hypot(dx, dy, dz);
			if (distance > options.radius) {
				continue;
			}
		}
		const item: StandInEntry = {
			...(pkgName === undefined ? {} : { package: pkgName }),
			...row,
			...(distance === undefined ? {} : { distance: +distance.toFixed(2) }),
		};
		if (options.where.length > 0 && !matchesWhere(item, options.where)) {
			continue;
		}
		matched.push(item);
	}
	return matched;
};

const emitStandIns = (matched: StandInEntry[], options: AuditStandInsOptions, scopeNote: string): void => {
	if (options.near !== undefined) {
		matched.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
	}
	if (options.group) {
		const groups = tallyBy(
			matched,
			(row) => row.reason,
			(row) =>
				`${row.package === undefined ? '' : `${row.package}:`}${row.name} (${row.path.split('/').pop()})`,
		);
		const shown = groups.slice(0, options.limit);
		if (options.json) {
			console.log(JSON.stringify(shown, null, '\t'));
		} else {
			for (const g of shown) {
				console.log(`${String(g.count).padStart(5)}  ${g.key}  (e.g. ${g.samples.join(', ')})`);
			}
		}
		console.error(`${matched.length} stand-ins in ${groups.length} reasons${scopeNote}`);
		return;
	}
	const shown = matched.slice(0, options.limit);
	if (options.json || options.pick.length > 0) {
		console.log(JSON.stringify(projectAuditRows(shown, options.pick), null, '\t'));
	} else {
		for (const row of shown) {
			const pkgCol = row.package === undefined ? '' : `${row.package.padEnd(18)} `;
			const distCol = row.distance === undefined ? '' : `${row.distance.toFixed(1).padStart(6)} m  `;
			const pos = row.position === null ? '-' : row.position.join(',');
			console.log(`${pkgCol}${distCol}${pos.padEnd(20)} ${row.name.padEnd(32)} ${row.reason}  (${row.path})`);
		}
	}
	console.error(`${shown.length} of ${matched.length} stand-ins${scopeNote}`);
};

const auditStandIns = async (debugDir: string, options: AuditStandInsOptions): Promise<void> => {
	const rows = await readDebugJson<StandInReport[]>(debugDir, STAND_INS_FILE);
	const unpositioned = options.near !== undefined ? rows.filter((r) => r.position === null).length : 0;
	const matched = filterStandIns(rows, options);
	const note = unpositioned > 0 ? ` (${unpositioned} unpositioned prefab stand-ins skipped by --near)` : '';
	emitStandIns(matched, options, note);
};

const auditStandInsMulti = async (
	packages: readonly { name: string; dir: string }[],
	options: AuditStandInsOptions,
): Promise<void> => {
	const matched: StandInEntry[] = [];
	for (const { name, dir } of packages) {
		// oxlint-disable-next-line no-await-in-loop -- reads small debug files per package
		const rows = await readOptionalJson<StandInReport[]>(join(dir, DEBUG_DIR, STAND_INS_FILE));
		if (rows === null) {
			continue;
		}
		matched.push(...filterStandIns(rows, options, name));
	}
	emitStandIns(matched, options, ` across ${packages.length} packages`);
};
