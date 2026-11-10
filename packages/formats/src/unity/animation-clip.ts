import { FormatError } from '../binary/binary-reader.ts';

import { ACL_TRANSFORM_STRIDE, decodeAclTransforms } from './acl.ts';
import type { TypeTreeObject } from './type-tree.ts';
import {
	arrayField,
	booleanField,
	bytesField,
	isObject,
	numberField,
	objectField,
	optionalNumberField,
} from './values.ts';

/** a Transform property a clip animates, at one time of the clip */
export type ClipTransformValue =
	| { kind: 'position' | 'scale'; value: [number, number, number] }
	| { kind: 'rotation'; value: [number, number, number, number] };

/**
 * a material property a clip sets on a renderer, at the clip's last frame. the binding names the property by
 * the low 28 bits of the CRC32 of its name, so the reader of the renderer's materials resolves it
 */
export interface ClipMaterialValue {
	/** the low 28 bits of the CRC32 of the property's name */
	nameHash: number;
	/** the vector or colour component (0 to 3 for x/r to w/a), `null` for a float property */
	component: number | null;
	value: number;
}

/** what a clip leaves each animated Transform and GameObject at */
export interface ClipEndPose {
	/** by binding path: CRC32 of the GameObject's path below the Animator, `/`-joined, 0 for the Animator's own */
	transforms: Map<number, ClipTransformValue[]>;
	/** whether each GameObject whose activity the clip animates ends switched on, by binding path */
	active: Map<number, boolean>;
	/** material properties the clip sets on each renderer, by binding path */
	materials: Map<number, ClipMaterialValue[]>;
	/**
	 * other renderer properties the clip sets, by binding path, then by attribute (the CRC32 of the property's
	 * path, such as `m_Pivot.x`)
	 */
	renderers: Map<number, Map<number, number>>;
}

/** Unity's `ClassID(Transform)` in a generic binding */
const TRANSFORM = 4;
/** Unity's `ClassID(GameObject)` in a generic binding */
const GAME_OBJECT = 1;
/** a GameObject binding's attribute for `m_IsActive`: CRC32 of the property name */
const IS_ACTIVE = 0x7c5a_22f6;
/** Unity's `ClassID` of mesh, skinned mesh and particle system renderers in a generic binding */
const RENDERERS = new Set([23, 137, 199]);
/** a generic binding's `customType` for a material property */
const MATERIAL_PROPERTY = 22;
/** a material binding's top four attribute bits: vector components x to w (0–3), colour r to a (4–7), a float */
const MATERIAL_FLOAT = 8;

const DEGREES = Math.PI / 180;

/**
 * Unity's `RotationOrder` by value, as the axes in the order they're applied. an Euler binding's `customType`
 * holds it; `Quaternion.Euler` uses ZXY (4)
 */
const ROTATION_ORDERS = [
	[0, 1, 2],
	[0, 2, 1],
	[1, 2, 0],
	[1, 0, 2],
	[2, 0, 1],
	[2, 1, 0],
] as const;

/** @returns the `RotationOrder` an Euler binding records in its `customType` */
const rotationOrder = (binding: TypeTreeObject): number => {
	const order = numberField(binding, 'customType');
	if (ROTATION_ORDERS[order] === undefined) {
		throw new FormatError(`unknown AnimationClip Euler rotation order ${order}`);
	}
	return order;
};

/**
 * @param angles rotations about x, y and z, degrees
 * @param order a Unity `RotationOrder`, naming the axes in the order they're applied
 * @returns the rotation as a quaternion
 */
