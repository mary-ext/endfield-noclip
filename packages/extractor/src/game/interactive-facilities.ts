import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import {
	readInteractiveBaseModel,
	readInteractiveTable,
	readInteractiveVariantModels,
} from '@endfield-noclip/formats/endfield/interactive-model';
import {
	type LevelInteractive,
	readLevelInteractives,
	UnsupportedLevelData,
} from '@endfield-noclip/formats/endfield/level-interactives';
import type { LevelPartition } from '@endfield-noclip/formats/endfield/level-partition';
import type { MemoryPackValue } from '@endfield-noclip/formats/endfield/memory-pack';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import { isObject, numberField, objectField, stringField } from '@endfield-noclip/formats/unity/values';
import type { ConditionalSetInfo, SceneControl } from '@endfield-noclip/package-format/states';

import { getOrInsert } from '../collections.ts';
import type { Context } from '../context.ts';
import { VfsGroup } from '../hg/vfs.ts';

import { readDoodadShell, type DoodadShell } from './doodad-shell.ts';
import type { StructureModel } from './dynamic-structures.ts';
import { progressionControl } from './scenery-variants.ts';

// these facility templates share the validated model-upgrade component, so their visual forms become a
// progression control. every other template draws its base model only.
const TEMPLATES = new Map([
	[
		'int_system_domain_shop',
		{
			name: 'Stock redistribution facility',
			data: 'Data/Json/Interactive/InteractiveData/data_int_system_domain_shop.json',
		},
	],
	[
		'int_system_domain_depot',
		{ name: 'Depot', data: 'Data/Json/Interactive/InteractiveData/data_int_system_domain_depot.json' },
	],
	[
		'int_doodad_core_recycle',
		{
			name: 'Recycling station',
			data: 'Data/Json/Interactive/InteractiveData/data_int_doodad_core_recycle.json',
		},
	],
	[
		'int_system_kite_station',
		{
			name: 'Environment monitoring terminal',
			data: 'Data/Json/Interactive/InteractiveData/data_int_system_kite_station.json',
		},
	],
]);

/** the MemoryPack wrapper of interactive templates */
const TEMPLATE_ROOT = 'Beyond_Gameplay_InteractiveTemplateDataForMemoryPack';

/**
 * @param template a decoded interactive template
 * @param path its file, for errors
 * @returns its base model (the model component's) and its model-upgrade list, one ModelTable id per visual
 *   form
 * @throws {FormatError} if either component is missing or the base model isn't one of the forms
 */
const facilityModels = (
	template: MemoryPackValue,
	path: string,
): { id: string; scale: number; levels: string[] } => {
	const components =
		template !== null && typeof template === 'object' && !Array.isArray(template)
			? template.componentList
			: null;
	const find = (suffix: string) =>
		(Array.isArray(components) ? components : []).find(
			(component): component is { [key: string]: MemoryPackValue } =>
				component !== null &&
				typeof component === 'object' &&
				!Array.isArray(component) &&
				typeof component.$type === 'string' &&
				component.$type.endsWith(suffix),
		);
	const model = find('_InteractiveModelComponentDataForMemoryPack');
	const upgrade = find('_InteractiveModelLevelUpComponentDataForMemoryPack');
	const levels = upgrade?.modelLevelList;
	if (
		typeof model?.modelId !== 'string' ||
		typeof model.modelScale !== 'number' ||
		!Array.isArray(levels) ||
		!levels.every((level) => typeof level === 'string') ||
		!levels.includes(model.modelId)
	) {
		throw new FormatError(`${path} lacks a model and a model-upgrade list holding it`);
	}
	return { id: model.modelId, scale: model.modelScale, levels };
};

const TABLE = 'Data/Json/Interactive/InteractiveTable.json';

/**
 * resolves the models of interactives placed by referenced LevelData: shop, depot and recycling-station
 * visual forms, and every other interactive's model (its template variant's, else the template's), always
 * shown. a model that is a doodad-group shell also places its form models, one per group level, under a
 * per-level `doodadGroups:<level id>` control
 *
 * @param context install readers and the bundle resolver
 * @param scene owning map
 * @param level restricts decoding to one level, or null for the map
 * @param partition numeric level tags
 * @returns placements and explicit unsupported-file diagnostics; no partial file is used
 * @throws {FormatError} for broken authored references or malformed supported records
 */
