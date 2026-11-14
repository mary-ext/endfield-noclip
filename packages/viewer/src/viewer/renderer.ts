import type { IrradianceRegionInfo, IrradianceTable } from '@endfield-noclip/package-format/irradiance';
import type { TerrainInfo } from '@endfield-noclip/package-format/terrain';

import type { GfxDevice } from '../gfx/device.ts';
import { GpuProfiler } from '../gfx/gpu-profiler.ts';
import { PipelineCache } from '../gfx/pipeline-cache.ts';
import { destroyPlaceholders } from '../gfx/placeholders.ts';
import { UniformRing } from '../gfx/uniform-ring.ts';
import { type BindLayouts, createBindLayouts } from '../render/frame/bind-layouts.ts';
import { FrameBindings } from '../render/frame/frame-bindings.ts';
import {
	type FrameSettings,
	type FrameSystems,
	ShadowLayerCache,
	encodeFrame,
} from '../render/frame/frame-graph.ts';
import {
	FRAME_UNIFORM_BYTES,
	type FrameUniformInputs,
	FrameOffsets,
	writeFrameUniforms,
} from '../render/frame/frame-uniform-writer.ts';
import { RenderTargets } from '../render/frame/render-targets.ts';
import { InstanceRenderer } from '../render/instances/instance-renderer.ts';
import { IrradianceVolume } from '../render/lighting/irradiance-volume.ts';
import { type LocalLightFrame, LocalLights } from '../render/lighting/local-lights.ts';
import { MeshRenderer } from '../render/meshes/mesh-renderer.ts';
import { PostProcess } from '../render/post/post-process.ts';
import { SHADOW_LAYERS, ShadowMap } from '../render/shadows/shadow-map.ts';
import { VolumetricFog } from '../render/sky/volumetric-fog.ts';
import { TerrainRenderer } from '../render/terrain/terrain-renderer.ts';
import { WaterRenderer } from '../render/water/water-renderer.ts';
import type { Camera } from '../scene/camera.ts';

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
	/** the wind clock (`Frame.wind.x`) */
	windClock: number;
	/** the loaded package's terrain, `null` or `undefined` for none */
	terrain: TerrainInfo | null | undefined;
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
	readonly targets: RenderTargets;
	readonly pipelines: PipelineCache;
	readonly shadows: ShadowMap;
	/** the loaded package's irradiance volume; an empty one without a package */
	readonly irradiance: IrradianceVolume;
	readonly lights: LocalLights;
	/** group 0 for the main and shadow passes */
	readonly bindings: FrameBindings;
	readonly profiler: GpuProfiler;
	readonly terrain: TerrainRenderer;
	readonly instances: InstanceRenderer;
	readonly meshes: MeshRenderer;
	readonly fog: VolumetricFog;
	readonly post: PostProcess;
	readonly water: WaterRenderer;
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

	/**
	 * @param gfx the device
	 * @param canvas the canvas to present to
	 * @param look the environment to start with
	 * @param near the camera's near plane, m
	 */
	constructor(gfx: GfxDevice, canvas: HTMLCanvasElement, look: EnvironmentLook, near: number) {
		const device = gfx.device;
		this.device = device;
		this.targets = new RenderTargets(device, canvas, gfx.presentationFormat, {
			stencil: gfx.features.depth32floatStencil8,
			mipFeedback: gfx.features.mipFeedbackTarget,
		});
		this.#layouts = createBindLayouts(device);
		this.pipelines = new PipelineCache(device);
		// the main pass's frame, one per shadow layer and one for a local light's shadow tile
		const alignment = device.limits.minUniformBufferOffsetAlignment;
		this.#ring = new UniformRing(
			device,
			Math.ceil(FRAME_UNIFORM_BYTES / alignment) * alignment * (2 + SHADOW_LAYERS),
			3,
		);
		this.shadows = new ShadowMap(device);
		this.irradiance = new IrradianceVolume(device, this.pipelines);
		this.lights = new LocalLights(device);
		this.bindings = new FrameBindings(device, {
			layout: this.#layouts.frame,
			uniforms: this.#ring.buffer,
			shadows: this.shadows,
			irradiance: this.irradiance,
			lights: this.lights,
		});
		this.profiler = new GpuProfiler(device, gfx.features.timestampQuery);
		const layouts = this.#layouts;
		const format = this.targets.format;
		this.terrain = new TerrainRenderer(device, layouts, this.pipelines, format, {
			capacity: TERRAIN_SLOTS,
			bc: gfx.features.textureCompressionBc,
		});
		this.instances = new InstanceRenderer(device, layouts, this.pipelines, format, INSTANCE_ROWS);
		this.fog = new VolumetricFog(device, this.pipelines, layouts.frame);
		this.fog.setEnvironment(look.environment, near);
		this.post = new PostProcess(device, this.pipelines, gfx.presentationFormat, look.environment, this.fog);
		this.meshes = new MeshRenderer(device, layouts, this.pipelines, {
			instances: this.instances,
			format,
			fog: this.post.fogInputs,
			features: gfx.features,
		});
		this.water = new WaterRenderer(device, this.pipelines, { frame: layouts.frame, ...this.post.skyLayouts });
		this.frame = {
			targets: this.targets,
			irradiance: this.irradiance,
			shadowMap: this.shadows,
			shadowLayers: new ShadowLayerCache(),
			lightShadows: this.lights.shadows,
			terrain: this.terrain,
			instances: this.instances,
			meshes: this.meshes,
			fog: this.fog,
			water: this.water,
			post: this.post,
		};
		this.pools = [
			this.terrain,
			this.instances,
			this.meshes,
			this.targets,
			this.post,
			this.fog,
			this.shadows,
			this.lights.shadows,
		];
		this.#histories = [this.post, this.fog, this.meshes];
		this.#owned = [
			this.post,
			this.fog,
			this.lights,
			this.irradiance,
			this.water,
			this.meshes,
			this.instances,
			this.terrain,
			this.shadows,
			this.targets,
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
		this.post.setEnvironment(look.environment, look);
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
			revealRadii: input.revealRadii,
			options: input.options,
		});
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
				frame: { group: this.bindings.main, offset: uniforms.offset },
				shadowFrame: { group: this.bindings.shadow, offsets: cascadeOffsets },
				lightShadowFrame:
					lightShadowOffset === null ? null : { group: this.bindings.shadow, offset: lightShadowOffset },
				index: input.index,
				time: input.time,
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
		this.device.destroy();
	}
}
