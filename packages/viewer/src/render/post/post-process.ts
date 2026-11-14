import type { CelestialLook, CelestialTextureSlot } from '../../environment/celestial-look.ts';
import type { Environment } from '../../environment/environment.ts';
import type { LensFlareLook } from '../../environment/lens-flare-look.ts';
import { createUniformBuffer } from '../../gfx/buffers.ts';
import type { PipelineCache } from '../../gfx/pipeline-cache.ts';
import { LINEAR_CLAMP, sampler as sharedSampler } from '../../gfx/samplers.ts';
import { TextureSet } from '../../gfx/texture-set.ts';
import type { Camera } from '../../scene/camera.ts';
import type { StreamedTexture } from '../../streaming/texture-requests.ts';
import { type SceneTextures, HDR_FORMAT } from '../frame/render-targets.ts';
import { AtmosphereLuts, SkyBinding } from '../sky/atmosphere-luts.ts';
import { CelestialLayer } from '../sky/celestial.ts';
import type { VolumetricFog } from '../sky/volumetric-fog.ts';
import type { TextureBinding } from '../textures/texture-store.ts';
import type { WaterContext, WaterRenderer } from '../water/water-renderer.ts';

import { AmbientOcclusion } from './ambient-occlusion.ts';
import { AutoExposure } from './auto-exposure.ts';
import { Bloom } from './bloom.ts';
import { Composite } from './composite.ts';
import { LensFlares } from './lens-flare.ts';
import { LightShafts } from './light-shafts.ts';
import { POST_BYTES, writeEnvironmentUniforms, writeFrameUniforms } from './post-uniforms.ts';
import { ScreenSpaceReflections } from './screen-space-reflections.ts';
import { type PostSettings, effectiveSettings, postExposure } from './settings.ts';
import { TemporalAA } from './temporal-aa.ts';
import { Tonemap } from './tonemap.ts';

/** the targets sized with the scene textures */
interface Sized {
	/** the scene textures' version the targets were made for */
	version: number;
	/** the composited scene at the render size, which the temporal resolve reads */
	scene: GPUTexture;
	sceneView: GPUTextureView;
	/** views of the temporal histories, the antialiased scene at the output size */
	historyViews: [GPUTextureView, GPUTextureView];
}

/** what {@link PostProcess.encodeComposite} leaves for the passes over the composited scene */
export interface CompositedScene {
	/** the composited HDR scene, which those passes draw over */
	target: GPUTextureView;
	/** what the water pass reads, `null` when no water draws this frame */
	water: WaterContext | null;
}

/**
 * owns the post chain's shared uniforms and sampler, and runs its passes in order: {@link encodeComposite},
 * then the caller's passes over the composited scene, then {@link encodeAfterScene}
 */
export class PostProcess {
	/**
	 * explicit layouts of the post uniforms and of the sky's reads (the sky-view LUT, its sampler and the
	 * volumetric fog, at their atmosphere.wgsl and sky.wgsl bindings), for passes that also bind the main
	 * pass's frame group and so can't use `auto` layouts
	 */
	readonly skyLayouts: { uniforms: GPUBindGroupLayout; sky: GPUBindGroupLayout };
	/**
	 * what transparent draws fog themselves with (fog.wgsl): the post uniforms, written once a frame by
	 * {@link encodeComposite}, the volumetric fog and the bilinear clamping sampler
	 */
	readonly fogInputs: { uniforms: GPUBuffer; froxels: GPUTextureView; sampler: GPUSampler };
	#device: GPUDevice;
	#uniforms: GPUBuffer;
	#data = new Float32Array(POST_BYTES / 4);
	#luts: AtmosphereLuts;
	#ao: AmbientOcclusion;
	#reflections: ScreenSpaceReflections;
	/** the nebula, planets and clouds the composite draws on the sky */
	#celestial: CelestialLayer;
	#composite: Composite;
	#lightShafts: LightShafts;
	#lensFlares: LensFlares;
	#taa: TemporalAA;
	#autoExposure: AutoExposure;
	#bloom: Bloom;
	#tonemap: Tonemap;
	/** the composited scene */
	#targets: TextureSet;
	#sized: Sized | null = null;
	#environment: Environment;
	/** the volumetric fog the composite and water passes add in front */
	#fog: VolumetricFog;
	/** groups for {@link skyLayouts} */
	#skyLayoutGroups: { uniforms: GPUBindGroup; sky: GPUBindGroup };

