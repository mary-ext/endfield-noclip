import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LevelInteractive } from '@endfield-noclip/formats/endfield/level-interactives';

import { lifterStart } from './lifters.ts';
import { entityProperties } from './template-data.ts';

const floatBits = (value: number): bigint => {
	const view = new DataView(new ArrayBuffer(4));
	view.setFloat32(0, value);
	return BigInt(view.getUint32(0));
};

const param = (key: string, type: number, values: bigint[]) => ({
	key,
	value: { type, valueArray: values.map((value) => ({ valueBit64: String(value), valueString: null })) },
});

// int_lifter_v2's core component and state as saved
const template = {
	componentList: [
		{
			$type: 'Beyond_Gameplay_Core_LifterCoreComponentDataForMemoryPack',
			propertyList: [param('doorside_list', 4, [0n, 0n])],
		},
	],
	saveProperties: [param('state', 3, [0n])],
	templateVariant: [],
};

// The Hub's lift 2100010064 (map01_lv001, near unity -84, 133, -88), which starts at its upper floor
const row = (state: number, doorside: bigint[] | null): LevelInteractive => ({
	id: 2100010064n,
	template: 'int_lifter_lv005',
	createState: 0,
	position: [-84.04, 132.907, -88.2],
	rotation: [0, 90, 0],
	scale: [1, 1, 1],
	modelScale: 0,
	isLocked: false,
	properties: [
		{
			key: 'position_list',
			type: 12,
			values: [-84.04, 133.507, -88.2, -84.04, 146.947, -88.2].map((value) => ({
				bits: floatBits(value),
				text: null,
			})),
		},
		{ key: 'state', type: 3, values: [{ bits: BigInt(state), text: null }] },
	],
	componentProperties: new Map(
		doorside === null
			? []
			: [[154, [{ key: 'doorside_list', type: 4, values: doorside.map((bits) => ({ bits, text: null })) }]]],
	),
});

test('a lift starts at the floor its state picks from its position list', () => {
	const start = lifterStart(template, entityProperties(template)!, row(1, null));
	assert.ok(!('reason' in start));
	assert.equal(start.floor, 1);
	assert.deepEqual(
		start.position.map((value) => Math.round(value * 1000) / 1000),
		[-84.04, 146.947, -88.2],
	);
	assert.deepEqual(
		[...start.keys],
		[
			['left_opened', 1],
			['right_opened', 1],
			['moving', 0],
		],
	);
});

test("a lift's door side closes the right door with bit 0 and the left with bit 1", () => {
	const start = lifterStart(template, entityProperties(template)!, row(0, [1n, 2n]));
	assert.ok(!('reason' in start));
	assert.equal(start.keys.get('left_opened'), 1);
	assert.equal(start.keys.get('right_opened'), 0);
});

test("a lift whose floor isn't listed can't start", () => {
	assert.ok('reason' in lifterStart(template, entityProperties(template)!, row(2, null)));
});
