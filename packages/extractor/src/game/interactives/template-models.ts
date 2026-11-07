import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import {
	readInteractiveBaseModel,
	readInteractiveTable,
	readInteractiveVariantModels,
} from '@endfield-noclip/formats/endfield/interactive-model';
import type { MemoryPackValue } from '@endfield-noclip/formats/endfield/memory-pack';

import type { FacilitySources, InteractiveForm } from './facility-sources.ts';
import type { PlacedInteractive } from './placed-interactives.ts';
import { findComponent, hasComponent, TEMPLATE_ROOT } from './template-data.ts';
import { readTemplateTraits, type TraitsRead } from './template-traits.ts';

/** the interactive table: template ids by interactive id, and template files */
export const INTERACTIVE_TABLE = 'Data/Json/Interactive/InteractiveTable.json';

/** the decoded {@link INTERACTIVE_TABLE} */
export type InteractiveTable = ReturnType<typeof readInteractiveTable>;

/**
 * @param sources install readers
 * @returns the decoded {@link INTERACTIVE_TABLE}
 */
export const loadInteractiveTable = async (sources: FacilitySources): Promise<InteractiveTable> =>
	readInteractiveTable(await sources.read(INTERACTIVE_TABLE), (id) => sources.string(id));

// templates with the model-upgrade component have their visual forms as a progression control; every other
// template draws its base model only. templates carry no display name, so these labels are ours; other
// upgrade-capable templates are labelled by their id
const FACILITY_NAMES = new Map([
	['int_system_domain_shop', 'Stock redistribution facility'],
	['int_system_domain_depot', 'Depot'],
	['int_doodad_core_recycle', 'Recycling station'],
	['int_system_kite_station', 'Environment monitoring terminal'],
]);

/** the component that lists a template's upgrade models */
const MODEL_UPGRADE_COMPONENTS = ['_InteractiveModelLevelUpComponentDataForMemoryPack'];

/**
 * @param template a decoded interactive template
 * @param path its file, for errors
 * @returns its base model (the model component's) and its model-upgrade list, one ModelTable id per visual
 *   form
 * @throws {FormatError} if either component is missing or the base model isn't one of the forms
 */
const facilityModels = (
	template: MemoryPackValue,
	path: string,
): { id: string; scale: number; levels: string[] } => {
	const model = findComponent(template, '_InteractiveModelComponentDataForMemoryPack');
	const upgrade = findComponent(template, '_InteractiveModelLevelUpComponentDataForMemoryPack');
	const levels = upgrade?.modelLevelList;
	if (
		typeof model?.modelId !== 'string' ||
		typeof model.modelScale !== 'number' ||
		!Array.isArray(levels) ||
		!levels.every((level) => typeof level === 'string') ||
		!levels.includes(model.modelId)
	) {
		throw new FormatError(`${path} lacks a model and a model-upgrade list holding it`);
	}
	return { id: model.modelId, scale: model.modelScale, levels };
};

/** what a placed template draws */
export interface AuthoredTemplate {
	/** a facility's label, `null` for a single-model interactive */
	name: string | null;
	/** a facility's visual forms, or a single-model interactive's one form */
	forms: InteractiveForm[];
	/** the ModelTable id of a single-model interactive, `null` for facilities */
	model: string | null;
	/** the template's data file */
	data: string;
}

/** the models of the placed templates */
export interface TemplateModels {
	/** by template key, in first-placement order, the templates that draw a model */
	authored: Map<string, AuthoredTemplate>;
	/** by template key, why a template that may have a model has none to draw */
	modelless: Map<string, string>;
	/** by data file, the traits of every template without the model-upgrade component */
	traits: Map<string, TraitsRead>;
}

/**
 * resolves what each placed template draws: the visual forms of a template with a model-upgrade component,
 * else its variant's model, else the template's; none for a variant that overrides it with an empty model.
 * templates that are missing or can't be read, and models the model table lacks, are reported. each template
 * file is read and decoded once, for its models and its traits
 *
 * @param sources install readers, where skipped files are reported
 * @param interactives the interactive table
 * @param placed the placed rows
 * @returns the templates' models by key, and their traits by file
 */
