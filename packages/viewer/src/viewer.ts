/**
 * the viewer: owns the device, the frame loop, the camera and the loaded package, and wires traversal →
 * streaming → renderers. the React UI drives it through {@link Viewer.setOptions} and the level actions, and
 * reads {@link ViewerStats} through {@link Viewer.subscribe}.
 *
 * @module
 */

import {
	BlobKind,
	type ContentRef,
	type LevelInfo,
	isTerrainHole,
	terrainHeight,
	tileAt,
	tileId,
} from '@endfield-noclip/package-format/format';

import { type BindLayouts, createBindLayouts } from './gfx/bind-layouts.ts';
import { type GfxDevice, createGfxDevice } from './gfx/device.ts';
import { GpuTimer } from './gfx/gpu-timer.ts';
import { PipelineCache } from './gfx/pipeline-cache.ts';
import { RenderTargets } from './gfx/render-targets.ts';
import { UniformRing } from './gfx/uniform-ring.ts';
import { DecodePool } from './package/decode-pool.ts';
import type { PackageSource } from './package/package-source.ts';
import { CORE_ARCHIVE_INDEX, type ViewerPackage, openViewerPackage } from './package/viewer-package.ts';
import { FOG_COLOUR, FRAME_UNIFORM_BYTES, FrameOffsets, clearColour } from './render/frame-uniforms.ts';
import { InstanceRenderer } from './render/instance-renderer.ts';
import { RowKind, type RowKinds, type TierSpan } from './render/instance-rows.ts';
import { materialLooks } from './render/materials.ts';
import { MeshRenderer } from './render/mesh-renderer.ts';
import { PAGE_SIDE, TerrainRenderer } from './render/terrain-renderer.ts';
import { TextureStore } from './render/texture-store.ts';
import { Camera, type Vec3 } from './scene/camera.ts';
import { type CameraPose, NoclipControls } from './scene/noclip-controls.ts';
import { type TileTree, buildTileTree } from './scene/tile-tree.ts';
import { type MeshSelection, MeshSelector } from './streaming/mesh-selection.ts';
import { Selector } from './streaming/selection.ts';
import { StreamManager } from './streaming/stream-manager.ts';

// #region options and stats

/** user-facing switches */
export interface ViewerOptions {
	terrain: boolean;
	instances: boolean;
	detail: boolean;
	resident: boolean;
	/** enabled HLOD tiers 0–2 */
	hlodTiers: [boolean, boolean, boolean];
	wireframe: boolean;
	/** draw instance stand-in boxes (the only instance representation until geometry streams) */
	boxes: boolean;
	/** instance refinement threshold, px */
	maxSse: number;
	/** terrain sample spacing target, px */
	terrainPixels: number;
	/** boxes smaller than this on screen are culled, px */
	minBoxPixels: number;
	/** boxes with a half extent above this draw as outlines only, m */
	outlineMetres: number;
	/** streamed content budget, MiB */
	budgetMiB: number;
	/** render every frame instead of only on change (for measuring) */
	continuous: boolean;
}

/** defaults for {@link ViewerOptions} */
export const DEFAULT_OPTIONS: ViewerOptions = {
	terrain: true,
	instances: true,
	detail: true,
	resident: true,
	hlodTiers: [true, true, true],
	wireframe: false,
	boxes: true,
	maxSse: 12,
	terrainPixels: 3,
	minBoxPixels: 1.5,
	outlineMetres: 60,
	budgetMiB: 192,
	continuous: false,
};

/** numbers for the stats panel */
export interface ViewerStats {
	adapter: string;
	features: string[];
	/** smoothed time between rendered frames, ms */
	frameMs: number;
	/** smoothed CPU time per frame that did work (traversal, streaming, encoding), ms */
	cpuMs: number;
	/** smoothed GPU time of the main pass, ms, if timestamps are available */
	gpuMs: number | null;
	draws: number;
	triangles: number;
	instances: number;
	/** instances drawn as meshes (the rest are boxes) */
	meshInstances: number;
	/** mesh draws with their base colour texture bound */
	texturedDraws: number;
	/** GPU bytes of integrated texture levels */
	textureBytes: number;
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
	geometriesReady: number;
	geometriesTotal: number;
	camera: { position: Vec3; yaw: number; pitch: number; speed: number };
}

