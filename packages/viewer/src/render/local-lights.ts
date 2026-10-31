/**
 * the package's local point and spot lights, as the game feeds them to its shading: each frame the shown
 * lights within their culling distance and the view are sorted by camera distance and capped at 256, then
 * binned the game's way, into screen tiles of 32 px and view-depth slices of 1 m from the near plane, each a
 * 256-bit mask; a pixel's lights are those in both its tile's mask and its slice's
 * (docs/game-data/lighting.md#local-lights). `frame.wgsl` reads both buffers (`local_lighting`,
 * `local_light_at`).
 *
 * @module
 */

import { type LightEntry, LightKind } from '@endfield-noclip/package-format/lights';

import type { Camera, Vec3 } from '../scene/camera.ts';

/** lights the shading takes per frame, as the game's light list does */
export const MAX_LOCAL_LIGHTS = 256;
/** u32 words per bin mask */
const MASK_WORDS = MAX_LOCAL_LIGHTS / 32;
/** screen tile edge, render px */
export const LIGHT_TILE_SIZE = 32;
/** view-depth slices, 1 m each */
export const LIGHT_SLICES = 2048;
/** vec4s per light in the light buffer */
const LIGHT_VEC4S = 8;
/** tiles the bin buffer holds at most (a 8192 × 4096 render) */
const MAX_TILES = 256 * 128;

/** what the frame uniforms need from this frame's lights */
export interface LocalLightFrame {
	count: number;
	tilesX: number;
	tilesY: number;
}

interface Candidate {
	entry: LightEntry;
	rel: Vec3;
	distance2: number;
	fade: number;
}

/** owns the light and bin buffers and fills them per frame */
export class LocalLights {
	readonly lightBuffer: GPUBuffer;
	readonly binBuffer: GPUBuffer;
	readonly #device: GPUDevice;
	readonly #lightData = new Float32Array(MAX_LOCAL_LIGHTS * LIGHT_VEC4S * 4);
	#bins = new Uint32Array(0);
	#entries: readonly LightEntry[] = [];
	#groupsShown: readonly boolean[] = [];
	/** the entries whose visibility group shows; rebuilt when the groups change */
	#shown: LightEntry[] | null = null;
	readonly #candidates: Candidate[] = [];

