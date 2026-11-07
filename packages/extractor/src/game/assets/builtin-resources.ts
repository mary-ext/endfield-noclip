import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';

import type { WorldIndex } from '../world/world-index.ts';

import type { BuiltinLookup, ObjectRef } from './assets.ts';

// the game references a few of Unity's built-in meshes (`library/unity default resources`), which ship in the
// player rather than in any bundle. the render pipeline bundles copies of them, which stand in.
// see docs/game-data/assets.md#built-in-meshes.

/** the render pipeline's unit quad: Unity's built-in Quad's geometry, and what billboard particles draw */
export const RENDER_PIPELINE_QUAD_PATH =
	'Packages/com.hg.render-pipelines/Runtime/RenderPipelineResources/Mesh/Quad.fbx';

const DEFAULT_RESOURCES = 'library/unity default resources';

/** built-in mesh path id in {@link DEFAULT_RESOURCES} → the bundled copy's asset path */
const BUILTIN_MESHES = new Map<bigint, string>([
	[10202n, 'Packages/com.hg.render-pipelines/Runtime/RenderPipelineResources/Mesh/Cube.fbx'],
	[10210n, RENDER_PIPELINE_QUAD_PATH],
]);

/**
 * @param world the world index, to hash the bundled copies' paths
 * @returns a lookup substituting the render pipeline's copies for Unity's built-in Cube and Quad; it reads
 *   the path hash table only when one is asked for
 */
export const builtinResources = (world: WorldIndex): BuiltinLookup => {
	const found = new Map<string, Promise<ObjectRef | null>>();
	return async (resolver, file, pathId) => {
		const path = BUILTIN_MESHES.get(pathId);
		if (file !== DEFAULT_RESOURCES || path === undefined) {
			return null;
		}
		return found.getOrInsertComputed(path, async () => {
			const [hash] = await world.hashesOf(path);
			if (hash === undefined) {
				return null;
			}
			return resolver.findUnique({ hash, path }, UnityClass.Mesh);
		});
	};
};
