import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import {
	booleanField,
	colorField,
	numberField,
	objectField,
	objectsField,
	type Aabb,
} from '@endfield-noclip/formats/unity/values';

import { compareNumbers } from '../../compare.ts';
import type { LineRibbonSample, SyntheticMesh } from '../../pack/convert/synthetic-mesh.ts';

// Unity's `LineRenderer` (class 120): polylines baked into synthetic ribbon meshes along `+x`, with
// `ChainFlags.BillboardAxial` turning view-aligned ribbons about their segment axis to face the camera.

/** Unity's class id of `LineRenderer` */
export const LINE_RENDERER_CLASS = 120;

/** Unity's `LineAlignment` */
const LineAlignment = { View: 0, TransformZ: 1 } as const;

/** Unity's `LineTextureMode` */
const LineTextureMode = {
	Stretch: 0,
	Tile: 1,
	DistributePerSegment: 2,
	RepeatPerSegment: 3,
} as const;

/** one straight run of a `LineRenderer`, in the GameObject's local frame */
export interface LineRendererRun {
	/** transform from ribbon space (along `+x` from 0 to run length) to the GameObject's local space */
	matrix: Float32Array;
	mesh: SyntheticMesh;
	bounds: Aabb;
	/** true for `LineAlignment.View`, false for `LineAlignment.TransformZ` */
	axial: boolean;
}

interface CurveKey {
	time: number;
	value: number;
	inSlope: number;
	outSlope: number;
}

interface ColorStop {
	time: number;
	r: number;
	g: number;
	b: number;
}

interface AlphaStop {
	time: number;
	a: number;
}

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

const evalCurve = (keys: readonly CurveKey[], t: number): number => {
	if (keys.length === 0) {
		return 1;
	}
	if (keys.length === 1 || t <= keys[0].time) {
		return keys[0].value;
	}
	const last = keys[keys.length - 1];
	if (t >= last.time) {
		return last.value;
	}
	for (let i = 0; i < keys.length - 1; i++) {
		const a = keys[i];
		const b = keys[i + 1];
		if (t > b.time) {
			continue;
		}
		const dt = b.time - a.time;
		if (dt <= 0) {
			return b.value;
		}
		const u = (t - a.time) / dt;
		const u2 = u * u;
		const u3 = u2 * u;
		return (
			(2 * u3 - 3 * u2 + 1) * a.value +
			(u3 - 2 * u2 + u) * dt * a.outSlope +
			(-2 * u3 + 3 * u2) * b.value +
			(u3 - u2) * dt * b.inSlope
		);
	}
	return last.value;
};

const readGradient = (
	gradient: TypeTreeObject,
): { color: ColorStop[]; alpha: AlphaStop[]; fixed: boolean } => {
	const numColor = Math.min(Math.max(numberField(gradient, 'm_NumColorKeys'), 0), 8);
	const numAlpha = Math.min(Math.max(numberField(gradient, 'm_NumAlphaKeys'), 0), 8);
	const fixed = numberField(gradient, 'm_Mode') === 1;
	const color: ColorStop[] = [];
	const alpha: AlphaStop[] = [];
	for (let i = 0; i < numColor; i++) {
		const key = colorField(gradient, `key${i}`);
		color.push({ time: numberField(gradient, `ctime${i}`) / 65535, r: key[0], g: key[1], b: key[2] });
	}
	for (let i = 0; i < numAlpha; i++) {
		const key = colorField(gradient, `key${i}`);
		alpha.push({ time: numberField(gradient, `atime${i}`) / 65535, a: key[3] });
	}
	return { color, alpha, fixed };
};

