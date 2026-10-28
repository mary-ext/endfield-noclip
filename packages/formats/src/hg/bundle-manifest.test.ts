import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FormatError } from '../binary/binary-reader.ts';

import { BundleManifest } from './bundle-manifest.ts';

// paths are "compressed" with an identity codec so the test needs no Brotli implementation
const identity = (data: Uint8Array): Uint8Array => data;

const utf16 = (text: string): Uint8Array => {
	const out = new Uint8Array(text.length * 2);
	const view = new DataView(out.buffer);
	for (let i = 0; i < text.length; i++) {
		view.setUint16(i * 2, text.charCodeAt(i), true);
	}
	return out;
};

interface Bundle {
	name: string;
	deps: number[];
	direct: number[];
	reverse: number[];
}

const build = (bundles: Bundle[], assets: { hash: bigint; path: string; bundle: number; size: number }[]) => {
	// payload: bundle names and lists, then asset paths
	const payload: number[] = [];
	const push32 = (value: number): void => {
		payload.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
	};
	const pushBytes = (bytes: Uint8Array): void => {
		for (const byte of bytes) {
			payload.push(byte);
		}
	};
	const pushString = (text: string): number => {
		const at = payload.length;
		const bytes = utf16(text);
		push32(bytes.length);
		pushBytes(bytes);
		payload.push(0, 0);
		return at;
	};
	const pushList = (values: number[]): number => {
		const at = payload.length;
		push32(values.length);
		values.forEach(push32);
		payload.push(0, 0);
		return at;
	};
	const bundleRefs = bundles.map((b) => ({
		name: pushString(b.name),
		deps: pushList(b.deps),
		reverse: pushList(b.reverse),
		direct: pushList(b.direct),
	}));
	const assetRefs = assets.map((a) => pushString(a.path));

	const assetCapacity = assets.length;
	const sizes = {
		header: 156,
		assets: 8 + assetCapacity * 32,
		bundleDict: 8 + bundles.length * 56,
		bundles: 8 + bundles.length * 48,
		payload: 8 + payload.length,
	};
	const out = new Uint8Array(Object.values(sizes).reduce((a, b) => a + b, 0));
	const view = new DataView(out.buffer);

	// header
	view.setUint32(0, 0xff11ff11, true);
	view.setUint32(4, 36, true);
	out.set(utf16('00000000-0000-0000-0000-000000000000'), 8);
	view.setUint32(80, 0xf1f2f3f4, true);
	view.setUint32(84, 32, true);
	out.set(utf16('0123456789abcdef0123456789abcdef'), 88);

	// asset dictionary: one slot per asset, keyed by hash mod capacity
	let at = 156;
	view.setUint32(at, 4 + assetCapacity * 32, true);
	view.setUint32(at + 4, assetCapacity, true);
	const values = at + 8 + assetCapacity * 8;
	const bySlot = new Map<number, number[]>();
	assets.forEach((a, i) => {
		const slot = Number(a.hash % BigInt(assetCapacity));
		bySlot.set(slot, [...(bySlot.get(slot) ?? []), i]);
	});
	let value = values;
	for (const [slot, members] of bySlot) {
		view.setUint32(at + 8 + slot * 8, value - (at + 4), true);
		view.setUint32(at + 8 + slot * 8 + 4, members.length, true);
		for (const i of members) {
			view.setBigUint64(value, assets[i].hash, true);
			view.setUint32(value + 8, assetRefs[i], true);
			view.setInt32(value + 12, assets[i].bundle, true);
			view.setInt32(value + 16, assets[i].size, true);
			value += 24;
		}
	}
	at += sizes.assets;

	// bundle dictionary (contents unused by the reader beyond its size)
	view.setUint32(at, 4 + bundles.length * 56, true);
	view.setUint32(at + 4, bundles.length, true);
	at += sizes.bundleDict;

	view.setUint32(at, 4 + bundles.length * 48, true);
	view.setUint32(at + 4, bundles.length, true);
	bundleRefs.forEach((ref, i) => {
		const row = at + 8 + i * 48;
		view.setInt32(row, i, true);
		view.setUint32(row + 4, ref.name, true);
		view.setUint32(row + 8, ref.deps, true);
		view.setUint32(row + 12, ref.reverse, true);
		view.setUint32(row + 16, ref.direct, true);
		view.setBigUint64(row + 24, BigInt(i + 100), true);
		view.setInt32(row + 40, 1, true);
	});
	at += sizes.bundles;

	view.setUint32(at, payload.length, true);
	out.set(payload, at + 4);
	view.setUint32(at + 4 + payload.length, payload.length, true);
	return out;
};

const fixture = () =>
	build(
		[
			{ name: 'main/aaa.ab', deps: [1, 2], direct: [1], reverse: [] },
			{ name: 'main/bbb.ab', deps: [2], direct: [2], reverse: [0] },
			{ name: 'initial/ccc.ab', deps: [], direct: [], reverse: [1] },
		],
		[
			{ hash: 5n, path: 'assets/x.mat', bundle: 0, size: 10 },
			{ hash: 8n, path: 'assets/y.fbx##y', bundle: 1, size: 20 },
		],
	);

test('reads bundles and their dependency lists', () => {
	const manifest = new BundleManifest(fixture(), { brotliDecompress: identity });
	assert.equal(manifest.bundleCount, 3);
	assert.equal(manifest.guid, '00000000-0000-0000-0000-000000000000');
	const bundle = manifest.bundle(1);
	assert.equal(bundle.name, 'main/bbb.ab');
	assert.deepEqual(bundle.dependencies, [2]);
	assert.deepEqual(bundle.directReverseDependencies, [0]);
	assert.equal(bundle.hashName, 101n);
	assert.equal(manifest.findBundle('initial/ccc.ab'), 2);
	assert.throws(() => manifest.bundle(3), RangeError);
});

test('finds assets by path hash and decodes their paths', () => {
	const manifest = new BundleManifest(fixture(), { brotliDecompress: identity });
	const [asset] = manifest.findAssets(8n);
	assert.equal(asset.bundleIndex, 1);
	assert.equal(asset.size, 20);
	assert.equal(manifest.assetPath(asset), 'assets/y.fbx##y');
	assert.deepEqual(manifest.findAssets(6n), []);
	assert.equal([...manifest.assets()].length, 2);
});

test('rejects a truncated manifest', () => {
	assert.throws(
		() => new BundleManifest(fixture().subarray(0, 400), { brotliDecompress: identity }),
		FormatError,
	);
});
