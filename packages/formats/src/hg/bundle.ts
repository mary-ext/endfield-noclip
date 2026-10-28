/**
 * Endfield's obfuscated UnityFS asset bundle container.
 *
 * the layout is UnityFS with the signature replaced by a keyed magic check, header, block table and directory
 * fields scrambled, the blocks-info and data blocks passed through the bundle cipher pad, and data blocks
 * compressed with "inverted" LZ4.
 *
 * descrambling is ported from AnimeStudio (`AnimeStudio/VFSFile.cs`, `AnimeStudio/Crypto/VFSUtils.cs`, commit
 * 7cfb26b, MIT, © Radu, Perfare, Razmoth and contributors).
 */

import { BinaryReader, FormatError } from '../binary/binary-reader.ts';
import { decodeInvertedLz4Block, decodeLz4Block } from '../binary/lz4.ts';

import { applyBundlePad } from './bundle-cipher.ts';

// #region types

/** descrambled bundle header */
export interface BundleHeader {
	/** total bundle size declared by the header */
	size: number;
	/** UnityFS archive flags (compression in the low 6 bits, see {@link BundleArchiveFlags}) */
	flags: number;
	/** obfuscation revision; 7 and above use a 48-byte header */
	encFlags: number;
	compressedBlocksInfoSize: number;
	uncompressedBlocksInfoSize: number;
	/** absolute offset of the (compressed, padded) blocks-info */
	blocksInfoOffset: number;
	/** absolute offset of the first data block */
	dataOffset: number;
}

/** UnityFS archive flag bits used by Endfield bundles */
export const BundleArchiveFlags = {
	CompressionMask: 0x3f,
	BlocksAndDirectoryInfoCombined: 0x40,
	BlocksInfoAtTheEnd: 0x80,
	BlockInfoNeedPaddingAtStart: 0x200,
} as const;

/** one storage block of the bundle's data stream */
export interface BundleBlock {
	/** storage flags; the value is the compression type (0 raw, 5 padded inverted LZ4) */
	flags: number;
	compressedSize: number;
	uncompressedSize: number;
	/** absolute offset of the block's stored bytes in the bundle */
	compressedOffset: number;
	/** offset of the block's first byte in the concatenated decompressed stream */
	uncompressedOffset: number;
}

/** a file inside the bundle, addressed in the decompressed stream */
export interface BundleNode {
	/** e.g. `CAB-<32 hex>` or `CAB-<32 hex>.resS` */
	path: string;
	offset: number;
	size: number;
	/** UnityFS node flags; bit 2 (0x4) marks a SerializedFile */
	flags: number;
}

/** parsed header, block table and directory: everything needed to locate node bytes */
export interface BundleDirectory {
	header: BundleHeader;
	blocks: BundleBlock[];
	nodes: BundleNode[];
}

/** random-access byte source, e.g. a file handle, an HTTP range reader or an in-memory buffer */
export interface ByteSource {
	/** total length in bytes */
	size: number;
	/**
	 * @param start inclusive offset
	 * @param end exclusive offset
	 * @returns exactly `end - start` bytes; the caller may mutate them
	 */
	read(start: number, end: number): Promise<Uint8Array>;
}

/** node flag marking a SerializedFile */
export const BUNDLE_NODE_SERIALIZED_FILE = 0x4;

/** bytes needed by {@link parseBundleHeader} */
export const BUNDLE_HEADER_SIZE = 48;

// #endregion

// #region descrambling

const ror32 = (value: number, count: number): number => {
	return ((value >>> count) | (value << (32 - count))) >>> 0;
};

const rol16 = (value: number, count: number): number => {
	return ((value << count) | (value >>> (16 - count))) & 0xffff;
};

const MASK64 = 0xffff_ffff_ffff_ffffn;

const rol64 = (value: bigint, count: bigint): bigint => {
	return ((value << count) | (value >> (64n - count))) & MASK64;
};

const bswap32 = (value: number): number => {
	return (((value & 0xff) << 24) | ((value & 0xff00) << 8) | ((value >>> 8) & 0xff00) | (value >>> 24)) >>> 0;
};

/** joins two 16-bit halves scrambled as `(hi ^ lo ^ 0xA121) ‖ lo`, then unrotates */
const descramble32 = (hi: number, lo: number): number => {
	return (ror32((((hi ^ lo ^ 0xa121) << 16) | lo) >>> 0, 18) ^ 0xf74324ee) >>> 0;
};

