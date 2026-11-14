import { ADD, ALPHA_OVER, KEEP, PREMULTIPLIED_OVER } from '../../gfx/blend.ts';
import type { PipelineCache } from '../../gfx/pipeline-cache.ts';
import { SLOTS, Slot } from '../../looks/look.ts';
import type { BindLayouts } from '../frame/bind-layouts.ts';
import { FRAME_WGSL } from '../frame/frame-uniforms.ts';
import {
	DEPTH_COMPARE,
	HDR_FORMAT,
	type MainPassFormat,
	TRANSPARENT_TARGETS,
	WATER_FOAM_FORMAT,
} from '../frame/render-targets.ts';
import { postCommonSource } from '../post/shader-source.ts';
import normalMapWgsl from '../shaders/common/normal-map.wgsl?raw';
import { SHADOW_DEPTH_STATE } from '../shadows/shadow-map.ts';
import { fogSource } from '../sky/fog-source.ts';

import { type DrawPhase, PHASES, type VertexStreams } from './draw-ranges.ts';
import effectWgsl from './effect.wgsl?raw';
import meshWgsl from './mesh.wgsl?raw';
import { type FaceCull, FRONT_FACE, type UvFormat, VARIANTS, pipelineKey } from './pipeline-variants.ts';
import { NORMAL_STREAM, POSITION_STREAM } from './vertex-bindings.ts';

/**
 * the fog transparent draws apply to themselves (fog.wgsl), with its inputs in the draw group (group 2): the
 * post uniforms at binding 2, the froxels at 3 and their sampler at 4
 */
const FOG_WGSL = [
	postCommonSource(2, 2),
	'@group(2) @binding(4) var lut_sampler: sampler;',
	fogSource({ group: 2, binding: 3 }),
].join('\n');

/** a phase's pipeline descriptor for a face culling and UV format */
export type PhaseDescriber = (cull: FaceCull, uvFormat: UvFormat) => GPURenderPipelineDescriptor;

/** what {@link prepareMeshPipelines} sets up */
interface MeshPipelines {
	/** each phase's descriptor by key, from which its stencil variants are derived */
	describers: Map<string, PhaseDescriber>;
	/**
	 * group 3 of the mesh pipelines: the material's texture slots, then the samplers of its base, detail,
	 * parallax and parallax noise slots
	 */
	materialLayout: GPUBindGroupLayout;
	/**
	 * group 3 of the effect pipelines: seven textures, their samplers, the main pass's depth, surfaces and
	 * diffuse ambient, a 3D texture, and the composited scene's copy
	 */
	effectLayout: GPUBindGroupLayout;
}

/** @returns the layout of the mesh pipelines' group 3 */
const createMaterialLayout = (device: GPUDevice): GPUBindGroupLayout => {
	const VERTEX = GPUShaderStage.VERTEX;
	const FRAGMENT = GPUShaderStage.FRAGMENT;
	// the vertex stage samples a vertex offset's texture and its mask in the parallax slots, each with its own
	// sampler (`vertex_offset` in mesh.wgsl); only the mask reads the noise slot's
	const samplers = [FRAGMENT, FRAGMENT, VERTEX | FRAGMENT, VERTEX];
	return device.createBindGroupLayout({
		label: 'mesh materials',
		entries: [
			...SLOTS.map((_, slot): GPUBindGroupLayoutEntry => ({
				binding: slot,
				visibility: slot === Slot.Parallax || slot === Slot.ParallaxNoise ? VERTEX | FRAGMENT : FRAGMENT,
				texture: { sampleType: 'float' },
			})),
			// the samplers of the base, detail, parallax and parallax noise slots
			...samplers.map((visibility, i): GPUBindGroupLayoutEntry => ({
				binding: SLOTS.length + i,
				visibility,
				sampler: { type: 'filtering' },
			})),
		],
	});
};

