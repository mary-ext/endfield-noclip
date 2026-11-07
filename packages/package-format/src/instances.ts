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
	/**
	 * a stand-in for something the game draws that the viewer can't (a particle system it can't play, a prefab
	 * it can't read), drawn with the viewer's unsupported look rather than its material. the material names
	 * what it would have drawn, or is {@link NO_MATERIAL} when that isn't known; the geometry is the content's
	 * own mesh, or a unit cube spanning −0.5 to 0.5 that the instance transform scales to its extent
	 */
	Unsupported: 2,
} as const;

/** {@link ChainDraw.material} of a `DrawRole.Unsupported` stand-in whose material isn't known */
export const NO_MATERIAL = 0xffff_ffff;

export type DrawRole = (typeof DrawRole)[keyof typeof DrawRole];

/**
 * chain flag bits. whether a chain is an HLOD cluster's follows from the tree ref that holds it
 * (`ContentKind.Hlod`), and shadow-only draws from their role
 */
export const ChainFlags = {
	/**
	 * the instances face the camera: each frame their transform's rotation is the camera's rotation times the
	 * stored one, about the stored translation
	 */
	BillboardFacing: 1 << 0,
	/**
	 * the instances turn about the world's vertical to face the camera: the stored rotation is relative to the
	 * camera's heading (its forward projected onto the horizontal)
	 */
	BillboardUpright: 1 << 1,
	/**
	 * the draws' `minSquared` and `maxSquared` are squared camera distances from {@link Chain.distanceOrigin},
	 * in m², rather than screen-relative sizes
	 */
	CameraDistance: 1 << 2,
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
	/** index into the material table, or {@link NO_MATERIAL} for some stand-ins */
	material: number;
	submesh: number;
	/** LOD level, 0 = nearest */
	lod: number;
	role: DrawRole;
	/**
	 * shown while `minSquared < s² <= maxSquared`, `s` being the instance's screen-relative height as in
	 * Unity's LODGroup, or the camera's distance in a {@link ChainFlags.CameraDistance} chain. `maxSquared` is
	 * `FLT_MAX` on the nearest LOD; a negative `minSquared` means never culled by size
	 */
	minSquared: number;
	maxSquared: number;
	/** the game's `RendererInfo.renderFlags`, kept for bits not yet understood */
	sourceFlags: number;
	/**
	 * the renderer's sorting layer (its place in the layer order) and order within it, i16 each; 0 where the
	 * game records none (static scenery). the transparent pass draws lower layers, then lower orders, first,
	 * and only then sorts by distance
	 */
	sortingLayer: number;
	sortingOrder: number;
	/**
	 * index into the particles table when the draw is a particle system's mesh: the instance is the emitter,
	 * its transform the system's frame and its bounds everywhere the particles reach. `null` for an ordinary
	 * draw
	 */
	particles: number | null;
}

/** a LOD-chain template shared by every instance with the same ordered draws */
export interface Chain {
	lodCount: number;
	/** {@link ChainFlags} */
	flags: number;
	draws: ChainDraw[];
	/**
	 * in a {@link ChainFlags.CameraDistance} chain, the point camera distances are measured from, in the
	 * instance's frame (its transform takes it to the world); `null` otherwise
	 */
	distanceOrigin: [x: number, y: number, z: number] | null;
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
	/** the placements of the block's rect decal rows */
	decalPlacements: DecalPlacements;
	/** the block's spinning rows and their spins */
	spins: RowSpins;
}

/**
 * f32 per spinning row: the pivot (relative to the block origin), the unit axis and the speed in radians per
 * second. at time `t` the row's transform is turned `speed · t` radians about the axis through the pivot, as
 * Unity's `Quaternion.AngleAxis` turns; its stored transform and bounds are those at `t = 0`
 */
export const SPIN_FLOATS = 7;

/** the spinning rows of an instance block and their spins, the rows ascending */
export interface RowSpins {
	rows: Uint32Array;
	/** {@link SPIN_FLOATS} per row in {@link rows} */
	values: Float32Array;
}

/**
 * f32 per rect decal placement: its RGBA8 colour (0–1, used as stored, not gamma-decoded) with RGB times its
 * intensity, the alpha being multiplied by the material's `_DecalOpacity`; then the scale (u, v) and offset
 * (u, v) of the UV transform of the decal box's `local.xz + 0.5`
 */
export const DECAL_PLACEMENT_FLOATS = 8;

/** the rect decal rows of an instance block and their placements, the rows ascending */
export interface DecalPlacements {
	rows: Uint32Array;
	/** {@link DECAL_PLACEMENT_FLOATS} per row in {@link rows} */
	values: Float32Array;
}

const CHAIN_SIZE = 8;
const DRAW_SIZE = 32;
const ORIGIN_SIZE = 12;
/** {@link ChainDraw.particles} of a draw without particles, as encoded */
const NO_PARTICLES = 0xff_ff_ff_ff;
const INSTANCE_HEADER_SIZE = 32;
/** bytes per instance row across all sections */
const INSTANCE_ROW_SIZE = 4 + 48 + 24 + 4;

