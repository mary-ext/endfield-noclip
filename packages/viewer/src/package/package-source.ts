/**
 * where a package's files come from: HTTP (range requests against a static directory or the dev server), a
 * local directory handle (File System Access API or OPFS), or a flat list of `File`s from a directory input.
 *
 * @module
 */

import { CORE_ARCHIVE } from '@endfield-noclip/package-format/manifest';

/** random access to a package's files by package-relative path */
export interface PackageSource {
	/** shown in the UI */
	label: string;
	/**
	 * @param path package-relative path, e.g. `core.czar`
	 * @param signal aborts the read; local sources ignore it
	 * @returns the whole file
	 */
	readFile(path: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>>;
	/**
	 * @param path package-relative path
	 * @param range the bytes to read, and the file's size as the manifest records it
	 * @param signal aborts the read; local sources ignore it
	 * @returns exactly `range.length` bytes
	 * @throws {PackageChangedError} if the file's size differs from `range.fileSize`
	 * @throws {Error} if the file is shorter than the range
	 */
	readRange(path: string, range: ByteRange, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>>;
}

/** a byte range of a package file */
export interface ByteRange {
	/** first byte */
	offset: number;
	/** byte count */
	length: number;
	/** the whole file's size in the opened package's manifest */
	fileSize: number;
}

/**
 * thrown when a file no longer matches the opened package's manifest, as after a re-pack while the page was
 * open; its ranges would point at the wrong bytes
 */
export class PackageChangedError extends Error {
	override name = 'PackageChangedError';
}

/** @throws {PackageChangedError} unless `actual` is `expected` */
const checkSize = (path: string, actual: number, expected: number): void => {
	if (actual !== expected) {
		throw new PackageChangedError(
			`${path} is ${actual} bytes, but the package was opened with ${expected}; reload to read the new package`,
		);
	}
};

// #region http

/**
 * @param baseUrl the package directory's URL; a trailing slash is added if missing
 * @returns a source issuing one HTTP range request per read
 */
export const httpSource = (baseUrl: string): PackageSource => {
	const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
	const fetchOk = async (path: string, init: RequestInit): Promise<Response> => {
		const response = await fetch(new URL(path, new URL(base, location.href)), init);
		if (!response.ok) {
			throw new Error(`${path}: HTTP ${response.status}`);
		}
		return response;
	};
	return {
		label: base,
		async readFile(path, signal) {
			const response = await fetchOk(path, { signal });
			return new Uint8Array(await response.arrayBuffer());
		},
		async readRange(path, { offset, length, fileSize }, signal) {
			const response = await fetchOk(path, {
				signal,
				headers: { range: `bytes=${offset}-${offset + length - 1}` },
			});
			const bytes = new Uint8Array(await response.arrayBuffer());
			const partial = response.status === 206;
			// `bytes <first>-<last>/<size>`; the size may be `*` (unknown)
			const total = partial ? /\/(\d+)$/.exec(response.headers.get('content-range') ?? '')?.[1] : undefined;
			if (!partial || total !== undefined) {
				checkSize(path, partial ? Number(total) : bytes.byteLength, fileSize);
			}
			// a server ignoring Range answers 200 with the whole file
			const view = partial ? bytes : bytes.subarray(offset, offset + length);
			if (view.byteLength !== length) {
				throw new Error(`${path}: short read at ${offset} (${view.byteLength} of ${length} bytes)`);
			}
			return view.byteOffset === 0 && view.byteLength === bytes.byteLength ? bytes : view.slice();
		},
	};
};

// #endregion

// #region local files

const sliceFile = async (
	file: Blob,
	path: string,
	{ offset, length, fileSize }: ByteRange,
): Promise<Uint8Array<ArrayBuffer>> => {
	checkSize(path, file.size, fileSize);
	if (offset + length > file.size) {
		throw new Error(`${path}: range ${offset}+${length} runs past ${file.size} bytes`);
	}
	return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
};

/**
 * @param root a package directory, from `showDirectoryPicker()` or OPFS
 * @returns a source reading files lazily through the handle
 */
export const directorySource = (root: FileSystemDirectoryHandle): PackageSource => {
	const files = new Map<string, Promise<File>>();
	const open = (path: string): Promise<File> => {
		let file = files.get(path);
		if (file === undefined) {
			file = (async () => {
				const parts = path.split('/');
				let dir = root;
				for (const part of parts.slice(0, -1)) {
					// oxlint-disable-next-line eslint/no-await-in-loop -- each step needs the previous handle
					dir = await dir.getDirectoryHandle(part);
				}
				const handle = await dir.getFileHandle(parts[parts.length - 1]);
				return handle.getFile();
			})();
			files.set(path, file);
			// drop failures so a retry re-resolves
			file.catch(() => files.delete(path));
		}
		return file;
	};
	return {
		label: root.name,
		async readFile(path) {
			return new Uint8Array(await (await open(path)).arrayBuffer());
		},
		async readRange(path, range) {
			return sliceFile(await open(path), path, range);
		},
	};
};

/**
 * @param files files from `<input type="file" webkitdirectory>`; their `webkitRelativePath`s start with the
 *   package directory's name
 * @returns a source over those files
 * @throws {Error} if there's no core archive among them
 */
export const fileListSource = (files: Iterable<File>): PackageSource => {
	const byPath = new Map<string, File>();
	let label = 'local files';
	for (const file of files) {
		const relative = file.webkitRelativePath === '' ? file.name : file.webkitRelativePath;
		const slash = relative.indexOf('/');
		if (slash >= 0) {
			label = relative.slice(0, slash);
		}
		byPath.set(slash >= 0 ? relative.slice(slash + 1) : relative, file);
	}
	if (!byPath.has(CORE_ARCHIVE)) {
		throw new Error(`the chosen folder has no ${CORE_ARCHIVE}`);
	}
	const get = (path: string): File => {
		const file = byPath.get(path);
		if (file === undefined) {
			throw new Error(`${path} is missing from the chosen folder`);
		}
		return file;
	};
	return {
		label,
		async readFile(path) {
			return new Uint8Array(await get(path).arrayBuffer());
		},
		readRange(path, range) {
			return sliceFile(get(path), path, range);
		},
	};
};

// #endregion

// #region opfs

const OPFS_DIR = 'packages';

/** @returns the names of packages imported into the origin-private file system */
export const listOpfsPackages = async (): Promise<string[]> => {
	if (navigator.storage?.getDirectory === undefined) {
		return [];
	}
	const root = await navigator.storage.getDirectory();
	const dir = await root.getDirectoryHandle(OPFS_DIR, { create: true });
	const names: string[] = [];
	for await (const [name, handle] of dir.entries()) {
		if (handle.kind === 'directory') {
			names.push(name);
		}
	}
	return names.toSorted();
};

/**
 * @param name a name from {@link listOpfsPackages}
 * @returns the package's directory in OPFS
 */
export const openOpfsPackage = async (name: string): Promise<FileSystemDirectoryHandle> => {
	const root = await navigator.storage.getDirectory();
	return (await root.getDirectoryHandle(OPFS_DIR)).getDirectoryHandle(name);
};

/**
 * copies a package directory into OPFS so it can be reopened without picking it again. skips `debug/`, which
 * the viewer never reads.
 *
 * @param source the package directory
 * @param onProgress called with bytes copied so far
 * @returns the imported package's name
 */
export const importToOpfs = async (
	source: FileSystemDirectoryHandle,
	onProgress: (bytes: number) => void,
): Promise<string> => {
	const root = await navigator.storage.getDirectory();
	const target = await (
		await root.getDirectoryHandle(OPFS_DIR, { create: true })
	).getDirectoryHandle(source.name, {
		create: true,
	});
	let copied = 0;
	const copyDir = async (from: FileSystemDirectoryHandle, to: FileSystemDirectoryHandle): Promise<void> => {
		for await (const [name, handle] of from.entries()) {
			if (handle.kind === 'directory') {
				if (name !== 'debug') {
					await copyDir(handle, await to.getDirectoryHandle(name, { create: true }));
				}
				continue;
			}
			const file = await handle.getFile();
			const writable = await (await to.getFileHandle(name, { create: true })).createWritable();
			await file.stream().pipeTo(writable);
			copied += file.size;
			onProgress(copied);
		}
	};
	await copyDir(source, target);
	return source.name;
};

// #endregion
