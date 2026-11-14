import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readClipActivity, readClipEndPose, readClipMotion } from './animation-clip.ts';

const binding = (path: number, attribute: number, typeID = 4, isPPtrCurve = 0) => ({
	path,
	attribute,
	typeID,
	customType: 0,
	isPPtrCurve,
});
const clip = (bindings: ReturnType<typeof binding>[], stops: number[]) => ({
	m_Legacy: false,
	m_MuscleClip: { m_ValueArrayDelta: stops.map((stop) => ({ m_Start: 0, m_Stop: stop })) },
	m_ClipBindingConstant: { genericBindings: bindings },
});

test('a clip ends each Transform binding on its stop values, in binding order', () => {
	const pose = readClipEndPose(
		clip(
			// a door leaf's position, its parent's rotation, an Animator float, a sprite swap
			[binding(1869814087, 1), binding(3066451557, 2), binding(0, 0, 95), binding(7, 0, 212, 1)],
			[0, 3.7, 0, 0, 0, -Math.SQRT1_2, Math.SQRT1_2, 1],
		),
	);
	assert.deepEqual(
		[...pose.transforms],
		[
			[1869814087, [{ kind: 'position', value: [0, 3.7, 0] }]],
			[3066451557, [{ kind: 'rotation', value: [0, 0, -Math.SQRT1_2, Math.SQRT1_2] }]],
		],
	);
});

test('a clip whose values and bindings disagree is rejected', () => {
	assert.throws(() => readClipEndPose(clip([binding(1, 1)], [0, 1])), /fewer values/);
	assert.throws(() => readClipEndPose(clip([binding(1, 1)], [0, 1, 2, 3])), /4 values for 3 bound/);
	assert.throws(() => readClipEndPose(clip([binding(1, 5)], [0, 1, 2])), /attribute 5/);
});

test('a clip ends Euler rotations as quaternions and GameObjects on their activity', () => {
	const pose = readClipEndPose(
		clip(
			// a spinning ring (x −90°, then a full turn about z), a node switched off and one switched on
			[binding(11, 4), binding(12, 0x7c5a22f6, 1), binding(13, 0x7c5a22f6, 1)],
			[-90, 0, -360, 0, 1],
		),
	);
	const [rotation] = pose.transforms.get(11)!;
	assert.equal(rotation.kind, 'rotation');
	// a full turn about z flips the quaternion's sign, which is the same rotation
	const expected = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
	const sign = Math.sign(rotation.value[3]) * Math.sign(expected[3]);
	rotation.value.forEach((value, i) => assert.ok(Math.abs(value * sign - expected[i]) < 1e-9));
	assert.deepEqual(
		[...pose.active],
		[
			[12, false],
			[13, true],
		],
	);
});

test('a clip shows a GameObject when it starts or ends switched on', () => {
	const IS_ACTIVE = 0x7c5a22f6;
	const shown = clip(
		// a rotation's four values come first; then a node held off, one switched off, one switched on
		[binding(1, 2), binding(21, IS_ACTIVE, 1), binding(22, IS_ACTIVE, 1), binding(23, IS_ACTIVE, 1)],
		[0, 0, 0, 1, 0, 0, 1],
	);
	shown.m_MuscleClip.m_ValueArrayDelta[5].m_Start = 1;
	assert.deepEqual(
		[...readClipActivity(shown)],
		[
			[21, false],
			[22, true],
			[23, true],
		],
	);
});

test('a clip ends renderers on their material and renderer values', () => {
	// the blue talosite's idle loop: a glow's `_TintColorAlpha` and `_BlendTint.r`, and a shard's `m_Pivot.x`
	const material = (path: number, attribute: number) => ({ ...binding(path, attribute, 23), customType: 22 });
	const pose = readClipEndPose(
		clip([material(5, 2292127880), material(5, 1141402741), binding(6, 3640387206, 199)], [0.05, 2.174, 0]),
	);
	assert.deepEqual(pose.materials.get(5), [
		{ nameHash: 2292127880 & 0x0fff_ffff, component: null, value: 0.05 },
		{ nameHash: 1141402741 & 0x0fff_ffff, component: 0, value: 2.174 },
	]);
	assert.deepEqual([...pose.renderers.get(6)!], [[3640387206, 0]]);
	// the campfire's locking clip sets a vector's x component (kind 0)
	assert.deepEqual(readClipEndPose(clip([material(5, 109495689)], [0.5])).materials.get(5), [
		{ nameHash: 109495689, component: 0, value: 0.5 },
	]);
	assert.throws(() => readClipEndPose(clip([material(5, 0x9000_0000)], [1])), /material property kind 9/);
});

