/**
 * the GPU side of the game's auto exposure (the arithmetic is in `exposure.ts`): a histogram of 16 bins of
 * log2 luminance over the profile's metering range, taken from every 16th pixel of the scene before bloom and
 * tonemapping and optionally weighted towards the screen's centre, then read back asynchronously, a frame or
 * two late, as in the game.
 *
 * @module
 */

import {
	type AutoExposureSettings,
	BINS,
	easeExposure,
	meteredExposure,
	targetExposure,
} from './exposure.ts';
import autoExposureWgsl from './shaders/auto-exposure.wgsl?raw';

/** pixels between samples along each axis; one workgroup of 8 × 8 threads covers 128² pixels */
const STRIDE = 16;
const WORKGROUP_PIXELS = 8 * STRIDE;
/** fixed-point scale of the weights the shader accumulates; matches `WEIGHT_SCALE` in auto-exposure.wgsl */
const WEIGHT_SCALE = 1024;
/** the game's centre weight under centre metering */
const CENTRE_WEIGHT = 0.75;
/** the exposure counts as settled once within this many EV of its target */
const SETTLED_EV = 0.01;

/** the histogram pass, its readback and the exposure it drives */
export class AutoExposure {
	/** the post exposure (linear) the scene is shown at, before the viewer's exposure option */
	exposure = 1;
	#device: GPUDevice;
	#pipeline: GPUComputePipeline;
	#uniforms: GPUBuffer;
	#bins: GPUBuffer;
	/** readback buffers not waiting on a map */
	#idle: GPUBuffer[];
	/** the readback buffer this frame's histogram was copied into, mapped after submit, and its settings */
	#pending: { buffer: GPUBuffer; settings: AutoExposureSettings } | null = null;
	#group: { view: GPUTextureView; group: GPUBindGroup } | null = null;
	#metered: number | null = null;
	/** jump straight to the next metered exposure instead of easing (a new level or a fresh start) */
	#snap = true;

	/** @param device the device */
	constructor(device: GPUDevice) {
		this.#device = device;
		const module = device.createShaderModule({ label: 'auto exposure', code: autoExposureWgsl });
		this.#pipeline = device.createComputePipeline({
			label: 'auto exposure histogram',
			layout: 'auto',
			compute: { module, entryPoint: 'cs_histogram' },
		});
		this.#uniforms = device.createBuffer({
			label: 'auto exposure params',
			size: 32,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		this.#bins = device.createBuffer({
			label: 'auto exposure bins',
			size: BINS * 4,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
		});
		this.#idle = [0, 1].map(() =>
			device.createBuffer({
				label: 'auto exposure readback',
				size: BINS * 4,
				usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
			}),
		);
	}

	/** forgets the metered exposure, so the next histogram is taken at once rather than eased towards */
	reset(): void {
		this.#metered = null;
		this.#snap = true;
	}

	/**
	 * encodes the histogram of this frame's scene, unless both readback buffers are still in flight.
	 *
	 * @param encoder this frame's encoder
	 * @param scene the lit scene before bloom and tonemapping, and its size in pixels
	 * @param settings the exposure settings
	 */
	encode(
		encoder: GPUCommandEncoder,
		scene: { view: GPUTextureView; width: number; height: number },
		settings: AutoExposureSettings,
	): void {
		if (settings.mode === 'manual') {
			return;
		}
		const readback = this.#idle.pop();
		if (readback === undefined) {
			return;
		}
		const { view, width, height } = scene;
		const params = new ArrayBuffer(32);
		new Uint32Array(params, 0, 3).set([width, height, STRIDE]);
		new Float32Array(params, 12, 3).set([
			settings.centreWeighted ? CENTRE_WEIGHT : 0,
			settings.meteringRange[0],
			settings.meteringRange[1],
		]);
		this.#device.queue.writeBuffer(this.#uniforms, 0, params);
		if (this.#group?.view !== view) {
			this.#group = {
				view,
				group: this.#device.createBindGroup({
					layout: this.#pipeline.getBindGroupLayout(0),
					entries: [
						{ binding: 0, resource: view },
						{ binding: 1, resource: { buffer: this.#uniforms } },
						{ binding: 2, resource: { buffer: this.#bins } },
					],
				}),
			};
		}
		encoder.clearBuffer(this.#bins);
		const pass = encoder.beginComputePass({ label: 'auto exposure histogram' });
		pass.setPipeline(this.#pipeline);
		pass.setBindGroup(0, this.#group.group);
		pass.dispatchWorkgroups(Math.ceil(width / WORKGROUP_PIXELS), Math.ceil(height / WORKGROUP_PIXELS));
		pass.end();
		encoder.copyBufferToBuffer(this.#bins, 0, readback, 0, BINS * 4);
		this.#pending = { buffer: readback, settings };
	}

	/** starts reading back the histogram {@link encode} recorded; call after submitting */
	afterSubmit(): void {
		const pending = this.#pending;
		if (pending === null) {
			return;
		}
		this.#pending = null;
		const { buffer, settings } = pending;
		buffer
			.mapAsync(GPUMapMode.READ)
			.then(() => {
				const words = new Uint32Array(buffer.getMappedRange());
				const bins = Array.from(words, (w) => w / WEIGHT_SCALE);
				buffer.unmap();
				this.#idle.push(buffer);
				this.#metered = meteredExposure(bins, settings);
			})
			.catch(() => {});
	}

	/**
	 * moves the exposure towards its target.
	 *
	 * @param settings the exposure settings, or `null` to show the scene at exposure 1
	 * @param dt seconds since the last step
	 * @returns whether the exposure is still moving or waiting on its first histogram, so the caller keeps
	 *   rendering
	 */
	update(settings: AutoExposureSettings | null, dt: number): boolean {
		if (settings === null) {
			this.exposure = 1;
			this.reset();
			return false;
		}
		if (settings.mode === 'auto' && this.#metered === null) {
			return true;
		}
		const target = targetExposure(this.#metered, settings);
		if (this.#snap) {
			this.#snap = false;
			this.exposure = target;
			return false;
		}
		if (Math.abs(Math.log2(this.exposure / target)) < SETTLED_EV) {
			this.exposure = target;
			return false;
		}
		this.exposure = easeExposure(this.exposure, target, settings, dt);
		return true;
	}

	/** frees the GPU resources */
	destroy(): void {
		this.#uniforms.destroy();
		this.#bins.destroy();
		for (const buffer of this.#idle) {
			buffer.destroy();
		}
		this.#pending?.buffer.destroy();
	}
}
