import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import type { MemoryPackValue } from '@endfield-noclip/formats/endfield/memory-pack';

import { animatorParameterId, animatorPose } from '../prefabs/animator-defaults.ts';
import type { PrefabRoots } from '../prefabs/prefab-root.ts';
import type { PrefabPose } from '../prefabs/prefab.ts';
import type { LevelScripts, Script } from '../script-drivers.ts';
import { allOf } from '../state/game-state.ts';
import { type DraftControl, sceneControl, switchValues } from '../state/scene-control.ts';

import type { StructureModel } from './dynamic-structures.ts';

// the Animator values level scripts set on script-controlled scenery as they start
// (docs/game-data/animation.md#decoration-animators)

/** Animator parameter values, by parameter name */
export type DecorationAnimatorValues = ReadonlyMap<string, number | boolean>;

/** what a group's scripts set on its prefabs' Animators when they start */
export interface DecorationAnimatorStart {
	/** the script that sets them */
	script: string;
	/** values set whatever the script's saved properties hold */
	fixed: DecorationAnimatorValues;
	/** values that follow one saved property, `null` when none does */
	saved: {
		property: string;
		/** values set while the property is unset and while it's set */
		unset: DecorationAnimatorValues;
		set: DecorationAnimatorValues;
	} | null;
}

/** `paramSource` of a constant and of the script's saved property named by its `path` */
const PARAM_CONSTANT = 0;
const PARAM_SAVED = 300;

const START = /_ScriptEvent_OnScriptActiveForMemoryPack$/;
const IF_ELSE = /_IfElseActionForMemoryPack$/;
const SET_VALUE = /_SetDecorationAnimator(Int|Bool)ForMemoryPack$/;

type Node = Script['nodes'] extends Map<number, infer N> ? N : never;

const asNode = (value: MemoryPackValue | undefined): Node | null =>
	value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;

/** @returns a param's constant, `undefined` when it isn't one */
const constant = (value: MemoryPackValue | undefined): MemoryPackValue | undefined => {
	const param = asNode(value);
	return param?.paramSource === PARAM_CONSTANT ? param.constValue : undefined;
};

/** one value a start path sets, with the saved property branch it's set under */
interface FoundValue {
	target: string;
	parameter: string;
	value: number | boolean;
	branch: { property: string; set: boolean } | null;
}

/**
 * follows a script from its start headers through `nextID`, branch lists and if/else nodes on saved
 * properties, collecting the Animator values it sets
 *
 * @returns the values, and the targets set past a branch this reader doesn't follow (another condition, or a
 *   second saved property)
 */
const startValues = (script: Script): { found: FoundValue[]; untraced: Set<string> } => {
	const found: FoundValue[] = [];
	const untraced = new Set<string>();
	const visited = new Set<string>();
	const visit = (id: number, branch: FoundValue['branch'], blocked: boolean): void => {
		const key = `${id}:${branch?.property}:${branch?.set}:${blocked}`;
		const node = script.nodes.get(id);
		if (node === undefined || visited.has(key)) {
			return;
		}
		visited.add(key);
		const type = typeof node.$type === 'string' ? node.$type : '';
		if (SET_VALUE.test(type)) {
			const target = constant(node.targetDynamicEntity);
			const parameter = constant(node.animatorParamName);
			const value = constant(node.targetValue);
			if (
				(typeof target === 'string' || typeof target === 'bigint' || typeof target === 'number') &&
				typeof parameter === 'string' &&
				(typeof value === 'number' || typeof value === 'boolean')
			) {
				if (blocked) {
					untraced.add(String(target));
				} else {
					found.push({ target: String(target), parameter, value, branch });
				}
			}
		}
		if (IF_ELSE.test(type)) {
			const condition = asNode(node.condition);
			const property = condition?.paramSource === PARAM_SAVED ? condition.path : null;
			const follows = typeof property === 'string' && branch === null && !blocked;
			for (const [edge, set] of [
				['onTrueID', true],
				['onFalseID', false],
			] as const) {
				const to = node[edge];
				if (typeof to === 'number') {
					visit(to, follows ? { property, set } : branch, blocked || !follows);
				}
			}
		}
		if (typeof node.nextID === 'number') {
			visit(node.nextID, branch, blocked);
		}
		if (Array.isArray(node.idList)) {
			for (const to of node.idList) {
				if (typeof to === 'number') {
					visit(to, branch, blocked);
				}
			}
		}
	};
	for (const header of script.headers) {
		if (typeof header.$type === 'string' && START.test(header.$type) && typeof header.nextID === 'number') {
			// a header fires only while its `validate` holds, a guard this reader doesn't follow unless constant
			const validate = asNode(header.validate) === null ? header.validate : constant(header.validate);
			visit(header.nextID, null, validate !== undefined && validate !== true);
		}
	}
	return { found, untraced };
};

/**
 * @param values one target's values from one script's start paths
 * @returns its start, or `null` when a parameter gets two values on one path, or values follow more than one
 *   saved property
 */
