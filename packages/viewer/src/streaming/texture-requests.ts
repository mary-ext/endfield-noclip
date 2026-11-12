import type { ReadyTexture } from '@endfield-noclip/package-format/textures';

import type { TextureBinding, TextureStore } from '../render/textures/texture-store.ts';

import type { StreamManager } from './stream-manager.ts';

/** what texture requests ask of the stream */
export type TextureStream = Pick<StreamManager, 'want' | 'markUsed' | 'isReady' | 'discard'>;

/** what texture requests ask of the texture store */
export type RequestedTextures = Pick<TextureStore, 'streamable' | 'integrated' | 'waiting' | 'blendsLevels'>;

/** how a texture is bound */
export type TextureKind = '2d' | 'cube' | '2d-array' | '3d';

/**
 * requests a texture's pieces down to the piece holding `level`, all at once and coarse first, and keeps the
 * integrated ones in use. a piece that arrives before a coarser one waits in the store, so the levels the
 * view needs take one round trip rather than one per piece; a texture's pieces mostly sit side by side in one
 * archive, so they're usually read together too
 */
const requestPieces = (
	stream: TextureStream,
	textures: RequestedTextures,
	texture: { id: number; entry: ReadyTexture },
	level: number,
	priority: number,
): void => {
	const pieces = texture.entry.pieces;
	const integrated = textures.integrated(texture.id);
	for (let i = 0; i < pieces.length; i++) {
		const piece = pieces[i];
		const blob = piece.blob;
		if (i < integrated) {
			stream.markUsed(blob);
		} else {
			// a piece left over from before a coarser one was evicted lost its levels: fetch it again
			if (stream.isReady(blob) && !textures.waiting(texture.id, i)) {
				stream.discard(blob);
			}
			stream.want(blob, priority / (1 + i));
		}
		if (piece.firstLevel <= level) {
			break;
		}
	}
};

/** mip levels an unseen material's textures stop short of what its size on screen asks for */
const UNSEEN_LEVELS = 2;
/** the largest level an unseen material's textures load, texels a side */
const UNSEEN_TEXELS = 256;

/** requests textures of one texture store, without allocating per request */
export class TextureRequests {
	#stream: TextureStream;
	#textures: RequestedTextures;

	/**
	 * @param stream residency
	 * @param textures the texture store the textures integrate into
	 */
	constructor(stream: TextureStream, textures: RequestedTextures) {
		this.#stream = stream;
		this.#textures = textures;
	}

	/**
	 * requests a 2D texture's pieces coarse to fine, up to the level its largest on-screen use needs: about one
	 * texel per pixel across the object, scaled by how often the UVs tile
	 *
	 * @param id texture id
	 * @param pixels the use's on-screen size, px
	 * @param uvScale how often the UVs tile across the object
	 * @param priority the priority
	 */
	forPixels(id: number, pixels: number, uvScale: number, priority: number): void {
		const entry = this.#textures.streamable(id, '2d');
		if (entry === null) {
			return;
		}
		const texels = Math.max(entry.width, entry.height) * uvScale;
		const level = Math.min(
			entry.mipCount - 1,
			Math.max(0, Math.floor(Math.log2(texels / Math.max(pixels, 1)))),
		);
		requestPieces(this.#stream, this.#textures, { id, entry }, level, priority);
	}

	/**
	 * requests the coarse levels of a 2D texture whose material is drawn but had no pixel read back (hidden
	 * behind something, or about to show): {@link UNSEEN_LEVELS} coarser than {@link forPixels} would, and no
	 * level over {@link UNSEEN_TEXELS} a side, so that what comes into sight isn't a smear while its levels
	 * load
	 *
	 * @param id texture id
	 * @param pixels the use's on-screen size, px
	 * @param uvScale how often the UVs tile across the object
	 * @param priority the priority
	 */
	forUnseen(id: number, pixels: number, uvScale: number, priority: number): void {
		const entry = this.#textures.streamable(id, '2d');
		if (entry === null) {
			return;
		}
		const side = Math.max(entry.width, entry.height);
		const level = Math.min(
			entry.mipCount - 1,
			Math.max(
				0,
				Math.floor(Math.log2((side * uvScale) / Math.max(pixels, 1))) + UNSEEN_LEVELS,
				Math.ceil(Math.log2(side / UNSEEN_TEXELS)),
			),
		);
		requestPieces(this.#stream, this.#textures, { id, entry }, level, priority);
	}

	/**
	 * requests a 2D texture's pieces coarse to fine, up to the finest level the frames just drawn sampled
	 *
	 * @param id texture id
	 * @param steps how many quarter mip levels below one UV unit per pixel the finest sample's footprint was
	 *   (`MipSteps.steps`)
	 * @param uvScale how often the material tiles the texture across a UV unit
	 * @param bias mip levels coarser than sampled to stop at
	 * @param priority the priority
	 */
	forFootprint(id: number, steps: number, uvScale: number, bias: number, priority: number): void {
		const entry = this.#textures.streamable(id, '2d');
		if (entry === null) {
			return;
		}
		// the level of detail the GPU computes: the footprint in texels of the longer side, which also holds for
		// the shorter
		const lod = Math.log2(Math.max(entry.width, entry.height) * uvScale) - steps / 4;
		// a sampler that blends neighbouring levels reads the finer of the two; one that doesn't rounds
		const sampled = Math.floor(this.#textures.blendsLevels(id) ? lod : lod + 0.5);
		const level = Math.min(entry.mipCount - 1, Math.max(0, sampled + Math.ceil(bias)));
		requestPieces(this.#stream, this.#textures, { id, entry }, level, priority);
	}

	/**
	 * requests every level of a texture, as {@link streamWholeTexture} does
	 *
	 * @param id texture id, or `null` for none
	 * @param kind the kind it's bound as
	 * @param priority the priority
	 * @returns the texture, or `null` without a texture streamable as that kind
	 */
	whole(id: number | null, kind: TextureKind, priority: number): ReadyTexture | null {
		if (id === null) {
			return null;
		}
		const entry = this.#textures.streamable(id, kind);
		if (entry !== null) {
			requestPieces(this.#stream, this.#textures, { id, entry }, 0, priority);
		}
		return entry;
	}
}

/** a texture streamed whole by {@link streamWholeTexture} */
export interface StreamedTexture {
	entry: ReadyTexture;
	/** `null` until its tail arrives */
	binding: TextureBinding | null;
}

/**
 * requests every level of a texture (sky and water textures, which aren't picked by screen size).
 *
 * @param request the stream, the texture store, the texture id (or `null` for none), the kind it's bound as
 *   and the priority
 * @returns the texture and its current binding, or `null` without a texture streamable as that kind
 */
export const streamWholeTexture = (request: {
	stream: TextureStream;
	textures: TextureStore;
	id: number | null;
	kind: TextureKind;
	priority: number;
}): StreamedTexture | null => {
	const { stream, textures, id, kind, priority } = request;
	if (id === null) {
		return null;
	}
	const entry = textures.streamable(id, kind);
	if (entry === null) {
		return null;
	}
	requestPieces(stream, textures, { id, entry }, 0, priority);
	return { entry, binding: textures.binding(id) };
};
