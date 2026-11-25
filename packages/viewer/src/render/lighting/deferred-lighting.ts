import type { RainConfig, RainPresetting } from '@endfield-noclip/package-format/environment';

import tgpu, { type TgpuRoot, common } from 'typegpu';

import { createUniformBuffer } from '../../gfx/buffers.ts';
import type { PipelineCache } from '../../gfx/pipeline-cache.ts';
import { placeholder } from '../../gfx/placeholders.ts';
import { LINEAR_CLAMP, LINEAR_REPEAT, sampler } from '../../gfx/samplers.ts';
import { HDR_FORMAT, type SceneTextures } from '../frame/render-targets.ts';
import { postUniformLayout } from '../post/post-schema.ts';
import type { TextureBinding } from '../textures/texture-store.ts';
import type { VerticalOcclusionMap } from '../weather/vertical-occlusion.ts';

import {
	RAIN_WETNESS_BYTES,
	deferredInputsLayout,
	fsDeferredLighting,
	rainWetnessLayout,
} from './deferred-lighting-shader.ts';

const RAIN_WETNESS_FLOATS = RAIN_WETNESS_BYTES / 4;
const PIPELINE_KEY = 'deferred lighting';

/**
 * deferred lighting pass (deferred-lighting-shader.ts): unpacks the G-buffer and writes lit HDR radiance into
 * `scene.lit` with `loadOp: 'load'`, leaving the celestial pass's sky pixels intact
 */
export class DeferredLighting {
	#root: TgpuRoot;
	#device: GPUDevice;
	#pipelines: PipelineCache;
	#postGroup: GPUBindGroup;
	#wetnessUniforms: GPUBuffer;
	#wetnessData = new Float32Array(RAIN_WETNESS_FLOATS);
	#wetnessGroup: GPUBindGroup;
	#verticalOcclusion: VerticalOcclusionMap;
	#noiseView: GPUTextureView;
	#rippleView: GPUTextureView;
	#flowView: GPUTextureView;
	#hasNoise = false;
	#hasRipple = false;
	#hasFlow = false;
	#sampler: GPUSampler;
	#repeatSampler: GPUSampler;
	#sized: { inputs: GPUBindGroup; target: GPUTextureView } | null = null;

	/**
	 * @param root the TypeGPU root
	 * @param pipelines the pipeline cache
	 * @param frameLayout group 0 (`frame`) bind group layout
	 * @param postUniforms the post chain's `Post` uniforms buffer
	 * @param verticalOcclusion the top-down vertical occlusion depth map for rain sheltering
	 */
	constructor(
		root: TgpuRoot,
		pipelines: PipelineCache,
		frameLayout: GPUBindGroupLayout,
		postUniforms: GPUBuffer,
		verticalOcclusion: VerticalOcclusionMap,
	) {
		const device = root.device;
		this.#root = root;
		this.#device = device;
		this.#pipelines = pipelines;
		this.#verticalOcclusion = verticalOcclusion;
		this.#sampler = sampler(device, LINEAR_CLAMP);
		this.#repeatSampler = sampler(device, LINEAR_REPEAT);
		this.#wetnessUniforms = createUniformBuffer(device, 'rain wetness uniforms', RAIN_WETNESS_BYTES);
		const module = pipelines.module(
			'deferred lighting',
			tgpu.resolve([common.fullScreenTriangle, fsDeferredLighting]),
		);
		void pipelines.prepare(PIPELINE_KEY, () => ({
			label: 'deferred lighting',
			layout: device.createPipelineLayout({
				label: 'deferred lighting',
				bindGroupLayouts: [
					frameLayout,
					root.unwrap(postUniformLayout),
					root.unwrap(deferredInputsLayout),
					root.unwrap(rainWetnessLayout),
				],
			}),
			vertex: { module },
			fragment: { module, entryPoint: 'fsDeferredLighting', targets: [{ format: HDR_FORMAT }] },
			primitive: { topology: 'triangle-list' },
		}));
		this.#postGroup = root.unwrap(root.createBindGroup(postUniformLayout, { post: postUniforms }));
		this.#noiseView = placeholder(device, 'black', '3d');
		this.#rippleView = placeholder(device, 'black', '2d');
		this.#flowView = placeholder(device, 'black', '2d');
		this.#wetnessGroup = this.#buildWetnessGroup();
	}

