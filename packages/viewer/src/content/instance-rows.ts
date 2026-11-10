/**
 * the GPU layout of instance rows, shared by the decode worker (which builds them) and the instance renderer
 * (whose WGSL `InstanceRow` mirrors it).
 *
 * @module
 */

import {
	type Chain,
	ChainFlags,
	type InstanceBlock,
	SPIN_FLOATS,
} from '@endfield-noclip/package-format/instances';

/**
 * 32-bit words per row: transform (12), bounds centre + block word (4), half extents + info (4), then the
 * words {@link RowWord} names from the texture sheet on (4). frame.wgsl's `InstanceRow` mirrors it
 */
export const ROW_WORDS = 24;

/** where a row's words past its transform and bounds centre start */
export const RowWord = {
	/** the block slot and decal placement ({@link BLOCK_SLOT_BITS}) */
	block: 15,
	/** half extents, f32×3 */
	extent: 16,
	/** its {@link RowKind} in bits 0–2 and its {@link RowBillboard} in bits 30–31; the bits between are free */
	info: 19,
	/** the texture sheet tile its mesh's UVs are remapped into ({@link rowSheet}) */
	sheet: 20,
	/** RGBA8 that multiplies the mesh's vertex colours (`instance_color` in frame.wgsl); white for most rows */
	color: 21,
	/**
	 * two words of f16 pairs (xy, zw): a particle's custom data (`ParticleSystemInfo.customData`), which effect
	 * looks read ({@link packRowCustom}); zero for every other row
	 */
	custom: 22,
} as const;

/** the {@link RowWord.color} of a row that leaves its mesh's colours as they are */
const ROW_WHITE = 0xffff_ffff;

/**
 * bits of a row's block word that hold its block slot (`row_block` in frame.wgsl); the bits above hold its
 * decal placement's index in its block plus 1, or 0 for a row without one (`row_placement`)
 */
export const BLOCK_SLOT_BITS = 14;

/** block slots the block word can name */
export const BLOCK_SLOTS = 1 << BLOCK_SLOT_BITS;

/** bytes per row */
export const ROW_BYTES = ROW_WORDS * 4;

/** f32 per row in {@link InstanceRows.cull}: bounding radius, largest half extent */
export const CULL_FLOATS = 2;

/** what a row draws as, its info word; tiers 0–2 are HLOD tiers */
export const RowKind = {
	Hlod0: 0,
	Hlod1: 1,
	Hlod2: 2,
	Detail: 3,
	Global: 4,
} as const;

export type RowKind = (typeof RowKind)[keyof typeof RowKind];

/**
 * a row's texture sheet word ({@link RowWord.sheet}): the tile its mesh's UVs are remapped into (`sheet_uv`
 * in frame.wgsl), tiles across − 1 in bits 0–5, down − 1 in bits 6–11, the tile in bits 12–23, and which UV
 * sets take it (bit 24 UV0, bit 25 UV1). 0, a 1×1 sheet, leaves the UVs as they are
 *
 * @param tiles tiles across and down, 1–64 each
 * @param tile the tile, counted from the sheet's top-left along its rows
 * @param uvChannels bit 0 for UV0, bit 1 for UV1
 * @returns the sheet word
 */
export const rowSheet = (tiles: readonly [number, number], tile: number, uvChannels: number): number =>
	((tiles[0] - 1) | ((tiles[1] - 1) << 6) | ((tile & 0xfff) << 12) | ((uvChannels & 3) << 24)) >>> 0;

const customHalves = new Float16Array(4);
const customWords = new Uint32Array(customHalves.buffer);

/**
 * @param custom a particle's four custom data values
 * @returns them as a row's two {@link RowWord.custom} words, each an f16 pair low half first, as WGSL's
 *   `unpack2x16float` reads them
 */
export const packRowCustom = (custom: ArrayLike<number>): [xy: number, zw: number] => {
	customHalves.set(custom);
	return [customWords[0], customWords[1]];
};

