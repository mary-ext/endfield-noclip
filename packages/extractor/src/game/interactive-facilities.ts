import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import type { DynamicModel } from '@endfield-noclip/formats/endfield/dynamic-resources';
import {
	readInteractiveBaseModel,
	readInteractiveTable,
	readInteractiveVariantModels,
} from '@endfield-noclip/formats/endfield/interactive-model';
import {
	type LevelInteractive,
	readLevelDataPrefix,
	UnsupportedLevelData,
} from '@endfield-noclip/formats/endfield/level-interactives';
import { InteractiveUnlockType, readLevelLocks } from '@endfield-noclip/formats/endfield/level-locks';
import type { LevelPartition } from '@endfield-noclip/formats/endfield/level-partition';
import { type LevelSpline, readLevelSplines } from '@endfield-noclip/formats/endfield/level-splines';
import type { MemoryPackValue } from '@endfield-noclip/formats/endfield/memory-pack';
import { parseSparkTable } from '@endfield-noclip/formats/hg/spark-buffer';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import {
	multiplyMatrices,
	quaternionUnityEuler,
	trsMatrix,
	unityEulerQuaternion,
} from '@endfield-noclip/formats/unity/transform';
import { isObject, numberField, objectField, stringField } from '@endfield-noclip/formats/unity/values';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import type { Context } from '../context.ts';
import { VfsGroup } from '../hg/vfs.ts';

import { animatorParameterId, animatorPose } from './animator-defaults.ts';
import { type ComponentKeys, componentParams } from './component-params.ts';
import {
	CRANE_TOWER_COMPONENTS,
	craneSteps,
	craneTowerOf,
	DEFAULT_CONTAINER_HEIGHT,
	readCraneLook,
} from './crane-tower.ts';
import { type CurveMove, curveMoveOf, curvePath, isAutoMovePlatform } from './curve-move.ts';
import { readDoodadShell, type DoodadShell } from './doodad-shell.ts';
import { readDoorPoses, type DoorPoses } from './door-poses.ts';
import type { StructureModel } from './dynamic-structures.ts';
import { allOf, type Alternatives } from './game-state.ts';
import { prefabNodeMatrices } from './prefab-nodes.ts';
import type { PrefabPose } from './prefab.ts';
import {
	type Visibility,
	type DraftControl,
	sceneControl,
	switchValues,
	SWITCH_VALUES,
} from './scene-control.ts';
import { progressionControl } from './scenery-variants.ts';
import { readTelescopicPoses, type TelescopicPoses } from './telescopic-bridge.ts';
import { isOneShotEffect } from './view-state-effects.ts';
import { type ModelViews, readViewStates, type RestingEffect, settledPose } from './view-state-poses.ts';

// templates with the model-upgrade component have their visual forms as a progression control; every other
// template draws its base model only. templates carry no display name, so these labels are ours; other
// upgrade-capable templates are labelled by their id
const FACILITY_NAMES = new Map([
	['int_system_domain_shop', 'Stock redistribution facility'],
	['int_system_domain_depot', 'Depot'],
	['int_doodad_core_recycle', 'Recycling station'],
	['int_system_kite_station', 'Environment monitoring terminal'],
]);

/** the component that lists a template's upgrade models */
const MODEL_UPGRADE_COMPONENTS = ['_InteractiveModelLevelUpComponentDataForMemoryPack'];

/** the MemoryPack wrapper of interactive templates */
const TEMPLATE_ROOT = 'Beyond_Gameplay_InteractiveTemplateDataForMemoryPack';

/** the MemoryPack wrapper of LevelData, decoded whole for its splines */
const LEVEL_DATA_ROOT = 'Beyond_Gameplay_LevelDataForMemoryPack';

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

/** components that make a template a door: common doors, and Dijiang's room doors */
const DOOR_COMPONENTS = [
	'_InteractiveDoorCommonComponentDataForMemoryPack',
	'_SpaceshipRoomDoorSystemDataForMemoryPack',
];

/** the component of Dijiang's construction-area walls */
const REGION_WALL_COMPONENTS = ['_SpaceshipRegionWallDataForMemoryPack'];

/** the component of campfires */
const CAMPFIRE_COMPONENTS = ['_InteractiveCampfireComponentDataForMemoryPack'];

/** a settled look of an interactive's model, its settled states' names and the effects they leave playing */
interface SettledLook {
	pose: PrefabPose;
	states: string[];
	effects: RestingEffect[];
}

/** the component of jump pads, which place an effect of their own */
const JUMP_MACHINE: ComponentKeys = {
	suffix: '_JumpMachineComponentDataForMemoryPack',
	diffKey: 'Comp_JumpMachine',
	type: 169,
};
const JUMP_MACHINE_COMPONENTS = [JUMP_MACHINE.suffix];

/** the component of vertical jump pads (cave vents), which play an effect of their own while on */
const JUMP_MACHINE_VERTICAL_COMPONENTS = ['_JumpMachineVerticalComponentDataForMemoryPack'];

/** the looping effect a vertical jump pad's component plays on its root while on; the name is fixed in code */
const VERTICAL_PAD_EFFECT = 'P_interactive_cavewell+1_001_01_loop';

/** the component of vertical rope lifts, which set their rope's length from their two ports */
const VERTICAL_ROPE_COMPONENTS = ['_InteractiveVerticalRopeComponentDataForMemoryPack'];

/** the placement property naming the other port of a vertical rope */
const TARGET_KEY = 'target';

/**
 * @param row a vertical rope's port
 * @param rows placed interactives by id
 * @returns the float keys its rope component sets before its view states start: `RopeLength`, the height
 *   between it and the port its `target` property names; none without another placed port
 */
export const verticalRopeFloats = (
	row: LevelInteractive,
	rows: ReadonlyMap<bigint, LevelInteractive>,
): Map<string, number> => {
	const id = row.properties.find((param) => param.key === TARGET_KEY)?.values[0]?.bits;
	const target = id === undefined || id === row.id ? undefined : rows.get(id);
	return target === undefined
		? new Map()
		: new Map([['RopeLength', Math.abs(row.position[1] - target.position[1])]]);
};

/**
 * @param name an effect's name
 * @returns the bundle path of its prefab, where the game's effect manager loads it from
 */
const effectPrefab = (name: string): string =>
	`assets/beyond/dynamicassets/gameplay/effects/prefabs/${name.toLowerCase()}.prefab`;

/**
 * @param m a rotation's matrix by row and column
 * @returns the rotation as an xyzw quaternion
 */
const matrixQuaternion = (m: readonly (readonly number[])[]): [number, number, number, number] => {
	const trace = m[0][0] + m[1][1] + m[2][2];
	if (trace > 0) {
		const s = 0.5 / Math.sqrt(trace + 1);
		return [(m[2][1] - m[1][2]) * s, (m[0][2] - m[2][0]) * s, (m[1][0] - m[0][1]) * s, 0.25 / s];
	}
	if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
		const s = 2 * Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]);
		return [0.25 * s, (m[0][1] + m[1][0]) / s, (m[0][2] + m[2][0]) / s, (m[2][1] - m[1][2]) / s];
	}
	if (m[1][1] > m[2][2]) {
		const s = 2 * Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]);
		return [(m[0][1] + m[1][0]) / s, 0.25 * s, (m[1][2] + m[2][1]) / s, (m[0][2] - m[2][0]) / s];
	}
	const s = 2 * Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]);
	return [(m[0][2] + m[2][0]) / s, (m[1][2] + m[2][1]) / s, 0.25 * s, (m[1][0] - m[0][1]) / s];
};

/**
 * @param matrix an affine column-major matrix without shear or mirroring
 * @param followRotation whether to keep its rotation; without, the placement keeps the world's axes
 * @returns its position, Unity Euler angles (degrees) and axis scales
 */
const matrixPlacement = (
	matrix: Float32Array,
	followRotation: boolean,
): Pick<DynamicModel, 'position' | 'rotation' | 'scale'> => {
	const columns = [0, 1, 2].map((c) => [matrix[c * 4], matrix[c * 4 + 1], matrix[c * 4 + 2]]);
	const scale = columns.map((column) => Math.hypot(...column));
	let rotation: [number, number, number] = [0, 0, 0];
	if (followRotation) {
		const rows = [0, 1, 2].map((r) => [0, 1, 2].map((c) => columns[c][r] / (scale[c] || 1)));
		rotation = quaternionUnityEuler(matrixQuaternion(rows));
	}
	return { position: [matrix[12], matrix[13], matrix[14]], rotation, scale: [scale[0], scale[1], scale[2]] };
};

/**
 * an interactive model's looks at rest. `away` and `near` are indexed by the activation (campfires: 0 not
 * activated, 1 activated; every other interactive has only 0). `near` is `null` when nothing the player's
 * presence sets changes the look
 */
