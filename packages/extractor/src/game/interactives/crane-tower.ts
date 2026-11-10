/* oxlint-disable no-await-in-loop -- reads a GameObject's MonoBehaviours in order */
import { crc32 } from 'node:zlib';

import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import {
	type InteractiveParam,
	type LevelInteractive,
	interactiveParamFromValue,
} from '@endfield-noclip/formats/endfield/level-interactives';
import { isMemoryPackObject, type MemoryPackValue } from '@endfield-noclip/formats/endfield/memory-pack';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import {
	multiplyMatrices,
	multiplyQuaternions,
	trsMatrix,
	unityEulerQuaternion,
} from '@endfield-noclip/formats/unity/transform';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import { pptrField } from '@endfield-noclip/formats/unity/values';

import { type AssetResolver, objectKey, type ObjectRef } from '../assets/assets.ts';
import type { LocalTransform } from '../effects/particle-mesh.ts';
import { walkPrefab } from '../prefabs/prefab-walk.ts';
import type { PrefabPose } from '../prefabs/prefab.ts';

// crane towers and the containers they hang: docs/game-data/interactives.md#crane-towers

/** the game's interactive component type of the crane tower component, as placements key its parameters */
const CRANE_TOWER_COMPONENT = 172;

/** the template component that makes an interactive a crane tower */
export const CRANE_TOWER_COMPONENTS = ['_CraneTowerComponentDataForMemoryPack'];

/** the height a container hangs below the hook when its entity has no `height` property */
export const DEFAULT_CONTAINER_HEIGHT = 4;

const toFloat = (bits: bigint): number => {
	const view = new DataView(new ArrayBuffer(4));
	view.setUint32(0, Number(BigInt.asUintN(32, bits)));
	return view.getFloat32(0);
};

/** a crane tower's step lists and the container it carries */
export interface CraneTower {
	/** rope lengths, picked by `state_1` (`position_list`) */
	ropeLengths: number[];
	/** world yaws of the arm, picked by `state_2` (`rotation_list`) */
	armYaws: number[];
	/** world yaws of the hook and its container, picked by `state_3` (`euler_angles`) */
	hookYaws: number[];
	/** the logic id of the container it carries (`target`), `null` for none */
	target: bigint | null;
}

/**
 * the crane tower component's parameters: the template's, overridden by the placement's own
 *
 * @param template the decoded template
 * @param row the placement
 * @returns its step lists and target, or `null` without a crane tower component
 */
export const craneTowerOf = (template: MemoryPackValue, row: LevelInteractive): CraneTower | null => {
	const component =
		isMemoryPackObject(template) && Array.isArray(template.componentList)
			? template.componentList.find((entry) => {
					const type = isMemoryPackObject(entry) ? entry.$type : null;
					return typeof type === 'string' && CRANE_TOWER_COMPONENTS.some((suffix) => type.endsWith(suffix));
				})
			: undefined;
	if (!isMemoryPackObject(component)) {
		return null;
	}
	const params = new Map<string, InteractiveParam>();
	for (const value of Array.isArray(component.propertyList) ? component.propertyList : []) {
		const param = interactiveParamFromValue(value);
		params.set(param.key, param);
	}
	for (const param of row.componentProperties.get(CRANE_TOWER_COMPONENT) ?? []) {
		params.set(param.key, param);
	}
	const floats = (key: string): number[] => (params.get(key)?.values ?? []).map((atom) => toFloat(atom.bits));
	const target = params.get('target')?.values[0]?.bits ?? 0n;
	return {
		ropeLengths: floats('position_list'),
		armYaws: floats('rotation_list'),
		hookYaws: floats('euler_angles'),
		target: target === 0n ? null : target,
	};
};

/** what a crane tower starts at: its steps' values */
export interface CraneSteps {
	ropeLength: number;
	armYaw: number;
	hookYaw: number;
}

/** @returns the list's value at the index clamped to it, as the game clamps a step */
const pick = (list: readonly number[], index: number): number | undefined =>
	list[Math.min(Math.max(index, 0), list.length - 1)];

/**
 * @param tower the tower's step lists
 * @param states its `state_1`, `state_2` and `state_3` properties
 * @returns the values the states pick, each index clamped to its list; `null` when a list is empty
 */
export const craneSteps = (
	tower: CraneTower,
	states: readonly [number, number, number],
): CraneSteps | null => {
	const ropeLength = pick(tower.ropeLengths, states[0]);
	const armYaw = pick(tower.armYaws, states[1]);
	const hookYaw = pick(tower.hookYaws, states[2]);
	if (ropeLength === undefined || armYaw === undefined || hookYaw === undefined) {
		return null;
	}
	return { ropeLength, armYaw, hookYaw };
};

/** a crane tower's look and the point its container hangs from */
export interface CraneLook {
	pose: PrefabPose;
	/** the hook's attach point in world space */
	attach: { position: [number, number, number]; rotation: [number, number, number, number] };
}

/** a Transform of the prefab, as saved */
interface Node extends LocalTransform {
	/** the GameObject's path below the prefab root, `/`-joined; '' for the root */
	path: string;
	/** the parent Transform's key, `null` for the root */
	parent: string | null;
}

/** local values the tower component sets on a Transform */
interface Posed {
	position?: [number, number, number];
	rotation?: [number, number, number, number];
	scale?: [number, number, number];
}

