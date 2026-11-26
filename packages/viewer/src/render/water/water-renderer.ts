import type { GeometryTable } from '@endfield-noclip/package-format/geometry-table';
import type { Vec3 } from '@endfield-noclip/package-format/values';
import type { WaterConfig, WaterTable } from '@endfield-noclip/package-format/water';

import tgpu, { type TgpuRoot } from 'typegpu';

import { BindGroupCache } from '../../gfx/bind-group-cache.ts';
import { createBufferWithData, createUniformBuffer } from '../../gfx/buffers.ts';
import type { PipelineCache } from '../../gfx/pipeline-cache.ts';
import { placeholder } from '../../gfx/placeholders.ts';
import { LINEAR_CLAMP, LINEAR_REPEAT_MIPMAPPED, sampler } from '../../gfx/samplers.ts';
import { TextureSet } from '../../gfx/texture-set.ts';
import { GeometryFlags } from '../../looks/look.ts';
import { type Plane, boxInFrustum } from '../../scene/camera.ts';
import type { StreamManager } from '../../streaming/stream-manager.ts';
import { streamWholeTexture } from '../../streaming/texture-requests.ts';
import {
	DEPTH_CLEAR,
	DEPTH_COMPARE,
	HDR_FORMAT,
	type SceneTextures,
	WATER_DEPTH_FORMAT,
	WATER_FOAM_FORMAT,
} from '../core/render-targets.ts';
import type { ResidentGeometry } from '../core/resident.ts';
import { FRONT_FACE, POSITION_FORMATS, type PositionFormat } from '../meshes/pipeline-variants.ts';
import { NORMAL_STREAM, positionStream } from '../meshes/vertex-bindings.ts';
import type { TextureBinding, TextureStore } from '../textures/texture-store.ts';

import {
	WATER_CONFIG_FLOATS,
	WATER_SURFACE_FLOATS,
	fsWater,
	fsWaterDepth,
	vsWater,
	waterLayout,
} from './water-shader.ts';

/**
 * floats of the `water` uniform in water-shader.ts (3 base vec4s + 5 reprojection vec4s + 1 sector window
 * vec4)
 */
const PARAM_FLOATS = 36;
/** edge of the camera-centred sector flow atlas, in sector tiles */
const SECTOR_GRID = 3;
const MAX_SURFACES = 4096;
/** priority of the surfaces' geometry at 1 m, and of their textures */
const PRIORITY = 1e5;
/** the pipeline that shades the surfaces */
const SHADE_KEY = 'water';
/** the pipeline that lays down the nearest surface's depth (`SceneTextures.waterDepth`) */
const DEPTH_KEY = 'water/depth';

/** the layouts of the groups the water pass shares with other passes */
interface WaterLayouts {
	/** the main pass's frame group (group 0) */
	frame: GPUBindGroupLayout;
	/** the post uniforms (group 3) */
	uniforms: GPUBindGroupLayout;
	/** the sky's reads (group 1) */
	sky: GPUBindGroupLayout;
}

/** what the water pass reads from the main pass and the post chain */
export interface WaterContext {
	scene: SceneTextures;
	/** a copy of the composited scene, which the pass refracts (and reflects when no previous frame exists) */
	background: GPUTextureView;
	/**
	 * last frame's resolved HDR scene (including transparents and particles), which water SSR reflects, or
	 * `null`
	 */
	reflectionScene: GPUTextureView | null;
	/** last frame's camera reprojection (16 floats view-proj + 3 eye delta + 1 invalid flag) */
	reprojection: Float32Array;
	/** the main pass's frame group and its uniforms' dynamic offset */
	frame: { group: GPUBindGroup; offset: number };
	/** groups of {@link WaterLayouts.uniforms} and {@link WaterLayouts.sky} */
	postUniforms: GPUBindGroup;
	sky: GPUBindGroup;
	/** bumped whenever the scene textures change */
	version: number;
	/** the main pass's size, px */
	width: number;
	height: number;
	/** whether {@link WaterRenderer.foamTarget} holds this frame's WaterDecal boxes */
	foam: boolean;
}

