import type { Vec2 } from '@endfield-noclip/package-format/values';

import { type TgpuBindGroup, type TgpuRenderPipeline, type TgpuRoot, type TgpuUniform, d } from 'typegpu';

import { type LensFlareLook, lensFlareTextures } from '../../environment/lens-flare-look.ts';
import { ADD, ALPHA_OVER, PREMULTIPLIED_OVER } from '../../gfx/blend.ts';
import type { AsyncPipeline, PipelineCache } from '../../gfx/pipeline-cache.ts';
import { LINEAR_CLAMP_MIPMAPPED, sampler } from '../../gfx/samplers.ts';
import type { Camera } from '../../scene/camera.ts';
import type { StreamedTexture } from '../../streaming/texture-requests.ts';
import { HDR_FORMAT, type SceneTextures } from '../core/render-targets.ts';

import { flareQuads } from './lens-flare-layout.ts';
import {
	FlareFrameSchema,
	FlareQuadSchema,
	flareFrameLayout,
	flareTextureLayout,
	fsFlareCircle,
	fsFlareImage,
	vsFlare,
} from './lens-flare-shader.ts';

/** floats per quad in the storage buffer, derived from {@link FlareQuadSchema} */
const QUAD_FLOATS = d.sizeOf(FlareQuadSchema) / 4;
/** the most quads a frame draws */
const MAX_QUADS = 256;
/** SRP core's celestial occlusion radius: a multiple of this angle's tangent at the sun's distance */
const CELESTIAL_OCCLUSION = Math.tan(0.0576);

/** per element blend mode: additive, screen, premultiplied, lerp */
const BLENDS: GPUBlendComponent[] = [
	ADD,
	{ srcFactor: 'one', dstFactor: 'one-minus-src', operation: 'add' },
	PREMULTIPLIED_OVER,
	ALPHA_OVER,
];

/** owns the flare's pipelines, quad buffer and texture bindings */
export class LensFlares {
	#root: TgpuRoot;
	#frame: TgpuUniform<typeof FlareFrameSchema>;
	#quads: GPUBuffer;
	#data = new Float32Array(MAX_QUADS * QUAD_FLOATS);
	#sampler: GPUSampler;
	/** compiled pipelines per shape, per blend mode */
	#pipelines: Record<'image' | 'circle', AsyncPipeline<TgpuRenderPipeline>[]>;
	#look: LensFlareLook | null = null;
	/** the texture-table ids the look's images sample */
	#textureIds: number[] = [];
	/** each id's streamed texture, once requested */
	#textures = new Map<number, StreamedTexture>();
	/** per bound view, its texture bind group; kept for the views in use */
	#textureGroups = new Map<GPUTextureView, TgpuBindGroup>();
	/** this frame's draws: each quad's pipeline and optional texture group (`null` for circles) */
	#drawPipelines: TgpuRenderPipeline[] = [];
	#drawGroups: (TgpuBindGroup | null)[] = [];
	/** the frame group and the scene the flare draws onto, once sized */
	#sized: { frame: TgpuBindGroup; target: GPUTextureView } | null = null;

	/**
	 * @param root the TypeGPU root
	 * @param pipelines the pipeline cache
	 */
	constructor(root: TgpuRoot, pipelines: PipelineCache) {
		this.#root = root;
		const prepareShape = (shape: 'image' | 'circle'): AsyncPipeline<TgpuRenderPipeline>[] =>
			BLENDS.map((blend, blendMode) =>
				pipelines.prepareTgpuRender(`lens flare ${shape}/${blendMode}`, () =>
					root.createRenderPipeline({
						vertex: vsFlare,
						fragment: shape === 'image' ? fsFlareImage : fsFlareCircle,
						targets: {
							format: HDR_FORMAT,
							blend: { color: blend, alpha: blend },
							writeMask: GPUColorWrite.RED | GPUColorWrite.GREEN | GPUColorWrite.BLUE,
						},
						primitive: { topology: 'triangle-strip' },
					}),
				),
			);
		this.#pipelines = { image: prepareShape('image'), circle: prepareShape('circle') };
		this.#frame = root.createUniform(FlareFrameSchema);
		this.#quads = root.device.createBuffer({
			label: 'lens flare quads',
			size: this.#data.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		this.#sampler = sampler(root.device, LINEAR_CLAMP_MIPMAPPED);
	}

