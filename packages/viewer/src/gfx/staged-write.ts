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
	if (stagedBytes > 0) {
		buffer = device.createBuffer({
			label: 'staged texels',
			size: stagedBytes,
			usage: GPUBufferUsage.COPY_SRC,
			mappedAtCreation: true,
		});
		mapped = new Uint8Array(buffer.getMappedRange());
		encoder = device.createCommandEncoder({ label: 'staged texels' });
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
		device.queue.submit([encoder.finish()]);
		buffer.destroy();
	}
};

/** whether a write goes through the staging buffer: large, and laid out as a buffer copy allows */
const staged = (write: TexelWrite): boolean =>
	write.data.byteLength >= STAGED_BYTES &&
	write.data.byteLength % 4 === 0 &&
	write.bytesPerRow % ROW_ALIGNMENT === 0;