const eulerQuaternion = (
	angles: readonly [number, number, number],
	order: number,
): [number, number, number, number] => {
	let q: [number, number, number, number] = [0, 0, 0, 1];
	for (const axis of ROTATION_ORDERS[order]) {
		const half = angles[axis] * DEGREES * 0.5;
		const r: [number, number, number, number] = [0, 0, 0, Math.cos(half)];
		r[axis] = Math.sin(half);
		// a later axis applies after: r · q
		q = [
			r[3] * q[0] + r[0] * q[3] + r[1] * q[2] - r[2] * q[1],
			r[3] * q[1] - r[0] * q[2] + r[1] * q[3] + r[2] * q[0],
			r[3] * q[2] + r[0] * q[1] - r[1] * q[0] + r[2] * q[3],
			r[3] * q[3] - r[0] * q[0] - r[1] * q[1] - r[2] * q[2],
		];
	}
	return q;
};

/**
 * reads the values a generic (non-humanoid) AnimationClip ends on, from the stop values the muscle clip
 * stores in binding order (`m_ValueArrayDelta`), so without sampling curves
 * (`docs/game-data/animation.md#bindings`)
 *
 * @param clip AnimationClip type-tree object
 * @returns the end value of every animated Transform property, GameObject activity and renderer property
 * @throws {FormatError} for legacy clips, unknown Transform attributes or material property kinds, or a value
 *   count that doesn't match the bindings
 */
export const readClipEndPose = (clip: TypeTreeObject): ClipEndPose => {
	if (booleanField(clip, 'm_Legacy')) {
		throw new FormatError('legacy AnimationClip');
	}
	const deltas = arrayField(objectField(clip, 'm_MuscleClip'), 'm_ValueArrayDelta');
	const stops = deltas.map((delta) => {
		if (!isObject(delta)) {
			throw new FormatError('invalid AnimationClip value delta');
		}
		return numberField(delta, 'm_Stop');
	});
	const transforms = new Map<number, ClipTransformValue[]>();
	const active = new Map<number, boolean>();
	const materials = new Map<number, ClipMaterialValue[]>();
	const renderers = new Map<number, Map<number, number>>();
	let at = 0;
	for (const binding of arrayField(objectField(clip, 'm_ClipBindingConstant'), 'genericBindings')) {
		if (!isObject(binding)) {
			throw new FormatError('invalid AnimationClip binding');
		}
		if (numberField(binding, 'isPPtrCurve') !== 0) {
			continue;
		}
		const path = numberField(binding, 'path') >>> 0;
		const attribute = numberField(binding, 'attribute');
		const type = numberField(binding, 'typeID');
		if (type === GAME_OBJECT && attribute >>> 0 === IS_ACTIVE && at < stops.length) {
			active.set(path, stops[at] !== 0);
		}
		if (RENDERERS.has(type) && at < stops.length) {
			if (numberField(binding, 'customType') === MATERIAL_PROPERTY) {
				const kind = attribute >>> 28;
				if (kind > MATERIAL_FLOAT) {
					throw new FormatError(`unsupported AnimationClip material property kind ${kind}`);
				}
				materials
					.getOrInsertComputed(path, () => [])
					.push({
						nameHash: attribute & 0x0fff_ffff,
						component: kind === MATERIAL_FLOAT ? null : kind % 4,
						value: stops[at],
					});
			} else {
				renderers.getOrInsertComputed(path, () => new Map()).set(attribute >>> 0, stops[at]);
			}
		}
		if (type !== TRANSFORM) {
			at++;
			continue;
		}
		const next = (): number => {
			if (at >= stops.length) {
				throw new FormatError('AnimationClip has fewer values than bindings');
			}
			return stops[at++];
		};
		let value: ClipTransformValue;
		switch (attribute) {
			case 1: {
				value = { kind: 'position', value: [next(), next(), next()] };
				break;
			}
			case 2: {
				value = { kind: 'rotation', value: [next(), next(), next(), next()] };
				break;
			}
			case 3: {
				value = { kind: 'scale', value: [next(), next(), next()] };
				break;
			}
			case 4: {
				value = {
					kind: 'rotation',
					value: eulerQuaternion([next(), next(), next()], rotationOrder(binding)),
				};
				break;
			}
			default: {
				throw new FormatError(`unsupported AnimationClip Transform attribute ${attribute}`);
			}
		}
		transforms.getOrInsertComputed(path, () => []).push(value);
	}
	if (at !== stops.length) {
		throw new FormatError(`AnimationClip has ${stops.length} values for ${at} bound`);
	}
	return { transforms, active, materials, renderers };
};

