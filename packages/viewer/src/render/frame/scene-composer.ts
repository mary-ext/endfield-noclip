import type { RainConfig, RainPresetting } from '@endfield-noclip/package-format/environment';

import type { TgpuRoot } from 'typegpu';

import type { CelestialLook, CelestialTextureSlot } from '../../environment/celestial-look.ts';
import type { Environment } from '../../environment/environment.ts';
import { createUniformBuffer } from '../../gfx/buffers.ts';
import type { PipelineCache } from '../../gfx/pipeline-cache.ts';
import { LINEAR_CLAMP, sampler as sharedSampler } from '../../gfx/samplers.ts';
import { TextureSet } from '../../gfx/texture-set.ts';
import type { Camera } from '../../scene/camera.ts';
import { POST_BYTES, PostSlot, postUniformLayout } from '../core/post-schema.ts';
import { writeEnvironmentUniforms, writeFrameUniforms } from '../core/post-uniforms.ts';
import { HDR_FORMAT, type SceneTextures } from '../core/render-targets.ts';
import { type PostSettings, effectiveSettings } from '../core/settings.ts';
import { DeferredLighting } from '../lighting/deferred-lighting.ts';
import { AmbientOcclusion } from '../post/ambient-occlusion.ts';
import { ScreenSpaceReflections } from '../post/screen-space-reflections.ts';
import { AtmosphereLuts } from '../sky/atmosphere-luts.ts';
import { skyReadLayout } from '../sky/atmosphere-shader.ts';
import { CelestialLayer } from '../sky/celestial.ts';
import { Composite } from '../sky/composite.ts';
import type { VolumetricFog } from '../sky/volumetric-fog.ts';
import type { TextureBinding } from '../textures/texture-store.ts';
import type { VerticalOcclusionMap } from '../weather/vertical-occlusion.ts';

/** float offset and length of the atmosphere medium uniforms read by transmittance and multi-scattering LUTs */
const ATMO_START = PostSlot.planet * 4;
const ATMO_END = (PostSlot.groundAlbedo + 1) * 4;

/** the composited HDR target sized with the scene textures */
export interface CompositedTarget {
	/** the scene textures' version this target was made for */
	version: number;
	texture: GPUTexture;
	view: GPUTextureView;
}

/**
 * owns the shared `Post` uniform buffer, sky/fog layouts, atmosphere LUTs, celestial layers, ambient
 * occlusion, screen-space reflections, deferred lighting, and scene-fog compositing
 */
export class SceneComposer {
	/** the shared `Post` uniform buffer, read by sky, fog, deferred lighting, water, weather, and post passes */
	readonly uniforms: GPUBuffer;
	/** the bilinear clamping sampler shared with post and fog passes */
	readonly sampler: GPUSampler;
	/**
	 * explicit layouts of the post uniforms and of the sky's reads (the sky-view LUT, its sampler and the
	 * volumetric fog, at their atmosphere-shader.ts bindings), for passes that also bind the main pass's frame
	 * group and so can't use `auto` layouts
	 */
	readonly skyLayouts: { uniforms: GPUBindGroupLayout; sky: GPUBindGroupLayout };
	/** bind groups for {@link skyLayouts}, bound by the water pass */
	readonly skyLayoutGroups: { uniforms: GPUBindGroup; sky: GPUBindGroup };
	/**
	 * what transparent draws fog themselves with (fog-shader.ts): the post uniforms, written once a frame by
	 * {@link encodePreDeferred}, the volumetric fog and the bilinear clamping sampler
	 */
	readonly fogInputs: { uniforms: GPUBuffer; froxels: GPUTextureView; sampler: GPUSampler };
	#device: GPUDevice;
	#data = new Float32Array(POST_BYTES / 4);
	#prevAtmo = new Float32Array(ATMO_END - ATMO_START);
	#luts: AtmosphereLuts;
	#ao: AmbientOcclusion;
	#reflections: ScreenSpaceReflections;
	#celestial: CelestialLayer;
	#deferred: DeferredLighting;
	#composite: Composite;
	#targets: TextureSet;
	#sized: CompositedTarget | null = null;
	#environment: Environment;
	#fog: VolumetricFog;

