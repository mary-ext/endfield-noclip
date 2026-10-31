/**
 * mip-streamed textures. a texture's levels arrive as pieces (blobs): first the tail of small levels, then
 * one blob per larger level. the GPU texture always holds a contiguous run of levels from the finest
 * integrated piece down to 1×1; integrating a finer piece builds a texture one step larger and copies the
 * coarser levels over, and releasing a piece shrinks it the same way. texel data is uploaded as stored (BC
 * blocks, no transcoding, row 0 is v = 0).
 *
 * @module
 */

import {
	type ReadyTexture,
	TEXTURE_FORMATS,
	type TextureTable,
	textureLevelLayout,
} from '@endfield-noclip/package-format/textures';

import type { DecodedTexture } from '../package/decode-protocol.ts';
import type { ResidentTexture } from '../streaming/stream-manager.ts';

interface PieceRef {
	texture: number;
	/** index into the texture's pieces, coarse (tail) first */
	index: number;
}

/** what a material bind group needs of a texture */
export interface TextureBinding {
	view: GPUTextureView;
	sampler: GPUSampler;
	/** changes whenever the view does, so bind groups can be rebuilt */
	version: number;
}

interface TextureState {
	entry: ReadyTexture;
	/** the GPU texture, or `null` before the tail arrives */
	gpu: GPUTexture | null;
	/** the GPU texture's binding, or `null` before the tail arrives */
	binding: TextureBinding | null;
	/** source level held as GPU level 0 */
	top: number;
	/** pieces integrated, counted from the tail; the GPU texture may still hold finer released levels */
	integrated: number;
	/** decoded pieces waiting for a coarser one, by piece index */
	waiting: Map<number, Uint8Array<ArrayBuffer>>;
	/** bumped whenever the GPU texture changes */
	version: number;
	sampler: GPUSampler;
}

/** the view a texture of this kind is bound as */
const viewDimension = (kind: ReadyTexture['kind']): GPUTextureViewDimension => {
	switch (kind) {
		case 'cube': {
			return 'cube';
		}
		case '2d-array': {
			return '2d-array';
		}
		case '3d': {
			return '3d';
		}
		default: {
			return '2d';
		}
	}
};

const blockAligned = (value: number, block: number): number => Math.ceil(value / block) * block;

/**
 * @param device the device
 * @param options the label, the view dimension, and the format (`rgba8unorm` by default)
 * @returns a view of a 1×1 zeroed texture (six layers for a cube), bound where a texture is missing
 */
export const placeholderView = (
	device: GPUDevice,
	{
		label,
		dimension,
		format = 'rgba8unorm',
	}: { label: string; dimension: '2d' | '2d-array' | 'cube' | '3d'; format?: GPUTextureFormat },
): GPUTextureView =>
	device
		.createTexture({
			label,
			size: [1, 1, dimension === 'cube' ? 6 : 1],
			dimension: dimension === '3d' ? '3d' : '2d',
			format,
			usage: GPUTextureUsage.TEXTURE_BINDING,
		})
		.createView({ dimension });

/** owns texture residency for one package */
export class TextureStore {
	#device: GPUDevice;
	#table: TextureTable;
	/**
	 * the pieces each blob holds: the packer stores identical pieces once, so one blob can serve several
	 * textures
	 */
	#pieces = new Map<number, PieceRef[]>();
	#states = new Map<number, TextureState>();
	#samplers = new Map<string, GPUSampler>();
	/** textures that lost pieces since the last {@link commit} */
	#released = new Set<TextureState>();
	/**
	 * GPU textures replaced since the last {@link commit}. bindings handed out before the stream update that
	 * replaced them are still in this frame's command buffer, so they're destroyed one commit later, by when
	 * every user has asked for its binding again
	 */
	#retired: GPUTexture[] = [];
	#retiring: GPUTexture[] = [];
	#supported: boolean;
	/** GPU bytes of integrated levels */
	bytes = 0;
	/** bumped whenever any texture's binding changes, so users can keep what they derived from bindings */
	version = 0;

