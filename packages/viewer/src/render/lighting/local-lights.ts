import { type LightEntry, LightKind } from '@endfield-noclip/package-format/lights';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import { dot } from '../../math/vec3.ts';
import type { Camera, Plane } from '../../scene/camera.ts';
import { wgslConst } from '../shaders/wgsl-const.ts';

import { LightShadows } from './light-shadows.ts';
import { MAX_SHADOW_RECORDS, SHADOW_RECORD_VEC4S, type ShadowFrame } from './shadow-tiles.ts';

/** lights the shading takes per frame, as the game's light list does */
const MAX_LOCAL_LIGHTS = 256;
/** u32 words per bin mask */
const MASK_WORDS = MAX_LOCAL_LIGHTS / 32;
/** screen tile edge, render px */
const LIGHT_TILE_SIZE = 32;
/** view-depth slices, 1 m each */
const LIGHT_SLICES = 2048;
/** vec4s per light in the light buffer */
const LIGHT_VEC4S = 9;
/** where the shadow records start in the light buffer, vec4s */
const SHADOW_RECORDS_AT = MAX_LOCAL_LIGHTS * LIGHT_VEC4S;
/** tiles the bin buffer holds at most (a 8192 × 4096 render) */
const MAX_TILES = 256 * 128;

/** the light and bin buffers' layout, as the constants `local_lighting` in frame.wgsl reads */
export const LOCAL_LIGHTS_WGSL = [
	wgslConst('LIGHT_TILE_SIZE', 'f32', LIGHT_TILE_SIZE),
	wgslConst('LIGHT_SLICES', 'f32', LIGHT_SLICES),
	wgslConst('LIGHT_MASK_WORDS', 'u32', MASK_WORDS),
	wgslConst('LIGHT_VEC4S', 'u32', LIGHT_VEC4S),
	wgslConst('LIGHT_SHADOW_RECORDS', 'u32', SHADOW_RECORDS_AT),
	wgslConst('LIGHT_SHADOW_VEC4S', 'u32', SHADOW_RECORD_VEC4S),
].join('\n');

/** what the frame uniforms need from this frame's lights */
export interface LocalLightFrame {
	count: number;
	tilesX: number;
	tilesY: number;
}

/** a shown light within its culling distance and in the view, reused across frames */
interface Candidate {
	entry: LightEntry;
	/** the light's camera-relative position */
	rel: Vec3;
	distance2: number;
	fade: number;
	/** a camera-relative sphere holding everything the light reaches */
	center: Vec3;
	radius: number;
}

/** owns the light and bin buffers and fills them per frame */
export class LocalLights {
	readonly lightBuffer: GPUBuffer;
	readonly binBuffer: GPUBuffer;
	/** the lights' shadow maps, whose records follow the lights in {@link lightBuffer} */
	readonly shadows: LightShadows;
	readonly #device: GPUDevice;
	readonly #lightData = new Float32Array((SHADOW_RECORDS_AT + MAX_SHADOW_RECORDS * SHADOW_RECORD_VEC4S) * 4);
	/** whether the last prepared frame could draw shadow tiles */
	#shadowsEnabled = false;
	/** the streamed content's version at the last prepared frame */
	#contentVersion = -1;
	#bins = new Uint32Array(0);
	#entries: readonly LightEntry[] = [];
	#groupsShown: readonly boolean[] = [];
	/** the entries whose visibility group shows; rebuilt when the groups change */
	#shown: LightEntry[] | null = null;
	/** this frame's candidates, nearest first; their objects come from {@link #pool} */
	readonly #candidates: Candidate[] = [];
	readonly #pool: Candidate[] = [];
	readonly #planes: Plane[] = [];
	readonly #frame: LocalLightFrame = { count: 0, tilesX: 1, tilesY: 1 };
	/**
	 * what the uploaded lights and bins were computed for: eye, yaw, pitch, fovY, near, width and height. `NaN`
	 * until the first upload and after the lights or groups change, so it never matches then
	 */
	readonly #view = new Float64Array(9).fill(Number.NaN);

	/** @param device the device */
	constructor(device: GPUDevice) {
		this.#device = device;
		this.shadows = new LightShadows(device);
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
		this.#view.fill(Number.NaN);
		this.shadows.reset();
	}

