/**
 * the open-world water: the shown level's surfaces (plus shared ones) drawn after compositing, over a copy of
 * the scene, with their configs and the scene's global wave normals, flow map and caustics. it lights them
 * with the main pass's frame group (sun shadow, irradiance volume, sky reflection). surfaces are resident in
 * the game, so every surface of the level is wanted; those outside the view aren't drawn.
 *
 * @module
 */

import type { GeometryEntry } from '@endfield-noclip/package-format/geometry';
import type { WaterConfig, WaterTable } from '@endfield-noclip/package-format/water';

import { HDR_FORMAT, type SceneTextures } from '../gfx/render-targets.ts';
import { type Plane, type Vec3, boxInFrustum } from '../scene/camera.ts';
import { streamWholeTexture } from '../streaming/mesh-selection.ts';
import type { ResidentGeometry, StreamManager } from '../streaming/stream-manager.ts';

import { FRAME_WGSL } from './frame-uniforms.ts';
import atmosphereWgsl from './shaders/atmosphere.wgsl?raw';
import commonWgsl from './shaders/post-common.wgsl?raw';
import skyWgsl from './shaders/sky.wgsl?raw';
import ssrTraceWgsl from './shaders/ssr-trace.wgsl?raw';
import waterWgsl from './shaders/water.wgsl?raw';
import { type TextureBinding, type TextureStore, placeholderView } from './texture-store.ts';

/** floats of `Surface` in water.wgsl */
const SURFACE_FLOATS = 20;
/** floats of `Config` in water.wgsl */
const CONFIG_FLOATS = 56;
/** floats of the `water` uniform in water.wgsl */
const PARAM_FLOATS = 12;
const MAX_SURFACES = 4096;
/** priority of the surfaces' geometry at 1 m, and of their textures */
const PRIORITY = 1e5;

/** the layouts of the groups the water pass shares with other passes */
export interface WaterLayouts {
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
}

/**
 * @returns the water shader: the frame's lighting at group 0, then the post passes' helpers with their
 *   uniforms moved to group 3
 */
const waterShaderSource = (): string => {
	const binding = '@group(0) @binding(0) var<uniform> post';
	if (!commonWgsl.includes(binding)) {
		throw new Error(`post-common.wgsl no longer declares \`${binding}\``);
	}
	const common = commonWgsl.replace(binding, '@group(3) @binding(0) var<uniform> post');
	return [FRAME_WGSL, common, atmosphereWgsl, skyWgsl, ssrTraceWgsl, waterWgsl].join('\n');
};

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
		[
			c.largeWaveFlowSpeed * (c.largeWaveInvDir > 0.5 ? -1 : 1),
			c.largeWaveNormalTilling,
			c.largeWaveNormalScale,
			c.flowFullCycleLarge,
		],
		[...c.flowDirectionVector2, c.useFlowMap, c.FlowmapOption],
		[c.smallWaveNormalType, c.largeWaveNormalType, c.dirSpecNormalScaler, c.sceneColorEnvInfluence],
		// the game's normal-map mip offset is labelled `envSpecularDesaturation`
		[c.distanceFade, c.distanceNormalMinStrength, (0.5 - c.envSpecularDesaturation) * 10, c.foamRoughness],
		// colours go in as authored, as the game copies them
		[c.foamColorG[0], c.foamColorG[1], c.foamColorG[2], c.foamOpacity],
		[
			c.foamShapeOffset,
			1 / Math.max(c.foamFadeDistance, 1e-4),
			c.waterBaseColorSubsurfaceScaler,
			c.emissiveStrength,
		],
		[c.causticTilling, c.causticOpacity, c.causticDistort, c.causticSpeed],
		[c.causticStartDepth, c.causticEndDepth, 0, 0],
	];
	rows.forEach((row, i) => out.set(row, at + i * 4));
};

/** owns the water pipeline, its buffers and the per-frame surface list */
export class WaterRenderer {
	#device: GPUDevice;
	#layout: GPUBindGroupLayout;
	#pipeline: GPURenderPipeline;
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
	/** group 2 */
	#group: GPUBindGroup | null = null;
	/** what {@link #group} was built from */
	#groupKey: unknown[] = [];

