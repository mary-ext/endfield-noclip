import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';

import { BlobCodec, blobPath, type BlobKind, type BlobRecord } from '@endfield-noclip/package-format/format';

import { type ArchivePlan, encodeArchive, encodeArchiveStream, planArchive } from '@mary-ext/czar';

import { zstd } from '../zstd.ts';

// #region blob files

/** a stored blob's identity and sizes; its bytes live in a {@link BlobDir} under {@link hash} */
export interface BlobMeta {
	/** first 128 bits of the SHA-256 of the stored bytes, hex */
	hash: string;
	codec: BlobCodec;
	/** stored byte length */
	length: number;
	/** byte length after undoing the codec */
	rawLength: number;
	crc32: number;
}

/**
 * picks a blob's stored form: the zstd frame when it saves at least 1/32 of the bytes (a frame costs a decode
 * pass), else the raw bytes
 *
 * @param raw the blob's bytes
 * @param packed `raw` as one zstd frame, or `null` when the blob isn't compressed
 * @returns the stored bytes and their description
 */
export const storedBlob = (
	raw: Uint8Array,
	packed: Uint8Array | null,
): { meta: BlobMeta; stored: Uint8Array } => {
	const pays = packed !== null && packed.length <= raw.length - raw.length / 32;
	const stored = pays ? packed : raw;
	return {
		meta: {
			hash: createHash('sha256').update(stored).digest('hex').slice(0, 32),
			codec: pays ? BlobCodec.Zstd : BlobCodec.None,
			length: stored.length,
			rawLength: raw.length,
			crc32: crc32(stored),
		},
		stored,
	};
};

/**
 * a directory of stored blobs named by hash, fanned out by the hash's first two digits. writers in several
 * threads may add the same blob at once: each write goes to a temporary file that's renamed into place
 */
export class BlobDir {
	readonly root: string;
	readonly #made = new Map<string, Promise<unknown>>();

	/** @param root the directory; created on demand */
	constructor(root: string) {
		this.root = root;
	}

	/** @returns where a blob's bytes live */
	path(hash: string): string {
		return join(this.root, hash.slice(0, 2), hash);
	}