	/** @param shown per visibility group of the package, whether its content shows */
	setGroupsShown(shown: readonly boolean[]): void {
		this.#groupsShown = shown;
		this.#shown = null;
		this.#view.fill(Number.NaN);
		// what shows changed, and with it what casts
		this.shadows.reset();
	}

	/**
	 * selects, packs and bins this frame's lights and uploads them, unless they were last prepared for the same
	 * view, lights and groups and no shadow tile waits to be drawn. picks the shadow tile the frame draws
	 * ({@link LightShadows.request}). call before writing the frame uniforms.
	 *
	 * @param camera the camera (its jitter is ignored: bins are a pixel larger than they need to be)
	 * @param width render width, px
	 * @param height render height, px
	 * @param shadowFrame what the shadow tiles are scheduled by
	 * @returns the counts the frame uniforms carry; the object is reused by the next call
	 */
	prepare(
		camera: Camera,
		width: number,
		height: number,
		shadowFrame: ShadowFrame,
	): Readonly<LocalLightFrame> {
		const frameInfo = this.#frame;
		const shadows = this.shadows;
		const moved = this.#viewChanged(camera, width, height);
		if (
			!moved &&
			!shadows.pending &&
			shadows.request === null &&
			shadowFrame.enabled === this.#shadowsEnabled &&
			shadowFrame.contentVersion === this.#contentVersion
		) {
			return frameInfo;
		}
		this.#shadowsEnabled = shadowFrame.enabled;
		this.#contentVersion = shadowFrame.contentVersion;
		const tilesX = Math.min(Math.ceil(width / LIGHT_TILE_SIZE), 256);
		const tilesY = Math.min(Math.ceil(height / LIGHT_TILE_SIZE), 128);
		frameInfo.count = 0;
		frameInfo.tilesX = tilesX;
		frameInfo.tilesY = tilesY;
		const selected = this.#select(camera, width / height);
		shadows.update(selected, shadowFrame);
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

		let records = 0;
		for (const [i, candidate] of selected.entries()) {
			packLight(this.#lightData, i, candidate);
			// its shadow records, once a tile of its is drawn
			const shadowAt = (i * LIGHT_VEC4S + 8) * 4;
			const written =
				candidate.entry.shadow === null
					? 0
					: shadows.writeRecords(
							this.#lightData,
							(SHADOW_RECORDS_AT + records * SHADOW_RECORD_VEC4S) * 4,
							candidate,
						);
			this.#lightData[shadowAt] = written === 0 ? -1 : records;
			this.#lightData[shadowAt + 1] =
				written === 0 ? 0 : shadows.strength(candidate.entry, candidate.distance2);
			records += written;
			const word = i >>> 5;
			const bit = 1 << (i & 31);
			const { center, radius } = candidate;
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
				const zFar = z + radius;
				const x0 = ndc(x - radius, zNear, sx);
				const x1 = ndc(x - radius, zFar, sx);
				const x2 = ndc(x + radius, zNear, sx);
				const x3 = ndc(x + radius, zFar, sx);
				const y0 = ndc(y - radius, zNear, f);
				const y1 = ndc(y - radius, zFar, f);
				const y2 = ndc(y + radius, zNear, f);
				const y3 = ndc(y + radius, zFar, f);
				const pxMin = (Math.min(x0, x1, x2, x3) * 0.5 + 0.5) * width - 1;
				const pxMax = (Math.max(x0, x1, x2, x3) * 0.5 + 0.5) * width + 1;
				// ndc y up, pixels down
				const pyMin = (0.5 - Math.max(y0, y1, y2, y3) * 0.5) * height - 1;
				const pyMax = (0.5 - Math.min(y0, y1, y2, y3) * 0.5) * height + 1;
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
		if (records > 0) {
			const at = SHADOW_RECORDS_AT * 4;
			queue.writeBuffer(this.lightBuffer, at * 4, this.#lightData, at, records * SHADOW_RECORD_VEC4S * 4);
		}
		queue.writeBuffer(this.binBuffer, 0, bins);
		frameInfo.count = selected.length;
		return frameInfo;
	}

	/** frees the buffers */
	destroy(): void {
		this.shadows.destroy();
		this.lightBuffer.destroy();
		this.binBuffer.destroy();
	}

	/** @returns whether the view differs from the one last prepared, recording it if so */
	#viewChanged(camera: Camera, width: number, height: number): boolean {
		const view = this.#view;
		const eye = camera.position;
		if (
			view[0] === eye[0] &&
			view[1] === eye[1] &&
			view[2] === eye[2] &&
			view[3] === camera.yaw &&
			view[4] === camera.pitch &&
			view[5] === camera.fovY &&
			view[6] === camera.near &&
			view[7] === width &&
			view[8] === height
		) {
			return false;
		}
		view[0] = eye[0];
		view[1] = eye[1];
		view[2] = eye[2];
		view[3] = camera.yaw;
		view[4] = camera.pitch;
		view[5] = camera.fovY;
		view[6] = camera.near;
		view[7] = width;
		view[8] = height;
		return true;
	}

	/** @returns this frame's lights, nearest first, at most {@link MAX_LOCAL_LIGHTS} */
	#select(camera: Camera, aspect: number): Candidate[] {
		this.#shown ??= this.#entries.filter((entry) => this.#groupsShown[entry.group] ?? false);
		const candidates = this.#candidates;
		const pool = this.#pool;
		candidates.length = 0;
		const eye = camera.position;
		const planes = camera.frustumPlanes(aspect, this.#planes);
		for (const entry of this.#shown) {
			const rx = entry.position[0] - eye[0];
			const ry = entry.position[1] - eye[1];
			const rz = entry.position[2] - eye[2];
			const distance2 = rx * rx + ry * ry + rz * rz;
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
			// fill the next pooled candidate; it's only kept when the light is in view
			const candidate = (pool[candidates.length] ??= {
				entry,
				rel: [0, 0, 0],
				distance2: 0,
				fade: 0,
				center: [0, 0, 0],
				radius: 0,
			});
			candidate.entry = entry;
			candidate.rel[0] = rx;
			candidate.rel[1] = ry;
			candidate.rel[2] = rz;
			candidate.distance2 = distance2;
			candidate.fade = fade;
			boundingSphere(candidate);
			if (sphereInPlanes(planes, candidate.center, candidate.radius)) {
				candidates.push(candidate);
			}
		}
		candidates.sort((a, b) => a.distance2 - b.distance2 || a.entry.priority - b.entry.priority);
		if (candidates.length > MAX_LOCAL_LIGHTS) {
			candidates.length = MAX_LOCAL_LIGHTS;
		}
		return candidates;
	}
}

/** @returns a view-space coordinate's NDC at a view depth, for a projection scale */
const ndc = (value: number, depth: number, scale: number): number => (value * scale) / depth;

/** @returns whether a sphere is at least partly inside every plane */
const sphereInPlanes = (planes: readonly Plane[], center: Vec3, radius: number): boolean => {
	for (const [nx, ny, nz, d] of planes) {
		if (nx * center[0] + ny * center[1] + nz * center[2] + d < -radius) {
			return false;
		}
	}
	return true;
};

/** sets a candidate's sphere from its light and camera-relative position */
const boundingSphere = (candidate: Candidate): void => {
	const { entry, rel, center } = candidate;
	const range = entry.range;
	center[0] = rel[0];
	center[1] = rel[1];
	center[2] = rel[2];
	if (entry.kind === LightKind.Spot) {
		const cos = Math.cos((entry.spotAngle * Math.PI) / 360);
		candidate.radius = range;
		// narrow cones fit a sphere around the middle of their axis: its farthest points are the rim of the cap
		if (cos > 0.5) {
			const d = entry.direction;
			const half = range / 2;
			center[0] = rel[0] + d[0] * half;
			center[1] = rel[1] + d[1] * half;
			center[2] = rel[2] + d[2] * half;
			candidate.radius = range * Math.sqrt(1.25 - cos);
		}
		return;
	}
	candidate.radius = range + entry.tubeLength / 2;
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
 * - 8: its first shadow record (-1 for none) and its shadow's strength, written by {@link LocalLights.prepare}
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
