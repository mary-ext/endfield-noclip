/**
 * binary encodings of the package's hot data: tree.bin, tables/chains.bin, tables/blobs.bin, instance blocks,
 * terrain height pages and the geometry blob container (its meshopt payloads are opaque here, so this module
 * stays dependency-free). texture blobs are raw texel data with no encoding of their own. all little-endian;
 * every section starts 4-byte aligned so decoders can take typed-array views when the input buffer is
 * aligned. compression (the blob codec) is applied outside these functions.
 *
 * @module
 */

import { PackageFormatError } from './errors.ts';
import {
	BlobCodec,
	BlobKind,
	type BlobRecord,
	type Chain,
	type ChainDraw,
	ContentKind,
	type ContentRef,
	DrawRole,
	type GeometryBlob,
	type GeometryStream,
	type GeometrySubmesh,
	GeometryVertexFormat,
	type InstanceBlock,
	type IrradianceTable,
	PACKAGE_VERSION,
	type Tree,
	type TreeNode,
} from './format.ts';

// #region magics and sizes

const MAGIC_TREE = 0x52_54_46_45; // 'EFTR'
const MAGIC_CHAINS = 0x48_43_46_45; // 'EFCH'
const MAGIC_BLOBS = 0x58_42_46_45; // 'EFBX'
const MAGIC_INSTANCES = 0x4e_49_46_45; // 'EFIN'
const MAGIC_HEIGHTS = 0x54_48_46_45; // 'EFHT'
const MAGIC_GEOMETRY = 0x4d_47_46_45; // 'EFGM'
const MAGIC_IRRADIANCE = 0x56_49_46_45; // 'EFIV'

const TABLE_HEADER_SIZE = 16;
const NODE_SIZE = 48;
const REF_SIZE = 24;
const CHAIN_SIZE = 8;
const DRAW_SIZE = 24;
const BLOB_SIZE = 32;
const INSTANCE_HEADER_SIZE = 32;
/** bytes per instance row across all sections, before padding the layer section */
const INSTANCE_ROW_SIZE = 4 + 48 + 24 + 4 + 1;
const HEIGHTS_HEADER_SIZE = 8;
const GEOMETRY_HEADER_SIZE = 32;
const GEOMETRY_STREAM_SIZE = 32;
const GEOMETRY_SUBMESH_SIZE = 40;

// #endregion

// #region helpers

const align4 = (n: number): number => (n + 3) & ~3;

const viewOf = (data: Uint8Array): DataView => new DataView(data.buffer, data.byteOffset, data.byteLength);

/** what every encoding's header starts with: `u32 magic ‖ u16 version` */
interface HeaderShape {
	magic: number;
	/** the header's full size, which the data must at least have */
	size: number;
	/** for error messages */
	label: string;
}

/** checks a header's size, magic and version */
const checkHeader = (view: DataView, header: HeaderShape): void => {
	if (view.byteLength < header.size || view.getUint32(0, true) !== header.magic) {
		throw new PackageFormatError(`not a ${header.label}`);
	}
	const version = view.getUint16(4, true);
	if (version !== PACKAGE_VERSION) {
		throw new PackageFormatError(`${header.label} version ${version} isn't ${PACKAGE_VERSION}`);
	}
};

/** @returns a type guard for the values of a `const` enum object */
const enumGuard = <T extends number>(
	values: Readonly<Record<string, T>>,
): ((value: number) => value is T) => {
	const known: ReadonlySet<number> = new Set(Object.values(values));
	return (value): value is T => known.has(value);
};

const isContentKind = enumGuard(ContentKind);
const isDrawRole = enumGuard(DrawRole);
const isBlobCodec = enumGuard(BlobCodec);
const isBlobKind = enumGuard(BlobKind);
const isGeometryVertexFormat = enumGuard(GeometryVertexFormat);

/** @throws {PackageFormatError} unless `value` passes `guard` */
const checkedEnum = <T extends number>(
	guard: (value: number) => value is T,
	value: number,
	label: string,
): T => {
	if (!guard(value)) {
		throw new PackageFormatError(`unknown ${label} ${value}`);
	}
	return value;
};

