import type { LevelInteractive } from '@endfield-noclip/formats/endfield/level-interactives';
import type { MemoryPackValue } from '@endfield-noclip/formats/endfield/memory-pack';

import type { PrefabPose } from '../prefabs/prefab.ts';
import { type DraftControl, sceneControl, switchValues } from '../state/scene-control.ts';

import type { FacilityContext, FacilitySources } from './facility-sources.ts';
import type { InteractiveKind, InteractiveRow, SingleModelTemplate } from './interactive-row.ts';
import { componentFloat, STATE_KEY, stateOf } from './template-data.ts';
import type { TemplateTraits } from './template-traits.ts';
import { type ModelViews, readViewStates, type RestingEffect, settledPose } from './view-state-poses.ts';

/** the component of campfires */
export const CAMPFIRE_COMPONENTS = ['_InteractiveCampfireComponentDataForMemoryPack'];

/** the component of vertical rope lifts, which set their rope's length from their two ports */
export const VERTICAL_ROPE_COMPONENTS = ['_InteractiveVerticalRopeComponentDataForMemoryPack'];

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

/** a settled look of an interactive's model, its settled states' names and the effects they leave playing */
export interface SettledLook {
	pose: PrefabPose;
	states: string[];
	effects: RestingEffect[];
}

/**
 * an interactive model's looks at rest. `away` and `near` are indexed by the activation (campfires: 0 not
 * activated, 1 activated; every other interactive has only 0). `near` is `null` when nothing the player's
 * presence sets changes the look
 */
export interface InteractiveLooks {
	away: SettledLook[];
	near: SettledLook[] | null;
}

