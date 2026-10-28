import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { FormatError, fromHex, toHex } from '@endfield-noclip/formats/binary/binary-reader';
import { decodeInvertedLz4Block, decodeInvertedLz4Prefix } from '@endfield-noclip/formats/binary/lz4';
import {
	AES_SBOX,
	bytesEqual,
	codeSections,
	dataSections,
	findBytePermutations,
	isWritable,
	parsePe,
	type PeImage,
} from '@endfield-noclip/formats/binary/pe';
import {
	BundleArchiveFlags,
	type BundleDirectory,
	parseBundleDirectory,
	parseBundleHeader,
} from '@endfield-noclip/formats/hg/bundle';
import { applyBundlePad, deriveBundlePad } from '@endfield-noclip/formats/hg/bundle-cipher';
import { parseVfsCatalog } from '@endfield-noclip/formats/hg/vfs-catalog';

import type { KeyConfig } from '../config.ts';

import { Vfs, vfsCatalogPath, VfsGroup, vfsLayerDirs } from './vfs.ts';

/**
 * recovers decryption keys from a local game install, so the repo never has to carry them.
 *
 * what comes from where, in this client build:
 *
 * - **bundle sbox/key/iv** are embedded as plain bytes in `UnityPlayer.dll`'s `.data` and are recovered by
 *   scanning for the cipher's 256-byte substitution box.
 * - **vfsKey** and the bundle **chainXor** are assembled at runtime by VM-protected code and are _not_ present
 *   as plain constants, so they can't be scanned out. they're taken from {@link DeriveOptions.fallback} (i.e.
 *   `--keys-from`) when supplied, and are still validated here against the install.
 *
 * every recovered or supplied key is checked against the real install before being returned, so a wrong key
 * fails here rather than deep in extraction.
 */
export interface DeriveOptions {
	/**
	 * key material to fall back on for parts this build hides (vfsKey, chainXor). typically the result of
	 * scraping third-party checkouts; see `key-import.ts`.
	 */
	fallback?: KeyConfig;
	/** progress sink; defaults to stderr. never receives key bytes. */
	log?: (message: string) => void;
}

/**
 * @param installRoot the install directory (holding `UnityPlayer.dll`) or its `Endfield_Data` subdirectory
 * @param options fallback key material and a progress sink
 * @returns a complete, install-validated key config
 * @throws {Error} if the install can't be read or a key can't be recovered or validated
 */
export const deriveKeys = async (installRoot: string, options: DeriveOptions = {}): Promise<KeyConfig> => {
	const log = options.log ?? ((message: string): void => console.error(`[derive] ${message}`));
	const { gameData, unityPath } = resolveInstall(installRoot);
	log(`install: ${gameData}`);

	const vfsKey = await deriveVfsKey(gameData, options.fallback, log);

	const vfs = new Vfs(gameData, fromHex(vfsKey));
	try {
		const oracles = await loadOracleBundles(vfs, log);
		log(`reading ${basename(unityPath)}`);
		// a plain Uint8Array (not a node Buffer), so `.slice()` inside the cipher copies rather than aliasing
		const unity = parsePe(new Uint8Array(await readFile(unityPath)));
		const cipher = deriveBundleCipher(unity, oracles, log);
		const chainXor = deriveChainXor(unity, cipher, oracles, options.fallback, log);
		log('all keys recovered and validated');
		return {
			vfsKey,
			bundle: { sbox: toHex(cipher.sbox), key: toHex(cipher.key), iv: toHex(cipher.iv), chainXor },
		};
	} finally {
		await vfs.close();
	}
};

// #region install layout

interface InstallPaths {
	/** path to `Endfield_Data` */
	gameData: string;
	/** path to `UnityPlayer.dll` */
	unityPath: string;
}

/**
 * @param installRoot the install directory or its `Endfield_Data` subdirectory
 * @returns the resolved `Endfield_Data` path, as stored in the config
 * @throws {Error} if neither layout is found
 */
export const resolveGameData = (installRoot: string): string => resolveInstall(installRoot).gameData;

