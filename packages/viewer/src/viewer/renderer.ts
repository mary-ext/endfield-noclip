import type { WeatherAssets } from '@endfield-noclip/package-format/environment';
import type { IrradianceRegionInfo, IrradianceTable } from '@endfield-noclip/package-format/irradiance';
import type { TerrainInfo } from '@endfield-noclip/package-format/terrain';

import type { TgpuRoot } from 'typegpu';

import type { GfxDevice } from '../gfx/device.ts';
import { GpuProfiler } from '../gfx/gpu-profiler.ts';
import { PipelineCache } from '../gfx/pipeline-cache.ts';
import { destroyPlaceholders } from '../gfx/placeholders.ts';
import { UniformRing } from '../gfx/uniform-ring.ts';
import { type BindLayouts, createBindLayouts } from '../render/core/bind-layouts.ts';
import { CAMERA_HISTORY_FLOATS, CameraHistory } from '../render/core/camera-history.ts';
import { FRAME_UNIFORM_BYTES, FrameOffsets } from '../render/core/frame-schema.ts';
import { RenderTargets } from '../render/core/render-targets.ts';
import { FrameBindings } from '../render/frame/frame-bindings.ts';
import {
	type FrameSettings,
	type FrameSystems,
	ShadowLayerCache,
	encodeFrame,
} from '../render/frame/frame-graph.ts';
import { type FrameUniformInputs, writeFrameUniforms } from '../render/frame/frame-uniform-writer.ts';
import { SceneComposer } from '../render/frame/scene-composer.ts';
import { InstanceRenderer } from '../render/instances/instance-renderer.ts';
import { IrradianceVolume } from '../render/lighting/irradiance-volume.ts';
import { type LocalLightFrame, LocalLights } from '../render/lighting/local-lights.ts';
import { ReflectionProbes } from '../render/lighting/reflection-probes.ts';
import { ShadowMap } from '../render/lighting/shadow-map.ts';
import { ClothSimulator } from '../render/meshes/cloth-simulator.ts';
import { MeshRenderer } from '../render/meshes/mesh-renderer.ts';
import { PostProcess } from '../render/post/post-process.ts';
import { VolumetricFog } from '../render/sky/volumetric-fog.ts';
import { TerrainRenderer } from '../render/terrain/terrain-renderer.ts';
import { WaterRenderer } from '../render/water/water-renderer.ts';
import { VerticalOcclusionMap } from '../render/weather/vertical-occlusion.ts';
import { WeatherRenderer } from '../render/weather/weather-renderer.ts';
import type { Camera } from '../scene/camera.ts';
import { SHADOW_LAYERS } from '../scene/shadow-volumes.ts';

import type { EnvironmentLook } from './environment-state.ts';
import type { FrameTimes } from './stats.ts';

const TERRAIN_SLOTS = 4096;
const INSTANCE_ROWS = 1_500_000;
/** the frame uniforms' local lights while they're off */
const NO_LOCAL_LIGHTS: LocalLightFrame = { count: 0, tilesX: 1, tilesY: 1 };

/** what {@link Renderer.render} draws */
export interface RenderInput {
	camera: Camera;
	settings: FrameSettings;
	/** the environment's look */
	look: EnvironmentLook;
	/** the frame counter */
	index: number;
	/** the animation clock, s */
	time: number;
	/** frame delta for GPU simulations, s (0 when paused) */
	dt: number;
	/** the wind clock (`Frame.wind.x`) */
	windClock: number;
	/** the loaded package's terrain, `null` or `undefined` for none */
	terrain: TerrainInfo | null | undefined;
	/** the loaded package's weather presetting assets, or `null` when absent */
	weather: WeatherAssets | null;
	revealRadii: FrameUniformInputs['revealRadii'];
	options: FrameUniformInputs['options'];
	/**
	 * the streamed content's state: a counter that rises whenever content arrives, and whether nothing is
	 * streaming in. local lights' shadow tiles are redrawn as their casters arrive
	 */
	content: { version: number; idle: boolean };
	/** where the CPU spans go */
	times: FrameTimes;
}