	/** @returns whether a blob's file exists */
	async has(hash: string): Promise<boolean> {
		try {
			await stat(this.path(hash));
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * stores a blob unless it's there already
	 *
	 * @param hash the blob's hash
	 * @param stored its stored bytes
	 */
	async write(hash: string, stored: Uint8Array): Promise<void> {
		if (await this.has(hash)) {
			return;
		}
		const fan = join(this.root, hash.slice(0, 2));
		let made = this.#made.get(fan);
		if (made === undefined) {
			made = mkdir(fan, { recursive: true });
			this.#made.set(fan, made);
		}
		await made;
		const temp = `${this.path(hash)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
		await writeFile(temp, stored);
		await rename(temp, this.path(hash));
	}
}

// #endregion

// #region store

/** how to store one blob */
export interface PutOptions {
	kind: BlobKind;
	/** compress with zstd (kept uncompressed unless that saves at least 1/32 of the bytes) */
	compress: boolean;
	/** zstd level for this blob, instead of the store's */
	zstdLevel?: number;
	/**
	 * archive to place the blob in, relative to the package root. called once per new blob, at commit, with its
	 * content hash and stored length. a blob that's already stored keeps its first archive
	 */
	archive: (hash: string, length: number) => string;
}

/** a blob whose bytes are in the store's directory, but which has no index yet; see {@link BlobStore.commit} */
export interface PreparedBlob {
	meta: BlobMeta;
	options: Pick<PutOptions, 'kind' | 'archive'>;
}

/** a blob as the store tracks it */
interface StoredBlob extends BlobMeta {
	kind: BlobKind;
	archive: string;
}

/** a non-blob member of the core archive (manifest, tables) */
export interface ArchiveMember {
	path: string;
	data: Uint8Array;
}

/** a written archive */
export interface WrittenArchive {
	name: string;
	/** total byte length */
	size: number;
	/** byte position of the data section; blob offsets are relative to it */
	dataOffset: number;
	/** byte length of the JSON header */
	headerLength: number;
	members: number;
}

/** a blob as a czar file source */
interface BlobSource {
	path: string;
	size: number;
	crc32: number;
	index: number;
}

/**
 * content-addressed blob store. blobs are compressed and written to a {@link BlobDir} as they arrive,
 * deduplicated by the SHA-256 of their stored bytes, and laid out into czar archives at the end. a blob's
 * index is fixed by its commit, so tables can reference blobs before any archive exists
 */
export class BlobStore {
	readonly dir: BlobDir;
	readonly #level: number;
	readonly #temporary: boolean;
	readonly #blobs: StoredBlob[] = [];
	readonly #byHash = new Map<string, number>();
	/** blob indices by archive, in first-use order; dropped whenever a blob is added */
	#groupsCache: Map<string, number[]> | undefined;

	/**
	 * @param dir where blob bytes go: a scratch directory, or a cache that outlives the store
	 * @param options zstd level for compressed blobs, and whether {@link BlobStore.dispose} removes `dir`
	 */
	constructor(dir: BlobDir, options: { zstdLevel: number; temporary: boolean }) {
		this.dir = dir;
		this.#level = options.zstdLevel;
		this.#temporary = options.temporary;
	}

	/** number of distinct blobs */
	get size(): number {
		return this.#blobs.length;
	}

	/**
	 * stores a blob
	 *
	 * @param raw the blob's bytes before compression; may be reused once the promise settles
	 * @param options kind, compression and placement
	 * @returns the blob's index
	 */
	async put(raw: Uint8Array, options: PutOptions): Promise<number> {
		const [index] = await this.putMany([{ raw, options }]);
		return index;
	}

	/**
	 * stores several blobs, compressing them in parallel. indices follow input order, so output stays
	 * deterministic
	 *
	 * @param items blobs and their options
	 * @returns each blob's index, in input order
	 */
	async putMany(items: readonly { raw: Uint8Array; options: PutOptions }[]): Promise<number[]> {
		const prepared = await Promise.all(items.map(({ raw, options }) => this.prepare(raw, options)));
		return prepared.map((blob) => this.commit(blob));
	}

	/**
	 * compresses, hashes and writes a blob without indexing it, so several can be prepared concurrently and
	 * committed in a deterministic order
	 *
	 * @param raw the blob's bytes before compression; may be reused once the promise settles
	 * @param options kind, compression and placement
	 * @returns the prepared blob, for {@link BlobStore.commit}
	 */
	async prepare(raw: Uint8Array, options: PutOptions): Promise<PreparedBlob> {
		const packed = options.compress ? await zstd(raw, options.zstdLevel ?? this.#level) : null;
		const { meta, stored } = storedBlob(raw, packed);
		await this.dir.write(meta.hash, stored);
		return { meta, options };
	}

	/**
	 * indexes a prepared blob, or finds its twin
	 *
	 * @param blob from {@link BlobStore.prepare}, or a blob another thread wrote to {@link BlobStore.dir}
	 * @returns the blob's index
	 */
	commit(blob: PreparedBlob): number {
		const { meta, options } = blob;
		const existing = this.#byHash.get(meta.hash);
		if (existing !== undefined) {
			return existing;
		}
		const index = this.#blobs.length;
		this.#blobs.push({ ...meta, kind: options.kind, archive: options.archive(meta.hash, meta.length) });
		this.#byHash.set(meta.hash, index);
		this.#groupsCache = undefined;
		return index;
	}

	/** @returns blob counts and stored/raw byte totals by kind */
	totals(): Map<BlobKind, { count: number; stored: number; raw: number }> {
		const totals = new Map<BlobKind, { count: number; stored: number; raw: number }>();
		for (const blob of this.#blobs) {
			const total = totals.get(blob.kind) ?? { count: 0, stored: 0, raw: 0 };
			total.count++;
			total.stored += blob.length;
			total.raw += blob.rawLength;
			totals.set(blob.kind, total);
		}
		return totals;
	}

	/** @returns the hash of a stored blob */
	hashOf(index: number): string {
		return this.#blobs[index].hash;
	}

	/** @returns every blob's hash, in index order */
	hashes(): string[] {
		return this.#blobs.map((blob) => blob.hash);
	}

	/** @returns archive names in first-use order */
	archiveNames(): string[] {
		return [...this.#groups().keys()];
	}

	/**
	 * describes every blob's final storage. offsets are relative to each archive's data section. in the core,
	 * blob paths sort before every fixed member, so their offsets don't depend on the tables that hold them
	 *
	 * @param archives archive names in manifest order; records index into it
	 * @returns one record per blob, in index order
	 * @throws {Error} if a blob's archive isn't listed
	 */
	records(archives: readonly string[]): BlobRecord[] {
		const offsets = new Map<number, number>();
		for (const indices of this.#groups().values()) {
			const plan = this.#plan(indices);
			for (const segment of plan.segments) {
				offsets.set(segment.source.index, segment.position - plan.head.length);
			}
		}
		const archiveIndex = new Map(archives.map((name, index) => [name, index]));
		return this.#blobs.map((blob, index) => {
			const archive = archiveIndex.get(blob.archive);
			if (archive === undefined) {
				throw new Error(`blob ${blob.hash} is in archive ${blob.archive}, which isn't listed`);
			}
			return {
				hash: blob.hash,
				archive,
				codec: blob.codec,
				kind: blob.kind,
				// empty blobs have no segment; their offset is never read
				offset: offsets.get(index) ?? 0,
				length: blob.length,
				rawLength: blob.rawLength,
			};
		});
	}

	/**
	 * streams every archive except the core to disk, reading blob bytes from the store's directory
	 *
	 * @param outDir package root
	 * @param core core archive name, written by {@link BlobStore.writeCore}
	 * @returns the written archives by name
	 */
	async writeShards(outDir: string, core: string): Promise<Map<string, WrittenArchive>> {
		const written = new Map<string, WrittenArchive>();
		for (const [name, indices] of this.#groups()) {
			if (name === core) {
				continue;
			}
			const plan = this.#plan(indices);
			const target = join(outDir, name);
			// oxlint-disable-next-line no-await-in-loop -- one archive at a time bounds open files
			await mkdir(dirname(target), { recursive: true });
			const stream = encodeArchiveStream(plan, (source) => createReadStream(this.#blobPath(source.index)));
			// oxlint-disable-next-line no-await-in-loop -- one archive at a time bounds open files
			await pipeline(Readable.fromWeb(stream), createWriteStream(target));
			written.set(name, describe(name, plan, indices.length));
		}
		return written;
	}

	/**
	 * writes the core archive: its blobs plus the fixed members, in memory
	 *
	 * @param outDir package root
	 * @param core core archive name
	 * @param members fixed members; their paths must sort after `blobs/`
	 * @returns the written archive
	 * @throws {Error} if a member would sort before the blobs
	 */
	async writeCore(outDir: string, core: string, members: readonly ArchiveMember[]): Promise<WrittenArchive> {
		for (const member of members) {
			if (member.path < 'blobs/') {
				throw new Error(`core member ${member.path} would sort before the blobs and shift their offsets`);
			}
		}
		const blobs = await Promise.all(
			(this.#groups().get(core) ?? []).map(async (index) => {
				const blob = this.#blobs[index];
				return { path: blobPath(blob.hash, blob.kind), data: await readFile(this.#blobPath(index)) };
			}),
		);
		const files = [...blobs, ...members];
		const archive = encodeArchive(files);
		await writeFile(join(outDir, core), archive);
		// the plan is the layout encodeArchive wrote; only its lengths are needed
		const plan = planArchive(
			files.map(({ path, data }) => ({ path, size: data.length, crc32: crc32(data) })),
		);
		return describe(core, plan, files.length);
	}

	/** removes the store's directory if it's a scratch one */
	async dispose(): Promise<void> {
		if (this.#temporary) {
			await rm(this.dir.root, { recursive: true, force: true });
		}
	}

	#groups(): Map<string, number[]> {
		if (this.#groupsCache === undefined) {
			const groups = new Map<string, number[]>();
			for (const [index, blob] of this.#blobs.entries()) {
				const list = groups.get(blob.archive) ?? [];
				list.push(index);
				groups.set(blob.archive, list);
			}
			this.#groupsCache = groups;
		}
		return this.#groupsCache;
	}

	#plan(indices: readonly number[]): ArchivePlan<BlobSource> {
		return planArchive(
			indices.map((index) => {
				const blob = this.#blobs[index];
				return { path: blobPath(blob.hash, blob.kind), size: blob.length, crc32: blob.crc32, index };
			}),
		);
	}

	#blobPath(index: number): string {
		return this.dir.path(this.#blobs[index].hash);
	}
}

const describe = <T>(name: string, plan: ArchivePlan<T>, members: number): WrittenArchive => {
	return { name, size: plan.size, dataOffset: plan.head.length, headerLength: plan.headerLength, members };
};

// #endregion
