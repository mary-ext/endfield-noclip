import type { ReadyTexture } from '@endfield-noclip/package-format/textures';

import type { TextureBinding, TextureStore } from '../render/textures/texture-store.ts';

import type { StreamManager } from './stream-manager.ts';

/** what texture requests ask of the stream */
export type TextureStream = Pick<StreamManager, 'want' | 'markUsed' | 'isReady' | 'discard'>;

/** how a texture is bound */
export type TextureKind = '2d' | 'cube' | '2d-array' | '3d';

/**
 * requests a texture's pieces coarse to fine, down to the piece holding `level`, and keeps the integrated
 * ones in use
 */
const requestPieces = (
	stream: TextureStream,
	textures: TextureStore,
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
		} else if (i === integrated) {
			// a piece left over from before a coarser one was evicted can't be integrated: fetch it again
			if (stream.isReady(blob)) {
				stream.discard(blob);
			}
			// coarse pieces first; the tail always, then each level the view needs
			if (i === 0 || piece.firstLevel + piece.levelCount - 1 >= level) {
				stream.want(blob, priority / (1 + i));
			}
		} else {
			// decoded ahead of a coarser piece: keep it from looking unused until it's integrated
			stream.markUsed(blob);
		}
		if (piece.firstLevel <= level) {
			break;
		}
	}
};

/** requests textures of one texture store, without allocating per request */
export class TextureRequests {
	#stream: TextureStream;
	#textures: TextureStore;

	/**
	 * @param stream residency
	 * @param textures the texture store the textures integrate into
	 */
	constructor(stream: TextureStream, textures: TextureStore) {
		this.#stream = stream;
		this.#textures = textures;
	}

	/**
	 * requests a 2D texture's pieces coarse to fine, up to the level its largest on-screen use needs: about one
	 * texel per pixel across the object, scaled by how often the UVs tile
	 *
	 * @param id texture id
	 * @param pixels the use's on-screen size, px; also the priority
	 * @param uvScale how often the UVs tile across the object
	 */
	forPixels(id: number, pixels: number, uvScale: number): void {
		const entry = this.#textures.streamable(id, '2d');
		if (entry === null) {
			return;
		}
		const texels = Math.max(entry.width, entry.height) * uvScale;
		const level = Math.min(
			entry.mipCount - 1,
			Math.max(0, Math.floor(Math.log2(texels / Math.max(pixels, 1)))),
		);
		requestPieces(this.#stream, this.#textures, { id, entry }, level, pixels);
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
