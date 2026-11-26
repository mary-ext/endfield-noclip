import { checkedEnum, enumGuard, viewOf } from './binary.ts';
import {
	checkStride,
	decodeContainer,
	decodeSparseSection,
	encodeContainer,
	encodeSparseSection,
	fourcc,
	requireSection,
	sectionF32,
	sectionU32,
	type ContainerSection,
	type ContainerSectionInput,
} from './container.ts';
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
	/**
	 * the instances turn about their own local `+x` axis (column 0 of the world transform) to face the camera,
	 * used by view-aligned `LineRenderer` ribbons
	 */
	BillboardAxial: 1 << 3,
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
	/** optional transparent sorting band byte (defaults to 0) */
	sortingBand?: number;
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
	/** optional 64-bit canonical content hash (for shard-local chain palettes) */
	contentHash?: bigint;
	/** {@link ChainFlags} */
	flags: number;
	draws: ChainDraw[];
	/**
	 * in a {@link ChainFlags.CameraDistance} chain, the point camera distances are measured from, in the
	 * instance's frame (its transform takes it to the world); `null` otherwise
	 */
	distanceOrigin: [x: number, y: number, z: number] | null;
}

/** pre-baked per-row flags in `.inst` (`FLAG` section) */
export const RowFlags = {
	/** transform has negative 3×3 determinant (mirrored handedness) */
	Mirrored: 1 << 0,
	/** row draws a facing billboard */
	BillboardFacing: 1 << 1,
	/** row draws an upright billboard */
	BillboardUpright: 1 << 2,
	/** row references a motion clip in `MOTN` */
	HasMotion: 1 << 3,
	/** row draws an axial billboard turning about its local `+x` axis */
	BillboardAxial: 1 << 4,
} as const;

/** values per row in `MOTN` sparse section: `[animBlob, float32Bits(phaseOffset)]` */
export const MOTION_WORDS = 2;

/** floats per row in `LODG` sparse section: `[refCenter.x, refCenter.y, refCenter.z, refSize]` */
export const LOD_GROUP_FLOATS = 4;

/**
 * an instance block, struct-of-arrays. rows reference chains; transforms are relative to `origin` so that f32
 * keeps sub-millimetre precision anywhere in the world
 */
export interface InstanceBlock {
	/** world position the rows' translations and bounds centres are relative to */
	origin: [x: number, y: number, z: number];
	/**
	 * optional per-block local chain palette (`PLTT`): 64-bit canonical chain hashes. when present,
	 * {@link chains} holds local indices into this palette rather than global `chains.bin` indices, isolating
	 * shard bytes from global chain ID shifts
	 */
	palette?: BigUint64Array;
	/** chain index per row; rows are grouped by chain, so equal chains form contiguous instanced ranges */
	chains: Uint32Array;
	/**
	 * 12 floats per row: the object-to-world matrix's top three rows, row-major (`m00 m01 m02 tx, m10 … ty, m20
	 * … tz`), translation relative to `origin`. matches a WGSL `array<vec4f, 3>` per instance
	 */
	transforms: Float32Array;
	/** 6 floats per row: world AABB centre (relative to `origin`) then half-extents, from the game */
	bounds: Float32Array;
	/** optional pre-baked {@link RowFlags} per row (`FLAG` section) */
	rowFlags?: Uint8Array;
	/** optional HLOD cluster id per row (`HLOD` section), linking to `tree.bin` `HLOD` */
	hlodClusters?: Uint32Array;
	/** the rect decal rows and their placements, {@link DECAL_PLACEMENT_FLOATS} each */
	decals: RowSection;
	/** the spinning rows and their spins, {@link SPIN_FLOATS} each */
	spins: RowSection;
	/**
	 * the rows floating on a gameplay water volume and, one each, the index into `WaterTable.volumes` of the
	 * volume they float on
	 */
	floaters: RowSection<Uint32Array>;
	/** the rows riding a path and, one each, the index into {@link paths} of the path they ride */
	rides: RowSection<Uint32Array>;
	/** the paths the block's {@link rides} name */
	paths: RowPath[];
	/** optional sparse `.anim` motion clip bindings (`MOTN` section: 2 u32 words per row) */
	motions?: RowSection<Uint32Array>;
	/** optional sparse static `LODGroup` reference spheres (`LODG` section: 4 f32 per row) */
	lodGroups?: RowSection;
	/** optional sparse assembly node bindings (`ASMB` section: 1 u32 node id per row) */
	assemblyNodes?: RowSection<Uint32Array>;
	/** optional sparse GPU cloth bindings (`CLTH` section: 1 u32 index into `ClothTable.cloths` per row) */
	cloths?: RowSection<Uint32Array>;
}

