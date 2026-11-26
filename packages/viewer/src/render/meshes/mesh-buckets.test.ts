import assert from 'node:assert/strict';
import { it } from 'node:test';

import type { GeometryTable } from '@endfield-noclip/package-format/geometry-table';
import { type Chain, DrawRole } from '@endfield-noclip/package-format/instances';

import { LazyMaterialLooks } from '../../looks/material-looks.ts';

import { MeshBuckets } from './mesh-buckets.ts';

const geometryTable = (blobs: readonly (number | null)[]): GeometryTable => ({
	count: blobs.length,
	blob: (id) => blobs[id] ?? null,
	entry: () => {
		throw new Error('unexpected entry read');
	},
});

const draw = (geometry: number, material: number) => ({
	lod: 0,
	minSquared: 0,
	maxSquared: Infinity,
	geometry,
	submesh: 0,
	material,
	flags: 0,
	role: DrawRole.Lit,
	sortingLayer: 0,
	sortingOrder: 0,
	particles: null,
});

it('drops draws whose geometry was not converted and skips their stand-in boxes', () => {
	const chains: Chain[] = [
		{ flags: 0, distanceOrigin: null, draws: [draw(0, 0)] },
		{ flags: 0, distanceOrigin: null, draws: [draw(1, 0)] },
	];
	const buckets = new MeshBuckets({
		chains,
		geometries: geometryTable([null, 42]),
		looks: new LazyMaterialLooks({ entries: [{ status: 'failed' }] }),
		stream: { get: () => undefined },
	});
	assert.equal(buckets.slots(0).length, 0);
	assert.equal(buckets.drawsBox(0), false);
	assert.equal(buckets.slots(1).length, 1);
	assert.equal(buckets.drawsBox(1), true);
});
