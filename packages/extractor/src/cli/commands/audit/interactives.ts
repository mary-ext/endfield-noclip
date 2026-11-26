import { join } from 'node:path';

import { DEBUG_DIR, type UnsupportedInput } from '../../../pipeline/debug.ts';
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
 * runs `endfield-extract audit interactives`
 *
 * @param args parsed CLI arguments
 */
export const runAuditInteractives = async (args: AuditSubArgs<'interactives'>): Promise<void> => {
	const options: AuditInteractivesOptions = {
		reason: args.reason,
		group: args.group,
		where: [...args.where],
		pick: [...args.pick],
		limit: args.limit,
		json: args.json,
	};
	if (args.scene === 'all') {
		await auditInteractivesMulti(await listPackedDirs(outRootOf(args.dir)), options);
		return;
	}
	const { debugDir } = packageDirsOf(args.scene, args.dir);
	await auditInteractives(debugDir, options);
};

interface AuditInteractivesOptions {
	reason: RegExp | undefined;
	group: boolean;
	where: readonly WherePredicate[];
	pick: readonly string[];
	limit: number;
	json: boolean;
}

const emitInteractives = (
	matched: readonly (UnsupportedInput & { package?: string })[],
	options: AuditInteractivesOptions,
	scopeNote: string,
): void => {
	if (options.group) {
		const groups = tallyBy(
			matched,
			(row) => row.reason,
			(row) => (row.package === undefined ? row.path : `${row.package}:${row.path}`),
		);
		const shown = groups.slice(0, options.limit);
		if (options.json) {
			console.log(JSON.stringify(shown, null, '\t'));
		} else {
			for (const g of shown) {
				console.log(`${String(g.count).padStart(5)}  ${g.key}  (e.g. ${g.samples.join(', ')})`);
			}
		}
		console.error(`${matched.length} unsupported interactives in ${groups.length} reasons${scopeNote}`);
		return;
	}
	const shown = matched.slice(0, options.limit);
	if (options.json || options.pick.length > 0) {
		console.log(JSON.stringify(projectAuditRows(shown, options.pick), null, '\t'));
	} else {
		for (const row of shown) {
			const pkgCol = row.package === undefined ? '' : `${row.package.padEnd(18)} `;
			console.log(`${pkgCol}${row.path.padEnd(44)} ${row.reason}`);
		}
	}
	console.error(`${shown.length} of ${matched.length} unsupported interactives${scopeNote}`);
};

const auditInteractives = async (debugDir: string, options: AuditInteractivesOptions): Promise<void> => {
	const rows = await readDebugJson<UnsupportedInput[]>(debugDir, 'unsupported-interactives.json');
	const matched = rows.filter(
		(row) =>
			(options.reason === undefined || options.reason.test(row.reason)) &&
			(options.where.length === 0 || matchesWhere(row, options.where)),
	);
	emitInteractives(matched, options, '');
};

const auditInteractivesMulti = async (
	packages: readonly { name: string; dir: string }[],
	options: AuditInteractivesOptions,
): Promise<void> => {
	const matched: (UnsupportedInput & { package: string })[] = [];
	for (const { name, dir } of packages) {
		// oxlint-disable-next-line no-await-in-loop -- reads small debug files per package
		const rows = await readOptionalJson<UnsupportedInput[]>(
			join(dir, DEBUG_DIR, 'unsupported-interactives.json'),
		);
		if (rows === null) {
			continue;
		}
		for (const row of rows) {
			if (options.reason !== undefined && !options.reason.test(row.reason)) {
				continue;
			}
			const item = { package: name, ...row };
			if (options.where.length > 0 && !matchesWhere(item, options.where)) {
				continue;
			}
			matched.push(item);
		}
	}
	emitInteractives(matched, options, ` across ${packages.length} packages`);
};

// #endregion
