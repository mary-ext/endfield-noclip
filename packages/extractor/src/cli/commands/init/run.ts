import { DEFAULT_CONFIG_PATH, decodeKeys, saveConfig, type KeyConfig } from '../../../install/config.ts';
import { deriveKeys, resolveGameData } from '../../../install/key-derive.ts';
import { importKeys } from '../../../install/key-import.ts';
import { Vfs, VfsGroup } from '../../../install/vfs.ts';

import type { InitArgs } from './parser.ts';

/**
 * runs `endfield-extract init`
 *
 * @param args parsed CLI arguments
 */
export const runInit = async (args: InitArgs): Promise<void> => {
	const configPath = args.config ?? DEFAULT_CONFIG_PATH;
	let fallback: KeyConfig | undefined;
	if (args.keysFrom.length > 0) {
		fallback = await importKeys([...args.keysFrom]);
	}
	const keys = await deriveKeys(args.game, { fallback });

	const gameData = resolveGameData(args.game);
	// re-open the VFS with the final keys so a bad key fails here, not on first use
	const vfs = new Vfs(gameData, decodeKeys(keys).vfsKey);
	try {
		const bundle = await vfs.group(VfsGroup.Bundle);
		await saveConfig(configPath, { gameData, keys });
		console.log(`wrote ${configPath}; Bundle catalog holds ${bundle.catalog.fileCount} files`);
	} finally {
		await vfs.close();
	}
};
