/**
 * the viewer: owns the device, the frame loop, the camera and the loaded package, and wires traversal →
 * streaming → renderers. the React UI drives it through {@link Viewer.setOptions} and the level actions, and
 * reads {@link ViewerStats} through {@link Viewer.subscribe}.
 *
 * @module
 */
import { BlobKind } from '@endfield-noclip/package-format/blobs';
import {
	conditionResults,
	defaultSceneValues,
	groupsShown,
} from '@endfield-noclip/package-format/conditions';
import type { EnvironmentProfile } from '@endfield-noclip/package-format/environment';
import type { LevelInfo } from '@endfield-noclip/package-format/manifest';
import {
	areasShownIn,
	streamAreaValues,
	zonesAround,
	zonesAt,
} from '@endfield-noclip/package-format/stream-areas';
import { isTerrainHole, terrainHeight } from '@endfield-noclip/package-format/terrain';
import { tileAt, tileId } from '@endfield-noclip/package-format/tiles';
import type { ContentRef } from '@endfield-noclip/package-format/tree';

import { type BindLayouts, createBindLayouts } from './gfx/bind-layouts.ts';
import { type GfxDevice, createGfxDevice } from './gfx/device.ts';
import { GpuProfiler } from './gfx/gpu-profiler.ts';
import { PipelineCache } from './gfx/pipeline-cache.ts';
import { RenderTargets } from './gfx/render-targets.ts';
import { UniformRing } from './gfx/uniform-ring.ts';
import { DecodePool } from './package/decode-pool.ts';
import type { PackageSource } from './package/package-source.ts';
import { CORE_ARCHIVE_INDEX, type ViewerPackage, openViewerPackage } from './package/viewer-package.ts';
import { type CelestialLook, NO_CELESTIAL, celestialLook, celestialTextures } from './render/celestial.ts';
import {
	type AppliedVolume,
	blendEnvironment,
	EnvironmentFades,
	eyeInLevelVolume,
	volumeLevelTag,
} from './render/environment-blend.ts';
import { type Environment, deriveEnvironment } from './render/environment.ts';
import { DEBUG_VIEWS, type DebugView, FRAME_UNIFORM_BYTES, FrameOffsets } from './render/frame-uniforms.ts';
import { InstanceRenderer } from './render/instance-renderer.ts';
import { RowKind, type RowKinds, type TierSpan } from './render/instance-rows.ts';
import { IrradianceVolume } from './render/irradiance-volume.ts';
import { lensFlareLook } from './render/lens-flare-layout.ts';
import { LocalLights } from './render/local-lights.ts';
import { materialLooks } from './render/materials.ts';
import { MeshRenderer } from './render/mesh-renderer.ts';
import { ParticleField } from './render/particles.ts';
import { type PostSettings, PostProcess, type Tonemapper, postExposure } from './render/post-process.ts';
import { SHADOW_FORMAT, SHADOW_LAYERS, ShadowMap, offscreenCasters } from './render/shadow-map.ts';
import { SETTLE_FRAMES } from './render/temporal-aa.ts';
import { PAGE_SIDE, SURFACE_BORDER, SURFACE_SIDE, TerrainRenderer } from './render/terrain-renderer.ts';
import { type TextureBinding, TextureStore, placeholderView } from './render/texture-store.ts';
import { VolumetricFog } from './render/volumetric-fog.ts';
import { WaterRenderer } from './render/water-renderer.ts';
import { wetnessParams } from './render/wetness.ts';
import { Camera, type Vec3 } from './scene/camera.ts';
import { type CameraPose, NoclipControls } from './scene/noclip-controls.ts';
import { type TileTree, buildTileTree } from './scene/tile-tree.ts';
import { type MeshSelection, MeshSelector, streamWholeTexture } from './streaming/mesh-selection.ts';
import { Selector } from './streaming/selection.ts';
import { StreamManager } from './streaming/stream-manager.ts';

// #region options and stats

/** user-facing switches */
export interface ViewerOptions {
	terrain: boolean;
	/** draw the terrain's baked albedo and normal pages; off (or without BC textures) shows stand-in colours */
	terrainSurface: boolean;
	/** blend the terrain's close-up material layers near the camera (needs BC textures) */
	terrainSplat: boolean;
	instances: boolean;
	detail: boolean;
	global: boolean;
	/**
	 * show the stream areas the game shows at the camera, as its trigger zones decide; off shows every area of
	 * the level at once
	 */
	streamAreas: boolean;
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
	/** stream material textures this many mip levels coarser than the view needs (each quarters their memory) */
	textureBias: number;
	/** render every frame instead of only on change (for measuring) */
	continuous: boolean;
	/** temporal antialiasing; off shows each frame as rendered */
	antialiasing: boolean;
	/** the render size relative to the canvas, (0, 1]; temporal antialiasing upsamples to the canvas */
	renderScale: number;
	/** exposure compensation on top of the level's exposure, EV */
	exposure: number;
	/** adapt the exposure to the view as the game's auto exposure does */
	autoExposure: boolean;
	tonemapper: Tonemapper;
	sky: boolean;
	heightFog: boolean;
	atmosphereFog: boolean;
	shadows: boolean;
	/** darken the sun under the environment's projected cloud shadow texture */
	cloudShadows: boolean;
	/** sway how much fog surfaces get with the environment's drifting 3D noise, where it has one */
	flowNoise: boolean;
	/**
	 * let the flow noise drift: the viewer keeps rendering while it moves. off freezes it, so a still view
	 * costs nothing
	 */
	flowNoisePlaying: boolean;
	water: boolean;
	ao: boolean;
	/** screen-space reflections, as on puddles, wet floors and metal */
	reflections: boolean;
	bloom: boolean;
	vignette: boolean;
	/** light ambient from the baked irradiance volume; off uses the environment's ambient probe alone */
	irradiance: boolean;
	/** light surfaces and the volumetric fog with the package's point and spot lights */
	localLights: boolean;
	/** blend the game's environment volumes at the camera; off shows the level's base environment */
	environmentVolumes: boolean;
	/** an environment phase to show over the base instead of the volumes, or `null` */
	environmentPin: number | null;
	/** per-volume preview overrides; absent entries keep the default preview */
	environmentEnabled: Readonly<Record<number, boolean>>;
	/** a material channel instead of the lit image */
	debugView: DebugView;
}

/** defaults for {@link ViewerOptions} */
export const DEFAULT_OPTIONS: ViewerOptions = {
	terrain: true,
	terrainSurface: true,
	terrainSplat: true,
	instances: true,
	detail: true,
	global: true,
	streamAreas: true,
	hlodTiers: [true, true, true],
	wireframe: false,
	boxes: true,
	maxSse: 12,
	terrainPixels: 3,
	minBoxPixels: 1.5,
	outlineMetres: 60,
	// the densest views (Wuling City at street level) want ~550–700 MiB of content
	budgetMiB: 768,
	textureBias: 0,
	continuous: false,
	antialiasing: true,
	renderScale: 1,
	exposure: 0,
	autoExposure: true,
	tonemapper: 'game',
	sky: true,
	heightFog: true,
	atmosphereFog: true,
	shadows: true,
	cloudShadows: true,
	flowNoise: true,
	flowNoisePlaying: true,
	water: true,
	ao: true,
	reflections: true,
	bloom: true,
	vignette: true,
	irradiance: true,
	localLights: true,
	environmentVolumes: true,
	environmentPin: null,
	environmentEnabled: {},
	debugView: 'lit',
};

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

