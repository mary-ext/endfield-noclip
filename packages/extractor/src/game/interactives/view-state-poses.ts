import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import { isMemoryPackObject, type MemoryPackValue } from '@endfield-noclip/formats/endfield/memory-pack';
import {
	type ClipMotion,
	readClipEndPose,
	readClipMotion,
} from '@endfield-noclip/formats/unity/animation-clip';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import { booleanField, objectField } from '@endfield-noclip/formats/unity/values';

import type { Context } from '../../context.ts';
import { VfsGroup } from '../../hg/vfs.ts';
import type { PoseClip, PrefabPose } from '../prefabs/prefab.ts';

// model view states (`ModelViewStateControllerData`) and the poses they settle in.
// rules: docs/game-data/interactives.md#interactive-view-states.

const ROOT = 'Beyond_Gameplay_Core_ModelViewStateController_MVSCModelViewStateControllerDataForMemoryPack';

/** a decoded MemoryPack record */
export type ViewStateRecord = { [key: string]: MemoryPackValue };

/** a model's decoded view-state controller */
export interface ViewStates {
	model: string;
	/** where it was read from, for errors */
	path: string;
	data: ViewStateRecord;
}

/**
 * a ModelTable model and the model whose view states it uses: its own id, or the one its row names in
 * `dependModelViewDataId` (a resized copy borrows its original's)
 */
export interface ModelViews {
	model: string;
	source: string;
}

/** the values a model's state machines test, by key; keys left out are false or 0 */
export type Blackboard = ReadonlyMap<string, boolean | number>;

/**
 * @param value a decoded list
 * @returns its records
 */
export const records = (value: MemoryPackValue | undefined): ViewStateRecord[] =>
	Array.isArray(value) ? value.filter(isMemoryPackObject) : [];

/**
 * @param value a decoded value
 * @returns it as a string, or `null`
 */
export const text = (value: MemoryPackValue | undefined): string | null =>
	typeof value === 'string' ? value : null;

/**
 * @param context install readers
 * @param model the ModelTable id, and `source`, the id whose view-state file it uses ({@link ModelViews})
 * @returns the model's view states, or `null` when it has none
 * @throws {FormatError} if the file isn't a view-state controller
 */
export const readViewStates = async (
	context: Pick<Context, 'vfs' | 'memoryPack'>,
	{ model, source }: ModelViews,
): Promise<ViewStates | null> => {
	const path = `Data/Json/Interactive/ModelViewStateControllerData/${source}.json`;
	const file = await context.vfs.find(VfsGroup.JsonData, path);
	if (file === undefined) {
		return null;
	}
	const data = (await context.memoryPack()).decode(await context.vfs.readVerified(file), ROOT);
	if (!isMemoryPackObject(data)) {
		throw new FormatError(`${path} isn't a view state controller`);
	}
	return { model, path, data };
};

/** the game's `Comparison`: 0 =, 1 >, 2 <, 3 ≥, 4 ≤ */
const compare = (value: number, comparison: number, target: number): boolean => {
	switch (comparison) {
		case 0: {
			return value === target;
		}
		case 1: {
			return value > target;
		}
		case 2: {
			return value < target;
		}
		case 3: {
			return value >= target;
		}
		case 4: {
			return value <= target;
		}
		default: {
			throw new FormatError(`unknown view state comparison ${comparison}`);
		}
	}
};

/**
 * @returns whether a transition condition holds; a trigger never has fired
 * @throws {FormatError} for an unknown comparison or value type
 */
