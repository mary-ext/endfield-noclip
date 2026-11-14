/* oxlint-disable no-await-in-loop -- reads Animators and their clips in authored order */
import { crc32 } from 'node:zlib';

import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import { type ClipMotion, readClipEndPose } from '@endfield-noclip/formats/unity/animation-clip';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import {
	arrayField,
	asPPtr,
	isObject,
	numberField,
	objectField,
	pptrField,
} from '@endfield-noclip/formats/unity/values';

import type { AssetResolver, ObjectRef } from '../assets/assets.ts';
import { loopingMotion } from '../interactives/view-state-poses.ts';

import { PRUNE, walkPrefab } from './prefab-walk.ts';
import type { PoseClip, PrefabPose } from './prefab.ts';

// what a prefab's own Animators play when nothing drives them: docs/game-data/animation.md#scenery-animators

/** `m_ClipID` of a blend tree node without a clip */
const NO_CLIP = 0xffff_ffff;

/** the clip one controller layer's default state plays */
export interface DefaultStateClip {
	layer: number;
	/** index into the controller's `m_AnimationClips` */
	clip: number;
	/** the state's playback speed */
	speed: number;
}

const data = (value: unknown, what: string): TypeTreeObject => {
	if (!isObject(value)) {
		throw new FormatError(`invalid animator controller ${what}`);
	}
	return objectField(value, 'data');
};

/** Animator parameter values by parameter id ({@link animatorParameterId}) */
export type AnimatorParameters = ReadonlyMap<number, boolean | number>;

/**
 * @param name an Animator parameter's name
 * @returns the id a controller keys it by
 */
export const animatorParameterId = (name: string): number => crc32(name);

/** `AnimatorControllerParameterType` of triggers, which are never set at rest */
const TRIGGER = 9;

/**
 * @param constant a controller's `m_Controller`
 * @param parameters values that replace the controller's defaults
 * @returns each parameter's value by id, and the ids of triggers
 */
const parameterValues = (
	constant: TypeTreeObject,
	parameters: AnimatorParameters,
): { values: Map<number, number>; triggers: Set<number> } => {
	const values = new Map<number, number>();
	const triggers = new Set<number>();
	const defaults = data(objectField(constant, 'm_DefaultValues'), 'default values');
	// `AnimatorControllerParameterType`: 1 float, 3 int, 4 bool, 9 trigger; each indexes its own array
	const arrays = new Map([
		[1, 'm_FloatValues'],
		[3, 'm_IntValues'],
		[4, 'm_BoolValues'],
	]);
	for (const entry of arrayField(data(objectField(constant, 'm_Values'), 'values'), 'm_ValueArray')) {
		if (!isObject(entry)) {
			throw new FormatError('invalid animator parameter');
		}
		const id = numberField(entry, 'm_ID');
		const type = numberField(entry, 'm_Type');
		if (type === TRIGGER) {
			triggers.add(id);
			continue;
		}
		const array = arrays.get(type);
		const saved =
			array === undefined ? undefined : arrayField(defaults, array)[numberField(entry, 'm_Index')];
		values.set(id, Number(parameters.get(id) ?? saved ?? 0));
	}
	return { values, triggers };
};

/**
 * @returns whether a transition's conditions all hold at rest. one without conditions waits on its exit time
 *   (a timed sequence), and one testing a trigger on a trigger that isn't set, so neither does
 * @throws {FormatError} on an unknown condition mode
 */
const transitionHolds = (
	transition: TypeTreeObject,
	values: ReadonlyMap<number, number>,
	triggers: ReadonlySet<number>,
): boolean => {
	const conditions = arrayField(transition, 'm_ConditionConstantArray');
	if (conditions.length === 0) {
		return false;
	}
	return conditions.every((entry) => {
		const condition = data(entry, 'condition');
		const id = numberField(condition, 'm_EventID');
		if (triggers.has(id)) {
			return false;
		}
		const value = values.get(id) ?? 0;
		const threshold = numberField(condition, 'm_EventThreshold');
		// `AnimatorConditionMode`: 1 if, 2 if not, 3 greater, 4 less, 5 exit time, 6 equals, 7 not equal
		switch (numberField(condition, 'm_ConditionMode')) {
			case 1: {
				return value !== 0;
			}
			case 2: {
				return value === 0;
			}
			case 3: {
				return value > threshold;
			}
			case 4: {
				return value < threshold;
			}
			case 5: {
				return true;
			}
			case 6: {
				return value === threshold;
			}
			case 7: {
				return value !== threshold;
			}
			default: {
				throw new FormatError(`unknown animator condition mode ${numberField(condition, 'm_ConditionMode')}`);
			}
		}
	});
};

/**
 * @param machine a layer's state machine
 * @param values parameter values
 * @param triggers trigger ids
 * @returns the index of the state the machine rests in: from the default state, any-state transitions first,
 *   then the state's own, the first that holds is taken until none does, a state repeats or a transition
 *   leaves for a sub-machine's entry or exit
 */
const settledStateIndex = (
	machine: TypeTreeObject,
	values: ReadonlyMap<number, number>,
	triggers: ReadonlySet<number>,
): number => {
	const states = arrayField(machine, 'm_StateConstantArray');
	const anyState = arrayField(machine, 'm_AnyStateTransitionConstantArray');
	let index = numberField(machine, 'm_DefaultState');
	const visited = new Set<number>();
	for (;;) {
		visited.add(index);
		const own = arrayField(data(states[index], 'state'), 'm_TransitionConstantArray');
		const taken = [...anyState, ...own]
			.map((entry) => data(entry, 'transition'))
			.find((transition) => transitionHolds(transition, values, triggers));
		const next = taken === undefined ? undefined : numberField(taken, 'm_DestinationState');
		if (next === undefined || next < 0 || next >= states.length || visited.has(next)) {
			return index;
		}
		index = next;
	}
};

