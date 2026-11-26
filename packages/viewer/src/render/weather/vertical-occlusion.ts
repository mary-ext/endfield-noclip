import type { Vec3 } from '@endfield-noclip/package-format/values';

import { LINEAR_CLAMP, sampler } from '../../gfx/samplers.ts';
import { SHADOW_FORMAT } from '../core/render-targets.ts';

/** vertical occlusion map edge, texels (PC desktop setting: 512²) */
export const VERTICAL_OCCLUSION_SIZE = 512;
/** default half-extent in world XZ, m (`HGRainPresettingAsset.rainOcclusionMapRange`) */
export const DEFAULT_OCCLUSION_RANGE = 100;
/** total vertical span, m (`HGVerticalOcclusionMapManager.OCCLUSION_MAP_HEIGHT`) */
export const VERTICAL_OCCLUSION_HEIGHT = 256;

/**
 * fits the top-down orthographic projection of the vertical occlusion map around `eye`, snapped to whole
 * texels in XZ and 1 m in Y to avoid shimmering as the camera moves
 *
 * @param eye camera world position
 * @param range half-extent in XZ, m
 * @param height full vertical span, m
 * @param size map edge, texels
 * @returns snapped world centre, column-major camera-relative clip matrix, and shader transform vectors
 */
export const fitVerticalOcclusion = (
	eye: Vec3,
	range = DEFAULT_OCCLUSION_RANGE,
	height = VERTICAL_OCCLUSION_HEIGHT,
	size = VERTICAL_OCCLUSION_SIZE,
): {
	snapped: Vec3;
	render: Float32Array;
	/** camera-relative (centerX, topY, centerZ, 1 / (2 · range)) */
	originAndInvSpan: [number, number, number, number];
	/** (1 / height, height, texelWorldSize, range) */
	metrics: [number, number, number, number];
} => {
	const texel = (2 * range) / size;
	const sx = Math.round(eye[0] / texel) * texel;
	const sy = Math.floor(eye[1]);
	const sz = Math.round(eye[2] / texel) * texel;
	const cx = sx - eye[0];
	const cy = sy - eye[1];
	const cz = sz - eye[2];
	const halfHeight = height * 0.5;
	const topRelY = cy + halfHeight;
	// camera-relative ortho looking straight down (-Y):
	//   x_ndc = (x - cx) / range       → u = 0.5 + (x - cx) / (2 * range)
	//   y_ndc = (z - cz) / range       → v = 0.5 - (z - cz) / (2 * range)
	//   z_ndc = (topRelY - y) / height → 0 at top, 1 at bottom
	// basis (+X, +Z, -Y) has determinant +1, matching ShadowMap.fit's front-face winding
	const render = new Float32Array(16);
	render[0] = 1 / range;
	render[6] = -1 / height;
	render[9] = 1 / range;
	render[12] = -cx / range;
	render[13] = -cz / range;
	render[14] = topRelY / height;
	render[15] = 1;
	return {
		snapped: [sx, sy, sz],
		render,
		originAndInvSpan: [cx, topRelY, cz, 1 / (2 * range)],
		metrics: [1 / height, height, texel, range],
	};
};

/**
 * top-down orthographic depth map (`HGVerticalOcclusionMapManager`) used by rain wetness, falling rain, rain
 * splashes, and falling snow to shelter interiors and project splashes/snow onto surfaces
 */
export class VerticalOcclusionMap {
	readonly texture: GPUTexture;
	/** sampled / attachment view */
	readonly view: GPUTextureView;
	/** depth comparison (`less-equal`): 1 when a point is exposed to the sky, 0 when sheltered */
	readonly compareSampler: GPUSampler;
	/** raw depth sampler for height reconstruction in splashes and snow collision */
	readonly rawSampler: GPUSampler;
	/** camera-relative clip matrix for rendering casters into the map */
	readonly render = new Float32Array(16);
	/** camera-relative (centerX, topY, centerZ, 1 / (2 · range)) */
	readonly originAndInvSpan: [number, number, number, number] = [0, 0, 0, 1 / (2 * DEFAULT_OCCLUSION_RANGE)];
	/** (1 / height, height, texelWorldSize, active ? 1 : 0) */
	readonly metrics: [number, number, number, number] = [
		1 / VERTICAL_OCCLUSION_HEIGHT,
		VERTICAL_OCCLUSION_HEIGHT,
		(2 * DEFAULT_OCCLUSION_RANGE) / VERTICAL_OCCLUSION_SIZE,
		0,
	];
	#range = DEFAULT_OCCLUSION_RANGE;
	#snapped: Vec3 = [Number.NaN, Number.NaN, Number.NaN];
	#contentVersion = -1;
	#compiling = false;
	#valid = false;

	/** @param device the device */
	constructor(device: GPUDevice) {
		this.texture = device.createTexture({
			label: 'vertical occlusion map',
			size: [VERTICAL_OCCLUSION_SIZE, VERTICAL_OCCLUSION_SIZE],
			format: SHADOW_FORMAT,
			usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
		});
		this.view = this.texture.createView();
		this.compareSampler = sampler(device, { ...LINEAR_CLAMP, compare: 'less-equal' });
		this.rawSampler = sampler(device, {});
	}

	/** @returns bytes of the vertical occlusion depth texture */
	get bytes(): number {
		return VERTICAL_OCCLUSION_SIZE * VERTICAL_OCCLUSION_SIZE * 4;
	}

	/** @returns whether the depth map holds valid data for the current frame */
	get active(): boolean {
		return this.#valid;
	}

	/**
	 * fits the map to the camera and reports whether it should be redrawn this frame
	 *
	 * @param eye camera world position
	 * @param options weather demand, range, and content/pipeline state
	 * @returns `true` if the depth pass should run this frame
	 */
	update(
		eye: Vec3,
		options: {
			needed: boolean;
			range?: number;
			contentVersion: number;
			compiling: boolean;
		},
	): boolean {
		if (!options.needed) {
			this.#valid = false;
			this.metrics[3] = 0;
			return false;
		}
		const range = options.range !== undefined && options.range > 0 ? options.range : DEFAULT_OCCLUSION_RANGE;
		const fit = fitVerticalOcclusion(eye, range);
		this.render.set(fit.render);
		this.originAndInvSpan[0] = fit.originAndInvSpan[0];
		this.originAndInvSpan[1] = fit.originAndInvSpan[1];
		this.originAndInvSpan[2] = fit.originAndInvSpan[2];
		this.originAndInvSpan[3] = fit.originAndInvSpan[3];
		this.metrics[0] = fit.metrics[0];
		this.metrics[1] = fit.metrics[1];
		this.metrics[2] = fit.metrics[2];
		const moved =
			!this.#valid ||
			range !== this.#range ||
			fit.snapped[0] !== this.#snapped[0] ||
			fit.snapped[1] !== this.#snapped[1] ||
			fit.snapped[2] !== this.#snapped[2];
		const contentChanged = options.contentVersion !== this.#contentVersion;
		const finishedCompiling = this.#compiling && !options.compiling;
		const redraw = moved || contentChanged || finishedCompiling;
		this.#range = range;
		this.#snapped = fit.snapped;
		this.#contentVersion = options.contentVersion;
		this.#compiling = options.compiling;
		this.#valid = true;
		this.metrics[3] = 1;
		return redraw;
	}

	/** forces a redraw on the next active frame (e.g. after a camera cut) */
	reset(): void {
		this.#valid = false;
		this.#snapped = [Number.NaN, Number.NaN, Number.NaN];
		this.metrics[3] = 0;
	}

	/** frees the depth texture */
	destroy(): void {
		this.texture.destroy();
	}
}
