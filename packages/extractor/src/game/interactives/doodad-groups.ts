import type { DraftControl } from '../state/scene-control.ts';
import { progressionControl } from '../state/scenery-variants.ts';

import { readDoodadShell, type DoodadShell } from './doodad-shell.ts';
import type { FacilitySources, InteractiveForm, PrefabHashes } from './facility-sources.ts';
import type { InteractiveRow } from './interactive-row.ts';
import type { AuthoredTemplate } from './template-models.ts';

/**
 * doodad-group centres, which draw an empty shell: their visible model is one form per group level, each
 * under its level's bit of a per-level `doodadGroups:<level id>` progression
 */
export class DoodadGroups {
	readonly #sources: FacilitySources;
	readonly #prefabs: PrefabHashes;
	/** by template key, its forms by group level */
	readonly #groups = new Map<string, { groupLevel: number; form: InteractiveForm }[]>();
	/** by control id, the group levels its rows place */
	readonly #levels = new Map<string, Set<number>>();

	/**
	 * @param sources install readers, where unreadable shells are reported
	 * @param prefabs the prefab hash lookup, which the forms' prefabs join
	 */
	constructor(sources: FacilitySources, prefabs: PrefabHashes) {
		this.#sources = sources;
		this.#prefabs = prefabs;
	}

	/**
	 * reads the shells of the single-model templates, in their order
	 *
	 * @param authored what each placed template draws
	 */
	async read(authored: ReadonlyMap<string, AuthoredTemplate>): Promise<void> {
		const sources = this.#sources;
		const resolver = await sources.context.resolver();
		const shells = new Map<string, DoodadShell | null>();
		for (const [key, template] of authored) {
			if (template.name !== null) {
				continue;
			}
			const [{ prefab, scale }] = template.forms;
			let shell = shells.get(prefab);
			if (shell === undefined) {
				// oxlint-disable-next-line no-await-in-loop -- one root per distinct prefab
				shell = await sources.attempt(
					prefab,
					async () => readDoodadShell(resolver, await this.#prefabs.root(prefab)),
					null,
				);
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
				if (!sources.models.has(modelId)) {
					sources.report(prefab, `doodad form ${modelId} is not in the model table`);
					continue;
				}
				levels.push({ groupLevel, form: sources.models.formOf(modelId, scale) });
			}
			this.#groups.set(key, levels);
		}
		await this.#prefabs.find(
			this.#groups.values().flatMap((levels) => levels.map(({ form }) => form.prefab)),
		);
	}

	/**
	 * @param key a template key
	 * @returns whether it's a doodad-group shell, which draws no look of its own
	 */
	has(key: string): boolean {
		return this.#groups.has(key);
	}

	/**
	 * places a shell's forms, if the row is one
	 *
	 * @param placed a placed single-model row
	 */
	place(placed: InteractiveRow): void {
		const group = this.#groups.get(placed.row.template);
		if (group === undefined || group.length === 0) {
			return;
		}
		const id = `doodadGroups:${placed.placed.levelId}`;
		const levels = this.#levels.getOrInsertComputed(id, () => new Set<number>());
		for (const { groupLevel, form } of group) {
			levels.add(groupLevel);
			placed.place(form, { alternatives: [[{ control: id, mask: (1 << groupLevel) >>> 0 }]] }, null);
		}
	}

	/** @returns one progression per level with doodad groups, defaulting to the fully grown form */
	progressions(): DraftControl[] {
		return [...this.#levels].map(([id, set]) => {
			// oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy
			const levels = [...set].sort((a, b) => a - b);
			// which slots a shell leaves active says nothing about its level, hence the default
			return progressionControl(
				'doodadGroups',
				id,
				'Resource nodes',
				levels,
				levels.at(-1)!,
				'the fully grown form',
			);
		});
	}
}
