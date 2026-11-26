import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_ARCHIVE } from '@endfield-noclip/package-format/manifest';
import type { Rect } from '@endfield-noclip/package-format/values';

import { definite, mapDefined } from '@mary-ext/array-fns';

import { compareNumbers, compareStrings } from '../../../compare.ts';
import { DEFAULT_OUT } from '../../../config.ts';
import { withContext } from '../../../context.ts';
import { ignoreMissing } from '../../../errors.ts';
import { packScene } from '../../../pack/packer.ts';
import { PackedPackage } from '../../../pack/read-package.ts';
import type { PackReport } from '../../../pack/report.ts';
import { PackSession } from '../../../pack/session.ts';

import type { PackArgs } from './parser.ts';

interface PackTarget {
	scene: string;
	outDir: string;
	level: string | null;
	bounds: Rect | null;
	maxTextureSize?: number | null;
}

const discoverExistingPackages = async (outRoot: string): Promise<PackTarget[]> => {
	const entries = await ignoreMissing(readdir(outRoot, { withFileTypes: true }), []);
	const dirs = entries
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
		.map((entry) => entry.name)
		.toSorted(compareStrings);
	const targets: PackTarget[] = [];
	for (const name of dirs) {
		const outDir = join(outRoot, name);
		// oxlint-disable-next-line no-await-in-loop -- opens manifests sequentially to keep fd count low
		const pkg = await ignoreMissing(PackedPackage.open(outDir), null);
		if (pkg === null) {
			continue;
		}
		try {
			targets.push({
				scene: pkg.manifest.scene.id,
				outDir,
				level: pkg.manifest.subset?.level ?? null,
				bounds: pkg.manifest.subset?.bounds ?? null,
				maxTextureSize: pkg.manifest.maxTextureSize ?? null,
			});
		} finally {
			// oxlint-disable-next-line no-await-in-loop -- paired with open above
			await pkg[Symbol.asyncDispose]();
		}
	}
	return targets;
};

/**
 * runs `endfield-extract pack`
 *
 * @param args parsed CLI arguments
 */
export const runPack = async (args: PackArgs): Promise<void> => {
	const cacheDir =
		args.cache === null ? null : resolve(args.cache ?? fileURLToPath(new URL('.cache', DEFAULT_OUT)));

	let targets: PackTarget[];
	if (args.existing) {
		const outRoot = args.output === undefined ? fileURLToPath(DEFAULT_OUT) : resolve(args.output);
		targets = await discoverExistingPackages(outRoot);
		if (targets.length === 0) {
			throw new Error(`no packed packages found in ${outRoot}`);
		}
	} else {
		const level = args.level ?? null;
		let outDir: string;
		if (args.output === undefined) {
			const name = level === null ? args.scene : `${args.scene}-${level}`;
			outDir = resolve(new URL(name, DEFAULT_OUT).pathname);
		} else {
			outDir = resolve(args.output);
		}
		targets = [
			{
				scene: args.scene,
				outDir,
				level,
				bounds: args.bounds ?? null,
			},
		];
	}

	await withContext(args.config, async (context) => {
		const reports: PackReport[] = [];
		const session =
			targets.length > 1 ? await PackSession.open(context, { cacheDir, jobs: args.jobs }) : undefined;
		try {
			for (const target of targets) {
				console.error(
					`packing ${target.scene}${target.level === null ? '' : ` (${target.level})`} into ${target.outDir}`,
				);
				// oxlint-disable-next-line no-await-in-loop -- packs sequentially to avoid memory and cache contention
				const report = await packScene(context, {
					scene: target.scene,
					outDir: target.outDir,
					level: target.level,
					bounds: target.bounds,
					zstdLevel: args.zstdLevel,
					textureZstdLevel: args.textureZstdLevel,
					maxTextureSize: args.maxTextureSize ?? target.maxTextureSize ?? null,
					jobs: args.jobs,
					cacheDir,
					session,
					convertAssets: !args.noAssets,
					log: (line) => console.error(line),
				});
				reports.push(report);
				if (!args.json) {
					console.log(formatReport(report));
				}
			}
		} finally {
			const swept = await session?.close();
			if (swept != null && !args.json) {
				console.error(
					`cache sweep: swept ${swept.blobs} blobs and ${swept.memos} memos (${mb(swept.bytes)})`,
				);
			}
		}
		if (args.json) {
			console.log(JSON.stringify(args.existing ? reports : reports[0], null, '\t'));
		}
	});
};

const mb = (bytes: number): string => `${(bytes / 1e6).toFixed(2)} MB`;

const share = (value: number | null): string => (value === null ? '–' : `${(value * 100).toFixed(1)}%`);

