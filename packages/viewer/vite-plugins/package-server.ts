import { readdir, stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';

import { CORE_ARCHIVE } from '@endfield-noclip/package-format/format';

import sirv from 'sirv';
import type { Connect, Plugin } from 'vite';

import { DEV_PACKAGES_INDEX, DEV_PACKAGES_PREFIX, type DevPackage } from '../src/package/dev-packages.ts';

/**
 * serves locally extracted viewer packages to the dev and preview servers as plain static files, as a static
 * host would, plus `GET /packages/index.json` listing the directories holding a core archive.
 *
 * @param root directory whose subdirectories are packages
 * @returns the plugin
 */
export const packageServer = (root: string): Plugin => {
	// `dev` looks files up per request, since packages are rewritten while the server runs
	const files = sirv(root, { dev: true, etag: true, extensions: [] });
	const middleware: Connect.NextHandleFunction = (req, res) => {
		// mounted under the prefix, so the URL is package-relative
		if (new URL(req.url ?? '/', 'http://localhost').pathname === `/${DEV_PACKAGES_INDEX}`) {
			listPackages(root, res).catch((err: unknown) => {
				res.statusCode = 500;
				res.end(String(err));
			});
			return;
		}
		// without `next`, a missing file is a 404 rather than the app's index page
		files(req, res);
	};

	const prefix = DEV_PACKAGES_PREFIX.slice(0, -1);
	return {
		name: 'endfield-noclip:package-server',
		configureServer(server) {
			server.middlewares.use(prefix, middleware);
		},
		configurePreviewServer(server) {
			server.middlewares.use(prefix, middleware);
		},
	};
};

const listPackages = async (root: string, res: ServerResponse): Promise<void> => {
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	const found = await Promise.all(
		entries
			// hidden directories are the packer's staging and replaced packages
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
			.map(async (entry): Promise<DevPackage | null> => {
				const core = await stat(join(root, entry.name, CORE_ARCHIVE)).catch(() => null);
				return core?.isFile() ? { name: entry.name, coreSize: core.size } : null;
			}),
	);
	const packages = found.filter((entry) => entry !== null).toSorted((a, b) => a.name.localeCompare(b.name));
	res.setHeader('content-type', 'application/json');
	res.setHeader('cache-control', 'no-cache');
	res.end(JSON.stringify({ packages }));
};