	#buildWetnessGroup(): GPUBindGroup {
		return this.#root.unwrap(
			this.#root.createBindGroup(rainWetnessLayout, {
				rainWet: this.#wetnessUniforms,
				verticalOcclusion: this.#verticalOcclusion.view,
				verticalOcclusionCompare: this.#verticalOcclusion.compareSampler,
				rainOccNoise: this.#noiseView,
				rippleTexture: this.#rippleView,
				verticalFlowTexture: this.#flowView,
				repeatSampler: this.#repeatSampler,
			}),
		);
	}

	/**
	 * binds the streamed wetness textures (3D occlusion jitter noise, standing-water ripple flipbook, wall
	 * vertical-flow normal map); missing textures fall back to placeholders and disable their sub-effect
	 *
	 * @param textures the wetness textures, `null` when not resident
	 */
	setWetnessTextures(textures: {
		noise: TextureBinding | null;
		ripple: TextureBinding | null;
		flow: TextureBinding | null;
	}): void {
		const noiseView = textures.noise?.view ?? placeholder(this.#device, 'black', '3d');
		const rippleView = textures.ripple?.view ?? placeholder(this.#device, 'black', '2d');
		const flowView = textures.flow?.view ?? placeholder(this.#device, 'black', '2d');
		this.#hasNoise = textures.noise !== null;
		this.#hasRipple = textures.ripple !== null;
		this.#hasFlow = textures.flow !== null;
		if (noiseView === this.#noiseView && rippleView === this.#rippleView && flowView === this.#flowView) {
			return;
		}
		this.#noiseView = noiseView;
		this.#rippleView = rippleView;
		this.#flowView = flowView;
		this.#wetnessGroup = this.#buildWetnessGroup();
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
		const data = this.#wetnessData;
		data.fill(0);
		if (rain === null || !rain.enableWetness || rain.wetness <= 0) {
			this.#device.queue.writeBuffer(this.#wetnessUniforms, 0, data);
			return;
		}
		const normalBias = presetting?.rainOcclusionSampleNormalBias ?? 1.8;
		const depthBias = presetting?.rainOcclusionSampleDepthBias ?? 0;
		const noiseScale = presetting?.rainOcclusionSampleNoiseScale ?? 0.15;
		const hJitter = presetting?.rainOcclusionSampleHorizontalJitterLevel ?? 1.2;
		const vJitter = presetting?.rainOcclusionSampleVerticalJitterLevel ?? 0.5;
		const flowSt = presetting?.verticalFlowTextureST ?? [0.5, 0.5, 0, 0];
		const rippleSt = presetting?.rippleTextureST ?? [1, 1, 0, 0];
		const rippleCols = Math.max(1, presetting?.rippleRowColumnCount ?? 4);

		// occOrigin: camera-relative (centerX, topRelY, centerZ, 1 / (2 · range))
		data.set(occlusion.originAndInvSpan, 0);
		// occMetrics: (1 / height, height, texelWorldSize, active)
		data.set(occlusion.metrics, 4);
		// occBias: (normalBias, depthBias, noiseScale, hasNoise)
		data[8] = normalBias;
		data[9] = depthBias;
		data[10] = noiseScale;
		data[11] = this.#hasNoise ? 1 : 0;
		// occJitter: (horizontalJitterLevel, verticalJitterLevel, 0, 0)
		data[12] = hJitter;
		data[13] = vJitter;
		// flowParams: (flowOffset, normalStrength, slopeThreshold, porosity)
		data[16] = (time * (rain.verticalFlowSpeed ?? 0) * 0.07) % 1000;
		data[17] = this.#hasFlow ? (rain.verticalFlowNormalStrength ?? 0) : 0;
		data[18] = rain.verticalFlowSurfaceThreshold ?? 0.3;
		data[19] = rain.verticalFlowPorosityBias ?? 0.4;
		// flowSt: (scaleX, scaleY, offsetX, offsetY)
		data.set(flowSt, 20);
		// rippleParams: (rippleTimeOffset, rippleNormalStrength, waveTimeOffset, waveNormalStrength)
		const rippleT = time * (rain.rippleFrequency ?? 0);
		const waveT = time * (rain.rippleWaveSpeed ?? 0);
		data[24] = rippleT - Math.floor(rippleT);
		data[25] = this.#hasRipple ? (rain.rippleNormalStrength ?? 0) : 0;
		data[26] = waveT - Math.floor(waveT);
		data[27] = this.#hasRipple ? (rain.rippleWaveNormalStrength ?? 0) : 0;
		// rippleSt: (scaleX, scaleY, rowColumnCount, roughnessMaskThreshold)
		data[28] = rippleSt[0];
		data[29] = rippleSt[1];
		data[30] = rippleCols;
		data[31] = Math.max(0, rain.rippleRoughnessMaskThreshold);
		this.#device.queue.writeBuffer(this.#wetnessUniforms, 0, data);
	}

	/**
	 * rebinds the G-buffer, AO, SSR and wetness mask after a resize.
	 *
	 * @param input the main pass's G-buffer, blurred AO and resolved SSR
	 */
	resize(input: { scene: SceneTextures; ao: GPUTextureView; reflections: GPUTextureView }): void {
		const { scene } = input;
		this.#sized = {
			target: scene.lit,
			inputs: this.#root.unwrap(
				this.#root.createBindGroup(deferredInputsLayout, {
					gbEmission: scene.emission,
					gbA: scene.gbufferA,
					gbB: scene.gbufferB,
					gbC: scene.gbufferC,
					gbDepth: scene.depth,
					aoTexture: input.ao,
					ssrTexture: input.reflections,
					wetnessTexture: scene.wetnessMask,
					linearSampler: this.#sampler,
				}),
			),
		};
	}

	/**
	 * encodes the deferred lighting pass into `scene.lit`, preserving sky pixels written by the celestial pass.
	 *
	 * @param encoder this frame's encoder
	 * @param frameGroup group 0 (`frame`) and its dynamic uniform offset
	 */
	encode(encoder: GPUCommandEncoder, frameGroup: { group: GPUBindGroup; offset: number }): void {
		const sized = this.#sized;
		if (sized === null) {
			throw new Error('deferred lighting used before resize()');
		}
		const pipeline = this.#pipelines.get(PIPELINE_KEY);
		if (pipeline === undefined) {
			return;
		}
		const pass = encoder.beginRenderPass({
			label: 'deferred lighting',
			colorAttachments: [{ view: sized.target, loadOp: 'load', storeOp: 'store' }],
		});
		pass.setPipeline(pipeline);
		pass.setBindGroup(0, frameGroup.group, [frameGroup.offset]);
		pass.setBindGroup(1, this.#postGroup);
		pass.setBindGroup(2, sized.inputs);
		pass.setBindGroup(3, this.#wetnessGroup);
		pass.draw(3);
		pass.end();
	}

	/** frees the pass's uniform buffer */
	destroy(): void {
		this.#wetnessUniforms.destroy();
	}
}
