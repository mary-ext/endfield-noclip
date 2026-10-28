/**
 * GPU pass timing with timestamp queries, read back asynchronously through a small pool of mappable buffers.
 *
 * @module
 */

const READBACK_BUFFERS = 4;

/** measures one pass per frame; inert when `timestamp-query` isn't available */
export class GpuTimer {
	/** smoothed GPU time of the timed pass, ms, or `null` before the first result / without support */
	milliseconds: number | null = null;

	#querySet: GPUQuerySet | null;
	#resolve: GPUBuffer | null;
	#idle: GPUBuffer[] = [];
	#pending: GPUBuffer | null = null;

	/**
	 * @param device the device
	 * @param supported whether the device was created with `timestamp-query`
	 */
	constructor(device: GPUDevice, supported: boolean) {
		if (!supported) {
			this.#querySet = null;
			this.#resolve = null;
			return;
		}
		this.#querySet = device.createQuerySet({ type: 'timestamp', count: 2 });
		this.#resolve = device.createBuffer({
			size: 16,
			usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
		});
		for (let i = 0; i < READBACK_BUFFERS; i++) {
			this.#idle.push(
				device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
			);
		}
	}

	/** @returns `timestampWrites` for the pass to time, or `undefined` if no readback buffer is free */
	passWrites(): GPURenderPassTimestampWrites | undefined {
		if (this.#querySet === null || this.#idle.length === 0) {
			return undefined;
		}
		return { querySet: this.#querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
	}

	/**
	 * resolves the timestamps after the timed pass. call only in frames where {@link passWrites} returned
	 * writes.
	 *
	 * @param encoder the frame's encoder, after the pass
	 */
	resolve(encoder: GPUCommandEncoder): void {
		if (this.#querySet === null || this.#resolve === null) {
			return;
		}
		const target = this.#idle.pop();
		if (target === undefined) {
			return;
		}
		encoder.resolveQuerySet(this.#querySet, 0, 2, this.#resolve, 0);
		encoder.copyBufferToBuffer(this.#resolve, 0, target, 0, 16);
		this.#pending = target;
	}

	/** starts reading back what {@link resolve} recorded; call after submitting */
	afterSubmit(): void {
		const buffer = this.#pending;
		if (buffer === null) {
			return;
		}
		this.#pending = null;
		buffer
			.mapAsync(GPUMapMode.READ)
			.then(() => {
				const times = new BigUint64Array(buffer.getMappedRange());
				const nanoseconds = Number(times[1] - times[0]);
				buffer.unmap();
				this.#idle.push(buffer);
				// ignore the bogus values some drivers report when a pass is reordered or empty
				if (nanoseconds > 0 && nanoseconds < 1e9) {
					const ms = nanoseconds / 1e6;
					this.milliseconds = this.milliseconds === null ? ms : this.milliseconds * 0.9 + ms * 0.1;
				}
			})
			.catch(() => {});
	}
}
