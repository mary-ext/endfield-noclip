import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import {
	readLevelInteractives,
	UnsupportedLevelData,
} from '@endfield-noclip/formats/endfield/level-interactives';
import type { MemoryPackValue } from '@endfield-noclip/formats/endfield/memory-pack';
import type {
	ControlDriver,
	QuestRef,
	ScriptEventKind,
	Trigger,
	TriggerShape,
} from '@endfield-noclip/package-format/states';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import { mapDefined, unique } from '@mary-ext/array-fns';

import type { Context } from '../context.ts';
import { VfsGroup } from '../hg/vfs.ts';

import { unitCubeShape } from './environment.ts';
import type { GameCondition } from './state/game-state.ts';
import { questRef } from './state/story.ts';

// what sets each script-controlled entity group in game: every path from a level script's event header to a
// `ShowSceneDecoration*` action naming the group, followed back across custom events and script starts to a
// root cause, which becomes a driver of the group's control. paths from a script's own activation that pass
// only quest and mission checks also become a rule the group's control follows. the script graph is described
// in docs/game-data/scene-states.md#what-sets-a-script-group.

// #region decoded scripts

type Node = { [key: string]: MemoryPackValue };

/** a decoded level script */
export interface Script {
	id: string;
	level: string;
	data: Node;
	nodes: Map<number, Node>;
	getters: Map<number, Node>;
	headers: Node[];
}

const ROOT = 'Beyond_Gameplay_LevelScriptDataForMemoryPack';
const SCRIPT_PATH = /^Data\/Json\/LevelScriptData\/([^/]+)\/(\d+)\.json$/;

const asNode = (value: MemoryPackValue | undefined): Node | null =>
	value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;

const asList = (value: MemoryPackValue | undefined): MemoryPackValue[] => (Array.isArray(value) ? value : []);

/** @returns a wrapper's type without namespace and suffix, e.g. `ShowSceneDecorationNew` */
const typeOf = (node: Node): string =>
	(typeof node.$type === 'string' ? node.$type : '')
		.replace(/^Beyond_Gameplay_(Actions_)?/, '')
		.replace(/ForMemoryPack$/, '');

/** @returns a dictionary's value at a key */
const entry = (dictionary: MemoryPackValue | undefined, key: MemoryPackValue): Node | null => {
	for (const pair of asList(dictionary)) {
		if (Array.isArray(pair) && pair[0] === key) {
			return asNode(pair[1]);
		}
	}
	return null;
};

const vec3 = (value: MemoryPackValue | undefined): Vec3 | null =>
	Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === 'number')
		? [value[0], value[1], value[2]]
		: null;

/**
 * @param id the script's id
 * @param level the level it belongs to
 * @param decoded the decoded `LevelScriptData`
 * @returns the script's graph: its nodes and getters by id, and its event headers; `null` without an action
 *   map
 */
export const toScript = (id: string, level: string, decoded: MemoryPackValue): Script | null => {
	const data = asNode(decoded);
	const map = asNode(asNode(data?.actionMap)?.dataMap);
	if (data === null || map === null) {
		return null;
	}
	const byId = (list: MemoryPackValue | undefined): Map<number, Node> => {
		const out = new Map<number, Node>();
		for (const value of asList(list)) {
			const node = asNode(value);
			if (node !== null) {
				out.set(Number(node.ID), node);
			}
		}
		return out;
	};
	const headers = [...byId(map.headerList).values()];
	const nodes = byId(map.actionList);
	for (const header of headers) {
		nodes.set(Number(header.ID), header);
	}
	return { id, level, data, nodes, getters: byId(map.getterList), headers };
};

// #endregion

// #region params

/** a resolved param: a constant, the current script's id, or the getter node it reads */
type Param = MemoryPackValue | { getter: Node };

/** @returns a param as an index key: scalars as they print, other values as JSON */
const keyOf = (value: Param): string =>
	typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
		? String(value)
		: JSON.stringify(value);

/**
 * @returns a param's value: its constant (entity and script pointers reduced to their ids), the script's own
 *   id for the current-script source, the getter node it reads (by `idRef`, or a `$<id>@_<field>` path), else
 *   `null`
 */
const param = (script: Script, value: MemoryPackValue | undefined): Param => {
	const p = asNode(value);
	if (p === null || !('paramSource' in p)) {
		return value ?? null;
	}
	if (p.paramSource === 0) {
		const constant = asNode(p.constValue);
		if (constant !== null && 'scriptId' in constant) {
			return constant.scriptId;
		}
		return p.constValue;
	}
	// ParamSource 1002: the current script
	if (p.paramSource === 1002) {
		return script.id;
	}
	// an input wired straight to a getter names it by `idRef`; a path reads another node's output field
	let ref: number | null = null;
	const match = /^\$(\d+)@/.exec(typeof p.path === 'string' ? p.path : '');
	if (match !== null) {
		ref = Number(match[1]);
	} else if (typeof p.idRef === 'number' && p.idRef >= 0) {
		ref = p.idRef;
	}
	const getter = ref === null ? undefined : script.getters.get(ref);
	return getter ? { getter } : null;
};

// #endregion

// #region graph

/**
 * a condition passed on the way to a node: an if/else branch (`holds` is the branch taken), a header's
 * `validate` (`holds` true), or a switch value (`holds` null, since which case was taken isn't a truth
 * value)
 */
interface Guard {
	param: Param;
	holds: boolean | null;
}

