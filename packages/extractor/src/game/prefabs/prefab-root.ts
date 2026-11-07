import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';

import { unique } from '@mary-ext/array-fns';

import { formatErrorOnly } from '../../errors.ts';
import type { AssetResolver, ObjectRef } from '../assets/assets.ts';

/** a prefab's root GameObject, or why it can't be read, and how reports name the prefab */
export interface PrefabRoot {
	/** its asset path, or its hash when that names no single path */
	label: string;
	root: ObjectRef | FormatError;
}

/** finds each placed prefab's root GameObject once, however many readers and placements ask */
export class PrefabRoots {
	readonly resolver: AssetResolver;
	readonly #roots = new Map<bigint, Promise<PrefabRoot>>();

	/** @param resolver bundle reader */
	constructor(resolver: AssetResolver) {
		this.resolver = resolver;
	}

	/**
	 * @param hash the prefab's path hash
	 * @returns its root, or the `FormatError` that kept it from being found: the hash names no single manifest
	 *   path, or the path's GameObject can't be read
	 */
	root(hash: bigint): Promise<PrefabRoot> {
		return this.#roots.getOrInsertComputed(hash, async () => {
			const { manifest } = this.resolver;
			const paths = unique(manifest.findAssets(hash).map((asset) => manifest.assetPath(asset)));
			const label = paths.length === 1 ? paths[0] : `0x${hash.toString(16)}`;
			if (paths.length !== 1) {
				return { label, root: new FormatError(`prefab has ${paths.length} manifest paths`) };
			}
			const root = await this.resolver
				.findUnique({ hash, path: paths[0] }, UnityClass.GameObject)
				.catch(formatErrorOnly);
			return { label, root };
		});
	}
}
