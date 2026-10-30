/**
 * the passes after the main pass: sky LUTs, ground-truth AO, compositing (AO, sky, aerial perspective, height
 * fog), water, bloom and tonemapping into the swapchain. every pass is a fullscreen triangle; pipelines use
 * `auto` layouts, so each bind group holds exactly the bindings its pass reads.
 *
 * @module
 */

import { type SceneTextures, HDR_FORMAT } from '../gfx/render-targets.ts';
import type { Camera } from '../scene/camera.ts';

import { AutoExposure } from './auto-exposure.ts';
import { type Environment, evaluateSh } from './environment.ts';
import type { DebugView } from './frame-uniforms.ts';
import atmosphereWgsl from './shaders/atmosphere.wgsl?raw';
import bloomWgsl from './shaders/bloom.wgsl?raw';
import brdfWgsl from './shaders/brdf.wgsl?raw';
import compositeWgsl from './shaders/composite.wgsl?raw';
import gtaoWgsl from './shaders/gtao.wgsl?raw';
import commonWgsl from './shaders/post-common.wgsl?raw';
import skyWgsl from './shaders/sky.wgsl?raw';
import tonemapWgsl from './shaders/tonemap.wgsl?raw';
import { type TextureBinding, placeholderView } from './texture-store.ts';
import type { WaterRenderer } from './water-renderer.ts';

/** byte size of `Post` in post-common.wgsl */
const POST_BYTES = 57 * 16;
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
 * modified ACES, Khronos PBR Neutral, or a clamp. the game's colour grading applies under the first two
 */
export const TONEMAPPERS = ['game', 'neutral', 'none'] as const;

export type Tonemapper = (typeof TONEMAPPERS)[number];

/** what the post chain shows; mirrors the viewer's look options */
export interface PostSettings {
	/** exposure compensation, EV */
	exposure: number;
	/** follow the game's auto exposure on top of the compensation */
	autoExposure: boolean;
	tonemapper: Tonemapper;
	sky: boolean;
	fog: boolean;
	aerialPerspective: boolean;
	ao: boolean;
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
		fog: false,
		aerialPerspective: false,
		ao: false,
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
 * @param sampleCount the main pass's sample count, which decides the depth texture's type
 * @returns a post pass's shader source: the shared BRDF terms and `Post` uniforms, then `parts`
 */
export const postShaderSource = (parts: string[], sampleCount: number): string =>
	[brdfWgsl, commonWgsl, ...parts]
		.join('\n')
		.replaceAll('DEPTH_TEXTURE', sampleCount > 1 ? 'texture_depth_multisampled_2d' : 'texture_depth_2d');

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
} as const;

interface Sized {
	width: number;
	height: number;
	version: number;
	sceneTextures: SceneTextures;
	/** half resolution: view depth, and the AO marched over it */
	aoDepth: GPUTexture;
	ao: GPUTexture;
	/** full resolution */
	aoBlurred: GPUTexture;
	/** a copy of the composited scene for the water to refract */
	background: GPUTexture;
	backgroundView: GPUTextureView;
	scene: GPUTexture;
	sceneView: GPUTextureView;
	/** the bloom levels, each half the previous one's size */
	down: GPUTexture[];
	/** each level's horizontal blur (none for the first) */
	blurred: GPUTexture[];
	up: GPUTexture[];
	bloomUniforms: GPUBuffer[];
	passes: {
		aoDepth: Pass;
		gtao: Pass;
		blur: Pass;
		composite: Pass;
		/** the prefilter, then two blurs per further level */
		down: Pass[];
		/** upsamples from the coarsest level, for the full chain and for one level fewer */
		up: { full: Pass[]; short: Pass[] };
	};
	/** the tonemap pass's groups; its target is the swapchain's current texture */
	tonemapGroups: GPUBindGroup[];
}

