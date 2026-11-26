import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';

import { syntheticMesh } from '../../pipeline/compile/synthetic-mesh.ts';

import { readLineRenderer } from './line-renderer.ts';

const vec3 = (x: number, y: number, z: number): TypeTreeObject => ({ x, y, z });

const line = (
	positions: readonly [number, number, number][],
	overrides: {
		useWorldSpace?: boolean;
		loop?: boolean;
		alignment?: number;
		textureMode?: number;
		widthMultiplier?: number;
		widthCurve?: TypeTreeObject[];
		colorGradient?: TypeTreeObject;
	} = {},
): TypeTreeObject => ({
	m_UseWorldSpace: overrides.useWorldSpace ?? false,
	m_Loop: overrides.loop ?? false,
	m_Positions: positions.map(([x, y, z]) => vec3(x, y, z)),
	m_Parameters: {
		widthMultiplier: overrides.widthMultiplier ?? 1,
		widthCurve: {
			m_Curve: overrides.widthCurve ?? [{ time: 0, value: 1, inSlope: 0, outSlope: 0 }],
		},
		colorGradient: overrides.colorGradient ?? {
			key0: { r: 1, g: 1, b: 1, a: 1 },
			key1: { r: 1, g: 1, b: 1, a: 1 },
			ctime0: 0,
			ctime1: 65535,
			atime0: 0,
			atime1: 65535,
			m_Mode: 0,
			m_NumColorKeys: 2,
			m_NumAlphaKeys: 2,
		},
		alignment: overrides.alignment ?? 0,
		textureMode: overrides.textureMode ?? 0,
	},
});

describe('readLineRenderer', () => {
	it('merges collinear points into one axial ribbon with gradient and width stops', () => {
		const runs = readLineRenderer(
			line(
				[
					[0, 0, 0],
					[0.5, 0, 0],
					[5, 0, 0],
					[6, 0, 0],
				],
				{
					widthMultiplier: 0.2,
					colorGradient: {
						key0: { r: 1, g: 1, b: 1, a: 0 },
						key1: { r: 1, g: 1, b: 1, a: 1 },
						key2: { r: 0, g: 1, b: 0, a: 0 },
						ctime0: 0,
						ctime1: 32768,
						ctime2: 65535,
						atime0: 0,
						atime1: 6553,
						atime2: 65535,
						m_Mode: 0,
						m_NumColorKeys: 3,
						m_NumAlphaKeys: 3,
					},
				},
			),
		);
		assert.equal(runs.length, 1);
		const [run] = runs;
		assert.equal(run.axial, true);
		assert.ok(typeof run.mesh === 'object' && run.mesh.kind === 'lineRibbon');
		// start, alpha key at ~0.1, color key at ~0.5, end
		assert.equal(run.mesh.samples.length, 4);
		assert.equal(run.mesh.samples[0].x, 0);
		assert.equal(run.mesh.samples[0].color[3], 0);
		assert.ok(Math.abs(run.mesh.samples[3].x - 6) < 1e-5);
		assert.ok(Math.abs(run.mesh.samples[3].width - 0.2) < 1e-5);
		assert.deepEqual(run.bounds, { center: [3, 0, 0], extents: [3, 0.1, 0.1] });
		const decoded = syntheticMesh(run.mesh);
		assert.equal(decoded.vertexCount, 8);
		assert.equal(decoded.indices.length, 18);
		assert.ok(decoded.colors !== null);
	});

	it('splits bent polylines into runs, closes loops, and skips world-space lines', () => {
		const bent = readLineRenderer(
			line(
				[
					[0, 0, 0],
					[2, 0, 0],
					[2, 3, 0],
				],
				{ alignment: 1, loop: true },
			),
		);
		assert.equal(bent.length, 3);
		assert.ok(bent.every((run) => !run.axial));
		assert.deepEqual(
			readLineRenderer(
				line(
					[
						[0, 0, 0],
						[1, 0, 0],
					],
					{ useWorldSpace: true },
				),
			),
			[],
		);
	});
});