test('Euler rotations apply in the rotation order their binding records', () => {
	const rotationOf = (order: number, angles: number[]) =>
		readClipEndPose(clip([{ ...binding(1, 4), customType: order }], angles)).transforms.get(1)![0].value;
	const near = (actual: number[], expected: number[]) => {
		// q and −q are the same rotation
		const sign = Math.sign(actual.reduce((sum, value, i) => sum + value * expected[i], 0)) || 1;
		actual.forEach((value, i) =>
			assert.ok(Math.abs(value * sign - expected[i]) < 1e-6, `${actual.join()} ≠ ${expected.join()}`),
		);
	};
	// ZXY (4), Quaternion.Euler's: x 90° then y 90° gives (0.5, 0.5, −0.5, 0.5)
	near(rotationOf(4, [90, 90, 0]), [0.5, 0.5, -0.5, 0.5]);
	// XYZ (0): the locked chest's metal band B_jinshubaozhuang_L, saved +90° about x
	near(rotationOf(0, [270, 180, -180]), [Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
	// read in ZXY instead it would turn −90°
	near(rotationOf(4, [270, 180, -180]), [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
	assert.throws(() => rotationOf(6, [0, 0, 0]), /rotation order 6/);
});

/** a clip with curves: streamed words, dense frames (16-bit when `packed`), constants */
const motionClip = (options: {
	bindings: ReturnType<typeof binding>[];
	streamed: { curveCount: number; words: number[] };
	dense: { curveCount: number; frames: number[][]; packed: boolean; positionFactor?: number };
	constants: number[];
	stop: number;
}) => {
	const { dense } = options;
	const samples = dense.frames.flat();
	const packed = new Uint8Array(dense.packed ? samples.length * 2 : 0);
	const factorOf = (curve: number): number => {
		const kind = options.bindings.flatMap((b) =>
			Array.from({ length: b.attribute === 2 ? 4 : 3 }, () => b.attribute),
		)[options.streamed.curveCount + curve];
		return kind === 1 ? (dense.positionFactor ?? 1) : 1;
	};
	if (dense.packed) {
		const view = new DataView(packed.buffer);
		samples.forEach((value, i) => {
			view.setUint16(i * 2, Math.round((value / factorOf(i % dense.curveCount)) * 32_767.5 + 32_767.5), true);
		});
	}
	return {
		m_Legacy: false,
		m_SampleRate: 30,
		m_AclCompressedBuffer: { OutputTrackCount: 0, FloatCurveCount: 0 },
		m_MuscleClip: {
			m_StartTime: 0,
			m_StopTime: options.stop,
			m_LoopTime: true,
			m_Clip: {
				data: {
					m_StreamedClip: {
						data: Uint32Array.from(options.streamed.words),
						curveCount: options.streamed.curveCount,
					},
					m_DenseClip: {
						m_FrameCount: dense.frames.length,
						m_CurveCount: dense.curveCount,
						m_SampleRate: 1,
						m_BeginTime: 0,
						m_SampleArray: dense.packed ? new Float32Array(0) : Float32Array.from(samples),
						m_ACLType: dense.packed ? 16 : 0,
						m_ACLArray: packed,
						m_PositionFactor: dense.positionFactor ?? 1,
						m_EulerFactor: 1,
						m_ScaleFactor: 1,
						m_FloatFactor: 1,
					},
					m_ConstantClip: { data: Float32Array.from(options.constants) },
				},
			},
		},
		m_ClipBindingConstant: { genericBindings: options.bindings },
	};
};

/** @returns a float's bits as a streamed clip word */
const word = (value: number): number => new Uint32Array(Float32Array.of(value).buffer)[0];

test('clip playback samples streamed cubics, interpolated dense frames and constants in binding order', () => {
	// streamed frames (time, key count, then index and a, b, c, value per key): the −FLT_MAX frame holds all
	// three curves at 0, then node 1's x rises 0 → 2 over a second (the cubic's c·dt) and holds
	// prettier-ignore
	const words = [
		word(-3.4028234663852886e38), 3,
		0, word(0), word(0), word(0), word(0),
		1, word(0), word(0), word(0), word(0),
		2, word(0), word(0), word(0), word(0),
		word(0), 1, 0, word(0), word(0), word(2), word(0),
		word(1), 1, 0, word(0), word(0), word(0), word(2),
		word(Infinity), 0,
	];
	const motion = readClipMotion(
		motionClip({
			// node 1's position (streamed), node 2's position (dense, 16-bit) and node 2's rotation (constant)
			bindings: [binding(1, 1), binding(2, 1), binding(2, 2)],
			streamed: { curveCount: 3, words },
			dense: {
				curveCount: 3,
				frames: [
					[0, 0, 0],
					[1, -1, 0.5],
				],
				packed: true,
				positionFactor: 2,
			},
			constants: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
			stop: 1,
		}),
	);
	assert.equal(motion.duration, 1);
	assert.equal(motion.loops, true);
	assert.deepEqual(motion.paths, [1, 2]);
	const half = motion.sample(0.5);
	const close = (got: readonly number[], expected: number[]) =>
		expected.forEach((value, i) =>
			assert.ok(Math.abs(got[i] - value) < 1e-4, `${got.join()} vs ${expected.join()}`),
		);
	close(half.get(1)![0].value, [1, 0, 0]);
	// halfway between the dense frames
	close(half.get(2)![0].value, [0.5, -0.5, 0.25]);
	close(half.get(2)![1].value, [0, 0, Math.SQRT1_2, Math.SQRT1_2]);
	close(motion.sample(1).get(1)![0].value, [2, 0, 0]);
});

test('clip playback samples the material properties a clip sets on a renderer', () => {
	// the water a Qingbo waterwheel pours: `_displayFrame` (a float) climbs 60 a second from 1, and
	// `_TintColorAlpha` stays 1
	const material = (path: number, attribute: number) => ({ ...binding(path, attribute, 23), customType: 22 });
	// prettier-ignore
	const words = [
		word(-3.4028234663852886e38), 1, 0, word(0), word(0), word(0), word(1),
		word(0), 1, 0, word(0), word(0), word(60), word(1),
		word(Infinity), 0,
	];
	const motion = readClipMotion(
		motionClip({
			bindings: [material(9, 0x882d_ec3a), material(9, 0x889f_1888)],
			streamed: { curveCount: 1, words },
			dense: { curveCount: 0, frames: [], packed: false },
			constants: [1],
			stop: 2,
		}),
	);
	assert.deepEqual(motion.paths, []);
	assert.deepEqual(motion.materials?.(0.5).get(9), [
		{ nameHash: 0x082d_ec3a, component: null, value: 31 },
		{ nameHash: 0x089f_1888, component: null, value: 1 },
	]);
	assert.equal(motion.materials?.(2).get(9)?.[0].value, 121);
});

test('clip playback reads float dense frames and rejects blocks that disagree with the bindings', () => {
	const options = {
		bindings: [binding(3, 3)],
		streamed: { curveCount: 0, words: [] },
		dense: {
			curveCount: 3,
			frames: [
				[1, 1, 1],
				[3, 3, 3],
			],
			packed: false,
		},
		constants: [],
		stop: 1,
	};
	const [scale] = readClipMotion(motionClip(options)).sample(0.25).get(3)!;
	assert.deepEqual(scale, { kind: 'scale', value: [1.5, 1.5, 1.5] });
	assert.throws(() => readClipMotion(motionClip({ ...options, constants: [1] })), /4 curves for 3 bound/);
});
