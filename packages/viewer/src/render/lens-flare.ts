/**
 * the sun's lens flare pass: draws the quads `lens-flare-layout.ts` lays out onto the composited scene after
 * the light shafts and before temporal antialiasing. `lens-flare.wgsl` fades them by how much of a disc
 * around the sun shows sky in the depth buffer.
 *
 * @module
 */

import type { Vec2 } from '@endfield-noclip/package-format/values';

import { HDR_FORMAT, type SceneTextures } from '../gfx/render-targets.ts';
import type { Camera } from '../scene/camera.ts';
import type { StreamedTexture } from '../streaming/mesh-selection.ts';

import { type LensFlareLook, flareQuads, lensFlareTextures } from './lens-flare-layout.ts';
import { sunOnScreen } from './light-shafts.ts';
import lensFlareWgsl from './shaders/lens-flare.wgsl?raw';
import { placeholderView } from './texture-store.ts';

/** byte size of `FlareFrame` in lens-flare.wgsl */
const FRAME_BYTES = 16;
/** bytes per quad in the storage buffer */
const QUAD_BYTES = 4 * 16;
/** the most quads a frame draws */
const MAX_QUADS = 256;
/** `GetCelestialProjectedOcclusionRadius`: the occlusion radius is a multiple of this angle's tangent */
const CELESTIAL_OCCLUSION = Math.tan(0.0576);

