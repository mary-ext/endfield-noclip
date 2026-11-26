import { type ObjectInfo, typeName, UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import type { TypeTreeValue } from '@endfield-noclip/formats/unity/type-tree';
import { isObject, numberField, pptrField, stringField } from '@endfield-noclip/formats/unity/values';

import { type Context, withContext } from '../../../install/context.ts';
import { surveyPlacements } from '../../../pipeline/survey.ts';
import { compareStrings } from '../../../util/compare.ts';
import { mapPool } from '../../../util/pool.ts';
import { hashText } from '../../helpers.ts';
import { matchesWhere, pickFields, type WherePredicate } from '../../query.ts';

import type { SceneSubArgs } from './parser.ts';

/**
 * runs `endfield-extract scene prefabs`
 *
 * @param args parsed CLI arguments
 */
export const runScenePrefabs = async (args: SceneSubArgs<'prefabs'>): Promise<void> => {
	await withContext(args.config, async (context) => {
		await scanScenePrefabs(context, args.scenes, {
			pattern: args.name,
			classes: [...args.classes],
			joinGo: args.joinGo,
			where: [...args.where],
			pick: [...args.pick],
			limit: args.limit,
			json: args.json,
		});
	});
};

const toSimpleJson = (value: TypeTreeValue, maxArray = 32): unknown => {
	if (typeof value === 'bigint') {
		return value.toString();
	}
	if (ArrayBuffer.isView(value)) {
		return `<${value.constructor.name} ${value.byteLength} bytes>`;
	}
	if (Array.isArray(value)) {
		return value.slice(0, maxArray).map((item) => toSimpleJson(item, maxArray));
	}
	if (typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toSimpleJson(v, maxArray)]));
	}
	return value;
};

