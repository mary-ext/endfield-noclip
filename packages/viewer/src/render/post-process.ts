/**
 * the passes after the main pass: sky LUTs, ground-truth AO, compositing (AO, sky, atmosphere fog, height
 * fog), water, temporal antialiasing, bloom and tonemapping into the swapchain. everything up to the temporal
 * resolve runs at the render size, everything after it at the output size. every pass is a fullscreen
 * triangle; pipelines use `auto` layouts, so each bind group holds exactly the bindings its pass reads.
 *
 * @module
 */

import { type SceneTextures, HDR_FORMAT } from '../gfx/render-targets.ts';
import type { Camera } from '../scene/camera.ts';

import { AutoExposure } from './auto-exposure.ts';
import { CelestialLayer } from './celestial.ts';
import { type Environment, evaluateSh } from './environment.ts';
import type { DebugView } from './frame-uniforms.ts';
import { LightShafts } from './light-shafts.ts';
import { ScreenSpaceReflections } from './screen-space-reflections.ts';
import atmosphereWgsl from './shaders/atmosphere.wgsl?raw';
import bloomWgsl from './shaders/bloom.wgsl?raw';
import brdfWgsl from './shaders/brdf.wgsl?raw';
import celestialWgsl from './shaders/celestial.wgsl?raw';
import compositeWgsl from './shaders/composite.wgsl?raw';
import gtaoWgsl from './shaders/gtao.wgsl?raw';
import commonWgsl from './shaders/post-common.wgsl?raw';
import skyWgsl from './shaders/sky.wgsl?raw';
import ssrWgsl from './shaders/ssr.wgsl?raw';
import taaWgsl from './shaders/taa.wgsl?raw';
import tonemapWgsl from './shaders/tonemap.wgsl?raw';
import { TemporalAA } from './temporal-aa.ts';
import { type TextureBinding, placeholderView } from './texture-store.ts';
import type { VolumetricFog } from './volumetric-fog.ts';
import type { WaterRenderer } from './water-renderer.ts';

/** byte size of `Post` in post-common.wgsl */
const POST_BYTES = 61 * 16;
const AO_FORMAT: GPUTextureFormat = 'r8unorm';
/** the reduced view depth the AO marches */
const AO_DEPTH_FORMAT: GPUTextureFormat = 'r32float';
/** full-resolution pixels per AO pixel along each axis; matches `AO_SCALE` in gtao.wgsl */
const AO_SCALE = 2;
/** the game's cap on bloom levels */
const BLOOM_MAX_LEVELS = 16;
/** the game sizes the bloom chain as if the view were at most this many pixels tall */
const BLOOM_REFERENCE_HEIGHT = 1080;

/**
 * @param width the chain's reference width (px)
 * @param height the chain's reference height (px)
 * @param half whether the profile asks for half-resolution bloom
 * @returns how many levels the game's bloom chain has
 */
const bloomLevelCount = (width: number, height: number, half: boolean): number => {
	const levels = Math.floor(Math.log2(Math.max(width, height)) - 2 - (half ? 0 : 1));
	return Math.min(Math.max(levels, 1), BLOOM_MAX_LEVELS);
};

/**
 * the tonemapping curves the final pass offers, in the order of their `Post.grade.w` codes: the game's
 * modified ACES (its `TonemappingMode.ACES_modified`), Khronos PBR Neutral (not the game's own `Neutral`
 * mode), or a clamp. the game's colour grading applies under the first two
 */
export const TONEMAPPERS = ['game', 'pbr neutral', 'none'] as const;

export type Tonemapper = (typeof TONEMAPPERS)[number];

/** what the post chain shows; mirrors the viewer's look options */
export interface PostSettings {
	/** exposure compensation, EV */
	exposure: number;
	/** follow the game's auto exposure on top of the compensation */
	autoExposure: boolean;
	tonemapper: Tonemapper;
	sky: boolean;
	heightFog: boolean;
	atmosphereFog: boolean;
	ao: boolean;
	/** screen-space reflections */
	reflections: boolean;
	bloom: boolean;
	vignette: boolean;
	/** anything but `lit` shows the main pass as it is: no exposure, tonemapping, effects or water */
	debugView: DebugView;
}

/** @returns the settings in effect: debug views turn the look off */
const effectiveSettings = (settings: PostSettings): PostSettings => {
	if (settings.debugView === 'lit') {
		return settings;
	}
	return {
		...settings,
		exposure: 0,
		autoExposure: false,
		tonemapper: 'none',
		heightFog: false,
		atmosphereFog: false,
		ao: false,
		reflections: false,
		bloom: false,
		vignette: false,
	};
};

/**
 * @param settings the post settings
 * @param autoExposure the auto exposure's state
 * @returns the linear exposure the tonemap pass multiplies the scene by
 */
export const postExposure = (settings: PostSettings, autoExposure: AutoExposure): number =>
	2 ** settings.exposure * (settings.autoExposure ? autoExposure.exposure : 1);

/**
 * @param parts WGSL sources after the shared post ones
 * @returns a post pass's shader source: the shared BRDF terms and `Post` uniforms, then `parts`
 */
export const postShaderSource = (parts: string[]): string => [brdfWgsl, commonWgsl, ...parts].join('\n');

