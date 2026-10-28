import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { CORE_ARCHIVE } from '@endfield-noclip/package-format/format';

import { parseBounds, parseZstdLevel } from '../cli-args.ts';
import { withContext } from '../context.ts';
import { packScene, type PackReport } from '../pack/packer.ts';

export const summary =
	'write a viewer package: pack <scene> [-o <dir>] [--level <id>] [--bounds xmin,xmax,zmin,zmax]';

const USAGE = `usage:
  pack <scene> [-o <dir>] [--level <id>] [--bounds xmin,xmax,zmin,zmax] [--zstd-level n]
       [--texture-zstd-level n] [--jobs n] [--cache <dir> | --no-cache] [--no-assets] [--json]

writes the package for one streaming scene (e.g. map02). --level keeps the content one level owns and the
terrain under its cells; --bounds keeps content whose centre lies in the world x, z rectangle. the output
directory must be empty, absent, or hold a previous package; it defaults to out/<scene>[-<level>] at the
repository root, which git ignores. --no-assets skips geometry, material and texture conversion, leaving
their table entries pending. texture blobs use their own zstd level (default 9; 19 saves ~2% at 10× the time). --jobs sets the
worker threads converting meshes and textures (default: one per core but one, at most 8).

converted meshes and textures, and every blob, are cached across packs (default out/.cache): a re-pack
converts only what the install or the converter changed. the cache keeps what the packages it built hold and
deletes the rest after each pack; a package directory deleted by hand releases its share at the next pack.
--no-cache converts everything and keeps nothing.`;

/** default worker count at most; each worker holds ~400 MB of its own catalogs and caches */
const MAX_DEFAULT_JOBS = 8;

/** the repository's gitignored output directory */
const DEFAULT_OUT = new URL('../../../../out/', import.meta.url);

export const run = async (args: string[]): Promise<void> => {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			config: { type: 'string' },
			output: { type: 'string', short: 'o' },
			level: { type: 'string' },
			bounds: { type: 'string' },
			'zstd-level': { type: 'string', default: '19' },
			'texture-zstd-level': { type: 'string', default: '9' },
			jobs: {
				type: 'string',
				default: String(Math.max(1, Math.min(MAX_DEFAULT_JOBS, availableParallelism() - 1))),
			},
			cache: { type: 'string' },
			'no-cache': { type: 'boolean', default: false },
			'no-assets': { type: 'boolean', default: false },
			json: { type: 'boolean', default: false },
		},
	});
	const [scene] = positionals;
	if (scene === undefined) {
		throw new Error(USAGE);
	}
	const level = values.level ?? null;
	const outDir =
		values.output === undefined
			? resolve(new URL(level === null ? scene : `${scene}-${level}`, DEFAULT_OUT).pathname)
			: resolve(values.output);
	const zstdLevel = parseZstdLevel(values['zstd-level'], '--zstd-level');
	const textureZstdLevel = parseZstdLevel(values['texture-zstd-level'], '--texture-zstd-level');
	const jobs = Number(values.jobs);
	if (!Number.isInteger(jobs) || jobs < 1) {
		throw new Error(`--jobs must be a positive integer, got ${values.jobs}`);
	}

	await withContext(values.config, async (context) => {
		console.error(`packing ${scene}${level === null ? '' : ` (${level})`} into ${outDir}`);
		const report = await packScene(context, {
			scene,
			outDir,
			level,
			bounds: values.bounds === undefined ? null : parseBounds(values.bounds),
			zstdLevel,
			textureZstdLevel,
			jobs,
			cacheDir: values['no-cache'] ? null : resolve(values.cache ?? new URL('.cache', DEFAULT_OUT).pathname),
			convertAssets: !values['no-assets'],
			log: (line) => console.error(line),
		});
		console.log(values.json ? JSON.stringify(report, null, '\t') : formatReport(report));
	});
};

const mb = (bytes: number): string => `${(bytes / 1e6).toFixed(2)} MB`;

