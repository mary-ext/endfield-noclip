import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import { readLevelDataInteractives } from '@endfield-noclip/formats/endfield/level-interactives';
import { parseSparkTable } from '@endfield-noclip/formats/hg/spark-buffer';

import { definite } from '@mary-ext/array-fns';

import { readViewStates, records, text } from '../../../game/interactives/view-state-poses.ts';
import { toScript } from '../../../game/script-drivers.ts';
import type { WorldIndex } from '../../../game/world/world-index.ts';
import { type Context, withContext } from '../../../install/context.ts';
import { VfsGroup } from '../../../install/vfs.ts';
import { compareNatural, compareStrings } from '../../../util/compare.ts';
import { errorText } from '../../../util/errors.ts';
import { mapPool } from '../../../util/pool.ts';
import { collectTargets, hashText, jsonReplacer, parseHash } from '../../helpers.ts';

import type { DataArgs } from './parser.ts';

/**
 * runs `endfield-extract data`
 *
 * @param args parsed CLI arguments
 */
export const runData = async (args: DataArgs): Promise<void> => {
	await withContext(args.config, async (context) => {
		switch (args.subcommand) {
			case 'paths': {
				await findPaths(context.world, args.pattern, args.limit, args.json);
				break;
			}
			case 'resolve': {
				const targets = await collectTargets(args.targets, args.stdin);
				if (targets.length === 0) {
					throw new Error('data resolve needs at least one path/hash or --stdin');
				}
				await resolveMany(context.world, targets, args.json);
				break;
			}
			case 'tables': {
				await listTables(context, args.filter);
				break;
			}
			case 'table': {
				await readTable(context, args.name, {
					key: args.key,
					filter: args.filter,
					limit: args.limit,
					json: args.json,
				});
				break;
			}
			case 'scripts': {
				await readScripts(context, args.level, {
					id: args.id,
					filter: args.filter,
					limit: args.limit,
					json: args.json,
				});
				break;
			}
			case 'interactives': {
				await readInteractives(context, args.level, {
					id: args.id,
					filter: args.filter,
					limit: args.limit,
					json: args.json,
				});
				break;
			}
			case 'view-states': {
				await readViewStatesCmd(context, {
					model: args.model,
					emissive: args.emissive,
					filter: args.filter,
					limit: args.limit,
					json: args.json,
				});
				break;
			}
		}
	});
};

// #region paths & resolve