/** the GPU side of the viewer: the device's renderers and targets, and the frame they encode together */
export class Renderer {
	readonly device: GPUDevice;
	readonly root: TgpuRoot;
	readonly targets: RenderTargets;
	readonly pipelines: PipelineCache;
	readonly shadows: ShadowMap;
	readonly verticalOcclusion: VerticalOcclusionMap;
	/** the loaded package's irradiance volume; an empty one without a package */
	readonly irradiance: IrradianceVolume;
	readonly lights: LocalLights;
	readonly reflectionProbes: ReflectionProbes;
	/** group 0 for the main and shadow passes */
	readonly bindings: FrameBindings;
	readonly profiler: GpuProfiler;
	readonly terrain: TerrainRenderer;
	readonly cloth: ClothSimulator;
	readonly instances: InstanceRenderer;
	readonly meshes: MeshRenderer;
	readonly fog: VolumetricFog;
	readonly composer: SceneComposer;
	readonly post: PostProcess;
	readonly water: WaterRenderer;
	readonly weather: WeatherRenderer;
	/** the systems whose passes a frame encodes */
	readonly frame: FrameSystems;
	/** the systems whose GPU pools and targets the stats sum */
	readonly pools: readonly { readonly bytes: number }[];
	readonly #layouts: BindLayouts;
	readonly #ring: UniformRing;
	/** the systems that carry frames over (temporal antialiasing, reflections, fog), dropped on a cut */
	readonly #histories: readonly { reset(): void }[];
	/** the systems freed on {@link destroy}, in order */
	readonly #owned: readonly { destroy(): void }[];
	/** each shadow layer's uniforms offset this frame */
	readonly #cascadeOffsets: number[] = [];
	/** previous frame's unjittered camera and clocks, for dynamic object motion vectors */
	readonly #frameHistory = new CameraHistory();
	readonly #previous = new Float32Array(CAMERA_HISTORY_FLOATS);
	#prevTime = 0;
	#prevWindClock = 0;

