import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_ARCHIVE } from '@endfield-noclip/package-format/manifest';

import { getOrInsert } from '../collections.ts';
import { errorCode, ignoreMissing } from '../errors.ts';

import { BlobDir, type BlobMeta, shortHash } from './blob-file.ts';
import type { BundleSource, ConvertResult } from './convert-pool.ts';

// a persistent cache for packing: converted meshes and textures, and every blob a pack stores. blobs live in
// a BlobDir that serves as the pack's blob store, so a re-pack reads cached blobs straight into its archives.
// conversions are remembered by a key over the job (the object, the options) and a fingerprint of the
// converter's code, along with the md5s (from the VFS catalog) of every bundle they read, so an install update
// or a converter change misses. whole pack steps (terrain, irradiance) are remembered the same way, keyed by
// their own module's code and the content md5s of what they read.
//
// the cache keeps what the packages it built are made of: each pack records its blobs and conversions as a
// root named after its output directory, and then deletes whatever no root references. a root goes away with
// its package (when the directory no longer holds a core archive). one pack uses a cache at a time.

/** the conversion worker; the fingerprint covers it and every workspace module it imports, transitively */
const CONVERTER_ENTRY = new URL('./convert-worker.ts', import.meta.url);

/** where workspace packages live, relative to this module; each maps `./*` to `./src/*.ts` */
const WORKSPACE_PACKAGES = new URL('../../../', import.meta.url);

/** value imports and re-exports (`import … from '…'`, `import '…'`, `export … from '…'`), not type-only ones */
const IMPORT_SPECIFIER = /^(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?'([^']+)'/gm;

/** what a pack's cache use came to */
export interface CacheReport {
	dir: string;
	/** conversions taken from the cache, by kind */
	hits: { geometries: number; textures: number };
	/** what the sweep after the pack deleted */
	swept: { blobs: number; memos: number; bytes: number };
}

/** a pack step's remembered output (see {@link PackCache.stepKey}) */
export interface StepMemo<T> {
	/** the blobs it stored, in the order it commits them; they live in {@link PackCache.blobs} */
	blobs: BlobMeta[];
	/** what else it produced, as JSON */
	value: T;
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
	readonly #stepFingerprints = new Map<string, Promise<string>>();
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
		return new PackCache(root, await moduleFingerprint(CONVERTER_ENTRY));
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
	 * @param current whether the bundles the conversion read are unchanged
	 * @returns its remembered result, or `undefined` if there's none, its sources changed or a blob is gone
	 */
	async recall(
		key: string,
		current: (sources: readonly BundleSource[]) => Promise<boolean>,
	): Promise<ConvertResult | undefined> {
		const text = await ignoreMissing(readFile(this.#memos.path(key), 'utf8'), undefined);
		if (text === undefined) {
			return undefined;
		}
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- written by remember() under the same fingerprint
		const result = JSON.parse(text) as ConvertResult;
		if (!(await current(result.sources))) {
			return undefined;
		}
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
	 * keys a whole pack step (terrain, irradiance) whose output depends only on its inputs and its code. inputs
	 * should name what the step reads by content (VFS data md5s, bundle md5s), so an install update misses
	 *
	 * @param entry the step's module; the key covers it and every workspace module it imports
	 * @param parts what the step's output depends on besides its code; bigints are allowed
	 * @returns the step's key
	 */
	async stepKey(entry: URL, parts: object): Promise<string> {
		const fingerprint = await getOrInsert(this.#stepFingerprints, entry.href, () => moduleFingerprint(entry));
		return shortHash(
			JSON.stringify(['step', fingerprint, parts], (_, value: unknown) =>
				typeof value === 'bigint' ? value.toString() : value,
			),
		);
	}

	/**
	 * @param key from {@link PackCache.stepKey}
	 * @returns the step's remembered output, or `undefined` if there's none or a blob is gone
	 */
	async recallStep<T>(key: string): Promise<StepMemo<T> | undefined> {
		const text = await ignoreMissing(readFile(this.#memos.path(key), 'utf8'), undefined);
		if (text === undefined) {
			return undefined;
		}
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- written by rememberStep() under this key
		const memo = JSON.parse(text) as StepMemo<T>;
		const present = await Promise.all(memo.blobs.map((blob) => this.blobs.has(blob.hash)));
		if (!present.every(Boolean)) {
			return undefined;
		}
		this.#used.add(key);
		return memo;
	}

	/**
	 * remembers a step's output; its blobs must be in {@link PackCache.blobs} already
	 *
	 * @param key from {@link PackCache.stepKey}
	 * @param memo the blobs the step stored, in the order it commits them, and whatever else it needs
	 */
	async rememberStep<T>(key: string, memo: StepMemo<T>): Promise<void> {
		await this.#memos.replace(key, JSON.stringify(memo));
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

/**
 * @param entry a module that decides cached results (the conversion worker, a pack step)
 * @returns a hash over its workspace import graph, the extractor's dependencies and Node's zstd
 */
const moduleFingerprint = async (entry: URL): Promise<string> => {
	const sources = new Map<string, Buffer>();
	const visit = async (url: URL): Promise<void> => {
		const path = fileURLToPath(url);
		if (sources.has(path)) {
			return;
		}
		const content = await readFile(path);
		sources.set(path, content);
		const imports: URL[] = [];
		for (const [, specifier] of content.toString('utf8').matchAll(IMPORT_SPECIFIER)) {
			if (specifier.startsWith('.')) {
				imports.push(new URL(specifier, url));
			} else if (specifier.startsWith('@endfield-noclip/')) {
				const [name, ...rest] = specifier.slice('@endfield-noclip/'.length).split('/');
				imports.push(new URL(`${name}/src/${rest.join('/')}.ts`, WORKSPACE_PACKAGES));
			}
			// anything else is a dependency, pinned by the extractor's package.json, or a node built-in
		}
		await Promise.all(imports.map(visit));
	};
	await visit(entry);

	const hash = createHash('sha256');
	const base = fileURLToPath(WORKSPACE_PACKAGES);
	for (const path of [...sources.keys()].toSorted()) {
		hash.update(`${relative(base, path)}\0`).update(sources.get(path)!);
	}
	hash.update(await readFile(new URL('../../package.json', import.meta.url)));
	hash.update(`zstd ${process.versions.zstd ?? 'unknown'}`);
	return hash.digest('hex');
};