const findPaths = async (world: WorldIndex, pattern: RegExp, limit: number, json: boolean): Promise<void> => {
	const [main, initial, manifest] = await Promise.all([
		world.pathHash(),
		world.initPathHash(),
		world.manifest(),
	]);
	const rows: { hash: string; path: string; bundles: string[] }[] = [];
	const seen = new Set<string>();
	for (const table of [main, initial]) {
		for (const [hash, path] of table.entries((candidate) => pattern.test(candidate))) {
			const key = `${hash}:${path}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			const bundles = [
				...new Set(manifest.findAssets(hash).map((asset) => manifest.bundleName(asset.bundleIndex))),
			];
			rows.push({ hash: hashText(hash), path, bundles });
			if (rows.length >= limit) {
				break;
			}
		}
		if (rows.length >= limit) {
			break;
		}
	}
	if (json) {
		console.log(JSON.stringify(rows, null, '\t'));
	} else {
		for (const row of rows) {
			console.log(`${row.hash}\t${row.path}\t${row.bundles.join(',') || '-'}`);
		}
	}
	console.error(
		`${rows.length} matches${rows.length === limit ? ' (limit reached; raise --limit for more)' : ''}`,
	);
};

const resolveMany = async (world: WorldIndex, queries: readonly string[], json: boolean): Promise<void> => {
	const manifest = await world.manifest();
	const jsonOut: unknown[] = [];
	for (const [index, query] of queries.entries()) {
		if (!json && index > 0) {
			console.log('');
		}
		let hashes: bigint[];
		let path: string | null = null;
		const parsed = parseHash(query);
		if (parsed !== null) {
			hashes = [parsed];
			// oxlint-disable-next-line no-await-in-loop -- preserves input order for batch output
			path = (await world.pathOf(parsed)) ?? null;
			if (!json) {
				console.log(`hash ${parsed} (${hashText(parsed)}) → ${path ?? '(not in StringPathHash)'}`);
			}
		} else {
			// oxlint-disable-next-line no-await-in-loop -- preserves input order for batch output
			hashes = await world.hashesOf(query);
			path = query;
			if (hashes.length === 0) {
				if (queries.length === 1) {
					throw new Error(`${query} is not in StringPathHash`);
				}
				if (json) {
					jsonOut.push({ query, error: 'not in StringPathHash' });
				} else {
					console.log(`${query} → (not in StringPathHash)`);
				}
				continue;
			}
			if (!json) {
				console.log(`${query} → hash ${hashes.map((hash) => `${hash} (0x${hash.toString(16)})`).join(', ')}`);
			}
		}

		const bundles: {
			hash: string;
			asset: string;
			assetSize: number;
			bundleIndex: number;
			bundle: string;
			directDependencies: string[];
			closureCount: number;
		}[] = [];
		for (const hash of hashes) {
			const assets = manifest.findAssets(hash);
			if (assets.length === 0 && !json) {
				console.log('  not a bundled asset (no manifest AssetInfo)');
			}
			const seen = new Set<number>();
			for (const asset of assets) {
				if (seen.has(asset.bundleIndex)) {
					continue;
				}
				seen.add(asset.bundleIndex);
				const bundle = manifest.bundle(asset.bundleIndex);
				const directDeps = bundle.directDependencies.map((dep) => manifest.bundleName(dep));
				if (json) {
					bundles.push({
						hash: hashText(hash),
						asset: manifest.assetPath(asset),
						assetSize: asset.assetSize,
						bundleIndex: bundle.index,
						bundle: bundle.name,
						directDependencies: directDeps,
						closureCount: bundle.dependencies.length,
					});
				} else {
					console.log(`  asset ${manifest.assetPath(asset)} (${asset.assetSize} bytes)`);
					console.log(`  bundle #${bundle.index} ${bundle.name}`);
					console.log(`    direct deps (${directDeps.length}):`);
					for (const dep of directDeps) {
						console.log(`      ${dep}`);
					}
					console.log(`    closure: ${bundle.dependencies.length} bundles`);
				}
			}
		}
		if (json) {
			jsonOut.push({
				query,
				path,
				hashes: hashes.map((h) => ({ dec: h.toString(), hex: hashText(h) })),
				bundles,
			});
		}
	}
	if (json) {
		console.log(JSON.stringify(queries.length === 1 ? jsonOut[0] : jsonOut, null, '\t'));
	}
};

// #endregion

// #region SparkBuffer tables

const TABLE_PREFIX = 'Data/TableCfg/';
const TABLE_SUFFIX = '.bytes';

const tableShortName = (name: string): string =>
	name.startsWith(TABLE_PREFIX) && name.endsWith(TABLE_SUFFIX)
		? name.slice(TABLE_PREFIX.length, -TABLE_SUFFIX.length)
		: name;

const listTables = async (context: Context, filter: RegExp | undefined): Promise<void> => {
	const group = await context.vfs.group(VfsGroup.Table);
	const names = Iterator.from(group.catalog)
		.filter((file) => file.name.endsWith(TABLE_SUFFIX))
		.map((file) => ({ name: tableShortName(file.name), length: file.length }))
		.filter((entry) => filter === undefined || filter.test(entry.name))
		.toArray();
	names.sort((a, b) => compareStrings(a.name, b.name));
	for (const entry of names) {
		console.log(`${String(entry.length).padStart(10)}  ${entry.name}`);
	}
	console.error(`${names.length} tables`);
};

