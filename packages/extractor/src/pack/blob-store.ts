import { createHash } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';

import type { BlobRecord } from '@endfield-noclip/package-format/blob-table';
import { blobPath, type BlobKind } from '@endfield-noclip/package-format/blobs';
import { ARCHIVE_ID_LENGTH, archiveName } from '@endfield-noclip/package-format/manifest';

import { type ArchivePlan, encodeArchive, encodeArchiveStream, planArchive } from '@mary-ext/czar';

import { ignoreMissing } from '../errors.ts';
import { mapPool } from '../pool.ts';
import { zstd } from '../zstd.ts';

import { type BlobDir, type BlobMeta, storedBlob } from './blob-file.ts';

/** archives written at once; a single stream doesn't saturate an SSD */
const ARCHIVE_WRITES = 8;

/** what a blob is and where it goes */
export interface BlobPlacement {
	kind: BlobKind;
	/**
	 * the archive group to place the blob in (see `archiveName`), or the core archive's name. a blob that's
	 * already stored keeps its first group
	 */
	stem: string;
}

/** how to store one blob */
export interface PutOptions extends BlobPlacement {
	/** offer a zstd frame; {@link storedBlob} keeps it only when it pays */
	compress: boolean;
	/** zstd level for this blob, instead of the store's */
	zstdLevel?: number;
}

/** a blob whose bytes are in the store's directory, but which has no index yet; see {@link BlobStore.commit} */
export interface PreparedBlob {
	meta: BlobMeta;
	options: BlobPlacement;
}

/** a blob as the store tracks it */
interface StoredBlob extends BlobMeta {
	kind: BlobKind;
	stem: string;
}

/** a non-blob member of the core archive (manifest, tables) */
export interface ArchiveMember {
	path: string;
	data: Uint8Array;
}

/** a written archive */
export interface WrittenArchive {
	name: string;
	/** the group it belongs to */
	stem: string;
	/** total byte length */
	size: number;
	/** byte position of the data section; blob offsets are relative to it */
	dataOffset: number;
	/** byte length of the JSON header */
	headerLength: number;
	members: number;
	/** whether it was cloned from the previous package rather than written */
	reused: boolean;
}

/** a blob as a czar file source */
interface BlobSource {
	path: string;
	size: number;
	crc32: number;
	index: number;
}

/** one planned archive */
interface PlannedArchive {
	name: string;
	stem: string;
	plan: ArchivePlan<BlobSource>;
	members: number;
}

/** the archives every blob lands in, and where */
interface Layout {
	/** by name; the core is keyed by its own name */
	archives: Map<string, PlannedArchive>;
	/** per blob index: its archive's name and its offset from the archive's data section */
	placement: { archive: string; offset: number }[];
}

/**
 * content-addressed blob store. blobs are compressed and written to a {@link BlobDir} as they arrive,
 * deduplicated by the SHA-256 of their stored bytes, and laid out into czar archives at the end. a blob's
 * index is fixed by its commit, so tables can reference blobs before any archive exists.
 *
 * archives are named by their content (`archiveName`): a group whose blobs total more than the cap is split
 * by blob hash into a power-of-two number of parts, so a re-pack that changes a few blobs changes only the
 * archives holding them, and {@link BlobStore.writeArchives} clones every other archive from the previous
 * package instead of writing it again
 */
export class BlobStore {
	readonly dir: BlobDir;
	readonly #level: number;
	readonly #cap: number;
	readonly #core: string;
	readonly #blobs: StoredBlob[] = [];
	readonly #byHash = new Map<string, number>();
	/** dropped whenever a blob is added */
	#layoutCache: Layout | undefined;

