/**
 * the GPU layout of instance rows, shared by the decode worker (which builds them) and the instance renderer
 * (whose WGSL `InstanceRow` mirrors it).
 *
 * @module
 */

import type { InstanceBlock } from '@endfield-noclip/package-format/instances';

/** 32-bit words per row: transform (12), bounds centre + block slot (4), half extents + info (4) */
export const ROW_WORDS = 20;

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
 * a row's info word: its {@link RowKind} in bits 0–3, then the texture sheet tile its mesh's UVs are remapped
 * into (`sheet_uv` in frame.wgsl): tiles across − 1 in bits 4–9, down − 1 in bits 10–15, the tile in bits
 * 16–27, and which UV sets take it (bit 28 UV0, bit 29 UV1). a 1×1 sheet leaves the UVs as they are
 *
 * @param kind the row's kind
 * @param tiles tiles across and down, 1–64 each
 * @param tile the tile, counted from the sheet's top-left along its rows
 * @param uvChannels bit 0 for UV0, bit 1 for UV1
 * @returns the info word
 */
export const rowInfo = (
	kind: RowKind,
	tiles: readonly [number, number],
	tile: number,
	uvChannels: number,
): number =>
	(kind |
		((tiles[0] - 1) << 4) |
		((tiles[1] - 1) << 10) |
		((tile & 0xfff) << 16) |
		((uvChannels & 3) << 28)) >>>
	0;

/**
 * info bit of a row whose last half-extent word holds a colour instead (RGBA8, `instance_color` in
 * frame.wgsl) that multiplies the mesh's vertex colours. only particle rows set it: their extents are equal,
 * so the other two keep the size
 */
export const ROW_COLORED = 1 << 30;

/**
 * @param rgba linear colour and alpha, 0–1
 * @returns them as the RGBA8 word of a {@link ROW_COLORED} row
 */
export const packRowColor = (rgba: readonly number[]): number => {
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
}

/**
 * row: f32×12 transform rows (relative to the block origin), f32×3 bounds centre (relative), u32 block slot,
 * f32×3 half extents, u32 info (the row's {@link RowKind}; see {@link rowInfo} for the rest of the word).
 *
 * the block slot is left 0; {@link assignBlockSlot} sets it once the block gets a slot.
 *
 * @param block decoded block
 * @param kinds the rows' kinds; rows outside every tier span become tier 0
 * @returns rows, cull data and chain runs
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
		rows[at + 19] = rowKinds[i];
		// from the f32-rounded extents, as the GPU sees them
		const fx = f32[at + 16];
		const fy = f32[at + 17];
		const fz = f32[at + 18];
		cull[i * CULL_FLOATS] = Math.sqrt(fx * fx + fy * fy + fz * fz);
		cull[i * CULL_FLOATS + 1] = Math.max(fx, fy, fz);
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
	return { count, origin: block.origin, rows, cull, runs: new Uint32Array(runs) };
};

/**
 * sets the block slot of every row.
 *
 * @param rows rows from {@link buildInstanceRows}; modified in place
 * @param slot index into the per-frame block origin table
 */
export const assignBlockSlot = (rows: Uint32Array, slot: number): void => {
	for (let at = 15; at < rows.length; at += ROW_WORDS) {
		rows[at] = slot;
	}
};