const evalGradient = (
	{ color, alpha, fixed }: ReturnType<typeof readGradient>,
	t: number,
): [number, number, number, number] => {
	let r = 1;
	let g = 1;
	let b = 1;
	if (color.length === 1 || (color.length > 1 && t <= color[0].time)) {
		({ r, g, b } = color[0]);
	} else if (color.length > 1) {
		const last = color[color.length - 1];
		if (t >= last.time) {
			({ r, g, b } = last);
		} else {
			for (let i = 0; i < color.length - 1; i++) {
				const a = color[i];
				const c = color[i + 1];
				if (t > c.time) {
					continue;
				}
				if (fixed || c.time <= a.time) {
					({ r, g, b } = c);
				} else {
					const f = (t - a.time) / (c.time - a.time);
					r = a.r + (c.r - a.r) * f;
					g = a.g + (c.g - a.g) * f;
					b = a.b + (c.b - a.b) * f;
				}
				break;
			}
		}
	}
	let aOut = 1;
	if (alpha.length === 1 || (alpha.length > 1 && t <= alpha[0].time)) {
		aOut = alpha[0].a;
	} else if (alpha.length > 1) {
		const last = alpha[alpha.length - 1];
		if (t >= last.time) {
			aOut = last.a;
		} else {
			for (let i = 0; i < alpha.length - 1; i++) {
				const k0 = alpha[i];
				const k1 = alpha[i + 1];
				if (t > k1.time) {
					continue;
				}
				if (fixed || k1.time <= k0.time) {
					aOut = k1.a;
				} else {
					const f = (t - k0.time) / (k1.time - k0.time);
					aOut = k0.a + (k1.a - k0.a) * f;
				}
				break;
			}
		}
	}
	return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b), aOut];
};

const cross = (
	a: readonly [number, number, number],
	b: readonly [number, number, number],
): [number, number, number] => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0],
];

const frameMatrix = (
	origin: readonly [number, number, number],
	xAxis: readonly [number, number, number],
): Float32Array => {
	// reference +z so TransformZ lines lie in the GameObject's XY plane
	const ref: [number, number, number] = Math.abs(xAxis[2]) < 0.99 ? [0, 0, 1] : [0, 1, 0];
	const rawY = cross(ref, xAxis);
	const yLen = Math.hypot(rawY[0], rawY[1], rawY[2]) || 1;
	const yAxis: [number, number, number] = [rawY[0] / yLen, rawY[1] / yLen, rawY[2] / yLen];
	const zAxis = cross(xAxis, yAxis);
	const m = new Float32Array(16);
	m[0] = xAxis[0];
	m[1] = xAxis[1];
	m[2] = xAxis[2];
	m[4] = yAxis[0];
	m[5] = yAxis[1];
	m[6] = yAxis[2];
	m[8] = zAxis[0];
	m[9] = zAxis[1];
	m[10] = zAxis[2];
	m[12] = origin[0];
	m[13] = origin[1];
	m[14] = origin[2];
	m[15] = 1;
	return m;
};

/**
 * reads a local-space `LineRenderer` into one or more straight ribbon runs. world-space lines and degenerate
 * polylines produce no runs
 *
 * @param data the `LineRenderer`'s serialized fields
 * @returns straight ribbon runs in the GameObject's local frame
 */
