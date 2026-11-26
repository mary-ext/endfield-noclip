import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_OUT } from '../../../install/config.ts';
import { DEBUG_DIR } from '../../../pipeline/debug.ts';
import { PackedPackage } from '../../../pipeline/read-package.ts';
import { compareStrings } from '../../../util/compare.ts';
import { ignoreMissing } from '../../../util/errors.ts';
import { pickFields } from '../../query.ts';

/** reads a JSON file or returns `null` if it does not exist */
export const readOptionalJson = async <T>(path: string): Promise<T | null> => {
	const raw = await ignoreMissing(readFile(path, 'utf8'), null);
	if (raw === null) {
		return null;
	}
	const parsed: T = JSON.parse(raw);
	return parsed;
};

/** resolves the root output directory (default `out/`) */
export const outRootOf = (dir: string | undefined): string => dir ?? fileURLToPath(DEFAULT_OUT);

/** resolves a single package directory and its debug directory */
export const packageDirsOf = (
	scene: string,
	dir: string | undefined,
): { packageDir: string; debugDir: string } => {
	const packageDir = dir ?? join(fileURLToPath(DEFAULT_OUT), scene);
	return { packageDir, debugDir: join(packageDir, DEBUG_DIR) };
};

/** projects rows when `--pick` is non-empty */
export const projectAuditRows = (rows: readonly object[], pick: readonly string[]): unknown[] =>
	pick.length === 0 ? [...rows] : rows.map((row) => pickFields(row, pick));

/** reads a JSON file under `debug/` */
export const readDebugJson = async <T>(debugDir: string, file: string): Promise<T> => {
	const path = join(debugDir, file);
	try {
		const parsed: T = JSON.parse(await readFile(path, 'utf8'));
		return parsed;
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			throw new Error(`${path} not found; pack the scene first (\`pnpm extract pack <scene>\`)`, {
				cause: error,
			});
		}
		throw error;
	}
};

/** tallies items by key, descending by count, keeping up to 3 sample labels per bucket */
/** groups and tallies rows by key */
export const tallyBy = <T>(
	items: readonly T[],
	keyOf: (item: T) => string,
	sampleOf: (item: T) => string,
): { key: string; count: number; samples: string[] }[] => {
	const groups = new Map<string, { key: string; count: number; samples: string[] }>();
	for (const item of items) {
		const key = keyOf(item);
		const bucket = groups.getOrInsertComputed(key, () => ({ key, count: 0, samples: [] }));
		bucket.count++;
		if (bucket.samples.length < 3) {
			const sample = sampleOf(item);
			if (!bucket.samples.includes(sample)) {
				bucket.samples.push(sample);
			}
		}
	}
	const sorted = [...groups.values()];
	sorted.sort((a, b) => b.count - a.count || compareStrings(a.key, b.key));
	return sorted;
};

/** lists packed package directories under `outRoot` */
export const listPackedDirs = async (outRoot: string): Promise<{ name: string; dir: string }[]> => {
	const entries = await ignoreMissing(readdir(outRoot, { withFileTypes: true }), []);
	const names = entries
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
		.map((entry) => entry.name)
		.toSorted(compareStrings);
	const out: { name: string; dir: string }[] = [];
	for (const name of names) {
		const dir = join(outRoot, name);
		// oxlint-disable-next-line no-await-in-loop -- few packed directories
		const pkg = await ignoreMissing(PackedPackage.open(dir), null);
		if (pkg !== null) {
			// oxlint-disable-next-line no-await-in-loop -- paired with open above
			await pkg[Symbol.asyncDispose]();
			out.push({ name, dir });
		}
	}
	return out;
};
