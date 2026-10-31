import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { KeyConfig } from '../config.ts';

/**
 * scrapes key material from local checkouts of third-party tools that already embed it, so this project never
 * has to carry the keys itself.
 *
 * recognized sources, looked for in each given directory and its `map-extractor` and `animestudio`
 * subdirectories:
 *
 * - An1X3R/Endfield-map-extractor: `src/extractor_core/vfs.py` (VFS key)
 * - Escartem/AnimeStudio: `AnimeStudio/Crypto/CryptoHelper.cs` + `VFSUtils.cs` (bundle cipher)
 *
 * @param dirs directories to search
 * @returns the assembled key config
 * @throws {Error} naming whichever keys couldn't be found
 */
export const importKeys = async (dirs: string[]): Promise<KeyConfig> => {
	let vfsKey: string | undefined;
	let bundle: KeyConfig['bundle'] | undefined;

	for (const dir of dirs) {
		for (const candidate of [dir, join(dir, 'map-extractor'), join(dir, 'animestudio')]) {
			const vfsPy = join(candidate, 'src/extractor_core/vfs.py');
			if (vfsKey === undefined && existsSync(vfsPy)) {
				// oxlint-disable-next-line no-await-in-loop -- the first source found wins
				const text = await readFile(vfsPy, 'utf8');
				const match = /DEFAULT_VFS_KEY_HEX\s*=\s*\(([^)]*)\)/.exec(text);
				if (match) {
					vfsKey = [...match[1].matchAll(/"([0-9a-fA-F]+)"/g)].map((m) => m[1]).join('');
				}
			}

			const helperCs = join(candidate, 'AnimeStudio/Crypto/CryptoHelper.cs');
			const utilsCs = join(candidate, 'AnimeStudio/Crypto/VFSUtils.cs');
			if (bundle === undefined && existsSync(helperCs) && existsSync(utilsCs)) {
				// oxlint-disable-next-line no-await-in-loop -- the first source found wins
				const [helper, utils] = await Promise.all([readFile(helperCs, 'utf8'), readFile(utilsCs, 'utf8')]);
				const array = (name: string): string | undefined => {
					const body = new RegExp(`\\b${name}\\s*=\\s*new byte\\[\\]\\s*\\{([^}]*)\\}`).exec(helper)?.[1];
					return body && [...body.matchAll(/0x([0-9A-Fa-f]{2})/g)].map((m) => m[1]).join('');
				};
				const chainXor = /InitKeys\(CryptoHelper\.VFSAESSBox,[^)]*?0x([0-9A-Fa-f]+)UL/.exec(utils)?.[1];
				const sbox = array('VFSAESSBox');
				const key = array('VFSAESKey');
				const iv = array('VFSAESIV');
				if (sbox && key && iv && chainXor) {
					bundle = { sbox, key, iv, chainXor };
				}
			}
		}
	}

	const missing = [
		vfsKey === undefined && 'vfsKey (from Endfield-map-extractor)',
		bundle === undefined && 'bundle cipher (from AnimeStudio)',
	];
	if (vfsKey === undefined || bundle === undefined) {
		throw new Error(`couldn't find: ${missing.filter(Boolean).join(', ')}`);
	}
	return { vfsKey, bundle };
};
