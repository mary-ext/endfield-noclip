import {
	type ReflectionProbeEntry,
	ReflectionProbeShape,
} from '@endfield-noclip/package-format/reflection-probes';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import type { Camera, Plane } from '../../scene/camera.ts';
import { type TextureStream, streamWholeTexture } from '../../streaming/texture-requests.ts';
import type { TextureStore } from '../textures/texture-store.ts';

/** local probes the shading evaluates per frame, matching the game's `_ReflectionProbeGlobalDatas[32]` */
/**
 * maximum number of active local reflection probes evaluated per frame (matches `MAX_REFLECTION_PROBES` in
 * WGSL)
 */
export const MAX_REFLECTION_PROBES = 32;
/** cubemap face edge, texels (every shipped local reflection probe is 128² BC6H with 8 mips) */
const PROBE_SIZE = 128;
const PROBE_MIPS = 8;
const PROBE_FORMAT: GPUTextureFormat = 'bc6h-rgb-ufloat';
/** vec4s per probe in the GPU storage buffer */
const PROBE_VEC4S = 7;
/** screen tile edge for reflection probe binning, render px */
export const PROBE_TILE_SIZE = 64;
/** tiles across and down supported at most (8192 × 4096) */
const MAX_PROBE_TILES_X = 128;
const MAX_PROBE_TILES_Y = 64;
const MAX_PROBE_TILES = MAX_PROBE_TILES_X * MAX_PROBE_TILES_Y;
/** vec4 offset where the packed u32 screen-tile probe masks start in `reflectionProbes` */
export const PROBE_BINS_OFFSET = MAX_REFLECTION_PROBES * PROBE_VEC4S;
/** streaming priority: right behind sky textures, ahead of scenery */
const PROBE_PRIORITY = 5e5;

/** what the frame uniforms carry for local reflection probes */
export interface ReflectionProbeFrame {
	/** active resident probes in the storage buffer (0..32) */
	count: number;
	/** last mip level of the probe cube array (`mipCount − 1`) */
	maxMip: number;
	/** screen tiles across for probe binning (0 when binning is unused) */
	tilesX: number;
	/** screen tiles down for probe binning */
	tilesY: number;
}

interface CacheSlot {
	slot: number;
	textureId: number;
	version: number;
	lastUsed: number;
}

/**
 * streams visible local reflection probes, caches their BC6H cubemaps in a 32-slot `cube-array` texture, and
 * packs their volume/normalisation records for `frame-core.ts` and `water-shader.ts`
 */
export class ReflectionProbes {
	/** storage buffer holding up to 32 packed probe records (7 vec4s each) */
	readonly buffer: GPUBuffer;
	/** `cube-array` texture view of cached probe cubemaps (or a 1×1 placeholder without BC support) */
	readonly view: GPUTextureView;
	readonly #device: GPUDevice;
	readonly #bc: boolean;
	readonly #texture: GPUTexture;
	readonly #data = new Float32Array(MAX_REFLECTION_PROBES * PROBE_VEC4S * 4);
	readonly #uploaded = new Float32Array(MAX_REFLECTION_PROBES * PROBE_VEC4S * 4);
	#uploadedCount = -1;
	readonly #bins = new Uint32Array(MAX_PROBE_TILES);
	readonly #uploadedBins = new Uint32Array(MAX_PROBE_TILES);
	#uploadedTiles = -1;
	readonly #wantedTextures = new Set<number>();
	readonly #activeProbes: ReflectionProbeEntry[] = [];
	#entries: readonly ReflectionProbeEntry[] = [];
	#groupsShown: readonly boolean[] = [];
	#shown: ReflectionProbeEntry[] | null = null;
	readonly #slotsByTexture = new Map<number, CacheSlot>();
	readonly #slots: (CacheSlot | null)[] = Array.from({ length: MAX_REFLECTION_PROBES }, () => null);
	#tick = 0;
	readonly #frame: ReflectionProbeFrame = { count: 0, maxMip: PROBE_MIPS - 1, tilesX: 0, tilesY: 0 };

