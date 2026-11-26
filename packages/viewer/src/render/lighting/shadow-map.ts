import type { Vec3 } from '@endfield-noclip/package-format/values';

import { LINEAR_CLAMP, sampler } from '../../gfx/samplers.ts';
import { cross, dot, normalize } from '../../math/vec3.ts';
import type { Camera } from '../../scene/camera.ts';
import { SHADOW_LAYERS, type ShadowLayerVolumes } from '../../scene/shadow-volumes.ts';
import { SHADOW_FORMAT } from '../core/render-targets.ts';

/** shadow map edge, texels */
const SHADOW_SIZE = 2048;
/**
 * 16-bit depth format used by the sun shadow map when `depth-clip-control` clamps far casters to the near
 * plane
 */
const SUN_SHADOW_FORMAT_16: GPUTextureFormat = 'depth16unorm';
const SUN_SHADOW_FORMAT_32: GPUTextureFormat = 'depth32float';
/** extra depth margin towards the sun when `unclippedDepth` clamps casters past the near plane, m */
const CLAMPED_CASTER_MARGIN = 64;
/** far distance of each layer, m; the first three are the game's cascades (ratios 0.15 and 0.375 of 80 m) */
const SPLITS = [12, 30, 80, 800];
/** the sharp cascades fade into the far layer between these distances, m */
const SHARP_REACH = 80;
const SHARP_FADE_START = 0.8 * SHARP_REACH;
/**
 * each sharp cascade's filter radius is the environment's shadow softness over these distances (the cascades'
 * splits, and as the game computes it, 40 m for the third) in uv of the game's 2 × 2 atlas, so twice that in
 * one layer's uv
 */
const PENUMBRA_SPLITS = [12, 30, 40];
/**
 * the far layer is centred on the camera, its centre snapped to this grid across and along the light, so it
 * keeps its fit (and can keep its casters) until the camera crosses a cell, as the game's cached far map
 * does, m
 */
const FAR_SNAP = 32;
/** the far layer's radius: its reach, plus as far as the camera can be from the snapped centre, m */
const FAR_RADIUS = SPLITS[SHADOW_LAYERS - 1] + FAR_SNAP;
/** how far towards the sun casters are kept beyond the layer's sphere, m */
const CASTER_REACH = 1500;

/** depth state of a shadow pass's pipelines: standard depth, casters biased along their slope against acne */
export const shadowDepthState = (format: GPUTextureFormat): GPUDepthStencilState => ({
	format,
	depthWriteEnabled: true,
	depthCompare: 'less',
	depthBias: format === 'depth16unorm' ? 1 : 0,
	depthBiasSlopeScale: 1.5,
});

/** depth state of the local-light shadow pass's pipelines */
export const SHADOW_DEPTH_STATE: GPUDepthStencilState = shadowDepthState(SHADOW_FORMAT);

/** one layer's matrices (column-major) and bounds */
interface ShadowLayer {
	/** camera-relative position → clip space of the shadow pass */
	render: Float32Array;
	/** camera-relative position → shadow map uv (v down) and depth */
	sample: Float32Array;
	/** bounding sphere: camera-relative centre and radius squared */
	sphere: [number, number, number, number];
	/** the centre along the light's axes in world space and the radius: equal fits hold the same depth */
	fit: Float64Array;
}

/** owns the shadow map and fits its layers */
export class ShadowMap {
	readonly format: GPUTextureFormat;
	/** whether shadow pipelines clamp depth past the near plane (`depth-clip-control`) */
	readonly unclippedDepth: boolean;
	readonly texture: GPUTexture;
	/** sampled view of all layers */
	readonly view: GPUTextureView;
	/** attachment view per layer */
	readonly views: GPUTextureView[];
	/** depth comparison, for the far layer's grid */
	readonly sampler: GPUSampler;
	/** raw depth reads, for the sharp cascades' gathers */
	readonly gatherSampler: GPUSampler;
	readonly layers: ShadowLayer[];
	/** the fitted layers' volumes, updated by {@link fit} */
	readonly volumes: ShadowLayerVolumes = {
		axes: new Float64Array(9),
		layers: new Float64Array(4 * SHADOW_LAYERS),
		reach: CASTER_REACH,
	};
	/** the sharp cascades' reach squared and the reciprocal of their fade span in squared distance */
	readonly fade: readonly [number, number] = [
		SHARP_REACH ** 2,
		1 / (SHARP_REACH ** 2 - SHARP_FADE_START ** 2),
	];
	/**
	 * @param softness the environment's shadow softness (`shadowConfig.csmShadowSoftness`)
	 * @returns each sharp cascade's filter radius, layer uv
	 */
	penumbra(softness: number): number[] {
		return PENUMBRA_SPLITS.map((split) => (2 * softness) / split);
	}

