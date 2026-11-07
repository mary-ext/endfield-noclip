/* oxlint-disable no-await-in-loop -- walks a small subtree in authored order */
import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import { readClipActivity } from '@endfield-noclip/formats/unity/animation-clip';
import { isTransformClass, UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import {
	arrayField,
	asPPtr,
	isObject,
	numberField,
	objectField,
	pptrField,
} from '@endfield-noclip/formats/unity/values';

import { objectKey, type AssetResolver, type ObjectRef } from '../assets/assets.ts';

// effects a prefab's view states never show at rest: docs/game-data/effects.md#one-shot-effects

const fieldNames = (ref: ObjectRef): Set<string> =>
	new Set(ref.info.type?.nodes.filter((node) => node.level === 1).map((node) => node.name));

/**
 * @param resolver bundle reader
 * @param animator an Animator component
 * @param data its fields
 * @returns binding paths (CRC32 of the path below the Animator) of the GameObjects its controller's clips
 *   switch but never show: every clip that animates their activity starts and ends with them off. empty for a
 *   disabled Animator or a controller other than a plain AnimatorController
 */
export const animatorHiddenNodes = async (
	resolver: AssetResolver,
	animator: ObjectRef,
	data: TypeTreeObject,
): Promise<Set<number>> => {
	const hidden = new Set<number>();
	if (numberField(data, 'm_Enabled') === 0) {
		return hidden;
	}
	const controller = await resolver.resolve(animator, pptrField(data, 'm_Controller'));
	if (controller === null || controller.info.classId !== UnityClass.AnimatorController) {
		return hidden;
	}
	const shown = new Set<number>();
	for (const pointer of arrayField(await resolver.read(controller), 'm_AnimationClips')) {
		const clip = await resolver.resolve(controller, asPPtr(pointer));
		if (clip === null) {
			continue;
		}
		for (const [path, on] of readClipActivity(await resolver.read(clip))) {
			(on ? shown : hidden).add(path);
		}
	}
	for (const path of shown) {
		hidden.delete(path);
	}
	return hidden;
};

/**
 * @param ref a MonoBehaviour
 * @returns whether it's a prefab's own view-state controller (`PostModelViewStateController` and its kin)
 */
export const isViewStateControllerType = (ref: ObjectRef): boolean => {
	const names = fieldNames(ref);
	return names.has('stateList') && names.has('animatorNode');
};

/**
 * @param resolver bundle reader
 * @param controller the controller component (see {@link isViewStateControllerType})
 * @param data its fields
 * @returns keys of the GameObjects its states switch on to play an effect
 */
export const playedEffectNodes = async (
	resolver: AssetResolver,
	controller: ObjectRef,
	data: TypeTreeObject,
): Promise<Set<string>> => {
	const nodes = new Set<string>();
	for (const state of arrayField(data, 'stateList')) {
		if (!isObject(state)) {
			throw new FormatError('invalid view state');
		}
		for (const config of arrayField(state, 'effectPlayConfigs')) {
			if (!isObject(config)) {
				throw new FormatError('invalid view state effect');
			}
			if (numberField(config, 'controlActive') === 0) {
				continue;
			}
			const node = await resolver.resolve(controller, pptrField(config, 'effectNode'));
			if (node !== null) {
				nodes.add(objectKey(node));
			}
		}
	}
	return nodes;
};

/**
 * @param ref a MonoBehaviour
 * @returns whether it's an `EffectSetting`
 */
export const isEffectSettingType = (ref: ObjectRef): boolean => fieldNames(ref).has('effectLogicCfg');

/**
 * @param resolver bundle reader
 * @param setting an `EffectSetting` (see {@link isEffectSettingType})
 * @param data its fields
 * @returns keys of the GameObjects its LOD table switches. the table keeps each one off when it was saved off
 *   (docs/game-data/effects.md#effect-lod-tables), so those never show. empty when the setting is disabled
 */
export const effectLodNodes = async (
	resolver: AssetResolver,
	setting: ObjectRef,
	data: TypeTreeObject,
): Promise<Set<string>> => {
	const nodes = new Set<string>();
	if (numberField(data, 'm_Enabled') === 0) {
		return nodes;
	}
	for (const entry of arrayField(data, 'lodSetting')) {
		if (!isObject(entry)) {
			throw new FormatError('invalid effect LOD entry');
		}
		const node = await resolver.resolve(setting, pptrField(entry, 'gameobject'));
		if (node !== null) {
			nodes.add(objectKey(node));
		}
	}
	return nodes;
};

/** camera distances `near < d ≤ far`, in metres */
export interface DistanceRange {
	near: number;
	far: number;
}

/**
 * @param a ranges, ascending and disjoint
 * @param b likewise
 * @returns the distances in both, ascending and disjoint
 */
export const intersectRanges = (
	a: readonly DistanceRange[],
	b: readonly DistanceRange[],
): DistanceRange[] => {
	const out: DistanceRange[] = [];
	for (const x of a) {
		for (const y of b) {
			const near = Math.max(x.near, y.near);
			const far = Math.min(x.far, y.far);
			if (near < far) {
				out.push({ near, far });
			}
		}
	}
	return out.toSorted((p, q) => p.near - q.near);
};

/** an `EffectSetting`'s distance LOD: where the camera has to be for the GameObjects it switches to show */
export interface EffectDistanceLod {
	/** where the setting's own GameObject is on: everywhere, or within the cull distance */
	self: DistanceRange[];
	/** by GameObject key, the distances its LOD entries leave it on at */
	nodes: Map<string, DistanceRange[]>;
}

/**
 * @param resolver bundle reader
 * @param setting an `EffectSetting` (see {@link isEffectSettingType})
 * @param data its fields
 * @returns the distances its GameObjects show at (docs/game-data/effects.md#effect-lod-tables), or `null`
 *   when the setting is disabled or doesn't switch by distance
 * @throws {FormatError} on a malformed LOD entry or distance band
 */
export const effectDistanceLod = async (
	resolver: AssetResolver,
	setting: ObjectRef,
	data: TypeTreeObject,
): Promise<EffectDistanceLod | null> => {
	if (numberField(data, 'm_Enabled') === 0 || numberField(data, 'isUseDistanceLod') === 0) {
		return null;
	}
	const distances = arrayField(data, 'distanceLodCfgList').map((band) => {
		if (!isObject(band)) {
			throw new FormatError('invalid effect distance band');
		}
		return numberField(band, 'distance');
	});
	if (distances.length === 0) {
		return null;
	}
	// the game picks the last band past whose distance the camera is, or the first; so a band runs from its
	// own distance to the nearest distance of a later band
	const bands = distances.map((distance, i): DistanceRange => {
		const later = distances.slice(i + 1);
		return { near: i === 0 ? 0 : distance, far: Math.min(Infinity, ...later) };
	});
	const nodes = new Map<string, DistanceRange[]>();
	for (const entry of arrayField(data, 'lodSetting')) {
		if (!isObject(entry)) {
			throw new FormatError('invalid effect LOD entry');
		}
		const node = await resolver.resolve(setting, pptrField(entry, 'gameobject'));
		if (node === null) {
			continue;
		}
		const infos = arrayField(entry, '_distanceLodInfos');
		const on: DistanceRange[] = [];
		for (const [i, band] of bands.entries()) {
			const info = infos[i];
			// a band the entry has no info for is assumed on (what the game fills in is unchecked)
			const active = info === undefined || (isObject(info) && numberField(info, 'isActive') !== 0);
			if (!active || band.near >= band.far) {
				continue;
			}
			const previous = on.at(-1);
			if (previous?.far === band.near) {
				previous.far = band.far;
			} else {
				on.push({ ...band });
			}
		}
		const known = nodes.get(objectKey(node));
		nodes.set(objectKey(node), known === undefined ? on : intersectRanges(known, on));
	}
	// past the cull distance the game switches the whole effect off, when `_isCullDisable` asks it to
	const cull = numberField(data, '_isCullDisable') !== 0 ? numberField(data, 'cullDis') : Infinity;
	return { self: [{ near: 0, far: cull }], nodes };
};

/**
 * @param resolver bundle reader
 * @param go a GameObject
 * @returns whether its subtree is effects that don't loop: it has `EffectSetting`s and none loops
 */
export const isOneShotEffect = async (resolver: AssetResolver, go: ObjectRef): Promise<boolean> => {
	let settings = 0;
	const visit = async (node: ObjectRef): Promise<boolean> => {
		const data = await resolver.read(node);
		let transform: ObjectRef | null = null;
		for (const item of arrayField(data, 'm_Component')) {
			if (!isObject(item)) {
				throw new FormatError('prefab component is not an object');
			}
			const ref = await resolver.resolve(node, pptrField(item, 'component'));
			if (ref === null) {
				continue;
			}
			if (isTransformClass(ref.info.classId)) {
				transform = ref;
			} else if (ref.info.classId === UnityClass.MonoBehaviour && isEffectSettingType(ref)) {
				settings++;
				if (numberField(objectField(await resolver.read(ref), 'effectLogicCfg'), 'isLoop') !== 0) {
					return false;
				}
			}
		}
		if (transform === null) {
			throw new FormatError(`prefab GameObject ${objectKey(node)} has no Transform`);
		}
		for (const pointer of arrayField(await resolver.read(transform), 'm_Children')) {
			const child = await resolver.resolve(transform, asPPtr(pointer));
			if (child === null) {
				continue;
			}
			const childGo = await resolver.resolve(child, pptrField(await resolver.read(child), 'm_GameObject'));
			if (childGo !== null && !(await visit(childGo))) {
				return false;
			}
		}
		return true;
	};
	return (await visit(go)) && settings > 0;
};
