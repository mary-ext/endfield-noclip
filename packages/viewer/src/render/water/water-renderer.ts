import type { GeometryTable } from '@endfield-noclip/package-format/geometry-table';
import type { Vec3 } from '@endfield-noclip/package-format/values';
import type { WaterConfig, WaterTable } from '@endfield-noclip/package-format/water';

import { BindGroupCache } from '../../gfx/bind-group-cache.ts';
import { createBufferWithData, createUniformBuffer } from '../../gfx/buffers.ts';
import type { PipelineCache } from '../../gfx/pipeline-cache.ts';
import { placeholder } from '../../gfx/placeholders.ts';
import { LINEAR_REPEAT_MIPMAPPED, sampler } from '../../gfx/samplers.ts';
import { TextureSet } from '../../gfx/texture-set.ts';
import { type Plane, boxInFrustum } from '../../scene/camera.ts';
import type { ResidentGeometry } from '../../streaming/resident.ts';
import type { StreamManager } from '../../streaming/stream-manager.ts';
import { streamWholeTexture } from '../../streaming/texture-requests.ts';
import { FRAME_WGSL } from '../frame/frame-uniforms.ts';
import {
	DEPTH_CLEAR,
	DEPTH_COMPARE,
	HDR_FORMAT,
	type SceneTextures,
	WATER_DEPTH_FORMAT,
	WATER_FOAM_FORMAT,
} from '../frame/render-targets.ts';
import { NORMAL_STREAM, POSITION_STREAM } from '../meshes/vertex-bindings.ts';
import { postCommonSource } from '../post/shader-source.ts';
import screenSpaceWgsl from '../shaders/common/screen-space.wgsl?raw';
import { SkyBinding } from '../sky/atmosphere-luts.ts';
import atmosphereWgsl from '../sky/atmosphere.wgsl?raw';
import { fogSource } from '../sky/fog-source.ts';
import type { TextureBinding, TextureStore } from '../textures/texture-store.ts';

import ssrTraceWgsl from './ssr-trace.wgsl?raw';
import waterWgsl from './water.wgsl?raw';

/** floats of `Surface` in water.wgsl */
const SURFACE_FLOATS = 20;
/** floats of `Config` in water.wgsl */
const CONFIG_FLOATS = 56;
/** floats of the `water` uniform in water.wgsl */
const PARAM_FLOATS = 12;
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
	/** a copy of the composited scene, which the pass refracts and reflects */
	background: GPUTextureView;
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

/**
 * @returns the water shader: the frame's lighting at group 0, then the post passes' helpers with their
 *   uniforms moved to group 3
 */
const waterShaderSource = (): string =>
	[
		FRAME_WGSL,
		postCommonSource(3),
		atmosphereWgsl,
		fogSource({ group: 1, binding: SkyBinding.froxels }),
		screenSpaceWgsl,
		ssrTraceWgsl,
		waterWgsl,
	].join('\n');

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