/** the foam the boxes leave on the water surface */
interface FoamTargets {
	/** the scene textures' version they were made at */
	version: number;
	foamView: GPUTextureView;
}

interface Draw {
	geometry: ResidentGeometry;
	slot: number;
}

/** a 3×3 GPU atlas of the camera's nearest high-res sector flow tiles */
interface SectorAtlas {
	texture: GPUTexture;
	view: GPUTextureView;
	tileWidth: number;
	tileHeight: number;
	format: GPUTextureFormat;
}

interface SectorCopy {
	src: GPUTexture;
	cellX: number;
	cellZ: number;
}

/** packs one config the way `Config` in water-shader.ts reads it */
const packConfig = (c: WaterConfig, out: Float32Array, at: number): void => {
	const rows = [
		c.waterRayleighScatteringMeter,
		c.waterRayleighAbsorptionMeter,
		c.waterRayleighAbsorptionMeter2,
		[c.safeFullAbsorpDistance, c.envLightIntensity, c.distanceEdgeBlendFactor, c.rayleighMieLerpFactor],
		[c.roughness, c.specular, c.waterIOR, c.envLightSpecularIntensity],
		[c.flowSpeed, c.normalTilling, c.normalScale, c.flowFullCycle],
		[c.largeWaveSignedSpeed, c.largeWaveNormalTilling, c.largeWaveNormalScale, c.flowFullCycleLarge],
		[...c.flowDirectionVector2, c.useFlowMap ? 1 : 0, c.flowMapCoverage ? 1 : 0],
		[c.smallWaveNormalType, c.largeWaveNormalType, c.dirSpecNormalScaler, c.sceneColorEnvInfluence],
		[c.distanceFade, c.distanceNormalMinStrength, c.normalMipBias, c.foamRoughness],
		// colours go in as authored, as the game copies them
		[c.foamColorG[0], c.foamColorG[1], c.foamColorG[2], c.foamOpacity],
		[c.foamShapeOffset, c.foamFadeRate, c.waterBaseColorSubsurfaceScaler, c.emissiveStrength],
		[c.causticTilling, c.causticOpacity, c.causticDistort, c.causticSpeed],
		[c.causticStartDepth, c.causticEndDepth, 0, 0],
	];
	rows.forEach((row, i) => out.set(row, at + i * 4));
};

/** owns the water pipeline, its buffers and the per-frame surface list */
export class WaterRenderer {
	#root: TgpuRoot;
	#device: GPUDevice;
	/** compiles {@link SHADE_KEY} and {@link DEPTH_KEY} */
	#pipelines: PipelineCache;
	/** the foam the boxes leave on the surface, at the main pass's size */
	#foamTargets: FoamTargets | null = null;
	/** the texture behind {@link #foamTargets} */
	#foam: TextureSet;
	/** bound in place of the water's depth while the depth pass draws into it */
	#noWaterDepth: GPUTexture;
	#noWaterDepthView: GPUTextureView;
	/** bound in place of the foam while there are no foam targets */
	#noFoam: GPUTextureView;
	#surfaces: GPUBuffer;
	#surfaceData = new Float32Array(MAX_SURFACES * WATER_SURFACE_FLOATS);
	#surfaceWords = new Uint32Array(this.#surfaceData.buffer);
	#configs: GPUBuffer | null = null;
	#params: GPUBuffer;
	#paramData = new Float32Array(PARAM_FLOATS);
	#paramWords = new Uint32Array(this.#paramData.buffer);
	#repeat: GPUSampler;
	#clamp: GPUSampler;
	#noNormals: GPUTextureView;
	#noFlow: GPUTextureView;
	#table: WaterTable | null = null;
	#draws: Draw[] = [];
	#normals: TextureBinding | null = null;
	#flow: TextureBinding | null = null;
	#caustics: TextureBinding | null = null;
	/** by `"x,z"`, the texture id of each packed sector flow tile */
	#sectorIds = new Map<string, number>();
	/** 3×3 sector flow atlas around the camera, created on first resident sector tile */
	#sectorAtlas: SectorAtlas | null = null;
	/** origin of the current 3×3 sector window, in sector grid coords (`NaN` until placed) */
	#sectorWinX = Number.NaN;
	#sectorWinZ = Number.NaN;
	/** per 3×3 cell (`z * 3 + x`): texture id and binding version already copied into {@link #sectorAtlas} */
	#sectorSlots = Array.from({ length: SECTOR_GRID * SECTOR_GRID }, () => ({ id: -1, version: -1 }));
	/** copies to issue into {@link #sectorAtlas} before the water shading pass */
	#pendingSectorCopies: SectorCopy[] = [];
	/** group 2, per water depth view bound: the depth pass's placeholder or the scene's */
	#groups = new BindGroupCache<GPUTextureView>();

