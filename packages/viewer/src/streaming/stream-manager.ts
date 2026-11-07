import { CORE_ARCHIVE_INDEX } from '@endfield-noclip/package-format/manifest';

import type { DecodePool } from '../package/decode-pool.ts';
import type { Decoded } from '../package/decode-protocol.ts';
import { PackageChangedError } from '../package/package-source.ts';
import type { ViewerPackage } from '../package/viewer-package.ts';

import { type QueuedRange, coalesceRanges } from './coalesce.ts';
import { type ContentItem, MAX_READ_FAILURES } from './content-item.ts';
import {
	RESIDENT_KINDS,
	type ResidencyHandlers,
	decodeJob,
	releaseResident,
	uploadResident,
} from './residency.ts';
import type { Resident } from './resident.ts';

// #region types

/** counters for the UI */
export interface StreamStats {
	queued: number;
	requestsInFlight: number;
	decoding: number;
	uploading: number;
	residentBytes: number;
	pinnedBytes: number;
	downloadedBytes: number;
	requests: number;
	evictions: number;
	failed: number;
	/** a shard no longer matches the manifest (re-packed since opening); fetching has stopped */
	packageChanged: boolean;
}

/** tunables */
export interface StreamOptions {
	/** GPU byte budget for streamed content (pinned content counts towards it but is never evicted) */
	budgetBytes: number;
	/** shard range reads in flight at most */
	maxRequests: number;
	/** bytes uploaded per frame at most */
	uploadBytesPerFrame: number;
}

// #endregion

/**
 * fetched blobs, and blobs in range reads, kept waiting for a decode slot at most; past it no new reads
 * start. fetching runs ahead of decoding, and blobs waiting in a long line would be decoded long after the
 * camera moved on, while the ones it wants now wait behind them
 */
const MAX_UNDECODED = 384;
/** fetched or decoded blobs nobody has wanted for this many frames are dropped instead of decoded or uploaded */
const STALE_FRAMES = 30;

/** a shard blob's byte range, with what reading its archive needs */
interface ShardRange extends QueuedRange {
	path: string;
	/** the archive's size, which a read checks to notice a re-packed package */
	archiveSize: number;
}

/** owns every {@link ContentItem} and drives fetch → decode → upload → evict */
export class StreamManager {
	readonly options: StreamOptions;
	readonly stats: StreamStats = {
		queued: 0,
		requestsInFlight: 0,
		decoding: 0,
		uploading: 0,
		residentBytes: 0,
		pinnedBytes: 0,
		downloadedBytes: 0,
		requests: 0,
		evictions: 0,
		failed: 0,
		packageChanged: false,
	};
	/** bumped whenever content becomes resident or is evicted, so the frame loop knows to redraw */
	version = 0;

	#package: ViewerPackage;
	#pool: DecodePool;
	#handlers: ResidencyHandlers;
	/** by blob index */
	#items: (ContentItem | undefined)[];
	/** by blob index: the order its item was made in, which breaks eviction ties */
	#created: Int32Array;
	#createdCount = 0;
	/** by blob index: a queued shard blob's byte range, made when it's first queued */
	#ranges: (ShardRange | undefined)[];
	/** the ready, unpinned items: what eviction picks from */
	#evictable = new Set<ContentItem>();
	/** queued shard blobs */
	#queued = new Set<ContentItem>();
	/** queued core blobs, read from memory without a request slot */
	#queuedCore = new Set<ContentItem>();
	/** fetched blobs' stored bytes, waiting for a decode slot; the most wanted is decoded first */
	#fetched = new Map<ContentItem, ArrayBuffer>();
	/** blobs in range reads under way */
	#fetching = 0;
	#uploads: ContentItem[] = [];
	/** the uploads a frame deferred, reused */
	#deferred: ContentItem[] = [];
	#inFlight = new Set<{ items: ContentItem[]; abort: AbortController }>();
	/** cancels the decodes still queued in the pool when the stream is destroyed */
	#decodes = new AbortController();
	/** core reads and decodes under way */
	#working = 0;
	#frame = 0;
	/**
	 * the budget is full of content still in use: unpinned fetches and uploads pause until something falls out
	 * of use, instead of evicting fresh uploads and fetching them again every frame
	 */
	#saturated = false;
	#destroyed = false;

