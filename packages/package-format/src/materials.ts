import type { UnconvertedEntry } from './entries.ts';
import type { MaterialSurface } from './surfaces.ts';

/** `tables/materials.json.zst`; a material's id is its index in `entries` */
export interface MaterialTable {
	entries: MaterialEntry[];
}

/** which faces a material culls */
export type MaterialCull = 'back' | 'front' | 'none';

/** one material */
export type MaterialEntry = UnconvertedEntry | ReadyMaterial;

/** a converted material */
export interface ReadyMaterial {
	status: 'ready';
	/** the faces the game culls */
	cull: MaterialCull;
	/** what the material draws, interpreted by the extractor */
	surface: MaterialSurface;
	/**
	 * what the game draws of the material that `surface` leaves out, as far as the extractor knows: the shader
	 * keywords its describer doesn't read and the properties it reads past, by name. empty for a surface that
	 * holds everything, and for unsupported and undrawn ones, whose reason says what's missing
	 */
	gaps: string[];
	/** the numbers of `surface` a looping clip keeps changing; `null` for a material that holds still */
	motion: MaterialMotion | null;
}

/**
 * what a looping animation clip does to a material's surface: a prefab's Animator setting material properties
 * on a renderer over time. it plays from the viewer's clock, in step with the looping geometry of its prefab
 */
export interface MaterialMotion {
	/** seconds per loop */
	duration: number;
	tracks: MaterialTrack[];
}

/** one number of a surface over a {@link MaterialMotion}'s loop */
export interface MaterialTrack {
	/** where the number is in the surface: property names and array indices from its root */
	path: (string | number)[];
	/**
	 * its value at even steps through the loop, the first at the loop's start, each held until the next; a
	 * material's tracks all have as many
	 */
	values: number[];
}

/** a texture bound to a material slot */
export interface TextureSlot {
	/** index into the texture table: a slot is always bound */
	texture: number;
	/** UV set ({@link VertexAttribute.TexCoord0} + `uv`) */
	uv: number;
	/** `uv' = uv · scale + offset` (Unity's `_ST`) */
	scale: [u: number, v: number];
	offset: [u: number, v: number];
}
