import type { RainConfig, SnowConfig, WeatherAssets } from '@endfield-noclip/package-format/environment';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import tgpu, { type TgpuRoot } from 'typegpu';

import type { PipelineCache } from '../../gfx/pipeline-cache.ts';
import { placeholder } from '../../gfx/placeholders.ts';
import { LINEAR_REPEAT, sampler } from '../../gfx/samplers.ts';
import { HDR_FORMAT, type SceneTextures } from '../frame/render-targets.ts';
import { postUniformLayout } from '../post/post-schema.ts';
import type { TextureBinding } from '../textures/texture-store.ts';

import { fsFarRain, vsFarRain } from './far-rain-shader.ts';
import { fsSplash, vsSplash } from './rain-splash-shader.ts';
import { fsRain, vsRain } from './scene-effect-rain-shader.ts';
import { fsSnow, vsSnow } from './scene-effect-snow-shader.ts';
import {
	MAX_SCREEN_DROPS,
	SCREEN_DROP_BYTES,
	fsScreenDrop,
	screenDropLayout,
	vsScreenDrop,
} from './screen-rain-drop-shader.ts';
import type { VerticalOcclusionMap } from './vertical-occlusion.ts';
import { WEATHER_SLOT_BYTES, weatherFogDepthLayout } from './weather-common.ts';
import {
	createFarRainMesh,
	createRainSplashMesh,
	createSceneEffectMesh,
	type WeatherMesh,
} from './weather-meshes.ts';

/** nested near-rain layer scale multipliers (`HGSceneEffectRainRenderer.s_sceneEffectLayerScale`) */
const RAIN_LAYER_SCALES: readonly number[] = [1.0, 0.5, 0.4, 0.6];
/** nested falling-snow layer scale multipliers (`HGSceneEffectSnowRenderer.s_sceneEffectLayerScale`) */
const SNOW_LAYER_SCALES: readonly number[] = [1.0, 0.5, 0.4, 0.6, 0.3, 0.2];

const SLOT_BYTES = WEATHER_SLOT_BYTES;
const SLOT_FLOATS = SLOT_BYTES / 4;
/** max draws per frame: 4 rain + 3 far rain + 1 splash + 6 snow = 14 */
const MAX_SLOTS = 16;
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

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

const randRange = (lo: number, hi: number): number => lo + Math.random() * Math.max(0, hi - lo);

/**
 * writes a 3×3 orientation matrix that rotates `(0, 1, 0)` onto `normalize(-dir)` and scales local X/Z by
 * `radius` and Y by `height` into 3 vec4f slots at `out[offset..offset + 12]`
 */
const writeCylinderBasis = (
	out: Float32Array,
	offset: number,
	dir: Vec3,
	radius: number,
	height: number,
): void => {
	const dx = -dir[0];
	const dy = -dir[1];
	const dz = -dir[2];
	const len = Math.hypot(dx, dy, dz);
	const ux = len > 1e-6 ? dx / len : 0;
	const uy = len > 1e-6 ? dy / len : 1;
	const uz = len > 1e-6 ? dz / len : 0;

	// FromToRotation((0, 1, 0), (ux, uy, uz))
	if (uy > 0.9999) {
		out[offset] = radius;
		out[offset + 1] = 0;
		out[offset + 2] = 0;
		out[offset + 4] = 0;
		out[offset + 5] = height;
		out[offset + 6] = 0;
		out[offset + 8] = 0;
		out[offset + 9] = 0;
		out[offset + 10] = radius;
		return;
	}
	if (uy < -0.9999) {
		out[offset] = radius;
		out[offset + 1] = 0;
		out[offset + 2] = 0;
		out[offset + 4] = 0;
		out[offset + 5] = -height;
		out[offset + 6] = 0;
		out[offset + 8] = 0;
		out[offset + 9] = 0;
		out[offset + 10] = -radius;
		return;
	}
	// cross((0, 1, 0), u) = (uz, 0, -ux)
	const axLen = Math.hypot(uz, -ux);
	const ax = uz / axLen;
	const az = -ux / axLen;
	const c = uy;
	const s = Math.sqrt(Math.max(0, 1 - c * c));
	const t = 1 - c;

	// column 0 (X) * radius
	out[offset] = (t * ax * ax + c) * radius;
	out[offset + 1] = -s * az * radius;
	out[offset + 2] = t * ax * az * radius;
	// column 1 (Y) * height
	out[offset + 4] = s * az * height;
	out[offset + 5] = c * height;
	out[offset + 6] = -s * ax * height;
	// column 2 (Z) * radius
	out[offset + 8] = t * ax * az * radius;
	out[offset + 9] = s * ax * radius;
	out[offset + 10] = (t * az * az + c) * radius;
};