	/**
	 * @param pkg the package
	 * @param pool decode workers
	 * @param handlers how each kind of blob is decoded, made resident and freed
	 * @param options tunables; read every frame, so callers may change them
	 */
	constructor(pkg: ViewerPackage, pool: DecodePool, handlers: ResidencyHandlers, options: StreamOptions) {
		this.#package = pkg;
		this.#pool = pool;
		this.#handlers = handlers;
		this.options = options;
		this.#items = Array.from({ length: pkg.blobs.length });
		this.#created = new Int32Array(pkg.blobs.length);
		this.#ranges = Array.from({ length: pkg.blobs.length });
	}

	// #region per-frame API

	/**
	 * whether nothing is queued, loading or waiting to upload, so another frame with the same view and the same
	 * {@link version} would change nothing
	 */
	get idle(): boolean {
		return (
			this.#queued.size === 0 &&
			this.#queuedCore.size === 0 &&
			this.#inFlight.size === 0 &&
			this.#fetched.size === 0 &&
			this.#working === 0 &&
			this.#uploads.length === 0
		);
	}

	/** @param frame the new frame number, larger than the last; call before the traversal */
	beginFrame(frame: number): void {
		this.#frame = frame;
	}

	/**
	 * marks a blob as wanted this frame, queueing it if it isn't loaded. resident content that's wanted counts
	 * as used, so it stays resident even when a coarser stand-in is drawn this frame (a refinement still
	 * loading); evicting it would only refetch it, and the view would flicker between representations.
	 *
	 * @param blob blob index
	 * @param priority larger loads sooner (screen-space error, boosted near the focus)
	 * @returns the item if it's resident, else `null`
	 */
	want(blob: number, priority: number): ContentItem | null {
		const item = this.#item(blob);
		if (item.wantedFrame !== this.#frame) {
			item.wantedFrame = this.#frame;
			item.priority = priority;
		} else if (priority > item.priority) {
			item.priority = priority;
		}
		switch (item.state) {
			case 'idle': {
				this.#enqueue(item);
				return null;
			}
			case 'ready': {
				item.usedFrame = this.#frame;
				return item;
			}
			default: {
				return null;
			}
		}
	}

	/**
	 * marks a resident blob used this frame without wanting it.
	 *
	 * @param blob blob index
	 * @returns whether the blob is resident
	 */
	markUsed(blob: number): boolean {
		const item = this.#items[blob];
		if (item?.state !== 'ready') {
			return false;
		}
		item.usedFrame = this.#frame;
		return true;
	}

	/**
	 * @param blob blob index
	 * @returns whether the blob is resident (without marking it used)
	 */
	isReady(blob: number): boolean {
		return this.#items[blob]?.state === 'ready';
	}

	/**
	 * pins blobs (the coarse layer) and queues them at top priority.
	 *
	 * @param blobs blob indices
	 */
	pin(blobs: Iterable<number>): void {
		for (const blob of blobs) {
			const item = this.#item(blob);
			item.pinned = true;
			this.#evictable.delete(item);
			item.priority = Infinity;
			item.wantedFrame = Infinity;
			if (item.state === 'idle') {
				this.#enqueue(item);
			}
		}
	}

	/**
	 * after the traversal: drops stale requests, starts new ones, uploads decoded content within the frame's
	 * budget, and evicts down to the memory budget.
	 */
	update(): void {
		this.#cancelStale();
		this.#dispatch();
		this.#startDecodes();
		this.#upload();
		this.#evict(this.options.budgetBytes);
		const stats = this.stats;
		stats.queued = this.#queued.size + this.#queuedCore.size;
		stats.requestsInFlight = this.#inFlight.size;
		stats.uploading = this.#uploads.length;
	}

	/**
	 * drops a resident blob that turned out to be unusable (a texture piece whose coarser piece was evicted),
	 * so it's fetched again when wanted
	 *
	 * @param blob blob index
	 */
	discard(blob: number): void {
		const item = this.#items[blob];
		if (item?.state === 'ready') {
			this.#release(item);
		}
	}