	/**
	 * @param device the device
	 * @param pipelines the pipeline cache, which compiles the auto exposure's histogram pass
	 * @param swapchainFormat the canvas format the final pass writes
	 * @param environment the environment to start with
	 * @param fog the volumetric fog, which the caller encodes before {@link encodeComposite}
	 */
	constructor(
		device: GPUDevice,
		pipelines: PipelineCache,
		swapchainFormat: GPUTextureFormat,
		environment: Environment,
		fog: VolumetricFog,
	) {
		this.#device = device;
		this.#fog = fog;
		this.#targets = new TextureSet(device);
		this.#uniforms = createUniformBuffer(device, 'post uniforms', POST_BYTES);
		const sampler = sharedSampler(device, LINEAR_CLAMP);
		const postUniforms = this.#uniforms;
		this.fogInputs = { uniforms: postUniforms, froxels: fog.view, sampler };
		this.#autoExposure = new AutoExposure(device, pipelines);
		this.#luts = new AtmosphereLuts(device, postUniforms, sampler);
		this.#ao = new AmbientOcclusion(device, postUniforms);
		this.#reflections = new ScreenSpaceReflections(device, postUniforms);
		this.#celestial = new CelestialLayer(device, { postUniforms, sampler });
		this.#composite = new Composite(device, {
			postUniforms,
			sampler,
			skyView: this.#luts.skyView,
			froxels: fog.view,
		});
		this.#lightShafts = new LightShafts(device, postUniforms);
		this.#lensFlares = new LensFlares(device);
		this.#taa = new TemporalAA(device, postUniforms);
		this.#bloom = new Bloom(device, postUniforms, sampler);
		this.#tonemap = new Tonemap(device, postUniforms, sampler, swapchainFormat);
		this.#environment = environment;
		writeEnvironmentUniforms(this.#data, environment);

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
					texture(SkyBinding.skyView, '2d'),
					{ binding: SkyBinding.sampler, visibility: fragment, sampler: { type: 'filtering' } },
					texture(SkyBinding.froxels, '3d'),
				],
			});
			this.skyLayouts = { uniforms, sky };
			this.#skyLayoutGroups = {
				uniforms: device.createBindGroup({
					layout: uniforms,
					entries: [{ binding: 0, resource: { buffer: postUniforms } }],
				}),
				sky: device.createBindGroup({
					layout: sky,
					entries: [
						{ binding: SkyBinding.skyView, resource: this.#luts.skyView },
						{ binding: SkyBinding.sampler, resource: sampler },
						{ binding: SkyBinding.froxels, resource: fog.view },
					],
				}),
			};
		}
	}

	/** @returns bytes of the targets the chain holds */
	get bytes(): number {
		// the composited scene, and each pass's own targets
		return (
			this.#targets.bytes +
			this.#ao.bytes +
			this.#bloom.bytes +
			this.#taa.bytes +
			this.#reflections.bytes +
			this.#lightShafts.bytes
		);
	}

	/**
	 * binds the sky's textures as they stream in; what isn't resident yet doesn't draw.
	 *
	 * @param textures the cloud panorama and the height fog's flow noise (`null` for none), each celestial
	 *   slot's binding, and each lens flare image's streamed texture by texture-table id
	 */
	setSkyTextures(textures: {
		cloud: TextureBinding | null;
		flowNoise: TextureBinding | null;
		celestial: (slot: CelestialTextureSlot) => TextureBinding | null;
		lensFlare: (texture: number) => StreamedTexture | null;
	}): void {
		this.#celestial.setCloud(textures.cloud);
		this.#composite.setFlowNoise(textures.flowNoise);
		this.#celestial.setTextures(textures.celestial);
		this.#lensFlares.setTextures(textures.lensFlare);
	}

	/** unbinds the sky's textures, before the store that holds them is destroyed */
	clearSkyTextures(): void {
		this.setSkyTextures({ cloud: null, flowNoise: null, celestial: () => null, lensFlare: () => null });
	}

	/**
	 * @param settings the settings in effect
	 * @returns whether the composite draws drifting fog, which changes from frame to frame
	 */
	#drifts(settings: PostSettings): boolean {
		return (
			settings.flowNoise &&
			settings.heightFog &&
			this.#environment.heightFog.flowNoise !== null &&
			this.#composite.hasFlowNoise
		);
	}

	/**
	 * sets the environment; the atmosphere LUTs are rebuilt on the next frame.
	 *
	 * @param environment the shown level's environment
	 * @param looks what the environment draws beyond the atmosphere, and its sun's lens flare (`null`: none)
	 */
	setEnvironment(
		environment: Environment,
		looks: { celestial: CelestialLook; lensFlare: LensFlareLook | null },
	): void {
		this.#environment = environment;
		this.#luts.invalidate();
		writeEnvironmentUniforms(this.#data, environment);
		this.#celestial.setLook(looks.celestial);
		this.#lensFlares.setLook(looks.lensFlare);
	}

	/** drops the temporal histories (antialiasing, reflections) after a cut to somewhere else */
	reset(): void {
		this.#taa.reset();
		this.#reflections.reset();
	}

	/** @param enabled whether the temporal antialiasing jitters and accumulates; off passes the frame through */
	setAntialiasing(enabled: boolean): void {
		this.#taa.enabled = enabled;
	}

	/** drops the antialiasing's history alone, after a change of what the view shows */
	resetAntialiasing(): void {
		this.#taa.reset();
	}

	/**
	 * advances the antialiasing's jitter. call once per rendered frame, before writing the main pass's
	 * uniforms.
	 *
	 * @param width the main pass's width, px
	 * @param height the main pass's height, px
	 * @param outputHeight the output height, px
	 * @returns this frame's jitter in NDC, to add to the projection (zero with antialiasing off)
	 */
	nextJitter(width: number, height: number, outputHeight: number): readonly [x: number, y: number] {
		return this.#taa.nextJitter(width, height, outputHeight);
	}

	/** @returns this frame's place in the jitter cycle, from 1; 0 with antialiasing off */
	get jitterPhase(): number {
		return this.#taa.phase;
	}

	/** jumps the auto exposure straight to its next reading (a new package or level) */
	resetExposure(): void {
		this.#autoExposure.reset();
	}

	/**
	 * moves the auto exposure towards its target. call once per frame, before deciding whether to render.
	 *
	 * @param settings the post settings
	 * @param dt seconds since the last frame
	 * @param options.metering whether this frame's histogram may move the target
	 * @returns whether the exposure is still moving, so the caller keeps rendering
	 */
	adaptExposure(settings: PostSettings, dt: number, options: { metering: boolean }): boolean {
		const look = effectiveSettings(settings).autoExposure ? this.#environment.autoExposure : null;
		return this.#autoExposure.update(look, dt, options);
	}

	/** @returns the auto exposure's adjustment, EV */
	get exposureEv(): number {
		return Math.log2(this.#autoExposure.exposure);
	}

	/**
	 * @param settings the post settings
	 * @returns the linear exposure the chain shows the scene at; 1 in debug views
	 */
	exposure(settings: PostSettings): number {
		return postExposure(effectiveSettings(settings), this.#autoExposure);
	}

	/** starts reading back this frame's auto exposure histogram; call after submitting */
	afterSubmit(): void {
		this.#autoExposure.afterSubmit();
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
		this.#targets.destroy();
		const sceneTexture = this.#targets.create({
			label: 'hdr scene',
			size: [width, height],
			format: HDR_FORMAT,
			usage:
				GPUTextureUsage.RENDER_ATTACHMENT |
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_SRC |
				GPUTextureUsage.COPY_DST,
		});
		const sceneView = sceneTexture.createView();
		this.#ao.resize({ depth: scene.depth, width, height });
		// the reflections run before compositing, so the scene they read still holds last frame's
		this.#reflections.resize({ scene, previousScene: sceneView, width, height });
		this.#celestial.resize({ depth: scene.depth, target: scene.reflection });
		this.#composite.resize({
			scene,
			ao: this.#ao.output,
			reflections: this.#reflections.output.createView(),
			target: sceneView,
		});
		this.#lightShafts.resize({ scene, composited: sceneView, width, height });
		this.#lensFlares.resize({ scene, composited: sceneView });
		this.#taa.resize({ scene: sceneView, depth: scene.depth, width, height, outputWidth, outputHeight });
		const histories = this.#taa.histories;
		this.#bloom.resize({ histories, outputWidth, outputHeight });
		this.#tonemap.resize({ histories, bloom: this.#bloom.result });
		const sized: Sized = {
			version: scene.version,
			scene: sceneTexture,
			sceneView,
			historyViews: [histories[0].createView(), histories[1].createView()],
		};
		this.#sized = sized;
		return sized;
	}

	/**
	 * encodes the chain from the main pass's outputs through the composite: the atmosphere LUTs, AO,
	 * reflections, the celestial layers and the water's depth. the caller then draws what goes over the
	 * composited scene (the water, the transparent pass, screen effects) and finishes with
	 * {@link encodeAfterScene}.
	 *
	 * @param encoder this frame's encoder, after the main pass
	 * @param input the main pass's textures, the camera (unjittered), the render and output sizes and settings
	 * @returns the composited scene, and what the water pass reads when water draws this frame
	 */
	encodeComposite(
		encoder: GPUCommandEncoder,
		input: {
			scene: SceneTextures;
			camera: Camera;
			width: number;
			height: number;
			outputWidth: number;
			outputHeight: number;
			settings: PostSettings;
			/** the viewer's animation time, s, which the flow noise, water and clouds move by */
			time: number;
			frame: number;
			/** whether the volumetric fog was encoded this frame */
			froxels: boolean;
			/** drawn over the composite when it has surfaces */
			water: WaterRenderer;
			/** the main pass's frame group and its uniforms' offset, which the water pass lights with */
			frameGroup: { group: GPUBindGroup; offset: number };
		},
	): CompositedScene {
		const { scene, camera, width, height, outputWidth, outputHeight } = input;
		const settings = effectiveSettings(input.settings);
		const environment = this.#environment;
		const sized = this.#ensureSized(scene, { width, height, outputWidth, outputHeight });
		writeFrameUniforms(this.#data, {
			camera,
			width,
			height,
			time: input.time,
			frame: input.frame,
			jitter: this.#taa.jitter,
			settings,
			exposure: postExposure(settings, this.#autoExposure),
			environment,
			froxels: input.froxels && settings.heightFog ? this.#fog.sampling : null,
			flowNoise: this.#drifts(settings) ? environment.heightFog.flowNoise : null,
			cloud: this.#celestial.hasCloud,
		});
		this.#device.queue.writeBuffer(this.#uniforms, 0, this.#data);
		this.#luts.encode(encoder, settings.sky);
		if (settings.ao && environment.post.ao !== null) {
			this.#ao.encode(encoder);
		}
		// with reflections off this still clears what composite reads
		this.#reflections.encode(encoder, { camera, look: environment.post.ssr, enabled: settings.reflections });
		this.#celestial.encode(encoder, {
			eye: camera.position,
			sun: environment.sunDirection,
			sunIlluminance: environment.sunIlluminance,
		});
		const water = input.water;
		let waterContext: WaterContext | null = null;
		if (settings.debugView === 'lit' && water.active) {
			waterContext = {
				scene,
				background: scene.radiance,
				frame: input.frameGroup,
				postUniforms: this.#skyLayoutGroups.uniforms,
				sky: this.#skyLayoutGroups.sky,
				version: sized.version,
				width,
				height,
				foam: false,
			};
		}
		if (waterContext !== null) {
			water.encodeDepth(encoder, waterContext);
		} else {
			water.clearDepth(encoder, scene);
		}
		this.#composite.encode(encoder);
		return { target: sized.sceneView, water: waterContext };
	}

	/**
	 * copies the composited scene into the main pass's radiance target, which nothing reads after compositing,
	 * for the passes over it that refract it (the water, refracting effects)
	 *
	 * @param encoder this frame's encoder, after {@link encodeComposite}
	 * @param scene the main pass's textures
	 */
	copyComposite(encoder: GPUCommandEncoder, scene: SceneTextures): void {
		const sized = this.#sized;
		if (sized === null) {
			return;
		}
		encoder.copyTextureToTexture({ texture: sized.scene }, { texture: scene.radianceTexture }, [
			sized.scene.width,
			sized.scene.height,
		]);
	}

	/**
	 * encodes the rest of the chain over the composited scene, to the swapchain: light shafts, lens flare,
	 * temporal antialiasing, auto exposure, bloom and tonemapping
	 *
	 * @param encoder this frame's encoder, after the passes over the composited scene
	 * @param input the swapchain, the camera (unjittered), the render and output sizes and settings, as given
	 *   to {@link encodeComposite}
	 */
	encodeAfterScene(
		encoder: GPUCommandEncoder,
		input: {
			swapchain: GPUTextureView;
			camera: Camera;
			width: number;
			height: number;
			outputWidth: number;
			outputHeight: number;
			settings: PostSettings;
		},
	): void {
		const { swapchain, camera, width, height, outputWidth, outputHeight } = input;
		const settings = effectiveSettings(input.settings);
		const environment = this.#environment;
		const sized = this.#sized;
		if (sized === null) {
			return;
		}
		if (settings.debugView === 'lit') {
			this.#lightShafts.encode(encoder, { camera, aspect: width / height, look: environment.lightShaft });
			// the game draws the flare after the shafts, which don't see it
			this.#lensFlares.encode(encoder, { camera, width, height });
		}
		const resolved = this.#taa.encode(encoder, camera);
		if (settings.autoExposure) {
			this.#autoExposure.encode(
				encoder,
				{ view: sized.historyViews[resolved], width: outputWidth, height: outputHeight },
				environment.autoExposure,
			);
		}
		if (settings.bloom) {
			this.#bloom.encode(encoder, { history: resolved, half: environment.post.bloom?.half ?? true });
		}
		this.#tonemap.encode(encoder, { swapchain, history: resolved });
	}

	/** frees the chain's GPU resources */
	destroy(): void {
		this.#targets.destroy();
		this.#luts.destroy();
		this.#ao.destroy();
		this.#bloom.destroy();
		this.#uniforms.destroy();
		this.#celestial.destroy();
		this.#autoExposure.destroy();
		this.#taa.destroy();
		this.#reflections.destroy();
		this.#lightShafts.destroy();
		this.#lensFlares.destroy();
	}
}