	/**
	 * @param dir where blob bytes go; its owner removes it when it's scratch space
	 * @param options zstd level for compressed blobs, the byte size past which a group splits into parts, and
	 *   the core archive's name (the one stem that isn't content-named)
	 */
	constructor(dir: BlobDir, options: { zstdLevel: number; archiveCap: number; core: string }) {
		this.dir = dir;
		this.#level = options.zstdLevel;
		this.#cap = options.archiveCap;
		this.#core = options.core;
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
		return { meta, options: { kind: options.kind, stem: options.stem } };
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
		this.#blobs.push({ ...meta, kind: options.kind, stem: options.stem });
		this.#byHash.set(meta.hash, index);
		this.#layoutCache = undefined;
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

	/** @returns the archives other than the core, sorted by name, with the stem each belongs to */
	archives(): { name: string; stem: string }[] {
		return [...this.#layout().archives.values()]
			.filter(({ name }) => name !== this.#core)
			.map(({ name, stem }) => ({ name, stem }))
			.toSorted((a, b) => (a.name < b.name ? -1 : 1));
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
		const { placement } = this.#layout();
		const archiveIndex = new Map(archives.map((name, index) => [name, index]));
		return this.#blobs.map((blob, index) => {
			const { archive: name, offset } = placement[index];
			const archive = archiveIndex.get(name);
			if (archive === undefined) {
				throw new Error(`blob ${blob.hash} is in archive ${name}, which isn't listed`);
			}
			return {
				hash: blob.hash,
				archive,
				codec: blob.codec,
				kind: blob.kind,
				offset,
				length: blob.length,
				rawLength: blob.rawLength,
			};
		});
	}

	/**
	 * puts every archive except the core in place: cloned from the previous package when it holds one of the
	 * same name and size (names are content ids, so its bytes are equal), else streamed from the store's
	 * directory
	 *
	 * @param outDir package root to write
	 * @param previous root of the package being replaced, or `null`
	 * @returns the archives by name
	 */
	async writeArchives(outDir: string, previous: string | null): Promise<Map<string, WrittenArchive>> {
		const archives = [...this.#layout().archives.values()].filter(({ name }) => name !== this.#core);
		const written = await mapPool(archives, ARCHIVE_WRITES, async ({ name, stem, plan, members }) => {
			const target = join(outDir, name);
			await mkdir(dirname(target), { recursive: true });
			const describe = (reused: boolean): WrittenArchive => ({
				...archiveSizes(name, plan, members),
				stem,
				reused,
			});
			if (previous !== null) {
				const source = join(previous, name);
				const existing = await ignoreMissing(stat(source), undefined);
				if (existing?.size === plan.size) {
					// a copy-on-write clone where the file system has them (APFS, Btrfs), a plain copy elsewhere
					await copyFile(source, target, constants.COPYFILE_FICLONE);
					return describe(true);
				}
			}
			const stream = encodeArchiveStream(plan, (source) => createReadStream(this.#blobPath(source.index)));
			await pipeline(Readable.fromWeb(stream), createWriteStream(target));
			return describe(false);
		});
		return new Map(written.map((archive) => [archive.name, archive]));
	}

	/**
	 * writes the core archive: its blobs plus the fixed members, in memory
	 *
	 * @param outDir package root
	 * @param members fixed members; their paths must sort after `blobs/`
	 * @returns the written archive
	 * @throws {Error} if a member would sort before the blobs
	 */
	async writeCore(outDir: string, members: readonly ArchiveMember[]): Promise<WrittenArchive> {
		for (const member of members) {
			if (member.path < 'blobs/') {
				throw new Error(`core member ${member.path} would sort before the blobs and shift their offsets`);
			}
		}
		const indices = this.#blobs.flatMap((blob, index) => (blob.stem === this.#core ? [index] : []));
		const blobs = await Promise.all(
			indices.map(async (index) => {
				const blob = this.#blobs[index];
				return { path: blobPath(blob.hash, blob.kind), data: await readFile(this.#blobPath(index)) };
			}),
		);
		const files = [...blobs, ...members];
		const archive = encodeArchive(files);
		await writeFile(join(outDir, this.#core), archive);
		// the plan is the layout encodeArchive wrote; only its lengths are needed
		const plan = planArchive(
			files.map(({ path, data }) => ({ path, size: data.length, crc32: crc32(data) })),
		);
		return { ...archiveSizes(this.#core, plan, files.length), stem: this.#core, reused: false };
	}

	#layout(): Layout {
		if (this.#layoutCache !== undefined) {
			return this.#layoutCache;
		}
		const stems = new Map<string, number[]>();
		for (const [index, blob] of this.#blobs.entries()) {
			const list = stems.get(blob.stem) ?? [];
			list.push(index);
			stems.set(blob.stem, list);
		}
		const archives = new Map<string, PlannedArchive>();
		const placement: Layout['placement'] = [];
		for (const [stem, indices] of stems) {
			const parts = stem === this.#core ? new Map([[null, indices]]) : this.#split(indices);
			for (const [part, members] of parts) {
				const plan = this.#plan(members);
				const name =
					stem === this.#core
						? stem
						: archiveName(
								stem,
								part,
								createHash('sha256').update(plan.head).digest('hex').slice(0, ARCHIVE_ID_LENGTH),
							);
				archives.set(name, { name, stem, plan, members: members.length });
				for (const index of members) {
					// empty blobs have no segment; their offset is never read
					placement[index] = { archive: name, offset: 0 };
				}
				for (const segment of plan.segments) {
					placement[segment.source.index].offset = segment.position - plan.head.length;
				}
			}
		}
		this.#layoutCache = { archives, placement };
		return this.#layoutCache;
	}

	/**
	 * @param indices one group's blobs
	 * @returns its parts: the whole group under `null` when it fits the cap, else buckets by the top bits of
	 *   each blob's hash, a power of two of them so a group's split only changes when its size doubles
	 */
	#split(indices: readonly number[]): Map<number | null, readonly number[]> {
		const total = indices.reduce((sum, index) => sum + this.#blobs[index].length, 0);
		if (total <= this.#cap) {
			return new Map([[null, indices]]);
		}
		const bits = Math.ceil(Math.log2(total / this.#cap));
		const parts = new Map<number, number[]>();
		for (const index of indices) {
			const part = Number.parseInt(this.#blobs[index].hash.slice(0, 8), 16) >>> (32 - bits);
			const list = parts.get(part) ?? [];
			list.push(index);
			parts.set(part, list);
		}
		return new Map([...parts].toSorted((a, b) => a[0] - b[0]));
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

const archiveSizes = <T>(
	name: string,
	plan: ArchivePlan<T>,
	members: number,
): Omit<WrittenArchive, 'stem' | 'reused'> => {
	return { name, size: plan.size, dataOffset: plan.head.length, headerLength: plan.headerLength, members };
};
