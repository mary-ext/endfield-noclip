import { createDecipheriv, createHash } from 'node:crypto';
import { open, readdir, readFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import type { ByteSource } from '@endfield-noclip/formats/hg/bundle';
import {
	type ChaCha20Cipher,
	decryptVfsFileSliceInPlace,
	parseVfsCatalog,
	type VfsCatalog,
	type VfsFileEntry,
} from '@endfield-noclip/formats/hg/vfs-catalog';

import { ignoreMissing } from '../util/errors.ts';

const chachaIv = new Uint8Array(16);
const chachaIvView = new DataView(chachaIv.buffer);

/** OpenSSL ChaCha20 (RFC 8439: 4-byte LE block counter ‖ 12-byte nonce) */
const nativeChaCha20: ChaCha20Cipher = (key, nonce, counter, input, output) => {
	chachaIvView.setUint32(0, counter, true);
	chachaIv.set(nonce, 4);
	const decipher = createDecipheriv('chacha20', key, chachaIv);
	output.set(decipher.update(input));
};

const VFS_CIPHER_OPTIONS = { chacha20: nativeChaCha20 };

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

/** a logical file located in a mounted group; implements {@link ByteSource} for random-access readers */
export class VfsFile implements ByteSource {
	readonly group: MountedGroup;
	readonly entry: VfsFileEntry;
	readonly #readRange: (
		group: MountedGroup,
		entry: VfsFileEntry,
		start: number,
		end: number,
	) => Promise<Uint8Array>;

	/**
	 * @param group mounted group containing this file
	 * @param entry catalog entry
	 * @param readRange internal range reader bound to the owning {@link Vfs}
	 * @internal
	 */
	constructor(
		group: MountedGroup,
		entry: VfsFileEntry,
		readRange: (group: MountedGroup, entry: VfsFileEntry, start: number, end: number) => Promise<Uint8Array>,
	) {
		this.group = group;
		this.entry = entry;
		this.#readRange = readRange;
	}

	/** logical length in bytes */
	get size(): number {
		return this.entry.length;
	}

	/**
	 * reads a byte range of the file, decrypting it if needed
	 *
	 * @param start inclusive offset within the logical file (defaults to 0)
	 * @param end exclusive end (defaults to the file length)
	 * @returns the requested bytes
	 */
	read(start = 0, end = this.entry.length): Promise<Uint8Array> {
		return this.#readRange(this.group, this.entry, start, end);
	}

	/**
	 * reads the whole file and checks it against the catalog's md5
	 *
	 * @returns the verified bytes
	 * @throws {Error} on md5 mismatch, which usually means the install changed under us
	 */
	async readVerified(): Promise<Uint8Array> {
		const data = await this.read();
		const md5 = createHash('md5').update(data).digest('hex').toUpperCase();
		if (md5 !== this.entry.dataMd5) {
			throw new Error(`md5 mismatch for ${this.entry.name}: ${md5} != ${this.entry.dataMd5}`);
		}
		return data;
	}
}

/** a group catalog plus where its chunks live on disk */
export interface MountedGroup {
	catalog: VfsCatalog;
	/** first 128 bits of the SHA-256 of the group's raw `.blc` catalog bytes, hex */
	catalogHash: string;
	/** layers to search for chunks, highest priority first */
	dirs: string[];
	/** wraps a catalog entry from this group in a readable {@link VfsFile} */
	file(entry: VfsFileEntry): VfsFile;
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
 * read-only view of the game's virtual file system. a group's catalog comes whole from the first layer of
 * {@link vfsLayerDirs} holding one; its chunks may live in either layer
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
		// oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy
		return [...found].sort();
	}

	/**
	 * loads (once) and returns a group's catalog
	 *
	 * @param hash 8-hex group hash
	 * @throws {Error} if no layer has a catalog for the group
	 */
	group(hash: string): Promise<MountedGroup> {
		return this.#groups.getOrInsertComputed(hash, () => {
			const mounted = this.#mount(hash);
			// a failed mount shouldn't stay cached
			mounted.catch(() => this.#groups.delete(hash));
			return mounted;
		});
	}

	/**
	 * @param hash group hash
	 * @param name logical path
	 * @returns the file handle, or `undefined` if the group doesn't contain it
	 */
	async find(hash: string, name: string): Promise<VfsFile | undefined> {
		const group = await this.group(hash);
		const entry = group.catalog.get(name);
		return entry && group.file(entry);
	}

	/**
	 * reads a logical file, returning `undefined` if the group doesn't contain it
	 *
	 * @param hash group hash
	 * @param name logical file name
	 * @param options.verify check the file's MD5 against the catalog (default `true`); pass `false` for large
	 *   or high-volume files whose own framing already validates their bytes
	 * @returns the file's bytes, or `undefined` if absent
	 */
	async tryRead(hash: string, name: string, options?: { verify?: boolean }): Promise<Uint8Array | undefined> {
		const file = await this.find(hash, name);
		if (file === undefined) {
			return undefined;
		}
		return options?.verify === false ? file.read() : file.readVerified();
	}

	/**
	 * reads a logical file, throwing if absent
	 *
	 * @param hash group hash
	 * @param name logical file name
	 * @param options.verify check the file's MD5 against the catalog (default `true`); pass `false` for large
	 *   or high-volume files whose own framing already validates their bytes
	 * @returns the file's bytes
	 * @throws {FormatError} if the group has no such file
	 */
	async read(hash: string, name: string, options?: { verify?: boolean }): Promise<Uint8Array> {
		const data = await this.tryRead(hash, name, options);
		if (data === undefined) {
			throw new FormatError(`missing ${name}`);
		}
		return data;
	}

	/** closes cached chunk handles; handles with reads in flight close once those finish */
	async close(): Promise<void> {
		const chunks = [...this.#handles.values()];
		this.#handles.clear();
		const idle: Promise<void>[] = [];
		for (const chunk of chunks) {
			chunk.evicted = true;
			if (chunk.users === 0) {
				idle.push(closeQuietly(chunk.handle));
			}
		}
		await Promise.all(idle);
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

		const catalog = parseVfsCatalog(blc, this.#key, VFS_CIPHER_OPTIONS);
		const catalogHash = createHash('sha256').update(blc).digest('hex').slice(0, 32);
		const readRange = (group: MountedGroup, entry: VfsFileEntry, start: number, end: number) =>
			this.#readRange(group, entry, start, end);
		const group: MountedGroup = {
			catalog,
			catalogHash,
			dirs,
			file: (entry) => new VfsFile(group, entry, readRange),
		};
		return group;
	}

	async #readRange(
		group: MountedGroup,
		entry: VfsFileEntry,
		start: number,
		end: number,
	): Promise<Uint8Array> {
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
		decryptVfsFileSliceInPlace(
			buffer,
			{
				position: alignedStart,
				key: this.#key,
				version: group.catalog.version,
				ivSeed: entry.ivSeed,
			},
			VFS_CIPHER_OPTIONS,
		);
		return buffer.subarray(start - alignedStart);
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
