/**
 * blob residency: the traversal says which blobs it wants each frame and how much; this fetches them (one
 * range read per blob, adjacent blobs of an archive coalesced into one request), decodes them on the worker
 * pool, uploads within a per-frame budget, and evicts the least recently used blobs when GPU memory exceeds
 * the budget. pinned blobs (the always-resident coarse layer) are never dropped.
 *
 * @module
 */

import { BlobKind } from '@endfield-noclip/package-format/blobs';

import type { RangeAllocation } from '../gfx/range-allocator.ts';
import type { DecodePool } from '../package/decode-pool.ts';
import type {
	Decoded,
	DecodedGeometry,
	DecodedDetail,
	DecodedHeights,
	DecodedInstances,
	DecodedLayer,
	DecodedIrradiance,
	DecodedSurface,
	DecodedTexture,
	UvTransform,
} from '../package/decode-protocol.ts';
import { PackageChangedError } from '../package/package-source.ts';
import { type BlobRange, CORE_ARCHIVE_INDEX, type ViewerPackage } from '../package/viewer-package.ts';
import type { RowKinds } from '../render/instance-rows.ts';

// #region types

/** lifecycle of a blob */
export type ItemState = 'idle' | 'queued' | 'fetching' | 'decoding' | 'uploading' | 'ready' | 'failed';

/** GPU residency of a height page */
export interface ResidentHeights {
	kind: 'heights';
	/** GPU bytes */
	bytes: number;
	/** height pool slot */
	slot: number;
	/** the samples kept on the CPU for ground-height queries (pinned pages only) */
	samples: Uint16Array | null;
}

/** GPU residency of a terrain surface page */
export interface ResidentSurface {
	kind: 'surface';
	/** GPU bytes */
	bytes: number;
	/** layer of the surface texture arrays */
	slot: number;
}

/** GPU residency of a terrain splat page */
export interface ResidentDetail {
	kind: 'splat';
	/** GPU bytes */
	bytes: number;
	/** layer of the detail texture arrays */
	slot: number;
}

/** GPU residency of a terrain layer texture (the terrain renderer owns the array) */
export interface ResidentLayer {
	kind: 'layer';
	/** GPU bytes */
	bytes: number;
}

/** GPU residency of an instance block */
export interface ResidentInstances {
	kind: 'instances';
	/** GPU bytes */
	bytes: number;
	alloc: RangeAllocation;
	blockSlot: number;
	count: number;
	/** world origin of the rows, f64 */
	origin: [x: number, y: number, z: number];
	/** (chain, first, count) runs */
	runs: Uint32Array;
	/** the rows as uploaded, kept for CPU-side LOD selection */
	rowsF32: Float32Array;
	/** per-row cull data, see {@link InstanceRows.cull} */
	cull: Float32Array;
}

/** GPU residency of a geometry */
export interface ResidentGeometry {
	kind: 'geometry';
	/** GPU bytes */
	bytes: number;
	/** positions, then normals, UV sets 0 and 1, tangents and colours where present, in one buffer */
	vertices: GPUBuffer;
	positionBytes: number;
	normalOffset: number | null;
	uv0Offset: number | null;
	/** UV set 1, or set 0 for meshes without it: the game reads a missing UV set as set 0 */
	uv1Offset: number | null;
	/** the UV streams' vertex format */
	uvFormat: 'unorm16x2' | 'float32x2';
	/** each UV set's dequantization */
	uvTransforms: [uv0: UvTransform, uv1: UvTransform];
	tangentOffset: number | null;
	/** `unorm8x4` vertex colours */
	colorOffset: number | null;
	indices: GPUBuffer;
	indexFormat: GPUIndexFormat;
	positionOffset: [x: number, y: number, z: number];
	positionScale: [x: number, y: number, z: number];
	submeshes: { firstIndex: number; indexCount: number; baseVertex: number }[];
}

/** GPU residency of a texture piece (the texture store owns the texture) */
export interface ResidentTexture {
	kind: 'texture';
	/** GPU bytes */
	bytes: number;
}

/** GPU residency of an irradiance cell in the volume's cell buffer */
export interface ResidentIrradiance {
	kind: 'irradiance';
	/** GPU bytes */
	bytes: number;
	/** u32 words of the cell buffer */
	alloc: RangeAllocation;
}

/** what a ready blob holds on the GPU */
export type Resident =
	| ResidentHeights
	| ResidentSurface
	| ResidentDetail
	| ResidentLayer
	| ResidentInstances
	| ResidentGeometry
	| ResidentTexture
	| ResidentIrradiance;

