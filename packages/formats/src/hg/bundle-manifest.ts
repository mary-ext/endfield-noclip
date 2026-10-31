import { FormatError } from '../binary/binary-reader.ts';
import { ByteView } from '../binary/byte-view.ts';

import { hashSlot } from './hash-slots.ts';

// `Data/Bundles/Windows/manifest.hgmmap` (BundleManifest group). the stored file is one Brotli stream over
// the layout below; asset paths inside it are Brotli-compressed again. layout and field names per
// Variante/endfield_research_kit (MIT, `scripts/game_data/bundle_manifest{,_native}.py` +
// `contracts/bundle_manifest_native.json`):
//
//   header (156 bytes): u32 0xFF11FF11, u32 n, UTF-16 guid[n]; u32 0xF1F2F3F4, u32 n, UTF-16 hash[n]; u32 0
//   asset dictionary:  u32 size, u32 capacity, capacity × (u32 offset, u32 count) slots,
//                      capacity × AssetInfo{ i64 pathHashHead, u32 path, i32 bundleIndex, i32 assetSize, u32 0 }
//   bundle dictionary: same shape over 48-byte Bundle values keyed by hashName (bundleIndex stored as 0)
//   bundle array:      u32 size, u32 count, count × Bundle{ i32 bundleIndex, u32 name, u32 dependencies,
//                      u32 directReverseDependencies, u32 directDependencies, u32 bundleFlags, i64 hashName,
//                      i64 hashVersion, i32 category, u32 0 }
//   data region:       u32 size, data, u32 size
//
// slot offsets are relative to the dictionary's capacity word; slot = unsigned key mod capacity. `name` and
// the dependency lists point into the data region: UTF-16 strings are `u32 byteLength ‖ chars ‖ u16 0`,
// lists are `u32 count ‖ u32 bundleIndex[count] ‖ u16 0`. `path` points at
// `u32 length ‖ Brotli(UTF-16LE) ‖ u16 0`.

const HEAD1 = 0xff11ff11;
const HEAD2 = 0xf1f2f3f4;
const HEADER_SIZE = 156;
const ASSET_SIZE = 24;
const BUNDLE_SIZE = 48;

// #region types

/** a bundle row */
export interface BundleInfo {
	index: number;
	/** logical bundle name, e.g. `main/0123…ab` or `initial/…ab` */
	name: string;
	/** transitive dependency closure, as bundle indices */
	dependencies: number[];
	directDependencies: number[];
	directReverseDependencies: number[];
	bundleFlags: number;
	/** hash of `name` (the manifest's own string hash) */
	hashName: bigint;
	/** `hashName` folded with every dependency's name hash */
	hashVersion: bigint;
	/** the game's `RootCategory`: 0 `Main`, 1 `Initial`, matching the name's `main/` or `initial/` prefix */
	category: number;
}

/** an asset row; several rows may name the same path */
export interface AssetInfo {
	/** hash of the lowercased asset path; same key space as StringPathHash */
	pathHash: bigint;
	bundleIndex: number;
	assetSize: number;
	/** data-region offset of the compressed path, for {@link BundleManifest.assetPath} */
	pathOffset: number;
}

/** options for {@link BundleManifest} */
export interface BundleManifestOptions {
	/** Brotli decompressor, for the file and its asset path strings */
	brotliDecompress: (data: Uint8Array) => Uint8Array;
}

// #endregion

/** reader over a `manifest.hgmmap` */
export class BundleManifest {
	readonly #view: ByteView;
	readonly #decompress: (data: Uint8Array) => Uint8Array;
	readonly #assetDictionary: number;
	readonly #assetCapacity: number;
	readonly #bundleArray: number;
	readonly #data: number;
	#bundlesByName: Map<string, number> | undefined;

	/** build guid from the first header */
	readonly guid: string;
	/** content hash from the second header (the game's manifest `hash`) */
	readonly contentHash: string;
	readonly bundleCount: number;

