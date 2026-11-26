/**
 * compact foliage cluster block (`.fol`, `EFFL` TLV container, {@link BlobKind.Foliage}): keeps dense
 * grass/bush/tree grids out of `.inst` by quantizing per-instance transforms inside each cluster AABB (24 B
 * per instance vs 72 B+ in `.inst`)
 *
 * @module
 */

import { viewOf } from './binary.ts';
import {
	checkStride,
	decodeContainer,
	encodeContainer,
	fourcc,
	requireSection,
	type ContainerSectionInput,
} from './container.ts';
import { PackageFormatError } from './errors.ts';
import type { Vec3 } from './values.ts';

/** one foliage cluster sharing a single chain and AABB */
export interface FoliageCluster {
	/** local index into {@link FoliageBlock.palette} (or global chain id once resolved) */
	chain: number;
	firstInstance: number;
	instanceCount: number;
	/** cluster AABB centre relative to {@link FoliageBlock.origin} */
	center: Vec3;
	/** cluster AABB half-extents */
	halfExtents: Vec3;
	/** half-size of the foliage renderer for screen-size/sparsity culling */
	rendererHalfSize: number;
	/** optional grass density multiplier (`GrassRendererInfo.sparsity`); defaults to 1 when omitted */
	sparsity?: number;
}

/**
 * packed foliage instances (24 bytes each):
 *
 * - `posQ`: `u16×3` (`unorm16` within cluster `[center - halfExtents, center + halfExtents]`)
 * - `rotQ`: `u16×3` (smallest-three unit quaternion: 15-bit components in low bits; high bits carry the 2-bit
 *   largest-component index and 1-bit mirrored-handedness flag)
 * - `scaleH`: `f16×3` (non-uniform 3D scale, non-negative; handedness lives in `rotQ`)
 * - `param0`: `u8×4` (`unorm8x4` shader custom param 0)
 * - `reserved`: `u16` (0)
 */
export interface FoliageBlock {
	origin: Vec3;
	/** optional per-block canonical chain hash palette (`PLTT`) */
	palette?: BigUint64Array;
	clusters: FoliageCluster[];
	/** `instanceCount × 24` raw instance bytes */
	instances: Uint8Array;
}

/** byte size of one packed foliage instance record */
export const FOLIAGE_INSTANCE_BYTES = 24;

const SQRT2 = Math.SQRT2;
const Q15_MAX = 32_767;
const U16_MAX = 65_535;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * packs one column-major 4×4 object-to-world matrix into a 24-byte foliage instance record
 *
 * @param out destination byte buffer (at least `offset + 24` bytes)
 * @param offset byte offset within `out`
 * @param matrix 16-float column-major object-to-world matrix
 * @param origin block world origin subtracted from translation
 * @param center cluster AABB centre relative to `origin`
 * @param halfExtents cluster AABB half-extents
 */
