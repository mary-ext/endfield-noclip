/**
 * a converted material's values, its shader's declared defaults, and the reader the surface describers use: a
 * material's own value, else its shader's declared default, else the describer's fallback. the package
 * carries only the surfaces described from these.
 */

import type { MaterialCull, TextureSlot } from '@endfield-noclip/package-format/materials';
import type { UnsupportedSurface } from '@endfield-noclip/package-format/surfaces';
import type { Rgb } from '@endfield-noclip/package-format/values';

/** @returns an unsupported surface for `reason` */
export const unsupported = (reason: string): UnsupportedSurface => ({ kind: 'unsupported', reason });

/**
 * @param value a describer step's result: its part of the surface, `unsupported`, or `null` without one
 * @returns whether the step found the material undrawable
 */
export const isUnsupported = (value: object | null): value is UnsupportedSurface =>
	value !== null && 'kind' in value && value.kind === 'unsupported';

/** a four-component colour or vector property */
export type Vec4 = [number, number, number, number];

/** the HGRP shader family a shader belongs to; `unknown` for shaders the viewer has no look for */
export type ShaderFamily =
	| 'lit'
	| 'litTransparent'
	| 'litEffect'
	| 'litForward'
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
	| 'vfxSmokeSixWay'
	| 'vfxFakeVolumeFog'
	| 'volumetricBeam'
	| 'terrain'
	| 'hlod'
	| 'mattePainting'
	| 'erosion'
	| 'unknown';

/** how a material composites */
export type MaterialBlend = 'opaque' | 'alphaTest' | 'alphaBlend' | 'premultiplied' | 'additive' | 'custom';

/**
 * a shader's declared properties and their defaults. a material property's value is the material's override
 * if present, else this default. undeclared (stale) material properties are dropped
 */
export interface ShaderEntry {
	/** e.g. `HGRP/Lit` */
	name: string;
	family: ShaderFamily;
	/** Float, Range and Int properties */
	floats: Record<string, number>;
	/**
	 * Color properties, as authored: LDR colours are gamma-encoded and, as in Unity's linear-space projects,
	 * converted to linear before shading; `[HDR]` colours are authored linear and used as stored (see
	 * `docs/game-data/materials.md#emission`)
	 */
	colors: Record<string, Vec4>;
	/** Vector properties, used as they are */
	vectors: Record<string, Vec4>;
	/** texture properties and the Unity built-in each defaults to (`white`, `black`, `gray`, `bump`, …) */
	textures: Record<string, string>;
	/** texture properties flagged `[Normal]` (tangent-space normal maps) */
	normalMaps: string[];
}

/** a converted material's values: its overrides of its shader's defaults, slots and render state */
export interface MaterialValues {
	/** index into the shader table */
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
	 * the Lit families' `_BaseTextureMapCount` (`docs/game-data/materials.md#texture-layouts`); `null` for
	 * shaders without the switch
	 */
	baseTextureMapCount: number | null;
	/** bound textures by Unity property name (`_BaseColorMap`, `_NormalMap`, …); empty slots are absent */
	slots: Record<string, TextureSlot>;
	/** overrides of {@link ShaderEntry.floats} */
	floats: Record<string, number>;
	/** overrides of {@link ShaderEntry.colors} */
	colors: Record<string, Vec4>;
	/** overrides of {@link ShaderEntry.vectors} */
	vectors: Record<string, Vec4>;
}

/** a material's properties, resolved against its shader's defaults */
export interface MaterialReader {
	readonly material: MaterialValues;
	shader: ShaderEntry;
	/** whether the material enables a keyword */
	has: (keyword: string) => boolean;
	/** a Float, Range or Int property */
	float: (name: string, fallback: number) => number;
	/** a Color property, as authored */
	color: (name: string) => Vec4 | undefined;
	/** a Vector property */
	vector: (name: string) => Vec4 | undefined;
	/** a Color property, else a Vector of the same name: the effect shaders declare some of each */
	colorOrVector: (name: string) => Vec4 | undefined;
	/** a bound texture, absent when the slot is empty */
	slot: (name: string) => TextureSlot | undefined;
}

/**
 * @param material a converted material
 * @param shader its shader's entry
 * @returns a reader of its properties
 */
export const readerOf = (material: MaterialValues, shader: ShaderEntry): MaterialReader => {
	const color = (name: string): Vec4 | undefined => material.colors[name] ?? shader.colors[name];
	const vector = (name: string): Vec4 | undefined => material.vectors[name] ?? shader.vectors[name];
	return {
		material,
		shader,
		has: (keyword) => material.keywords.includes(keyword),
		float: (name, fallback) => material.floats[name] ?? shader.floats[name] ?? fallback,
		color,
		vector,
		colorOrVector: (name) => color(name) ?? vector(name),
		slot: (name) => material.slots[name],
	};
};

/**
 * @param c an sRGB-encoded channel
 * @returns the linear channel
 */
export const srgbToLinear = (c: number): number => {
	if (c <= 0.04045) {
		return c / 12.92;
	}
	// HDR values: like Unity's `Mathf.GammaToLinearSpace`, a plain 2.2 power past 1
	return c < 1 ? ((c + 0.055) / 1.055) ** 2.4 : c ** 2.2;
};

/**
 * Unity linearizes LDR (non-`[HDR]`) colour properties in linear-space projects
 * (`docs/game-data/materials.md`)
 *
 * @param color a gamma-encoded colour property
 * @returns its RGB, linear
 */
export const linearRgb = (color: Readonly<Vec4>): Rgb => [
	srgbToLinear(color[0]),
	srgbToLinear(color[1]),
	srgbToLinear(color[2]),
];

/** @returns the colour times `k` */
export const scaleRgb = (rgb: Readonly<Rgb> | Readonly<Vec4>, k: number): Rgb => [
	rgb[0] * k,
	rgb[1] * k,
	rgb[2] * k,
];