/**
 * a looping path rows ride as a whole, keeping their rotation and scale. at time `t` a riding row's
 * translation and bounds centre are its stored ones plus the offset at frame `t · frameRate`, wrapped to the
 * loop and blended linearly between neighbouring frames (the last towards the first). its stored transform
 * and bounds are those off the path, where the game places it before it sets off
 */
export interface RowPath {
	/** frames per second, above 0 */
	frameRate: number;
	/** 3 floats per frame, at least one frame: the offset from the stored translation, m along the world's axes */
	offsets: Float32Array;
}

/**
 * @param path a path rows ride
 * @param time seconds
 * @param out where the offset goes
 * @returns `out`, holding the path's offset at that time
 */
export const pathOffset = (
	path: RowPath,
	time: number,
	out: [x: number, y: number, z: number],
): [x: number, y: number, z: number] => {
	const { offsets } = path;
	const count = offsets.length / 3;
	const at = (((time * path.frameRate) % count) + count) % count;
	const frame = Math.min(Math.floor(at), count - 1);
	const blend = at - frame;
	const a = frame * 3;
	const b = ((frame + 1) % count) * 3;
	for (let axis = 0; axis < 3; axis++) {
		out[axis] = offsets[a + axis] + (offsets[b + axis] - offsets[a + axis]) * blend;
	}
	return out;
};

