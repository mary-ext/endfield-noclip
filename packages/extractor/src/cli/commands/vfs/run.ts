import { withContext } from '../../../install/context.ts';
import { VfsGroup } from '../../../install/vfs.ts';
import { errorText } from '../../../util/errors.ts';
import { save } from '../../helpers.ts';

import type { VfsArgs } from './parser.ts';

const GROUP_NAMES = new Map<string, string>(
	Object.entries(VfsGroup).map(([name, hash]) => [name.toLowerCase(), hash]),
);

const resolveGroup = (input: string): string => GROUP_NAMES.get(input.toLowerCase()) ?? input;

/**
 * runs `endfield-extract vfs`
 *
 * @param args parsed CLI arguments
 */
export const runVfs = async (args: VfsArgs): Promise<void> => {
	await withContext(args.config, async ({ vfs }) => {
		switch (args.subcommand) {
			case 'groups': {
				const hashes = await vfs.listGroups();
				const mounted = await Promise.allSettled(hashes.map((hash) => vfs.group(hash)));
				for (const [i, result] of mounted.entries()) {
					const hash = hashes[i];
					if (result.status === 'rejected') {
						console.log(`${hash}  (unreadable: ${errorText(result.reason)})`);
						continue;
					}
					const { catalog } = result.value;
					const gib = (catalog.chunksLength / 1024 ** 3).toFixed(2);
					console.log(
						`${hash}  ${catalog.groupName.padEnd(20)} ${String(catalog.fileCount).padStart(7)} files  ${gib} GiB`,
					);
				}
				break;
			}
			case 'ls': {
				for (const entry of (await vfs.group(resolveGroup(args.group))).catalog) {
					if (args.filter === undefined || args.filter.test(entry.name)) {
						console.log(
							`${String(entry.length).padStart(11)}  ${entry.ivSeed === null ? ' ' : 'E'}  ${entry.name}`,
						);
					}
				}
				break;
			}
			case 'cat': {
				const data = await vfs.read(resolveGroup(args.group), args.path);
				await save(args.output, data);
				console.log(`wrote ${data.length} bytes to ${args.output}`);
				break;
			}
		}
	});
};
