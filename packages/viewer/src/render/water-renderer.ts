/**
 * the open-world water: the shown level's surfaces (plus shared ones) drawn after compositing, over a copy of
 * the scene, with their configs and the scene's global wave normals and flow map. surfaces are resident in
 * the game, so every surface of the level is wanted; those outside the view aren't drawn.
 *
 * @module
 */

import type { GeometryEntry, WaterConfig, WaterTable } from '@endfield-noclip/package-format/format';

import { HDR_FORMAT, type SceneTextures } from '../gfx/render-targets.ts';
import { type Plane, type Vec3, boxInFrustum } from '../scene/camera.ts';
import { streamWholeTexture } from '../streaming/mesh-selection.ts';
import type { ResidentGeometry, StreamManager } from '../streaming/stream-manager.ts';

import { postShaderSource } from './post-process.ts';
import atmosphereWgsl from './shaders/atmosphere.wgsl?raw';
import skyWgsl from './shaders/sky.wgsl?raw';
import waterWgsl from './shaders/water.wgsl?raw';
import { type TextureBinding, type TextureStore, placeholderView } from './texture-store.ts';

/** floats of `Surface` in water.wgsl */
const SURFACE_FLOATS = 20;
/** floats of `Config` in water.wgsl */
const CONFIG_FLOATS = 36;
const MAX_SURFACES = 4096;
/** priority of the surfaces' geometry at 1 m, and of their textures */
const PRIORITY = 1e5;

/** what the water pass reads from the post chain */
export interface WaterContext {
	scene: SceneTextures;
	/** a copy of the composited scene, which the pass refracts */
	background: GPUTextureView;
	/**
	 * @param pipeline the water pipeline
	 * @returns the post chain's groups 0 (uniforms) and 1 (atmosphere) for it
	 */
	postGroups(pipeline: GPURenderPipeline): GPUBindGroup[];
	cloud: TextureBinding;
	/** bumped whenever anything above changes */
	version: number;
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
		// water's reflectance at normal incidence; `specular` scales it like a material's
		[c.roughness, 0.02 * (c.specular / 0.5), c.waterIOR, 0],
		[c.flowSpeed, c.normalTilling, c.normalScale, c.flowFullCycle],
		[
			c.largeWaveFlowSpeed * (c.largeWaveInvDir > 0.5 ? -1 : 1),
			c.largeWaveNormalTilling,
			c.largeWaveNormalScale,
			c.flowFullCycleLarge,
		],
		[...c.flowDirectionVector2, c.useFlowMap, 0],
		[c.smallWaveNormalType, c.largeWaveNormalType, 0, 0],
	];
	rows.forEach((row, i) => out.set(row, at + i * 4));
};

/** owns the water pipeline, its buffers and the per-frame surface list */
export class WaterRenderer {
	#device: GPUDevice;
	#pipeline: GPURenderPipeline;
	#surfaces: GPUBuffer;
	#surfaceData = new Float32Array(MAX_SURFACES * SURFACE_FLOATS);
	#surfaceWords = new Uint32Array(this.#surfaceData.buffer);
	#configs: GPUBuffer | null = null;
	#params: GPUBuffer;
	#paramData = new Float32Array(8);
	#repeat: GPUSampler;
	#noNormals: GPUTextureView;
	#noFlow: GPUTextureView;
	#table: WaterTable | null = null;
	#draws: Draw[] = [];
	#normals: TextureBinding | null = null;
	#flow: TextureBinding | null = null;
	#groups: GPUBindGroup[] | null = null;
	/** what {@link #groups} were built from */
	#groupKey: unknown[] = [];

	/** @param device the device */
	constructor(device: GPUDevice) {
		this.#device = device;
		const module = device.createShaderModule({
			label: 'water',
			code: postShaderSource([atmosphereWgsl, skyWgsl, waterWgsl]),
		});
		this.#pipeline = device.createRenderPipeline({
			label: 'water',
			layout: 'auto',
			vertex: {
				module,
				entryPoint: 'vs_water',
				buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'unorm16x4' }] }],
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
		this.#groups = null;
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

	#conditions: readonly boolean[] = [];

	/**
	 * @param results per conditional set of the package, whether the selected scene values satisfy it; surfaces
	 *   whose condition is unsatisfied aren't drawn
	 */
	setConditions(results: readonly boolean[]): void {
		this.#conditions = results;
	}

	/** draws nothing until the next {@link prepare} */
	clear(): void {
		this.#draws.length = 0;
	}

	/**
	 * picks this frame's surfaces and streams what they need.
	 *
	 * @param input the shown level's tag (`null` shows every surface), the camera, the stream and tables
	 */
	prepare(input: {
		level: number | null;
		eye: Vec3;
		planes: readonly Plane[];
		stream: StreamManager;
		geometries: readonly GeometryEntry[];
		textures: TextureStore;
	}): void {
		const { level, eye, planes, stream, geometries, textures } = input;
		const table = this.#table;
		this.clear();
		if (table === null) {
			return;
		}
		const data = this.#surfaceData;
		const words = this.#surfaceWords;
		let slot = 0;
		for (const surface of table.surfaces) {
			// level 0 surfaces belong to no level and show with every one
			if (level !== null && surface.levelTag !== level && surface.levelTag !== 0) {
				continue;
			}
			if (surface.condition !== null && !this.#conditions[surface.condition]) {
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
			data[at + 19] = 0;
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
		const params = this.#paramData;
		params[0] = this.#normals === null ? 0 : 1;
		params[1] = this.#flow === null ? 0 : 1;
		params[2] = global?.mapSize ?? 1;
		params[4] = global?.center[0] ?? 0;
		params[5] = global?.center[1] ?? 0;
		this.#device.queue.writeBuffer(this.#params, 0, params);
	}

	#bindGroups(context: WaterContext): GPUBindGroup[] | null {
		if (this.#configs === null) {
			return null;
		}
		const key = [context.version, context.cloud, this.#normals, this.#flow];
		if (this.#groups !== null && key.every((part, i) => part === this.#groupKey[i])) {
			return this.#groups;
		}
		this.#groups = [
			...context.postGroups(this.#pipeline),
			this.#device.createBindGroup({
				layout: this.#pipeline.getBindGroupLayout(2),
				entries: [
					{ binding: 0, resource: { buffer: this.#surfaces } },
					{ binding: 1, resource: { buffer: this.#configs } },
					{ binding: 2, resource: context.background },
					{ binding: 3, resource: context.scene.depth },
					{ binding: 4, resource: context.cloud.view },
					{ binding: 5, resource: context.cloud.sampler },
					{ binding: 6, resource: this.#normals?.view ?? this.#noNormals },
					{ binding: 7, resource: this.#flow?.view ?? this.#noFlow },
					{ binding: 8, resource: this.#repeat },
					{ binding: 9, resource: { buffer: this.#params } },
				],
			}),
		];
		this.#groupKey = key;
		return this.#groups;
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
		const groups = this.#bindGroups(context);
		if (groups === null || this.#draws.length === 0) {
			return;
		}
		const pass = encoder.beginRenderPass({
			label: 'water',
			colorAttachments: [{ view: target, loadOp: 'load', storeOp: 'store' }],
		});
		pass.setPipeline(this.#pipeline);
		groups.forEach((group, i) => pass.setBindGroup(i, group));
		for (const { geometry, slot } of this.#draws) {
			pass.setVertexBuffer(0, geometry.vertices, 0, geometry.positionBytes);
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