/** values some rows of an instance block carry */
export interface RowSection<Values extends Float32Array | Uint32Array = Float32Array> {
	/** the rows that carry them, ascending */
	rows: Uint32Array;
	/** a fixed number of values per row in {@link rows} */
	values: Values;
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

const MAJOR_VERSION = 2;
const CHAINS_MAGIC = fourcc('EFCH');
const INSTANCES_MAGIC = fourcc('EFIN');

const TAG_CHNS = fourcc('CHNS');
const TAG_DRWS = fourcc('DRWS');
const TAG_DORG = fourcc('DORG');
const CHAINS_TAGS = new Set([TAG_CHNS, TAG_DRWS, TAG_DORG]);

const TAG_HEAD = fourcc('HEAD');
const TAG_PLTT = fourcc('PLTT');
const TAG_XFRM = fourcc('XFRM');
const TAG_BNDS = fourcc('BNDS');
const TAG_FLAG = fourcc('FLAG');
const TAG_HLOD = fourcc('HLOD');
const TAG_DECL = fourcc('DECL');
const TAG_SPIN = fourcc('SPIN');
const TAG_FLOT = fourcc('FLOT');
const TAG_RIDE = fourcc('RIDE');
const TAG_PATH = fourcc('PATH');
const TAG_MOTN = fourcc('MOTN');
const TAG_LODG = fourcc('LODG');
const TAG_ASMB = fourcc('ASMB');
const TAG_CLTH = fourcc('CLTH');
const INSTANCES_TAGS = new Set([
	TAG_HEAD,
	TAG_PLTT,
	TAG_CHNS,
	TAG_XFRM,
	TAG_BNDS,
	TAG_FLAG,
	TAG_HLOD,
	TAG_DECL,
	TAG_SPIN,
	TAG_FLOT,
	TAG_RIDE,
	TAG_PATH,
	TAG_MOTN,
	TAG_LODG,
	TAG_ASMB,
	TAG_CLTH,
]);

const CHAIN_SIZE = 16;
const DRAW_SIZE = 32;
const DORG_SIZE = 16;
const HEAD_SIZE = 24;
const PATH_HEADER_SIZE = 8;
const NONE = 0xff_ff_ff_ff;

const isDrawRole = enumGuard(DrawRole);

const hasDistanceOrigin = (flags: number): boolean => (flags & ChainFlags.CameraDistance) !== 0;

/**
 * encodes `tables/chains.bin` as an `EFCH` v2 TLV container
 *
 * @param chains chain templates in id order
 * @returns the encoded table
 * @throws {RangeError} if a chain has more than 65,535 draws, or has a distance origin without the
 *   `CameraDistance` flag or the flag without one
 */
export const encodeChains = (chains: readonly Chain[]): Uint8Array => {
	const drawCount = chains.reduce((sum, chain) => sum + chain.draws.length, 0);
	const origins: { index: number; origin: [number, number, number] }[] = [];
	const chainBuf = new Uint8Array(chains.length * CHAIN_SIZE);
	const cv = viewOf(chainBuf);
	const drawBuf = new Uint8Array(drawCount * DRAW_SIZE);
	const dv = viewOf(drawBuf);

	let firstDraw = 0;
	let drawAt = 0;
	for (const [c, chain] of chains.entries()) {
		if (chain.draws.length > 0xff_ff) {
			throw new RangeError(`chain has ${chain.draws.length} draws, more than a u16 counts`);
		}
		if (hasDistanceOrigin(chain.flags) !== (chain.distanceOrigin !== null)) {
			throw new RangeError('a chain has a distance origin exactly when it has the CameraDistance flag');
		}
		if (chain.distanceOrigin !== null) {
			origins.push({ index: c, origin: chain.distanceOrigin });
		}
		const at = c * CHAIN_SIZE;
		cv.setBigUint64(at, chain.contentHash ?? 0n, true);
		cv.setUint32(at + 8, firstDraw, true);
		cv.setUint16(at + 12, chain.draws.length, true);
		cv.setUint8(at + 14, chain.flags);
		for (const draw of chain.draws) {
			dv.setUint32(drawAt, draw.geometry, true);
			dv.setUint32(drawAt + 4, draw.material ?? NONE, true);
			dv.setUint32(drawAt + 8, draw.particles ?? NONE, true);
			dv.setUint16(drawAt + 12, draw.submesh, true);
			dv.setUint8(drawAt + 14, draw.lod);
			dv.setUint8(drawAt + 15, draw.role);
			dv.setFloat32(drawAt + 16, draw.minSquared, true);
			dv.setFloat32(drawAt + 20, draw.maxSquared, true);
			dv.setUint8(drawAt + 24, draw.flags);
			dv.setUint8(drawAt + 25, draw.sortingBand ?? 0);
			dv.setInt16(drawAt + 26, draw.sortingLayer, true);
			dv.setInt16(drawAt + 28, draw.sortingOrder, true);
			drawAt += DRAW_SIZE;
		}
		firstDraw += chain.draws.length;
	}

	const sections: ContainerSectionInput[] = [
		{ tag: TAG_CHNS, required: true, data: chainBuf, count: chains.length, stride: CHAIN_SIZE },
		{ tag: TAG_DRWS, required: true, data: drawBuf, count: drawCount, stride: DRAW_SIZE },
	];
	if (origins.length > 0) {
		const dorgBuf = new Uint8Array(origins.length * DORG_SIZE);
		const ov = viewOf(dorgBuf);
		for (const [i, { index, origin }] of origins.entries()) {
			const at = i * DORG_SIZE;
			ov.setUint32(at, index, true);
			ov.setFloat32(at + 4, origin[0], true);
			ov.setFloat32(at + 8, origin[1], true);
			ov.setFloat32(at + 12, origin[2], true);
		}
		sections.push({
			tag: TAG_DORG,
			required: true,
			data: dorgBuf,
			count: origins.length,
			stride: DORG_SIZE,
		});
	}
	return encodeContainer({ magic: CHAINS_MAGIC, majorVersion: MAJOR_VERSION, sections });
};

const indexOf = (value: number): number | null => (value === NONE ? null : value);

/**
 * decodes `tables/chains.bin` (`EFCH` v2 TLV container)
 *
 * @param data tables/chains.bin
 * @returns the chain templates
 * @throws {PackageFormatError} on a bad header, length or draw range
 */
export const decodeChains = (data: Uint8Array): Chain[] => {
	const container = decodeContainer(data, {
		magic: CHAINS_MAGIC,
		majorVersion: MAJOR_VERSION,
		knownTags: CHAINS_TAGS,
		label: 'chain table',
	});
	const chainSec = requireSection(container, TAG_CHNS, 'chain table');
	const drawSec = requireSection(container, TAG_DRWS, 'chain table');
	const dorgSec = container.sections.get(TAG_DORG);
	checkStride(chainSec, CHAIN_SIZE, 'CHNS');
	checkStride(drawSec, DRAW_SIZE, 'DRWS');
	if (dorgSec !== undefined) {
		checkStride(dorgSec, DORG_SIZE, 'DORG');
	}

	const origins = new Map<number, [number, number, number]>();
	if (dorgSec !== undefined) {
		const ov = viewOf(dorgSec.data);
		for (let i = 0; i < dorgSec.count; i++) {
			const at = i * dorgSec.stride;
			origins.set(ov.getUint32(at, true), [
				ov.getFloat32(at + 4, true),
				ov.getFloat32(at + 8, true),
				ov.getFloat32(at + 12, true),
			]);
		}
	}

	const cv = viewOf(chainSec.data);
	const dv = viewOf(drawSec.data);
	const chains: Chain[] = [];
	for (let c = 0; c < chainSec.count; c++) {
		const at = c * chainSec.stride;
		const contentHash = cv.getBigUint64(at, true);
		const first = cv.getUint32(at + 8, true);
		const count = cv.getUint16(at + 12, true);
		const flags = cv.getUint8(at + 14);
		if (first + count > drawSec.count) {
			throw new PackageFormatError(`chain ${c} draws run past the draw table`);
		}
		const draws: ChainDraw[] = [];
		for (let d = first; d < first + count; d++) {
			const drawAt = d * drawSec.stride;
			const sortingBand = dv.getUint8(drawAt + 25);
			draws.push({
				geometry: dv.getUint32(drawAt, true),
				material: indexOf(dv.getUint32(drawAt + 4, true)),
				particles: indexOf(dv.getUint32(drawAt + 8, true)),
				submesh: dv.getUint16(drawAt + 12, true),
				lod: dv.getUint8(drawAt + 14),
				role: checkedEnum(isDrawRole, dv.getUint8(drawAt + 15), 'draw role'),
				minSquared: dv.getFloat32(drawAt + 16, true),
				maxSquared: dv.getFloat32(drawAt + 20, true),
				flags: dv.getUint8(drawAt + 24),
				...(sortingBand !== 0 ? { sortingBand } : {}),
				sortingLayer: dv.getInt16(drawAt + 26, true),
				sortingOrder: dv.getInt16(drawAt + 28, true),
			});
		}
		const distanceOrigin = origins.get(c) ?? null;
		if (hasDistanceOrigin(flags) !== (distanceOrigin !== null)) {
			throw new PackageFormatError(`chain ${c} CameraDistance flag disagrees with DORG`);
		}
		chains.push({
			...(contentHash !== 0n ? { contentHash } : {}),
			flags,
			draws,
			distanceOrigin,
		});
	}
	return chains;
};

/**
 * builds a lookup map from 64-bit canonical {@link Chain.contentHash} to global chain index
 *
 * @param chains decoded chain table
 * @returns map of content hash → chain index
 */
export const chainHashMap = (chains: readonly Chain[]): Map<bigint, number> => {
	const map = new Map<bigint, number>();
	for (let i = 0; i < chains.length; i++) {
		const hash = chains[i].contentHash;
		if (hash !== undefined && hash !== 0n) {
			map.set(hash, i);
		}
	}
	return map;
};

const bytesOf = (a: Uint32Array | Float32Array | BigUint64Array): Uint8Array =>
	new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

const readSparseF32 = (
	section: ContainerSection | undefined,
	words: number,
	rowCount: number,
	label: string,
): RowSection => {
	if (section === undefined) {
		return { rows: new Uint32Array(0), values: new Float32Array(0) };
	}
	const { rows, values, stride } = decodeSparseSection(section, words * 4, rowCount, label);
	if (stride === words * 4 && (values.byteOffset & 3) === 0) {
		return { rows, values: new Float32Array(values.buffer, values.byteOffset, rows.length * words) };
	}
	const out = new Float32Array(rows.length * words);
	const v = viewOf(values);
	for (let i = 0; i < rows.length; i++) {
		for (let w = 0; w < words; w++) {
			out[i * words + w] = v.getFloat32(i * stride + w * 4, true);
		}
	}
	return { rows, values: out };
};

const readSparseU32Words = (
	section: ContainerSection | undefined,
	words: number,
	rowCount: number,
	label: string,
): RowSection<Uint32Array> => {
	if (section === undefined) {
		return { rows: new Uint32Array(0), values: new Uint32Array(0) };
	}
	const { rows, values, stride } = decodeSparseSection(section, words * 4, rowCount, label);
	if (stride === words * 4 && (values.byteOffset & 3) === 0) {
		return { rows, values: new Uint32Array(values.buffer, values.byteOffset, rows.length * words) };
	}
	const out = new Uint32Array(rows.length * words);
	const v = viewOf(values);
	for (let i = 0; i < rows.length; i++) {
		for (let w = 0; w < words; w++) {
			out[i * words + w] = v.getUint32(i * stride + w * 4, true);
		}
	}
	return { rows, values: out };
};

const readSparseU32 = (
	section: ContainerSection | undefined,
	rowCount: number,
	label: string,
): RowSection<Uint32Array> => readSparseU32Words(section, 1, rowCount, label);

/**
 * encodes an instance block (`.inst`) as an `EFIN` v2 TLV container
 *
 * @param block rows
 * @returns the encoded block
 * @throws {RangeError} if the sections disagree in length, a row section's rows aren't ascending rows of the
 *   block, a ride names no path, or a path has no whole frame or no frame rate above 0
 */
export const encodeInstanceBlock = (block: InstanceBlock): Uint8Array => {
	const count = block.chains.length;
	if (block.transforms.length !== count * 12 || block.bounds.length !== count * 6) {
		throw new RangeError('instance block sections differ in length');
	}
	if (block.rides.values.some((path) => path >= block.paths.length)) {
		throw new RangeError('an instance block ride names a path the block lacks');
	}
	for (const { frameRate, offsets } of block.paths) {
		if (offsets.length === 0 || offsets.length % 3 !== 0 || !(frameRate > 0)) {
			throw new RangeError('an instance block path needs whole frames and a frame rate above 0');
		}
	}

	const head = new Uint8Array(HEAD_SIZE);
	const hv = viewOf(head);
	hv.setFloat32(0, block.origin[0], true);
	hv.setFloat32(4, block.origin[1], true);
	hv.setFloat32(8, block.origin[2], true);
	hv.setUint32(12, count, true);

	const sections: ContainerSectionInput[] = [{ tag: TAG_HEAD, required: true, data: head }];
	if (block.palette !== undefined) {
		sections.push({
			tag: TAG_PLTT,
			required: true,
			data: bytesOf(block.palette),
			count: block.palette.length,
			stride: 8,
		});
	}
	sections.push(
		{ tag: TAG_CHNS, required: true, data: bytesOf(block.chains), count, stride: 4 },
		{ tag: TAG_XFRM, required: true, data: bytesOf(block.transforms), count, stride: 48 },
		{ tag: TAG_BNDS, required: true, data: bytesOf(block.bounds), count, stride: 24 },
	);
	if (block.rowFlags !== undefined) {
		if (block.rowFlags.length !== count) {
			throw new RangeError('instance block rowFlags disagrees with row count');
		}
		sections.push({ tag: TAG_FLAG, required: false, data: block.rowFlags, count, stride: 1 });
	}
	if (block.hlodClusters !== undefined) {
		if (block.hlodClusters.length !== count) {
			throw new RangeError('instance block hlodClusters disagrees with row count');
		}
		sections.push({
			tag: TAG_HLOD,
			required: false,
			data: bytesOf(block.hlodClusters),
			count,
			stride: 4,
		});
	}

	const addSparse = (
		tag: number,
		sec: RowSection<Float32Array | Uint32Array>,
		words: number,
		required: boolean,
	): void => {
		if (sec.rows.length === 0) {
			if (sec.values.length !== 0) {
				throw new RangeError('instance block sparse section has values without rows');
			}
			return;
		}
		for (const row of sec.rows) {
			if (row >= count) {
				throw new RangeError('instance block sparse row index past block count');
			}
		}
		sections.push({
			tag,
			required,
			data: encodeSparseSection(sec.rows, bytesOf(sec.values), words * 4),
			count: sec.rows.length,
			stride: words * 4,
		});
	};

	addSparse(TAG_DECL, block.decals, DECAL_PLACEMENT_FLOATS, false);
	addSparse(TAG_SPIN, block.spins, SPIN_FLOATS, false);
	addSparse(TAG_FLOT, block.floaters, 1, false);
	addSparse(TAG_RIDE, block.rides, 1, false);
	if (block.motions !== undefined) {
		addSparse(TAG_MOTN, block.motions, MOTION_WORDS, false);
	}
	if (block.lodGroups !== undefined) {
		addSparse(TAG_LODG, block.lodGroups, LOD_GROUP_FLOATS, false);
	}
	if (block.assemblyNodes !== undefined) {
		addSparse(TAG_ASMB, block.assemblyNodes, 1, false);
	}
	if (block.cloths !== undefined) {
		addSparse(TAG_CLTH, block.cloths, 1, false);
	}

	if (block.paths.length > 0) {
		const pathBytes = block.paths.reduce((sum, p) => sum + PATH_HEADER_SIZE + p.offsets.byteLength, 0);
		const pathBuf = new Uint8Array(pathBytes);
		const pv = viewOf(pathBuf);
		let at = 0;
		for (const { frameRate, offsets } of block.paths) {
			pv.setFloat32(at, frameRate, true);
			pv.setUint32(at + 4, offsets.length / 3, true);
			at += PATH_HEADER_SIZE;
			pathBuf.set(bytesOf(offsets), at);
			at += offsets.byteLength;
		}
		sections.push({ tag: TAG_PATH, required: false, data: pathBuf, count: block.paths.length });
	}

	return encodeContainer({ magic: INSTANCES_MAGIC, majorVersion: MAJOR_VERSION, sections });
};

/**
 * decodes an instance block (`.inst`, `EFIN` v2 TLV container)
 *
 * @param data an instance block
 * @param chainIndex optional map from 64-bit chain content hash → global chain index (from
 *   {@link chainHashMap}); when given and a `PLTT` section is present, remaps `chains` to global indices
 * @returns its rows (zero-copy views when 4-byte aligned)
 * @throws {PackageFormatError} on a bad header or length, a row section whose rows aren't ascending rows of
 *   the block, a ride naming no path, a missing palette hash, or a path without frames or a frame rate above
 *   0
 */
export const decodeInstanceBlock = (
	data: Uint8Array,
	chainIndex?: ReadonlyMap<bigint, number>,
): InstanceBlock => {
	const container = decodeContainer(data, {
		magic: INSTANCES_MAGIC,
		majorVersion: MAJOR_VERSION,
		knownTags: INSTANCES_TAGS,
		label: 'instance block',
	});
	const head = requireSection(container, TAG_HEAD, 'instance block');
	if (head.byteLength < HEAD_SIZE) {
		throw new PackageFormatError('instance block HEAD is too short');
	}
	const hv = viewOf(head.data);
	const origin: [number, number, number] = [
		hv.getFloat32(0, true),
		hv.getFloat32(4, true),
		hv.getFloat32(8, true),
	];
	const count = hv.getUint32(12, true);

	let chains = sectionU32(requireSection(container, TAG_CHNS, 'instance block'));
	const transforms = sectionF32(requireSection(container, TAG_XFRM, 'instance block'));
	const bounds = sectionF32(requireSection(container, TAG_BNDS, 'instance block'));
	if (chains.length !== count || transforms.length !== count * 12 || bounds.length !== count * 6) {
		throw new PackageFormatError('instance block core sections disagree with rowCount');
	}

	let palette: BigUint64Array | undefined;
	const plttSec = container.sections.get(TAG_PLTT);
	if (plttSec !== undefined) {
		checkStride(plttSec, 8, 'PLTT');
		const rawPalette =
			(plttSec.data.byteOffset & 7) === 0
				? new BigUint64Array(plttSec.data.buffer, plttSec.data.byteOffset, plttSec.count)
				: new BigUint64Array(plttSec.data.slice(0, plttSec.count * 8).buffer);
		if (chainIndex !== undefined) {
			const remap = new Uint32Array(rawPalette.length);
			for (let i = 0; i < rawPalette.length; i++) {
				const globalId = chainIndex.get(rawPalette[i]);
				if (globalId === undefined) {
					throw new PackageFormatError(`instance block PLTT hash 0x${rawPalette[i].toString(16)} not found`);
				}
				remap[i] = globalId;
			}
			const resolved = new Uint32Array(count);
			for (let r = 0; r < count; r++) {
				const local = chains[r];
				if (local >= remap.length) {
					throw new PackageFormatError(`instance block row ${r} chain ${local} past PLTT`);
				}
				resolved[r] = remap[local];
			}
			chains = resolved;
		} else {
			palette = rawPalette;
		}
	}

	const flagSec = container.sections.get(TAG_FLAG);
	let rowFlags: Uint8Array | undefined;
	if (flagSec !== undefined) {
		if (flagSec.count !== count || flagSec.byteLength < count) {
			throw new PackageFormatError('instance block FLAG disagrees with rowCount');
		}
		rowFlags = flagSec.data.subarray(0, count);
	}
	const hlodSec = container.sections.get(TAG_HLOD);
	let hlodClusters: Uint32Array | undefined;
	if (hlodSec !== undefined) {
		hlodClusters = sectionU32(hlodSec);
		if (hlodClusters.length !== count) {
			throw new PackageFormatError('instance block HLOD disagrees with rowCount');
		}
	}

	const decals = readSparseF32(container.sections.get(TAG_DECL), DECAL_PLACEMENT_FLOATS, count, 'DECL');
	const spins = readSparseF32(container.sections.get(TAG_SPIN), SPIN_FLOATS, count, 'SPIN');
	const floaters = readSparseU32(container.sections.get(TAG_FLOT), count, 'FLOT');
	const rides = readSparseU32(container.sections.get(TAG_RIDE), count, 'RIDE');
	const motnSec = container.sections.get(TAG_MOTN);
	const motions =
		motnSec === undefined ? undefined : readSparseU32Words(motnSec, MOTION_WORDS, count, 'MOTN');
	const lodgSec = container.sections.get(TAG_LODG);
	const lodGroups =
		lodgSec === undefined ? undefined : readSparseF32(lodgSec, LOD_GROUP_FLOATS, count, 'LODG');
	const asmbSec = container.sections.get(TAG_ASMB);
	const assemblyNodes = asmbSec === undefined ? undefined : readSparseU32(asmbSec, count, 'ASMB');
	const clthSec = container.sections.get(TAG_CLTH);
	const cloths = clthSec === undefined ? undefined : readSparseU32(clthSec, count, 'CLTH');

	const paths: RowPath[] = [];
	const pathSec = container.sections.get(TAG_PATH);
	if (pathSec !== undefined) {
		const pv = viewOf(pathSec.data);
		let at = 0;
		for (let p = 0; p < pathSec.count; p++) {
			if (at + PATH_HEADER_SIZE > pathSec.byteLength) {
				throw new PackageFormatError('instance block paths run past its end');
			}
			const frameRate = pv.getFloat32(at, true);
			const frames = pv.getUint32(at + 4, true);
			at += PATH_HEADER_SIZE;
			if (frames === 0 || !(frameRate > 0) || at + frames * 12 > pathSec.byteLength) {
				throw new PackageFormatError(`instance block path ${p} is malformed`);
			}
			const raw = pathSec.data.subarray(at, at + frames * 12);
			const offsets =
				(raw.byteOffset & 3) === 0
					? new Float32Array(raw.buffer, raw.byteOffset, frames * 3)
					: new Float32Array(raw.slice().buffer);
			paths.push({ frameRate, offsets });
			at += frames * 12;
		}
	}

	if (rides.values.some((path) => path >= paths.length)) {
		throw new PackageFormatError('an instance block ride names a path the block lacks');
	}
	return {
		origin,
		...(palette !== undefined ? { palette } : {}),
		chains,
		transforms,
		bounds,
		...(rowFlags !== undefined ? { rowFlags } : {}),
		...(hlodClusters !== undefined ? { hlodClusters } : {}),
		decals,
		spins,
		floaters,
		rides,
		paths,
		...(motions !== undefined ? { motions } : {}),
		...(lodGroups !== undefined ? { lodGroups } : {}),
		...(assemblyNodes !== undefined ? { assemblyNodes } : {}),
		...(cloths !== undefined ? { cloths } : {}),
	};
};
