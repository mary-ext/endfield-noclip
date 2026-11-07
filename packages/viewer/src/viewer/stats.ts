import type { Vec3 } from '@endfield-noclip/package-format/values';

import { mapDefined } from '@mary-ext/array-fns';

import type { GfxDevice } from '../gfx/device.ts';
import type { GpuProfiler } from '../gfx/gpu-profiler.ts';
import type { InstanceRenderer } from '../render/instances/instance-renderer.ts';
import type { MeshRenderer } from '../render/meshes/mesh-renderer.ts';
import type { PostProcess } from '../render/post/post-process.ts';
import type { TerrainRenderer } from '../render/terrain/terrain-renderer.ts';
import type { TextureStore } from '../render/textures/texture-store.ts';
import type { Camera } from '../scene/camera.ts';
import type { StreamManager } from '../streaming/stream-manager.ts';

/** how often the stats refresh, ms */
export const STATS_INTERVAL = 250;

/** numbers for the stats panel */
export interface ViewerStats {
	adapter: string;
	features: string[];
	/** smoothed time between rendered frames, ms */
	frameMs: number;
	/** smoothed CPU time per frame that did work (traversal, streaming, encoding), ms */
	cpuMs: number;
	/** {@link cpuMs} by frame phase, ms */
	cpuPhases: Record<string, number>;
	/** smoothed GPU time of all passes, ms, if timestamps are available */
	gpuMs: number | null;
	/** GPU time by pass label, ms; see {@link GpuProfiler.passes} for how far to trust it */
	gpuPasses: Record<string, number>;
	/** the auto exposure's adjustment, EV (0 when off) */
	autoExposureEv: number;
	draws: number;
	triangles: number;
	instances: number;
	/** instances drawn as meshes (the rest are boxes) */
	meshInstances: number;
	/** mesh draws with their base colour texture bound */
	texturedDraws: number;
	/** GPU bytes of integrated texture levels */
	textureBytes: number;
	/** mip levels material textures are lowered by to fit the stream budget */
	textureReduction: number;
	terrainPatches: number;
	nodesVisited: number;
	residentBytes: number;
	pinnedBytes: number;
	poolBytes: number;
	queued: number;
	requestsInFlight: number;
	decoding: number;
	uploading: number;
	downloadedBytes: number;
	requests: number;
	evictions: number;
	failed: number;
	/** the package was re-packed since it was opened; streaming has stopped until a reload */
	packageChanged: boolean;
	geometriesReady: number;
	geometriesTotal: number;
	camera: { position: Vec3; yaw: number; pitch: number; speed: number };
}

/**
 * @param gfx the device
 * @returns stats before the first frame: the adapter and its features, and zeros
 */
export const emptyStats = (gfx: GfxDevice): ViewerStats => ({
	adapter: gfx.adapterName,
	features: mapDefined(Object.entries(gfx.features), ([name, on]) => (on ? name : undefined)),
	frameMs: 0,
	cpuMs: 0,
	cpuPhases: {},
	gpuMs: null,
	gpuPasses: {},
	autoExposureEv: 0,
	draws: 0,
	triangles: 0,
	instances: 0,
	meshInstances: 0,
	texturedDraws: 0,
	textureBytes: 0,
	textureReduction: 0,
	terrainPatches: 0,
	nodesVisited: 0,
	residentBytes: 0,
	pinnedBytes: 0,
	poolBytes: 0,
	queued: 0,
	requestsInFlight: 0,
	decoding: 0,
	uploading: 0,
	downloadedBytes: 0,
	requests: 0,
	evictions: 0,
	failed: 0,
	packageChanged: false,
	geometriesReady: 0,
	geometriesTotal: 0,
	camera: { position: [0, 0, 0], yaw: 0, pitch: 0, speed: 0 },
});

/** smoothed frame and CPU times, the CPU time split into named spans of the frame */
export class FrameTimes {
	/** smoothed time between rendered frames, ms */
	frameMs = 16.7;
	/** smoothed CPU time of the frames that did work, ms */
	cpuMs = 0;
	/** when the current frame started */
	#frameAt = 0;
	/** when the current span started */
	#spanAt = 0;
	/** CPU time per span in this frame so far, ms */
	readonly #frameSpans = new Map<string, number>();
	/** {@link #frameSpans} smoothed over the frames that did work */
	readonly #cpuSpans = new Map<string, number>();

	/** starts a frame and its first span */
	begin(): void {
		this.#frameAt = this.#spanAt = performance.now();
		this.#frameSpans.clear();
	}

