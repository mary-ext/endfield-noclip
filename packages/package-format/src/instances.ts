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
	 * what it would have drawn, or is `null` when that isn't known; the geometry is the content's own mesh, or
	 * a unit cube spanning −0.5 to 0.5 that the instance transform scales to its extent
	 */
	Unsupported: 2,
} as const;

export type DrawRole = (typeof DrawRole)[keyof typeof DrawRole];

/** chain draw flag bits: which shadow maps the draw casts into, when its material casts at all */
export const ChainDrawFlags = {
	/** casts into the sharp cascades around the camera */
	CastsCascades: 1 << 0,
	/** casts into the cached far shadow map */
	CastsStatic: 1 << 1,
} as const;

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

/** one draw of a LOD chain */
export interface ChainDraw {
	/** index into the geometry table */
	geometry: number;
	/** index into the material table, or `null` for a stand-in whose material isn't known */
	material: number | null;
	/**
	 * index into the particles table when the draw is a particle system's mesh: the instance is the emitter,
	 * its transform the system's frame and its bounds everywhere the particles reach. `null` for an ordinary
	 * draw
	 */
	particles: number | null;
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
	/** {@link ChainDrawFlags} */
	flags: number;
	/**
	 * the renderer's sorting layer (its place in the layer order) and order within it, i16 each; 0 where the
	 * game records none (static scenery). the transparent pass draws lower layers, then lower orders, first,
	 * and only then sorts by distance
	 */
	sortingLayer: number;
	sortingOrder: number;
}

/** a LOD-chain template shared by every instance with the same ordered draws */
export interface Chain {
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
	/** world position the rows' translations and bounds centres are relative to */
	origin: [x: number, y: number, z: number];
	/** chain index per row; rows are grouped by chain, so equal chains form contiguous instanced ranges */
	chains: Uint32Array;
	/**
	 * 12 floats per row: the object-to-world matrix's top three rows, row-major (`m00 m01 m02 tx, m10 … ty, m20
	 * … tz`), translation relative to `origin`. matches a WGSL `array<vec4f, 3>` per instance
	 */
	transforms: Float32Array;
	/** 6 floats per row: world AABB centre (relative to `origin`) then half-extents, from the game */
	bounds: Float32Array;
	/** the rect decal rows and their placements, {@link DECAL_PLACEMENT_FLOATS} each */
	decals: RowSection;
	/** the spinning rows and their spins, {@link SPIN_FLOATS} each */
	spins: RowSection;
}

/** values some rows of an instance block carry */
export interface RowSection {
	/** the rows that carry them, ascending */
	rows: Uint32Array;
	/** a fixed number of floats per row in {@link rows} */
	values: Float32Array;
}

/**
 * f32 per rect decal placement: its RGBA8 colour (0–1, used as stored, not gamma-decoded) with RGB times its
 * intensity, the alpha being multiplied by the material's `_DecalOpacity`; then the scale (u, v) and offset
 * (u, v) of the UV transform of the decal box's `local.xz + 0.5`
 */
export const DECAL_PLACEMENT_FLOATS = 8;

/**
 * f32 per spinning row: the pivot (relative to the block origin), the unit axis and the speed in radians per
 * second. at time `t` the row's transform is turned `speed · t` radians about the axis through the pivot, as
 * Unity's `Quaternion.AngleAxis` turns; its stored transform and bounds are those at `t = 0`
 */
export const SPIN_FLOATS = 7;

/** the row sections of an instance block, in encoded order */
const ROW_SECTIONS = [
	{ key: 'decals', floats: DECAL_PLACEMENT_FLOATS },
	{ key: 'spins', floats: SPIN_FLOATS },
] as const satisfies readonly { key: keyof InstanceBlock; floats: number }[];

