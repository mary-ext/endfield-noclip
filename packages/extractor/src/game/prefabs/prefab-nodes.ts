/* oxlint-disable no-await-in-loop -- walks a prefab's hierarchy in authored order */
import { crc32 } from 'node:zlib';

import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import { isTransformClass } from '@endfield-noclip/formats/unity/serialized-file';
import { multiplyMatrices, trsMatrix } from '@endfield-noclip/formats/unity/transform';
import {
	arrayField,
	asPPtr,
	isObject,
	numberField,
	objectField,
	pptrField,
	stringField,
} from '@endfield-noclip/formats/unity/values';

import { objectKey, type AssetResolver, type ObjectRef } from '../assets/assets.ts';

import type { PrefabPose } from './prefab.ts';

const xyz = (value: ReturnType<typeof objectField>): [number, number, number] => [
	numberField(value, 'x'),
	numberField(value, 'y'),
	numberField(value, 'z'),
];

/**
 * @param resolver bundle reader
 * @param root prefab GameObject
 * @param pose the view-state pose its clips leave it in, or `null` for the saved one
 * @returns each GameObject's matrix in prefab space by name (the first in authored order where names repeat),
 *   with the root's at the identity
 * @throws {FormatError} on a malformed or cyclic hierarchy
 */
export const prefabNodeMatrices = async (
	resolver: AssetResolver,
	root: ObjectRef,
	pose: PrefabPose | null,
): Promise<Map<string, Float32Array>> => {
	const matrices = new Map<string, Float32Array>();
	const seen = new Set<string>();
	const clips = pose?.clips ?? [];
	const visit = async (
		go: ObjectRef,
		parent: Float32Array | null,
		/** per pose clip, the parent's path below that clip's Animator, `null` outside it */
		above: readonly (string | null)[],
	): Promise<void> => {
		const key = objectKey(go);
		if (seen.has(key)) {
			throw new FormatError(`cyclic prefab hierarchy at ${key}`);
		}
		seen.add(key);
		const data = await resolver.read(go);
		const name = stringField(data, 'm_Name');
		// clip bindings name GameObjects by their `/`-joined path below the Animator's own, which is ''
		const below = clips.map((clip, i): string | null => {
			const parentPath = above[i] ?? null;
			if (parentPath !== null) {
				return parentPath === '' ? name : `${parentPath}/${name}`;
			}
			return (parent === null ? clip.animator === null : name === clip.animator) ? '' : null;
		});
		let transform: ObjectRef | null = null;
		for (const item of arrayField(data, 'm_Component')) {
			if (!isObject(item)) {
				throw new FormatError('prefab component is not an object');
			}
			const ref = await resolver.resolve(go, pptrField(item, 'component'));
			if (ref !== null && isTransformClass(ref.info.classId)) {
				transform = ref;
				break;
			}
		}
		if (transform === null) {
			throw new FormatError(`prefab GameObject ${key} has no Transform`);
		}
		const t = await resolver.read(transform);
		let matrix: Float32Array;
		if (parent === null) {
			// the root's own placement comes from the caller
			matrix = trsMatrix([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
		} else {
			const rotation = objectField(t, 'm_LocalRotation');
			let position: readonly number[] = xyz(objectField(t, 'm_LocalPosition'));
			let quaternion: readonly number[] = [...xyz(rotation), numberField(rotation, 'w')];
			let scale: readonly number[] = xyz(objectField(t, 'm_LocalScale'));
			for (const [i, clip] of clips.entries()) {
				const path = below[i];
				if (path === null) {
					continue;
				}
				for (const value of clip.transforms.get(crc32(path) >>> 0) ?? []) {
					switch (value.kind) {
						case 'position': {
							position = value.value;
							break;
						}
						case 'rotation': {
							quaternion = value.value;
							break;
						}
						case 'scale': {
							scale = value.value;
							break;
						}
					}
				}
			}
			matrix = multiplyMatrices(parent, trsMatrix(position, quaternion, scale));
		}
		if (!matrices.has(name)) {
			matrices.set(name, matrix);
		}
		for (const pointer of arrayField(t, 'm_Children')) {
			const child = await resolver.resolve(transform, asPPtr(pointer));
			if (child === null) {
				continue;
			}
			const childGo = await resolver.resolve(child, pptrField(await resolver.read(child), 'm_GameObject'));
			if (childGo !== null) {
				await visit(childGo, matrix, below);
			}
		}
	};
	await visit(root, null, []);
	return matrices;
};
