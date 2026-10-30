import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import {
	readInteractiveBaseModel,
	readInteractiveModel,
} from '@endfield-noclip/formats/endfield/interactive-model';
import {
	type LevelInteractive,
	readLevelInteractives,
	UnsupportedLevelData,
} from '@endfield-noclip/formats/endfield/level-interactives';
import type { LevelPartition } from '@endfield-noclip/formats/endfield/level-partition';
import { isObject, numberField, objectField, stringField } from '@endfield-noclip/formats/unity/values';
import type { ProgressionInfo } from '@endfield-noclip/package-format/states';

import type { Context } from '../context.ts';
import { VfsGroup } from '../hg/vfs.ts';

import type { StructureModel } from './dynamic-structures.ts';

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
]);

const templateDataPath = (template: string): string =>
	`Data/Json/Interactive/InteractiveData/data_${template}.json`;

/**
 * resolves the models of interactives placed by referenced LevelData: shop, depot and recycling-station
 * visual forms, and every other template's base model, always shown
 *
 * @param context install readers
 * @param scene owning map
 * @param level restricts decoding to one level, or null for the map
 * @param partition numeric level tags
 * @returns placements and explicit unsupported-file diagnostics; no partial file is used
 * @throws {FormatError} for broken authored references or malformed supported records
 */
export const loadInteractiveFacilities = async (
	context: Pick<Context, 'vfs' | 'world'>,
	scene: string,
	level: string | null,
	partition: LevelPartition | undefined,
): Promise<{
	models: StructureModel[];
	progressions: ProgressionInfo[];
	unsupported: { path: string; reason: string }[];
}> => {
	const { vfs, world } = context;
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

	// templates: facilities with their visual forms, the rest with their base model alone
	const authored = new Map<
		string,
		{ name: string | null; initial: number; forms: { prefab: string; scale: number }[] }
	>();
	for (const template of new Set(placed.map(({ row }) => row.template))) {
		const facility = TEMPLATES.get(template);
		if (facility !== undefined) {
			// oxlint-disable-next-line no-await-in-loop -- small templates, read once per map
			const model = readInteractiveModel(await read(facility.data), string);
			authored.set(template, {
				name: facility.name,
				initial: model.levels.indexOf(model.id),
				forms: model.levels.map((modelId) => formOf(modelId, model.scale)),
			});
			continue;
		}
		const data = templateDataPath(template);
		// oxlint-disable-next-line no-await-in-loop -- small templates, read once per map
		const file = await find(data);
		if (!file) {
			// variants such as the weapon-wall racks have no template file of their own
			unsupported.push({ path: data, reason: `no template file for ${template}` });
			continue;
		}
		try {
			// oxlint-disable-next-line no-await-in-loop -- small templates, read once per map
			const model = readInteractiveBaseModel(await vfs.readVerified(file), string);
			if (model !== null) {
				authored.set(template, { name: null, initial: 0, forms: [formOf(model.id, model.scale)] });
			}
		} catch (error) {
			if (!(error instanceof FormatError)) {
				throw error;
			}
			unsupported.push({ path: data, reason: error.message });
		}
	}

	// the manifest maps hashes to paths only, and each path decompresses on read: stop once all are found
	const wanted = new Set(
		[...authored.values()].flatMap((template) => template.forms.map((form) => form.prefab)),
	);
	const hashes = new Map<string, bigint>();
	const manifest = await world.manifest();
	for (const asset of manifest.assets()) {
		if (hashes.size === wanted.size) {
			break;
		}
		const path = manifest.assetPath(asset);
		if (wanted.has(path)) {
			hashes.set(path, asset.pathHash);
		}
	}
	const hashOf = (prefab: string): bigint => {
		const hash = hashes.get(prefab);
		if (hash === undefined) {
			throw new FormatError(`missing interactive prefab ${prefab}`);
		}
		return hash;
	};

	const models: StructureModel[] = [];
	const progressions: ProgressionInfo[] = [];
	for (const { path, levelId, levelTag, row } of placed) {
		const template = authored.get(row.template);
		if (template === undefined) {
			continue;
		}
		const id = `facility:${row.id}`;
		if (template.name !== null) {
			progressions.push({
				id,
				kind: 'facility',
				key: row.template,
				name: `${template.name} (${Math.round(row.position[0])}, ${Math.round(row.position[2])})`,
				levelId,
				levels: template.forms.map((_, i) => i),
				defaultLevel: template.initial,
			});
		}
		for (const [form, model] of template.forms.entries()) {
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
				visibility:
					template.name === null
						? { alternatives: [[]] }
						: { alternatives: [[{ control: id, mask: (1 << form) >>> 0 }]] },
			});
		}
	}
	return { models, progressions, unsupported };
};
