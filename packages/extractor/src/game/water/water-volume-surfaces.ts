import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import { readWaterSurfaceConfig, type WaterSurfaceConfig } from '@endfield-noclip/formats/endfield/water';
import { isSparkBean, parseSparkTable } from '@endfield-noclip/formats/hg/spark-buffer';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import type { TypeTreeObject, TypeTreeValue } from '@endfield-noclip/formats/unity/type-tree';
import {
	arrayField,
	asPPtr,
	isObject,
	objectField,
	type PPtr,
	pptrField,
} from '@endfield-noclip/formats/unity/values';

import { VfsGroup } from '../../hg/vfs.ts';
import type { AssetResolver, ObjectRef } from '../assets/assets.ts';
import type { WorldIndex } from '../world/world-index.ts';

import type { LoadedWaterConfig } from './water-source.ts';

// the surface a water volume without a config of its own draws with: the game instantiates a surface prefab
// picked by the volume's water type, and that prefab's water renderer names a WaterConfig. see
// docs/game-data/water.md "water volumes".

const MANAGER_CONFIG = 'assets/beyond/dynamicassets/gameplay/gamemech/watervolumemanagerconfig.prefab';

/** a `WaterVolumeManagerConfig`'s surface choice, as {@link volumeSurfacePrefab} reads it */
export interface WaterSurfaceSettings {
	/** by water type (`FacItemSubType`), its surface prefab's root GameObject */
	surfaces: ReadonlyMap<number, PPtr>;
	/** by water type, the type whose surface it borrows */
	remap: ReadonlyMap<number, number>;
	/** the surface for a type the table doesn't list */
	fallback: PPtr;
}

/**
 * @param settings the manager config's surface choice
 * @param waterType the volume's water type
 * @returns the surface prefab the game instantiates for it: the type is first remapped, then looked up, and a
 *   missing or null entry falls back to the config's fallback prefab
 */
export const volumeSurfacePrefab = (settings: WaterSurfaceSettings, waterType: number): PPtr => {
	const surface = settings.surfaces.get(settings.remap.get(waterType) ?? waterType);
	return surface === undefined || surface.pathId === 0n ? settings.fallback : surface;
};

/**
 * @param data a decoded `WaterVolumeManagerConfig`
 * @returns its surface choice
 * @throws {FormatError} if a dictionary doesn't have the serialized shape
 */
export const readWaterSurfaceSettings = (data: TypeTreeObject): WaterSurfaceSettings => {
	const surfaces = new Map<number, PPtr>();
	for (const [key, value] of dictionaryEntries(objectField(data, 'waterSurfaceSettingDict'))) {
		if (!isObject(value)) {
			throw new FormatError('water surface setting is not an object');
		}
		surfaces.set(key, pptrField(value, 'surfacePrefab'));
	}
	const remap = new Map<number, number>();
	for (const [key, value] of dictionaryEntries(objectField(data, 'waterTypeToSurfaceDict'))) {
		if (typeof value !== 'number') {
			throw new FormatError('water type remap is not a number');
		}
		remap.set(key, value);
	}
	return { surfaces, remap, fallback: pptrField(data, 'waterSurfaceMissingFallback') };
};

/** a `SerializeFieldDictionary`'s parallel key and value arrays, keyed by an enum */
const dictionaryEntries = (dictionary: TypeTreeObject): [number, TypeTreeValue][] => {
	const keys = arrayField(dictionary, '_keyData');
	const values = arrayField(dictionary, '_valueData');
	if (keys.length !== values.length) {
		throw new FormatError(`dictionary has ${keys.length} keys and ${values.length} values`);
	}
	return keys.map((key, i) => {
		if (typeof key !== 'number') {
			throw new FormatError('dictionary key is not an enum');
		}
		return [key, values[i]];
	});
};

/**
 * @param world install readers
 * @returns by factory item id, its `FacItemSubType` (a liquid's is its water type), from FactoryItemTable
 */
