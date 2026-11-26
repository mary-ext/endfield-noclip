import tgpu, { type TgpuRenderPipeline, type TgpuRoot, d, std } from 'typegpu';

import type { AsyncPipeline, PipelineCache } from '../../gfx/pipeline-cache.ts';
import { SHADOW_FORMAT } from '../core/render-targets.ts';

import { ATLAS_SIZE, ShadowTiles } from './shadow-tiles.ts';

const CLEAR_KEY = 'light shadow clear';

/** clears one tile of the local lights' shadow atlas: a triangle over the viewport at the far depth */
const vsLightShadowClear = tgpu.vertexFn({
	in: { index: d.builtin.vertexIndex },
	out: { position: d.builtin.position },
})((input) => {
	'use gpu';
	const corner = d.vec2f(d.f32((input.index << 1) & 2), d.f32(input.index & 2));
	return { position: d.vec4f(std.sub(std.mul(corner, 2), d.vec2f(1)), 1, 1) };
});

/** the local lights' shadow atlas, with the tiles {@link ShadowTiles} hands out, and the pass that draws one */
export class LightShadows extends ShadowTiles {
	readonly texture: GPUTexture;
	/** the atlas, sampled and drawn into */
	readonly view: GPUTextureView;
	readonly #clear: AsyncPipeline<TgpuRenderPipeline>;

	/**
	 * @param root the TypeGPU root
	 * @param pipelines the pipeline cache
	 */
	constructor(root: TgpuRoot, pipelines: PipelineCache) {
		super();
		this.texture = root.device.createTexture({
			label: 'local light shadows',
			size: [ATLAS_SIZE, ATLAS_SIZE],
			format: SHADOW_FORMAT,
			usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
		});
		this.view = this.texture.createView();
		this.#clear = pipelines.prepareTgpuRender(CLEAR_KEY, () =>
			root.createRenderPipeline({
				vertex: vsLightShadowClear,
				depthStencil: { format: SHADOW_FORMAT, depthWriteEnabled: true, depthCompare: 'always' },
			}),
		);
	}

	/** @returns bytes of the atlas (16-bit depth) */
	get bytes(): number {
		return ATLAS_SIZE * ATLAS_SIZE * 2;
	}

	/**
	 * draws {@link request}'s tile: clears it, then lets `draw` encode the casters
	 *
	 * @param encoder this frame's encoder
	 * @param bind binds the pass's frame group, whose view-projection is the request's
	 * @param draw encodes the casters into the pass and returns its draws
	 * @returns the draws encoded
	 */
	encode(
		encoder: GPUCommandEncoder,
		bind: (pass: GPURenderPassEncoder) => void,
		draw: (pass: GPURenderPassEncoder) => number,
	): number {
		const request = this.request;
		const clear = this.#clear.get();
		if (request === null || clear === undefined) {
			return 0;
		}
		const pass = encoder.beginRenderPass({
			label: 'local light shadow',
			colorAttachments: [],
			depthStencilAttachment: { view: this.view, depthLoadOp: 'load', depthStoreOp: 'store' },
		});
		const { x, y, size } = request;
		pass.setViewport(x, y, size, size, 0, 1);
		pass.setScissorRect(x, y, size, size);
		clear.with(pass).draw(3);
		bind(pass);
		const draws = draw(pass);
		pass.end();
		return draws + 1;
	}

	/** frees the atlas */
	destroy(): void {
		this.texture.destroy();
	}
}