	/**
	 * sums every resident blob, for inspection; walks every item, so don't call it per frame
	 *
	 * @returns {@link StreamStats.residentBytes} split by residency kind
	 */
	residentByKind(): Partial<Record<Resident['kind'], number>> {
		const bytes: Partial<Record<Resident['kind'], number>> = {};
		for (const item of this.#items) {
			const resident = item?.resident;
			if (resident != null) {
				bytes[resident.kind] = (bytes[resident.kind] ?? 0) + resident.bytes;
			}
		}
		return bytes;
	}

	/**
	 * @param blob blob index
	 * @returns the item, if it was ever requested
	 */
	get(blob: number): ContentItem | undefined {
		return this.#items[blob];
	}

	/** aborts requests, cancels queued decodes and frees all GPU content */
	destroy(): void {
		this.#destroyed = true;
		for (const request of this.#inFlight) {
			request.abort.abort();
		}
		this.#decodes.abort();
		this.#fetched.clear();
		for (const item of this.#items) {
			if (item !== undefined && item.resident !== null) {
				releaseResident(this.#handlers, item.resident.kind, item.blob, item.resident);
				item.resident = null;
			}
		}
		this.#items = [];
		this.#ranges = [];
		this.#evictable.clear();
	}

	// #endregion

	// #region internals

	#item(blob: number): ContentItem {
		let item = this.#items[blob];
		if (item === undefined) {
			const record = this.#package.blobs[blob];
			item = {
				blob,
				kind: record.kind,
				archive: record.archive,
				state: 'idle',
				pinned: false,
				priority: 0,
				wantedFrame: -1,
				usedFrame: -1,
				readFailures: 0,
				decoded: null,
				resident: null,
			};
			this.#items[blob] = item;
			this.#created[blob] = this.#createdCount++;
		}
		return item;
	}