// #region playback

/** a clip's Transform values over time, for playing it rather than holding its end pose */
export interface ClipMotion {
	/** seconds from the clip's start to its stop */
	duration: number;
	/** the clip's authored frames per second */
	sampleRate: number;
	/** whether the clip loops (`m_LoopTime`) */
	loops: boolean;
	/** binding paths of the Transforms the clip animates, in binding order */
	paths: readonly number[];
	/**
	 * @param time seconds from the clip's start, within `[0, duration]`
	 * @returns every animated Transform's values at that time, by binding path, as
	 *   {@link ClipEndPose.transforms}
	 */
	sample(time: number): Map<number, ClipTransformValue[]>;
}

/** one streamed key: the cubic `((a·dt + b)·dt + c)·dt + value` from its time to the curve's next key */
interface StreamedKey {
	time: number;
	a: number;
	b: number;
	c: number;
	value: number;
}

/** what each scalar of a clip's curves animates: a Transform attribute (1–4) or `0` for anything else */
type ScalarKinds = Uint8Array;

// the 16-bit dense decode follows Sora-Core's `NativeGenericScalarSampler`
// (https://github.com/SaigyoujiYusora/Sora-Core, MIT).

/** the dense block's 16-bit encoding, Hypergryph's (`m_ACLType` 16) */
const DENSE_PACKED16 = 16;

/** the 16-bit dense block's scale field per scalar kind: other floats, position, rotation, scale, Euler */
const DENSE_FACTORS = ['m_FloatFactor', 'm_PositionFactor', '', 'm_ScaleFactor', 'm_EulerFactor'] as const;

/** @returns a numeric array field as numbers, typed arrays read in place */
const numbersField = (parent: TypeTreeObject, name: string): ArrayLike<number> => {
	const value = parent[name];
	if (
		ArrayBuffer.isView(value) &&
		!(value instanceof DataView) &&
		!(value instanceof BigInt64Array) &&
		!(value instanceof BigUint64Array)
	) {
		return value;
	}
	return arrayField(parent, name).map((item) => {
		if (typeof item !== 'number') {
			throw new FormatError(`field ${name} holds a non-number`);
		}
		return item;
	});
};

/** @returns the scalars of a streamed clip's words, each curve's keys ascending by time */
const readStreamed = (words: ArrayLike<number>, curveCount: number): StreamedKey[][] => {
	const bits = new DataView(new ArrayBuffer(4));
	const float = (word: number): number => {
		bits.setUint32(0, word >>> 0, true);
		return bits.getFloat32(0, true);
	};
	const curves: StreamedKey[][] = Array.from({ length: curveCount }, () => []);
	let at = 0;
	while (at < words.length) {
		if (at + 2 > words.length) {
			throw new FormatError('truncated streamed AnimationClip frame');
		}
		const time = float(words[at]);
		const count = words[at + 1] >>> 0;
		at += 2;
		if (at + count * 5 > words.length) {
			throw new FormatError('truncated streamed AnimationClip keys');
		}
		for (let k = 0; k < count; k++, at += 5) {
			const index = words[at] >>> 0;
			if (index >= curveCount) {
				throw new FormatError(`streamed AnimationClip key for curve ${index} of ${curveCount}`);
			}
			// a frame at −FLT_MAX holds constant values for before a curve's first key; one at +∞ ends the clip
			if (Number.isFinite(time)) {
				curves[index].push({
					time,
					a: float(words[at + 1]),
					b: float(words[at + 2]),
					c: float(words[at + 3]),
					value: float(words[at + 4]),
				});
			}
		}
	}
	return curves;
};

