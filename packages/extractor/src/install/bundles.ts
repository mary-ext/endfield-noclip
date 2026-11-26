import { mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { brotliDecompress, brotliDecompressSync } from 'node:zlib';

import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import { type BundleNode, UnityBundle } from '@endfield-noclip/formats/hg/bundle';
import { deriveBundlePad } from '@endfield-noclip/formats/hg/bundle-cipher';
import { BundleManifest } from '@endfield-noclip/formats/hg/bundle-manifest';
import {
	getObjectInfo,
	type ObjectInfo,
	parseSerializedFile,
	parseSerializedFileHeader,
	type SerializedFile,
	serializedFileMetadataEnd,
	UnityClass,
} from '@endfield-noclip/formats/unity/serialized-file';
import {
	objectBytes,
	peekObjectName,
	readObject,
	readObjectField,
	type TypeTreeObject,
	type TypeTreeValue,
} from '@endfield-noclip/formats/unity/type-tree';
import {
	arrayField,
	asPPtr,
	isObject,
	mapEntries,
	numberField,
	type PPtr,
} from '@endfield-noclip/formats/unity/values';

import { mapDefined } from '@mary-ext/array-fns';

import { ignoreMissing } from '../util/errors.ts';

import { DEFAULT_OUT, type Keys } from './config.ts';
import { type Vfs, type VfsFile, VfsGroup } from './vfs.ts';

/** logical directory of the Bundle group */
export const BUNDLE_PREFIX = 'Data/Bundles/Windows/';

/** the bundle manifest's logical path, in {@link VfsGroup.BundleManifest} */
const MANIFEST_PATH = 'Data/Bundles/Windows/manifest.hgmmap';

/** where decompressed install files (like the bundle manifest) are cached across CLI runs */
const INSTALL_CACHE_DIR = fileURLToPath(new URL('.cache/install', DEFAULT_OUT));

const brotliDecompressAsync = promisify(brotliDecompress);

const MANIFEST_OPTIONS = { brotliDecompress: (data: Uint8Array) => brotliDecompressSync(data) };

/** reads a file straight into a `SharedArrayBuffer`-backed view, or returns `undefined` if absent */
const readIntoSharedBuffer = async (path: string): Promise<Uint8Array | undefined> => {
	const handle = await ignoreMissing(open(path, 'r'), undefined);
	if (handle === undefined) {
		return undefined;
	}
	try {
		const { size } = await handle.stat();
		const bytes = new Uint8Array(new SharedArrayBuffer(size));
		let offset = 0;
		while (offset < size) {
			// oxlint-disable-next-line no-await-in-loop -- finish short reads until EOF
			const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
			if (bytesRead === 0) {
				break;
			}
			offset += bytesRead;
		}
		return offset === size ? bytes : undefined;
	} finally {
		await handle.close();
	}
};

/** atomically writes the decompressed manifest to the install cache and removes older MD5 copies */
const writeManifestCache = async (cacheDir: string, fileName: string, bytes: Uint8Array): Promise<void> => {
	const target = join(cacheDir, fileName);
	const tmp = join(cacheDir, `${fileName}.${process.pid}.tmp`);
	try {
		await mkdir(cacheDir, { recursive: true });
		await writeFile(tmp, bytes);
		await rename(tmp, target);
		const entries = await ignoreMissing(readdir(cacheDir), []);
		await Promise.all(
			mapDefined(entries, (name) =>
				name.startsWith('manifest-') && name.endsWith('.bin') && name !== fileName
					? rm(join(cacheDir, name), { force: true })
					: undefined,
			),
		);
	} catch {
		await rm(tmp, { force: true }).catch(() => {});
	}
};

/**
 * @param vfs the VFS
 * @param options.cacheDir directory for caching the decompressed manifest by MD5 (`null` disables caching;
 *   defaults to `out/.cache/install`)
 * @returns the parsed bundle manifest, its {@link BundleManifest.bytes} backed by a `SharedArrayBuffer` so
 *   worker threads can read it through {@link sharedBundleManifest} without a copy of their own
 * @throws {Error} if it's missing or its md5 doesn't match the catalog
 */
export const loadBundleManifest = async (
	vfs: Vfs,
	options?: { cacheDir?: string | null },
): Promise<BundleManifest> => {
	const file = await vfs.find(VfsGroup.BundleManifest, MANIFEST_PATH);
	if (file === undefined) {
		throw new Error(`${MANIFEST_PATH} not found in vfs group ${VfsGroup.BundleManifest}`);
	}
	const cacheDir = options?.cacheDir === undefined ? INSTALL_CACHE_DIR : options.cacheDir;
	const cacheFile = `manifest-${file.entry.dataMd5}.bin`;
	if (cacheDir !== null) {
		const cached = await readIntoSharedBuffer(join(cacheDir, cacheFile));
		if (cached !== undefined) {
			try {
				return new BundleManifest(cached, MANIFEST_OPTIONS);
			} catch (error) {
				if (!(error instanceof FormatError)) {
					throw error;
				}
			}
		}
	}
	// ~150 MB decompressed; the async form keeps the event loop free for the reads setup runs alongside
	const decompressed = await brotliDecompressAsync(await file.readVerified());
	const bytes = new Uint8Array(new SharedArrayBuffer(decompressed.length));
	bytes.set(decompressed);
	const manifest = new BundleManifest(bytes, MANIFEST_OPTIONS);
	if (cacheDir !== null) {
		await writeManifestCache(cacheDir, cacheFile, bytes);
	}
	return manifest;
};

/**
 * @param bytes {@link BundleManifest.bytes} of a manifest from {@link loadBundleManifest}, e.g. passed to a
 *   worker
 * @returns a reader over the same bytes
 */
export const sharedBundleManifest = (bytes: Uint8Array): BundleManifest => {
	return new BundleManifest(bytes, MANIFEST_OPTIONS);
};

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
	return pads.getOrInsertComputed(keys.bundle, deriveBundlePad);
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
	return UnityBundle.open(file, bundlePad(context.keys));
};

