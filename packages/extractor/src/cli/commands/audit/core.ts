import { CORE_PATHS } from '@endfield-noclip/package-format/manifest';

import { PackedPackage, resolveCorePath } from '../../../pipeline/read-package.ts';
import { jsonReplacer } from '../../helpers.ts';

import type { AuditSubArgs } from './parser.ts';
import { packageDirsOf } from './shared.ts';

/**
 * runs `endfield-extract audit core`
 *
 * @param args parsed CLI arguments
 */
export const runAuditCore = async (args: AuditSubArgs<'core'>): Promise<void> => {
	const { packageDir } = packageDirsOf(args.scene, args.dir);
	await auditCore(packageDir, args.member, args.json);
};

const CORE_SHORTHANDS = new Map<string, string>(Object.entries(CORE_PATHS).map(([key, path]) => [path, key]));

const auditCore = async (packageDir: string, member: string | undefined, json: boolean): Promise<void> => {
	await using pkg = await PackedPackage.open(packageDir);
	if (member === undefined) {
		const files = pkg.coreFiles().map((file) => ({
			path: file.path,
			shorthand: CORE_SHORTHANDS.get(file.path) ?? null,
			size: file.size,
		}));
		if (json) {
			console.log(JSON.stringify(files, null, '\t'));
			return;
		}
		for (const file of files) {
			const alias = file.shorthand === null ? '' : `  (${file.shorthand})`;
			console.log(`${String(file.size).padStart(10)}  ${file.path}${alias}`);
		}
		console.error(`${files.length} members in core.czar`);
		return;
	}

	const resolved = resolveCorePath(member);
	switch (resolved) {
		case CORE_PATHS.geometries: {
			const table = await pkg.geometries();
			const entries = Array.from({ length: table.count }, (_, id) => ({ id, ...table.entry(id) }));
			console.log(JSON.stringify(entries, jsonReplacer, '\t'));
			return;
		}
		case CORE_PATHS.blobs: {
			console.log(JSON.stringify(await pkg.blobs(), jsonReplacer, '\t'));
			return;
		}
		case CORE_PATHS.chains: {
			console.log(JSON.stringify(await pkg.chains(), jsonReplacer, '\t'));
			return;
		}
		case CORE_PATHS.tree: {
			console.log(JSON.stringify(await pkg.tree(), jsonReplacer, '\t'));
			return;
		}
		case CORE_PATHS.lights: {
			console.log(JSON.stringify(await pkg.lights(), jsonReplacer, '\t'));
			return;
		}
		case CORE_PATHS.luts: {
			const table = await pkg.luts();
			console.log(
				JSON.stringify(
					{
						curves: table.curves.length,
						gradients: table.gradients.length,
						shapeMeshes: table.shapeMeshes.map((m, i) => ({
							id: i,
							primSize: m.primSize,
							vertices: m.positions.length / 3,
							primitives: m.areaCdf.length,
							hasNormals: m.normals !== null,
							hasColor: m.hasColor,
							totalArea: m.areaCdf.at(-1) ?? 0,
						})),
					},
					null,
					'\t',
				),
			);
			return;
		}
		case CORE_PATHS.irradiance: {
			const table = await pkg.irradiance();
			const entries = Array.from({ length: table.keys.length }, (_, i) => ({
				key: `0x${table.keys[i].toString(16).padStart(8, '0')}`,
				level: table.keys[i] >>> 24,
				blob: table.blobs[i],
				group: table.groups[i],
			}));
			console.log(JSON.stringify(entries, null, '\t'));
			return;
		}
		default: {
			const available = pkg.coreFiles().map((file) => {
				const alias = CORE_SHORTHANDS.get(file.path);
				return alias === undefined ? file.path : `${file.path} (${alias})`;
			});
			if (!pkg.coreFiles().some((file) => file.path === resolved)) {
				const manifestNote =
					member === 'manifest.json' || member === 'manifest'
						? ' (manifest.json lives at the package root, not inside core.czar)'
						: '';
				throw new Error(
					`core.czar has no member ${resolved}${manifestNote}\navailable members:\n  ${available.join('\n  ')}`,
				);
			}
			const bytes = await pkg.readCore(resolved);
			if (resolved.endsWith('.json') || resolved.endsWith('.json.zst')) {
				const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
				console.log(JSON.stringify(parsed, null, '\t'));
				return;
			}
			console.log(JSON.stringify({ path: resolved, bytes: bytes.byteLength }, null, '\t'));
		}
	}
};