/** an event header reaching a node, with the conditions passed on the way */
interface Reach {
	header: Node;
	guards: Guard[];
}

/** distinct guard sets kept per node and header; more paths add little */
const PATHS_PER_NODE = 16;
/** custom-event and script-start hops followed back */
const MAX_DEPTH = 5;

/** nodes that pass on to `nextID` only while their `value` is true or false, by the value they need */
const CHECKS = new Map([
	['CheckBoolIfTrue', true],
	['CheckBoolIfFalse', false],
]);

/** @returns a node's outgoing edges and the condition each one passes */
const edges = (script: Script, node: Node): { to: number; guard: Guard | undefined }[] => {
	const out: { to: number; guard: Guard | undefined }[] = [];
	const check = CHECKS.get(typeOf(node));
	for (const [key, value] of Object.entries(node)) {
		if (key === 'ID') {
			continue;
		}
		if (typeof value === 'number' && key.endsWith('ID') && value >= 0) {
			let guard: Guard | undefined;
			switch (key) {
				case 'onTrueID':
				case 'onFalseID': {
					guard = { param: param(script, node.condition), holds: key === 'onTrueID' };
					break;
				}
				case 'defaultID': {
					guard = { param: param(script, node.value), holds: null };
					break;
				}
				case 'nextID': {
					if (check !== undefined) {
						guard = { param: param(script, node.value), holds: check };
					}
					break;
				}
				default: {
					break;
				}
			}
			out.push({ to: value, guard });
		}
		if (Array.isArray(value) && /(ID|id)List$/.test(key)) {
			for (const to of value) {
				if (typeof to === 'number' && to >= 0) {
					out.push({
						to,
						guard: key === 'caseIDList' ? { param: param(script, node.value), holds: null } : undefined,
					});
				}
			}
		}
	}
	return out;
};

/** @returns a header's `validate` as a guard, which must hold for it to fire; nothing when absent or `true` */
const validation = (script: Script, header: Node): Guard[] => {
	if (header.validate === undefined) {
		return [];
	}
	const value = param(script, header.validate);
	return value === true ? [] : [{ param: value, holds: true }];
};

const reaches = new WeakMap<Script, Map<number, Reach[]>>();

/** @returns every header and distinct guard set reaching each node of a script; cycles end a path */
const reach = (script: Script): Map<number, Reach[]> => {
	let result = reaches.get(script);
	if (result !== undefined) {
		return result;
	}
	result = new Map();
	for (const header of script.headers) {
		const seen = new Map<number, Set<string>>();
		const stack: { id: number; guards: Guard[]; path: Set<number> }[] = [
			{ id: Number(header.ID), guards: validation(script, header), path: new Set() },
		];
		let steps = 0;
		while (stack.length > 0 && steps++ < 50_000) {
			const { id, guards, path } = stack.pop()!;
			const node = script.nodes.get(id);
			if (node === undefined || path.has(id)) {
				continue;
			}
			const key = JSON.stringify(guards);
			const at = seen.getOrInsertComputed(id, () => new Set<string>());
			if (at.has(key) || at.size >= PATHS_PER_NODE) {
				continue;
			}
			at.add(key);
			result.getOrInsertComputed(id, () => []).push({ header, guards });
			const next = new Set(path).add(id);
			for (const edge of edges(script, node)) {
				stack.push({
					id: edge.to,
					guards: edge.guard === undefined ? guards : [...guards, edge.guard],
					path: next,
				});
			}
		}
	}
	reaches.set(script, result);
	return result;
};

// #endregion

// #region causes

/** a root cause of a header firing, with the guards met on the way */
type Cause =
	| { kind: 'quest'; detail: Param; guards: Guard[] }
	| { kind: 'switch'; script: Script; target: Param; guards: Guard[] }
	| { kind: 'area'; shape: Node | null; guards: Guard[] }
	| { kind: 'script'; script: Script; guards: Guard[] }
	| { kind: 'server'; guards: Guard[] }
	| { kind: 'event'; event: ScriptEventKind; type: string; guards: Guard[] }
	| { kind: 'unknown'; type: string; guards: Guard[] };

/** an interactive's events the player sets off by using it (`targetEntity`) */
const SWITCH_EVENTS = new Set([
	'EntityEvent_OnInteractiveStateChanged',
	'EntityEvent_OnUIInteract',
	'EntityEvent_OnIntUnlocked',
	'EntityEvent_OnIntTryUnlock',
	'EntityEvent_OnIntUnlockFailed',
	'EntityEvent_OnSavePropertyChanged',
	'EntityEvent_OnBeingScanned',
]);

/** script stage, property and lifecycle events no client node raises; the server sets them */
const SERVER_EVENTS = new Set([
	'ScriptEvent_OnScriptStageChanged',
	'ScriptEvent_OnPropertyChanged',
	'ScriptEvent_OnBBVariableChanged',
	'ScriptEvent_OnScriptComplete',
	'ScriptEvent_OnScriptEnd',
	'ScriptEvent_OnScriptMarkDone',
]);

