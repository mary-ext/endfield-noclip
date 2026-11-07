import assert from 'node:assert/strict';
import { it } from 'node:test';

import { type Chain, ChainFlags, type InstanceBlock } from '@endfield-noclip/package-format/instances';

import {
	assignBlockSlot,
	BLOCK_SLOT_BITS,
	buildInstanceRows,
	markBillboardRows,
	ROW_WORDS,
	RowBillboard,
	RowKind,
	turnRows,
} from './instance-rows.ts';

const block = (chains: number[], decalRows: number[] = []): InstanceBlock => ({
	origin: [0, 0, 0],
	chains: Uint32Array.from(chains),
	transforms: new Float32Array(chains.length * 12),
	bounds: new Float32Array(chains.length * 6),
	decals: {
		rows: Uint32Array.from(decalRows),
		values: Float32Array.from({ length: decalRows.length * 8 }, (_, i) => i),
	},
	spins: { rows: new Uint32Array(0), values: new Float32Array(0) },
});

it('marks the rows of billboard chains, keeping the rest of their info words', () => {
	const chain = (flags: number): Chain => ({ flags, draws: [], distanceOrigin: null });
	const chains = [chain(0), chain(ChainFlags.BillboardFacing), chain(ChainFlags.BillboardUpright)];
	const rows = buildInstanceRows(block([0, 1, 1, 2]), RowKind.Detail);
	markBillboardRows(rows, chains);
	const info = Array.from({ length: 4 }, (_, i) => rows.rows[i * ROW_WORDS + 19]);
	assert.deepEqual(
		info.map((word) => word >>> 30),
		[RowBillboard.None, RowBillboard.Facing, RowBillboard.Facing, RowBillboard.Upright],
	);
	assert.ok(info.every((word) => (word & 7) === RowKind.Detail));
});

it('indexes decal rows’ placements from 1 above the block slot, which a slot assignment keeps', () => {
	const rows = buildInstanceRows(block([0, 0, 0, 0], [1, 3]), RowKind.Detail);
	assignBlockSlot(rows.rows, 5);
	const words = Array.from({ length: 4 }, (_, i) => rows.rows[i * ROW_WORDS + 15]);
	assert.deepEqual(
		words.map((word) => [word & ((1 << BLOCK_SLOT_BITS) - 1), word >>> BLOCK_SLOT_BITS]),
		[
			[5, 0],
			[5, 1],
			[5, 0],
			[5, 2],
		],
	);
	assert.deepEqual(
		[...rows.placements],
		Array.from({ length: 16 }, (_, i) => i),
	);
});

it('turns spinning rows about their pivot as Unity turns, from their stored transform', () => {
	const spinning = block([0, 0]);
	// row 1: identity at (2, 0, 0), bounds centred there, spinning a quarter turn per second about +z through (1, 0, 0)
	spinning.transforms.set([1, 0, 0, 2, 0, 1, 0, 0, 0, 0, 1, 0], 12);
	spinning.bounds.set([2, 0, 0, 0.5, 0.5, 0.5], 6);
	spinning.spins = { rows: Uint32Array.of(1), values: Float32Array.of(1, 0, 0, 0, 0, 1, Math.PI / 2) };
	const built = buildInstanceRows(spinning, RowKind.Detail);
	const f32 = new Float32Array(built.rows.buffer);
	const row = (): number[] =>
		Array.from(f32.subarray(ROW_WORDS, ROW_WORDS + 15), (v) => Math.round(v * 1e5) / 1e5 + 0);
	// Quaternion.Euler(0, 0, 90) * Vector3.right is Vector3.up
	assert.deepEqual([...built.spins!.runs], [1, 2]);
	turnRows(f32, built.spins!, 1);
	assert.deepEqual(row(), [0, -1, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 1, 1, 0]);
	// half extents stay, and turning again starts from the stored transform
	assert.deepEqual(Array.from(f32.subarray(ROW_WORDS + 16, ROW_WORDS + 19)), [0.5, 0.5, 0.5]);
	turnRows(f32, built.spins!, 4);
	assert.deepEqual(row(), [1, 0, 0, 2, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0]);
	// rows that don't spin are left alone
	assert.deepEqual(
		Array.from(f32.subarray(0, 12)),
		Array.from({ length: 12 }, () => 0),
	);
});

it('rewrites spinning rows in runs that bridge short gaps of rows holding still', () => {
	const spinning = block(Array.from({ length: 40 }, () => 0));
	const rows = [2, 3, 5, 30];
	spinning.spins = {
		rows: Uint32Array.from(rows),
		values: new Float32Array(rows.length * 7),
	};
	assert.deepEqual([...buildInstanceRows(spinning, RowKind.Detail).spins!.runs], [2, 6, 30, 31]);
});
