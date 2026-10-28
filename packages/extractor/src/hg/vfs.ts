import { createHash } from 'node:crypto';
import { open, readdir, readFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import {
	decryptVfsFileSliceInPlace,
	parseVfsCatalog,
	type VfsCatalog,
	type VfsFileEntry,
} from '@endfield-noclip/formats/hg/vfs-catalog';

import { ignoreMissing } from '../errors.ts';

/** well-known VFS group hashes */
export const VfsGroup = {
	Bundle: '7064D8E2',
	InitialBundle: '0CE8FA57',
	BundleManifest: '1CDDBF1F',
	ExtendData: 'D6E622F7',
	InitialExtendData: '3C9D9D2D',
	Streaming: 'C3442D43',
	DynamicStreaming: '23D53F5D',
	Terrain: 'F84BF5E6',
	JsonData: '775A31D1',
	Table: '42A8FCA6',
} as const;

/**
 * @param gameData path to `Endfield_Data`
 * @returns the VFS layer directories, highest priority first: the Persistent layer (patches) supersedes
 *   StreamingAssets
 */
export const vfsLayerDirs = (gameData: string): string[] => [
	join(gameData, 'Persistent/VFS'),
	join(gameData, 'StreamingAssets/VFS'),
];

/**
 * @param layerDir a directory from {@link vfsLayerDirs}
 * @param hash 8-hex group hash
 * @returns where the group's `.blc` catalog lives in that layer
 */
export const vfsCatalogPath = (layerDir: string, hash: string): string => join(layerDir, hash, `${hash}.blc`);

/** a logical file located in a mounted group */
export interface VfsFile {
	group: MountedGroup;
	entry: VfsFileEntry;
}

/** a group catalog plus where its chunks live on disk */
export interface MountedGroup {
	catalog: VfsCatalog;
	/** layers to search for chunks, highest priority first */
	dirs: string[];
	files: Map<string, VfsFileEntry>;
}

/** chunk files kept open at once; least recently used ones are closed once idle */
const OPEN_CHUNK_LIMIT = 64;

/** an open chunk file and the reads in flight on it */
interface ChunkHandle {
	handle: Promise<FileHandle>;
	users: number;
	evicted: boolean;
}

/**
 * read-only view of the game's virtual file system.
 *
 * the Persistent layer (patches) carries a complete catalog that supersedes StreamingAssets'; its chunks may
 * live in either layer, Persistent first.
 */
export class Vfs {
	readonly gameData: string;
	readonly #key: Uint8Array;
	readonly #groups = new Map<string, Promise<MountedGroup>>();
	/** insertion-ordered, so the first entry is the least recently used */
	readonly #handles = new Map<string, ChunkHandle>();

	/**
	 * @param gameData path to `Endfield_Data`
	 * @param key 32-byte VFS key
	 */
	constructor(gameData: string, key: Uint8Array) {
		this.gameData = gameData;
		this.#key = key;
	}

	/** @returns group hashes present in any layer */
	async listGroups(): Promise<string[]> {
		const listings = await Promise.all(
			vfsLayerDirs(this.gameData).map((layer) => ignoreMissing(readdir(layer), [])),
		);
		const found = new Set(listings.flat().filter((name) => /^[0-9A-F]{8}$/.test(name)));
		return [...found].toSorted();
	}

	/**
	 * loads (once) and returns a group's catalog
	 *
	 * @param hash 8-hex group hash
	 * @throws {Error} if no layer has a catalog for the group
	 */
	group(hash: string): Promise<MountedGroup> {
		let cached = this.#groups.get(hash);
		if (cached === undefined) {
			cached = this.#mount(hash);
			this.#groups.set(hash, cached);
			// a failed mount shouldn't stay cached
			cached.catch(() => this.#groups.delete(hash));
		}
		return cached;
	}

	/**
	 * @param hash group hash
	 * @param name logical path
	 * @returns the file, or `undefined` if the group doesn't contain it
	 */
	async find(hash: string, name: string): Promise<VfsFile | undefined> {
		const group = await this.group(hash);
		const entry = group.files.get(name);
		return entry && { group, entry };
	}

	/**
	 * reads a byte range of a logical file, decrypting it if needed
	 *
	 * @param file file to read
	 * @param start offset within the logical file
	 * @param end exclusive end; defaults to the file length
	 */
	async read(file: VfsFile, start = 0, end = file.entry.length): Promise<Uint8Array> {
		const { entry, group } = file;
		if (start < 0 || end > entry.length || start > end) {
			throw new RangeError(`range ${start}..${end} outside ${entry.name} (${entry.length} bytes)`);
		}

		// encrypted reads must begin on a ChaCha20 block boundary
		const alignedStart = entry.ivSeed === null ? start : start - (start % 64);
		const buffer = new Uint8Array(end - alignedStart);
		const chunk = this.#acquire(group, entry.chunkMd5);
		try {
			const handle = await chunk.handle;
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, entry.offset + alignedStart);
			if (bytesRead !== buffer.length) {
				throw new Error(`short read of ${entry.name} in chunk ${entry.chunkMd5}`);
			}
		} finally {
			this.#release(chunk);
		}

		if (entry.ivSeed === null) {
			return buffer;
		}
		decryptVfsFileSliceInPlace(buffer, {
			position: alignedStart,
			key: this.#key,
			version: group.catalog.version,
			ivSeed: entry.ivSeed,
		});
		return buffer.subarray(start - alignedStart);
	}

	/**
	 * reads a whole logical file and checks it against the catalog's md5
	 *
	 * @throws {Error} on md5 mismatch, which usually means the install changed under us
	 */
	async readVerified(file: VfsFile): Promise<Uint8Array> {
		const data = await this.read(file);
		const md5 = createHash('md5').update(data).digest('hex').toUpperCase();
		if (md5 !== file.entry.dataMd5) {
			throw new Error(`md5 mismatch for ${file.entry.name}: ${md5} != ${file.entry.dataMd5}`);
		}
		return data;
	}

	/** closes cached chunk handles */
	async close(): Promise<void> {
		const chunks = [...this.#handles.values()];
		this.#handles.clear();
		await Promise.allSettled(chunks.map(async (chunk) => (await chunk.handle).close()));
	}

	async #mount(hash: string): Promise<MountedGroup> {
		const dirs = vfsLayerDirs(this.gameData).map((layer) => join(layer, hash));
		let blc: Uint8Array | undefined;
		for (const layer of vfsLayerDirs(this.gameData)) {
			// oxlint-disable-next-line no-await-in-loop -- the first layer holding a catalog wins
			blc = await ignoreMissing(readFile(vfsCatalogPath(layer, hash)), undefined);
			if (blc !== undefined) {
				break;
			}
		}
		if (blc === undefined) {
			throw new Error(`vfs group ${hash} has no catalog`);
		}

		const catalog = parseVfsCatalog(blc, this.#key);
		const files = new Map<string, VfsFileEntry>();
		for (const chunk of catalog.chunks) {
			for (const file of chunk.files) {
				files.set(file.name, file);
			}
		}
		return { catalog, dirs, files };
	}

	#acquire(group: MountedGroup, md5: string): ChunkHandle {
		let chunk = this.#handles.get(md5);
		if (chunk === undefined) {
			chunk = { handle: openFirst(group.dirs, `${md5}.chk`), users: 0, evicted: false };
			// a failed open shouldn't stay cached
			chunk.handle.catch(() => {
				if (this.#handles.get(md5) === chunk) {
					this.#handles.delete(md5);
				}
			});
		} else {
			this.#handles.delete(md5);
		}
		this.#handles.set(md5, chunk);
		chunk.users++;

		for (const [oldMd5, old] of this.#handles) {
			if (this.#handles.size <= OPEN_CHUNK_LIMIT) {
				break;
			}
			this.#handles.delete(oldMd5);
			old.evicted = true;
			if (old.users === 0) {
				void closeQuietly(old.handle);
			}
		}
		return chunk;
	}

	#release(chunk: ChunkHandle): void {
		chunk.users--;
		if (chunk.evicted && chunk.users === 0) {
			void closeQuietly(chunk.handle);
		}
	}
}

/**
 * @param dirs candidate directories, highest priority first
 * @param name file name
 * @returns a read handle on the first copy that exists
 * @throws {Error} if none does
 */
const openFirst = async (dirs: string[], name: string): Promise<FileHandle> => {
	for (const dir of dirs) {
		// oxlint-disable-next-line no-await-in-loop -- the first layer holding the chunk wins
		const handle = await ignoreMissing(open(join(dir, name), 'r'), undefined);
		if (handle !== undefined) {
			return handle;
		}
	}
	throw new Error(`chunk ${name} not found in any layer`);
};

const closeQuietly = async (handle: Promise<FileHandle>): Promise<void> => {
	try {
		await (await handle).close();
	} catch {
		// a failed open has nothing to close
	}
};
