import { createHash } from 'node:crypto';
import { open, readdir, readFile, rename, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_ARCHIVE } from '@endfield-noclip/package-format/format';

import { BlobDir } from './blob-store.ts';
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
 * conversion. instance, terrain and environment packing aren't cached, so their code isn't listed
 */
const CONVERTER_SOURCES = [
	'../../../formats/src/binary',
	'../../../formats/src/hg',
	'../../../formats/src/unity',
	'../../../package-format/src',
	'../game/asset-decode.ts',
	'../game/assets.ts',
	'../hg/bundles.ts',
	'../hg/vfs.ts',
	'../zstd.ts',
	'./blob-store.ts',
	'./convert-pool.ts',
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
	readonly #fingerprint: string;
	readonly #memos = new Set<string>();

	private constructor(root: string, fingerprint: string) {
		this.root = root;
		this.blobs = new BlobDir(join(root, 'blobs'));
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
		const text = JSON.stringify([this.#fingerprint, parts], (_, value: unknown) =>
			typeof value === 'bigint' ? value.toString() : value,
		);
		return createHash('sha256').update(text).digest('hex').slice(0, 32);
	}

	/**
	 * @param key a conversion's key
	 * @returns its remembered result, or `undefined` if there's none or one of its blobs is gone
	 */
	async recall(key: string): Promise<ConvertResult | undefined> {
		let result: ConvertResult;
		try {
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- written by remember() under the same fingerprint
			result = JSON.parse(await readFile(this.#memoPath(key), 'utf8')) as ConvertResult;
		} catch {
			return undefined;
		}
		const present = await Promise.all(resultBlobs(result).map((hash) => this.blobs.has(hash)));
		if (!present.every(Boolean)) {
			return undefined;
		}
		this.#memos.add(key);
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
		await writeAtomically(this.#memoPath(key), JSON.stringify(result));
		this.#memos.add(key);
	}

	/**
	 * records the finished package as a root, then deletes what no root references
	 *
	 * @param outDir the package's directory
	 * @param blobs hashes of every blob the package holds
	 * @returns hits and what was deleted
	 */
	async finish(outDir: string, blobs: readonly string[]): Promise<CacheReport> {
		const root: Root = { outDir, time: new Date().toISOString(), blobs: [...blobs], memos: [...this.#memos] };
		const rootDir = join(this.root, 'roots');
		await writeAtomically(join(rootDir, `${hashText(outDir)}.json`), JSON.stringify(root));

		const liveBlobs = new Set<string>();
		const liveMemos = new Set<string>();
		for (const name of await readdir(rootDir)) {
			const path = join(rootDir, name);
			let other: Root;
			try {
				// oxlint-disable-next-line no-await-in-loop, typescript/no-unsafe-type-assertion -- roots are few; ours
				other = JSON.parse(await readFile(path, 'utf8')) as Root;
				// oxlint-disable-next-line no-await-in-loop -- roots are few
				await stat(join(other.outDir, CORE_ARCHIVE));
			} catch {
				// unreadable, or its package is gone
				// oxlint-disable-next-line no-await-in-loop -- roots are few
				await rm(path, { force: true });
				continue;
			}
			for (const hash of other.blobs) {
				liveBlobs.add(hash);
			}
			for (const key of other.memos) {
				liveMemos.add(key);
			}
		}
		const blobSweep = await sweep(this.blobs.root, (name) => liveBlobs.has(name));
		const memoSweep = await sweep(join(this.root, 'memo'), (name) =>
			liveMemos.has(name.replace(/\.json$/, '')),
		);
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

	#memoPath(key: string): string {
		return join(this.root, 'memo', key.slice(0, 2), `${key}.json`);
	}
}

/** @returns the hashes of a result's blobs */
const resultBlobs = (result: ConvertResult): string[] => {
	return result.kind === 'geometry' ? [result.blob.hash] : result.pieces.map((piece) => piece.blob.hash);
};

const hashText = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 32);

/** takes a lock file holding our pid; a lock left by a process that's gone is taken over */
const lock = async (path: string): Promise<void> => {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			// oxlint-disable-next-line no-await-in-loop -- retried once after clearing a stale lock
			const handle = await open(path, 'wx');
			// oxlint-disable-next-line no-await-in-loop
			await handle.writeFile(String(process.pid));
			// oxlint-disable-next-line no-await-in-loop
			await handle.close();
			return;
		} catch (error) {
			if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
				throw error;
			}
		}
		// oxlint-disable-next-line no-await-in-loop
		const pid = Number(await readFile(path, 'utf8').catch(() => ''));
		if (Number.isInteger(pid) && pid > 0 && isRunning(pid)) {
			throw new Error(`the pack cache ${path} is in use by process ${pid}; wait for it, or pass --no-cache`);
		}
		// oxlint-disable-next-line no-await-in-loop
		await rm(path, { force: true });
	}
	throw new Error(`couldn't take the pack cache lock ${path}`);
};

const isRunning = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: it exists but isn't ours
		return error instanceof Error && 'code' in error && error.code === 'EPERM';
	}
};

const writeAtomically = async (path: string, data: string): Promise<void> => {
	await mkdir(join(path, '..'), { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	await writeFile(temp, data);
	await rename(temp, path);
};

/** deletes the files of a fanned-out directory that `keep` rejects, plus leftover temporary files */
const sweep = async (
	dir: string,
	keep: (name: string) => boolean,
): Promise<{ files: number; bytes: number }> => {
	let files = 0;
	let bytes = 0;
	const fans = await readdir(dir).catch((): string[] => []);
	await Promise.all(
		fans.map(async (fan) => {
			const names = await readdir(join(dir, fan)).catch((): string[] => []);
			for (const name of names) {
				if (keep(name)) {
					continue;
				}
				const path = join(dir, fan, name);
				// oxlint-disable-next-line no-await-in-loop -- one fan at a time per task bounds open files
				const size = (await stat(path).catch(() => undefined))?.size ?? 0;
				// oxlint-disable-next-line no-await-in-loop
				await rm(path, { force: true });
				files++;
				bytes += size;
			}
		}),
	);
	return { files, bytes };
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