/** other events, by what sets them off; header types matching none become `unknown` drivers */
const EVENT_KINDS: [ScriptEventKind, RegExp][] = [
	[
		'combat',
		/^(LevelEvent_On(Spawner\w*|Squad\w*|Encounter\w*|Spell\w*|AnyEnemy\w*|Enemy\w*|BattleSignal|EntityCastSkill|EntityHpChanged|EntityTakeDamage|EntityListTakeDamage|AnyEntityDie|SpecificEntityDie|SpecificEntityListDie|EntityWeaknessTriggered)|EntityEvent_On(EntityDie|EntityDestroy|HpChanged|IntHpZero|IntReceiveAttack|ComboSkillActivated|PhysicalNoGuard|PhysicalInfliction|EntityReceiveWaterDroneAttack))$/,
	],
	['dialog', /^LevelEvent_On(DialogEnter|DialogExit|ServerDialogExit|CutsceneExit)$/],
	['variable', /^(OnMapVarChanged|MissionEvent_OnClientGlobalVarChanged)$/],
	['entity', /^EntityEvent_On(EntityStart|CustomEventNew|LeaderEnterTrigger|EntityEnterTrigger)$/],
];

interface Indexes {
	/** `RaiseCustomScriptEvent` nodes by `<receiver>:<key>` */
	scriptEvents: Map<string, { script: Script; node: Node }[]>;
	/** `RaiseCustomLevelEvent` nodes by `<level>:<key>` */
	levelEvents: Map<string, { script: Script; node: Node }[]>;
	/** `ManualStartLevelScript` nodes by started script id */
	starters: Map<string, { script: Script; node: Node }[]>;
}

const indexScripts = (scripts: Iterable<Script>): Indexes => {
	const indexes: Indexes = { scriptEvents: new Map(), levelEvents: new Map(), starters: new Map() };
	for (const script of scripts) {
		for (const node of script.nodes.values()) {
			const push = (map: Map<string, { script: Script; node: Node }[]>, key: string) =>
				map.getOrInsertComputed(key, () => []).push({ script, node });
			switch (typeOf(node)) {
				case 'RaiseCustomScriptEvent': {
					push(
						indexes.scriptEvents,
						`${keyOf(param(script, node.receiver))}:${keyOf(param(script, node.eventKey))}`,
					);
					break;
				}
				case 'RaiseCustomLevelEvent': {
					push(indexes.levelEvents, `${script.level}:${keyOf(param(script, node.eventKey))}`);
					break;
				}
				case 'ManualStartLevelScript': {
					push(indexes.starters, keyOf(param(script, node.scriptId)));
					break;
				}
				default: {
					break;
				}
			}
		}
	}
	return indexes;
};

/** @returns what ultimately makes a header fire */
const causesOf = (script: Script, header: Node, indexes: Indexes, depth: number): Cause[] => {
	const type = typeOf(header);
	const fromRaisers = (raisers: { script: Script; node: Node }[] | undefined): Cause[] => {
		if (raisers === undefined || raisers.length === 0 || depth >= MAX_DEPTH) {
			return [{ kind: 'server', guards: [] }];
		}
		return raisers.flatMap((raiser) =>
			(reach(raiser.script).get(Number(raiser.node.ID)) ?? []).flatMap((path) => {
				// fresh causes, so their guards can be extended in place
				const causes = causesOf(raiser.script, path.header, indexes, depth + 1);
				for (const cause of causes) {
					cause.guards = [...path.guards, ...cause.guards];
				}
				return causes;
			}),
		);
	};
	switch (type) {
		case 'ScriptEvent_OnCustomEvent': {
			return fromRaisers(indexes.scriptEvents.get(`${script.id}:${keyOf(param(script, header.eventKey))}`));
		}
		case 'LevelEvent_OnCustomEvent': {
			return fromRaisers(indexes.levelEvents.get(`${script.level}:${keyOf(param(script, header.eventKey))}`));
		}
		case 'ScriptEvent_OnScriptActive':
		case 'ScriptEvent_OnScriptStart':
		case 'ScriptEvent_OnScriptPreActive': {
			const started = indexes.starters.get(script.id);
			return [...(started === undefined ? [] : fromRaisers(started)), { kind: 'script', script, guards: [] }];
		}
		case 'ScriptEvent_OnLeaderEnterTriggerVolume':
		case 'ScriptEvent_OnLeaderLeaveTriggerVolume':
		case 'ScriptEvent_OnLeaderEnterTriggerVolumeList': {
			const volume = entry(script.data.triggerVolumes, param(script, header.triggerSlotIdFilter));
			return [{ kind: 'area', shape: asNode(asList(volume?.shapeList)[0]), guards: [] }];
		}
		case 'LevelEvent_OnQuestStateChanged':
		case 'LevelEvent_OnMissionStateChanged': {
			return [{ kind: 'quest', detail: header, guards: [] }];
		}
		default: {
			if (SWITCH_EVENTS.has(type)) {
				return [{ kind: 'switch', script, target: param(script, header.targetEntity), guards: [] }];
			}
			if (SERVER_EVENTS.has(type)) {
				return [{ kind: 'server', guards: [] }];
			}
			const event = EVENT_KINDS.find(([, pattern]) => pattern.test(type))?.[0];
			if (event !== undefined) {
				return [{ kind: 'event', event, type, guards: [] }];
			}
			return [{ kind: 'unknown', type, guards: [] }];
		}
	}
};

/** fields that name a quest or mission in condition getters and quest events */
const QUEST_FIELD = /(quest|mission)Id$|^filted(Quest|Mission)Id$/i;

/** @returns the quest and mission ids named in a value (params, getters, headers), found by field name */
const questIds = (value: unknown, found = new Set<string>(), depth = 0): Set<string> => {
	if (depth > 8 || value === null || typeof value !== 'object') {
		return found;
	}
	for (const [key, inner] of Object.entries(value)) {
		if (QUEST_FIELD.test(key)) {
			const id =
				inner !== null && typeof inner === 'object' && 'constValue' in inner ? inner.constValue : inner;
			if (typeof id === 'string' && id !== '' && !/^\d+$/.test(id)) {
				found.add(id);
			}
		}
		questIds(inner, found, depth + 1);
	}
	return found;
};