/** what the level list needs */
export interface LevelEntry {
	id: string;
	name: string;
	instances: number;
}

// #endregion

const TERRAIN_SLOTS = 4096;
const INSTANCE_ROWS = 1_500_000;
const STATS_INTERVAL = 250;
/** the irradiance volume of a package without one */
const EMPTY_IRRADIANCE = { keys: new Uint32Array(), blobs: new Uint32Array() };
/** how far over the terrain a level's first view stays (m) */
const VIEW_CLEARANCE = 100;
/** headings a level's first view tries, from the south round */
const VIEW_HEADINGS = 8;

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
 * @param global manifest.global refs
 * @returns what the rows of each instance blob are: rows of HLOD blocks take their tier from the refs that
 *   slice them
 */
const instanceRowKinds = (tree: TileTree, global: readonly ContentRef[]): Map<number, RowKinds> => {
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
		for (const ref of [...node.detail, ...node.conditional]) {
			kinds.set(ref.blob, RowKind.Detail);
		}
	}
	for (const ref of global) {
		kinds.set(ref.blob, RowKind.Global);
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
	#shadowFrameBindGroup: GPUBindGroup;
	#shadows: ShadowMap;
	#shadowPlaceholder: GPUTextureView;
	/** bound while the level has no reflection cubemap, or it hasn't streamed in */
	#noReflection: TextureBinding;
	/** the reflection binding the frame groups were built with */
	#reflection: TextureBinding;
	/** mip levels of the bound reflection cubemap, minus one */
	#reflectionMips = 0;
	/** black: bound while the environment has no shadow ramp, or it hasn't streamed in */
	#noShadowRamp: GPUTextureView;
	/** the shadow ramp view the frame groups were built with */
	#shadowRamp: GPUTextureView;
	/** bound while the environment has no cloud shadow, or it hasn't streamed in */
	#noCloudShadow: GPUTextureView;
	/** the cloud shadow view the frame groups were built with */
	#cloudShadow: GPUTextureView;
	readonly #lights: LocalLights;
	#profiler: GpuProfiler;
	#terrain: TerrainRenderer;
	#instances: InstanceRenderer;
	#meshes: MeshRenderer;
	#post: PostProcess;
	#fog: VolumetricFog;
	/** the loaded package's irradiance volume; an empty one without a package */
	#irradiance: IrradianceVolume;
	#water: WaterRenderer;
	/** the shown level's look */
	#environment: Environment = deriveEnvironment(null);
	/** the nebula and planets of {@link #environment}'s profile */
	#celestial: CelestialLook = NO_CELESTIAL;
	/** `Frame.wetness` for {@link #environment}'s profile */
	#wetness: Float32Array = wetnessParams(undefined);
	/** the shown level's base environment, which the volumes blend over */
	#baseProfile: EnvironmentProfile | null = null;
	/** what the environment was last blended for */
	#blendEye: Vec3 = [Infinity, Infinity, Infinity];
	#blendSettings = '';
	#blendKey: string | null = null;
	#appliedVolumes: AppliedVolume[] = [];
	/** the time-faded volumes' fade state for the camera */
	readonly #fades = new EnvironmentFades();
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
	/** CPU time per frame phase in this frame so far, ms */
	#frameSpans = new Map<string, number>();
	/** {@link #frameSpans} smoothed over the frames that did work */
	#cpuSpans = new Map<string, number>();
	/** when the current span started */
	#spanAt = 0;
	#visited = 0;
	#focusCells: Set<string> | null = null;
	/** the level being shown; `null` when the package has no level with content, which shows everything */
	#level: LevelInfo | null = null;
	/**
	 * the first view after loading, when it was posed before the coarse terrain was resident (at the spawn
	 * height); it's re-posed over the ground once that lands, unless the camera moved first
	 */
	#unsettledPose: CameraPose | null = null;
	#lastDraws = 0;
	#viewProj = new Float32Array(16);
	/** frames still to render so the temporal antialiasing settles after the view stopped changing */
	#settleFrames = 0;
	/** whether the shadow layers need drawing: the casters changed, or they weren't drawn last frame */
	#shadowsStale = true;
	/** each shadow layer's render matrix when it was last drawn */
	#shadowFits = new Float32Array(16 * SHADOW_LAYERS);
	/** seconds the flow noise has drifted; it only advances while playing */
	#flowTime = 0;

	private constructor(gfx: GfxDevice, canvas: HTMLCanvasElement) {
		this.#gfx = gfx;
		const device = gfx.device;
		this.#targets = new RenderTargets(device, canvas, gfx.presentationFormat);
		this.#layouts = createBindLayouts(device);
		this.#pipelines = new PipelineCache(device);
		// the main pass's frame plus one per shadow layer
		const alignment = device.limits.minUniformBufferOffsetAlignment;
		this.#ring = new UniformRing(
			device,
			Math.ceil(FRAME_UNIFORM_BYTES / alignment) * alignment * (1 + SHADOW_LAYERS),
			3,
		);
		this.#shadows = new ShadowMap(device);
		// the shadow passes can't bind the map they render into
		this.#shadowPlaceholder = placeholderView(device, {
			label: 'shadow placeholder',
			dimension: '2d-array',
			format: SHADOW_FORMAT,
		});
		this.#noReflection = {
			view: placeholderView(device, { label: 'no reflection', dimension: 'cube' }),
			sampler: device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' }),
			version: -1,
		};
		this.#reflection = this.#noReflection;
		this.#noShadowRamp = placeholderView(device, { label: 'no shadow ramp', dimension: '2d' });
		this.#shadowRamp = this.#noShadowRamp;
		this.#noCloudShadow = placeholderView(device, { label: 'no cloud shadow', dimension: '2d' });
		this.#cloudShadow = this.#noCloudShadow;
		this.#irradiance = new IrradianceVolume(device, EMPTY_IRRADIANCE);
		this.#lights = new LocalLights(device);
		[this.#frameBindGroup, this.#shadowFrameBindGroup] = this.#frameGroups();
		this.#profiler = new GpuProfiler(device, gfx.features.timestampQuery);
		const format = this.#targets.format;
		this.#terrain = new TerrainRenderer(device, this.#layouts, this.#pipelines, format, {
			capacity: TERRAIN_SLOTS,
			bc: gfx.features.textureCompressionBc,
		});
		this.#instances = new InstanceRenderer(device, this.#layouts, this.#pipelines, format, INSTANCE_ROWS);
		this.#meshes = new MeshRenderer(device, this.#layouts, this.#pipelines, this.#instances, format);
		this.#fog = new VolumetricFog(device, this.#layouts.frame);
		this.#fog.setEnvironment(this.#environment, this.camera.near);
		this.#post = new PostProcess(device, gfx.presentationFormat, this.#environment, this.#fog);
		this.#water = new WaterRenderer(device, { frame: this.#layouts.frame, ...this.#post.skyLayouts });
		this.#pool = new DecodePool(Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) >> 1)));
		this.controls = new NoclipControls(this.camera, canvas);
		this.stats = this.#emptyStats();
	}

	/**
	 * @param canvas the canvas to render into
	 * @param onLost called if the GPU device is lost
	 * @param signal abandons the creation; once aborted, the canvas is left untouched
	 * @returns a running viewer
	 * @throws {GfxUnsupportedError} without WebGPU
	 * @throws the signal's reason when aborted
	 */
	static async create(
		canvas: HTMLCanvasElement,
		onLost: (reason: string) => void,
		signal: AbortSignal,
	): Promise<Viewer> {
		const gfx = await createGfxDevice(onLost);
		// a canvas has one WebGPU context, shared by every viewer made on it. an abandoned viewer built anyway
		// would reconfigure that context and then unconfigure it on destroy, blacking out the viewer that
		// replaced it, so drop the device before touching the canvas
		if (signal.aborted) {
			gfx.device.destroy();
			throw signal.reason;
		}
		const viewer = new Viewer(gfx, canvas);
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
		const surface = pkg.manifest.terrain;
		if (
			surface !== null &&
			(surface.surfaceSize !== SURFACE_SIDE || surface.surfaceBorder !== SURFACE_BORDER)
		) {
			throw new Error(
				`terrain surface pages of ${surface.surfaceSize}² with a ${surface.surfaceBorder}-texel border aren't supported`,
			);
		}
		const tree = buildTileTree(pkg.manifest, pkg.tree);

		const textures = new TextureStore(this.#gfx.device, pkg.textures, {
			bc: this.#gfx.features.textureCompressionBc,
		});
		const irradiance = new IrradianceVolume(this.#gfx.device, pkg.irradiance);
		this.#setIrradiance(irradiance);
		const particles = new ParticleField(pkg.particles, this.#instances);
		const stream = new StreamManager(
			pkg,
			this.#pool,
			{
				uploadHeights: (decoded, options) => this.#terrain.upload(decoded, options),
				uploadSurface: (decoded) => this.#terrain.uploadSurface(decoded),
				uploadDetail: (decoded) => this.#terrain.uploadDetail(decoded),
				uploadLayer: (blob, decoded) => this.#terrain.uploadLayer(blob, decoded),
				uploadInstances: (decoded) => this.#instances.upload(decoded),
				uploadGeometry: (blob, decoded) => this.#meshes.upload(blob, decoded),
				uploadTexture: (blob, decoded) => textures.upload(blob, decoded),
				uploadIrradiance: (_blob, decoded) => irradiance.upload(decoded),
				release: (blob, resident) => {
					switch (resident.kind) {
						case 'heights': {
							this.#terrain.release(resident);
							break;
						}
						case 'surface': {
							this.#terrain.releaseSurface(resident);
							break;
						}
						case 'splat': {
							this.#terrain.releaseSplat(resident);
							break;
						}
						case 'layer': {
							// pinned for the package's lifetime; its array goes with the next `setSplat`
							break;
						}
						case 'instances': {
							particles.release(resident);
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
						case 'irradiance': {
							irradiance.release(resident);
							break;
						}
					}
				},
			},
			instanceRowKinds(tree, pkg.manifest.global),
			{ budgetBytes: this.options.budgetMiB * 2 ** 20, maxRequests: 32, uploadBytesPerFrame: 24 * 2 ** 20 },
		);
		// the coarse layer: everything in the core (coarse terrain pages, every HLOD block, global scenery)
		const coreBlobs: number[] = [];
		for (let i = 0; i < pkg.blobs.length; i++) {
			const blob = pkg.blobs[i];
			if (blob.archive !== CORE_ARCHIVE_INDEX) {
				continue;
			}
			switch (blob.kind) {
				case BlobKind.TerrainHeights:
				case BlobKind.Instances: {
					coreBlobs.push(i);
					break;
				}
				case BlobKind.TerrainSurface: {
					if (this.#terrain.surfaces) {
						coreBlobs.push(i);
					}
					break;
				}
			}
		}
		// every splat page draws from all layer textures, so they stay resident
		const splat = pkg.manifest.terrain?.splat ?? null;
		this.#terrain.setSplat(splat);
		if (splat !== null && this.#terrain.surfaces) {
			coreBlobs.push(...new Set([...splat.diffuse, ...splat.normal]));
		}
		stream.pin(coreBlobs);

		const manifest = pkg.manifest;
		const selector = new Selector(
			tree,
			stream,
			manifest.global,
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
							particles,
						})
					: null,
			textures,
			levels: manifest.levels.map((level) => ({
				id: level.id,
				name: level.name ?? level.id,
				instances: level.instances,
			})),
		};
		this.#sceneValues = defaultSceneValues(manifest.states);
		const showable = manifest.levels.filter((level) => level.instances > 0);
		this.#level = showable.find((level) => level.id === initialLevel) ?? showable[0] ?? null;
		this.#post.autoExposure.reset();
		this.#water.setTable(pkg.water);
		this.#lights.setLights(pkg.lights.lights);
		this.#updateVisibility();
		this.#applyEnvironment();
		if (this.#level !== null) {
			this.#focusCells = this.#cellIds(this.#level);
		}
		if (this.#level === null) {
			const pose = this.#overviewPose();
			if (pose !== null) {
				this.#setPose(pose);
			}
		} else {
			const { pose, settled } = this.#levelPose(this.#level);
			this.#setPose(pose);
			this.#unsettledPose = settled ? null : pose;
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
		// the destroyed store's sky textures
		this.#post.setCloud(null);
		this.#post.setFlowNoise(null);
		this.#post.celestial.setTextures(() => null);
		this.#post.lensFlares.setTextures(() => null);
		this.#setReflection(this.#noReflection, 1);
		this.#setShadowRamp(null);
		this.scene = null;
		this.#sceneValues = {};
		this.options.environmentEnabled = {};
		this.options.environmentPin = null;
		this.#fades.reset();
		this.#setIrradiance(new IrradianceVolume(this.#gfx.device, EMPTY_IRRADIANCE));
		this.#water.setTable(null);
		this.#lights.setLights([]);
		this.#terrain.setSplat(null);
		this.#level = null;
		this.#unsettledPose = null;
		this.#focusCells = null;
		this.#applyEnvironment();
		this.#dirty = true;
		this.#emitState();
	}

	/** @returns group 0 for the main pass and for the shadow passes, with the bound sky and shadow textures */
	#frameGroups(): [main: GPUBindGroup, shadow: GPUBindGroup] {
		const device = this.#gfx.device;
		const reflection = this.#reflection;
		const group = (label: string, shadowView: GPUTextureView): GPUBindGroup =>
			device.createBindGroup({
				label,
				layout: this.#layouts.frame,
				entries: [
					{ binding: 0, resource: { buffer: this.#ring.buffer, size: FRAME_UNIFORM_BYTES } },
					{ binding: 1, resource: shadowView },
					{ binding: 2, resource: this.#shadows.sampler },
					{ binding: 3, resource: reflection.view },
					{ binding: 4, resource: reflection.sampler },
					...irradiance.flatMap(({ a, b }, level) => [
						{ binding: 5 + level * 2, resource: a },
						{ binding: 6 + level * 2, resource: b },
					]),
					{ binding: 11, resource: this.#irradiance.sampler },
					{ binding: 12, resource: this.#irradiance.clampSampler },
					{ binding: 13, resource: this.#shadows.gatherSampler },
					{ binding: 14, resource: this.#shadowRamp },
					{ binding: 15, resource: { buffer: this.#lights.lightBuffer } },
					{ binding: 16, resource: { buffer: this.#lights.binBuffer } },
					{ binding: 17, resource: this.#cloudShadow },
				],
			});
		const irradiance = this.#irradiance.views();
		return [group('frame', this.#shadows.view), group('shadow frame', this.#shadowPlaceholder)];
	}

	/** swaps in a package's irradiance volume and rebinds the frame groups */
	#setIrradiance(irradiance: IrradianceVolume): void {
		this.#irradiance.destroy();
		this.#irradiance = irradiance;
		[this.#frameBindGroup, this.#shadowFrameBindGroup] = this.#frameGroups();
	}

	/** streams the level's sky textures (reflection cubemap, cloud panorama) and binds them as they arrive */
	#updateSkyTextures(scene: LoadedScene): void {
		const { stream, textures } = scene;
		const environment = this.#environment;
		const cloud = streamWholeTexture({
			stream,
			textures,
			id: environment.cloud?.texture ?? null,
			kind: '2d',
			priority: 1e6,
		});
		this.#post.setCloud(cloud?.binding ?? null);
		// the flow noise is one texture for the whole package, wanted only while an environment drifts
		const flowNoise =
			environment.heightFog.flowNoise === null || !this.options.flowNoise
				? null
				: streamWholeTexture({
						stream,
						textures,
						id: scene.pkg.manifest.heightFogFlowNoise ?? null,
						kind: '3d',
						priority: 1e6,
					});
		this.#post.setFlowNoise(flowNoise?.binding ?? null);

		const celestialIds = celestialTextures(this.#celestial);
		this.#post.celestial.setTextures(
			(slot) =>
				streamWholeTexture({ stream, textures, id: celestialIds[slot], kind: '2d', priority: 1e6 })
					?.binding ?? null,
		);
		this.#post.lensFlares.setTextures((id) =>
			streamWholeTexture({ stream, textures, id, kind: '2d', priority: 1e6 }),
		);

		const reflection = streamWholeTexture({
			stream,
			textures,
			id: environment.reflection,
			kind: 'cube',
			priority: 1e6,
		});
		this.#setReflection(reflection?.binding ?? this.#noReflection, reflection?.entry.mipCount ?? 1);

		const ramp = streamWholeTexture({
			stream,
			textures,
			id: environment.shadow.ramp,
			kind: '2d',
			priority: 1e6,
		});
		this.#setShadowRamp(ramp?.binding?.view ?? null);

		const cloudShadow = streamWholeTexture({
			stream,
			textures,
			id: environment.cloudShadow?.texture ?? null,
			kind: '2d',
			priority: 1e6,
		});
		this.#setCloudShadow(cloudShadow?.binding?.view ?? null);
	}

	/** rebinds the frame groups when the cloud shadow's view changed; `null` binds the placeholder */
	#setCloudShadow(view: GPUTextureView | null): void {
		const next = view ?? this.#noCloudShadow;
		if (next !== this.#cloudShadow) {
			this.#cloudShadow = next;
			[this.#frameBindGroup, this.#shadowFrameBindGroup] = this.#frameGroups();
		}
	}

	/** rebinds the frame groups when the shadow ramp's view changed; `null` binds the black placeholder */
	#setShadowRamp(view: GPUTextureView | null): void {
		const next = view ?? this.#noShadowRamp;
		if (next !== this.#shadowRamp) {
			this.#shadowRamp = next;
			[this.#frameBindGroup, this.#shadowFrameBindGroup] = this.#frameGroups();
		}
	}

	/** rebinds the frame groups when the reflection's binding changed (the store hands out a new one then) */
	#setReflection(binding: TextureBinding, mipCount: number): void {
		if (binding !== this.#reflection) {
			this.#reflection = binding;
			this.#reflectionMips = mipCount - 1;
			[this.#frameBindGroup, this.#shadowFrameBindGroup] = this.#frameGroups();
		}
	}

	/** lights the scene with the shown level's environment, or the defaults */
	#applyEnvironment(): void {
		const index = this.#level?.environment ?? null;
		const manifest = this.scene?.pkg.manifest;
		this.#baseProfile = index === null || manifest === undefined ? null : manifest.environments[index];
		this.#blendKey = null;
		this.#fades.reset();
		this.#blendEnvironment(true, 0);
	}

	/**
	 * re-blends the environment volumes at the camera when it moved, a fade is running or the options changed,
	 * and relights the scene if the result differs
	 *
	 * @param force blend even if nothing changed
	 * @param dt seconds since the last frame, which time-faded volumes advance by
	 */
	#blendEnvironment(force: boolean, dt: number): void {
		const options = this.options;
		const eye = this.camera.position;
		const settings = `${options.environmentVolumes}|${options.environmentPin}|${JSON.stringify(options.environmentEnabled)}|${this.#conditionResults.join()}`;
		const last = this.#blendEye;
		if (
			!force &&
			settings === this.#blendSettings &&
			!this.#fades.animating &&
			eye[0] === last[0] &&
			eye[1] === last[1] &&
			eye[2] === last[2]
		) {
			return;
		}
		this.#blendEye = [...eye];
		this.#blendSettings = settings;
		const manifest = this.scene?.pkg.manifest;
		const base = this.#baseProfile;
		let profile = base;
		let key = base?.name ?? '';
		this.#appliedVolumes = [];
		if (
			manifest !== undefined &&
			base !== null &&
			(options.environmentVolumes || options.environmentPin !== null)
		) {
			const blended = blendEnvironment(
				manifest,
				base,
				eye,
				{
					pinnedPhase: options.environmentPin,
					enabled: options.environmentEnabled,
					loaded: this.#conditionResults,
				},
				{ fades: this.#fades, dt },
			);
			profile = blended.profile;
			key = blended.key;
			this.#appliedVolumes = blended.applied;
		}
		if (key === this.#blendKey) {
			return;
		}
		this.#blendKey = key;
		this.#environment = deriveEnvironment(profile);
		this.#celestial = celestialLook(profile);
		this.#wetness = wetnessParams(profile?.rain);
		this.#post.celestial.setLook(this.#celestial);
		this.#post.lensFlares.setLook(lensFlareLook(profile));
		this.#post.setEnvironment(this.#environment);
		this.#fog.setEnvironment(this.#environment, this.camera.near);
		this.#dirty = true;
		this.#emitState();
	}

	/** @returns the name of the environment profile lighting the shown level, or `null` for the defaults */
	get environmentName(): string | null {
		return this.#environment.name;
	}

	/** @returns the environment volumes applied at the camera, in order */
	get appliedVolumes(): readonly AppliedVolume[] {
		return this.#appliedVolumes;
	}

	/** @returns the phases the shown level's volumes apply, for pinning one: index and name */
	environmentPhases(): { index: number; name: string }[] {
		const manifest = this.scene?.pkg.manifest;
		const level = this.#level;
		if (manifest === undefined || level === null) {
			return [];
		}
		const indices = new Set<number>();
		for (const volume of manifest.environmentVolumes) {
			const owner = volumeLevelTag(manifest, volume);
			if (volume.phase !== null && (owner === level.tag || owner === 0)) {
				indices.add(volume.phase);
			}
		}
		return [...indices]
			.map((index) => ({ index, name: manifest.environmentPhases[index].name }))
			.toSorted((a, b) => a.name.localeCompare(b.name));
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
	 * @returns the top of the scenery in the 128 m cell over the point, or -∞ where there's none
	 */
	#sceneryTop(x: number, z: number): number {
		const scene = this.scene;
		if (scene === null) {
			return -Infinity;
		}
		const info = scene.pkg.manifest.tree;
		const cell = scene.tree.byId.get(tileId(tileAt(info, info.cellLevel, x, z)));
		return cell?.bounds.max[1] ?? -Infinity;
	}

	/**
	 * @param x world x
	 * @param z world z
	 * @returns terrain height from the always-resident coarse pages, `null` off the terrain or over a hole, or
	 *   `undefined` while no page covering the point is resident yet
	 */
	#groundHeight(x: number, z: number): number | null | undefined {
		const scene = this.scene;
		const terrain = scene?.pkg.manifest.terrain;
		if (scene == null || terrain == null) {
			return null;
		}
		const info = scene.pkg.manifest.tree;
		let covered = false;
		for (let level = scene.tree.terrainLeafLevel; level >= scene.tree.terrainRootLevel; level--) {
			const node = scene.tree.byId.get(tileId(tileAt(info, level, x, z)));
			const blob = node?.terrain?.blob;
			covered ||= blob !== undefined;
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
		return covered ? undefined : null;
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

	/**
	 * @returns a pose looking over the level's playable rectangle (over the terrain, or the spawn height off
	 *   it) from the heading that keeps the widest view where the level's own environment applies, and whether
	 *   it's settled: unsettled poses fell back to the spawn height while the coarse pages load
	 */
	#levelPose(level: LevelInfo): { pose: CameraPose; settled: boolean } {
		const { rect, playerInitPos } = level;
		const cx = (rect.minX + rect.maxX) / 2;
		const cz = (rect.minZ + rect.maxZ) / 2;
		const extent = Math.max(rect.maxX - rect.minX, rect.maxZ - rect.minZ);
		const terrain = this.#groundHeight(cx, cz);
		const ground = terrain ?? playerInitPos[1];
		const back = extent * 0.75;
		const up = extent * 0.55;
		const pitch = -Math.atan2(up, back);
		const settled = terrain !== undefined;
		// looking north from the south, unless the level's volume can't hold that view
		const fromHeading = (yaw: number): Vec3 => [
			cx - Math.sin(yaw) * back,
			ground + up,
			cz - Math.cos(yaw) * back,
		];
		const fallback = { pose: { position: fromHeading(0), yaw: 0, pitch }, settled };
		const manifest = this.scene?.pkg.manifest;
		const base = level.environment === null ? undefined : manifest?.environments[level.environment];
		if (manifest === undefined || base === undefined || !this.options.environmentVolumes) {
			return fallback;
		}
		const target: Vec3 = [cx, ground, cz];
		let best: { position: Vec3; yaw: number; distance: number } | null = null;
		for (let i = 0; i < VIEW_HEADINGS; i++) {
			const yaw = (i / VIEW_HEADINGS) * 2 * Math.PI;
			const position = eyeInLevelVolume(manifest, level.tag, base, target, fromHeading(yaw), {
				enabled: this.options.environmentEnabled,
				loaded: this.#conditionResults,
				// over the treetops and the cell's tallest scenery (Yinglung's chasm walls are meshes). holes in
				// the terrain aren't clear; terrain that isn't resident yet is
				clear: ([x, y, z]) => {
					const height = this.#groundHeight(x, z);
					return (
						height !== null && y >= (height ?? -Infinity) + VIEW_CLEARANCE && y >= this.#sceneryTop(x, z)
					);
				},
			});
			if (position === null) {
				continue;
			}
			const distance = Math.hypot(position[0] - cx, position[1] - ground, position[2] - cz);
			if (best === null || distance > best.distance + 1) {
				best = { position, yaw, distance };
			}
			// the usual heading wins while it keeps half its reach: other headings can land inside scenery the
			// terrain check doesn't see
			if (i === 0 && distance >= Math.hypot(back, up) / 2) {
				break;
			}
		}
		if (best === null) {
			return fallback;
		}
		return { pose: { position: best.position, yaw: best.yaw, pitch }, settled };
	}

	#setPose({ position, yaw, pitch }: CameraPose): void {
		this.camera.position = [...position];
		this.camera.yaw = yaw;
		this.camera.pitch = pitch;
		// a cut: the last frames show somewhere else
		this.#post.taa.reset();
		this.#post.reflections.reset();
		this.#fog.reset();
	}

	/** re-poses the first view over the ground once the coarse terrain lands; drops it if the camera moved */
	#settleFirstPose(): boolean {
		const pending = this.#unsettledPose;
		const level = this.#level;
		if (pending === null || level === null) {
			return false;
		}
		const camera = this.camera;
		if (
			camera.yaw !== pending.yaw ||
			camera.pitch !== pending.pitch ||
			camera.position.some((value, axis) => value !== pending.position[axis])
		) {
			this.#unsettledPose = null;
			return false;
		}
		const { pose, settled } = this.#levelPose(level);
		if (!settled) {
			return false;
		}
		this.#setPose(pose);
		this.#unsettledPose = null;
		return true;
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
		this.controls.flyTo(this.#levelPose(level).pose);
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
		this.#updateVisibility();
		this.#post.autoExposure.reset();
		this.#applyEnvironment();
		this.#flyOver(level);
		this.#emitState();
	}

	// #endregion

	// #region options and stats

	#sceneValues: Record<string, number> = {};

	/** @returns selected scene control values, including authored defaults */
	get sceneValues(): Readonly<Record<string, number>> {
		return this.#sceneValues;
	}

	/**
	 * @param id exported progression or manual gate identifier
	 * @param value an authored progression level, or 0/1 for a manual gate
	 */
	setSceneValue(id: string, value: number): void {
		const states = this.scene?.pkg.manifest.states;
		if (!states) {
			return;
		}
		const progression = states.progressions.find((entry) => entry.id === id);
		const toggle = states.toggles.find((entry) => entry.id === id);
		if (!(progression?.levels.includes(value) || (toggle && (value === 0 || value === 1)))) {
			return;
		}
		this.#sceneValues = { ...this.#sceneValues, [id]: value };
		this.#updateVisibility();
		this.#emitState();
	}

	/** restores progression, script and environment preview defaults for the current package */
	resetSceneValues(): void {
		const states = this.scene?.pkg.manifest.states;
		this.#sceneValues = states ? defaultSceneValues(states) : {};
		this.options.environmentEnabled = {};
		this.options.environmentPin = null;
		this.#fades.reset();
		this.#updateVisibility();
		this.#emitState();
	}

	/** per conditional set of the loaded package, whether the selected scene values satisfy it */
	#conditionResults: boolean[] = [];

	/** @returns per conditional set of the loaded package, whether the selected scene values satisfy it */
	get conditionResults(): readonly boolean[] {
		return this.#conditionResults;
	}

	/** stream areas the conditions were last evaluated with, or `null` for every area */
	#visibleAreas: ReadonlySet<number> | null = null;
	/** camera position {@link followStreamAreas} last tested */
	#areasEye: Vec3 = [Number.NaN, 0, 0];

	/**
	 * @returns the stream areas shown at the camera, or `null` when every area shows (the option is off or the
	 *   package has no stream areas)
	 */
	get visibleStreamAreas(): ReadonlySet<number> | null {
		return this.#visibleAreas;
	}

	/** @returns the stream areas to show at the camera, or `null` for every area */
	#streamAreasAtCamera(): ReadonlySet<number> | null {
		const info = this.scene?.pkg.manifest.states.streamAreas ?? null;
		if (info === null || !this.options.streamAreas) {
			return null;
		}
		const eye = this.camera.position;
		let zones = zonesAt(info, eye);
		if (zones.size === 0) {
			// above or below every trigger the game falls back to the root areas, which hides most of a zone's
			// level from an overview, so a free camera keeps the zones whose footprint it's over
			zones = zonesAround(info, eye);
		}
		return areasShownIn(info, zones);
	}

	/** re-evaluates visibility when the camera moved into a different set of stream areas */
	#followStreamAreas(): void {
		const eye = this.camera.position;
		const last = this.#areasEye;
		if (eye[0] === last[0] && eye[1] === last[1] && eye[2] === last[2]) {
			return;
		}
		this.#areasEye = [...eye];
		const visible = this.#streamAreasAtCamera();
		const current = this.#visibleAreas;
		const same =
			visible === null || current === null
				? visible === current
				: visible.size === current.size && [...visible].every((area) => current.has(area));
		if (!same) {
			this.#updateVisibility();
		}
	}

	/**
	 * re-evaluates conditions and visibility groups for the shown level, scene values and stream areas at the
	 * camera, for every consumer
	 */
	#updateVisibility(): void {
		const scene = this.scene;
		const states = scene?.pkg.manifest.states;
		this.#visibleAreas = this.#streamAreasAtCamera();
		this.#areasEye = [...this.camera.position];
		const areas = states?.streamAreas ?? null;
		const values =
			areas === null
				? this.#sceneValues
				: { ...this.#sceneValues, ...streamAreaValues(areas, this.#visibleAreas) };
		this.#conditionResults = states === undefined ? [] : conditionResults(states, values);
		const shown =
			states === undefined ? [] : groupsShown(states, this.#level?.tag ?? null, this.#conditionResults);
		scene?.selector.setGroupsShown(shown);
		this.#water.setGroupsShown(shown);
		this.#lights.setGroupsShown(shown);
		this.#dirty = true;
	}

	/** @param patch options to change */
	setOptions(patch: Partial<ViewerOptions>): void {
		Object.assign(this.options, patch);
		if (patch.environmentEnabled !== undefined) {
			this.#fades.reset();
		}
		this.#targets.renderScale = Math.min(1, Math.max(0.25, this.options.renderScale));
		this.#post.taa.enabled = this.options.antialiasing;
		if (patch.debugView !== undefined || patch.antialiasing !== undefined) {
			this.#post.taa.reset();
		}
		if (patch.streamAreas !== undefined) {
			this.#updateVisibility();
		}
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
		};
	}

	// #endregion

	// #region frame loop

	#tick(time: number): void {
		this.#raf = requestAnimationFrame((next) => this.#tick(next));
		const dt = this.#lastTime === 0 ? 1 / 60 : Math.min(0.1, (time - this.#lastTime) / 1000);
		this.#lastTime = time;
		const cpuStart = performance.now();
		this.#spanAt = cpuStart;
		this.#frameSpans.clear();

		const moved = this.controls.update(dt) || this.#settleFirstPose();
		this.#followStreamAreas();
		const resized = this.#targets.update();
		this.#blendEnvironment(false, dt);
		this.#span('controls');
		const scene = this.scene;
		const options = this.options;
		// keep rendering while the exposure adapts; each frame also meters the next
		const post = this.#postSettings();
		const adapting = this.#post.autoExposure.update(
			post.autoExposure && post.debugView === 'lit' ? this.#environment.autoExposure : null,
			dt,
		);
		let render = this.#dirty || moved || resized || options.continuous || adapting;
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
		// the temporal antialiasing converges over a few more jittered frames of the same view, which reuse the
		// last frame's selection
		if (render) {
			this.#settleFrames = options.antialiasing ? SETTLE_FRAMES : 0;
		} else if (this.#settleFrames > 0) {
			this.#settleFrames--;
			render = true;
		}
		// drifting fog moves on its own, so it renders every frame, reusing the last selection; paused, its time
		// stands still and a still view costs nothing
		if (scene !== null && options.flowNoisePlaying && this.#post.drifts(post)) {
			this.#flowTime += dt;
			render = true;
		}
		if (render) {
			this.#lastDraws = this.#render(scene !== null);
			this.#frameMs = this.#frameMs * 0.9 + dt * 1000 * 0.1;
		}
		if (render || traverse) {
			this.#cpuMs = this.#cpuMs * 0.9 + (performance.now() - cpuStart) * 0.1;
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

		if (time - this.#lastStats > STATS_INTERVAL) {
			this.#lastStats = time;
			this.#publishStats();
		}
	}

	/** ends the current CPU span, attributing its time to `name` */
	#span(name: string): void {
		const now = performance.now();
		this.#frameSpans.set(name, (this.#frameSpans.get(name) ?? 0) + now - this.#spanAt);
		this.#spanAt = now;
	}

	/** selects and streams this frame's content, and when `prepare` is set, writes it for the renderers */
	#traverseAndPrepare(scene: LoadedScene, { prepare }: { prepare: boolean }): void {
		const options = this.options;
		const stream = scene.stream;
		stream.beginFrame(this.#frame);
		this.#seenVersion = stream.version;
		// screen-space sizes are measured in output pixels, so the render scale trades shading only, not detail
		const aspect = this.#targets.outputWidth / this.#targets.outputHeight;
		const planes = this.camera.frustumPlanes(aspect);
		const shadows = options.shadows && options.debugView === 'lit';
		const view = {
			camera: this.camera,
			planes,
			pixelFactor: this.camera.pixelFactor(this.#targets.outputHeight),
			casters: shadows ? offscreenCasters(planes, this.#environment.sunDirection) : null,
		};
		const selection = scene.selector.run(
			view,
			{
				...options,
				terrainSurface: options.terrainSurface && this.#terrain.surfaces,
				terrainSplat: options.terrainSplat && this.#terrain.surfaces,
			},
			this.#focusCells,
		);
		this.#visited = selection.visited;
		this.#span('tree');
		// per-instance LOD selection also requests geometry, so it runs before the stream update
		let meshSelection: MeshSelection | null = null;
		if (shadows) {
			// mesh selection groups instances by the shadow layers they reach; #render fits the same layers again,
			// which changes nothing while the camera holds still
			this.#shadows.fit(this.camera, aspect, this.#environment.sunDirection);
		}
		if (scene.meshes !== null && options.instances) {
			meshSelection = scene.meshes.run(selection.instances, {
				eye: this.camera.position,
				planes: view.planes,
				pixelFactor: view.pixelFactor,
				viewportHeight: this.#targets.outputHeight,
				minPixels: options.minBoxPixels,
				textureBias: options.textureBias,
				casters: view.casters,
				shadowLayers: shadows ? this.#shadows.volumes : null,
				// the clock the effects' shaders scroll by
				particles: {
					time: performance.now() / 1000,
					right: this.camera.right(),
					up: this.camera.up(),
					forward: this.camera.forward(),
				},
			});
		}
		this.#span('mesh select');
		this.#updateSkyTextures(scene);
		if (options.water) {
			this.#water.prepare({
				eye: this.camera.position,
				planes: view.planes,
				stream,
				geometries: scene.pkg.geometries.entries,
				textures: scene.textures,
			});
		} else {
			this.#water.clear();
		}
		this.#span('sky, water');
		this.#irradiance.prepare(stream, this.camera.position);
		stream.update();
		scene.textures.commit();
		this.#span('stream');
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
		this.#shadowsStale = true;
		this.#span('prepare');
	}

	#render(hasScene: boolean): number {
		const device = this.#gfx.device;
		const ring = this.#ring;
		ring.beginFrame();
		const shadows = hasScene && this.options.shadows && this.options.debugView === 'lit';
		if (shadows) {
			this.#shadows.fit(
				this.camera,
				this.#targets.width / this.#targets.height,
				this.#environment.sunDirection,
			);
		}
		const uniforms = ring.allocate(FRAME_UNIFORM_BYTES);
		this.#writeFrameUniforms(uniforms.f32, uniforms.u32, { shadows });
		// each cascade's frame: the main one with the cascade's view-projection
		const cascadeOffsets: number[] = [];
		if (shadows) {
			for (const layer of this.#shadows.layers) {
				const block = ring.allocate(FRAME_UNIFORM_BYTES);
				block.f32.set(uniforms.f32);
				block.f32.set(layer.render, FrameOffsets.viewProj);
				cascadeOffsets.push(block.offset);
			}
		}
		ring.flush();
		this.#span('uniforms');

		const encoder = this.#profiler.instrument(device.createCommandEncoder({ label: 'frame' }));
		this.#irradiance.encode(encoder);
		let draws = 0;
		// the layers hold what they drew last until the casters or a layer's fit change; frames that only settle
		// the antialiasing or drift the fog redraw nothing there
		if (shadows) {
			const fits = this.#shadowFits;
			this.#shadows.layers.forEach((layer, i) => {
				if (layer.render.some((value, k) => value !== fits[i * 16 + k])) {
					fits.set(layer.render, i * 16);
					this.#shadowsStale = true;
				}
			});
		}
		const drawShadows = this.#shadowsStale;
		// pipelines still compiling would leave casters out
		this.#shadowsStale = !shadows || this.#pipelines.compiling > 0;
		(drawShadows ? cascadeOffsets : []).forEach((offset, i) => {
			const pass = encoder.beginRenderPass({
				label: `shadow layer ${i}`,
				colorAttachments: [],
				depthStencilAttachment: {
					view: this.#shadows.views[i],
					depthClearValue: 1,
					depthLoadOp: 'clear',
					depthStoreOp: 'store',
				},
			});
			pass.setBindGroup(0, this.#shadowFrameBindGroup, [offset]);
			if (this.options.terrain) {
				draws += this.#terrain.encodeShadow(pass);
			}
			draws += this.#meshes.encodeShadow(pass, i);
			pass.end();
		});
		// after the shadow layers, which it reads
		const froxels =
			hasScene &&
			this.options.heightFog &&
			this.options.debugView === 'lit' &&
			this.#fog.encode(encoder, {
				frameGroup: this.#frameBindGroup,
				frameOffset: uniforms.offset,
				camera: this.camera,
				aspect: this.#targets.width / this.#targets.height,
				frame: this.#frame,
			});
		const { colors, depth } = this.#targets.mainPassAttachments();
		const pass = encoder.beginRenderPass({
			label: 'main',
			colorAttachments: colors,
			depthStencilAttachment: depth,
		});
		if (hasScene) {
			pass.setBindGroup(0, this.#frameBindGroup, [uniforms.offset]);
			// the meshes' depth first, so the terrain and the meshes shade only what stays visible
			draws += this.#meshes.encodePrepass(pass);
			draws += this.#terrain.encode(pass);
			draws += this.#meshes.encode(pass);
			draws += this.#instances.encode(pass);
			draws += this.#instances.encodeOutlines(pass);
			if (this.options.wireframe) {
				draws += this.#terrain.encodeWireframe(pass);
			}
		}
		pass.end();
		// always run, so the composite reads cleared targets when nothing is transparent
		{
			const attachments = this.#targets.transparentPassAttachments();
			const transparent = encoder.beginRenderPass({
				label: 'transparent',
				colorAttachments: attachments.colors,
				depthStencilAttachment: attachments.depth,
			});
			if (hasScene) {
				transparent.setBindGroup(0, this.#frameBindGroup, [uniforms.offset]);
				draws += this.#meshes.encodeTransparent(transparent, this.#targets.scene);
			}
			transparent.end();
		}
		this.#post.encode(encoder, {
			scene: this.#targets.scene,
			swapchain: this.#targets.swapchainView(),
			camera: this.camera,
			width: this.#targets.width,
			height: this.#targets.height,
			outputWidth: this.#targets.outputWidth,
			outputHeight: this.#targets.outputHeight,
			settings: this.#postSettings(),
			frame: this.#frame,
			froxels,
			water: this.#water,
			frameGroup: { group: this.#frameBindGroup, offset: uniforms.offset },
		});
		this.#profiler.resolve(encoder);
		this.#span('encode');
		device.queue.submit([encoder.finish()]);
		this.#profiler.afterSubmit();
		this.#post.autoExposure.afterSubmit();
		this.#span('submit');
		return draws;
	}

	/** the post chain's settings, from the options; auto exposure needs a scene */
	#postSettings(): PostSettings {
		const options = this.options;
		return {
			exposure: options.exposure,
			autoExposure: options.autoExposure && this.scene !== null,
			tonemapper: options.tonemapper,
			sky: options.sky,
			heightFog: options.heightFog,
			atmosphereFog: options.atmosphereFog,
			flowNoise: options.flowNoise,
			flowTime: this.#flowTime,
			ao: options.ao,
			reflections: options.reflections,
			bloom: options.bloom,
			vignette: options.vignette,
			debugView: options.debugView,
		};
	}

	#writeFrameUniforms(f32: Float32Array, u32: Uint32Array, { shadows }: { shadows: boolean }): void {
		const camera = this.camera;
		const eye = camera.position;
		const { width, height, outputWidth, outputHeight } = this.#targets;
		camera.writeViewProjection(width / height, this.#viewProj);
		{
			// shift the image by this frame's subpixel jitter: clip.xy += jitter · clip.w
			const viewProj = this.#viewProj;
			const [jx, jy] = this.#post.taa.nextJitter(width, height, outputHeight);
			for (let column = 0; column < 4; column++) {
				viewProj[column * 4] += jx * viewProj[column * 4 + 3];
				viewProj[column * 4 + 1] += jy * viewProj[column * 4 + 3];
			}
		}
		f32.set(this.#viewProj, FrameOffsets.viewProj);
		{
			const at = FrameOffsets.eye;
			f32[at] = eye[0];
			f32[at + 1] = eye[1];
			f32[at + 2] = eye[2];
			f32[at + 3] = performance.now() / 1000;
		}
		{
			const environment = this.#environment;
			f32.set(environment.sunDirection, FrameOffsets.sun);
			f32[FrameOffsets.sun + 3] = 1;
			f32.set(environment.sunIlluminance, FrameOffsets.sunColor);
			f32[FrameOffsets.sunColor + 3] = environment.sunSpecular;
			f32.set(environment.sh, FrameOffsets.sh);
			f32[FrameOffsets.ambient] = environment.indirectSpecular;
			// emitters marked `_IgnorePostExposure` divide out the post exposure (the game's adapted exposure)
			f32[FrameOffsets.ambient + 1] = 1 / postExposure(this.#postSettings(), this.#post.autoExposure);
			f32[FrameOffsets.ambient + 2] = this.#reflection === this.#noReflection ? 0 : 1;
			f32[FrameOffsets.ambient + 3] = this.#reflectionMips;
		}
		{
			const at = FrameOffsets.viewport;
			f32[at] = outputWidth;
			f32[at + 1] = outputHeight;
			f32[at + 2] = camera.pixelFactor(outputHeight);
			f32[at + 3] = this.options.minBoxPixels;
		}
		const terrain = this.scene?.pkg.manifest.terrain;
		if (terrain != null) {
			const at = FrameOffsets.terrain;
			f32[at] = terrain.position[1] - eye[1];
			f32[at + 1] = terrain.heightScale / terrain.holeBit;
			u32[at + 2] = terrain.holeBit;
		}
		{
			const at = FrameOffsets.flags;
			u32[at] = this.options.wireframe ? 1 : 0;
			u32[at + 1] = DEBUG_VIEWS.indexOf(this.options.debugView);
			u32[at + 2] = 0;
			u32[at + 3] = 0;
		}
		f32[FrameOffsets.params] = this.options.outlineMetres;
		// below the output size, textures sample as sharp as the output needs; the history gathers the detail
		f32[FrameOffsets.params + 1] = Math.log2(height / outputHeight);
		this.#shadows.layers.forEach((layer, i) => {
			f32.set(layer.sample, FrameOffsets.shadowMatrices + i * 16);
			f32.set(layer.sphere, FrameOffsets.shadowSpheres + i * 4);
		});
		f32.set(this.#shadows.fade, FrameOffsets.shadowFade);
		f32[FrameOffsets.shadowFade + 3] = shadows ? 1 : 0;
		{
			const shadow = this.#environment.shadow;
			f32.set(this.#shadows.penumbra(shadow.softness), FrameOffsets.shadowPenumbra);
			const at = FrameOffsets.shadowLook;
			f32[at] = shadow.strength;
			f32[at + 1] = shadow.override;
			f32[at + 2] = shadow.attenuation;
			f32[at + 3] = this.#shadowRamp === this.#noShadowRamp ? 0 : 1;
		}
		{
			const cloud = this.#environment.cloudShadow;
			const at = FrameOffsets.cloudShadow;
			const on =
				cloud !== null &&
				this.#cloudShadow !== this.#noCloudShadow &&
				this.options.cloudShadows &&
				this.options.debugView === 'lit';
			f32.fill(0, at, at + 16);
			if (on) {
				f32.set(cloud.center, at);
				f32[at + 3] = 1;
				f32[at + 4] = cloud.start;
				f32[at + 5] = cloud.start + cloud.width;
				f32[at + 6] = cloud.scale;
				f32.set(cloud.flow, at + 8);
				f32[at + 10] = cloud.alpha;
				f32[at + 11] = cloud.farScale;
				f32.set(cloud.projection, at + 12);
			}
		}
		f32.set(this.#wetness, FrameOffsets.wetness);
		this.#irradiance.centers().forEach((center, i) => {
			const at = FrameOffsets.irradiance + i * 4;
			f32.set(center ?? [0, 0, 0], at);
			f32[at + 3] = center !== null && this.options.irradiance ? 1 : 0;
		});
		{
			const lit = this.scene !== null && this.options.localLights && this.options.debugView === 'lit';
			const lights = lit ? this.#lights.prepare(camera, width, height) : { count: 0, tilesX: 1, tilesY: 1 };
			const at = FrameOffsets.localLights;
			f32[at] = lights.count;
			f32[at + 1] = lights.tilesX;
			f32[at + 2] = lights.tilesY;
			f32[at + 3] = camera.near;
			f32.set(camera.forward(), FrameOffsets.viewForward);
			f32[FrameOffsets.renderSize] = width;
			f32[FrameOffsets.renderSize + 1] = height;
		}
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
			cpuPhases: Object.fromEntries(this.#cpuSpans),
			gpuMs: this.#profiler.milliseconds,
			gpuPasses: Object.fromEntries(this.#profiler.passes),
			autoExposureEv: Math.log2(this.#post.autoExposure.exposure),
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
			poolBytes:
				this.#terrain.poolBytes +
				this.#instances.poolBytes +
				this.#targets.bytes +
				this.#post.bytes +
				this.#fog.bytes +
				this.#shadows.bytes,
			queued: stream?.queued ?? 0,
			requestsInFlight: stream?.requestsInFlight ?? 0,
			decoding: stream?.decoding ?? 0,
			uploading: stream?.uploading ?? 0,
			downloadedBytes: stream?.downloadedBytes ?? 0,
			requests: stream?.requests ?? 0,
			evictions: stream?.evictions ?? 0,
			failed: stream?.failed ?? 0,
			packageChanged: stream?.packageChanged ?? false,
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
		this.#post.destroy();
		this.#fog.destroy();
		this.#lights.destroy();
		this.#water.destroy();
		this.#shadows.destroy();
		this.#pool.destroy();
		this.#targets.destroy();
		this.#gfx.device.destroy();
	}

	// #endregion
}