export const packFoliageInstance = (
	out: Uint8Array,
	offset: number,
	matrix: ArrayLike<number>,
	origin: Vec3,
	center: Vec3,
	halfExtents: Vec3,
): void => {
	const view = viewOf(out);
	const tx = matrix[12] - origin[0];
	const ty = matrix[13] - origin[1];
	const tz = matrix[14] - origin[2];
	const px =
		halfExtents[0] > 0
			? clamp(Math.round((((tx - center[0]) / halfExtents[0]) * 0.5 + 0.5) * U16_MAX), 0, U16_MAX)
			: 32_768;
	const py =
		halfExtents[1] > 0
			? clamp(Math.round((((ty - center[1]) / halfExtents[1]) * 0.5 + 0.5) * U16_MAX), 0, U16_MAX)
			: 32_768;
	const pz =
		halfExtents[2] > 0
			? clamp(Math.round((((tz - center[2]) / halfExtents[2]) * 0.5 + 0.5) * U16_MAX), 0, U16_MAX)
			: 32_768;
	view.setUint16(offset, px, true);
	view.setUint16(offset + 2, py, true);
	view.setUint16(offset + 4, pz, true);

	let c0x = matrix[0];
	let c0y = matrix[1];
	let c0z = matrix[2];
	const c1x = matrix[4];
	const c1y = matrix[5];
	const c1z = matrix[6];
	const c2x = matrix[8];
	const c2y = matrix[9];
	const c2z = matrix[10];

	const sx = Math.hypot(c0x, c0y, c0z);
	const sy = Math.hypot(c1x, c1y, c1z);
	const sz = Math.hypot(c2x, c2y, c2z);
	const det = (c0y * c1z - c0z * c1y) * c2x + (c0z * c1x - c0x * c1z) * c2y + (c0x * c1y - c0y * c1x) * c2z;
	const mirrored = det < 0 ? 1 : 0;
	if (mirrored !== 0) {
		c0x = -c0x;
		c0y = -c0y;
		c0z = -c0z;
	}

	const r00 = sx > 1e-8 ? c0x / sx : 1;
	const r10 = sx > 1e-8 ? c0y / sx : 0;
	const r20 = sx > 1e-8 ? c0z / sx : 0;
	const r01 = sy > 1e-8 ? c1x / sy : 0;
	const r11 = sy > 1e-8 ? c1y / sy : 1;
	const r21 = sy > 1e-8 ? c1z / sy : 0;
	const r02 = sz > 1e-8 ? c2x / sz : 0;
	const r12 = sz > 1e-8 ? c2y / sz : 0;
	const r22 = sz > 1e-8 ? c2z / sz : 1;

	let qx: number;
	let qy: number;
	let qz: number;
	let qw: number;
	const trace = r00 + r11 + r22;
	if (trace > 0) {
		const s = Math.sqrt(trace + 1) * 2;
		qw = 0.25 * s;
		qx = (r21 - r12) / s;
		qy = (r02 - r20) / s;
		qz = (r10 - r01) / s;
	} else if (r00 > r11 && r00 > r22) {
		const s = Math.sqrt(Math.max(0, 1 + r00 - r11 - r22)) * 2;
		qw = (r21 - r12) / s;
		qx = 0.25 * s;
		qy = (r01 + r10) / s;
		qz = (r02 + r20) / s;
	} else if (r11 > r22) {
		const s = Math.sqrt(Math.max(0, 1 + r11 - r00 - r22)) * 2;
		qw = (r02 - r20) / s;
		qx = (r01 + r10) / s;
		qy = 0.25 * s;
		qz = (r12 + r21) / s;
	} else {
		const s = Math.sqrt(Math.max(0, 1 + r22 - r00 - r11)) * 2;
		qw = (r10 - r01) / s;
		qx = (r02 + r20) / s;
		qy = (r12 + r21) / s;
		qz = 0.25 * s;
	}
	const qLen = Math.hypot(qx, qy, qz, qw);
	if (qLen > 0) {
		qx /= qLen;
		qy /= qLen;
		qz /= qLen;
		qw /= qLen;
	} else {
		qx = 0;
		qy = 0;
		qz = 0;
		qw = 1;
	}

	const ax = Math.abs(qx);
	const ay = Math.abs(qy);
	const az = Math.abs(qz);
	const aw = Math.abs(qw);
	let largest = 3;
	let maxAbs = aw;
	if (ax > maxAbs) {
		largest = 0;
		maxAbs = ax;
	}
	if (ay > maxAbs) {
		largest = 1;
		maxAbs = ay;
	}
	if (az > maxAbs) {
		largest = 2;
	}

	let a: number;
	let b: number;
	let c: number;
	let sign: number;
	switch (largest) {
		case 0: {
			sign = qx < 0 ? -1 : 1;
			a = qy * sign;
			b = qz * sign;
			c = qw * sign;
			break;
		}
		case 1: {
			sign = qy < 0 ? -1 : 1;
			a = qx * sign;
			b = qz * sign;
			c = qw * sign;
			break;
		}
		case 2: {
			sign = qz < 0 ? -1 : 1;
			a = qx * sign;
			b = qy * sign;
			c = qw * sign;
			break;
		}
		default: {
			sign = qw < 0 ? -1 : 1;
			a = qx * sign;
			b = qy * sign;
			c = qz * sign;
			break;
		}
	}
	const q15 = (v: number): number => clamp(Math.round((v * SQRT2 * 0.5 + 0.5) * Q15_MAX), 0, Q15_MAX);
	view.setUint16(offset + 6, q15(a) | ((largest & 1) << 15), true);
	view.setUint16(offset + 8, q15(b) | (((largest >> 1) & 1) << 15), true);
	view.setUint16(offset + 10, q15(c) | (mirrored << 15), true);

	view.setFloat16(offset + 12, sx, true);
	view.setFloat16(offset + 14, sy, true);
	view.setFloat16(offset + 16, sz, true);
	view.setUint32(offset + 18, 0, true);
	view.setUint16(offset + 22, 0, true);
};