	/**
	 * @param gfx the device
	 * @param canvas the canvas to present to
	 * @param look the environment to start with
	 * @param near the camera's near plane, m
	 */
	constructor(gfx: GfxDevice, canvas: HTMLCanvasElement, look: EnvironmentLook, near: number) {
		const device = gfx.device;
		this.device = device;
		this.root = gfx.root;
		this.targets = new RenderTargets(device, canvas, gfx.presentationFormat, {
			stencil: gfx.features.depth32floatStencil8,
		});
		this.#layouts = createBindLayouts(device);
		this.pipelines = new PipelineCache(device);
		// the main pass's frame, one per shadow layer, one for a local light's shadow tile, and one for vertical occlusion
		const alignment = device.limits.minUniformBufferOffsetAlignment;
		this.#ring = new UniformRing(
			device,
			Math.ceil(FRAME_UNIFORM_BYTES / alignment) * alignment * (3 + SHADOW_LAYERS),
			3,
		);
		this.shadows = new ShadowMap(device, { depthClipControl: gfx.features.depthClipControl });
		this.verticalOcclusion = new VerticalOcclusionMap(device);
		this.irradiance = new IrradianceVolume(this.root, this.pipelines);
		this.lights = new LocalLights(this.root, this.pipelines);
		this.reflectionProbes = new ReflectionProbes(device, { bc: gfx.features.textureCompressionBc });
		this.bindings = new FrameBindings(device, {
			coreLayout: this.#layouts.frameCore,
			layout: this.#layouts.frame,
			uniforms: this.#ring.buffer,
			shadows: this.shadows,
			irradiance: this.irradiance,
			lights: this.lights,
			reflectionProbes: this.reflectionProbes,
		});
		this.profiler = new GpuProfiler(device, gfx.features.timestampQuery);
		const layouts = this.#layouts;
		const format = this.targets.format;
		this.terrain = new TerrainRenderer(device, layouts, this.pipelines, format, {
			capacity: TERRAIN_SLOTS,
			bc: gfx.features.textureCompressionBc,
			shadow: this.shadows,
		});
		this.cloth = new ClothSimulator(this.root, this.pipelines);
		this.instances = new InstanceRenderer(device, layouts, this.pipelines, format, INSTANCE_ROWS, () => ({
			buffer: this.cloth.skeletonBuffer,
			prevBuffer: this.cloth.prevSkeletonBuffer,
			version: this.cloth.version,
		}));
		this.fog = new VolumetricFog(this.root, this.pipelines, layouts.frame);
		this.fog.setEnvironment(look.environment, near);
		this.composer = new SceneComposer(
			this.root,
			this.pipelines,
			look.environment,
			this.fog,
			layouts.frame,
			this.verticalOcclusion,
		);
		this.post = new PostProcess(this.root, this.pipelines, {
			swapchainFormat: gfx.presentationFormat,
			postUniforms: this.composer.uniforms,
			sampler: this.composer.sampler,
			environment: look.environment,
		});
		this.meshes = new MeshRenderer(this.root, layouts, this.pipelines, {
			instances: this.instances,
			format,
			shadow: this.shadows,
			fog: this.composer.fogInputs,
			features: gfx.features,
		});
		this.water = new WaterRenderer(this.root, this.pipelines, {
			frame: layouts.frame,
			...this.composer.skyLayouts,
		});
		this.weather = new WeatherRenderer(
			this.root,
			this.pipelines,
			layouts.frame,
			format.depth,
			this.composer.fogInputs,
			this.verticalOcclusion,
		);
		this.frame = {
			targets: this.targets,
			irradiance: this.irradiance,
			shadowMap: this.shadows,
			shadowLayers: new ShadowLayerCache(),
			lightShadows: this.lights.shadows,
			verticalOcclusion: this.verticalOcclusion,
			terrain: this.terrain,
			instances: this.instances,
			cloth: this.cloth,
			meshes: this.meshes,
			fog: this.fog,
			water: this.water,
			weather: this.weather,
			composer: this.composer,
			post: this.post,
		};
		this.pools = [
			this.terrain,
			this.instances,
			this.meshes,
			this.cloth,
			this.irradiance,
			this.lights,
			this.lights.shadows,
			this.water,
			this.targets,
			this.composer,
			this.post,
			this.fog,
			this.shadows,
			this.verticalOcclusion,
			this.weather,
			this.reflectionProbes,
			this.#ring,
		];
		this.#histories = [
			this.composer,
			this.post,
			this.fog,
			this.meshes,
			this.verticalOcclusion,
			this.weather,
			this.#frameHistory,
		];
		this.#owned = [
			this.post,
			this.composer,
			this.fog,
			this.lights,
			this.reflectionProbes,
			this.irradiance,
			this.water,
			this.weather,
			this.meshes,
			this.cloth,
			this.instances,
			this.terrain,
			this.verticalOcclusion,
			this.shadows,
			this.targets,
			this.#ring,
			this.profiler,
		];
	}

	/** drops what the passes carry over from earlier frames, after a cut to somewhere else */
	cut(): void {
		for (const history of this.#histories) {
			history.reset();
		}
	}

	/**
	 * swaps in a package's irradiance volume and rebinds the frame groups
	 *
	 * @param table the package's cells, empty for none
	 * @param regions the package's region bakes
	 */
	setIrradiance(table: IrradianceTable, regions: readonly IrradianceRegionInfo[]): void {
		this.irradiance.setPackage(table, regions);
		this.bindings.rebuild();
	}

	/**
	 * relights the post chain and the fog
	 *
	 * @param look the environment's new look
	 * @param near the camera's near plane, m
	 */
	setEnvironment(look: EnvironmentLook, near: number): void {
		this.composer.setEnvironment(look.environment, look.celestial);
		this.post.setEnvironment(look.environment, look.lensFlare);
		this.fog.setEnvironment(look.environment, near);
	}

	/**
	 * writes the frame uniforms, encodes the frame's passes and submits them
	 *
	 * @param input what to draw
	 * @returns the draws encoded
	 */
	render(input: RenderInput): number {
		const { camera, settings, look, times } = input;
		const ring = this.#ring;
		ring.beginFrame();
		const { width, height, outputWidth, outputHeight } = this.targets;
		// shadow tiles draw the sun's far-layer casters, so they need its passes on
		const compiling = this.pipelines.compiling > 0;
		const lightShadows = this.lights.shadows;
		let lights: Readonly<LocalLightFrame> = NO_LOCAL_LIGHTS;
		if (settings.localLights) {
			lights = this.lights.prepare(camera, width, height, {
				enabled: settings.shadows,
				compiling,
				contentVersion: input.content.version,
				streamIdle: input.content.idle,
			});
		} else {
			// nothing waits while the lights are off
			lightShadows.update([], { enabled: false, compiling, contentVersion: 0, streamIdle: true });
		}
		const uniforms = ring.allocate(FRAME_UNIFORM_BYTES);
		const jitter = this.post.nextJitter(width, height, outputHeight);
		this.#frameHistory.write(this.#previous, camera, width / height);
		writeFrameUniforms(uniforms.f32, uniforms.u32, {
			camera,
			jitter,
			jitterPhase: this.post.jitterPhase,
			width,
			height,
			outputWidth,
			outputHeight,
			time: input.time,
			windClock: input.windClock,
			environment: look.environment,
			wetness: look.wetness,
			exposure: this.post.exposure(settings.post),
			bindings: this.bindings,
			terrain: input.terrain,
			shadowMap: this.shadows,
			shadows: settings.shadows,
			irradiance: this.irradiance.centers(),
			lights,
			reflectionProbes: this.reflectionProbes.frame(),
			revealRadii: input.revealRadii,
			previous: {
				history: this.#previous,
				time: this.#prevTime,
				windClock: this.#prevWindClock,
			},
			options: input.options,
		});
		this.#frameHistory.advance();
		this.#prevTime = input.time;
		this.#prevWindClock = input.windClock;
		// each cascade's frame: the main one with the cascade's view-projection
		const cascadeOffsets = this.#cascadeOffsets;
		cascadeOffsets.length = 0;
		if (settings.shadows) {
			for (const layer of this.shadows.layers) {
				const block = ring.allocate(FRAME_UNIFORM_BYTES);
				block.f32.set(uniforms.f32);
				block.f32.set(layer.render, FrameOffsets.viewProj);
				cascadeOffsets.push(block.offset);
			}
		}
		let lightShadowOffset: number | null = null;
		if (lightShadows.request !== null) {
			const block = ring.allocate(FRAME_UNIFORM_BYTES);
			block.f32.set(uniforms.f32);
			block.f32.set(lightShadows.request.render, FrameOffsets.viewProj);
			lightShadowOffset = block.offset;
		}
		const weatherNeedsOcclusion =
			settings.weather &&
			((look.rain !== null &&
				((look.rain.enableWetness && look.rain.wetness > 0) ||
					(look.rain.enable && look.rain.intensity > 0))) ||
				(look.snow !== null && look.snow.enable && look.snow.intensity > 0));
		let verticalOcclusionOffset: number | null = null;
		if (
			this.verticalOcclusion.update(camera.position, {
				needed: weatherNeedsOcclusion,
				range: input.weather?.rain?.rainOcclusionMapRange,
				contentVersion: input.content.version,
				compiling,
			})
		) {
			const block = ring.allocate(FRAME_UNIFORM_BYTES);
			block.f32.set(uniforms.f32);
			block.f32.set(this.verticalOcclusion.render, FrameOffsets.viewProj);
			verticalOcclusionOffset = block.offset;
		}
		this.composer.updateWetness(look.rain, input.weather?.rain ?? null, this.verticalOcclusion, input.time);
		this.weather.update({
			rain: look.rain,
			snow: look.snow,
			assets: input.weather,
			cameraRight: camera.right(),
			dt: input.dt,
			enabled: settings.weather,
		});
		ring.flush();
		times.span('uniforms');

		const encoder = this.profiler.instrument(this.device.createCommandEncoder({ label: 'frame' }));
		const draws = encodeFrame(
			encoder,
			{
				camera,
				width,
				height,
				outputWidth,
				outputHeight,
				frameCore: { group: this.bindings.core, offset: uniforms.offset },
				frame: { group: this.bindings.main, offset: uniforms.offset },
				shadowOffsets: cascadeOffsets,
				lightShadowOffset,
				verticalOcclusionOffset,
				index: input.index,
				time: input.time,
				dt: input.dt,
				wind: look.environment.wind,
				settings,
				compiling,
			},
			this.frame,
		);
		this.profiler.resolve(encoder);
		times.span('encode');
		this.device.queue.submit([encoder.finish()]);
		this.profiler.afterSubmit();
		this.post.afterSubmit();
		this.meshes.afterSubmit();
		times.span('submit');
		return draws;
	}

	/** frees the renderers, the targets and the device */
	destroy(): void {
		for (const system of this.#owned) {
			system.destroy();
		}
		destroyPlaceholders(this.device);
		this.root.destroy();
		this.device.destroy();
	}
}