const RAIN_PIPELINE = 'weather scene effect rain';
const SNOW_PIPELINE = 'weather scene effect snow';
const FAR_RAIN_PIPELINE = 'weather far rain';
const SPLASH_PIPELINE = 'weather rain splash';
const SCREEN_DROP_PIPELINE = 'weather screen rain drop';

type DrawKind = 'rain' | 'farRain' | 'splash' | 'snow';

interface PlannedDraw {
	kind: DrawKind;
	slot: number;
}

/**
 * renders falling rain streaks, middle/far rain curtains, distant rain waves, ground rain splashes, and
 * falling snow with vertical-occlusion collision over the composited HDR scene
 */
export class WeatherRenderer {
	readonly #root: TgpuRoot;
	readonly #device: GPUDevice;
	readonly #pipelines: PipelineCache;
	readonly #verticalOcclusion: VerticalOcclusionMap;
	readonly #fogInputs: { uniforms: GPUBuffer; froxels: GPUTextureView; sampler: GPUSampler };
	readonly #postGroup: GPUBindGroup;
	readonly #weatherLayout: GPUBindGroupLayout;
	readonly #uniforms: GPUBuffer;
	readonly #uniformData = new Float32Array(MAX_SLOTS * SLOT_FLOATS);
	readonly #screenDropUniforms: GPUBuffer;
	readonly #screenDropData = new Float32Array(SCREEN_DROP_FLOATS);
	readonly #screenDrops: ScreenDropState[] = Array.from({ length: MAX_SCREEN_DROPS }, () => ({
		active: false,
		x: 0,
		y: 0,
		life: 0,
		size: 0,
		slideSpeed: 0,
		flowChance: 0,
		jitterTimer: 0,
	}));
	#screenDropGroup: GPUBindGroup;
	#activeScreenDrops = 0;
	readonly #repeatSampler: GPUSampler;
	readonly #rainMesh: WeatherMesh;
	readonly #splashMesh: WeatherMesh;
	readonly #farRainMesh: WeatherMesh;

	#fogDepthGroup: GPUBindGroup | null = null;
	#sceneVersion = -1;
	#rainTexView: GPUTextureView;
	#waveTexView: GPUTextureView;
	#splashTexView: GPUTextureView;
	#snowTexView: GPUTextureView;
	#hasRainTex = false;
	#hasWaveTex = false;
	#hasSplashTex = false;
	#hasSnowTex = false;
	#rainGroup: GPUBindGroup;
	#waveGroup: GPUBindGroup;
	#splashGroup: GPUBindGroup;
	#snowGroup: GPUBindGroup;

	/** accumulated animation phases (matching the game's per-renderer clocks) */
	#rainLayerOffset = 0;
	#middleRainOffset = 0;
	#farRainOffset = 0;
	#rainWaveOffsetX = 0;
	#rainWaveOffsetY = 0;
	#rainSplashOffset = 0;
	#snowOffset: [number, number, number] = [0, 0, 0];

	readonly #draws: PlannedDraw[] = [];

	/**
	 * @param root the TypeGPU root
	 * @param pipelines the pipeline cache
	 * @param frameLayout group 0 (`frame`) layout
	 * @param depthFormat the main pass's depth-stencil format
	 * @param fogInputs the post chain's uniforms, froxels and clamping sampler
	 * @param verticalOcclusion the top-down vertical occlusion depth map
	 */
	constructor(
		root: TgpuRoot,
		pipelines: PipelineCache,
		frameLayout: GPUBindGroupLayout,
		depthFormat: GPUTextureFormat,
		fogInputs: { uniforms: GPUBuffer; froxels: GPUTextureView; sampler: GPUSampler },
		verticalOcclusion: VerticalOcclusionMap,
	) {
		const device = root.device;
		this.#root = root;
		this.#device = device;
		this.#pipelines = pipelines;
		this.#fogInputs = fogInputs;
		this.#verticalOcclusion = verticalOcclusion;
		this.#repeatSampler = sampler(device, LINEAR_REPEAT);
		this.#uniforms = device.createBuffer({
			label: 'weather uniforms',
			size: MAX_SLOTS * SLOT_BYTES,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		this.#screenDropUniforms = device.createBuffer({
			label: 'weather screen drop uniforms',
			size: SCREEN_DROP_BYTES,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		this.#rainMesh = createSceneEffectMesh(device);
		this.#splashMesh = createRainSplashMesh(device);
		this.#farRainMesh = createFarRainMesh(device);

		const vf = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
		const frag = GPUShaderStage.FRAGMENT;
		this.#postGroup = root.unwrap(root.createBindGroup(postUniformLayout, { post: fogInputs.uniforms }));
		this.#weatherLayout = device.createBindGroupLayout({
			label: 'weather params',
			entries: [
				{ binding: 0, visibility: vf, buffer: { type: 'uniform', hasDynamicOffset: true } },
				{ binding: 1, visibility: vf, texture: { sampleType: 'depth' } },
				{ binding: 2, visibility: frag, sampler: { type: 'comparison' } },
				{ binding: 3, visibility: vf, sampler: { type: 'non-filtering' } },
				{ binding: 4, visibility: frag, texture: { sampleType: 'float' } },
				{ binding: 5, visibility: frag, sampler: { type: 'filtering' } },
			],
		});

		const fogDepthLayout = root.unwrap(weatherFogDepthLayout);
		const pipelineLayout = device.createPipelineLayout({
			label: 'weather',
			bindGroupLayouts: [frameLayout, fogDepthLayout, this.#weatherLayout, root.unwrap(postUniformLayout)],
		});
		const blend: GPUBlendState = {
			color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
			alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
		};
		const depthStencil: GPUDepthStencilState = {
			format: depthFormat,
			depthWriteEnabled: false,
			depthCompare: 'greater-equal',
		};

		const sceneEffectBuffers: GPUVertexBufferLayout[] = [
			{
				arrayStride: 32,
				attributes: [
					{ shaderLocation: 0, offset: 0, format: 'float32x3' },
					{ shaderLocation: 1, offset: 12, format: 'float32x2' },
					{ shaderLocation: 2, offset: 20, format: 'float32x3' },
				],
			},
		];
		const splashBuffers: GPUVertexBufferLayout[] = [
			{
				arrayStride: 24,
				attributes: [
					{ shaderLocation: 0, offset: 0, format: 'float32x2' },
					{ shaderLocation: 1, offset: 8, format: 'float32x2' },
					{ shaderLocation: 2, offset: 16, format: 'float32x2' },
				],
			},
		];
		const farRainBuffers: GPUVertexBufferLayout[] = [
			{
				arrayStride: 20,
				attributes: [
					{ shaderLocation: 0, offset: 0, format: 'float32x3' },
					{ shaderLocation: 1, offset: 12, format: 'float32x2' },
				],
			},
		];

		const preparePipeline = (
			key: string,
			code: string,
			vs: string,
			fs: string,
			buffers: GPUVertexBufferLayout[],
		): void => {
			void pipelines.prepare(key, () => {
				const module = pipelines.module(key, code);
				return {
					layout: pipelineLayout,
					vertex: { module, entryPoint: vs, buffers },
					fragment: { module, entryPoint: fs, targets: [{ format: HDR_FORMAT, blend }] },
					primitive: { topology: 'triangle-list', cullMode: 'none' },
					depthStencil,
				};
			});
		};

		preparePipeline(RAIN_PIPELINE, tgpu.resolve([vsRain, fsRain]), 'vsRain', 'fsRain', sceneEffectBuffers);
		preparePipeline(SNOW_PIPELINE, tgpu.resolve([vsSnow, fsSnow]), 'vsSnow', 'fsSnow', sceneEffectBuffers);
		preparePipeline(
			FAR_RAIN_PIPELINE,
			tgpu.resolve([vsFarRain, fsFarRain]),
			'vsFarRain',
			'fsFarRain',
			farRainBuffers,
		);
		preparePipeline(
			SPLASH_PIPELINE,
			tgpu.resolve([vsSplash, fsSplash]),
			'vsSplash',
			'fsSplash',
			splashBuffers,
		);
		{
			const screenDropPipelineLayout = device.createPipelineLayout({
				label: SCREEN_DROP_PIPELINE,
				bindGroupLayouts: [frameLayout, fogDepthLayout, root.unwrap(screenDropLayout)],
			});
			void pipelines.prepare(SCREEN_DROP_PIPELINE, () => {
				const module = pipelines.module(SCREEN_DROP_PIPELINE, tgpu.resolve([vsScreenDrop, fsScreenDrop]));
				return {
					layout: screenDropPipelineLayout,
					vertex: { module, entryPoint: 'vsScreenDrop' },
					fragment: { module, entryPoint: 'fsScreenDrop', targets: [{ format: HDR_FORMAT, blend }] },
					primitive: { topology: 'triangle-list', cullMode: 'none' },
					depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'always' },
				};
			});
		}

		const black = placeholder(device, 'black', '2d');
		this.#rainTexView = black;
		this.#waveTexView = black;
		this.#splashTexView = black;
		this.#snowTexView = black;
		this.#rainGroup = this.#buildWeatherGroup('weather rain', black);
		this.#waveGroup = this.#buildWeatherGroup('weather wave', black);
		this.#splashGroup = this.#buildWeatherGroup('weather splash', black);
		this.#snowGroup = this.#buildWeatherGroup('weather snow', black);
		this.#screenDropGroup = this.#buildScreenDropGroup(black);
	}

	/** @returns GPU buffer bytes owned by the weather renderer */
	get bytes(): number {
		return (
			this.#uniforms.size +
			this.#screenDropUniforms.size +
			this.#rainMesh.bytes +
			this.#splashMesh.bytes +
			this.#farRainMesh.bytes
		);
	}

	/** @returns whether any weather pass is planned to draw this frame */
	get active(): boolean {
		return this.#draws.length > 0 || this.#activeScreenDrops > 0;
	}

	#buildScreenDropGroup(textureView: GPUTextureView): GPUBindGroup {
		return this.#root.unwrap(
			this.#root.createBindGroup(screenDropLayout, {
				dropData: this.#screenDropUniforms,
				verticalOcclusion: this.#verticalOcclusion.view,
				verticalOcclusionCompare: this.#verticalOcclusion.compareSampler,
				verticalOcclusionRaw: this.#verticalOcclusion.rawSampler,
				noiseTex: textureView,
				noiseSampler: this.#repeatSampler,
			}),
		);
	}

	#buildWeatherGroup(label: string, textureView: GPUTextureView): GPUBindGroup {
		return this.#device.createBindGroup({
			label,
			layout: this.#weatherLayout,
			entries: [
				{ binding: 0, resource: { buffer: this.#uniforms, size: SLOT_BYTES } },
				{ binding: 1, resource: this.#verticalOcclusion.view },
				{ binding: 2, resource: this.#verticalOcclusion.compareSampler },
				{ binding: 3, resource: this.#verticalOcclusion.rawSampler },
				{ binding: 4, resource: textureView },
				{ binding: 5, resource: this.#repeatSampler },
			],
		});
	}

	/**
	 * binds the streamed weather particle/wave textures as they arrive
	 *
	 * @param textures the streamed rain, wave, splash, and snowflake textures (`null` when not resident)
	 */
	setTextures(textures: {
		rain: TextureBinding | null;
		wave: TextureBinding | null;
		splash: TextureBinding | null;
		snow: TextureBinding | null;
	}): void {
		const black = placeholder(this.#device, 'black', '2d');
		const rainView = textures.rain?.view ?? black;
		const waveView = textures.wave?.view ?? black;
		const splashView = textures.splash?.view ?? black;
		const snowView = textures.snow?.view ?? black;
		this.#hasRainTex = textures.rain !== null;
		this.#hasWaveTex = textures.wave !== null;
		this.#hasSplashTex = textures.splash !== null;
		this.#hasSnowTex = textures.snow !== null;
		if (rainView !== this.#rainTexView) {
			this.#rainTexView = rainView;
			this.#rainGroup = this.#buildWeatherGroup('weather rain', rainView);
			this.#screenDropGroup = this.#buildScreenDropGroup(rainView);
		}
		if (waveView !== this.#waveTexView) {
			this.#waveTexView = waveView;
			this.#waveGroup = this.#buildWeatherGroup('weather wave', waveView);
		}
		if (splashView !== this.#splashTexView) {
			this.#splashTexView = splashView;
			this.#splashGroup = this.#buildWeatherGroup('weather splash', splashView);
		}
		if (snowView !== this.#snowTexView) {
			this.#snowTexView = snowView;
			this.#snowGroup = this.#buildWeatherGroup('weather snow', snowView);
		}
	}

	/** unbinds all weather textures before the texture store is destroyed */
	clearTextures(): void {
		this.setTextures({ rain: null, wave: null, splash: null, snow: null });
	}

	/**
	 * advances weather animation clocks and prepares this frame's weather draws and uniform slots
	 *
	 * @param input blended rain/snow configs, package weather presetting assets, animation delta, and toggle
	 */
	update(input: {
		rain: RainConfig | null;
		snow: SnowConfig | null;
		assets: WeatherAssets | null;
		cameraRight: Vec3;
		dt: number;
		enabled: boolean;
	}): void {
		const draws = this.#draws;
		draws.length = 0;
		this.#activeScreenDrops = 0;
		if (!input.enabled) {
			return;
		}
		const { rain, snow, assets, dt } = input;
		const data = this.#uniformData;
		const occ = this.#verticalOcclusion;
		let slot = 0;

		const beginSlot = (): number => {
			const base = slot * SLOT_FLOATS;
			data.fill(0, base, base + SLOT_FLOATS);
			data.set(occ.originAndInvSpan, base);
			data.set(occ.metrics, base + 4);
			return slot++;
		};

		// 1. falling rain (near streaks, middle/far curtains, distant rain wave, ground splashes)
		if (rain !== null && rain.enable && rain.intensity > 0) {
			const rp = assets?.rain ?? null;
			const maxRainHeight = rp?.maxRainHeight ?? 150;
			const sceneRainRange = rp?.sceneEffectRainRange ?? 30;
			const sceneRainMaxSpeed = rp?.sceneEffectRainMaxUVFlowSpeed ?? 80;
			const farRainMaxSpeed = rp?.farRainMaxUVFlowSpeed ?? 60;
			const middleDist = rp?.middleRainDistance ?? 15;
			const farDist = rp?.farRainDistance ?? 30;
			const waveDist = rp?.rainWaveDistance ?? 100;
			const occRange = rp?.rainOcclusionMapRange ?? 100;

			const dir = rain.rainDirection ?? [0, -1, 0];
			const dirLen = Math.hypot(dir[0], dir[1], dir[2]);
			const rdx = dirLen > 1e-6 ? dir[0] / dirLen : 0;
			const rdy = dirLen > 1e-6 ? dir[1] / dirLen : -1;
			const rdz = dirLen > 1e-6 ? dir[2] / dirLen : 0;
			const midDir = rain.middleRainDirection ?? [rdx, rdy, rdz];
			const farDir = rain.farRainDirection ?? [rdx, rdy, rdz];
			const rainColor = rain.color ?? [0.7, 0.75, 0.8, 0.35];
			const rR = srgbToLinear(rainColor[0]);
			const rG = srgbToLinear(rainColor[1]);
			const rB = srgbToLinear(rainColor[2]);
			const rA = rainColor[3];
			const intensity01 = clamp01(rain.intensity * 0.01);
			const speed = rain.speed ?? 0.5;
			const streakLen = rain.streakLength ?? 0.6;

			// advance clocks
			this.#rainLayerOffset =
				(this.#rainLayerOffset + (0.5 / maxRainHeight) * speed * 0.05 * sceneRainMaxSpeed * dt) % 10;
			const baseFarStep = (0.5 / maxRainHeight) * speed * 0.05 * farRainMaxSpeed * dt;
			this.#middleRainOffset =
				(this.#middleRainOffset + baseFarStep * (rain.middleRainLayerSpeedDiffMultiplier ?? 1)) % 10;
			this.#farRainOffset =
				(this.#farRainOffset + baseFarStep * (rain.farRainLayerSpeedDiffMultiplier ?? 0.7)) % 10;
			this.#rainWaveOffsetX = (this.#rainWaveOffsetX + dt * (rain.rainWaveHorizontalSpeed ?? 0.05)) % 100;
			this.#rainWaveOffsetY = (this.#rainWaveOffsetY + dt * (rain.rainWaveVerticalSpeed ?? 0.3)) % 100;
			this.#rainSplashOffset = (this.#rainSplashOffset + dt * (rain.rainSplashSpeed ?? 2.5)) % 1000;

			// 1a. near-camera SceneEffectRain layers
			if (this.#hasRainTex) {
				const st = rp?.sceneEffectRainTexST ?? [2, 2, 0.5, 0.4];
				const widthScale = rain.sceneEffectRainWidthScale ?? 0.008;
				const jitter = rain.sceneEffectRainJitterLevel ?? 0.02;
				const lightingPct = rain.sceneEffectRainLightingPercent ?? 0.5;
				for (const scale of RAIN_LAYER_SCALES) {
					const s = beginSlot();
					const base = s * SLOT_FLOATS;
					data[base + 8] = rR;
					data[base + 9] = rG;
					data[base + 10] = rB;
					data[base + 11] = rA;
					data[base + 12] = this.#rainLayerOffset;
					data[base + 13] = widthScale;
					data[base + 14] = streakLen;
					data[base + 15] = intensity01;
					data[base + 16] = -rdx * maxRainHeight;
					data[base + 17] = -rdy * maxRainHeight;
					data[base + 18] = -rdz * maxRainHeight;
					data[base + 19] = jitter;
					data[base + 20] = sceneRainRange * scale;
					data[base + 21] = maxRainHeight;
					data[base + 22] = lightingPct;
					data[base + 23] = 0.5;
					data.set(st, base + 24);
					draws.push({ kind: 'rain', slot: s });
				}
			}

			// 1b. middle rain curtain
			const midAlpha = rA * (rain.middleRainAlphaMultiplier ?? 0.6);
			if (midAlpha > 0.001) {
				const s = beginSlot();
				const base = s * SLOT_FLOATS;
				const st0 = rp?.farRainTex0ST ?? [600, 120, 0, 0];
				data[base + 8] = rR;
				data[base + 9] = rG;
				data[base + 10] = rB;
				data[base + 11] = midAlpha;
				data[base + 12] = this.#middleRainOffset;
				data[base + 13] = streakLen;
				data[base + 14] = intensity01;
				data[base + 16] = st0[0];
				data[base + 17] = st0[1];
				data[base + 18] = rain.middleRainLightingPercent ?? 0.5;
				data[base + 19] = occRange;
				writeCylinderBasis(data, base + 32, midDir, middleDist, maxRainHeight);
				draws.push({ kind: 'farRain', slot: s });
			}

			// 1c. far rain curtain
			const farAlpha = rA * (rain.farRainAlphaMultiplier ?? 0.4);
			if (farAlpha > 0.001) {
				const s = beginSlot();
				const base = s * SLOT_FLOATS;
				const st1 = rp?.farRainTex1ST ?? [800, 80, 0, 0];
				data[base + 8] = rR;
				data[base + 9] = rG;
				data[base + 10] = rB;
				data[base + 11] = farAlpha;
				data[base + 12] = this.#farRainOffset;
				data[base + 13] = streakLen;
				data[base + 14] = intensity01;
				data[base + 16] = st1[0];
				data[base + 17] = st1[1];
				data[base + 18] = 0;
				data[base + 19] = occRange;
				writeCylinderBasis(data, base + 32, farDir, farDist, maxRainHeight);
				draws.push({ kind: 'farRain', slot: s });
			}

			// 1d. distant rain wave curtain
			const waveAlpha = (rain.rainWaveAlpha ?? 0) * intensity01;
			if (this.#hasWaveTex && waveAlpha > 0.001) {
				const s = beginSlot();
				const base = s * SLOT_FLOATS;
				const waveSt = rp?.rainWaveTexST ?? [1, 1, 0, 0];
				const noiseSt = rp?.rainWaveNoiseST ?? [3, 1, 0, 0];
				const noiseMul = rp?.rainWaveNoiseFlowSpeedMultiplier ?? 2;
				data[base + 8] = rR;
				data[base + 9] = rG;
				data[base + 10] = rB;
				data[base + 11] = waveAlpha;
				data[base + 12] = this.#rainWaveOffsetX;
				data[base + 13] = this.#rainWaveOffsetY;
				data[base + 14] = -this.#rainWaveOffsetX * noiseMul;
				data[base + 15] = this.#rainWaveOffsetY * noiseMul;
				data[base + 19] = occRange;
				data[base + 20] = 1;
				data[base + 21] = rain.rainWaveBottomFadeFactor ?? 0.5;
				data.set(waveSt, base + 24);
				data.set(noiseSt, base + 28);
				writeCylinderBasis(data, base + 32, [0, -1, 0], waveDist, maxRainHeight);
				draws.push({ kind: 'farRain', slot: s });
			}

			// 1e. ground rain splashes
			const splashCount = rain.rainSplashCount ?? 0;
			const splashAlpha = rain.rainSplashAlpha ?? 0;
			if (this.#hasSplashTex && splashCount > 0 && splashAlpha > 0.001 && occ.active) {
				const s = beginSlot();
				const base = s * SLOT_FLOATS;
				const cols = Math.max(1, rp?.rainSplashTextureRowColumnCount ?? 6);
				const splashRange = rp?.rainSplashRange ?? 15;
				const yBias = rp?.rainSplashYBias ?? 0.3;
				const splashSize = rain.rainSplashMinMaxSize ?? [0.1, 0.25];
				data[base + 8] = rR;
				data[base + 9] = rG;
				data[base + 10] = rB;
				data[base + 11] = splashAlpha * intensity01;
				data[base + 12] = splashRange;
				data[base + 13] = this.#rainSplashOffset;
				data[base + 14] = splashSize[0];
				data[base + 15] = splashSize[1];
				data[base + 16] = cols;
				data[base + 17] = 1 / cols;
				data[base + 18] = yBias;
				data[base + 19] = clamp01((splashCount / 1024) * intensity01);
				data[base + 20] = rain.rainSplashLightingPercent ?? 0.5;
				draws.push({ kind: 'splash', slot: s });
			}

			// 1f. screen-space camera lens raindrops
			const maxDrops = Math.min(
				MAX_SCREEN_DROPS,
				Math.floor((rain.screenDropMaxCountLim ?? 0) * intensity01),
			);
			if (this.#hasRainTex && maxDrops > 0) {
				this.#updateScreenDrops(rain, rp, [rdx, rdy, rdz], input.cameraRight, maxDrops, dt);
			}
		}

		// 2. falling snow layers
		if (snow !== null && snow.enable && snow.intensity > 0 && this.#hasSnowTex) {
			const sp = assets?.snow ?? null;
			const maxSnowHeight = sp?.maxSnowHeight ?? 20;
			const snowRange = sp?.snowRange ?? 50;
			const snowMaxSpeed = sp?.snowMaxUVFlowSpeed ?? 70;
			const st = sp?.snowflakeTexST ?? [0.1, 0.1, 1, 0.95];
			const dir = snow.snowDirection;
			const dirLen = Math.hypot(dir[0], dir[1], dir[2]);
			const sdx = dirLen > 1e-6 ? dir[0] / dirLen : 0;
			const sdy = dirLen > 1e-6 ? dir[1] / dirLen : -1;
			const sdz = dirLen > 1e-6 ? dir[2] / dirLen : 0;
			const speed = (snow.speed[0] + snow.speed[1]) * 0.5;
			const step = speed * 0.05 * snowMaxSpeed * dt;
			this.#snowOffset[0] = (this.#snowOffset[0] + (sdx * step) / (2 * snowRange)) % 1;
			this.#snowOffset[1] = (this.#snowOffset[1] + (sdy * step) / (2 * maxSnowHeight)) % 1;
			this.#snowOffset[2] = (this.#snowOffset[2] + (sdz * step) / (2 * snowRange)) % 1;

			const snowColor = snow.color;
			const sR = srgbToLinear(snowColor[0]);
			const sG = srgbToLinear(snowColor[1]);
			const sB = srgbToLinear(snowColor[2]);
			const sA = snowColor[3];
			const intensity01 = clamp01(snow.intensity * 0.01);
			const size = snow.snowSizeRange;

			for (const scale of SNOW_LAYER_SCALES) {
				if (slot >= MAX_SLOTS) {
					break;
				}
				const s = beginSlot();
				const base = s * SLOT_FLOATS;
				data[base + 8] = sR;
				data[base + 9] = sG;
				data[base + 10] = sB;
				data[base + 11] = sA;
				data[base + 13] = size[0];
				data[base + 14] = size[1];
				data[base + 15] = intensity01;
				data[base + 16] = sdx;
				data[base + 17] = sdy;
				data[base + 18] = sdz;
				data[base + 19] = snow.snowJitterLevel;
				data[base + 20] = snowRange * scale;
				data[base + 21] = maxSnowHeight;
				data[base + 22] = snow.snowLightingPercent;
				data[base + 23] = snow.snowCollisionFadeTimeScale;
				data.set(st, base + 24);
				data[base + 28] = this.#snowOffset[0];
				data[base + 29] = this.#snowOffset[1];
				data[base + 30] = this.#snowOffset[2];
				data[base + 31] = snow.snowTrailLength;
				draws.push({ kind: 'snow', slot: s });
			}
		}

		if (draws.length > 0) {
			this.#device.queue.writeBuffer(this.#uniforms, 0, data, 0, slot * SLOT_FLOATS);
		}
	}

	#ensureFogDepthGroup(scene: SceneTextures): GPUBindGroup {
		if (this.#fogDepthGroup !== null && this.#sceneVersion === scene.version) {
			return this.#fogDepthGroup;
		}
		this.#sceneVersion = scene.version;
		this.#fogDepthGroup = this.#root.unwrap(
			this.#root.createBindGroup(weatherFogDepthLayout, {
				froxels: this.#fogInputs.froxels,
				lutSampler: this.#fogInputs.sampler,
				sceneDepth: scene.depth,
			}),
		);
		return this.#fogDepthGroup;
	}

	#updateScreenDrops(
		rain: RainConfig,
		rp: WeatherAssets['rain'],
		rainDir: Vec3,
		cameraRight: Vec3,
		targetCount: number,
		dt: number,
	): void {
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

		const sd = this.#screenDropData;
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
			const drop = this.#screenDrops[i];
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
		this.#activeScreenDrops = activeCount;
		if (activeCount > 0) {
			this.#device.queue.writeBuffer(this.#screenDropUniforms, 0, sd);
		}
	}

	/**
	 * encodes all active weather draws into the render pass over `composited.target`
	 *
	 * @param pass the render pass over the composited HDR scene with read-only depth
	 * @param scene the main pass's textures (for depth reads in far rain)
	 * @returns number of draw calls encoded
	 */
	encode(pass: GPURenderPassEncoder, scene: SceneTextures): number {
		const draws = this.#draws;
		if (draws.length === 0 && this.#activeScreenDrops === 0) {
			return 0;
		}
		pass.setBindGroup(1, this.#ensureFogDepthGroup(scene));
		pass.setBindGroup(3, this.#postGroup);
		let encoded = 0;
		let lastKind: DrawKind | null = null;
		for (const draw of draws) {
			if (draw.kind !== lastKind) {
				let pipeline: GPURenderPipeline | undefined;
				let mesh: WeatherMesh;
				switch (draw.kind) {
					case 'rain': {
						pipeline = this.#pipelines.get(RAIN_PIPELINE);
						mesh = this.#rainMesh;
						break;
					}
					case 'farRain': {
						pipeline = this.#pipelines.get(FAR_RAIN_PIPELINE);
						mesh = this.#farRainMesh;
						break;
					}
					case 'splash': {
						pipeline = this.#pipelines.get(SPLASH_PIPELINE);
						mesh = this.#splashMesh;
						break;
					}
					case 'snow': {
						pipeline = this.#pipelines.get(SNOW_PIPELINE);
						mesh = this.#rainMesh;
						break;
					}
				}
				if (pipeline === undefined) {
					continue;
				}
				lastKind = draw.kind;
				pass.setPipeline(pipeline);
				pass.setVertexBuffer(0, mesh.vertex);
				pass.setIndexBuffer(mesh.index, 'uint16');
			}
			const offset = draw.slot * SLOT_BYTES;
			switch (draw.kind) {
				case 'rain': {
					pass.setBindGroup(2, this.#rainGroup, [offset]);
					pass.drawIndexed(this.#rainMesh.indexCount);
					break;
				}
				case 'farRain': {
					pass.setBindGroup(2, this.#waveGroup, [offset]);
					pass.drawIndexed(this.#farRainMesh.indexCount);
					break;
				}
				case 'splash': {
					pass.setBindGroup(2, this.#splashGroup, [offset]);
					pass.drawIndexed(this.#splashMesh.indexCount);
					break;
				}
				case 'snow': {
					pass.setBindGroup(2, this.#snowGroup, [offset]);
					pass.drawIndexed(this.#rainMesh.indexCount);
					break;
				}
			}
			encoded++;
		}
		if (this.#activeScreenDrops > 0) {
			const screenDrop = this.#pipelines.get(SCREEN_DROP_PIPELINE);
			if (screenDrop !== undefined) {
				pass.setPipeline(screenDrop);
				pass.setBindGroup(2, this.#screenDropGroup);
				pass.draw(6, this.#activeScreenDrops);
				encoded++;
			}
		}
		return encoded;
	}

	/** resets animation clocks on a camera/level cut */
	reset(): void {
		this.#rainLayerOffset = 0;
		this.#middleRainOffset = 0;
		this.#farRainOffset = 0;
		this.#rainWaveOffsetX = 0;
		this.#rainWaveOffsetY = 0;
		this.#rainSplashOffset = 0;
		this.#snowOffset = [0, 0, 0];
		this.#activeScreenDrops = 0;
		for (const drop of this.#screenDrops) {
			drop.active = false;
		}
	}

	/** frees GPU buffers */
	destroy(): void {
		this.#uniforms.destroy();
		this.#screenDropUniforms.destroy();
		this.#rainMesh.vertex.destroy();
		this.#rainMesh.index.destroy();
		this.#splashMesh.vertex.destroy();
		this.#splashMesh.index.destroy();
		this.#farRainMesh.vertex.destroy();
		this.#farRainMesh.index.destroy();
	}
}
