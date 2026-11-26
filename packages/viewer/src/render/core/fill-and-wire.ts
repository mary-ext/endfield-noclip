/**
 * main-pass pipelines that draw a family's surfaces filled, or their edges as a wireframe over what's drawn
 *
 * @module
 */

import { DEPTH_COMPARE, type MainPassFormat } from './render-targets.ts';

/** the stages of a filled or wireframe pipeline: its layout and shader entry points */
type FillOrWireStages = Pick<GPURenderPipelineDescriptor, 'layout' | 'vertex' | 'fragment'>;

/**
 * @param format the main pass's targets
 * @param stages the pipeline's layout and shaders
 * @param primitive how triangles are wound and culled
 * @returns a pipeline over triangles that writes and tests the main pass's depth
 */
export const describeFill = (
	format: MainPassFormat,
	stages: FillOrWireStages,
	primitive: Pick<GPUPrimitiveState, 'frontFace' | 'cullMode'>,
): GPURenderPipelineDescriptor => ({
	...stages,
	primitive: { topology: 'triangle-list', ...primitive },
	depthStencil: { format: format.depth, depthWriteEnabled: true, depthCompare: DEPTH_COMPARE },
});

/**
 * @param format the main pass's targets
 * @param stages the pipeline's layout and shaders
 * @returns a pipeline over lines that shows them on the surfaces they lie on and in front of the rest,
 *   without writing depth
 */
export const describeWire = (
	format: MainPassFormat,
	stages: FillOrWireStages,
): GPURenderPipelineDescriptor => ({
	...stages,
	primitive: { topology: 'line-list' },
	depthStencil: { format: format.depth, depthWriteEnabled: false, depthCompare: 'greater-equal' },
});
