import type { TgpuRoot } from 'typegpu';

import type { Environment } from '../../environment/environment.ts';
import type { LensFlareLook } from '../../environment/lens-flare-look.ts';
import type { PipelineCache } from '../../gfx/pipeline-cache.ts';
import type { Camera } from '../../scene/camera.ts';
import type { StreamedTexture } from '../../streaming/texture-requests.ts';
import type { SceneTextures } from '../core/render-targets.ts';
import { type PostSettings, effectiveSettings, postExposure } from '../core/settings.ts';

import { AutoExposure } from './auto-exposure.ts';
import { Bloom } from './bloom.ts';
import { LensFlares } from './lens-flare.ts';
import { LightShafts } from './light-shafts.ts';
import { TemporalAA } from './temporal-aa.ts';
import { Tonemap } from './tonemap.ts';

/** the post-scene views sized with the scene textures */
interface Sized {
	version: number;
	historyViews: [GPUTextureView, GPUTextureView];
}

/**
 * post-scene rendering chain: light shafts, lens flare, temporal antialiasing, auto exposure, bloom, and
 * tonemapping to the swapchain
 */
export class PostProcess {
	#lightShafts: LightShafts;
	#lensFlares: LensFlares;
	#taa: TemporalAA;
	#autoExposure: AutoExposure;
	#bloom: Bloom;
	#tonemap: Tonemap;
	#sized: Sized | null = null;
	#environment: Environment;

	/**
	 * @param root the TypeGPU root
	 * @param pipelines the pipeline cache, which compiles the auto exposure and lens flare passes
	 * @param options swapchain format, shared `Post` uniform buffer, clamping sampler, and starting environment
	 */
	constructor(
		root: TgpuRoot,
		pipelines: PipelineCache,
		options: {
			swapchainFormat: GPUTextureFormat;
			postHdrFormat: GPUTextureFormat;
			postUniforms: GPUBuffer;
			sampler: GPUSampler;
			environment: Environment;
		},
	) {
		const { swapchainFormat, postHdrFormat, postUniforms, sampler, environment } = options;
		this.#autoExposure = new AutoExposure(root, pipelines);
		this.#lightShafts = new LightShafts(root, pipelines, postUniforms, postHdrFormat);
		this.#lensFlares = new LensFlares(root, pipelines);
		this.#taa = new TemporalAA(root, pipelines, postUniforms, postHdrFormat);
		this.#bloom = new Bloom(root, pipelines, postUniforms, sampler, postHdrFormat);
		this.#tonemap = new Tonemap(root, pipelines, postUniforms, sampler, swapchainFormat);
		this.#environment = environment;
	}

	/** @returns bytes of the post chain's render targets */
	get bytes(): number {
		return this.#bloom.bytes + this.#taa.bytes + this.#lightShafts.bytes;
	}

	/**
	 * binds lens flare textures as they stream in
	 *
	 * @param lookup returns each lens flare image's streamed texture by texture-table id
	 */
	setLensFlareTextures(lookup: (texture: number) => StreamedTexture | null): void {
		this.#lensFlares.setTextures(lookup);
	}

	/** unbinds lens flare textures before the store that holds them is destroyed */
	clearTextures(): void {
		this.#lensFlares.setTextures(() => null);
	}

	/**
	 * updates the post-processing environment settings and sun lens flare look
	 *
	 * @param environment the shown level's environment
	 * @param lensFlare the sun's lens flare (`null`: none)
	 */
	setEnvironment(environment: Environment, lensFlare: LensFlareLook | null): void {
		this.#environment = environment;
		this.#lensFlares.setLook(lensFlare);
	}

	/** drops the temporal antialiasing history after a camera cut */
	reset(): void {
		this.#taa.reset();
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

	/** @returns this frame's current jitter in NDC */
	get jitter(): readonly [x: number, y: number] {
		return this.#taa.jitter;
	}

	/** @returns this frame's place in the jitter cycle, from 1; 0 with antialiasing off */
	get jitterPhase(): number {
		return this.#taa.phase;
	}

	/** @returns index of the previous resolved history texture (0 or 1) */
	get previousIndex(): number {
		return this.#taa.previousIndex;
	}

	/**
	 * writes the previous frame's camera reprojection for water reflections and returns its resolved scene view
	 *
	 * @param out destination for the camera history floats
	 * @param eye current camera world position
	 * @returns the previous resolved HDR scene view, or `null` when unavailable
	 */
	previousScene(out: Float32Array, eye: readonly [number, number, number]): GPUTextureView | null {
		return this.#taa.previous(out, eye);
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

	/**
	 * resizes TAA, light shafts, lens flares, bloom, and tonemap targets when `scene.version` changes
	 *
	 * @param scene the main pass's textures
	 * @param input composited target view and render/output sizes
	 * @returns whether a resize occurred, plus the TAA history views for SSR
	 */
	ensureSized(
		scene: SceneTextures,
		input: {
			composited: GPUTextureView;
			width: number;
			height: number;
			outputWidth: number;
			outputHeight: number;
		},
	): { resized: boolean; historyViews: [GPUTextureView, GPUTextureView] } {
		const current = this.#sized;
		if (current !== null && current.version === scene.version) {
			return { resized: false, historyViews: current.historyViews };
		}
		const { composited, width, height, outputWidth, outputHeight } = input;
		this.#taa.resize({
			scene: composited,
			depth: scene.depth,
			velocity: scene.velocity,
			width,
			height,
			outputWidth,
			outputHeight,
		});
		const histories = this.#taa.histories;
		const historyViews: [GPUTextureView, GPUTextureView] = [
			histories[0].createView(),
			histories[1].createView(),
		];
		this.#lightShafts.resize({ scene, composited, width, height });
		this.#lensFlares.resize({ scene, composited });
		this.#bloom.resize({ histories, outputWidth, outputHeight });
		this.#tonemap.resize({ histories, bloom: this.#bloom.result });
		this.#sized = { version: scene.version, historyViews };
		return { resized: true, historyViews };
	}

	/**
	 * encodes the post-scene passes to the swapchain: light shafts, lens flare, temporal antialiasing, auto
	 * exposure, bloom, and tonemapping
	 *
	 * @param encoder this frame's encoder, after the passes over the composited scene
	 * @param input swapchain view, camera, render and output sizes, and settings
	 */
	encode(
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

	/** frees the post chain's GPU resources */
	destroy(): void {
		this.#bloom.destroy();
		this.#autoExposure.destroy();
		this.#taa.destroy();
		this.#lightShafts.destroy();
		this.#lensFlares.destroy();
	}
}
