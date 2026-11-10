/* oxlint-disable no-await-in-loop -- reads a GameObject's MonoBehaviours in order */
import { crc32 } from 'node:zlib';

import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import type { LevelInteractive } from '@endfield-noclip/formats/endfield/level-interactives';
import type { MemoryPackValue } from '@endfield-noclip/formats/endfield/memory-pack';
import type { ClipTransformValue } from '@endfield-noclip/formats/unity/animation-clip';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import { inverseTransformPoint, multiplyMatrices, trsMatrix } from '@endfield-noclip/formats/unity/transform';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import { numberField, pptrField } from '@endfield-noclip/formats/unity/values';

import { type AssetResolver, objectKey, type ObjectRef } from '../assets/assets.ts';
import type { LocalTransform } from '../effects/particle-mesh.ts';
import { walkPrefab } from '../prefabs/prefab-walk.ts';
import type { PoseClip } from '../prefabs/prefab.ts';

import { type ComponentKeys, componentParams } from './component-params.ts';
import { atomFloat, type EntityProperties, entityProperty, entityState } from './template-data.ts';

// lifts: docs/game-data/interactives.md#lifts

/** the lift's core component, which moves its platform between floors */
const LIFTER_CORE: ComponentKeys = {
	suffix: '_LifterCoreComponentDataForMemoryPack',
	diffKey: 'Comp_LifterCore',
	type: 154,
};

/** the template component that makes an interactive a lift */
export const LIFTER_CORE_COMPONENTS = [LIFTER_CORE.suffix];

/** what a lift starts at */
export interface LifterStart {
	/** its floor, the entity's `state` */
	floor: number;
	/** where the platform stands at that floor, in world space */
	position: [number, number, number];
	/** the view-state keys it sets as it starts: `left_opened`, `right_opened` and `moving` (0 or 1) */
	keys: Map<string, number>;
}

/**
 * @param template the decoded lift template
 * @param entity its entity properties
 * @param row a placed lift
 * @returns its floor, the platform's position there and the door keys that floor's `doorside_list` entry
 *   sets, or why it can't start: `position_list` doesn't list its floor
 */
export const lifterStart = (
	template: MemoryPackValue,
	entity: EntityProperties,
	row: LevelInteractive,
): LifterStart | { reason: string } => {
	const floor = entityState(entity, row);
	const floats = (entityProperty(entity, row, 'position_list') ?? []).map((atom) => atomFloat(atom.bits));
	if (floor < 0 || floats.length < (floor + 1) * 3) {
		return { reason: `lift floor ${floor} isn't in its position_list (${floats.length / 3} floors)` };
	}
	const side = componentParams(template, row, LIFTER_CORE)?.get('doorside_list')?.values[floor]?.bits ?? 0n;
	// a set bit closes that side: bit 0 the right door, bit 1 the left
	const keys = new Map([
		['left_opened', (side & 2n) === 0n ? 1 : 0],
		['right_opened', (side & 1n) === 0n ? 1 : 0],
		['moving', 0],
	]);
	return { floor, position: [floats[floor * 3], floats[floor * 3 + 1], floats[floor * 3 + 2]], keys };
};

/** the lift postmodel MonoBehaviour's fields, as the lift's core component reads them */
const MONO_FIELDS = ['MovingPartRoot', 'Pole', 'PoleHeight', 'PlacformThickness'];

/** a Transform of the prefab, as saved */
interface Node extends LocalTransform {
	/** the GameObject's path below the prefab root, `/`-joined; '' for the root */
	path: string;
	/** the parent Transform's key, `null` for the root */
	parent: string | null;
}

