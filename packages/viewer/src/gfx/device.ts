import { definite } from '@mary-ext/array-fns';
import tgpu, { type TgpuRoot } from 'typegpu';

/** optional features, detected on the adapter and requested when present */
export interface GfxFeatures {
	/** BC1–BC7 texture formats, which the package's textures are stored in */
	textureCompressionBc: boolean;
	/** linear filtering of r32float/rg32float/rgba32float textures */
	float32Filterable: boolean;
	/** `firstInstance` ≠ 0 in indirect draw arguments */
	indirectFirstInstance: boolean;
	/** GPU timestamps on passes */
	timestampQuery: boolean;
	/** the `depth32float-stencil8` format, which gives the main pass a stencil buffer */
	depth32floatStencil8: boolean;
	/** clamping depth past the near plane instead of clipping, which lets sun shadows use 16-bit depth */
	depthClipControl: boolean;
	/** `rg11b10ufloat` render targets, halving HDR post-chain VRAM and bandwidth */
	rg11b10ufloatRenderable: boolean;
}

/** a ready device plus what it supports */
export interface GfxDevice {
	device: GPUDevice;
	/** TypeGPU root wrapping {@link device} for typed schemas, bind groups and pipelines */
	root: TgpuRoot;
	features: GfxFeatures;
	/** human-readable adapter description */
	adapterName: string;
	/** swapchain format the platform prefers */
	presentationFormat: GPUTextureFormat;
}

/** thrown when WebGPU is unavailable or the adapter lacks something the viewer needs */
export class GfxUnsupportedError extends Error {
	override name = 'GfxUnsupportedError';
}

/**
 * @param onLost called once if the device is lost (not after `device.destroy()`)
 * @returns the device and its capabilities
 * @throws {GfxUnsupportedError} without WebGPU or a usable adapter
 */
export const createGfxDevice = async (onLost: (reason: string) => void): Promise<GfxDevice> => {
	if (!('gpu' in navigator)) {
		throw new GfxUnsupportedError(`this browser doesn't support WebGPU`);
	}
	const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
	if (adapter === null) {
		throw new GfxUnsupportedError(`no WebGPU adapter is available`);
	}

	const has = (feature: GPUFeatureName): boolean => adapter.features.has(feature);
	const features: GfxFeatures = {
		textureCompressionBc: has('texture-compression-bc'),
		float32Filterable: has('float32-filterable'),
		indirectFirstInstance: has('indirect-first-instance'),
		timestampQuery: has('timestamp-query'),
		depth32floatStencil8: has('depth32float-stencil8'),
		depthClipControl: has('depth-clip-control'),
		rg11b10ufloatRenderable: has('rg11b10ufloat-renderable'),
	};
	const requiredFeatures: GPUFeatureName[] = [];
	if (features.textureCompressionBc) {
		requiredFeatures.push('texture-compression-bc');
	}
	if (features.float32Filterable) {
		requiredFeatures.push('float32-filterable');
	}
	if (features.indirectFirstInstance) {
		requiredFeatures.push('indirect-first-instance');
	}
	if (features.timestampQuery) {
		requiredFeatures.push('timestamp-query');
	}
	if (features.depth32floatStencil8) {
		requiredFeatures.push('depth32float-stencil8');
	}
	if (features.depthClipControl) {
		requiredFeatures.push('depth-clip-control');
	}
	if (features.rg11b10ufloatRenderable) {
		requiredFeatures.push('rg11b10ufloat-renderable');
	}

	const limits = adapter.limits;
	const device = await adapter.requestDevice({
		requiredFeatures,
		requiredLimits: {
			maxBufferSize: limits.maxBufferSize,
			maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
			maxTextureArrayLayers: limits.maxTextureArrayLayers,
			maxStorageBuffersPerShaderStage: limits.maxStorageBuffersPerShaderStage,
			// the effect pipelines bind 19 sampled textures to their fragment stage, over the default 16
			// (docs/viewer/gpu-resources.md), and the G-buffer + mip feedback pass takes 36 bytes/sample
			maxSampledTexturesPerShaderStage: limits.maxSampledTexturesPerShaderStage,
			maxColorAttachmentBytesPerSample: limits.maxColorAttachmentBytesPerSample,
		},
	});
	device.lost
		.then((info) => {
			if (info.reason !== 'destroyed') {
				onLost(info.message);
			}
		})
		.catch(() => {});
	device.addEventListener('uncapturederror', (event) => {
		console.error('webgpu:', event.error.message);
	});

	const info = adapter.info;
	return {
		device,
		root: tgpu.initFromDevice({ device }),
		features,
		adapterName: definite([info.vendor, info.architecture, info.description]).join(' '),
		presentationFormat: navigator.gpu.getPreferredCanvasFormat(),
	};
};
