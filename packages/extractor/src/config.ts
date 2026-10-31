import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { fromHex } from '@endfield-noclip/formats/binary/binary-reader';

/**
 * local-only configuration. it holds decryption keys, so it lives in a gitignored `*.local.json` file and is
 * never committed or bundled.
 */
export interface LocalConfig {
	/** path to the install's `Endfield_Data` directory */
	gameData: string;
	keys: KeyConfig;
}

/** key material as stored in the local config, hex-encoded */
export interface KeyConfig {
	/** 32-byte ChaCha20 key for `.blc` catalogs and encrypted logical files, hex */
	vfsKey: string;
	/** parameters of the bundle block cipher (AES-128 with a custom S-box, used as a keystream) */
	bundle: {
		sbox: string;
		key: string;
		iv: string;
		/** 64-bit constant mixed into the keystream chain, hex */
		chainXor: string;
	};
}

/** decoded key material */
export interface Keys {
	vfsKey: Uint8Array;
	bundle: {
		sbox: Uint8Array;
		key: Uint8Array;
		iv: Uint8Array;
		chainXor: bigint;
	};
}

export const DEFAULT_CONFIG_PATH = 'endfield.local.json';

/**
 * @param path config file; defaults to `endfield.local.json` in the working directory
 * @returns the parsed config
 * @throws {Error} with setup instructions if the file is missing or incomplete
 */
export const loadConfig = async (path = DEFAULT_CONFIG_PATH): Promise<LocalConfig> => {
	let text: string;
	try {
		text = await readFile(path, 'utf8');
	} catch {
		throw new Error(
			`config file ${resolve(path)} not found. create it with \`pnpm extract init --game <Endfield_Data> --keys-from <dir>\``,
		);
	}
	const config: unknown = JSON.parse(text);
	if (!isLocalConfig(config)) {
		throw new Error(`config file ${resolve(path)} is missing \`gameData\` or parts of \`keys\``);
	}
	return config;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
	return typeof value === 'object' && value !== null;
};

const isLocalConfig = (value: unknown): value is LocalConfig => {
	if (!isRecord(value) || typeof value.gameData !== 'string' || !isRecord(value.keys)) {
		return false;
	}
	const { vfsKey, bundle } = value.keys;
	return (
		typeof vfsKey === 'string' &&
		isRecord(bundle) &&
		['sbox', 'key', 'iv', 'chainXor'].every((field) => typeof bundle[field] === 'string')
	);
};

/**
 * @param path destination file
 * @param config config to write
 */
export const saveConfig = async (path: string, config: LocalConfig): Promise<void> => {
	await writeFile(path, `${JSON.stringify(config, null, '\t')}\n`, { mode: 0o600 });
};

/**
 * @param config key section of the local config
 * @returns decoded key material
 * @throws {Error} if any key has the wrong length
 */
export const decodeKeys = (config: KeyConfig): Keys => {
	const keys: Keys = {
		vfsKey: fromHex(config.vfsKey),
		bundle: {
			sbox: fromHex(config.bundle.sbox),
			key: fromHex(config.bundle.key),
			iv: fromHex(config.bundle.iv),
			chainXor: BigInt(`0x${config.bundle.chainXor}`),
		},
	};
	if (keys.vfsKey.length !== 32) {
		throw new Error('keys.vfsKey must be 32 bytes');
	}
	if (keys.bundle.sbox.length !== 256 || keys.bundle.key.length !== 16 || keys.bundle.iv.length !== 16) {
		throw new Error('keys.bundle must have a 256-byte sbox, 16-byte key and 16-byte iv');
	}
	return keys;
};
