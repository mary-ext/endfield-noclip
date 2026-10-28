import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';

import { BlobCodec, blobPath, type BlobKind, type BlobRecord } from '@endfield-noclip/package-format/format';

import { type ArchivePlan, encodeArchive, encodeArchiveStream, planArchive } from '@mary-ext/czar';

import { zstd } from '../zstd.ts';

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

/** a blob compressed and hashed, but not stored yet; see {@link BlobStore.prepare} */
export interface PreparedBlob {
	hash: string;
	stored: Uint8Array;
	codec: BlobCodec;
	rawLength: number;
	options: PutOptions;
}

/** a blob as the store tracks it */
interface StoredBlob {
	hash: string;
	kind: BlobKind;
	codec: BlobCodec;
	archive: string;
	length: number;
	rawLength: number;
	crc32: number;
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
 * content-addressed blob store. blobs are compressed and spooled to disk as they arrive, deduplicated by the
 * SHA-256 of their stored bytes, and laid out into czar archives at the end. a blob's index is fixed by its
 * first `put`, so tables can reference blobs before any archive exists
 */
export class BlobStore {
	readonly #spool: string;
	readonly #level: number;
	readonly #blobs: StoredBlob[] = [];
	readonly #byHash = new Map<string, number>();
	readonly #pending: Promise<void>[] = [];
	#spoolReady: Promise<unknown> | undefined;
	/** blob indices by archive, in first-use order; dropped whenever a blob is added */
	#groupsCache: Map<string, number[]> | undefined;

	/**
	 * @param spool scratch directory for blob bytes; created on demand, removed by {@link BlobStore.dispose}
	 * @param options zstd level for compressed blobs
	 */
	constructor(spool: string, options: { zstdLevel: number }) {
		this.#spool = spool;
		this.#level = options.zstdLevel;
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
	 * compresses and hashes a blob without storing it, so several can be prepared concurrently and committed in
	 * a deterministic order
	 *
	 * @param raw the blob's bytes before compression; may be reused once the promise settles
	 * @param options kind, compression and placement
	 * @returns the prepared blob, for {@link BlobStore.commit}
	 */
	async prepare(raw: Uint8Array, options: PutOptions): Promise<PreparedBlob> {
		let stored: Uint8Array | undefined;
		let codec: BlobCodec = BlobCodec.None;
		if (options.compress) {
			const packed = await zstd(raw, options.zstdLevel ?? this.#level);
			// a zstd frame costs a decode pass; take it only when it pays
			if (packed.length <= raw.length - raw.length / 32) {
				stored = packed;
				codec = BlobCodec.Zstd;
			}
		}
		// the spool keeps its own copy, since callers may reuse `raw`
		stored ??= raw.slice();
		const hash = createHash('sha256').update(stored).digest('hex').slice(0, 32);
		return { hash, stored, codec, rawLength: raw.length, options };
	}

	/**
	 * stores a prepared blob, or finds its twin
	 *
	 * @param blob from {@link BlobStore.prepare}
	 * @returns the blob's index
	 */
	commit(blob: PreparedBlob): number {
		const existing = this.#byHash.get(blob.hash);
		if (existing !== undefined) {
			return existing;
		}
		const index = this.#blobs.length;
		this.#blobs.push({
			hash: blob.hash,
			kind: blob.options.kind,
			codec: blob.codec,
			archive: blob.options.archive(blob.hash, blob.stored.length),
			length: blob.stored.length,
			rawLength: blob.rawLength,
			crc32: crc32(blob.stored),
		});
		this.#byHash.set(blob.hash, index);
		this.#groupsCache = undefined;
		this.#pending.push(this.#spoolWrite(blob.hash, blob.stored));
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
	 * streams every archive except the core to disk, reading blob bytes from the spool
	 *
	 * @param outDir package root
	 * @param core core archive name, written by {@link BlobStore.writeCore}
	 * @returns the written archives by name
	 */
	async writeShards(outDir: string, core: string): Promise<Map<string, WrittenArchive>> {
		await Promise.all(this.#pending);
		const written = new Map<string, WrittenArchive>();
		for (const [name, indices] of this.#groups()) {
			if (name === core) {
				continue;
			}
			const plan = this.#plan(indices);
			const target = join(outDir, name);
			// oxlint-disable-next-line no-await-in-loop -- one archive at a time bounds open files
			await mkdir(dirname(target), { recursive: true });
			const stream = encodeArchiveStream(plan, (source) => createReadStream(this.#spoolPath(source.index)));
			// oxlint-disable-next-line no-await-in-loop -- one archive at a time bounds open files
			await pipeline(Readable.fromWeb(stream), createWriteStream(target));
			written.set(name, describe(name, plan.size, plan.head, indices.length));
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
		await Promise.all(this.#pending);
		for (const member of members) {
			if (member.path < 'blobs/') {
				throw new Error(`core member ${member.path} would sort before the blobs and shift their offsets`);
			}
		}
		const blobs = await Promise.all(
			(this.#groups().get(core) ?? []).map(async (index) => {
				const blob = this.#blobs[index];
				return { path: blobPath(blob.hash, blob.kind), data: await readFile(this.#spoolPath(index)) };
			}),
		);
		const files = [...blobs, ...members];
		const archive = encodeArchive(files);
		await writeFile(join(outDir, core), archive);
		// the plan's head is the layout encodeArchive wrote; it's only needed for its length
		const { head } = planArchive(
			files.map(({ path, data }) => ({ path, size: data.length, crc32: crc32(data) })),
		);
		return describe(core, archive.length, head, files.length);
	}

	/** waits for spool writes, then removes the spool */
	async dispose(): Promise<void> {
		await Promise.allSettled(this.#pending);
		await rm(this.#spool, { recursive: true, force: true });
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

	#spoolPath(index: number): string {
		return join(this.#spool, this.#blobs[index].hash);
	}

	async #spoolWrite(hash: string, data: Uint8Array): Promise<void> {
		this.#spoolReady ??= mkdir(this.#spool, { recursive: true });
		await this.#spoolReady;
		await writeFile(join(this.#spool, hash), data);
	}
}

const describe = (name: string, size: number, head: Uint8Array, members: number): WrittenArchive => {
	const headerLength = Number(new DataView(head.buffer, head.byteOffset).getBigUint64(8, true));
	return { name, size, dataOffset: head.length, headerLength, members };
};