const holds = (condition: ViewStateRecord, blackboard: Blackboard): boolean => {
	const key = text(condition.key) ?? '';
	const wrapper = isMemoryPackObject(condition.conditionValue) ? condition.conditionValue : {};
	const union = isMemoryPackObject(wrapper.conditionValue) ? wrapper.conditionValue : {};
	const comparison = typeof condition.comparison === 'number' ? condition.comparison : 0;
	const value = blackboard.get(key);
	let result: boolean;
	// `DataType`: 0 bool, 1 float, 2 int, 3 trigger
	switch (wrapper.type) {
		case 0: {
			result = compare(
				value === true || (typeof value === 'number' && value !== 0) ? 1 : 0,
				comparison,
				union.boolValue === true ? 1 : 0,
			);
			break;
		}
		case 1: {
			result = compare(typeof value === 'number' ? value : 0, comparison, Number(union.floatValue ?? 0));
			break;
		}
		case 2: {
			result = compare(typeof value === 'number' ? value : 0, comparison, Number(union.intValue ?? 0));
			break;
		}
		case 3: {
			result = false;
			break;
		}
		default: {
			throw new FormatError(`unknown view state condition type ${JSON.stringify(wrapper.type)}`);
		}
	}
	return condition.isInvert === true ? !result : result;
};

/**
 * @param layer an animator layer's state machine
 * @param blackboard the values its conditions test
 * @returns the states the layer enters, from its starting state to the one it rests in: the first transition
 *   whose conditions all hold is taken (one without conditions always is) until none holds
 * @throws {FormatError} if the layer has no starting state or its transitions loop
 */
export const settledPath = (layer: ViewStateRecord, blackboard: Blackboard): ViewStateRecord[] => {
	const layerName = text(layer.layerName) ?? '?';
	const states = new Map(records(layer.stateDatas).map((state) => [text(state.stateName) ?? '', state]));
	const start = records(layer.stateDatas).find((candidate) => candidate.isStartingNode === true);
	if (start === undefined) {
		throw new FormatError(`view state layer ${layerName} has no starting state`);
	}
	const path: ViewStateRecord[] = [];
	let state: ViewStateRecord = start;
	for (;;) {
		if (path.includes(state)) {
			throw new FormatError(`view state layer ${layerName} loops at ${text(state.stateName) ?? '?'}`);
		}
		path.push(state);
		const next: ViewStateRecord | undefined = records(state.transitions).find((transition) =>
			records(
				isMemoryPackObject(transition.conditionGroup) ? transition.conditionGroup.conditions : [],
			).every((condition) => holds(condition, blackboard)),
		);
		const target: ViewStateRecord | undefined =
			next === undefined ? undefined : states.get(text(next.targetStateName) ?? '');
		if (target === undefined) {
			return path;
		}
		state = target;
	}
};

/**
 * @param states a model's view states
 * @param key an int key their transitions test
 * @returns the values any transition condition compares the key against, ascending and deduplicated
 */
export const testedValues = (states: ViewStates, key: string): number[] => {
	const values = new Set<number>();
	for (const animator of records(states.data.modelAnimatorDatas)) {
		for (const layer of records(animator.layerFsmDatas)) {
			for (const state of records(layer.stateDatas)) {
				for (const transition of records(state.transitions)) {
					const group = isMemoryPackObject(transition.conditionGroup)
						? transition.conditionGroup.conditions
						: [];
					for (const condition of records(group)) {
						const wrapper = isMemoryPackObject(condition.conditionValue) ? condition.conditionValue : {};
						const union = isMemoryPackObject(wrapper.conditionValue) ? wrapper.conditionValue : {};
						if (text(condition.key) === key && wrapper.type === 2 && typeof union.intValue === 'number') {
							values.add(union.intValue);
						}
					}
				}
			}
		}
	}
	return [...values].toSorted((a, b) => a - b);
};

/**
 * @param states a model's view states
 * @returns whether any state of any layer has a `SetActive` behaviour, so it can switch a GameObject
 */
export const switchesGameObjects = (states: ViewStates): boolean =>
	records(states.data.modelAnimatorDatas).some((animator) =>
		records(animator.layerFsmDatas).some((layer) =>
			records(layer.stateDatas).some((state) =>
				records(state.behaviors).some((behavior) =>
					text(behavior.$type)?.endsWith('SetActiveBehaviorDataForMemoryPack'),
				),
			),
		),
	);

