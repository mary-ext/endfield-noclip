import { crc32, deflateSync } from 'node:zlib';

/** PNG colour types this writer supports */
export type PngColor = 'gray' | 'rgb';

export interface PngImage {
	width: number;
	height: number;
	color: PngColor;
	bitDepth: 8 | 16;
	/** rows top to bottom; 16-bit samples are host-order `Uint16Array` values */
	data: Uint8Array | Uint16Array;
}

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const CHANNELS: Record<PngColor, number> = { gray: 1, rgb: 3 };
const COLOR_TYPE: Record<PngColor, number> = { gray: 0, rgb: 2 };

/**
 * encodes a non-interlaced PNG without filtering, which is plenty for debug output
 *
 * @param image pixels; `data` must be `Uint16Array` for 16-bit images and `Uint8Array` for 8-bit ones
 * @returns the PNG file
 * @throws {RangeError} if `data` has the wrong length or element type
 */
export const encodePng = (image: PngImage): Uint8Array => {
	const { width, height, color, bitDepth, data } = image;
	const channels = CHANNELS[color];
	const sampleBytes = bitDepth / 8;
	if (data.length !== width * height * channels || (bitDepth === 16) !== data instanceof Uint16Array) {
		throw new RangeError(`pixel data doesn't match a ${width}×${height} ${bitDepth}-bit ${color} image`);
	}

	const stride = width * channels * sampleBytes;
	const raw = new Uint8Array((stride + 1) * height);
	if (data instanceof Uint16Array) {
		const view = new DataView(raw.buffer);
		for (let y = 0; y < height; y++) {
			const row = y * (stride + 1) + 1;
			for (let i = 0; i < width * channels; i++) {
				view.setUint16(row + i * 2, data[y * width * channels + i], false);
			}
		}
	} else {
		for (let y = 0; y < height; y++) {
			raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
		}
	}

	const header = new Uint8Array(13);
	{
		const view = new DataView(header.buffer);
		view.setUint32(0, width);
		view.setUint32(4, height);
		header[8] = bitDepth;
		header[9] = COLOR_TYPE[color];
	}
	const chunks = [chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())];
	const out = new Uint8Array(SIGNATURE.length + chunks.reduce((sum, part) => sum + part.length, 0));
	out.set(SIGNATURE);
	let offset = SIGNATURE.length;
	for (const part of chunks) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
};

const chunk = (type: string, body: Uint8Array): Uint8Array => {
	const out = new Uint8Array(body.length + 12);
	const view = new DataView(out.buffer);
	view.setUint32(0, body.length);
	for (let i = 0; i < 4; i++) {
		out[4 + i] = type.charCodeAt(i);
	}
	out.set(body, 8);
	view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
	return out;
};
