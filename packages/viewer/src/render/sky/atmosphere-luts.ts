import { type TgpuBindGroup, type TgpuRenderPipeline, type TgpuRoot, common } from 'typegpu';

import type { AsyncPipeline, PipelineCache } from '../../gfx/pipeline-cache.ts';
import { type TgpuFullscreenPass, encodeTgpuFullscreen } from '../../gfx/tgpu-fullscreen.ts';
import { HDR_FORMAT } from '../frame/render-targets.ts';
import { postUniformLayout } from '../post/post-schema.ts';

import {
	fsMultiScattering,
	fsSkyView,
	fsTransmittance,
	multiScatteringLayout,
	skyViewBuildLayout,
} from './atmosphere-shader.ts';

/** owns the atmosphere's lookup tables (atmosphere-shader.ts) and the passes that build them */
export class AtmosphereLuts {
	/** the sky-view LUT, which sky shaders sample; rebuilt each frame the sky shows */
	readonly skyView: GPUTextureView;
	#textures: GPUTexture[];
	#passes: Record<'transmittance' | 'multiScattering' | 'skyView', TgpuFullscreenPass>;
	/** whether the transmittance and multiple-scattering LUTs hold the current environment */
	#ready = false;

	/**
	 * @param root the TypeGPU root
	 * @param pipelines the pipeline cache
	 * @param postUniforms the post chain's `Post` uniforms, which hold the atmosphere
	 * @param sampler the bilinear clamping sampler the LUTs are read with
	 */
	constructor(root: TgpuRoot, pipelines: PipelineCache, postUniforms: GPUBuffer, sampler: GPUSampler) {
		const lut = (label: string, width: number, height: number): GPUTexture =>
			root.device.createTexture({
				label,
				size: [width, height],
				format: HDR_FORMAT,
				usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
			});
		const transmittance = lut('transmittance lut', 256, 64);
		const multiScattering = lut('multiple scattering lut', 32, 32);
		const skyView = lut('sky view lut', 192, 108);
		this.#textures = [transmittance, multiScattering, skyView];
		const views = {
			transmittance: transmittance.createView(),
			multiScattering: multiScattering.createView(),
			skyView: skyView.createView(),
		};
		this.skyView = views.skyView;
		const postGroup = root.createBindGroup(postUniformLayout, { post: postUniforms });
		const make = (label: string, fragment: typeof fsTransmittance): AsyncPipeline<TgpuRenderPipeline> =>
			pipelines.prepareTgpuRender(label, () =>
				root.createRenderPipeline({
					vertex: common.fullScreenTriangle,
					fragment,
					targets: { format: HDR_FORMAT },
				}),
			);
		const pass = (
			label: string,
			fragment: typeof fsTransmittance,
			target: GPUTextureView,
			groups: readonly TgpuBindGroup[],
		): TgpuFullscreenPass => ({
			label,
			pipeline: make(label, fragment),
			groups,
			target,
		});
		this.#passes = {
			transmittance: pass('transmittance lut', fsTransmittance, views.transmittance, [postGroup]),
			multiScattering: pass('multiple scattering lut', fsMultiScattering, views.multiScattering, [
				postGroup,
				root.createBindGroup(multiScatteringLayout, {
					transmittance: views.transmittance,
					lutSampler: sampler,
				}),
			]),
			skyView: pass('sky view lut', fsSkyView, views.skyView, [
				postGroup,
				root.createBindGroup(skyViewBuildLayout, {
					transmittance: views.transmittance,
					multiScattering: views.multiScattering,
					lutSampler: sampler,
				}),
			]),
		};
	}

	/** @returns bytes of the atmosphere LUT textures */
	get bytes(): number {
		return (256 * 64 + 32 * 32 + 192 * 108) * 8;
	}

	/** rebuilds the LUTs on the next {@link encode}, after the atmosphere changed */
	invalidate(): void {
		this.#ready = false;
	}

	/**
	 * encodes the LUTs that are out of date: the transmittance and multiple scattering once per atmosphere, the
	 * sky view each frame the sky shows (it follows the camera's height and the sun)
	 *
	 * @param encoder this frame's encoder, after the post uniforms are written
	 * @param sky whether the sky shows
	 */
	encode(encoder: GPUCommandEncoder, sky: boolean): void {
		if (!this.#ready) {
			const t = encodeTgpuFullscreen(encoder, this.#passes.transmittance);
			const m = encodeTgpuFullscreen(encoder, this.#passes.multiScattering);
			this.#ready = t && m;
		}
		// the atmosphere fog is analytic; only the sky reads the LUTs
		if (sky) {
			encodeTgpuFullscreen(encoder, this.#passes.skyView);
		}
	}

	/** frees the LUTs */
	destroy(): void {
		for (const texture of this.#textures) {
			texture.destroy();
		}
	}
}
