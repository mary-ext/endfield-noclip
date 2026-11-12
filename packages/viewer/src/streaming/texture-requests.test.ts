import assert from 'node:assert/strict';
import { it } from 'node:test';

import type { ReadyTexture } from '@endfield-noclip/package-format/textures';

import { TextureRequests } from './texture-requests.ts';

/** a 2048² texture: its tail holds levels 5–11, then a piece per larger level, blobs 100… coarse to fine */
const entry: ReadyTexture = {
	status: 'ready',
	kind: '2d',
	format: 'bc7-rgba-unorm',
	width: 2048,
	height: 2048,
	depthOrArrayLayers: 1,
	mipCount: 12,
	sampler: 0,
	pieces: [
		{ blob: 100, firstLevel: 5, levelCount: 7 },
		{ blob: 101, firstLevel: 4, levelCount: 1 },
		{ blob: 102, firstLevel: 3, levelCount: 1 },
		{ blob: 103, firstLevel: 2, levelCount: 1 },
		{ blob: 104, firstLevel: 1, levelCount: 1 },
		{ blob: 105, firstLevel: 0, levelCount: 1 },
	],
};

/** @returns requests over one texture, and the finest level a call asked for */
const requests = ({ blends }: { blends: boolean }) => {
	const wanted: number[] = [];
	const made = new TextureRequests(
		{
			want: (blob) => {
				wanted.push(blob);
				return null;
			},
			markUsed: () => false,
			isReady: () => false,
			discard: () => {},
		},
		{
			streamable: () => entry,
			integrated: () => 0,
			waiting: () => false,
			blendsLevels: () => blends,
		},
	);
	const finest = (): number => {
		const level = Math.min(...wanted.map((blob) => entry.pieces[blob - 100].firstLevel));
		wanted.length = 0;
		return level;
	};
	return { made, finest };
};

it('requests down to the level a footprint samples, rounded as the sampler picks levels', () => {
	const nearest = requests({ blends: false });
	// one texel per pixel: 11 levels below a UV unit per pixel
	nearest.made.forFootprint(0, 44, 1, 0, 1);
	assert.equal(nearest.finest(), 0);
	// a footprint of 2.5 texels rounds to level 1, of 3 to level 2
	nearest.made.forFootprint(0, 44 - 5, 1, 0, 1);
	assert.equal(nearest.finest(), 1);
	nearest.made.forFootprint(0, 44 - 6, 1, 0, 1);
	assert.equal(nearest.finest(), 2);
	// a sampler blending two levels reads the finer of them
	const blending = requests({ blends: true });
	blending.made.forFootprint(0, 44 - 6, 1, 0, 1);
	assert.equal(blending.finest(), 1);
	// tiling packs more texels into a UV unit, and the bias stops short
	nearest.made.forFootprint(0, 44, 4, 0, 1);
	assert.equal(nearest.finest(), 2);
	nearest.made.forFootprint(0, 44, 1, 1.5, 1);
	assert.equal(nearest.finest(), 2);
	// magnified: nothing is finer than the top level
	nearest.made.forFootprint(0, 80, 1, 0, 1);
	assert.equal(nearest.finest(), 0);
});

it('gives an unseen material coarse levels only', () => {
	const { made, finest } = requests({ blends: false });
	// its size on screen asks for the top level: stopped at 256 texels
	made.forUnseen(0, 4096, 1, 1);
	assert.equal(finest(), 3);
	// two levels short of what a small one asks for
	made.forUnseen(0, 64, 1, 1);
	assert.equal(finest(), 5);
});