const toSafeNumber = (value: bigint, what: string): number => {
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new FormatError(`bundle ${what} ${value} isn't a safe integer; wrong key or not a bundle?`);
	}
	return Number(value);
};

/**
 * @param prefix at least the first 8 bytes of a candidate file
 * @returns whether the keyed magic check passes
 */
export const isHgBundle = (prefix: Uint8Array): boolean => {
	if (prefix.length < 8) {
		return false;
	}
	const view = new DataView(prefix.buffer, prefix.byteOffset, 8);
	const a = (view.getUint32(0, false) ^ 0x4a92f0cd) >>> 0;
	const b = view.getUint32(4, false);
	const expected = (((a * 4) & 0xffff0000) ^ ror32(a, 14) ^ 0xd8b1e637) >>> 0;
	return b === expected;
};

/**
 * @param prefix at least the first {@link BUNDLE_HEADER_SIZE} bytes of the bundle
 * @returns the descrambled header
 * @throws {FormatError} if the magic check fails or the header is implausible
 */
export const parseBundleHeader = (prefix: Uint8Array): BundleHeader => {
	if (!isHgBundle(prefix)) {
		throw new FormatError('not an Endfield bundle (magic check failed)');
	}
	const r = new BinaryReader(prefix, { offset: 8, littleEndian: false });
	const cbis2 = r.u16();
	const flags2 = r.u32();
	const encFlagsRaw = r.u32();
	const size2 = r.u32();
	const flags1 = r.u32();
	const ubis1 = r.u16();
	r.skip(4);
	const ubis2 = r.u16();
	const size1 = r.u32();
	const cbis1 = r.u16();

	const compressedBlocksInfoSize = descramble32(cbis1, cbis2);
	const uncompressedBlocksInfoSize = descramble32(ubis1, ubis2);
	// AnimeStudio unrotates this with ror 18 and truncates to 32 bits, but it never uses the result; rol 14
	// (as for node fields) reproduces the file length exactly
	const sizeHi = BigInt((size1 ^ size2 ^ 0xdad76848) >>> 0);
	const size = toSafeNumber(rol64((sizeHi << 32n) | BigInt(size2), 14n) ^ 0xa4f1a11747816520n, 'size');
	const encFlags = (encFlagsRaw ^ flags2) >>> 0;
	const flags = (flags1 ^ flags2 ^ 0xa7f49310) >>> 0;

	const base = encFlags >= 7 ? 48 : 40;
	let blocksInfoOffset = base;
	let dataOffset = base;
	if (flags & BundleArchiveFlags.BlocksInfoAtTheEnd) {
		blocksInfoOffset = size - compressedBlocksInfoSize;
	} else if (flags & BundleArchiveFlags.BlockInfoNeedPaddingAtStart) {
		dataOffset += (compressedBlocksInfoSize + 15) & ~15;
	} else {
		dataOffset += compressedBlocksInfoSize;
	}
	if (blocksInfoOffset < 0 || blocksInfoOffset + compressedBlocksInfoSize > size) {
		throw new FormatError(`bundle blocks-info at ${blocksInfoOffset} lies outside the ${size}-byte bundle`);
	}

	return {
		size,
		flags,
		encFlags,
		compressedBlocksInfoSize,
		uncompressedBlocksInfoSize,
		blocksInfoOffset,
		dataOffset,
	};
};

/**
 * @param header result of {@link parseBundleHeader}
 * @param stored the `compressedBlocksInfoSize` bytes at `header.blocksInfoOffset`; not mutated
 * @param pad bundle cipher pad from `deriveBundlePad`
 * @returns the block table and directory
 * @throws {FormatError} if the blocks-info doesn't decode
 */
