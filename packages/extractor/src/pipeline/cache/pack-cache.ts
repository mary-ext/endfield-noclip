import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { deserialize, serialize } from 'node:v8';

import { CORE_ARCHIVE } from '@endfield-noclip/package-format/manifest';

import { errorCode, ignoreMissing } from '../../util/errors.ts';
import type { BundleSource, ConvertJob, ConvertResult } from '../compile/convert-pool.ts';

import { BlobDir, type BlobMeta, shortHash, storedBlobKey, type StoredBlobLookup } from './blob-file.ts';

// caches converted assets and pack steps by code fingerprint, options and input catalog MD5s in a SQLite
// database (`cache.sqlite`) alongside the content-addressed `blobs/` directory. each live package roots its
// blobs and memos; unreferenced entries are swept after packing.

/** SQLite database filename under the cache root */
const CACHE_DB = 'cache.sqlite';

/** converter entry modules, fingerprinted separately so geometry edits don't invalidate cached textures */
const CONVERTER_ENTRIES: Record<ConvertJob['kind'], URL> = {
	geometry: new URL('../compile/convert-geometry.ts', import.meta.url),
	texture: new URL('../compile/convert-texture.ts', import.meta.url),
};

/** where workspace packages live, relative to this module; each maps `./*` to `./src/*.ts` */
const WORKSPACE_PACKAGES = new URL('../../../../', import.meta.url);