/** @returns a param's constant object, if it is one */
const constantNode = (value: Param): Node | null =>
	value !== null && typeof value === 'object' && !Array.isArray(value) && !('getter' in value) ? value : null;

// #endregion

// #region quest checks on activation

/** headers that fire when the script runs */
const ACTIVATION = new Set([
	'ScriptEvent_OnScriptActive',
	'ScriptEvent_OnScriptStart',
	'ScriptEvent_OnScriptPreActive',
]);

/** getters that test a quest's or mission's state, by the `QuestState` / `MissionState` they test for */
const STATE_CHECKS = new Map([
	['CheckMissionOrQuestIsProcessing', 2],
	['CheckMissionOrQuestIsComplete', 3],
]);

/**
 * @returns the condition a guard requires as a quest or mission test; `true` or `false` for a constant guard
 *   that does or doesn't hold; `null` for anything else
 */
const questTest = (script: Script, guard: Guard): GameCondition | boolean | null => {
	if (guard.holds === null) {
		return null;
	}
	if (typeof guard.param === 'boolean') {
		return guard.param === guard.holds;
	}
	const getter =
		guard.param !== null && typeof guard.param === 'object' && !Array.isArray(guard.param)
			? asNode(guard.param.getter)
			: null;
	const state = getter === null ? undefined : STATE_CHECKS.get(typeOf(getter));
	if (getter === null || state === undefined) {
		return null;
	}
	const isQuest = param(script, getter.isQuest);
	const id = param(script, getter.missionId);
	if (typeof isQuest !== 'boolean' || typeof id !== 'string' || id === '') {
		return null;
	}
	return { kind: isQuest ? 'quest' : 'mission', id, compare: guard.holds ? 0 : 1, target: state };
};

/**
 * what a group's own level scripts set it to when they run, where every path from a script's activation to
 * the group's show or hide action passes only quest and mission state checks: each path is a conjunction of
 * tests, and `show` / `hide` the disjunctions of the paths setting each value
 */
export interface ActivationRule {
	show: GameCondition[][];
	hide: GameCondition[][];
}

/** `QuestState` / `MissionState` values; quests skip "available" (1) */
const STATES = { quest: [0, 2, 3, 4, 5], mission: [0, 1, 2, 3, 4, 5] };

/** @returns whether some quest and mission state satisfies every test, which are all `=` or `≠` */
const satisfiable = (tests: readonly GameCondition[]): boolean => {
	const allowed = new Map<string, number[]>();
	for (const test of tests) {
		if (test.kind !== 'quest' && test.kind !== 'mission') {
			return true;
		}
		const key = `${test.kind}:${test.id}`;
		const values = allowed.get(key) ?? STATES[test.kind];
		allowed.set(
			key,
			values.filter((value) => (value === test.target) === (test.compare === 0)),
		);
	}
	return [...allowed.values()].every((values) => values.length > 0);
};

/**
 * @param rule what the group's scripts set it to when they run
 * @param defaultLoad the group's stored default-load flag, which holds until a script sets it
 * @returns the condition under which the group is shown, or `null` when the rule doesn't settle it: some
 *   state would both show and hide it, or no path changes the stored flag
 */
export const activationCondition = (rule: ActivationRule, defaultLoad: boolean): GameCondition | null => {
	if (rule.show.some((show) => rule.hide.some((hide) => satisfiable([...show, ...hide])))) {
		return null;
	}
	const paths = defaultLoad ? rule.hide : rule.show;
	if (paths.length === 0) {
		return null;
	}
	// shown while a show path holds, else while the flag is set and no hide path holds; with the two exclusive,
	// that is the show paths for an unset flag and no hide path for a set one
	return {
		kind: 'any',
		reverse: defaultLoad,
		conditions: paths.map((tests) => ({ kind: 'all', reverse: false, conditions: tests })),
	};
};

// #endregion

// #region visibility actions

/** actions that show or hide a dynamic entity's scenery by its global id: `targetDynamicEntity`, `visible` */
const DECORATION_ACTIONS =
	/^(ShowSceneDecorationNew|ShowSceneDecorationWithHandle|ForceShowDecorationWithHandle)$/;

/** actions that show or hide level entities (interactives) by entity pointer, with the value they set */
const ENTITY_ACTIONS = new Map<string, { field: string; shows: boolean | 'isVisible' }>([
	['EntityShow', { field: 'entityPtr', shows: true }],
	['EntityHide', { field: 'entityPtr', shows: false }],
	['EntityShowList', { field: 'entityListPtr', shows: true }],
	['EntityHideList', { field: 'entityListPtr', shows: false }],
	['SetEntitiesVisibility', { field: 'targetEntities', shows: 'isVisible' }],
]);

/** what a visibility action sets: its constant targets, and how many targets it computes at runtime */
interface VisibilityAction {
	targets: string[];
	/** targets not named by a constant: getters, or slots of the script's own interactives */
	untraced: number;
	/** the visibility it sets, `null` when computed */
	shows: boolean | null;
}