export const parseBundleDirectory = (
	header: BundleHeader,
	stored: Uint8Array,
	pad: Uint8Array,
): BundleDirectory => {
	if (stored.length !== header.compressedBlocksInfoSize) {
		throw new FormatError(
			`blocks-info is ${stored.length} bytes, header says ${header.compressedBlocksInfoSize}`,
		);
	}
	let info: Uint8Array;
	if (header.flags & BundleArchiveFlags.CompressionMask) {
		const copy = stored.slice();
		applyBundlePad(copy, pad);
		info = decodeLz4Block(copy, header.uncompressedBlocksInfoSize);
	} else {
		info = stored;
	}

	const r = new BinaryReader(info, { littleEndian: false });
	const blocks: BundleBlock[] = [];
	{
		const encoded = bswap32((readU32Le(r) ^ 0x8a7bf723) >>> 0);
		const lo = encoded & 0xffff;
		const hi = encoded >>> 16;
		const count = (ror32((((lo ^ hi) << 16) | lo) >>> 0, 18) ^ 0x91ce0a4f) >>> 0;
		if (count * 10 > r.remaining) {
			throw new FormatError(`implausible bundle block count ${count}`);
		}
		let compressedOffset = header.dataOffset;
		let uncompressedOffset = 0;
		for (let i = 0; i < count; i++) {
			const a = r.u16();
			const b = r.u16();
			const c = r.u16();
			const encFlags = r.u16() ^ 0x9cd6;
			const d = r.u16();
			const a0 = encFlags & 0xff;
			const a1 = encFlags >>> 8;
			const flags = c ^ rol16(((a0 ^ a1) << 8) | a0, 14) ^ 0x523f;
			const uncompressedSize = descramble32(a, c);
			const compressedSize = descramble32(b, d);
			blocks.push({ flags, compressedSize, uncompressedSize, compressedOffset, uncompressedOffset });
			compressedOffset += compressedSize;
			uncompressedOffset += uncompressedSize;
		}
	}

	const nodes: BundleNode[] = [];
	{
		const encoded = bswap32((readU32Le(r) ^ 0x5de50a6b) >>> 0);
		const lo = encoded & 0xffff;
		const hi = encoded >>> 16;
		const count = (ror32((((lo ^ hi) << 16) | lo) >>> 0, 18) ^ 0xe4c1d9f2) >>> 0;
		if (count * 21 > r.remaining) {
			throw new FormatError(`implausible bundle node count ${count}`);
		}
		for (let i = 0; i < count; i++) {
			const a = (r.u32() ^ 0x8e06a9f8) >>> 0;
			const b = r.u32();
			const c = r.u32();
			const d = r.u32();
			const path = readNodeName(r);
			const e = r.u32();

			const a0 = a & 0xffff;
			const a1 = a >>> 16;
			const flags = (ror32((((a1 ^ a0) << 16) | a0) >>> 0, 18) ^ 0xf13927c4 ^ b) >>> 0;
			const offsetHi = BigInt((d ^ c ^ 0xdad76848) >>> 0);
			const offset = rol64((offsetHi << 32n) | BigInt(c), 14n) ^ 0xa4f1a11747816520n;
			const sizeHi = BigInt((b ^ e ^ 0xdad76848) >>> 0);
			const size = rol64((sizeHi << 32n) | BigInt(e), 14n) ^ 0xa4f1a11747816520n;
			nodes.push({
				path,
				offset: toSafeNumber(offset, 'node offset'),
				size: toSafeNumber(size, 'node size'),
				flags,
			});
		}
	}

	const streamLength = blocks.reduce((sum, block) => sum + block.uncompressedSize, 0);
	for (const node of nodes) {
		if (node.offset + node.size > streamLength) {
			throw new FormatError(`bundle node ${node.path} overruns the ${streamLength}-byte data stream`);
		}
	}
	return { header, blocks, nodes };
};

const readU32Le = (r: BinaryReader): number => {
	r.littleEndian = true;
	const value = r.u32();
	r.littleEndian = false;
	return value;
};

/** node names are NUL-terminated, capped at 64 bytes, and XORed with `index ^ 0x97` */
const readNodeName = (r: BinaryReader): string => {
	let name = '';
	for (let j = 0; j < 64 && r.remaining > 0; j++) {
		const byte = r.u8();
		if (byte === 0) {
			break;
		}
		name += String.fromCharCode(byte ^ ((j ^ 0x97) & 0xff));
	}
	return name;
};

// #endregion

// #region block decoding

/**
 * decodes one stored data block, decrypting padded blocks in place
 *
 * @param block block descriptor
 * @param stored the block's `compressedSize` stored bytes; padded (type 5) blocks are decrypted in place, so
 *   pass bytes the caller owns
 * @param pad bundle cipher pad
 * @returns the block's decompressed bytes; `stored` itself for raw blocks
 * @throws {FormatError} on unsupported compression types or corrupt data
 */
