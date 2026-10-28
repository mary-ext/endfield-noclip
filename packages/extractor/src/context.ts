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
}

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
		});
	} finally {
		await vfs.close();
	}
};
