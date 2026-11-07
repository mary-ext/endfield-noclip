import type { LevelInteractive } from '@endfield-noclip/formats/endfield/level-interactives';
import {
	type BezierCurve,
	bezierPoint,
	type LevelSpline,
	splineCurves,
} from '@endfield-noclip/formats/endfield/level-splines';
import type { MemoryPackValue } from '@endfield-noclip/formats/endfield/memory-pack';
import { inverseTransformPoint, trsMatrix } from '@endfield-noclip/formats/unity/transform';

import { type ComponentKeys, componentOf, componentParams } from './component-params.ts';

// auto-moving platforms riding LevelData splines: docs/game-data/interactives.md#auto-moving-platforms

const CURVE_MOVE: ComponentKeys = {
	suffix: '_CustomCurveMoveComponentDataForMemoryPack',
	diffKey: 'Comp_InteractiveCustomCurveMove',
	type: 107,
};

/**
 * @param template a decoded interactive template
 * @returns whether it's an auto-moving platform: its curve move starts once its `state` is 1
 */
export const isAutoMovePlatform = (template: MemoryPackValue): boolean =>
	componentOf(template, '_InteractiveAutoMovePlatformComponentDataForMemoryPack') !== null &&
	componentOf(template, CURVE_MOVE.suffix) !== null;

/** what a curve move component does once started */
export interface CurveMove {
	/** the LevelData spline it rides; 0 names none */
	splineId: number;
	/** metres per second along the curve */
	speed: number;
	/** 0 stops at the target knot, 1 loops, 2 goes back and forth */
	mode: number;
	startIndex: number;
	targetIndex: number;
	/** where it starts, as a fraction of its trip from the start knot */
	initialPhase: number;
	/** `curve_move_direction` 1 turns it along the curve; 0 keeps its own rotation */
	followsTangent: boolean;
	/** knots it waits at (`curve_node_index_list`) */
	waitNodes: number;
	/** `tween` 1 eases in and out over `distance` */
	eased: boolean;
}

const toFloat = (bits: bigint): number => {
	const view = new DataView(new ArrayBuffer(4));
	view.setUint32(0, Number(BigInt.asUintN(32, bits)));
	return view.getFloat32(0);
};

/**
 * @param template the decoded template
 * @param row the placement
 * @returns what its curve move component does once started, or `null` without one
 */
export const curveMoveOf = (template: MemoryPackValue, row: LevelInteractive): CurveMove | null => {
	const params = componentParams(template, row, CURVE_MOVE);
	if (params === null) {
		return null;
	}
	const bits = (key: string): bigint => params.get(key)?.values[0]?.bits ?? 0n;
	const int = (key: string): number => Number(BigInt.asIntN(32, bits(key)));
	return {
		splineId: int('spline_id'),
		speed: toFloat(bits('speed')),
		mode: int('curve_move_mode'),
		startIndex: int('curve_start_index'),
		targetIndex: int('curve_target_index'),
		initialPhase: toFloat(bits('initial_phase')),
		followsTangent: int('curve_move_direction') === 1,
		waitNodes: params.get('curve_node_index_list')?.values.length ?? 0,
		eased: int('tween') === 1,
	};
};

/** a prefab root's matrices, in its placement's space, at evenly spaced times of a loop */
export interface RootPath {
	frameRate: number;
	matrices: Float32Array[];
}

/** samples per curve of the arc-length table, as many as Unity Splines' default */
const LUT_SAMPLES = 30;

/** frames per second of a sampled path; frames interpolate linearly, so slow platforms need few */
const PATH_FRAME_RATE = 15;

/** a curve's points at even parameter steps with the distance along it to each */
interface CurveTable {
	curve: BezierCurve;
	distances: Float64Array;
	length: number;
}