export const readFactoryItemSubTypes = async (world: WorldIndex): Promise<Map<string, number>> => {
	const file = await world.vfs.find(VfsGroup.Table, 'Data/TableCfg/FactoryItemTable.bytes');
	if (file === undefined) {
		throw new Error('FactoryItemTable not found');
	}
	const types = new Map<string, number>();
	for (const [key, value] of parseSparkTable(await world.vfs.readVerified(file)).entries) {
		if (typeof key === 'string' && isSparkBean(value) && typeof value.subType === 'number') {
			types.set(key, value.subType);
		}
	}
	return types;
};

/**
 * loads the surface config each liquid's volumes draw with when they name none
 *
 * @param context install readers
 * @param itemTypes the volumes' `waterItemType`s
 * @returns by item type, the config its surface prefab's water renderer names, or why it couldn't be found
 * @throws {Error} if the manager config itself can't be found or read
 */
export const loadVolumeSurfaceConfigs = async (
	context: { world: WorldIndex; resolver: AssetResolver },
	itemTypes: readonly string[],
): Promise<Map<string, LoadedWaterConfig<WaterSurfaceConfig> | Error>> => {
	const { world, resolver } = context;
	const [hash] = await world.hashesOf(MANAGER_CONFIG);
	if (hash === undefined) {
		throw new Error(`${MANAGER_CONFIG} isn't in StringPathHash`);
	}
	const root = await resolver.findUnique({ hash, path: MANAGER_CONFIG }, UnityClass.GameObject);
	const manager = await componentWith(resolver, root, 'waterSurfaceSettingDict');
	if (manager === null) {
		throw new FormatError(`${MANAGER_CONFIG} has no WaterVolumeManagerConfig`);
	}
	const settings = readWaterSurfaceSettings(manager.data);
	const subTypes = await readFactoryItemSubTypes(world);

	const configs = new Map<string, LoadedWaterConfig<WaterSurfaceConfig> | Error>();
	for (const itemType of new Set(itemTypes)) {
		const waterType = subTypes.get(itemType);
		if (waterType === undefined) {
			configs.set(itemType, new Error(`${itemType} isn't in FactoryItemTable`));
			continue;
		}
		try {
			// oxlint-disable-next-line no-await-in-loop -- a scene has a handful of liquids
			const prefab = await resolver.resolve(manager.ref, volumeSurfacePrefab(settings, waterType));
			if (prefab === null) {
				throw new FormatError(`no surface prefab for water type ${waterType}`);
			}
			// oxlint-disable-next-line no-await-in-loop -- as above
			const renderer = await componentWith(resolver, prefab, 'waterConfig');
			if (renderer === null) {
				throw new FormatError(`water type ${waterType}'s surface prefab has no water renderer`);
			}
			// oxlint-disable-next-line no-await-in-loop -- as above
			const ref = await resolver.resolve(renderer.ref, pptrField(renderer.data, 'waterConfig'));
			if (ref === null) {
				throw new FormatError(`water type ${waterType}'s surface names no water config`);
			}
			// oxlint-disable-next-line no-await-in-loop -- as above
			const config = readWaterSurfaceConfig(ref.info.type.nodes, await resolver.read(ref));
			configs.set(itemType, { ref, config });
		} catch (error) {
			configs.set(itemType, error instanceof Error ? error : new Error(String(error)));
		}
	}
	return configs;
};

/** @returns the first MonoBehaviour on a GameObject that has the field, with its data */
const componentWith = async (
	resolver: AssetResolver,
	gameObject: ObjectRef,
	field: string,
): Promise<{ ref: ObjectRef; data: TypeTreeObject } | null> => {
	for (const item of arrayField(await resolver.read(gameObject), 'm_Component')) {
		if (!isObject(item)) {
			continue;
		}
		// oxlint-disable-next-line no-await-in-loop -- a surface prefab has a handful of components
		const ref = await resolver.resolve(gameObject, asPPtr(item.component));
		if (ref?.info.classId !== UnityClass.MonoBehaviour) {
			continue;
		}
		// oxlint-disable-next-line no-await-in-loop -- as above
		const data = await resolver.read(ref);
		if (field in data) {
			return { ref, data };
		}
	}
	return null;
};