	/**
	 * @param device the device
	 * @param table the package's texture table
	 * @param formats `bc` tells whether BC formats are available
	 */
	constructor(device: GPUDevice, table: TextureTable, formats: { bc: boolean }) {
		this.#device = device;
		this.#table = table;
		this.#supported = formats.bc;
		for (const entry of table.entries) {
			if (entry.status !== 'ready') {
				continue;
			}
			entry.pieces.forEach((piece, i) => {
				const refs = this.#pieces.get(piece.blob);
				const ref = { texture: entry.id, index: i };
				if (refs === undefined) {
					this.#pieces.set(piece.blob, [ref]);
				} else {
					refs.push(ref);
				}
			});
		}
	}

	/**
	 * @param id texture id
	 * @param kind the kind the caller binds it as
	 * @returns the entry if this viewer can stream it (that kind, a supported format, block-aligned size)
	 */
	streamable(id: number, kind: '2d' | 'cube' | '2d-array' | '3d'): ReadyTexture | null {
		const entry = this.#table.entries[id];
		if (entry?.status !== 'ready' || entry.kind !== kind) {
			return null;
		}
		const info = TEXTURE_FORMATS[entry.format];
		if (info === undefined || (info.blockWidth > 1 && !this.#supported)) {
			return null;
		}
		if (entry.width % info.blockWidth !== 0 || entry.height % info.blockHeight !== 0) {
			return null;
		}
		return entry;
	}

	/**
	 * @param id texture id
	 * @returns how many pieces (from the tail) are integrated
	 */
	integrated(id: number): number {
		return this.#states.get(id)?.integrated ?? 0;
	}

	/**
	 * @param id texture id
	 * @returns the texture's binding (the same object until the view changes), or `null` before the tail
	 *   arrives
	 */
	binding(id: number): TextureBinding | null {
		const state = this.#states.get(id);
		if (state === undefined) {
			return null;
		}
		this.#shrink(state);
		return state.binding;
	}

	/**
	 * takes a decoded piece; integrates it (and any waiting finer pieces) when the coarser ones are present.
	 *
	 * @param blob the piece's blob
	 * @param decoded the piece's level data
	 * @returns the residency; textures aren't pooled and the memory budget bounds them
	 */
	upload(blob: number, decoded: DecodedTexture): ResidentTexture {
		const data = new Uint8Array(decoded.data);
		for (const ref of this.#pieces.get(blob) ?? []) {
			const state = this.#state(ref.texture);
			this.#shrink(state);
			state.waiting.set(ref.index, data);
			while (state.waiting.has(state.integrated)) {
				const next = state.waiting.get(state.integrated);
				state.waiting.delete(state.integrated);
				if (next !== undefined) {
					this.#integrate(state, next);
				}
			}
		}
		return { kind: 'texture', bytes: data.byteLength };
	}

	/**
	 * forgets a piece; the texture shrinks to the levels coarser than it before its next use.
	 *
	 * @param blob the piece's blob
	 */
	release(blob: number): void {
		for (const ref of this.#pieces.get(blob) ?? []) {
			const state = this.#states.get(ref.texture);
			if (state === undefined) {
				continue;
			}
			state.waiting.delete(ref.index);
			// finer integrated pieces lose their levels too
			state.integrated = Math.min(state.integrated, ref.index);
			this.#released.add(state);
		}
	}

	/**
	 * shrinks the textures that lost pieces since the last call, once however many pieces each lost. call once
	 * a frame, after the stream update; bindings from before the previous call are invalid afterwards.
	 */
	commit(): void {
		for (const texture of this.#retiring) {
			texture.destroy();
		}
		this.#retiring = this.#retired;
		this.#retired = [];
		for (const state of this.#released) {
			this.#shrink(state);
		}
		this.#released.clear();
	}

	/** frees every texture */
	destroy(): void {
		for (const state of this.#states.values()) {
			state.gpu?.destroy();
		}
		for (const texture of [...this.#retired, ...this.#retiring]) {
			texture.destroy();
		}
		this.#retired = [];
		this.#retiring = [];
		this.#states.clear();
		this.#released.clear();
		this.bytes = 0;
	}

	#state(id: number): TextureState {
		let state = this.#states.get(id);
		if (state === undefined) {
			const entry = this.#table.entries[id];
			if (entry?.status !== 'ready') {
				throw new Error(`texture ${id} isn't ready`);
			}
			state = {
				entry,
				gpu: null,
				binding: null,
				top: entry.mipCount,
				integrated: 0,
				waiting: new Map(),
				version: 0,
				sampler: this.#sampler(entry),
			};
			this.#states.set(id, state);
		}
		return state;
	}

	#sampler(entry: ReadyTexture): GPUSampler {
		const { mipBias: _, ...descriptor } = entry.sampler;
		const key = JSON.stringify(descriptor);
		let sampler = this.#samplers.get(key);
		if (sampler === undefined) {
			sampler = this.#device.createSampler(descriptor);
			this.#samplers.set(key, sampler);
		}
		return sampler;
	}

