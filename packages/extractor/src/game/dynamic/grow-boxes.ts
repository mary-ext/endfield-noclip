import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import { isSparkBean, parseSparkTable } from '@endfield-noclip/formats/hg/spark-buffer';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import { arrayField, isObject, pptrField, stringField } from '@endfield-noclip/formats/unity/values';

import type { Context } from '../../context.ts';
import { VfsGroup } from '../../hg/vfs.ts';
import type { AssetResolver, ObjectRef } from '../assets/assets.ts';

// the growth chamber's planting boxes (docs/game-data/scene-states.md#dijiang-cabins): each box prefab's
// script names a shutter object that stays shown until the cabin level unlocks the box's planting field.

const GROW_CABIN_LEVELS = 'Data/TableCfg/SpaceshipGrowCabinLvTable.bytes';

/** the box script's field naming its shutter */
const SHUTTER_FIELD = 'nonTransparentPlate';

/**
 * @param vfs the game's VFS
 * @returns the cabin level that unlocks each planting field (numbered from 1)
 * @throws {FormatError} if the table is missing or an entry isn't a level with its fields
 */
export const readPlantingFieldLevels = async (vfs: Context['vfs']): Promise<Map<number, number>> => {
	const file = await vfs.find(VfsGroup.Table, GROW_CABIN_LEVELS);
	if (file === undefined) {
		throw new FormatError(`missing ${GROW_CABIN_LEVELS}`);
	}
	const levels = new Map<number, number>();
	for (const [, entry] of parseSparkTable(await vfs.readVerified(file)).entries) {
		const fields = isSparkBean(entry) ? entry.unlockPlantingField : undefined;
		if (!isSparkBean(entry) || typeof entry.level !== 'number' || !Array.isArray(fields)) {
			throw new FormatError(`${GROW_CABIN_LEVELS} has an invalid entry`);
		}
		for (const field of fields) {
			if (typeof field !== 'number') {
				throw new FormatError(`${GROW_CABIN_LEVELS} has an invalid planting field`);
			}
			levels.set(field, entry.level);
		}
	}
	return levels;
};

/**
 * @param resolver bundle reader
 * @param root a prefab's root GameObject
 * @returns the name of the GameObject the root's planting-box script hides once its box unlocks, or `null`
 *   when the prefab isn't a planting box
 * @throws {FormatError} if the script's reference can't be resolved
 */
export const readGrowBoxShutter = async (
	resolver: AssetResolver,
	root: ObjectRef,
): Promise<string | null> => {
	const data = await resolver.read(root);
	for (const item of arrayField(data, 'm_Component')) {
		if (!isObject(item)) {
			continue;
		}
		// oxlint-disable-next-line no-await-in-loop -- a root has a handful of components
		const ref = await resolver.resolve(root, pptrField(item, 'component'));
		if (ref?.info.classId !== UnityClass.MonoBehaviour) {
			continue;
		}
		// oxlint-disable-next-line no-await-in-loop -- as above
		const script = await resolver.read(ref);
		if (!(SHUTTER_FIELD in script)) {
			continue;
		}
		// oxlint-disable-next-line no-await-in-loop -- as above
		const shutter = await resolver.resolve(ref, pptrField(script, SHUTTER_FIELD));
		if (shutter === null) {
			throw new FormatError(`planting box ${SHUTTER_FIELD} is null`);
		}
		// oxlint-disable-next-line no-await-in-loop -- as above
		return stringField(await resolver.read(shutter), 'm_Name');
	}
	return null;
};