/** @returns what a node shows or hides, or `null` when it isn't a visibility action */
const visibilityAction = (script: Script, node: Node): VisibilityAction | null => {
	const type = typeOf(node);
	if (DECORATION_ACTIONS.test(type)) {
		const target = param(script, node.targetDynamicEntity);
		const visible = param(script, node.visible);
		return {
			targets: typeof target === 'string' ? [target] : [],
			untraced: typeof target === 'string' ? 0 : 1,
			shows: typeof visible === 'boolean' ? visible : null,
		};
	}
	const entity = ENTITY_ACTIONS.get(type);
	if (entity === undefined) {
		return null;
	}
	let shows: boolean | null;
	if (entity.shows === 'isVisible') {
		const visible = param(script, node.isVisible);
		shows = typeof visible === 'boolean' ? visible : null;
	} else {
		shows = entity.shows;
	}
	const value = param(script, node[entity.field]);
	const pointers = Array.isArray(value) ? value : [value];
	const targets: string[] = [];
	let untraced = 0;
	for (const pointer of pointers) {
		const constant = constantNode(pointer);
		const id = constant?.useSlotId === false ? constant.logicId : undefined;
		if (typeof id === 'string' || typeof id === 'number' || typeof id === 'bigint') {
			targets.push(String(id));
		} else {
			untraced++;
		}
	}
	return { targets, untraced, shows };
};

/**
 * @param scripts decoded level scripts
 * @param ownLevels the scene's levels
 * @returns the logic ids of level entities the scene's own scripts show or hide by entity pointer
 */
export const entityVisibilityTargets = (
	scripts: Iterable<Script>,
	ownLevels: ReadonlySet<string>,
): Set<string> => {
	const targets = new Set<string>();
	for (const script of scripts) {
		if (!ownLevels.has(script.level)) {
			continue;
		}
		for (const node of script.nodes.values()) {
			if (ENTITY_ACTIONS.has(typeOf(node))) {
				for (const target of visibilityAction(script, node)?.targets ?? []) {
					targets.add(target);
				}
			}
		}
	}
	return targets;
};

// #endregion

// #region trigger volumes

/** `LevelScriptTriggerVolumeShapeType` values */
const ShapeType = { Box: 1, Sphere: 2, Polyline: 3, Infinite: 4 };

/**
 * a group set only by one level script's trigger volume crossings, each unguarded and to a constant value: in
 * game it follows the player's path through those volumes
 */
export interface VolumeRule {
	/** the level script's id */
	script: string;
	/** per volume the group's crossings name, what entering and leaving set it to (1 shows, 0 hides) */
	triggers: Trigger[];
}

/** a group's volume rule while its paths are collected: per volume slot, what each crossing sets */
interface PendingVolume {
	script: Script;
	edges: Map<string, { slot: MemoryPackValue; enter: number | null; leave: number | null }>;
}

/** @returns a polyline point (the shape's local x, z) */
const vec2 = (value: MemoryPackValue | undefined): [number, number] | null =>
	Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === 'number')
		? [value[0], value[1]]
		: null;

/**
 * a shape covers the box `±size / 2` in its frame (`position`, then `rotation` as Unity Euler degrees); a
 * polyline also needs the point's local x, z inside its polygon, and a sphere holds points within `radius` of
 * `position`
 *
 * @returns the shape in the world frame, or `null` when it isn't understood: a polyline turned off the
 *   vertical or with points beyond its box
 */
const triggerShape = (shape: Node): TriggerShape | null => {
	const position = vec3(shape.position);
	const rotation = vec3(shape.rotation);
	const size = vec3(shape.size);
	switch (shape.shapeType) {
		case ShapeType.Box: {
			return position && rotation && size && unitCubeShape(position, rotation, size);
		}
		case ShapeType.Sphere: {
			return position && typeof shape.radius === 'number'
				? { kind: 'sphere', center: position, radius: shape.radius }
				: null;
		}
		case ShapeType.Polyline: {
			const points = asList(shape.polyLinePoints).map(vec2);
			if (
				position === null ||
				rotation === null ||
				size === null ||
				rotation[0] !== 0 ||
				rotation[2] !== 0 ||
				points.length < 3 ||
				points.some(
					(point) =>
						point === null ||
						Math.abs(point[0]) > size[0] / 2 + 0.01 ||
						Math.abs(point[1]) > size[2] / 2 + 0.01,
				)
			) {
				return null;
			}
			// a yaw-only frame maps local (x, z) to the world as Unity's Euler y does
			const yaw = (rotation[1] * Math.PI) / 180;
			const [cos, sin] = [Math.cos(yaw), Math.sin(yaw)];
			return {
				kind: 'prism',
				points: mapDefined(points, (point) =>
					point === null
						? undefined
						: [position[0] + point[0] * cos + point[1] * sin, position[2] - point[0] * sin + point[1] * cos],
				),
				bottom: position[1] - size[1] / 2,
				top: position[1] + size[1] / 2,
			};
		}
		case ShapeType.Infinite: {
			return { kind: 'global' };
		}
		default: {
			return null;
		}
	}
};

/** @returns the volume's shapes, or `null` when one isn't understood or some shapes only count for leaving */
const volumeShapes = (script: Script, slot: MemoryPackValue): TriggerShape[] | null => {
	const volume = entry(script.data.triggerVolumes, slot);
	const shapes = asList(volume?.shapeList);
	if (volume === null || shapes.length === 0 || volume.exitShapeStartIndex !== -1) {
		return null;
	}
	const out: TriggerShape[] = [];
	for (const value of shapes) {
		const node = asNode(value);
		const shape = node && triggerShape(node);
		if (shape === null) {
			return null;
		}
		out.push(shape);
	}
	return out;
};