	/**
	 * @param device the device
	 * @param options `bc` tells whether `texture-compression-bc` is available
	 */
	constructor(device: GPUDevice, { bc }: { bc: boolean }) {
		this.#device = device;
		this.#bc = bc;
		this.buffer = device.createBuffer({
			label: 'reflection probes',
			size: this.#data.byteLength + this.#bins.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		if (bc) {
			this.#texture = device.createTexture({
				label: 'reflection probe cache',
				size: [PROBE_SIZE, PROBE_SIZE, 6 * MAX_REFLECTION_PROBES],
				format: PROBE_FORMAT,
				mipLevelCount: PROBE_MIPS,
				usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
			});
		} else {
			this.#texture = device.createTexture({
				label: 'reflection probe placeholder',
				size: [1, 1, 6],
				format: 'rgba8unorm',
				usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
			});
		}
		this.view = this.#texture.createView({ dimension: 'cube-array' });
	}

	/** @returns GPU bytes of the probe cache texture and record buffer */
	get bytes(): number {
		if (!this.#bc) {
			return this.buffer.size;
		}
		// 128² BC6H mip chain (8 mips, 4×4 blocks of 16 bytes) × 6 faces × 32 slots
		let faceBytes = 0;
		for (let mip = 0; mip < PROBE_MIPS; mip++) {
			const edge = Math.max(1, PROBE_SIZE >> mip);
			const blocks = Math.ceil(edge / 4);
			faceBytes += blocks * blocks * 16;
		}
		return this.buffer.size + faceBytes * 6 * MAX_REFLECTION_PROBES;
	}

	/** @returns the last prepared frame's probe count and mip span */
	frame(): Readonly<ReflectionProbeFrame> {
		return this.#frame;
	}

	/** @param probes the package's local reflection probes, or none */
	setProbes(probes: readonly ReflectionProbeEntry[]): void {
		this.#entries = probes;
		this.#shown = null;
		this.#slotsByTexture.clear();
		this.#slots.fill(null);
		this.#uploadedCount = -1;
		this.#uploadedTiles = -1;
		this.#frame.count = 0;
		this.#frame.tilesX = 0;
		this.#frame.tilesY = 0;
	}

	/** @param shown per visibility group of the package, whether its content shows */
	setGroupsShown(shown: readonly boolean[]): void {
		this.#groupsShown = shown;
		this.#shown = null;
	}

	/**
	 * culls shown probes to the view frustum, requests their cubemaps, copies newly resident cubemaps into the
	 * cache array, bins active probes into screen tiles, and uploads the active probe records. call once per
	 * traversal before rendering.
	 *
	 * @param input camera, render dimensions, view frustum planes, stream manager, and texture store
	 * @returns active probe count, mip span, and tile grid
	 */
	prepare(input: {
		camera: Camera;
		width: number;
		height: number;
		planes: readonly Plane[];
		stream: TextureStream;
		textures: TextureStore;
	}): Readonly<ReflectionProbeFrame> {
		const { camera, width, height, planes, stream, textures } = input;
		if (!this.#bc || this.#entries.length === 0) {
			this.#frame.count = 0;
			this.#frame.tilesX = 0;
			this.#frame.tilesY = 0;
			return this.#frame;
		}
		if (this.#shown === null) {
			const shown = this.#groupsShown;
			this.#shown = this.#entries.filter((probe) => shown[probe.group] ?? true);
		}
		const visible = selectVisibleProbes(this.#shown, camera.position, planes);

		this.#tick++;
		const tick = this.#tick;
		const wantedTextures = this.#wantedTextures;
		wantedTextures.clear();
		for (const probe of visible) {
			wantedTextures.add(probe.texture);
		}

		let encoder: GPUCommandEncoder | null = null;
		const activeProbes = this.#activeProbes;
		activeProbes.length = 0;
		for (const probe of visible) {
			const streamed = streamWholeTexture({
				stream,
				textures,
				id: probe.texture,
				kind: 'cube',
				priority: PROBE_PRIORITY,
			});
			if (streamed === null || streamed.binding === null) {
				continue;
			}
			const gpu = textures.gpuTexture(probe.texture);
			if (
				gpu === null ||
				gpu.width !== PROBE_SIZE ||
				gpu.height !== PROBE_SIZE ||
				gpu.format !== PROBE_FORMAT ||
				gpu.mipLevelCount !== PROBE_MIPS
			) {
				continue;
			}
			const slot = this.#acquireSlot(probe.texture, streamed.binding.version, tick, wantedTextures);
			if (slot === null) {
				continue;
			}
			if (slot.needsCopy) {
				encoder ??= this.#device.createCommandEncoder({ label: 'reflection probe cache' });
				for (let mip = 0; mip < PROBE_MIPS; mip++) {
					const edge = Math.max(1, PROBE_SIZE >> mip);
					const copyEdge = Math.ceil(edge / 4) * 4;
					encoder.copyTextureToTexture(
						{ texture: gpu, mipLevel: mip },
						{ texture: this.#texture, mipLevel: mip, origin: [0, 0, slot.index * 6] },
						[copyEdge, copyEdge, 6],
					);
				}
			}
			packProbe(this.#data, activeProbes.length, probe, slot.index);
			activeProbes.push(probe);
		}
		if (encoder !== null) {
			this.#device.queue.submit([encoder.finish()]);
		}

		const count = activeProbes.length;
		const floats = count * PROBE_VEC4S * 4;
		let dirty = count !== this.#uploadedCount;
		if (!dirty) {
			for (let i = 0; i < floats; i++) {
				if (this.#data[i] !== this.#uploaded[i]) {
					dirty = true;
					break;
				}
			}
		}
		if (dirty) {
			if (floats > 0) {
				this.#device.queue.writeBuffer(this.buffer, 0, this.#data, 0, floats);
				this.#uploaded.set(this.#data.subarray(0, floats));
			}
			this.#uploadedCount = count;
		}

		const tilesX =
			count > 0 ? Math.min(Math.max(1, Math.ceil(width / PROBE_TILE_SIZE)), MAX_PROBE_TILES_X) : 0;
		const tilesY =
			count > 0 ? Math.min(Math.max(1, Math.ceil(height / PROBE_TILE_SIZE)), MAX_PROBE_TILES_Y) : 0;
		if (count > 0) {
			const tileCount = tilesX * tilesY;
			const bins = this.#bins;
			bins.fill(0, 0, tileCount);
			binProbes(bins, activeProbes, camera, width, height, tilesX, tilesY);
			let binsDirty = tileCount !== this.#uploadedTiles;
			if (!binsDirty) {
				const uploadedBins = this.#uploadedBins;
				for (let t = 0; t < tileCount; t++) {
					if (bins[t] !== uploadedBins[t]) {
						binsDirty = true;
						break;
					}
				}
			}
			if (binsDirty) {
				const aligned = (tileCount + 3) & ~3;
				for (let t = tileCount; t < aligned; t++) {
					bins[t] = 0;
				}
				this.#device.queue.writeBuffer(this.buffer, PROBE_BINS_OFFSET * 16, bins, 0, aligned);
				this.#uploadedBins.set(bins.subarray(0, tileCount));
				this.#uploadedTiles = tileCount;
			}
		}
		this.#frame.count = count;
		this.#frame.tilesX = tilesX;
		this.#frame.tilesY = tilesY;
		return this.#frame;
	}

	/** frees the cache texture and buffer */
	destroy(): void {
		this.#texture.destroy();
		this.buffer.destroy();
	}

	#acquireSlot(
		textureId: number,
		version: number,
		tick: number,
		wanted: ReadonlySet<number>,
	): { index: number; needsCopy: boolean } | null {
		const existing = this.#slotsByTexture.get(textureId);
		if (existing !== undefined) {
			existing.lastUsed = tick;
			const needsCopy = existing.version !== version;
			existing.version = version;
			return { index: existing.slot, needsCopy };
		}
		let free = this.#slots.indexOf(null);
		if (free === -1) {
			// evict the least-recently-used slot not needed by this frame's visible probes
			let oldestTick = Infinity;
			for (let i = 0; i < this.#slots.length; i++) {
				const entry = this.#slots[i]!;
				if (!wanted.has(entry.textureId) && entry.lastUsed < oldestTick) {
					oldestTick = entry.lastUsed;
					free = i;
				}
			}
			if (free === -1) {
				return null;
			}
			this.#slotsByTexture.delete(this.#slots[free]!.textureId);
		}
		const record: CacheSlot = { slot: free, textureId, version, lastUsed: tick };
		this.#slots[free] = record;
		this.#slotsByTexture.set(textureId, record);
		return { index: free, needsCopy: true };
	}
}

const packProbe = (out: Float32Array, index: number, probe: ReflectionProbeEntry, slot: number): void => {
	const at = index * PROBE_VEC4S * 4;
	// [0]: lumaSh (_m0)
	out[at] = probe.lumaSh[0];
	out[at + 1] = probe.lumaSh[1];
	out[at + 2] = probe.lumaSh[2];
	out[at + 3] = probe.lumaSh[3];
	// [1]: halfExtents.xyz, cube-array slot (_m1)
	out[at + 4] = probe.halfExtents[0];
	out[at + 5] = probe.halfExtents[1];
	out[at + 6] = probe.halfExtents[2];
	out[at + 7] = slot;
	// [2..4]: worldToLocal rows 0..2 (_m2.._m4)
	for (let m = 0; m < 12; m++) {
		out[at + 8 + m] = probe.worldToLocal[m];
	}
	// [5]: invBlendDistance.xyz, intensity (_m5)
	out[at + 20] = probe.invBlendDistance[0];
	out[at + 21] = probe.invBlendDistance[1];
	out[at + 22] = probe.invBlendDistance[2];
	out[at + 23] = probe.intensity;
	// [6]: boxProjection, isBox, 0, fade (_m6)
	out[at + 24] = probe.boxProjection ? 1 : 0;
	out[at + 25] = probe.shape === ReflectionProbeShape.Box ? 1 : 0;
	out[at + 26] = 0;
	out[at + 27] = 1;
};

/**
 * culls `probes` to the camera frustum, keeps the nearest {@link MAX_REFLECTION_PROBES} (breaking ties by
 * higher importance so probes containing the camera win), and returns them ordered by importance descending
 * then distance ascending for front-to-back blending.
 *
 * @param probes shown reflection probes
 * @param eye camera world position
 * @param planes camera-relative frustum planes
 * @returns active probes in shading order (at most {@link MAX_REFLECTION_PROBES})
 */
export const selectVisibleProbes = (
	probes: readonly ReflectionProbeEntry[],
	eye: Vec3,
	planes: readonly Plane[],
): ReflectionProbeEntry[] => {
	const visible: { probe: ReflectionProbeEntry; dist2: number }[] = [];
	for (const probe of probes) {
		if (!aabbInFrustum(probe.center, probe.boundsExtents, eye, planes)) {
			continue;
		}
		visible.push({ probe, dist2: aabbDistance2(probe.center, probe.boundsExtents, eye) });
	}
	// pick the nearest probes first so distant high-importance probes cannot evict probes around the camera
	visible.sort((a, b) => a.dist2 - b.dist2 || b.probe.importance - a.probe.importance);
	if (visible.length > MAX_REFLECTION_PROBES) {
		visible.length = MAX_REFLECTION_PROBES;
	}
	// order the kept probes by importance descending for front-to-back shading
	visible.sort((a, b) => b.probe.importance - a.probe.importance || a.dist2 - b.dist2);
	return visible.map(({ probe }) => probe);
};

const aabbInFrustum = (center: Vec3, extents: Vec3, eye: Vec3, planes: readonly Plane[]): boolean => {
	const cx = center[0] - eye[0];
	const cy = center[1] - eye[1];
	const cz = center[2] - eye[2];
	for (const [nx, ny, nz, d] of planes) {
		const r = Math.abs(nx) * extents[0] + Math.abs(ny) * extents[1] + Math.abs(nz) * extents[2];
		if (nx * cx + ny * cy + nz * cz + d + r < 0) {
			return false;
		}
	}
	return true;
};

const binProbes = (
	bins: Uint32Array,
	probes: readonly ReflectionProbeEntry[],
	camera: Camera,
	width: number,
	height: number,
	tilesX: number,
	tilesY: number,
): void => {
	const eye = camera.position;
	const right = camera.right();
	const up = camera.up();
	const forward = camera.forward();
	const f = 1 / Math.tan(camera.fovY / 2);
	const sx = f / (width / height);
	const near = camera.near;
	const rx = right[0];
	const ry = right[1];
	const rz = right[2];
	const ux = up[0];
	const uy = up[1];
	const uz = up[2];
	const fx = forward[0];
	const fy = forward[1];
	const fz = forward[2];

	for (let i = 0; i < probes.length; i++) {
		const probe = probes[i];
		const cx = probe.center[0] - eye[0];
		const cy = probe.center[1] - eye[1];
		const cz = probe.center[2] - eye[2];
		const ex = probe.boundsExtents[0];
		const ey = probe.boundsExtents[1];
		const ez = probe.boundsExtents[2];
		const bit = (1 << i) >>> 0;

		// view-space z of the nearest corner of the world AABB
		const vzCenter = cx * fx + cy * fy + cz * fz;
		const vzExtent = Math.abs(fx) * ex + Math.abs(fy) * ey + Math.abs(fz) * ez;
		let tx0 = 0;
		let tx1 = tilesX - 1;
		let ty0 = 0;
		let ty1 = tilesY - 1;
		if (vzCenter - vzExtent > near) {
			let minX = Infinity;
			let maxX = -Infinity;
			let minY = Infinity;
			let maxY = -Infinity;
			for (let c = 0; c < 8; c++) {
				const px = cx + ((c & 1) === 0 ? -ex : ex);
				const py = cy + ((c & 2) === 0 ? -ey : ey);
				const pz = cz + ((c & 4) === 0 ? -ez : ez);
				const invZ = 1 / (px * fx + py * fy + pz * fz);
				const ndcX = (px * rx + py * ry + pz * rz) * sx * invZ;
				const ndcY = (px * ux + py * uy + pz * uz) * f * invZ;
				if (ndcX < minX) {
					minX = ndcX;
				}
				if (ndcX > maxX) {
					maxX = ndcX;
				}
				if (ndcY < minY) {
					minY = ndcY;
				}
				if (ndcY > maxY) {
					maxY = ndcY;
				}
			}
			const pxMin = (minX * 0.5 + 0.5) * width - 1;
			const pxMax = (maxX * 0.5 + 0.5) * width + 1;
			const pyMin = (0.5 - maxY * 0.5) * height - 1;
			const pyMax = (0.5 - minY * 0.5) * height + 1;
			tx0 = Math.max(0, Math.floor(pxMin / PROBE_TILE_SIZE));
			tx1 = Math.min(tilesX - 1, Math.floor(pxMax / PROBE_TILE_SIZE));
			ty0 = Math.max(0, Math.floor(pyMin / PROBE_TILE_SIZE));
			ty1 = Math.min(tilesY - 1, Math.floor(pyMax / PROBE_TILE_SIZE));
		}
		for (let ty = ty0; ty <= ty1; ty++) {
			const row = ty * tilesX;
			for (let tx = tx0; tx <= tx1; tx++) {
				bins[row + tx] |= bit;
			}
		}
	}
};

const aabbDistance2 = (center: Vec3, extents: Vec3, eye: Vec3): number => {
	const dx = Math.max(0, Math.abs(eye[0] - center[0]) - extents[0]);
	const dy = Math.max(0, Math.abs(eye[1] - center[1]) - extents[1]);
	const dz = Math.max(0, Math.abs(eye[2] - center[2]) - extents[2]);
	return dx * dx + dy * dy + dz * dz;
};