/** SerializedFiles up to this size are read whole; larger ones read objects on demand */
const EAGER_SERIALIZED_FILE_SIZE = 16 * 1024 * 1024;

/** initial bytes read from a lazily opened SerializedFile to cover its header and small metadata in one read */
const METADATA_PREFIX_SIZE = 4096;

/** bytes read from the start of an object to find its `m_Name` in a lazily read file */
const NAME_PREFIX_SIZE = 4096;

/** a `m_Container` entry: an asset path and the object it names */
export interface ContainerEntry {
	path: string;
	asset: PPtr;
	/** references in this container entry's preload range */
	preloads: PPtr[];
}

/** an AssetBundle object's name and container */
export interface AssetBundleObject {
	/** the owning AssetBundle object; pointers are relative to its SerializedFile */
	info: ObjectInfo;
	name: string | undefined;
	container: ContainerEntry[];
}

/** a SerializedFile inside a bundle, with object access by path id */
export class BundleAssetFile {
	readonly bundle: UnityBundle;
	readonly node: BundleNode;
	readonly file: SerializedFile;
	readonly #bytes: Uint8Array | undefined;
	#assetBundles: Promise<AssetBundleObject[]> | undefined;

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
	 * reads the metadata, and the whole file too if it's small (unless `eager` is `false`)
	 *
	 * @param bundle containing bundle
	 * @param node a node flagged as a SerializedFile
	 * @param options.eager whether to read SerializedFiles up to 16 MB whole (default `true`); pass `false`
	 *   when only metadata or a few objects are needed
	 */
	static async open(
		bundle: UnityBundle,
		node: BundleNode,
		options?: { eager?: boolean },
	): Promise<BundleAssetFile> {
		if ((options?.eager ?? true) && node.size <= EAGER_SERIALIZED_FILE_SIZE) {
			const bytes = await bundle.readNode(node);
			return new BundleAssetFile(bundle, node, parseSerializedFile(bytes), bytes);
		}
		const prefix = await bundle.readNode(node, 0, Math.min(node.size, METADATA_PREFIX_SIZE));
		const header = parseSerializedFileHeader(prefix);
		const metadataEnd = serializedFileMetadataEnd(header);
		let metadata: Uint8Array;
		if (metadataEnd <= prefix.length) {
			metadata = prefix;
		} else {
			const rest = await bundle.readNode(node, prefix.length, metadataEnd);
			metadata = new Uint8Array(metadataEnd);
			metadata.set(prefix);
			metadata.set(rest, prefix.length);
		}
		return new BundleAssetFile(bundle, node, parseSerializedFile(metadata), undefined);
	}

