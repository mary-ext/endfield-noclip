import type { LevelInteractive } from '@endfield-noclip/formats/endfield/level-interactives';
import {
	isMemoryPackObject,
	type MemoryPackObject,
	type MemoryPackValue,
} from '@endfield-noclip/formats/endfield/memory-pack';

// readers for decoded interactive templates (`InteractiveTemplateData`) and for the properties a placement
// overrides them with

/** the MemoryPack wrapper of interactive templates */
export const TEMPLATE_ROOT = 'Beyond_Gameplay_InteractiveTemplateDataForMemoryPack';

/** a template component: a decoded object with its wrapper's name */
type Component = MemoryPackObject & { $type: string };

/**
 * @param template a decoded interactive template
 * @returns its components, in order; none when it isn't a record
 */
const componentsOf = (template: MemoryPackValue): Component[] => {
	const components = isMemoryPackObject(template) ? template.componentList : null;
	return (Array.isArray(components) ? components : []).filter(
		(component): component is Component =>
			isMemoryPackObject(component) && typeof component.$type === 'string',
	);
};

/**
 * @param template a decoded interactive template
 * @param suffix the component's type name suffix
 * @returns its first component of that type, if any
 */
export const findComponent = (template: MemoryPackValue, suffix: string): MemoryPackObject | undefined =>
	componentsOf(template).find((component) => component.$type.endsWith(suffix));

/**
 * @param template a decoded interactive template
 * @param suffixes component type name suffixes
 * @returns whether it has a component of one of those types
 */
export const hasComponent = (template: MemoryPackValue, suffixes: readonly string[]): boolean =>
	componentsOf(template).some((component) => suffixes.some((suffix) => component.$type.endsWith(suffix)));

/**
 * @param properties a keyed property list
 * @param key the property's key
 * @returns its first atom's bits; `null` when they aren't a number, `undefined` when the property is absent
 */
const propertyAtomBits = (
	properties: MemoryPackValue | undefined,
	key: string,
): bigint | null | undefined => {
	for (const property of Array.isArray(properties) ? properties : []) {
		if (!isMemoryPackObject(property) || property.key !== key) {
			continue;
		}
		const value = property.value;
		const [atom] = isMemoryPackObject(value) && Array.isArray(value.valueArray) ? value.valueArray : [];
		const bits = isMemoryPackObject(atom) ? atom.valueBit64 : undefined;
		return typeof bits === 'string' || typeof bits === 'number' ? BigInt(bits) : null;
	}
	return undefined;
};

/**
 * @param bits a float's IEEE bits in a 64-bit atom
 * @returns the float
 */
export const atomFloat = (bits: bigint): number => {
	const view = new DataView(new ArrayBuffer(4));
	view.setUint32(0, Number(BigInt.asUintN(32, bits)));
	return view.getFloat32(0);
};

/**
 * @param template a decoded interactive template
 * @param suffix the component's type name suffix
 * @param key the property's key
 * @returns the float property of the first such component that has it, or `null` without one
 */
export const componentFloat = (template: MemoryPackValue, suffix: string, key: string): number | null => {
	for (const component of componentsOf(template)) {
		if (!component.$type.endsWith(suffix)) {
			continue;
		}
		const bits = propertyAtomBits(component.propertyList, key);
		if (bits !== undefined) {
			return bits === null ? null : atomFloat(bits);
		}
	}
	return null;
};

/**
 * @param properties a template's keyed property list
 * @param key the property's key
 * @returns its first atom as a bool, or `null` when it's absent
 */
export const boolProperty = (properties: MemoryPackValue | undefined, key: string): boolean | null => {
	const bits = propertyAtomBits(properties, key) ?? null;
	return bits === null ? null : bits !== 0n;
};

/**
 * @param properties a template's keyed property list
 * @param key the property's key
 * @returns its first atom as a 32-bit int, or `null` when it's absent
 */
const intProperty = (properties: MemoryPackValue | undefined, key: string): number | null => {
	const bits = propertyAtomBits(properties, key) ?? null;
	return bits === null ? null : Number(BigInt.asIntN(32, bits));
};

/** the component that passes an interactive's `state` property to its view states */
const COMMON_PERFORM_COMPONENTS = ['_InteractiveCommonPerformComponentDataForMemoryPack'];

/** the entity property, and view-state key, the common-perform component passes on */
export const STATE_KEY = 'state';

/** the `state` an interactive template's entities start with */
export interface StartState {
	/** the template's own: its saved, else config, else temporary property, else 0 */
	state: number;
	/** variants whose diff properties set another, by interactive id */
	variants: Map<string, number>;
}

/**
 * @param template a decoded interactive template
 * @returns the `state` its view states start with, or `null` when it has no common-perform component to pass
 *   one on
 */