/** @returns a streamed curve's value at a time: its last key at or before it, else its first */
const sampleStreamed = (keys: readonly StreamedKey[], time: number): number => {
	if (keys.length === 0) {
		return 0;
	}
	let low = 0;
	let high = keys.length;
	while (low + 1 < high) {
		const mid = (low + high) >> 1;
		if (keys[mid].time <= time) {
			low = mid;
		} else {
			high = mid;
		}
	}
	const key = keys[low];
	const dt = Math.max(time - key.time, 0);
	return ((key.a * dt + key.b) * dt + key.c) * dt + key.value;
};

/**
 * reads a generic (non-humanoid) AnimationClip's curves for playback: the streamed block (Unity's cubic
 * keys), the dense block (frames at its own rate, linearly interpolated, as floats or Hypergryph's 16-bit
 * encoding) and the constant block, in that order of the bindings' scalars, or the clip's ACL transform
 * tracks when it has them (`docs/game-data/animation.md#curves`). rotations come out normalized
 *
 * @param clip AnimationClip type-tree object
 * @returns its Transform values over time
 * @throws {FormatError} for legacy clips, ACL-compressed clips without transform tracks or that
 *   {@link readAclMotion} rejects, dense encodings other than floats and the 16-bit one, unknown Transform
 *   attributes or Euler rotation orders, or blocks that don't add up to the bindings
 */