const formatReport = (report: PackReport): string => {
	const reused = report.archives.filter((archive) => archive.reused);
	const lines = [
		`package ${report.outDir}: ${mb(report.totalBytes)} in ${report.archives.length} archives` +
			(reused.length === 0
				? ''
				: `, ${reused.length} (${mb(reused.reduce((sum, archive) => sum + archive.size, 0))}) reused from the previous package`),
	];
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
	lines.push(`instances: detail ${instances.detail}, hlod ${instances.hlod}, global ${instances.global}`);
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
				`${geometry.generatedTangents} with generated tangents` +
				(geometry.tangentUvConflicts === 0
					? ''
					: ` (${geometry.tangentUvConflicts} for one of several uv sets; tangentUvs in debug/assets.json)`),
		);
		const groups = Object.entries(conversion.texturePieces);
		groups.sort(([a], [b]) => (a === 'tail' ? -1 : b === 'tail' ? 1 : Number(a) - Number(b)));
		for (const [group, tally] of groups) {
			lines.push(
				`texture ${group === 'tail' ? 'mip tails' : `${group}² levels`}: ${tally.count} blobs, ` +
					`${mb(tally.stored)} stored, ${mb(tally.raw)} raw`,
			);
		}
		const textureFormats = Object.entries(conversion.textureFormats);
		textureFormats.sort((a, b) => b[1] - a[1]);
		lines.push(
			`texture formats: ${textureFormats
				.map(([format, count]) => `${format} ${count}`)
				.join(', ')}; ${conversion.textureDuplicates} duplicate objects merged`,
		);
		for (const [approximation, count] of Object.entries(conversion.textureApproximations)) {
			lines.push(`  approximated ${String(count).padStart(5)} × texture: ${approximation}`);
		}
		// oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy
		for (const [reason, count] of Object.entries(conversion.failures).sort((a, b) => b[1] - a[1])) {
			lines.push(`  failed ${String(count).padStart(5)} × ${reason}`);
		}
		{
			const unsupported = Object.entries(conversion.unsupportedMaterials);
			unsupported.sort((a, b) => b[1] - a[1]);
			const keywords = Object.values(conversion.keywordsNotDrawn);
			lines.push(
				`materials: ${unsupported.reduce((sum, [, count]) => sum + count, 0)} unsupported; ` +
					`${keywords.reduce((sum, count) => sum + count, 0)} uses of ${keywords.length} undrawn surface ` +
					'keywords (per material in debug/assets.json)',
			);
			const SHOWN = 12;
			for (const [reason, count] of unsupported.slice(0, SHOWN)) {
				lines.push(`  unsupported ${String(count).padStart(5)} × ${reason}`);
			}
			if (unsupported.length > SHOWN) {
				lines.push(`  … ${unsupported.length - SHOWN} more reasons`);
			}
		}
	}
	{
		const { environments } = report;
		lines.push(
			`environments: ${environments.posts} post profiles, phases referencing ${environments.textures} textures ` +
				'(per level in debug/environments.json, `scene env` explains the choice)' +
				(environments.problems > 0
					? `; ${environments.problems} inputs left out (debug/environments.json)`
					: ''),
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
			`water: ${water.surfaces.packed} of ${water.surfaces.scene} surfaces, ` +
				`${water.volumes.packed} of ${water.volumes.scene} volumes, ${water.configs} configs, ` +
				`global ${water.global ?? '(none)'}, ${water.sectors.packed} of ${water.sectors.scene} sectors` +
				(water.sectors.untiled > 0 ? ` (${water.sectors.untiled} without a tile)` : '') +
				', ' +
				`${water.textures} textures` +
				(water.errors > 0 ? `; ${water.errors} errors (debug/water.json)` : ''),
		);
	}
	if (report.terrain !== null) {
		const { tiles, withoutSurface, leavesWithoutSplat, orphanPages, layerProblem } = report.terrain;
		const missing = definite([
			withoutSurface > 0 ? `${withoutSurface} without a surface page` : null,
			leavesWithoutSplat > 0 ? `${leavesWithoutSplat} leaves without a splat page` : null,
			orphanPages > 0 ? `${orphanPages} pages of tiles without heights` : null,
			layerProblem === null ? null : `no close-up blend: the scene ${layerProblem}`,
		]);
		lines.push(
			`terrain: ${tiles} tiles` + (missing.length > 0 ? `; ${missing.join(', ')} (debug/terrain.json)` : ''),
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
			`cache ${report.cache.dir}: ${hits.materials} materials, ${hits.geometries} geometries and ` +
				`${hits.textures} textures reused; ` +
				`swept ${swept.blobs} blobs and ${swept.memos} conversions (${mb(swept.bytes)})`,
		);
	}
	lines.push(`peak RSS ${(report.peakRss / 1e9).toFixed(2)} GB`);
	{
		const { grid } = hlod;
		const misaligned = mapDefined(grid.aligned, (aligned, tier) =>
			aligned || hlod.tierCounts[tier] === 0 ? undefined : tier,
		);
		lines.push(
			`hlod: ${hlod.clusters} clusters (tiers ${hlod.tierCounts.join('/')}), ` +
				`${(hlod.nameMatchesPosition * 100).toFixed(1)}% centred in their tile; names on ${grid.cellSize} m ` +
				`cells from ${grid.origin.join(', ')} (${share(grid.agreement[0])} / ${share(grid.agreement[1])} agree)` +
				(misaligned.length === 0 ? '' : `, tiers ${misaligned.join('/')} straddle tree tiles`),
		);
	}
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
		const sizes = shards.map((archive) => archive.size);
		sizes.sort(compareNumbers);
		const headers = shards.map((archive) => archive.headerLength);
		headers.sort(compareNumbers);
		lines.push(
			`${shards.length} shards: ${mb(sizes[0])}–${mb(sizes.at(-1)!)} (median ${mb(sizes[sizes.length >> 1])}), ` +
				`headers ${headers[0]}–${headers.at(-1)} B, ${shards.reduce((sum, a) => sum + a.members, 0)} members`,
		);
	}
	return lines.join('\n');
};
