import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RangeAllocator } from './range-allocator.ts';

test('growing extends a free range that reaches the end', () => {
	const allocator = new RangeAllocator(8);
	const first = allocator.allocate(6);
	assert.deepEqual(first, { start: 0, count: 6 });
	assert.equal(allocator.allocate(4), null);
	allocator.grow(16);
	assert.equal(allocator.capacity, 16);
	// the 2 free units at the end joined the new 8, so 10 fit in one range
	assert.deepEqual(allocator.allocate(10), { start: 6, count: 10 });
	assert.equal(allocator.used, 16);
});

test('growing a full range adds a new free range after the live allocations', () => {
	const allocator = new RangeAllocator(4);
	const first = allocator.allocate(4);
	assert.ok(first !== null);
	allocator.grow(6);
	assert.deepEqual(allocator.allocate(2), { start: 4, count: 2 });
	allocator.free(first);
	// the freed range at the start is the first fit again
	assert.deepEqual(allocator.allocate(4), { start: 0, count: 4 });
});

test('growing to a smaller capacity changes nothing', () => {
	const allocator = new RangeAllocator(8);
	allocator.grow(4);
	assert.equal(allocator.capacity, 8);
	assert.deepEqual(allocator.allocate(8), { start: 0, count: 8 });
});
