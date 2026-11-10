import { createHash } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { copyFile, link, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';

import type { BlobRecord } from '@endfield-noclip/package-format/blob-table';
import { blobPath, type BlobKind } from '@endfield-noclip/package-format/blobs';
import { ARCHIVE_ID_LENGTH, archiveName } from '@endfield-noclip/package-format/manifest';
import type { TileKey } from '@endfield-noclip/package-format/tiles';

import { mapDefined } from '@mary-ext/array-fns';
import { type ArchivePlan, encodeArchive, encodeArchiveStream, planArchive } from '@mary-ext/czar';

import { ignoreMissing } from '../../errors.ts';
import { mapPool } from '../../pool.ts';
import { zstd } from '../../zstd.ts';

import { type BlobDir, type BlobMeta, storedBlob } from './blob-file.ts';
import type { PackCache } from './pack-cache.ts';

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
	/**
	 * the blob's locality key (`blobPath`): blobs read together share its part before the first `.` and sort by
	 * the rest, and a group split into parts keeps each such set in one part. derived from content (tile keys,
	 * hashes), never from ids, so paths only change with what they hold. `null` for a blob read alone
	 */
	locality: string | null;
}

/**
 * @param tile a tile
 * @returns the locality key of the blobs a tile node reads together: its level, then a Morton code of its x,
 *   z, so a node's blobs are adjacent and nearby nodes' close
 */
export const tileLocality = (tile: TileKey): string => {
	let code = 0;
	const x = (tile.x + 0x80_00) & 0xff_ff;
	const z = (tile.z + 0x80_00) & 0xff_ff;
	for (let bit = 0; bit < 16; bit++) {
		code |= (((x >>> bit) & 1) << (bit * 2)) | (((z >>> bit) & 1) << (bit * 2 + 1));
	}
	return `${tile.level.toString(16).padStart(2, '0')}${(code >>> 0).toString(16).padStart(8, '0')}`;
};

/** how to store one blob */
export interface PutOptions extends BlobPlacement {
	/** offer a zstd frame; {@link storedBlob} keeps it only when it pays */
	compress: boolean;
	/** zstd level for this blob, instead of the store's */
	zstdLevel?: number;
	/**
	 * set for the blobs of a step the pack cache remembers whole (terrain, irradiance): a later pack takes them
	 * from the step's memo, so their stored forms aren't also remembered one by one, which would cost a hash
	 * and two file operations per blob for memos the next pack sweeps
	 */
	stepMemo?: boolean;
}

/** remembers compressed blobs' stored forms by their raw bytes (`PackCache`) */
export type StoredMemo = Pick<PackCache, 'storedKey' | 'recallStored' | 'rememberStored'>;

/** a blob whose bytes are in the store's directory, but which has no index yet; see {@link BlobStore.commit} */
export interface PreparedBlob {
	meta: BlobMeta;
	options: BlobPlacement;
}

/** a blob as the store tracks it */
interface StoredBlob extends BlobMeta, BlobPlacement {}

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
	/** whether it was reused from the previous package rather than written */
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
 * archives are named by their content (`archiveName`) and a group over the cap is split into parts by hash,
 * so a re-pack that changes a few blobs changes only the archives holding them, and
 * {@link BlobStore.writeArchives} links every other archive from the previous package instead of writing it
 * again
 */
export class BlobStore {
	readonly dir: BlobDir;
	readonly #level: number;
	readonly #cap: number;
	readonly #core: string;
	readonly #memo: StoredMemo | null;
	readonly #blobs: StoredBlob[] = [];
	readonly #byHash = new Map<string, number>();
	/** dropped whenever a blob is added */
	#layoutCache: Layout | undefined;

	/**
	 * @param dir where blob bytes go; its owner removes it when it's scratch space
	 * @param options zstd level for compressed blobs, the byte size past which a group splits into parts, the
	 *   core archive's name (the one stem that isn't content-named), and where compressed blobs' stored forms
	 *   are remembered, keyed by their raw bytes, or `null` to compress every one (the memo's blobs must live
	 *   in `dir`)
	 */
	constructor(
		dir: BlobDir,
		options: { zstdLevel: number; archiveCap: number; core: string; memo: StoredMemo | null },
	) {
		this.dir = dir;
		this.#level = options.zstdLevel;
		this.#cap = options.archiveCap;
		this.#core = options.core;
		this.#memo = options.memo;
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
		const placement = { kind: options.kind, stem: options.stem, locality: options.locality };
		if (!options.compress) {
			const { meta, stored } = storedBlob(raw, null);
			await this.dir.write(meta.hash, stored);
			return { meta, options: placement };
		}
		// compression dominates a warm pack's instance blocks, which mostly come out as they did last time
		const level = options.zstdLevel ?? this.#level;
		const key = options.stepMemo === true ? undefined : this.#memo?.storedKey(raw, level);
		const remembered = key === undefined ? undefined : await this.#memo?.recallStored(key);
		if (remembered !== undefined) {
			return { meta: remembered, options: placement };
		}
		const { meta, stored } = storedBlob(raw, await zstd(raw, level));
		await this.dir.write(meta.hash, stored);
		if (key !== undefined) {
			await this.#memo?.rememberStored(key, meta);
		}
		return { meta, options: placement };
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
		this.#blobs.push({ ...meta, kind: options.kind, stem: options.stem, locality: options.locality });
		this.#byHash.set(meta.hash, index);
		this.#layoutCache = undefined;
		return index;
	}

