import assert from 'node:assert/strict';
import { it } from 'node:test';

import { sourceVisibility } from './chunk-sources.ts';

it('loads content with any file holding it, each needing its scene state and stream area', () => {
	assert.deepEqual(
		sourceVisibility([
			{ sceneState: 3, area: 0 },
			{ sceneState: 0, area: 7 },
			{ sceneState: 2, area: 7 },
		]),
		{
			alternatives: [
				[{ control: 'sceneState:2', mask: 2 }],
				[{ control: 'area:7', mask: 2 }],
				[
					{ control: 'sceneState:1', mask: 2 },
					{ control: 'area:7', mask: 2 },
				],
			],
		},
	);
	// an always-loaded file of the default area loads it unconditionally
	assert.equal(
		sourceVisibility([
			{ sceneState: 0, area: 7 },
			{ sceneState: 0, area: 0 },
		]),
		null,
	);
});
