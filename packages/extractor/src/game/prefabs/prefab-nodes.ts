import type { AssetResolver, ObjectRef } from '../assets/assets.ts';

import { type ClipPaths, clipPaths, posedLocal } from './pose-paths.ts';
import { walkPrefab } from './prefab-walk.ts';
import type { PrefabPose } from './prefab.ts';

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
	const clips = pose?.clips ?? [];
	const transforms = clips.map((clip) => clip.transforms);
	await walkPrefab<ClipPaths>(
		resolver,
		root,
		{
			enter: (node, above) => clipPaths(clips, above, node),
			local: (node, paths) => posedLocal(node.saved, transforms, paths),
			visit: (node) => {
				if (!matrices.has(node.name)) {
					matrices.set(node.name, node.matrix);
				}
			},
		},
		[],
	);
	return matrices;
};
