import { AsyncLocalStorage } from 'node:async_hooks';

import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import type { UnityBundle } from '@endfield-noclip/formats/hg/bundle';
import type { BundleManifest } from '@endfield-noclip/formats/hg/bundle-manifest';
import { type ObjectInfo, UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import type { PPtr, StreamingInfo } from '@endfield-noclip/formats/unity/values';

import type { Keys } from '../config.ts';
import {
	archiveFileName,
	BUNDLE_PREFIX,
	type BundleAssetFile,
	type ContainerEntry,
	bundlePath,
	findBundleFile,
	openAssetFiles,
	openBundle,
} from '../hg/bundles.ts';
import type { Vfs } from '../hg/vfs.ts';

// cross-bundle object resolution. a PPtr's `m_FileID` names an external SerializedFile by CAB name
// (`archive:/CAB-<hex>/CAB-<hex>`), and `m_StreamData` names a `.resS` the same way. CAB names aren't derivable
// from bundle names, but an external is always in the referencing bundle's dependency closure (manifest
// `dependencies`), so a lookup opens just the directories of that closure until the CAB turns up, and
// remembers every CAB it sees on the way.

// #region types

/** an object located in a bundle */
export interface ObjectRef {
	/** manifest bundle index */
	bundleIndex: number;
	file: BundleAssetFile;
	info: ObjectInfo;
}

/**
 * @param ref an object
 * @returns a stable identity: `CAB-<hex>:<path id>`
 */
export const objectKey = (ref: ObjectRef): string => `${ref.file.node.path}:${ref.info.pathId}`;

/** where an object lives, without holding its bundle open; see {@link AssetResolver.objectIn} */
export interface ObjectLocator {
	/** manifest bundle index */
	bundleIndex: number;
	/** SerializedFile name, `CAB-<hex>` */
	file: string;
	pathId: bigint;
}

/**
 * @param ref an object
 * @returns its locator
 */
export const locateObject = (ref: ObjectRef): ObjectLocator => ({
	bundleIndex: ref.bundleIndex,
	file: ref.file.node.path,
	pathId: ref.info.pathId,
});

/** a game asset as InitChunkData names it */
export interface AssetRef {
	/** StringPathHash key */
	hash: bigint;
	/** the path behind the hash (`<container>.fbx##<subasset>`, `.mesh`, `.mat`, …), or `null` if unknown */
	path: string | null;
	/** exact prefab dependency; bypasses path lookup when the asset was reached through a PPtr */
	locator?: ObjectLocator;
	/** mesh-space to prefab-space skinning matrices for a baked authored pose */
	pose?: Float32Array[];
}

// #endregion

/** the bundles touched on behalf of the current {@link recordBundleReads} call */
const bundleReads = new AsyncLocalStorage<Set<number>>();

/**
 * runs `work`, noting every bundle an {@link AssetResolver} opens or reads for it, including bundles whose
 * directories were searched. concurrent calls keep separate records
 *
 * @param work reads through any resolver
 * @returns its result and the manifest indices of the bundles it touched, ascending
 */
export const recordBundleReads = async <T>(
	work: () => Promise<T>,
): Promise<{ result: T; bundles: number[] }> => {
	const bundles = new Set<number>();
	const result = await bundleReads.run(bundles, work);
	return { result, bundles: [...bundles].toSorted((a, b) => a - b) };
};

/** how many opened bundles (directory + a few decoded blocks each) stay cached */
const BUNDLE_CACHE_SIZE = 96;
/** how many bundles' SerializedFiles (metadata, plus small files read whole) stay cached */
const FILE_CACHE_SIZE = 48;

const CLASS_NAMES = new Map<number, string>(Object.entries(UnityClass).map(([name, id]) => [id, name]));

/** @returns the manifest's bundle name, e.g. `main/<hex>.ab`, for any form {@link bundlePath} accepts */
const manifestBundleName = (name: string): string => bundlePath(name).slice(BUNDLE_PREFIX.length);

/** strips a `.resS`/`.resource` suffix so stream files map onto their CAB */
const cabOf = (fileName: string): string => {
	const dot = fileName.indexOf('.');
	return dot < 0 ? fileName : fileName.slice(0, dot);
};

/**
 * @returns whether a PPtr targets the bundle holding `file`; malformed pointers count, so resolving them
 *   throws
 */
const inBundle = (file: BundleAssetFile, pptr: PPtr): boolean => {
	if (pptr.fileId === 0) {
		return true;
	}
	const external = file.file.externals[pptr.fileId - 1];
	return external === undefined || file.bundle.node(archiveFileName(external.pathName)) !== undefined;
};

/** a small insertion-ordered LRU */
class LruCache<K, V> {
	readonly #limit: number;
	readonly #map = new Map<K, V>();

	constructor(limit: number) {
		this.#limit = limit;
	}

	get(key: K): V | undefined {
		const value = this.#map.get(key);
		if (value !== undefined) {
			this.#map.delete(key);
			this.#map.set(key, value);
		}
		return value;
	}

	delete(key: K): void {
		this.#map.delete(key);
	}

	set(key: K, value: V): void {
		this.#map.delete(key);
		this.#map.set(key, value);
		while (this.#map.size > this.#limit) {
			const oldest = this.#map.keys().next();
			if (oldest.done === true) {
				break;
			}
			this.#map.delete(oldest.value);
		}
	}
}

/** resolves objects, PPtrs and stream data across bundles; caches what it opens */
export class AssetResolver {
	readonly context: { vfs: Vfs; keys: Keys };
	readonly manifest: BundleManifest;
	readonly #bundles = new LruCache<number, Promise<UnityBundle>>(BUNDLE_CACHE_SIZE);
	readonly #files = new LruCache<number, Promise<BundleAssetFile[]>>(FILE_CACHE_SIZE);
	/** per bundle: lowercase container path → entries and their owning objects */
	readonly #containers = new LruCache<
		number,
		Promise<Map<string, { from: ObjectRef; entry: ContainerEntry }[]>>
	>(FILE_CACHE_SIZE);
	/** CAB name (without extension) → bundle index, for every bundle directory seen */
	readonly #cabs = new Map<string, number>();
	/** bundles whose directory has been registered in {@link #cabs} */
	readonly #scanned = new Set<number>();

	/**
	 * @param context VFS and keys
	 * @param manifest the bundle manifest
	 */
	constructor(context: { vfs: Vfs; keys: Keys }, manifest: BundleManifest) {
		this.context = context;
		this.manifest = manifest;
	}

	/**
	 * @param name a bundle hex id, `main/<hex>.ab` or a full logical path
	 * @returns the bundle's manifest index
	 * @throws {Error} if the manifest doesn't list it
	 */
	bundleIndex(name: string): number {
		const index = this.manifest.findBundle(manifestBundleName(name));
		if (index === undefined) {
			throw new Error(`bundle ${name} isn't in the manifest`);
		}
		return index;
	}

	/**
	 * @param index manifest bundle index
	 * @returns the md5 of the bundle's file, from the VFS catalog (nothing is read)
	 */
	async bundleMd5(index: number): Promise<string> {
		return (await findBundleFile(this.context.vfs, this.manifest.bundle(index).name)).entry.dataMd5;
	}

	/**
	 * @param index manifest bundle index
	 * @returns the opened bundle (directory only)
	 */
	bundle(index: number): Promise<UnityBundle> {
		bundleReads.getStore()?.add(index);
		let cached = this.#bundles.get(index);
		if (cached === undefined) {
			cached = openBundle(this.context, this.manifest.bundle(index).name).then((bundle) => {
				this.#register(index, bundle);
				return bundle;
			});
			this.#bundles.set(index, cached);
			// a failed open shouldn't stay cached
			cached.catch(() => this.#bundles.delete(index));
		}
		return cached;
	}

	/**
	 * @param index manifest bundle index
	 * @returns the bundle's SerializedFiles
	 */
	assetFiles(index: number): Promise<BundleAssetFile[]> {
		bundleReads.getStore()?.add(index);
		let cached = this.#files.get(index);
		if (cached === undefined) {
			cached = this.bundle(index).then(openAssetFiles);
			this.#files.set(index, cached);
		}
		return cached;
	}

	/**
	 * @param index manifest bundle index
	 * @param pathId object path id
	 * @returns the object, from whichever of the bundle's SerializedFiles holds it
	 * @throws {Error} if none does
	 */
	async object(index: number, pathId: bigint): Promise<ObjectRef> {
		for (const file of await this.assetFiles(index)) {
			const info = file.file.objectsByPathId.get(pathId);
			if (info !== undefined) {
				return { bundleIndex: index, file, info };
			}
		}
		throw new Error(`${this.manifest.bundle(index).name} has no object with path id ${pathId}`);
	}

	/**
	 * @param index manifest bundle index
	 * @param fileName SerializedFile name, `CAB-<hex>`
	 * @param pathId object path id
	 * @returns the object
	 * @throws {Error} if the bundle has no such file or object
	 */
	async objectIn(index: number, fileName: string, pathId: bigint): Promise<ObjectRef> {
		const file = (await this.assetFiles(index)).find((candidate) => candidate.node.path === fileName);
		if (file === undefined) {
			throw new Error(`${fileName} isn't a SerializedFile of ${this.manifest.bundle(index).name}`);
		}
		const info = file.file.objectsByPathId.get(pathId);
		if (info === undefined) {
			throw new FormatError(`${fileName} has no object with path id ${pathId}`);
		}
		return { bundleIndex: index, file, info };
	}

	/**
	 * @param ref an object
	 * @returns its fields
	 */
	read(ref: ObjectRef): Promise<TypeTreeObject> {
		return ref.file.read(ref.info);
	}

	/**
	 * finds the bundle holding a CAB, searching the dependency closure of `near` when it hasn't been seen
	 *
	 * @param cab CAB name, with or without a `.resS`-style extension
	 * @param near index of the bundle that references it
	 * @returns the holding bundle's index
	 * @throws {Error} if no bundle of the closure holds it
	 */
	async bundleOfCab(cab: string, near: number): Promise<number> {
		const key = cabOf(cab);
		const known = this.#cabs.get(key);
		if (known !== undefined) {
			return known;
		}
		const candidates = [near, ...this.manifest.bundle(near).dependencies].filter(
			(index) => !this.#scanned.has(index),
		);
		// open directories a few at a time; stop as soon as the CAB shows up
		const BATCH = 16;
		for (let i = 0; i < candidates.length; i += BATCH) {
			// oxlint-disable-next-line no-await-in-loop -- batches stop opening bundles once the CAB is found
			await Promise.all(candidates.slice(i, i + BATCH).map((index) => this.bundle(index)));
			const found = this.#cabs.get(key);
			if (found !== undefined) {
				return found;
			}
		}
		throw new Error(
			`${key} isn't in ${this.manifest.bundle(near).name} or its ${candidates.length - 1} dependencies`,
		);
	}

	/**
	 * @param from the object holding the PPtr
	 * @param pptr the pointer
	 * @returns the target, or `null` for a null PPtr
	 * @throws {Error} if the external file or object can't be found
	 */
	async resolve(from: ObjectRef, pptr: PPtr): Promise<ObjectRef | null> {
		if (pptr.pathId === 0n) {
			return null;
		}
		if (pptr.fileId === 0) {
			const info = from.file.file.objectsByPathId.get(pptr.pathId);
			if (info === undefined) {
				throw new FormatError(`${from.file.node.path} has no object with path id ${pptr.pathId}`);
			}
			return { bundleIndex: from.bundleIndex, file: from.file, info };
		}
		const external = from.file.file.externals[pptr.fileId - 1];
		if (external === undefined) {
			throw new FormatError(
				`PPtr file id ${pptr.fileId} is past ${from.file.file.externals.length} externals`,
			);
		}
		// Unity's built-in files (`library/unity default resources`, `resources/unity_builtin_extra`) ship in the
		// player, not in any bundle
		const path = external.pathName.toLowerCase();
		if (path.startsWith('library/') || path.startsWith('resources/')) {
			throw new FormatError(`PPtr into built-in ${external.pathName}`);
		}
		const cab = archiveFileName(external.pathName);
		return this.objectIn(await this.bundleOfCab(cab, from.bundleIndex), cab, pptr.pathId);
	}

	/**
	 * reads out-of-line stream data, wherever its `.resS` lives
	 *
	 * @param from the object whose `m_StreamData` this is
	 * @param info the streaming info
	 * @returns the bytes, or `undefined` if the data is inline (empty path)
	 */
	async streamData(from: ObjectRef, info: StreamingInfo): Promise<Uint8Array | undefined> {
		if (info.path === '') {
			return undefined;
		}
		const name = archiveFileName(info.path);
		let bundle = from.file.bundle;
		let node = bundle.node(name);
		if (node === undefined) {
			bundle = await this.bundle(await this.bundleOfCab(name, from.bundleIndex));
			node = bundle.node(name);
		}
		if (node === undefined) {
			throw new Error(`stream file ${info.path} not found`);
		}
		return bundle.readNodeRange(node, info.offset, info.offset + info.size);
	}

	/**
	 * finds the objects a draw's asset path names. paths are `<container path>` or, for sub-assets of an FBX,
	 * `<container path>##<sub-asset name>`; matching is case-insensitive, as the container stores lowercase.
	 *
	 * @param path asset path as StringPathHash spells it
	 * @param pathHash its StringPathHash key, to locate the bundle in the manifest
	 * @param classId only return objects of this class (a {@link UnityClass} id)
	 * @returns matching objects; several when a sub-asset name is ambiguous
	 * @throws {Error} if the manifest doesn't know the hash
	 */
	async findAsset(path: string, pathHash: bigint, classId: number): Promise<ObjectRef[]> {
		const assets = this.manifest.findAssets(pathHash);
		if (assets.length === 0) {
			throw new Error(`${path} isn't in the bundle manifest`);
		}
		const bundles = [...new Set(assets.map((asset) => asset.bundleIndex))];
		const found = await Promise.all(bundles.map((index) => this.findInBundle(index, path, classId)));
		return found.flat();
	}

	/**
	 * like {@link findAsset}, but for an asset that must resolve to exactly one object
	 *
	 * @param asset hash and path
	 * @param classId the object's class (a {@link UnityClass} id)
	 * @returns the object
	 * @throws {Error} if the path is unknown, or not exactly one object matches
	 */
	async findUnique(asset: AssetRef, classId: number): Promise<ObjectRef> {
		if (asset.locator !== undefined) {
			const { bundleIndex, file, pathId } = asset.locator;
			const ref = await this.objectIn(bundleIndex, file, pathId);
			if (ref.info.classId !== classId) {
				throw new FormatError(`prefab dependency has class ${ref.info.classId}, expected ${classId}`);
			}
			return ref;
		}
		if (asset.path === null) {
			throw new Error(`hash isn't in StringPathHash`);
		}
		const refs = await this.findAsset(asset.path, asset.hash, classId);
		if (refs.length !== 1) {
			throw new Error(
				`${refs.length} ${CLASS_NAMES.get(classId) ?? `class ${classId}`} objects match the path`,
			);
		}
		return refs[0];
	}

	/**
	 * like {@link findAsset}, within one known bundle
	 *
	 * @param index manifest bundle index
	 * @param path asset path, optionally with a `##<sub-asset>` suffix
	 * @param classId only return objects of this class
	 * @returns matching objects
	 */
	async findInBundle(index: number, path: string, classId: number): Promise<ObjectRef[]> {
		const [containerPath, subAsset] = path.toLowerCase().split('##');
		const entries = (await this.#container(index)).get(containerPath) ?? [];
		const matches = await Promise.all(
			entries.map(async ({ from, entry }) => {
				// preload ranges may include dependencies; only named sub-assets use them. a sub-asset ships in its
				// container's bundle, so preloads into other bundles are skipped without opening them
				const pointers =
					subAsset === undefined
						? [entry.asset]
						: [entry.asset, ...entry.preloads.filter((pointer) => inBundle(from.file, pointer))];
				return Promise.all(
					pointers.map(async (pointer) => {
						const ref = await this.resolve(from, pointer);
						if (ref === null || ref.info.classId !== classId) {
							return null;
						}
						if (subAsset !== undefined && (await ref.file.peekName(ref.info))?.toLowerCase() !== subAsset) {
							return null;
						}
						return ref;
					}),
				);
			}),
		);
		const found = new Map<string, ObjectRef>();
		for (const ref of matches.flat()) {
			if (ref !== null) {
				found.set(objectKey(ref), ref);
			}
		}
		return [...found.values()];
	}

	/** @returns container entries with the owning file needed to resolve their pointers */
	#container(index: number): Promise<Map<string, { from: ObjectRef; entry: ContainerEntry }[]>> {
		let cached = this.#containers.get(index);
		if (cached === undefined) {
			cached = (async () => {
				const byPath = new Map<string, { from: ObjectRef; entry: ContainerEntry }[]>();
				const files = await this.assetFiles(index);
				const perFile = await Promise.all(files.map((file) => file.assetBundles()));
				for (const [i, bundles] of perFile.entries()) {
					for (const bundle of bundles) {
						const from = { bundleIndex: index, file: files[i], info: bundle.info };
						for (const entry of bundle.container) {
							const path = entry.path.toLowerCase();
							const list = byPath.get(path) ?? [];
							list.push({ from, entry });
							byPath.set(path, list);
						}
					}
				}
				return byPath;
			})();
			this.#containers.set(index, cached);
		}
		return cached;
	}

	#register(index: number, bundle: UnityBundle): void {
		this.#scanned.add(index);
		for (const node of bundle.nodes) {
			this.#cabs.set(cabOf(node.path), index);
		}
	}
}