const readTable = async (
	context: Context,
	name: string,
	options: { key: string | undefined; filter: RegExp | undefined; limit: number; json: boolean },
): Promise<void> => {
	const group = await context.vfs.group(VfsGroup.Table);
	let exactPath = name;
	if (!name.includes('/')) {
		exactPath = `${TABLE_PREFIX}${name}${name.endsWith(TABLE_SUFFIX) ? '' : TABLE_SUFFIX}`;
	}
	let matchedPath = group.catalog.has(exactPath) ? exactPath : undefined;
	if (matchedPath === undefined) {
		const lower = exactPath.toLowerCase();
		for (const candidate of group.catalog.names()) {
			if (candidate.toLowerCase() === lower) {
				matchedPath = candidate;
				break;
			}
		}
	}
	if (matchedPath === undefined) {
		throw new Error(
			`table ${name} not found in Table group; see \`data tables\` (or \`vfs ls JsonData\` for JSON tables)`,
		);
	}
	const table = parseSparkTable(await context.vfs.read(VfsGroup.Table, matchedPath));
	const matched: { key: string | number | bigint; value: unknown }[] = [];
	for (const [key, value] of table.entries) {
		const keyText = String(key);
		if (options.key !== undefined && keyText !== options.key) {
			continue;
		}
		if (options.filter !== undefined) {
			const hay = `${keyText} ${JSON.stringify(value, jsonReplacer)}`;
			if (!options.filter.test(hay)) {
				continue;
			}
		}
		matched.push({ key, value });
		if (matched.length >= options.limit) {
			break;
		}
	}
	if (options.json || options.key !== undefined) {
		console.log(
			JSON.stringify(
				options.key !== undefined && matched.length === 1 ? matched[0] : matched,
				jsonReplacer,
				'\t',
			),
		);
	} else {
		for (const row of matched) {
			console.log(`${String(row.key).padEnd(32)} ${JSON.stringify(row.value, jsonReplacer)}`);
		}
	}
	console.error(
		`${matched.length} rows of ${table.entries.length} in ${table.name}${matched.length === options.limit ? ' (limit reached; raise --limit for more)' : ''}`,
	);
};

// #endregion

// #region MemoryPack scripts & interactives

const SCRIPT_ROOT = 'Beyond_Gameplay_LevelScriptDataForMemoryPack';

/** expands a level id, scene name, or comma-separated list into distinct level ids */
const expandLevels = async (world: WorldIndex, target: string): Promise<string[]> => {
	const levels: string[] = [];
	const seen = new Set<string>();
	for (const part of target
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)) {
		// oxlint-disable-next-line no-await-in-loop -- usually 1 target
		const partition = await world.partition(part);
		const expanded =
			partition !== undefined && partition.levels.length > 0 ? partition.levels.map((l) => l.id) : [part];
		for (const id of expanded) {
			if (!seen.has(id)) {
				seen.add(id);
				levels.push(id);
			}
		}
	}
	return levels;
};

const readScripts = async (
	context: Context,
	target: string,
	options: { id: string | undefined; filter: RegExp | undefined; limit: number; json: boolean },
): Promise<void> => {
	const [group, levels] = await Promise.all([
		context.vfs.group(VfsGroup.JsonData),
		expandLevels(context.world, target),
	]);
	const entries: { level: string; prefix: string; name: string }[] = [];
	for (const level of levels) {
		const prefix = `Data/Json/LevelScriptData/${level}/`;
		const files = group.catalog
			.names()
			.filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
			.filter((name) => options.id === undefined || name === `${prefix}${options.id}.json`)
			.toArray();
		files.sort(compareNatural);
		for (const name of files) {
			entries.push({ level, prefix, name });
		}
	}
	if (entries.length === 0) {
		throw new Error(
			`no level scripts found for ${target}${options.id === undefined ? '' : ` id ${options.id}`}`,
		);
	}

	const mp = await context.memoryPack();
	const multiLevel = levels.length > 1;
	const matched: object[] = [];
	for (const { level, prefix, name } of entries) {
		const scriptId = name.slice(prefix.length, -'.json'.length);
		// oxlint-disable-next-line no-await-in-loop -- stops at --limit
		const decoded = mp.decode(await context.vfs.read(VfsGroup.JsonData, name), SCRIPT_ROOT);
		if (options.filter !== undefined && !options.filter.test(JSON.stringify(decoded, jsonReplacer))) {
			continue;
		}
		if (options.id !== undefined || options.json) {
			matched.push({ id: scriptId, level, file: name, data: decoded });
		} else {
			const graph = toScript(scriptId, level, decoded);
			const types = new Set<string>();
			if (graph !== null) {
				for (const node of graph.nodes.values()) {
					if (typeof node.$type === 'string') {
						types.add(node.$type.replace(/^Beyond_Gameplay_(Actions_)?/, '').replace(/ForMemoryPack$/, ''));
					}
				}
			}
			const list = [...types];
			const levelPrefix = multiLevel ? `${level.padEnd(14)} ` : '';
			console.log(
				`${levelPrefix}${scriptId.padEnd(14)} ${String(graph?.headers.length ?? 0).padStart(2)} headers  ${String(graph?.nodes.size ?? 0).padStart(3)} nodes  ${list.slice(0, 6).join(', ')}${list.length > 6 ? ` (+${list.length - 6})` : ''}`,
			);
			matched.push({ id: scriptId });
		}
		if (matched.length >= options.limit) {
			break;
		}
	}
	if (options.id !== undefined || options.json) {
		console.log(
			JSON.stringify(
				options.id !== undefined && matched.length === 1 ? matched[0] : matched,
				jsonReplacer,
				'\t',
			),
		);
	}
	console.error(
		`${matched.length} scripts matched out of ${entries.length}${matched.length === options.limit ? ' (limit reached; raise --limit for more)' : ''}`,
	);
};

