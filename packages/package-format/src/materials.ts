import type { UnconvertedEntry } from './entries.ts';

/** `tables/materials.json`; entry `i` has id `i` */
export interface MaterialTable {
	/** shaders by index. a material stores only the values that differ from its shader's defaults */
	shaders: ShaderEntry[];
	entries: MaterialEntry[];
}

/**
 * a shader's declared properties and their defaults. a material parameter's value is the material's override
 * if present, else this default. undeclared (stale) material properties are dropped
 */
export interface ShaderEntry {
	/** e.g. `HGRP/Lit` */
	name: string;
	family: ShaderFamily;
	/** Float, Range and Int properties */
	floats: Record<string, number>;
	/**
	 * Color properties, as authored (gamma-encoded): like Unity in a linear-space project, convert them to
	 * linear before shading
	 */
	colors: Record<string, [r: number, g: number, b: number, a: number]>;
	/** Vector properties, used as they are */
	vectors: Record<string, [x: number, y: number, z: number, w: number]>;
	/** texture properties and the Unity built-in each defaults to (`white`, `black`, `gray`, `bump`, …) */
	textures: Record<string, string>;
	/** texture properties flagged `[Normal]` (tangent-space normal maps) */
	normalMaps: string[];
}

/**
 * the HGRP shader family a shader belongs to; `unknown` for shaders the viewer has no path for. the decoder
 * (formats' `unity/material.ts`) spells the same union independently, since neither package may depend on the
 * other; the extractor's mapping type-checks against both
 */
export type ShaderFamily =
	| 'lit'
	| 'litTransparent'
	| 'leaf'
	| 'trunk'
	| 'grass'
	| 'cardMesh'
	| 'fogSimple'
	| 'waterProxy'
	| 'waterDecal'
	| 'water'
	| 'decal'
	| 'vfxBase'
	| 'vfxAdvance'
	| 'vfxRefract'
	| 'vfxDitherAlpha'
	| 'vfxFakeVolumeFog'
	| 'volumetricBeam'
	| 'terrain'
	| 'hlod'
	| 'mattePainting'
	| 'erosion'
	| 'unknown';

/** how a material composites */
export type MaterialBlend = 'opaque' | 'alphaTest' | 'alphaBlend' | 'premultiplied' | 'additive' | 'custom';

/** which faces a material culls */
export type MaterialCull = 'back' | 'front' | 'none';

/** one material */
export type MaterialEntry = UnconvertedEntry | ReadyMaterial;

/** a converted material */
export interface ReadyMaterial {
	id: number;
	status: 'ready';
	/** index into {@link MaterialTable.shaders} */
	shader: number;
	/** enabled shader keywords */
	keywords: string[];
	/** the custom queue, else the shader's, else 2000 */
	renderQueue: number;
	blend: MaterialBlend;
	/** source and destination factors (Unity `BlendMode` values) for blended materials */
	blendFactors: [src: number, dst: number] | null;
	/** alpha-test threshold, or `null` without alpha testing */
	alphaClipThreshold: number | null;
	cull: MaterialCull;
	zWrite: boolean;
	/**
	 * the Lit families' `_BaseTextureMapCount`: 0 adds an MRO map (R metallic, G roughness, B occlusion) and an
	 * `RAG` normal map; 1 and 2 use an `RG` normal map with roughness in B, and metallic from the base map's
	 * alpha (1) or `_Metallic` (2). `null` outside the Lit families
	 */
	baseTextureMapCount: number | null;
	/** bound textures by Unity property name (`_BaseColorMap`, `_NormalMap`, …); empty slots are absent */
	slots: Record<string, TextureSlot>;
	/** overrides of {@link ShaderEntry.floats} */
	floats: Record<string, number>;
	/** overrides of {@link ShaderEntry.colors} */
	colors: Record<string, [r: number, g: number, b: number, a: number]>;
	/** overrides of {@link ShaderEntry.vectors} */
	vectors: Record<string, [x: number, y: number, z: number, w: number]>;
}

/** a texture bound to a material slot */
export interface TextureSlot {
	/** index into the texture table */
	texture: number;
	/** UV set ({@link VertexAttribute.TexCoord0} + `uv`) */
	uv: number;
	/** `uv' = uv · scale + offset` (Unity's `_ST`) */
	scale: [u: number, v: number];
	offset: [u: number, v: number];
}
