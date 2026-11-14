import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TERRAIN_HOLE_BIT } from '@endfield-noclip/package-format/terrain';

import { deriveEnvironment } from '../../environment/derive.ts';
import { wetnessParams } from '../../environment/wetness.ts';
import { Camera } from '../../scene/camera.ts';

import {
	FRAME_UNIFORM_BYTES,
	type FrameUniformInputs,
	FrameOffsets,
	writeFrameUniforms,
} from './frame-uniform-writer.ts';

const inputs = (patch: Partial<FrameUniformInputs> = {}): FrameUniformInputs => {
	const camera = new Camera();
	camera.position = [10, 20, 30];
	return {
		camera,
		jitter: [0, 0],
		jitterPhase: 0,
		width: 800,
		height: 400,
		outputWidth: 1600,
		outputHeight: 800,
		time: 12.5,
		windClock: 3,
		environment: deriveEnvironment(null),
		wetness: wetnessParams(undefined),
		exposure: 4,
		bindings: { has: (slot) => slot === 'reflection', reflectionMips: 7 },
		terrain: null,
		shadowMap: {
			layers: [],
			fade: [1, 2],
			penumbra: () => [0, 0, 0, 0],
		},
		shadows: false,
		irradiance: [[1, 2, 3], null, null],
		lights: { count: 5, tilesX: 6, tilesY: 7 },
		revealRadii: [9999, 50000],
		options: {
			minBoxPixels: 1.5,
			outlineMetres: 60,
			wireframe: false,
			cloudShadows: true,
			irradiance: true,
			debugView: 'normals',
		},
		...patch,
	};
};

const write = (patch?: Partial<FrameUniformInputs>): { f32: Float32Array; u32: Uint32Array } => {
	const buffer = new ArrayBuffer(FRAME_UNIFORM_BYTES);
	const f32 = new Float32Array(buffer);
	const u32 = new Uint32Array(buffer);
	writeFrameUniforms(f32, u32, inputs(patch));
	return { f32, u32 };
};

describe('writeFrameUniforms', () => {
	it('packs the eye, clock and sizes', () => {
		const { f32 } = write();
		assert.deepEqual([...f32.subarray(FrameOffsets.eye, FrameOffsets.eye + 4)], [10, 20, 30, 12.5]);
		assert.deepEqual(
			[...f32.subarray(FrameOffsets.renderSize, FrameOffsets.renderSize + 4)],
			[800, 400, 9999, 50000],
		);
		assert.equal(f32[FrameOffsets.viewport], 1600);
		// textures sample one level sharper at half the output size
		assert.equal(f32[FrameOffsets.params + 1], -1);
	});

	it('marks the bound textures and divides out the exposure', () => {
		const { f32 } = write();
		assert.equal(f32[FrameOffsets.ambient + 1], 0.25);
		assert.equal(f32[FrameOffsets.ambient + 2], 1);
		assert.equal(f32[FrameOffsets.ambient + 3], 7);
		assert.equal(f32[FrameOffsets.shadowLook + 3], 0);
	});

	it('writes the debug view code and the filled irradiance levels', () => {
		const { f32, u32 } = write();
		assert.equal(u32[FrameOffsets.flags + 1], 2);
		assert.deepEqual(
			[...f32.subarray(FrameOffsets.irradiance, FrameOffsets.irradiance + 8)],
			[1, 2, 3, 1, 0, 0, 0, 0],
		);
	});

	it('shifts the projection by the jitter, scaled by clip w', () => {
		const still = write().f32;
		const jittered = write({ jitter: [0.5, -0.25] }).f32;
		for (let column = 0; column < 4; column++) {
			const w = still[column * 4 + 3];
			assert.ok(Math.abs(jittered[column * 4] - (still[column * 4] + 0.5 * w)) < 1e-6);
			assert.ok(Math.abs(jittered[column * 4 + 1] - (still[column * 4 + 1] - 0.25 * w)) < 1e-6);
		}
	});

	it('writes the terrain relative to the eye', () => {
		const { f32, u32 } = write({
			terrain: { baseHeight: 5, heightScale: 100, levels: [], splat: null },
		});
		assert.equal(f32[FrameOffsets.terrain], -15);
		assert.equal(u32[FrameOffsets.terrain + 2], TERRAIN_HOLE_BIT);
	});
});