/**
 * unpacks a 24-byte foliage instance record into a 12-float row-major 3×4 transform relative to the block
 * origin
 *
 * @param data packed instances buffer
 * @param offset byte offset of the record within `data`
 * @param center cluster AABB centre relative to the block origin
 * @param halfExtents cluster AABB half-extents
 * @param out destination float array
 * @param outOffset float index in `out` where the 12-float row-major 3×4 transform is written
 * @returns whether the transform is mirrored (negative 3×3 determinant)
 */
export const unpackFoliageInstance = (
	data: Uint8Array,
	offset: number,
	center: Vec3,
	halfExtents: Vec3,
	out: Float32Array,
	outOffset: number,
): boolean => {
	const view = viewOf(data);
	const tx = center[0] + ((view.getUint16(offset, true) / U16_MAX) * 2 - 1) * halfExtents[0];
	const ty = center[1] + ((view.getUint16(offset + 2, true) / U16_MAX) * 2 - 1) * halfExtents[1];
	const tz = center[2] + ((view.getUint16(offset + 4, true) / U16_MAX) * 2 - 1) * halfExtents[2];

	const u0 = view.getUint16(offset + 6, true);
	const u1 = view.getUint16(offset + 8, true);
	const u2 = view.getUint16(offset + 10, true);
	const largest = ((u0 >>> 15) & 1) | (((u1 >>> 15) & 1) << 1);
	const mirrored = ((u2 >>> 15) & 1) !== 0;
	const a = ((u0 & Q15_MAX) / Q15_MAX - 0.5) * SQRT2;
	const b = ((u1 & Q15_MAX) / Q15_MAX - 0.5) * SQRT2;
	const c = ((u2 & Q15_MAX) / Q15_MAX - 0.5) * SQRT2;
	const d = Math.sqrt(Math.max(0, 1 - a * a - b * b - c * c));

	let qx: number;
	let qy: number;
	let qz: number;
	let qw: number;
	switch (largest) {
		case 0: {
			qx = d;
			qy = a;
			qz = b;
			qw = c;
			break;
		}
		case 1: {
			qx = a;
			qy = d;
			qz = b;
			qw = c;
			break;
		}
		case 2: {
			qx = a;
			qy = b;
			qz = d;
			qw = c;
			break;
		}
		default: {
			qx = a;
			qy = b;
			qz = c;
			qw = d;
			break;
		}
	}

	const sx = view.getFloat16(offset + 12, true) * (mirrored ? -1 : 1);
	const sy = view.getFloat16(offset + 14, true);
	const sz = view.getFloat16(offset + 16, true);

	const xx = qx * qx;
	const yy = qy * qy;
	const zz = qz * qz;
	const xy = qx * qy;
	const xz = qx * qz;
	const yz = qy * qz;
	const wx = qw * qx;
	const wy = qw * qy;
	const wz = qw * qz;

	out[outOffset] = (1 - 2 * (yy + zz)) * sx;
	out[outOffset + 1] = 2 * (xy - wz) * sy;
	out[outOffset + 2] = 2 * (xz + wy) * sz;
	out[outOffset + 3] = tx;

	out[outOffset + 4] = 2 * (xy + wz) * sx;
	out[outOffset + 5] = (1 - 2 * (xx + zz)) * sy;
	out[outOffset + 6] = 2 * (yz - wx) * sz;
	out[outOffset + 7] = ty;

	out[outOffset + 8] = 2 * (xz - wy) * sx;
	out[outOffset + 9] = 2 * (yz + wx) * sy;
	out[outOffset + 10] = (1 - 2 * (xx + yy)) * sz;
	out[outOffset + 11] = tz;

	return mirrored;
};

const MAGIC = fourcc('EFFL');
const MAJOR_VERSION = 2;

