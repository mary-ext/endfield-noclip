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