const resolveInstall = (installRoot: string): InstallPaths => {
	let gameData: string;
	let installDir: string;
	if (basename(installRoot) === 'Endfield_Data') {
		gameData = installRoot;
		installDir = dirname(installRoot);
	} else if (existsSync(join(installRoot, 'Endfield_Data', 'il2cpp_data'))) {
		gameData = join(installRoot, 'Endfield_Data');
		installDir = installRoot;
	} else if (existsSync(join(installRoot, 'il2cpp_data'))) {
		gameData = installRoot;
		installDir = dirname(installRoot);
	} else {
		throw new Error(`${installRoot} is neither an install root nor an Endfield_Data directory`);
	}
	const unityPath = join(installDir, 'UnityPlayer.dll');
	if (!existsSync(unityPath)) {
		throw new Error(`UnityPlayer.dll not found next to ${gameData}`);
	}
	return { gameData, unityPath };
};

// #endregion

// #region vfs key

/**
 * the vfsKey is VM-protected in this build, so we validate a supplied key rather than scanning for it. the
 * oracle: a `.blc` catalog decrypts to a recognizable layout.
 */
const deriveVfsKey = async (
	gameData: string,
	fallback: KeyConfig | undefined,
	log: (message: string) => void,
): Promise<string> => {
	const blc = await readAnyCatalog(gameData);
	if (fallback?.vfsKey !== undefined) {
		const key = fromHex(fallback.vfsKey);
		if (key.length === 32 && catalogDecrypts(blc, key)) {
			log('vfsKey: validated supplied key (not recoverable from this build)');
			return fallback.vfsKey;
		}
		throw new Error('supplied vfsKey does not decrypt the install catalogs');
	}
	throw new Error('vfsKey is VM-protected in this build and must be supplied via --keys-from');
};

/** reads the first `.blc` catalog found in any VFS layer */
const readAnyCatalog = async (gameData: string): Promise<Uint8Array> => {
	for (const layer of vfsLayerDirs(gameData)) {
		for (const group of Object.values(VfsGroup)) {
			const path = vfsCatalogPath(layer, group);
			if (existsSync(path)) {
				return readFile(path);
			}
		}
	}
	throw new Error(`no .blc catalogs found under ${gameData}`);
};

const catalogDecrypts = (blc: Uint8Array, key: Uint8Array): boolean => {
	try {
		const catalog = parseVfsCatalog(blc, key);
		return /^[\x20-\x7e]+$/.test(catalog.groupName);
	} catch {
		return false;
	}
};

// #endregion

// #region oracle bundles

/** a bundle whose header we've descrambled, holding one encrypted payload block to test the pad against */
interface OracleBundle {
	data: Uint8Array;
	/** first block: file offset of the ciphertext, decompressed size, compressed size */
	block: FirstBlock;
}

interface FirstBlock {
	offset: number;
	decompressedSize: number;
	compressedSize: number;
	/** whether the node at stream offset 0 is a `CAB-` SerializedFile (so the block-0 signature applies) */
	serializedFirst: boolean;
}

const ORACLE_BUNDLE_COUNT = 4;

/**
 * pulls a few small bundles out of the VFS to validate the bundle cipher against. we want bundles whose
 * blocks-info is stored unencrypted (so we can parse the header without the pad) and whose first payload
 * block is large enough to exercise the full pad.
 */
const loadOracleBundles = async (vfs: Vfs, log: (message: string) => void): Promise<OracleBundle[]> => {
	const group = await vfs.group(VfsGroup.Bundle);
	const candidates = [...group.files.values()]
		.filter((entry) => entry.length > 1500 && entry.length < 60_000)
		.toSorted((a, b) => a.length - b.length);
	const oracles: OracleBundle[] = [];
	for (const entry of candidates) {
		// oxlint-disable-next-line no-await-in-loop -- stops reading once enough oracles are found
		const data = await vfs.read({ group, entry });
		const block = firstPayloadBlock(data);
		// the block-0 oracle checks a SerializedFile signature, so the first block must be one (not a resource)
		if (block && block.compressedSize >= 1024 && block.serializedFirst) {
			oracles.push({ data, block });
			if (oracles.length >= ORACLE_BUNDLE_COUNT) {
				break;
			}
		}
	}
	if (oracles.length === 0) {
		throw new Error('found no usable bundle to validate the cipher against');
	}
	log(`validating cipher against ${oracles.length} bundles`);
	return oracles;
};

/** the pad is only needed for compressed blocks-info, which oracle bundles don't have */
const NO_PAD = new Uint8Array(0);

