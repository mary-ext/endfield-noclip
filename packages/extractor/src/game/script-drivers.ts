import {
	readLevelInteractives,
	UnsupportedLevelData,
} from '@endfield-noclip/formats/endfield/level-interactives';
import type { MemoryPackValue } from '@endfield-noclip/formats/endfield/memory-pack';
import type { ControlDriver, QuestRef } from '@endfield-noclip/package-format/states';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import { getOrInsert } from '../collections.ts';
import type { Context } from '../context.ts';
import { VfsGroup } from '../hg/vfs.ts';

import { questRef } from './story.ts';

// what sets each script-controlled entity group in game: every path from a level script's event header to a
// `ShowSceneDecoration*` action naming the group, followed back across custom events and script starts to a
// root cause, which becomes a driver of the group's control. the script graph is described in
// docs/game-data/scene-states.md#what-sets-a-script-group.

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
 *   id for the current-script source, the getter node for a `$<id>@_<field>` path, else `null`
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
	const match = /^\$(\d+)@/.exec(typeof p.path === 'string' ? p.path : '');
	const getter = match && script.getters.get(Number(match[1]));
	return getter ? { getter } : null;
};

// #endregion

// #region graph

/** an event header reaching a node, with the branch conditions passed on the way */
interface Reach {
	header: Node;
	guards: Param[];
}

/** distinct guard sets kept per node and header; more paths add little */
const PATHS_PER_NODE = 16;
/** custom-event and script-start hops followed back */
const MAX_DEPTH = 5;

