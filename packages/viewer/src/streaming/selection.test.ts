import assert from 'node:assert/strict';
import { it } from 'node:test';

import { ContentKind, type ContentRef } from '@endfield-noclip/package-format/format';

import { Camera } from '../scene/camera.ts';
import type { TileNode, TileTree } from '../scene/tile-tree.ts';

import { Selector, type SelectionOptions } from './selection.ts';

it('streams conditional scenery independently of coarse HLOD and never requests hidden variants', () => {
	const ref = (blob: number, condition: number, level: number): ContentRef => ({
		kind: ContentKind.Conditional,
		tier: 0,
		level,
		blob,
		first: 0,
		count: 1,
		param: condition,
	});
	const child: TileNode = {
		index: 1,
		level: 1,
		x: 0,
		z: 0,
		minX: 0,
		minZ: 0,
		size: 50,
		bounds: { min: [0, 0, 0], max: [50, 50, 50] },
		geometricError: 0,
		quadrants: [null, null, null, null],
		terrain: null,
		surface: null,
		detail: [],
		hlod: [],
		conditional: [ref(1, 0, 1), ref(2, 1, 1), ref(3, 0, 2)],
		cellId: null,
	};
	const root: TileNode = {
		...child,
		index: 0,
		level: 0,
		size: 100,
		quadrants: [child, null, null, null],
		conditional: [],
		hlod: [{ ...ref(9, 0, 1), kind: ContentKind.Hlod }],
	};
	const tree: TileTree = {
		nodes: [root, child],
		roots: [root],
		byId: new Map(),
		terrainLeafLevel: -1,
		terrainRootLevel: Infinity,
	};
	const wanted: number[] = [];
	const selector = new Selector(
		tree,
		{
			want(blob) {
				wanted.push(blob);
				return null;
			},
			get() {
				return undefined;
			},
			markUsed() {
				return false;
			},
			isReady() {
				return false;
			},
		},
		[],
		65,
		100,
	);
	selector.setLevel(1);
	const options: SelectionOptions = {
		terrain: false,
		terrainSurface: false,
		instances: true,
		detail: true,
		resident: true,
		maxSse: 12,
		terrainPixels: 3,
		hlodTiers: [true, true, true],
	};
	const view = { camera: new Camera(), planes: [], pixelFactor: 100 };
	selector.setConditions([true, false]);
	selector.run(view, options, null);
	assert.deepEqual(wanted, [9, 1]);
	wanted.length = 0;
	selector.setConditions([false, true]);
	selector.run(view, options, null);
	assert.deepEqual(wanted, [9, 2]);
	wanted.length = 0;
	selector.run(view, { ...options, detail: false }, null);
	assert.deepEqual(wanted, [9]);
	wanted.length = 0;
	// 50 m tiles 1 km away span 5 px at this pixel factor: under maxSse, so nothing conditional is requested
	const far = new Camera();
	far.position = [1050, 0, 0];
	selector.run({ ...view, camera: far }, options, null);
	assert.deepEqual(wanted, [9]);
});