export const startState = (template: MemoryPackValue): StartState | null => {
	if (!isMemoryPackObject(template) || !hasComponent(template, COMMON_PERFORM_COMPONENTS)) {
		return null;
	}
	const state =
		intProperty(template.saveProperties, STATE_KEY) ??
		intProperty(template.configProperties, STATE_KEY) ??
		intProperty(template.tempProperties, STATE_KEY) ??
		0;
	const variants = new Map<string, number>();
	for (const pair of Array.isArray(template.templateVariant) ? template.templateVariant : []) {
		if (!Array.isArray(pair)) {
			continue;
		}
		const [id, variant] = pair;
		const value = isMemoryPackObject(variant) ? intProperty(variant.diffProperties, STATE_KEY) : null;
		if (typeof id === 'string' && value !== null) {
			variants.set(id, value);
		}
	}
	return { state, variants };
};

/** a property's value atoms: their raw bits and strings */
type PropertyAtoms = { bits: bigint; text: string | null }[];

/** where an interactive's entity properties start, below a placement's own `properties` */
export interface EntityProperties {
	/** the template's saved, config and temporary properties, in the order they're looked up */
	lists: MemoryPackValue[];
	/** by interactive id, a variant's diff properties, looked up before the template's */
	variants: Map<string, MemoryPackValue>;
}

/**
 * @param template a decoded interactive template
 * @returns its entity property lists, or `null` when it isn't a record
 */
export const entityProperties = (template: MemoryPackValue): EntityProperties | null => {
	if (!isMemoryPackObject(template)) {
		return null;
	}
	const variants = new Map<string, MemoryPackValue>();
	for (const pair of Array.isArray(template.templateVariant) ? template.templateVariant : []) {
		if (Array.isArray(pair) && typeof pair[0] === 'string' && isMemoryPackObject(pair[1])) {
			variants.set(pair[0], pair[1].diffProperties);
		}
	}
	return {
		lists: [template.saveProperties, template.configProperties, template.tempProperties],
		variants,
	};
};

/**
 * @param properties a template's keyed property list
 * @param key the property's key
 * @returns its value atoms, or `null` when it's absent
 */
const templateAtoms = (properties: MemoryPackValue | undefined, key: string): PropertyAtoms | null => {
	for (const property of Array.isArray(properties) ? properties : []) {
		if (!isMemoryPackObject(property) || property.key !== key || !isMemoryPackObject(property.value)) {
			continue;
		}
		const atoms = Array.isArray(property.value.valueArray) ? property.value.valueArray : [];
		return atoms.filter(isMemoryPackObject).map((atom) => ({
			bits:
				typeof atom.valueBit64 === 'string' || typeof atom.valueBit64 === 'number'
					? BigInt(atom.valueBit64)
					: 0n,
			text: typeof atom.valueString === 'string' ? atom.valueString : null,
		}));
	}
	return null;
};

/**
 * @param entity the template's entity properties
 * @param row a placed interactive
 * @param key the property's key
 * @returns the property's starting value atoms: the placement's own, else its variant's, else the template's;
 *   `null` when none has it
 */
export const entityProperty = (
	entity: EntityProperties,
	row: LevelInteractive,
	key: string,
): PropertyAtoms | null =>
	row.properties.find((param) => param.key === key)?.values ??
	templateAtoms(entity.variants.get(row.template), key) ??
	entity.lists.reduce<PropertyAtoms | null>((found, list) => found ?? templateAtoms(list, key), null);

/**
 * @param entity the template's entity properties
 * @param row a placed interactive
 * @param key the property's key
 * @returns the property's starting first atom as a 32-bit int, 0 when nothing sets it
 */
export const entityInt = (entity: EntityProperties, row: LevelInteractive, key: string): number =>
	Number(BigInt.asIntN(32, entityProperty(entity, row, key)?.[0]?.bits ?? 0n));

/**
 * @param entity the template's entity properties
 * @param row a placed interactive
 * @returns its starting `state`: the placement's, else its variant's, else the template's, else 0
 */
export const entityState = (entity: EntityProperties, row: LevelInteractive): number =>
	stateOf(row) ?? entityInt(entity, row, STATE_KEY);

/**
 * @param row a placed interactive
 * @param key a parameter's key
 * @returns the first value of that parameter on each of its components that has it, in order
 */
export const componentValues = function* (
	row: LevelInteractive,
	key: string,
): Generator<{ bits: bigint; text: string | null } | undefined> {
	for (const params of row.componentProperties.values()) {
		const param = params.find((entry) => entry.key === key);
		if (param !== undefined) {
			yield param.values[0];
		}
	}
};

/**
 * @param row a placed interactive
 * @returns its own `state` property, else its `state` parameter on any component, else null
 */
export const stateOf = (row: LevelInteractive): number | null => {
	const own = row.properties.find((param) => param.key === STATE_KEY)?.values[0]?.bits;
	if (own !== undefined) {
		return Number(BigInt.asIntN(32, own));
	}
	for (const value of componentValues(row, STATE_KEY)) {
		if (value !== undefined) {
			return Number(BigInt.asIntN(32, value.bits));
		}
	}
	return null;
};
