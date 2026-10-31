import {
	viewOf,
	checkHeader,
	enumGuard,
	checkedEnum,
	checkLength,
	hexOf,
	bytesOfHex,
	TABLE_HEADER_SIZE,
	writeHeader,
	type HeaderShape,
} from './binary.ts';
import { BlobKind, BlobCodec } from './blobs.ts';

/** a blob's storage */
export interface BlobRecord {
	/** first 128 bits of the SHA-256 of the stored bytes, as 32 lowercase hex digits */
	hash: string;
	/** index into {@link PackageManifest.archives} */
	archive: number;
	codec: BlobCodec;
	kind: BlobKind;
	/**
	 * byte offset of the member from its archive's data section ({@link ArchiveInfo.dataOffset}), so the viewer
	 * can range-read a blob without fetching the archive's JSON header
	 */
	offset: number;
	/** stored byte length */
	length: number;
	/** byte length after undoing the codec */
	rawLength: number;
}

/** 'EFBX' */
const BLOBS_HEADER: HeaderShape = {
	magic: 0x58_42_46_45,
	version: 1,
	size: TABLE_HEADER_SIZE,
	label: 'blob table',
};

const BLOB_SIZE = 32;

const isBlobCodec = enumGuard(BlobCodec);

const isBlobKind = enumGuard(BlobKind);

/**
 * tables/blobs.bin: 16-byte header (`'EFBX'`, u16 version, u16 0, u32 blobCount, u32 0), then 32-byte
 * records: 16-byte hash, u16 archive, u8 codec, u8 kind, u32 offset, u32 length, u32 rawLength.
 *
 * @param blobs records in index order
 * @returns the encoded table
 * @throws {RangeError} if an offset or length exceeds 32 bits
 * @throws {PackageFormatError} if a hash isn't 32 lowercase hex digits
 */
export const encodeBlobTable = (blobs: readonly BlobRecord[]): Uint8Array => {
	const out = new Uint8Array(TABLE_HEADER_SIZE + blobs.length * BLOB_SIZE);
	const view = viewOf(out);
	writeHeader(view, BLOBS_HEADER);
	view.setUint32(8, blobs.length, true);
	let at = TABLE_HEADER_SIZE;
	for (const blob of blobs) {
		if (blob.offset > 0xff_ff_ff_ff || blob.length > 0xff_ff_ff_ff || blob.rawLength > 0xff_ff_ff_ff) {
			throw new RangeError(`blob ${blob.hash} doesn't fit 32-bit offsets; archives must stay below 4 GiB`);
		}
		out.set(bytesOfHex(blob.hash), at);
		view.setUint16(at + 16, blob.archive, true);
		view.setUint8(at + 18, blob.codec);
		view.setUint8(at + 19, blob.kind);
		view.setUint32(at + 20, blob.offset, true);
		view.setUint32(at + 24, blob.length, true);
		view.setUint32(at + 28, blob.rawLength, true);
		at += BLOB_SIZE;
	}
	return out;
};

/**
 * @param data tables/blobs.bin
 * @returns the blob records
 * @throws {PackageFormatError} on a bad header or length
 */
export const decodeBlobTable = (data: Uint8Array): BlobRecord[] => {
	const view = viewOf(data);
	checkHeader(view, BLOBS_HEADER);
	const count = view.getUint32(8, true);
	checkLength(data, TABLE_HEADER_SIZE + count * BLOB_SIZE, 'blob table');
	const blobs: BlobRecord[] = [];
	for (let i = 0; i < count; i++) {
		const at = TABLE_HEADER_SIZE + i * BLOB_SIZE;
		blobs.push({
			hash: hexOf(data.subarray(at, at + 16)),
			archive: view.getUint16(at + 16, true),
			codec: checkedEnum(isBlobCodec, view.getUint8(at + 18), 'blob codec'),
			kind: checkedEnum(isBlobKind, view.getUint8(at + 19), 'blob kind'),
			offset: view.getUint32(at + 20, true),
			length: view.getUint32(at + 24, true),
			rawLength: view.getUint32(at + 28, true),
		});
	}
	return blobs;
};
