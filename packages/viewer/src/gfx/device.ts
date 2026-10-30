/**
 * WebGPU adapter/device setup: optional features the renderer can use, raised limits, and device loss.
 *
 * @module
 */

/** optional features, detected on the adapter and requested when present */
export interface GfxFeatures {
	/** BC1–BC7 texture formats (needed for the game's BC7/BC5 textures once they stream) */
	textureCompressionBc: boolean;
	/** linear filtering of r32float/rg32float/rgba32float textures */
	float32Filterable: boolean;
	/** `firstInstance` ≠ 0 in indirect draw arguments */
	indirectFirstInstance: boolean;
	/** GPU timestamps on passes */
	timestampQuery: boolean;
}

/** a ready device plus what it supports */
export interface GfxDevice {
	adapter: GPUAdapter;
	device: GPUDevice;
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
 * requests a high-performance adapter and a device with every optional feature we use that the adapter has,
 * and with the buffer/array limits raised to the adapter's maximum.
 *
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

	const limits = adapter.limits;
	const device = await adapter.requestDevice({
		requiredFeatures,
		requiredLimits: {
			maxBufferSize: limits.maxBufferSize,
			maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
			maxTextureArrayLayers: limits.maxTextureArrayLayers,
			maxStorageBuffersPerShaderStage: limits.maxStorageBuffersPerShaderStage,
			// the mesh pipeline samples 17 textures in its fragment stage, one over the default
			maxSampledTexturesPerShaderStage: limits.maxSampledTexturesPerShaderStage,
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
		adapter,
		device,
		features,
		adapterName: [info.vendor, info.architecture, info.description].filter((part) => part !== '').join(' '),
		presentationFormat: navigator.gpu.getPreferredCanvasFormat(),
	};
};