// #endregion

/** what sets each script-controlled entity group */
export interface ScriptLinks {
	/** drivers by entity id */
	drivers: Map<string, ControlDriver[]>;
	/**
	 * by entity id, what the scene's own scripts set the group to when they run, for groups whose every such
	 * path passes only quest and mission state checks (see {@link activationCondition})
	 */
	rules: Map<string, ActivationRule>;
	/** by entity id, the trigger volumes whose crossings alone set the group (see {@link VolumeRule}) */
	volumes: Map<string, VolumeRule>;
	/** show and hide action targets computed at runtime (getters, the script's own slots), not followed */
	untraced: number;
	/** event header types the driver mapping doesn't know, with how many driver paths start at each */
	unmapped: Map<string, number>;
}

/** the scenery drivers of a scene's script-controlled entities */
export interface ScriptDrivers extends ScriptLinks {
	counts: { scripts: number; undecoded: number; targeted: number };
}

/** a scene's decoded level scripts */
export interface LevelScripts {
	/** the scene's own levels' scripts, and other levels' scripts naming a wanted entity */
	scripts: Script[];
	/** the scene's levels */
	ownLevels: Set<string>;
	/** scripts the decoder couldn't read, skipped */
	undecoded: number;
}

/**
 * @param context install readers
 * @param scene streaming scene id
 * @param entities ids of entities whose other-level scripts are wanted too (dungeons reusing the map)
 * @returns the scene's decoded level scripts
 */
export const loadLevelScripts = async (
	context: Pick<Context, 'vfs' | 'world' | 'memoryPack'>,
	scene: string,
	entities: ReadonlySet<string>,
): Promise<LevelScripts> => {
	const { vfs, world } = context;
	const reader = await context.memoryPack();
	const configs = await world.levelConfigs();
	const ownLevels = new Set(
		mapDefined([...configs.values()], (config) => (config.mapId === scene ? config.id : undefined)),
	);
	const read = (name: string): Promise<Uint8Array> => vfs.readFile(VfsGroup.JsonData, name);
	const wanted = new Set([...entities].map((id) => BigInt(id)));
	const scripts = new Map<string, Script>();
	let undecoded = 0;
	for (const name of (await vfs.group(VfsGroup.JsonData)).files.keys()) {
		const match = SCRIPT_PATH.exec(name);
		if (match === null) {
			continue;
		}
		const [, level, id] = match;
		// oxlint-disable-next-line no-await-in-loop -- scripts are small and released after decoding
		const bytes = await read(name);
		if (!ownLevels.has(level) && !namesAny(bytes, wanted)) {
			continue;
		}
		let script: Script | null;
		try {
			script = toScript(id, level, reader.decode(bytes, ROOT));
		} catch (error) {
			if (!(error instanceof FormatError)) {
				throw error;
			}
			undecoded++;
			continue;
		}
		if (script !== null) {
			scripts.set(id, script);
		}
	}
	return { scripts: [...scripts.values()], ownLevels, undecoded };
};

/**
 * finds what shows and hides a scene's script-controlled entities, and what runs other actions
 *
 * @param context install readers
 * @param levelScripts the scene's level scripts
 * @param entities ids of the scene's script-controlled entities: dynamic entities' global ids, interactives'
 *   logic ids
 * @param actions other actions whose drivers to list, by their target key
 * @returns drivers by entity id and action target, and activation rules by entity id
 */
export const loadScriptDrivers = async (
	context: Pick<Context, 'vfs' | 'world'>,
	levelScripts: LevelScripts,
	entities: ReadonlySet<string>,
	actions: readonly ScriptAction[],
): Promise<ScriptDrivers> => {
	const { vfs, world } = context;
	const { scripts, ownLevels, undecoded } = levelScripts;
	const read = (name: string): Promise<Uint8Array> => vfs.readFile(VfsGroup.JsonData, name);

	// #region where things are: LevelData placements for interactives named by logic id
	const placements = new Map<string, { template: string; position: Vec3 }>();
	const pool = await world.stringPool();
	const pathOf = await world.pathLookup();
	for (const config of (await world.levelConfigs()).values()) {
		if (!ownLevels.has(config.id)) {
			continue;
		}
		for (const hash of config.levelDataPathHashes ?? []) {
			const path = pathOf(hash);
			if (path === undefined) {
				continue;
			}
			try {
				// oxlint-disable-next-line no-await-in-loop -- level files are released after their prefix is decoded
				for (const row of readLevelInteractives(await read(path), (id) => pool.get(id))) {
					placements.set(row.id.toString(), { template: row.template, position: row.position });
				}
			} catch (error) {
				if (!(error instanceof UnsupportedLevelData)) {
					throw error;
				}
			}
		}
	}
	// #endregion

	const labels = new Map<string, Promise<QuestRef>>();
	const links = await linkScripts(scripts, {
		entities,
		ownLevels,
		placements,
		// missions whose objectives check a script: the progress that has the server run it
		missionsOf: await missionScriptReferences(context),
		label: (id) => labels.getOrInsertComputed(id, () => questRef(world, id)),
		levelNames: await world.names(),
		actions,
	});
	return {
		...links,
		counts: {
			scripts: scripts.length,
			undecoded,
			targeted: [...links.drivers.keys()].filter((id) => entities.has(id)).length,
		},
	};
};

