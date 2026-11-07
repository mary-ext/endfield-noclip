import type { LevelInteractive } from '@endfield-noclip/formats/endfield/level-interactives';
import { trsMatrix, unityEulerQuaternion } from '@endfield-noclip/formats/unity/transform';

import type { StructureModel } from '../dynamic/dynamic-structures.ts';
import type { PrefabPose } from '../prefabs/prefab.ts';
import { allOf, type Alternatives } from '../state/game-state.ts';
import {
	type DraftControl,
	sceneControl,
	scriptControl,
	SWITCH_VALUES,
	type Visibility,
} from '../state/scene-control.ts';

import type { Hang } from './cranes.ts';
import type { FacilitySources, PrefabHashes } from './facility-sources.ts';
import { type Ride, ridePose } from './moving-platforms.ts';
import type { PlacedInteractive } from './placed-interactives.ts';
import type { SettledLook } from './rest-looks.ts';
import type { RestingEffects } from './resting-effects.ts';
import type { AuthoredTemplate } from './template-models.ts';
import type { TemplateTraits } from './template-traits.ts';

// a placed row is drawn by the first kind of interactive that claims it. every model it places goes through
// one InteractiveRow, which applies what the row's kind doesn't decide: its switches and blight core, its model
// scale, the spline it rides, the hook it hangs from and its gameplay lock

/** a single-model template, as kinds read it */
export type SingleModelTemplate = AuthoredTemplate & { model: string };

/** reads what it needs of each placed single-model template */
export interface TemplateReader {
	/**
	 * called once per single-model template, in first-placement order
	 *
	 * @param key the template's key
	 * @param template what it draws
	 * @param traits what its template file says it is
	 */
	prepare(key: string, template: SingleModelTemplate, traits: TemplateTraits): void | Promise<void>;
}

/** a kind of interactive with a look of its own */
export interface InteractiveKind extends TemplateReader {
	/**
	 * @param row a placed row with a model
	 * @returns whether the kind drew it; `false` leaves it to the next kind
	 */
	place(row: InteractiveRow): boolean | Promise<boolean>;
}

/** the `InteractiveComponentType.ActivitySnapshotComponent`: a limited-time photo event's spot */
const ACTIVITY_SNAPSHOT_COMPONENT = 2000;

/** the scene's one control for limited-time event placements */
const ACTIVITY_CONTROL_ID = 'activity:snapshot';

/**
 * the controls a row's placements require beyond their own look: its level's `created` control for a row
 * created later, the scene's event control for a limited-time photo spot, and a script control for a row a
 * level script shows and hides
 */
export class RowSwitches {
	/** by logic id, the controls of the rows level scripts show and hide, shown as placed */
	readonly scriptControls = new Map<string, DraftControl>();
	readonly #scripted: ReadonlySet<string>;
	/** whether any row needs the activity control */
	#activity = false;

	/** @param scripted logic ids of the interactives level scripts show and hide */
	constructor(scripted: ReadonlySet<string>) {
		this.#scripted = scripted;
	}