/**
 * how a row turns towards the camera (`row_basis` in frame.wgsl), in bits 30–31 of its info word: its
 * transform's rotation is relative to the camera's ({@link ChainFlags.BillboardFacing}), or to the camera's
 * heading about the vertical ({@link ChainFlags.BillboardUpright})
 */
export const RowBillboard = {
	None: 0,
	Facing: 1,
	Upright: 2,
} as const;

export type RowBillboard = (typeof RowBillboard)[keyof typeof RowBillboard];

/**
 * marks the rows of billboard chains in their info words, in place, by the block's chain runs
 *
 * @param built rows from {@link buildInstanceRows}; their info words are modified
 * @param chains the package's chains
 */
export const markBillboardRows = (built: InstanceRows, chains: readonly Chain[]): void => {
	const { runs, rows } = built;
	for (let r = 0; r < runs.length; r += 3) {
		const flags = chains[runs[r]]?.flags ?? 0;
		let billboard: RowBillboard = RowBillboard.None;
		if (flags & ChainFlags.BillboardFacing) {
			billboard = RowBillboard.Facing;
		} else if (flags & ChainFlags.BillboardUpright) {
			billboard = RowBillboard.Upright;
		}
		if (billboard === RowBillboard.None) {
			continue;
		}
		for (let i = runs[r + 1], end = i + runs[r + 2]; i < end; i++) {
			const at = i * ROW_WORDS + RowWord.info;
			rows[at] = ((rows[at] & ~(3 << 30)) | (billboard << 30)) >>> 0;
		}
	}
};

/**
 * @param rgba linear colour and alpha, 0–1
 * @returns them as a row's RGBA8 {@link RowWord.color}
 */
export const packRowColor = (rgba: ArrayLike<number>): number => {
	let word = 0;
	for (let i = 0; i < 4; i++) {
		word |= Math.round(Math.min(Math.max(rgba[i], 0), 1) * 255) << (i * 8);
	}
	return word >>> 0;
};

/** a span of rows sharing a tier, as listed by the tree's HLOD refs */
export interface TierSpan {
	first: number;
	count: number;
	tier: number;
}

/** what an instance block's rows are: one kind for every row, or the tier spans of an HLOD block */
export type RowKinds = RowKind | readonly TierSpan[];

/** f32 per spinning row in {@link RowSpins.base}: its stored transform (12) and bounds centre (3) */
const SPIN_BASE_FLOATS = 15;

/** a block's spinning rows, which {@link turnRows} turns by the clock */
export interface RowSpins {
	/** the rows, ascending */
	rows: Uint32Array<ArrayBuffer>;
	/** `SPIN_FLOATS` per row, as the package stores them: pivot (relative to the block origin), axis, speed */
	values: Float32Array<ArrayBuffer>;
	/** {@link SPIN_BASE_FLOATS} per row: what the rows hold at time 0 */
	base: Float32Array<ArrayBuffer>;
	/**
	 * (first, end) pairs of row ranges that hold every spinning row, across gaps of up to {@link SPIN_RUN_GAP}
	 * rows: what's rewritten after {@link turnRows}
	 */
	runs: Uint32Array<ArrayBuffer>;
}

/** rows that hold still between two spinning rows rewritten together rather than in two writes */
const SPIN_RUN_GAP = 8;

/** @returns {@link RowSpins.runs} of ascending spinning rows */
const spinRuns = (rows: Uint32Array): Uint32Array<ArrayBuffer> => {
	const runs: number[] = [];
	for (const row of rows) {
		const last = runs.length - 1;
		if (last > 0 && row - runs[last] <= SPIN_RUN_GAP) {
			runs[last] = row + 1;
		} else {
			runs.push(row, row + 1);
		}
	}
	return new Uint32Array(runs);
};