/** what {@link linkScripts} looks things up in */
export interface LinkContext {
	/** ids of the script-controlled entities to find drivers for */
	entities: ReadonlySet<string>;
	/** the scene's levels; scripts of other levels become `level` drivers */
	ownLevels: ReadonlySet<string>;
	/** interactive placements by logic id */
	placements: ReadonlyMap<string, { template: string; position: Vec3 }>;
	/** missions by the script ids their objectives check */
	missionsOf: ReadonlyMap<string, ReadonlySet<string>>;
	/** labels a quest or mission id */
	label: (id: string) => Promise<QuestRef>;
	/** level display names by id */
	levelNames: ReadonlyMap<string, string>;
	/** other actions whose drivers to find, each under its own target key; their drivers' values are `null` */
	actions: readonly ScriptAction[];
}

/** an action node of a script, whose drivers are listed under `target` */
export interface ScriptAction {
	script: string;
	node: number;
	target: string;
}

/**
 * @param scripts decoded level scripts (see {@link toScript})
 * @param context lookups
 * @returns drivers by entity id, for the entities some script shows or hides, and activation rules for those
 *   whose own scripts' activation paths check only quest and mission states
 */
export const linkScripts = async (scripts: readonly Script[], context: LinkContext): Promise<ScriptLinks> => {
	const { entities, ownLevels, placements, missionsOf, label, levelNames } = context;
	const indexes = indexScripts(scripts);
	const drivers = new Map<string, ControlDriver[]>();
	// `null` once some activation path sets a group in a way quest tests don't capture
	const rules = new Map<string, ActivationRule | null>();
	// `null` once something other than one script's volume crossings sets a group
	const volumes = new Map<string, PendingVolume | null>();
	let untraced = 0;
	/** header types no rule maps, by paths reaching a show or hide action from them */
	const unmapped = new Map<string, number>();
	for (const script of scripts) {
		const paths = reach(script);
		for (const node of script.nodes.values()) {
			const action = visibilityAction(script, node);
			if (action === null) {
				continue;
			}
			untraced += action.untraced;
			for (const target of action.targets) {
				if (entities.has(target)) {
					// oxlint-disable-next-line no-await-in-loop -- labels are cached per quest
					await link(script, paths, node, target, action.shows === null ? null : Number(action.shows), true);
				}
			}
		}
	}
	const byId = new Map(scripts.map((script) => [script.id, script]));
	for (const { script: id, node: nodeId, target } of context.actions) {
		const script = byId.get(id);
		const node = script?.nodes.get(nodeId);
		if (script !== undefined && node !== undefined) {
			// oxlint-disable-next-line no-await-in-loop -- labels are cached per quest
			await link(script, reach(script), node, target, null, false);
		}
	}

	/**
	 * adds the drivers of one action setting one target to `value`, and for a visibility action (`activation`)
	 * its activation paths
	 */
	async function link(
		script: Script,
		paths: Map<number, Reach[]>,
		node: Node,
		target: string,
		value: number | null,
		activation: boolean,
	): Promise<void> {
		const found: ControlDriver[] = [];
		if (!ownLevels.has(script.level)) {
			if (activation) {
				volumes.set(target, null);
			}
			found.push({
				kind: 'level',
				levelId: script.level,
				name: levelNames.get(script.level) ?? null,
				value,
			});
		} else {
			for (const path of paths.get(Number(node.ID)) ?? []) {
				for (const cause of causesOf(script, path.header, indexes, 0)) {
					// oxlint-disable-next-line no-await-in-loop -- labels are cached per quest
					found.push(...(await driversOf(cause, [...path.guards, ...cause.guards], value)));
				}
				if (activation && ACTIVATION.has(typeOf(path.header))) {
					noteActivation(script, target, path.guards, value === null ? null : value === 1);
				}
				if (activation) {
					noteVolume(script, path, target, value);
				}
			}
		}
		const list = drivers.getOrInsertComputed(target, () => []);
		for (const driver of found) {
			if (!list.some((known) => JSON.stringify(known) === JSON.stringify(driver))) {
				list.push(driver);
			}
		}
	}

	/** adds an activation path to its group's rule, or drops the rule when the path isn't only quest tests */
	function noteActivation(script: Script, target: string, guards: Guard[], shows: boolean | null): void {
		const rule = rules.get(target);
		if (rule === null) {
			return;
		}
		if (shows === null) {
			rules.set(target, null);
			return;
		}
		const tests: GameCondition[] = [];
		for (const guard of guards) {
			const test = questTest(script, guard);
			if (test === false) {
				// a constant branch never taken
				return;
			}
			if (test === null) {
				rules.set(target, null);
				return;
			}
			if (test !== true) {
				tests.push(test);
			}
		}
		if (tests.length === 0) {
			// set whenever the script runs, which depends on server progress this doesn't model
			rules.set(target, null);
			return;
		}
		const next = rule ?? { show: [], hide: [] };
		const paths = shows ? next.show : next.hide;
		if (!paths.some((known) => JSON.stringify(known) === JSON.stringify(tests))) {
			paths.push(tests);
		}
		rules.set(target, next);
	}

	/**
	 * adds a path to its group's volume rule, or drops the rule when the path isn't an unguarded volume
	 * crossing
	 */
	function noteVolume(script: Script, path: Reach, target: string, value: number | null): void {
		const current = volumes.get(target);
		if (current === null) {
			return;
		}
		const type = typeOf(path.header);
		const enters = type === 'ScriptEvent_OnLeaderEnterTriggerVolume';
		const slot = param(script, path.header.triggerSlotIdFilter);
		if (
			(!enters && type !== 'ScriptEvent_OnLeaderLeaveTriggerVolume') ||
			path.guards.length > 0 ||
			value === null ||
			slot === null ||
			(current !== undefined && current.script !== script)
		) {
			volumes.set(target, null);
			return;
		}
		const next = current ?? { script, edges: new Map() };
		const edge = next.edges.getOrInsertComputed(keyOf(slot), () => ({ slot, enter: null, leave: null }));
		const known = enters ? edge.enter : edge.leave;
		if (known !== null && known !== value) {
			// the same crossing both shows and hides it
			volumes.set(target, null);
			return;
		}
		if (enters) {
			edge.enter = value;
		} else {
			edge.leave = value;
		}
		volumes.set(target, next);
	}

	/** @returns the drivers a cause becomes */
	async function driversOf(cause: Cause, guards: Guard[], value: number | null): Promise<ControlDriver[]> {
		const quests = [...questIds(guards), ...(cause.kind === 'quest' ? questIds(cause.detail) : [])];
		const out: ControlDriver[] = [];
		if (quests.length > 0) {
			out.push({
				kind: 'quest',
				// oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy
				quests: await Promise.all(unique(quests).sort().map(label)),
				value,
			});
		}
		switch (cause.kind) {
			case 'quest': {
				break;
			}
			case 'switch': {
				const target = constantNode(cause.target);
				let template: string | null = null;
				let position: Vec3 | null = null;
				if (target !== null && target.useSlotId === true) {
					// a slot of the script's own interactives
					const slot = entry(cause.script.data.interactives, target.slotId);
					template = typeof slot?.entityDataIdKey === 'string' ? slot.entityDataIdKey : null;
					position = vec3(slot?.position);
				} else if (target !== null) {
					const placement = placements.get(keyOf(target.logicId ?? null));
					template = placement?.template ?? null;
					position = placement?.position ?? null;
				}
				out.push({ kind: 'switch', template, position, value });
				break;
			}
			case 'area': {
				const position = vec3(cause.shape?.position);
				const radius = cause.shape?.radius;
				out.push(
					position !== null && typeof radius === 'number'
						? { kind: 'area', position, radius, value }
						: { kind: 'server', value },
				);
				break;
			}
			case 'script': {
				const missions = missionsOf.get(cause.script.id);
				if (missions !== undefined && quests.length === 0) {
					// oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy
					out.push({ kind: 'quest', quests: await Promise.all([...missions].sort().map(label)), value });
				}
				const shape = asNode(
					asList(cause.script.data.startShapeList)[0] ?? asList(cause.script.data.activeShapeList)[0],
				);
				const position = vec3(shape?.offset);
				out.push({
					kind: 'script',
					position,
					radius: position !== null && typeof shape?.radius === 'number' ? shape.radius : null,
					value,
				});
				break;
			}
			case 'server': {
				if (quests.length === 0) {
					out.push({ kind: 'server', value });
				}
				break;
			}
			case 'event': {
				out.push({ kind: 'event', event: cause.event, type: cause.type, value });
				break;
			}
			case 'unknown': {
				unmapped.set(cause.type, (unmapped.get(cause.type) ?? 0) + 1);
				out.push({ kind: 'unknown', type: cause.type, value });
				break;
			}
		}
		return out;
	}

	const settled = new Map<string, ActivationRule>();
	for (const [target, rule] of rules) {
		if (rule !== null) {
			settled.set(target, rule);
		}
	}
	const followed = new Map<string, VolumeRule>();
	for (const [target, pending] of volumes) {
		if (pending === null) {
			continue;
		}
		const triggers: Trigger[] = [];
		for (const { slot, enter, leave } of pending.edges.values()) {
			const shapes = volumeShapes(pending.script, slot);
			if (shapes === null) {
				break;
			}
			triggers.push({ shapes, enter, leave });
		}
		if (triggers.length === pending.edges.size) {
			followed.set(target, { script: pending.script.id, triggers });
		}
	}
	return { drivers, rules: settled, volumes: followed, untraced, unmapped };
};

