import type { RainConfig, WeatherAssets } from '@endfield-noclip/package-format/environment';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import tgpu, { type TgpuRoot } from 'typegpu';

import type { PipelineCache } from '../../gfx/pipeline-cache.ts';
import { srgbToLinear } from '../../math/color.ts';
import { HDR_FORMAT } from '../core/render-targets.ts';

import {
	MAX_SCREEN_DROPS,
	SCREEN_DROP_BYTES,
	fsScreenDrop,
	screenDropLayout,
	vsScreenDrop,
} from './screen-rain-drop-shader.ts';
import type { VerticalOcclusionMap } from './vertical-occlusion.ts';

const SCREEN_DROP_PIPELINE = 'weather screen rain drop';
const SCREEN_DROP_FLOATS = SCREEN_DROP_BYTES / 4;

interface ScreenDropState {
	active: boolean;
	x: number;
	y: number;
	life: number;
	size: number;
	slideSpeed: number;
	flowChance: number;
	jitterTimer: number;
}

const randRange = (lo: number, hi: number): number => lo + Math.random() * Math.max(0, hi - lo);

/** simulates and renders camera-lens raindrops (`ScreenRainDropFX`) over the composited HDR scene */
export class ScreenRainDrops {
	readonly #root: TgpuRoot;
	readonly #device: GPUDevice;
	readonly #pipelines: PipelineCache;
	readonly #verticalOcclusion: VerticalOcclusionMap;
	readonly #repeatSampler: GPUSampler;
	readonly #uniforms: GPUBuffer;
	readonly #data = new Float32Array(SCREEN_DROP_FLOATS);
	readonly #drops: ScreenDropState[] = Array.from({ length: MAX_SCREEN_DROPS }, () => ({
		active: false,
		x: 0,
		y: 0,
		life: 0,
		size: 0,
		slideSpeed: 0,
		flowChance: 0,
		jitterTimer: 0,
	}));
	#group: GPUBindGroup;
	#activeCount = 0;

	/**
	 * @param root the TypeGPU root
	 * @param pipelines the pipeline cache
	 * @param frameLayout group 0 (`frame`) layout
	 * @param fogDepthLayout group 1 (`weatherFogDepthLayout`) layout
	 * @param depthFormat the main pass's depth-stencil format
	 * @param blend the additive/alpha blend state for weather overlays
	 * @param verticalOcclusion the top-down vertical occlusion depth map
	 * @param repeatSampler linear repeat sampler for the rain noise texture
	 * @param initialTexture initial placeholder texture view
	 */
	constructor(
		root: TgpuRoot,
		pipelines: PipelineCache,
		frameLayout: GPUBindGroupLayout,
		fogDepthLayout: GPUBindGroupLayout,
		depthFormat: GPUTextureFormat,
		blend: GPUBlendState,
		verticalOcclusion: VerticalOcclusionMap,
		repeatSampler: GPUSampler,
		initialTexture: GPUTextureView,
	) {
		const device = root.device;
		this.#root = root;
		this.#device = device;
		this.#pipelines = pipelines;
		this.#verticalOcclusion = verticalOcclusion;
		this.#repeatSampler = repeatSampler;
		this.#uniforms = device.createBuffer({
			label: 'weather screen drop uniforms',
			size: SCREEN_DROP_BYTES,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		const pipelineLayout = device.createPipelineLayout({
			label: SCREEN_DROP_PIPELINE,
			bindGroupLayouts: [frameLayout, fogDepthLayout, root.unwrap(screenDropLayout)],
		});
		void pipelines.prepare(SCREEN_DROP_PIPELINE, () => {
			const module = pipelines.module(SCREEN_DROP_PIPELINE, tgpu.resolve([vsScreenDrop, fsScreenDrop]));
			return {
				layout: pipelineLayout,
				vertex: { module, entryPoint: 'vsScreenDrop' },
				fragment: { module, entryPoint: 'fsScreenDrop', targets: [{ format: HDR_FORMAT, blend }] },
				primitive: { topology: 'triangle-list', cullMode: 'none' },
				depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'always' },
			};
		});
		this.#group = this.#buildGroup(initialTexture);
	}

	/** @returns GPU buffer bytes owned by the screen-drop pass */
	get bytes(): number {
		return this.#uniforms.size;
	}

	/** @returns whether any camera-lens raindrops are active this frame */
	get active(): boolean {
		return this.#activeCount > 0;
	}

	/** clears the active count at the start of a frame before {@link update} */
	clear(): void {
		this.#activeCount = 0;
	}

	/**
	 * binds a new rain noise texture view
	 *
	 * @param textureView the noise texture view
	 */
	setTexture(textureView: GPUTextureView): void {
		this.#group = this.#buildGroup(textureView);
	}

	#buildGroup(textureView: GPUTextureView): GPUBindGroup {
		return this.#root.unwrap(
			this.#root.createBindGroup(screenDropLayout, {
				dropData: this.#uniforms,
				verticalOcclusion: this.#verticalOcclusion.view,
				verticalOcclusionCompare: this.#verticalOcclusion.compareSampler,
				verticalOcclusionRaw: this.#verticalOcclusion.rawSampler,
				noiseTex: textureView,
				noiseSampler: this.#repeatSampler,
			}),
		);
	}

	/**
	 * steps the raindrop simulation and uploads active drops for this frame
	 *
	 * @param rain active rain config
	 * @param rp rain presetting assets
	 * @param rainDir unit falling-rain direction
	 * @param cameraRight camera right axis
	 * @param intensity01 normalized rain intensity in `[0, 1]`
	 * @param dt frame delta, s
	 */
	update(
		rain: RainConfig,
		rp: WeatherAssets['rain'] | null,
		rainDir: Vec3,
		cameraRight: Vec3,
		intensity01: number,
		dt: number,
	): void {
		const targetCount = Math.min(
			MAX_SCREEN_DROPS,
			Math.floor((rain.screenDropMaxCountLim ?? 0) * intensity01),
		);
		if (targetCount <= 0) {
			return;
		}
		const [scatterMean, scatterStd] = rp?.screenDropScatterParam ?? [0.86, 0.27];
		const [minLife, maxLife] = rain.screenDropMinMaxLifeTime ?? [1.5, 3.5];
		const [minSize, maxSize] = rain.screenDropMinMaxSize ?? [0.06, 0.14];
		const [minSpeed, maxSpeed] = rain.screenDropMinMaxSpeed ?? [0.05, 0.2];
		const flowPercent = rain.screenDropFlowPercent ?? 0.35;
		const jitterScale = rain.screenDropJitterSpeedScale ?? 0.15;
		const dotRight = rainDir[0] * cameraRight[0] + rainDir[1] * cameraRight[1] + rainDir[2] * cameraRight[2];
		const horizSign = dotRight >= 0 ? 1 : -1;
		const horizMag = Math.min(1, Math.abs(dotRight));

		const gaussian = (): number => {
			const u1 = Math.max(1e-6, Math.random());
			const u2 = Math.random();
			return scatterMean + Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * scatterStd;
		};

		const sd = this.#data;
		sd.fill(0);
		sd.set(this.#verticalOcclusion.originAndInvSpan, 0);
		sd.set(this.#verticalOcclusion.metrics, 4);
		const col = rain.screenDropColor ?? rain.color ?? [0.85, 0.9, 0.95, 0.35];
		sd[8] = srgbToLinear(col[0]);
		sd[9] = srgbToLinear(col[1]);
		sd[10] = srgbToLinear(col[2]);
		sd[11] = col[3];
		const [fadeLo, fadeHi] = rain.screenDropCentroidFadeParam ?? [0.15, 0.55];
		sd[12] = rp?.screenDropFXShadingSize ?? 0.3;
		sd[13] = rp?.screenDropNoiseLevel ?? 0.3;
		sd[14] = fadeLo;
		sd[15] = fadeHi;
		sd[18] = rain.screenRainDropEdgeSharpness ?? 0.7;
		sd.set(rp?.screenDropFXNoiseTexST ?? [3, 3, 0, 0], 20);

		let activeCount = 0;
		for (let i = 0; i < MAX_SCREEN_DROPS; i++) {
			const drop = this.#drops[i];
			if (i < targetCount && !drop.active) {
				const angle = Math.random() * Math.PI * 2;
				const radius = Math.max(0.15, Math.min(1.35, gaussian()));
				drop.active = true;
				drop.x = Math.cos(angle) * radius;
				drop.y = Math.sin(angle) * radius;
				drop.life = randRange(minLife, maxLife) + 1;
				drop.size = randRange(minSize, maxSize);
				drop.slideSpeed = 0;
				const r = Math.random();
				drop.flowChance = r > 1 - flowPercent ? r : 0;
				drop.jitterTimer = 0;
			}
			if (!drop.active) {
				continue;
			}
			if (drop.life <= 0) {
				drop.active = false;
				continue;
			}
			if (drop.flowChance > 0) {
				if (drop.slideSpeed <= 0) {
					if (Math.random() > drop.flowChance) {
						drop.slideSpeed = randRange(minSpeed, maxSpeed);
					}
				} else {
					drop.slideSpeed = Math.max(0, drop.slideSpeed - dt);
				}
			}
			let jitterSpeed = 0;
			if (drop.jitterTimer < 0.5) {
				jitterSpeed = Math.sin(drop.jitterTimer * Math.PI * 2) * jitterScale * (1 - drop.jitterTimer * 2);
				drop.jitterTimer += dt;
			}
			drop.x += dt * drop.slideSpeed * horizSign * horizMag;
			drop.y -= dt * (drop.slideSpeed + Math.max(0, jitterSpeed));
			drop.life -= dt;
			const base = 24 + activeCount * 4;
			sd[base] = drop.x;
			sd[base + 1] = drop.y;
			sd[base + 2] = Math.max(0, Math.min(1, drop.life));
			sd[base + 3] = drop.size;
			activeCount++;
		}
		sd[17] = activeCount;
		this.#activeCount = activeCount;
		if (activeCount > 0) {
			this.#device.queue.writeBuffer(this.#uniforms, 0, sd);
		}
	}

	/**
	 * encodes the screen-drop draw call if any drops are active
	 *
	 * @param pass the weather render pass (groups 0 and 1 already bound)
	 * @returns number of draw calls encoded (`0` or `1`)
	 */
	encode(pass: GPURenderPassEncoder): number {
		if (this.#activeCount === 0) {
			return 0;
		}
		const pipeline = this.#pipelines.get(SCREEN_DROP_PIPELINE);
		if (pipeline === undefined) {
			return 0;
		}
		pass.setPipeline(pipeline);
		pass.setBindGroup(2, this.#group);
		pass.draw(6, this.#activeCount);
		return 1;
	}

	/** resets all drops on a camera/level cut */
	reset(): void {
		this.#activeCount = 0;
		for (const drop of this.#drops) {
			drop.active = false;
		}
	}

	/** frees the uniform buffer */
	destroy(): void {
		this.#uniforms.destroy();
	}
}
