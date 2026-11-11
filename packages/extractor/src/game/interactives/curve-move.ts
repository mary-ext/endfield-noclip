import type { LevelInteractive } from '@endfield-noclip/formats/endfield/level-interactives';
import {
	type BezierCurve,
	bezierPoint,
	type LevelSpline,
	splineCurves,
} from '@endfield-noclip/formats/endfield/level-splines';
import type { MemoryPackValue } from '@endfield-noclip/formats/endfield/memory-pack';
import type { RowPath } from '@endfield-noclip/package-format/instances';

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

/** a knot a curve move stops at as it passes */
export interface CurveWait {
	node: number;
	/** waits until the player comes within the component's `radius`, instead of for `time` */
	forNearby: boolean;
	/** seconds */
	time: number;
}

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
	/** the knots it stops at, in `curve_node_index_list` order */
	waits: CurveWait[];
	/**
	 * with `tween` 1, the metres (`distance`) over which each trip speeds up from 0.1 m/s and slows back down;
	 * `null` moves at a uniform speed
	 */
	ramp: number | null;
	/** whether `curve_segment_speed` or a speed curve (`use_curve_control_speed`) changes the speed */
	variesSpeed: boolean;
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
	const atoms = (key: string): { bits: bigint }[] => params.get(key)?.values ?? [];
	const bits = (key: string): bigint => atoms(key)[0]?.bits ?? 0n;
	const int = (key: string): number => Number(BigInt.asIntN(32, bits(key)));
	// the three lists are parallel, one entry per waiting knot
	const nearby = atoms('wait_for_nearby_list');
	const times = atoms('curve_node_wait_time_list');
	return {
		splineId: int('spline_id'),
		speed: toFloat(bits('speed')),
		mode: int('curve_move_mode'),
		startIndex: int('curve_start_index'),
		targetIndex: int('curve_target_index'),
		initialPhase: toFloat(bits('initial_phase')),
		followsTangent: int('curve_move_direction') === 1,
		waits: atoms('curve_node_index_list').map((atom, i) => ({
			node: Number(BigInt.asIntN(32, atom.bits)),
			forNearby: (nearby[i]?.bits ?? 0n) !== 0n,
			time: toFloat(times[i]?.bits ?? 0n),
		})),
		ramp: int('tween') === 1 ? toFloat(bits('distance')) : null,
		variesSpeed: atoms('curve_start_index_list').length > 0 || bits('use_curve_control_speed') !== 0n,
	};
};

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

/** the slowest a ramped trip moves, at its ends */
const RAMP_FLOOR = 0.1;

/** seconds per step of the simulated move, finer than a path frame so the speed ramp integrates closely */
const STEP = 1 / 240;

/** the longest loop drawn; a longer one is reported */
const MAX_PERIOD = 600;

/** one trip from a start knot to a target knot */
interface Trip {
	/** where it starts, in metres along the spline from knot 0 */
	offset: number;
	/** 1 along the knot order, -1 against it */
	direction: 1 | -1;
	length: number;
	/** the waiting knots it passes, by distance from its start */
	stops: { distance: number; wait: CurveWait }[];
}

/**
 * @param move its curve move parameters
 * @param length the trip's length
 * @param travelled metres into the trip
 * @returns its speed there, in metres per second: its own, ramped linearly with distance at both ends of the
 *   trip when it has a ramp
 */
const speedAt = (move: CurveMove, length: number, travelled: number): number => {
	if (move.ramp === null || length <= 0) {
		return move.speed;
	}
	const ramp = move.ramp * 2 > length ? length / 2 : move.ramp;
	const at = Math.min(Math.max(travelled, 0), length);
	let speed = move.speed;
	if (ramp > 1e-6 && at < ramp) {
		speed = RAMP_FLOOR + (move.speed - RAMP_FLOOR) * (at / ramp);
	} else if (ramp > 1e-6 && at >= length - ramp) {
		speed = ((length - at) / ramp) * move.speed;
	}
	return speed < RAMP_FLOOR ? RAMP_FLOOR : Math.min(speed, move.speed);
};

/**
 * the path an auto-moving platform loops through once started, by the trip, ramp and knot rules of the
 * auto-moving platforms page: its position is the spline's, its rotation and scale its own. a knot that waits
 * for the player parks it there, as while the player is away
 *
 * @param spline the spline it rides
 * @param move its curve move parameters
 * @param position where it's placed
 * @returns its offsets from its placement at evenly spaced times of the loop, or why its motion isn't drawn
 */
