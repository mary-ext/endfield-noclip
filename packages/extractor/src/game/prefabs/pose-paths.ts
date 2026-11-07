import { crc32 } from 'node:zlib';

import type { ClipTransformValue } from '@endfield-noclip/formats/unity/animation-clip';

import type { LocalTransform } from '../effects/particle-mesh.ts';

import type { PoseClip } from './prefab.ts';

// where a pose's clips bind in a prefab: clip bindings name GameObjects by their `/`-joined path below the
// Animator's own, which is ''

/** per pose clip, a GameObject's path below that clip's Animator, `null` outside it */
export type ClipPaths = readonly (string | null)[];

/**
 * @param clips the pose's clips
 * @param above the parent's paths; empty on the root
 * @param node the GameObject
 * @returns its paths
 */
export const clipPaths = (
	clips: readonly PoseClip[],
	above: ClipPaths,
	node: { name: string; isRoot: boolean },
): ClipPaths =>
	clips.map((clip, i): string | null => {
		const parentPath = above[i] ?? null;
		if (parentPath !== null) {
			return parentPath === '' ? node.name : `${parentPath}/${node.name}`;
		}
		return (node.isRoot ? clip.animator === null : node.name === clip.animator) ? '' : null;
	});

/** @returns a path's binding key, as clips key their values */
export const bindingKey = (path: string): number => crc32(path) >>> 0;

/**
 * @param local the local transform as saved
 * @param transforms per pose clip, the Transform values it sets by binding key
 * @param paths the GameObject's {@link clipPaths}
 * @returns the local transform with each clip's values in turn replacing the saved ones
 */
export const posedLocal = (
	local: LocalTransform,
	transforms: readonly ReadonlyMap<number, readonly ClipTransformValue[]>[],
	paths: ClipPaths,
): LocalTransform => {
	const posed = { ...local };
	for (const [i, values] of transforms.entries()) {
		const path = paths[i] ?? null;
		for (const value of path === null ? [] : (values.get(bindingKey(path)) ?? [])) {
			switch (value.kind) {
				case 'position': {
					posed.position = value.value;
					break;
				}
				case 'rotation': {
					posed.rotation = value.value;
					break;
				}
				case 'scale': {
					posed.scale = value.value;
					break;
				}
			}
		}
	}
	return posed;
};
