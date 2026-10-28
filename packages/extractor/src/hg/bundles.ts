import { type BundleNode, type ByteSource, UnityBundle } from '@endfield-noclip/formats/hg/bundle';
import { deriveBundlePad } from '@endfield-noclip/formats/hg/bundle-cipher';
import {
	getObjectInfo,
	type ObjectInfo,
	parseSerializedFile,
	parseSerializedFileHeader,
	SERIALIZED_FILE_HEADER_SIZE,
	type SerializedFile,
	serializedFileMetadataEnd,
	UnityClass,
} from '@endfield-noclip/formats/unity/serialized-file';
import {
	objectBytes,
	peekObjectName,
	readObject,
	type TypeTreeObject,
} from '@endfield-noclip/formats/unity/type-tree';
import { asPPtr, isObject, mapEntries, type PPtr } from '@endfield-noclip/formats/unity/values';

import type { Keys } from '../config.ts';

import { type Vfs, type VfsFile, VfsGroup } from './vfs.ts';

/** logical directory of the Bundle group */
export const BUNDLE_PREFIX = 'Data/Bundles/Windows/';

/**
 * normalizes the ways a bundle gets named into its logical VFS path
 *
 * @param name `Data/Bundles/Windows/main/<hex>.ab`, `main/<hex>.ab` (the manifest's form) or a bare `<hex>`
 * @returns the logical path in the Bundle group
 */
export const bundlePath = (name: string): string => {
	if (name.startsWith(BUNDLE_PREFIX)) {
		return name;
	}
	if (/^[0-9a-f]+$/i.test(name)) {
		return `${BUNDLE_PREFIX}main/${name.toLowerCase()}.ab`;
	}
	return `${BUNDLE_PREFIX}${name}`;
};

/**
 * @param path an archive path such as `archive:/CAB-<hex>/CAB-<hex>.resS`
 * @returns the file name, e.g. `CAB-<hex>.resS`
 */
export const archiveFileName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

const pads = new WeakMap<Keys['bundle'], Uint8Array>();

/** @returns the bundle cipher pad, derived once per key set */
const bundlePad = (keys: Keys): Uint8Array => {
	let pad = pads.get(keys.bundle);
	if (pad === undefined) {
		pad = deriveBundlePad(keys.bundle);
		pads.set(keys.bundle, pad);
	}
	return pad;
};

/** @returns a range-reading {@link ByteSource} over a logical file */
const vfsSource = (vfs: Vfs, file: VfsFile): ByteSource => {
	return {
		size: file.entry.length,
		read: (start, end) => vfs.read(file, start, end),
	};
};

/**
 * locates a bundle's logical file
 *
 * @param vfs the VFS
 * @param name any form accepted by {@link bundlePath}
 * @returns the file; its catalog entry carries the bundle's md5
 * @throws {Error} if the bundle isn't in the catalog
 */
export const findBundleFile = async (vfs: Vfs, name: string): Promise<VfsFile> => {
	const path = bundlePath(name);
	// `initial/` bundles ship in their own group
	const file =
		(await vfs.find(VfsGroup.Bundle, path)) ??
		(path.startsWith(`${BUNDLE_PREFIX}initial/`) ? await vfs.find(VfsGroup.InitialBundle, path) : undefined);
	if (file === undefined) {
		throw new Error(`bundle ${path} not found in groups ${VfsGroup.Bundle}/${VfsGroup.InitialBundle}`);
	}
	return file;
};

/**
 * opens a bundle from the Bundle group without reading it whole
 *
 * @param context VFS and keys
 * @param name any form accepted by {@link bundlePath}
 * @throws {Error} if the bundle isn't in the catalog
 */
export const openBundle = async (context: { vfs: Vfs; keys: Keys }, name: string): Promise<UnityBundle> => {
	const file = await findBundleFile(context.vfs, name);
	return UnityBundle.open(vfsSource(context.vfs, file), bundlePad(context.keys));
};

/** SerializedFiles up to this size are read whole; larger ones read objects on demand */
const EAGER_SERIALIZED_FILE_SIZE = 16 * 1024 * 1024;

/** bytes read from the start of an object to find its `m_Name` in a lazily read file */
const NAME_PREFIX_SIZE = 4096;

/** a `m_Container` entry: an asset path and the object it names */
export interface ContainerEntry {
	path: string;
	asset: PPtr;
}

/** an AssetBundle object's name and container */
export interface AssetBundleInfo {
	name: string | undefined;
	container: ContainerEntry[];
}

/** a SerializedFile inside a bundle, with object access by path id */
export class BundleAssetFile {
	readonly bundle: UnityBundle;
	readonly node: BundleNode;
	readonly file: SerializedFile;
	readonly #bytes: Uint8Array | undefined;
	/** per class id: lowercase `m_Name` → objects */
	readonly #names = new Map<number, Promise<Map<string, ObjectInfo[]>>>();

