import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import {
	arrayField,
	asPPtr,
	isObject,
	numberField,
	objectField,
	pptrField,
} from '@endfield-noclip/formats/unity/values';

import { objectKey, type AssetResolver, type ObjectRef } from './assets.ts';

/** the form fields of a doodad-group centre's postmodel script, for group levels 1 to 4 */
const FORM_FIELDS = ['doodadFormOne', 'doodadFormTwo', 'doodadFormThree', 'doodadFormFour'];

/** a doodad-group centre's postmodel: a shell that loads one form model per group level into a slot */
export interface DoodadShell {
	/** ModelTable ids indexed by group level (1 to 4); index 0 and levels without a model are `null` */
	forms: (string | null)[];
}

/**
 * reads the doodad-group shell on a prefab root: a script naming one ModelTable form per group level, and a
 * `levelModel` list of slot GameObjects, indexed by level, that the loaded form attaches under
 *
 * @param resolver bundle reader
 * @param root prefab GameObject
 * @returns the shell, or `null` when the root carries no script with a named form
 * @throws {FormatError} for a slot that isn't an identity child of the root
 */
export const readDoodadShell = async (
	resolver: AssetResolver,
	root: ObjectRef,
): Promise<DoodadShell | null> => {
	const data = await resolver.read(root);
	let rootTransform: ObjectRef | null = null;
	let shell: { ref: ObjectRef; data: TypeTreeObject } | null = null;
	for (const item of arrayField(data, 'm_Component')) {
		if (!isObject(item)) {
			throw new FormatError('prefab component is not an object');
		}
		// oxlint-disable-next-line no-await-in-loop -- a root has a handful of components
		const ref = await resolver.resolve(root, pptrField(item, 'component'));
		switch (ref?.info.classId) {
			case UnityClass.Transform: {
				rootTransform = ref;
				break;
			}
			case UnityClass.MonoBehaviour: {
				// oxlint-disable-next-line no-await-in-loop -- as above
				const value = await resolver.read(ref);
				// form postmodels carry the same script with every form empty
				if (FORM_FIELDS.some((field) => typeof value[field] === 'string' && value[field] !== '')) {
					shell = { ref, data: value };
				}
				break;
			}
		}
	}
	if (shell === null) {
		return null;
	}
	if (rootTransform === null) {
		throw new FormatError('doodad shell root has no Transform');
	}
	const forms: (string | null)[] = [null];
	for (const field of FORM_FIELDS) {
		const value = shell.data[field];
		forms.push(typeof value === 'string' && value !== '' ? value : null);
	}
	for (const pointer of arrayField(shell.data, 'levelModel')) {
		// oxlint-disable-next-line no-await-in-loop -- five slots
		const slot = await resolver.resolve(shell.ref, asPPtr(pointer));
		if (slot !== null) {
			// oxlint-disable-next-line no-await-in-loop -- as above
			await expectIdentityChild(resolver, slot, await resolver.read(slot), rootTransform);
		}
	}
	return { forms };
};

/** placements draw a form at the shell's own transform, so a slot must add none */
const expectIdentityChild = async (
	resolver: AssetResolver,
	slot: ObjectRef,
	slotData: TypeTreeObject,
	rootTransform: ObjectRef,
): Promise<void> => {
	for (const item of arrayField(slotData, 'm_Component')) {
		if (!isObject(item)) {
			throw new FormatError('prefab component is not an object');
		}
		// oxlint-disable-next-line no-await-in-loop -- a slot has one component
		const ref = await resolver.resolve(slot, pptrField(item, 'component'));
		if (ref?.info.classId !== UnityClass.Transform) {
			continue;
		}
		// oxlint-disable-next-line no-await-in-loop -- as above
		const t = await resolver.read(ref);
		// oxlint-disable-next-line no-await-in-loop -- as above
		const father = await resolver.resolve(ref, pptrField(t, 'm_Father'));
		const value = (name: string, axis: string): number => numberField(objectField(t, name), axis);
		const identity =
			father !== null &&
			objectKey(father) === objectKey(rootTransform) &&
			['x', 'y', 'z'].every(
				(axis) =>
					value('m_LocalPosition', axis) === 0 &&
					value('m_LocalRotation', axis) === 0 &&
					value('m_LocalScale', axis) === 1,
			) &&
			value('m_LocalRotation', 'w') === 1;
		if (!identity) {
			throw new FormatError('doodad shell slot is not an identity child of the root');
		}
		return;
	}
	throw new FormatError('doodad shell slot has no Transform');
};