/** a fullscreen pass into one target */
interface Pass {
	pipeline: GPURenderPipeline;
	groups: GPUBindGroup[];
	target: GPUTextureView;
}

/** group 1 bindings of atmosphere.wgsl and sky.wgsl */
const Lut = {
	transmittance: 0,
	multiScattering: 1,
	skyView: 2,
	sampler: 3,
	skyMean: 4,
	froxels: 5,
} as const;

interface Sized {
	/** the render size */
	width: number;
	height: number;
	outputWidth: number;
	outputHeight: number;
	version: number;
	sceneTextures: SceneTextures;
	/** half resolution: view depth, and the AO marched over it */
	aoDepth: GPUTexture;
	ao: GPUTexture;
	/** full resolution */
	aoBlurred: GPUTexture;
	/** the nebula and planets at the sky pixels, and how far they cover the sky */
	celestial: GPUTexture;
	/** the composited scene at the render size, which the temporal resolve reads */
	scene: GPUTexture;
	sceneView: GPUTextureView;
	/** views of the temporal histories, the antialiased scene at the output size */
	historyViews: [GPUTextureView, GPUTextureView];
	/** the bloom levels at the output size, each half the previous one's size */
	down: GPUTexture[];
	/** each level's horizontal blur (none for the first) */
	blurred: GPUTexture[];
	up: GPUTexture[];
	bloomUniforms: GPUBuffer[];
	passes: {
		aoDepth: Pass;
		gtao: Pass;
		blur: Pass;
		celestial: Pass;
		composite: Pass;
		/** group 0 of the temporal resolve */
		taa: GPUBindGroup;
		/** the bloom prefilter from each temporal history, or `null` on a canvas too small for bloom */
		prefilter: [Pass, Pass] | null;
		/** two blurs per level after the first */
		down: Pass[];
		/** upsamples from the coarsest level, for the full chain and for one level fewer */
		up: { full: Pass[]; short: Pass[] };
	};
	/** the tonemap pass's groups reading each temporal history; its target is the swapchain's current texture */
	tonemapGroups: [GPUBindGroup[], GPUBindGroup[]];
}