export const decodeBundleBlockInPlace = (
	block: BundleBlock,
	stored: Uint8Array,
	pad: Uint8Array,
): Uint8Array => {
	if (stored.length !== block.compressedSize) {
		throw new FormatError(`block is ${stored.length} bytes, expected ${block.compressedSize}`);
	}
	switch (block.flags) {
		case 0: {
			if (block.compressedSize !== block.uncompressedSize) {
				throw new FormatError('raw block with differing stored and decompressed sizes');
			}
			return stored;
		}
		case 5: {
			applyBundlePad(stored, pad);
			return decodeInvertedLz4Block(stored, block.uncompressedSize);
		}
		default: {
			throw new FormatError(
				`unsupported bundle block type 0x${block.flags.toString(16)} (only 0 raw and 5 inverted LZ4 are known)`,
			);
		}
	}
};

/**
 * @param blocks block table
 * @param start inclusive offset in the decompressed stream
 * @param end exclusive offset in the decompressed stream
 * @returns indices `[first, last]` of the blocks overlapping the range, or `undefined` if it's empty
 */
export const findBlockSpan = (
	blocks: readonly BundleBlock[],
	start: number,
	end: number,
): [first: number, last: number] | undefined => {
	if (end <= start) {
		return undefined;
	}
	// binary search for the block containing `start`
	let lo = 0;
	let hi = blocks.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >>> 1;
		if (blocks[mid].uncompressedOffset <= start) {
			lo = mid;
		} else {
			hi = mid - 1;
		}
	}
	let last = lo;
	while (last + 1 < blocks.length && blocks[last + 1].uncompressedOffset < end) {
		last++;
	}
	const tail = blocks[last];
	if (tail === undefined || tail.uncompressedOffset + tail.uncompressedSize < end) {
		throw new FormatError(`range ${start}..${end} overruns the bundle data stream`);
	}
	return [lo, last];
};

// #endregion

// #region random-access reader

/** how many decoded blocks {@link UnityBundle} keeps around for neighbouring reads */
const BLOCK_CACHE_SIZE = 4;

/**
 * random-access reader over an Endfield bundle. only the header, blocks-info and the blocks overlapping a
 * requested range are read and decoded, so one CAB can be pulled from a large bundle cheaply.
 */
export class UnityBundle {
	readonly header: BundleHeader;
	readonly blocks: readonly BundleBlock[];
	readonly nodes: readonly BundleNode[];
	readonly #source: ByteSource;
	readonly #pad: Uint8Array;
	/** most recently used last */
	readonly #cache = new Map<number, Uint8Array>();
	/** decodes started by a read that hasn't finished, so concurrent reads share them */
	readonly #inFlight = new Map<number, Promise<Uint8Array>>();

	/**
	 * @param directory parsed directory
	 * @param source byte source of the whole bundle
	 * @param pad bundle cipher pad
	 */
	constructor(directory: BundleDirectory, source: ByteSource, pad: Uint8Array) {
		this.header = directory.header;
		this.blocks = directory.blocks;
		this.nodes = directory.nodes;
		this.#source = source;
		this.#pad = pad;
	}

	/**
	 * reads the header and directory (two small reads)
	 *
	 * @param source byte source of the whole bundle
	 * @param pad bundle cipher pad from `deriveBundlePad`
	 * @throws {FormatError} if the source isn't a decodable Endfield bundle
	 */
	static async open(source: ByteSource, pad: Uint8Array): Promise<UnityBundle> {
		if (source.size < BUNDLE_HEADER_SIZE) {
			throw new FormatError(`${source.size}-byte file is too small to be a bundle`);
		}
		const header = parseBundleHeader(await source.read(0, BUNDLE_HEADER_SIZE));
		if (header.size > source.size) {
			throw new FormatError(`bundle header declares ${header.size} bytes, file has ${source.size}`);
		}
		const stored = await source.read(
			header.blocksInfoOffset,
			header.blocksInfoOffset + header.compressedBlocksInfoSize,
		);
		return new UnityBundle(parseBundleDirectory(header, stored, pad), source, pad);
	}

	/**
	 * @param path node path or file name, e.g. `CAB-….resS`
	 * @returns the node, or `undefined` if the bundle doesn't contain it
	 */
	node(path: string): BundleNode | undefined {
		return this.nodes.find((node) => node.path === path);
	}

	/** @returns nodes flagged as SerializedFiles */
	serializedFileNodes(): BundleNode[] {
		return this.nodes.filter((node) => node.flags & BUNDLE_NODE_SERIALIZED_FILE);
	}