/**
 * parses a bundle's directory and returns its first payload block, or `undefined` if the bundle isn't one we
 * can use as an oracle (not a bundle, compressed or end-placed blocks-info, or a non-LZ4 first block)
 */
const firstPayloadBlock = (data: Uint8Array): FirstBlock | undefined => {
	let directory: BundleDirectory;
	try {
		const header = parseBundleHeader(data);
		if (header.flags & (BundleArchiveFlags.CompressionMask | BundleArchiveFlags.BlocksInfoAtTheEnd)) {
			return undefined;
		}
		const stored = data.subarray(
			header.blocksInfoOffset,
			header.blocksInfoOffset + header.compressedBlocksInfoSize,
		);
		directory = parseBundleDirectory(header, stored, NO_PAD);
	} catch (error) {
		if (error instanceof FormatError) {
			return undefined;
		}
		throw error;
	}
	const [first] = directory.blocks;
	if (first?.flags !== 5 || first.compressedOffset + first.compressedSize > data.length) {
		return undefined;
	}
	const head = directory.nodes.find((node) => node.offset === 0);
	return {
		offset: first.compressedOffset,
		decompressedSize: first.uncompressedSize,
		compressedSize: first.compressedSize,
		serializedFirst: head?.path.startsWith('CAB-') ?? false,
	};
};

// #endregion

// #region bundle cipher (sbox/key/iv)

interface BundleKeyMaterial {
	sbox: Uint8Array;
	key: Uint8Array;
	iv: Uint8Array;
}

/**
 * recovers the bundle cipher's sbox, key and iv from `UnityPlayer.dll`. the sbox is the only 256-byte
 * permutation in writable `.data` that isn't the standard AES box; the key and iv sit immediately before it.
 *
 * @throws {Error} if no candidate validates against the oracle bundles
 */
const deriveBundleCipher = (
	unity: PeImage,
	oracles: OracleBundle[],
	log: (message: string) => void,
): BundleKeyMaterial => {
	const windows: number[] = [];
	for (const section of dataSections(unity).filter(isWritable)) {
		windows.push(...findBytePermutations(unity.data, section.rawOffset, section.rawOffset + section.rawSize));
	}
	log(`scanning ${windows.length} permutation windows for the bundle sbox`);
	for (const offset of windows) {
		if (offset < 0x20) {
			continue;
		}
		const sbox = unity.data.subarray(offset, offset + 256);
		if (bytesEqual(sbox, AES_SBOX)) {
			continue;
		}
		const key = unity.data.subarray(offset - 0x20, offset - 0x10);
		const iv = unity.data.subarray(offset - 0x10, offset);
		// block 0 of the pad is AES(iv) and doesn't depend on chainXor, so we can validate sbox/key/iv alone
		const block0 = deriveBundlePad({ sbox, key, iv, chainXor: 0n }).subarray(0, 16);
		if (oracles.every((oracle) => block0Validates(oracle, block0))) {
			log('bundle sbox/key/iv: recovered from UnityPlayer.dll');
			return { sbox: sbox.slice(), key: key.slice(), iv: iv.slice() };
		}
	}
	throw new Error('could not locate the bundle cipher sbox in UnityPlayer.dll');
};

/** the first decompressed bytes of a bundle's SerializedFile: legacy sizes are zero, version is 22 (0x16) */
const SERIALIZED_FILE_SIGNATURE = Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x16);

/**
 * validates a candidate `block0` (the first 16 pad bytes) against one bundle, without needing chainXor: only
 * the pad positions covered by block 0 are decrypted, and the inverted-LZ4 stream is decoded up to the first
 * byte that would need a later pad block. the decoded prefix must start with the SerializedFile signature.
 */
const block0Validates = (oracle: OracleBundle, block0: Uint8Array): boolean => {
	const cipher = oracle.data.subarray(oracle.block.offset, oracle.block.offset + oracle.block.compressedSize);
	const { buffer, firstUncertain } = decryptWithBlock0(cipher, block0);
	const prefix = decodeInvertedLz4Prefix(buffer, {
		inputEnd: firstUncertain,
		outputLength: SERIALIZED_FILE_SIGNATURE.length,
	});
	return hasSignature(prefix);
};

const hasSignature = (decoded: Uint8Array): boolean => {
	return bytesEqual(decoded.subarray(0, SERIALIZED_FILE_SIGNATURE.length), SERIALIZED_FILE_SIGNATURE);
};

