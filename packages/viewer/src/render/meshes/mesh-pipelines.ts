import tgpu from 'typegpu';

import { ADD, ALPHA_OVER, KEEP, PREMULTIPLIED_OVER } from '../../gfx/blend.ts';
import type { PipelineCache } from '../../gfx/pipeline-cache.ts';
import { EFFECT_SLOT_COUNT, type LookStencil, SLOTS, Slot } from '../../looks/look.ts';
import type { BindLayouts } from '../core/bind-layouts.ts';
import {
	DEPTH_COMPARE,
	GBUFFER_A_FORMAT,
	GBUFFER_B_FORMAT,
	GBUFFER_C_FORMAT,
	HDR_FORMAT,
	type MainPassFormat,
	TRANSPARENT_TARGETS,
	WATER_DEPTH_FORMAT,
	WATER_FOAM_FORMAT,
	WETNESS_MASK_FORMAT,
} from '../core/render-targets.ts';
import { SHADOW_DEPTH_STATE, shadowDepthState } from '../lighting/shadow-map.ts';

import { type DrawPhase, PHASES, type VertexStreams } from './draw-ranges.ts';
import { fsDecalGbuffer, fsWetnessDecal } from './effects/decal-gbuffer.ts';
import { fsMistCard, fsMistVolume } from './effects/mist.ts';
import { fsRadialBlur, fsRefract } from './effects/screen.ts';
import { fsEffect, fsEffectDecal, fsEffectMultiply, fsEffectOpaque } from './effects/stack.ts';
import { vsEffect } from './effects/vertex.ts';
import { fsWaterFoam } from './effects/water-foam.ts';
import {
	type FaceCull,
	FRONT_FACE,
	type PositionFormat,
	type UvFormat,
	VARIANTS,
	pipelineKey,
	stencilPipelineKey,
	withStencil,
} from './pipeline-variants.ts';
import { fsOpaqueLit } from './surfaces/lit.ts';
import { fsCutoutOverlay, fsOpaque } from './surfaces/surface.ts';
import { fsTransparent } from './surfaces/transparent.ts';
import {
	fsCutoutDepth,
	fsDepth,
	fsDepthFade,
	vsCutoutDepth,
	vsDepth,
	vsDepthFade,
	vsMain,
} from './surfaces/vertex.ts';
import { NORMAL_STREAM, positionStream } from './vertex-bindings.ts';

/** a phase's pipeline descriptor for a face culling, position format and UV format */
export type PhaseDescriber = (
	cull: FaceCull,
	positionFormat: PositionFormat,
	uvFormat: UvFormat,
) => GPURenderPipelineDescriptor;

/**
 * lazy pipeline store for all mesh and effect phases: compiles only the ~6 hottest Lit/depth/shadow variants
 * up front and compiles every other `(phase, cull, positionFormat, uvFormat, stencil)` on first draw,
 * collapsing UV-format duplicates on position-only phases
 */
export interface MeshPipelines {
	/**
	 * returns the compiled pipeline for a draw's phase and variant, or starts async compilation and returns
	 * `undefined` until ready
	 */
	get(
		phase: DrawPhase,
		variant: number,
		options?: { fade?: boolean; stencil?: LookStencil | null },
	): GPURenderPipeline | undefined;
	/**
	 * group 3 of the mesh pipelines: the material's texture slots, then the samplers of its base, detail,
	 * parallax and parallax noise slots
	 */
	materialLayout: GPUBindGroupLayout;
	/**
	 * group 3 of the effect pipelines: seven textures, their samplers, the main pass's depth, surfaces and
	 * G-buffer A, a 3D texture, and the composited scene's copy
	 */
	effectLayout: GPUBindGroupLayout;
}

/** phases paired with a prepass phase whose depth must match before either draws */
const PAIRED_PREPASS: Partial<Record<string, DrawPhase>> = {
	'mesh/opaque-lit': PHASES.prepassLit,
	'mesh/opaque': PHASES.prepass,
	'mesh/cutout-shade': PHASES.cutoutDepth,
};