const CHAIN_SIZE = 8;
const DRAW_SIZE = 32;
const ORIGIN_SIZE = 12;
/** a `null` reference, as encoded */
const NONE = 0xff_ff_ff_ff;
const INSTANCE_HEADER_SIZE = 32;
/** bytes per instance row across the per-row sections */
const INSTANCE_ROW_SIZE = 4 + 48 + 24;

/** 'EFCH' */
const CHAINS_HEADER: HeaderShape = {
	magic: 0x48_43_46_45,
	version: 7,
	size: TABLE_HEADER_SIZE,
	label: 'chain table',
};
/** 'EFIN' */
const INSTANCES_HEADER: HeaderShape = {
	magic: 0x4e_49_46_45,
	version: 5,
	size: INSTANCE_HEADER_SIZE,
	label: 'instance block',
};

const isDrawRole = enumGuard(DrawRole);

const hasDistanceOrigin = (flags: number): boolean => (flags & ChainFlags.CameraDistance) !== 0;

/**
 * tables/chains.bin: 16-byte header (`'EFCH'`, u16 version, u16 0, u32 chainCount, u32 drawCount), 8-byte
 * chains (u32 firstDraw, u16 drawCount, u8 flags, u8 0), then 32-byte draws (u32 geometry, u32 material, u32
 * particles, `0xffffffff` for none, u16 submesh, u8 lod, u8 role, f32 minSquared, f32 maxSquared, u8 flags,
 * u8 0, i16 sortingLayer, i16 sortingOrder, u16 0), then f32×3 distance origins, one per
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
		view.setUint8(chainAt + 6, chain.flags);
		chainAt += CHAIN_SIZE;
		for (const draw of chain.draws) {
			view.setUint32(drawAt, draw.geometry, true);
			view.setUint32(drawAt + 4, draw.material ?? NONE, true);
			view.setUint32(drawAt + 8, draw.particles ?? NONE, true);
			view.setUint16(drawAt + 12, draw.submesh, true);
			view.setUint8(drawAt + 14, draw.lod);
			view.setUint8(drawAt + 15, draw.role);
			view.setFloat32(drawAt + 16, draw.minSquared, true);
			view.setFloat32(drawAt + 20, draw.maxSquared, true);
			view.setUint8(drawAt + 24, draw.flags);
			view.setInt16(drawAt + 26, draw.sortingLayer, true);
			view.setInt16(drawAt + 28, draw.sortingOrder, true);
			drawAt += DRAW_SIZE;
		}
		firstDraw += chain.draws.length;
	}
	return out;
};

const indexOf = (value: number): number | null => (value === NONE ? null : value);

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
			originCount += Number(hasDistanceOrigin(view.getUint8(TABLE_HEADER_SIZE + c * CHAIN_SIZE + 6)));
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
				material: indexOf(view.getUint32(drawAt + 4, true)),
				particles: indexOf(view.getUint32(drawAt + 8, true)),
				submesh: view.getUint16(drawAt + 12, true),
				lod: view.getUint8(drawAt + 14),
				role: checkedEnum(isDrawRole, view.getUint8(drawAt + 15), 'draw role'),
				minSquared: view.getFloat32(drawAt + 16, true),
				maxSquared: view.getFloat32(drawAt + 20, true),
				flags: view.getUint8(drawAt + 24),
				sortingLayer: view.getInt16(drawAt + 26, true),
				sortingOrder: view.getInt16(drawAt + 28, true),
			});
		}
		const flags = view.getUint8(at + 6);
		let distanceOrigin: Chain['distanceOrigin'] = null;
		if (hasDistanceOrigin(flags)) {
			const f = (i: number): number => view.getFloat32(originAt + i * 4, true);
			distanceOrigin = [f(0), f(1), f(2)];
			originAt += ORIGIN_SIZE;
		}
		chains.push({ flags, draws, distanceOrigin });
	}
	return chains;
};

/**
 * instance block: 32-byte header (`'EFIN'`, u16 version, u16 0, u32 count, f32×3 origin, then a u32 row count
 * per row section: decals, spins), then sections of `count` elements each: u32 chain, f32×12 transform, f32×6
 * bounds; then each row section: its u32 rows, ascending, and their floats (f32×8 decal placements, f32×7
 * spins).
 *
 * @param block rows
 * @returns the encoded block
 * @throws {RangeError} if the sections disagree in length, or a row section's rows aren't ascending rows of
 *   the block
 */
