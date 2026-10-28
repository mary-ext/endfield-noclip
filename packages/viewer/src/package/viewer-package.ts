/**
 * an opened viewer package: the core archive's manifest and tables, plus raw blob reads (one range read per
 * shard blob; shard JSON headers are never fetched).
 *
 * @module
 */

import { decodeBlobTable, decodeChains, decodeTree } from '@endfield-noclip/package-format/codec';
import {
	type BlobRecord,
	type Chain,
	CORE_ARCHIVE,
	CORE_PATHS,
	type GeometryTable,
	type MaterialTable,
	PACKAGE_FORMAT,
	PACKAGE_VERSION,
	type PackageManifest,
	type TextureTable,
	type Tree,
	blobPath,
} from '@endfield-noclip/package-format/format';

import { fromUint8Array, openArchive } from '@mary-ext/czar';
import { decompress } from 'fzstd';

import type { PackageSource } from './package-source.ts';

/** index of {@link CORE_ARCHIVE} in {@link PackageManifest.archives} */
export const CORE_ARCHIVE_INDEX = 0;

/** a blob's absolute byte range in its shard archive */
export interface BlobRange {
	archive: number;
	path: string;
	start: number;
	length: number;
}

/** everything the viewer reads from the core archive up front */
export interface ViewerPackage {
	source: PackageSource;
	manifest: PackageManifest;
	tree: Tree;
	blobs: BlobRecord[];
	chains: Chain[];
	geometries: GeometryTable;
	materials: MaterialTable;
	textures: TextureTable;
	/**
	 * @param index index of a blob in the core archive
	 * @returns the blob's stored bytes (codec not undone), in a buffer of their own
	 */
	readCoreBlob(index: number): Promise<ArrayBuffer>;
	/**
	 * @param index index of a blob outside the core archive
	 * @returns the archive path and absolute byte range of the blob, for request coalescing
	 * @throws {PackageError} for a core blob
	 */
	blobRange(index: number): BlobRange;
}

/** thrown for a package this viewer can't read */
export class PackageError extends Error {
	override name = 'PackageError';
}

/**
 * reads and validates the core archive and decodes its tables.
 *
 * @param source where the package lives
 * @param onProgress reports phases for the UI
 * @returns the opened package
 * @throws {PackageError} on a wrong format or version
 */
export const openViewerPackage = async (
	source: PackageSource,
	onProgress: (phase: string) => void,
): Promise<ViewerPackage> => {
	onProgress(`reading ${CORE_ARCHIVE}`);
	const archive = await openArchive(fromUint8Array(await source.readFile(CORE_ARCHIVE)));

	onProgress('decoding tables');
	const member = async (path: string): Promise<Uint8Array> => {
		const file = archive.get(path);
		if (file === undefined) {
			throw new PackageError(`${CORE_ARCHIVE} has no ${path}`);
		}
		return file.bytes();
	};
	const json = async (path: string): Promise<unknown> => {
		const bytes = await member(path);
		// `.zst` members are a single zstd frame
		return JSON.parse(new TextDecoder().decode(path.endsWith('.zst') ? decompress(bytes) : bytes));
	};

	const manifestValue = await json(CORE_PATHS.manifest);
	if (
		typeof manifestValue !== 'object' ||
		manifestValue === null ||
		!('format' in manifestValue) ||
		manifestValue.format !== PACKAGE_FORMAT
	) {
		throw new PackageError(`not an endfield-noclip package`);
	}
	if (!('version' in manifestValue) || manifestValue.version !== PACKAGE_VERSION) {
		const version = 'version' in manifestValue ? String(manifestValue.version) : 'unknown';
		throw new PackageError(`package version ${version} isn't supported (expected ${PACKAGE_VERSION})`);
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- format and version checked above
	const manifest = manifestValue as PackageManifest;
	const tree = decodeTree(await member(CORE_PATHS.tree));
	const blobs = decodeBlobTable(await member(CORE_PATHS.blobs));
	const chains = decodeChains(await member(CORE_PATHS.chains));
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- same package version as the manifest
	const geometries = (await json(CORE_PATHS.geometries)) as GeometryTable;
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- same package version as the manifest
	const materials = (await json(CORE_PATHS.materials)) as MaterialTable;
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- same package version as the manifest
	const textures = (await json(CORE_PATHS.textures)) as TextureTable;

	return {
		source,
		manifest,
		tree,
		blobs,
		chains,
		geometries,
		materials,
		textures,
		readCoreBlob(index) {
			const blob = blobs[index];
			const file =
				blob.archive === CORE_ARCHIVE_INDEX ? archive.get(blobPath(blob.hash, blob.kind)) : undefined;
			if (file === undefined) {
				return Promise.reject(new PackageError(`blob ${index} isn't in ${CORE_ARCHIVE}`));
			}
			// copied out of the archive buffer, so it can be transferred to a worker
			return file.arrayBuffer();
		},
		blobRange(index) {
			const blob = blobs[index];
			const info = manifest.archives[blob.archive];
			if (info.dataOffset === null) {
				throw new PackageError(`archive ${info.name} has no data offset`);
			}
			return {
				archive: blob.archive,
				path: info.name,
				start: info.dataOffset + blob.offset,
				length: blob.length,
			};
		},
	};
};