const readInteractives = async (
	context: Context,
	target: string,
	options: { id: string | undefined; filter: RegExp | undefined; limit: number; json: boolean },
): Promise<void> => {
	const [group, levels] = await Promise.all([
		context.vfs.group(VfsGroup.JsonData),
		expandLevels(context.world, target),
	]);
	const entries: { level: string; name: string }[] = [];
	for (const level of levels) {
		const prefix = `Data/Json/LevelData/${level}/`;
		const files = group.catalog
			.names()
			.filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
			.toArray();
		files.sort();
		for (const name of files) {
			entries.push({ level, name });
		}
	}
	if (entries.length === 0) {
		throw new Error(`no LevelData files found for ${target}`);
	}
	const reader = await context.memoryPack();
	const fields = new Set(['interactives']);

	const multiLevel = levels.length > 1;
	const matched: object[] = [];
	const skipped: string[] = [];
	for (const { level, name } of entries) {
		// oxlint-disable-next-line no-await-in-loop -- stops at --limit
		const bytes = await context.vfs.read(VfsGroup.JsonData, name);
		let rows;
		try {
			const data = reader.decodeFields(bytes, 'Beyond_Gameplay_LevelDataForMemoryPack', fields);
			rows = readLevelDataInteractives(data).interactives;
		} catch (error) {
			if (error instanceof FormatError) {
				skipped.push(`${name}: ${errorText(error)}`);
				continue;
			}
			throw error;
		}
		for (const row of rows) {
			const idText = row.id.toString();
			if (options.id !== undefined && idText !== options.id) {
				continue;
			}
			const plain = {
				id: idText,
				level,
				template: row.template,
				createState: row.createState,
				isLocked: row.isLocked,
				position: row.position,
				rotation: row.rotation,
				scale: row.scale,
				modelScale: row.modelScale,
				properties: row.properties,
				componentProperties: Object.fromEntries(row.componentProperties),
				file: name,
			};
			if (options.filter !== undefined && !options.filter.test(JSON.stringify(plain, jsonReplacer))) {
				continue;
			}
			matched.push(plain);
			if (!options.json && options.id === undefined) {
				const pos = row.position.map((v) => v.toFixed(1)).join(',');
				const flags = definite([
					row.createState !== 0 ? `create=${row.createState}` : '',
					row.isLocked ? 'locked' : '',
				]).join(' ');
				const levelPrefix = multiLevel ? `${level.padEnd(14)} ` : '';
				console.log(
					`${levelPrefix}${idText.padStart(12)}  ${pos.padEnd(24)} ${row.template.padEnd(36)} ${flags}  @ ${name.split('/').pop()}`,
				);
			}
			if (matched.length >= options.limit) {
				break;
			}
		}
		if (matched.length >= options.limit) {
			break;
		}
	}
	if (options.json || options.id !== undefined) {
		console.log(
			JSON.stringify(
				options.id !== undefined && matched.length === 1 ? matched[0] : matched,
				jsonReplacer,
				'\t',
			),
		);
	}
	for (const note of skipped) {
		console.error(`skipped: ${note}`);
	}
	console.error(
		`${matched.length} interactives${matched.length === options.limit ? ' (limit reached; raise --limit for more)' : ''}`,
	);
};

