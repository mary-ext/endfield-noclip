import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import { isSparkBean, parseSparkTable } from '@endfield-noclip/formats/hg/spark-buffer';

import { VfsGroup } from '../../install/vfs.ts';
import { compareNumbers } from '../../util/compare.ts';
import type { DraftControl } from '../state/scene-control.ts';
import { progressionControl } from '../state/scenery-variants.ts';

import type { FacilitySources, InteractiveForm, PrefabHashes } from './facility-sources.ts';
import type { InteractiveRow } from './interactive-row.ts';
import type { PlacedInteractive } from './placed-interactives.ts';
import { type EntityProperties, entityProperty } from './template-data.ts';
import type { AuthoredTemplate } from './template-models.ts';
import type { TemplateTraitsReader } from './template-traits.ts';

// graded doodads (docs/game-data/scene-states.md#graded-doodads): breakable crates and supply boxes whose model
// is one of four forms, picked by a progression level the save holds

/** the doodad config table, keyed by a placement's `doodad_id` */
const DOODAD_TABLE = 'Data/TableCfg/DoodadGeneralTable.bytes';

/** the component that swaps a doodad's model for its form */
export const DOODAD_GRADE_COMPONENTS = ['_InteractiveDoodadGradeComponentDataForMemoryPack'];

/** what a doodad's form follows (the game's `DoodadUpgradeSource`), with its control's label */
const UPGRADE_SOURCES = new Map([
	[1, { key: 'worldLevel', name: 'World level' }],
	[2, { key: 'domainLevel', name: 'Regional development level' }],
	[3, { key: 'innLevel', name: 'Inn level' }],
]);

/**
 * @param need the placement's `upgrade_need_level`: entries 1 to 4 are the levels each form needs (entry 0
 *   isn't read)
 * @param level the progression level
 * @returns the form shown at that level, 1 to 4: the last whose need it meets; `null` below the first need,
 *   where the game indexes form 0 and keeps the template's model
 */
export const gradeForm = (need: readonly number[], level: number): number | null => {
	let form = 0;
	for (let index = 1; index <= 4; index++) {
		if (level >= need[index]) {
			form = index;
		}
	}
	return form === 0 ? null : form;
};

/**
 * @param need the placement's `upgrade_need_level`
 * @param levels the control's levels, each below 32
 * @param base the template's model, shown below the first need
 * @param forms forms 1 to 4
 * @returns each distinct model shown at some level, with the mask of the levels showing it, in level order
 */
export const gradeMasks = <Form extends { model: string }>(
	need: readonly number[],
	levels: Iterable<number>,
	base: Form,
	forms: readonly Form[],
): { form: Form; mask: number }[] => {
	const shown = new Map<string, { form: Form; mask: number }>();
	// oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy
	for (const level of [...levels].sort(compareNumbers)) {
		const index = gradeForm(need, level);
		const form = index === null ? base : forms[index - 1];
		const entry = shown.getOrInsertComputed(form.model, () => ({ form, mask: 0 }));
		entry.mask = (entry.mask | (1 << level)) >>> 0;
	}
	return [...shown.values()];
};

/**
 * @param vfs the game's VFS
 * @returns by doodad id, the `DoodadUpgradeSource` its form follows (0: none)
 * @throws {FormatError} if the table is missing or a row lacks its upgrade source
 */
const readUpgradeSources = async (vfs: FacilitySources['context']['vfs']): Promise<Map<string, number>> => {
	const sources = new Map<string, number>();
	for (const [id, entry] of parseSparkTable(await vfs.read(VfsGroup.Table, DOODAD_TABLE)).entries) {
		const source = isSparkBean(entry) ? entry.upgradeSource : undefined;
		if (typeof id !== 'string' || typeof source !== 'number') {
			throw new FormatError(`${DOODAD_TABLE} has an invalid entry`);
		}
		sources.set(id, source);
	}
	return sources;
};

/** a graded row's forms, resolved before placement */
interface GradedRow {
	control: string;
	need: number[];
	/** the template's model, shown below the first need */
	base: InteractiveForm;
	/** forms 1 to 4 */
	forms: InteractiveForm[];
}

/**
 * graded doodads among the plain-model rows: each form is placed under the levels of its source's
 * `<source>:<scene>` progression that show it. rows whose forms are one model, or whose doodad follows no
 * source, keep their plain model
 */