/** per element blend mode: additive, screen, premultiplied, lerp */
const BLENDS: GPUBlendComponent[] = [
	{ srcFactor: 'one', dstFactor: 'one', operation: 'add' },
	{ srcFactor: 'one', dstFactor: 'one-minus-src', operation: 'add' },
	{ srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
	{ srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
];

/** owns the flare's pipelines, quad buffer and texture bindings */
export class LensFlares {
	#device: GPUDevice;
	#module: GPUShaderModule;
	#frame: GPUBuffer;
	#quads: GPUBuffer;
	#data = new Float32Array(MAX_QUADS * (QUAD_BYTES / 4));
	#sampler: GPUSampler;
	#frameLayout: GPUBindGroupLayout;
	#textureLayout: GPUBindGroupLayout;
	#layout: GPUPipelineLayout;
	/** group 1 for circles, which sample nothing */
	#blankGroup: GPUBindGroup;
	/** per shape and blend mode */
	#pipelines = new Map<string, GPURenderPipeline>();
	#look: LensFlareLook | null = null;
	#textures = new Map<number, StreamedTexture>();
	/** per bound view, its group 1; kept for the views in use */
	#textureGroups = new Map<GPUTextureView, GPUBindGroup>();
	/** the frame group and the scene the flare draws onto, once sized */
	#sized: { frame: GPUBindGroup; target: GPUTextureView } | null = null;

	/** @param device the device */
	constructor(device: GPUDevice) {
		this.#device = device;
		this.#module = device.createShaderModule({ label: 'lens flare', code: lensFlareWgsl });
		const visibility = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
		this.#frameLayout = device.createBindGroupLayout({
			label: 'lens flare frame',
			entries: [
				{ binding: 0, visibility, buffer: { type: 'uniform' } },
				{ binding: 1, visibility, buffer: { type: 'read-only-storage' } },
				{ binding: 2, visibility: GPUShaderStage.VERTEX, texture: { sampleType: 'depth' } },
			],
		});
		this.#textureLayout = device.createBindGroupLayout({
			label: 'lens flare texture',
			entries: [
				{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
				{ binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
			],
		});
		this.#layout = device.createPipelineLayout({
			label: 'lens flare',
			bindGroupLayouts: [this.#frameLayout, this.#textureLayout],
		});
		this.#frame = device.createBuffer({
			label: 'lens flare frame',
			size: FRAME_BYTES,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		this.#quads = device.createBuffer({
			label: 'lens flare quads',
			size: this.#data.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		this.#sampler = device.createSampler({
			label: 'lens flare',
			magFilter: 'linear',
			minFilter: 'linear',
			mipmapFilter: 'linear',
			addressModeU: 'clamp-to-edge',
			addressModeV: 'clamp-to-edge',
		});
		this.#blankGroup = this.#textureGroup(
			placeholderView(device, { label: 'no flare texture', dimension: '2d' }),
		);
	}

	#pipeline(shape: 'image' | 'circle', blendMode: number): GPURenderPipeline {
		const key = `${shape}/${blendMode}`;
		let pipeline = this.#pipelines.get(key);
		if (pipeline === undefined) {
			const blend = BLENDS[blendMode] ?? BLENDS[0];
			pipeline = this.#device.createRenderPipeline({
				label: `lens flare ${key}`,
				layout: this.#layout,
				vertex: { module: this.#module, entryPoint: 'vs_flare' },
				fragment: {
					module: this.#module,
					entryPoint: shape === 'image' ? 'fs_image' : 'fs_circle',
					targets: [
						{
							format: HDR_FORMAT,
							blend: { color: blend, alpha: blend },
							writeMask: GPUColorWrite.RED | GPUColorWrite.GREEN | GPUColorWrite.BLUE,
						},
					],
				},
				primitive: { topology: 'triangle-strip' },
			});
			this.#pipelines.set(key, pipeline);
		}
		return pipeline;
	}

	#textureGroup(view: GPUTextureView): GPUBindGroup {
		return this.#device.createBindGroup({
			label: 'lens flare texture',
			layout: this.#textureLayout,
			entries: [
				{ binding: 0, resource: view },
				{ binding: 1, resource: this.#sampler },
			],
		});
	}

	/** @param look the flare, or `null` for none */
	setLook(look: LensFlareLook | null): void {
		this.#look = look;
	}

	/**
	 * binds the image textures as they stream in; an element whose texture isn't resident yet doesn't draw
	 *
	 * @param lookup gives each texture-table id's streamed texture, or `null`
	 */
	setTextures(lookup: (texture: number) => StreamedTexture | null): void {
		this.#textures.clear();
		const groups = new Map<GPUTextureView, GPUBindGroup>();
		for (const id of lensFlareTextures(this.#look)) {
			const streamed = lookup(id);
			if (streamed === null) {
				continue;
			}
			this.#textures.set(id, streamed);
			const view = streamed.binding?.view;
			if (view !== undefined) {
				groups.set(view, this.#textureGroups.get(view) ?? this.#textureGroup(view));
			}
		}
		this.#textureGroups = groups;
	}

	/**
	 * points the pass at new render targets
	 *
	 * @param input the main pass's textures and the composited scene the flare draws onto
	 */
	resize(input: { scene: SceneTextures; composited: GPUTextureView }): void {
		this.#sized = {
			target: input.composited,
			frame: this.#device.createBindGroup({
				label: 'lens flare frame',
				layout: this.#frameLayout,
				entries: [
					{ binding: 0, resource: { buffer: this.#frame } },
					{ binding: 1, resource: { buffer: this.#quads } },
					{ binding: 2, resource: input.scene.depth },
				],
			}),
		};
	}

	/**
	 * draws this frame's flare onto the composited scene, when the look has one and the sun is in front of the
	 * camera
	 *
	 * @param encoder this frame's encoder, after the light shafts and before temporal antialiasing
	 * @param input the camera (unjittered) and the render size
	 */
	encode(encoder: GPUCommandEncoder, input: { camera: Camera; width: number; height: number }): void {
		const look = this.#look;
		const sized = this.#sized;
		if (look === null || sized === null) {
			return;
		}
		const { camera, width, height } = input;
		const aspect = width / height;
		const sun = sunOnScreen(camera, aspect, look.direction);
		if (sun === null) {
			return;
		}
		const screen: Vec2 = [sun[0] * 2 - 1, sun[1] * 2 - 1];
		if (!look.allowOffScreen && (Math.abs(screen[0]) > 1 || Math.abs(screen[1]) > 1)) {
			return;
		}
		const groupOf = (texture: number | null): GPUBindGroup | undefined => {
			if (texture === null) {
				return this.#blankGroup;
			}
			const view = this.#textures.get(texture)?.binding?.view;
			return view === undefined ? undefined : this.#textureGroups.get(view);
		};
		// quads whose image hasn't streamed in yet don't draw
		const quads = flareQuads(look, screen, aspect, (id) => {
			const entry = this.#textures.get(id)?.entry;
			return entry === undefined ? 1 : entry.height / entry.width;
		})
			.flatMap((quad) => {
				const group = groupOf(quad.texture);
				return group === undefined ? [] : [{ ...quad, group }];
			})
			.slice(0, MAX_QUADS);
		if (quads.length === 0) {
			return;
		}

		// the occlusion disc's radius, in the viewport units SRP core measures it in
		let radius = 0;
		let samples = 0;
		if (look.occlusion !== null) {
			const up = camera.up();
			const k = CELESTIAL_OCCLUSION * look.occlusion.radius;
			const edge = sunOnScreen(camera, aspect, [
				look.direction[0] + up[0] * k,
				look.direction[1] + up[1] * k,
				look.direction[2] + up[2] * k,
			]);
			radius = edge === null ? 0 : Math.hypot(edge[0] - sun[0], edge[1] - sun[1]);
			samples = look.occlusion.samples;
		}
		this.#device.queue.writeBuffer(
			this.#frame,
			0,
			new Float32Array([radius, samples, look.occlusion === null ? 0 : 1, height / width]),
		);
		const f = this.#data;
		for (const [i, quad] of quads.entries()) {
			const o = i * (QUAD_BYTES / 4);
			f.set(quad.data0, o);
			f.set(quad.data2, o + 4);
			f.set(quad.color, o + 8);
			f.set(quad.data3, o + 12);
		}
		this.#device.queue.writeBuffer(this.#quads, 0, f, 0, quads.length * (QUAD_BYTES / 4));

		const render = encoder.beginRenderPass({
			label: 'lens flare',
			colorAttachments: [{ view: sized.target, loadOp: 'load', storeOp: 'store' }],
		});
		render.setBindGroup(0, sized.frame);
		for (const [i, quad] of quads.entries()) {
			render.setPipeline(this.#pipeline(quad.texture === null ? 'circle' : 'image', quad.blendMode));
			render.setBindGroup(1, quad.group);
			render.draw(4, 1, 0, i);
		}
		render.end();
	}

	/** frees the buffers */
	destroy(): void {
		this.#frame.destroy();
		this.#quads.destroy();
	}
}