	/**
	 * @param placed a placed row
	 * @returns the switch controls all its placements require, registering the ones it's the first to need
	 */
	of({ row, created }: PlacedInteractive): string[] {
		const logicId = row.id.toString();
		const switches: string[] = [];
		if (created !== null) {
			switches.push(created);
		}
		if (row.componentProperties.has(ACTIVITY_SNAPSHOT_COMPONENT)) {
			switches.push(ACTIVITY_CONTROL_ID);
			this.#activity = true;
		}
		if (this.#scripted.has(logicId)) {
			const control = scriptControl(logicId);
			switches.push(control);
			this.scriptControls.getOrInsertComputed(logicId, () =>
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
		return switches;
	}

	/** @returns the control that shows limited-time event placements, off; empty when no row needs it */
	activities(): DraftControl[] {
		if (!this.#activity) {
			return [];
		}
		return [
			sceneControl({
				kind: 'activity',
				id: ACTIVITY_CONTROL_ID,
				name: 'Event photo spots',
				values: SWITCH_VALUES,
				default: 0,
				assumption: 'hidden: placed for limited-time photo events, which the server opens and closes',
			}),
		];
	}
}

/**
 * @param switches switch controls every placement requires on
 * @param erosion the conditions a blight core's erosion root or sludge loads under, `undefined` for another
 *   row
 * @returns what turns a look's visibility into its placement's
 */
export const rowGate = (
	switches: readonly string[],
	erosion: Alternatives | undefined,
): ((visibility: Visibility) => Visibility) => {
	const switchRequirements = switches.map((control) => ({ control, mask: 2 }));
	return (visibility) => {
		// a blight core shows while its erosion root or sludge loads, so both go when the core is destroyed
		const alternatives =
			erosion === undefined ? visibility.alternatives : allOf(visibility.alternatives, erosion);
		return { alternatives: alternatives.map((requirements) => requirements.concat(switchRequirements)) };
	};
};

/** a placed row with a model, and where the models it places go */
export class InteractiveRow {
	readonly placed: PlacedInteractive;
	readonly row: LevelInteractive;
	/** `<LevelData path>#<row id>` */
	readonly source: string;
	readonly template: AuthoredTemplate;
	/** what turns a look's visibility into its placement's */
	readonly gate: (visibility: Visibility) => Visibility;
	readonly #sources: FacilitySources;
	readonly #prefabs: PrefabHashes;
	readonly #models: StructureModel[];
	readonly #effects: RestingEffects;
	readonly #ride: Ride | null;
	readonly #hang: Hang | undefined;
	readonly #locked: boolean;

	/**
	 * @param fields the row, its template and gate, what modifies all its placements, and where they go
	 * @param fields.ride the spline it rides from its start, `null` when it stays put
	 * @param fields.hang where a crane tower hangs it instead of its placement
	 * @param fields.locked whether its gameplay lock shows its locked look
	 */
	constructor(fields: {
		sources: FacilitySources;
		prefabs: PrefabHashes;
		models: StructureModel[];
		effects: RestingEffects;
		placed: PlacedInteractive;
		template: AuthoredTemplate;
		gate: (visibility: Visibility) => Visibility;
		ride: Ride | null;
		hang: Hang | undefined;
		locked: boolean;
	}) {
		this.placed = fields.placed;
		this.row = fields.placed.row;
		this.source = `${fields.placed.path}#${fields.placed.row.id}`;
		this.template = fields.template;
		this.gate = fields.gate;
		this.#sources = fields.sources;
		this.#prefabs = fields.prefabs;
		this.#models = fields.models;
		this.#effects = fields.effects;
		this.#ride = fields.ride;
		this.#hang = fields.hang;
		this.#locked = fields.locked;
	}

	/**
	 * @param model a form's prefab and scale
	 * @returns the row's scale times its model scale: the row's own, else the form's
	 */
	scaleOf(model: { scale: number }): [number, number, number] {
		const { row } = this;
		// zero is the authored "no scale override" sentinel on LevelInteractiveData.
		const scale = row.modelScale > 0 ? row.modelScale : model.scale;
		return [row.scale[0] * scale, row.scale[1] * scale, row.scale[2] * scale];
	}

	/**
	 * places one of the row's models
	 *
	 * @param model a form's prefab and scale
	 * @param shown when the look shows, before the row's gate
	 * @param pose its pose, `null` as saved
	 * @throws {FormatError} if the prefab's hash wasn't found
	 */
	place(model: { prefab: string; scale: number }, shown: Visibility, pose: PrefabPose | null): void {
		const { row, source } = this;
		const visibility = this.gate(shown);
		const scales = this.scaleOf(model);
		let posed = pose;
		if (this.#ride !== null) {
			const riding = ridePose(
				this.#ride,
				trsMatrix(row.position, unityEulerQuaternion(row.rotation), scales),
				pose,
				source,
			);
			if ('reason' in riding) {
				this.#sources.report(source, riding.reason);
			} else {
				posed = riding;
			}
		}
		const hang = this.#hang;
		this.#models.push({
			model: {
				pathHash: this.#prefabs.hashOf(model.prefab),
				position: hang?.position ?? row.position,
				rotation: hang?.rotation ?? row.rotation,
				scale: scales,
			},
			levelTag: this.placed.levelTag,
			source,
			logicId: row.id.toString(),
			visibility,
			pose: posed,
			locked: this.#locked,
		});
	}

	/**
	 * places a settled look's model, and the looping effects its states leave playing on it
	 *
	 * @param model a form's prefab and scale
	 * @param shown when the look shows, before the row's gate
	 * @param look the settled look
	 */
	placeLook(model: { prefab: string; scale: number }, shown: Visibility, look: SettledLook): void {
		const { row } = this;
		this.place(model, shown, look.pose);
		const frame = trsMatrix(row.position, unityEulerQuaternion(row.rotation), this.scaleOf(model));
		for (const rest of look.effects) {
			this.#effects.queue({
				effect: rest.effect,
				source: this.source,
				levelTag: this.placed.levelTag,
				visibility: this.gate(shown),
				frame,
				on: { prefab: model.prefab, pose: look.pose, rest },
				followRotation: rest.followRotation,
			});
		}
	}
}