/** the crane postmodel MonoBehaviour's Transform fields, as the game's tower component reads them */
const MONO_FIELDS = ['rotateBaseTrans', 'rotateHeaderTrans', 'ropeEndTrans', 'ropeScaleTrans', 'attachTrans'];

/**
 * reads a crane tower prefab's look at its steps, as the tower component sets it up: the rope stretched and
 * its end lowered by the rope length, the arm's base and the hook turned to their world yaws
 *
 * @param resolver bundle reader
 * @param root the prefab's root GameObject
 * @param key tells this prefab's poses apart from other prefabs'
 * @param placement the tower's world position, rotation (xyzw) and scale
 * @param steps the values its states pick
 * @returns its pose and hook, or `null` when the prefab has no crane postmodel MonoBehaviour
 * @throws {FormatError} on a malformed hierarchy, or a MonoBehaviour Transform outside the prefab
 */
export const readCraneLook = async (
	resolver: AssetResolver,
	root: ObjectRef,
	key: string,
	placement: {
		position: readonly number[];
		rotation: readonly number[];
		scale: readonly number[];
	},
	steps: CraneSteps,
): Promise<CraneLook | null> => {
	const nodes = new Map<string, Node>();
	// the game takes the first such MonoBehaviour in the hierarchy, the root's own first
	let mono: { ref: ObjectRef; data: TypeTreeObject } | null = null;
	await walkPrefab<string>(
		resolver,
		root,
		{
			enter: async (node, parentPath) => {
				let path = '';
				if (!node.isRoot) {
					path = parentPath === '' ? node.name : `${parentPath}/${node.name}`;
				}
				nodes.set(node.transformKey, { ...node.saved, path, parent: node.parent?.transformKey ?? null });
				for (const component of mono === null ? node.ofClass(UnityClass.MonoBehaviour) : []) {
					const data = await component.read();
					if (MONO_FIELDS.every((field) => field in data)) {
						mono = { ref: component.ref, data };
						break;
					}
				}
				return path;
			},
		},
		'',
	);
	const found = mono as { ref: ObjectRef; data: TypeTreeObject } | null;
	if (found === null) {
		return null;
	}
	const [base, header, ropeEnd, ropeScale, attach] = await Promise.all(
		MONO_FIELDS.map(async (field) => {
			const ref = await resolver.resolve(found.ref, pptrField(found.data, field));
			const tKey = ref === null ? undefined : objectKey(ref);
			if (tKey === undefined || !nodes.has(tKey)) {
				throw new FormatError(`crane postmodel ${field} isn't a Transform of the prefab`);
			}
			return tKey;
		}),
	);
	// local overrides by Transform key, applied over the saved values
	const posed = new Map<string, Posed>();
	const local = (tKey: string): Node => ({ ...nodes.get(tKey)!, ...posed.get(tKey) });
	const placementRotation = [...placement.rotation];
	const worldRotation = (tKey: string | null): [number, number, number, number] => {
		if (tKey === null) {
			return [placementRotation[0], placementRotation[1], placementRotation[2], placementRotation[3]];
		}
		const node = local(tKey);
		// the root's own rotation is the placement's
		return node.parent === null
			? worldRotation(null)
			: multiplyQuaternions(worldRotation(node.parent), node.rotation);
	};
	// a world rotation set on a Transform becomes the local rotation under its parent's
	const setWorldYaw = (tKey: string, yaw: number): void => {
		const [x, y, z, w] = worldRotation(nodes.get(tKey)!.parent);
		const rotation = multiplyQuaternions([-x, -y, -z, w], unityEulerQuaternion([0, yaw, 0]));
		posed.set(tKey, { ...posed.get(tKey), rotation });
	};
	posed.set(ropeScale, { ...posed.get(ropeScale), scale: [1, 1, steps.ropeLength + 1] });
	posed.set(ropeEnd, { ...posed.get(ropeEnd), position: [0, -steps.ropeLength, 0] });
	setWorldYaw(base, steps.armYaw);
	setWorldYaw(header, steps.hookYaw);
	const worldMatrix = (tKey: string): Float32Array => {
		const node = local(tKey);
		if (node.parent === null) {
			return trsMatrix(placement.position, placement.rotation, placement.scale);
		}
		return multiplyMatrices(worldMatrix(node.parent), trsMatrix(node.position, node.rotation, node.scale));
	};
	const hook = worldMatrix(attach);
	const transforms = new Map(
		[...posed].map(([tKey, values]) => {
			const node = nodes.get(tKey)!;
			const list = [];
			if (values.position) {
				list.push({ kind: 'position' as const, value: values.position });
			}
			if (values.rotation) {
				list.push({ kind: 'rotation' as const, value: values.rotation });
			}
			if (values.scale) {
				list.push({ kind: 'scale' as const, value: values.scale });
			}
			return [crc32(node.path) >>> 0, list] as const;
		}),
	);
	return {
		pose: {
			key: `${key}:crane:${JSON.stringify([...posed.values()], (_, value) => (typeof value === 'number' ? Math.round(value * 1e4) / 1e4 : value))}`,
			clips: [
				{
					animator: null,
					transforms,
					active: new Map(),
					materials: new Map(),
					renderers: new Map(),
					motion: null,
				},
			],
			active: new Map(),
		},
		attach: { position: [hook[12], hook[13], hook[14]], rotation: worldRotation(attach) },
	};
};
