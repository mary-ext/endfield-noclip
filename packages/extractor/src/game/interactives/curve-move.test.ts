import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { levelInteractiveFromValue } from '@endfield-noclip/formats/endfield/level-interactives';
import { readLevelSplines } from '@endfield-noclip/formats/endfield/level-splines';
import type { MemoryPackValue } from '@endfield-noclip/formats/endfield/memory-pack';
import { multiplyMatrices, transformPoint, trsMatrix } from '@endfield-noclip/formats/unity/transform';

import { curveMoveOf, curvePath, isAutoMovePlatform } from './curve-move.ts';

const param = (key: string, type: number, ...atoms: (string | number)[]): MemoryPackValue => ({
	$type: 'Beyond_Gameplay_ParamKeyValueForMemoryPack',
	key,
	value: {
		$type: 'Beyond_Gameplay_ParamValueForMemoryPack',
		type,
		valueArray: atoms.map((atom) => ({
			$type: 'Beyond_Gameplay_ParamValueAtomForMemoryPack',
			valueBit64: typeof atom === 'number' ? String(atom) : '0',
			valueString: typeof atom === 'string' ? atom : null,
		})),
	},
});

/** a float's bits as the 64-bit atom holds them */
const float = (value: number): number => {
	const view = new DataView(new ArrayBuffer(4));
	view.setFloat32(0, value);
	return view.getUint32(0);
};

/** `int_platform_automove`'s components, trimmed to the ones these tests read */
const template: MemoryPackValue = {
	$type: 'Beyond_Gameplay_InteractiveTemplateDataForMemoryPack',
	componentList: [
		{
			$type: 'Beyond_Gameplay_Core_InteractiveAutoMovePlatformComponentDataForMemoryPack',
			propertyList: [param('destroy_self', 1, 0)],
		},
		{
			$type: 'Beyond_Gameplay_Core_CustomCurveMoveComponentDataForMemoryPack',
			propertyList: [
				param('spline_id', 3, 0),
				param('speed', 5, 0),
				param('curve_move_mode', 3, 1),
				param('curve_start_index', 3, 0),
				param('curve_target_index', 3, 0),
				param('initial_phase', 5, 0),
				param('curve_node_index_list', 4),
			],
		},
	],
	templateVariant: [
		[
			'int_platform_automove_floatingtower',
			{
				componentDiffProperties: [
					['Comp_InteractiveCustomCurveMove', { value: [param('initial_phase', 5, float(0.5))] }],
				],
			},
		],
	],
};

/** a script's platform as indie_race001's level scripts place it */
const scriptRow = (key: string, curve: MemoryPackValue[]): MemoryPackValue => ({
	$type: 'Beyond_Gameplay_LevelInteractiveDataForMemoryPack',
	entityDataIdKey: key,
	createState: 0,
	levelLogicId: '0',
	position: [-116, 144.5, 275.8],
	rotation: [0, 0, 0],
	scale: [1, 1, 1],
	componentProperties: [[107, curve]],
	isLocked: false,
	modelScale: 0,
	properties: [param('state', 3, 1)],
});

/** spline 25002 of indie_race001: a closed 15 m × 7 m loop on its side, turned a quarter about y */
const levelData: MemoryPackValue = {
	splines: [
		{
			splineId: 25002,
			position: [-101.73583984375, 137.5, 275.7559814453125],
			rotation: [0, 90, 0],
			closed: true,
			knots: [
				[0, 0, 0],
				[0, 0, -15],
				[0, 7, -15],
				[0, 7, 0],
			].map(([x, y, z]) => ({
				$type: 'BezierKnot',
				Position: { x, y, z },
				TangentIn: { x: 0, y: 0, z: 0 },
				TangentOut: { x: 0, y: 0, z: 0 },
				Rotation: { value: { x: 0, y: 0, z: 0, w: 1 } },
				Width: 2,
			})),
			keyNodeIndexList: [],
			knotProgresses: [],
		},
	],
};

const near = (
	actual: readonly number[],
	expected: readonly number[],
	what: string,
	tolerance = 1e-3,
): void => {
	for (const [i, value] of expected.entries()) {
		assert.ok(Math.abs(actual[i] - value) <= tolerance, `${what}: ${actual.join()} ≠ ${expected.join()}`);
	}
};