export const encodeInstanceBlock = (block: InstanceBlock): Uint8Array => {
	const count = block.chains.length;
	if (block.transforms.length !== count * 12 || block.bounds.length !== count * 6) {
		throw new RangeError('instance block sections differ in length');
	}
	for (const { key, floats } of ROW_SECTIONS) {
		const { rows, values } = block[key];
		if (values.length !== rows.length * floats) {
			throw new RangeError(`instance block ${key} differ in length`);
		}
		if (!areAscendingRows(rows, count)) {
			throw new RangeError(`instance block ${key} rows must be ascending rows of the block`);
		}
	}
	const out = new Uint8Array(
		instanceBlockSize(
			count,
			ROW_SECTIONS.map(({ key }) => block[key].rows.length),
		),
	);
	const view = viewOf(out);
	writeHeader(view, INSTANCES_HEADER);
	view.setUint32(8, count, true);
	for (let i = 0; i < 3; i++) {
		view.setFloat32(12 + i * 4, block.origin[i], true);
	}
	const parts: (Uint32Array | Float32Array)[] = [block.chains, block.transforms, block.bounds];
	for (const [i, { key }] of ROW_SECTIONS.entries()) {
		view.setUint32(24 + i * 4, block[key].rows.length, true);
		parts.push(block[key].rows, block[key].values);
	}
	let at = INSTANCE_HEADER_SIZE;
	for (const part of parts) {
		out.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), at);
		at += part.byteLength;
	}
	return out;
};

const areAscendingRows = (rows: Uint32Array, count: number): boolean =>
	rows.every((row, i) => row < count && (i === 0 || row > rows[i - 1]));

const instanceBlockSize = (count: number, sectionRows: readonly number[]): number =>
	INSTANCE_HEADER_SIZE +
	count * INSTANCE_ROW_SIZE +
	ROW_SECTIONS.reduce((sum, { floats }, i) => sum + sectionRows[i] * (4 + floats * 4), 0);

/**
 * @param data an instance block
 * @returns its rows, copied into aligned arrays
 * @throws {PackageFormatError} on a bad header or length, or a row section whose rows aren't ascending rows
 *   of the block
 */
export const decodeInstanceBlock = (data: Uint8Array): InstanceBlock => {
	const view = viewOf(data);
	checkHeader(view, INSTANCES_HEADER);
	const count = view.getUint32(8, true);
	const sectionRows = ROW_SECTIONS.map((_, i) => view.getUint32(24 + i * 4, true));
	checkLength(data, instanceBlockSize(count, sectionRows), 'instance block');

	let at = INSTANCE_HEADER_SIZE;
	const chains = u32Section(data, at, count);
	at += count * 4;
	const transforms = f32Section(data, at, count * 12);
	at += count * 48;
	const bounds = f32Section(data, at, count * 6);
	at += count * 24;
	const sections = ROW_SECTIONS.map(({ key, floats }, i): RowSection => {
		const rows = u32Section(data, at, sectionRows[i]);
		at += sectionRows[i] * 4;
		const values = f32Section(data, at, sectionRows[i] * floats);
		at += sectionRows[i] * floats * 4;
		if (!areAscendingRows(rows, count)) {
			throw new PackageFormatError(`instance block ${key} rows aren’t ascending rows of the block`);
		}
		return { rows, values };
	});
	return {
		origin: [view.getFloat32(12, true), view.getFloat32(16, true), view.getFloat32(20, true)],
		chains,
		transforms,
		bounds,
		decals: sections[0],
		spins: sections[1],
	};
};
