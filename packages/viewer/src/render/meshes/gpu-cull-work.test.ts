import assert from 'node:assert/strict';
import { it } from 'node:test';

import { ITEM_WORDS, NO_BUCKET, SLOT_WORDS, addItem, addSlot, gpuCullWork } from './gpu-cull-work.ts';

it('packs items and their slots, growing past the initial room', () => {
	const work = gpuCullWork();
	const items = work.items.length / ITEM_WORDS + 1;
	for (let i = 0; i < items; i++) {
		addItem(work, i * 32, 32, 1 << 8);
		addSlot(work, { minSquared: 0.25, maxSquared: Infinity }, 1, [i, NO_BUCKET]);
		addSlot(work, { minSquared: 0, maxSquared: 0.25 }, 3, [NO_BUCKET, i]);
	}
	assert.equal(work.itemCount, items);
	assert.equal(work.slotCount, items * 2);
	const last = (items - 1) * ITEM_WORDS;
	assert.deepEqual(
		[...work.items.subarray(last, last + ITEM_WORDS)],
		[(items - 1) * 32, 32 | (1 << 8), (items - 1) * 2, 2],
	);
	const slot = (items - 1) * 2 * SLOT_WORDS;
	assert.deepEqual([...work.slotFloats.subarray(slot, slot + 2)], [0.25, Infinity]);
	assert.deepEqual([...work.slots.subarray(slot + 2, slot + SLOT_WORDS)], [1, items - 1, NO_BUCKET]);
});