interface InteractiveLooks {
	away: SettledLook[];
	near: SettledLook[] | null;
}

/** a view-state key that follows the player, and how near the player must be for it to hold */
interface PlayerKey {
	key: string;
	radius: number;
}

/**
 * view-state keys the player's presence sets, by the template component that sets them: `Distance` within the
 * interest component's distance, and a campfire's `InZone` inside its trigger sphere
 */
const PLAYER_KEYS = [
	{
		key: 'Distance',
		component: '_MainCharacterInterestComponentDataForMemoryPack',
		property: 'main_character_interest_distance',
	},
	{ key: 'InZone', component: '_TriggerObserverComponentDataForMemoryPack', property: 'radius' },
];

/**
 * @param template a decoded interactive template
 * @param suffix the component's type name suffix
 * @param key the property's key
 * @returns the float property of the template's first such component, or `null` without one
 */
const componentFloat = (template: MemoryPackValue, suffix: string, key: string): number | null => {
	const components =
		template !== null && typeof template === 'object' && !Array.isArray(template)
			? template.componentList
			: null;
	for (const component of Array.isArray(components) ? components : []) {
		if (
			component === null ||
			typeof component !== 'object' ||
			Array.isArray(component) ||
			typeof component.$type !== 'string' ||
			!component.$type.endsWith(suffix)
		) {
			continue;
		}
		for (const property of Array.isArray(component.propertyList) ? component.propertyList : []) {
			if (
				property === null ||
				typeof property !== 'object' ||
				Array.isArray(property) ||
				property.key !== key
			) {
				continue;
			}
			const value = property.value;
			const [atom] =
				value !== null &&
				typeof value === 'object' &&
				!Array.isArray(value) &&
				Array.isArray(value.valueArray)
					? value.valueArray
					: [];
			const bits =
				atom !== null && typeof atom === 'object' && !Array.isArray(atom) ? atom.valueBit64 : undefined;
			if (typeof bits !== 'string' && typeof bits !== 'number') {
				return null;
			}
			// float properties keep their IEEE bits in the 64-bit atom
			const view = new DataView(new ArrayBuffer(4));
			view.setUint32(0, Number(BigInt.asUintN(32, BigInt(bits))));
			return view.getFloat32(0);
		}
	}
	return null;
};

/**
 * @param template a decoded interactive template
 * @returns the player-set keys its components drive
 */
const playerKeys = (template: MemoryPackValue): PlayerKey[] =>
	PLAYER_KEYS.flatMap(({ key, component, property }) => {
		const radius = componentFloat(template, component, property);
		return radius === null || !(radius > 0) ? [] : [{ key, radius }];
	});

/**
 * @param context install readers and the bundle resolver
 * @param model a ModelTable model and the model whose view states it uses
 * @param campfire whether the model's `Enabled` key is the player's activation
 * @param keys the player-set keys the template drives; one whose radius is largest counts
 * @param state the `state` key's value, `null` when nothing sets it
 * @param floats float keys the interactive's components set before its view states start
 * @returns the model's settled looks, or `null` when it has no view states
 * @throws {FormatError} if a state machine can't settle or a clip can't be read
 */
const readInteractiveLooks = async (
	context: Pick<Context, 'vfs' | 'world' | 'resolver' | 'memoryPack'>,
	model: ModelViews,
	campfire: boolean,
	keys: readonly PlayerKey[],
	state: number | null,
	floats: ReadonlyMap<string, number>,
): Promise<InteractiveLooks | null> => {
	const states = await readViewStates(context, model);
	if (states === null) {
		return null;
	}
	const activations = campfire ? [false, true] : [null];
	const settle = (activated: boolean | null, near: boolean) => {
		const blackboard = new Map<string, boolean | number>(floats);
		if (state !== null) {
			blackboard.set(STATE_KEY, state);
		}
		if (activated !== null) {
			blackboard.set('Enabled', activated);
		}
		for (const { key } of keys) {
			blackboard.set(key, near);
		}
		const key = `${state === null ? '' : `state ${state} `}${activated === null ? '' : activated ? 'activated ' : 'locked '}${near ? 'near' : 'away'}`;
		return settledPose(context, states, key, blackboard);
	};
	const away: SettledLook[] = [];
	const near: SettledLook[] = [];
	for (const activated of activations) {
		// oxlint-disable-next-line no-await-in-loop -- a few one-frame clips per model
		away.push(await settle(activated, false));
		if (keys.length > 0) {
			// oxlint-disable-next-line no-await-in-loop -- as above
			near.push(await settle(activated, true));
		}
	}
	const changes = near.some((look, i) => look.states.join() !== away[i].states.join());
	return { away, near: changes ? near : null };
};

/**
 * @param template a decoded interactive template
 * @param suffixes component type name suffixes
 * @returns whether it has a component of one of those types
 */
const hasComponent = (template: MemoryPackValue, suffixes: readonly string[]): boolean => {
	const components =
		template !== null && typeof template === 'object' && !Array.isArray(template)
			? template.componentList
			: null;
	return (Array.isArray(components) ? components : []).some(
		(component) =>
			component !== null &&
			typeof component === 'object' &&
			!Array.isArray(component) &&
			typeof component.$type === 'string' &&
			suffixes.some((suffix) => typeof component.$type === 'string' && component.$type.endsWith(suffix)),
	);
};

/** the Animator bools an interactive sets on load: fixed ones, and at most one that follows a saved property */
interface AnimatorStart {
	/** values from constants and the template's config properties, by parameter name */
	fixed: Map<string, boolean>;
	/** the parameter set from a saved property, `null` without one */
	saved: { parameter: string; property: string } | null;
}

/** `paramSource` of an action value read from a constant, a config property and a saved property */
const PARAM_CONSTANT = 0;
const PARAM_CONFIG = 200;
const PARAM_SAVED = 300;

/**
 * @param properties a template's keyed property list
 * @param key the property's key
 * @returns its first atom's bits, or `null` when it's absent
 */
const propertyBits = (properties: MemoryPackValue | undefined, key: string): bigint | null => {
	for (const property of Array.isArray(properties) ? properties : []) {
		if (
			property === null ||
			typeof property !== 'object' ||
			Array.isArray(property) ||
			property.key !== key
		) {
			continue;
		}
		const value = property.value;
		const [atom] =
			value !== null && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.valueArray)
				? value.valueArray
				: [];
		const bits =
			atom !== null && typeof atom === 'object' && !Array.isArray(atom) ? atom.valueBit64 : undefined;
		return typeof bits === 'string' || typeof bits === 'number' ? BigInt(bits) : null;
	}
	return null;
};

/**
 * @param properties a template's keyed property list
 * @param key the property's key
 * @returns its first atom as a bool, or `null` when it's absent
 */
const boolProperty = (properties: MemoryPackValue | undefined, key: string): boolean | null => {
	const bits = propertyBits(properties, key);
	return bits === null ? null : bits !== 0n;
};

/**
 * @param properties a template's keyed property list
 * @param key the property's key
 * @returns its first atom as a 32-bit int, or `null` when it's absent
 */
const intProperty = (properties: MemoryPackValue | undefined, key: string): number | null => {
	const bits = propertyBits(properties, key);
	return bits === null ? null : Number(BigInt.asIntN(32, bits));
};

/** the component that passes an interactive's `state` property to its view states */
const COMMON_PERFORM_COMPONENTS = ['_InteractiveCommonPerformComponentDataForMemoryPack'];

