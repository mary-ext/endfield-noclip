import { chacha20 } from '@noble/ciphers/chacha.js';

import { BinaryReader, FormatError, toHex } from '../binary/binary-reader.ts';

// #region types

/** one logical file stored inside a `.chk` chunk */
export interface VfsFileEntry {
	/** logical path, e.g. `Data/Streaming/PC/map02/Streaming/InitChunkData_0_0_0_0.bytes` */
	name: string;
	/** 8-byte name hash as uppercase hex */
	nameHash: string;
	/** md5 name of the chunk holding the bytes, i.e. `<chunkMd5>.chk` */
	chunkMd5: string;
	/** md5 of the logical file's decrypted bytes, uppercase hex */
	dataMd5: string;
	offset: number;
	length: number;
	blockType: number;
	/** per-file ChaCha20 seed; `null` when the file is stored in the clear */
	ivSeed: bigint | null;
}

/** one physical `.chk` file */
export interface VfsChunkEntry {
	md5: string;
	contentMd5: string;
	length: number;
	blockType: number;
	files: VfsFileEntry[];
}

/** a decrypted `<group>.blc` catalog */
export interface VfsCatalog {
	/** catalog version; also forms part of per-file nonces */
	version: number;
	/** human name, e.g. `Bundle`, `Streaming` */
	groupName: string;
	/** 8 hex digits, matching the directory name */
	groupHash: string;
	blockType: number;
	fileCount: number;
	chunksLength: number;
	chunks: VfsChunkEntry[];
}

// #endregion

/** bytes before the encrypted body: `u32 version ‖ 8 bytes`, which together form the nonce */
const CATALOG_HEAD_LENGTH = 12;

/**
 * decrypts and parses a `.blc` catalog.
 *
 * @param raw entire `.blc` file
 * @param key 32-byte VFS ChaCha20 key
 * @returns the parsed catalog
 * @throws {FormatError} if the key is wrong or the layout is unrecognized
 */
export const parseVfsCatalog = (raw: Uint8Array, key: Uint8Array): VfsCatalog => {
	if (key.length !== 32) {
		throw new FormatError('vfs key must be 32 bytes');
	}
	if (raw.length <= CATALOG_HEAD_LENGTH) {
		throw new FormatError('vfs catalog is too short');
	}

	const plain = new Uint8Array(raw.length);
	plain.set(raw.subarray(0, CATALOG_HEAD_LENGTH));
	chacha20(
		key,
		raw.subarray(0, CATALOG_HEAD_LENGTH),
		raw.subarray(CATALOG_HEAD_LENGTH),
		plain.subarray(CATALOG_HEAD_LENGTH),
		1,
	);

	const r = new BinaryReader(plain, { littleEndian: true });
	const version = r.u32();
	if (version === 0 || version > 100) {
		throw new FormatError(`unexpected vfs catalog version ${version}`);
	}
	r.offset = CATALOG_HEAD_LENGTH;

	// release catalogs start with a layout marker; 5 widens the per-entry padding from 4 to 8 bytes
	const layout = r.u32();
	if (layout !== 4 && layout !== 5) {
		throw new FormatError(`unknown vfs catalog layout ${layout}; is the key correct?`);
	}
	const padding = layout === 5 ? 8 : 4;
	r.skip(4);

	const groupName = readShortString(r);
	const groupHash = toHex(r.bytesView(8).subarray(0, 4));
	const fileCount = r.i32();
	const chunksLength = r.i64Number();
	const blockType = r.u8();
	const chunkCount = r.i32();
	if (fileCount < 0 || chunkCount < 0 || chunkCount > 100_000) {
		throw new FormatError(`implausible vfs catalog counts: ${fileCount} files, ${chunkCount} chunks`);
	}

	const chunks: VfsChunkEntry[] = [];
	let parsedFiles = 0;
	for (let c = 0; c < chunkCount; c++) {
		const md5 = toHex(r.bytesView(16));
		const contentMd5 = toHex(r.bytesView(16));
		const length = r.i64Number();
		const chunkBlockType = r.u8();
		r.skip(padding);

		const itemCount = r.i32();
		if (itemCount < 0) {
			throw new FormatError(`negative file count in chunk ${md5}`);
		}
		const files: VfsFileEntry[] = [];
		for (let i = 0; i < itemCount; i++) {
			const name = readShortString(r);
			const nameHash = toHex(r.bytesView(8));
			const chunkMd5 = toHex(r.bytesView(16));
			const dataMd5 = toHex(r.bytesView(16));
			const offset = r.i64Number();
			const fileLength = r.i64Number();
			const fileBlockType = r.u8();
			const encrypted = r.bool();
			const ivSeed = encrypted ? r.i64() : null;
			// the padding follows the optional seed; reading it first yields bogus nonces
			r.skip(padding);
			if (offset < 0 || fileLength < 0 || offset + fileLength > length) {
				throw new FormatError(`vfs entry ${name} lies outside its chunk`);
			}
			files.push({
				name,
				nameHash,
				chunkMd5,
				dataMd5,
				offset,
				length: fileLength,
				blockType: fileBlockType,
				ivSeed,
			});
		}
		parsedFiles += files.length;
		chunks.push({ md5, contentMd5, length, blockType: chunkBlockType, files });
	}

	if (parsedFiles !== fileCount) {
		throw new FormatError(`vfs catalog declares ${fileCount} files but holds ${parsedFiles}`);
	}
	if (r.remaining > 16) {
		throw new FormatError(`vfs catalog has ${r.remaining} trailing bytes`);
	}

	return { version, groupName, groupHash, blockType, fileCount, chunksLength, chunks };
};

/** where a slice sits in an encrypted logical file, and the file's key material */
export interface VfsSliceCipher {
	/** offset of the slice within the logical file; must be a multiple of 64 */
	position: number;
	/** 32-byte VFS key */
	key: Uint8Array;
	/** catalog version */
	version: number;
	/** the entry's seed */
	ivSeed: bigint;
}

/**
 * decrypts a slice of an encrypted logical file in place. ChaCha20 is seekable, so any 64-byte-aligned window
 * can be decrypted without the bytes before it.
 *
 * @param data ciphertext covering file bytes `[position, position + data.length)`; overwritten with the
 *   plaintext
 * @param cipher the slice's position and key material
 * @throws {FormatError} if `position` isn't 64-byte aligned
 */
export const decryptVfsFileSliceInPlace = (data: Uint8Array, cipher: VfsSliceCipher): void => {
	if (cipher.position % 64 !== 0) {
		throw new FormatError('vfs decryption must start on a 64-byte boundary');
	}
	const nonce = new Uint8Array(12);
	const view = new DataView(nonce.buffer);
	view.setUint32(0, cipher.version, true);
	view.setBigInt64(4, cipher.ivSeed, true);
	chacha20(cipher.key, nonce, data, data, 1 + cipher.position / 64);
};

const readShortString = (r: BinaryReader): string => {
	const length = r.i16();
	if (length < 0) {
		throw new FormatError(`negative string length at 0x${(r.offset - 2).toString(16)}`);
	}
	return r.utf8(length);
};