/** @returns a node's outgoing edges and the condition each one passes */
const edges = (script: Script, node: Node): { to: number; guard: Param | undefined }[] => {
	const out: { to: number; guard: Param | undefined }[] = [];
	for (const [key, value] of Object.entries(node)) {
		if (key === 'ID') {
			continue;
		}
		if (typeof value === 'number' && key.endsWith('ID') && value >= 0) {
			const guard =
				key === 'onTrueID' || key === 'onFalseID'
					? param(script, node.condition)
					: key === 'defaultID'
						? param(script, node.value)
						: undefined;
			out.push({ to: value, guard });
		}
		if (Array.isArray(value) && /(ID|id)List$/.test(key)) {
			for (const to of value) {
				if (typeof to === 'number' && to >= 0) {
					out.push({ to, guard: key === 'caseIDList' ? param(script, node.value) : undefined });
				}
			}
		}
	}
	return out;
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
		const stack: { id: number; guards: Param[]; path: Set<number> }[] = [
			{ id: Number(header.ID), guards: [], path: new Set() },
		];
		let steps = 0;
		while (stack.length > 0 && steps++ < 50_000) {
			const { id, guards, path } = stack.pop()!;
			const node = script.nodes.get(id);
			if (node === undefined || path.has(id)) {
				continue;
			}
			const key = JSON.stringify(guards);
			const at = getOrInsert(seen, id, () => new Set<string>());
			if (at.has(key) || at.size >= PATHS_PER_NODE) {
				continue;
			}
			at.add(key);
			getOrInsert(result, id, () => []).push({ header, guards });
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
	| { kind: 'quest'; detail: Param; guards: Param[] }
	| { kind: 'switch'; script: Script; target: Param; guards: Param[] }
	| { kind: 'area'; shape: Node | null; guards: Param[] }
	| { kind: 'script'; script: Script; guards: Param[] }
	| { kind: 'server'; guards: Param[] };

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
				getOrInsert(map, key, () => []).push({ script, node });
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
			if (type.startsWith('EntityEvent_')) {
				return [{ kind: 'switch', script, target: param(script, header.targetEntity), guards: [] }];
			}
			// script stages, properties and events without a client raiser come from the server
			return [{ kind: 'server', guards: [] }];
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

/** the scenery drivers of a scene's script-controlled entities */
export interface ScriptDrivers {
	/** drivers by entity id */
	drivers: Map<string, ControlDriver[]>;
	counts: { scripts: number; undecoded: number; targeted: number };
}

/**
 * finds what shows and hides a scene's script-controlled entities: the scene's level scripts, and other
 * levels' scripts that name one of the entities (dungeons reusing the map)
 *
 * @param context install readers
 * @param scene streaming scene id
 * @param entities ids of the scene's script-controlled entities
 * @returns drivers by entity id; scripts the decoder can't read are counted and skipped
 */
export const loadScriptDrivers = async (
	context: Pick<Context, 'vfs' | 'world' | 'memoryPack'>,
	scene: string,
	entities: ReadonlySet<string>,
): Promise<ScriptDrivers> => {
	const { vfs, world } = context;
	const reader = await context.memoryPack();
	const configs = await world.levelConfigs();
	const ownLevels = new Set(
		[...configs.values()].filter((config) => config.mapId === scene).map((config) => config.id),
	);
	const read = async (name: string): Promise<Uint8Array> =>
		vfs.readVerified((await vfs.find(VfsGroup.JsonData, name))!);
	const wanted = new Set([...entities].map((id) => BigInt(id)));

	// #region scripts: the scene's own, and others naming a wanted entity
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
		} catch {
			undecoded++;
			continue;
		}
		if (script !== null) {
			scripts.set(id, script);
		}
	}
	// #endregion

	// #region where things are: LevelData placements for interactives named by logic id
	const placements = new Map<string, { template: string; position: Vec3 }>();
	const pool = await world.stringPool();
	const pathOf = await world.pathLookup();
	for (const config of configs.values()) {
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
	const drivers = await linkScripts([...scripts.values()], {
		entities,
		ownLevels,
		placements,
		// missions whose objectives check a script: the progress that has the server run it
		missionsOf: await missionScriptReferences(context),
		label: (id) => getOrInsert(labels, id, () => questRef(world, id)),
		levelNames: await world.names(),
	});
	return {
		drivers,
		counts: { scripts: scripts.size, undecoded, targeted: drivers.size },
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
}

/**
 * @param scripts decoded level scripts (see {@link toScript})
 * @param context lookups
 * @returns drivers by entity id, for the entities some script shows or hides
 */
export const linkScripts = async (
	scripts: readonly Script[],
	context: LinkContext,
): Promise<Map<string, ControlDriver[]>> => {
	const { entities, ownLevels, placements, missionsOf, label, levelNames } = context;
	const indexes = indexScripts(scripts);
	const drivers = new Map<string, ControlDriver[]>();
	for (const script of scripts) {
		const paths = reach(script);
		for (const node of script.nodes.values()) {
			if (
				!/^(ShowSceneDecorationNew|ShowSceneDecorationWithHandle|ForceShowDecorationWithHandle)$/.test(
					typeOf(node),
				)
			) {
				continue;
			}
			const target = param(script, node.targetDynamicEntity);
			if (typeof target !== 'string' || !entities.has(target)) {
				continue;
			}
			const visible = param(script, node.visible);
			const shows = typeof visible === 'boolean' ? visible : null;
			const found: ControlDriver[] = [];
			if (!ownLevels.has(script.level)) {
				found.push({
					kind: 'level',
					levelId: script.level,
					name: levelNames.get(script.level) ?? null,
					shows,
				});
			} else {
				for (const path of paths.get(Number(node.ID)) ?? []) {
					for (const cause of causesOf(script, path.header, indexes, 0)) {
						// oxlint-disable-next-line no-await-in-loop -- labels are cached per quest
						found.push(...(await driversOf(cause, [...path.guards, ...cause.guards], shows)));
					}
				}
			}
			const list = getOrInsert(drivers, target, () => []);
			for (const driver of found) {
				if (!list.some((known) => JSON.stringify(known) === JSON.stringify(driver))) {
					list.push(driver);
				}
			}
		}
	}

	/** @returns the drivers a cause becomes */
	async function driversOf(cause: Cause, guards: Param[], shows: boolean | null): Promise<ControlDriver[]> {
		const quests = [...questIds(guards), ...(cause.kind === 'quest' ? questIds(cause.detail) : [])];
		const out: ControlDriver[] = [];
		if (quests.length > 0) {
			out.push({
				kind: 'quest',
				quests: await Promise.all([...new Set(quests)].toSorted().map(label)),
				shows,
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
				out.push({ kind: 'switch', template, position, shows });
				break;
			}
			case 'area': {
				const position = vec3(cause.shape?.position);
				const radius = cause.shape?.radius;
				out.push(
					position !== null && typeof radius === 'number'
						? { kind: 'area', position, radius, shows }
						: { kind: 'server', shows },
				);
				break;
			}
			case 'script': {
				const missions = missionsOf.get(cause.script.id);
				if (missions !== undefined && quests.length === 0) {
					out.push({ kind: 'quest', quests: await Promise.all([...missions].toSorted().map(label)), shows });
				}
				const shape = asNode(
					asList(cause.script.data.startShapeList)[0] ?? asList(cause.script.data.activeShapeList)[0],
				);
				const position = vec3(shape?.offset);
				out.push({
					kind: 'script',
					position,
					radius: position !== null && typeof shape?.radius === 'number' ? shape.radius : null,
					shows,
				});
				break;
			}
			case 'server': {
				if (quests.length === 0) {
					out.push({ kind: 'server', shows });
				}
				break;
			}
		}
		return out;
	}

	return drivers;
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
		const text = new TextDecoder().decode(await vfs.readVerified((await vfs.find(VfsGroup.JsonData, name))!));
		for (const reference of text.matchAll(/"scriptId":\s*"?(\d+)/g)) {
			getOrInsert(references, reference[1], () => new Set()).add(match[1]);
		}
	}
	return references;
};
