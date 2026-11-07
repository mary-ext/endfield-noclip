import type { PrefabPose } from '../prefabs/prefab.ts';
import type { DraftControl } from '../state/scene-control.ts';
import { progressionControl } from '../state/scenery-variants.ts';

import type { FacilitySources } from './facility-sources.ts';
import type { InteractiveRow } from './interactive-row.ts';
import { readInteractiveLooks } from './rest-looks.ts';
import type { AuthoredTemplate } from './template-models.ts';

/**
 * facilities: templates with a model-upgrade component, one model per visual form under a per-row
 * `facility:<row id>` progression, fully upgraded by default
 */
export class FacilityForms {
	readonly #sources: FacilitySources;
	readonly #progressions: DraftControl[];
	/** facility forms with view states drawn as they rest (an idle loop keeps playing), by ModelTable id */
	readonly #poses = new Map<string, PrefabPose>();

	/**
	 * @param sources install readers, where unreadable view states are reported
	 * @param progressions where the facilities' controls go
	 */
	constructor(sources: FacilitySources, progressions: DraftControl[]) {
		this.#sources = sources;
		this.#progressions = progressions;
	}

	/**
	 * settles each visual form as its own model, with every key false
	 *
	 * @param template a facility template
	 */
	async prepare(template: AuthoredTemplate): Promise<void> {
		const sources = this.#sources;
		for (const form of template.forms) {
			if (this.#poses.has(form.model)) {
				continue;
			}
			// oxlint-disable-next-line no-await-in-loop -- one view state file and a clip per form
			const looks = await sources.attempt(
				form.model,
				() =>
					readInteractiveLooks(sources.context, sources.models.viewsOf(form.model), {
						campfire: false,
						keys: [],
						state: null,
						floats: new Map(),
					}),
				null,
			);
			if (looks !== null) {
				this.#poses.set(form.model, looks.away[0].pose);
			}
		}
	}

	/** @param placed a placed facility row */
	place(placed: InteractiveRow): void {
		const { row, template } = placed;
		const id = `facility:${row.id}`;
		this.#progressions.push(
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
			placed.place(
				model,
				{ alternatives: [[{ control: id, mask: (1 << form) >>> 0 }]] },
				this.#poses.get(model.model) ?? null,
			);
		}
	}
}
