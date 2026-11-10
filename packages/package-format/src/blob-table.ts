import {
	viewOf,
	checkHeader,
	enumGuard,
	checkedEnum,
	checkLength,
	TABLE_HEADER_SIZE,
	writeHeader,
	type HeaderShape,
} from './binary.ts';
import { BlobKind, BlobCodec } from './blobs.ts';

/** a blob's storage */
export interface BlobRecord {
	kind: BlobKind;
	codec: BlobCodec;
	/** index into {@link PackageManifest.archives} */
	archive: number;
	/**
	 * byte offset of the member from its archive's data section ({@link ArchiveInfo.dataOffset}, or for the
	 * core the position of its first member), so a reader can range-read a blob without its archive's JSON
	 * header
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
	version: 2,
	size: TABLE_HEADER_SIZE,
	label: 'blob table',
};

const BLOB_SIZE = 16;

const isBlobCodec = enumGuard(BlobCodec);

const isBlobKind = enumGuard(BlobKind);

/**
 * tables/blobs.bin; the layout is in docs/package-format.md (binary encodings).
 *
 * @param blobs records in index order
 * @returns the encoded table
 * @throws {RangeError} if an offset or length exceeds 32 bits, or an archive index 16 bits
 */
export const encodeBlobTable = (blobs: readonly BlobRecord[]): Uint8Array => {
	const out = new Uint8Array(TABLE_HEADER_SIZE + blobs.length * BLOB_SIZE);
	const view = viewOf(out);
	writeHeader(view, BLOBS_HEADER);
	view.setUint32(8, blobs.length, true);
	let at = TABLE_HEADER_SIZE;
	for (const [index, blob] of blobs.entries()) {
		if (blob.offset > 0xff_ff_ff_ff || blob.length > 0xff_ff_ff_ff || blob.rawLength > 0xff_ff_ff_ff) {
			throw new RangeError(`blob ${index} doesn't fit 32-bit offsets; archives must stay below 4 GiB`);
		}
		if (blob.archive > 0xff_ff) {
			throw new RangeError(`blob ${index} is in archive ${blob.archive}, past what 16 bits index`);
		}
		view.setUint8(at, blob.kind);
		view.setUint8(at + 1, blob.codec);
		view.setUint16(at + 2, blob.archive, true);
		view.setUint32(at + 4, blob.offset, true);
		view.setUint32(at + 8, blob.length, true);
		view.setUint32(at + 12, blob.rawLength, true);
		at += BLOB_SIZE;
	}
	return out;
};

/**
 * @param data tables/blobs.bin
 * @returns the blob records
 * @throws {PackageFormatError} on a bad header, length, kind or codec
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
			kind: checkedEnum(isBlobKind, view.getUint8(at), 'blob kind'),
			codec: checkedEnum(isBlobCodec, view.getUint8(at + 1), 'blob codec'),
			archive: view.getUint16(at + 2, true),
			offset: view.getUint32(at + 4, true),
			length: view.getUint32(at + 8, true),
			rawLength: view.getUint32(at + 12, true),
		});
	}
	return blobs;
};