/** a view-state key that follows the player, and how near the player must be for it to hold */
export interface PlayerKey {
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
 * @returns the player-set keys its components drive
 */
export const playerKeys = (template: MemoryPackValue): PlayerKey[] =>
	PLAYER_KEYS.flatMap(({ key, component, property }) => {
		const radius = componentFloat(template, component, property);
		return radius === null || !(radius > 0) ? [] : [{ key, radius }];
	});

/** what a model's view states are settled with */
export interface LookKeys {
	/** whether the model's `Enabled` key is the player's activation */
	campfire: boolean;
	/** the player-set keys the template drives; one whose radius is largest counts */
	keys: readonly PlayerKey[];
	/** the `state` key's value, `null` when nothing sets it */
	state: number | null;
	/** float keys the interactive's components set before its view states start */
	floats: ReadonlyMap<string, number>;
}

/**
 * @param context install readers and the bundle resolver
 * @param model a ModelTable model and the model whose view states it uses
 * @param keys what its view states are settled with
 * @returns the model's settled looks, or `null` when it has no view states
 * @throws {FormatError} if a state machine can't settle or a clip can't be read
 */
export const readInteractiveLooks = async (
	context: FacilityContext,
	model: ModelViews,
	{ campfire, keys, state, floats }: LookKeys,
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

/** a template's settled looks and what they were settled with */
interface TemplateLooks {
	model: string;
	looks: InteractiveLooks;
	campfire: boolean;
	keys: PlayerKey[];
	/** how near the player must be for the near look, `null` when nothing the player sets changes it */
	radius: number | null;
	/** the `state` `looks` were settled with, `null` when nothing passes one on */
	state: number | null;
	/** whether it's a vertical rope's port, whose look also follows its other port */
	verticalRope: boolean;
}

/**
 * interactives with view states, drawn as they rest: campfires locked or activated under an `activation:<row
 * id>` control, and those the player's presence changes away or near under a `proximity:<row id>` control. a
 * placement's own `state`, and a vertical rope's length, settle its model again
 */
export class RestLooks implements InteractiveKind {
	/** controls of interactives whose look follows the player's presence, in placement order */
	readonly proximityControls: DraftControl[] = [];
	readonly #sources: FacilitySources;
	readonly #progressions: DraftControl[];
	readonly #doodads: { has(key: string): boolean };
	readonly #rows: ReadonlyMap<bigint, LevelInteractive>;
	/** by template key */
	readonly #templates = new Map<string, TemplateLooks>();
	/** by model and what it's settled with; `null` without view states or when they can't be read */
	readonly #looks = new Map<string, Promise<InteractiveLooks | null>>();

	/**
	 * @param sources install readers, where unreadable view states are reported
	 * @param options.progressions where campfires' activation controls go
	 * @param options.doodads doodad-group shells, which draw no look of their own
	 * @param options.rows placed rows by id, where a vertical rope's port finds its other port
	 */
	constructor(
		sources: FacilitySources,
		{
			progressions,
			doodads,
			rows,
		}: {
			progressions: DraftControl[];
			doodads: { has(key: string): boolean };
			rows: ReadonlyMap<bigint, LevelInteractive>;
		},
	) {
		this.#sources = sources;
		this.#progressions = progressions;
		this.#doodads = doodads;
		this.#rows = rows;
	}

	async prepare(key: string, { model }: SingleModelTemplate, traits: TemplateTraits): Promise<void> {
		if (traits.kind !== 'other' || this.#doodads.has(key)) {
			return;
		}
		const { campfire, keys, start, verticalRope } = traits;
		const state = start === null ? null : (start.variants.get(key) ?? start.state);
		const looks = await this.#looksOf(model, { campfire, keys, state, floats: new Map() });
		if (looks !== null) {
			const radius = looks.near === null ? null : Math.max(...keys.map((entry) => entry.radius));
			this.#templates.set(key, { model, looks, campfire, keys, radius, state, verticalRope });
		}
	}

	async place(placed: InteractiveRow): Promise<boolean> {
		const { row, template } = placed;
		const rest = this.#templates.get(row.template);
		if (rest === undefined) {
			return false;
		}
		const { campfire, radius } = rest;
		let { looks } = rest;
		// a placement's own `state` overrides its template's
		const state = (rest.state === null ? null : stateOf(row)) ?? rest.state;
		const floats = rest.verticalRope ? verticalRopeFloats(row, this.#rows) : new Map<string, number>();
		if (state !== rest.state || floats.size > 0) {
			looks = (await this.#looksOf(rest.model, { campfire, keys: rest.keys, state, floats })) ?? looks;
		}
		const activation = `activation:${row.id}`;
		if (campfire) {
			this.#progressions.push(
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
			this.proximityControls.push(
				sceneControl({
					kind: 'proximity',
					id: nearness,
					name: campfire ? 'Campfire, player nearby' : row.template,
					position: row.position,
					values: switchValues(`away (${states(looks.away)})`, `within ${radius} m (${states(looks.near)})`),
					default: 0,
					assumption: 'follows the camera, as the game follows the player',
					source: {
						kind: 'camera',
						test: { kind: 'near', reaches: [{ position: [...row.position], radius }] },
					},
				}),
			);
		}
		const [form] = template.forms;
		for (const [i, away] of looks.away.entries()) {
			const requirements = campfire ? [{ control: activation, mask: 1 << i }] : [];
			const near = looks.near?.[i];
			if (near === undefined || near.states.join() === away.states.join()) {
				placed.placeLook(form, { alternatives: [requirements] }, away);
				continue;
			}
			placed.placeLook(form, { alternatives: [[...requirements, { control: nearness, mask: 1 }]] }, away);
			placed.placeLook(form, { alternatives: [[...requirements, { control: nearness, mask: 2 }]] }, near);
		}
		return true;
	}

	#looksOf(model: string, keys: LookKeys): Promise<InteractiveLooks | null> {
		const { campfire, state, floats } = keys;
		const sources = this.#sources;
		return this.#looks.getOrInsertComputed(
			`${model} ${campfire} ${keys.keys.map((entry) => entry.key).join()} ${state} ${JSON.stringify([...floats])}`,
			() =>
				sources.attempt(
					model,
					() => readInteractiveLooks(sources.context, sources.models.viewsOf(model), keys),
					null,
				),
		);
	}
}