/** 'EFCH' */
const CHAINS_HEADER: HeaderShape = {
	magic: 0x48_43_46_45,
	version: 6,
	size: TABLE_HEADER_SIZE,
	label: 'chain table',
};
/** 'EFIN' */
const INSTANCES_HEADER: HeaderShape = {
	magic: 0x4e_49_46_45,
	version: 4,
	size: INSTANCE_HEADER_SIZE,
	label: 'instance block',
};

const isDrawRole = enumGuard(DrawRole);

const hasDistanceOrigin = (flags: number): boolean => (flags & ChainFlags.CameraDistance) !== 0;

/**
 * tables/chains.bin: 16-byte header (`'EFCH'`, u16 version, u16 0, u32 chainCount, u32 drawCount), 8-byte
 * chains (u32 firstDraw, u16 drawCount, u8 lodCount, u8 flags), then 32-byte draws (u32 geometry, u32
 * material, u16 submesh, u8 lod, u8 role, f32 minSquared, f32 maxSquared, u32 sourceFlags, u32 particles,
 * `0xffffffff` for none, i16 sortingLayer, i16 sortingOrder), then f32×3 distance origins, one per
 * {@link ChainFlags.CameraDistance} chain in chain order.
 *
 * @param chains chain templates in id order
 * @returns the encoded table
 * @throws {RangeError} if a chain has more than 65,535 draws, or has a distance origin without the
 *   `CameraDistance` flag or the flag without one
 */
export const encodeChains = (chains: readonly Chain[]): Uint8Array => {
	const drawCount = chains.reduce((sum, chain) => sum + chain.draws.length, 0);
	const originCount = chains.filter((chain) => hasDistanceOrigin(chain.flags)).length;
	const out = new Uint8Array(
		TABLE_HEADER_SIZE + chains.length * CHAIN_SIZE + drawCount * DRAW_SIZE + originCount * ORIGIN_SIZE,
	);
	const view = viewOf(out);
	writeHeader(view, CHAINS_HEADER);
	view.setUint32(8, chains.length, true);
	view.setUint32(12, drawCount, true);

	let chainAt = TABLE_HEADER_SIZE;
	let drawAt = TABLE_HEADER_SIZE + chains.length * CHAIN_SIZE;
	let originAt = drawAt + drawCount * DRAW_SIZE;
	let firstDraw = 0;
	for (const chain of chains) {
		if (chain.draws.length > 0xff_ff) {
			throw new RangeError(`chain has ${chain.draws.length} draws, more than a u16 counts`);
		}
		if (hasDistanceOrigin(chain.flags) !== (chain.distanceOrigin !== null)) {
			throw new RangeError('a chain has a distance origin exactly when it has the CameraDistance flag');
		}
		if (chain.distanceOrigin !== null) {
			for (let i = 0; i < 3; i++) {
				view.setFloat32(originAt + i * 4, chain.distanceOrigin[i], true);
			}
			originAt += ORIGIN_SIZE;
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
			view.setUint32(drawAt + 24, draw.particles ?? NO_PARTICLES, true);
			view.setInt16(drawAt + 28, draw.sortingLayer, true);
			view.setInt16(drawAt + 30, draw.sortingOrder, true);
			drawAt += DRAW_SIZE;
		}
		firstDraw += chain.draws.length;
	}
	return out;
};

const particlesOf = (value: number): number | null => (value === NO_PARTICLES ? null : value);

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
	let originCount = 0;
	if (data.length >= TABLE_HEADER_SIZE + chainCount * CHAIN_SIZE) {
		for (let c = 0; c < chainCount; c++) {
			originCount += Number(hasDistanceOrigin(view.getUint8(TABLE_HEADER_SIZE + c * CHAIN_SIZE + 7)));
		}
	}
	checkLength(
		data,
		TABLE_HEADER_SIZE + chainCount * CHAIN_SIZE + drawCount * DRAW_SIZE + originCount * ORIGIN_SIZE,
		'chain table',
	);

	const drawsAt = TABLE_HEADER_SIZE + chainCount * CHAIN_SIZE;
	let originAt = drawsAt + drawCount * DRAW_SIZE;
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
				sortingLayer: view.getInt16(drawAt + 28, true),
				sortingOrder: view.getInt16(drawAt + 30, true),
				particles: particlesOf(view.getUint32(drawAt + 24, true)),
			});
		}
		const flags = view.getUint8(at + 7);
		let distanceOrigin: Chain['distanceOrigin'] = null;
		if (hasDistanceOrigin(flags)) {
			const f = (i: number): number => view.getFloat32(originAt + i * 4, true);
			distanceOrigin = [f(0), f(1), f(2)];
			originAt += ORIGIN_SIZE;
		}
		chains.push({ lodCount: view.getUint8(at + 6), flags, draws, distanceOrigin });
	}
	return chains;
};