	/** @returns the raw bytes of one object */
	async objectBytes(info: ObjectInfo): Promise<Uint8Array> {
		if (this.#bytes !== undefined) {
			return objectBytes(this.#bytes, info);
		}
		return this.bundle.readNode(this.node, info.byteStart, info.byteStart + info.byteSize);
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

	/**
	 * reads one top-level field of an object without materializing the fields before it
	 *
	 * @param target object path id or table entry
	 * @param field top-level field name
	 * @returns the field's value, or `undefined` if the type has no such field or the object omits it
	 * @throws {FormatError} if there's no such object or it doesn't match its TypeTree
	 */
	async readField(target: bigint | ObjectInfo, field: string): Promise<TypeTreeValue | undefined> {
		const info = typeof target === 'bigint' ? getObjectInfo(this.file, target) : target;
		return readObjectField(this.file, info, await this.objectBytes(info), field);
	}

	/** @returns the object's `m_Name`, or `undefined` if its class has none */
	async peekName(info: ObjectInfo): Promise<string | undefined> {
		if (this.#bytes !== undefined || info.byteSize <= NAME_PREFIX_SIZE) {
			return peekObjectName(this.file, info, await this.objectBytes(info));
		}
		// `m_Name` sits near the start of every class that has one; read the rest only if it doesn't fit
		const prefix = await this.bundle.readNode(this.node, info.byteStart, info.byteStart + NAME_PREFIX_SIZE);
		try {
			return peekObjectName(this.file, info, prefix);
		} catch {
			return peekObjectName(this.file, info, await this.objectBytes(info));
		}
	}

	/** @returns every AssetBundle object of the file with its `m_Container`, cached after the first read */
	assetBundles(): Promise<AssetBundleObject[]> {
		this.#assetBundles ??= this.#readAssetBundles();
		return this.#assetBundles;
	}

	async #readAssetBundles(): Promise<AssetBundleObject[]> {
		const bundles: AssetBundleObject[] = [];
		for (const info of this.file.objects) {
			if (info.classId !== UnityClass.AssetBundle) {
				continue;
			}
			// oxlint-disable-next-line no-await-in-loop -- a file holds at most one AssetBundle in practice
			const value = await this.read(info);
			const preloads = arrayField(value, 'm_PreloadTable').map(asPPtr);
			const container: ContainerEntry[] = [];
			for (const [path, entry] of mapEntries(value.m_Container)) {
				if (typeof path === 'string' && isObject(entry)) {
					const start = numberField(entry, 'preloadIndex');
					const size = numberField(entry, 'preloadSize');
					if (
						!Number.isInteger(start) ||
						!Number.isInteger(size) ||
						start < 0 ||
						size < 0 ||
						start + size > preloads.length
					) {
						throw new Error(`invalid preload range for ${path}`);
					}
					container.push({ path, asset: asPPtr(entry.asset), preloads: preloads.slice(start, start + size) });
				}
			}
			bundles.push({
				info,
				name: typeof value.m_AssetBundleName === 'string' ? value.m_AssetBundleName : undefined,
				container,
			});
		}
		return bundles;
	}
}

/**
 * @param bundle an opened bundle
 * @param options.eager whether to read small SerializedFiles whole (default `true`)
 * @returns its SerializedFiles
 */
export const openAssetFiles = (
	bundle: UnityBundle,
	options?: { eager?: boolean },
): Promise<BundleAssetFile[]> => {
	return Promise.all(bundle.serializedFileNodes().map((node) => BundleAssetFile.open(bundle, node, options)));
};