	/**
	 * @param device the device
	 * @param layouts the shared groups' layouts
	 */
	constructor(device: GPUDevice, layouts: WaterLayouts) {
		this.#device = device;
		const module = device.createShaderModule({ label: 'water', code: waterShaderSource() });
		const fragment = GPUShaderStage.FRAGMENT;
		const texture = (
			binding: number,
			sampleType: GPUTextureSampleType,
			viewDimension: GPUTextureViewDimension = '2d',
		): GPUBindGroupLayoutEntry => ({ binding, visibility: fragment, texture: { sampleType, viewDimension } });
		// the bindings of water.wgsl's group 2
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
			],
		});
		this.#pipeline = device.createRenderPipeline({
			label: 'water',
			layout: device.createPipelineLayout({
				label: 'water',
				bindGroupLayouts: [layouts.frame, layouts.sky, this.#layout, layouts.uniforms],
			}),
			vertex: {
				module,
				entryPoint: 'vs_water',
				buffers: [
					{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'unorm16x4' }] },
					// octahedral normals; meshes without them bind their positions here, which the shader ignores
					{ arrayStride: 4, attributes: [{ shaderLocation: 1, offset: 0, format: 'snorm16x2' }] },
				],
			},
			fragment: { module, entryPoint: 'fs_water', targets: [{ format: HDR_FORMAT }] },
			// seen from below too
			primitive: { topology: 'triangle-list', cullMode: 'none' },
		});
		this.#surfaces = device.createBuffer({
			label: 'water surfaces',
			size: this.#surfaceData.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		this.#params = device.createBuffer({
			label: 'water params',
			size: this.#paramData.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		this.#repeat = device.createSampler({
			label: 'water repeat',
			addressModeU: 'repeat',
			addressModeV: 'repeat',
			magFilter: 'linear',
			minFilter: 'linear',
			mipmapFilter: 'linear',
			maxAnisotropy: 4,
		});
		this.#noFlow = placeholderView(device, { label: 'no water flow map', dimension: '2d' });
		this.#noNormals = placeholderView(device, { label: 'no water normals', dimension: '2d-array' });
	}

	/** @param table the package's water, or `null` */
	setTable(table: WaterTable | null): void {
		this.#table = table;
		this.#configs?.destroy();
		this.#configs = null;
		this.#group = null;
		this.clear();
		if (table === null || table.configs.length === 0) {
			return;
		}
		const data = new Float32Array(table.configs.length * CONFIG_FLOATS);
		table.configs.forEach((config, i) => packConfig(config.values, data, i * CONFIG_FLOATS));
		this.#configs = this.#device.createBuffer({
			label: 'water configs',
			size: data.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		this.#device.queue.writeBuffer(this.#configs, 0, data);
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
		geometries: readonly GeometryEntry[];
		textures: TextureStore;
		/** the sun as the water column takes it: `Environment.sunRaw` */
		sun: Vec3;
	}): void {
		const { eye, planes, stream, geometries, textures, sun } = input;
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
			const entry = geometries[surface.geometry];
			if (entry?.status !== 'ready') {
				continue;
			}
			const { min, max } = surface.bounds;
			const dx = Math.max(min[0] - eye[0], 0, eye[0] - max[0]);
			const dz = Math.max(min[2] - eye[2], 0, eye[2] - max[2]);
			const item = stream.want(entry.blob, PRIORITY / (1 + Math.hypot(dx, dz)));
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
				data[at + r * 4 + 3] = t[r * 4 + 3] - eye[r];
			}
			data.set(resident.positionOffset, at + 12);
			words[at + 15] = surface.config;
			data.set(resident.positionScale, at + 16);
			// the game draws LOD surfaces as a grid shaded with its own upward normals, so their mesh normals (wrong
			// on some polygon meshes) never show; proxy-only surfaces take theirs
			const lod = (surface.renderTypeMask & 2) !== 0;
			data[at + 19] = resident.normalOffset === null || lod ? 0 : 1;
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

	#bindGroup(context: WaterContext): GPUBindGroup | null {
		if (this.#configs === null) {
			return null;
		}
		const key = [context.version, context.background, this.#normals, this.#flow, this.#caustics];
		if (this.#group !== null && key.every((part, i) => part === this.#groupKey[i])) {
			return this.#group;
		}
		this.#group = this.#device.createBindGroup({
			label: 'water',
			layout: this.#layout,
			entries: [
				{ binding: 0, resource: { buffer: this.#surfaces } },
				{ binding: 1, resource: { buffer: this.#configs } },
				{ binding: 2, resource: context.background },
				{ binding: 3, resource: context.scene.depth },
				{ binding: 4, resource: this.#normals?.view ?? this.#noNormals },
				{ binding: 5, resource: this.#flow?.view ?? this.#noFlow },
				{ binding: 6, resource: this.#repeat },
				{ binding: 7, resource: { buffer: this.#params } },
				// the flow map's placeholder stands in; the shader skips caustics without the map
				{ binding: 8, resource: this.#caustics?.view ?? this.#noFlow },
			],
		});
		this.#groupKey = key;
		return this.#group;
	}

	/** @returns whether there's anything to draw this frame */
	get active(): boolean {
		return this.#draws.length > 0 && this.#configs !== null;
	}

	/**
	 * draws this frame's surfaces into the scene.
	 *
	 * @param encoder this frame's encoder
	 * @param target the composited HDR scene, drawn over
	 * @param context what the pass reads
	 */
	encode(encoder: GPUCommandEncoder, target: GPUTextureView, context: WaterContext): void {
		const group = this.#bindGroup(context);
		if (group === null || this.#draws.length === 0) {
			return;
		}
		const pass = encoder.beginRenderPass({
			label: 'water',
			colorAttachments: [{ view: target, loadOp: 'load', storeOp: 'store' }],
		});
		pass.setPipeline(this.#pipeline);
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
		pass.end();
	}

	/** frees the buffers */
	destroy(): void {
		this.#surfaces.destroy();
		this.#configs?.destroy();
		this.#params.destroy();
	}
}
