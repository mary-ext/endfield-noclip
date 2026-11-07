import brdfWgsl from '../frame/brdf.wgsl?raw';
import noiseWgsl from '../shaders/common/noise.wgsl?raw';

import commonWgsl from './post-common.wgsl?raw';

const UNIFORMS_BINDING = '@group(0) @binding(0) var<uniform> post';

/**
 * @param uniformsGroup the bind group the `Post` uniforms sit at
 * @param uniformsBinding their binding in it
 * @returns post-common.wgsl with its uniforms there
 */
export const postCommonSource = (uniformsGroup: number, uniformsBinding = 0): string => {
	if (!commonWgsl.includes(UNIFORMS_BINDING)) {
		throw new Error(`post-common.wgsl no longer declares \`${UNIFORMS_BINDING}\``);
	}
	return commonWgsl.replace(
		UNIFORMS_BINDING,
		`@group(${uniformsGroup}) @binding(${uniformsBinding}) var<uniform> post`,
	);
};

/**
 * @param parts WGSL sources after the shared post ones
 * @returns a post pass's shader source: the shared BRDF terms, the gradient noise and the `Post` uniforms at
 *   group 0, then `parts`
 */
const postShaderSource = (parts: readonly string[]): string =>
	[brdfWgsl, noiseWgsl, postCommonSource(0), ...parts].join('\n');

/**
 * @param device the device
 * @param label the module's label
 * @param parts WGSL sources after the shared post ones
 * @returns the module of {@link postShaderSource}
 */
export const postShaderModule = (
	device: GPUDevice,
	label: string,
	parts: readonly string[],
): GPUShaderModule => device.createShaderModule({ label, code: postShaderSource(parts) });