/** what the level list needs */
export interface LevelEntry {
	id: string;
	name: string;
	instances: number;
}

// #endregion

const SAMPLE_COUNT = 4;
const TERRAIN_SLOTS = 4096;
const INSTANCE_ROWS = 1_500_000;
const STATS_INTERVAL = 250;

/** towards a late-afternoon sun in the south-west, normalized */
const SUN_DIRECTION: Vec3 = (() => {
	const [x, y, z] = [-0.45, 0.62, -0.64];
	const length = Math.sqrt(x * x + y * y + z * z);
	return [x / length, y / length, z / length];
})();
const SUN_AMBIENT = 0.5;
const FOG_DENSITY = 0.00006;

interface LoadedScene {
	pkg: ViewerPackage;
	tree: TileTree;
	stream: StreamManager;
	selector: Selector;
	/** per-instance LOD selection, when the package has converted geometry */
	meshes: MeshSelector | null;
	textures: TextureStore;
	levels: LevelEntry[];
}

/**
 * @param tree the linked tree
 * @param resident manifest.resident refs
 * @returns what the rows of each instance blob are: rows of HLOD blocks take their tier from the refs that
 *   slice them
 */
const instanceRowKinds = (tree: TileTree, resident: readonly ContentRef[]): Map<number, RowKinds> => {
	const kinds = new Map<number, RowKinds>();
	const spans = new Map<number, TierSpan[]>();
	for (const node of tree.nodes) {
		for (const ref of node.hlod) {
			let list = spans.get(ref.blob);
			if (list === undefined) {
				list = [];
				spans.set(ref.blob, list);
				kinds.set(ref.blob, list);
			}
			list.push({ first: ref.first, count: ref.count, tier: ref.tier });
		}
		for (const ref of node.detail) {
			kinds.set(ref.blob, RowKind.Detail);
		}
	}
	for (const ref of resident) {
		kinds.set(ref.blob, RowKind.Resident);
	}
	return kinds;
};

/** the running viewer */
export class Viewer {
	readonly camera = new Camera();
	readonly controls: NoclipControls;
	readonly options: ViewerOptions = structuredClone(DEFAULT_OPTIONS);
	stats: ViewerStats;
	/** bumped when the package, the options or the shown level change; a cheap snapshot for the UI */
	stateRevision = 0;
	/** bumped when {@link stats} change */
	statsRevision = 0;
	scene: LoadedScene | null = null;

	#gfx: GfxDevice;
	#targets: RenderTargets;
	#layouts: BindLayouts;
	#pipelines: PipelineCache;
	#ring: UniformRing;
	#frameBindGroup: GPUBindGroup;
	#timer: GpuTimer;
	#terrain: TerrainRenderer;
	#instances: InstanceRenderer;
	#meshes: MeshRenderer;
	#pool: DecodePool;
	#listeners = new Set<() => void>();
	#raf = 0;
	#frame = 0;
	#lastTime = 0;
	#lastStats = 0;
	#statsKey = '';
	#dirty = true;
	/** the stream version the last traversal saw */
	#seenVersion = -1;
	#frameMs = 16.7;
	#cpuMs = 0;
	#visited = 0;
	#focusCells: Set<string> | null = null;
	/** the level being shown; `null` when the package has no level with content, which shows everything */
	#level: LevelInfo | null = null;
	#lastDraws = 0;
	#viewProj = new Float32Array(16);