	/**
	 * @param stored the file as stored in the VFS (Brotli-compressed)
	 * @param options decompressor
	 * @throws {FormatError} if the framing doesn't match
	 */
	constructor(stored: Uint8Array, options: BundleManifestOptions) {
		this.#decompress = options.brotliDecompress;
		const bytes = this.#decompress(stored);
		this.#view = new ByteView(bytes, 'bundle manifest');

		if (bytes.length < HEADER_SIZE || this.#view.u32(0) !== HEAD1) {
			throw new FormatError('not a bundle manifest');
		}
		const guidLength = this.#view.u32(4);
		this.guid = utf16.decode(this.#view.subarray(8, guidLength * 2));
		const head2 = 8 + guidLength * 2;
		if (this.#view.u32(head2) !== HEAD2) {
			throw new FormatError('bundle manifest second header is missing');
		}
		const hashLength = this.#view.u32(head2 + 4);
		this.contentHash = utf16.decode(this.#view.subarray(head2 + 8, hashLength * 2));
		if (head2 + 8 + hashLength * 2 + 4 !== HEADER_SIZE) {
			throw new FormatError('bundle manifest header has an unexpected size');
		}

		this.#assetDictionary = HEADER_SIZE;
		this.#assetCapacity = this.#view.u32(HEADER_SIZE + 4);
		const bundleDictionary = this.#section(this.#assetDictionary, ASSET_SIZE);
		const bundleSection = this.#section(bundleDictionary, BUNDLE_SIZE);

		const bundleSize = this.#view.u32(bundleSection);
		this.bundleCount = this.#view.u32(bundleSection + 4);
		if (bundleSize !== 4 + this.bundleCount * BUNDLE_SIZE) {
			throw new FormatError('bundle array size disagrees with its count');
		}
		this.#bundleArray = bundleSection + 8;

		const variable = bundleSection + 4 + bundleSize;
		const dataSize = this.#view.u32(variable);
		this.#data = variable + 4;
		if (this.#view.u32(this.#data + dataSize) !== dataSize || this.#data + dataSize + 4 !== bytes.length) {
			throw new FormatError('bundle manifest variable region is malformed');
		}
	}

	/**
	 * @param index bundle index
	 * @returns the bundle row
	 * @throws {RangeError} if out of range
	 */
	bundle(index: number): BundleInfo {
		if (!Number.isInteger(index) || index < 0 || index >= this.bundleCount) {
			throw new RangeError(`bundle index ${index} out of range`);
		}
		const at = this.#bundleArray + index * BUNDLE_SIZE;
		return {
			index: this.#view.i32(at),
			name: this.#string(this.#view.u32(at + 4)),
			dependencies: this.#list(this.#view.u32(at + 8)),
			directReverseDependencies: this.#list(this.#view.u32(at + 12)),
			directDependencies: this.#list(this.#view.u32(at + 16)),
			bundleFlags: this.#view.u32(at + 20),
			hashName: this.#view.u64(at + 24),
			hashVersion: this.#view.u64(at + 32),
			category: this.#view.i32(at + 40),
		};
	}

	/**
	 * @param name logical bundle name, e.g. `main/<24 hex>.ab`
	 * @returns its index, or `undefined`
	 */
	findBundle(name: string): number | undefined {
		if (this.#bundlesByName === undefined) {
			this.#bundlesByName = new Map();
			for (let i = 0; i < this.bundleCount; i++) {
				this.#bundlesByName.set(this.#string(this.#view.u32(this.#bundleArray + i * BUNDLE_SIZE + 4)), i);
			}
		}
		return this.#bundlesByName.get(name);
	}

	/**
	 * @param pathHash hash of the lowercased asset path, as an unsigned 64-bit value
	 * @returns every asset row stored under the hash
	 */
	findAssets(pathHash: bigint): AssetInfo[] {
		const found: AssetInfo[] = [];
		const slot = hashSlot(this.#view, this.#assetDictionary + 8, this.#assetCapacity, pathHash);
		if (slot === undefined) {
			return found;
		}
		// slot offsets are relative to the capacity word
		const start = this.#assetDictionary + 4 + slot.offset;
		for (let i = 0; i < slot.count; i++) {
			const asset = this.#asset(start + i * ASSET_SIZE);
			if (asset.pathHash === pathHash) {
				found.push(asset);
			}
		}
		return found;
	}

	/** yields every asset row in storage order */
	*assets(): Generator<AssetInfo> {
		const values = this.#assetDictionary + 8 + this.#assetCapacity * 8;
		for (let i = 0; i < this.#assetCapacity; i++) {
			yield this.#asset(values + i * ASSET_SIZE);
		}
	}

	/**
	 * @param asset an asset row from this manifest
	 * @returns its path as stored (lowercase)
	 */
	assetPath(asset: AssetInfo): string {
		const at = this.#data + asset.pathOffset;
		const length = this.#view.u32(at);
		return utf16.decode(this.#decompress(this.#view.subarray(at + 4, length)));
	}

	/** @returns the position after a dictionary section, validating its size word */
	#section(at: number, valueSize: number): number {
		const size = this.#view.u32(at);
		const capacity = this.#view.u32(at + 4);
		if (size !== 4 + capacity * (8 + valueSize)) {
			throw new FormatError(`bundle manifest dictionary at ${at} has an inconsistent size`);
		}
		return at + 4 + size;
	}

	#asset(at: number): AssetInfo {
		return {
			pathHash: this.#view.u64(at),
			pathOffset: this.#view.u32(at + 8),
			bundleIndex: this.#view.i32(at + 12),
			assetSize: this.#view.i32(at + 16),
		};
	}

	#string(offset: number): string {
		return this.#view.lengthPrefixedUtf16(this.#data + offset);
	}

	#list(offset: number): number[] {
		const at = this.#data + offset;
		const count = this.#view.u32(at);
		this.#view.check(at + 4, count * 4);
		return Array.from({ length: count }, (_, i) => this.#view.u32(at + 4 + i * 4));
	}
}

const utf16 = new TextDecoder('utf-16le');
