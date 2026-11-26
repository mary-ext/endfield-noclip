import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';

import { compareNumbers } from '../../util/compare.ts';
import { mapPool } from '../../util/pool.ts';
import type { DraftControl } from '../state/scene-control.ts';
import { progressionControl } from '../state/scenery-variants.ts';

import { readDoodadShell, type DoodadShell } from './doodad-shell.ts';
import type { FacilitySources, InteractiveForm, PrefabHashes } from './facility-sources.ts';
import type { InteractiveRow } from './interactive-row.ts';
import type { AuthoredTemplate } from './template-models.ts';

/** unique prefab shells read concurrently */
const SHELL_CONCURRENCY = 16;

/**
 * doodad-group centres, whose shell loads one form per group level into its slots: each form is placed under
 * its level's bit of a per-level `doodadGroups:<level id>` progression instead of the shell prefab itself
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
		const uniquePrefabs: string[] = [];
		const seenPrefabs = new Set<string>();
		for (const template of authored.values()) {
			if (template.name !== null) {
				continue;
			}
			const [{ prefab }] = template.forms;
			if (!seenPrefabs.has(prefab)) {
				seenPrefabs.add(prefab);
				uniquePrefabs.push(prefab);
			}
		}
		// read distinct prefabs concurrently, then report errors and record forms in authored order
		const fetched = await mapPool(
			uniquePrefabs,
			SHELL_CONCURRENCY,
			async (prefab): Promise<DoodadShell | FormatError | null> => {
				try {
					return await readDoodadShell(resolver, await this.#prefabs.root(prefab));
				} catch (error) {
					if (error instanceof FormatError) {
						return error;
					}
					throw error;
				}
			},
		);
		const shells = new Map<string, DoodadShell | null>();
		for (const [i, prefab] of uniquePrefabs.entries()) {
			const result = fetched[i];
			if (result instanceof FormatError) {
				sources.report(prefab, result.message);
				shells.set(prefab, null);
			} else {
				shells.set(prefab, result);
			}
		}
		for (const [key, template] of authored) {
			if (template.name !== null) {
				continue;
			}
			const [{ prefab, scale }] = template.forms;
			const shell = shells.get(prefab) ?? null;
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
	 * @returns whether the row is a doodad-group shell and was placed
	 */
	place(placed: InteractiveRow): boolean {
		const group = this.#groups.get(placed.row.template);
		if (group === undefined || group.length === 0) {
			return false;
		}
		const id = `doodadGroups:${placed.placed.levelId}`;
		const levels = this.#levels.getOrInsertComputed(id, () => new Set<number>());
		for (const { groupLevel, form } of group) {
			levels.add(groupLevel);
			placed.place(form, { alternatives: [[{ control: id, mask: (1 << groupLevel) >>> 0 }]] }, null);
		}
		return true;
	}

	/** @returns one progression per level with doodad groups, defaulting to the fully grown form */
	progressions(): DraftControl[] {
		return this.#levels
			.entries()
			.map(([id, set]) => {
				// oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy
				const levels = [...set].sort(compareNumbers);
				// which slots a shell leaves active says nothing about its level, hence the default
				return progressionControl(
					'doodadGroups',
					id,
					'Resource nodes',
					levels,
					levels.at(-1)!,
					'the fully grown form',
				);
			})
			.toArray();
	}
}
