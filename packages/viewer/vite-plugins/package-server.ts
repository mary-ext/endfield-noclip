import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, normalize, sep } from 'node:path';

import { CORE_ARCHIVE } from '@endfield-noclip/package-format/format';

import type { Connect, Plugin } from 'vite';

import { DEV_PACKAGES_INDEX, DEV_PACKAGES_PREFIX, type DevPackage } from '../src/package/dev-packages.ts';

/**
 * serves locally extracted viewer packages to the dev and preview servers, with HTTP range support so the
 * viewer can read single blobs out of the archives. `GET /packages/index.json` lists the directories holding
 * a core archive.
 *
 * @param root directory whose subdirectories are packages
 * @returns the plugin
 */
export const packageServer = (root: string): Plugin => {
	const handle = async (req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> => {
		const url = new URL(req.url ?? '/', 'http://localhost');
		if (!url.pathname.startsWith(DEV_PACKAGES_PREFIX)) {
			next();
			return;
		}
		const rest = decodeURIComponent(url.pathname.slice(DEV_PACKAGES_PREFIX.length));
		if (rest === DEV_PACKAGES_INDEX) {
			await listPackages(root, res);
			return;
		}
		const path = normalize(join(root, rest));
		if (!path.startsWith(root + sep)) {
			res.statusCode = 403;
			res.end();
			return;
		}
		await serveFile(path, req, res);
	};
	const middleware: Connect.NextHandleFunction = (req, res, next) => {
		handle(req, res, next).catch((err: unknown) => {
			res.statusCode = 500;
			res.end(String(err));
		});
	};

	return {
		name: 'endfield-noclip:package-server',
		configureServer(server) {
			server.middlewares.use(middleware);
		},
		configurePreviewServer(server) {
			server.middlewares.use(middleware);
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

const serveFile = async (path: string, req: IncomingMessage, res: ServerResponse): Promise<void> => {
	const info = await stat(path).catch(() => null);
	if (!info?.isFile()) {
		res.statusCode = 404;
		res.end();
		return;
	}
	// archives keep their names across re-packs, so revalidate instead of caching blindly
	res.setHeader('cache-control', 'no-cache');
	res.setHeader('last-modified', info.mtime.toUTCString());
	const since = req.headers['if-modified-since'];
	// Last-Modified has whole-second precision
	if (since !== undefined && Math.floor(info.mtimeMs / 1000) * 1000 <= Date.parse(since)) {
		res.statusCode = 304;
		res.end();
		return;
	}
	res.setHeader('accept-ranges', 'bytes');
	res.setHeader('content-type', 'application/octet-stream');

	let start = 0;
	let end = info.size - 1;
	const range = req.headers.range;
	if (range !== undefined) {
		const match = /^bytes=(\d*)-(\d*)$/.exec(range);
		if (match === null) {
			res.statusCode = 416;
			res.end();
			return;
		}
		if (match[1] === '') {
			start = Math.max(0, info.size - Number(match[2]));
		} else {
			start = Number(match[1]);
			if (match[2] !== '') {
				end = Math.min(end, Number(match[2]));
			}
		}
		if (start > end || start >= info.size) {
			res.statusCode = 416;
			res.setHeader('content-range', `bytes */${info.size}`);
			res.end();
			return;
		}
		res.statusCode = 206;
		res.setHeader('content-range', `bytes ${start}-${end}/${info.size}`);
	}
	res.setHeader('content-length', String(end - start + 1));
	if (req.method === 'HEAD') {
		res.end();
		return;
	}
	createReadStream(path, { start, end }).pipe(res);
};