const tableOf = (curve: BezierCurve): CurveTable => {
	const distances = new Float64Array(LUT_SAMPLES + 1);
	let previous = bezierPoint(curve, 0);
	for (let i = 1; i <= LUT_SAMPLES; i++) {
		const point = bezierPoint(curve, i / LUT_SAMPLES);
		distances[i] =
			distances[i - 1] + Math.hypot(point[0] - previous[0], point[1] - previous[1], point[2] - previous[2]);
		previous = point;
	}
	return { curve, distances, length: distances[LUT_SAMPLES] };
};

/** @returns the point `distance` metres along a curve, by its arc-length table */
const pointAlong = (table: CurveTable, distance: number): [number, number, number] => {
	const { distances } = table;
	let i = 1;
	while (i < LUT_SAMPLES && distances[i] < distance) {
		i++;
	}
	const span = distances[i] - distances[i - 1];
	const local = span > 0 ? Math.min(Math.max((distance - distances[i - 1]) / span, 0), 1) : 0;
	return bezierPoint(table.curve, (i - 1 + local) / LUT_SAMPLES);
};

/**
 * the path an auto-moving platform loops through, as the game's curve move plays it once started: it rides
 * the spline at a constant speed from its start knot, its position replaced by the spline's (its rotation and
 * scale kept). with start and target knots equal it goes round the whole spline, closed for the trip
 *
 * @param spline the spline it rides
 * @param move its curve move parameters
 * @param placement its placement matrix (position, rotation, scale)
 * @returns its root's matrices in its placement's space, or why its motion isn't drawn
 */
export const curvePath = (
	spline: LevelSpline,
	move: CurveMove,
	placement: Float32Array,
): { path: RootPath } | { reason: string } => {
	if (move.speed <= 0) {
		return { reason: 'curve move speed is not above 0' };
	}
	if (move.followsTangent || move.waitNodes > 0 || move.eased) {
		return { reason: "curve move turns along the curve, waits at knots or eases, which aren't drawn" };
	}
	if (move.mode !== 1 && move.mode !== 2) {
		return { reason: `curve move mode ${move.mode} isn't drawn` };
	}
	const loop = move.startIndex === move.targetIndex;
	const tables = splineCurves(spline, spline.closed || loop).map(tableOf);
	const { startIndex, targetIndex } = move;
	if (
		tables.length === 0 ||
		startIndex < 0 ||
		targetIndex < 0 ||
		Math.max(startIndex, targetIndex) > tables.length
	) {
		return { reason: `spline ${spline.id} has no curves from knot ${startIndex} to ${targetIndex}` };
	}
	const total = tables.reduce((sum, table) => sum + table.length, 0);
	const lengthTo = (knot: number): number =>
		tables.slice(0, knot).reduce((sum, table) => sum + table.length, 0);
	const offset = lengthTo(startIndex);
	// a trip from a later knot to an earlier one runs backwards
	const direction = startIndex > targetIndex ? -1 : 1;
	const span = loop ? total : Math.abs(lengthTo(targetIndex) - offset);
	if (span <= 0) {
		return { reason: `spline ${spline.id} has no length` };
	}
	const period = ((move.mode === 2 ? 2 : 1) * span) / move.speed;
	const frameCount = Math.max(Math.round(period * PATH_FRAME_RATE), 2);
	const matrices: Float32Array[] = [];
	for (let frame = 0; frame < frameCount; frame++) {
		let travelled =
			(move.initialPhase * span + (frame / frameCount) * period * move.speed) %
			(move.mode === 2 ? 2 * span : span);
		if (travelled > span) {
			travelled = 2 * span - travelled;
		}
		let distance = (((offset + direction * travelled) % total) + total) % total;
		let curve = 0;
		while (curve < tables.length - 1 && distance > tables[curve].length) {
			distance -= tables[curve].length;
			curve++;
		}
		const point = pointAlong(tables[curve], distance);
		matrices.push(trsMatrix(inverseTransformPoint(placement, point), [0, 0, 0, 1], [1, 1, 1]));
	}
	return { path: { frameRate: frameCount / period, matrices } };
};