/** a blob the viewer has asked for at some point */
export interface ContentItem {
	blob: number;
	kind: BlobKind;
	/** index of the archive holding the blob */
	archive: number;
	state: ItemState;
	/** part of the always-resident coarse layer */
	pinned: boolean;
	/** highest priority requested in {@link wantedFrame} */
	priority: number;
	wantedFrame: number;
	/** last frame something drew it */
	usedFrame: number;
	decoded: Decoded | null;
	/** set exactly while the item is `ready` */
	resident: Resident | null;
	error: string | null;
}

/** GPU-side owners of uploaded content (the renderers) */
export interface ContentStores {
	/** @returns the residency, or `null` if there was no room */
	uploadHeights(decoded: DecodedHeights, options: { keepSamples: boolean }): ResidentHeights | null;
	/** @returns the residency, or `null` if there was no room */
	uploadSurface(decoded: DecodedSurface): ResidentSurface | null;
	/** @returns the residency, or `null` if there was no room */
	uploadDetail(decoded: DecodedDetail): ResidentDetail | null;
	/** @returns the residency */
	uploadLayer(blob: number, decoded: DecodedLayer): ResidentLayer;
	/** @returns the residency, or `null` if there was no room */
	uploadInstances(decoded: DecodedInstances): ResidentInstances | null;
	/** @returns the residency */
	uploadGeometry(blob: number, decoded: DecodedGeometry): ResidentGeometry;
	/** @returns the residency */
	uploadTexture(blob: number, decoded: DecodedTexture): ResidentTexture;
	/** @returns the residency, or `null` if there was no room */
	uploadIrradiance(blob: number, decoded: DecodedIrradiance): ResidentIrradiance | null;
	/** frees a blob's GPU resources */
	release(blob: number, resident: Resident): void;
}

/** counters for the UI */
export interface StreamStats {
	queued: number;
	requestsInFlight: number;
	decoding: number;
	uploading: number;
	residentBytes: number;
	/** {@link residentBytes} split by residency kind */
	residentByKind: Record<Resident['kind'], number>;
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
	/** concurrent HTTP requests */
	maxRequests: number;
	/** bytes uploaded per frame at most */
	uploadBytesPerFrame: number;
}

// #endregion

/** coalesce blobs whose ranges are at most this far apart */
const COALESCE_GAP = 64 * 1024;
/** largest coalesced request */
const COALESCE_SPAN = 2 * 1024 * 1024;
const COALESCE_COUNT = 96;

