import { isMemoryPackObject, type MemoryPackValue } from '@endfield-noclip/formats/endfield/memory-pack';

import { animatorParameterId, animatorPose } from '../prefabs/animator-defaults.ts';
import type { PrefabPose } from '../prefabs/prefab.ts';
import { type DraftControl, sceneControl, switchValues } from '../state/scene-control.ts';

import type { FacilitySources, PrefabHashes } from './facility-sources.ts';
import type { InteractiveKind, InteractiveRow, SingleModelTemplate } from './interactive-row.ts';
import { boolProperty, hasComponent } from './template-data.ts';
import type { TemplateTraits } from './template-traits.ts';

/** the Animator bools an interactive sets on load: fixed ones, and at most one that follows a saved property */
export interface AnimatorStart {
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
 * @param template a decoded interactive template
 * @returns the Animator bools its simple-animator component gets from the template's on-load action chain, or
 *   `null` when it has no such component or chain, or sets more than one bool from saved properties
 */
export const animatorStart = (template: MemoryPackValue): AnimatorStart | null => {
	if (
		!isMemoryPackObject(template) ||
		!hasComponent(template, ['_SimpleAnimatorComponentDataForMemoryPack'])
	) {
		return null;
	}
	const map = template.dataMap;
	if (!isMemoryPackObject(map)) {
		return null;
	}
	const headers = Array.isArray(map.headerList) ? map.headerList.filter(isMemoryPackObject) : [];
	const actions = new Map(
		(Array.isArray(map.actionList) ? map.actionList.filter(isMemoryPackObject) : []).map((action) => [
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
		const parameter = isMemoryPackObject(action.key) ? action.key.constValue : null;
		const value = isMemoryPackObject(action.value) ? action.value : null;
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

/**
 * interactives whose template sets their own Animator's bools on load, posed in the states they settle. one
 * bool from a saved property puts the row under an `activation:<row id>` control, set by default. a model
 * with view states is drawn by its rest look instead, which is tried first
 */
export class AnimatorStarts implements InteractiveKind {
	readonly #sources: FacilitySources;
	readonly #prefabs: PrefabHashes;
	readonly #progressions: DraftControl[];
	readonly #doodads: { has(key: string): boolean };
	/** by template key */
	readonly #starts = new Map<string, AnimatorStart>();
	/** by prefab and parameter values; `null` when no Animator plays a clip (drawn as saved) */
	readonly #poses = new Map<string, Promise<PrefabPose | null>>();

	/**
	 * @param sources where unreadable prefabs are reported
	 * @param options.prefabs the prefab hash lookup
	 * @param options.progressions where activation controls go
	 * @param options.doodads doodad-group shells, which draw no look of their own
	 */
	constructor(
		sources: FacilitySources,
		{
			prefabs,
			progressions,
			doodads,
		}: { prefabs: PrefabHashes; progressions: DraftControl[]; doodads: { has(key: string): boolean } },
	) {
		this.#sources = sources;
		this.#prefabs = prefabs;
		this.#progressions = progressions;
		this.#doodads = doodads;
	}

	prepare(key: string, _template: SingleModelTemplate, traits: TemplateTraits): void {
		if (traits.kind === 'other' && !this.#doodads.has(key) && traits.animator !== null) {
			this.#starts.set(key, traits.animator);
		}
	}

	async place(placed: InteractiveRow): Promise<boolean> {
		const { row, template } = placed;
		const start = this.#starts.get(row.template);
		if (start === undefined) {
			return false;
		}
		const [form] = template.forms;
		if (start.saved === null) {
			placed.place(form, { alternatives: [[]] }, await this.#poseOf(form.prefab, start, null));
			return true;
		}
		const control = `activation:${row.id}`;
		const { property } = start.saved;
		this.#progressions.push(
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
			// oxlint-disable-next-line no-await-in-loop -- one pose per prefab and parameter set
			const pose = await this.#poseOf(form.prefab, start, set);
			placed.place(form, { alternatives: [[{ control, mask: 1 << value }]] }, pose);
		}
		return true;
	}

	/**
	 * @param prefab the interactive's model prefab
	 * @param start the Animator bools its template sets on load
	 * @param saved the saved property's value, `null` without one
	 * @returns what the prefab's Animators rest in under those bools
	 */
	#poseOf(prefab: string, start: AnimatorStart, saved: boolean | null): Promise<PrefabPose | null> {
		const parameters = new Map<number, boolean>();
		for (const [name, value] of start.fixed) {
			parameters.set(animatorParameterId(name), value);
		}
		if (start.saved !== null && saved !== null) {
			parameters.set(animatorParameterId(start.saved.parameter), saved);
		}
		const key = `${prefab}:${[...parameters].map(([id, value]) => `${id}=${Number(value)}`).join(',')}`;
		return this.#poses.getOrInsertComputed(key, () =>
			this.#sources.attempt(
				prefab,
				async () => {
					const resolver = await this.#sources.context.resolver();
					return animatorPose(resolver, await this.#prefabs.root(prefab), parameters);
				},
				null,
			),
		);
	}
}