	/**
	 * @param device the device
	 * @param options `depthClipControl` enables 16-bit depth with near-plane clamping
	 */
	constructor(device: GPUDevice, { depthClipControl = false }: { depthClipControl?: boolean } = {}) {
		this.unclippedDepth = depthClipControl;
		this.format = depthClipControl ? SUN_SHADOW_FORMAT_16 : SUN_SHADOW_FORMAT_32;
		this.texture = device.createTexture({
			label: 'shadow map',
			size: [SHADOW_SIZE, SHADOW_SIZE, SHADOW_LAYERS],
			format: this.format,
			usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
		});
		this.view = this.texture.createView({ dimension: '2d-array' });
		this.views = Array.from({ length: SHADOW_LAYERS }, (_, i) =>
			this.texture.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 }),
		);
		this.sampler = sampler(device, { ...LINEAR_CLAMP, compare: 'less-equal' });
		this.gatherSampler = sampler(device, {});
		this.layers = Array.from({ length: SHADOW_LAYERS }, () => ({
			render: new Float32Array(16),
			sample: new Float32Array(16),
			sphere: [0, 0, 0, 0],
			fit: new Float64Array(4),
		}));
	}

	/** @returns bytes of the shadow map */
	get bytes(): number {
		return SHADOW_SIZE * SHADOW_SIZE * (this.format === 'depth16unorm' ? 2 : 4) * SHADOW_LAYERS;
	}

	/**
	 * fits the layers to the camera.
	 *
	 * @param camera the camera
	 * @param aspect viewport width / height
	 * @param towardsSun unit vector towards the sun
	 */
	fit(camera: Camera, aspect: number, towardsSun: Vec3): void {
		const forward = camera.forward();
		const tanY = Math.tan(camera.fovY / 2);
		const tanX = tanY * aspect;
		// the light's frame: z along the light, x and y across it
		const z: Vec3 = [-towardsSun[0], -towardsSun[1], -towardsSun[2]];
		const reference: Vec3 = Math.abs(z[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
		const x = normalize(cross(reference, z));
		const y = cross(z, x);
		const eye = camera.position;
		this.volumes.axes.set([...x, ...y, ...z]);
		let near = camera.near;
		for (let i = 0; i < SHADOW_LAYERS; i++) {
			const far = SPLITS[i];
			const farLayer = i === SHADOW_LAYERS - 1;
			let radius = FAR_RADIUS;
			let world: Vec3 = eye;
			if (!farLayer) {
				// the slice's bounding sphere, centred on the view axis
				const cornerSquared = 1 + tanX * tanX + tanY * tanY;
				let center = (near + far) / 2;
				// move the centre towards the far plane as far as the near corners allow (smallest sphere)
				center = Math.min(far, ((far * far - near * near) * cornerSquared) / (2 * (far - near)) || center);
				const radiusFar = Math.sqrt((far - center) ** 2 + far * far * (cornerSquared - 1));
				const radiusNear = Math.sqrt((center - near) ** 2 + near * near * (cornerSquared - 1));
				radius = Math.ceil(Math.max(radiusFar, radiusNear));
				world = [eye[0] + forward[0] * center, eye[1] + forward[1] * center, eye[2] + forward[2] * center];
			}
			const texel = (2 * radius) / SHADOW_SIZE;
			// snap the centre to whole texels in world space, the far layer's to its grid first
			const snap = (value: number): number => {
				const cell = farLayer ? Math.round(value / FAR_SNAP) * FAR_SNAP : value;
				return Math.round(cell / texel) * texel;
			};
			const sx = snap(dot(world, x));
			const sy = snap(dot(world, y));
			const sz = farLayer ? Math.round(dot(world, z) / FAR_SNAP) * FAR_SNAP : dot(world, z);
			const c: Vec3 = [
				x[0] * sx + y[0] * sy + z[0] * sz - eye[0],
				x[1] * sx + y[1] * sy + z[1] * sz - eye[1],
				x[2] * sx + y[2] * sy + z[2] * sz - eye[2],
			];
			const back = radius + (this.unclippedDepth ? CLAMPED_CASTER_MARGIN : CASTER_REACH);
			const depthRange = back + radius;
			const layer = this.layers[i];
			layer.sphere = [c[0], c[1], c[2], radius * radius];
			layer.fit.set([sx, sy, sz, radius]);
			this.volumes.layers.set([dot(c, x), dot(c, y), dot(c, z), radius], i * 4);
			const m = layer.render;
			// rows: x / r, y / r, (z + back) / range, 1
			const rows = [
				[x[0] / radius, x[1] / radius, x[2] / radius, -dot(c, x) / radius],
				[y[0] / radius, y[1] / radius, y[2] / radius, -dot(c, y) / radius],
				[z[0] / depthRange, z[1] / depthRange, z[2] / depthRange, (back - dot(c, z)) / depthRange],
				[0, 0, 0, 1],
			];
			for (let r = 0; r < 4; r++) {
				for (let k = 0; k < 4; k++) {
					m[k * 4 + r] = rows[r][k];
				}
			}
			const s = layer.sample;
			for (let k = 0; k < 4; k++) {
				s[k * 4] = 0.5 * rows[0][k] + 0.5 * rows[3][k];
				s[k * 4 + 1] = -0.5 * rows[1][k] + 0.5 * rows[3][k];
				s[k * 4 + 2] = rows[2][k];
				s[k * 4 + 3] = rows[3][k];
			}
			near = far;
		}
	}

	/** frees the shadow map */
	destroy(): void {
		this.texture.destroy();
	}
}
