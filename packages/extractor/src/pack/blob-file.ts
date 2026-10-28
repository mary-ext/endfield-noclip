import { createHash } from 'node:crypto';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';

import { BlobCodec } from '@endfield-noclip/package-format/format';

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
			hash: createHash('sha256').update(stored).digest('hex').slice(0, 32),
			codec: pays ? BlobCodec.Zstd : BlobCodec.None,
			length: stored.length,
			rawLength: raw.length,
			crc32: crc32(stored),
		},
		stored,
	};
};

/**
 * a directory of stored blobs named by hash, fanned out by the hash's first two digits. writers in several
 * threads may add the same blob at once: each write goes to a temporary file that's renamed into place
 */
export class BlobDir {
	readonly root: string;
	readonly #made = new Map<string, Promise<unknown>>();

	/** @param root the directory; created on demand */
	constructor(root: string) {
		this.root = root;
	}

	/** @returns where a blob's bytes live */
	path(hash: string): string {
		return join(this.root, hash.slice(0, 2), hash);
	}

	/** @returns whether a blob's file exists */
	async has(hash: string): Promise<boolean> {
		try {
			await stat(this.path(hash));
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * stores a blob unless it's there already
	 *
	 * @param hash the blob's hash
	 * @param stored its stored bytes
	 */
	async write(hash: string, stored: Uint8Array): Promise<void> {
		if (await this.has(hash)) {
			return;
		}
		const fan = join(this.root, hash.slice(0, 2));
		let made = this.#made.get(fan);
		if (made === undefined) {
			made = mkdir(fan, { recursive: true });
			this.#made.set(fan, made);
		}
		await made;
		const temp = `${this.path(hash)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
		await writeFile(temp, stored);
		await rename(temp, this.path(hash));
	}
}