const scanScenePrefabs = async (
	context: Context,
	sceneArg: string,
	options: {
		pattern: RegExp | undefined;
		classes: readonly string[];
		joinGo: boolean;
		where: readonly WherePredicate[];
		pick: readonly string[];
		limit: number;
		json: boolean;
	},
): Promise<void> => {
	const scenes =
		sceneArg === 'all'
			? await context.world.scenes()
			: sceneArg
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean);

	const unique = new Map<
		bigint,
		{ hash: bigint; scenes: Set<string>; path: string | null; bundle: string | null }
	>();
	const [manifest, surveys] = await Promise.all([
		context.world.manifest(),
		mapPool(scenes, 4, async (scene) => ({
			scene,
			survey: await surveyPlacements(context, scene, null, { includeEcs: false }),
		})),
	]);
	for (const { scene, survey } of surveys) {
		for (const pl of survey.placements) {
			const hash = pl.model.pathHash;
			if (hash === 0n) {
				continue;
			}
			let entry = unique.get(hash);
			if (entry === undefined) {
				// oxlint-disable-next-line no-await-in-loop -- fast StringPathHash lookup on first sight
				const path = (await context.world.pathOf(hash)) ?? null;
				if (options.pattern !== undefined && !options.pattern.test(path ?? '')) {
					continue;
				}
				const assets = manifest.findAssets(hash);
				const bundle = assets.length > 0 ? manifest.bundleName(assets[0].bundleIndex) : null;
				entry = { hash, scenes: new Set([scene]), path, bundle };
				unique.set(hash, entry);
			} else {
				entry.scenes.add(scene);
			}
		}
	}

	const entries = [...unique.values()].toSorted((a, b) =>
		compareStrings(a.path ?? a.hash.toString(), b.path ?? b.hash.toString()),
	);

	// list-only mode when no object scan flags were provided
	if (options.classes.length === 0 && options.where.length === 0) {
		const shown = entries.slice(0, options.limit);
		if (options.json) {
			const rows = shown.map((e) => ({
				hash: hashText(e.hash),
				bundle: e.bundle,
				scenes: [...e.scenes],
				path: e.path,
			}));
			console.log(
				JSON.stringify(
					options.pick.length === 0 ? rows : rows.map((r) => pickFields(r, options.pick)),
					null,
					'\t',
				),
			);
		} else {
			for (const e of shown) {
				console.log(`${e.bundle ?? '-'}\t${hashText(e.hash)}\t${[...e.scenes].join(',')}\t${e.path ?? '-'}`);
			}
		}
		console.error(
			`${shown.length} of ${entries.length} unique placed prefabs across ${scenes.length} scenes`,
		);
		return;
	}

	const resolver = await context.resolver();
	let scanned = 0;
	let errors = 0;
	const perPrefab = await mapPool(entries, 12, async (entry) => {
		let ref;
		try {
			ref = await resolver.findUnique({ hash: entry.hash, path: entry.path }, UnityClass.GameObject);
		} catch {
			errors++;
			return [];
		}
		scanned++;
		const matchesClass = (obj: ObjectInfo): boolean =>
			options.classes.length === 0 ||
			options.classes.some((cls) => String(obj.classId) === cls || typeName(obj.type) === cls);

		const matching = ref.file.file.objects.filter(matchesClass);
		if (matching.length === 0) {
			return [];
		}

		const goNames = new Map<bigint, string>();
		const renderModes = new Map<bigint, number>();
		if (options.joinGo) {
			for (const obj of ref.file.file.objects) {
				if (obj.classId === UnityClass.GameObject) {
					// oxlint-disable-next-line no-await-in-loop -- lightweight name peek
					const name = await ref.file.peekName(obj);
					if (name !== undefined) {
						goNames.set(obj.pathId, name);
					}
				} else if (obj.classId === UnityClass.ParticleSystemRenderer) {
					try {
						// oxlint-disable-next-line no-await-in-loop -- reads render mode per sibling
						const data = await resolver.read({ ...ref, info: obj });
						const go = pptrField(data, 'm_GameObject').pathId;
						if (go !== 0n) {
							renderModes.set(go, numberField(data, 'm_RenderMode'));
						}
					} catch {
						// ignore
					}
				}
			}
		}

		const rows: Record<string, unknown>[] = [];
		for (const obj of matching) {
			let raw: TypeTreeValue;
			try {
				// oxlint-disable-next-line no-await-in-loop -- reads matching objects in prefab
				raw = await resolver.read({ ...ref, info: obj });
			} catch {
				continue;
			}
			const value = toSimpleJson(raw);
			let gameObject: string | undefined;
			let renderMode: number | undefined;
			if (options.joinGo && isObject(raw)) {
				if (obj.classId === UnityClass.GameObject) {
					try {
						gameObject = stringField(raw, 'm_Name');
					} catch {
						// ignore
					}
				} else if ('m_GameObject' in raw) {
					try {
						const goId = pptrField(raw, 'm_GameObject').pathId;
						gameObject = goNames.get(goId);
						if (obj.classId === UnityClass.ParticleSystem) {
							renderMode = renderModes.get(goId);
						}
					} catch {
						// ignore
					}
				}
			}
			const header: Record<string, unknown> = {
				scenes: [...entry.scenes],
				path: entry.path,
				bundle: entry.bundle,
				pathId: obj.pathId.toString(),
				classId: obj.classId,
				type: typeName(obj.type),
				...(gameObject === undefined ? {} : { gameObject }),
				...(renderMode === undefined ? {} : { renderMode }),
			};
			const queryView =
				value !== null && typeof value === 'object' && !Array.isArray(value)
					? { ...Object.fromEntries(Object.entries(value)), ...header, value }
					: { ...header, value };
			if (options.where.length > 0 && !matchesWhere(queryView, options.where)) {
				continue;
			}
			const outRow =
				options.pick.length > 0
					? {
							scenes: header.scenes,
							path: header.path,
							bundle: header.bundle,
							pathId: header.pathId,
							...(gameObject === undefined ? {} : { gameObject }),
							...(renderMode === undefined ? {} : { renderMode }),
							...pickFields(queryView, options.pick),
						}
					: { ...header, value };
			rows.push(outRow);
		}
		return rows;
	});

	const allRows = perPrefab.flat();
	const shown = allRows.slice(0, options.limit);
	if (options.json) {
		console.log(JSON.stringify(shown, null, '\t'));
	} else {
		for (const row of shown) {
			console.log(JSON.stringify(row));
		}
	}
	console.error(
		`${shown.length} of ${allRows.length} matching objects across ${scanned} prefabs (${errors} unresolved)`,
	);
};

// #endregion
