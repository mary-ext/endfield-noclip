import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	type AutoExposureSettings,
	BINS,
	easeExposure,
	meteredExposure,
	targetExposure,
} from './exposure.ts';

/** the Hub's settings: bins over EV −8…4 (0.75 EV apart), averaged within −5…4, brightening up to 8 EV */
const HUB: AutoExposureSettings = {
	mode: 'auto',
	compensation: 0,
	manualEv: 0,
	upSpeed: 1,
	downSpeed: 1,
	meteringRange: [-8, 4],
	binRange: [-5, 4],
	centerWeighted: true,
	percentiles: [0.05, 0.95],
	evLimits: [-0.2, 8],
};

const histogram = (entries: Record<number, number>): number[] => {
	const bins = Array.from({ length: BINS }, () => 0);
	for (const [bin, count] of Object.entries(entries)) {
		bins[Number(bin)] = count;
	}
	return bins;
};

test('a dim scene meters brighter, averaging over every sample though the extremes are dropped', () => {
	// bin 4 starts at EV −5; 90 % of the samples are kept, and the sum is divided by all of them
	const exposure = meteredExposure(histogram({ 4: 100 }), HUB);
	assert.ok(Math.abs(exposure - 0.18 / 2 ** (0.9 * -5)) < 1e-9);
});

test('bins darker than the averaging range count at its floor', () => {
	assert.equal(meteredExposure(histogram({ 0: 100 }), HUB), meteredExposure(histogram({ 4: 100 }), HUB));
});

test('the brightest and darkest twentieth of the samples are ignored', () => {
	// a few blown-out samples (emitters) don't pull the exposure down
	const withEmitters = meteredExposure(histogram({ 4: 95, 15: 5 }), HUB);
	const plain = 0.18 / 2 ** ((90 * -5) / 100);
	assert.ok(Math.abs(withEmitters - plain) < 1e-9);
});

test('compensation adds EV, and the target stays within the EV limits', () => {
	const brighter = meteredExposure(histogram({ 4: 100 }), { ...HUB, compensation: 1 });
	assert.ok(Math.abs(brighter / meteredExposure(histogram({ 4: 100 }), HUB) - 2) < 1e-9);
	assert.equal(targetExposure(1000, HUB), 2 ** 8);
	assert.equal(targetExposure(0.1, HUB), 2 ** -0.2);
	assert.equal(targetExposure(null, HUB), 1);
	assert.equal(targetExposure(1000, { ...HUB, mode: 'manual', manualEv: 2 }), 4);
});

test('the exposure eases by the up or down speed and never overshoots', () => {
	const settings = { ...HUB, upSpeed: 2, downSpeed: 0.5 };
	assert.equal(easeExposure(1, 3, settings, 0.25), 2);
	assert.equal(easeExposure(3, 1, settings, 1), 2);
	assert.equal(easeExposure(1, 3, settings, 10), 3);
});