export const curvePath = (
	spline: LevelSpline,
	move: CurveMove,
	position: readonly [x: number, y: number, z: number],
): { path: RowPath } | { reason: string } => {
	if (move.speed <= 0) {
		return { reason: 'curve move speed is not above 0' };
	}
	if (move.followsTangent || move.variesSpeed) {
		return { reason: "curve move turns along the curve or varies its speed, which isn't drawn" };
	}
	if (move.mode !== 1 && move.mode !== 2) {
		return { reason: `curve move mode ${move.mode} isn't drawn` };
	}
	const loop = move.startIndex === move.targetIndex;
	const wraps = spline.closed || loop;
	const tables = splineCurves(spline, wraps).map(tableOf);
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
	const knotCount = wraps ? tables.length : tables.length + 1;
	const tripOf = (from: number, to: number): Trip => {
		const offset = lengthTo(from);
		// a trip from a later knot to an earlier one runs backwards
		const direction = from > to ? -1 : 1;
		const stops: Trip['stops'] = [];
		for (let knot = 0; knot < knotCount; knot++) {
			// a whole-spline trip fires only the knots from its start on (back to it, backwards); others those
			// between its ends
			const passes = loop
				? direction * (knot - from) >= 0
				: knot >= Math.min(from, to) && knot <= Math.max(from, to);
			const wait = move.waits.find((entry) => entry.node === knot);
			if (passes && wait !== undefined) {
				stops.push({ distance: Math.abs(lengthTo(knot) - offset), wait });
			}
		}
		stops.sort((a, b) => a.distance - b.distance);
		return { offset, direction, length: loop ? total : Math.abs(lengthTo(to) - offset), stops };
	};
	const trips =
		move.mode === 2
			? [tripOf(startIndex, targetIndex), tripOf(targetIndex, startIndex)]
			: [tripOf(startIndex, targetIndex)];
	if (trips[0].length <= 0) {
		return { reason: `spline ${spline.id} has no length` };
	}
	const offsetOf = (trip: Trip, travelled: number): [number, number, number] => {
		let distance = trip.offset + trip.direction * travelled;
		distance = wraps ? ((distance % total) + total) % total : Math.min(Math.max(distance, 0), total);
		let curve = 0;
		while (curve < tables.length - 1 && distance > tables[curve].length) {
			distance -= tables[curve].length;
			curve++;
		}
		const point = pointAlong(tables[curve], distance);
		return [point[0] - position[0], point[1] - position[1], point[2] - position[2]];
	};
	// one simulated step per entry: which trip, and how far into it as the step begins
	const steps: { trip: number; travelled: number }[] = [];
	for (const [index, trip] of trips.entries()) {
		let travelled = 0;
		let next = 0;
		for (;;) {
			while (next < trip.stops.length && trip.stops[next].distance <= travelled) {
				const { wait } = trip.stops[next];
				if (wait.forNearby) {
					const parked = offsetOf(trip, trip.stops[next].distance);
					return { path: { frameRate: 1, offsets: Float32Array.from(parked) } };
				}
				for (let held = Math.round(wait.time / STEP); held > 0; held--) {
					steps.push({ trip: index, travelled });
				}
				next++;
			}
			if (travelled >= trip.length) {
				break;
			}
			steps.push({ trip: index, travelled });
			travelled = Math.min(travelled + speedAt(move, trip.length, travelled) * STEP, trip.length);
			if (steps.length * STEP > MAX_PERIOD) {
				return { reason: `curve move loop is longer than ${MAX_PERIOD} s` };
			}
		}
	}
	// the loop starts where the first trip has covered its initial phase
	const phase = move.initialPhase * trips[0].length;
	const first =
		phase > 0
			? Math.max(
					steps.findIndex((step) => step.trip === 0 && step.travelled >= phase),
					0,
				)
			: 0;
	const period = steps.length * STEP;
	const frameCount = Math.max(Math.round(period * PATH_FRAME_RATE), 2);
	const offsets = new Float32Array(frameCount * 3);
	for (let frame = 0; frame < frameCount; frame++) {
		const step = steps[(first + Math.floor((frame * steps.length) / frameCount)) % steps.length];
		offsets.set(offsetOf(trips[step.trip], step.travelled), frame * 3);
	}
	return { path: { frameRate: frameCount / period, offsets } };
};
