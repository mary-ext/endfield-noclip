import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
	EnvironmentPhaseInfo,
	EnvironmentProfile,
	EnvironmentVolumeInfo,
	EnvironmentVolumeShape,
	PackageManifest,
} from '@endfield-noclip/package-format/format';

import { blendEnvironment, EnvironmentFades } from './environment-blend.ts';

// only the fields the blend reads; sections are opaque records to it
const profile = (density: number): EnvironmentProfile =>
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a minimal stand-in
	({
		name: 'base',
		heightFog: { heightFogDensity: density, enable: true },
		post: null,
	}) as unknown as EnvironmentProfile;

const phase = (name: string, density: number): EnvironmentPhaseInfo =>
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- as above
	({
		name,
		active: ['heightFog'],
		sections: { heightFog: { heightFogDensity: density, enable: true } },
	}) as unknown as EnvironmentPhaseInfo;

const volume = (patch: Partial<EnvironmentVolumeInfo>): EnvironmentVolumeInfo => ({
	name: 'v',
	level: 1,
	shape: { kind: 'global' },
	blendMode: 1,
	priority: 100,
	blendDistance: 10,
	fadeInDuration: 0,
	fadeOutDuration: 0,
	phase: 0,
	state: false,
	...patch,
});

const manifest = (phases: EnvironmentPhaseInfo[], volumes: EnvironmentVolumeInfo[]): PackageManifest =>
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the blend reads only these lists
	({ environmentPhases: phases, environmentVolumes: volumes }) as unknown as PackageManifest;

const density = (result: ReturnType<typeof blendEnvironment>): number =>
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the stand-in's field
	(result.profile.heightFog as unknown as { heightFogDensity: number }).heightFogDensity;

const square = {
	kind: 'prism',
	points: [
		[0, 0],
		[100, 0],
		[100, 100],
		[0, 100],
	],
	bottom: 0,
	top: 50,
} as const satisfies EnvironmentVolumeShape;
const options = { states: false, pinnedPhase: null };

describe('environment blend', () => {
	it('applies volumes by priority, higher over lower', () => {
		const m = manifest(
			[phase('global', 1), phase('cave', 3)],
			[volume({ priority: 300, phase: 1, shape: square, blendMode: 0 }), volume({ phase: 0 })],
		);
		const inside = blendEnvironment(m, profile(0), [50, 25, 50], options);
		assert.equal(density(inside), 3);
		assert.deepEqual(
			inside.applied.map(({ phase: name }) => name),
			['global', 'cave'],
		);
	});

	it('leaves a prism outside its height band', () => {
		const m = manifest([phase('cave', 3)], [volume({ shape: square, blendMode: 0 })]);
		assert.equal(density(blendEnvironment(m, profile(0), [50, 60, 50], options)), 0);
	});

	it('lerps distance-blended volumes by depth inside over the blend distance', () => {
		const m = manifest([phase('cave', 4)], [volume({ shape: square, blendDistance: 10 })]);
		// 5 m from the nearest edge (x = 5): halfway in
		assert.equal(density(blendEnvironment(m, profile(0), [5, 25, 50], options)), 2);
	});

	it('skips state volumes unless asked', () => {
		const m = manifest([phase('night', 9)], [volume({ state: true })]);
		assert.equal(density(blendEnvironment(m, profile(0), [0, 0, 0], options)), 0);
		assert.equal(density(blendEnvironment(m, profile(0), [0, 0, 0], { ...options, states: true })), 9);
	});

	it('pins one phase instead of the volumes', () => {
		const m = manifest([phase('a', 1), phase('b', 2)], [volume({ phase: 0 })]);
		assert.equal(density(blendEnvironment(m, profile(0), [0, 0, 0], { states: false, pinnedPhase: 1 })), 2);
	});

	it('fades time-blended volumes over their durations, and snaps on a jump', () => {
		const m = manifest(
			[phase('cave', 6)],
			[volume({ shape: square, blendMode: 2, fadeInDuration: 2, fadeOutDuration: 3 })],
		);
		const fades = new EnvironmentFades();
		const at = (eye: [number, number, number], dt: number) =>
			density(blendEnvironment(m, profile(0), eye, options, { fades, dt }));
		// the first frame counts as a jump: fully in at once
		assert.equal(at([98, 25, 50], 0.1), 6);
		// walking out (under 5 m a frame): fades out over 3 s
		assert.equal(at([101, 25, 50], 1), 4);
		assert.equal(fades.animating, true);
		assert.equal(at([102, 25, 50], 2), 0);
		// walking back in fades in over 2 s
		assert.ok(Math.abs(at([99, 25, 50], 1) - 3) < 1e-9);
	});
});