	/**
	 * @param node node to read
	 * @returns the node's bytes; the caller owns them
	 */
	readNode(node: BundleNode): Promise<Uint8Array> {
		return this.readNodeRange(node, 0, node.size);
	}

	/**
	 * @param node node to read from
	 * @param start inclusive offset within the node
	 * @param end exclusive offset within the node
	 * @returns the requested bytes; the caller owns them
	 * @throws {RangeError} if the range lies outside the node
	 */
	readNodeRange(node: BundleNode, start: number, end: number): Promise<Uint8Array> {
		if (start < 0 || end > node.size || start > end) {
			throw new RangeError(`range ${start}..${end} outside ${node.path} (${node.size} bytes)`);
		}
		return this.readStream(node.offset + start, node.offset + end);
	}

	/**
	 * @param start inclusive offset in the decompressed data stream
	 * @param end exclusive offset in the decompressed data stream
	 * @returns the requested bytes; the caller owns them
	 */
	async readStream(start: number, end: number): Promise<Uint8Array> {
		const out = new Uint8Array(end - start);
		const span = findBlockSpan(this.blocks, start, end);
		if (span === undefined) {
			return out;
		}
		const [first, last] = span;

		// cached blocks are taken now (concurrent reads may evict them while this one awaits), blocks another
		// read is already decoding are shared, and each run of remaining blocks is fetched in one contiguous read
		const pending: Promise<Uint8Array>[] = [];
		const fetched = new Set<number>();
		let run: number[] = [];
		const flush = (): void => {
			if (run.length > 0) {
				pending.push(...this.#fetchRun(run));
				run = [];
			}
		};
		for (let i = first; i <= last; i++) {
			const flying = this.#inFlight.get(i);
			if (this.#cache.has(i)) {
				flush();
				pending.push(Promise.resolve(this.#touch(i)));
			} else if (flying !== undefined) {
				flush();
				pending.push(flying);
			} else {
				run.push(i);
				fetched.add(i);
			}
		}
		flush();
		const decoded = await Promise.all(pending);

		for (let i = first; i <= last; i++) {
			const block = this.blocks[i];
			const bytes = decoded[i - first];
			const from = Math.max(start, block.uncompressedOffset);
			const to = Math.min(end, block.uncompressedOffset + block.uncompressedSize);
			out.set(bytes.subarray(from - block.uncompressedOffset, to - block.uncompressedOffset), from - start);
		}

		// only keep the edges: interior blocks of a long read are unlikely to be wanted again
		for (const index of new Set([first, last])) {
			if (fetched.has(index)) {
				const bytes = decoded[index - first];
				// raw blocks are views into the whole read; don't let the cache pin it
				this.#remember(index, bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice());
			}
		}
		return out;
	}

	/**
	 * reads consecutive blocks in one source read and decodes each, registering the decodes as in flight
	 *
	 * @param indices consecutive block indices
	 * @returns one promise per block, in order
	 */
	#fetchRun(indices: readonly number[]): Promise<Uint8Array>[] {
		const from = this.blocks[indices[0]];
		const to = this.blocks[indices[indices.length - 1]];
		const read = this.#source.read(from.compressedOffset, to.compressedOffset + to.compressedSize);
		return indices.map((index) => {
			const block = this.blocks[index];
			const at = block.compressedOffset - from.compressedOffset;
			const promise = read
				.then((stored) =>
					decodeBundleBlockInPlace(block, stored.subarray(at, at + block.compressedSize), this.#pad),
				)
				.finally(() => {
					this.#inFlight.delete(index);
				});
			this.#inFlight.set(index, promise);
			return promise;
		});
	}

	#touch(index: number): Uint8Array {
		const bytes = this.#cache.get(index);
		if (bytes === undefined) {
			throw new Error(`block ${index} vanished from the cache`);
		}
		this.#cache.delete(index);
		this.#cache.set(index, bytes);
		return bytes;
	}

	#remember(index: number, bytes: Uint8Array): void {
		this.#cache.set(index, bytes);
		while (this.#cache.size > BLOCK_CACHE_SIZE) {
			const oldest = this.#cache.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this.#cache.delete(oldest);
		}
	}
}

/**
 * @param bytes whole file in memory
 * @returns a {@link ByteSource} over it; reads return copies
 */
export const bytesSource = (bytes: Uint8Array): ByteSource => {
	return {
		size: bytes.length,
		read: (start, end) => Promise.resolve(bytes.slice(start, end)),
	};
};

// #endregion