/**
 * instance block: 32-byte header (`'EFIN'`, u16 version, u16 flags, u32 count, f32×3 origin, u32
 * placementCount, u32 spinCount), then sections of `count` elements each: u32 chain, f32×12 transform, f32×6
 * bounds, u32 entity id; then `placementCount` u32 decal rows, ascending, and their f32×8 placements; then
 * `spinCount` u32 spinning rows, ascending, and their f32×7 spins.
 *
 * @param block rows
 * @returns the encoded block
 * @throws {RangeError} if the sections disagree in length, or the decal or spinning rows aren't ascending
 *   rows of the block
 */
export const encodeInstanceBlock = (block: InstanceBlock): Uint8Array => {
	const count = block.chains.length;
	const { rows: decalRows, values: placements } = block.decalPlacements;
	const { rows: spinRows, values: spins } = block.spins;
	if (
		block.transforms.length !== count * 12 ||
		block.bounds.length !== count * 6 ||
		block.entityIds.length !== count ||
		placements.length !== decalRows.length * DECAL_PLACEMENT_FLOATS ||
		spins.length !== spinRows.length * SPIN_FLOATS
	) {
		throw new RangeError('instance block sections differ in length');
	}
	if (!areAscendingRows(decalRows, count)) {
		throw new RangeError('decal rows must be ascending rows of the block');
	}
	if (!areAscendingRows(spinRows, count)) {
		throw new RangeError('spinning rows must be ascending rows of the block');
	}
	const out = new Uint8Array(instanceBlockSize(count, decalRows.length, spinRows.length));
	const view = viewOf(out);
	writeHeader(view, INSTANCES_HEADER);
	view.setUint16(6, block.flags, true);
	view.setUint32(8, count, true);
	for (let i = 0; i < 3; i++) {
		view.setFloat32(12 + i * 4, block.origin[i], true);
	}
	view.setUint32(24, decalRows.length, true);
	view.setUint32(28, spinRows.length, true);
	let at = INSTANCE_HEADER_SIZE;
	for (const section of [
		block.chains,
		block.transforms,
		block.bounds,
		block.entityIds,
		decalRows,
		placements,
		spinRows,
		spins,
	]) {
		out.set(new Uint8Array(section.buffer, section.byteOffset, section.byteLength), at);
		at += section.byteLength;
	}
	return out;
};

const areAscendingRows = (rows: Uint32Array, count: number): boolean =>
	rows.every((row, i) => row < count && (i === 0 || row > rows[i - 1]));

const instanceBlockSize = (count: number, placements: number, spins: number): number =>
	INSTANCE_HEADER_SIZE +
	count * INSTANCE_ROW_SIZE +
	placements * (4 + DECAL_PLACEMENT_FLOATS * 4) +
	spins * (4 + SPIN_FLOATS * 4);

/**
 * @param data an instance block
 * @returns its rows, copied into aligned arrays
 * @throws {PackageFormatError} on a bad header or length
 */
export const decodeInstanceBlock = (data: Uint8Array): InstanceBlock => {
	const view = viewOf(data);
	checkHeader(view, INSTANCES_HEADER);
	const count = view.getUint32(8, true);
	const placementCount = view.getUint32(24, true);
	const spinCount = view.getUint32(28, true);
	checkLength(data, instanceBlockSize(count, placementCount, spinCount), 'instance block');

	let at = INSTANCE_HEADER_SIZE;
	const chains = u32Section(data, at, count);
	at += count * 4;
	const transforms = f32Section(data, at, count * 12);
	at += count * 48;
	const bounds = f32Section(data, at, count * 6);
	at += count * 24;
	const entityIds = u32Section(data, at, count);
	at += count * 4;
	const decalRows = u32Section(data, at, placementCount);
	at += placementCount * 4;
	const placements = f32Section(data, at, placementCount * DECAL_PLACEMENT_FLOATS);
	at += placementCount * DECAL_PLACEMENT_FLOATS * 4;
	const spinRows = u32Section(data, at, spinCount);
	at += spinCount * 4;
	const spins = f32Section(data, at, spinCount * SPIN_FLOATS);
	if (!areAscendingRows(decalRows, count)) {
		throw new PackageFormatError('instance block decal rows aren’t ascending rows of the block');
	}
	if (!areAscendingRows(spinRows, count)) {
		throw new PackageFormatError('instance block spinning rows aren’t ascending rows of the block');
	}
	return {
		flags: view.getUint16(6, true),
		origin: [view.getFloat32(12, true), view.getFloat32(16, true), view.getFloat32(20, true)],
		chains,
		transforms,
		bounds,
		entityIds,
		decalPlacements: { rows: decalRows, values: placements },
		spins: { rows: spinRows, values: spins },
	};
};