/** owns the post chain's targets, pipelines and uniforms */
export class PostProcess {
	/** the post exposure the game's auto exposure picks; the caller steps it each frame */
	readonly autoExposure: AutoExposure;
	/** the antialiasing; the caller jitters the main pass with it */
	readonly taa: TemporalAA;
	/** the nebula and planets the composite draws on the sky; the caller sets their look and textures */
	readonly celestial: CelestialLayer;
	/** the screen-space reflections; the caller resets their history on cuts */
	readonly reflections: ScreenSpaceReflections;
	#lightShafts: LightShafts;
	#device: GPUDevice;
	#uniforms: GPUBuffer;
	#data = new Float32Array(POST_BYTES / 4);
	#words = new Uint32Array(this.#data.buffer);
	#sampler: GPUSampler;
	#transmittance: GPUTexture;
	#multiScattering: GPUTexture;
	#skyView: GPUTexture;
	#skyMean: GPUTexture;
	#lutViews: Record<'transmittance' | 'multiScattering' | 'skyView' | 'skyMean', GPUTextureView>;
	#pipelines: {
		transmittance: GPURenderPipeline;
		multiScattering: GPURenderPipeline;
		skyView: GPURenderPipeline;
		skyMean: GPURenderPipeline;
		aoDepth: GPURenderPipeline;
		gtao: GPURenderPipeline;
		blur: GPURenderPipeline;
		celestial: GPURenderPipeline;
		composite: GPURenderPipeline;
		prefilter: GPURenderPipeline;
		blurH: GPURenderPipeline;
		blurV: GPURenderPipeline;
		up: GPURenderPipeline;
		tonemap: GPURenderPipeline;
	};
	#lutPasses: Record<'transmittance' | 'multiScattering' | 'skyView' | 'skyMean', Pass>;
	#sized: Sized | null = null;
	#environment: Environment;
	/** the cloud panorama bound in the celestial pass */
	#cloud: TextureBinding;
	#noCloud: TextureBinding;
	#lutsReady = false;
	/** the volumetric fog the composite and water passes add in front */
	#fog: VolumetricFog;
	/**
	 * explicit layouts of the post uniforms and of the sky's reads (the sky-view LUT, its sampler, the sky mean
	 * and the volumetric fog, at their atmosphere.wgsl and sky.wgsl bindings), for passes that also bind the
	 * main pass's frame group and so can't use `auto` layouts
	 */
	readonly skyLayouts: { uniforms: GPUBindGroupLayout; sky: GPUBindGroupLayout };
	/** groups for {@link skyLayouts} */
	#skyLayoutGroups: { uniforms: GPUBindGroup; sky: GPUBindGroup };

	/**
	 * @param device the device
	 * @param swapchainFormat the canvas format the final pass writes
	 * @param environment the environment to start with
	 * @param fog the volumetric fog, which the caller encodes before {@link encode}
	 */
	constructor(
		device: GPUDevice,
		swapchainFormat: GPUTextureFormat,
		environment: Environment,
		fog: VolumetricFog,
	) {
		this.#device = device;
		this.#fog = fog;
		this.autoExposure = new AutoExposure(device);
		this.celestial = new CelestialLayer(device);
		this.#uniforms = device.createBuffer({
			label: 'post uniforms',
			size: POST_BYTES,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		this.#sampler = device.createSampler({
			label: 'post bilinear',
			magFilter: 'linear',
			minFilter: 'linear',
			addressModeU: 'clamp-to-edge',
			addressModeV: 'clamp-to-edge',
		});
		const lut = (label: string, width: number, height: number): GPUTexture =>
			device.createTexture({
				label,
				size: [width, height],
				format: HDR_FORMAT,
				usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
			});
		this.#transmittance = lut('transmittance lut', 256, 64);
		this.#multiScattering = lut('multiple scattering lut', 32, 32);
		this.#skyView = lut('sky view lut', 192, 108);
		this.#skyMean = lut('sky mean', 1, 1);
		this.#lutViews = {
			transmittance: this.#transmittance.createView(),
			multiScattering: this.#multiScattering.createView(),
			skyView: this.#skyView.createView(),
			skyMean: this.#skyMean.createView(),
		};
		this.#noCloud = {
			view: placeholderView(device, { label: 'no clouds', dimension: '2d' }),
			sampler: this.#sampler,
			version: -1,
		};
		this.#cloud = this.#noCloud;

		const module = (label: string, parts: string[]): GPUShaderModule =>
			device.createShaderModule({ label, code: postShaderSource(parts) });
		this.taa = new TemporalAA(device, module('taa', [taaWgsl]));
		this.reflections = new ScreenSpaceReflections(device, module('ssr', [ssrWgsl]), this.#uniforms);
		this.#lightShafts = new LightShafts(device);
		const atmosphere = module('atmosphere', [atmosphereWgsl]);
		const gtao = module('gtao', [gtaoWgsl]);
		const composite = module('composite', [atmosphereWgsl, skyWgsl, compositeWgsl]);
		const celestial = module('celestial', [celestialWgsl]);
		const bloom = module('bloom', [bloomWgsl]);
		const tonemap = module('tonemap', [tonemapWgsl]);
		const pipeline = (
			label: string,
			shader: GPUShaderModule,
			entryPoint: string,
			format: GPUTextureFormat,
		): GPURenderPipeline =>
			device.createRenderPipeline({
				label,
				layout: 'auto',
				vertex: { module: shader, entryPoint: 'vs_fullscreen' },
				fragment: { module: shader, entryPoint, targets: [{ format }] },
				primitive: { topology: 'triangle-list' },
			});
		this.#pipelines = {
			transmittance: pipeline('transmittance', atmosphere, 'fs_transmittance', HDR_FORMAT),
			multiScattering: pipeline('multiple scattering', atmosphere, 'fs_multi_scattering', HDR_FORMAT),
			skyView: pipeline('sky view', atmosphere, 'fs_sky_view', HDR_FORMAT),
			skyMean: pipeline('sky mean', composite, 'fs_sky_mean', HDR_FORMAT),
			aoDepth: pipeline('ao depth', gtao, 'fs_ao_depth', AO_DEPTH_FORMAT),
			gtao: pipeline('gtao', gtao, 'fs_gtao', AO_FORMAT),
			blur: pipeline('gtao blur', gtao, 'fs_blur', AO_FORMAT),
			celestial: pipeline('celestial', celestial, 'fs_celestial', HDR_FORMAT),
			composite: pipeline('composite', composite, 'fs_composite', HDR_FORMAT),
			prefilter: pipeline('bloom prefilter', bloom, 'fs_prefilter', HDR_FORMAT),
			blurH: pipeline('bloom blur h', bloom, 'fs_blur_h', HDR_FORMAT),
			blurV: pipeline('bloom blur v', bloom, 'fs_blur_v', HDR_FORMAT),
			up: pipeline('bloom up', bloom, 'fs_up', HDR_FORMAT),
			tonemap: pipeline('tonemap', tonemap, 'fs_tonemap', swapchainFormat),
		};
		const p = this.#pipelines;
		const lutPass = (target: GPURenderPipeline, view: GPUTextureView, reads: readonly number[]): Pass => {
			const groups = [this.#uniformsGroup(target)];
			if (reads.length > 0) {
				groups.push(this.#atmosphereGroup(target, reads));
			}
			return { pipeline: target, groups, target: view };
		};
		const views = this.#lutViews;
		this.#lutPasses = {
			transmittance: lutPass(p.transmittance, views.transmittance, []),
			multiScattering: lutPass(p.multiScattering, views.multiScattering, [Lut.transmittance, Lut.sampler]),
			skyView: lutPass(p.skyView, views.skyView, [Lut.transmittance, Lut.multiScattering, Lut.sampler]),
			skyMean: lutPass(p.skyMean, views.skyMean, [Lut.skyView, Lut.sampler]),
		};
		this.#environment = environment;
		this.#writeEnvironment();

		{
			const fragment = GPUShaderStage.FRAGMENT;
			const texture = (binding: number, viewDimension: GPUTextureViewDimension): GPUBindGroupLayoutEntry => ({
				binding,
				visibility: fragment,
				texture: { sampleType: 'float', viewDimension },
			});
			const uniforms = device.createBindGroupLayout({
				label: 'post uniforms',
				entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | fragment, buffer: { type: 'uniform' } }],
			});
			const sky = device.createBindGroupLayout({
				label: 'sky reads',
				entries: [
					texture(Lut.skyView, '2d'),
					{ binding: Lut.sampler, visibility: fragment, sampler: { type: 'filtering' } },
					texture(Lut.skyMean, '2d'),
					texture(Lut.froxels, '3d'),
				],
			});
			this.skyLayouts = { uniforms, sky };
			this.#skyLayoutGroups = {
				uniforms: device.createBindGroup({
					layout: uniforms,
					entries: [{ binding: 0, resource: { buffer: this.#uniforms } }],
				}),
				sky: device.createBindGroup({
					layout: sky,
					entries: [
						{ binding: Lut.skyView, resource: views.skyView },
						{ binding: Lut.sampler, resource: this.#sampler },
						{ binding: Lut.skyMean, resource: views.skyMean },
						{ binding: Lut.froxels, resource: fog.view },
					],
				}),
			};
		}
	}

	#uniformsGroup(pipeline: GPURenderPipeline): GPUBindGroup {
		return this.#device.createBindGroup({
			layout: pipeline.getBindGroupLayout(0),
			entries: [{ binding: 0, resource: { buffer: this.#uniforms } }],
		});
	}

	/**
	 * @param pipeline a pass that reads the atmosphere
	 * @param reads the group 1 bindings it reads (an `auto` layout has only those)
	 * @returns its group 1
	 */
	#atmosphereGroup(pipeline: GPURenderPipeline, reads: readonly number[]): GPUBindGroup {
		const views = this.#lutViews;
		const resources: Record<number, GPUBindingResource> = {
			[Lut.transmittance]: views.transmittance,
			[Lut.multiScattering]: views.multiScattering,
			[Lut.skyView]: views.skyView,
			[Lut.sampler]: this.#sampler,
			[Lut.skyMean]: views.skyMean,
			[Lut.froxels]: this.#fog.view,
		};
		return this.#device.createBindGroup({
			layout: pipeline.getBindGroupLayout(1),
			entries: reads.map((binding) => ({ binding, resource: resources[binding] })),
		});
	}

	/**
	 * @param pipeline a pass built from {@link postShaderSource} with atmosphere.wgsl and sky.wgsl that draws
	 *   the sky and fog (it reads the sky-view LUT and its mean, and the volumetric fog)
	 * @returns its groups 0 (uniforms) and 1 (atmosphere)
	 */
	#skyGroups(pipeline: GPURenderPipeline): GPUBindGroup[] {
		return [
			this.#uniformsGroup(pipeline),
			this.#atmosphereGroup(pipeline, [Lut.skyView, Lut.sampler, Lut.skyMean, Lut.froxels]),
		];
	}

	/** @returns bytes of the targets the chain holds */
	get bytes(): number {
		const sized = this.#sized;
		if (sized === null) {
			return 0;
		}
		const pixels = sized.width * sized.height;
		const outputPixels = sized.outputWidth * sized.outputHeight;
		// at the render size the reduced AO depth and AO, the blurred AO, the celestial layers and the scene; at the
		// output size the temporal history and the bloom chain (two quarter-size mips)
		return (
			pixels * ((4 + 1) / AO_SCALE ** 2 + 1 + 8 + 8) +
			outputPixels * 8 * (2 / 3) +
			this.taa.bytes +
			this.reflections.bytes +
			this.#lightShafts.bytes
		);
	}

	/** the celestial pass's group 2: the main pass's depth and the cloud panorama */
	#celestialGroup(scene: SceneTextures): GPUBindGroup {
		return this.#device.createBindGroup({
			layout: this.#pipelines.celestial.getBindGroupLayout(2),
			entries: [
				{ binding: 0, resource: scene.depth },
				{ binding: 1, resource: this.#cloud.view },
				{ binding: 2, resource: this.#cloud.sampler },
			],
		});
	}

	/** the composite pass's group 2: the main and transparent passes' outputs, the blurred AO and reflections */
	#sceneGroup(scene: SceneTextures, aoBlurred: GPUTexture, celestial: GPUTexture): GPUBindGroup {
		return this.#device.createBindGroup({
			layout: this.#pipelines.composite.getBindGroupLayout(2),
			entries: [
				{ binding: 0, resource: scene.radiance },
				{ binding: 1, resource: scene.ambient },
				{ binding: 2, resource: aoBlurred.createView() },
				{ binding: 3, resource: scene.depth },
				{ binding: 6, resource: this.reflections.output.createView() },
				{ binding: 7, resource: scene.transparent },
				{ binding: 8, resource: scene.revealage },
				{ binding: 9, resource: celestial.createView() },
			],
		});
	}

	/**
	 * binds the cloud panorama, once it streams in.
	 *
	 * @param cloud the texture's binding, or `null` for none
	 */
	setCloud(cloud: TextureBinding | null): void {
		const next = cloud ?? this.#noCloud;
		if (next === this.#cloud) {
			return;
		}
		this.#cloud = next;
		const sized = this.#sized;
		if (sized !== null) {
			sized.passes.celestial.groups[2] = this.#celestialGroup(sized.sceneTextures);
		}
	}

	/**
	 * sets the environment; the atmosphere LUTs are rebuilt on the next frame.
	 *
	 * @param environment the shown level's environment
	 */
	setEnvironment(environment: Environment): void {
		this.#environment = environment;
		this.#lutsReady = false;
		this.#writeEnvironment();
	}

	#releaseSized(sized: Sized): void {
		for (const texture of [
			sized.aoDepth,
			sized.ao,
			sized.aoBlurred,
			sized.celestial,
			sized.scene,
			...sized.down,
			...sized.blurred,
			...sized.up,
		]) {
			texture.destroy();
		}
		for (const buffer of sized.bloomUniforms) {
			buffer.destroy();
		}
	}

	#ensureSized(
		scene: SceneTextures,
		size: { width: number; height: number; outputWidth: number; outputHeight: number },
	): Sized {
		const { width, height, outputWidth, outputHeight } = size;
		const current = this.#sized;
		if (current !== null && current.version === scene.version) {
			return current;
		}
		if (current !== null) {
			this.#releaseSized(current);
		}
		const device = this.#device;
		const texture = (label: string, w: number, h: number, format: GPUTextureFormat): GPUTexture =>
			device.createTexture({
				label,
				size: [w, h],
				format,
				usage:
					GPUTextureUsage.RENDER_ATTACHMENT |
					GPUTextureUsage.TEXTURE_BINDING |
					GPUTextureUsage.COPY_SRC |
					GPUTextureUsage.COPY_DST,
			});
		const aoWidth = Math.max(1, Math.ceil(width / AO_SCALE));
		const aoHeight = Math.max(1, Math.ceil(height / AO_SCALE));
		const aoDepth = texture('ao depth', aoWidth, aoHeight, AO_DEPTH_FORMAT);
		const ao = texture('ao', aoWidth, aoHeight, AO_FORMAT);
		const aoBlurred = texture('ao blurred', width, height, AO_FORMAT);
		const celestialTexture = texture('celestial', width, height, HDR_FORMAT);
		const sceneTexture = texture('hdr scene', width, height, HDR_FORMAT);
		const sceneView = sceneTexture.createView();
		this.taa.resize({ scene: sceneView, depth: scene.depth, width, height, outputWidth, outputHeight });
		// the reflections run before compositing, so the scene they read still holds last frame's
		this.reflections.resize({ scene, previousScene: sceneView, width, height });
		this.#lightShafts.resize({ scene, composited: sceneView, width, height });
		const histories = this.taa.histories;
		// the game's chain: sized as if the view were at most 1080 px tall, the first level at half that size,
		// with as many levels as half-resolution bloom gets (quarter resolution runs one fewer)
		const down: GPUTexture[] = [];
		const blurred: GPUTexture[] = [];
		const up: GPUTexture[] = [];
		{
			const scale = outputHeight > BLOOM_REFERENCE_HEIGHT ? BLOOM_REFERENCE_HEIGHT / outputHeight : 1;
			const count = bloomLevelCount(outputWidth * scale, outputHeight * scale, true);
			for (let i = 0; i < count; i++) {
				const w = Math.max(1, Math.round((outputWidth * scale) / 2 ** (i + 1)));
				const h = Math.max(1, Math.round((outputHeight * scale) / 2 ** (i + 1)));
				down.push(texture(`bloom down ${i}`, w, h, HDR_FORMAT));
				up.push(texture(`bloom up ${i}`, w, h, HDR_FORMAT));
				if (i > 0) {
					blurred.push(texture(`bloom blurred ${i}`, w, h, HDR_FORMAT));
				}
			}
		}
		const p = this.#pipelines;
		const bloomUniforms: GPUBuffer[] = [];
		const bloomPass = (pass: {
			pipeline: GPURenderPipeline;
			source: GPUTexture;
			/** upsamples: the matching level of the downsample chain */
			high: GPUTexture | null;
			target: GPUTexture;
		}): Pass => {
			const { pipeline, source, high, target } = pass;
			const buffer = device.createBuffer({
				label: 'bloom pass',
				size: 16,
				usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
			});
			device.queue.writeBuffer(
				buffer,
				0,
				new Float32Array([1 / source.width, 1 / source.height, source.width, source.height]),
			);
			bloomUniforms.push(buffer);
			const entries: GPUBindGroupEntry[] = [
				{ binding: 0, resource: source.createView() },
				{ binding: 1, resource: this.#sampler },
				{ binding: 2, resource: { buffer } },
			];
			if (high !== null) {
				entries.push({ binding: 3, resource: high.createView() });
			}
			// the blurs don't read the shared uniforms, so their group 0 is empty
			const uniforms =
				pipeline === p.blurH || pipeline === p.blurV
					? device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [] })
					: this.#uniformsGroup(pipeline);
			return {
				pipeline,
				groups: [uniforms, device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries })],
				target: target.createView(),
			};
		};
		let prefilter: [Pass, Pass] | null = null;
		if (down.length > 0) {
			const from = (history: GPUTexture): Pass =>
				bloomPass({ pipeline: p.prefilter, source: history, high: null, target: down[0] });
			prefilter = [from(histories[0]), from(histories[1])];
		}
		const downPasses: Pass[] = [];
		for (let i = 1; i < down.length; i++) {
			const temp = blurred[i - 1];
			downPasses.push(bloomPass({ pipeline: p.blurH, source: down[i - 1], high: null, target: temp }));
			downPasses.push(bloomPass({ pipeline: p.blurV, source: temp, high: null, target: down[i] }));
		}
		const upPasses = (count: number): Pass[] => {
			const passes: Pass[] = [];
			for (let i = count - 2; i >= 0; i--) {
				const low = i === count - 2 ? down[i + 1] : up[i + 1];
				passes.push(bloomPass({ pipeline: p.up, source: low, high: down[i], target: up[i] }));
			}
			return passes;
		};
		const fullUp = upPasses(down.length);
		const shortUp = down.length > 2 ? upPasses(down.length - 1) : fullUp;
		// the last upsample, or the only level (or nothing, on a tiny canvas)
		let bloomResult: GPUTexture | null = null;
		if (down.length > 1) {
			bloomResult = up[0];
		} else if (down.length === 1) {
			bloomResult = down[0];
		}
		const tonemapGroups = (history: GPUTexture): GPUBindGroup[] => [
			this.#uniformsGroup(p.tonemap),
			device.createBindGroup({
				layout: p.tonemap.getBindGroupLayout(1),
				entries: [
					{ binding: 0, resource: history.createView() },
					{ binding: 1, resource: (bloomResult ?? history).createView() },
					{ binding: 2, resource: this.#sampler },
				],
			}),
		];
		const sized: Sized = {
			width,
			height,
			outputWidth,
			outputHeight,
			version: scene.version,
			sceneTextures: scene,
			aoDepth,
			ao,
			aoBlurred,
			celestial: celestialTexture,
			scene: sceneTexture,
			sceneView,
			historyViews: [histories[0].createView(), histories[1].createView()],
			down,
			blurred,
			up,
			bloomUniforms,
			passes: {
				aoDepth: {
					pipeline: p.aoDepth,
					groups: [
						this.#uniformsGroup(p.aoDepth),
						device.createBindGroup({
							layout: p.aoDepth.getBindGroupLayout(1),
							entries: [{ binding: 0, resource: scene.depth }],
						}),
					],
					target: aoDepth.createView(),
				},
				gtao: {
					pipeline: p.gtao,
					groups: [
						this.#uniformsGroup(p.gtao),
						device.createBindGroup({
							layout: p.gtao.getBindGroupLayout(1),
							entries: [{ binding: 1, resource: aoDepth.createView() }],
						}),
					],
					target: ao.createView(),
				},
				blur: {
					pipeline: p.blur,
					groups: [
						this.#uniformsGroup(p.blur),
						device.createBindGroup({
							layout: p.blur.getBindGroupLayout(1),
							entries: [
								{ binding: 0, resource: scene.depth },
								{ binding: 1, resource: aoDepth.createView() },
								{ binding: 2, resource: ao.createView() },
							],
						}),
					],
					target: aoBlurred.createView(),
				},
				celestial: {
					pipeline: p.celestial,
					// group 1 is the layer's own, bound each frame
					groups: [
						this.#uniformsGroup(p.celestial),
						this.celestial.group(p.celestial.getBindGroupLayout(1)),
						this.#celestialGroup(scene),
					],
					target: celestialTexture.createView(),
				},
				composite: {
					pipeline: p.composite,
					groups: [...this.#skyGroups(p.composite), this.#sceneGroup(scene, aoBlurred, celestialTexture)],
					target: sceneView,
				},
				taa: this.#uniformsGroup(this.taa.pipeline),
				prefilter,
				down: downPasses,
				up: { full: fullUp, short: shortUp },
			},
			tonemapGroups: [tonemapGroups(histories[0]), tonemapGroups(histories[1])],
		};
		this.#sized = sized;
		return sized;
	}

	/** writes the uniforms that only change with the environment */
	#writeEnvironment(): void {
		const environment = this.#environment;
		const f = this.#data;
		const set = (at: number, values: readonly number[]): void => {
			f.set(values, at * 4);
		};
		set(5, [...environment.sunDirection, 1]);
		set(6, [...environment.sunIlluminance, 0]);
		set(7, [...environment.skySunDirection, 0]);
		set(8, [...environment.skyIlluminance, 0]);
		const a = environment.atmosphere;
		set(9, [a.bottomRadius, a.topRadius, a.mieAnisotropy, a.multiScattering]);
		set(10, [...a.rayleighScattering, a.rayleighDistribution]);
		set(11, [...a.mieScattering, a.mieDistribution]);
		set(12, [
			a.mieScattering[0] + a.mieAbsorption[0],
			a.mieScattering[1] + a.mieAbsorption[1],
			a.mieScattering[2] + a.mieAbsorption[2],
			0,
		]);
		set(13, [...a.ozoneAbsorption, a.ozoneTipAltitude]);
		set(14, [a.ozoneTipValue, a.ozoneWidth, 0, 0]);
		set(15, [...a.groundAlbedo, 0]);
		const fog = environment.heightFog;
		set(16, [fog.layers[0].density, fog.layers[0].falloff, fog.layers[0].height, 0]);
		set(17, [fog.layers[1].density, fog.layers[1].falloff, fog.layers[1].height, 0]);
		set(18, [...fog.inscatter, 1 - fog.maxOpacity]);
		set(19, [fog.startDistance, fog.startTransition, fog.cutoffDistance, fog.cutoffTransition]);
		set(20, [...fog.directional, fog.directionalExponent]);
		set(34, [...fog.directionalDirection, fog.directionalStartDistance]);
		const atmo = environment.atmosphereFog;
		if (atmo !== null) {
			set(35, [...atmo.sunDirection, atmo.mieAnisotropy]);
			set(36, [...atmo.extinction, atmo.startDistance]);
			set(37, [...atmo.rayleigh, atmo.distanceScale]);
			set(38, [...atmo.mie, 1 / atmo.fallOffHeight]);
			set(39, [...atmo.ambient, atmo.startHeight / atmo.fallOffHeight]);
		}
		set(40, [environment.skyDistance, atmo !== null ? 1 : 0, 0, 0]);
		set(21, [...evaluateSh(environment.sh, [0, 1, 0]), 0]);
		set(22, [...evaluateSh(environment.sh, [Math.SQRT1_2, 0, Math.SQRT1_2]), 0]);
		const { bloom, ao, vignette } = environment.post;
		{
			// the game's threshold packing: a knee of half the threshold
			const threshold = bloom?.threshold ?? 1;
			const knee = threshold * 0.5 + 1e-5;
			set(24, [threshold, threshold - knee, 2 * knee, 0.25 / knee]);
			set(25, [...(bloom?.tint ?? [1, 1, 1]), bloom?.intensity ?? 0]);
			set(56, [bloom?.subtract ?? 0, bloom?.scatter ?? 0, 0, 0]);
		}
		set(28, [ao?.falloff ?? 1, ao?.distribution ?? 1, ao?.thin ?? 0, 0]);
		set(29, [...(vignette?.color ?? [0, 0, 0]), vignette?.roundness ?? 1]);
		set(30, [...(vignette?.center ?? [0.5, 0.5]), vignette?.rounded ? 1 : 0, 0]);
		const cloud = environment.cloud;
		set(31, [cloud?.rotation ?? 0, cloud?.contrast ?? 1, cloud?.singleChannel ? 1 : 0, 0]);
		set(32, cloud?.tint ?? [1, 1, 1, 1]);
		set(33, [cloud?.opacity[0] ?? 1, cloud?.opacity[1] ?? 1, cloud?.afterPlanets ? 1 : 0, 0]);
		const g = environment.grading;
		set(41, [...g.colorBalance, g.postExposure]);
		set(42, [...g.colorFilter, 0]);
		set(43, [g.hueShift, g.saturation, g.contrast, 0]);
		set(44, [...g.channelMixer[0], 0]);
		set(45, [...g.channelMixer[1], 0]);
		set(46, [...g.channelMixer[2], 0]);
		set(47, [...g.shadows, 0]);
		set(48, [...g.midtones, 0]);
		set(49, [...g.highlights, 0]);
		set(50, g.limits);
		set(51, [...g.lift, 0]);
		set(52, [...g.gamma, 0]);
		set(53, [...g.gain, 0]);
		set(54, [...g.splitShadows, g.splitBalance]);
		set(55, [...g.splitHighlights, 0]);
	}

	/** writes the per-frame uniforms (camera, settings) over the environment's and uploads them all */
	#writeFrame(
		camera: Camera,
		width: number,
		height: number,
		settings: PostSettings,
		frame: number,
		froxels: boolean,
	): void {
		const environment = this.#environment;
		const f = this.#data;
		const u = this.#words;
		const aspect = width / height;
		const tanHalf = Math.tan(camera.fovY / 2);
		const forward = camera.forward();
		const right = camera.right();
		const up = camera.up();
		const set = (at: number, values: readonly number[]): void => {
			f.set(values, at * 4);
		};
		set(0, [...forward, camera.near]);
		set(1, [
			right[0] * aspect * tanHalf,
			right[1] * aspect * tanHalf,
			right[2] * aspect * tanHalf,
			camera.pixelFactor(height),
		]);
		set(2, [up[0] * tanHalf, up[1] * tanHalf, up[2] * tanHalf, performance.now() / 1000]);
		set(3, [...camera.position, frame % 1024]);
		set(4, [width, height, 1 / width, 1 / height]);
		set(57, [...this.taa.jitter, 0, 0]);
		const { bloom, ao, vignette } = environment.post;
		set(23, [ao?.radius ?? 1, 1, ao?.power ?? 1, settings.ao && ao !== null ? 1 : 0]);
		set(26, [
			postExposure(settings, this.autoExposure),
			settings.vignette && vignette !== null ? vignette.intensity : 0,
			vignette?.smoothness ?? 0,
			TONEMAPPERS.indexOf(settings.tonemapper),
		]);
		u.set(
			[
				settings.sky ? 1 : 0,
				settings.heightFog && environment.heightFog.enabled ? 1 : 0,
				settings.atmosphereFog ? 1 : 0,
				settings.bloom && bloom !== null ? 1 : 0,
			],
			27 * 4,
		);
		{
			const sampling = froxels ? this.#fog.sampling : null;
			set(58, sampling?.slices ?? [0, 0, 0, 0]);
			set(59, [sampling?.start ?? 0, 0, 0, 0]);
		}
		set(60, [settings.reflections ? 1 : 0, 0, 0, 0]);
		f[31 * 4 + 3] = environment.cloud !== null && this.#cloud !== this.#noCloud ? 1 : 0;
		f[33 * 4 + 3] = settings.debugView === 'clouds' ? 1 : 0;
		this.#device.queue.writeBuffer(this.#uniforms, 0, f);
	}

	#run(encoder: GPUCommandEncoder, label: string, pass: Pass): void {
		const render = encoder.beginRenderPass({
			label,
			colorAttachments: [{ view: pass.target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
		});
		render.setPipeline(pass.pipeline);
		pass.groups.forEach((group, i) => render.setBindGroup(i, group));
		render.draw(3);
		render.end();
	}

	/**
	 * encodes the chain from the main pass's outputs to the swapchain.
	 *
	 * @param encoder this frame's encoder, after the main pass
	 * @param input the main pass's textures, the camera (unjittered), the render and output sizes and settings
	 */
	encode(
		encoder: GPUCommandEncoder,
		input: {
			scene: SceneTextures;
			swapchain: GPUTextureView;
			camera: Camera;
			width: number;
			height: number;
			outputWidth: number;
			outputHeight: number;
			settings: PostSettings;
			frame: number;
			/** whether the volumetric fog was encoded this frame */
			froxels: boolean;
			/** drawn after compositing, when it has surfaces */
			water: WaterRenderer;
			/** the main pass's frame group and its uniforms' offset, which the water pass lights with */
			frameGroup: { group: GPUBindGroup; offset: number };
		},
	): void {
		const { scene, swapchain, camera, width, height, outputWidth, outputHeight, frame } = input;
		const settings = effectiveSettings(input.settings);
		const sized = this.#ensureSized(scene, { width, height, outputWidth, outputHeight });
		this.#writeFrame(camera, width, height, settings, frame, input.froxels && settings.heightFog);
		const luts = this.#lutPasses;
		if (!this.#lutsReady) {
			this.#run(encoder, 'transmittance lut', luts.transmittance);
			this.#run(encoder, 'multiple scattering lut', luts.multiScattering);
			this.#lutsReady = true;
		}
		// the atmosphere fog is analytic; only the sky reads the LUTs
		if (settings.sky) {
			this.#run(encoder, 'sky view lut', luts.skyView);
			this.#run(encoder, 'sky mean', luts.skyMean);
		}
		if (settings.ao && this.#environment.post.ao !== null) {
			this.#run(encoder, 'ao depth', sized.passes.aoDepth);
			this.#run(encoder, 'gtao', sized.passes.gtao);
			this.#run(encoder, 'gtao blur', sized.passes.blur);
		}
		// with reflections off this still clears what composite reads
		this.reflections.encode(encoder, {
			camera,
			look: this.#environment.post.ssr,
			enabled: settings.reflections,
		});
		{
			const environment = this.#environment;
			this.celestial.write(camera.position, environment.sunDirection, environment.sunIlluminance);
			const celestial = sized.passes.celestial;
			celestial.groups[1] = this.celestial.group(celestial.pipeline.getBindGroupLayout(1));
			this.#run(encoder, 'celestial', celestial);
		}
		this.#run(encoder, 'composite', sized.passes.composite);
		const water = input.water;
		if (settings.debugView === 'lit' && water.active) {
			// the water refracts a copy of the composited scene, kept in the main pass's radiance target, which
			// nothing reads after compositing
			encoder.copyTextureToTexture({ texture: sized.scene }, { texture: scene.radianceTexture }, [
				width,
				height,
			]);
			water.encode(encoder, sized.sceneView, {
				scene,
				background: scene.radiance,
				frame: input.frameGroup,
				postUniforms: this.#skyLayoutGroups.uniforms,
				sky: this.#skyLayoutGroups.sky,
				version: sized.version,
			});
		}
		if (settings.debugView === 'lit') {
			this.#lightShafts.encode(encoder, {
				camera,
				aspect: width / height,
				look: this.#environment.lightShaft,
			});
		}
		const resolved = this.taa.encode(encoder, { camera, postGroup: sized.passes.taa });
		if (settings.autoExposure) {
			this.autoExposure.encode(
				encoder,
				{ view: sized.historyViews[resolved], width: outputWidth, height: outputHeight },
				this.#environment.autoExposure,
			);
		}
		const prefilter = sized.passes.prefilter;
		if (settings.bloom && prefilter !== null) {
			this.#run(encoder, 'bloom down', prefilter[resolved]);
			for (const pass of sized.passes.down) {
				this.#run(encoder, 'bloom down', pass);
			}
			const half = this.#environment.post.bloom?.half ?? true;
			for (const pass of half ? sized.passes.up.full : sized.passes.up.short) {
				this.#run(encoder, 'bloom up', pass);
			}
		}
		this.#run(encoder, 'tonemap', {
			pipeline: this.#pipelines.tonemap,
			groups: sized.tonemapGroups[resolved],
			target: swapchain,
		});
	}

	/** frees the chain's GPU resources */
	destroy(): void {
		if (this.#sized !== null) {
			this.#releaseSized(this.#sized);
		}
		this.#transmittance.destroy();
		this.#multiScattering.destroy();
		this.#skyView.destroy();
		this.#skyMean.destroy();
		this.#uniforms.destroy();
		this.celestial.destroy();
		this.autoExposure.destroy();
		this.taa.destroy();
		this.reflections.destroy();
		this.#lightShafts.destroy();
	}
}