/** owns the post chain's targets, pipelines and uniforms */
export class PostProcess {
	/** the post exposure the game's auto exposure picks; the caller steps it each frame */
	readonly autoExposure: AutoExposure;
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
	/** the cloud panorama bound in the composite pass */
	#cloud: TextureBinding;
	#noCloud: TextureBinding;
	#lutsReady = false;

	/**
	 * @param device the device
	 * @param swapchainFormat the canvas format the final pass writes
	 * @param sampleCount the main pass's sample count
	 * @param environment the environment to start with
	 */
	constructor(
		device: GPUDevice,
		swapchainFormat: GPUTextureFormat,
		sampleCount: number,
		environment: Environment,
	) {
		this.#device = device;
		this.autoExposure = new AutoExposure(device);
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
			device.createShaderModule({ label, code: postShaderSource(parts, sampleCount) });
		const atmosphere = module('atmosphere', [atmosphereWgsl]);
		const gtao = module('gtao', [gtaoWgsl]);
		const composite = module('composite', [atmosphereWgsl, skyWgsl, compositeWgsl]);
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
		};
		return this.#device.createBindGroup({
			layout: pipeline.getBindGroupLayout(1),
			entries: reads.map((binding) => ({ binding, resource: resources[binding] })),
		});
	}

	/**
	 * @param pipeline a pass built from {@link postShaderSource} with atmosphere.wgsl and sky.wgsl that draws
	 *   the sky (it reads the sky-view LUT and its mean; the fog is analytic)
	 * @returns its groups 0 (uniforms) and 1 (atmosphere)
	 */
	#skyGroups(pipeline: GPURenderPipeline): GPUBindGroup[] {
		return [
			this.#uniformsGroup(pipeline),
			this.#atmosphereGroup(pipeline, [Lut.skyView, Lut.sampler, Lut.skyMean]),
		];
	}

	/** @returns bytes of the targets the chain holds */
	get bytes(): number {
		const sized = this.#sized;
		if (sized === null) {
			return 0;
		}
		const pixels = sized.width * sized.height;
		// the reduced AO depth and AO, the blurred AO, the scene and the water's background, and the bloom chain
		// (two quarter-size mips)
		return pixels * ((4 + 1) / AO_SCALE ** 2 + 1 + 8 + 8) + pixels * 8 * (2 / 3);
	}

	/** the composite pass's group 2: the main pass's outputs, the blurred AO and the cloud panorama */
	#sceneGroup(scene: SceneTextures, aoBlurred: GPUTexture): GPUBindGroup {
		return this.#device.createBindGroup({
			layout: this.#pipelines.composite.getBindGroupLayout(2),
			entries: [
				{ binding: 0, resource: scene.radiance },
				{ binding: 1, resource: scene.ambient },
				{ binding: 2, resource: aoBlurred.createView() },
				{ binding: 3, resource: scene.depth },
				{ binding: 4, resource: this.#cloud.view },
				{ binding: 5, resource: this.#cloud.sampler },
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
			sized.passes.composite.groups[2] = this.#sceneGroup(sized.sceneTextures, sized.aoBlurred);
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
			sized.scene,
			sized.background,
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

	#ensureSized(scene: SceneTextures, width: number, height: number): Sized {
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
		const sceneTexture = texture('hdr scene', width, height, HDR_FORMAT);
		const background = texture('hdr background', width, height, HDR_FORMAT);
		// the game's chain: sized as if the view were at most 1080 px tall, the first level at half that size,
		// with as many levels as half-resolution bloom gets (quarter resolution runs one fewer)
		const down: GPUTexture[] = [];
		const blurred: GPUTexture[] = [];
		const up: GPUTexture[] = [];
		{
			const scale = height > BLOOM_REFERENCE_HEIGHT ? BLOOM_REFERENCE_HEIGHT / height : 1;
			const count = bloomLevelCount(width * scale, height * scale, true);
			for (let i = 0; i < count; i++) {
				const w = Math.max(1, Math.round((width * scale) / 2 ** (i + 1)));
				const h = Math.max(1, Math.round((height * scale) / 2 ** (i + 1)));
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
		const downPasses: Pass[] = [];
		if (down.length > 0) {
			downPasses.push(
				bloomPass({ pipeline: p.prefilter, source: sceneTexture, high: null, target: down[0] }),
			);
		}
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
		let bloomResult = sceneTexture;
		if (down.length > 1) {
			bloomResult = up[0];
		} else if (down.length === 1) {
			bloomResult = down[0];
		}
		const sceneView = sceneTexture.createView();
		const sized: Sized = {
			width,
			height,
			version: scene.version,
			sceneTextures: scene,
			aoDepth,
			ao,
			aoBlurred,
			scene: sceneTexture,
			sceneView,
			background,
			backgroundView: background.createView(),
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
				composite: {
					pipeline: p.composite,
					groups: [...this.#skyGroups(p.composite), this.#sceneGroup(scene, aoBlurred)],
					target: sceneView,
				},
				down: downPasses,
				up: { full: fullUp, short: shortUp },
			},
			tonemapGroups: [
				this.#uniformsGroup(p.tonemap),
				device.createBindGroup({
					layout: p.tonemap.getBindGroupLayout(1),
					entries: [
						{ binding: 0, resource: sceneView },
						{ binding: 1, resource: bloomResult.createView() },
						{ binding: 2, resource: this.#sampler },
					],
				}),
			],
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
		const fog = environment.fog;
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
		set(29, [...(vignette?.colour ?? [0, 0, 0]), vignette?.roundness ?? 1]);
		set(30, [...(vignette?.centre ?? [0.5, 0.5]), vignette?.rounded ? 1 : 0, 0]);
		const cloud = environment.cloud;
		set(31, [cloud?.rotation ?? 0, cloud?.contrast ?? 1, cloud?.singleChannel ? 1 : 0, 0]);
		set(32, cloud?.tint ?? [1, 1, 1, 1]);
		set(33, [cloud?.opacity[0] ?? 1, cloud?.opacity[1] ?? 1, 0, 0]);
		const g = environment.grading;
		set(41, [...g.colourBalance, g.postExposure]);
		set(42, [...g.colourFilter, 0]);
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
	#writeFrame(camera: Camera, width: number, height: number, settings: PostSettings, frame: number): void {
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
				settings.fog && environment.fog.enabled ? 1 : 0,
				settings.aerialPerspective ? 1 : 0,
				settings.bloom && bloom !== null ? 1 : 0,
			],
			27 * 4,
		);
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
	 * @param input the resolved main-pass textures, the camera, sizes and settings
	 */
	encode(
		encoder: GPUCommandEncoder,
		input: {
			scene: SceneTextures;
			swapchain: GPUTextureView;
			camera: Camera;
			width: number;
			height: number;
			settings: PostSettings;
			frame: number;
			/** drawn after compositing, when it has surfaces */
			water: WaterRenderer;
		},
	): void {
		const { scene, swapchain, camera, width, height, frame } = input;
		const settings = effectiveSettings(input.settings);
		const sized = this.#ensureSized(scene, width, height);
		this.#writeFrame(camera, width, height, settings, frame);
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
		this.#run(encoder, 'composite', sized.passes.composite);
		const water = input.water;
		if (settings.debugView === 'lit' && water.active) {
			encoder.copyTextureToTexture({ texture: sized.scene }, { texture: sized.background }, [width, height]);
			water.encode(encoder, sized.sceneView, {
				scene,
				background: sized.backgroundView,
				postGroups: (pipeline) => this.#skyGroups(pipeline),
				cloud: this.#cloud,
				version: sized.version,
			});
		}
		if (settings.autoExposure) {
			this.autoExposure.encode(
				encoder,
				{ view: sized.sceneView, width, height },
				this.#environment.autoExposure,
			);
		}
		if (settings.bloom) {
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
			groups: sized.tonemapGroups,
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
		this.autoExposure.destroy();
	}
}