	/**
	 * @param root the TypeGPU root
	 * @param pipelines the pipeline cache, which compiles the water's pipelines
	 * @param layouts the shared groups' layouts
	 */
	constructor(root: TgpuRoot, pipelines: PipelineCache, layouts: WaterLayouts) {
		const device = root.device;
		this.#root = root;
		this.#device = device;
		this.#pipelines = pipelines;
		this.#foam = new TextureSet(device);
		const module = pipelines.module('water', tgpu.resolve([vsWater, fsWater, fsWaterDepth]));
		const layout = device.createPipelineLayout({
			label: 'water',
			bindGroupLayouts: [layouts.frame, layouts.sky, root.unwrap(waterLayout), layouts.uniforms],
		});
		// the shader drops back faces, by the winding the transform leaves
		const primitive: GPUPrimitiveState = {
			topology: 'triangle-list',
			frontFace: FRONT_FACE,
			cullMode: 'none',
		};
		for (const positionFormat of POSITION_FORMATS) {
			const vertex: GPUVertexState = {
				module,
				entryPoint: 'vsWater',
				// meshes without normals bind their positions as them, which the shader ignores
				buffers: [positionStream(positionFormat), NORMAL_STREAM],
			};
			void pipelines.prepare(`${SHADE_KEY}/${positionFormat}`, () => ({
				layout,
				vertex,
				fragment: { module, entryPoint: 'fsWater', targets: [{ format: HDR_FORMAT }] },
				primitive,
			}));
			void pipelines.prepare(`${DEPTH_KEY}/${positionFormat}`, () => ({
				layout,
				vertex,
				fragment: { module, entryPoint: 'fsWaterDepth', targets: [] },
				primitive,
				depthStencil: { format: WATER_DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: DEPTH_COMPARE },
			}));
		}
		this.#surfaces = device.createBuffer({
			label: 'water surfaces',
			size: this.#surfaceData.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		this.#params = createUniformBuffer(device, 'water params', this.#paramData.byteLength);
		this.#repeat = sampler(device, { ...LINEAR_REPEAT_MIPMAPPED, maxAnisotropy: 4 });
		this.#clamp = sampler(device, LINEAR_CLAMP);
		this.#noFlow = placeholder(device, 'black', '2d');
		this.#noNormals = placeholder(device, 'black', '2d-array');
		this.#noFoam = placeholder(device, 'black', '2d');
		this.#noWaterDepth = device.createTexture({
			label: 'no water depth',
			size: [1, 1],
			format: WATER_DEPTH_FORMAT,
			usage: GPUTextureUsage.TEXTURE_BINDING,
		});
		this.#noWaterDepthView = this.#noWaterDepth.createView();
	}

	/** @param table the package's water, or `null` */
	setTable(table: WaterTable | null): void {
		this.#table = table;
		this.#configs?.destroy();
		this.#configs = null;
		this.#sectorIds.clear();
		this.#sectorAtlas?.texture.destroy();
		this.#sectorAtlas = null;
		this.#sectorWinX = Number.NaN;
		this.#sectorWinZ = Number.NaN;
		for (const slot of this.#sectorSlots) {
			slot.id = -1;
			slot.version = -1;
		}
		this.#pendingSectorCopies.length = 0;
		this.#groups.clear();
		this.clear();
		if (table === null || table.configs.length === 0) {
			return;
		}
		for (const sector of table.global?.sectors ?? []) {
			if (sector.texture !== null) {
				this.#sectorIds.set(`${sector.x},${sector.z}`, sector.texture);
			}
		}
		const data = new Float32Array(table.configs.length * WATER_CONFIG_FLOATS);
		table.configs.forEach((config, i) => packConfig(config.values, data, i * WATER_CONFIG_FLOATS));
		this.#configs = createBufferWithData(this.#device, {
			label: 'water configs',
			usage: GPUBufferUsage.STORAGE,
			data,
		});
	}

	#groupsShown: readonly boolean[] = [];

	/** @param shown per visibility group of the package, whether its content shows; others aren't drawn */
	setGroupsShown(shown: readonly boolean[]): void {
		this.#groupsShown = shown;
	}

	/** draws nothing until the next {@link prepare} */
	clear(): void {
		this.#draws.length = 0;
	}

	/**
	 * picks this frame's surfaces and streams what they need.
	 *
	 * @param input the camera, the stream and tables
	 */
	prepare(input: {
		eye: Vec3;
		planes: readonly Plane[];
		stream: StreamManager;
		geometries: GeometryTable;
		textures: TextureStore;
		/** the sun as the water column takes it: `Environment.sunRaw` */
		sun: Vec3;
		/** per water volume, metres its surface sits above where it was packed */
		volumeOffsets: Float32Array;
	}): void {
		const { eye, planes, stream, geometries, textures, sun, volumeOffsets } = input;
		const table = this.#table;
		this.clear();
		if (table === null) {
			return;
		}
		const data = this.#surfaceData;
		const words = this.#surfaceWords;
		let slot = 0;
		for (const surface of table.surfaces) {
			if (!(this.#groupsShown[surface.group] ?? false)) {
				continue;
			}
			const blob = geometries.blob(surface.geometry);
			if (blob === null) {
				continue;
			}
			// a water volume's surface rises and falls with its fill
			const lift = surface.kind === 'volume' ? (volumeOffsets[surface.volume] ?? 0) : 0;
			const { min: packedMin, max: packedMax } = surface.bounds;
			const min: Vec3 = [packedMin[0], packedMin[1] + lift, packedMin[2]];
			const max: Vec3 = [packedMax[0], packedMax[1] + lift, packedMax[2]];
			const dx = Math.max(min[0] - eye[0], 0, eye[0] - max[0]);
			const dz = Math.max(min[2] - eye[2], 0, eye[2] - max[2]);
			const item = stream.want(blob, PRIORITY / (1 + Math.hypot(dx, dz)));
			const resident = item?.resident;
			if (resident?.kind !== 'geometry' || slot >= MAX_SURFACES || !boxInFrustum(planes, min, max, eye)) {
				continue;
			}
			const t = surface.transform;
			const at = slot * WATER_SURFACE_FLOATS;
			for (let r = 0; r < 3; r++) {
				data[at + r * 4] = t[r * 4];
				data[at + r * 4 + 1] = t[r * 4 + 1];
				data[at + r * 4 + 2] = t[r * 4 + 2];
				data[at + r * 4 + 3] = t[r * 4 + 3] + (r === 1 ? lift : 0) - eye[r];
			}
			data.set(resident.positionOffset, at + 12);
			words[at + 15] = surface.config;
			data.set(resident.positionScale, at + 16);
			// volumes are flat polygons facing up
			data[at + 19] =
				surface.kind === 'placed' && (resident.streamFlags & GeometryFlags.HasNormals) !== 0 ? 1 : 0;
			this.#draws.push({ geometry: resident, slot });
			slot++;
		}
		if (slot === 0) {
			return;
		}
		this.#device.queue.writeBuffer(this.#surfaces, 0, data, 0, slot * WATER_SURFACE_FLOATS);

		const global = table.global;
		const streamBinding = (id: number | null, kind: '2d' | '2d-array'): TextureBinding | null =>
			streamWholeTexture({ stream, textures, id, kind, priority: PRIORITY })?.binding ?? null;
		this.#normals = streamBinding(global?.normalMaps ?? null, '2d-array');
		this.#flow = streamBinding(global?.flowMap ?? null, '2d');
		this.#caustics = streamBinding(global?.causticMap ?? null, '2d');
		const sectorMask = this.#prepareSectors(eye, global, stream, textures);
		const params = this.#paramData;
		params[0] = this.#normals === null ? 0 : 1;
		params[1] = this.#flow === null ? 0 : 1;
		params[2] = global?.mapSize ?? 1;
		params[3] = this.#caustics === null ? 0 : 1;
		params[4] = global?.center[0] ?? 0;
		params[5] = global?.center[1] ?? 0;
		params[7] = this.#sectorAtlas?.tileWidth ?? 256;
		params.set(sun, 8);
		const sectorSize = global?.sectorSize ?? 128;
		params[32] = Number.isFinite(this.#sectorWinX) ? this.#sectorWinX * sectorSize : 0;
		params[33] = Number.isFinite(this.#sectorWinZ) ? this.#sectorWinZ * sectorSize : 0;
		params[34] = sectorSize;
		this.#paramWords[35] = sectorMask;
		this.#device.queue.writeBuffer(this.#params, 0, params);
	}

	/**
	 * streams the 3×3 high-res sector flow tiles around the camera and queues GPU copies into
	 * {@link #sectorAtlas} whenever the window shifts or a tile finishes loading
	 *
	 * @returns a 9-bit mask (`cellZ * 3 + cellX`) of cells ready in {@link #sectorAtlas}
	 */
	#prepareSectors(
		eye: Vec3,
		global: WaterTable['global'],
		stream: StreamManager,
		textures: TextureStore,
	): number {
		this.#pendingSectorCopies.length = 0;
		if (global === null || this.#sectorIds.size === 0 || global.sectorSize <= 0) {
			return 0;
		}
		const sx = Math.floor((eye[0] - global.center[0]) / global.sectorSize);
		const sz = Math.floor((eye[2] - global.center[1]) / global.sectorSize);
		const winX = sx - 1;
		const winZ = sz - 1;
		if (winX !== this.#sectorWinX || winZ !== this.#sectorWinZ) {
			this.#sectorWinX = winX;
			this.#sectorWinZ = winZ;
			for (const slot of this.#sectorSlots) {
				slot.id = -1;
				slot.version = -1;
			}
		}
		let mask = 0;
		for (let j = 0; j < SECTOR_GRID; j++) {
			for (let i = 0; i < SECTOR_GRID; i++) {
				const id = this.#sectorIds.get(`${winX + i},${winZ + j}`);
				if (id === undefined) {
					continue;
				}
				const streamed = streamWholeTexture({ stream, textures, id, kind: '2d', priority: PRIORITY });
				const binding = streamed?.binding ?? null;
				const gpu = binding === null ? null : textures.gpuTexture(id);
				if (binding === null || gpu === null) {
					continue;
				}
				if (this.#sectorAtlas === null) {
					const texture = this.#device.createTexture({
						label: 'water sector flow 3x3',
						size: [gpu.width * SECTOR_GRID, gpu.height * SECTOR_GRID],
						format: gpu.format,
						usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
					});
					this.#sectorAtlas = {
						texture,
						view: texture.createView(),
						tileWidth: gpu.width,
						tileHeight: gpu.height,
						format: gpu.format,
					};
				}
				const atlas = this.#sectorAtlas;
				if (gpu.width !== atlas.tileWidth || gpu.height !== atlas.tileHeight || gpu.format !== atlas.format) {
					continue;
				}
				const cell = j * SECTOR_GRID + i;
				const slot = this.#sectorSlots[cell];
				if (slot.id !== id || slot.version !== binding.version) {
					this.#pendingSectorCopies.push({ src: gpu, cellX: i, cellZ: j });
					slot.id = id;
					slot.version = binding.version;
				}
				mask |= 1 << cell;
			}
		}
		return mask;
	}

	/**
	 * @param context what the pass reads
	 * @param waterDepth bound as the water's depth: the scene's, or a placeholder while drawing into it
	 */
	#bindGroup(context: WaterContext, waterDepth: GPUTextureView): GPUBindGroup | null {
		const configs = this.#configs;
		if (configs === null) {
			return null;
		}
		const foam = this.#foamTargets?.foamView ?? this.#noFoam;
		const sectorFlow = this.#sectorAtlas?.view ?? this.#noFlow;
		const reflectionScene = context.reflectionScene ?? context.background;
		const parts = [
			context.version,
			context.background,
			reflectionScene,
			this.#normals,
			this.#flow,
			this.#caustics,
			foam,
			sectorFlow,
		];
		return this.#groups.get(waterDepth, parts, () =>
			this.#createGroup(context, waterDepth, configs, foam, sectorFlow, reflectionScene),
		);
	}

	/** @returns group 2 over the current textures */
	#createGroup(
		context: WaterContext,
		waterDepth: GPUTextureView,
		configs: GPUBuffer,
		foam: GPUTextureView,
		sectorFlow: GPUTextureView,
		reflectionScene: GPUTextureView,
	): GPUBindGroup {
		return this.#root.unwrap(
			this.#root.createBindGroup(waterLayout, {
				surfaces: this.#surfaces,
				configs,
				background: context.background,
				depthTexture: context.scene.depth,
				waveNormals: this.#normals?.view ?? this.#noNormals,
				flowMap: this.#flow?.view ?? this.#noFlow,
				repeatSampler: this.#repeat,
				water: this.#params,
				causticMap: this.#caustics?.view ?? this.#noFlow,
				foamTexture: foam,
				reflectionScene,
				clampSampler: this.#clamp,
				waterDepthTexture: waterDepth,
				sectorFlow,
			}),
		);
	}

	/** @returns whether there's anything to draw this frame, with all pipelines compiled */
	get active(): boolean {
		return (
			this.#draws.length > 0 &&
			this.#configs !== null &&
			POSITION_FORMATS.every(
				(format) =>
					this.#pipelines.get(`${SHADE_KEY}/${format}`) !== undefined &&
					this.#pipelines.get(`${DEPTH_KEY}/${format}`) !== undefined,
			)
		);
	}

	/**
	 * clears the nearest water surface's depth (`SceneTextures.waterDepth`) and, when there's water to draw,
	 * draws it. call before the composite, which reads it, whenever {@link encode} follows; otherwise
	 * {@link clearDepth}. both draw only while {@link active}.
	 *
	 * @param encoder this frame's encoder
	 * @param context what the pass reads
	 */
	encodeDepth(encoder: GPUCommandEncoder, context: WaterContext): number {
		const pass = WaterRenderer.#beginDepthPass(encoder, context.scene.waterDepth);
		const group = this.active ? this.#bindGroup(context, this.#noWaterDepthView) : null;
		const draws = group !== null ? this.#drawSurfaces(pass, DEPTH_KEY, group, context) : 0;
		pass.end();
		return draws;
	}

	/**
	 * clears the nearest water surface's depth to none, for frames that draw no water.
	 *
	 * @param encoder this frame's encoder
	 * @param scene the scene textures
	 */
	clearDepth(encoder: GPUCommandEncoder, scene: SceneTextures): void {
		WaterRenderer.#beginDepthPass(encoder, scene.waterDepth).end();
	}

	static #beginDepthPass(encoder: GPUCommandEncoder, view: GPUTextureView): GPURenderPassEncoder {
		return encoder.beginRenderPass({
			label: 'water depth',
			colorAttachments: [],
			depthStencilAttachment: {
				view,
				depthClearValue: DEPTH_CLEAR,
				depthLoadOp: 'clear',
				depthStoreOp: 'store',
			},
		});
	}

	/**
	 * the target the WaterDecal boxes draw into, projected onto the water surface's depth
	 * (`SceneTextures.waterDepth`); whoever draws them clears it to (0, 0, 0, 1) first and sets
	 * {@link WaterContext.foam} for {@link encode}
	 *
	 * @param context what the pass reads
	 * @returns the foam target, at the main pass's size
	 */
	foamTarget(context: WaterContext): GPUTextureView {
		return this.#ensureFoamTargets(context).foamView;
	}

	/**
	 * draws this frame's surfaces into the scene, after {@link encodeDepth} and any foam, and before the
	 * transparent pass, as the game lights its water before drawing transparent things.
	 *
	 * @param encoder this frame's encoder
	 * @param target the composited HDR scene, drawn over
	 * @param context what the pass reads
	 */
	encode(encoder: GPUCommandEncoder, target: GPUTextureView, context: WaterContext): number {
		if (!this.active) {
			return 0;
		}
		if (this.#sectorAtlas !== null && this.#pendingSectorCopies.length > 0) {
			const { texture, tileWidth, tileHeight } = this.#sectorAtlas;
			for (const copy of this.#pendingSectorCopies) {
				encoder.copyTextureToTexture(
					{ texture: copy.src },
					{ texture, origin: [copy.cellX * tileWidth, copy.cellZ * tileHeight, 0] },
					[tileWidth, tileHeight, 1],
				);
			}
			this.#pendingSectorCopies.length = 0;
		}
		this.#paramData[6] = context.foam ? 1 : 0;
		this.#paramData.set(context.reprojection, 12);
		this.#device.queue.writeBuffer(this.#params, 0, this.#paramData);
		const group = this.#bindGroup(context, context.scene.waterDepth);
		if (group === null) {
			return 0;
		}
		const pass = encoder.beginRenderPass({
			label: 'water',
			colorAttachments: [{ view: target, loadOp: 'load', storeOp: 'store' }],
		});
		const draws = this.#drawSurfaces(pass, SHADE_KEY, group, context);
		pass.end();
		return draws;
	}

	/** the foam targets at the main pass's size, made again when the scene textures change */
	#ensureFoamTargets(context: WaterContext): FoamTargets {
		const current = this.#foamTargets;
		if (current !== null && current.version === context.version) {
			return current;
		}
		this.#foam.destroy();
		const foam = this.#foam.create({
			label: 'water foam',
			size: [context.width, context.height],
			format: WATER_FOAM_FORMAT,
		});
		this.#foamTargets = { version: context.version, foamView: foam.createView() };
		return this.#foamTargets;
	}

	#drawSurfaces(
		pass: GPURenderPassEncoder,
		pipelinePrefix: string,
		group: GPUBindGroup,
		context: WaterContext,
	): number {
		pass.setBindGroup(0, context.frame.group, [context.frame.offset]);
		pass.setBindGroup(1, context.sky);
		pass.setBindGroup(2, group);
		pass.setBindGroup(3, context.postUniforms);
		let boundFormat: PositionFormat | null = null;
		let draws = 0;
		for (const { geometry, slot } of this.#draws) {
			if (geometry.positionFormat !== boundFormat) {
				const pipeline = this.#pipelines.get(`${pipelinePrefix}/${geometry.positionFormat}`);
				if (pipeline === undefined) {
					continue;
				}
				pass.setPipeline(pipeline);
				boundFormat = geometry.positionFormat;
			}
			// positions and normals, as the meshes bind them; without normals in the mesh the shader ignores slot 1
			const [position, normal] = geometry.vertices.streams;
			pass.setVertexBuffer(0, position.buffer, position.offset, position.size);
			pass.setVertexBuffer(1, normal.buffer ?? position.buffer, normal.offset, normal.size);
			pass.setIndexBuffer(geometry.indices.buffer, geometry.indices.format);
			for (const submesh of geometry.submeshes) {
				pass.drawIndexed(submesh.indexCount, 1, submesh.firstIndex, submesh.baseVertex, slot);
				draws++;
			}
		}
		return draws;
	}

	/** @returns bytes of the water buffers and foam/sector targets */
	get bytes(): number {
		let atlasBytes = 0;
		if (this.#sectorAtlas !== null) {
			const tex = this.#sectorAtlas.texture;
			atlasBytes = tex.width * tex.height * (tex.format === 'rgba8unorm' ? 4 : 1);
		}
		return (
			this.#foam.bytes + this.#surfaces.size + (this.#configs?.size ?? 0) + this.#params.size + atlasBytes
		);
	}

	/** frees the buffers */
	destroy(): void {
		this.#surfaces.destroy();
		this.#configs?.destroy();
		this.#params.destroy();
		this.#foam.destroy();
		this.#noWaterDepth.destroy();
		this.#sectorAtlas?.texture.destroy();
	}
}
