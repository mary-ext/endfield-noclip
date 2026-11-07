import {
	type InteractiveParam,
	type LevelInteractive,
	interactiveParamFromValue,
} from '@endfield-noclip/formats/endfield/level-interactives';
import { isMemoryPackObject, type MemoryPackValue } from '@endfield-noclip/formats/endfield/memory-pack';

/** how one interactive component is named in a template, its variants and LevelData */
export interface ComponentKeys {
	/** the suffix of its `$type` in the template's `componentList` */
	suffix: string;
	/** its key in a variant's `componentDiffProperties` */
	diffKey: string;
	/** the game's interactive component type, which keys a placement's `componentProperties` */
	type: number;
}

/**
 * @param template a decoded interactive template
 * @param suffix the suffix of the component's `$type`
 * @returns the template's first component of that type, or `null` without one
 */
export const componentOf = (
	template: MemoryPackValue,
	suffix: string,
): { [key: string]: MemoryPackValue } | null => {
	if (!isMemoryPackObject(template) || !Array.isArray(template.componentList)) {
		return null;
	}
	for (const component of template.componentList) {
		if (
			isMemoryPackObject(component) &&
			typeof component.$type === 'string' &&
			component.$type.endsWith(suffix)
		) {
			return component;
		}
	}
	return null;
};

/**
 * a component's own parameters, which it reads apart from its entity's properties: the template's, overridden
 * by the placement's variant's diff and then the placement's own
 *
 * @param template the decoded template
 * @param row the placement
 * @param keys how the component is named
 * @returns the merged parameters by key, or `null` when the template has no such component
 */
export const componentParams = (
	template: MemoryPackValue,
	row: LevelInteractive,
	keys: ComponentKeys,
): Map<string, InteractiveParam> | null => {
	const component = componentOf(template, keys.suffix);
	if (component === null || !isMemoryPackObject(template)) {
		return null;
	}
	const params = new Map<string, InteractiveParam>();
	const add = (list: MemoryPackValue | undefined): void => {
		for (const value of Array.isArray(list) ? list : []) {
			const param = interactiveParamFromValue(value);
			params.set(param.key, param);
		}
	};
	add(component.propertyList);
	for (const pair of Array.isArray(template.templateVariant) ? template.templateVariant : []) {
		if (!Array.isArray(pair) || pair[0] !== row.template || !isMemoryPackObject(pair[1])) {
			continue;
		}
		for (const diff of Array.isArray(pair[1].componentDiffProperties)
			? pair[1].componentDiffProperties
			: []) {
			if (Array.isArray(diff) && diff[0] === keys.diffKey && isMemoryPackObject(diff[1])) {
				add(diff[1].value);
			}
		}
	}
	for (const param of row.componentProperties.get(keys.type) ?? []) {
		params.set(param.key, param);
	}
	return params;
};