/** an effect a model's view states keep playing once they rest */
export interface RestingEffect {
	/** the effect's name, which names its prefab */
	effect: string;
	/** the GameObject it plays on, by name */
	node: string | null;
	/** where it plays when the model has no {@link node}: the animator's GameObject, `null` for the prefab root */
	fallback: string | null;
	/** whether it turns with its GameObject; one that doesn't keeps the world's axes */
	followRotation: boolean;
}

/**
 * the effects a layer's effect behaviours leave playing once it rests. a persistent effect is switched on or
 * off by each state that names it, in the order the layer enters them; any other effect plays while the state
 * that names it is active, so only the resting state's count. fire-and-forget effects are left to run out
 *
 * @param animator the GameObject the layer's animator drives, `null` for the prefab root
 * @param path the states the layer enters ({@link settledPath})
 * @returns the effects, one per effect and GameObject
 */
export const restingEffects = (
	animator: string | null,
	path: readonly ViewStateRecord[],
): RestingEffect[] => {
	const playing = new Map<string, RestingEffect>();
	for (const [i, state] of path.entries()) {
		const resting = i === path.length - 1;
		for (const behavior of records(state.behaviors)) {
			const effect = text(behavior.effectId);
			if (!text(behavior.$type)?.endsWith('_MVSCEffectBehaviorDataForMemoryPack') || !effect) {
				continue;
			}
			if (behavior.fireAndForget === true) {
				continue;
			}
			const node = text(behavior.effectNodeName) || null;
			const key = `${effect}@${node ?? ''}`;
			const persistent = behavior.isPersistence === true;
			if ((persistent && behavior.active !== true) || (!persistent && !resting)) {
				if (persistent) {
					playing.delete(key);
				}
				continue;
			}
			playing.set(key, {
				effect,
				node,
				fallback: animator,
				// a detached effect is placed once at its GameObject's pose
				followRotation: behavior.followRot === true || behavior.dontFollowTrans === true,
			});
		}
	}
	return [...playing.values()];
};

/**
 * the lengths a layer's length behaviours leave set: each sets its GameObject's `VFXAdjustLength` to its
 * blackboard float, or its constant without one, plus its deviation, in the order the layer enters its
 * states. one whose float isn't on the blackboard sets nothing. the length stays once its state is left
 *
 * @param path the states the layer enters ({@link settledPath})
 * @param blackboard the values its conditions test
 * @returns the lengths, by GameObject name
 */
export const restingLengths = (
	path: readonly ViewStateRecord[],
	blackboard: Blackboard,
): Map<string, number> => {
	const lengths = new Map<string, number>();
	for (const state of path) {
		for (const behavior of records(state.behaviors)) {
			const node = text(behavior.nodeName);
			if (!text(behavior.$type)?.endsWith('_MVSCEffectLengthBehaviorDataForMemoryPack') || !node) {
				continue;
			}
			let value: number | boolean | undefined = Number(behavior.val ?? 0);
			if (behavior.dependBlackBoard === true) {
				value = blackboard.get(text(behavior.dependFloatKey) ?? '');
			}
			if (typeof value === 'number') {
				lengths.set(node, value + Number(behavior.deviation ?? 0));
			}
		}
	}
	return lengths;
};

/**
 * a settled state's looping clip keeps playing; any other rests on its end pose
 *
 * @param clip an AnimationClip
 * @returns its motion when it loops, `null` otherwise or when its curves can't be read (it then holds its end
 *   pose)
 */
export const loopingMotion = (clip: TypeTreeObject): ClipMotion | null => {
	if (!booleanField(objectField(clip, 'm_MuscleClip'), 'm_LoopTime')) {
		return null;
	}
	try {
		return readClipMotion(clip);
	} catch (error) {
		if (error instanceof FormatError) {
			return null;
		}
		throw error;
	}
};