/** @returns the layout of the effect pipelines' group 3 */
const createEffectLayout = (device: GPUDevice): GPUBindGroupLayout => {
	// the vertex stage samples the vertex offset's texture and its mask, which takes whichever slot the stack
	// leaves free
	const slotStages = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
	return device.createBindGroupLayout({
		label: 'effect materials',
		entries: [
			...SLOTS.map((_, binding) => ({
				binding,
				visibility: slotStages,
				texture: { sampleType: 'float' as const },
			})),
			...SLOTS.map((_, i) => ({
				binding: SLOTS.length + i,
				visibility: slotStages,
				sampler: { type: 'filtering' as const },
			})),
			{ binding: 14, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
			{ binding: 15, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'uint' } },
			{
				binding: 16,
				visibility: GPUShaderStage.FRAGMENT,
				texture: { sampleType: 'unfilterable-float' },
			},
			{ binding: 17, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '3d' } },
			{ binding: 18, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
			{ binding: 19, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
			{ binding: 20, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
		],
	});
};

/** @returns the vertex state of a mesh pipeline reading `streams` with UVs in `uvFormat` */
const meshVertex = (module: GPUShaderModule, uvFormat: UvFormat, streams: VertexStreams): GPUVertexState => {
	const uvStride = uvFormat === 'unorm16x2' ? 4 : 8;
	const position = POSITION_STREAM;
	const uvs: GPUVertexBufferLayout[] = [
		{ arrayStride: uvStride, attributes: [{ shaderLocation: 2, offset: 0, format: uvFormat }] },
		{ arrayStride: uvStride, attributes: [{ shaderLocation: 4, offset: 0, format: uvFormat }] },
	];
	switch (streams) {
		case 'position': {
			return { module, entryPoint: 'vs_depth', buffers: [position] };
		}
		case 'uv': {
			return { module, entryPoint: 'vs_cutout_depth', buffers: [position, ...uvs] };
		}
		case 'all': {
			return {
				module,
				entryPoint: 'vs_main',
				buffers: [
					position,
					NORMAL_STREAM,
					...uvs,
					{ arrayStride: 4, attributes: [{ shaderLocation: 3, offset: 0, format: 'snorm8x4' }] },
					{ arrayStride: 4, attributes: [{ shaderLocation: 5, offset: 0, format: 'unorm8x4' }] },
				],
			};
		}
	}
};

/**
 * starts compiling every mesh phase's pipeline for each face culling and UV format, so streaming compiles
 * nothing; only stencil variants compile on first use
 *
 * @param device the device
 * @param layouts shared layouts
 * @param pipelines the cache to compile into
 * @param format the main pass's targets
 * @returns the phases' descriptors and the mesh and effect material layouts
 */
export const prepareMeshPipelines = (
	device: GPUDevice,
	layouts: BindLayouts,
	pipelines: PipelineCache,
	format: MainPassFormat,
): MeshPipelines => {
	const describers = new Map<string, PhaseDescriber>();
	/** registers a phase's descriptor and compiles its pipeline for every face culling and UV format */
	const describe = ({ key }: DrawPhase, describer: PhaseDescriber): void => {
		describers.set(key, describer);
		for (const { cull, uvFormat } of VARIANTS) {
			void pipelines.prepare(pipelineKey(key, cull, uvFormat), () => describer(cull, uvFormat));
		}
	};

	// #region meshes
	const module = pipelines.module('mesh', [FRAME_WGSL, FOG_WGSL, normalMapWgsl, meshWgsl].join('\n'));
	const materialLayout = createMaterialLayout(device);
	const meshPipelineLayout = device.createPipelineLayout({
		label: 'mesh',
		bindGroupLayouts: [layouts.frame, layouts.instances, layouts.draw, materialLayout],
	});
	/** describes a phase of the mesh shader */
	const describeMesh = (
		phase: DrawPhase,
		stages: Pick<GPURenderPipelineDescriptor, 'fragment' | 'depthStencil'>,
	): void => {
		describe(phase, (cullMode, uvFormat) => ({
			layout: meshPipelineLayout,
			vertex: meshVertex(module, uvFormat, phase.streams),
			primitive: { topology: 'triangle-list', frontFace: FRONT_FACE, cullMode },
			...stages,
		}));
	};
	const depthWrite: GPUDepthStencilState = {
		format: format.depth,
		depthWriteEnabled: true,
		depthCompare: DEPTH_COMPARE,
	};
	const depthTest: GPUDepthStencilState = {
		format: format.depth,
		depthWriteEnabled: false,
		depthCompare: DEPTH_COMPARE,
	};
	const depthEqual: GPUDepthStencilState = {
		format: format.depth,
		depthWriteEnabled: false,
		depthCompare: 'equal',
	};
	const noColor = format.targets.map((target) => ({ ...target, writeMask: 0 }));
	const shade: GPUFragmentState = { module, entryPoint: 'fs_opaque', targets: format.targets };
	const depthOnly: GPUFragmentState = { module, entryPoint: 'fs_depth', targets: noColor };
	describeMesh(PHASES.prepass, { fragment: depthOnly, depthStencil: depthWrite });
	// each mask draws through a stencil variant; this one only completes the phase
	describeMesh(PHASES.stencilMask, { fragment: depthOnly, depthStencil: depthTest });
	describeMesh(PHASES.opaque, { fragment: shade, depthStencil: depthEqual });
	describeMesh(PHASES.cutoutDepth, {
		fragment: { module, entryPoint: 'fs_cutout_depth', targets: noColor },
		depthStencil: depthWrite,
	});
	describeMesh(PHASES.cutoutShade, { fragment: shade, depthStencil: depthEqual });
	describeMesh(PHASES.transparent, {
		fragment: { module, entryPoint: 'fs_transparent', targets: TRANSPARENT_TARGETS },
		depthStencil: depthTest,
	});
	describeMesh(PHASES.shadowOpaque, { depthStencil: SHADOW_DEPTH_STATE });
	describeMesh(PHASES.shadowCutout, {
		fragment: { module, entryPoint: 'fs_cutout_depth', targets: [] },
		depthStencil: SHADOW_DEPTH_STATE,
	});
	// #endregion

	// #region scene effects
	const effectLayout = createEffectLayout(device);
	const effectModule = pipelines.module(
		'mesh-effect',
		[FRAME_WGSL, FOG_WGSL, normalMapWgsl, effectWgsl].join('\n'),
	);
	const effectPipelineLayout = device.createPipelineLayout({
		label: 'effect',
		bindGroupLayouts: [layouts.frame, layouts.instances, layouts.draw, effectLayout],
	});
	/**
	 * describes a phase of the effect shader: its fragment entry point, targets and depth test, if any, which
	 * writes depth only when `writesDepth` is set
	 */
	const describeEffect = (
		phase: DrawPhase,
		entryPoint: string,
		targets: GPUColorTargetState[],
		depthCompare: GPUCompareFunction | null,
		{ writesDepth = false }: { writesDepth?: boolean } = {},
	): void => {
		describe(phase, (cullMode, uvFormat) => {
			const descriptor: GPURenderPipelineDescriptor = {
				layout: effectPipelineLayout,
				vertex: { ...meshVertex(module, uvFormat, 'all'), module: effectModule, entryPoint: 'vs_effect' },
				primitive: { topology: 'triangle-list', frontFace: FRONT_FACE, cullMode },
				fragment: { module: effectModule, entryPoint, targets },
			};
			if (depthCompare !== null) {
				descriptor.depthStencil = { format: format.depth, depthWriteEnabled: writesDepth, depthCompare };
			}
			return descriptor;
		});
	};
	// opaque layers shade into the main pass's targets like a mesh, without a prepass
	describeEffect(PHASES.effectOpaque, 'fs_effect_opaque', format.targets, DEPTH_COMPARE, {
		writesDepth: true,
	});
	describeEffect(PHASES.effect, 'fs_effect', TRANSPARENT_TARGETS, DEPTH_COMPARE);
	// decals find their surface through the depth buffer, so their back faces draw wherever they are
	describeEffect(PHASES.effectDecal, 'fs_effect_decal', TRANSPARENT_TARGETS, 'always');
	describeEffect(PHASES.litDecal, 'fs_effect_decal', TRANSPARENT_TARGETS, 'always');
	describeEffect(PHASES.mist, 'fs_mist_card', TRANSPARENT_TARGETS, DEPTH_COMPARE);
	// fog boxes measure their thickness up to the depth buffer the same way
	describeEffect(PHASES.mistVolume, 'fs_mist_volume', TRANSPARENT_TARGETS, 'always');
	// effects over the composited scene: multiplying it, then blending a refracted copy of it over
	describeEffect(
		PHASES.screenMultiply,
		'fs_effect_multiply',
		[
			{
				format: HDR_FORMAT,
				blend: {
					color: { srcFactor: 'dst', dstFactor: 'zero', operation: 'add' },
					alpha: KEEP,
				},
			},
		],
		DEPTH_COMPARE,
	);
	describeEffect(
		PHASES.refract,
		'fs_refract',
		[
			{
				format: HDR_FORMAT,
				blend: {
					color: ALPHA_OVER,
					alpha: KEEP,
				},
			},
		],
		DEPTH_COMPARE,
	);
	// WaterDecal boxes write the foam colour over the water's own: rgb adds the box's premultiplied colour to
	// what's there times one minus its alpha, and alpha keeps the product of those factors, so the water pass
	// can apply them over its own foam. the main pass's depth, attached read-only, tests them as the game's
	// `_ZTest` does under reversed-Z
	const foam: GPUColorTargetState[] = [
		{
			format: WATER_FOAM_FORMAT,
			blend: {
				color: PREMULTIPLIED_OVER,
				alpha: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha', operation: 'add' },
			},
		},
	];
	describeEffect(PHASES.waterFoam, 'fs_water_foam', foam, 'greater-equal');
	describeEffect(PHASES.waterFoamBehind, 'fs_water_foam', foam, 'less');
	describeEffect(PHASES.waterFoamThrough, 'fs_water_foam', foam, 'always');
	// relit decals add the change in the surface's light to the radiance, leaving its alpha (the albedo's
	// luminance) alone. they read the depth as a texture, so the pass has no depth attachment
	describeEffect(
		PHASES.decalRelight,
		'fs_decal_relight',
		[
			{
				format: HDR_FORMAT,
				blend: {
					color: ADD,
					alpha: KEEP,
				},
				writeMask: GPUColorWrite.RED | GPUColorWrite.GREEN | GPUColorWrite.BLUE,
			},
		],
		null,
	);
	// #endregion

	return { describers, materialLayout, effectLayout };
};