const TAG_HEAD = fourcc('HEAD');
const TAG_PLTT = fourcc('PLTT');
const TAG_CLST = fourcc('CLST');
const TAG_INST = fourcc('INST');
const TAG_SPST = fourcc('SPST');
const KNOWN_TAGS = new Set([TAG_HEAD, TAG_PLTT, TAG_CLST, TAG_INST, TAG_SPST]);

const HEAD_SIZE = 20;
const CLST_SIZE = 40;

/**
 * encodes a {@link FoliageBlock} into an `EFFL` TLV container
 *
 * @param block foliage clusters and packed instances
 * @returns encoded bytes (before outer zstd)
 * @throws {RangeError} if instance byte length is not a multiple of {@link FOLIAGE_INSTANCE_BYTES} or a
 *   cluster slice runs past `instances`
 */
export const encodeFoliageBlock = (block: FoliageBlock): Uint8Array => {
	if (block.instances.byteLength % FOLIAGE_INSTANCE_BYTES !== 0) {
		throw new RangeError('foliage instances byte length is not a multiple of 24');
	}
	const instanceCount = block.instances.byteLength / FOLIAGE_INSTANCE_BYTES;
	const head = new Uint8Array(HEAD_SIZE);
	const hv = viewOf(head);
	hv.setFloat32(0, block.origin[0], true);
	hv.setFloat32(4, block.origin[1], true);
	hv.setFloat32(8, block.origin[2], true);
	hv.setUint32(12, block.clusters.length, true);
	hv.setUint32(16, instanceCount, true);

	const clst = new Uint8Array(block.clusters.length * CLST_SIZE);
	const cv = viewOf(clst);
	for (const [i, c] of block.clusters.entries()) {
		if (c.firstInstance + c.instanceCount > instanceCount) {
			throw new RangeError(`foliage cluster ${i} runs past instances`);
		}
		const at = i * CLST_SIZE;
		cv.setUint32(at, c.chain, true);
		cv.setUint32(at + 4, c.firstInstance, true);
		cv.setUint32(at + 8, c.instanceCount, true);
		cv.setFloat32(at + 12, c.center[0], true);
		cv.setFloat32(at + 16, c.center[1], true);
		cv.setFloat32(at + 20, c.center[2], true);
		cv.setFloat32(at + 24, c.halfExtents[0], true);
		cv.setFloat32(at + 28, c.halfExtents[1], true);
		cv.setFloat32(at + 32, c.halfExtents[2], true);
		cv.setFloat32(at + 36, c.rendererHalfSize, true);
	}

	const hasSparsity = block.clusters.some((c) => c.sparsity !== undefined && c.sparsity !== 1);
	const spst = hasSparsity ? new Uint8Array(block.clusters.length * 4) : null;
	if (spst !== null) {
		const sv = viewOf(spst);
		for (const [i, c] of block.clusters.entries()) {
			sv.setFloat32(i * 4, c.sparsity ?? 1, true);
		}
	}

	const sections: ContainerSectionInput[] = [
		{ tag: TAG_HEAD, required: true, data: head, count: 1, stride: HEAD_SIZE },
	];
	if (block.palette !== undefined && block.palette.length > 0) {
		sections.push({
			tag: TAG_PLTT,
			required: false,
			data: new Uint8Array(block.palette.buffer, block.palette.byteOffset, block.palette.byteLength),
			count: block.palette.length,
			stride: 8,
		});
	}
	sections.push(
		{ tag: TAG_CLST, required: true, data: clst, count: block.clusters.length, stride: CLST_SIZE },
		{
			tag: TAG_INST,
			required: true,
			data: block.instances,
			count: instanceCount,
			stride: FOLIAGE_INSTANCE_BYTES,
		},
	);
	if (spst !== null) {
		sections.push({ tag: TAG_SPST, required: false, data: spst, count: block.clusters.length, stride: 4 });
	}
	return encodeContainer({ magic: MAGIC, majorVersion: MAJOR_VERSION, sections });
};

/**
 * decodes an `EFFL` foliage cluster block
 *
 * @param data `.fol` bytes
 * @param chainIndex optional map from 64-bit chain content hash → global chain index; when given and a `PLTT`
 *   section is present, remaps each cluster's `chain` to global chain IDs
 * @returns decoded foliage block
 * @throws {PackageFormatError} on malformed headers, lengths, or missing palette hashes
 */
