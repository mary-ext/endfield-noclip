import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import { readInteractiveModel } from '@endfield-noclip/formats/endfield/interactive-model';
import {
	readLevelInteractives,
	UnsupportedLevelData,
} from '@endfield-noclip/formats/endfield/level-interactives';
import type { LevelPartition } from '@endfield-noclip/formats/endfield/level-partition';
import { isObject, numberField, objectField, stringField } from '@endfield-noclip/formats/unity/values';
import type { ProgressionInfo } from '@endfield-noclip/package-format/format';

import type { Context } from '../context.ts';
import { VfsGroup } from '../hg/vfs.ts';

import type { StructureModel } from './dynamic-structures.ts';

// these facility templates share the validated base-model component prefix. other interactive
// systems need their own component and visibility contracts before their models can be included.
const TEMPLATES = new Map([
	['int_system_domain_shop', 'Data/Json/Interactive/InteractiveData/data_int_system_domain_shop.json'],
	['int_system_domain_depot', 'Data/Json/Interactive/InteractiveData/data_int_system_domain_depot.json'],
	['int_doodad_core_recycle', 'Data/Json/Interactive/InteractiveData/data_int_doodad_core_recycle.json'],
]);

/**
 * resolves shop, depot and recycling-station visual forms from referenced LevelData and the install's model
 * table
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
	const read = async (name: string): Promise<Uint8Array> => {
		const file = await vfs.find(VfsGroup.JsonData, name);
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
	const manifest = await world.manifest();
	const paths = new Map<string, bigint>();
	for (const asset of manifest.assets()) {
		paths.set(manifest.assetPath(asset), asset.pathHash);
	}
	const templates = new Map<string, { initial: number; forms: { hash: bigint; scale: number }[] }>();
	for (const [id, path] of TEMPLATES) {
		// oxlint-disable-next-line no-await-in-loop -- small facility templates, read once per map
		const model = readInteractiveModel(await read(path), string);
		const forms = model.levels.map((modelId) => {
			const data = objectField(modelData, modelId);
			const prefab = stringField(data, 'path').toLowerCase();
			const hash = paths.get(prefab);
			if (hash === undefined) {
				throw new FormatError(`missing facility prefab ${prefab}`);
			}
			return { hash, scale: model.scale * numberField(data, 'scaleFactor') };
		});
		templates.set(id, { initial: model.levels.indexOf(model.id), forms });
	}
	const pathOf = await world.pathLookup();
	const models: StructureModel[] = [];
	const progressions: ProgressionInfo[] = [];
	const unsupported: { path: string; reason: string }[] = [];
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
				const template = templates.get(row.template);
				if (!template || row.createState !== 0 || seen.has(row.id)) {
					continue;
				}
				seen.add(row.id);
				const id = `facility:${row.id}`;
				const names: Record<string, string> = {
					int_system_domain_shop: 'Stock redistribution facility',
					int_system_domain_depot: 'Depot',
					int_doodad_core_recycle: 'Recycling station',
				};
				progressions.push({
					id,
					kind: 'facility',
					key: row.template,
					name: `${names[row.template]} (${Math.round(row.position[0])}, ${Math.round(row.position[2])})`,
					levelId: config.id,
					levels: template.forms.map((_, i) => i),
					defaultLevel: template.initial,
				});
				for (const [form, model] of template.forms.entries()) {
					// zero is the authored "no scale override" sentinel on LevelInteractiveData.
					const scale = row.modelScale > 0 ? row.modelScale : model.scale;
					models.push({
						model: {
							pathHash: model.hash,
							position: row.position,
							rotation: row.rotation,
							scale: [row.scale[0] * scale, row.scale[1] * scale, row.scale[2] * scale],
						},
						levelTag,
						source: `${path}#${row.id}`,
						visibility: { alternatives: [[{ control: id, mask: (1 << form) >>> 0 }]] },
					});
				}
			}
		}
	}
	return { models, progressions, unsupported };
};