interface QueuedRange {
	item: ContentItem;
	start: number;
	end: number;
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
		residentByKind: {
			heights: 0,
			surface: 0,
			splat: 0,
			layer: 0,
			instances: 0,
			geometry: 0,
			texture: 0,
			irradiance: 0,
		},
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
	#stores: ContentStores;
	#rowKinds: ReadonlyMap<number, RowKinds>;
	/** by blob index */
	#items: (ContentItem | undefined)[];
	/** every item in {@link #items}, for sweeps */
	#known: ContentItem[] = [];
	/** queued shard blobs */
	#queued = new Set<ContentItem>();
	/** queued core blobs, read from memory without a request slot */
	#queuedCore = new Set<ContentItem>();
	#uploads: ContentItem[] = [];
	#inFlight = new Set<{ items: ContentItem[]; abort: AbortController }>();
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
	 * @param stores GPU owners
	 * @param rowKinds what the rows of each instance blob are; blobs without an entry are tier 0 HLOD rows
	 * @param options tunables; read every frame, so callers may change them
	 */
	constructor(
		pkg: ViewerPackage,
		pool: DecodePool,
		stores: ContentStores,
		rowKinds: ReadonlyMap<number, RowKinds>,
		options: StreamOptions,
	) {
		this.#package = pkg;
		this.#pool = pool;
		this.#stores = stores;
		this.#rowKinds = rowKinds;
		this.options = options;
		this.#items = Array.from({ length: pkg.blobs.length });
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
	 * @param blob blob index
	 * @returns the item, if it was ever requested
	 */
	get(blob: number): ContentItem | undefined {
		return this.#items[blob];
	}

	/** aborts requests and frees all GPU content */
	destroy(): void {
		this.#destroyed = true;
		for (const request of this.#inFlight) {
			request.abort.abort();
		}
		for (const item of this.#known) {
			if (item.resident !== null) {
				this.#stores.release(item.blob, item.resident);
				item.resident = null;
			}
		}
		this.#items = [];
		this.#known = [];
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
				decoded: null,
				resident: null,
				error: null,
			};
			this.#items[blob] = item;
			this.#known.push(item);
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
		if (this.#queued.size === 0 || this.#inFlight.size >= this.options.maxRequests) {
			return;
		}

		const queued = [...this.#queued].toSorted((a, b) => b.priority - a.priority);
		// per-archive lists by byte position, for coalescing neighbours
		const byArchive = new Map<number, QueuedRange[]>();
		for (const item of queued) {
			const range = this.#package.blobRange(item.blob);
			let list = byArchive.get(range.archive);
			if (list === undefined) {
				list = [];
				byArchive.set(range.archive, list);
			}
			list.push({ item, start: range.start, end: range.start + range.length });
		}
		const positions = new Map<ContentItem, number>();
		for (const list of byArchive.values()) {
			list.sort((a, b) => a.start - b.start);
			for (let i = 0; i < list.length; i++) {
				positions.set(list[i].item, i);
			}
		}

		for (const seed of queued) {
			if (this.#inFlight.size >= this.options.maxRequests) {
				break;
			}
			const list = byArchive.get(seed.archive);
			const at = positions.get(seed);
			if (seed.state !== 'queued' || list === undefined || at === undefined) {
				continue;
			}
			let lo = at;
			let hi = at;
			let start = list[at].start;
			let end = list[at].end;
			const usable = (i: number): boolean => i >= 0 && i < list.length && list[i].item.state === 'queued';
			while (hi - lo + 1 < COALESCE_COUNT) {
				const right = usable(hi + 1) && list[hi + 1].start - end <= COALESCE_GAP;
				const left = usable(lo - 1) && start - list[lo - 1].end <= COALESCE_GAP;
				if (right && Math.max(end, list[hi + 1].end) - start <= COALESCE_SPAN) {
					hi++;
					end = Math.max(end, list[hi].end);
				} else if (left && end - list[lo - 1].start <= COALESCE_SPAN) {
					lo--;
					start = list[lo].start;
				} else {
					break;
				}
			}
			const members = list.slice(lo, hi + 1).filter((entry) => entry.item.state === 'queued');
			for (const { item } of members) {
				item.state = 'fetching';
				this.#queued.delete(item);
			}
			this.#fetch(this.#package.blobRange(seed.blob), start, end, members);
		}
	}

	#fetch(range: BlobRange, start: number, end: number, members: QueuedRange[]): void {
		const request = { items: members.map((member) => member.item), abort: new AbortController() };
		this.#inFlight.add(request);
		this.stats.requests++;
		this.#package.source
			.readRange(
				range.path,
				{ offset: start, length: end - start, fileSize: range.archiveSize },
				request.abort.signal,
			)
			.then((bytes) => {
				this.stats.downloadedBytes += bytes.byteLength;
				const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
				for (const member of members) {
					if (member.item.state !== 'fetching') {
						continue;
					}
					// each member is transferred to a worker on its own, so it needs a buffer of its own
					const data =
						whole && member.start === start && member.end === end
							? bytes.buffer
							: bytes.slice(member.start - start, member.end - start).buffer;
					this.#decode(member.item, data);
				}
			})
			.catch((err: unknown) => {
				const aborted = request.abort.signal.aborted;
				const changed = err instanceof PackageChangedError;
				if (changed && !this.stats.packageChanged) {
					this.stats.packageChanged = true;
					console.warn(String(err));
				}
				for (const { item } of members) {
					if (item.state !== 'fetching') {
						continue;
					}
					if (aborted || changed) {
						item.state = 'idle';
					} else {
						this.#fail(item, err);
					}
				}
			})
			.finally(() => {
				this.#inFlight.delete(request);
			});
	}