	#enqueue(item: ContentItem): void {
		if (item.archive === CORE_ARCHIVE_INDEX) {
			item.state = 'queued';
			this.#queuedCore.add(item);
		} else if (!this.stats.packageChanged) {
			// once the shards changed, their blobs stay idle so the stream can settle
			item.state = 'queued';
			this.#queued.add(item);
		}
	}

	/** returns queued items to idle: those not wanted this frame, or every unpinned one */
	#dequeue(queue: Set<ContentItem>, options: { unpinned: boolean }): void {
		for (const item of queue) {
			if (!item.pinned && (options.unpinned || item.wantedFrame < this.#frame)) {
				item.state = 'idle';
				queue.delete(item);
			}
		}
	}

	#cancelStale(): void {
		this.#dequeue(this.#queued, { unpinned: false });
		this.#dequeue(this.#queuedCore, { unpinned: false });
		// abort requests nobody has wanted for a few frames
		for (const request of this.#inFlight) {
			if (request.items.every((item) => !item.pinned && item.wantedFrame < this.#frame - 2)) {
				request.abort.abort();
			}
		}
	}

	#dispatch(): void {
		if (this.stats.packageChanged) {
			// every shard read would hit the wrong bytes; resident content stays drawn
			for (const item of this.#queued) {
				item.state = 'idle';
			}
			this.#queued.clear();
		}
		if (this.#saturated) {
			this.#dequeue(this.#queued, { unpinned: true });
			this.#dequeue(this.#queuedCore, { unpinned: true });
		}
		for (const item of this.#queuedCore) {
			this.#decodeCore(item);
		}
		this.#queuedCore.clear();
		if (
			this.#queued.size === 0 ||
			this.#inFlight.size >= this.options.maxRequests ||
			this.#fetched.size + this.#fetching >= MAX_UNDECODED
		) {
			return;
		}

		const queued = [...this.#queued];
		const ranges = queued.map((item) => {
			const range = this.#shardRange(item.blob);
			range.priority = item.priority;
			return range;
		});
		for (const read of coalesceRanges(ranges, this.options.maxRequests - this.#inFlight.size)) {
			if (this.#fetched.size + this.#fetching >= MAX_UNDECODED) {
				break;
			}
			const members = read.members.map((i) => queued[i]);
			for (const item of members) {
				item.state = 'fetching';
				this.#queued.delete(item);
			}
			this.#fetch(ranges[read.members[0]], read.start, read.end, members);
		}
	}

	/** @returns a shard blob's byte range, made once */
	#shardRange(blob: number): ShardRange {
		let range = this.#ranges[blob];
		if (range === undefined) {
			const { archive, path, start, length, archiveSize } = this.#package.blobRange(blob);
			range = { archive, start, end: start + length, priority: 0, path, archiveSize };
			this.#ranges[blob] = range;
		}
		return range;
	}

	/**
	 * @param shard the range of a blob in the archive to read
	 * @param start the read's byte range, `[start, end)`
	 * @param members the blobs it covers
	 */
	#fetch(shard: ShardRange, start: number, end: number, members: ContentItem[]): void {
		const request = { items: members, abort: new AbortController() };
		this.#inFlight.add(request);
		this.#fetching += members.length;
		this.stats.requests++;
		this.#package.source
			.readRange(
				shard.path,
				{ offset: start, length: end - start, fileSize: shard.archiveSize },
				request.abort.signal,
			)
			.then((bytes) => {
				this.stats.downloadedBytes += bytes.byteLength;
				const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
				for (const item of members) {
					if (item.state !== 'fetching') {
						continue;
					}
					const member = this.#shardRange(item.blob);
					// each member is transferred to a worker on its own, so it needs a buffer of its own
					const data =
						whole && member.start === start && member.end === end
							? bytes.buffer
							: bytes.slice(member.start - start, member.end - start).buffer;
					this.#received(item, data);
				}
				this.#startDecodes();
			})
			.catch((err: unknown) => {
				const aborted = request.abort.signal.aborted;
				const changed = err instanceof PackageChangedError;
				if (changed && !this.stats.packageChanged) {
					this.stats.packageChanged = true;
					console.warn(String(err));
				}
				for (const item of members) {
					if (item.state !== 'fetching') {
						continue;
					}
					if (aborted || changed) {
						item.state = 'idle';
					} else if (++item.readFailures < MAX_READ_FAILURES) {
						// wanted again, it's read again
						item.state = 'idle';
					} else {
						this.#fail(item, err);
					}
				}
			})
			.finally(() => {
				this.#inFlight.delete(request);
				this.#fetching -= members.length;
			});
	}

	#decodeCore(item: ContentItem): void {
		item.state = 'fetching';
		this.#working++;
		this.#package
			.readCoreBlob(item.blob)
			.then((data) => {
				this.#received(item, data);
				this.#startDecodes();
			})
			.catch((err: unknown) => this.#fail(item, err))
			.finally(() => this.#working--);
	}

	/** keeps a fetched blob's stored bytes until a decode slot frees */
	#received(item: ContentItem, data: ArrayBuffer): void {
		if (this.#destroyed) {
			return;
		}
		item.state = 'fetched';
		this.#fetched.set(item, data);
		this.stats.decoding++;
	}

	/**
	 * hands fetched blobs to the free decode slots, most wanted first, dropping the ones nobody wants any more.
	 * the waiting line is short ({@link MAX_UNDECODED}), so a scan per slot is cheaper than keeping it sorted
	 */
	#startDecodes(): void {
		const fetched = this.#fetched;
		while (fetched.size > 0 && this.#pool.free > 0) {
			let best: ContentItem | null = null;
			for (const item of fetched.keys()) {
				// while saturated, unpinned content would only be dropped once decoded
				if (!item.pinned && (item.wantedFrame < this.#frame - STALE_FRAMES || this.#saturated)) {
					fetched.delete(item);
					item.state = 'idle';
					this.stats.decoding--;
				} else if (best === null || item.priority > best.priority) {
					best = item;
				}
			}
			if (best === null) {
				return;
			}
			const data = fetched.get(best);
			fetched.delete(best);
			this.stats.decoding--;
			if (data !== undefined) {
				this.#decode(best, data);
			}
		}
	}

	#decode(item: ContentItem, data: ArrayBuffer): void {
		if (this.#destroyed) {
			return;
		}
		const record = this.#package.blobs[item.blob];
		const kind = RESIDENT_KINDS[record.kind];
		if (kind === null) {
			this.#fail(item, new Error(`blob kind ${record.kind} isn't supported yet`));
			return;
		}
		const stored = { data, codec: record.codec, rawLength: record.rawLength };
		const job = this.#pool.run(decodeJob(this.#handlers, kind, item.blob, stored), this.#decodes.signal);
		item.state = 'decoding';
		this.#working++;
		this.stats.decoding++;
		job
			.then((decoded) => {
				if (item.state !== 'decoding' || this.#destroyed) {
					return;
				}
				item.decoded = decoded;
				item.state = 'uploading';
				this.#uploads.push(item);
			})
			.catch((err: unknown) => {
				// the decodes still queued when the stream was destroyed are cancelled
				if (!this.#destroyed) {
					this.#fail(item, err);
				}
			})
			.finally(() => {
				this.#working--;
				this.stats.decoding--;
				this.#startDecodes();
			});
	}

	#fail(item: ContentItem, err: unknown): void {
		item.state = 'failed';
		item.decoded = null;
		this.stats.failed++;
		console.warn(`blob ${item.blob}:`, err);
	}

	#upload(): void {
		const uploads = this.#uploads;
		if (uploads.length === 0) {
			return;
		}
		uploads.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.priority - a.priority);
		const deferred = this.#deferred;
		let uploaded = 0;
		let next = 0;
		for (; next < uploads.length && uploaded < this.options.uploadBytesPerFrame; next++) {
			const item = uploads[next];
			const decoded = item.decoded;
			if (decoded === null) {
				continue;
			}
			// content nobody wants any more isn't worth the space, nor is anything unpinned while saturated
			if (!item.pinned && (item.wantedFrame < this.#frame - STALE_FRAMES || this.#saturated)) {
				item.decoded = null;
				item.state = 'idle';
				continue;
			}
			let resident = this.#tryUpload(item, decoded);
			if (resident === null && this.#evictForSpace(item)) {
				resident = this.#tryUpload(item, decoded);
			}
			if (resident === null) {
				deferred.push(item);
				continue;
			}
			item.decoded = null;
			item.resident = resident;
			item.state = 'ready';
			// fresh content counts as used, so the budget pass can't evict it before its first draw
			item.usedFrame = this.#frame;
			if (!item.pinned) {
				this.#evictable.add(item);
			}
			this.#count(item, resident.bytes);
			uploaded += resident.bytes;
			this.version++;
		}
		// the ones not reached, then the deferred ones
		uploads.copyWithin(0, next);
		uploads.length -= next;
		for (const item of deferred) {
			uploads.push(item);
		}
		deferred.length = 0;
	}

	#tryUpload(item: ContentItem, decoded: Decoded): Resident | null {
		return uploadResident(this.#handlers, decoded.kind, item.blob, decoded, { pinned: item.pinned });
	}

	/** adds `bytes` to the resident counters */
	#count(item: ContentItem, bytes: number): void {
		this.stats.residentBytes += bytes;
		if (item.pinned) {
			this.stats.pinnedBytes += bytes;
		}
	}

	/** evicts unpinned content of the same kind not used this frame, oldest first, to make room for `item` */
	#evictForSpace(item: ContentItem): boolean {
		const candidates: ContentItem[] = [];
		for (const other of this.#evictable) {
			if (other.kind === item.kind && other.usedFrame < this.#frame && other.priority <= item.priority) {
				candidates.push(other);
			}
		}
		if (candidates.length === 0) {
			return false;
		}
		const created = this.#created;
		// oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh array
		candidates.sort((a, b) => a.usedFrame - b.usedFrame || created[a.blob] - created[b.blob]);
		for (let i = 0; i < Math.min(candidates.length, 16); i++) {
			this.#release(candidates[i]);
		}
		return true;
	}

	#evict(budget: number): void {
		if (this.stats.residentBytes <= budget) {
			this.#saturated = false;
			return;
		}
		const candidates: ContentItem[] = [];
		for (const item of this.#evictable) {
			if (item.usedFrame < this.#frame) {
				candidates.push(item);
			}
		}
		const created = this.#created;
		// oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh array
		candidates.sort(
			(a, b) => a.usedFrame - b.usedFrame || a.priority - b.priority || created[a.blob] - created[b.blob],
		);
		for (const item of candidates) {
			if (this.stats.residentBytes <= budget) {
				break;
			}
			this.#release(item);
		}
		this.#saturated = this.stats.residentBytes > budget;
	}

	#release(item: ContentItem): void {
		const resident = item.resident;
		if (resident === null) {
			return;
		}
		releaseResident(this.#handlers, resident.kind, item.blob, resident);
		this.#count(item, -resident.bytes);
		this.#evictable.delete(item);
		item.resident = null;
		item.state = 'idle';
		this.stats.evictions++;
		this.version++;
	}

	// #endregion
}
