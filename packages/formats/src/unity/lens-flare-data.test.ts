import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FormatError } from '../binary/binary-reader.ts';

import { readLensFlareData } from './lens-flare-data.ts';

/** little-endian writer for building a synthetic asset */
class Writer {
	#bytes: number[] = [];

	#push(size: number, set: (view: DataView) => void): void {
		const view = new DataView(new ArrayBuffer(size));
		set(view);
		this.#bytes.push(...new Uint8Array(view.buffer));
	}

	i32(value: number): this {
		this.#push(4, (view) => view.setInt32(0, value, true));
		return this;
	}

	i64(value: bigint): this {
		this.#push(8, (view) => view.setBigInt64(0, value, true));
		return this;
	}

	f32(...values: number[]): this {
		for (const value of values) {
			this.#push(4, (view) => view.setFloat32(0, value, true));
		}
		return this;
	}

	u16(value: number): this {
		this.#push(2, (view) => view.setUint16(0, value, true));
		return this;
	}

	u8(value: number): this {
		this.#bytes.push(value);
		return this;
	}

	align(): this {
		while (this.#bytes.length % 4 !== 0) {
			this.#bytes.push(0);
		}
		return this;
	}

	bool(value: boolean): this {
		return this.u8(value ? 1 : 0).align();
	}

	pptr(fileId: number, pathId: bigint): this {
		return this.i32(fileId).i64(pathId);
	}

	string(value: string): this {
		const bytes = new TextEncoder().encode(value);
		this.i32(bytes.length);
		this.#bytes.push(...bytes);
		return this.align();
	}

	/** a linear curve from (0, from) to (1, to) */
	curve(from: number, to: number): this {
		this.i32(2);
		this.f32(0, from, 0, 0)
			.i32(0)
			.f32(1 / 3, 1 / 3);
		this.f32(1, to, 0, 0)
			.i32(0)
			.f32(1 / 3, 1 / 3);
		return this.i32(2).i32(2).i32(4);
	}

	gradient(): this {
		for (let i = 0; i < 8; i++) {
			this.f32(i === 1 ? 0.5 : 1, 1, 1, i === 1 ? 0.25 : 1);
		}
		for (let i = 0; i < 8; i++) {
			this.u16(i === 1 ? 65535 : 0);
		}
		for (let i = 0; i < 8; i++) {
			this.u16(i === 1 ? 65535 : 0);
		}
		return this.i32(0).u8(2).u8(2).align();
	}

	bytes(): Uint8Array {
		return new Uint8Array(this.#bytes);
	}
}

const element = (w: Writer, texture: bigint): Writer =>
	w
		.bool(true)
		.f32(0.5)
		.f32(0.1, 0.2)
		.f32(-5)
		.f32(1, 1)
		.f32(7)
		.pptr(1, texture)
		.f32(2)
		.f32(8, 3)
		.bool(true)
		.i32(3)
		.bool(false)
		.f32(30)
		.f32(1, 0.5, 0, 1)
		.i32(0)
		.bool(true)
		.i32(texture === 0n ? 1 : 0)
		.bool(false)
		.bool(true)
		.i32(2)
		.f32(0.45)
		.curve(0, 1)
		.curve(0.5, 1)
		.i32(16)
		.gradient()
		.f32(0.75)
		.f32(1, 0)
		.f32(1)
		.f32(180)
		.bool(true)
		.f32(1, 1)
		.curve(0, 1)
		.bool(false)
		.f32(0.7)
		.f32(0.8)
		.i32(6)
		.f32(0)
		.bool(false)
		.f32(0)
		.curve(0, 0);

const asset = (): Writer => {
	const w = new Writer().pptr(0, 0n).bool(true).pptr(2, 99n).string('LFlare_test').i32(2);
	element(w, 1234n);
	return element(w, 0n);
};

describe('readLensFlareData', () => {
	it('reads every element in declaration order', () => {
		const flare = readLensFlareData(asset().bytes(), { littleEndian: true });
		assert.equal(flare.name, 'LFlare_test');
		assert.equal(flare.elements.length, 2);
		const [image, circle] = flare.elements;
		assert.deepEqual(image.lensFlareTexture, { fileId: 1, pathId: 1234n });
		assert.equal(circle.lensFlareTexture, null);
		assert.equal(circle.flareType, 1);
		assert.equal(image.localIntensity, 7);
		assert.deepEqual(image.sizeXY, [8, 3]);
		assert.equal(image.count, 3);
		assert.equal(image.distribution, 2);
		assert.equal(image.seed, 16);
		assert.deepEqual(
			image.scaleCurve.keys.map(({ time, value }) => [time, value]),
			[
				[0, 0.5],
				[1, 1],
			],
		);
		assert.equal(image.scaleCurve.preWrapMode, 2);
		assert.deepEqual(image.colorGradient.colorKeys, [
			{ time: 0, color: [1, 1, 1] },
			{ time: 1, color: [0.5, 1, 1] },
		]);
		assert.deepEqual(image.colorGradient.alphaKeys, [
			{ time: 0, alpha: 1 },
			{ time: 1, alpha: 0.25 },
		]);
		assert.equal(image.sideCount, 6);
		assert.ok(Math.abs(image.fallOff - 0.7) < 1e-6);
	});

	it('rejects trailing bytes', () => {
		const bytes = asset().i32(0).bytes();
		assert.throws(() => readLensFlareData(bytes, { littleEndian: true }), FormatError);
	});
});
