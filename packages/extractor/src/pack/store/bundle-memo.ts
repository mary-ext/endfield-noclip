import type { BundleManifest } from '@endfield-noclip/formats/hg/bundle-manifest';

import type { AssetResolver, LocatedObject } from '../../game/assets/assets.ts';
import type { BundleSource } from '../convert/convert-pool.ts';

// shared helpers for caching values that read Unity bundles and reference objects inside them: bundle indices
// shift across game updates, so memos record bundle names and catalog MD5s and relocate indices on recall.

/** a {@link LocatedObject} stored in a cache memo with its bundle's name instead of its manifest index */
export interface SavedLocator {
	key: string;
	bundle: string;
	file: string;
	pathId: bigint;
}

/**
 * records the catalog MD5 of every bundle an operation touched
 *
 * @param resolver asset resolver
 * @param bundles manifest bundle indices touched
 * @returns bundle names and MD5s for cache validation
 */
export const bundleSources = (resolver: AssetResolver, bundles: readonly number[]): Promise<BundleSource[]> =>
	Promise.all(
		bundles.map(async (index) => ({
			bundle: resolver.manifest.bundleName(index),
			md5: await resolver.bundleMd5(index),
		})),
	);

/** per-resolver cache of `bundleName:md5` → whether the bundle still matches its recorded MD5 */
const bundleChecks = new WeakMap<AssetResolver, Map<string, Promise<boolean>>>();

/**
 * checks whether every bundle in `sources` still exists in the install with the same catalog MD5
 *
 * @param resolver asset resolver
 * @param sources recorded bundle sources
 * @returns `true` if all bundles match their recorded MD5s
 */
export const sourcesCurrent = async (
	resolver: AssetResolver,
	sources: readonly BundleSource[],
): Promise<boolean> => {
	if (sources.length === 0) {
		return true;
	}
	let checks = bundleChecks.get(resolver);
	if (checks === undefined) {
		checks = new Map();
		bundleChecks.set(resolver, checks);
	}
	const results = await Promise.all(
		sources.map(({ bundle, md5 }) =>
			checks.getOrInsertComputed(`${bundle}\0${md5}`, async () => {
				const index = resolver.manifest.findBundle(bundle);
				return index !== undefined && (await resolver.bundleMd5(index)) === md5;
			}),
		),
	);
	return results.every(Boolean);
};

/**
 * converts a {@link LocatedObject} into a manifest-independent {@link SavedLocator}
 *
 * @param manifest bundle manifest
 * @param object located object
 * @returns saved locator using the bundle's name
 */
export const saveLocated = (manifest: BundleManifest, object: LocatedObject): SavedLocator => ({
	key: object.key,
	bundle: manifest.bundleName(object.locator.bundleIndex),
	file: object.locator.file,
	pathId: object.locator.pathId,
});

/**
 * resolves a {@link SavedLocator} back into this install's manifest
 *
 * @param manifest bundle manifest
 * @param saved saved locator
 * @returns the relocated object, or `undefined` if its bundle is no longer in the manifest
 */
export const relocateSaved = (manifest: BundleManifest, saved: SavedLocator): LocatedObject | undefined => {
	const bundleIndex = manifest.findBundle(saved.bundle);
	if (bundleIndex === undefined) {
		return undefined;
	}
	return {
		key: saved.key,
		locator: { bundleIndex, file: saved.file, pathId: saved.pathId },
	};
};
