import { createHash } from 'node:crypto';
import { mkdir, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_ARCHIVE } from '@endfield-noclip/package-format/format';

import { errorCode, ignoreMissing } from '../errors.ts';

import { BlobDir, shortHash } from './blob-file.ts';
import type { ConvertResult } from './convert-pool.ts';

// a persistent cache for packing: converted meshes and textures, and every blob a pack stores. blobs live in
// a BlobDir that serves as the pack's blob store, so a re-pack reads cached blobs straight into its archives.
// conversions are remembered by a key over their source (the bundles' md5s from the VFS catalog, the object,
// the options) and a fingerprint of the converter's code, so an install update or a converter change misses.
//
// the cache keeps what the packages it built are made of: each pack records its blobs and conversions as a
// root named after its output directory, and then deletes whatever no root references. a root goes away with
// its package (when the directory no longer holds a core archive). one pack uses a cache at a time.

/**
 * code whose output the cache stores, relative to this module: editing any of it invalidates every cached
 * conversion. it must cover what `convert-worker.ts` imports to decide results; instance, terrain and
 * environment packing aren't cached, so their code isn't listed
 */
const CONVERTER_SOURCES = [
	'../../../formats/src/binary',
	'../../../formats/src/hg',
	'../../../formats/src/unity',
	'../../../package-format/src',
	'../game/asset-decode.ts',
	'../game/assets.ts',
	'../game/world-index.ts',
	'../hg/bundles.ts',
	'../hg/vfs.ts',
	'../zstd.ts',
	'./blob-file.ts',
	'./bounds.ts',
	'./convert-worker.ts',
	'./geometry.ts',
	'./textures.ts',
];

/** what a pack's cache use came to */
export interface CacheReport {
	dir: string;
	/** conversions taken from the cache, by kind */
	hits: { geometries: number; textures: number };
	/** what the sweep after the pack deleted */
	swept: { blobs: number; memos: number; bytes: number };
}

/** a root: what one package was built from */
interface Root {
	outDir: string;
	time: string;
	blobs: string[];
	memos: string[];
}

/** a pack's handle on the cache, holding its lock until {@link PackCache.close} */
export class PackCache {
	readonly root: string;
	/** where the pack's blob store writes */
	readonly blobs: BlobDir;
	readonly hits = { geometries: 0, textures: 0 };
	/** conversion results as JSON, by key */
	readonly #memos: BlobDir;
	readonly #fingerprint: string;
	readonly #used = new Set<string>();

	private constructor(root: string, fingerprint: string) {
		this.root = root;
		this.blobs = new BlobDir(join(root, 'blobs'));
		this.#memos = new BlobDir(join(root, 'memo'));
		this.#fingerprint = fingerprint;
	}

	/**
	 * opens (creating) a cache and takes its lock
	 *
	 * @param root the cache directory
	 * @returns the handle
	 * @throws {Error} if another running pack holds the lock
	 */
	static async open(root: string): Promise<PackCache> {
		await mkdir(root, { recursive: true });
		await lock(join(root, 'lock'));
		return new PackCache(root, await converterFingerprint());
	}

