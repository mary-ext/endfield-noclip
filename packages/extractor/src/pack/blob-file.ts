import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';

import { BlobCodec } from '@endfield-noclip/package-format/blobs';

import { getOrInsert } from '../collections.ts';
import { ignoreMissing } from '../errors.ts';

// stored blobs as files, shared by the packer's blob store and the conversion workers. what's here decides
// blob bytes and hashes, so the pack cache fingerprints it.

/** a stored blob's identity and sizes; its bytes live in a {@link BlobDir} under {@link hash} */
export interface BlobMeta {
	/** first 128 bits of the SHA-256 of the stored bytes, hex */
	hash: string;
	codec: BlobCodec;
	/** stored byte length */
	length: number;
	/** byte length after undoing the codec */
	rawLength: number;
	crc32: number;
}

/**
 * @param data bytes or text
 * @returns the first 128 bits of its SHA-256, as 32 hex digits: the package's blob hash
 */
export const shortHash = (data: Uint8Array | string): string => {
	return createHash('sha256').update(data).digest('hex').slice(0, 32);
};

/**
 * picks a blob's stored form: the zstd frame when it saves at least 1/32 of the bytes (a frame costs a decode
 * pass), else the raw bytes
 *
 * @param raw the blob's bytes
 * @param packed `raw` as one zstd frame, or `null` when the blob isn't compressed
 * @returns the stored bytes and their description
 */
export const storedBlob = (
	raw: Uint8Array,
	packed: Uint8Array | null,
): { meta: BlobMeta; stored: Uint8Array } => {
	const pays = packed !== null && packed.length <= raw.length - raw.length / 32;
	const stored = pays ? packed : raw;
	return {
		meta: {
			hash: shortHash(stored),
			codec: pays ? BlobCodec.Zstd : BlobCodec.None,
			length: stored.length,
			rawLength: raw.length,
			crc32: crc32(stored),
		},
		stored,
	};
};

/**
 * a directory of files named by hash, fanned out by the hash's first two digits. writers in several threads
 * may add the same file at once: each write goes to a temporary file that's renamed into place
 */
export class BlobDir {
	readonly root: string;
	readonly #made = new Map<string, Promise<unknown>>();

	/** @param root the directory; created on demand */
	constructor(root: string) {
		this.root = root;
	}

	/** @returns where a file lives */
	path(hash: string): string {
		return join(this.root, hash.slice(0, 2), hash);
	}

	/** @returns whether a file exists */
	async has(hash: string): Promise<boolean> {
		return (await ignoreMissing(stat(this.path(hash)), undefined)) !== undefined;
	}

	/**
	 * stores a file unless it's there already
	 *
	 * @param hash the file's name
	 * @param data its contents
	 */
	async write(hash: string, data: Uint8Array | string): Promise<void> {
		if (await this.has(hash)) {
			return;
		}
		await this.replace(hash, data);
	}

	/**
	 * stores a file, replacing any earlier one
	 *
	 * @param hash the file's name
	 * @param data its contents
	 */
	async replace(hash: string, data: Uint8Array | string): Promise<void> {
		const fan = join(this.root, hash.slice(0, 2));
		await getOrInsert(this.#made, fan, () => mkdir(fan, { recursive: true }));
		const temp = `${this.path(hash)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
		await writeFile(temp, data);
		await rename(temp, this.path(hash));
	}

	/** @returns the names of the stored files */
	async names(): Promise<string[]> {
		const fans = await ignoreMissing(readdir(this.root), []);
		const listed = await Promise.all(fans.map((fan) => readdir(join(this.root, fan))));
		return listed.flat().filter((name) => !name.endsWith('.tmp'));
	}

	/**
	 * deletes the files `keep` rejects, and temporary files left by interrupted writes
	 *
	 * @param keep whether to keep a file, by name
	 * @returns how many files were deleted and their bytes
	 */
	async sweep(keep: (hash: string) => boolean): Promise<{ files: number; bytes: number }> {
		let files = 0;
		let bytes = 0;
		const fans = await ignoreMissing(readdir(this.root), []);
		await Promise.all(
			fans.map(async (fan) => {
				for (const name of await readdir(join(this.root, fan))) {
					if (!name.endsWith('.tmp') && keep(name)) {
						continue;
					}
					const path = join(this.root, fan, name);
					// oxlint-disable-next-line no-await-in-loop -- one fan at a time per task bounds open files
					bytes += (await ignoreMissing(stat(path), undefined))?.size ?? 0;
					// oxlint-disable-next-line no-await-in-loop
					await rm(path, { force: true });
					files++;
				}
			}),
		);
		return { files, bytes };
	}
}