/**
 * @param context bundle and path readers
 * @param states the model's view states
 * @param key tells this pose apart from the model's others, for caching
 * @param settled each animator's states to draw: the GameObject its clips bind below (`null` for the prefab
 *   root) and one state per layer, in layer order
 * @returns the states' clip end poses and the GameObjects their SetActive behaviours switch
 * @throws {FormatError} if a clip isn't listed, found or readable
 */
export const statesPose = async (
	context: Pick<Context, 'world' | 'resolver'>,
	states: ViewStates,
	key: string,
	settled: readonly { animator: string | null; states: readonly ViewStateRecord[] }[],
): Promise<PrefabPose> => {
	const clipHashes = new Map(
		records(states.data.clipAssetInfos).map((info) => [text(info.animationClipName), info.animationClipHash]),
	);
	const [resolver, pathOf] = await Promise.all([context.resolver(), context.world.pathLookup()]);
	const clips: PoseClip[] = [];
	const active = new Map<string, boolean>();
	for (const { animator, states: layerStates } of settled) {
		for (const state of layerStates) {
			for (const behavior of records(state.behaviors)) {
				const target = text(behavior.gameObjName);
				if (text(behavior.$type)?.endsWith('SetActiveBehaviorDataForMemoryPack') && target !== null) {
					active.set(target, behavior.active === true);
				}
			}
			if (state.isHaveClip !== true) {
				continue;
			}
			const clipName = text(state.animationClipName);
			const hashValue = clipHashes.get(clipName);
			if (typeof hashValue !== 'string' && typeof hashValue !== 'number') {
				throw new FormatError(`${states.path} lists no clip ${clipName}`);
			}
			const hash = BigInt.asUintN(64, BigInt(hashValue));
			const clipPath = pathOf(hash);
			if (clipPath === undefined) {
				throw new FormatError(`${states.path}: clip ${clipName} isn't in StringPathHash`);
			}
			// oxlint-disable-next-line no-await-in-loop -- a few one-frame clips per model
			const clip = await resolver.findUnique({ hash, path: clipPath }, UnityClass.AnimationClip);
			// oxlint-disable-next-line no-await-in-loop -- as above
			const data = await resolver.read(clip);
			clips.push({ animator, ...readClipEndPose(data), motion: loopingMotion(data) });
		}
	}
	return { key: `${states.model}:${key}`, clips, active };
};

/**
 * @param context bundle and path readers
 * @param states the model's view states
 * @param key tells this pose apart from the model's others, for caching
 * @param blackboard the values the state machines test
 * @returns the pose every animator layer settles in under those values, with the lengths they leave set, the
 *   settled states' names and the effects they leave playing
 * @throws {FormatError} if a layer can't settle or a clip can't be read
 */
export const settledPose = async (
	context: Pick<Context, 'world' | 'resolver'>,
	states: ViewStates,
	key: string,
	blackboard: Blackboard,
): Promise<{ pose: PrefabPose; states: string[]; effects: RestingEffect[] }> => {
	const effects: RestingEffect[] = [];
	const lengths = new Map<string, number>();
	const settled = records(states.data.modelAnimatorDatas).map((animator) => {
		const name = text(animator.modelName);
		const driven = name === '$$ROOT$$' ? null : name;
		const paths = records(animator.layerFsmDatas).map((layer) => settledPath(layer, blackboard));
		effects.push(...paths.flatMap((path) => restingEffects(driven, path)));
		for (const path of paths) {
			for (const [node, length] of restingLengths(path, blackboard)) {
				lengths.set(node, length);
			}
		}
		return { animator: driven, states: paths.map((path) => path[path.length - 1]) };
	});
	const pose = await statesPose(context, states, key, settled);
	return {
		pose:
			lengths.size === 0
				? pose
				: { ...pose, key: `${pose.key} lengths ${JSON.stringify([...lengths])}`, lengths },
		states: settled.flatMap(({ states: layerStates }) =>
			layerStates.map((state) => text(state.stateName) ?? ''),
		),
		effects,
	};
};
