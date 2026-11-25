import { type TgpuBindGroup, type TgpuComputePipeline, type TgpuRoot, d } from 'typegpu';

import { createBufferWithData } from '../../gfx/buffers.ts';
import type { AsyncPipeline, PipelineCache } from '../../gfx/pipeline-cache.ts';
import type { DecodedSkin } from '../../package/decode-protocol.ts';

import { skinFrame } from './skin-frame.ts';
import { SKIN_NONE, SkinParamsSchema, csSkin, skinLayout } from './skin-shader.ts';

/** bytes of {@link SkinParamsSchema} */
const PARAMS_BYTES = d.sizeOf(SkinParamsSchema);
const WORKGROUP = 64;
const PIPELINE_KEY = 'skin';

const streamOutWord = (offset: number | null, from: number): number =>
	offset !== null && from >= 0 ? offset / 4 : SKIN_NONE;

/** an animated geometry's GPU side: its bind pose, frames and the pass that skins it into its vertices */
export interface ResidentSkin {
	vertexCount: number;
	frameCount: number;
	frameRate: number;
	/** `SkinParamsSchema`; the frame fields change with the frame */
	params: GPUBuffer;
	/** the params as last written, as words and as floats */
	paramWords: Uint32Array<ArrayBuffer>;
	paramFloats: Float32Array<ArrayBuffer>;
	/** whether the vertices hold the frame the params name; `false` until first skinned */
	skinned: boolean;
	group: TgpuBindGroup;
	/** GPU bytes of the bind pose and frames */
	bytes: number;
	/** buffers the skin owns, destroyed with it */
	buffers: GPUBuffer[];
}

/** skins animated geometries into their own vertex buffers before they're drawn */
export class SkinAnimator {
	#root: TgpuRoot;
	#pipeline: AsyncPipeline<TgpuComputePipeline>;

	/**
	 * @param root the TypeGPU root
	 * @param pipelines the pipeline cache, which compiles the skinning pass
	 */
	constructor(root: TgpuRoot, pipelines: PipelineCache) {
		this.#root = root;
		this.#pipeline = pipelines.prepareTgpuCompute(PIPELINE_KEY, () =>
			root.createComputePipeline({ compute: csSkin }),
		);
	}

	/**
	 * uploads an animated geometry's bind pose and frames
	 *
	 * @param label names the buffers
	 * @param skin the decoded animation
	 * @param target the geometry's vertex buffer, created with storage usage, and where its streams start
	 * @returns the residency; destroy its buffers with the geometry's
	 */
	create(
		label: string,
		skin: DecodedSkin,
		target: {
			vertices: GPUBuffer;
			vertexCount: number;
			normalOffset: number | null;
			tangentOffset: number | null;
			positionOffset: readonly number[];
			positionScale: readonly number[];
		},
	): ResidentSkin {
		const device = this.#root.device;
		const storage = (name: string, data: ArrayBuffer): GPUBuffer =>
			createBufferWithData(device, {
				label: `${label} ${name}`,
				usage: GPUBufferUsage.STORAGE,
				data,
				minSize: 16,
			});
		const source = storage('bind pose', skin.source);
		const frames = storage('frames', skin.matrices);
		const paramData = new ArrayBuffer(PARAMS_BYTES);
		const words = new Uint32Array(paramData);
		const floats = new Float32Array(paramData);
		{
			words[0] = target.vertexCount;
			words[1] = skin.boneCount;
			// a stream the geometry has is written in place of its bind pose's, which the source keeps
			words[5] = streamOutWord(target.normalOffset, skin.normalWord);
			words[6] = streamOutWord(target.tangentOffset, skin.tangentWord);
			words[7] = Math.max(skin.normalWord, 0);
			words[8] = Math.max(skin.tangentWord, 0);
			words[9] = skin.weightWord;
			words[10] = skin.boneWord;
			words[11] = skin.wideBones ? 1 : 0;
			floats.set(skin.bindOffset, 12);
			floats.set(skin.bindScale, 16);
			floats.set(target.positionOffset, 20);
			floats.set(
				target.positionScale.map((scale) => (scale === 0 ? 0 : 1 / scale)),
				24,
			);
		}
		// the frame fields are written again as the animation plays
		const params = createBufferWithData(device, {
			label: `${label} skin`,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
			data: paramData,
		});
		const group = this.#root.createBindGroup(skinLayout, {
			skin: params,
			source,
			frames,
			vertices: target.vertices,
		});
		return {
			vertexCount: target.vertexCount,
			frameCount: skin.frameCount,
			frameRate: skin.frameRate,
			params,
			paramWords: words,
			paramFloats: floats,
			skinned: false,
			group,
			bytes: source.size + frames.size + params.size,
			buffers: [source, frames, params],
		};
	}

	/**
	 * skins each geometry at the time's frame, before anything draws them; a geometry whose vertices already
	 * hold that frame is skipped. nothing is skinned while the pipeline compiles
	 *
	 * @param encoder the frame's encoder
	 * @param skins the animated geometries drawn this frame
	 * @param time seconds of the viewer's clock; every geometry plays from the same start
	 * @returns whether any geometry was skinned
	 */
	encode(encoder: GPUCommandEncoder, skins: Iterable<ResidentSkin>, time: number): boolean {
		const pipeline = this.#pipeline.get();
		if (pipeline === undefined) {
			return false;
		}
		let pass: GPUComputePassEncoder | null = null;
		for (const skin of skins) {
			const { a, b, blend } = skinFrame(time, skin.frameCount, skin.frameRate);
			const words = skin.paramWords;
			const floats = skin.paramFloats;
			if (skin.skinned && words[2] === a && words[3] === b && floats[4] === Math.fround(blend)) {
				continue;
			}
			words[2] = a;
			words[3] = b;
			floats[4] = blend;
			skin.skinned = true;
			// only the frame fields change
			this.#root.device.queue.writeBuffer(skin.params, 0, words, 0, 5);
			pass ??= encoder.beginComputePass({ label: 'skin' });
			pipeline
				.with(skin.group)
				.with(pass)
				.dispatchWorkgroups(Math.ceil(skin.vertexCount / WORKGROUP));
		}
		pass?.end();
		return pass !== null;
	}
}