/** @returns the layout of the mesh pipelines' group 3 */
const createMaterialLayout = (device: GPUDevice): GPUBindGroupLayout => {
	const VERTEX = GPUShaderStage.VERTEX;
	const FRAGMENT = GPUShaderStage.FRAGMENT;
	// the vertex stage samples a vertex offset's texture and its mask in the parallax slots, each with its own
	// sampler (`vertex_offset` in surfaces/common.ts); only that mask and a dithered look's (`fs_cutout_depth`) read the
	// noise slot's
	const samplers = [FRAGMENT, FRAGMENT, VERTEX | FRAGMENT, VERTEX | FRAGMENT];
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
			...Array.from({ length: EFFECT_SLOT_COUNT }, (_, binding) => ({
				binding,
				visibility: slotStages,
				texture: { sampleType: 'float' as const },
			})),
			...Array.from({ length: EFFECT_SLOT_COUNT }, (_, i) => ({
				binding: EFFECT_SLOT_COUNT + i,
				visibility: slotStages,
				sampler: { type: 'filtering' as const },
			})),
			{ binding: 14, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
			{ binding: 15, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
			{ binding: 16, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
			{ binding: 17, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '3d' } },
			{ binding: 18, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
			{ binding: 19, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
			{ binding: 20, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
			{ binding: 21, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
		],
	});
};

/** @returns the vertex state of a mesh pipeline reading `streams` with `positionFormat` and `uvFormat` */
const meshVertex = (
	module: GPUShaderModule,
	positionFormat: PositionFormat,
	uvFormat: UvFormat,
	streams: VertexStreams,
): GPUVertexState => {
	const uvStride = uvFormat === 'unorm16x2' ? 4 : 8;
	const position = positionStream(positionFormat);
	const uvs: GPUVertexBufferLayout[] = [
		{ arrayStride: uvStride, attributes: [{ shaderLocation: 2, offset: 0, format: uvFormat }] },
		{ arrayStride: uvStride, attributes: [{ shaderLocation: 4, offset: 0, format: uvFormat }] },
	];
	const color: GPUVertexBufferLayout = {
		arrayStride: 4,
		attributes: [{ shaderLocation: 5, offset: 0, format: 'unorm8x4' }],
	};
	switch (streams) {
		case 'position': {
			return { module, entryPoint: 'vsDepth', buffers: [position, color] };
		}
		case 'uv': {
			return { module, entryPoint: 'vsCutoutDepth', buffers: [position, ...uvs, color] };
		}
		case 'all': {
			return {
				module,
				entryPoint: 'vsMain',
				buffers: [
					position,
					NORMAL_STREAM,
					...uvs,
					{ arrayStride: 4, attributes: [{ shaderLocation: 3, offset: 0, format: 'snorm8x4' }] },
					color,
				],
			};
		}
	}
};

/**
 * registers every mesh and effect phase's pipeline descriptor and pre-warms the hottest opaque/shadow
 * variants; all other combinations compile lazily on first draw
 *
 * @param device the device
 * @param layouts shared layouts
 * @param pipelines the cache to compile into
 * @param format the main pass's targets
 * @param shadow sun shadow depth format and clip control
 * @returns the lazy pipeline store and the mesh and effect material layouts
 */
export const prepareMeshPipelines = (
	device: GPUDevice,
	layouts: BindLayouts,
	pipelines: PipelineCache,
	format: MainPassFormat,
	shadow: { format: GPUTextureFormat; unclippedDepth: boolean },
): MeshPipelines => {
	const describers = new Map<string, PhaseDescriber>();
	const positionOnly = new Set<string>();
	/** registers a phase's descriptor; compilation happens lazily in `get()` */
	const describe = (phase: DrawPhase, describer: PhaseDescriber): void => {
		describers.set(phase.key, describer);
		if (phase.streams === 'position') {
			positionOnly.add(phase.key);
		}
	};

	// #region meshes
	// separate modules per family so depth/shadow and G-buffer passes never compile lighting or fog
	const litModule = pipelines.module(
		'mesh-lit',
		tgpu.resolve([
			vsMain,
			vsDepth,
			vsDepthFade,
			vsCutoutDepth,
			fsDepth,
			fsDepthFade,
			fsCutoutDepth,
			fsOpaqueLit,
		]),
	);
	const surfaceModule = pipelines.module('mesh-surface', tgpu.resolve([vsMain, fsOpaque, fsCutoutOverlay]));
	const transparentModule = pipelines.module('mesh-transparent', tgpu.resolve([vsMain, fsTransparent]));
	const materialLayout = createMaterialLayout(device);
	const meshCoreLayout = device.createPipelineLayout({
		label: 'mesh core',
		bindGroupLayouts: [layouts.frameCore, layouts.instances, layouts.draw, materialLayout],
	});
	const meshLightingLayout = device.createPipelineLayout({
		label: 'mesh lighting',
		bindGroupLayouts: [layouts.frame, layouts.instances, layouts.draw, materialLayout],
	});
	/** describes a phase of a mesh shader module */
	const describeMesh = (
		phase: DrawPhase,
		module: GPUShaderModule,
		stages: Pick<GPURenderPipelineDescriptor, 'fragment' | 'depthStencil'>,
		{
			layout = meshCoreLayout,
			unclippedDepth = false,
		}: { layout?: GPUPipelineLayout; unclippedDepth?: boolean } = {},
	): void => {
		describe(phase, (cullMode, positionFormat, uvFormat) => ({
			layout,
			vertex: meshVertex(module, positionFormat, uvFormat, phase.streams),
			primitive: { topology: 'triangle-list', frontFace: FRONT_FACE, cullMode, unclippedDepth },
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
	const depthGreaterEqual: GPUDepthStencilState = {
		format: format.depth,
		depthWriteEnabled: false,
		depthCompare: 'greater-equal',
	};
	const noColor = format.targets.map((target) => ({ ...target, writeMask: 0 }));
	const shade: GPUFragmentState = { module: surfaceModule, entryPoint: 'fsOpaque', targets: format.targets };
	const shadeLit: GPUFragmentState = {
		module: litModule,
		entryPoint: 'fsOpaqueLit',
		targets: format.targets,
	};
	const depthOnly: GPUFragmentState = { module: litModule, entryPoint: 'fsDepth', targets: noColor };
	describeMesh(PHASES.prepass, litModule, { fragment: depthOnly, depthStencil: depthWrite });
	describe({ ...PHASES.prepass, key: 'mesh/prepass-fade' }, (cullMode, positionFormat, uvFormat) => ({
		layout: meshCoreLayout,
		vertex: { ...meshVertex(litModule, positionFormat, uvFormat, 'position'), entryPoint: 'vsDepthFade' },
		primitive: { topology: 'triangle-list', frontFace: FRONT_FACE, cullMode },
		fragment: { module: litModule, entryPoint: 'fsDepthFade', targets: noColor },
		depthStencil: depthWrite,
	}));
	// each mask draws through a stencil variant; this one only completes the phase
	describeMesh(PHASES.stencilMask, litModule, { fragment: depthOnly, depthStencil: depthTest });
	describeMesh(PHASES.opaqueLit, litModule, { fragment: shadeLit, depthStencil: depthEqual });
	describeMesh(PHASES.opaque, surfaceModule, { fragment: shade, depthStencil: depthEqual });
	describeMesh(PHASES.cutoutDepth, litModule, {
		fragment: { module: litModule, entryPoint: 'fsCutoutDepth', targets: noColor },
		depthStencil: depthWrite,
	});
	describeMesh(PHASES.cutoutShade, surfaceModule, { fragment: shade, depthStencil: depthEqual });
	describeMesh(PHASES.cutoutOverlay, surfaceModule, {
		fragment: { module: surfaceModule, entryPoint: 'fsCutoutOverlay', targets: format.targets },
		depthStencil: depthGreaterEqual,
	});
	describeMesh(
		PHASES.transparent,
		transparentModule,
		{
			fragment: { module: transparentModule, entryPoint: 'fsTransparent', targets: TRANSPARENT_TARGETS },
			depthStencil: depthTest,
		},
		{ layout: meshLightingLayout },
	);
	describeMesh(
		PHASES.transparentDepthWrite,
		transparentModule,
		{
			fragment: { module: transparentModule, entryPoint: 'fsTransparent', targets: TRANSPARENT_TARGETS },
			depthStencil: depthWrite,
		},
		{ layout: meshLightingLayout },
	);
	const noTransparentColor = TRANSPARENT_TARGETS.map((target) => ({ ...target, writeMask: 0 }));
	// runs inside the transparent pass, which binds `layouts.frame` at group 0
	describeMesh(
		PHASES.transparentDepthOnly,
		litModule,
		{
			fragment: { module: litModule, entryPoint: 'fsDepth', targets: noTransparentColor },
			depthStencil: depthWrite,
		},
		{ layout: meshLightingLayout },
	);
	const sunShadowDepth = shadowDepthState(shadow.format);
	describeMesh(
		PHASES.shadowOpaque,
		litModule,
		{ depthStencil: sunShadowDepth },
		{ unclippedDepth: shadow.unclippedDepth },
	);
	describeMesh(
		PHASES.shadowCutout,
		litModule,
		{
			fragment: { module: litModule, entryPoint: 'fsCutoutDepth', targets: [] },
			depthStencil: sunShadowDepth,
		},
		{ unclippedDepth: shadow.unclippedDepth },
	);
	describeMesh(PHASES.lightShadowOpaque, litModule, { depthStencil: SHADOW_DEPTH_STATE });
	describeMesh(PHASES.lightShadowCutout, litModule, {
		fragment: { module: litModule, entryPoint: 'fsCutoutDepth', targets: [] },
		depthStencil: SHADOW_DEPTH_STATE,
	});
	// #endregion

	// #region scene effects
	const effectLayout = createEffectLayout(device);
	const effectStackModule = pipelines.module(
		'mesh-effect-stack',
		tgpu.resolve([vsEffect, fsEffectOpaque, fsEffect, fsEffectDecal, fsEffectMultiply]),
	);
	const effectDecalModule = pipelines.module(
		'mesh-effect-decal',
		tgpu.resolve([vsEffect, fsDecalGbuffer, fsWetnessDecal]),
	);
	const effectFoamModule = pipelines.module('mesh-effect-foam', tgpu.resolve([vsEffect, fsWaterFoam]));
	const effectScreenModule = pipelines.module(
		'mesh-effect-screen',
		tgpu.resolve([vsEffect, fsRefract, fsRadialBlur]),
	);
	const effectMistModule = pipelines.module(
		'mesh-effect-mist',
		tgpu.resolve([vsEffect, fsMistCard, fsMistVolume]),
	);
	const effectCoreLayout = device.createPipelineLayout({
		label: 'effect core',
		bindGroupLayouts: [layouts.frameCore, layouts.instances, layouts.draw, effectLayout],
	});
	const effectLightingLayout = device.createPipelineLayout({
		label: 'effect lighting',
		bindGroupLayouts: [layouts.frame, layouts.instances, layouts.draw, effectLayout],
	});
	/**
	 * describes a phase of an effect shader module: its fragment entry point, targets and depth test, if any,
	 * which writes depth only when `writesDepth` is set and tests the main pass's depth unless `depthFormat`
	 * names another
	 */
	const describeEffect = (
		phase: DrawPhase,
		module: GPUShaderModule,
		entryPoint: string,
		targets: GPUColorTargetState[],
		depthCompare: GPUCompareFunction | null,
		{
			layout = effectLightingLayout,
			writesDepth = false,
			depthFormat = format.depth,
		}: { layout?: GPUPipelineLayout; writesDepth?: boolean; depthFormat?: GPUTextureFormat } = {},
	): void => {
		describe(phase, (cullMode, positionFormat, uvFormat) => {
			const descriptor: GPURenderPipelineDescriptor = {
				layout,
				vertex: {
					...meshVertex(module, positionFormat, uvFormat, 'all'),
					entryPoint: 'vsEffect',
				},
				primitive: { topology: 'triangle-list', frontFace: FRONT_FACE, cullMode },
				fragment: { module, entryPoint, targets },
			};
			if (depthCompare !== null) {
				descriptor.depthStencil = { format: depthFormat, depthWriteEnabled: writesDepth, depthCompare };
			}
			return descriptor;
		});
	};
	// opaque layers shade into the main pass's targets like a mesh, without a prepass
	describeEffect(PHASES.effectOpaque, effectStackModule, 'fsEffectOpaque', format.targets, DEPTH_COMPARE, {
		writesDepth: true,
	});
	describeEffect(PHASES.effect, effectStackModule, 'fsEffect', TRANSPARENT_TARGETS, DEPTH_COMPARE);
	// decals find their surface through the depth buffer, so their back faces draw wherever they are
	describeEffect(PHASES.effectDecal, effectStackModule, 'fsEffectDecal', TRANSPARENT_TARGETS, 'always');
	describeEffect(PHASES.mist, effectMistModule, 'fsMistCard', TRANSPARENT_TARGETS, DEPTH_COMPARE);
	// fog boxes measure their thickness up to the depth buffer the same way
	describeEffect(PHASES.mistVolume, effectMistModule, 'fsMistVolume', TRANSPARENT_TARGETS, 'always');
	// effects over the composited scene: multiplying it, then blending a refracted copy of it over
	describeEffect(
		PHASES.screenMultiply,
		effectStackModule,
		'fsEffectMultiply',
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
	const refractBlend: GPUColorTargetState[] = [
		{
			format: HDR_FORMAT,
			blend: {
				color: ALPHA_OVER,
				alpha: KEEP,
			},
		},
	];
	describeEffect(PHASES.refract, effectScreenModule, 'fsRefract', refractBlend, DEPTH_COMPARE, {
		layout: effectCoreLayout,
	});
	describeEffect(PHASES.radialBlur, effectScreenModule, 'fsRadialBlur', refractBlend, DEPTH_COMPARE, {
		layout: effectCoreLayout,
	});
	describeEffect(PHASES.radialBlurThrough, effectScreenModule, 'fsRadialBlur', refractBlend, 'always', {
		layout: effectCoreLayout,
	});
	// under an opaque blend state the refracted colour replaces the scene's whatever its alpha
	describeEffect(
		PHASES.refractOpaque,
		effectScreenModule,
		'fsRefract',
		[
			{
				format: HDR_FORMAT,
				blend: {
					color: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' },
					alpha: KEEP,
				},
			},
		],
		DEPTH_COMPARE,
		{ layout: effectCoreLayout, writesDepth: true },
	);
	// WaterDecal boxes write the foam colour over the water's own: rgb adds the box's premultiplied colour to
	// what's there times one minus its alpha, and alpha keeps the product of those factors, so the water pass
	// can apply them over its own foam. the water's depth, attached read-only, tests them as the game's `_ZTest`
	// does under reversed-Z: the game's buffer is the scene's depth with the water drawn into it, and the boxes
	// draw only over water
	const foam: GPUColorTargetState[] = [
		{
			format: WATER_FOAM_FORMAT,
			blend: {
				color: PREMULTIPLIED_OVER,
				alpha: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha', operation: 'add' },
			},
		},
	];
	const onWater = { layout: effectCoreLayout, depthFormat: WATER_DEPTH_FORMAT };
	describeEffect(PHASES.waterFoam, effectFoamModule, 'fsWaterFoam', foam, 'greater-equal', onWater);
	describeEffect(PHASES.waterFoamBehind, effectFoamModule, 'fsWaterFoam', foam, 'less', onWater);
	describeEffect(PHASES.waterFoamThrough, effectFoamModule, 'fsWaterFoam', foam, 'always', onWater);
	// `HGRP/DecalLit` boxes blend directly into the G-buffer (emission, gbufferA, gbufferB, gbufferC) before
	// deferred lighting. they read scene depth and copies of gbufferA/B as textures, so the pass has no depth
	// attachment:
	// - emission: additive rgb (alpha kept)
	// - gbufferA / gbufferB: shader blends against copies in 3D/linear space and replaces rgb (alpha kept so
	//   shading model and decal-reject flags stay intact)
	// - gbufferC: premultiplied over (handles both normal albedo alpha-blend and `_BLEND_WETNESS` darkening
	//   without copying gbufferC), alpha kept
	const decalEmission: GPUColorTargetState = {
		format: HDR_FORMAT,
		blend: { color: ADD, alpha: KEEP },
		writeMask: GPUColorWrite.RED | GPUColorWrite.GREEN | GPUColorWrite.BLUE,
	};
	const decalGBufferA: GPUColorTargetState = {
		format: GBUFFER_A_FORMAT,
		writeMask: GPUColorWrite.RED | GPUColorWrite.GREEN | GPUColorWrite.BLUE,
	};
	const decalGBufferB: GPUColorTargetState = {
		format: GBUFFER_B_FORMAT,
		writeMask: GPUColorWrite.RED | GPUColorWrite.GREEN | GPUColorWrite.BLUE,
	};
	const decalGBufferC: GPUColorTargetState = {
		format: GBUFFER_C_FORMAT,
		blend: { color: PREMULTIPLIED_OVER, alpha: KEEP },
		writeMask: GPUColorWrite.RED | GPUColorWrite.GREEN | GPUColorWrite.BLUE,
	};
	describeEffect(
		PHASES.litDecal,
		effectDecalModule,
		'fsDecalGbuffer',
		[decalEmission, decalGBufferA, decalGBufferB, decalGBufferC],
		null,
		{ layout: effectCoreLayout },
	);
	// `HGRP/WetnessDecal` boxes write max-blended wetness into `wetnessMask` (`rg8unorm`), so overlapping
	// boxes never double-wet and deferred lighting applies wetness once using per-material porosity
	const maxBlend: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one', operation: 'max' };
	describeEffect(
		PHASES.wetnessDecal,
		effectDecalModule,
		'fsWetnessDecal',
		[{ format: WETNESS_MASK_FORMAT, blend: { color: maxBlend, alpha: maxBlend } }],
		null,
		{ layout: effectCoreLayout },
	);
	// #endregion

	const resolve = (
		phaseKey: string,
		variant: number,
		stencil: LookStencil | null,
	): GPURenderPipeline | undefined => {
		const { cull, positionFormat, uvFormat } = VARIANTS[variant];
		// position-only phases ignore UV format, halving their compiled pipeline variants
		const effectiveUv: UvFormat = positionOnly.has(phaseKey) ? 'unorm16x2' : uvFormat;
		const baseKey = pipelineKey(phaseKey, cull, positionFormat, effectiveUv);
		const key = stencil === null ? baseKey : stencilPipelineKey(baseKey, stencil);
		const ready = pipelines.get(key);
		if (ready !== undefined) {
			return ready;
		}
		const describer = describers.get(phaseKey);
		if (describer === undefined) {
			throw new Error(`phase ${phaseKey} has no pipeline descriptor`);
		}
		void pipelines.prepare(key, () => {
			const desc = describer(cull, positionFormat, effectiveUv);
			return stencil === null ? desc : withStencil(desc, stencil);
		});
		return undefined;
	};

	// pre-warm the hottest variants (~90% of meshes: back-culled unorm16x4 + unorm16x2)
	const HOT_VARIANT = VARIANTS.findIndex(
		({ cull, positionFormat, uvFormat }) =>
			cull === 'back' && positionFormat === 'unorm16x4' && uvFormat === 'unorm16x2',
	);
	for (const phase of [
		PHASES.prepass,
		PHASES.opaqueLit,
		PHASES.opaque,
		PHASES.cutoutDepth,
		PHASES.cutoutShade,
		PHASES.shadowOpaque,
	]) {
		resolve(phase.key, HOT_VARIANT, null);
	}

	const get: MeshPipelines['get'] = (phase, variant, { fade = false, stencil = null } = {}) => {
		const phaseKey = fade && phase.key === 'mesh/prepass' ? 'mesh/prepass-fade' : phase.key;
		const pipeline = resolve(phaseKey, variant, stencil);
		// depth-equal shading requires its paired prepass pipeline to be ready too
		const paired = PAIRED_PREPASS[phaseKey];
		if (paired !== undefined) {
			const prepassKey = fade && paired.key === 'mesh/prepass' ? 'mesh/prepass-fade' : paired.key;
			if (resolve(prepassKey, variant, null) === undefined) {
				return undefined;
			}
		}
		return pipeline;
	};

	return { get, materialLayout, effectLayout };
};