export const readClipMotion = (clip: TypeTreeObject): ClipMotion => {
	if (booleanField(clip, 'm_Legacy')) {
		throw new FormatError('legacy AnimationClip');
	}
	const acl = objectField(clip, 'm_AclCompressedBuffer');
	if (numberField(acl, 'OutputTrackCount') !== 0) {
		return readAclMotion(clip, acl);
	}
	if (numberField(acl, 'FloatCurveCount') !== 0) {
		throw new FormatError('ACL-compressed AnimationClip without transform tracks');
	}
	const muscle = objectField(clip, 'm_MuscleClip');
	const start = numberField(muscle, 'm_StartTime');
	const duration = numberField(muscle, 'm_StopTime') - start;
	const data = objectField(objectField(muscle, 'm_Clip'), 'data');

	// what each scalar animates, from the bindings
	const kinds: number[] = [];
	const paths: number[] = [];
	const transformBindings: { path: number; attribute: number; order: number; at: number }[] = [];
	for (const binding of arrayField(objectField(clip, 'm_ClipBindingConstant'), 'genericBindings')) {
		if (!isObject(binding)) {
			throw new FormatError('invalid AnimationClip binding');
		}
		if (numberField(binding, 'isPPtrCurve') !== 0) {
			continue;
		}
		if (numberField(binding, 'typeID') !== TRANSFORM) {
			kinds.push(0);
			continue;
		}
		const attribute = numberField(binding, 'attribute');
		if (attribute < 1 || attribute > 4) {
			throw new FormatError(`unsupported AnimationClip Transform attribute ${attribute}`);
		}
		const path = numberField(binding, 'path') >>> 0;
		if (!paths.includes(path)) {
			paths.push(path);
		}
		transformBindings.push({
			path,
			attribute,
			order: attribute === 4 ? rotationOrder(binding) : 0,
			at: kinds.length,
		});
		for (let i = 0; i < (attribute === 2 ? 4 : 3); i++) {
			kinds.push(attribute);
		}
	}
	const scalarKinds: ScalarKinds = Uint8Array.from(kinds);

	const streamedClip = objectField(data, 'm_StreamedClip');
	const streamedCount = numberField(streamedClip, 'curveCount');
	const streamed = readStreamed(numbersField(streamedClip, 'data'), streamedCount);

	const dense = objectField(data, 'm_DenseClip');
	const denseCount = numberField(dense, 'm_CurveCount');
	const frameCount = numberField(dense, 'm_FrameCount');
	const denseRate = numberField(dense, 'm_SampleRate');
	const denseBegin = numberField(dense, 'm_BeginTime');
	const floats = numbersField(dense, 'm_SampleArray');
	let denseValue: (curve: number, frame: number) => number;
	if (denseCount === 0 || frameCount === 0) {
		denseValue = () => 0;
	} else if (floats.length > 0) {
		if (floats.length !== denseCount * frameCount) {
			throw new FormatError(
				`dense AnimationClip has ${floats.length} samples for ${denseCount}×${frameCount}`,
			);
		}
		denseValue = (curve, frame) => floats[frame * denseCount + curve];
	} else {
		const type = optionalNumberField(dense, 'm_ACLType') ?? 0;
		const packed = bytesField(dense, 'm_ACLArray');
		if (type !== DENSE_PACKED16 || packed.length !== denseCount * frameCount * 2) {
			throw new FormatError(
				`dense AnimationClip encoding ${type} with ${packed.length} bytes isn't supported`,
			);
		}
		// each kind's range: rotations are unit quaternions, other values span ± their factor
		const factors = new Float64Array(denseCount);
		for (let curve = 0; curve < denseCount; curve++) {
			const kind = scalarKinds[streamedCount + curve];
			factors[curve] = kind === 2 ? 1 : numberField(dense, DENSE_FACTORS[kind]);
		}
		const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
		denseValue = (curve, frame) =>
			((view.getUint16((frame * denseCount + curve) * 2, true) - 32_767.5) / 32_767.5) * factors[curve];
	}

	const constants = numbersField(objectField(data, 'm_ConstantClip'), 'data');
	if (streamedCount + denseCount + constants.length !== scalarKinds.length) {
		throw new FormatError(
			`AnimationClip has ${streamedCount + denseCount + constants.length} curves for ${scalarKinds.length} bound`,
		);
	}

	const values = new Float64Array(scalarKinds.length);
	const sample = (time: number): Map<number, ClipTransformValue[]> => {
		const t = start + time;
		for (let i = 0; i < streamedCount; i++) {
			values[i] = sampleStreamed(streamed[i], t);
		}
		if (denseCount > 0 && frameCount > 0) {
			const position = Math.min(Math.max((t - denseBegin) * denseRate, 0), frameCount - 1);
			const frame = Math.min(Math.floor(position), frameCount - 1);
			const next = Math.min(frame + 1, frameCount - 1);
			const blend = position - frame;
			for (let i = 0; i < denseCount; i++) {
				const a = denseValue(i, frame);
				values[streamedCount + i] = a + (denseValue(i, next) - a) * blend;
			}
		}
		for (let i = 0; i < constants.length; i++) {
			values[streamedCount + denseCount + i] = constants[i];
		}
		const out = new Map<number, ClipTransformValue[]>();
		for (const { path, attribute, order, at } of transformBindings) {
			let value: ClipTransformValue;
			switch (attribute) {
				case 2: {
					const length = Math.hypot(values[at], values[at + 1], values[at + 2], values[at + 3]) || 1;
					value = {
						kind: 'rotation',
						value: [
							values[at] / length,
							values[at + 1] / length,
							values[at + 2] / length,
							values[at + 3] / length,
						],
					};
					break;
				}
				case 4: {
					value = {
						kind: 'rotation',
						value: eulerQuaternion([values[at], values[at + 1], values[at + 2]], order),
					};
					break;
				}
				default: {
					value = {
						kind: attribute === 1 ? 'position' : 'scale',
						value: [values[at], values[at + 1], values[at + 2]],
					};
				}
			}
			out.getOrInsertComputed(path, () => []).push(value);
		}
		return out;
	};

	return {
		duration,
		sampleRate: numberField(clip, 'm_SampleRate'),
		loops: booleanField(muscle, 'm_LoopTime'),
		paths,
		sample,
	};
};

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * an ACL-compressed clip's Transform motion: one ACL transform track per animated Transform. the sub-track
 * masks say which tracks take a position, rotation or scale binding: the k-th binding of a kind is the k-th
 * track whose bit for that kind is set ([ACL-compressed
 * clips](../../../../docs/game-data/animation.md#acl-compressed-clips))
 *
 * @throws {FormatError} for Euler bindings, masks that don't match the bindings, or a buffer
 *   {@link decodeAclTransforms} can't read
 */
const readAclMotion = (clip: TypeTreeObject, acl: TypeTreeObject): ClipMotion => {
	const muscle = objectField(clip, 'm_MuscleClip');
	const duration = numberField(muscle, 'm_StopTime') - numberField(muscle, 'm_StartTime');
	// bindings listed as constant take their values from the clip, in listing order, not from the ACL track
	const constantIndices = new Set(Array.from(numbersField(acl, 'm_ConstantIndexs')));
	const constantValues = numbersField(acl, 'm_ConstantValues');
	let nextConstant = 0;
	const trackCount = numberField(acl, 'OutputTrackCount');
	const masks = bytesField(acl, 'TransformSubTrackMasks');
	const maskBytes = Math.ceil(trackCount / 8);
	if (masks.length < maskBytes * 3) {
		throw new FormatError(`ACL AnimationClip has ${masks.length} mask bytes for ${trackCount} tracks`);
	}
	// per kind (position, rotation, scale), the tracks its bindings go to, in order
	const targets = [0, 1, 2].map((kind) => {
		const list: number[] = [];
		for (let track = 0; track < trackCount; track++) {
			if (((masks[kind * maskBytes + (track >> 3)] >> (7 - (track & 7))) & 1) === 1) {
				list.push(track);
			}
		}
		return list;
	});
	const taken = [0, 0, 0];
	const paths: number[] = [];
	const bindings: { path: number; attribute: number; track: number; constant: number[] | null }[] = [];
	for (const [index, binding] of arrayField(
		objectField(clip, 'm_ClipBindingConstant'),
		'genericBindings',
	).entries()) {
		if (!isObject(binding)) {
			throw new FormatError('invalid AnimationClip binding');
		}
		const transform = numberField(binding, 'typeID') === TRANSFORM;
		const attribute = numberField(binding, 'attribute');
		let constant: number[] | null = null;
		if (constantIndices.has(index)) {
			const count = transform ? (attribute === 2 ? 4 : 3) : 1;
			constant = Array.from({ length: count }, (_, c) => constantValues[nextConstant + c]);
			nextConstant += count;
		}
		if (!transform) {
			continue;
		}
		if (attribute < 1 || attribute > 3) {
			throw new FormatError(`unsupported ACL AnimationClip Transform attribute ${attribute}`);
		}
		const path = numberField(binding, 'path') >>> 0;
		if (!paths.includes(path)) {
			paths.push(path);
		}
		const track = targets[attribute - 1][taken[attribute - 1]++];
		if (track === undefined) {
			throw new FormatError(
				`ACL AnimationClip has more Transform attribute ${attribute} bindings than masked tracks`,
			);
		}
		bindings.push({ path, attribute, track, constant });
	}
	if (taken.some((count, kind) => count !== targets[kind].length)) {
		throw new FormatError('ACL AnimationClip masks more tracks than it binds');
	}
	if (nextConstant !== constantValues.length) {
		throw new FormatError(
			`ACL AnimationClip has ${constantValues.length} constant values for ${nextConstant} bound`,
		);
	}
	const tracks = decodeAclTransforms(bytesField(acl, 'TransformBufferData'));
	if (tracks.trackCount !== trackCount) {
		throw new FormatError(`ACL AnimationClip buffer has ${tracks.trackCount} tracks for ${trackCount}`);
	}
	const { values, sampleCount, sampleRate, wraps } = tracks;
	const sample = (time: number): Map<number, ClipTransformValue[]> => {
		const position = Math.max(time * sampleRate, 0);
		let frame = Math.floor(position);
		let next = frame + 1;
		let blend = position - frame;
		if (wraps) {
			frame %= sampleCount;
			next %= sampleCount;
		} else if (next >= sampleCount) {
			frame = Math.min(frame, sampleCount - 1);
			next = frame;
			blend = 0;
		}
		const out = new Map<number, ClipTransformValue[]>();
		for (const { path, attribute, track, constant } of bindings) {
			const a = (frame * trackCount + track) * ACL_TRANSFORM_STRIDE;
			const b = (next * trackCount + track) * ACL_TRANSFORM_STRIDE;
			let value: ClipTransformValue;
			if (constant !== null) {
				value =
					attribute === 2
						? { kind: 'rotation', value: [constant[0], constant[1], constant[2], constant[3]] }
						: {
								kind: attribute === 1 ? 'position' : 'scale',
								value: [constant[0], constant[1], constant[2]],
							};
			} else if (attribute === 2) {
				// normalized lerp along the shorter arc, as ACL interpolates
				const sign =
					values[a] * values[b] +
						values[a + 1] * values[b + 1] +
						values[a + 2] * values[b + 2] +
						values[a + 3] * values[b + 3] <
					0
						? -1
						: 1;
				const q = [0, 1, 2, 3].map((c) => lerp(values[a + c], values[b + c] * sign, blend));
				const length = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
				value = { kind: 'rotation', value: [q[0] / length, q[1] / length, q[2] / length, q[3] / length] };
			} else {
				const k = attribute === 1 ? 4 : 7;
				value = {
					kind: attribute === 1 ? 'position' : 'scale',
					value: [
						lerp(values[a + k], values[b + k], blend),
						lerp(values[a + k + 1], values[b + k + 1], blend),
						lerp(values[a + k + 2], values[b + k + 2], blend),
					],
				};
			}
			out.getOrInsertComputed(path, () => []).push(value);
		}
		return out;
	};
	return {
		duration,
		sampleRate: numberField(clip, 'm_SampleRate'),
		loops: booleanField(muscle, 'm_LoopTime'),
		paths,
		sample,
	};
};

// #endregion

/**
 * @param clip a non-legacy AnimationClip
 * @returns for each GameObject whose activity the clip animates, by binding path, whether it's switched on at
 *   the clip's first or last frame (the values a clip stores for both ends; frames between aren't read)
 * @throws {FormatError} for legacy clips or malformed bindings
 */
export const readClipActivity = (clip: TypeTreeObject): Map<number, boolean> => {
	if (booleanField(clip, 'm_Legacy')) {
		throw new FormatError('legacy AnimationClip');
	}
	const deltas = arrayField(objectField(clip, 'm_MuscleClip'), 'm_ValueArrayDelta');
	const activity = new Map<number, boolean>();
	let at = 0;
	for (const binding of arrayField(objectField(clip, 'm_ClipBindingConstant'), 'genericBindings')) {
		if (!isObject(binding)) {
			throw new FormatError('invalid AnimationClip binding');
		}
		if (numberField(binding, 'isPPtrCurve') !== 0) {
			continue;
		}
		const type = numberField(binding, 'typeID');
		if (type === GAME_OBJECT && numberField(binding, 'attribute') >>> 0 === IS_ACTIVE) {
			const delta = deltas[at];
			if (!isObject(delta)) {
				throw new FormatError('AnimationClip has fewer values than bindings');
			}
			activity.set(
				numberField(binding, 'path') >>> 0,
				numberField(delta, 'm_Start') !== 0 || numberField(delta, 'm_Stop') !== 0,
			);
		}
		// Transform positions and scales take three values, rotations four (Euler three); other bindings one
		if (type === TRANSFORM) {
			at += numberField(binding, 'attribute') === 2 ? 4 : 3;
		} else {
			at++;
		}
	}
	return activity;
};
