import {
	viewOf,
	checkHeader,
	enumGuard,
	checkedEnum,
	checkLength,
	f32Section,
	u32Section,
	TABLE_HEADER_SIZE,
	writeHeader,
	type HeaderShape,
} from './binary.ts';
import { PackageFormatError } from './errors.ts';

/** how a draw of a LOD chain is used */
export const DrawRole = {
	/** visible geometry */
	Lit: 0,
	/** casts shadows only (a shadow proxy) */
	ShadowOnly: 1,
	/** foliage imposter card mesh */
	Card: 2,
	/** HLOD cluster mesh */
	Hlod: 3,
} as const;

export type DrawRole = (typeof DrawRole)[keyof typeof DrawRole];

/** chain flag bits */
export const ChainFlags = {
	HasShadowOnly: 1 << 0,
	Hlod: 1 << 1,
	HasCard: 1 << 2,
} as const;

/** instance block flag bits */
export const InstanceBlockFlags = {
	/** rows are grouped by chain, so equal chains form contiguous instanced ranges */
	SortedByChain: 1 << 0,
} as const;

/** one draw of a LOD chain */
export interface ChainDraw {
	/** index into the geometry table */
	geometry: number;
	/** index into the material table */
	material: number;
	submesh: number;
	/** LOD level, 0 = nearest */
	lod: number;
	role: DrawRole;
	/**
	 * shown while `minSquared < s² <= maxSquared`, `s` being the instance's screen-relative height as in
	 * Unity's LODGroup (times the viewer's LOD bias). `maxSquared` is `FLT_MAX` on the nearest LOD; a negative
	 * `minSquared` means never culled by size
	 */
	minSquared: number;
	maxSquared: number;
	/** the game's `RendererInfo.renderFlags`, kept for bits not yet understood */
	sourceFlags: number;
}

/** a LOD-chain template shared by every instance with the same ordered draws */
export interface Chain {
	lodCount: number;
	/** {@link ChainFlags} */
	flags: number;
	draws: ChainDraw[];
}

/**
 * an instance block, struct-of-arrays. rows reference chains; transforms are relative to `origin` so that f32
 * keeps sub-millimetre precision anywhere in the world
 */
export interface InstanceBlock {
	/** {@link InstanceBlockFlags} */
	flags: number;
	/** world position the rows' translations and bounds centres are relative to */
	origin: [x: number, y: number, z: number];
	/** chain index per row */
	chains: Uint32Array;
	/**
	 * 12 floats per row: the object-to-world matrix's top three rows, row-major (`m00 m01 m02 tx, m10 … ty, m20
	 * … tz`), translation relative to `origin`. matches a WGSL `array<vec4f, 3>` per instance
	 */
	transforms: Float32Array;
	/** 6 floats per row: world AABB centre (relative to `origin`) then half-extents, from the game */
	bounds: Float32Array;
	/**
	 * the game's entity id per row, or an id the packer made up for a prefab renderer; for tracing a row back
	 * through the debug index. ownership and visibility come from the block's group, not from the id
	 */
	entityIds: Uint32Array;
}

const CHAIN_SIZE = 8;
const DRAW_SIZE = 24;
const INSTANCE_HEADER_SIZE = 32;
/** bytes per instance row across all sections */
const INSTANCE_ROW_SIZE = 4 + 48 + 24 + 4;

/** 'EFCH' */
const CHAINS_HEADER: HeaderShape = {
	magic: 0x48_43_46_45,
	version: 1,
	size: TABLE_HEADER_SIZE,
	label: 'chain table',
};
/** 'EFIN' */
const INSTANCES_HEADER: HeaderShape = {
	magic: 0x4e_49_46_45,
	version: 2,
	size: INSTANCE_HEADER_SIZE,
	label: 'instance block',
};

const isDrawRole = enumGuard(DrawRole);

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
	writeHeader(view, CHAINS_HEADER);
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
	checkHeader(view, CHAINS_HEADER);
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

/**
 * instance block: 32-byte header (`'EFIN'`, u16 version, u16 flags, u32 count, f32×3 origin, u32×2 0), then
 * sections of `count` elements each: u32 chain, f32×12 transform, f32×6 bounds, u32 entity id.
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
		block.entityIds.length !== count
	) {
		throw new RangeError('instance block sections differ in length');
	}
	const out = new Uint8Array(instanceBlockSize(count));
	const view = viewOf(out);
	writeHeader(view, INSTANCES_HEADER);
	view.setUint16(6, block.flags, true);
	view.setUint32(8, count, true);
	for (let i = 0; i < 3; i++) {
		view.setFloat32(12 + i * 4, block.origin[i], true);
	}
	let at = INSTANCE_HEADER_SIZE;
	for (const section of [block.chains, block.transforms, block.bounds, block.entityIds]) {
		out.set(new Uint8Array(section.buffer, section.byteOffset, section.byteLength), at);
		at += section.byteLength;
	}
	return out;
};

const instanceBlockSize = (count: number): number => INSTANCE_HEADER_SIZE + count * INSTANCE_ROW_SIZE;

/**
 * @param data an instance block
 * @returns its rows, copied into aligned arrays
 * @throws {PackageFormatError} on a bad header or length
 */
export const decodeInstanceBlock = (data: Uint8Array): InstanceBlock => {
	const view = viewOf(data);
	checkHeader(view, INSTANCES_HEADER);
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
	return {
		flags: view.getUint16(6, true),
		origin: [view.getFloat32(12, true), view.getFloat32(16, true), view.getFloat32(20, true)],
		chains,
		transforms,
		bounds,
		entityIds,
	};
};