export const loadInteractiveFacilities = async (
	context: Pick<Context, 'vfs' | 'world' | 'resolver' | 'memoryPack'>,
	scene: string,
	level: string | null,
	partition: LevelPartition | undefined,
): Promise<{
	models: StructureModel[];
	progressions: SceneControl[];
	unsupported: { path: string; reason: string }[];
}> => {
	const { vfs, world } = context;
	const reader = await context.memoryPack();
	const find = (name: string) => vfs.find(VfsGroup.JsonData, name);
	const read = async (name: string): Promise<Uint8Array> => {
		const file = await find(name);
		if (!file) {
			throw new FormatError(`missing interactive data ${name}`);
		}
		return vfs.readVerified(file);
	};
	const pool = await world.stringPool();
	const string = (id: number): string | null => pool.get(id);
	const table: unknown = JSON.parse(
		new TextDecoder().decode(await read('Data/Json/GameplayConfig/ModelTable.json')),
	);
	if (!isObject(table)) {
		throw new FormatError('invalid model table');
	}
	const modelData = objectField(table, 'data');
	const formOf = (modelId: string, scale: number): { prefab: string; scale: number } => {
		const data = objectField(modelData, modelId);
		return {
			prefab: stringField(data, 'path').toLowerCase(),
			scale: scale * numberField(data, 'scaleFactor'),
		};
	};
	const interactives = readInteractiveTable(await read(TABLE), string);
	const unsupported: { path: string; reason: string }[] = [];

	// placements first, so only the templates they use are read
	const pathOf = await world.pathLookup();
	const placed: { path: string; levelId: string; levelTag: number; row: LevelInteractive }[] = [];
	{
		const seen = new Set<bigint>();
		for (const config of (await world.levelConfigs()).values()) {
			if (config.mapId !== scene || (level !== null && config.id !== level)) {
				continue;
			}
			const levelTag = partition?.levels.find((entry) => entry.id === config.id)?.tag ?? 0;
			for (const hash of config.levelDataPathHashes ?? []) {
				const path = pathOf(hash);
				if (!path) {
					throw new FormatError(`missing LevelData path ${hash}`);
				}
				let rows;
				try {
					// oxlint-disable-next-line no-await-in-loop -- level files are released after their prefix is decoded
					rows = readLevelInteractives(await read(path), string);
				} catch (error) {
					if (!(error instanceof UnsupportedLevelData)) {
						throw error;
					}
					unsupported.push({ path, reason: error.message });
					continue;
				}
				for (const row of rows) {
					if (row.createState !== 0 || seen.has(row.id)) {
						continue;
					}
					seen.add(row.id);
					placed.push({ path, levelId: config.id, levelTag, row });
				}
			}
		}
	}

	// interactive ids: facilities with their visual forms, the rest with one model
	const authored = new Map<
		string,
		{ name: string | null; initial: number; forms: { prefab: string; scale: number }[] }
	>();
	// each template's base model and its variants' model overrides
	const templates = new Map<
		string,
		{ base: { id: string; scale: number } | null; variants: Map<string, string | null> }
	>();
	const variantsOf = new Map<string, Set<string>>();
	for (const [id, template] of interactives.templates) {
		if (id !== template) {
			variantsOf.set(template, (variantsOf.get(template) ?? new Set()).add(id));
		}
	}
	for (const key of new Set(placed.map(({ row }) => row.template))) {
		const facility = TEMPLATES.get(key);
		if (facility !== undefined) {
			// oxlint-disable-next-line no-await-in-loop -- small templates, read once per map
			const model = facilityModels(reader.decode(await read(facility.data), TEMPLATE_ROOT), facility.data);
			authored.set(key, {
				name: facility.name,
				initial: model.levels.indexOf(model.id),
				forms: model.levels.map((modelId) => formOf(modelId, model.scale)),
			});
			continue;
		}
		const template = interactives.templates.get(key);
		const data = template === undefined ? undefined : interactives.templatePaths.get(template);
		if (template === undefined || data === undefined) {
			unsupported.push({ path: TABLE, reason: `no template for ${key}` });
			continue;
		}
		let resolved = templates.get(template);
		if (resolved === undefined) {
			try {
				// oxlint-disable-next-line no-await-in-loop -- small templates, read once per map
				const bytes = await read(data);
				resolved = {
					base: readInteractiveBaseModel(bytes, string),
					variants: readInteractiveVariantModels(bytes, string, variantsOf.get(template) ?? new Set()),
				};
			} catch (error) {
				if (!(error instanceof FormatError)) {
					throw error;
				}
				unsupported.push({ path: data, reason: error.message });
				resolved = { base: null, variants: new Map() };
			}
			templates.set(template, resolved);
		}
		const { base } = resolved;
		const modelId = resolved.variants.get(key) ?? base?.id;
		if (modelId === undefined) {
			// triggers and logic-only interactives have no model
			continue;
		}
		if (!(modelId in modelData)) {
			unsupported.push({ path: data, reason: `model ${modelId} of ${key} is not in the model table` });
			continue;
		}
		authored.set(key, { name: null, initial: 0, forms: [formOf(modelId, base?.scale ?? 1)] });
	}

	const hashes = new Map<string, bigint>();
	const manifest = await world.manifest();
	// the manifest maps hashes to paths only, and each path decompresses on read: stop once all are found
	const findHashes = (paths: Iterable<string>): void => {
		const missing = new Set([...paths].filter((path) => !hashes.has(path)));
		for (const asset of manifest.assets()) {
			if (missing.size === 0) {
				break;
			}
			const path = manifest.assetPath(asset);
			if (missing.delete(path)) {
				hashes.set(path, asset.pathHash);
			}
		}
	};
	findHashes(authored.values().flatMap((template) => template.forms.map((form) => form.prefab)));
	const hashOf = (prefab: string): bigint => {
		const hash = hashes.get(prefab);
		if (hash === undefined) {
			throw new FormatError(`missing interactive prefab ${prefab}`);
		}
		return hash;
	};

	// doodad-group centres draw an empty shell; their visible model is one form per group level
	const doodads = new Map<string, { groupLevel: number; form: { prefab: string; scale: number } }[]>();
	{
		const resolver = await context.resolver();
		const shells = new Map<string, DoodadShell | null>();
		for (const [key, template] of authored) {
			if (template.name !== null) {
				continue;
			}
			const [{ prefab, scale }] = template.forms;
			let shell = shells.get(prefab);
			if (shell === undefined) {
				try {
					// oxlint-disable-next-line no-await-in-loop -- one root per distinct prefab
					const root = await resolver.findUnique(
						{ hash: hashOf(prefab), path: prefab },
						UnityClass.GameObject,
					);
					// oxlint-disable-next-line no-await-in-loop -- as above
					shell = await readDoodadShell(resolver, root);
				} catch (error) {
					if (!(error instanceof FormatError)) {
						throw error;
					}
					unsupported.push({ path: prefab, reason: error.message });
					shell = null;
				}
				shells.set(prefab, shell);
			}
			if (shell === null) {
				continue;
			}
			const levels = [];
			for (const [groupLevel, modelId] of shell.forms.entries()) {
				if (modelId === null) {
					continue;
				}
				if (!(modelId in modelData)) {
					unsupported.push({ path: prefab, reason: `doodad form ${modelId} is not in the model table` });
					continue;
				}
				levels.push({ groupLevel, form: formOf(modelId, scale) });
			}
			doodads.set(key, levels);
		}
		findHashes(doodads.values().flatMap((levels) => levels.map(({ form }) => form.prefab)));
	}

	const models: StructureModel[] = [];
	const progressions: SceneControl[] = [];
	const doodadLevels = new Map<string, Set<number>>();
	for (const { path, levelId, levelTag, row } of placed) {
		const template = authored.get(row.template);
		if (template === undefined) {
			continue;
		}
		const place = (model: { prefab: string; scale: number }, visibility: ConditionalSetInfo): void => {
			// zero is the authored "no scale override" sentinel on LevelInteractiveData.
			const scale = row.modelScale > 0 ? row.modelScale : model.scale;
			models.push({
				model: {
					pathHash: hashOf(model.prefab),
					position: row.position,
					rotation: row.rotation,
					scale: [row.scale[0] * scale, row.scale[1] * scale, row.scale[2] * scale],
				},
				levelTag,
				source: `${path}#${row.id}`,
				visibility,
			});
		};
		if (template.name === null) {
			place(template.forms[0], { alternatives: [[]] });
			const doodad = doodads.get(row.template);
			if (doodad === undefined || doodad.length === 0) {
				continue;
			}
			const id = `doodadGroups:${levelId}`;
			const levels = getOrInsert(doodadLevels, id, () => new Set<number>());
			for (const { groupLevel, form } of doodad) {
				levels.add(groupLevel);
				place(form, { alternatives: [[{ control: id, mask: (1 << groupLevel) >>> 0 }]] });
			}
			continue;
		}
		const id = `facility:${row.id}`;
		progressions.push(
			progressionControl(
				'facility',
				id,
				`${template.name} (${Math.round(row.position[0])}, ${Math.round(row.position[2])})`,
				template.forms.map((_, i) => i),
				template.initial,
				"the template's base model",
			),
		);
		for (const [form, model] of template.forms.entries()) {
			place(model, { alternatives: [[{ control: id, mask: (1 << form) >>> 0 }]] });
		}
	}
	for (const [id, set] of doodadLevels) {
		const levels = [...set].toSorted((a, b) => a - b);
		// shell slot activity varies (one or all four), so default to the fully grown form
		progressions.push(
			progressionControl(
				'doodadGroups',
				id,
				'Resource nodes',
				levels,
				levels.at(-1)!,
				'the fully grown form',
			),
		);
	}
	return { models, progressions, unsupported };
};
