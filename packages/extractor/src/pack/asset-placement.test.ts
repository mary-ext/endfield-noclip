import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DrawRole } from '@endfield-noclip/package-format/instances';

import { AssetArchives, AssetPlacement, commonAncestor, mergePlaces } from './asset-placement.ts';

describe('commonAncestor', () => {
	it('finds the deepest shared tile, across negative coordinates', () => {
		assert.deepEqual(commonAncestor({ level: 3, x: 2, z: 1 }, { level: 3, x: 3, z: 0 }), {
			level: 2,
			x: 1,
			z: 0,
		});
		assert.deepEqual(commonAncestor({ level: 3, x: 2, z: 1 }, { level: 1, x: 0, z: 0 }), {
			level: 1,
			x: 0,
			z: 0,
		});
		assert.deepEqual(commonAncestor({ level: 3, x: -1, z: -1 }, { level: 3, x: -2, z: -1 }), {
			level: 2,
			x: -1,
			z: -1,
		});
		// different roots
		assert.equal(commonAncestor({ level: 3, x: 0, z: 0 }, { level: 3, x: 0, z: -1 }), null);
	});

	it('merges with unused and common placements', () => {
		const tile = { level: 3, x: 1, z: 1 };
		assert.equal(mergePlaces(undefined, tile), tile);
		assert.equal(mergePlaces(tile, undefined), tile);
		assert.equal(mergePlaces(tile, null), null);
	});
});

describe('AssetPlacement', () => {
	it('places assets at the common ancestor of the tiles drawing them', () => {
		const draw = (geometry: number, material: number) => ({
			geometry,
			material,
			submesh: 0,
			lod: 0,
			role: DrawRole.Lit,
			minSquared: -1,
			maxSquared: 1,
			sourceFlags: 0,
			particles: null,
		});
		const chains = [
			{ lodCount: 1, flags: 0, draws: [draw(0, 0)] },
			{ lodCount: 1, flags: 0, draws: [draw(1, 0), draw(0, 1)] },
			{ lodCount: 1, flags: 0, draws: [draw(2, 2)] },
		];
		const placement = new AssetPlacement(3);
		// leaves at level 6 lift to their level-3 ancestors
		placement.note(0, { level: 6, x: 16, z: 8 });
		placement.note(1, { level: 6, x: 31, z: 15 });
		placement.note(2, null);
		const { geometries, materials } = placement.resolve(chains, 4, 3);
		assert.deepEqual(geometries[0], { level: 2, x: 1, z: 0 });
		assert.deepEqual(geometries[1], { level: 3, x: 3, z: 1 });
		assert.equal(geometries[2], null);
		assert.equal(geometries[3], undefined);
		assert.deepEqual(materials[0], { level: 2, x: 1, z: 0 });
		assert.equal(materials[2], null);
	});

	it('merges direct geometry uses with chain uses', () => {
		const draw = {
			geometry: 0,
			material: 0,
			submesh: 0,
			lod: 0,
			role: DrawRole.Lit,
			minSquared: -1,
			maxSquared: 1,
			sourceFlags: 0,
			particles: null,
		};
		const placement = new AssetPlacement(3);
		placement.note(0, { level: 3, x: 1, z: 1 });
		placement.noteGeometry(0, null);
		placement.noteGeometry(1, { level: 6, x: 8, z: 8 });
		const { geometries } = placement.resolve([{ lodCount: 1, flags: 0, draws: [draw] }], 2, 1);
		assert.equal(geometries[0], null);
		assert.deepEqual(geometries[1], { level: 3, x: 1, z: 1 });
	});
});

describe('AssetArchives', () => {
	it('names archive groups by placement and remembers their tiles', () => {
		const archives = new AssetArchives();
		const tile = { level: 3, x: 2, z: -1 };
		assert.equal(archives.stem(tile), 'assets/3_2_-1');
		assert.equal(archives.stem(null), 'assets/common');
		assert.equal(archives.stem(undefined), 'assets/common');
		assert.deepEqual(archives.tileOf('assets/3_2_-1'), tile);
		assert.equal(archives.tileOf('assets/common'), null);
		assert.equal(archives.tileOf('assets/0_0_0'), undefined);
	});
});