	private constructor(gfx: GfxDevice, canvas: HTMLCanvasElement) {
		this.#gfx = gfx;
		const device = gfx.device;
		this.#targets = new RenderTargets(device, canvas, gfx.presentationFormat, SAMPLE_COUNT);
		this.#layouts = createBindLayouts(device);
		this.#pipelines = new PipelineCache(device);
		this.#ring = new UniformRing(device, FRAME_UNIFORM_BYTES, 3);
		this.#frameBindGroup = device.createBindGroup({
			label: 'frame',
			layout: this.#layouts.frame,
			entries: [{ binding: 0, resource: { buffer: this.#ring.buffer, size: FRAME_UNIFORM_BYTES } }],
		});
		this.#timer = new GpuTimer(device, gfx.features.timestampQuery);
		const targets = { colorFormat: gfx.presentationFormat, sampleCount: SAMPLE_COUNT };
		this.#terrain = new TerrainRenderer(device, this.#layouts, this.#pipelines, targets, TERRAIN_SLOTS);
		this.#instances = new InstanceRenderer(device, this.#layouts, this.#pipelines, targets, INSTANCE_ROWS);
		this.#meshes = new MeshRenderer(
			device,
			this.#layouts,
			this.#pipelines,
			this.#instances.bindGroup,
			targets,
		);
		this.#pool = new DecodePool(Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) >> 1)));
		this.controls = new NoclipControls(this.camera, canvas);
		this.stats = this.#emptyStats();
	}

	/**
	 * @param canvas the canvas to render into
	 * @param onLost called if the GPU device is lost
	 * @returns a running viewer
	 * @throws {GfxUnsupportedError} without WebGPU
	 */
	static async create(canvas: HTMLCanvasElement, onLost: (reason: string) => void): Promise<Viewer> {
		const viewer = new Viewer(await createGfxDevice(onLost), canvas);
		viewer.#raf = requestAnimationFrame((time) => viewer.#tick(time));
		return viewer;
	}

	// #region package

	/**
	 * opens a package and starts streaming it, replacing any loaded one.
	 *
	 * @param source where the package lives
	 * @param initialLevel id of the level to show first; when absent from the package, the first level with
	 *   content is shown
	 * @param onProgress loading phases for the UI
	 */
	async load(
		source: PackageSource,
		initialLevel: string | null,
		onProgress: (phase: string) => void,
	): Promise<void> {
		this.unload();
		const pkg = await openViewerPackage(source, onProgress);
		const tree = buildTileTree(pkg.manifest, pkg.tree);

		const textures = new TextureStore(this.#gfx.device, pkg.textures, {
			bc: this.#gfx.features.textureCompressionBc,
		});
		const stream = new StreamManager(
			pkg,
			this.#pool,
			{
				uploadHeights: (decoded, options) => this.#terrain.upload(decoded, options),
				uploadInstances: (decoded) => this.#instances.upload(decoded),
				uploadGeometry: (blob, decoded) => this.#meshes.upload(blob, decoded),
				uploadTexture: (blob, decoded) => textures.upload(blob, decoded),
				release: (blob, resident) => {
					switch (resident.kind) {
						case 'heights': {
							this.#terrain.release(resident);
							break;
						}
						case 'instances': {
							this.#instances.release(resident);
							break;
						}
						case 'geometry': {
							this.#meshes.release(resident);
							break;
						}
						case 'texture': {
							textures.release(blob);
							break;
						}
					}
				},
			},
			instanceRowKinds(tree, pkg.manifest.resident),
			{ budgetBytes: this.options.budgetMiB * 2 ** 20, maxRequests: 8, uploadBytesPerFrame: 24 * 2 ** 20 },
		);
		// the coarse layer: everything in the core (coarse terrain pages, every HLOD block, resident scenery)
		const coreBlobs: number[] = [];
		for (let i = 0; i < pkg.blobs.length; i++) {
			const blob = pkg.blobs[i];
			if (
				blob.archive === CORE_ARCHIVE_INDEX &&
				(blob.kind === BlobKind.TerrainHeights || blob.kind === BlobKind.Instances)
			) {
				coreBlobs.push(i);
			}
		}
		stream.pin(coreBlobs);