const formatReport = (report: PackReport): string => {
	const lines = [`package ${report.outDir}: ${mb(report.totalBytes)} in ${report.archives.length} archives`];
	const total = Object.values(report.timings).reduce((sum, ms) => sum + ms, 0);
	lines.push(
		`timings: ${Object.entries(report.timings)
			.map(([name, ms]) => `${name} ${(ms / 1000).toFixed(1)} s`)
			.join(', ')}; total ${(total / 1000).toFixed(1)} s`,
	);
	lines.push(
		`entities: ${Object.entries(report.entities)
			.map(([name, count]) => `${name} ${count}`)
			.join(', ')}`,
	);
	const { instances, chains, assets, hlod, tree } = report;
	lines.push(`instances: detail ${instances.detail}, hlod ${instances.hlod}, resident ${instances.resident}`);
	lines.push(
		`chains: ${chains.count} templates, ${chains.draws} draws, ${chains.instancesPerChain.toFixed(1)} instances per template`,
	);
	lines.push(
		`assets: ${assets.geometries} geometries (${assets.ready.geometries} ready), ${assets.materials} materials ` +
			`(${assets.ready.materials} ready, ${assets.shaders} shaders), ${assets.textures} textures ` +
			`(${assets.ready.textures} ready); ${assets.unresolvedPaths} hashes without a path`,
	);
	const { conversion } = report;
	if (conversion !== null) {
		const { geometry } = conversion;
		lines.push(
			`geometry: ${geometry.count} blobs, ${mb(geometry.stored)} stored, ${mb(geometry.raw)} meshopt, ` +
				`${mb(geometry.gpuBytes)} on the GPU; ${geometry.vertices} vertices, ${geometry.triangles} triangles, ` +
				`${geometry.generatedTangents} with generated tangents`,
		);
		const groups = Object.entries(conversion.texturePieces).toSorted(([a], [b]) =>
			a === 'tail' ? -1 : b === 'tail' ? 1 : Number(a) - Number(b),
		);
		for (const [group, tally] of groups) {
			lines.push(
				`texture ${group === 'tail' ? 'mip tails' : `${group}² levels`}: ${tally.count} blobs, ` +
					`${mb(tally.stored)} stored, ${mb(tally.raw)} raw`,
			);
		}
		lines.push(
			`texture formats: ${Object.entries(conversion.textureFormats)
				.toSorted((a, b) => b[1] - a[1])
				.map(([format, count]) => `${format} ${count}`)
				.join(', ')}; ${conversion.textureDuplicates} duplicate objects merged`,
		);
		for (const [reason, count] of Object.entries(conversion.failures).toSorted((a, b) => b[1] - a[1])) {
			lines.push(`  failed ${String(count).padStart(5)} × ${reason}`);
		}
	}
	{
		const { environments } = report;
		lines.push(
			`environments: ${environments.profiles} profiles referencing ${environments.textures} textures ` +
				'(per level in debug/environments.json, `world env` explains the choice)',
		);
		for (const level of environments.levels) {
			const inherited = Object.entries(level.sections).map(([name, source]) => `${name} ${source}`);
			lines.push(
				`  ${level.level.padEnd(14)} ${level.phase ?? level.error ?? '(none)'}` +
					(inherited.length > 0 ? ` (${inherited.join(', ')})` : ''),
			);
		}
	}
	{
		const { water } = report;
		lines.push(
			`water: ${water.surfaces.packed} of ${water.surfaces.scene} surfaces, ${water.configs} configs, ` +
				`global ${water.global ?? '(none)'}, ${water.sectors.packed} of ${water.sectors.scene} sectors, ` +
				`${water.textures} textures` +
				(water.errors > 0 ? `; ${water.errors} errors (debug/water.json)` : ''),
		);
	}
	lines.push(
		`core members: ${Object.entries(report.coreMembers)
			.map(([path, size]) => `${path} ${mb(size)}`)
			.join(', ')}`,
	);
	if (report.cache !== null) {
		const { hits, swept } = report.cache;
		lines.push(
			`cache ${report.cache.dir}: ${hits.geometries} geometries and ${hits.textures} textures reused; ` +
				`swept ${swept.blobs} blobs and ${swept.memos} conversions (${mb(swept.bytes)})`,
		);
	}
	lines.push(`peak RSS ${(report.peakRss / 1e9).toFixed(2)} GB`);
	lines.push(
		`hlod: ${hlod.clusters} clusters (tiers ${hlod.tierCounts.join('/')}), ` +
			`${(hlod.nameMatchesPosition * 100).toFixed(1)}% centred in their named cell`,
	);
	lines.push(
		`tree: ${tree.nodes} nodes, ${tree.refs} refs (${Object.entries(tree.byKind)
			.map(([kind, count]) => `${kind} ${count}`)
			.join(', ')})`,
	);
	for (const [kind, blobs] of Object.entries(report.blobs)) {
		lines.push(`blobs ${kind}: ${blobs.count}, ${mb(blobs.stored)} stored, ${mb(blobs.raw)} raw`);
	}
	const shards = report.archives.filter((archive) => archive.name !== CORE_ARCHIVE);
	const core = report.archives.find((archive) => archive.name === CORE_ARCHIVE);
	if (core !== undefined) {
		lines.push(`${CORE_ARCHIVE}: ${mb(core.size)}, ${core.members} members, header ${core.headerLength} B`);
	}
	if (shards.length > 0) {
		const sizes = shards.map((archive) => archive.size).toSorted((a, b) => a - b);
		const headers = shards.map((archive) => archive.headerLength).toSorted((a, b) => a - b);
		lines.push(
			`${shards.length} shards: ${mb(sizes[0])}–${mb(sizes.at(-1)!)} (median ${mb(sizes[sizes.length >> 1])}), ` +
				`headers ${headers[0]}–${headers.at(-1)} B, ${shards.reduce((sum, a) => sum + a.members, 0)} members`,
		);
	}
	return lines.join('\n');
};
