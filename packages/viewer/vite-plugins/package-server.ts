import { open, readdir, stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { join, resolve, sep } from 'node:path';

import { CORE_ARCHIVE } from '@endfield-noclip/package-format/manifest';

import sirv from 'sirv';
import type { Connect, Plugin } from 'vite';

import { DEV_PACKAGES_INDEX, DEV_PACKAGES_PREFIX, type DevPackage } from '../src/package/dev-packages.ts';

/**
 * serves locally extracted viewer packages to the dev and preview servers as plain static files, as a static
 * host answering multi-range requests would, plus `GET /packages/index.json` listing the directories holding
 * a core archive.
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
		// sirv answers one range; the viewer asks for several of an archive at once
		const ranges = parseRanges(req.headers.range);
		if (ranges !== null && ranges.length > 1 && req.method === 'GET') {
			sendRanges(root, req.url ?? '/', ranges, res).catch((err: unknown) => {
				if (!res.headersSent) {
					res.statusCode = 500;
				}
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

/** a requested byte range, `[first, last]` */
type Range = [first: number, last: number];

/** @returns the ranges of a `bytes=<first>-<last>,…` header, or `null` for any other form */
const parseRanges = (header: string | undefined): Range[] | null => {
	const match = /^bytes=(\d+-\d+(?:,\s*\d+-\d+)*)$/.exec(header ?? '');
	if (match === null) {
		return null;
	}
	return match[1].split(',').map((range): Range => {
		const [first, last] = range.trim().split('-').map(Number);
		return [first, last];
	});
};

const BOUNDARY = 'endfield-noclip-ranges';

/** answers a multi-range request with `multipart/byteranges` (RFC 9110 §14.6), a part per range as asked */
const sendRanges = async (root: string, url: string, ranges: Range[], res: ServerResponse): Promise<void> => {
	const path = resolve(root, `.${decodeURIComponent(new URL(url, 'http://localhost').pathname)}`);
	if (!path.startsWith(root + sep)) {
		res.statusCode = 403;
		res.end();
		return;
	}
	const file = await open(path).catch(() => null);
	if (file === null) {
		res.statusCode = 404;
		res.end();
		return;
	}
	try {
		const { size } = await file.stat();
		if (ranges.some(([first, last]) => first > last || last >= size)) {
			res.statusCode = 416;
			res.setHeader('content-range', `bytes */${size}`);
			res.end();
			return;
		}
		const heads = ranges.map(([first, last]) =>
			Buffer.from(
				`--${BOUNDARY}\r\ncontent-type: application/octet-stream\r\ncontent-range: bytes ${first}-${last}/${size}\r\n\r\n`,
			),
		);
		const tail = Buffer.from(`--${BOUNDARY}--\r\n`);
		let length = tail.length;
		for (const [i, [first, last]] of ranges.entries()) {
			length += heads[i].length + last - first + 1 + 2;
		}
		// one buffer, one write: the parts are small and the viewer reads the answer whole
		const body = Buffer.allocUnsafe(length);
		let at = 0;
		for (const [i, [first, last]] of ranges.entries()) {
			at += heads[i].copy(body, at);
			// oxlint-disable-next-line eslint/no-await-in-loop -- sequential reads of one handle
			const { bytesRead } = await file.read(body, at, last - first + 1, first);
			if (bytesRead !== last - first + 1) {
				throw new Error(`short read of ${path} at ${first}`);
			}
			at += bytesRead;
			at += body.write('\r\n', at);
		}
		tail.copy(body, at);
		res.statusCode = 206;
		res.setHeader('content-type', `multipart/byteranges; boundary=${BOUNDARY}`);
		res.setHeader('content-length', length);
		res.setHeader('cache-control', 'no-cache');
		res.end(body);
	} finally {
		await file.close();
	}
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