/** an instance block laid out for the GPU */
export interface InstanceRows {
	count: number;
	origin: [x: number, y: number, z: number];
	/** `count × ROW_WORDS` words */
	rows: Uint32Array<ArrayBuffer>;
	/** `count × CULL_FLOATS` floats for CPU-side culling and LOD selection */
	cull: Float32Array<ArrayBuffer>;
	/** (chain, first, count) triples of equal-chain runs, for per-template instancing */
	runs: Uint32Array<ArrayBuffer>;
	/** the block's rect decal placements, `DECAL_PLACEMENT_FLOATS` each, in the order rows index them */
	placements: Float32Array<ArrayBuffer>;
	/** the block's spinning rows, or `null` when every row holds still */
	spins: RowSpins | null;
	/** the block's rows floating on a water volume, or `null` when none does */
	floaters: RowFloaters | null;
}

/** a block's rows floating on water volumes, which follow their volume's surface up and down */
export interface RowFloaters {
	/** the rows, ascending */
	rows: Uint32Array<ArrayBuffer>;
	/** per row, the index into the package's water volumes of the volume it floats on */
	volumes: Uint32Array<ArrayBuffer>;
}

/**
 * rows as {@link ROW_WORDS} lays them out: transforms relative to the block origin, the bounds, the rows'
 * kinds, a 1×1 texture sheet, white and no custom data.
 *
 * the block slot is left 0; {@link assignBlockSlot} sets it once the block gets a slot.
 *
 * @param block decoded block
 * @param kinds the rows' kinds; rows outside every tier span become tier 0
 * @returns rows, cull data, chain runs and decal placements
 * @throws {RangeError} if the block has more decal placements than a block word can index
 */
export const buildInstanceRows = (block: InstanceBlock, kinds: RowKinds): InstanceRows => {
	const count = block.chains.length;
	const rows = new Uint32Array(count * ROW_WORDS);
	const f32 = new Float32Array(rows.buffer);
	const cull = new Float32Array(count * CULL_FLOATS);
	const rowKinds = new Uint8Array(count);
	if (typeof kinds === 'number') {
		rowKinds.fill(kinds);
	} else {
		for (const span of kinds) {
			rowKinds.fill(span.tier, span.first, span.first + span.count);
		}
	}
	for (let i = 0; i < count; i++) {
		const at = i * ROW_WORDS;
		const ex = block.bounds[i * 6 + 3];
		const ey = block.bounds[i * 6 + 4];
		const ez = block.bounds[i * 6 + 5];
		f32.set(block.transforms.subarray(i * 12, i * 12 + 12), at);
		f32[at + 12] = block.bounds[i * 6];
		f32[at + 13] = block.bounds[i * 6 + 1];
		f32[at + 14] = block.bounds[i * 6 + 2];
		f32[at + 16] = ex;
		f32[at + 17] = ey;
		f32[at + 18] = ez;
		rows[at + RowWord.info] = rowKinds[i];
		rows[at + RowWord.color] = ROW_WHITE;
		// from the f32-rounded extents, as the GPU sees them
		const fx = f32[at + 16];
		const fy = f32[at + 17];
		const fz = f32[at + 18];
		cull[i * CULL_FLOATS] = Math.sqrt(fx * fx + fy * fy + fz * fz);
		cull[i * CULL_FLOATS + 1] = Math.max(fx, fy, fz);
	}
	const { rows: decalRows, values } = block.decals;
	if (decalRows.length >= 2 ** (32 - BLOCK_SLOT_BITS)) {
		throw new RangeError(
			`an instance block has ${decalRows.length} decal placements, more than rows can index`,
		);
	}
	for (let p = 0; p < decalRows.length; p++) {
		rows[decalRows[p] * ROW_WORDS + RowWord.block] = ((p + 1) << BLOCK_SLOT_BITS) >>> 0;
	}

	const runs: number[] = [];
	for (let i = 0; i < count;) {
		const chain = block.chains[i];
		let end = i + 1;
		while (end < count && block.chains[end] === chain) {
			end++;
		}
		runs.push(chain, i, end - i);
		i = end;
	}
	let spins: RowSpins | null = null;
	if (block.spins.rows.length > 0) {
		const spinRows = new Uint32Array(block.spins.rows);
		const base = new Float32Array(spinRows.length * SPIN_BASE_FLOATS);
		for (let s = 0; s < spinRows.length; s++) {
			const at = spinRows[s] * ROW_WORDS;
			base.set(f32.subarray(at, at + SPIN_BASE_FLOATS), s * SPIN_BASE_FLOATS);
		}
		spins = {
			rows: spinRows,
			values: new Float32Array(block.spins.values),
			base,
			runs: spinRuns(spinRows),
		};
	}
	return {
		count,
		origin: block.origin,
		rows,
		cull,
		runs: new Uint32Array(runs),
		placements: new Float32Array(values),
		spins,
		floaters:
			block.floaters.rows.length === 0
				? null
				: { rows: new Uint32Array(block.floaters.rows), volumes: new Uint32Array(block.floaters.values) },
	};
};