/** value imports and re-exports (`import … from '…'`, `import '…'`, `export … from '…'`), not type-only ones */
const IMPORT_SPECIFIER = /^(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?'([^']+)'/gm;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memos (
	key TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	payload BLOB NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS roots (
	out_dir TEXT PRIMARY KEY,
	updated_at TEXT NOT NULL,
	blobs BLOB NOT NULL,
	memos BLOB NOT NULL
) WITHOUT ROWID;
`;

/** what a pack's cache use came to */
export interface CacheReport {
	dir: string;
	/** conversions taken from the cache, by kind */
	hits: { geometries: number; materials: number; textures: number };
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

interface RootRow {
	out_dir: string;
	blobs: Uint8Array;
	memos: Uint8Array;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const encodeLines = (items: readonly string[]): Uint8Array => encoder.encode(items.join('\n'));
const decodeLines = (bytes: Uint8Array): string[] => {
	if (bytes.byteLength === 0) {
		return [];
	}
	return decoder.decode(bytes).split('\n');
};

/**
 * opens a lightweight SQLite handle on `dbPath` for conversion workers to deduplicate raw blobs before zstd
 *
 * @param dbPath path to `cache.sqlite`
 * @returns lookup handle with a `close()` method
 */
export const openStoredBlobLookup = (dbPath: string): StoredBlobLookup & { close(): void } => {
	const db = new DatabaseSync(dbPath, { timeout: 5000 });
	db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
	const getStmt = db.prepare('SELECT payload FROM memos WHERE key = ?');
	const putStmt = db.prepare("INSERT OR REPLACE INTO memos (key, kind, payload) VALUES (?, 'stored', ?)");
	return {
		get(key: string): BlobMeta | undefined {
			const row = getStmt.get(key);
			if (row === undefined || !(row.payload instanceof Uint8Array)) {
				return undefined;
			}
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- written by set() as BlobMeta JSON
			return JSON.parse(decoder.decode(row.payload)) as BlobMeta;
		},
		set(key: string, meta: BlobMeta): void {
			putStmt.run(key, encoder.encode(JSON.stringify(meta)));
		},
		close(): void {
			db.close();
		},
	};
};

/** a pack's handle on the cache, holding its lock until {@link PackCache.close} */
export class PackCache {
	readonly root: string;
	/** path to `cache.sqlite`, passed to conversion workers for raw-byte deduplication */
	readonly dbPath: string;
	/** where the pack's blob store writes */
	readonly blobs: BlobDir;
	readonly hits = { geometries: 0, materials: 0, textures: 0 };
	readonly #db: DatabaseSync;
	readonly #getMemo: StatementSync;
	readonly #putMemo: StatementSync | null;
	readonly #putRoot: StatementSync | null;
	readonly #listRoots: StatementSync;
	readonly #deleteRoot: StatementSync | null;
	readonly #fingerprints: Record<ConvertJob['kind'], string>;
	readonly #readOnly: boolean;
	readonly #stepFingerprints = new Map<string, Promise<string>>();
	readonly #used = new Set<string>();
	#closed = false;

	private constructor(
		root: string,
		dbPath: string,
		db: DatabaseSync,
		fingerprints: Record<ConvertJob['kind'], string>,
		readOnly: boolean,
	) {
		this.root = root;
		this.dbPath = dbPath;
		this.blobs = new BlobDir(join(root, 'blobs'));
		this.#db = db;
		this.#fingerprints = fingerprints;
		this.#readOnly = readOnly;
		this.#getMemo = db.prepare('SELECT payload FROM memos WHERE key = ?');
		this.#listRoots = db.prepare('SELECT out_dir, blobs, memos FROM roots');
		if (readOnly) {
			this.#putMemo = null;
			this.#putRoot = null;
			this.#deleteRoot = null;
		} else {
			this.#putMemo = db.prepare('INSERT OR REPLACE INTO memos (key, kind, payload) VALUES (?, ?, ?)');
			this.#putRoot = db.prepare(
				'INSERT OR REPLACE INTO roots (out_dir, updated_at, blobs, memos) VALUES (?, ?, ?, ?)',
			);
			this.#deleteRoot = db.prepare('DELETE FROM roots WHERE out_dir = ?');
		}
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
		try {
			const dbPath = join(root, CACHE_DB);
			const db = new DatabaseSync(dbPath, { timeout: 5000 });
			db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
			db.exec(SCHEMA_SQL);
			const [geometry, texture] = await Promise.all([
				moduleFingerprint(CONVERTER_ENTRIES.geometry),
				moduleFingerprint(CONVERTER_ENTRIES.texture),
			]);
			return new PackCache(root, dbPath, db, { geometry, texture }, false);
		} catch (error) {
			await rm(join(root, 'lock'), { force: true });
			throw error;
		}
	}

	/**
	 * opens an existing cache read-only without taking a lock or fingerprinting asset converters, so inspection
	 * commands (`scene find`, `scene prefabs`, `scene env`) can reuse step memos from previous packs
	 *
	 * @param root the cache directory
	 * @returns a read-only handle, or `null` if the database doesn't exist
	 */
	static async openReadOnly(root: string): Promise<PackCache | null> {
		const dbPath = join(root, CACHE_DB);
		if ((await ignoreMissing(stat(dbPath), undefined)) === undefined) {
			return null;
		}
		const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
		return new PackCache(root, dbPath, db, { geometry: '', texture: '' }, true);
	}

	/** resets per-scene hit counters and tracked memo usage when reusing a cache across multiple scenes */
	beginScene(): void {
		this.hits.geometries = 0;
		this.hits.materials = 0;
		this.hits.textures = 0;
		this.#used.clear();
	}

	#readMemo(key: string): Uint8Array | undefined {
		const row = this.#getMemo.get(key);
		return row !== undefined && row.payload instanceof Uint8Array ? row.payload : undefined;
	}

	#writeMemo(key: string, kind: string, payload: Uint8Array): void {
		if (this.#putMemo === null) {
			return;
		}
		this.#putMemo.run(key, kind, payload);
		this.#used.add(key);
	}

	/**
	 * @param kind converter kind (`geometry` or `texture`)
	 * @param parts what the conversion depends on besides the converter's code; bigints and typed arrays are
	 *   allowed
	 * @returns the conversion's key
	 */
	key(kind: ConvertJob['kind'], parts: object): string {
		return shortHash(JSON.stringify([this.#fingerprints[kind], parts], keyReplacer));
	}

	/**
	 * @param key a conversion's key
	 * @param current whether the bundles (or manifest, when no bundle was read) are unchanged
	 * @returns its remembered result, or `undefined` if there's none, its sources changed or a blob is gone
	 */
	async recall(
		key: string,
		current: (sources: readonly BundleSource[], manifestHash?: string) => Promise<boolean>,
	): Promise<ConvertResult | undefined> {
		const payload = this.#readMemo(key);
		if (payload === undefined) {
			return undefined;
		}
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- written by remember() under the same fingerprint
		const result = JSON.parse(decoder.decode(payload)) as ConvertResult;
		const manifestHash = result.kind === 'failed' ? result.manifestHash : undefined;
		if (!(await current(result.sources, manifestHash))) {
			return undefined;
		}
		const present = await Promise.all(resultBlobs(result).map((hash) => this.blobs.has(hash)));
		if (!present.every(Boolean)) {
			return undefined;
		}
		this.#used.add(key);
		const hitKind = result.kind === 'failed' ? result.jobKind : result.kind;
		this.hits[hitKind === 'geometry' ? 'geometries' : 'textures']++;
		return result;
	}

	/**
	 * remembers a conversion; its blobs must be in {@link PackCache.blobs} already
	 *
	 * @param key the conversion's key
	 * @param result what it produced
	 */
	remember(key: string, result: ConvertResult): Promise<void> {
		this.#writeMemo(key, result.kind, encoder.encode(JSON.stringify(result)));
		return Promise.resolve();
	}

	/**
	 * @param entry a module whose workspace import graph decides cached results
	 * @returns its cached code fingerprint
	 */
	fingerprint(entry: URL): Promise<string> {
		return this.#stepFingerprints.getOrInsertComputed(entry.href, () => moduleFingerprint(entry));
	}

	/**
	 * computes a step memo key from a precomputed {@link fingerprint} without awaiting
	 *
	 * @param fingerprint code fingerprint from {@link fingerprint}
	 * @param parts what the step's output depends on besides its code; bigints and typed arrays are allowed
	 * @returns the step's key
	 */
	keyWith(fingerprint: string, parts: object): string {
		return shortHash(JSON.stringify(['step', fingerprint, parts], keyReplacer));
	}

	/**
	 * keys a whole pack step (terrain, irradiance) whose output depends only on its inputs and its code. inputs
	 * should name what the step reads by content (VFS data md5s, bundle md5s), so an install update misses
	 *
	 * @param entry the step's module; the key covers it and every workspace module it imports
	 * @param parts what the step's output depends on besides its code; bigints and typed arrays are allowed
	 * @returns the step's key
	 */
	async stepKey(entry: URL, parts: object): Promise<string> {
		return this.keyWith(await this.fingerprint(entry), parts);
	}

	/**
	 * @param key from {@link PackCache.stepKey}
	 * @returns the step's remembered output, or `undefined` if there's none or a blob is gone
	 */
	async recallStep<T>(key: string): Promise<StepMemo<T> | undefined> {
		const payload = this.#readMemo(key);
		if (payload === undefined) {
			return undefined;
		}
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- written by rememberStep() under this key
		const memo = JSON.parse(decoder.decode(payload)) as StepMemo<T>;
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
	rememberStep<T>(key: string, memo: StepMemo<T>): Promise<void> {
		this.#writeMemo(key, 'step', encoder.encode(JSON.stringify(memo)));
		return Promise.resolve();
	}

	/**
	 * @param key from {@link PackCache.stepKey}
	 * @returns the value {@link rememberValue} stored under the key, or `undefined` if there's none
	 */
	recallValue<T>(key: string): Promise<T | undefined> {
		const payload = this.#readMemo(key);
		if (payload === undefined) {
			return Promise.resolve(undefined);
		}
		this.#used.add(key);
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- written by rememberValue() under this key
		return Promise.resolve(deserialize(payload) as T);
	}

	/**
	 * remembers a value with no blobs. it's stored in V8's serialization format rather than JSON, so bigints,
	 * non-finite numbers, `undefined` and typed arrays come back as they went in
	 *
	 * @param key from {@link PackCache.stepKey}
	 * @param value what to remember
	 */
	rememberValue(key: string, value: unknown): Promise<void> {
		if (this.#readOnly) {
			return Promise.resolve();
		}
		this.#writeMemo(key, 'value', serialize(value));
		return Promise.resolve();
	}

	/**
	 * @param raw a blob's bytes before compression
	 * @param level the zstd level it would be compressed at
	 * @returns the key of its stored form, for {@link recallStored} and {@link rememberStored}
	 */
	storedKey(raw: Uint8Array, level: number): string {
		return storedBlobKey(raw, level);
	}

	/** @returns current hit counts without updating roots or sweeping */
	report(): CacheReport {
		return {
			dir: this.root,
			hits: { ...this.hits },
			swept: { blobs: 0, memos: 0, bytes: 0 },
		};
	}

	/**
	 * @param key from {@link storedKey}
	 * @returns the stored form remembered for the bytes, or `undefined` if there's none or its blob is gone
	 */
	async recallStored(key: string): Promise<BlobMeta | undefined> {
		const payload = this.#readMemo(key);
		if (payload === undefined) {
			return undefined;
		}
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- written by rememberStored() under this key
		const meta = JSON.parse(decoder.decode(payload)) as BlobMeta;
		if (!(await this.blobs.has(meta.hash))) {
			return undefined;
		}
		this.#used.add(key);
		return meta;
	}

	/**
	 * remembers a blob's stored form; its bytes must be in {@link PackCache.blobs} already
	 *
	 * @param key from {@link storedKey}
	 * @param meta the stored blob
	 */
	rememberStored(key: string, meta: BlobMeta): Promise<void> {
		this.#writeMemo(key, 'stored', encoder.encode(JSON.stringify(meta)));
		return Promise.resolve();
	}

	/**
	 * records a finished package as a root without sweeping, for multi-scene sessions that sweep once at the
	 * end
	 *
	 * @param outDir the package's directory
	 * @param blobs hashes of every blob the package holds
	 */
	recordRoot(outDir: string, blobs: readonly string[]): void {
		if (this.#putRoot === null) {
			return;
		}
		this.#putRoot.run(outDir, new Date().toISOString(), encodeLines(blobs), encodeLines([...this.#used]));
	}

	/**
	 * drops roots whose `core.czar` is gone and deletes every unreferenced blob and memo
	 *
	 * @returns what was deleted
	 */
	async sweep(): Promise<CacheReport['swept']> {
		if (this.#deleteRoot === null) {
			return { blobs: 0, memos: 0, bytes: 0 };
		}
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- matches SELECT columns
		const rows = this.#listRoots.all() as unknown as RootRow[];
		const liveBlobs = new Set<string>();
		const liveMemos = new Set<string>();
		const staleDirs: string[] = [];
		await Promise.all(
			rows.map(async (row) => {
				if ((await ignoreMissing(stat(join(row.out_dir, CORE_ARCHIVE)), undefined)) === undefined) {
					staleDirs.push(row.out_dir);
					return;
				}
				for (const hash of decodeLines(row.blobs)) {
					liveBlobs.add(hash);
				}
				for (const key of decodeLines(row.memos)) {
					liveMemos.add(key);
				}
			}),
		);
		// delete stale roots and dead memos in one SQLite transaction
		let sweptMemos = 0;
		let sweptMemoBytes = 0;
		this.#db.exec('BEGIN');
		try {
			for (const dir of staleDirs) {
				this.#deleteRoot.run(dir);
			}
			const deleteMemo = this.#db.prepare('DELETE FROM memos WHERE key = ?');
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- matches SELECT columns
			const memoRows = this.#db
				.prepare('SELECT key, kind, payload, length(payload) AS bytes FROM memos')
				.all() as unknown as {
				key: string;
				kind: string;
				payload: Uint8Array;
				bytes: number;
			}[];
			for (const { key, kind, payload, bytes } of memoRows) {
				if (liveMemos.has(key)) {
					continue;
				}
				// worker threads write raw-blob dedup memos (`kind = 'stored'`) directly to SQLite without
				// reporting keys to the main thread's `#used` set; keep them while their target blob is live
				if (kind === 'stored') {
					// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- written as BlobMeta JSON
					const meta = JSON.parse(decoder.decode(payload)) as BlobMeta;
					if (liveBlobs.has(meta.hash)) {
						continue;
					}
				}
				deleteMemo.run(key);
				sweptMemos++;
				sweptMemoBytes += bytes;
			}
			this.#db.exec('COMMIT');
		} catch (error) {
			this.#db.exec('ROLLBACK');
			throw error;
		}
		const blobSweep = await this.blobs.sweep((hash) => liveBlobs.has(hash));
		return {
			blobs: blobSweep.files,
			memos: sweptMemos,
			bytes: blobSweep.bytes + sweptMemoBytes,
		};
	}

	/**
	 * records the finished package as a root, then deletes what no root references
	 *
	 * @param outDir the package's directory
	 * @param blobs hashes of every blob the package holds
	 * @returns hits and what was deleted
	 */
	async finish(outDir: string, blobs: readonly string[]): Promise<CacheReport> {
		this.recordRoot(outDir, blobs);
		const swept = await this.sweep();
		return {
			dir: this.root,
			hits: { ...this.hits },
			swept,
		};
	}

	/** closes the database and releases the lock */
	async close(): Promise<void> {
		if (this.#closed) {
			return;
		}
		this.#closed = true;
		this.#db.close();
		if (this.#readOnly) {
			return;
		}
		await rm(join(this.root, 'lock'), { force: true });
	}
}

/** JSON replacer for cache keys: stringifies bigints and digests typed arrays */
const keyReplacer = (_key: string, value: unknown): unknown => {
	if (typeof value === 'bigint') {
		return value.toString();
	}
	// an animation's frames run to megabytes as JSON; their digest stands in for them
	if (ArrayBuffer.isView(value)) {
		const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
		return `${value.constructor.name}:${createHash('sha256').update(bytes).digest('hex')}`;
	}
	return value;
};

/** @returns the hashes of a result's blobs */
const resultBlobs = (result: ConvertResult): string[] => {
	switch (result.kind) {
		case 'geometry': {
			return [result.blob.hash];
		}
		case 'texture': {
			return result.pieces.map((piece) => piece.blob.hash);
		}
		case 'failed': {
			return [];
		}
	}
};

/** acquires the cache lock with the current pid, reclaiming locks left by dead processes */
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
	// oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy
	for (const path of [...sources.keys()].sort()) {
		hash.update(`${relative(base, path)}\0`).update(sources.get(path)!);
	}
	hash.update(await readFile(new URL('../../../package.json', import.meta.url)));
	hash.update(`zstd ${process.versions.zstd ?? 'unknown'}`);
	return hash.digest('hex');
};
