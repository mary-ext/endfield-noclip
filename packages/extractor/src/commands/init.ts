import { parseArgs } from 'node:util';

import { DEFAULT_CONFIG_PATH, decodeKeys, saveConfig, type KeyConfig } from '../config.ts';
import { deriveKeys, resolveGameData } from '../hg/key-derive.ts';
import { importKeys } from '../hg/key-import.ts';
import { Vfs, VfsGroup } from '../hg/vfs.ts';

export const summary = `write ${DEFAULT_CONFIG_PATH}: --game <install or Endfield_Data> [--keys-from <dir>...]`;

export const run = async (args: string[]): Promise<void> => {
	const { values } = parseArgs({
		args,
		options: {
			config: { type: 'string', default: DEFAULT_CONFIG_PATH },
			game: { type: 'string' },
			'keys-from': { type: 'string', multiple: true },
		},
	});
	if (values.game === undefined) {
		throw new Error('init needs --game <install root or Endfield_Data>');
	}

	// keys recoverable from the install are derived; the rest (and overrides) come from --keys-from
	let fallback: KeyConfig | undefined;
	if (values['keys-from'] !== undefined) {
		fallback = await importKeys(values['keys-from']);
	}
	const keys = await deriveKeys(values.game, { fallback });

	const gameData = resolveGameData(values.game);
	// re-open the VFS with the final keys so a bad key fails here, not on first use
	const vfs = new Vfs(gameData, decodeKeys(keys).vfsKey);
	try {
		const bundle = await vfs.group(VfsGroup.Bundle);
		await saveConfig(values.config, { gameData, keys });
		console.log(`wrote ${values.config}; Bundle catalog holds ${bundle.catalog.fileCount} files`);
	} finally {
		await vfs.close();
	}
};
