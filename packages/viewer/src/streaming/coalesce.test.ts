import assert from 'node:assert/strict';
import { it } from 'node:test';

import { BlobCoalescer, type BlobRange } from './coalesce.ts';

const KiB = 1024;

const coalescer = (ranges: (BlobRange | null)[]): BlobCoalescer =>
	new BlobCoalescer(ranges.length, (blob) => ranges[blob]);

it('takes in close neighbours of the same archive around the highest-priority seed', () => {
	const reads = coalescer([
		{ archive: 1, start: 0, end: 10 * KiB },
		{ archive: 1, start: 20 * KiB, end: 30 * KiB },
		{ archive: 1, start: 200 * KiB, end: 210 * KiB },
		{ archive: 2, start: 30 * KiB, end: 40 * KiB },
	]).reads([0, 1, 2, 3], [1, 5, 2, 3], () => true, 8);
	assert.deepEqual(reads, [
		{ members: [0, 1], start: 0, end: 30 * KiB },
		{ members: [3], start: 30 * KiB, end: 40 * KiB },
		{ members: [2], start: 200 * KiB, end: 210 * KiB },
	]);
});

it('stops at the read limit and keeps reads within their span', () => {
	const ranges = Array.from({ length: 4 }, (_, i) => ({
		archive: 1,
		start: i * 1024 * KiB,
		end: (i + 1) * 1024 * KiB,
	}));
	const reads = coalescer(ranges).reads([0, 1, 2, 3], [4, 3, 2, 1], () => true, 1);
	assert.deepEqual(reads, [{ members: [0, 1], start: 0, end: 2048 * KiB }]);
});

it('reads over blobs that are not queued, in any table order', () => {
	const ranges = [
		{ archive: 1, start: 40 * KiB, end: 50 * KiB },
		null,
		{ archive: 1, start: 0, end: 10 * KiB },
		{ archive: 1, start: 20 * KiB, end: 30 * KiB },
	];
	const reads = coalescer(ranges).reads([0, 2], [1, 2], (blob) => blob !== 3, 8);
	assert.deepEqual(reads, [{ members: [2, 0], start: 0, end: 50 * KiB }]);
});

it('resets what was taken between calls', () => {
	const c = coalescer([{ archive: 1, start: 0, end: 10 * KiB }]);
	assert.equal(c.reads([0], [1], () => true, 8).length, 1);
	assert.equal(c.reads([0], [1], () => true, 8).length, 1);
});