/** the entity property, and view-state key, the common-perform component passes on */
const STATE_KEY = 'state';

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
	if (!isRecord(template) || !hasComponent(template, COMMON_PERFORM_COMPONENTS)) {
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
		const value = isRecord(variant) ? intProperty(variant.diffProperties, STATE_KEY) : null;
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
	if (!isRecord(template)) {
		return null;
	}
	const variants = new Map<string, MemoryPackValue>();
	for (const pair of Array.isArray(template.templateVariant) ? template.templateVariant : []) {
		if (Array.isArray(pair) && typeof pair[0] === 'string' && isRecord(pair[1])) {
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
		if (!isRecord(property) || property.key !== key || !isRecord(property.value)) {
			continue;
		}
		const atoms = Array.isArray(property.value.valueArray) ? property.value.valueArray : [];
		return atoms.filter(isRecord).map((atom) => ({
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
const entityProperty = (entity: EntityProperties, row: LevelInteractive, key: string): PropertyAtoms | null =>
	row.properties.find((param) => param.key === key)?.values ??
	templateAtoms(entity.variants.get(row.template), key) ??
	entity.lists.reduce<PropertyAtoms | null>((found, list) => found ?? templateAtoms(list, key), null);

/**
 * @param bits a float's IEEE bits in a 64-bit atom
 * @returns the float
 */
const atomFloat = (bits: bigint): number => {
	const view = new DataView(new ArrayBuffer(4));
	view.setUint32(0, Number(BigInt.asUintN(32, bits)));
	return view.getFloat32(0);
};

/**
 * @param entity the template's entity properties
 * @param row a placed interactive
 * @returns its starting `state`: the placement's, else its variant's, else the template's, else 0
 */
const entityState = (entity: EntityProperties, row: LevelInteractive): number =>
	stateOf(row) ?? Number(BigInt.asIntN(32, entityProperty(entity, row, STATE_KEY)?.[0]?.bits ?? 0n));

/**
 * @param template the decoded vertical jump pad template
 * @param row a placed vertical jump pad
 * @returns the looping effect it plays on its root, or `null` unless its `state` starts on (1)
 */
export const verticalPadEffect = (template: MemoryPackValue, row: LevelInteractive): string | null => {
	const entity = entityProperties(template);
	return entity !== null && entityState(entity, row) === 1 ? VERTICAL_PAD_EFFECT : null;
};

/**
 * the stationary effect a jump pad that isn't off (`state` 0) or a free jump places at itself, turned about
 * the vertical towards its target position
 *
 * @param template the decoded jump pad template
 * @param row a placed jump pad
 * @returns the effect's name and its yaw in degrees, or `null` when it places none
 */
export const jumpPadArrow = (
	template: MemoryPackValue,
	row: LevelInteractive,
): { effect: string; yaw: number } | null => {
	const entity = entityProperties(template);
	const params = componentParams(template, row, JUMP_MACHINE);
	if (entity === null || params === null) {
		return null;
	}
	// a pad is locked while its `state` is off (0), whatever its `is_locked` property says. `free_jump` and
	// `effect` are the component's own parameters; the state and the target are the entity's
	const locked = entityState(entity, row) === 0;
	const free = (params.get('free_jump')?.values[0]?.bits ?? 0n) !== 0n;
	const effect = params.get('effect')?.values[0]?.text;
	if (locked || free || !effect) {
		return null;
	}
	const target = (entityProperty(entity, row, 'target_position') ?? []).map((atom) => atomFloat(atom.bits));
	const dx = (target[0] ?? 0) - row.position[0];
	const dz = (target[2] ?? 0) - row.position[2];
	// a zero direction looks along +z
	return { effect, yaw: dx === 0 && dz === 0 ? 0 : (Math.atan2(dx, dz) * 180) / Math.PI };
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
	for (const params of row.componentProperties.values()) {
		const bits = params.find((param) => param.key === STATE_KEY)?.values[0]?.bits;
		if (bits !== undefined) {
			return Number(BigInt.asIntN(32, bits));
		}
	}
	return null;
};

const isRecord = (value: MemoryPackValue): value is { [key: string]: MemoryPackValue } =>
	value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * @param template a decoded interactive template
 * @returns the Animator bools its simple-animator component gets from the template's on-load action chain, or
 *   `null` when it has no such component or chain, or sets more than one bool from saved properties
 */
const animatorStart = (template: MemoryPackValue): AnimatorStart | null => {
	if (
		template === null ||
		typeof template !== 'object' ||
		Array.isArray(template) ||
		!hasComponent(template, ['_SimpleAnimatorComponentDataForMemoryPack'])
	) {
		return null;
	}
	const map = template.dataMap;
	if (map === null || typeof map !== 'object' || Array.isArray(map)) {
		return null;
	}
	const headers = Array.isArray(map.headerList) ? map.headerList.filter(isRecord) : [];
	const actions = new Map(
		(Array.isArray(map.actionList) ? map.actionList.filter(isRecord) : []).map((action) => [
			action.ID,
			action,
		]),
	);
	const start = headers.find(
		(header) => typeof header.$type === 'string' && header.$type.endsWith('_OnEntityStartForMemoryPack'),
	);
	if (start === undefined) {
		return null;
	}
	const fixed = new Map<string, boolean>();
	let saved: AnimatorStart['saved'] = null;
	const visited = new Set<MemoryPackValue>();
	for (let id = start.nextID; !visited.has(id);) {
		visited.add(id);
		const action = actions.get(id);
		if (action === undefined) {
			break;
		}
		id = action.nextID;
		if (typeof action.$type !== 'string' || !action.$type.endsWith('_SetAnimatorBoolForMemoryPack')) {
			continue;
		}
		const parameter = isRecord(action.key) ? action.key.constValue : null;
		const value = isRecord(action.value) ? action.value : null;
		if (typeof parameter !== 'string' || value === null) {
			continue;
		}
		const path = typeof value.path === 'string' ? value.path : '';
		switch (value.paramSource) {
			case PARAM_CONSTANT: {
				fixed.set(parameter, value.constValue === true);
				break;
			}
			case PARAM_CONFIG: {
				fixed.set(parameter, boolProperty(template.configProperties, path) ?? false);
				break;
			}
			case PARAM_SAVED: {
				if (saved !== null && (saved.parameter !== parameter || saved.property !== path)) {
					return null;
				}
				saved = { parameter, property: path };
				break;
			}
			default: {
				break;
			}
		}
	}
	return fixed.size === 0 && saved === null ? null : { fixed, saved };
};

/** the interactive logic type of telescopic bridges */
const TELESCOPIC_LOGIC = 8;

/** `InteractiveComponentType.ActivitySnapshotComponent`: a limited-time photo event's spot */
const ACTIVITY_SNAPSHOT_COMPONENT = 2000;

/** the scene's one control for limited-time event placements */
/** the id of {@link activityControl} */
const ACTIVITY_CONTROL_ID = 'activity:snapshot';

const activityControl = (): DraftControl =>
	sceneControl({
		kind: 'activity',
		id: ACTIVITY_CONTROL_ID,
		name: 'Event photo spots',
		values: SWITCH_VALUES,
		default: 0,
		assumption: 'hidden: placed for limited-time photo events, which the server opens and closes',
	});

/** the template and placement property holding a telescopic bridge's piece count */
const PIECES_KEY = 'pieces';

/**
 * @param template a decoded interactive template
 * @param path its file, for errors
 * @returns its piece count when its logic is a telescopic bridge, otherwise `null`
 * @throws {FormatError} if a telescopic bridge lacks a valid piece count
 */
const telescopicPieces = (template: MemoryPackValue, path: string): number | null => {
	if (template === null || typeof template !== 'object' || Array.isArray(template)) {
		return null;
	}
	const components = Array.isArray(template.componentList) ? template.componentList : [];
	const telescopic = components.some(
		(component) =>
			component !== null &&
			typeof component === 'object' &&
			!Array.isArray(component) &&
			typeof component.$type === 'string' &&
			component.$type.endsWith('_InteractiveLogicControllerComponentDataForMemoryPack') &&
			component.logicType === TELESCOPIC_LOGIC,
	);
	if (!telescopic) {
		return null;
	}
	const properties = Array.isArray(template.configProperties) ? template.configProperties : [];
	for (const property of properties) {
		if (property === null || typeof property !== 'object' || Array.isArray(property)) {
			continue;
		}
		const value = property.value;
		if (property.key !== PIECES_KEY || value === null || typeof value !== 'object' || Array.isArray(value)) {
			continue;
		}
		const [atom] = Array.isArray(value.valueArray) ? value.valueArray : [];
		const bits =
			atom !== null && typeof atom === 'object' && !Array.isArray(atom) ? atom.valueBit64 : undefined;
		const pieces = typeof bits === 'string' || typeof bits === 'number' ? Number(bits) : Number.NaN;
		if (Number.isInteger(pieces) && pieces > 0 && pieces <= 64) {
			return pieces;
		}
	}
	throw new FormatError(`${path} is a telescopic bridge without a valid ${PIECES_KEY} count`);
};

/**
 * @param row a placed interactive
 * @returns its piece count override on any component, or null
 */
const piecesOf = (row: LevelInteractive): number | null => {
	for (const params of row.componentProperties.values()) {
		const bits = params.find((param) => param.key === PIECES_KEY)?.values[0]?.bits;
		if (bits !== undefined) {
			return Number(bits);
		}
	}
	return null;
};

const TABLE = 'Data/Json/Interactive/InteractiveTable.json';

/** construction area → the Control Nexus level that unlocks it */
const AREA_UNLOCK_TABLE = 'Data/TableCfg/SpaceshipAreaUnlockNeedCenterLvTable.bytes';

/** the placement parameter naming a region wall's construction area */
const AREA_KEY = 'system_inst_key';

/**
 * @param row a placed interactive
 * @returns the string of its {@link AREA_KEY} parameter on any component, or null
 */
const areaOf = (row: LevelInteractive): string | null => {
	for (const params of row.componentProperties.values()) {
		const text = params.find((param) => param.key === AREA_KEY)?.values[0]?.text;
		if (text) {
			return text;
		}
	}
	return null;
};

/** a placed door and its open/closed control */
export interface InteractiveDoor {
	control: DraftControl;
	position: [number, number, number];
}

/** a placed interactive with a model the reader couldn't find, to draw a stand-in for */
export interface InteractiveStandIn {
	/** `<LevelData path>#<row id>` */
	source: string;
	template: string;
	reason: string;
	levelTag: number;
	position: [number, number, number];
	/** Unity Euler angles, degrees */
	rotation: [number, number, number];
	scale: [number, number, number];
	/** when it shows: always, or with its level's `created` control for a row the game creates later */
	visibility: Visibility;
}

/**
 * resolves the models of interactives placed by referenced LevelData: the visual forms of the facility
 * templates in {@link TEMPLATES}, each under a `facility:<id>` control, and every other interactive's model
 * (its template variant's, else the template's; none for a variant that overrides it with an empty model),
 * always shown. a model that is a doodad-group shell also places its form models, one per group level, under
 * a per-level `doodadGroups:<level id>` control. a model with door poses is placed closed and open, under a
 * `door:<id>` control, closed by default. a telescopic bridge is placed retracted and extended, under a
 * `bridge:<id>` control, retracted by default. a model without view states whose template sets its own
 * Animator's bools on load is posed in the states they settle; one bool from a saved property puts it under
 * an `activation:<id>` control, set by default. rows the game creates later (`createState` ≠ 0) are placed
 * the same way and also require their level's `created:<level id>` control, off by default. a limited-time
 * photo event's spot also requires the scene's `activity:snapshot` control, off by default. an auto-moving
 * platform that starts with its level rides its spline
 *
 * @param context install readers and the bundle resolver
 * @param scene owning map
 * @param level restricts decoding to one level, or null for the map
 * @param partition numeric level tags
 * @param scripted logic ids of the interactives level scripts show and hide
 * @param erosionCores by logic id, the conditions a blight core's erosion root loads under
 * @returns placements, controls, explicit unsupported-file diagnostics and the placements of interactives
 *   whose model wasn't found (a template that's missing or can't be read, or a model id the model table
 *   lacks); no partial file is used
 * @throws {FormatError} for broken authored references or malformed supported records
 */
export const loadInteractiveFacilities = async (
	context: Pick<Context, 'vfs' | 'world' | 'resolver' | 'memoryPack'>,
	scene: string,
	level: string | null,
	partition: LevelPartition | undefined,
	scripted: ReadonlySet<string>,
	erosionCores: ReadonlyMap<string, Alternatives>,
): Promise<{
	models: StructureModel[];
	progressions: DraftControl[];
	/** by logic id, the controls of the rows level scripts show and hide, shown as placed */
	scriptControls: Map<string, DraftControl>;
	/** per level with rows the game creates later (`createState` ≠ 0), the control that shows them, off */
	created: DraftControl[];
	/** the control that shows limited-time event placements, off; empty when the scene has none */
	activities: DraftControl[];
	/** controls of interactives whose look follows the player's presence */
	proximityControls: DraftControl[];
	doors: InteractiveDoor[];
	bridges: DraftControl[];
	unsupported: { path: string; reason: string }[];
	standIns: InteractiveStandIn[];
	/** every placed row's template and position, by logic id */
	placements: Map<string, { template: string; position: Vec3 }>;
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
	const viewsOf = (model: string): ModelViews => {
		const source = objectField(modelData, model).dependModelViewDataId;
		return { model, source: typeof source === 'string' && source !== '' ? source : model };
	};
	const formOf = (modelId: string, scale: number): { model: string; prefab: string; scale: number } => {
		const data = objectField(modelData, modelId);
		return {
			model: modelId,
			prefab: stringField(data, 'path').toLowerCase(),
			scale: scale * numberField(data, 'scaleFactor'),
		};
	};
	const interactives = readInteractiveTable(await read(TABLE), string);
	const unsupported: { path: string; reason: string }[] = [];

	// placements first, so only the templates they use are read
	const pathOf = await world.pathLookup();
	const placed: {
		path: string;
		levelId: string;
		levelTag: number;
		row: LevelInteractive;
		/** the `created:<level id>` control of a row the game creates later, `null` for one created with the level */
		created: string | null;
	}[] = [];
	/** by level id, the control of its rows created later */
	const createdControls = new Map<string, DraftControl>();
	/** by level id, its LevelData files, which also hold the splines its moving platforms ride */
	const levelDataPaths = new Map<string, string[]>();
	{
		const seen = new Set<bigint>();
		const later: typeof placed = [];
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
				levelDataPaths.getOrInsertComputed(config.id, () => []).push(path);
				let prefix;
				try {
					// oxlint-disable-next-line no-await-in-loop -- level files are released after their prefix is decoded
					prefix = readLevelDataPrefix(await read(path), string);
				} catch (error) {
					if (!(error instanceof UnsupportedLevelData)) {
						throw error;
					}
					unsupported.push({ path, reason: error.message });
					continue;
				}
				if (prefix.hideByTypeAreas > 0) {
					unsupported.push({
						path,
						reason: `${prefix.hideByTypeAreas} function areas that hide entities by type aren't applied`,
					});
				}
				for (const row of prefix.interactives) {
					if (row.createState !== 0) {
						later.push({ path, levelId: config.id, levelTag, row, created: `created:${config.id}` });
						continue;
					}
					if (seen.has(row.id)) {
						continue;
					}
					seen.add(row.id);
					placed.push({ path, levelId: config.id, levelTag, row, created: null });
				}
			}
		}
		// a row created with its level wins over the same id created later in another layer
		for (const entry of later) {
			if (seen.has(entry.row.id)) {
				continue;
			}
			seen.add(entry.row.id);
			placed.push(entry);
			createdControls.getOrInsertComputed(entry.levelId, () =>
				sceneControl({
					kind: 'created',
					id: `created:${entry.levelId}`,
					name: `Created later (${entry.levelId})`,
					values: switchValues('not created', 'created'),
					default: 0,
					assumption: 'hidden: the server or a level script creates these interactives during play',
				}),
			);
		}
	}

	const authored = new Map<
		string,
		{
			name: string | null;
			forms: { model: string; prefab: string; scale: number }[];
			/** the ModelTable id of a single-model interactive, `null` for facilities */
			model: string | null;
			/** the template's data file */
			data: string;
		}
	>();
	/** by placed template id, why its model wasn't found */
	const modelless = new Map<string, string>();
	const templates = new Map<
		string,
		{
			base: { id: string; scale: number } | null;
			variants: Map<string, string | null>;
			/** why the template couldn't be read, `null` when it was */
			failure: string | null;
		}
	>();
	const variantsOf = new Map<string, Set<string>>();
	for (const [id, template] of interactives.templates) {
		if (id !== template) {
			variantsOf.getOrInsertComputed(template, () => new Set()).add(id);
		}
	}
	/** by template data file, its upgrade models, or `null` without the model-upgrade component */
	const upgrades = new Map<string, ReturnType<typeof facilityModels> | null>();
	for (const key of new Set(placed.map(({ row }) => row.template))) {
		const template = interactives.templates.get(key);
		const data = template === undefined ? undefined : interactives.templatePaths.get(template);
		if (template === undefined || data === undefined) {
			unsupported.push({ path: TABLE, reason: `no template for ${key}` });
			modelless.set(key, 'no template');
			continue;
		}
		let upgrade = upgrades.get(data);
		if (upgrade === undefined) {
			try {
				// oxlint-disable-next-line no-await-in-loop -- small templates, read once per map
				const decoded = reader.decode(await read(data), TEMPLATE_ROOT);
				upgrade = hasComponent(decoded, MODEL_UPGRADE_COMPONENTS) ? facilityModels(decoded, data) : null;
			} catch (error) {
				if (!(error instanceof FormatError)) {
					throw error;
				}
				// drawn with its base model only, as read below
				unsupported.push({ path: data, reason: `model upgrades: ${error.message}` });
				upgrade = null;
			}
			upgrades.set(data, upgrade);
		}
		if (upgrade !== null) {
			authored.set(key, {
				name: FACILITY_NAMES.get(key) ?? key,
				forms: upgrade.levels.map((modelId) => formOf(modelId, upgrade.scale)),
				model: null,
				data,
			});
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
					failure: null,
				};
			} catch (error) {
				if (!(error instanceof FormatError)) {
					throw error;
				}
				unsupported.push({ path: data, reason: error.message });
				resolved = { base: null, variants: new Map(), failure: error.message };
			}
			templates.set(template, resolved);
		}
		if (resolved.failure !== null) {
			// the template may have had a model, so it gets a stand-in rather than being taken for a trigger
			modelless.set(key, resolved.failure);
			continue;
		}
		const { base } = resolved;
		const modelId = resolved.variants.has(key) ? resolved.variants.get(key) : base?.id;
		if (modelId === undefined || modelId === null) {
			// triggers and logic-only interactives have no model, and variants that empty it (bridges whose
			// DynamicStreaming row is the model they drive) draw nothing of their own
			continue;
		}
		if (!(modelId in modelData)) {
			unsupported.push({ path: data, reason: `model ${modelId} of ${key} is not in the model table` });
			modelless.set(key, `model ${modelId} is not in the model table`);
			continue;
		}
		authored.set(key, {
			name: null,
			forms: [formOf(modelId, base?.scale ?? 1)],
			model: modelId,
			data,
		});
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

	// doors drawn open or closed: interactives of door templates whose model has door poses, by key. region
	// walls, by key, are drawn while their construction area is locked
	const doorPoses = new Map<string, DoorPoses>();
	// other interactives with view states drawn as they rest, by key: campfires locked or activated, and those
	// the player's presence changes away or near, within `radius`
	const interactiveLooks = new Map<
		string,
		{
			model: string;
			looks: InteractiveLooks;
			campfire: boolean;
			keys: PlayerKey[];
			radius: number | null;
			/** the `state` `looks` were settled with, `null` when nothing passes one on */
			state: number | null;
			/** whether it's a vertical rope's port, whose look also follows its other port */
			verticalRope: boolean;
		}
	>();
	// a failed read reports and leaves the model drawn as saved
	const attempt = async <T>(path: string, run: () => Promise<T>, failed: T): Promise<T> => {
		try {
			return await run();
		} catch (error) {
			if (!(error instanceof FormatError)) {
				throw error;
			}
			unsupported.push({ path, reason: error.message });
			return failed;
		}
	};
	const looksByModel = new Map<string, Promise<InteractiveLooks | null>>();
	const looksFor = (
		model: string,
		campfire: boolean,
		keys: readonly PlayerKey[],
		state: number | null,
		floats: ReadonlyMap<string, number>,
	): Promise<InteractiveLooks | null> =>
		looksByModel.getOrInsertComputed(
			`${model} ${campfire} ${keys.map((entry) => entry.key).join()} ${state} ${JSON.stringify([...floats])}`,
			() =>
				attempt(
					model,
					() => readInteractiveLooks(context, viewsOf(model), campfire, keys, state, floats),
					null,
				),
		);
	// facility forms with view states drawn as they rest (an idle loop keeps playing), by ModelTable id
	const formPoses = new Map<string, PrefabPose>();
	const regionWalls = new Set<string>();
	// interactives without view states whose template sets their own Animator's bools on load, by key
	const animatorStarts = new Map<string, AnimatorStart>();
	/** telescopic bridges' piece counts and prefab roots, by key */
	const telescopic = new Map<string, { pieces: number; prefab: string }>();
	/** jump pads' decoded templates, which say whether and where they place their arrow, by key */
	const jumpPads = new Map<string, MemoryPackValue>();
	/** vertical jump pads' decoded templates, by key */
	const verticalPads = new Map<string, MemoryPackValue>();
	/** auto-moving platforms' decoded templates and starting `state`, by key */
	const autoMoves = new Map<string, { template: MemoryPackValue; start: StartState | null }>();
	/** crane towers' decoded templates, by key */
	const craneTowers = new Map<string, MemoryPackValue>();
	/** entity properties of other single-model templates (crane containers among them), by key */
	const entities = new Map<string, EntityProperties>();
	{
		const templateKinds = new Map<
			string,
			| { kind: 'door' | 'regionWall' }
			| { kind: 'telescopic'; pieces: number }
			| {
					kind: 'other';
					campfire: boolean;
					keys: PlayerKey[];
					animator: AnimatorStart | null;
					start: StartState | null;
					/** a jump pad's decoded template, `null` for other templates */
					jumpPad: MemoryPackValue | null;
					/** a vertical jump pad's decoded template, `null` for other templates */
					verticalPad: MemoryPackValue | null;
					/** an auto-moving platform's decoded template, `null` for other templates */
					autoMove: MemoryPackValue | null;
					verticalRope: boolean;
					/** a crane tower's decoded template, `null` for other templates */
					craneTower: MemoryPackValue | null;
					entity: EntityProperties | null;
			  }
		>();
		const byModel = new Map<string, DoorPoses | null>();
		for (const [key, { model, data, forms }] of authored) {
			if (model === null) {
				// a facility: each visual form is its own model, settled with every key false
				for (const form of forms) {
					if (formPoses.has(form.model)) {
						continue;
					}
					// oxlint-disable-next-line no-await-in-loop -- one view state file and a clip per form
					const looks = await attempt(
						form.model,
						() => readInteractiveLooks(context, viewsOf(form.model), false, [], null, new Map()),
						null,
					);
					if (looks !== null) {
						formPoses.set(form.model, looks.away[0].pose);
					}
				}
				continue;
			}
			let kind = templateKinds.get(data);
			if (kind === undefined) {
				// oxlint-disable-next-line no-await-in-loop -- one decode per template
				kind = await attempt(
					data,
					async () => {
						const decoded = reader.decode(await read(data), TEMPLATE_ROOT);
						if (hasComponent(decoded, DOOR_COMPONENTS)) {
							return { kind: 'door' as const };
						}
						if (hasComponent(decoded, REGION_WALL_COMPONENTS)) {
							return { kind: 'regionWall' as const };
						}
						const pieces = telescopicPieces(decoded, data);
						if (pieces !== null) {
							return { kind: 'telescopic' as const, pieces };
						}
						return {
							kind: 'other' as const,
							campfire: hasComponent(decoded, CAMPFIRE_COMPONENTS),
							keys: playerKeys(decoded),
							animator: animatorStart(decoded),
							start: startState(decoded),
							jumpPad: hasComponent(decoded, JUMP_MACHINE_COMPONENTS) ? decoded : null,
							verticalPad: hasComponent(decoded, JUMP_MACHINE_VERTICAL_COMPONENTS) ? decoded : null,
							autoMove: isAutoMovePlatform(decoded) ? decoded : null,
							verticalRope: hasComponent(decoded, VERTICAL_ROPE_COMPONENTS),
							craneTower: hasComponent(decoded, CRANE_TOWER_COMPONENTS) ? decoded : null,
							entity: entityProperties(decoded),
						};
					},
					// an unreadable template is drawn as saved
					{
						kind: 'other' as const,
						campfire: false,
						keys: [],
						animator: null,
						start: null,
						jumpPad: null,
						verticalPad: null,
						autoMove: null,
						verticalRope: false,
						craneTower: null,
						entity: null,
					},
				);
				templateKinds.set(data, kind);
			}
			if (kind.kind === 'other' && kind.autoMove !== null) {
				autoMoves.set(key, { template: kind.autoMove, start: kind.start });
			}
			if (kind.kind === 'other' && kind.craneTower !== null) {
				craneTowers.set(key, kind.craneTower);
			}
			if (kind.kind === 'other' && kind.entity !== null) {
				entities.set(key, kind.entity);
			}
			if (kind.kind === 'regionWall') {
				regionWalls.add(key);
			}
			if (kind.kind === 'telescopic') {
				telescopic.set(key, { pieces: kind.pieces, prefab: forms[0].prefab });
			}
			// a doodad-group shell draws nothing itself; its forms attach to it instead
			if (kind.kind === 'other' && kind.jumpPad !== null) {
				jumpPads.set(key, kind.jumpPad);
			}
			if (kind.kind === 'other' && kind.verticalPad !== null) {
				verticalPads.set(key, kind.verticalPad);
			}
			if (kind.kind === 'other' && !doodads.has(key)) {
				const { campfire, keys, start, verticalRope } = kind;
				const state = start === null ? null : (start.variants.get(key) ?? start.state);
				// oxlint-disable-next-line no-await-in-loop -- one view state file and a few clips per model
				const looks = await looksFor(model, campfire, keys, state, new Map());
				if (looks !== null) {
					const radius = looks.near === null ? null : Math.max(...kind.keys.map((entry) => entry.radius));
					interactiveLooks.set(key, { model, looks, campfire, keys, radius, state, verticalRope });
				} else if (kind.animator !== null) {
					animatorStarts.set(key, kind.animator);
				}
				continue;
			}
			if (kind.kind !== 'door') {
				continue;
			}
			let poses = byModel.get(model);
			if (poses === undefined) {
				// oxlint-disable-next-line no-await-in-loop -- a few view state files and one-frame clips per map
				poses = await attempt(model, () => readDoorPoses(context, viewsOf(model)), null);
				byModel.set(model, poses);
			}
			if (poses !== null) {
				doorPoses.set(key, poses);
			}
		}
	}

	// Dijiang's region walls hide once the Control Nexus level unlocks their construction area. one control,
	// offered at the levels that unlock an area; levels between them change no wall
	let nexus: { control: DraftControl; unlockOf: Map<string, number> } | null = null;
	{
		const walls = placed.filter(({ row }) => regionWalls.has(row.template));
		const file = walls.length > 0 ? await vfs.find(VfsGroup.Table, AREA_UNLOCK_TABLE) : undefined;
		if (walls.length > 0 && file === undefined) {
			unsupported.push({ path: AREA_UNLOCK_TABLE, reason: 'missing; region walls stay shown' });
		}
		if (file !== undefined) {
			const unlockOf = new Map<string, number>();
			for (const [area, unlock] of parseSparkTable(await vfs.readVerified(file)).entries) {
				if (typeof area !== 'string' || typeof unlock !== 'number' || unlock < 1 || unlock > 31) {
					throw new FormatError(`${AREA_UNLOCK_TABLE} has an invalid entry for ${String(area)}`);
				}
				unlockOf.set(area, unlock);
			}
			// oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy
			const levels = [...new Set([1, ...unlockOf.values()])].sort((a, b) => a - b);
			nexus = {
				control: sceneControl({
					kind: 'controlNexus',
					id: `controlNexus:${walls[0].levelId}`,
					name: 'Control Nexus level',
					values: levels.map((value) => ({ value, label: `Level ${value}` })),
					default: 1,
					assumption: 'level 1, before the player upgrades it',
				}),
				unlockOf,
			};
		}
	}

	const models: StructureModel[] = [];
	const progressions: DraftControl[] = nexus === null ? [] : [nexus.control];
	const proximityControls: DraftControl[] = [];
	const doors: InteractiveDoor[] = [];
	const bridges: DraftControl[] = [];
	const doodadLevels = new Map<string, Set<number>>();
	const standIns: InteractiveStandIn[] = [];
	/** by prefab and piece count; `null` when the prefab isn't a readable telescopic bridge (drawn as saved) */
	const bridgeLooks = new Map<string, Promise<TelescopicPoses | null>>();
	const telescopicLooks = (prefab: string, pieces: number): Promise<TelescopicPoses | null> =>
		bridgeLooks.getOrInsertComputed(`${prefab}:${pieces}`, async () => {
			try {
				const resolver = await context.resolver();
				const root = await resolver.findUnique({ hash: hashOf(prefab), path: prefab }, UnityClass.GameObject);
				const looks = await readTelescopicPoses(resolver, root, prefab, pieces);
				if (looks === null) {
					unsupported.push({ path: prefab, reason: 'telescopic bridge prefab has no bridge MonoBehaviour' });
				}
				return looks;
			} catch (error) {
				if (!(error instanceof FormatError)) {
					throw error;
				}
				unsupported.push({ path: prefab, reason: error.message });
				return null;
			}
		});
	/** by prefab and parameter values; `null` when no Animator plays a clip (drawn as saved) */
	const startPoses = new Map<string, Promise<PrefabPose | null>>();
	/**
	 * @param prefab the interactive's model prefab
	 * @param start the Animator bools its template sets on load
	 * @param saved the saved property's value, `null` without one
	 * @returns what the prefab's Animators rest in under those bools
	 */
	const startPose = (
		prefab: string,
		start: AnimatorStart,
		saved: boolean | null,
	): Promise<PrefabPose | null> => {
		const parameters = new Map<number, boolean>();
		for (const [name, value] of start.fixed) {
			parameters.set(animatorParameterId(name), value);
		}
		if (start.saved !== null && saved !== null) {
			parameters.set(animatorParameterId(start.saved.parameter), saved);
		}
		const key = `${prefab}:${[...parameters].map(([id, value]) => `${id}=${Number(value)}`).join(',')}`;
		return startPoses.getOrInsertComputed(key, async () => {
			try {
				const resolver = await context.resolver();
				const root = await resolver.findUnique({ hash: hashOf(prefab), path: prefab }, UnityClass.GameObject);
				return await animatorPose(resolver, root, parameters);
			} catch (error) {
				if (!(error instanceof FormatError)) {
					throw error;
				}
				unsupported.push({ path: prefab, reason: error.message });
				return null;
			}
		});
	};
	/** effects to place once their prefabs' hashes are found, after every placement is read */
	const pendingEffects: {
		effect: string;
		source: string;
		levelTag: number;
		visibility: Visibility;
		/** the world matrix the effect is placed relative to: its model's placement, or its own */
		frame: Float32Array;
		/** the model and pose whose GameObject the effect plays on, `null` when placed at {@link frame} itself */
		on: { prefab: string; pose: PrefabPose; rest: RestingEffect } | null;
		followRotation: boolean;
	}[] = [];
	/** by level id, the splines its LevelData files hold */
	const levelSplines = new Map<string, Promise<Map<number, LevelSpline>>>();
	const splinesOf = (levelId: string): Promise<Map<number, LevelSpline>> =>
		levelSplines.getOrInsertComputed(levelId, async () => {
			const splines = new Map<number, LevelSpline>();
			for (const path of levelDataPaths.get(levelId) ?? []) {
				try {
					// oxlint-disable-next-line no-await-in-loop -- one level's files, each released once read
					for (const spline of readLevelSplines(reader.decode(await read(path), LEVEL_DATA_ROOT))) {
						splines.set(spline.id, spline);
					}
				} catch (error) {
					if (!(error instanceof FormatError)) {
						throw error;
					}
					unsupported.push({ path, reason: `splines: ${error.message}` });
				}
			}
			return splines;
		});
	/** by level id, the unlock types of its interactives' gameplay locks, by logic id */
	const levelLocks = new Map<string, Promise<Map<bigint, number[]>>>();
	const locksOf = (levelId: string): Promise<Map<bigint, number[]>> =>
		levelLocks.getOrInsertComputed(levelId, async () => {
			const locks = new Map<bigint, number[]>();
			for (const path of levelDataPaths.get(levelId) ?? []) {
				try {
					// oxlint-disable-next-line no-await-in-loop -- one level's files, each released once read
					for (const [id, types] of readLevelLocks(reader.decode(await read(path), LEVEL_DATA_ROOT))) {
						locks.set(id, types);
					}
				} catch (error) {
					if (!(error instanceof FormatError)) {
						throw error;
					}
					unsupported.push({ path, reason: `gameplay locks: ${error.message}` });
				}
			}
			return locks;
		});
	/**
	 * @returns the spline an auto-moving platform rides and how, when it starts moving with its level (its
	 *   `state` is 1 and it names a spline); otherwise `null`
	 */
	const rideOf = async (
		row: LevelInteractive,
		levelId: string,
	): Promise<{ spline: LevelSpline; move: CurveMove } | null> => {
		const auto = autoMoves.get(row.template);
		if (auto === undefined) {
			return null;
		}
		const state = stateOf(row) ?? auto.start?.variants.get(row.template) ?? auto.start?.state ?? 0;
		const move = curveMoveOf(auto.template, row);
		if (state !== 1 || move === null || move.splineId === 0) {
			return null;
		}
		const spline = (await splinesOf(levelId)).get(move.splineId);
		if (spline === undefined) {
			unsupported.push({ path: levelId, reason: `spline ${move.splineId} of ${row.template} not found` });
			return null;
		}
		return { spline, move };
	};
	const scriptControls = new Map<string, DraftControl>();
	// a vertical rope's port finds its other port by id
	const rowsById = new Map(placed.map(({ row }) => [row.id, row]));
	// a crane tower starts at its steps and hangs its container from its hook, wherever that was placed
	/** by tower row id, its look */
	const craneLooks = new Map<bigint, PrefabPose>();
	/** by container row id, where its tower hangs it */
	const hung = new Map<bigint, { position: [number, number, number]; rotation: [number, number, number] }>();
	for (const { path, row } of placed) {
		const template = craneTowers.get(row.template);
		const entity = entities.get(row.template);
		const form = authored.get(row.template)?.forms[0];
		if (template === undefined || entity === undefined || form === undefined) {
			continue;
		}
		const source = `${path}#${row.id}`;
		const tower = craneTowerOf(template, row);
		const state = (key: string) =>
			Number(BigInt.asIntN(32, entityProperty(entity, row, key)?.[0]?.bits ?? 0n));
		const steps = tower && craneSteps(tower, [state('state_1'), state('state_2'), state('state_3')]);
		if (tower === null || steps === null) {
			unsupported.push({ path: source, reason: 'crane tower has an empty step list; drawn as saved' });
			continue;
		}
		const scale = row.modelScale > 0 ? row.modelScale : form.scale;
		// oxlint-disable-next-line no-await-in-loop -- a few towers per map, each read once
		const look = await attempt(
			form.prefab,
			async () => {
				const resolver = await context.resolver();
				const root = await resolver.findUnique(
					{ hash: hashOf(form.prefab), path: form.prefab },
					UnityClass.GameObject,
				);
				return readCraneLook(
					resolver,
					root,
					form.prefab,
					{
						position: row.position,
						rotation: unityEulerQuaternion(row.rotation),
						scale: row.scale.map((axis) => axis * scale),
					},
					steps,
				);
			},
			null,
		);
		if (look === null) {
			unsupported.push({
				path: source,
				reason: 'crane tower prefab has no crane MonoBehaviour; drawn as saved',
			});
			continue;
		}
		craneLooks.set(row.id, look.pose);
		const container = tower.target === null ? undefined : rowsById.get(tower.target);
		const containerEntity = container && entities.get(container.template);
		if (container === undefined || containerEntity === undefined) {
			unsupported.push({ path: source, reason: `crane tower's container ${tower.target} isn't placed` });
			continue;
		}
		const height = entityProperty(containerEntity, container, 'height')?.[0]?.bits;
		const drop = height === undefined ? DEFAULT_CONTAINER_HEIGHT : atomFloat(height);
		const [x, y, z] = look.attach.position;
		hung.set(container.id, {
			position: [x, y - drop, z],
			rotation: quaternionUnityEuler(look.attach.rotation),
		});
	}
	/** whether any placement needs {@link activityControl} */
	let activity = false;
	for (const { path, levelId, levelTag, row, created } of placed) {
		// a row created later also needs its level's `created` control on, and one a level script shows and hides
		// its script control
		const logicId = row.id.toString();
		const source = `${path}#${row.id}`;
		const switches: string[] = [];
		if (created !== null) {
			switches.push(created);
		}
		if (row.componentProperties.has(ACTIVITY_SNAPSHOT_COMPONENT)) {
			switches.push(ACTIVITY_CONTROL_ID);
			activity = true;
		}
		// an auto-moving platform started with its level rides its spline
		// oxlint-disable-next-line no-await-in-loop -- splines are read once per level
		const ride = await rideOf(row, levelId);
		// a mini-game or submit lock swaps the model to its locked look until the player opens it
		// oxlint-disable-next-line no-await-in-loop -- locks are read once per level
		const locks = (await locksOf(levelId)).get(row.id);
		const locked =
			locks?.some(
				(type) => type === InteractiveUnlockType.MiniGame || type === InteractiveUnlockType.Submit,
			) ?? false;
		if (scripted.has(logicId)) {
			const control = `script:${logicId}`;
			switches.push(control);
			scriptControls.getOrInsertComputed(logicId, () =>
				sceneControl({
					kind: 'script',
					id: control,
					name: row.template,
					position: row.position,
					values: SWITCH_VALUES,
					default: 1,
					assumption: 'shown as placed until a level script hides it',
				}),
			);
		}
		// a blight core shows while its erosion root or sludge loads, so both go when the core is destroyed
		const erosion = erosionCores.get(logicId);
		const switchRequirements = switches.map((control) => ({ control, mask: 2 }));
		const gate = (visibility: Visibility): Visibility => {
			const alternatives =
				erosion === undefined ? visibility.alternatives : allOf(visibility.alternatives, erosion);
			return { alternatives: alternatives.map((requirements) => requirements.concat(switchRequirements)) };
		};
		const template = authored.get(row.template);
		if (template === undefined) {
			const reason = modelless.get(row.template);
			if (reason !== undefined) {
				standIns.push({
					source,
					template: row.template,
					reason,
					levelTag,
					position: row.position,
					rotation: row.rotation,
					scale: row.scale,
					visibility: gate({ alternatives: [[]] }),
				});
			}
			continue;
		}
		const place = (
			model: { prefab: string; scale: number },
			shown: Visibility,
			pose: PrefabPose | null,
		): void => {
			const visibility = gate(shown);
			// zero is the authored "no scale override" sentinel on LevelInteractiveData.
			const scale = row.modelScale > 0 ? row.modelScale : model.scale;
			const scales: [number, number, number] = [
				row.scale[0] * scale,
				row.scale[1] * scale,
				row.scale[2] * scale,
			];
			let posed = pose;
			if (ride !== null) {
				const placement = trsMatrix(row.position, unityEulerQuaternion(row.rotation), scales);
				const moving = curvePath(ride.spline, ride.move, placement);
				if ('reason' in moving) {
					unsupported.push({ path: source, reason: moving.reason });
				} else {
					posed = {
						key: `${pose?.key ?? ''} path:${source}`,
						clips: pose?.clips ?? [],
						active: pose?.active ?? new Map(),
						path: moving.path,
					};
				}
			}
			// a crane's container hangs where its tower puts it
			const hang = hung.get(row.id);
			models.push({
				model: {
					pathHash: hashOf(model.prefab),
					position: hang?.position ?? row.position,
					rotation: hang?.rotation ?? row.rotation,
					scale: scales,
				},
				levelTag,
				source,
				visibility,
				pose: posed,
				locked,
			});
		};
		// a settled look's model, and the looping effects its states leave playing on it
		const placeLook = (
			model: { prefab: string; scale: number },
			shown: Visibility,
			look: SettledLook,
		): void => {
			place(model, shown, look.pose);
			const scale = row.modelScale > 0 ? row.modelScale : model.scale;
			const frame = trsMatrix(row.position, unityEulerQuaternion(row.rotation), [
				row.scale[0] * scale,
				row.scale[1] * scale,
				row.scale[2] * scale,
			]);
			for (const rest of look.effects) {
				pendingEffects.push({
					effect: rest.effect,
					source,
					levelTag,
					visibility: gate(shown),
					frame,
					on: { prefab: model.prefab, pose: look.pose, rest },
					followRotation: rest.followRotation,
				});
			}
		};
		const jumpPad = jumpPads.get(row.template);
		const arrow = jumpPad === undefined ? null : jumpPadArrow(jumpPad, row);
		if (arrow !== null) {
			// a stationary effect, unscaled, independent of the pad's state
			pendingEffects.push({
				effect: arrow.effect,
				source,
				levelTag,
				visibility: gate({ alternatives: [[]] }),
				frame: trsMatrix(row.position, unityEulerQuaternion([0, arrow.yaw, 0]), [1, 1, 1]),
				on: null,
				followRotation: true,
			});
		}
		const verticalPad = verticalPads.get(row.template);
		const vent = verticalPad === undefined ? null : verticalPadEffect(verticalPad, row);
		if (vent !== null) {
			// played on the entity's root, so it follows the placement but not its model's scale
			pendingEffects.push({
				effect: vent,
				source,
				levelTag,
				visibility: gate({ alternatives: [[]] }),
				frame: trsMatrix(row.position, unityEulerQuaternion(row.rotation), row.scale),
				on: null,
				followRotation: true,
			});
		}
		const bridge = telescopic.get(row.template);
		if (bridge !== undefined) {
			const pieces = piecesOf(row) ?? bridge.pieces;
			// oxlint-disable-next-line no-await-in-loop -- one read per prefab and piece count
			const looks = await telescopicLooks(bridge.prefab, pieces);
			if (looks !== null) {
				const control = `bridge:${row.id}`;
				bridges.push(
					sceneControl({
						kind: 'bridge',
						id: control,
						name: `Telescopic bridge (${row.template})`,
						position: row.position,
						values: switchValues('retracted', `extended (${pieces} pieces)`),
						default: 0,
						assumption: 'retracted: the player or the server extends it',
					}),
				);
				place(template.forms[0], { alternatives: [[{ control, mask: 1 }]] }, looks.retracted);
				for (const pose of [looks.extended, ...looks.pieces]) {
					place(template.forms[0], { alternatives: [[{ control, mask: 2 }]] }, pose);
				}
				continue;
			}
		}
		const poses = doorPoses.get(row.template);
		if (poses !== undefined) {
			const control = `door:${row.id}`;
			doors.push({
				control: sceneControl({
					kind: 'door',
					id: control,
					name: `Door (${row.template})`,
					position: row.position,
					values: switchValues(`closed (${poses.closedState})`, `open (${poses.openState})`),
					default: 0,
					assumption: 'closed: the player or the server opens it',
				}),
				position: row.position,
			});
			place(template.forms[0], { alternatives: [[{ control, mask: 1 }]] }, poses.closed);
			place(template.forms[0], { alternatives: [[{ control, mask: 2 }]] }, poses.open);
			continue;
		}
		const rest = interactiveLooks.get(row.template);
		if (rest !== undefined) {
			const { campfire, radius } = rest;
			let { looks } = rest;
			// a placement's own `state` overrides its template's
			const state = (rest.state === null ? null : stateOf(row)) ?? rest.state;
			const floats = rest.verticalRope ? verticalRopeFloats(row, rowsById) : new Map<string, number>();
			if (state !== rest.state || floats.size > 0) {
				// oxlint-disable-next-line no-await-in-loop -- one settle per model, state and rope length
				looks = (await looksFor(rest.model, campfire, rest.keys, state, floats)) ?? looks;
			}
			const activation = `activation:${row.id}`;
			if (campfire) {
				progressions.push(
					sceneControl({
						kind: 'activation',
						id: activation,
						name: 'Campfire',
						position: row.position,
						values: switchValues(
							`not activated (${looks.away[0].states.join(', ')})`,
							`activated (${looks.away[1].states.join(', ')})`,
						),
						default: 1,
						assumption: 'activated, as in a finished save: the player activates it, and the server keeps it',
					}),
				);
			}
			const nearness = `proximity:${row.id}`;
			if (looks.near !== null && radius !== null) {
				const states = (side: SettledLook[]) => [...new Set(side.flatMap((look) => look.states))].join(', ');
				proximityControls.push(
					sceneControl({
						kind: 'proximity',
						id: nearness,
						name: campfire ? 'Campfire, player nearby' : row.template,
						position: row.position,
						values: switchValues(
							`away (${states(looks.away)})`,
							`within ${radius} m (${states(looks.near)})`,
						),
						default: 0,
						assumption: 'follows the camera, as the game follows the player',
						source: {
							kind: 'camera',
							test: { kind: 'near', reaches: [{ position: [...row.position], radius }] },
						},
					}),
				);
			}
			for (const [i, away] of looks.away.entries()) {
				const requirements = campfire ? [{ control: activation, mask: 1 << i }] : [];
				const near = looks.near?.[i];
				if (near === undefined || near.states.join() === away.states.join()) {
					placeLook(template.forms[0], { alternatives: [requirements] }, away);
					continue;
				}
				placeLook(
					template.forms[0],
					{ alternatives: [[...requirements, { control: nearness, mask: 1 }]] },
					away,
				);
				placeLook(
					template.forms[0],
					{ alternatives: [[...requirements, { control: nearness, mask: 2 }]] },
					near,
				);
			}
			continue;
		}
		const start = animatorStarts.get(row.template);
		if (start !== undefined) {
			const [form] = template.forms;
			if (start.saved === null) {
				// oxlint-disable-next-line no-await-in-loop -- one pose per prefab and parameter set
				place(form, { alternatives: [[]] }, await startPose(form.prefab, start, null));
				continue;
			}
			const control = `activation:${row.id}`;
			const { property } = start.saved;
			progressions.push(
				sceneControl({
					kind: 'activation',
					id: control,
					name: row.template,
					position: row.position,
					values: switchValues(`${property} unset`, `${property} set`),
					default: 1,
					assumption: `${property} set, as in a finished save: the server sets it during play`,
				}),
			);
			for (const [value, set] of [false, true].entries()) {
				// oxlint-disable-next-line no-await-in-loop -- as above
				const pose = await startPose(form.prefab, start, set);
				place(form, { alternatives: [[{ control, mask: 1 << value }]] }, pose);
			}
			continue;
		}
		if (nexus !== null && regionWalls.has(row.template)) {
			const unlock = nexus.unlockOf.get(areaOf(row) ?? '');
			if (unlock === undefined) {
				// no level unlocks the area in this client
				place(template.forms[0], { alternatives: [[]] }, null);
				continue;
			}
			let mask = 0;
			for (const { value } of nexus.control.values) {
				if (value < unlock) {
					mask |= 1 << value;
				}
			}
			if (mask !== 0) {
				place(template.forms[0], { alternatives: [[{ control: nexus.control.id, mask: mask >>> 0 }]] }, null);
			}
			continue;
		}
		const crane = craneLooks.get(row.id);
		if (crane !== undefined) {
			place(template.forms[0], { alternatives: [[]] }, crane);
			continue;
		}
		if (template.name === null) {
			place(template.forms[0], { alternatives: [[]] }, null);
			const doodad = doodads.get(row.template);
			if (doodad === undefined || doodad.length === 0) {
				continue;
			}
			const id = `doodadGroups:${levelId}`;
			const levels = doodadLevels.getOrInsertComputed(id, () => new Set<number>());
			for (const { groupLevel, form } of doodad) {
				levels.add(groupLevel);
				place(form, { alternatives: [[{ control: id, mask: (1 << groupLevel) >>> 0 }]] }, null);
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
				template.forms.length - 1,
				'fully upgraded: its last visual form, as in a finished world',
			),
		);
		for (const [form, model] of template.forms.entries()) {
			place(
				model,
				{ alternatives: [[{ control: id, mask: (1 << form) >>> 0 }]] },
				formPoses.get(model.model) ?? null,
			);
		}
	}
	if (pendingEffects.length > 0) {
		findHashes(new Set(pendingEffects.map(({ effect }) => effectPrefab(effect))));
		const resolver = await context.resolver();
		/** by effect prefab, whether it keeps playing at rest; `null` when it's missing or unreadable */
		const looping = new Map<string, Promise<boolean | null>>();
		const loops = (prefab: string): Promise<boolean | null> =>
			looping.getOrInsertComputed(prefab, async () => {
				const hash = hashes.get(prefab);
				if (hash === undefined) {
					unsupported.push({ path: prefab, reason: 'effect prefab not in the bundle manifest' });
					return null;
				}
				try {
					const root = await resolver.findUnique({ hash, path: prefab }, UnityClass.GameObject);
					// an effect that doesn't loop has run out by the time its state rests
					return !(await isOneShotEffect(resolver, root));
				} catch (error) {
					if (!(error instanceof FormatError)) {
						throw error;
					}
					unsupported.push({ path: prefab, reason: error.message });
					return null;
				}
			});
		/** by model prefab and pose, its GameObjects' matrices; `null` when unreadable */
		const nodeMatrices = new Map<string, Promise<Map<string, Float32Array> | null>>();
		const nodesOf = (prefab: string, pose: PrefabPose): Promise<Map<string, Float32Array> | null> =>
			nodeMatrices.getOrInsertComputed(`${prefab}:${pose.key}`, async () => {
				try {
					const root = await resolver.findUnique(
						{ hash: hashOf(prefab), path: prefab },
						UnityClass.GameObject,
					);
					return await prefabNodeMatrices(resolver, root, pose);
				} catch (error) {
					if (!(error instanceof FormatError)) {
						throw error;
					}
					unsupported.push({ path: prefab, reason: error.message });
					return null;
				}
			});
		for (const pending of pendingEffects) {
			const prefab = effectPrefab(pending.effect);
			// oxlint-disable-next-line no-await-in-loop -- one read per effect prefab
			if ((await loops(prefab)) !== true) {
				continue;
			}
			let matrix = pending.frame;
			if (pending.on !== null) {
				const { rest } = pending.on;
				// oxlint-disable-next-line no-await-in-loop -- one walk per model prefab and pose
				const nodes = await nodesOf(pending.on.prefab, pending.on.pose);
				if (nodes === null) {
					continue;
				}
				// a GameObject the model lacks falls back to the animator's, as in the game
				const node =
					(rest.node === null ? undefined : nodes.get(rest.node)) ??
					(rest.fallback === null ? undefined : nodes.get(rest.fallback));
				if (node !== undefined) {
					matrix = multiplyMatrices(matrix, node);
				}
			}
			models.push({
				model: { pathHash: hashes.get(prefab)!, ...matrixPlacement(matrix, pending.followRotation) },
				levelTag: pending.levelTag,
				source: `${pending.source}:${pending.effect}`,
				visibility: pending.visibility,
				pose: null,
			});
		}
	}
	for (const [id, set] of doodadLevels) {
		// oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy
		const levels = [...set].sort((a, b) => a - b);
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
	return {
		models,
		progressions,
		scriptControls,
		created: [...createdControls.values()],
		activities: activity ? [activityControl()] : [],
		proximityControls,
		doors,
		bridges,
		unsupported,
		standIns,
		placements: new Map(
			placed.map(({ row }) => [row.id.toString(), { template: row.template, position: row.position }]),
		),
	};
};