	/**
	 * @param root the TypeGPU root
	 * @param pipelines the pipeline cache
	 * @param environment the environment to start with
	 * @param fog the volumetric fog
	 * @param frameLayout group 0 (`frame`) bind group layout
	 * @param verticalOcclusion the top-down vertical occlusion depth map for rain wetness
	 */
	constructor(
		root: TgpuRoot,
		pipelines: PipelineCache,
		environment: Environment,
		fog: VolumetricFog,
		frameLayout: GPUBindGroupLayout,
		verticalOcclusion: VerticalOcclusionMap,
	) {
		const device = root.device;
		this.#device = device;
		this.#fog = fog;
		this.#targets = new TextureSet(device);
		this.uniforms = createUniformBuffer(device, 'post uniforms', POST_BYTES);
		this.sampler = sharedSampler(device, LINEAR_CLAMP);
		const postUniforms = this.uniforms;
		const sampler = this.sampler;
		this.fogInputs = { uniforms: postUniforms, froxels: fog.view, sampler };
		this.#luts = new AtmosphereLuts(root, pipelines, postUniforms, sampler);
		this.#ao = new AmbientOcclusion(root, pipelines, postUniforms);
		this.#reflections = new ScreenSpaceReflections(root, pipelines, postUniforms);
		this.#celestial = new CelestialLayer(root, pipelines, { postUniforms, sampler });
		this.#composite = new Composite(root, pipelines, {
			postUniforms,
			sampler,
			skyView: this.#luts.skyView,
			froxels: fog.view,
		});
		this.#environment = environment;
		writeEnvironmentUniforms(this.#data, environment);

		this.skyLayouts = {
			uniforms: root.unwrap(postUniformLayout),
			sky: root.unwrap(skyReadLayout),
		};
		this.skyLayoutGroups = {
			uniforms: root.unwrap(root.createBindGroup(postUniformLayout, { post: postUniforms })),
			sky: root.unwrap(
				root.createBindGroup(skyReadLayout, {
					skyView: this.#luts.skyView,
					lutSampler: sampler,
					froxels: fog.view,
				}),
			),
		};
		this.#deferred = new DeferredLighting(root, pipelines, frameLayout, postUniforms, verticalOcclusion);
	}

	/** @returns bytes of the composited target, LUTs, AO, and reflection targets */
	get bytes(): number {
		return this.#targets.bytes + this.#luts.bytes + this.#ao.bytes + this.#reflections.bytes;
	}

	/**
	 * binds the sky's streamed textures; what isn't resident yet doesn't draw
	 *
	 * @param textures cloud panorama, height-fog flow noise, and celestial slot lookup
	 */
	setSkyTextures(textures: {
		cloud: TextureBinding | null;
		flowNoise: TextureBinding | null;
		celestial: (slot: CelestialTextureSlot) => TextureBinding | null;
	}): void {
		this.#celestial.setCloud(textures.cloud);
		this.#composite.setFlowNoise(textures.flowNoise);
		this.#celestial.setTextures(textures.celestial);
	}

	/**
	 * binds the rain wetness textures (3D jitter noise, ripple flipbook, wall vertical flow) as they stream in
	 *
	 * @param textures the wetness textures, `null` when not resident
	 */
	setWetnessTextures(textures: {
		noise: TextureBinding | null;
		ripple: TextureBinding | null;
		flow: TextureBinding | null;
	}): void {
		this.#deferred.setWetnessTextures(textures);
	}

	/**
	 * uploads this frame's high-quality rain wetness uniforms
	 *
	 * @param rain the blended rain config, or `null` when dry
	 * @param presetting the package's rain presetting asset, or `null` when absent
	 * @param occlusion the vertical occlusion map as fitted for this frame
	 * @param time the viewer's animation clock, s
	 */
	updateWetness(
		rain: RainConfig | null,
		presetting: RainPresetting | null,
		occlusion: VerticalOcclusionMap,
		time: number,
	): void {
		this.#deferred.updateWetness(rain, presetting, occlusion, time);
	}

	/** unbinds the sky and wetness textures before the store that holds them is destroyed */
	clearTextures(): void {
		this.setSkyTextures({ cloud: null, flowNoise: null, celestial: () => null });
		this.setWetnessTextures({ noise: null, ripple: null, flow: null });
	}

	/**
	 * sets the environment; the atmosphere LUTs rebuild on the next frame if atmosphere parameters changed
	 *
	 * @param environment the shown level's environment
	 * @param celestial what the environment draws beyond the atmosphere
	 */
	setEnvironment(environment: Environment, celestial: CelestialLook): void {
		this.#environment = environment;
		const data = this.#data;
		const prev = this.#prevAtmo;
		for (let i = 0; i < prev.length; i++) {
			prev[i] = data[ATMO_START + i];
		}
		writeEnvironmentUniforms(data, environment);
		for (let i = 0; i < prev.length; i++) {
			if (data[ATMO_START + i] !== prev[i]) {
				this.#luts.invalidate();
				break;
			}
		}
		this.#celestial.setLook(celestial);
	}

	/** drops reflection history after a camera cut */
	reset(): void {
		this.#reflections.reset();
	}

	/**
	 * creates or returns the composited HDR target for `scene` and resizes AO, SSR, celestial, deferred
	 * lighting, and composite once `historyViews` are ready
	 *
	 * @param scene the main pass's textures
	 * @param width render width, px
	 * @param height render height, px
	 * @returns the composited HDR target
	 */
	ensureTarget(scene: SceneTextures, width: number, height: number): CompositedTarget {
		const current = this.#sized;
		if (current !== null && current.version === scene.version) {
			return current;
		}
		this.#targets.destroy();
		const texture = this.#targets.create({
			label: 'hdr scene',
			size: [width, height],
			format: HDR_FORMAT,
			usage:
				GPUTextureUsage.RENDER_ATTACHMENT |
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_SRC |
				GPUTextureUsage.COPY_DST,
		});
		const sized: CompositedTarget = {
			version: scene.version,
			texture,
			view: texture.createView(),
		};
		this.#sized = sized;
		return sized;
	}

	/**
	 * resizes AO, SSR, celestial, deferred lighting, and composite bind groups to match `scene` and
	 * `historyViews`
	 *
	 * @param scene the main pass's textures
	 * @param input render size, composited target view, and TAA history views for SSR
	 */
	resizePasses(
		scene: SceneTextures,
		input: {
			width: number;
			height: number;
			target: GPUTextureView;
			historyViews: [GPUTextureView, GPUTextureView];
		},
	): void {
		const { width, height, target, historyViews } = input;
		this.#ao.resize({ depth: scene.depth, gbufferB: scene.gbufferB, width, height });
		this.#reflections.resize({ scene, previousScenes: historyViews, width, height });
		this.#celestial.resize({ depth: scene.depth, target: scene.lit });
		this.#deferred.resize({
			scene,
			ao: this.#ao.output,
			reflections: this.#reflections.output.createView(),
		});
		this.#composite.resize({ scene, target });
	}

	/**
	 * writes the shared `Post` frame uniforms and encodes atmosphere LUTs, AO, SSR, and celestial passes
	 *
	 * @param encoder this frame's encoder, after the main pass
	 * @param input camera, size, clocks, jitter, exposure, settings, and previous TAA history index
	 */
	encodePreDeferred(
		encoder: GPUCommandEncoder,
		input: {
			camera: Camera;
			width: number;
			height: number;
			time: number;
			frame: number;
			jitter: readonly [number, number];
			exposure: number;
			settings: PostSettings;
			froxels: boolean;
			previousScene: number;
		},
	): void {
		const settings = effectiveSettings(input.settings);
		const environment = this.#environment;
		const drifts =
			settings.flowNoise &&
			settings.heightFog &&
			environment.heightFog.flowNoise !== null &&
			this.#composite.hasFlowNoise;
		writeFrameUniforms(this.#data, {
			camera: input.camera,
			width: input.width,
			height: input.height,
			time: input.time,
			frame: input.frame,
			jitter: input.jitter,
			settings,
			exposure: input.exposure,
			environment,
			froxels: input.froxels && settings.heightFog ? this.#fog.sampling : null,
			flowNoise: drifts ? environment.heightFog.flowNoise : null,
			cloud: this.#celestial.hasCloud,
		});
		this.#device.queue.writeBuffer(this.uniforms, 0, this.#data);
		this.#luts.encode(encoder, settings.sky);
		if (settings.ao && environment.post.ao !== null) {
			this.#ao.encode(encoder);
		}
		// with reflections off this still clears what composite reads
		this.#reflections.encode(encoder, {
			camera: input.camera,
			look: environment.post.ssr,
			enabled: settings.reflections,
			previousScene: input.previousScene,
		});
		this.#celestial.encode(encoder, {
			eye: input.camera.position,
			sun: environment.sunDirection,
			sunIlluminance: environment.sunIlluminance,
		});
	}

	/**
	 * encodes deferred lighting into `scene.lit` and fog/sky compositing into the HDR scene target
	 *
	 * @param encoder this frame's encoder, after water depth
	 * @param frameGroup group 0 (`frame`) and its dynamic uniform offset
	 */
	encodeDeferredAndComposite(
		encoder: GPUCommandEncoder,
		frameGroup: { group: GPUBindGroup; offset: number },
	): void {
		this.#deferred.encode(encoder, frameGroup);
		this.#composite.encode(encoder);
	}

	/**
	 * copies the composited scene into `scene.litTexture`, which nothing reads after compositing, for the
	 * passes over it that refract it (the water, refracting effects)
	 *
	 * @param encoder this frame's encoder, after {@link encodeDeferredAndComposite}
	 * @param scene the main pass's textures
	 */
	copyComposite(encoder: GPUCommandEncoder, scene: SceneTextures): void {
		const sized = this.#sized;
		if (sized === null) {
			return;
		}
		encoder.copyTextureToTexture({ texture: sized.texture }, { texture: scene.litTexture }, [
			sized.texture.width,
			sized.texture.height,
		]);
	}

	/** frees the composer's GPU resources */
	destroy(): void {
		this.#targets.destroy();
		this.#luts.destroy();
		this.#ao.destroy();
		this.#reflections.destroy();
		this.#celestial.destroy();
		this.#deferred.destroy();
		this.uniforms.destroy();
	}
}