	/**
	 * ends the current span, attributing its time to `name`, and starts the next
	 *
	 * @param name the phase the span's time goes to; spans of one name add up within a frame
	 */
	span(name: string): void {
		const now = performance.now();
		this.#frameSpans.set(name, (this.#frameSpans.get(name) ?? 0) + now - this.#spanAt);
		this.#spanAt = now;
	}

	/** @param dt seconds since the last frame, which rendered */
	rendered(dt: number): void {
		this.frameMs = this.frameMs * 0.9 + dt * 1000 * 0.1;
	}

	/** folds this frame's CPU time and spans into the smoothed ones; call at the end of a frame that did work */
	worked(): void {
		this.cpuMs = this.cpuMs * 0.9 + (performance.now() - this.#frameAt) * 0.1;
		const spans = this.#cpuSpans;
		for (const name of spans.keys()) {
			if (!this.#frameSpans.has(name)) {
				spans.set(name, (spans.get(name) ?? 0) * 0.9);
			}
		}
		for (const [name, ms] of this.#frameSpans) {
			spans.set(name, (spans.get(name) ?? ms) * 0.9 + ms * 0.1);
		}
	}

	/** @returns the smoothed CPU time by span name, ms */
	phases(): Record<string, number> {
		return Object.fromEntries(this.#cpuSpans);
	}
}

/** what {@link collectStats} reads */
export interface StatsSources {
	times: FrameTimes;
	profiler: GpuProfiler;
	post: PostProcess;
	terrain: TerrainRenderer;
	instances: InstanceRenderer;
	meshes: MeshRenderer;
	/** whether the terrain draws */
	terrainShown: boolean;
	/** draws the last rendered frame encoded */
	draws: number;
	/** tree nodes the last traversal visited */
	visited: number;
	/** mip levels material textures are lowered by to fit the stream budget */
	textureReduction: number;
	/** the loaded package's streaming, textures and geometry counts, `null` without one */
	scene: {
		stream: StreamManager;
		textures: TextureStore;
		geometries: { ready: number; total: number };
	} | null;
	/** every system holding GPU pools or targets, which {@link ViewerStats.poolBytes} sums */
	pools: readonly { readonly bytes: number }[];
	camera: Camera;
	/** the camera's movement speed, m/s */
	speed: number;
}

/**
 * @param previous the stats published last, which fields this doesn't measure keep
 * @param sources what to measure
 * @returns fresh stats
 */
export const collectStats = (previous: ViewerStats, sources: StatsSources): ViewerStats => {
	const { times, profiler, terrain, instances, meshes, scene, camera } = sources;
	const stream = scene?.stream.stats;
	let poolBytes = 0;
	for (const pool of sources.pools) {
		poolBytes += pool.bytes;
	}
	return {
		...previous,
		frameMs: times.frameMs,
		cpuMs: times.cpuMs,
		cpuPhases: times.phases(),
		gpuMs: profiler.milliseconds,
		gpuPasses: Object.fromEntries(profiler.passes),
		autoExposureEv: sources.post.exposureEv,
		draws: sources.draws,
		triangles:
			(sources.terrainShown ? terrain.patchCount * terrain.patchTriangles : 0) +
			instances.triangles +
			meshes.triangles,
		instances: instances.instanceCount + meshes.instanceCount,
		meshInstances: meshes.instanceCount,
		texturedDraws: meshes.texturedDraws,
		textureBytes: scene?.textures.bytes ?? 0,
		textureReduction: sources.textureReduction,
		terrainPatches: terrain.patchCount,
		nodesVisited: scene === null ? 0 : sources.visited,
		residentBytes: stream?.residentBytes ?? 0,
		pinnedBytes: stream?.pinnedBytes ?? 0,
		poolBytes,
		queued: stream?.queued ?? 0,
		requestsInFlight: stream?.requestsInFlight ?? 0,
		decoding: stream?.decoding ?? 0,
		uploading: stream?.uploading ?? 0,
		downloadedBytes: stream?.downloadedBytes ?? 0,
		requests: stream?.requests ?? 0,
		evictions: stream?.evictions ?? 0,
		failed: stream?.failed ?? 0,
		packageChanged: stream?.packageChanged ?? false,
		geometriesReady: scene?.geometries.ready ?? 0,
		geometriesTotal: scene?.geometries.total ?? 0,
		camera: {
			position: [...camera.position],
			yaw: camera.yaw,
			pitch: camera.pitch,
			speed: sources.speed,
		},
	};
};