/** @returns whether the bytes hold any of the ids as a little-endian u64 */
const namesAny = (bytes: Uint8Array, ids: ReadonlySet<bigint>): boolean => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	for (let at = 0; at + 8 <= bytes.length; at++) {
		// entity ids are below 2^40: test the high bytes before building a bigint
		if (
			bytes[at + 7] === 0 &&
			bytes[at + 6] === 0 &&
			bytes[at + 5] === 0 &&
			ids.has(view.getBigUint64(at, true))
		) {
			return true;
		}
	}
	return false;
};

/**
 * @returns script id → missions whose objectives check that script (stages, properties); the server runs such
 *   scripts as those missions progress
 */
const missionScriptReferences = async (context: Pick<Context, 'vfs'>): Promise<Map<string, Set<string>>> => {
	const { vfs } = context;
	const references = new Map<string, Set<string>>();
	for (const name of (await vfs.group(VfsGroup.JsonData)).files.keys()) {
		const match = /^Data\/Json\/MissionRuntimeAsset\/(\w+)\.json$/.exec(name);
		if (match === null || match[1].endsWith('_meta')) {
			continue;
		}
		// oxlint-disable-next-line no-await-in-loop -- mission files are small
		const text = new TextDecoder().decode(await vfs.readFile(VfsGroup.JsonData, name));
		for (const reference of text.matchAll(/"scriptId":\s*"?(\d+)/g)) {
			references.getOrInsertComputed(reference[1], () => new Set()).add(match[1]);
		}
	}
	return references;
};