const startOf = (script: string, values: readonly FoundValue[]): DecorationAnimatorStart | null => {
	const fixed = new Map<string, number | boolean>();
	const unset = new Map<string, number | boolean>();
	const set = new Map<string, number | boolean>();
	let property: string | null = null;
	for (const { parameter, value, branch } of values) {
		let into = fixed;
		if (branch !== null) {
			if (property !== null && property !== branch.property) {
				return null;
			}
			property = branch.property;
			into = branch.set ? set : unset;
		}
		if (into.has(parameter) && into.get(parameter) !== value) {
			return null;
		}
		into.set(parameter, value);
	}
	if (property !== null && (set.size === 0 || unset.size === 0)) {
		return null;
	}
	return { script, fixed, saved: property === null ? null : { property, unset, set } };
};

/**
 * finds the Animator values the scene's own level scripts set on script-controlled groups as they start
 * (`SetDecorationAnimatorInt`/`Bool` reached from `ScriptEvent_OnScriptActive`), constant or split on one
 * saved property. values set by other events (quests, custom events, trigger volumes) are left out, since
 * they don't hold whenever the group loads
 *
 * @param levelScripts the scene's decoded level scripts
 * @returns by group id (the action's `targetDynamicEntity`), what its starting script sets, and how many
 *   groups were left as saved because their start paths set them some other way
 */
export const decorationAnimatorStarts = (
	levelScripts: LevelScripts,
): { starts: Map<string, DecorationAnimatorStart>; untraced: number } => {
	const starts = new Map<string, DecorationAnimatorStart>();
	const dropped = new Set<string>();
	for (const script of levelScripts.scripts) {
		if (!levelScripts.ownLevels.has(script.level)) {
			continue;
		}
		const { found, untraced } = startValues(script);
		for (const target of untraced) {
			dropped.add(target);
		}
		const byTarget = Map.groupBy(found, ({ target }) => target);
		for (const [target, values] of byTarget) {
			const start = startOf(script.id, values);
			// a group two scripts set as they start has no one value
			if (start === null || starts.has(target)) {
				dropped.add(target);
			} else {
				starts.set(target, start);
			}
		}
	}
	for (const target of dropped) {
		starts.delete(target);
	}
	return { starts, untraced: dropped.size };
};

/**
 * poses the dynamic structures' prefabs whose group a level script sets Animator values on as it starts. a
 * start that follows a saved property places the model once per value under an
 * `activation:<script>:<property>` control, set by default as in a finished save. models already posed (view
 * states) and effect rows keep their look, and so does a prefab that can't be read
 *
 * @param roots the placed prefabs' roots
 * @param models the dynamic structures' placements
 * @param starts by group id, what its starting script sets ({@link decorationAnimatorStarts})
 * @returns the placements, posed copies in place of the originals, the controls they add and how many models
 *   were posed
 */
export const poseDecorationModels = async (
	roots: PrefabRoots,
	models: readonly StructureModel[],
	starts: ReadonlyMap<string, DecorationAnimatorStart>,
): Promise<{ models: StructureModel[]; controls: DraftControl[]; posed: number }> => {
	const poses = new Map<string, Promise<PrefabPose | null>>();
	const poseOf = (model: StructureModel, values: DecorationAnimatorValues): Promise<PrefabPose | null> => {
		const parameters = new Map([...values].map(([name, value]) => [animatorParameterId(name), value]));
		const key = `${model.model.pathHash}:${[...values].map(([name, value]) => `${name}=${value}`).join(',')}`;
		return poses.getOrInsertComputed(key, async () => {
			const { root } = await roots.root(model.model.pathHash);
			if (root instanceof FormatError) {
				return null;
			}
			return animatorPose(roots.resolver, root, parameters).catch((error: unknown) => {
				if (!(error instanceof FormatError)) {
					throw error;
				}
				return null;
			});
		});
	};
	const out: StructureModel[] = [];
	const controls = new Map<string, DraftControl>();
	let posed = 0;
	for (const model of models) {
		const start = model.owner === undefined ? undefined : starts.get(model.owner);
		if (start === undefined || model.pose !== null || model.source.startsWith('effect:')) {
			out.push(model);
			continue;
		}
		posed++;
		if (start.saved === null) {
			// oxlint-disable-next-line no-await-in-loop -- poses are cached per prefab and values
			out.push({ ...model, pose: await poseOf(model, start.fixed) });
			continue;
		}
		const { property } = start.saved;
		const control = `activation:${start.script}:${property}`;
		controls.getOrInsertComputed(control, () =>
			sceneControl({
				kind: 'activation',
				id: control,
				name: `level script ${start.script}`,
				values: switchValues(`${property} unset`, `${property} set`),
				default: 1,
				assumption: `${property} set, as in a finished save: the server sets it during play`,
			}),
		);
		for (const [value, values] of [start.saved.unset, start.saved.set].entries()) {
			// oxlint-disable-next-line no-await-in-loop -- poses are cached per prefab and values
			const pose = await poseOf(model, new Map([...start.fixed, ...values]));
			out.push({
				...model,
				source: `${model.source}@${property}=${value}`,
				pose,
				visibility: {
					alternatives: allOf(model.visibility.alternatives, [[{ control, mask: 1 << value }]]),
				},
			});
		}
	}
	return { models: out, controls: [...controls.values()], posed };
};
