import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { MaterialSurface } from '@endfield-noclip/package-format/surfaces';

import { surfaceMotion } from './material-motion.ts';

/** a matte painting whose colour's red follows `_Glow` and whose alpha clip appears past `_Clip` 0 */
const describe = (floats: Record<string, number>): MaterialSurface => ({
	kind: 'mattePainting',
	texture: { texture: 4, uv: 0, scale: [1, 1], offset: [0, 0] },
	color: [floats['_Glow'] ?? 0, 0.5, 0.5],
	alphaClip: (floats['_Clip'] ?? 0) > 0 ? floats['_Clip'] : null,
	highlight: { threshold: 1, intensity: (floats['_Glow'] ?? 0) * 2 },
	ignorePostExposure: 1,
});

test('the floats a clip plays become tracks of the surface numbers they change', () => {
	const base = describe({ _Glow: 3 });
	const motion = surfaceMotion(
		base,
		{ duration: 2, floats: { _Glow: [1, 2, 3], _Unread: [0, 1, 2] } },
		describe,
	);
	assert.deepEqual(motion, {
		duration: 2,
		tracks: [
			{ path: ['color', 0], values: [1, 2, 3] },
			{ path: ['highlight', 'intensity'], values: [2, 4, 6] },
		],
	});
});

test('floats that change nothing give no motion, and a surface that changes shape is reported', () => {
	const base = describe({ _Glow: 3 });
	assert.equal(surfaceMotion(base, { duration: 2, floats: { _Unread: [0, 1, 2] } }, describe), null);
	assert.equal(surfaceMotion(base, { duration: 2, floats: {} }, describe), null);
	// the alpha clip comes and goes, which a track of numbers can't hold
	assert.equal(surfaceMotion(base, { duration: 2, floats: { _Clip: [0, 0.5] } }, describe), 'reshaped');
});