	#textureGroup(view: GPUTextureView): TgpuBindGroup {
		return this.#root.createBindGroup(flareTextureLayout, {
			texture: view,
			sampler: this.#sampler,
		});
	}

	/** @param look the flare, or `null` for none */
	setLook(look: LensFlareLook | null): void {
		this.#look = look;
		this.#textureIds = lensFlareTextures(look);
		this.#textures.clear();
	}

	/**
	 * binds the image textures as they stream in; an element whose texture isn't resident yet doesn't draw
	 *
	 * @param lookup gives each texture-table id's streamed texture, or `null`
	 */
	setTextures(lookup: (texture: number) => StreamedTexture | null): void {
		const groups = this.#textureGroups;
		let views = 0;
		for (const id of this.#textureIds) {
			const streamed = lookup(id);
			if (streamed === null) {
				this.#textures.delete(id);
				continue;
			}
			this.#textures.set(id, streamed);
			const view = streamed.binding?.view;
			if (view !== undefined) {
				views++;
				if (!groups.has(view)) {
					groups.set(view, this.#textureGroup(view));
				}
			}
		}
		// forget the groups of views no longer bound, once there are more groups than views in use
		if (groups.size > views) {
			const bound = new Set<GPUTextureView | undefined>();
			for (const streamed of this.#textures.values()) {
				bound.add(streamed.binding?.view);
			}
			for (const view of groups.keys()) {
				if (!bound.has(view)) {
					groups.delete(view);
				}
			}
		}
	}

	/**
	 * points the pass at new render targets
	 *
	 * @param input the main pass's textures and the composited scene the flare draws onto
	 */
	resize(input: { scene: SceneTextures; composited: GPUTextureView }): void {
		this.#sized = {
			target: input.composited,
			frame: this.#root.createBindGroup(flareFrameLayout, {
				frame: this.#frame,
				quads: this.#quads,
				depth: input.scene.depth,
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
		const sized = this.#sized;
		if (sized === null) {
			throw new Error('lens flare used before resize()');
		}
		const look = this.#look;
		if (look === null) {
			return;
		}
		const { camera, width, height } = input;
		const aspect = width / height;
		const sun = camera.projectDirection(look.direction, aspect);
		if (sun === null) {
			return;
		}
		const screen: Vec2 = [sun[0] * 2 - 1, sun[1] * 2 - 1];
		if (!look.allowOffScreen && (Math.abs(screen[0]) > 1 || Math.abs(screen[1]) > 1)) {
			return;
		}
		const quads = flareQuads(look, screen, aspect, (id) => {
			const entry = this.#textures.get(id)?.entry;
			return entry === undefined ? 1 : entry.height / entry.width;
		});
		// quads whose image hasn't streamed in yet don't draw
		const f = this.#data;
		let count = 0;
		for (const quad of quads) {
			if (count === MAX_QUADS) {
				break;
			}
			let group: TgpuBindGroup | null = null;
			if (quad.texture !== null) {
				const view = this.#textures.get(quad.texture)?.binding?.view;
				const found = view === undefined ? undefined : this.#textureGroups.get(view);
				if (found === undefined) {
					continue;
				}
				group = found;
			}
			const list = this.#pipelines[quad.texture === null ? 'circle' : 'image'];
			const pipeline = (list[quad.blendMode] ?? list[0]).get();
			if (pipeline === undefined) {
				continue;
			}
			const o = count * QUAD_FLOATS;
			f.set(quad.data0, o);
			f.set(quad.data2, o + 4);
			f.set(quad.color, o + 8);
			f.set(quad.data3, o + 12);
			this.#drawPipelines[count] = pipeline;
			this.#drawGroups[count] = group;
			count++;
		}
		if (count === 0) {
			return;
		}

		// the occlusion disc's radius, in the viewport units SRP core measures it in
		let radius = 0;
		let samples = 0;
		if (look.occlusion !== null) {
			const up = camera.up();
			const k = CELESTIAL_OCCLUSION * look.occlusion.radius;
			const edge = camera.projectDirection(
				[look.direction[0] + up[0] * k, look.direction[1] + up[1] * k, look.direction[2] + up[2] * k],
				aspect,
			);
			radius = edge === null ? 0 : Math.hypot(edge[0] - sun[0], edge[1] - sun[1]);
			samples = look.occlusion.samples;
		}
		this.#frame.write({
			occlusion: [radius, samples, look.occlusion === null ? 0 : 1, height / width],
		});
		this.#root.device.queue.writeBuffer(this.#quads, 0, f, 0, count * QUAD_FLOATS);

		const render = encoder.beginRenderPass({
			label: 'lens flare',
			colorAttachments: [{ view: sized.target, loadOp: 'load', storeOp: 'store' }],
		});
		for (let i = 0; i < count; i++) {
			let draw = this.#drawPipelines[i].with(sized.frame);
			const group = this.#drawGroups[i];
			if (group !== null) {
				draw = draw.with(group);
			}
			draw.with(render).draw(4, 1, 0, i);
		}
		render.end();
	}

	/** frees the buffers */
	destroy(): void {
		this.#frame.buffer.destroy();
		this.#quads.destroy();
	}
}