/**
 * reads a lift prefab's look at its starting floor, as its core component sets it up: the moving part placed
 * at the floor's world position, and the pole's height scaled to reach the platform's underside
 *
 * @param resolver bundle reader
 * @param root the prefab's root GameObject
 * @param placement the lift's world position, rotation (xyzw) and scale
 * @param start what it starts at
 * @returns the clip that poses it and a key telling it apart from the prefab's other poses, or `null` when
 *   the prefab has no lift postmodel MonoBehaviour
 * @throws {FormatError} on a malformed hierarchy, or a MonoBehaviour Transform outside the prefab
 */
export const readLifterLook = async (
	resolver: AssetResolver,
	root: ObjectRef,
	placement: { position: readonly number[]; rotation: readonly number[]; scale: readonly number[] },
	start: LifterStart,
): Promise<{ clip: PoseClip; key: string } | null> => {
	const nodes = new Map<string, Node>();
	// the core component asks the model's root for the MonoBehaviour
	let mono: { ref: ObjectRef; data: TypeTreeObject } | null = null;
	await walkPrefab<string>(
		resolver,
		root,
		{
			enter: async (node, parentPath) => {
				let path = '';
				if (!node.isRoot) {
					path = parentPath === '' ? node.name : `${parentPath}/${node.name}`;
				} else {
					for (const component of node.ofClass(UnityClass.MonoBehaviour)) {
						const data = await component.read();
						if (MONO_FIELDS.every((field) => field in data)) {
							mono = { ref: component.ref, data };
							break;
						}
					}
				}
				nodes.set(node.transformKey, { ...node.saved, path, parent: node.parent?.transformKey ?? null });
				return path;
			},
		},
		'',
	);
	const found = mono as { ref: ObjectRef; data: TypeTreeObject } | null;
	if (found === null) {
		return null;
	}
	const transformOf = async (field: string): Promise<string | null> => {
		const ref = await resolver.resolve(found.ref, pptrField(found.data, field));
		if (ref === null) {
			return null;
		}
		if (!nodes.has(objectKey(ref))) {
			throw new FormatError(`lift postmodel ${field} isn't a Transform of the prefab`);
		}
		return objectKey(ref);
	};
	const moving = await transformOf('MovingPartRoot');
	const pole = await transformOf('Pole');
	const movingParent = moving === null ? null : nodes.get(moving)!.parent;
	if (moving === null || movingParent === null) {
		// the root's own placement is the caller's, so it can't be moved here
		throw new FormatError('lift postmodel has no MovingPartRoot below its root');
	}
	const worldMatrix = (tKey: string): Float32Array => {
		const node = nodes.get(tKey)!;
		if (node.parent === null) {
			return trsMatrix(placement.position, placement.rotation, placement.scale);
		}
		return multiplyMatrices(worldMatrix(node.parent), trsMatrix(node.position, node.rotation, node.scale));
	};
	const transforms = new Map<number, ClipTransformValue[]>();
	const posed: number[] = [];
	{
		const node = nodes.get(moving)!;
		const position = inverseTransformPoint(worldMatrix(movingParent), start.position);
		transforms.set(crc32(node.path) >>> 0, [{ kind: 'position', value: position }]);
		posed.push(...position);
	}
	if (pole !== null) {
		// the pole's height at the bottom floor is read once the model is placed and before the platform moves,
		// so it's taken from the saved hierarchy; the platform's underside sits its thickness below the floor
		const height = numberField(found.data, 'PoleHeight');
		const thickness = numberField(found.data, 'PlacformThickness');
		const node = nodes.get(pole)!;
		const scale: [number, number, number] = [
			1,
			(start.position[1] - worldMatrix(pole)[13] - thickness) / height,
			1,
		];
		transforms.set(crc32(node.path) >>> 0, [{ kind: 'scale', value: scale }]);
		posed.push(scale[1]);
	}
	return {
		clip: {
			animator: null,
			transforms,
			active: new Map(),
			materials: new Map(),
			renderers: new Map(),
			motion: null,
		},
		key: `lift ${start.floor} ${posed.map((value) => Math.round(value * 1e4) / 1e4).join(',')}`,
	};
};