/**
 * sets the block slot of every row, keeping its placement index.
 *
 * @param rows rows from {@link buildInstanceRows}; modified in place
 * @param slot index into the per-frame block table, below {@link BLOCK_SLOTS}
 */
export const assignBlockSlot = (rows: Uint32Array, slot: number): void => {
	const keep = ~(BLOCK_SLOTS - 1);
	for (let at = RowWord.block; at < rows.length; at += ROW_WORDS) {
		rows[at] = ((rows[at] & keep) | slot) >>> 0;
	}
};

/** {@link turnRows}' rotation matrix and pivot, kept so turning allocates nothing */
const ROTATION = new Float64Array(9);
const PIVOT = new Float64Array(3);

/**
 * turns a block's spinning rows to where they are at `time`: each row's transform and bounds centre are its
 * stored ones turned `speed · time` radians about its axis through its pivot. the half extents stay the
 * stored ones, so a row's bounding sphere (centre, |extents|) still holds it
 *
 * @param rows the block's rows, as f32; the spinning rows' transform and centre words are overwritten
 * @param spins the block's spinning rows
 * @param time seconds of the viewer's clock
 */
export const turnRows = (rows: Float32Array, spins: RowSpins, time: number): void => {
	const { rows: spinRows, values, base } = spins;
	const r = ROTATION;
	const pivot = PIVOT;
	for (let s = 0; s < spinRows.length; s++) {
		const v = s * SPIN_FLOATS;
		const px = values[v];
		const py = values[v + 1];
		const pz = values[v + 2];
		const ax = values[v + 3];
		const ay = values[v + 4];
		const az = values[v + 5];
		const angle = values[v + 6] * time;
		// Rodrigues' rotation, as Unity's Quaternion.AngleAxis turns: R = cos·I + sin·[a]× + (1 − cos)·aaᵀ
		const c = Math.cos(angle);
		const sn = Math.sin(angle);
		const k = 1 - c;
		r[0] = c + k * ax * ax;
		r[1] = k * ax * ay - sn * az;
		r[2] = k * ax * az + sn * ay;
		r[3] = k * ay * ax + sn * az;
		r[4] = c + k * ay * ay;
		r[5] = k * ay * az - sn * ax;
		r[6] = k * az * ax - sn * ay;
		r[7] = k * az * ay + sn * ax;
		r[8] = c + k * az * az;
		pivot[0] = px;
		pivot[1] = py;
		pivot[2] = pz;
		const b = s * SPIN_BASE_FLOATS;
		const at = spinRows[s] * ROW_WORDS;
		for (let i = 0; i < 3; i++) {
			for (let j = 0; j < 3; j++) {
				rows[at + i * 4 + j] =
					r[i * 3] * base[b + j] + r[i * 3 + 1] * base[b + 4 + j] + r[i * 3 + 2] * base[b + 8 + j];
			}
			let t = pivot[i];
			let centre = pivot[i];
			for (let j = 0; j < 3; j++) {
				t += r[i * 3 + j] * (base[b + j * 4 + 3] - pivot[j]);
				centre += r[i * 3 + j] * (base[b + 12 + j] - pivot[j]);
			}
			rows[at + i * 4 + 3] = t;
			rows[at + 12 + i] = centre;
		}
	}
};