/** packs one config the way `Config` in water.wgsl reads it */
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
	#device: GPUDevice;
	#layout: GPUBindGroupLayout;
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
	#surfaceData = new Float32Array(MAX_SURFACES * SURFACE_FLOATS);
	#surfaceWords = new Uint32Array(this.#surfaceData.buffer);
	#configs: GPUBuffer | null = null;
	#params: GPUBuffer;
	#paramData = new Float32Array(PARAM_FLOATS);
	#repeat: GPUSampler;
	#noNormals: GPUTextureView;
	#noFlow: GPUTextureView;
	#table: WaterTable | null = null;
	#draws: Draw[] = [];
	#normals: TextureBinding | null = null;
	#flow: TextureBinding | null = null;
	#caustics: TextureBinding | null = null;
	/** group 2, per water depth view bound: the depth pass's placeholder or the scene's */
	#groups = new BindGroupCache<GPUTextureView>();

	/**
	 * @param device the device
	 * @param pipelines the pipeline cache, which compiles the water's pipelines
	 * @param layouts the shared groups' layouts
	 */
	constructor(device: GPUDevice, pipelines: PipelineCache, layouts: WaterLayouts) {
		this.#device = device;
		this.#pipelines = pipelines;
		this.#foam = new TextureSet(device);
		const module = pipelines.module('water', waterShaderSource());
		const fragment = GPUShaderStage.FRAGMENT;
		const texture = (
			binding: number,
			sampleType: GPUTextureSampleType,
			viewDimension: GPUTextureViewDimension = '2d',
		): GPUBindGroupLayoutEntry => ({ binding, visibility: fragment, texture: { sampleType, viewDimension } });
		this.#layout = device.createBindGroupLayout({
			label: 'water',
			entries: [
				{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
				{ binding: 1, visibility: fragment, buffer: { type: 'read-only-storage' } },
				texture(2, 'unfilterable-float'),
				texture(3, 'depth'),
				texture(4, 'float', '2d-array'),
				texture(5, 'float'),
				{ binding: 6, visibility: fragment, sampler: { type: 'filtering' } },
				{ binding: 7, visibility: fragment, buffer: { type: 'uniform' } },
				texture(8, 'float'),
				texture(10, 'float'),
				texture(14, 'depth'),
			],
		});
		const layout = device.createPipelineLayout({
			label: 'water',
			bindGroupLayouts: [layouts.frame, layouts.sky, this.#layout, layouts.uniforms],
		});
		const vertex: GPUVertexState = {
			module,
			entryPoint: 'vs_water',
			// meshes without normals bind their positions as them, which the shader ignores
			buffers: [POSITION_STREAM, NORMAL_STREAM],
		};
		// seen from below too
		const primitive: GPUPrimitiveState = { topology: 'triangle-list', cullMode: 'none' };
		void pipelines.prepare(SHADE_KEY, () => ({
			layout,
			vertex,
			fragment: { module, entryPoint: 'fs_water', targets: [{ format: HDR_FORMAT }] },
			primitive,
		}));
		void pipelines.prepare(DEPTH_KEY, () => ({
			layout,
			vertex,
			fragment: { module, entryPoint: 'fs_water_depth', targets: [] },
			primitive,
			depthStencil: { format: WATER_DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: DEPTH_COMPARE },
		}));
		this.#surfaces = device.createBuffer({
			label: 'water surfaces',
			size: this.#surfaceData.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		this.#params = createUniformBuffer(device, 'water params', this.#paramData.byteLength);
		this.#repeat = sampler(device, { ...LINEAR_REPEAT_MIPMAPPED, maxAnisotropy: 4 });
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
		this.#groups.clear();
		this.clear();
		if (table === null || table.configs.length === 0) {
			return;
		}
		const data = new Float32Array(table.configs.length * CONFIG_FLOATS);
		table.configs.forEach((config, i) => packConfig(config.values, data, i * CONFIG_FLOATS));
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
			const at = slot * SURFACE_FLOATS;
			for (let r = 0; r < 3; r++) {
				data[at + r * 4] = t[r * 4];
				data[at + r * 4 + 1] = t[r * 4 + 1];
				data[at + r * 4 + 2] = t[r * 4 + 2];
				data[at + r * 4 + 3] = t[r * 4 + 3] + (r === 1 ? lift : 0) - eye[r];
			}
			data.set(resident.positionOffset, at + 12);
			words[at + 15] = surface.config;
			data.set(resident.positionScale, at + 16);
			data[at + 19] = surface.meshNormals && resident.normalOffset !== null ? 1 : 0;
			this.#draws.push({ geometry: resident, slot });
			slot++;
		}
		if (slot === 0) {
			return;
		}
		this.#device.queue.writeBuffer(this.#surfaces, 0, data, 0, slot * SURFACE_FLOATS);

		const global = table.global;
		const streamBinding = (id: number | null, kind: '2d' | '2d-array'): TextureBinding | null =>
			streamWholeTexture({ stream, textures, id, kind, priority: PRIORITY })?.binding ?? null;
		this.#normals = streamBinding(global?.normalMaps ?? null, '2d-array');
		this.#flow = streamBinding(global?.flowMap ?? null, '2d');
		this.#caustics = streamBinding(global?.causticMap ?? null, '2d');
		const params = this.#paramData;
		params[0] = this.#normals === null ? 0 : 1;
		params[1] = this.#flow === null ? 0 : 1;
		params[2] = global?.mapSize ?? 1;
		params[3] = this.#caustics === null ? 0 : 1;
		params[4] = global?.center[0] ?? 0;
		params[5] = global?.center[1] ?? 0;
		params.set(sun, 8);
		this.#device.queue.writeBuffer(this.#params, 0, params);
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
		const parts = [context.version, context.background, this.#normals, this.#flow, this.#caustics, foam];
		return this.#groups.get(waterDepth, parts, () => this.#createGroup(context, waterDepth, configs, foam));
	}

	/** @returns group 2 over the current textures */
	#createGroup(
		context: WaterContext,
		waterDepth: GPUTextureView,
		configs: GPUBuffer,
		foam: GPUTextureView,
	): GPUBindGroup {
		return this.#device.createBindGroup({
			label: 'water',
			layout: this.#layout,
			entries: [
				{ binding: 0, resource: { buffer: this.#surfaces } },
				{ binding: 1, resource: { buffer: configs } },
				{ binding: 2, resource: context.background },
				{ binding: 3, resource: context.scene.depth },
				{ binding: 4, resource: this.#normals?.view ?? this.#noNormals },
				{ binding: 5, resource: this.#flow?.view ?? this.#noFlow },
				{ binding: 6, resource: this.#repeat },
				{ binding: 7, resource: { buffer: this.#params } },
				// the flow map's placeholder stands in; the shader skips caustics without the map
				{ binding: 8, resource: this.#caustics?.view ?? this.#noFlow },
				{ binding: 10, resource: foam },
				{ binding: 14, resource: waterDepth },
			],
		});
	}

	/** @returns whether there's anything to draw this frame, with both pipelines compiled */
	get active(): boolean {
		return (
			this.#draws.length > 0 &&
			this.#configs !== null &&
			this.#pipelines.get(SHADE_KEY) !== undefined &&
			this.#pipelines.get(DEPTH_KEY) !== undefined
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
	encodeDepth(encoder: GPUCommandEncoder, context: WaterContext): void {
		const pass = WaterRenderer.#beginDepthPass(encoder, context.scene.waterDepth);
		const pipeline = this.#pipelines.get(DEPTH_KEY);
		const group = this.active ? this.#bindGroup(context, this.#noWaterDepthView) : null;
		if (pipeline !== undefined && group !== null) {
			this.#drawSurfaces(pass, pipeline, group, context);
		}
		pass.end();
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
	encode(encoder: GPUCommandEncoder, target: GPUTextureView, context: WaterContext): void {
		const pipeline = this.#pipelines.get(SHADE_KEY);
		if (pipeline === undefined || !this.active) {
			return;
		}
		const foamed = context.foam;
		if (this.#paramData[6] !== (foamed ? 1 : 0)) {
			this.#paramData[6] = foamed ? 1 : 0;
			this.#device.queue.writeBuffer(this.#params, 0, this.#paramData);
		}
		const group = this.#bindGroup(context, context.scene.waterDepth);
		if (group === null) {
			return;
		}
		const pass = encoder.beginRenderPass({
			label: 'water',
			colorAttachments: [{ view: target, loadOp: 'load', storeOp: 'store' }],
		});
		this.#drawSurfaces(pass, pipeline, group, context);
		pass.end();
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
		pipeline: GPURenderPipeline,
		group: GPUBindGroup,
		context: WaterContext,
	): void {
		pass.setPipeline(pipeline);
		pass.setBindGroup(0, context.frame.group, [context.frame.offset]);
		pass.setBindGroup(1, context.sky);
		pass.setBindGroup(2, group);
		pass.setBindGroup(3, context.postUniforms);
		for (const { geometry, slot } of this.#draws) {
			pass.setVertexBuffer(0, geometry.vertices, 0, geometry.positionBytes);
			pass.setVertexBuffer(1, geometry.vertices, geometry.normalOffset ?? 0);
			pass.setIndexBuffer(geometry.indices, geometry.indexFormat);
			for (const submesh of geometry.submeshes) {
				pass.drawIndexed(submesh.indexCount, 1, submesh.firstIndex, submesh.baseVertex, slot);
			}
		}
	}

	/** frees the buffers */
	destroy(): void {
		this.#surfaces.destroy();
		this.#configs?.destroy();
		this.#params.destroy();
		this.#foam.destroy();
		this.#noWaterDepth.destroy();
	}
}
