import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FormatError } from '../binary/binary-reader.ts';

import { DynamicData, readDynamicEntities, resourceGroupShown } from './dynamic-scene.ts';

// #region synthetic FlatBuffer writer

/** forward-only writer: referenced data follows its referrer, so uoffsets stay positive */
class Writer {
	bytes = new Uint8Array(1 << 14);
	view = new DataView(this.bytes.buffer);
	pos = 0;

	reserve(size: number, align = 4): number {
		this.pos = Math.ceil(this.pos / align) * align;
		const at = this.pos;
		this.pos += size;
		return at;
	}

	/** vtable + table of 4-byte fields at the given slots; returns slot → field position */
	table(slotCount: number, slots: number[]): Map<number, number> {
		const vtable = this.reserve(4 + slotCount * 2, 2);
		const at = this.reserve(4 + slots.length * 4);
		this.view.setUint16(vtable, 4 + slotCount * 2, true);
		this.view.setUint16(vtable + 2, 4 + slots.length * 4, true);
		const fields = new Map<number, number>();
		slots.forEach((slot, i) => {
			this.view.setUint16(vtable + 4 + slot * 2, 4 + i * 4, true);
			fields.set(slot, at + 4 + i * 4);
		});
		this.view.setInt32(at, at - vtable, true);
		return fields;
	}

	link(field: number, target: number): void {
		this.view.setUint32(field, target - field, true);
	}

	/** a vector of `rows.length` fixed-width structs, each given as i32 words; returns its position */
	structs(width: number, rows: number[][]): number {
		const at = this.reserve(4 + width * rows.length, 8);
		this.view.setUint32(at, rows.length, true);
		rows.forEach((words, r) =>
			words.forEach((word, k) => this.view.setInt32(at + 4 + r * width + k * 4, word, true)),
		);
		return at;
	}

	finish(): Uint8Array {
		return this.bytes.slice(0, this.pos);
	}
}

// #endregion

const GRID = 0x070000;

/** DataGroup / DataIndex words: invalid, type, grid, index, num, total */
const ref = (type: number, index: number, num = 0) => [0, type, GRID, index, num, 0];

/**
 * one grid, two entities:
 *
 * - entity 0: IdComp 10200000003, SettlementControlComp (`stm_hongs_3`, main), ResourceComp with three groups
 *   (mask 0b00011, 0b10000, 0)
 * - entity 1: IdComp 7 and PoiControlComp (`INN_TABLE`)
 */
const build = (options: { resType?: number } = {}): Uint8Array => {
	const w = new Writer();
	const root = w.reserve(4);
	const rootFields = w.table(5, [3, 4]);
	w.link(root, rootFields.get(3)! - 4);

	const gridVector = w.reserve(8);
	w.view.setUint32(gridVector, 1, true);
	w.link(rootFields.get(3)!, gridVector);
	const strings = w.reserve(12);
	w.view.setUint32(strings, 2, true);
	w.link(rootFields.get(4)!, strings);

	const slots = [0, 5, 12, 17, 29, 32, 33, 55];
	const grid = w.table(56, slots);
	w.link(gridVector + 4, grid.get(0)! - 4);
	w.view.setUint32(grid.get(0)!, GRID, true);

	const dataIndex = [
		ref(DynamicData.IdComp, 0),
		ref(DynamicData.SettlementControlComp, 0),
		ref(DynamicData.ResourceComp, 0),
		ref(DynamicData.IdComp, 1),
		ref(DynamicData.PoiControlComp, 0),
	].map((words) => words.slice(0, 4));
	w.link(grid.get(5)!, w.structs(16, dataIndex));

	const group = (model: number, logic: number) => [...ref(DynamicData.Model, model, 1), 0, logic, 102, -1];
	w.link(grid.get(12)!, w.structs(88, [group(0, 0b00011), group(1, 0b10000), group(2, 0)]));

	const ids = w.structs(8, [
		[10200000003 % 2 ** 32, Math.floor(10200000003 / 2 ** 32)],
		[7, 0],
	]);
	w.link(grid.get(17)!, ids);
	w.link(grid.get(29)!, w.structs(20, [[0, 0, 0, 0, 1]]));
	w.link(
		grid.get(32)!,
		w.structs(132, [ref(options.resType ?? DynamicData.ResourceGroupWithStateDesc, 0, 3)]),
	);
	w.link(
		grid.get(33)!,
		w.structs(84, [
			[16, 0, ...ref(1, 0, 3)],
			[39, 0, ...ref(1, 3, 2)],
		]),
	);
	w.link(grid.get(55)!, w.structs(8, [[1, 161]]));

	const encoder = new TextEncoder();
	['stm_hongs_3', 'INN_TABLE'].forEach((text, i) => {
		const bytes = encoder.encode(text);
		const at = w.reserve(4 + bytes.length + 1);
		w.view.setUint32(at, bytes.length, true);
		w.bytes.set(bytes, at + 4);
		w.link(strings + 4 + i * 4, at);
	});
	return w.finish();
};

test('reads entity ids, controllers and resource groups', () => {
	const [settlement, poi] = readDynamicEntities(build());
	assert.equal(settlement.grid, GRID);
	assert.equal(settlement.uid, 10200000003n);
	assert.equal(settlement.entityType, 16);
	assert.deepEqual(settlement.controllers, [
		{ kind: 'settlement', settlementId: 'stm_hongs_3', isMain: true },
	]);
	assert.deepEqual(
		settlement.resourceGroups.map((g) => [g.resources.type, g.resources.index, g.logicState, g.levelNum]),
		[
			[DynamicData.Model, 0, 0b00011, 102],
			[DynamicData.Model, 1, 0b10000, 102],
			[DynamicData.Model, 2, 0, 102],
		],
	);
	assert.equal(poi.uid, 7n);
	assert.deepEqual(poi.controllers, [{ kind: 'poi', poiId: 'INN_TABLE', domainType: 161 }]);
	assert.deepEqual(poi.resourceGroups, []);
});

test('a group is shown when its mask has the logic-state bit, or always when the mask is 0', () => {
	const [settlement] = readDynamicEntities(build());
	const shown = (level: number) =>
		settlement.resourceGroups.filter((g) => resourceGroupShown(g, level)).map((g) => g.resources.index);
	assert.deepEqual(shown(1), [0, 2]);
	assert.deepEqual(shown(4), [1, 2]);
	assert.deepEqual(shown(3), [2]);
});

test('rejects a ResourceComp whose Res slice is not a ResourceGroupWithStateDesc slice', () => {
	assert.throws(() => readDynamicEntities(build({ resType: DynamicData.Model })), FormatError);
});
