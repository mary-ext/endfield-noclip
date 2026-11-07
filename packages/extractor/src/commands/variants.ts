import { parseArgs } from 'node:util';

import { withContext } from '../context.ts';
import {
	loadSceneryVariants,
	resolveChunkFiles,
	selectedAreas,
	type AreaSelection,
} from '../game/state/scenery-variants.ts';

export const summary = 'inspect stream areas, progressions and selected chunk files';

/** command usage, available without opening the install */
export const usage = `usage:
  variants <scene> [--json]                   stream areas (chunk areaIds) and progression controllers
  variants <scene> --areas all|root|<id,…>    also list the chunk files that selection loads`;

export const run = async (args: string[]): Promise<void> => {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			config: { type: 'string' },
			json: { type: 'boolean', default: false },
			areas: { type: 'string' },
		},
	});
	const [scene] = positionals;
	if (scene === undefined) {
		throw new Error(usage);
	}

	await withContext(values.config, async ({ world }) => {
		const variants = await loadSceneryVariants(world, scene);
		let selection: { areas: number[]; files: string[] } | undefined;
		if (values.areas !== undefined) {
			const ids = selectedAreas(variants, await world.streamAreas(scene), parseAreas(values.areas));
			const files = resolveChunkFiles(await world.chunkFiles(), scene, ids);
			selection = { areas: [...ids].toSorted((a, b) => a - b), files: files.map((file) => file.name) };
		}
		if (values.json) {
			console.log(JSON.stringify({ ...variants, selection }, null, '\t'));
			return;
		}
		printVariants(variants);
		if (selection !== undefined) {
			console.log(`\n${selection.files.length} InitChunkData files for areas ${selection.areas.join(',')}`);
			for (const file of selection.files) {
				console.log(`  ${file}`);
			}
		}
	});
};

const parseAreas = (value: string): AreaSelection => {
	if (value === 'all' || value === 'root') {
		return value;
	}
	const ids = value.split(',').map((part) => (part.trim() === '' ? Number.NaN : Number(part)));
	if (!ids.every((id) => Number.isSafeInteger(id) && id >= 0)) {
		throw new Error(`--areas takes all, root or comma-separated area ids\n${usage}`);
	}
	return ids;
};

const printVariants = (variants: Awaited<ReturnType<typeof loadSceneryVariants>>): void => {
	console.log(`${variants.scene}: ${variants.areas.length} stream areas with static chunks`);
	console.log('        area  root  shown inside zones            files  entities  level');
	for (const area of variants.areas) {
		const inside = area.shownInside.join(',') || '-';
		console.log(
			`${String(area.id).padStart(12)}  ${area.rootVisible ? 'yes ' : '    '}  ${inside.padEnd(30)} ${String(area.chunkFiles).padStart(5)}  ${String(area.entities).padStart(8)}  ${area.levelId ?? '-'} ${area.levelName ?? ''}`,
		);
	}
	console.log(
		`\n${variants.progressions.length} progression controllers (DynamicStreaming LogicState levels)`,
	);
	console.log(
		'kind           key                            level                         levels (groups)       default',
	);
	for (const p of variants.progressions) {
		const levels = p.levels.map((level) => `${level}(${p.groupsPerLevel[level]})`).join(' ');
		console.log(
			`${p.kind.padEnd(14)} ${p.key.padEnd(30)} ${`${p.levelId ?? '-'} ${p.levelName ?? ''}`.padEnd(29)} ${levels.padEnd(21)} ${p.defaultLevel}`,
		);
	}
};