/**
 * applies only the block-0 portion of the sampled pad to a payload block.
 *
 * @returns the partially decrypted buffer and the first input offset whose correct value would need a later
 *   pad block (so decoding must stop there)
 */
const decryptWithBlock0 = (
	cipher: Uint8Array,
	block0: Uint8Array,
): { buffer: Uint8Array; firstUncertain: number } => {
	const buffer = cipher.slice();
	const length = buffer.length;
	if (length <= 256) {
		const certain = Math.min(length, 16);
		for (let i = 0; i < certain; i++) {
			buffer[i] ^= block0[i];
		}
		return { buffer, firstUncertain: length > 16 ? 16 : length };
	}
	const blocks = Math.floor(length / 16);
	const step = blocks > 256 ? 1 : Math.floor(256 / blocks);
	const count = Math.min(blocks, 256);
	let firstUncertain = length;
	for (let i = 0; i < count; i++) {
		for (let j = 0; j < step; j++) {
			const padIndex = i * step + j;
			const position = i * 16 + j;
			if (padIndex < 16) {
				buffer[position] ^= block0[padIndex];
			} else {
				firstUncertain = Math.min(firstUncertain, position);
			}
		}
	}
	return { buffer, firstUncertain };
};

// #endregion

// #region chainXor

/**
 * recovers the 64-bit chainXor. it's VM-computed in this build, so we first try any 64-bit immediate present
 * in the binary (robust if a future/other build keeps it as a plain `movabs` or data constant), then fall
 * back to a supplied value. either way it's validated by a full bundle decode.
 *
 * @throws {Error} if neither a scanned nor a supplied value validates
 */
const deriveChainXor = (
	unity: PeImage,
	cipher: BundleKeyMaterial,
	oracles: OracleBundle[],
	fallback: KeyConfig | undefined,
	log: (message: string) => void,
): string => {
	const validates = (chainXor: bigint): boolean => {
		const pad = deriveBundlePad({ ...cipher, chainXor });
		return oracles.every((oracle) => fullyDecodes(oracle, pad));
	};

	const candidates = collectImmediates(unity);
	log(`testing ${candidates.size} binary immediates for chainXor`);
	for (const candidate of candidates) {
		if (validates(candidate)) {
			log('chainXor: recovered from a binary immediate');
			return toHex64(candidate);
		}
	}

	if (fallback?.bundle.chainXor !== undefined) {
		const chainXor = BigInt(`0x${fallback.bundle.chainXor}`);
		if (validates(chainXor)) {
			log('chainXor: validated supplied value (not recoverable from this build)');
			return toHex64(chainXor);
		}
		throw new Error('supplied chainXor does not decrypt the install bundles');
	}
	throw new Error('chainXor is VM-computed in this build and must be supplied via --keys-from');
};

/** fully decrypts and decompresses a bundle's first block and checks the SerializedFile signature */
const fullyDecodes = (oracle: OracleBundle, pad: Uint8Array): boolean => {
	const buffer = oracle.data.slice(oracle.block.offset, oracle.block.offset + oracle.block.compressedSize);
	try {
		applyBundlePad(buffer, pad);
		const decoded = decodeInvertedLz4Block(buffer, oracle.block.decompressedSize);
		return hasSignature(decoded);
	} catch {
		return false;
	}
};

/** collects distinct 64-bit immediates loaded by `movabs reg, imm64` across the image's code sections */
const collectImmediates = (unity: PeImage): Set<bigint> => {
	const values = new Set<bigint>();
	for (const section of codeSections(unity)) {
		const end = section.rawOffset + section.rawSize - 10;
		const view = new DataView(unity.data.buffer, unity.data.byteOffset, unity.data.byteLength);
		for (let i = section.rawOffset; i < end; i++) {
			const rex = unity.data[i];
			const op = unity.data[i + 1];
			// movabs r64, imm64 == REX.W (0x48/0x49) + (0xB8..0xBF)
			if ((rex === 0x48 || rex === 0x49) && op >= 0xb8 && op <= 0xbf) {
				values.add(view.getBigUint64(i + 2, true));
			}
		}
	}
	return values;
};

const toHex64 = (value: bigint): string => {
	return value.toString(16).padStart(16, '0');
};

// #endregion