export const readLineRenderer = (data: TypeTreeObject): LineRendererRun[] => {
	if (booleanField(data, 'm_UseWorldSpace')) {
		return [];
	}
	const rawPositions = objectsField(data, 'm_Positions').map((p): [number, number, number] => [
		numberField(p, 'x'),
		numberField(p, 'y'),
		numberField(p, 'z'),
	]);
	if (rawPositions.length < 2) {
		return [];
	}
	if (booleanField(data, 'm_Loop')) {
		rawPositions.push(rawPositions[0]);
	}
	const params = objectField(data, 'm_Parameters');
	const widthMultiplier = numberField(params, 'widthMultiplier');
	const widthKeys: CurveKey[] = objectsField(objectField(params, 'widthCurve'), 'm_Curve').map((key) => ({
		time: numberField(key, 'time'),
		value: numberField(key, 'value'),
		inSlope: numberField(key, 'inSlope'),
		outSlope: numberField(key, 'outSlope'),
	}));
	const gradient = readGradient(objectField(params, 'colorGradient'));
	const alignment = numberField(params, 'alignment');
	const textureMode = numberField(params, 'textureMode');
	if (alignment !== LineAlignment.View && alignment !== LineAlignment.TransformZ) {
		return [];
	}

	interface Segment {
		start: [number, number, number];
		end: [number, number, number];
		dir: [number, number, number];
		s0: number;
		s1: number;
		index: number;
	}
	const segments: Segment[] = [];
	let totalLen = 0;
	for (let i = 0; i < rawPositions.length - 1; i++) {
		const start = rawPositions[i];
		const end = rawPositions[i + 1];
		const dx = end[0] - start[0];
		const dy = end[1] - start[1];
		const dz = end[2] - start[2];
		const len = Math.hypot(dx, dy, dz);
		if (len <= 1e-6) {
			continue;
		}
		segments.push({
			start,
			end,
			dir: [dx / len, dy / len, dz / len],
			s0: totalLen,
			s1: totalLen + len,
			index: i,
		});
		totalLen += len;
	}
	if (segments.length === 0 || totalLen <= 1e-6) {
		return [];
	}

	// merge consecutive collinear segments into one straight run (unless U repeats per segment)
	const runs: {
		start: [number, number, number];
		dir: [number, number, number];
		s0: number;
		s1: number;
		seg0: number;
		seg1: number;
	}[] = [];
	for (const seg of segments) {
		const prev = runs.at(-1);
		if (
			prev !== undefined &&
			textureMode !== LineTextureMode.RepeatPerSegment &&
			prev.dir[0] * seg.dir[0] + prev.dir[1] * seg.dir[1] + prev.dir[2] * seg.dir[2] >= 0.9999
		) {
			prev.s1 = seg.s1;
			prev.seg1 = seg.index + 1;
		} else {
			runs.push({
				start: seg.start,
				dir: seg.dir,
				s0: seg.s0,
				s1: seg.s1,
				seg0: seg.index,
				seg1: seg.index + 1,
			});
		}
	}

	const keyTimes = [
		...gradient.color.map((k) => k.time),
		...gradient.alpha.map((k) => k.time),
		...widthKeys.map((k) => k.time),
	];
	const segmentCount = rawPositions.length - 1;
	const tileDivisor = Math.max(widthMultiplier, 1e-4);

	return runs.map((run) => {
		const t0 = run.s0 / totalLen;
		const t1 = run.s1 / totalLen;
		const ts = [t0, t1];
		for (const time of keyTimes) {
			if (time > t0 + 1e-5 && time < t1 - 1e-5) {
				ts.push(time);
			}
		}
		if (widthKeys.length > 1) {
			const steps = Math.ceil((t1 - t0) / 0.125);
			for (let k = 1; k < steps; k++) {
				ts.push(t0 + ((t1 - t0) * k) / steps);
			}
		}
		ts.sort(compareNumbers);
		const uniqueTs: number[] = [];
		for (const t of ts) {
			if (uniqueTs.length === 0 || t - uniqueTs[uniqueTs.length - 1] > 1e-5) {
				uniqueTs.push(t);
			}
		}
		const runLen = run.s1 - run.s0;
		let maxHalfWidth = 0;
		const samples: LineRibbonSample[] = uniqueTs.map((t) => {
			const x = (t - t0) * totalLen;
			const width = Math.max(widthMultiplier * evalCurve(widthKeys, t), 0);
			maxHalfWidth = Math.max(maxHalfWidth, width * 0.5);
			let u: number;
			switch (textureMode) {
				case LineTextureMode.Tile: {
					u = (t * totalLen) / tileDivisor;
					break;
				}
				case LineTextureMode.DistributePerSegment: {
					const frac = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
					u = (run.seg0 + (run.seg1 - run.seg0) * frac) / segmentCount;
					break;
				}
				case LineTextureMode.RepeatPerSegment: {
					u = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
					break;
				}
				default: {
					u = t;
					break;
				}
			}
			return { x, width, u, color: evalGradient(gradient, t) };
		});
		const bounds: Aabb = {
			center: [runLen * 0.5, 0, 0],
			extents: [runLen * 0.5, maxHalfWidth, maxHalfWidth],
		};
		return {
			matrix: frameMatrix(run.start, run.dir),
			mesh: { kind: 'lineRibbon', samples },
			bounds,
			axial: alignment === LineAlignment.View,
		};
	});
};
