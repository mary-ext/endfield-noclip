/**
 * large uploads through a staging buffer. `queue.writeBuffer` and `queue.writeTexture` hand their bytes to
 * the GPU process inside the call, and Chrome sends a megabyte or more in pieces it waits on: a 1 MiB
 * `writeTexture` took about 2 ms of the main thread on an idle device and 15–30 ms while streaming, the
 * longest stalls of a flight. a buffer mapped at creation is shared memory, so filling one and copying from
 * it costs the main thread a tenth of a millisecond whatever the size.
 *
 * @module
 */

/** writes of at least this many bytes go through a staging buffer; smaller ones cost less written directly */
export const STAGED_BYTES = 128 * 1024;

/** the row pitch `copyBufferToTexture` needs for copies of more than one row of blocks */
const ROW_ALIGNMENT = 256;

interface UploadBatch {
	device: GPUDevice;
	encoder: GPUCommandEncoder | null;
	staging: GPUBuffer[];
}

let activeBatch: UploadBatch | null = null;

/**
 * opens a batch that coalesces staged buffer/texture copies and texture-level copies into one command buffer
 * and one `queue.submit()`, flushed by {@link flushUploadBatch}
 *
 * @param device the device
 */
export const beginUploadBatch = (device: GPUDevice): void => {
	if (activeBatch !== null) {
		flushUploadBatch();
	}
	activeBatch = { device, encoder: null, staging: [] };
};

/**
 * returns the active batch's shared command encoder for `device`, or `null` when no batch is open
 *
 * @param device the device
 * @param label label if the encoder is created now
 * @returns the batch's encoder, or `null`
 */
export const uploadBatchEncoder = (device: GPUDevice, label: string): GPUCommandEncoder | null => {
	if (activeBatch === null || activeBatch.device !== device) {
		return null;
	}
	activeBatch.encoder ??= device.createCommandEncoder({ label });
	return activeBatch.encoder;
};

/**
 * submits all copies recorded since {@link beginUploadBatch} (if any) and destroys their staging buffers.
 * keeps the batch open when `keepOpen` is true (e.g. before a pool growth copy that must order after prior
 * writes)
 *
 * @param options.keepOpen leave the batch open for subsequent writes in the same frame
 */
export const flushUploadBatch = (options?: { keepOpen?: boolean }): void => {
	const batch = activeBatch;
	if (batch === null) {
		return;
	}
	if (batch.encoder !== null) {
		batch.device.queue.submit([batch.encoder.finish()]);
		batch.encoder = null;
	}
	for (const buffer of batch.staging) {
		buffer.destroy();
	}
	batch.staging.length = 0;
	if (!options?.keepOpen) {
		activeBatch = null;
	}
};

/**
 * @param device the device
 * @param bytes the data to stage
 * @returns a `COPY_SRC` buffer holding them, padded to a multiple of 4 bytes; destroy it once its copy is
 *   submitted
 */
const stage = (device: GPUDevice, bytes: Uint8Array): GPUBuffer => {
	const buffer = device.createBuffer({
		label: 'staged write',
		size: Math.ceil(bytes.byteLength / 4) * 4,
		usage: GPUBufferUsage.COPY_SRC,
		mappedAtCreation: true,
	});
	new Uint8Array(buffer.getMappedRange()).set(bytes);
	buffer.unmap();
	return buffer;
};

const bytesOf = (data: ArrayBuffer | ArrayBufferView): Uint8Array =>
	ArrayBuffer.isView(data)
		? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
		: new Uint8Array(data);

/**
 * writes `data` into a buffer as `queue.writeBuffer` would, in order with the queue's other writes and
 * submits; large data goes through a staging buffer
 *
 * @param device the device
 * @param target a `COPY_DST` buffer
 * @param offset where the data goes in it, bytes; a multiple of 4
 * @param data the bytes to write, a multiple of 4 long
 */
export const writeBufferStaged = (
	device: GPUDevice,
	target: GPUBuffer,
	offset: number,
	data: ArrayBuffer | ArrayBufferView<ArrayBuffer>,
): void => {
	if (data.byteLength < STAGED_BYTES || data.byteLength % 4 !== 0 || offset % 4 !== 0) {
		device.queue.writeBuffer(target, offset, data);
		return;
	}
	const staging = stage(device, bytesOf(data));
	const batched = uploadBatchEncoder(device, 'staged upload batch');
	if (batched !== null && activeBatch !== null) {
		batched.copyBufferToBuffer(staging, 0, target, offset, data.byteLength);
		activeBatch.staging.push(staging);
		return;
	}
	const encoder = device.createCommandEncoder({ label: 'staged write' });
	encoder.copyBufferToBuffer(staging, 0, target, offset, data.byteLength);
	device.queue.submit([encoder.finish()]);
	staging.destroy();
};

/** one level (or layer range) of texels to write */
export interface TexelWrite {
	destination: GPUTexelCopyTextureInfo;
	/** the texels, rows `bytesPerRow` apart and images `rowsPerImage` rows apart, with no padding between */
	data: Uint8Array<ArrayBuffer>;
	bytesPerRow: number;
	/** rows of blocks per image */
	rowsPerImage: number;
	size: GPUExtent3DStrict;
}

/**
 * writes texels as `queue.writeTexture` would, in order with the queue's other writes and submits; the large
 * writes share one staging buffer and one submit
 *
 * @param device the device
 * @param writes the levels to write, into `COPY_DST` textures
 */
export const writeTexturesStaged = (device: GPUDevice, writes: readonly TexelWrite[]): void => {
	let stagedBytes = 0;
	for (const write of writes) {
		if (staged(write)) {
			stagedBytes += write.data.byteLength;
		}
	}
	let buffer: GPUBuffer | null = null;
	let mapped: Uint8Array | null = null;
	let encoder: GPUCommandEncoder | null = null;
	let ownsEncoder = false;
	if (stagedBytes > 0) {
		buffer = device.createBuffer({
			label: 'staged texels',
			size: stagedBytes,
			usage: GPUBufferUsage.COPY_SRC,
			mappedAtCreation: true,
		});
		mapped = new Uint8Array(buffer.getMappedRange());
		encoder = uploadBatchEncoder(device, 'staged upload batch');
		if (encoder === null) {
			encoder = device.createCommandEncoder({ label: 'staged texels' });
			ownsEncoder = true;
		}
	}
	let at = 0;
	for (const write of writes) {
		const { destination, data, bytesPerRow, rowsPerImage, size } = write;
		if (buffer === null || mapped === null || encoder === null || !staged(write)) {
			device.queue.writeTexture(destination, data, { bytesPerRow, rowsPerImage }, size);
			continue;
		}
		mapped.set(data, at);
		encoder.copyBufferToTexture({ buffer, offset: at, bytesPerRow, rowsPerImage }, destination, size);
		at += data.byteLength;
	}
	if (buffer !== null && encoder !== null) {
		buffer.unmap();
		if (ownsEncoder) {
			device.queue.submit([encoder.finish()]);
			buffer.destroy();
		} else if (activeBatch !== null) {
			activeBatch.staging.push(buffer);
		}
	}
};

/** whether a write goes through the staging buffer: large, and laid out as a buffer copy allows */
const staged = (write: TexelWrite): boolean =>
	write.data.byteLength >= STAGED_BYTES &&
	write.data.byteLength % 4 === 0 &&
	write.bytesPerRow % ROW_ALIGNMENT === 0;
