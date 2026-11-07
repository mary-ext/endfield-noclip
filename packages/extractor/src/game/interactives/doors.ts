import { type DraftControl, sceneControl, switchValues } from '../state/scene-control.ts';

import { readDoorPoses, type DoorPoses } from './door-poses.ts';
import type { FacilitySources } from './facility-sources.ts';
import type { InteractiveKind, InteractiveRow, SingleModelTemplate } from './interactive-row.ts';
import type { TemplateTraits } from './template-traits.ts';

/** components that make a template a door: common doors, and Dijiang's room doors */
export const DOOR_COMPONENTS = [
	'_InteractiveDoorCommonComponentDataForMemoryPack',
	'_SpaceshipRoomDoorSystemDataForMemoryPack',
];

/** a placed door and its open/closed control */
export interface InteractiveDoor {
	control: DraftControl;
	position: [number, number, number];
}

/**
 * doors: a door template whose model has door poses is drawn closed and open under a `door:<row id>` control,
 * closed by default. a model without door poses is left to the next kind
 */
export class InteractiveDoors implements InteractiveKind {
	/** one per placed door, in placement order */
	readonly doors: InteractiveDoor[] = [];
	readonly #sources: FacilitySources;
	/** by template key, the door poses of its model */
	readonly #poses = new Map<string, DoorPoses>();
	/** by model, its door poses; `null` without */
	readonly #byModel = new Map<string, DoorPoses | null>();

	/** @param sources install readers, where unreadable view states are reported */
	constructor(sources: FacilitySources) {
		this.#sources = sources;
	}

	async prepare(key: string, { model }: SingleModelTemplate, traits: TemplateTraits): Promise<void> {
		if (traits.kind !== 'door') {
			return;
		}
		let poses = this.#byModel.get(model);
		if (poses === undefined) {
			const sources = this.#sources;
			poses = await sources.attempt(
				model,
				() => readDoorPoses(sources.context, sources.models.viewsOf(model)),
				null,
			);
			this.#byModel.set(model, poses);
		}
		if (poses !== null) {
			this.#poses.set(key, poses);
		}
	}

	place(placed: InteractiveRow): boolean {
		const { row, template } = placed;
		const poses = this.#poses.get(row.template);
		if (poses === undefined) {
			return false;
		}
		const control = `door:${row.id}`;
		this.doors.push({
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
		placed.place(template.forms[0], { alternatives: [[{ control, mask: 1 }]] }, poses.closed);
		placed.place(template.forms[0], { alternatives: [[{ control, mask: 2 }]] }, poses.open);
		return true;
	}
}
