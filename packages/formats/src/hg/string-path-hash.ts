import { FormatError } from '../binary/binary-reader.ts';
import { ByteView } from '../binary/byte-view.ts';

import { hashSlot, type HashSlot, slotAt } from './hash-slots.ts';

// `Data/ExtendData/Main/StringPathHash.bin` (ExtendData group) and `Data/ExtendData/Initial/InitStringPathHash.bin`
// (InitialExtendData group): a stored hash table from 64-bit path hashes to asset/`Data/` paths. world data
// (InitChunkData draws, LevelConfig levelDataPaths) references assets by these hashes. layout per
// Variante/endfield_research_kit (MIT, `scripts/game_data/extend_data_binary.py`):
//
//   u32 stringsOffset (= 8 + 24·count) ‖ u32 count
//   count × (u32 bucketOffset, u32 bucketLength)       slot = hash mod count
//   count × 16-byte buckets: (u32 ?, u64 hash, u32 pathOffset relative to stringsOffset)
//   count × (u32 byteLength ‖ UTF-16LE ‖ u16 0)

const SLOTS_START = 8;
const BUCKET_SIZE = 16;

/** read-only view of a StringPathHash table; lookups decode only what they touch */
export class StringPathHashTable {
	readonly #view: ByteView;
	readonly #stringsOffset: number;
	/** number of slots, which is also the number of buckets and strings */
	readonly count: number;

	/**
	 * @param bytes the whole file; not copied
	 * @throws {FormatError} if the header doesn't describe the file
	 */
	constructor(bytes: Uint8Array) {
		if (bytes.length < 8) {
			throw new FormatError('string path hash file is too short');
		}
		this.#view = new ByteView(bytes, 'string path hash');
		this.#stringsOffset = this.#view.u32(0);
		this.count = this.#view.u32(4);
		if (this.#stringsOffset !== 8 + 24 * this.count || this.#stringsOffset > bytes.length) {
			throw new FormatError(`string path hash header is inconsistent (count ${this.count})`);
		}
	}

	/**
	 * @param hash path hash as stored (unsigned)
	 * @returns every distinct path stored under the hash; usually exactly one
	 * @throws {FormatError} if the table references data outside the file
	 */
	lookupAll(hash: bigint): string[] {
		const slot = hashSlot(this.#view, SLOTS_START, this.count, hash);
		const found: string[] = [];
		if (slot === undefined) {
			return found;
		}
		for (const bucket of this.#buckets(slot)) {
			if (this.#view.u64(bucket + 4) === hash) {
				const path = this.#string(this.#view.u32(bucket + 12));
				if (!found.includes(path)) {
					found.push(path);
				}
			}
		}
		return found;
	}

	/**
	 * @param hash path hash as stored (unsigned)
	 * @returns the path, or `undefined` if the hash is unknown or ambiguous
	 * @throws {FormatError} if the table references data outside the file
	 */
	lookup(hash: bigint): string | undefined {
		const found = this.lookupAll(hash);
		return found.length === 1 ? found[0] : undefined;
	}

	/**
	 * yields every `(hash, path)` bucket in slot order; repeated pairs are yielded repeatedly
	 *
	 * @throws {FormatError} if the table references data outside the file
	 */
	*entries(): Generator<[hash: bigint, path: string]> {
		for (const bucket of this.#allBuckets()) {
			yield [this.#view.u64(bucket + 4), this.#string(this.#view.u32(bucket + 12))];
		}
	}

	/**
	 * like {@link entries}, but only decodes paths whose stored UTF-16 byte length matches, which makes scanning
	 * for a known path cheap
	 *
	 * @param byteLength UTF-16 byte length of the wanted paths (twice their UTF-16 code unit count)
	 * @throws {FormatError} if the table references data outside the file
	 */
	*entriesWithByteLength(byteLength: number): Generator<[hash: bigint, path: string]> {
		for (const bucket of this.#allBuckets()) {
			const at = this.#stringsOffset + this.#view.u32(bucket + 12);
			if (this.#view.u32(at) === byteLength) {
				yield [this.#view.u64(bucket + 4), this.#view.lengthPrefixedUtf16(at)];
			}
		}
	}

	/** @returns bucket offsets of every slot, in slot order */
	*#allBuckets(): Generator<number> {
		for (let s = 0; s < this.count; s++) {
			yield* this.#buckets(slotAt(this.#view, SLOTS_START, s));
		}
	}

	*#buckets(slot: HashSlot): Generator<number> {
		for (let i = 0; i < slot.count; i++) {
			yield slot.offset + i * BUCKET_SIZE;
		}
	}

	#string(relative: number): string {
		return this.#view.lengthPrefixedUtf16(this.#stringsOffset + relative);
	}
}
