import { FormatError } from '../binary/binary-reader.ts';
import { decodeLz4Block } from '../binary/lz4.ts';

// USPC v1 string pools (`Data/Json/StringPool/StringPool<n>.byte`, JsonData group). pooled JsonData payloads
// (LevelConfig, LevelData) store i32 string ids instead of strings. layout per Variante/endfield_research_kit
// (MIT, `scene_string_pool.py`).
//
//   block 0 only: u32 blockFileCount
//   u32 magic 'USPC', u32 version (1), u32 flags (1 = LZ4), u32 count, u32 rawSize, u32 packedSize, body
//   raw body: u32 count, count × u32 offset, count × (u32 byteLength ‖ UTF-8)

const MAGIC = 0x43505355;

/** native string ids with special meaning */
export const StringId = {
	Null: -2,
	Empty: -1,
} as const;

/**
 * decodes one pool block file
 *
 * @param bytes the `.byte` file
 * @param options.first whether this is `StringPool0.byte`, which carries a leading block count
 * @returns the block's strings in id order
 * @throws {FormatError} on framing errors
 */
export const parseStringPoolBlock = (bytes: Uint8Array, options: { first: boolean }): string[] => {
	const body = options.first ? bytes.subarray(4) : bytes;
	if (body.length < 24) {
		throw new FormatError('string pool block is too short');
	}
	const head = new DataView(body.buffer, body.byteOffset, 24);
	const [magic, version, flags, count, rawSize, packedSize] = [0, 4, 8, 12, 16, 20].map((at) =>
		head.getUint32(at, true),
	);
	if (magic !== MAGIC || version !== 1 || (flags !== 0 && flags !== 1) || body.length !== packedSize + 24) {
		throw new FormatError('unsupported string pool header');
	}
	const raw = flags === 1 ? decodeLz4Block(body.subarray(24), rawSize) : body.subarray(24);
	const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
	if (raw.length !== rawSize || view.getUint32(0, true) !== count) {
		throw new FormatError('string pool count or size mismatch');
	}

	const strings: string[] = [];
	let cursor = 4 + count * 4;
	for (let i = 0; i < count; i++) {
		if (4 + count * 4 + view.getUint32(4 + i * 4, true) !== cursor) {
			throw new FormatError(`string pool entry ${i} is out of sequence`);
		}
		const size = view.getUint32(cursor, true);
		cursor += 4;
		if (cursor + size > raw.length) {
			throw new FormatError(`string pool entry ${i} overruns its block`);
		}
		strings.push(utf8.decode(raw.subarray(cursor, cursor + size)));
		cursor += size;
	}
	if (cursor !== raw.length) {
		throw new FormatError('string pool block has trailing bytes');
	}
	return strings;
};

/**
 * resolves pooled string ids. every block holds as many strings as block 0, so id `i` lives in block `⌊i /
 * blockSize⌋`.
 */
export class StringPool {
	readonly #blocks: string[][];

	/** @param blocks decoded blocks in file-number order */
	constructor(blocks: string[][]) {
		if (blocks.length === 0) {
			throw new FormatError('string pool needs at least one block');
		}
		this.#blocks = blocks;
	}

	/**
	 * @param id pooled string id
	 * @returns the string, `null` for {@link StringId.Null}, `''` for {@link StringId.Empty}
	 * @throws {FormatError} if the id isn't in the pool
	 */
	get(id: number): string | null {
		if (id === StringId.Null) {
			return null;
		}
		if (id === StringId.Empty) {
			return '';
		}
		const size = this.#blocks[0].length;
		const value = id >= 0 ? this.#blocks[Math.floor(id / size)]?.[id % size] : undefined;
		if (value === undefined) {
			throw new FormatError(`string id ${id} is not in the pool`);
		}
		return value;
	}
}

const utf8 = new TextDecoder('utf-8');