/** how far a 4 m/s platform moves between two of its 15 frames per second: the nearest frame's error */
const STEP = 4 / 15;

describe('auto-moving platforms', () => {
	const [spline] = readLevelSplines(levelData);
	const curve = [
		param('spline_id', 3, 25002),
		param('speed', 5, float(4)),
		param('curve_start_index', 3, 2),
		param('curve_target_index', 3, 2),
	];

	it('reads a script row, its template and its curve move with the placement overriding the template', () => {
		const row = levelInteractiveFromValue(scriptRow('int_platform_automove_5m_5m', curve), 1280002500240001n);
		assert.equal(row.template, 'int_platform_automove_5m_5m');
		assert.equal(row.properties[0].values[0].bits, 1n);
		assert.ok(isAutoMovePlatform(template));
		assert.deepEqual(curveMoveOf(template, row), {
			splineId: 25002,
			speed: 4,
			mode: 1,
			startIndex: 2,
			targetIndex: 2,
			initialPhase: 0,
			followsTangent: false,
			waitNodes: 0,
			eased: false,
		});
	});

	it('takes a variant diff over the template and under the placement', () => {
		const row = levelInteractiveFromValue(scriptRow('int_platform_automove_floatingtower', []), 1n);
		assert.equal(curveMoveOf(template, row)?.initialPhase, 0.5);
	});

	it('loops round the whole spline from its start knot at its speed, keeping its rotation', () => {
		const row = levelInteractiveFromValue(scriptRow('int_platform_automove_5m_5m', curve), 1n);
		const move = curveMoveOf(template, row)!;
		const placement = trsMatrix(row.position, [0, Math.SQRT1_2, 0, Math.SQRT1_2], [2, 2, 2]);
		const result = curvePath(spline, move, placement);
		assert.ok('path' in result);
		const { matrices, frameRate } = result.path;
		// 15 + 7 + 15 + 7 metres at 4 m/s
		near([matrices.length / frameRate], [11], 'period');
		const world = (frame: number) => transformPoint(multiplyMatrices(placement, matrices[frame]), [0, 0, 0]);
		// knot 2, (0, 7, -15) turned a quarter about y
		near(world(0), [-116.736, 144.5, 275.756], 'start');
		// 15 m on, along the top edge to knot 3, then down towards knot 0
		near(world(Math.round((15 / 44) * matrices.length)), [-101.736, 144.5, 275.756], 'knot 3', STEP);
		near(world(Math.round((18.5 / 44) * matrices.length)), [-101.736, 141, 275.756], 'half way down', STEP);
		// the path moves the root only
		near([matrices[1][0], matrices[1][5], matrices[1][10]], [1, 1, 1], 'unturned');
	});

	it('goes back and forth between different knots in mode 2', () => {
		const row = levelInteractiveFromValue(
			scriptRow('int_platform_automove_5m_5m', [
				...curve.slice(0, 2),
				param('curve_start_index', 3, 0),
				param('curve_target_index', 3, 1),
				param('curve_move_mode', 3, 2),
			]),
			1n,
		);
		const move = curveMoveOf(template, row)!;
		const result = curvePath(spline, move, trsMatrix([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]));
		assert.ok('path' in result);
		const { matrices, frameRate } = result.path;
		near([matrices.length / frameRate], [7.5], 'period');
		const at = (frame: number) => [matrices[frame][12], matrices[frame][13], matrices[frame][14]];
		near(at(Math.round(matrices.length / 2)), [-116.736, 137.5, 275.756], 'target knot', STEP);
		near(at(Math.round(matrices.length / 4)), [-109.236, 137.5, 275.756], 'midway', STEP);
	});

	it("reports what it can't draw", () => {
		const row = levelInteractiveFromValue(
			scriptRow('int_platform_automove_5m_5m', [param('spline_id', 3, 25002)]),
			1n,
		);
		const result = curvePath(
			spline,
			curveMoveOf(template, row)!,
			trsMatrix([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]),
		);
		assert.deepEqual(result, { reason: 'curve move speed is not above 0' });
	});
});
