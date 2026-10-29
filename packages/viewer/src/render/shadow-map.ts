/**
 * sun shadows in the game's PC high layout: three sharp cascades out to 80 m, fading into one coarse far
 * layer out to 800 m that stands in for the game's cached shadow map there. each layer is an orthographic
 * view along the sunlight fitted to a slice of the camera frustum (a bounding sphere, so the fit doesn't
 * change as the camera turns) and snapped to whole texels in world space, so shadow edges don't crawl as the
 * camera moves. matrices are camera-relative like everything else.
 *
 * casters are what the main pass draws this frame, so geometry outside the view doesn't cast yet.
 *
 * @module
 */

import type { Camera, Vec3 } from '../scene/camera.ts';

/** shadow map edge, texels */
export const SHADOW_SIZE = 2048;
export const SHADOW_FORMAT: GPUTextureFormat = 'depth32float';
/** depth layers: the sharp cascades, then the far layer */
export const SHADOW_LAYERS = 4;
/** far distance of each layer, m; the first three are the game's cascades (ratios 0.15 and 0.375 of 80 m) */
const SPLITS = [12, 30, 80, 800];
/** the sharp cascades fade into the far layer between these distances, m */
const SHARP_REACH = 80;
const SHARP_FADE_START = 0.8 * SHARP_REACH;
/**
 * the shadow's softness, the game's `shadowConfig.csmShadowSoftness`: each sharp cascade's filter radius is
 * it over the cascade's split distance (12, 30 m and, as the game computes it, 40 m for the third) in uv of
 * the game's 2 × 2 atlas, so twice that in one layer's uv
 */
const SOFTNESS = 0.01;
const PENUMBRA_SPLITS = [12, 30, 40];
/** how far towards the sun casters are kept beyond the layer's sphere, m */
const CASTER_REACH = 1500;

/** depth state of the shadow pass's pipelines: standard depth, biased along the slope against acne */
export const SHADOW_DEPTH_STATE: GPUDepthStencilState = {
	format: SHADOW_FORMAT,
	depthWriteEnabled: true,
	depthCompare: 'less',
	depthBiasSlopeScale: 1.5,
};

/** one layer's matrices (column-major) and bounds */
export interface ShadowLayer {
	/** camera-relative position → clip space of the shadow pass */
	render: Float32Array;
	/** camera-relative position → shadow map uv (v down) and depth */
	sample: Float32Array;
	/** bounding sphere: camera-relative centre and radius squared */
	sphere: [number, number, number, number];
}

const dot = (a: readonly number[], b: readonly number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const normalize = (v: Vec3): Vec3 => {
	const length = Math.hypot(v[0], v[1], v[2]) || 1;
	return [v[0] / length, v[1] / length, v[2] / length];
};

const cross = (a: Vec3, b: Vec3): Vec3 => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0],
];

/** owns the shadow map and fits its layers */
export class ShadowMap {
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
	/** the sharp cascades' reach squared and the reciprocal of their fade span in squared distance */
	readonly fade: readonly [number, number] = [
		SHARP_REACH ** 2,
		1 / (SHARP_REACH ** 2 - SHARP_FADE_START ** 2),
	];
	/** each sharp cascade's filter radius, layer uv */
	readonly penumbra: readonly number[] = PENUMBRA_SPLITS.map((split) => (2 * SOFTNESS) / split);

	/** @param device the device */
	constructor(device: GPUDevice) {
		this.texture = device.createTexture({
			label: 'shadow map',
			size: [SHADOW_SIZE, SHADOW_SIZE, SHADOW_LAYERS],
			format: SHADOW_FORMAT,
			usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
		});
		this.view = this.texture.createView({ dimension: '2d-array' });
		this.views = Array.from({ length: SHADOW_LAYERS }, (_, i) =>
			this.texture.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 }),
		);
		this.sampler = device.createSampler({
			label: 'shadow comparison',
			compare: 'less-equal',
			magFilter: 'linear',
			minFilter: 'linear',
			addressModeU: 'clamp-to-edge',
			addressModeV: 'clamp-to-edge',
		});
		this.gatherSampler = device.createSampler({
			label: 'shadow gather',
			addressModeU: 'clamp-to-edge',
			addressModeV: 'clamp-to-edge',
		});
		this.layers = Array.from({ length: SHADOW_LAYERS }, () => ({
			render: new Float32Array(16),
			sample: new Float32Array(16),
			sphere: [0, 0, 0, 0],
		}));
	}

	/** @returns bytes of the shadow map */
	get bytes(): number {
		return SHADOW_SIZE * SHADOW_SIZE * 4 * SHADOW_LAYERS;
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
		let near = camera.near;
		for (let i = 0; i < SHADOW_LAYERS; i++) {
			const far = SPLITS[i];
			// the slice's bounding sphere, centred on the view axis
			const cornerSquared = 1 + tanX * tanX + tanY * tanY;
			let centre = (near + far) / 2;
			// move the centre towards the far plane as far as the near corners allow (smallest sphere)
			centre = Math.min(far, ((far * far - near * near) * cornerSquared) / (2 * (far - near)) || centre);
			const radiusFar = Math.sqrt((far - centre) ** 2 + far * far * (cornerSquared - 1));
			const radiusNear = Math.sqrt((centre - near) ** 2 + near * near * (cornerSquared - 1));
			const radius = Math.ceil(Math.max(radiusFar, radiusNear));
			const texel = (2 * radius) / SHADOW_SIZE;
			// snap the centre to whole texels in world space
			const world: Vec3 = [
				eye[0] + forward[0] * centre,
				eye[1] + forward[1] * centre,
				eye[2] + forward[2] * centre,
			];
			const sx = Math.round(dot(world, x) / texel) * texel;
			const sy = Math.round(dot(world, y) / texel) * texel;
			const sz = dot(world, z);
			// back to camera-relative coordinates
			const c: Vec3 = [
				x[0] * sx + y[0] * sy + z[0] * sz - eye[0],
				x[1] * sx + y[1] * sy + z[1] * sz - eye[1],
				x[2] * sx + y[2] * sy + z[2] * sz - eye[2],
			];
			const back = radius + CASTER_REACH;
			const depthRange = back + radius;
			const layer = this.layers[i];
			layer.sphere = [c[0], c[1], c[2], radius * radius];
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