export const resolveTemplateModels = async (
	sources: FacilitySources,
	interactives: InteractiveTable,
	placed: readonly PlacedInteractive[],
): Promise<TemplateModels> => {
	const string = (id: number) => sources.string(id);
	const authored = new Map<string, AuthoredTemplate>();
	const modelless = new Map<string, string>();
	const templates = new Map<
		string,
		{
			base: { id: string; scale: number } | null;
			variants: Map<string, string | null>;
			/** why the template couldn't be read, `null` when it was */
			failure: string | null;
		}
	>();
	const variantsOf = new Map<string, Set<string>>();
	for (const [id, template] of interactives.templates) {
		if (id !== template) {
			variantsOf.getOrInsertComputed(template, () => new Set()).add(id);
		}
	}
	/** by template data file, its upgrade models, or `null` without the model-upgrade component */
	const upgrades = new Map<string, ReturnType<typeof facilityModels> | null>();
	const traits = new Map<string, TraitsRead>();
	for (const key of new Set(placed.map(({ row }) => row.template))) {
		const template = interactives.templates.get(key);
		const data = template === undefined ? undefined : interactives.templatePaths.get(template);
		if (template === undefined || data === undefined) {
			sources.report(INTERACTIVE_TABLE, `no template for ${key}`);
			modelless.set(key, 'no template');
			continue;
		}
		let bytes: Uint8Array | undefined;
		let upgrade = upgrades.get(data);
		if (upgrade === undefined) {
			let decoded: MemoryPackValue | undefined;
			try {
				// oxlint-disable-next-line no-await-in-loop -- small templates, read once per map
				bytes = await sources.read(data);
				decoded = sources.memoryPack.decode(bytes, TEMPLATE_ROOT);
				upgrade = hasComponent(decoded, MODEL_UPGRADE_COMPONENTS) ? facilityModels(decoded, data) : null;
			} catch (error) {
				if (!(error instanceof FormatError)) {
					throw error;
				}
				// drawn with its base model only, as read below
				sources.report(data, `model upgrades: ${error.message}`);
				upgrade = null;
				if (decoded === undefined) {
					traits.set(data, { failure: error.message });
				}
			}
			if (upgrade === null && decoded !== undefined) {
				traits.set(data, readTemplateTraits(decoded, data));
			}
			upgrades.set(data, upgrade);
		}
		if (upgrade !== null) {
			authored.set(key, {
				name: FACILITY_NAMES.get(key) ?? key,
				forms: upgrade.levels.map((modelId) => sources.models.formOf(modelId, upgrade.scale)),
				model: null,
				data,
			});
			continue;
		}
		let resolved = templates.get(template);
		if (resolved === undefined) {
			try {
				// oxlint-disable-next-line no-await-in-loop -- small templates, read once per map
				const file = bytes ?? (await sources.read(data));
				resolved = {
					base: readInteractiveBaseModel(file, string),
					variants: readInteractiveVariantModels(file, string, variantsOf.get(template) ?? new Set()),
					failure: null,
				};
			} catch (error) {
				if (!(error instanceof FormatError)) {
					throw error;
				}
				sources.report(data, error.message);
				resolved = { base: null, variants: new Map(), failure: error.message };
			}
			templates.set(template, resolved);
		}
		if (resolved.failure !== null) {
			// the template may have had a model, so it gets a stand-in rather than being taken for a trigger
			modelless.set(key, resolved.failure);
			continue;
		}
		const { base } = resolved;
		const modelId = resolved.variants.has(key) ? resolved.variants.get(key) : base?.id;
		if (modelId === undefined || modelId === null) {
			// triggers and logic-only interactives have no model, and variants that empty it (bridges whose
			// DynamicStreaming row is the model they drive) draw nothing of their own
			continue;
		}
		if (!sources.models.has(modelId)) {
			sources.report(data, `model ${modelId} of ${key} is not in the model table`);
			modelless.set(key, `model ${modelId} is not in the model table`);
			continue;
		}
		authored.set(key, {
			name: null,
			forms: [sources.models.formOf(modelId, base?.scale ?? 1)],
			model: modelId,
			data,
		});
	}
	return { authored, modelless, traits };
};
