import { parseArgs } from 'node:util';

import { save } from '../cli-args.ts';
import { withContext } from '../context.ts';
import { errorText } from '../errors.ts';

export const summary = 'browse the VFS: groups | ls <group> [--filter re] | cat <group> <name> -o <file>';

export const run = async (args: string[]): Promise<void> => {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			config: { type: 'string' },
			filter: { type: 'string' },
			output: { type: 'string', short: 'o' },
		},
	});
	const [sub, group, name] = positionals;

	await withContext(values.config, async ({ vfs }) => {
		switch (sub) {
			case 'groups': {
				for (const hash of await vfs.listGroups()) {
					try {
						const { catalog } = await vfs.group(hash);
						const gib = (catalog.chunksLength / 1024 ** 3).toFixed(2);
						console.log(
							`${hash}  ${catalog.groupName.padEnd(20)} ${String(catalog.fileCount).padStart(7)} files  ${gib} GiB`,
						);
					} catch (error) {
						console.log(`${hash}  (unreadable: ${errorText(error)})`);
					}
				}
				break;
			}
			case 'ls': {
				if (group === undefined) {
					throw new Error('vfs ls needs a group hash');
				}
				const filter = values.filter === undefined ? undefined : new RegExp(values.filter, 'i');
				for (const entry of (await vfs.group(group)).files.values()) {
					if (filter === undefined || filter.test(entry.name)) {
						console.log(
							`${String(entry.length).padStart(11)}  ${entry.ivSeed === null ? ' ' : 'E'}  ${entry.name}`,
						);
					}
				}
				break;
			}
			case 'cat': {
				if (group === undefined || name === undefined || values.output === undefined) {
					throw new Error('vfs cat needs <group> <name> -o <file>');
				}
				const file = await vfs.find(group, name);
				if (file === undefined) {
					throw new Error(`${name} not found in ${group}`);
				}
				const data = await vfs.readVerified(file);
				await save(values.output, data);
				console.log(`wrote ${data.length} bytes to ${values.output}`);
				break;
			}
			default: {
				throw new Error('usage: vfs groups | ls <group> | cat <group> <name> -o <file>');
			}
		}
	});
};