	/** @returns blob counts and stored/raw byte totals by kind */
	totals(): Map<BlobKind, { count: number; stored: number; raw: number }> {
		const totals = new Map<BlobKind, { count: number; stored: number; raw: number }>();
		for (const blob of this.#blobs) {
			const total = totals.getOrInsertComputed(blob.kind, () => ({ count: 0, stored: 0, raw: 0 }));
			total.count++;
			total.stored += blob.length;
			total.raw += blob.rawLength;
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
		const archives = mapDefined([...this.#layout().archives.values()], ({ name, stem }) =>
			name !== this.#core ? { name, stem } : undefined,
		);
		archives.sort((a, b) => (a.name < b.name ? -1 : 1));
		return archives;
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
				throw new Error(`blob ${index} is in archive ${name}, which isn't listed`);
			}
			return {
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
	 * puts every archive except the core in place: linked from the previous package when it holds one of the
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
					await reuseFile(source, target);
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
		const indices = mapDefined(this.#blobs, (blob, index) => (blob.stem === this.#core ? index : undefined));
		const blobs = await Promise.all(
			indices.map(async (index) => {
				const blob = this.#blobs[index];
				return {
					path: blobPath(blob.hash, blob.kind, blob.locality),
					data: await readFile(this.#blobPath(index)),
				};
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
			stems.getOrInsertComputed(blob.stem, () => []).push(index);
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
	 * @returns its parts: the whole group under `null` when it fits the cap, else buckets by the top bits of a
	 *   hash of each blob's locality set (its own hash without one), a power of two of them so a group's split
	 *   only changes when its size doubles, and blobs read together stay in one part
	 */
	#split(indices: readonly number[]): Map<number | null, readonly number[]> {
		const total = indices.reduce((sum, index) => sum + this.#blobs[index].length, 0);
		if (total <= this.#cap) {
			return new Map([[null, indices]]);
		}
		const bits = Math.ceil(Math.log2(total / this.#cap));
		const parts = new Map<number, number[]>();
		for (const index of indices) {
			const { hash, locality } = this.#blobs[index];
			const spread =
				locality === null ? hash : createHash('sha256').update(locality.split('.', 1)[0]).digest('hex');
			const part = Number.parseInt(spread.slice(0, 8), 16) >>> (32 - bits);
			parts.getOrInsertComputed(part, () => []).push(index);
		}
		// oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy
		return new Map([...parts].sort((a, b) => a[0] - b[0]));
	}

	#plan(indices: readonly number[]): ArchivePlan<BlobSource> {
		return planArchive(
			indices.map((index) => {
				const blob = this.#blobs[index];
				return {
					path: blobPath(blob.hash, blob.kind, blob.locality),
					size: blob.length,
					crc32: blob.crc32,
					index,
				};
			}),
		);
	}

	#blobPath(index: number): string {
		return this.dir.path(this.#blobs[index].hash);
	}
}

/**
 * puts an archive the previous package already has into the new one. archives are never written after they're
 * made, so a hard link shares the bytes without copying them on any file system; where linking fails (another
 * device), a copy-on-write clone where the file system has them, else a plain copy
 *
 * @param source the previous package's archive
 * @param target where the new package's goes
 */
const reuseFile = async (source: string, target: string): Promise<void> => {
	try {
		await link(source, target);
	} catch {
		await copyFile(source, target, constants.COPYFILE_FICLONE);
	}
};

const archiveSizes = <T>(
	name: string,
	plan: ArchivePlan<T>,
	members: number,
): Omit<WrittenArchive, 'stem' | 'reused'> => {
	return { name, size: plan.size, dataOffset: plan.head.length, headerLength: plan.headerLength, members };
};
