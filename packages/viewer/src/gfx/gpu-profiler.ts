const READBACK_BUFFERS = 4;
/** passes timed per frame at most; later ones run untimed */
const MAX_PASSES = 64;
/** weight of the newest frame in the smoothed times */
const SMOOTHING = 0.1;
/** resolved bytes per pass: begin and end timestamps */
const PASS_BYTES = 2 * 8;

interface Readback {
	buffer: GPUBuffer;
	/** the label of each timed pass, in query order */
	labels: string[];
}

/** times each render and compute pass of a frame; inert when `timestamp-query` isn't available */
export class GpuProfiler {
	/**
	 * smoothed GPU time from the first timed pass's start to the last one's end, ms, or `null` before the first
	 * result / without support
	 */
	milliseconds: number | null = null;
	/**
	 * smoothed GPU time per pass label (passes sharing a label are summed), ms. tile-based GPUs (Apple) overlap
	 * passes, so there these are pass lifetimes rather than costs and can sum to far more than
	 * {@link milliseconds}; compare frames with features toggled instead
	 */
	readonly passes = new Map<string, number>();

	#querySet: GPUQuerySet | null;
	#resolve: GPUBuffer | null;
	#idle: GPUBuffer[] = [];
	#labels: string[] = [];
	#frameMap = new Map<string, number>();
	#pending: Readback | null = null;
	#destroyed = false;

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
		const bytes = MAX_PASSES * PASS_BYTES;
		this.#querySet = device.createQuerySet({ type: 'timestamp', count: MAX_PASSES * 2 });
		this.#resolve = device.createBuffer({
			label: 'pass timestamps',
			size: bytes,
			usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
		});
		for (let i = 0; i < READBACK_BUFFERS; i++) {
			this.#idle.push(
				device.createBuffer({
					label: 'pass timestamp readback',
					size: bytes,
					usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
				}),
			);
		}
	}

	/**
	 * @param encoder the frame's encoder
	 * @returns the encoder, timing each render and compute pass begun through it while a readback buffer is
	 *   free; call {@link resolve} on it after the last pass
	 */
	instrument(encoder: GPUCommandEncoder): GPUCommandEncoder {
		const querySet = this.#querySet;
		this.#labels = [];
		if (this.#destroyed || querySet === null || this.#idle.length === 0) {
			return encoder;
		}
		const labels = this.#labels;
		const nextWrites = (label: string | undefined): GPURenderPassTimestampWrites | null => {
			if (labels.length >= MAX_PASSES) {
				return null;
			}
			const index = labels.length * 2;
			labels.push(label ?? 'unlabelled');
			return { querySet, beginningOfPassWriteIndex: index, endOfPassWriteIndex: index + 1 };
		};
		const rawRender = encoder.beginRenderPass.bind(encoder);
		const rawCompute = encoder.beginComputePass.bind(encoder);
		encoder.beginRenderPass = (descriptor: GPURenderPassDescriptor): GPURenderPassEncoder => {
			const timestampWrites = nextWrites(descriptor.label);
			return timestampWrites === null ? rawRender(descriptor) : rawRender({ ...descriptor, timestampWrites });
		};
		encoder.beginComputePass = (descriptor?: GPUComputePassDescriptor): GPUComputePassEncoder => {
			const timestampWrites = nextWrites(descriptor?.label);
			return timestampWrites === null
				? rawCompute(descriptor)
				: rawCompute({ ...descriptor, timestampWrites });
		};
		return encoder;
	}

	/**
	 * resolves the timestamps of the passes timed since {@link instrument}.
	 *
	 * @param encoder the frame's encoder, after its last pass
	 */
	resolve(encoder: GPUCommandEncoder): void {
		const count = this.#labels.length;
		if (this.#querySet === null || this.#resolve === null || count === 0) {
			return;
		}
		const buffer = this.#idle.pop();
		if (buffer === undefined) {
			return;
		}
		encoder.resolveQuerySet(this.#querySet, 0, count * 2, this.#resolve, 0);
		encoder.copyBufferToBuffer(this.#resolve, 0, buffer, 0, count * PASS_BYTES);
		this.#pending = { buffer, labels: this.#labels };
	}

	/** starts reading back what {@link resolve} recorded; call after submitting */
	afterSubmit(): void {
		const pending = this.#pending;
		if (pending === null) {
			return;
		}
		this.#pending = null;
		const { buffer, labels } = pending;
		buffer
			.mapAsync(GPUMapMode.READ)
			.then(() => {
				if (this.#destroyed) {
					buffer.unmap();
					buffer.destroy();
					return;
				}
				const times = new BigUint64Array(buffer.getMappedRange(), 0, labels.length * 2);
				const frame = this.#frameMap;
				frame.clear();
				let first = times[0];
				let last = times[1];
				for (let i = 0; i < labels.length; i++) {
					const begin = times[i * 2];
					const end = times[i * 2 + 1];
					const nanoseconds = Number(end - begin);
					// some drivers report bogus values for reordered or empty passes
					const ms = nanoseconds > 0 && nanoseconds < 1e9 ? nanoseconds / 1e6 : 0;
					frame.set(labels[i], (frame.get(labels[i]) ?? 0) + ms);
					if (begin > 0n && begin < first) {
						first = begin;
					}
					if (end > last) {
						last = end;
					}
				}
				const span = Number(last - first) / 1e6;
				const total = span > 0 && span < 1e3 ? span : 0;
				buffer.unmap();
				this.#idle.push(buffer);
				for (const label of this.passes.keys()) {
					if (!frame.has(label)) {
						this.passes.delete(label);
					}
				}
				for (const [label, ms] of frame) {
					const previous = this.passes.get(label);
					this.passes.set(label, previous === undefined ? ms : previous + (ms - previous) * SMOOTHING);
				}
				const previous = this.milliseconds;
				this.milliseconds = previous === null ? total : previous + (total - previous) * SMOOTHING;
			})
			.catch(() => {
				if (this.#destroyed) {
					buffer.destroy();
				} else {
					if (buffer.mapState === 'mapped') {
						buffer.unmap();
					}
					if (buffer.mapState === 'unmapped') {
						this.#idle.push(buffer);
					}
				}
			});
	}

	/** frees the query set and readback buffers */
	destroy(): void {
		this.#destroyed = true;
		this.#querySet?.destroy();
		this.#resolve?.destroy();
		for (const buffer of this.#idle) {
			buffer.destroy();
		}
		this.#idle.length = 0;
		this.#pending?.buffer.destroy();
		this.#pending = null;
	}
}