	/**
	 * @param parts what the conversion depends on besides the converter's code; bigints are allowed
	 * @returns the conversion's key
	 */
	key(parts: object): string {
		return shortHash(
			JSON.stringify([this.#fingerprint, parts], (_, value: unknown) =>
				typeof value === 'bigint' ? value.toString() : value,
			),
		);
	}

	/**
	 * @param key a conversion's key
	 * @returns its remembered result, or `undefined` if there's none or one of its blobs is gone
	 */
	async recall(key: string): Promise<ConvertResult | undefined> {
		const text = await ignoreMissing(readFile(this.#memos.path(key), 'utf8'), undefined);
		if (text === undefined) {
			return undefined;
		}
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- written by remember() under the same fingerprint
		const result = JSON.parse(text) as ConvertResult;
		const present = await Promise.all(resultBlobs(result).map((hash) => this.blobs.has(hash)));
		if (!present.every(Boolean)) {
			return undefined;
		}
		this.#used.add(key);
		this.hits[result.kind === 'geometry' ? 'geometries' : 'textures']++;
		return result;
	}

	/**
	 * remembers a conversion; its blobs must be in {@link PackCache.blobs} already
	 *
	 * @param key the conversion's key
	 * @param result what it produced
	 */
	async remember(key: string, result: ConvertResult): Promise<void> {
		await this.#memos.replace(key, JSON.stringify(result));
		this.#used.add(key);
	}

	/**
	 * records the finished package as a root, then deletes what no root references
	 *
	 * @param outDir the package's directory
	 * @param blobs hashes of every blob the package holds
	 * @returns hits and what was deleted
	 */
	async finish(outDir: string, blobs: readonly string[]): Promise<CacheReport> {
		const roots = new BlobDir(join(this.root, 'roots'));
		const root: Root = { outDir, time: new Date().toISOString(), blobs: [...blobs], memos: [...this.#used] };
		await roots.replace(shortHash(outDir), JSON.stringify(root));

		const liveBlobs = new Set<string>();
		const liveMemos = new Set<string>();
		await Promise.all(
			(await roots.names()).map(async (name) => {
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- written like the root above
				const other = JSON.parse(await readFile(roots.path(name), 'utf8')) as Root;
				if ((await ignoreMissing(stat(join(other.outDir, CORE_ARCHIVE)), undefined)) === undefined) {
					// its package is gone
					await rm(roots.path(name), { force: true });
					return;
				}
				for (const hash of other.blobs) {
					liveBlobs.add(hash);
				}
				for (const key of other.memos) {
					liveMemos.add(key);
				}
			}),
		);
		const blobSweep = await this.blobs.sweep((hash) => liveBlobs.has(hash));
		const memoSweep = await this.#memos.sweep((key) => liveMemos.has(key));
		return {
			dir: this.root,
			hits: { ...this.hits },
			swept: { blobs: blobSweep.files, memos: memoSweep.files, bytes: blobSweep.bytes + memoSweep.bytes },
		};
	}

	/** releases the lock */
	async close(): Promise<void> {
		await rm(join(this.root, 'lock'), { force: true });
	}
}

/** @returns the hashes of a result's blobs */
const resultBlobs = (result: ConvertResult): string[] => {
	return result.kind === 'geometry' ? [result.blob.hash] : result.pieces.map((piece) => piece.blob.hash);
};

/** takes a lock file holding our pid; a lock left by a process that's gone is taken over */
const lock = async (path: string): Promise<void> => {
	if (await tryCreate(path)) {
		return;
	}
	const pid = Number(await ignoreMissing(readFile(path, 'utf8'), ''));
	if (Number.isInteger(pid) && pid > 0 && isRunning(pid)) {
		throw new Error(`the pack cache ${path} is in use by process ${pid}; wait for it, or pass --no-cache`);
	}
	await rm(path, { force: true });
	if (!(await tryCreate(path))) {
		throw new Error(`couldn't take the pack cache lock ${path}`);
	}
};

/** @returns whether the lock file was created (false if it exists) */
const tryCreate = async (path: string): Promise<boolean> => {
	try {
		const handle = await open(path, 'wx');
		await handle.writeFile(String(process.pid));
		await handle.close();
		return true;
	} catch (error) {
		if (errorCode(error) === 'EEXIST') {
			return false;
		}
		throw error;
	}
};

const isRunning = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: it exists but isn't ours
		return errorCode(error) === 'EPERM';
	}
};

/** @returns a hash over the converter's code, the extractor's dependencies and Node's zstd */
const converterFingerprint = async (): Promise<string> => {
	const hash = createHash('sha256');
	const base = fileURLToPath(new URL('.', import.meta.url));
	const files: string[] = [];
	for (const source of CONVERTER_SOURCES) {
		const path = fileURLToPath(new URL(source, import.meta.url));
		// oxlint-disable-next-line no-await-in-loop -- a handful of paths
		if ((await stat(path)).isDirectory()) {
			// oxlint-disable-next-line no-await-in-loop
			const entries = await readdir(path, { recursive: true });
			files.push(
				...entries
					.filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
					.map((name) => join(path, name)),
			);
		} else {
			files.push(path);
		}
	}
	const contents = await Promise.all(
		files.toSorted().map(async (path) => [relative(base, path), await readFile(path)] as const),
	);
	for (const [path, content] of contents) {
		hash.update(`${path}\0`).update(content);
	}
	// the extractor pins meshoptimizer exactly, so its manifest names the version in use
	hash.update(await readFile(new URL('../../package.json', import.meta.url)));
	hash.update(`zstd ${process.versions.zstd ?? 'unknown'}`);
	return hash.digest('hex');
};