const checkLength = (data: Uint8Array, expected: number, label: string): void => {
	if (data.byteLength !== expected) {
		throw new PackageFormatError(`${label} is ${data.byteLength} bytes, expected ${expected}`);
	}
};

/** copies `count` elements of a section into a fresh, aligned typed array */
const f32Section = (data: Uint8Array, at: number, count: number): Float32Array => {
	return new Float32Array(data.slice(at, at + count * 4).buffer);
};

const u32Section = (data: Uint8Array, at: number, count: number): Uint32Array => {
	return new Uint32Array(data.slice(at, at + count * 4).buffer);
};

const hexOf = (bytes: Uint8Array): string => {
	let out = '';
	for (const byte of bytes) {
		out += byte.toString(16).padStart(2, '0');
	}
	return out;
};

const bytesOfHex = (hex: string): Uint8Array => {
	if (!/^[0-9a-f]{32}$/.test(hex)) {
		throw new PackageFormatError(`blob hash ${hex} isn't 32 lowercase hex digits`);
	}
	const out = new Uint8Array(16);
	for (let i = 0; i < 16; i++) {
		out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
};

// #endregion

// #region tree

/**
 * tree.bin: 16-byte header (`'EFTR'`, u16 version, u16 0, u32 nodeCount, u32 refCount), then 48-byte nodes,
 * then 24-byte content refs.
 *
 * node: u8 level, u8 childMask, u16 flags, i32 x, i32 z, f32×3 min, f32×3 max, f32 geometricError, u32
 * refFirst, u32 refCount. ref: u8 kind, u8 tier, u16 0, u32 level, u32 blob, u32 first, u32 count, f32
 * param.
 *
 * @param tree nodes and refs; node ref slices must lie inside `refs`
 * @returns the encoded file
 */
export const encodeTree = (tree: Tree): Uint8Array => {
	const out = new Uint8Array(TABLE_HEADER_SIZE + tree.nodes.length * NODE_SIZE + tree.refs.length * REF_SIZE);
	const view = viewOf(out);
	view.setUint32(0, MAGIC_TREE, true);
	view.setUint16(4, PACKAGE_VERSION, true);
	view.setUint32(8, tree.nodes.length, true);
	view.setUint32(12, tree.refs.length, true);

	let at = TABLE_HEADER_SIZE;
	for (const node of tree.nodes) {
		if (node.refFirst + node.refCount > tree.refs.length) {
			throw new RangeError(`node ${node.level}/${node.x}/${node.z} refs run past the ref table`);
		}
		view.setUint8(at, node.level);
		view.setUint8(at + 1, node.childMask);
		view.setUint16(at + 2, node.flags, true);
		view.setInt32(at + 4, node.x, true);
		view.setInt32(at + 8, node.z, true);
		for (let i = 0; i < 3; i++) {
			view.setFloat32(at + 12 + i * 4, node.bounds.min[i], true);
			view.setFloat32(at + 24 + i * 4, node.bounds.max[i], true);
		}
		view.setFloat32(at + 36, node.geometricError, true);
		view.setUint32(at + 40, node.refFirst, true);
		view.setUint32(at + 44, node.refCount, true);
		at += NODE_SIZE;
	}
	for (const ref of tree.refs) {
		writeRef(view, at, ref);
		at += REF_SIZE;
	}
	return out;
};

const writeRef = (view: DataView, at: number, ref: ContentRef): void => {
	view.setUint8(at, ref.kind);
	view.setUint8(at + 1, ref.tier);
	view.setUint16(at + 2, 0, true);
	view.setUint32(at + 4, ref.level, true);
	view.setUint32(at + 8, ref.blob, true);
	view.setUint32(at + 12, ref.first, true);
	view.setUint32(at + 16, ref.count, true);
	view.setFloat32(at + 20, ref.param, true);
};

/**
 * @param data tree.bin
 * @returns its nodes and refs
 * @throws {PackageFormatError} on a bad header or length
 */
export const decodeTree = (data: Uint8Array): Tree => {
	const view = viewOf(data);
	checkHeader(view, { magic: MAGIC_TREE, size: TABLE_HEADER_SIZE, label: 'package tree' });
	const nodeCount = view.getUint32(8, true);
	const refCount = view.getUint32(12, true);
	checkLength(data, TABLE_HEADER_SIZE + nodeCount * NODE_SIZE + refCount * REF_SIZE, 'package tree');

	const nodes: TreeNode[] = [];
	let at = TABLE_HEADER_SIZE;
	for (let i = 0; i < nodeCount; i++) {
		const f = (offset: number): number => view.getFloat32(at + offset, true);
		nodes.push({
			level: view.getUint8(at),
			x: view.getInt32(at + 4, true),
			z: view.getInt32(at + 8, true),
			childMask: view.getUint8(at + 1),
			flags: view.getUint16(at + 2, true),
			bounds: { min: [f(12), f(16), f(20)], max: [f(24), f(28), f(32)] },
			geometricError: f(36),
			refFirst: view.getUint32(at + 40, true),
			refCount: view.getUint32(at + 44, true),
		});
		at += NODE_SIZE;
	}
	const refs: ContentRef[] = [];
	for (let i = 0; i < refCount; i++) {
		refs.push({
			kind: checkedEnum(isContentKind, view.getUint8(at), 'content kind'),
			tier: view.getUint8(at + 1),
			level: view.getUint32(at + 4, true),
			blob: view.getUint32(at + 8, true),
			first: view.getUint32(at + 12, true),
			count: view.getUint32(at + 16, true),
			param: view.getFloat32(at + 20, true),
		});
		at += REF_SIZE;
	}
	return { nodes, refs };
};

// #endregion

// #region chains

/**
 * tables/chains.bin: 16-byte header (`'EFCH'`, u16 version, u16 0, u32 chainCount, u32 drawCount), 8-byte
 * chains (u32 firstDraw, u16 drawCount, u8 lodCount, u8 flags), then 24-byte draws (u32 geometry, u32
 * material, u16 submesh, u8 lod, u8 role, f32 minSquared, f32 maxSquared, u32 sourceFlags).
 *
 * @param chains chain templates in id order
 * @returns the encoded table
 */
export const encodeChains = (chains: readonly Chain[]): Uint8Array => {
	const drawCount = chains.reduce((sum, chain) => sum + chain.draws.length, 0);
	const out = new Uint8Array(TABLE_HEADER_SIZE + chains.length * CHAIN_SIZE + drawCount * DRAW_SIZE);
	const view = viewOf(out);
	view.setUint32(0, MAGIC_CHAINS, true);
	view.setUint16(4, PACKAGE_VERSION, true);
	view.setUint32(8, chains.length, true);
	view.setUint32(12, drawCount, true);

	let chainAt = TABLE_HEADER_SIZE;
	let drawAt = TABLE_HEADER_SIZE + chains.length * CHAIN_SIZE;
	let firstDraw = 0;
	for (const chain of chains) {
		if (chain.draws.length > 0xff_ff) {
			throw new RangeError(`chain has ${chain.draws.length} draws, more than a u16 counts`);
		}
		view.setUint32(chainAt, firstDraw, true);
		view.setUint16(chainAt + 4, chain.draws.length, true);
		view.setUint8(chainAt + 6, chain.lodCount);
		view.setUint8(chainAt + 7, chain.flags);
		chainAt += CHAIN_SIZE;
		for (const draw of chain.draws) {
			view.setUint32(drawAt, draw.geometry, true);
			view.setUint32(drawAt + 4, draw.material, true);
			view.setUint16(drawAt + 8, draw.submesh, true);
			view.setUint8(drawAt + 10, draw.lod);
			view.setUint8(drawAt + 11, draw.role);
			view.setFloat32(drawAt + 12, draw.minSquared, true);
			view.setFloat32(drawAt + 16, draw.maxSquared, true);
			view.setUint32(drawAt + 20, draw.sourceFlags, true);
			drawAt += DRAW_SIZE;
		}
		firstDraw += chain.draws.length;
	}
	return out;
};

/**
 * @param data tables/chains.bin
 * @returns the chain templates
 * @throws {PackageFormatError} on a bad header, length or draw range
 */
export const decodeChains = (data: Uint8Array): Chain[] => {
	const view = viewOf(data);
	checkHeader(view, { magic: MAGIC_CHAINS, size: TABLE_HEADER_SIZE, label: 'chain table' });
	const chainCount = view.getUint32(8, true);
	const drawCount = view.getUint32(12, true);
	checkLength(data, TABLE_HEADER_SIZE + chainCount * CHAIN_SIZE + drawCount * DRAW_SIZE, 'chain table');

	const drawsAt = TABLE_HEADER_SIZE + chainCount * CHAIN_SIZE;
	const chains: Chain[] = [];
	for (let c = 0; c < chainCount; c++) {
		const at = TABLE_HEADER_SIZE + c * CHAIN_SIZE;
		const first = view.getUint32(at, true);
		const count = view.getUint16(at + 4, true);
		if (first + count > drawCount) {
			throw new PackageFormatError(`chain ${c} draws run past the draw table`);
		}
		const draws: ChainDraw[] = [];
		for (let d = first; d < first + count; d++) {
			const drawAt = drawsAt + d * DRAW_SIZE;
			draws.push({
				geometry: view.getUint32(drawAt, true),
				material: view.getUint32(drawAt + 4, true),
				submesh: view.getUint16(drawAt + 8, true),
				lod: view.getUint8(drawAt + 10),
				role: checkedEnum(isDrawRole, view.getUint8(drawAt + 11), 'draw role'),
				minSquared: view.getFloat32(drawAt + 12, true),
				maxSquared: view.getFloat32(drawAt + 16, true),
				sourceFlags: view.getUint32(drawAt + 20, true),
			});
		}
		chains.push({ lodCount: view.getUint8(at + 6), flags: view.getUint8(at + 7), draws });
	}
	return chains;
};

// #endregion

// #region blob table

/**
 * tables/blobs.bin: 16-byte header (`'EFBX'`, u16 version, u16 0, u32 blobCount, u32 0), then 32-byte
 * records: 16-byte hash, u16 archive, u8 codec, u8 kind, u32 offset, u32 length, u32 rawLength.
 *
 * @param blobs records in index order
 * @returns the encoded table
 * @throws {RangeError} if an offset or length exceeds 32 bits
 */
export const encodeBlobTable = (blobs: readonly BlobRecord[]): Uint8Array => {
	const out = new Uint8Array(TABLE_HEADER_SIZE + blobs.length * BLOB_SIZE);
	const view = viewOf(out);
	view.setUint32(0, MAGIC_BLOBS, true);
	view.setUint16(4, PACKAGE_VERSION, true);
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
	checkHeader(view, { magic: MAGIC_BLOBS, size: TABLE_HEADER_SIZE, label: 'blob table' });
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

// #endregion

// #region irradiance

/**
 * tables/irradiance.bin: 16-byte header (`'EFIV'`, u16 version, u16 0, u32 cellCount, u32 0), then the cell
 * keys (u32 each, ascending), then their blob indices (u32 each).
 *
 * @param table the cells
 * @returns the encoded table
 * @throws {RangeError} if the two lists differ in length or the keys aren't ascending
 */
export const encodeIrradianceTable = (table: IrradianceTable): Uint8Array => {
	const count = table.keys.length;
	if (table.blobs.length !== count) {
		throw new RangeError('irradiance table: keys and blobs differ in length');
	}
	for (let i = 1; i < count; i++) {
		if (table.keys[i] <= table.keys[i - 1]) {
			throw new RangeError('irradiance table: keys must be ascending');
		}
	}
	const out = new Uint8Array(TABLE_HEADER_SIZE + count * 8);
	const view = viewOf(out);
	view.setUint32(0, MAGIC_IRRADIANCE, true);
	view.setUint16(4, PACKAGE_VERSION, true);
	view.setUint32(8, count, true);
	for (let i = 0; i < count; i++) {
		view.setUint32(TABLE_HEADER_SIZE + i * 4, table.keys[i], true);
		view.setUint32(TABLE_HEADER_SIZE + (count + i) * 4, table.blobs[i], true);
	}
	return out;
};

/**
 * @param data tables/irradiance.bin
 * @returns the cells
 * @throws {PackageFormatError} on a bad header or length
 */
export const decodeIrradianceTable = (data: Uint8Array): IrradianceTable => {
	const view = viewOf(data);
	checkHeader(view, { magic: MAGIC_IRRADIANCE, size: TABLE_HEADER_SIZE, label: 'irradiance table' });
	const count = view.getUint32(8, true);
	checkLength(data, TABLE_HEADER_SIZE + count * 8, 'irradiance table');
	const keys = new Uint32Array(count);
	const blobs = new Uint32Array(count);
	for (let i = 0; i < count; i++) {
		keys[i] = view.getUint32(TABLE_HEADER_SIZE + i * 4, true);
		blobs[i] = view.getUint32(TABLE_HEADER_SIZE + (count + i) * 4, true);
	}
	return { keys, blobs };
};

// #endregion

// #region instance blocks

/**
 * instance block: 32-byte header (`'EFIN'`, u16 version, u16 flags, u32 count, f32×3 origin, u32×2 0), then
 * sections of `count` elements each: u32 chain, f32×12 transform, f32×6 bounds, u32 entity id, u8 scene state
 * (padded to 4 bytes).
 *
 * @param block rows
 * @returns the encoded block
 * @throws {RangeError} if the sections disagree in length
 */
export const encodeInstanceBlock = (block: InstanceBlock): Uint8Array => {
	const count = block.chains.length;
	if (
		block.transforms.length !== count * 12 ||
		block.bounds.length !== count * 6 ||
		block.entityIds.length !== count ||
		block.sceneStates.length !== count
	) {
		throw new RangeError('instance block sections differ in length');
	}
	const out = new Uint8Array(instanceBlockSize(count));
	const view = viewOf(out);
	view.setUint32(0, MAGIC_INSTANCES, true);
	view.setUint16(4, PACKAGE_VERSION, true);
	view.setUint16(6, block.flags, true);
	view.setUint32(8, count, true);
	for (let i = 0; i < 3; i++) {
		view.setFloat32(12 + i * 4, block.origin[i], true);
	}
	let at = INSTANCE_HEADER_SIZE;
	for (const section of [block.chains, block.transforms, block.bounds, block.entityIds, block.sceneStates]) {
		out.set(new Uint8Array(section.buffer, section.byteOffset, section.byteLength), at);
		at += align4(section.byteLength);
	}
	return out;
};

const instanceBlockSize = (count: number): number => {
	return INSTANCE_HEADER_SIZE + count * (INSTANCE_ROW_SIZE - 1) + align4(count);
};

/**
 * @param data an instance block
 * @returns its rows, copied into aligned arrays
 * @throws {PackageFormatError} on a bad header or length
 */
export const decodeInstanceBlock = (data: Uint8Array): InstanceBlock => {
	const view = viewOf(data);
	checkHeader(view, { magic: MAGIC_INSTANCES, size: INSTANCE_HEADER_SIZE, label: 'instance block' });
	const count = view.getUint32(8, true);
	checkLength(data, instanceBlockSize(count), 'instance block');

	let at = INSTANCE_HEADER_SIZE;
	const chains = u32Section(data, at, count);
	at += count * 4;
	const transforms = f32Section(data, at, count * 12);
	at += count * 48;
	const bounds = f32Section(data, at, count * 6);
	at += count * 24;
	const entityIds = u32Section(data, at, count);
	at += count * 4;
	const sceneStates = data.slice(at, at + count);
	return {
		flags: view.getUint16(6, true),
		origin: [view.getFloat32(12, true), view.getFloat32(16, true), view.getFloat32(20, true)],
		chains,
		transforms,
		bounds,
		entityIds,
		sceneStates,
	};
};

// #endregion

// #region height pages

/**
 * height page: 8-byte header (`'EFHT'`, u16 version, u16 side), then the raw samples as two byte planes (all
 * low bytes, then all high bytes) of zigzag-encoded deltas. interior samples are predicted by the gradient
 * `left + above - aboveLeft`, the first row by the left neighbour, the first column by the sample above, the
 * first sample by 0. arithmetic wraps at 16 bits, so the hole bit survives. on map02's leaves with zstd-19
 * this is 2.15 KB per 65² page, against 2.36 KB for left-only prediction and 3.6 KB for raw samples.
 *
 * @param samples `side²` raw samples, rows along +Z
 * @param side samples per edge
 * @returns the encoded page
 * @throws {RangeError} if `samples` isn't `side²` long
 */
export const encodeHeightPage = (samples: Uint16Array, side: number): Uint8Array => {
	const count = side * side;
	if (samples.length !== count) {
		throw new RangeError(`height page needs ${count} samples, got ${samples.length}`);
	}
	const out = new Uint8Array(HEIGHTS_HEADER_SIZE + count * 2);
	const view = viewOf(out);
	view.setUint32(0, MAGIC_HEIGHTS, true);
	view.setUint16(4, PACKAGE_VERSION, true);
	view.setUint16(6, side, true);
	for (let i = 0; i < count; i++) {
		const delta = (samples[i] - predictHeight(samples, i, side)) & 0xff_ff;
		// zigzag over the 16-bit two's complement delta
		const signed = delta >= 0x80_00 ? delta - 0x1_00_00 : delta;
		const zigzag = signed >= 0 ? signed * 2 : -signed * 2 - 1;
		out[HEIGHTS_HEADER_SIZE + i] = zigzag & 0xff;
		out[HEIGHTS_HEADER_SIZE + count + i] = zigzag >> 8;
	}
	return out;
};

const predictHeight = (samples: Uint16Array, i: number, side: number): number => {
	const first = i % side === 0;
	if (i < side) {
		return first ? 0 : samples[i - 1];
	}
	if (first) {
		return samples[i - side];
	}
	return (samples[i - 1] + samples[i - side] - samples[i - side - 1]) & 0xff_ff;
};

/**
 * @param data an encoded height page
 * @returns its side and raw samples
 * @throws {PackageFormatError} on a bad header or length
 */
export const decodeHeightPage = (data: Uint8Array): { side: number; samples: Uint16Array } => {
	const view = viewOf(data);
	checkHeader(view, { magic: MAGIC_HEIGHTS, size: HEIGHTS_HEADER_SIZE, label: 'height page' });
	const side = view.getUint16(6, true);
	const count = side * side;
	checkLength(data, HEIGHTS_HEADER_SIZE + count * 2, 'height page');
	const samples = new Uint16Array(count);
	for (let i = 0; i < count; i++) {
		const zigzag = data[HEIGHTS_HEADER_SIZE + i] | (data[HEIGHTS_HEADER_SIZE + count + i] << 8);
		const signed = zigzag & 1 ? -((zigzag + 1) >> 1) : zigzag >> 1;
		samples[i] = (predictHeight(samples, i, side) + signed) & 0xff_ff;
	}
	return { side, samples };
};

// #endregion

// #region geometry

/**
 * geometry blob: 32-byte header (`'EFGM'`, u16 version, u16 flags, u32 vertexCount, u32 indexCount, u16
 * streamCount, u16 submeshCount, u32 index payload length, u32×2 0), 32-byte stream records (u8 attribute, u8
 * format, u8 flags, u8 0, u32 payload length, f32×3 offset, f32×3 scale), 40-byte submesh records (u32
 * firstIndex, u32 indexCount, u32 baseVertex, u32 vertexCount, f32×3 min, f32×3 max), then the stream
 * payloads in record order and the index payload, each starting 4-byte aligned.
 *
 * @param blob the container; payloads are stored as given
 * @returns the encoded blob
 * @throws {RangeError} on more than 65,535 streams or submeshes
 */
export const encodeGeometryBlob = (blob: GeometryBlob): Uint8Array => {
	if (blob.streams.length > 0xff_ff || blob.submeshes.length > 0xff_ff) {
		throw new RangeError('geometry has more than 65,535 streams or submeshes');
	}
	const tables =
		GEOMETRY_HEADER_SIZE +
		blob.streams.length * GEOMETRY_STREAM_SIZE +
		blob.submeshes.length * GEOMETRY_SUBMESH_SIZE;
	const size =
		blob.streams.reduce((sum, stream) => sum + align4(stream.data.byteLength), tables) +
		align4(blob.indices.byteLength);
	const out = new Uint8Array(size);
	const view = viewOf(out);
	view.setUint32(0, MAGIC_GEOMETRY, true);
	view.setUint16(4, PACKAGE_VERSION, true);
	view.setUint16(6, blob.flags, true);
	view.setUint32(8, blob.vertexCount, true);
	view.setUint32(12, blob.indexCount, true);
	view.setUint16(16, blob.streams.length, true);
	view.setUint16(18, blob.submeshes.length, true);
	view.setUint32(20, blob.indices.byteLength, true);

	let at = GEOMETRY_HEADER_SIZE;
	for (const stream of blob.streams) {
		view.setUint8(at, stream.attribute);
		view.setUint8(at + 1, stream.format);
		view.setUint8(at + 2, stream.flags);
		view.setUint32(at + 4, stream.data.byteLength, true);
		for (let i = 0; i < 3; i++) {
			view.setFloat32(at + 8 + i * 4, stream.offset[i], true);
			view.setFloat32(at + 20 + i * 4, stream.scale[i], true);
		}
		at += GEOMETRY_STREAM_SIZE;
	}
	for (const submesh of blob.submeshes) {
		view.setUint32(at, submesh.firstIndex, true);
		view.setUint32(at + 4, submesh.indexCount, true);
		view.setUint32(at + 8, submesh.baseVertex, true);
		view.setUint32(at + 12, submesh.vertexCount, true);
		for (let i = 0; i < 3; i++) {
			view.setFloat32(at + 16 + i * 4, submesh.bounds.min[i], true);
			view.setFloat32(at + 28 + i * 4, submesh.bounds.max[i], true);
		}
		at += GEOMETRY_SUBMESH_SIZE;
	}
	for (const stream of blob.streams) {
		out.set(stream.data, at);
		at += align4(stream.data.byteLength);
	}
	out.set(blob.indices, at);
	return out;
};

/**
 * @param data a geometry blob
 * @returns its container; payloads are views into `data`
 * @throws {PackageFormatError} on a bad header, an unknown vertex format or a length mismatch
 */
export const decodeGeometryBlob = (data: Uint8Array): GeometryBlob => {
	const view = viewOf(data);
	checkHeader(view, { magic: MAGIC_GEOMETRY, size: GEOMETRY_HEADER_SIZE, label: 'geometry blob' });
	const streamCount = view.getUint16(16, true);
	const submeshCount = view.getUint16(18, true);
	const indexLength = view.getUint32(20, true);
	let at = GEOMETRY_HEADER_SIZE;
	let payloadAt =
		GEOMETRY_HEADER_SIZE + streamCount * GEOMETRY_STREAM_SIZE + submeshCount * GEOMETRY_SUBMESH_SIZE;
	if (payloadAt > data.byteLength) {
		throw new PackageFormatError('geometry blob tables run past its end');
	}

	const streams: GeometryStream[] = [];
	for (let s = 0; s < streamCount; s++) {
		const format = view.getUint8(at + 1);
		if (!isGeometryVertexFormat(format)) {
			throw new PackageFormatError(`geometry stream ${s} has unknown vertex format ${format}`);
		}
		const length = view.getUint32(at + 4, true);
		if (payloadAt + length > data.byteLength) {
			throw new PackageFormatError(`geometry stream ${s} runs past the blob`);
		}
		const f = (offset: number): number => view.getFloat32(at + offset, true);
		streams.push({
			attribute: view.getUint8(at),
			format,
			flags: view.getUint8(at + 2),
			offset: [f(8), f(12), f(16)],
			scale: [f(20), f(24), f(28)],
			data: data.subarray(payloadAt, payloadAt + length),
		});
		payloadAt += align4(length);
		at += GEOMETRY_STREAM_SIZE;
	}
	const submeshes: GeometrySubmesh[] = [];
	for (let s = 0; s < submeshCount; s++) {
		const f = (offset: number): number => view.getFloat32(at + offset, true);
		submeshes.push({
			firstIndex: view.getUint32(at, true),
			indexCount: view.getUint32(at + 4, true),
			baseVertex: view.getUint32(at + 8, true),
			vertexCount: view.getUint32(at + 12, true),
			bounds: { min: [f(16), f(20), f(24)], max: [f(28), f(32), f(36)] },
		});
		at += GEOMETRY_SUBMESH_SIZE;
	}
	checkLength(data, payloadAt + align4(indexLength), 'geometry blob');
	return {
		flags: view.getUint16(6, true),
		vertexCount: view.getUint32(8, true),
		indexCount: view.getUint32(12, true),
		streams,
		submeshes,
		indices: data.subarray(payloadAt, payloadAt + indexLength),
	};
};

// #endregion