	/** @param device the device */
	constructor(device: GPUDevice) {
		this.#device = device;
		this.lightBuffer = device.createBuffer({
			label: 'local lights',
			size: this.#lightData.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		this.binBuffer = device.createBuffer({
			label: 'local light bins',
			size: (MAX_TILES + LIGHT_SLICES) * MASK_WORDS * 4,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
	}

	/** @param lights the package's lights, or none */
	setLights(lights: readonly LightEntry[]): void {
		this.#entries = lights;
		this.#shown = null;
	}

	/** @param shown per visibility group of the package, whether its content shows */
	setGroupsShown(shown: readonly boolean[]): void {
		this.#groupsShown = shown;
		this.#shown = null;
	}

	/**
	 * selects, packs and bins this frame's lights and uploads them
	 *
	 * @param camera the camera (its jitter is ignored: bins are a pixel larger than they need to be)
	 * @param width render width, px
	 * @param height render height, px
	 * @returns the counts the frame uniforms carry
	 */
	prepare(camera: Camera, width: number, height: number): LocalLightFrame {
		const tilesX = Math.min(Math.ceil(width / LIGHT_TILE_SIZE), 256);
		const tilesY = Math.min(Math.ceil(height / LIGHT_TILE_SIZE), 128);
		const frameInfo = { count: 0, tilesX, tilesY };
		const selected = this.#select(camera, width / height);
		if (selected.length === 0) {
			return frameInfo;
		}

		const words = (tilesX * tilesY + LIGHT_SLICES) * MASK_WORDS;
		if (this.#bins.length !== words) {
			this.#bins = new Uint32Array(words);
		} else {
			this.#bins.fill(0);
		}
		const bins = this.#bins;
		const zBase = tilesX * tilesY * MASK_WORDS;
		const right = camera.right();
		const up = camera.up();
		const forward = camera.forward();
		const f = 1 / Math.tan(camera.fovY / 2);
		const aspect = width / height;
		const near = camera.near;

		for (const [i, candidate] of selected.entries()) {
			packLight(this.#lightData, i, candidate);
			const word = i >>> 5;
			const bit = 1 << (i & 31);
			const [center, radius] = boundingSphere(candidate);
			const x = dot(center, right);
			const y = dot(center, up);
			const z = dot(center, forward);

			// depth slices
			const first = Math.max(0, Math.floor(z - radius - near));
			const last = Math.min(LIGHT_SLICES - 1, Math.floor(z + radius - near));
			for (let s = first; s <= last; s++) {
				bins[zBase + s * MASK_WORDS + word] |= bit;
			}

			// screen tiles: the extremes of the sphere's view-space box over its nearest depth, or the whole
			// screen when it reaches the near plane
			let tx0 = 0;
			let tx1 = tilesX - 1;
			let ty0 = 0;
			let ty1 = tilesY - 1;
			const zNear = z - radius;
			if (zNear > near) {
				const sx = f / aspect;
				const xs = [
					ndc(x - radius, zNear, sx),
					ndc(x - radius, z + radius, sx),
					ndc(x + radius, zNear, sx),
					ndc(x + radius, z + radius, sx),
				];
				const ys = [
					ndc(y - radius, zNear, f),
					ndc(y - radius, z + radius, f),
					ndc(y + radius, zNear, f),
					ndc(y + radius, z + radius, f),
				];
				const pxMin = (Math.min(...xs) * 0.5 + 0.5) * width - 1;
				const pxMax = (Math.max(...xs) * 0.5 + 0.5) * width + 1;
				// ndc y up, pixels down
				const pyMin = (0.5 - Math.max(...ys) * 0.5) * height - 1;
				const pyMax = (0.5 - Math.min(...ys) * 0.5) * height + 1;
				tx0 = Math.max(0, Math.floor(pxMin / LIGHT_TILE_SIZE));
				tx1 = Math.min(tilesX - 1, Math.floor(pxMax / LIGHT_TILE_SIZE));
				ty0 = Math.max(0, Math.floor(pyMin / LIGHT_TILE_SIZE));
				ty1 = Math.min(tilesY - 1, Math.floor(pyMax / LIGHT_TILE_SIZE));
			}
			for (let ty = ty0; ty <= ty1; ty++) {
				for (let tx = tx0; tx <= tx1; tx++) {
					bins[(ty * tilesX + tx) * MASK_WORDS + word] |= bit;
				}
			}
		}
		const queue = this.#device.queue;
		queue.writeBuffer(this.lightBuffer, 0, this.#lightData, 0, selected.length * LIGHT_VEC4S * 4);
		queue.writeBuffer(this.binBuffer, 0, bins);
		frameInfo.count = selected.length;
		return frameInfo;
	}

	/** frees the buffers */
	destroy(): void {
		this.lightBuffer.destroy();
		this.binBuffer.destroy();
	}

	/** @returns this frame's lights, nearest first, at most {@link MAX_LOCAL_LIGHTS} */
	#select(camera: Camera, aspect: number): Candidate[] {
		this.#shown ??= this.#entries.filter((entry) => this.#groupsShown[entry.group] ?? false);
		const candidates = this.#candidates;
		candidates.length = 0;
		const eye = camera.position;
		const planes = camera.frustumPlanes(aspect);
		for (const entry of this.#shown) {
			const rel: Vec3 = [entry.position[0] - eye[0], entry.position[1] - eye[1], entry.position[2] - eye[2]];
			const distance2 = dot(rel, rel);
			// the game fades a light out with camera distance, linearly in squared distance
			let fade = 1;
			const distanceFade = entry.distanceFade;
			if (distanceFade !== null) {
				const culling2 = distanceFade.culling ** 2;
				const falloff2 = distanceFade.falloff ** 2;
				if (distance2 >= culling2) {
					continue;
				}
				if (distance2 > falloff2 && culling2 > falloff2) {
					fade = (culling2 - distance2) / (culling2 - falloff2);
				}
			}
			const candidate = { entry, rel, distance2, fade };
			const [center, radius] = boundingSphere(candidate);
			if (planes.some(([nx, ny, nz, d]) => nx * center[0] + ny * center[1] + nz * center[2] + d < -radius)) {
				continue;
			}
			candidates.push(candidate);
		}
		candidates.sort((a, b) => a.distance2 - b.distance2 || a.entry.priority - b.entry.priority);
		if (candidates.length > MAX_LOCAL_LIGHTS) {
			candidates.length = MAX_LOCAL_LIGHTS;
		}
		return candidates;
	}
}

const dot = (a: readonly number[], b: readonly number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** @returns a view-space coordinate's NDC at a view depth, for a projection scale */
const ndc = (value: number, depth: number, scale: number): number => (value * scale) / depth;

/** @returns a camera-relative sphere holding everything the light reaches */
const boundingSphere = ({ entry, rel }: Candidate): [center: Vec3, radius: number] => {
	const range = entry.range;
	if (entry.kind === LightKind.Spot) {
		const cos = Math.cos((entry.spotAngle * Math.PI) / 360);
		// narrow cones fit a sphere around the middle of their axis: its farthest points are the rim of the cap
		if (cos > 0.5) {
			const d = entry.direction;
			const half = range / 2;
			return [
				[rel[0] + d[0] * half, rel[1] + d[1] * half, rel[2] + d[2] * half],
				range * Math.sqrt(1.25 - cos),
			];
		}
		return [rel, range];
	}
	return [rel, range + entry.tubeLength / 2];
};

/**
 * one light's 8 vec4s, the layout `local_light_at` in frame.wgsl reads:
 *
 * - 0: camera-relative position, 1 / range
 * - 1: colour (faded), kind (0 spot, 1 point)
 * - 2: direction, cos(outer / 2)
 * - 3: 1 / (cos(inner / 2) − cos(outer / 2)), tube length, falloff exponent, soft source radius
 * - 4: specular intensity, volumetric intensity, box falloff threshold, 1 with a culling box
 * - 5–7: the box's rows3x4
 */
const packLight = (out: Float32Array, index: number, { entry, rel, fade }: Candidate): void => {
	const at = index * LIGHT_VEC4S * 4;
	const spot = entry.kind === LightKind.Spot;
	const cosOuter = spot ? Math.cos((entry.spotAngle * Math.PI) / 360) : 0;
	const cosInner = spot ? Math.cos((Math.min(entry.innerSpotAngle, entry.spotAngle) * Math.PI) / 360) : 1;
	out[at] = rel[0];
	out[at + 1] = rel[1];
	out[at + 2] = rel[2];
	out[at + 3] = 1 / entry.range;
	out[at + 4] = entry.color[0] * fade;
	out[at + 5] = entry.color[1] * fade;
	out[at + 6] = entry.color[2] * fade;
	out[at + 7] = spot ? 0 : 1;
	out[at + 8] = entry.direction[0];
	out[at + 9] = entry.direction[1];
	out[at + 10] = entry.direction[2];
	out[at + 11] = cosOuter;
	out[at + 12] = 1 / Math.max(cosInner - cosOuter, 1e-4);
	out[at + 13] = entry.tubeLength;
	out[at + 14] = entry.falloffExponent;
	out[at + 15] = entry.softSourceRadius;
	out[at + 16] = entry.specularIntensity;
	out[at + 17] = entry.volumetricScatteringIntensity;
	const box = entry.cullingBox;
	out[at + 18] = box?.falloffThreshold ?? 0;
	out[at + 19] = box === null ? 0 : 1;
	if (box !== null) {
		out.set(box.matrix, at + 20);
	}
};
