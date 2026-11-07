import { readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';

import { CORE_ARCHIVE } from '@endfield-noclip/package-format/manifest';

import { ignoreMissing } from '../errors.ts';

/**
 * files and directories a package consists of; only these are removed when replacing a package. macOS Finder
 * drops `.DS_Store` into any folder it shows, so it doesn't make a package directory foreign
 */
const PACKAGE_ENTRIES = new Set([
	CORE_ARCHIVE,
	'shards',
	'assets',
	'irradiance',
	'debug',
	'.spool',
	'.DS_Store',
]);

/**
 * @param outDir a pack's output directory
 * @returns whether `outDir` holds a package (to be replaced)
 * @throws {Error} unless `outDir` is absent, empty, or holds only a package
 */
export const checkOutDir = async (outDir: string): Promise<boolean> => {
	const entries = (await ignoreMissing(readdir(outDir), null)) ?? [];
	if (entries.length === 0) {
		return false;
	}
	if (!entries.includes(CORE_ARCHIVE)) {
		throw new Error(`${outDir} isn't empty and doesn't hold a package; refusing to replace it`);
	}
	const foreign = entries.filter((entry) => !PACKAGE_ENTRIES.has(entry));
	if (foreign.length > 0) {
		throw new Error(`${outDir} holds files that aren't part of a package: ${foreign.join(', ')}`);
	}
	return true;
};

/**
 * @param dir a directory
 * @param suffix what the sibling is for
 * @returns a hidden directory next to `dir`, on the same file system so it can be renamed into place
 */
export const siblingDir = (dir: string, suffix: string): string => {
	const resolved = resolvePath(dir);
	return join(dirname(resolved), `.${basename(resolved)}.${suffix}`);
};

/**
 * replaces `outDir` with the finished package in `stage`. each step is a rename, so readers see the old
 * package, briefly nothing, or the new package, never a mix
 *
 * @param stage the finished package
 * @param outDir where it goes; a package there is replaced
 */
export const swapIn = async (stage: string, outDir: string): Promise<void> => {
	const old = siblingDir(outDir, 'old');
	await rm(old, { recursive: true, force: true });
	const hadPackage = await ignoreMissing(
		rename(outDir, old).then(() => true),
		false,
	);
	await rename(stage, outDir);
	if (hadPackage) {
		await rm(old, { recursive: true, force: true });
	}
};