		const manifest = pkg.manifest;
		const selector = new Selector(
			tree,
			stream,
			manifest.resident,
			manifest.terrain?.pageSize ?? PAGE_SIDE,
			manifest.tree.rootSize,
		);
		const geometries = pkg.geometries.entries;
		const geometriesReady = geometries.reduce((sum, entry) => sum + (entry.status === 'ready' ? 1 : 0), 0);
		this.scene = {
			pkg,
			tree,
			stream,
			selector,
			meshes:
				geometriesReady > 0
					? new MeshSelector({
							chains: pkg.chains,
							geometries,
							looks: materialLooks(pkg.materials),
							stream,
							textures,
						})
					: null,
			textures,
			levels: manifest.levels.map((level) => ({
				id: level.id,
				name: level.name ?? level.id,
				instances: level.instances,
			})),
		};
		const showable = manifest.levels.filter((level) => level.instances > 0);
		this.#level = showable.find((level) => level.id === initialLevel) ?? showable[0] ?? null;
		selector.setLevel(this.#level?.tag ?? null);
		if (this.#level !== null) {
			this.#focusCells = this.#cellIds(this.#level);
		}
		const pose = this.#level === null ? this.#overviewPose() : this.#levelPose(this.#level);
		if (pose !== null) {
			this.camera.position = pose.position;
			this.camera.yaw = pose.yaw;
			this.camera.pitch = pose.pitch;
		}
		this.stats.geometriesTotal = geometries.length;
		this.stats.geometriesReady = geometriesReady;
		this.#dirty = true;
		this.#emitState();
		onProgress('streaming');
	}

	/** drops the loaded package and its GPU content */
	unload(): void {
		this.scene?.stream.destroy();
		this.scene?.textures.destroy();
		this.#meshes.releaseMaterials();
		this.scene = null;
		this.#level = null;
		this.#focusCells = null;
		this.#dirty = true;
		this.#emitState();
	}

	/** @returns the loaded package's levels (the same array until the package changes) */
	levels(): LevelEntry[] {
		return this.scene?.levels ?? [];
	}

	// #endregion

	// #region camera and levels