export const decodeFoliageBlock = (
	data: Uint8Array,
	chainIndex?: ReadonlyMap<bigint, number>,
): FoliageBlock => {
	const container = decodeContainer(data, {
		magic: MAGIC,
		majorVersion: MAJOR_VERSION,
		knownTags: KNOWN_TAGS,
		label: 'foliage block',
	});
	const head = requireSection(container, TAG_HEAD, 'foliage block');
	if (head.byteLength < HEAD_SIZE) {
		throw new PackageFormatError('foliage block HEAD is too short');
	}
	const hv = viewOf(head.data);
	const origin: Vec3 = [hv.getFloat32(0, true), hv.getFloat32(4, true), hv.getFloat32(8, true)];
	const clusterCount = hv.getUint32(12, true);
	const instanceCount = hv.getUint32(16, true);

	const clstSec = requireSection(container, TAG_CLST, 'foliage block');
	const instSec = requireSection(container, TAG_INST, 'foliage block');
	checkStride(clstSec, CLST_SIZE, 'CLST');
	checkStride(instSec, FOLIAGE_INSTANCE_BYTES, 'INST');
	if (clstSec.count !== clusterCount || instSec.count !== instanceCount) {
		throw new PackageFormatError('foliage block section counts disagree with HEAD');
	}

	let palette: BigUint64Array | undefined;
	let remap: Uint32Array | null = null;
	const plttSec = container.sections.get(TAG_PLTT);
	if (plttSec !== undefined) {
		checkStride(plttSec, 8, 'PLTT');
		const rawPalette =
			(plttSec.data.byteOffset & 7) === 0
				? new BigUint64Array(plttSec.data.buffer, plttSec.data.byteOffset, plttSec.count)
				: new BigUint64Array(plttSec.data.slice(0, plttSec.count * 8).buffer);
		if (chainIndex !== undefined) {
			remap = new Uint32Array(rawPalette.length);
			for (let i = 0; i < rawPalette.length; i++) {
				const globalId = chainIndex.get(rawPalette[i]);
				if (globalId === undefined) {
					throw new PackageFormatError(`foliage block PLTT hash 0x${rawPalette[i].toString(16)} not found`);
				}
				remap[i] = globalId;
			}
		} else {
			palette = rawPalette;
		}
	}

	const spstSec = container.sections.get(TAG_SPST);
	if (spstSec !== undefined) {
		checkStride(spstSec, 4, 'SPST');
		if (spstSec.count !== clusterCount) {
			throw new PackageFormatError('foliage block SPST count disagrees with HEAD');
		}
	}
	const sv = spstSec !== undefined ? viewOf(spstSec.data) : null;

	const cv = viewOf(clstSec.data);
	const clusters: FoliageCluster[] = [];
	for (let i = 0; i < clstSec.count; i++) {
		const at = i * clstSec.stride;
		const rawChain = cv.getUint32(at, true);
		let chain = rawChain;
		if (remap !== null) {
			if (rawChain >= remap.length) {
				throw new PackageFormatError(`foliage cluster ${i} chain ${rawChain} past PLTT`);
			}
			chain = remap[rawChain];
		}
		const firstInstance = cv.getUint32(at + 4, true);
		const count = cv.getUint32(at + 8, true);
		if (firstInstance + count > instanceCount) {
			throw new PackageFormatError(`foliage cluster ${i} runs past INST`);
		}
		const sparsity = sv !== null ? sv.getFloat32(i * 4, true) : undefined;
		clusters.push({
			chain,
			firstInstance,
			instanceCount: count,
			center: [cv.getFloat32(at + 12, true), cv.getFloat32(at + 16, true), cv.getFloat32(at + 20, true)],
			halfExtents: [cv.getFloat32(at + 24, true), cv.getFloat32(at + 28, true), cv.getFloat32(at + 32, true)],
			rendererHalfSize: cv.getFloat32(at + 36, true),
			...(sparsity !== undefined ? { sparsity } : {}),
		});
	}

	return {
		origin,
		...(palette !== undefined ? { palette } : {}),
		clusters,
		instances: instSec.data.subarray(0, instanceCount * FOLIAGE_INSTANCE_BYTES),
	};
};
