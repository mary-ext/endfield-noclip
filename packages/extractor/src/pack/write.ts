import { createHash } from 'node:crypto';

import { encodeBlobTable } from '@endfield-noclip/package-format/blob-table';
import {
	type ArchiveInfo,
	CORE_ARCHIVE,
	CORE_PATHS,
	type PackageManifest,
} from '@endfield-noclip/package-format/manifest';

import { zstd } from '../zstd.ts';

import type { ArchiveLayout } from './archives.ts';
import { json } from './debug.ts';
import type { BlobStore } from './store/blob-store.ts';

/** a member of the core archive besides the manifest and blob index: a table, the tree, the chains */
export interface CoreMember {
	/** a `CORE_PATHS` value */
	path: string;
	/** its bytes, which may still be compressing */
	data: Uint8Array | Promise<Uint8Array>;
}

/** a written archive, for the pack report */
export interface WrittenArchive {
	name: string;
	size: number;
	headerLength: number;
	members: number;
	/** whether it was cloned from the package this one replaces */
	reused: boolean;
}

/**
 * a `.zst` core member: one zstd frame. level 9 is within about 15% of level 19 on these tables at a small
 * fraction of the time
 *
 * @param value a table
 * @returns its JSON, compressed
 */
export const jsonTable = (value: unknown): Promise<Uint8Array> => zstd(json(value), 9);

/**
 * @param data a binary table
 * @returns it compressed as a `.zst` core member, like {@link jsonTable}
 */
export const binaryTable = (data: Uint8Array): Promise<Uint8Array> => zstd(data, 9);

/**
 * writes every archive: the stored blobs' archives, then the core with the manifest, the blob index and the
 * other members. the manifest's generation hashes the members, so a package whose content changed gets a new
 * one
 *
 * @param output the blob store, the archive layout, the staging directory and the package being replaced
 *   (whose unchanged archives are cloned), or `null`
 * @param manifest the manifest without its generation and archives
 * @param members the core's other members, in archive order
 * @returns each core member's byte length and every written archive
 */
export const writePackage = async (
	{
		store,
		layout,
		dir,
		previous,
	}: { store: BlobStore; layout: ArchiveLayout; dir: string; previous: string | null },
	manifest: Omit<PackageManifest, 'generation' | 'archives'>,
	members: readonly CoreMember[],
): Promise<{ coreMembers: Record<string, number>; archives: WrittenArchive[] }> => {
	const stems = new Map([
		[CORE_ARCHIVE, CORE_ARCHIVE],
		...store.archives().map(({ name, stem }): [string, string] => [name, stem]),
	]);
	const archiveNames = [...stems.keys()];
	const blobs = { path: CORE_PATHS.blobs, data: encodeBlobTable(store.records(archiveNames)) };
	// tables compress on the thread pool while the archives are written
	const [written, datas] = await Promise.all([
		store.writeArchives(dir, previous),
		Promise.all(members.map(async ({ data }) => data)),
	]);
	const finished = [blobs, ...members.map(({ path }, i) => ({ path, data: datas[i] }))];

	const generation = createHash('sha256');
	for (const { data } of finished) {
		generation.update(data);
	}
	const archives = archiveNames.map((name): ArchiveInfo => {
		if (name === CORE_ARCHIVE) {
			return { role: 'core', name };
		}
		const { size, dataOffset } = written.get(name)!;
		return layout.info(stems.get(name)!, { name, size, dataOffset });
	});
	const complete: PackageManifest = {
		...manifest,
		generation: generation.digest('hex').slice(0, 32),
		archives,
	};
	const core = await store.writeCore(dir, [
		{ path: CORE_PATHS.manifest, data: await jsonTable(complete) },
		...finished,
	]);
	return {
		coreMembers: Object.fromEntries(finished.map(({ path, data }) => [path, data.length])),
		archives: [core, ...written.values()].map(({ name, size, headerLength, members: count, reused }) => ({
			name,
			size,
			headerLength,
			members: count,
			reused,
		})),
	};
};