	#create(entry: ReadyTexture, top: number): GPUTexture {
		const layout = textureLevelLayout(entry, top);
		return this.#device.createTexture({
			label: `texture ${entry.id}@${top}`,
			size: [layout.width, layout.height, layout.depthOrArrayLayers],
			dimension: entry.kind === '3d' ? '3d' : '2d',
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- TEXTURE_FORMATS keys are WebGPU format names
			format: entry.format as GPUTextureFormat,
			mipLevelCount: entry.mipCount - top,
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
		});
	}

	/** swaps in `next` (holding levels `top…`), copying the levels both have from the current texture */
	#replace(state: TextureState, next: GPUTexture | null, top: number): void {
		const previous = state.gpu;
		const info = TEXTURE_FORMATS[state.entry.format];
		if (previous !== null && next !== null) {
			const encoder = this.#device.createCommandEncoder({ label: 'texture levels' });
			for (let level = Math.max(top, state.top); level < state.entry.mipCount; level++) {
				const layout = textureLevelLayout(state.entry, level);
				encoder.copyTextureToTexture(
					{ texture: previous, mipLevel: level - state.top },
					{ texture: next, mipLevel: level - top },
					[
						blockAligned(layout.width, info.blockWidth),
						blockAligned(layout.height, info.blockHeight),
						layout.depthOrArrayLayers,
					],
				);
			}
			this.#device.queue.submit([encoder.finish()]);
		}
		this.bytes -= this.#levelBytes(state.entry, state.top);
		if (previous !== null) {
			this.#retired.push(previous);
		}
		state.gpu = next;
		state.top = next === null ? state.entry.mipCount : top;
		state.version++;
		this.version++;
		state.binding =
			next === null
				? null
				: {
						view: next.createView({ dimension: viewDimension(state.entry.kind) }),
						sampler: state.sampler,
						version: state.version,
					};
		this.bytes += this.#levelBytes(state.entry, state.top);
	}

	/** drops levels of released pieces from the GPU texture */
	#shrink(state: TextureState): void {
		const pieces = state.entry.pieces;
		const top = state.integrated === 0 ? state.entry.mipCount : pieces[state.integrated - 1].firstLevel;
		if (state.top >= top) {
			return;
		}
		this.#replace(state, state.integrated === 0 ? null : this.#create(state.entry, top), top);
	}

	#levelBytes(entry: ReadyTexture, top: number): number {
		let bytes = 0;
		for (let level = top; level < entry.mipCount; level++) {
			bytes += textureLevelLayout(entry, level).byteLength;
		}
		return bytes;
	}

	#integrate(state: TextureState, data: Uint8Array<ArrayBuffer>): void {
		const piece = state.entry.pieces[state.integrated];
		const next = this.#create(state.entry, piece.firstLevel);
		this.#replace(state, next, piece.firstLevel);
		const info = TEXTURE_FORMATS[state.entry.format];
		let at = 0;
		for (let level = piece.firstLevel; level < piece.firstLevel + piece.levelCount; level++) {
			const layout = textureLevelLayout(state.entry, level);
			this.#device.queue.writeTexture(
				{ texture: next, mipLevel: level - piece.firstLevel },
				data.subarray(at, at + layout.byteLength),
				{ bytesPerRow: layout.bytesPerRow, rowsPerImage: layout.rowsPerImage },
				[
					blockAligned(layout.width, info.blockWidth),
					blockAligned(layout.height, info.blockHeight),
					layout.depthOrArrayLayers,
				],
			);
			at += layout.byteLength;
		}
		state.integrated++;
	}
}
