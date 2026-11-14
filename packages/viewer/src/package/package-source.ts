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
	/**
	 * reads several ranges of one file at once, in one round trip where the source can
	 *
	 * @param path package-relative path
	 * @param ranges the bytes to read: ascending, apart from one another, each with the file's size
	 * @param signal aborts the read; local sources ignore it
	 * @returns each range's bytes, in the order given, each in a buffer of its own
	 * @throws {PackageChangedError} if the file's size differs from the ranges' `fileSize`
	 * @throws {Error} if the file is shorter than a range
	 */
	readRanges(
		path: string,
		ranges: readonly ByteRange[],
		signal?: AbortSignal,
	): Promise<Uint8Array<ArrayBuffer>[]>;
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
 * thrown when an archive's size differs from the opened manifest; stored ranges may no longer be valid.
 * same-sized edits are not detected, and missing archives produce the source's ordinary read error
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

/** a part of a `multipart/byteranges` body: the file's bytes from `offset`, and the file's size if stated */
interface RangePart {
	offset: number;
	bytes: Uint8Array<ArrayBuffer>;
	fileSize: number | null;
}

const CR = 0x0d;
const LF = 0x0a;

const malformed = (): Error => new Error('malformed multipart/byteranges body');

/**
 * splits a `multipart/byteranges` body (RFC 9110 §14.6) into its parts. each part's length comes from its
 * `Content-Range`, so the binary bodies are never searched for the boundary
 *
 * @param body the response body
 * @param boundary the boundary parameter of the response's content type
 * @returns the parts in body order, as views of `body`
 * @throws {Error} on a body that isn't laid out as byte range parts
 */
export const parseByteRanges = (body: Uint8Array<ArrayBuffer>, boundary: string): RangePart[] => {
	const parts: RangePart[] = [];
	const latin1 = new TextDecoder('latin1');
	/** @returns the line starting at `at`, without its line break, and where the next one starts */
	const line = (at: number): { text: string; next: number } => {
		if (at >= body.length) {
			throw malformed();
		}
		let end = at;
		while (end < body.length && body[end] !== LF) {
			end++;
		}
		const text = latin1.decode(body.subarray(at, end > at && body[end - 1] === CR ? end - 1 : end));
		return { text, next: end + 1 };
	};
	const open = `--${boundary}`;
	const close = `--${boundary}--`;
	let at = 0;
	for (;;) {
		// a preamble, and the line break after each part's body, come before a delimiter
		let delimiter = line(at);
		while (delimiter.text !== open && delimiter.text !== close) {
			delimiter = line(delimiter.next);
		}
		if (delimiter.text === close) {
			return parts;
		}
		at = delimiter.next;
		let range: RegExpExecArray | null = null;
		for (;;) {
			const header = line(at);
			at = header.next;
			if (header.text === '') {
				break;
			}
			range ??= /^content-range:\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(header.text.trim());
		}
		if (range === null) {
			throw malformed();
		}
		const offset = Number(range[1]);
		const end = at + Number(range[2]) - offset + 1;
		if (end > body.length) {
			throw malformed();
		}
		parts.push({
			offset,
			bytes: body.subarray(at, end),
			fileSize: range[3] === '*' ? null : Number(range[3]),
		});
		at = end;
	}
};

/**
 * @param baseUrl the package directory's URL; a trailing slash is added if missing
 * @returns a source issuing one HTTP range request per read, or per several where the server answers
 *   multi-range requests
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
	/**
	 * whether the server answers a request for several ranges with one part each. some hosts answer with the
	 * whole file, one range or an error instead, and a cross-origin one that doesn't allow the header fails the
	 * request: the first request settles it
	 */
	let multiRange: 'untried' | 'answered' | 'refused' = 'untried';
	const source: PackageSource = {
		label: base,
		async readFile(path, signal) {
			const response = await fetchOk(path, { signal });
			return new Uint8Array(await response.arrayBuffer());
		},
		async readRanges(path, ranges, signal) {
			const single = (): Promise<Uint8Array<ArrayBuffer>[]> =>
				Promise.all(ranges.map((range) => source.readRange(path, range, signal)));
			if (multiRange === 'refused' || ranges.length < 2) {
				return single();
			}
			const response = await fetch(new URL(path, new URL(base, location.href)), {
				signal,
				headers: {
					range: `bytes=${ranges.map(({ offset, length }) => `${offset}-${offset + length - 1}`).join(',')}`,
				},
			}).catch((err: unknown) => {
				// from a server that has answered in parts, a failure is the network's
				if (multiRange === 'answered' || signal?.aborted === true) {
					throw err;
				}
				return null;
			});
			const boundary =
				response?.status === 206
					? /^multipart\/byteranges;.*\bboundary="?([^";]+)"?/i.exec(
							response.headers.get('content-type') ?? '',
						)
					: null;
			if (response === null || boundary === null) {
				if (multiRange === 'answered' && response?.ok === false) {
					throw new Error(`${path}: HTTP ${response.status}`);
				}
				if (multiRange === 'untried') {
					multiRange = 'refused';
				}
				// the whole file, or one range of it: not worth reading to its end. the single reads report
				// whatever is really wrong
				void response?.body?.cancel();
				return single();
			}
			multiRange = 'answered';
			const parts = parseByteRanges(new Uint8Array(await response.arrayBuffer()), boundary[1]);
			return ranges.map(({ offset, length, fileSize }) => {
				// a server may send the ranges in another order, or merge neighbours into one part
				const part = parts.find((p) => p.offset <= offset && offset + length <= p.offset + p.bytes.length);
				if (part === undefined) {
					throw new Error(`${path}: no part of the response holds ${length} bytes at ${offset}`);
				}
				if (part.fileSize !== null) {
					checkSize(path, part.fileSize, fileSize);
				}
				return part.bytes.slice(offset - part.offset, offset - part.offset + length);
			});
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
	return source;
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
		async readRanges(path, ranges) {
			const file = await open(path);
			return Promise.all(ranges.map((range) => sliceFile(file, path, range)));
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
		readRanges(path, ranges) {
			return Promise.all(ranges.map((range) => sliceFile(get(path), path, range)));
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
