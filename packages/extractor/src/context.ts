import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import { MemoryPackReader, MemoryPackSchema } from '@endfield-noclip/formats/endfield/memory-pack';
import { Il2CppMetadata } from '@endfield-noclip/formats/il2cpp/metadata';
import { PeImage } from '@endfield-noclip/formats/il2cpp/pe';
import { Il2CppRuntime } from '@endfield-noclip/formats/il2cpp/registration';

import { decodeKeys, DEFAULT_CONFIG_PATH, loadConfig, type Keys, type LocalConfig } from './config.ts';
import { AssetResolver } from './game/assets.ts';
import { WorldIndex } from './game/world-index.ts';
import { Vfs } from './hg/vfs.ts';

/** shared state for commands that read the install */
export interface Context {
	config: LocalConfig;
	keys: Keys;
	vfs: Vfs;
	world: WorldIndex;
	/** @returns the asset resolver over the bundle manifest, built on first use */
	resolver(): Promise<AssetResolver>;
	/**
	 * @returns a decoder for MemoryPack game data, its schema read from the install's IL2CPP metadata and
	 *   GameAssembly on first use
	 */
	memoryPack(): Promise<MemoryPackReader>;
}

/**
 * @param gameData the install's `Endfield_Data` directory
 * @param world its world index, for the string pool
 * @returns a MemoryPack reader with the build's schema
 * @throws {FormatError} if the metadata or binary don't have the expected shape
 */
const loadMemoryPack = async (gameData: string, world: WorldIndex): Promise<MemoryPackReader> => {
	const [metadata, image, pool] = await Promise.all([
		readFile(join(gameData, 'il2cpp_data', 'Metadata', 'global-metadata.dat')),
		readFile(join(gameData, '..', 'GameAssembly.dll')),
		world.stringPool(),
	]);
	const schema = new MemoryPackSchema(new Il2CppRuntime(new Il2CppMetadata(metadata), new PeImage(image)));
	return new MemoryPackReader(schema, (id) => {
		try {
			return pool.get(id);
		} catch (error) {
			if (error instanceof FormatError) {
				return undefined;
			}
			throw error;
		}
	});
};

/**
 * loads the local config, opens the VFS, runs `fn` and closes file handles afterwards
 *
 * @param configPath local config file
 * @param fn work to do
 * @returns whatever `fn` returns
 */
export const withContext = async <T>(
	configPath: string | undefined,
	fn: (context: Context) => Promise<T>,
): Promise<T> => {
	const config = await loadConfig(configPath ?? DEFAULT_CONFIG_PATH);
	const keys = decodeKeys(config.keys);
	const vfs = new Vfs(config.gameData, keys.vfsKey);
	const world = new WorldIndex(vfs);
	let resolver: Promise<AssetResolver> | undefined;
	let memoryPack: Promise<MemoryPackReader> | undefined;
	try {
		return await fn({
			config,
			keys,
			vfs,
			world,
			resolver: () => {
				resolver ??= world.manifest().then((manifest) => new AssetResolver({ vfs, keys }, manifest));
				return resolver;
			},
			memoryPack: () => {
				memoryPack ??= loadMemoryPack(config.gameData, world);
				return memoryPack;
			},
		});
	} finally {
		await vfs.close();
	}
};