// #endregion

// #region view-states

const VIEW_STATE_PREFIX = 'Data/Json/Interactive/ModelViewStateControllerData/';
const VIEW_STATE_SUFFIX = '.json';
const VIEW_STATE_CONCURRENCY = 16;

interface EmissiveStateHit {
	state: string;
	configHash: string;
	configPath: string | null;
}

const readViewStatesCmd = async (
	context: Context,
	options: {
		model: RegExp | undefined;
		emissive: RegExp | undefined;
		filter: RegExp | undefined;
		limit: number;
		json: boolean;
	},
): Promise<void> => {
	const group = await context.vfs.group(VfsGroup.JsonData);
	const models: string[] = [];
	for (const entry of group.catalog) {
		if (!entry.name.startsWith(VIEW_STATE_PREFIX) || !entry.name.endsWith(VIEW_STATE_SUFFIX)) {
			continue;
		}
		const model = entry.name.slice(VIEW_STATE_PREFIX.length, -VIEW_STATE_SUFFIX.length);
		if (options.model === undefined || options.model.test(model)) {
			models.push(model);
		}
	}
	models.sort(compareNatural);

	// warm up MemoryPack schema & StringPathHash once before fanning out
	await context.memoryPack();
	if (options.emissive !== undefined || !options.json) {
		await context.world.pathHash();
	}

	const rows: {
		model: string;
		states: string[];
		emissives: EmissiveStateHit[];
		data?: unknown;
	}[] = [];

	await mapPool(models, VIEW_STATE_CONCURRENCY, async (model) => {
		const vs = await readViewStates(context, { model, source: model });
		if (vs === null) {
			return;
		}
		const states: string[] = [];
		const emissives: EmissiveStateHit[] = [];
		for (const ac of records(vs.data.modelAnimatorDatas)) {
			for (const layer of records(ac.layerFsmDatas)) {
				for (const state of records(layer.stateDatas)) {
					const stateName = text(state.stateName) ?? text(state.name) ?? '?';
					states.push(stateName);
					for (const behavior of records(state.behaviors)) {
						const type = text(behavior.$type);
						if (type === null || !type.endsWith('_MVSCEmissiveBehaviorDataForMemoryPack')) {
							continue;
						}
						const rawHash = behavior.emissiveConfigHash;
						if (typeof rawHash !== 'string' && typeof rawHash !== 'number' && typeof rawHash !== 'bigint') {
							continue;
						}
						const hash = BigInt.asUintN(64, BigInt(rawHash));
						if (hash === 0n) {
							continue;
						}
						// oxlint-disable-next-line no-await-in-loop -- cached table lookup
						const configPath = (await context.world.pathOf(hash)) ?? null;
						emissives.push({
							state: stateName,
							configHash: hashText(hash),
							configPath,
						});
					}
				}
			}
		}

		if (options.emissive !== undefined) {
			const matchedEmissives = emissives.filter(
				(e) =>
					(e.configPath !== null && options.emissive!.test(e.configPath)) ||
					options.emissive!.test(e.configHash),
			);
			if (matchedEmissives.length === 0) {
				return;
			}
		}
		if (options.filter !== undefined && !options.filter.test(JSON.stringify(vs.data, jsonReplacer))) {
			return;
		}
		rows.push({
			model,
			states,
			emissives,
			...(options.json ? { data: vs.data } : {}),
		});
	});

	rows.sort((a, b) => compareNatural(a.model, b.model));
	const shown = rows.slice(0, options.limit);
	if (options.json) {
		console.log(JSON.stringify(shown, jsonReplacer, '\t'));
	} else {
		for (const row of shown) {
			let emText = '';
			if (row.emissives.length > 0) {
				const list = row.emissives
					.map((e) => `${e.state}→${e.configPath?.split('/').pop() ?? e.configHash}`)
					.join(', ');
				emText = `  emissives: ${list}`;
			}
			console.log(`${row.model.padEnd(44)} states=${row.states.length}${emText}`);
		}
	}
	console.error(
		`${shown.length} of ${rows.length} view states (scanned ${models.length})${rows.length > options.limit ? ' (raise --limit for more)' : ''}`,
	);
};

// #endregion