	/**
	 * @param bundle containing bundle
	 * @param node the SerializedFile's node
	 * @param file parsed metadata
	 * @param bytes the whole file, if it was read eagerly
	 */
	constructor(bundle: UnityBundle, node: BundleNode, file: SerializedFile, bytes: Uint8Array | undefined) {
		this.bundle = bundle;
		this.node = node;
		this.file = file;
		this.#bytes = bytes;
	}

	/**
	 * reads the metadata, and the whole file too if it's small
	 *
	 * @param bundle containing bundle
	 * @param node a node flagged as a SerializedFile
	 */
	static async open(bundle: UnityBundle, node: BundleNode): Promise<BundleAssetFile> {
		if (node.size <= EAGER_SERIALIZED_FILE_SIZE) {
			const bytes = await bundle.readNode(node);
			return new BundleAssetFile(bundle, node, parseSerializedFile(bytes), bytes);
		}
		const header = parseSerializedFileHeader(
			await bundle.readNodeRange(node, 0, SERIALIZED_FILE_HEADER_SIZE),
		);
		const prefix = await bundle.readNodeRange(node, 0, serializedFileMetadataEnd(header));
		return new BundleAssetFile(bundle, node, parseSerializedFile(prefix), undefined);
	}

	/** @returns the raw bytes of one object */
	async objectBytes(info: ObjectInfo): Promise<Uint8Array> {
		if (this.#bytes !== undefined) {
			return objectBytes(this.#bytes, info);
		}
		return this.bundle.readNodeRange(this.node, info.byteStart, info.byteStart + info.byteSize);
	}

	/**
	 * @param target object path id or table entry
	 * @returns the object's fields
	 * @throws {FormatError} if there's no such object or it doesn't match its TypeTree
	 */
	async read(target: bigint | ObjectInfo): Promise<TypeTreeObject> {
		const info = typeof target === 'bigint' ? getObjectInfo(this.file, target) : target;
		return readObject(this.file, info, await this.objectBytes(info));
	}

	/** @returns the object's `m_Name`, or `undefined` if its class has none */
	async peekName(info: ObjectInfo): Promise<string | undefined> {
		if (this.#bytes !== undefined || info.byteSize <= NAME_PREFIX_SIZE) {
			return peekObjectName(this.file, info, await this.objectBytes(info));
		}
		// `m_Name` sits near the start of every class that has one; read the rest only if it doesn't fit
		const prefix = await this.bundle.readNodeRange(
			this.node,
			info.byteStart,
			info.byteStart + NAME_PREFIX_SIZE,
		);
		try {
			return peekObjectName(this.file, info, prefix);
		} catch {
			return peekObjectName(this.file, info, await this.objectBytes(info));
		}
	}

	/**
	 * finds objects by name; the first call per class reads every name of that class
	 *
	 * @param classId class of the objects
	 * @param name `m_Name`, lowercase
	 * @returns the objects of that class whose lowercased name is `name`
	 */
	async objectsNamed(classId: number, name: string): Promise<ObjectInfo[]> {
		let index = this.#names.get(classId);
		if (index === undefined) {
			index = (async () => {
				const byName = new Map<string, ObjectInfo[]>();
				const objects = this.file.objects.filter((info) => info.classId === classId);
				const names = await Promise.all(objects.map((info) => this.peekName(info)));
				for (const [i, info] of objects.entries()) {
					const key = names[i]?.toLowerCase();
					if (key !== undefined) {
						const list = byName.get(key) ?? [];
						list.push(info);
						byName.set(key, list);
					}
				}
				return byName;
			})();
			this.#names.set(classId, index);
		}
		return (await index).get(name) ?? [];
	}

	/** @returns every AssetBundle object of the file with its `m_Container` */
	async assetBundles(): Promise<AssetBundleInfo[]> {
		const bundles: AssetBundleInfo[] = [];
		for (const info of this.file.objects) {
			if (info.classId !== UnityClass.AssetBundle) {
				continue;
			}
			// oxlint-disable-next-line no-await-in-loop -- a file holds at most one AssetBundle in practice
			const value = await this.read(info);
			const container: ContainerEntry[] = [];
			for (const [path, entry] of mapEntries(value.m_Container)) {
				if (typeof path === 'string' && isObject(entry)) {
					container.push({ path, asset: asPPtr(entry.asset) });
				}
			}
			bundles.push({
				name: typeof value.m_AssetBundleName === 'string' ? value.m_AssetBundleName : undefined,
				container,
			});
		}
		return bundles;
	}
}

/**
 * @param bundle an opened bundle
 * @returns its SerializedFiles
 */
export const openAssetFiles = (bundle: UnityBundle): Promise<BundleAssetFile[]> => {
	return Promise.all(bundle.serializedFileNodes().map((node) => BundleAssetFile.open(bundle, node)));
};
