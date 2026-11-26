/**
 * the pipeline variants of a mesh phase: one per face culling and UV format, compiled up front, and one per
 * stencil state, compiled on first use
 *
 * @module
 */

import { product } from '@mary-ext/array-fns';

import type { LookStencil } from '../../looks/look.ts';

import type { MeshBucket } from './mesh-buckets.ts';

/** the face culling a draw's pipeline uses; each phase has a pipeline per value */
export const FACE_CULLS = ['none', 'back', 'front'] as const satisfies readonly GPUCullMode[];
export type FaceCull = (typeof FACE_CULLS)[number];

/**
 * the winding of front faces of unmirrored instances, as the game's meshes reach the rasterizer through
 * `view_proj` (Unity's left-handed, clockwise-front convention, like the terrain's)
 */
export const FRONT_FACE: GPUFrontFace = 'cw';

/** the vertex formats of positions: dequantized 16-bit for small/animated meshes, else float32 */
export const POSITION_FORMATS = ['unorm16x4', 'float32x4'] as const;
export type PositionFormat = (typeof POSITION_FORMATS)[number];

/** the vertex formats of UV sets 0 and 1: as the package stores 16-bit UVs, else dequantized floats */
export const UV_FORMATS = ['unorm16x2', 'float32x2'] as const;
export type UvFormat = (typeof UV_FORMATS)[number];

/** @returns the cache key of a phase's pipeline for a face culling, position format and UV format */
export const pipelineKey = (
	phase: string,
	cull: FaceCull,
	positionFormat: PositionFormat,
	uvFormat: UvFormat,
): string => `${phase}/${cull}/${positionFormat}/${uvFormat}`;

/** every face culling, position format and UV format a phase has a pipeline for, by {@link variantOf} */
export const VARIANTS: readonly { cull: FaceCull; positionFormat: PositionFormat; uvFormat: UvFormat }[] =
	FACE_CULLS.flatMap((cull) =>
		product(POSITION_FORMATS, UV_FORMATS).map(([positionFormat, uvFormat]) => ({
			cull,
			positionFormat,
			uvFormat,
		})),
	);

/** @returns index of `cull` in {@link FACE_CULLS} */
export const faceCullIndex = (cull: FaceCull): number => {
	switch (cull) {
		case 'none': {
			return 0;
		}
		case 'back': {
			return 1;
		}
		case 'front': {
			return 2;
		}
	}
};

/** @returns index of `positionFormat` in {@link POSITION_FORMATS} */
export const positionFormatIndex = (positionFormat: PositionFormat): number =>
	positionFormat === 'unorm16x4' ? 0 : 1;

/** @returns index of `uvFormat` in {@link UV_FORMATS} */
export const uvFormatIndex = (uvFormat: UvFormat): number => (uvFormat === 'unorm16x2' ? 0 : 1);

/** @returns the index of a face culling, position format and UV format in {@link VARIANTS} */
export const variantOf = (cull: FaceCull, positionFormat: PositionFormat, uvFormat: UvFormat): number =>
	(faceCullIndex(cull) * POSITION_FORMATS.length + positionFormatIndex(positionFormat)) * UV_FORMATS.length +
	uvFormatIndex(uvFormat);

/** @returns the cache keys of a phase's pipelines, by {@link variantOf} */
export const variantKeys = (phase: string): string[] =>
	VARIANTS.map(({ cull, positionFormat, uvFormat }) => pipelineKey(phase, cull, positionFormat, uvFormat));

/** @returns the faces a bucket's draws cull: the material's, swapped for mirrored instances */
export const faceCullOf = (bucket: MeshBucket): FaceCull => {
	switch (bucket.look.cull) {
		case 'none': {
			return 'none';
		}
		case 'back': {
			return bucket.mirrored ? 'front' : 'back';
		}
		case 'front': {
			return bucket.mirrored ? 'back' : 'front';
		}
	}
};

/** @returns the position format of a bucket's geometry */
export const positionFormatOf = (bucket: MeshBucket): PositionFormat => {
	const resident = bucket.geometry.resident;
	return resident?.kind === 'geometry' ? resident.positionFormat : 'unorm16x4';
};

/** @returns the UV format of a bucket's geometry */
export const uvFormatOf = (bucket: MeshBucket): UvFormat => {
	const resident = bucket.geometry.resident;
	return resident?.kind === 'geometry' ? resident.uvFormat : 'float32x2';
};

/** @returns the cache key of a phase's pipeline variant for a stencil state */
export const stencilPipelineKey = (base: string, stencil: LookStencil): string =>
	`${base}/stencil:${stencil.compare}:${stencil.replace ? 'replace' : 'keep'}:${stencil.readMask}:${stencil.writeMask}:${stencil.depthCompare}`;

/**
 * @returns a pipeline descriptor with a stencil state's stencil and depth tests in place of its own
 * @throws {Error} if the descriptor has no depth-stencil state
 */
export const withStencil = (
	descriptor: GPURenderPipelineDescriptor,
	stencil: LookStencil,
): GPURenderPipelineDescriptor => {
	const depthStencil = descriptor.depthStencil;
	if (depthStencil === undefined) {
		throw new Error(`a stencil variant of ${descriptor.label} needs a depth-stencil state`);
	}
	const face: GPUStencilFaceState = {
		compare: stencil.compare,
		passOp: stencil.replace ? 'replace' : 'keep',
		failOp: 'keep',
		depthFailOp: 'keep',
	};
	return {
		...descriptor,
		depthStencil: {
			...depthStencil,
			depthCompare: stencil.depthCompare,
			stencilFront: face,
			stencilBack: face,
			stencilReadMask: stencil.readMask,
			stencilWriteMask: stencil.writeMask,
		},
	};
};
