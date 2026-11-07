/**
 * the mesh draws as data: the ranges a frame's draws are prepared in, the phases that draw a range with one
 * set of pipelines, and the passes that run phases. adding a queue means a row in {@link DRAW_RANGES}, a
 * phase in {@link PHASES} and its pipelines in mesh-pipelines.ts.
 *
 * @module
 */

import type { LookQueue } from '../../looks/look.ts';

/** the draws a phase runs over: those of one look queue */
export type DrawRange = LookQueue;

/** how a range's buckets are sorted (comparators in draw-order.ts) */
export type RangeOrder = 'pipelineThenNearest' | 'bindings' | 'stencilWritesThenBindings';

/** a range's place in the frame's draws */
export interface DrawRangeInfo {
	range: DrawRange;
	order: RangeOrder;
	/**
	 * whether its draws are scene effects, whose material group also binds the main pass's outputs and is built
	 * when their pass encodes
	 */
	effect: boolean;
}

/** every range, in the order the frame's draws are prepared */
export const DRAW_RANGES: readonly DrawRangeInfo[] = [
	// depth-writing draws: early depth testing rewards nearest first
	{ range: 'opaque', order: 'pipelineThenNearest', effect: false },
	{ range: 'cutout', order: 'pipelineThenNearest', effect: false },
	{ range: 'effectOpaque', order: 'bindings', effect: true },
	{ range: 'stencilMask', order: 'bindings', effect: false },
	{ range: 'transparent', order: 'bindings', effect: false },
	// effects that write the stencil first, so the effects testing it see the whole mask
	{ range: 'effect', order: 'stencilWritesThenBindings', effect: true },
	{ range: 'effectDecal', order: 'bindings', effect: true },
	{ range: 'mist', order: 'bindings', effect: true },
	{ range: 'mistVolume', order: 'bindings', effect: true },
	{ range: 'decalRelight', order: 'bindings', effect: true },
	{ range: 'screenMultiply', order: 'bindings', effect: true },
	{ range: 'refract', order: 'bindings', effect: true },
	{ range: 'waterFoam', order: 'bindings', effect: true },
	{ range: 'waterFoamBehind', order: 'bindings', effect: true },
	{ range: 'waterFoamThrough', order: 'bindings', effect: true },
];

/**
 * the vertex streams a phase's pipelines read, in buffer slot order: every stream, positions alone (opaque
 * shadow casters), or positions and the UV sets (alpha-tested ones)
 */
export type VertexStreams = 'all' | 'position' | 'uv';

/** one run over one of a pass's draw ranges, with a pipeline per face culling and UV format */
export interface DrawPhase {
	key: string;
	range: DrawRange;
	/** whether the pipeline reads the material's textures; if not, any material group will do */
	textured: boolean;
	/**
	 * over only the draws whose materials cast shadows, cast-only ones included; otherwise over the draws in
	 * view
	 */
	shadow: boolean;
	streams: VertexStreams;
}

/** a phase that shades a range in view, reading every stream */
const shading = (key: string, range: DrawRange): DrawPhase => ({
	key,
	range,
	textured: true,
	shadow: false,
	streams: 'all',
});

/** every phase, by name */
export const PHASES = {
	/**
	 * the opaque meshes' depth, laid down before the terrain and the shading so each pixel is shaded once: the
	 * opaque phase then shades only where its depth equals this
	 */
	prepass: { key: 'mesh/prepass', range: 'opaque', textured: false, shadow: false, streams: 'position' },
	opaque: shading('mesh/opaque', 'opaque'),
	cutoutDepth: { key: 'mesh/cutout-depth', range: 'cutout', textured: true, shadow: false, streams: 'uv' },
	cutoutShade: shading('mesh/cutout-shade', 'cutout'),
	stencilMask: {
		key: 'mesh/stencil-mask',
		range: 'stencilMask',
		textured: false,
		shadow: false,
		streams: 'position',
	},
	transparent: shading('mesh/transparent', 'transparent'),
	effectOpaque: shading('mesh/effect-opaque', 'effectOpaque'),
	effect: shading('mesh/effect', 'effect'),
	effectDecal: shading('mesh/effect-decal', 'effectDecal'),
	mist: shading('mesh/mist', 'mist'),
	mistVolume: shading('mesh/mist-volume', 'mistVolume'),
	decalRelight: shading('mesh/decal-relight', 'decalRelight'),
	screenMultiply: shading('mesh/effect-multiply', 'screenMultiply'),
	refract: shading('mesh/refract', 'refract'),
	waterFoam: shading('mesh/water-foam', 'waterFoam'),
	waterFoamBehind: shading('mesh/water-foam-behind', 'waterFoamBehind'),
	waterFoamThrough: shading('mesh/water-foam-through', 'waterFoamThrough'),
	shadowOpaque: {
		key: 'mesh/shadow/opaque',
		range: 'opaque',
		textured: false,
		shadow: true,
		streams: 'position',
	},
	shadowCutout: { key: 'mesh/shadow/cutout', range: 'cutout', textured: true, shadow: true, streams: 'uv' },
} as const satisfies Record<string, DrawPhase>;

/** the passes that draw meshes */
export type MeshPass = SurfacePass | EffectPass | 'shadow';

/** passes over the main pass's targets */
export type SurfacePass = 'prepass' | 'main';

/** passes of scene effects, which read the main pass's outputs */
export type EffectPass = 'relight' | 'transparent' | 'multiply' | 'refract' | 'waterFoam';

/** each pass's phases, in the order they draw */
export const PASS_PHASES: Record<MeshPass, readonly DrawPhase[]> = {
	// alpha-tested cut-outs lay down their depth before the terrain too, so it isn't shaded under leaves and grass
	prepass: [PHASES.prepass, PHASES.cutoutDepth],
	// stencil masks after the surfaces they're tested against
	main: [PHASES.opaque, PHASES.cutoutShade, PHASES.effectOpaque, PHASES.stencilMask],
	// lit decals that change only the surface's normal, roughness or occlusion, run between the main and the
	// transparent pass: they add the change in the surface's light to the radiance
	relight: [PHASES.decalRelight],
	transparent: [PHASES.transparent, PHASES.effect, PHASES.effectDecal, PHASES.mist, PHASES.mistVolume],
	// effects that multiply the composited scene, drawn over it
	multiply: [PHASES.screenMultiply],
	// effects that sample a copy of the composited scene, drawn over it after the multiplies
	refract: [PHASES.refract],
	// WaterDecal boxes, drawn into the water's foam before the water draws: those the game depth-tests in front
	// of the scene, then those it tests behind it, then those it doesn't test
	waterFoam: [PHASES.waterFoam, PHASES.waterFoamBehind, PHASES.waterFoamThrough],
	shadow: [PHASES.shadowOpaque, PHASES.shadowCutout],
};

/**
 * the ranges the transparent pass draws: one list sorted far to near across all of them, by each instance's
 * distance, as the game draws its transparent queue (`docs/game-data/materials.md#transparent-draw-order`)
 */
export const SORTED_RANGES: ReadonlySet<DrawRange> = new Set(
	PASS_PHASES.transparent.map(({ range }) => range),
);

/**
 * passes that draw only once another's pipelines are ready too: the shading only shows where the prepass
 * drew, so neither draws until both can
 */
export const PAIRED_PASSES: Partial<Record<MeshPass, MeshPass>> = { prepass: 'main', main: 'prepass' };