/**
 * @param controller an AnimatorController's fields
 * @param parameters parameter values set on the Animator, replacing the controller's defaults
 * @returns per layer that shows, in layer order, the clip of the state it rests in
 *   ({@link settledStateIndex}). the base layer always shows; another shows when it overrides at full default
 *   weight. layers that blend (additive, partial weight) and states that play a blend tree, no clip or not
 *   forwards are left out
 * @throws {FormatError} on a malformed controller
 */
export const settledStateClips = (
	controller: TypeTreeObject,
	parameters: AnimatorParameters,
): DefaultStateClip[] => {
	const constant = objectField(controller, 'm_Controller');
	const machines = arrayField(constant, 'm_StateMachineArray');
	const { values, triggers } = parameterValues(constant, parameters);
	const result: DefaultStateClip[] = [];
	for (const [layer, entry] of arrayField(constant, 'm_LayerArray').entries()) {
		const layerData = data(entry, 'layer');
		// Unity holds the base layer at weight 1 whatever its saved weight
		const weight = layer === 0 ? 1 : numberField(layerData, 'm_DefaultWeight');
		// `AnimatorLayerBlendingMode`: 0 override, 1 additive
		if (weight !== 1 || numberField(layerData, '(int&)m_LayerBlendingMode') !== 0) {
			continue;
		}
		const machine = data(machines[numberField(layerData, 'm_StateMachineIndex')], 'state machine');
		const state = data(
			arrayField(machine, 'm_StateConstantArray')[settledStateIndex(machine, values, triggers)],
			'state',
		);
		const speed = numberField(state, 'm_Speed');
		const treeIndex = arrayField(state, 'm_BlendTreeConstantIndexArray')[0];
		if (speed <= 0 || typeof treeIndex !== 'number' || treeIndex < 0) {
			continue;
		}
		const tree = data(arrayField(state, 'm_BlendTreeConstantArray')[treeIndex], 'blend tree');
		const nodes = arrayField(tree, 'm_NodeArray');
		if (nodes.length !== 1) {
			continue;
		}
		const clip = numberField(data(nodes[0], 'blend tree node'), 'm_ClipID');
		if (clip !== NO_CLIP) {
			result.push({ layer, clip, speed });
		}
	}
	return result;
};

/**
 * @param motion a clip's motion
 * @param speed the state's playback speed, above 0
 * @returns the motion as the state plays it
 */
const atSpeed = (motion: ClipMotion, speed: number): ClipMotion => {
	if (speed === 1) {
		return motion;
	}
	const { materials } = motion;
	return {
		...motion,
		duration: motion.duration / speed,
		sample: (time) => motion.sample(Math.min(time * speed, motion.duration)),
		materials: materials === null ? null : (time) => materials(Math.min(time * speed, motion.duration)),
	};
};

/**
 * reads what a prefab's own Animators play when no view state drives them: each enabled Animator on a
 * GameObject active as saved plays the states its AnimatorController rests in under the controller's default
 * parameters, holding a clip's end pose once it ends or playing on while it loops
 *
 * @param resolver bundle reader
 * @param root prefab GameObject
 * @returns the pose, or `null` when no Animator plays a clip
 * @throws {FormatError} on a malformed hierarchy or controller
 */
export const animatorDefaultPose = (resolver: AssetResolver, root: ObjectRef): Promise<PrefabPose | null> =>
	animatorPose(resolver, root, new Map());

/**
 * like {@link animatorDefaultPose}, with parameter values set on every Animator in the prefab, as a gameplay
 * component sets them when the prefab loads
 *
 * @param resolver bundle reader
 * @param root prefab GameObject
 * @param parameters values replacing the controllers' defaults
 * @returns the pose, or `null` when no Animator plays a clip
 * @throws {FormatError} on a malformed hierarchy or controller
 */
export const animatorPose = async (
	resolver: AssetResolver,
	root: ObjectRef,
	parameters: AnimatorParameters,
): Promise<PrefabPose | null> => {
	const clips: PoseClip[] = [];
	await walkPrefab(
		resolver,
		root,
		{
			enter: async (node) => {
				if (!node.active) {
					return PRUNE;
				}
				for (const component of node.ofClass(UnityClass.Animator)) {
					const animator = await component.read();
					const controller =
						numberField(animator, 'm_Enabled') === 0
							? null
							: await resolver.resolve(component.ref, pptrField(animator, 'm_Controller'));
					// override controllers swap clips by name; their base controller isn't followed
					if (controller === null || controller.info.classId !== UnityClass.AnimatorController) {
						continue;
					}
					const controllerData = await resolver.read(controller);
					const pointers = arrayField(controllerData, 'm_AnimationClips');
					for (const { clip, speed } of settledStateClips(controllerData, parameters)) {
						const pointer = pointers[clip];
						const clipRef =
							pointer === undefined ? null : await resolver.resolve(controller, asPPtr(pointer));
						if (clipRef === null) {
							continue;
						}
						const clipData = await resolver.read(clipRef);
						const motion = loopingMotion(clipData);
						clips.push({
							animator: node.isRoot ? null : node.name,
							...readClipEndPose(clipData),
							motion: motion === null ? null : atSpeed(motion, speed),
						});
					}
				}
				return undefined;
			},
		},
		undefined,
	);
	if (clips.length === 0) {
		return null;
	}
	const key =
		parameters.size === 0
			? 'animator-defaults'
			: `animator:${[...parameters].map(([id, value]) => `${id}=${Number(value)}`).join(',')}`;
	return { key, clips, active: new Map() };
};