	/**
	 * @param x world x
	 * @param z world z
	 * @returns terrain height from the always-resident coarse pages, or `null` off the terrain
	 */
	#groundHeight(x: number, z: number): number | null {
		const scene = this.scene;
		const terrain = scene?.pkg.manifest.terrain;
		if (scene == null || terrain == null) {
			return null;
		}
		const info = scene.pkg.manifest.tree;
		for (let level = scene.tree.terrainLeafLevel; level >= scene.tree.terrainRootLevel; level--) {
			const node = scene.tree.byId.get(tileId(tileAt(info, level, x, z)));
			const blob = node?.terrain?.blob;
			const resident = blob === undefined ? null : scene.stream.get(blob)?.resident;
			const samples = resident?.kind === 'heights' ? resident.samples : null;
			if (node === undefined || samples === null) {
				continue;
			}
			const side = terrain.pageSize;
			const spacing = node.size / (side - 1);
			const fx = Math.min(side - 1, Math.max(0, (x - node.minX) / spacing));
			const fz = Math.min(side - 1, Math.max(0, (z - node.minZ) / spacing));
			const sample = samples[Math.round(fz) * side + Math.round(fx)];
			return isTerrainHole(terrain, sample) ? null : terrainHeight(terrain, sample);
		}
		return null;
	}

	/** @returns a pose looking over the whole region, or `null` without a package */
	#overviewPose(): CameraPose | null {
		const manifest = this.scene?.pkg.manifest;
		if (manifest === undefined) {
			return null;
		}
		const { origin, rootSize } = manifest.tree;
		const terrain = manifest.terrain;
		const baseY = terrain === null ? 0 : terrain.position[1] + terrain.heightScale / 2;
		return {
			position: [
				origin[0] + rootSize / 2,
				baseY + rootSize * 0.45,
				origin[1] + rootSize / 2 - rootSize * 0.85,
			],
			yaw: 0,
			pitch: -0.5,
		};
	}

	/** @returns {@link TileNode.cellId} s of the level's cells */
	#cellIds(level: LevelInfo): Set<string> {
		const cellLevel = this.scene?.pkg.manifest.tree.cellLevel ?? 0;
		return new Set(level.cells.map(([x, z]) => tileId({ level: cellLevel, x, z })));
	}

	#levelInfo(id: string): LevelInfo | undefined {
		return this.scene?.pkg.manifest.levels.find((candidate) => candidate.id === id);
	}

	/** @returns a pose looking over the level's playable rectangle */
	#levelPose(level: LevelInfo): CameraPose {
		const { rect, playerInitPos } = level;
		const cx = (rect.minX + rect.maxX) / 2;
		const cz = (rect.minZ + rect.maxZ) / 2;
		const extent = Math.max(rect.maxX - rect.minX, rect.maxZ - rect.minZ);
		const ground = this.#groundHeight(cx, cz) ?? playerInitPos[1];
		const back = extent * 0.75;
		const up = extent * 0.55;
		return { position: [cx, ground + up, cz - back], yaw: 0, pitch: -Math.atan2(up, back) };
	}

	/**
	 * flies to a vantage point over a level and prioritises its cells.
	 *
	 * @param id level id
	 */
	flyToLevel(id: string): void {
		const level = this.#levelInfo(id);
		if (level !== undefined) {
			this.#flyOver(level);
		}
	}

	#flyOver(level: LevelInfo): void {
		this.controls.flyTo(this.#levelPose(level));
		this.#focusCells = this.#cellIds(level);
		this.#dirty = true;
	}

	/**
	 * flies to a level's player spawn, at eye height.
	 *
	 * @param id level id
	 */
	flyToSpawn(id: string): void {
		const level = this.#levelInfo(id);
		if (level === undefined) {
			return;
		}
		const [x, y, z] = level.playerInitPos;
		this.controls.flyTo({ position: [x, y + 1.7, z], yaw: this.camera.yaw, pitch: -0.05 });
		this.#focusCells = this.#cellIds(level);
		this.#dirty = true;
	}

	/** @returns the shown level's id, or `null` when the package has no level with content */
	get level(): string | null {
		return this.#level?.id ?? null;
	}

	/**
	 * shows one level, whole and alone over the shared terrain, and flies over it. other levels' content stops
	 * being drawn and is evicted as the budget needs.
	 *
	 * @param id level id
	 */
	showLevel(id: string): void {
		const level = this.#levelInfo(id);
		if (level === undefined || this.scene === null) {
			return;
		}
		this.#level = level;
		this.scene.selector.setLevel(level.tag);
		this.#flyOver(level);
		this.#emitState();
	}

	// #endregion

	// #region options and stats

	/** @param patch options to change */
	setOptions(patch: Partial<ViewerOptions>): void {
		Object.assign(this.options, patch);
		if (this.scene !== null) {
			this.scene.stream.options.budgetBytes = this.options.budgetMiB * 2 ** 20;
		}
		this.#dirty = true;
		this.#emitState();
	}

	/**
	 * @param listener called when {@link stateRevision} or {@link statsRevision} change (stats at most about
	 *   four times a second)
	 * @returns unsubscribe
	 */
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emitState(): void {
		this.stateRevision++;
		this.#notify();
	}

	#notify(): void {
		for (const listener of this.#listeners) {
			listener();
		}
	}

	#emptyStats(): ViewerStats {
		const features = this.#gfx.features;
		return {
			adapter: this.#gfx.adapterName,
			features: Object.entries(features)
				.filter(([, on]) => on)
				.map(([name]) => name),
			frameMs: 0,
			cpuMs: 0,
			gpuMs: null,
			draws: 0,
			triangles: 0,
			instances: 0,
			meshInstances: 0,
			texturedDraws: 0,
			textureBytes: 0,
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
			geometriesReady: 0,
			geometriesTotal: 0,
			camera: { position: [0, 0, 0], yaw: 0, pitch: 0, speed: 0 },
		};
	}

	// #endregion

	// #region frame loop

	#tick(time: number): void {
		this.#raf = requestAnimationFrame((next) => this.#tick(next));
		const dt = this.#lastTime === 0 ? 1 / 60 : Math.min(0.1, (time - this.#lastTime) / 1000);
		this.#lastTime = time;
		const cpuStart = performance.now();

		const moved = this.controls.update(dt);
		const resized = this.#targets.update();
		const scene = this.scene;
		const options = this.options;
		let render = this.#dirty || moved || resized || options.continuous;
		this.#dirty = false;
		// with the view, the options and the resident content unchanged and nothing loading, the traversal
		// would repeat the last frame's
		const traverse =
			scene !== null && (render || scene.stream.version !== this.#seenVersion || !scene.stream.idle);
		if (scene !== null && traverse) {
			render ||= scene.stream.version !== this.#seenVersion;
			this.#frame++;
			this.#traverseAndPrepare(scene, { prepare: render });
		}
		if (render) {
			this.#lastDraws = this.#render(scene !== null);
			this.#frameMs = this.#frameMs * 0.9 + dt * 1000 * 0.1;
		}
		if (render || traverse) {
			this.#cpuMs = this.#cpuMs * 0.9 + (performance.now() - cpuStart) * 0.1;
		}

		if (time - this.#lastStats > STATS_INTERVAL) {
			this.#lastStats = time;
			this.#publishStats();
		}
	}

	/** selects and streams this frame's content, and when `prepare` is set, writes it for the renderers */
	#traverseAndPrepare(scene: LoadedScene, { prepare }: { prepare: boolean }): void {
		const options = this.options;
		const stream = scene.stream;
		stream.beginFrame(this.#frame);
		this.#seenVersion = stream.version;
		const aspect = this.#targets.width / this.#targets.height;
		const view = {
			camera: this.camera,
			planes: this.camera.frustumPlanes(aspect),
			pixelFactor: this.camera.pixelFactor(this.#targets.height),
		};
		const selection = scene.selector.run(view, options, this.#focusCells);
		this.#visited = selection.visited;
		// per-instance LOD selection also requests geometry, so it runs before the stream update
		let meshSelection: MeshSelection | null = null;
		if (scene.meshes !== null && options.instances) {
			meshSelection = scene.meshes.run(selection.instances, {
				eye: this.camera.position,
				planes: view.planes,
				pixelFactor: view.pixelFactor,
				viewportHeight: this.#targets.height,
				minPixels: options.minBoxPixels,
			});
		}
		stream.update();
		scene.textures.commit();
		if (!prepare) {
			return;
		}

		const eye = this.camera.position;
		this.#terrain.prepare(options.terrain ? selection.patches : [], eye);
		this.#instances.rebase(eye);
		if (meshSelection === null) {
			this.#instances.prepareRanges(options.instances && options.boxes ? selection.instances : []);
			this.#meshes.clear();
		} else {
			this.#instances.prepareList(options.boxes ? meshSelection.boxes : [], meshSelection.buckets);
			this.#meshes.prepare(meshSelection.buckets, scene.textures);
		}
	}

	#render(hasScene: boolean): number {
		const device = this.#gfx.device;
		const ring = this.#ring;
		ring.beginFrame();
		const uniforms = ring.allocate(FRAME_UNIFORM_BYTES);
		this.#writeFrameUniforms(uniforms.f32, uniforms.u32);
		ring.flush();

		const encoder = device.createCommandEncoder({ label: 'frame' });
		const { color, depth } = this.#targets.mainPassAttachments(clearColour());
		const timestampWrites = this.#timer.passWrites();
		const pass = encoder.beginRenderPass({
			label: 'main',
			colorAttachments: [color],
			depthStencilAttachment: depth,
			timestampWrites,
		});
		let draws = 0;
		if (hasScene) {
			pass.setBindGroup(0, this.#frameBindGroup, [uniforms.offset]);
			draws += this.#terrain.encode(pass);
			draws += this.#meshes.encode(pass);
			draws += this.#instances.encode(pass);
			draws += this.#instances.encodeOutlines(pass);
			if (this.options.wireframe) {
				draws += this.#terrain.encodeWireframe(pass);
			}
		}
		pass.end();
		if (timestampWrites !== undefined) {
			this.#timer.resolve(encoder);
		}
		device.queue.submit([encoder.finish()]);
		this.#timer.afterSubmit();
		return draws;
	}

	#writeFrameUniforms(f32: Float32Array, u32: Uint32Array): void {
		const camera = this.camera;
		const eye = camera.position;
		const width = this.#targets.width;
		const height = this.#targets.height;
		camera.writeViewProjection(width / height, this.#viewProj);
		f32.set(this.#viewProj, FrameOffsets.viewProj);
		{
			const at = FrameOffsets.eye;
			f32[at] = eye[0];
			f32[at + 1] = eye[1];
			f32[at + 2] = eye[2];
			f32[at + 3] = performance.now() / 1000;
		}
		{
			const at = FrameOffsets.sun;
			f32[at] = SUN_DIRECTION[0];
			f32[at + 1] = SUN_DIRECTION[1];
			f32[at + 2] = SUN_DIRECTION[2];
			f32[at + 3] = SUN_AMBIENT;
		}
		{
			const at = FrameOffsets.viewport;
			f32[at] = width;
			f32[at + 1] = height;
			f32[at + 2] = camera.pixelFactor(height);
			f32[at + 3] = this.options.minBoxPixels;
		}
		const terrain = this.scene?.pkg.manifest.terrain;
		if (terrain != null) {
			const at = FrameOffsets.terrain;
			f32[at] = terrain.position[1] - eye[1];
			f32[at + 1] = terrain.heightScale / terrain.holeBit;
			u32[at + 2] = terrain.holeBit;
		}
		f32.set(FOG_COLOUR, FrameOffsets.fog);
		f32[FrameOffsets.fog + 3] = FOG_DENSITY;
		{
			const at = FrameOffsets.flags;
			u32[at] = this.options.wireframe ? 1 : 0;
			u32[at + 1] = 0;
			u32[at + 2] = 0;
			u32[at + 3] = 0;
		}
		f32[FrameOffsets.params] = this.options.outlineMetres;
	}

	/** refreshes {@link stats}, notifying subscribers only if something changed */
	#publishStats(): void {
		const scene = this.scene;
		const stream = scene?.stream.stats;
		const camera = this.camera;
		const stats: ViewerStats = {
			...this.stats,
			frameMs: this.#frameMs,
			cpuMs: this.#cpuMs,
			gpuMs: this.#timer.milliseconds,
			draws: this.#lastDraws,
			triangles:
				(this.options.terrain ? this.#terrain.patchCount * this.#terrain.patchTriangles : 0) +
				this.#instances.triangles +
				this.#meshes.triangles,
			instances: this.#instances.instanceCount + this.#meshes.instanceCount,
			meshInstances: this.#meshes.instanceCount,
			texturedDraws: this.#meshes.texturedDraws,
			textureBytes: scene?.textures.bytes ?? 0,
			terrainPatches: this.#terrain.patchCount,
			nodesVisited: scene === null ? 0 : this.#visited,
			residentBytes: stream?.residentBytes ?? 0,
			pinnedBytes: stream?.pinnedBytes ?? 0,
			poolBytes: this.#terrain.poolBytes + this.#instances.poolBytes + this.#targets.bytes,
			queued: stream?.queued ?? 0,
			requestsInFlight: stream?.requestsInFlight ?? 0,
			decoding: stream?.decoding ?? 0,
			uploading: stream?.uploading ?? 0,
			downloadedBytes: stream?.downloadedBytes ?? 0,
			requests: stream?.requests ?? 0,
			evictions: stream?.evictions ?? 0,
			failed: stream?.failed ?? 0,
			camera: {
				position: [...camera.position],
				yaw: camera.yaw,
				pitch: camera.pitch,
				speed: this.controls.effectiveSpeed,
			},
		};
		const key = JSON.stringify(stats);
		if (key === this.#statsKey) {
			return;
		}
		this.#statsKey = key;
		this.stats = stats;
		this.statsRevision++;
		this.#notify();
	}

	/** stops the loop and frees everything */
	destroy(): void {
		cancelAnimationFrame(this.#raf);
		this.unload();
		this.controls.destroy();
		this.#pool.destroy();
		this.#targets.destroy();
		this.#gfx.device.destroy();
	}

	// #endregion
}