export class DoodadGrades {
	readonly #sources: FacilitySources;
	readonly #prefabs: PrefabHashes;
	/** by row id */
	readonly #rows = new Map<bigint, GradedRow>();
	/** by control id, its label and the levels its rows need */
	readonly #controls = new Map<string, { name: string; levels: Set<number> }>();

	/**
	 * @param sources install readers, where unusable rows are reported
	 * @param prefabs the prefab hash lookup, which the forms' prefabs join
	 */
	constructor(sources: FacilitySources, prefabs: PrefabHashes) {
		this.#sources = sources;
		this.#prefabs = prefabs;
	}

	/**
	 * resolves the forms of the graded rows among the plain single-model templates' placements
	 *
	 * @param scene the owning map, which the controls are keyed by
	 * @param placed the placed rows
	 * @param authored what each placed template draws
	 * @param traits the templates' traits
	 */
	async read(
		scene: string,
		placed: readonly PlacedInteractive[],
		authored: ReadonlyMap<string, AuthoredTemplate>,
		traits: TemplateTraitsReader,
	): Promise<void> {
		const sources = this.#sources;
		let upgradeSources: Map<string, number> | undefined;
		for (const { path, row } of placed) {
			const template = authored.get(row.template);
			if (template === undefined || template.name !== null) {
				continue;
			}
			const read = traits.of(template.data);
			if (read.kind !== 'other' || !read.doodadGrade || read.entity === null) {
				continue;
			}
			const entity: EntityProperties = read.entity;
			const source = `${path}#${row.id}`;
			const forms = entityProperty(entity, row, 'doodad_form_list')?.map(({ text }) => text) ?? [];
			if (forms.length !== 4 || new Set(forms).size === 1) {
				continue;
			}
			// oxlint-disable-next-line no-await-in-loop -- read once, on the first graded row
			upgradeSources ??= await readUpgradeSources(sources.context.vfs);
			const doodadId = entityProperty(entity, row, 'doodad_id')?.[0]?.text;
			const upgrade = UPGRADE_SOURCES.get(upgradeSources.get(doodadId ?? '') ?? 0);
			if (upgrade === undefined) {
				continue;
			}
			const need = (entityProperty(entity, row, 'upgrade_need_level') ?? []).map(({ bits }) =>
				Number(BigInt.asIntN(32, bits)),
			);
			// levels are mask bits
			if (need.length !== 5 || need.some((level) => level < 0 || level > 31)) {
				sources.report(source, `doodad needs levels ${need.join(', ')}, not five levels below 32`);
				continue;
			}
			const missing = forms.find((model) => model === null || !sources.models.has(model));
			if (missing !== undefined) {
				sources.report(source, `doodad form ${missing} is not in the model table`);
				continue;
			}
			const [{ scale }] = template.forms;
			const control = `${upgrade.key}:${scene}`;
			const entry = this.#controls.getOrInsertComputed(control, () => ({
				name: upgrade.name,
				levels: new Set<number>(),
			}));
			for (const level of need.slice(1)) {
				entry.levels.add(level);
			}
			this.#rows.set(row.id, {
				control,
				need,
				base: template.forms[0],
				forms: forms.map((model) => sources.models.formOf(model!, scale)),
			});
		}
		await this.#prefabs.find(this.#rows.values().flatMap(({ forms }) => forms.map((form) => form.prefab)));
	}

	/**
	 * places a graded row's forms
	 *
	 * @param placed a placed plain-model row
	 * @returns whether the row is graded and was placed
	 */
	place(placed: InteractiveRow): boolean {
		const graded = this.#rows.get(placed.row.id);
		if (graded === undefined) {
			return false;
		}
		const { control, need, base, forms } = graded;
		const levels = this.#controls.get(control)!.levels;
		for (const { form, mask } of gradeMasks(need, levels, base, forms)) {
			placed.place(form, { alternatives: [[{ control, mask }]] }, null);
		}
		return true;
	}

	/** @returns one progression per upgrade source the scene's graded rows follow, defaulting to its top level */
	progressions(): DraftControl[] {
		return this.#controls
			.entries()
			.map(([id, { name, levels }]) => {
				// oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy
				const sorted = [...levels].sort(compareNumbers);
				return progressionControl(
					'doodadGrade',
					id,
					name,
					sorted,
					sorted.at(-1)!,
					'the save holds the level; the highest level any graded doodad needs',
				);
			})
			.toArray();
	}
}