	#decodeCore(item: ContentItem): void {
		item.state = 'fetching';
		this.#working++;
		this.#package
			.readCoreBlob(item.blob)
			.then((data) => this.#decode(item, data))
			.catch((err: unknown) => this.#fail(item, err))
			.finally(() => this.#working--);
	}

	#decode(item: ContentItem, data: ArrayBuffer): void {
		if (this.#destroyed) {
			return;
		}
		const record = this.#package.blobs[item.blob];
		const base = { data, codec: record.codec, rawLength: record.rawLength };
		let job: Promise<Decoded>;
		switch (record.kind) {
			case BlobKind.TerrainHeights: {
				job = this.#pool.run({ kind: 'heights', ...base });
				break;
			}
			case BlobKind.TerrainSurface: {
				job = this.#pool.run({ kind: 'surface', ...base });
				break;
			}
			case BlobKind.TerrainSplat: {
				job = this.#pool.run({ kind: 'splat', ...base });
				break;
			}
			case BlobKind.TerrainLayer: {
				job = this.#pool.run({ kind: 'layer', ...base });
				break;
			}
			case BlobKind.Instances: {
				job = this.#pool.run({ kind: 'instances', ...base, rowKinds: this.#rowKinds.get(item.blob) ?? [] });
				break;
			}
			case BlobKind.Geometry: {
				job = this.#pool.run({ kind: 'geometry', ...base });
				break;
			}
			case BlobKind.Texture: {
				job = this.#pool.run({ kind: 'texture', ...base });
				break;
			}
			case BlobKind.Irradiance: {
				job = this.#pool.run({ kind: 'irradiance', ...base });
				break;
			}
			default: {
				this.#fail(item, new Error(`blob kind ${record.kind} isn't supported yet`));
				return;
			}
		}
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
			.catch((err: unknown) => this.#fail(item, err))
			.finally(() => {
				this.#working--;
				this.stats.decoding--;
			});
	}

	#fail(item: ContentItem, err: unknown): void {
		item.state = 'failed';
		item.error = String(err);
		item.decoded = null;
		this.stats.failed++;
		console.warn(`blob ${item.blob}:`, err);
	}

	#upload(): void {
		const uploads = this.#uploads;
		if (uploads.length === 0) {
			return;
		}
		// pinned first, then by priority
		uploads.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.priority - a.priority);
		const deferred: ContentItem[] = [];
		let uploaded = 0;
		let next = 0;
		for (; next < uploads.length && uploaded < this.options.uploadBytesPerFrame; next++) {
			const item = uploads[next];
			const decoded = item.decoded;
			if (decoded === null) {
				continue;
			}
			// content nobody wants any more isn't worth the space, nor is anything unpinned while saturated
			if (!item.pinned && (item.wantedFrame < this.#frame - 30 || this.#saturated)) {
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
			this.#count(item, resident, resident.bytes);
			uploaded += resident.bytes;
			this.version++;
		}
		this.#uploads = [...uploads.slice(next), ...deferred];
	}

	#tryUpload(item: ContentItem, decoded: Decoded): Resident | null {
		switch (decoded.kind) {
			case 'heights': {
				return this.#stores.uploadHeights(decoded, { keepSamples: item.pinned });
			}
			case 'surface': {
				return this.#stores.uploadSurface(decoded);
			}
			case 'splat': {
				return this.#stores.uploadDetail(decoded);
			}
			case 'layer': {
				return this.#stores.uploadLayer(item.blob, decoded);
			}
			case 'instances': {
				return this.#stores.uploadInstances(decoded);
			}
			case 'geometry': {
				return this.#stores.uploadGeometry(item.blob, decoded);
			}
			case 'texture': {
				return this.#stores.uploadTexture(item.blob, decoded);
			}
			case 'irradiance': {
				return this.#stores.uploadIrradiance(item.blob, decoded);
			}
		}
	}

	/** adds `bytes` to the resident counters */
	#count(item: ContentItem, resident: Resident, bytes: number): void {
		this.stats.residentBytes += bytes;
		this.stats.residentByKind[resident.kind] += bytes;
		if (item.pinned) {
			this.stats.pinnedBytes += bytes;
		}
	}

	/** evicts unpinned content of the same kind not used this frame, oldest first, to make room for `item` */
	#evictForSpace(item: ContentItem): boolean {
		const candidates = this.#known
			.filter((other) => other.state === 'ready' && !other.pinned && other.kind === item.kind)
			.filter((other) => other.usedFrame < this.#frame && other.priority <= item.priority)
			.toSorted((a, b) => a.usedFrame - b.usedFrame)
			.slice(0, 16);
		for (const other of candidates) {
			this.#release(other);
		}
		return candidates.length > 0;
	}

	#evict(budget: number): void {
		if (this.stats.residentBytes <= budget) {
			this.#saturated = false;
			return;
		}
		const candidates = this.#known
			.filter((item) => item.state === 'ready' && !item.pinned && item.usedFrame < this.#frame)
			.toSorted((a, b) => a.usedFrame - b.usedFrame || a.priority - b.priority);
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
		this.#stores.release(item.blob, resident);
		this.#count(item, resident, -resident.bytes);
		item.resident = null;
		item.state = 'idle';
		this.stats.evictions++;
		this.version++;
	}

	// #endregion
}
