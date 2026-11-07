import type { LevelPartition } from '@endfield-noclip/formats/endfield/level-partition';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import type { StructureModel } from '../dynamic/dynamic-structures.ts';
import type { Alternatives } from '../state/game-state.ts';
import type { DraftControl, Visibility } from '../state/scene-control.ts';

import { AnimatorStarts } from './animator-starts.ts';
import { TelescopicBridges } from './bridges.ts';
import { CraneTowers } from './cranes.ts';
import { DoodadGroups } from './doodad-groups.ts';
import { type InteractiveDoor, InteractiveDoors } from './doors.ts';
import { FacilityForms } from './facility-forms.ts';
import {
	type FacilityContext,
	FacilitySources,
	PrefabHashes,
	type UnsupportedFile,
} from './facility-sources.ts';
import {
	type InteractiveKind,
	InteractiveRow,
	rowGate,
	RowSwitches,
	type TemplateReader,
} from './interactive-row.ts';
import { JumpPads } from './jump-pads.ts';
import { MovingPlatforms } from './moving-platforms.ts';
import { collectPlacements, LevelDataExtras } from './placed-interactives.ts';
import { RegionWalls } from './region-walls.ts';
import { RestLooks } from './rest-looks.ts';
import { RestingEffects } from './resting-effects.ts';
import { loadInteractiveTable, resolveTemplateModels } from './template-models.ts';
import { TemplateTraitsReader } from './template-traits.ts';

export type { InteractiveDoor } from './doors.ts';

/** a placed interactive with a model the reader couldn't find, to draw a stand-in for */
export interface InteractiveStandIn {
	/** `<LevelData path>#<row id>` */
	source: string;
	template: string;
	reason: string;
	levelTag: number;
	position: [number, number, number];
	/** Unity Euler angles, degrees */
	rotation: [number, number, number];
	scale: [number, number, number];
	/** when it shows: always, or with its level's `created` control for a row the game creates later */
	visibility: Visibility;
}

/**
 * resolves the models of interactives placed by referenced LevelData: the visual forms of facility templates,
 * each under a `facility:<id>` control, and every other interactive's model (its template variant's, else the
 * template's; none for a variant that overrides it with an empty model), always shown. a model that is a
 * doodad-group shell also places its form models, one per group level, under a per-level `doodadGroups:<level
 * id>` control. a model with door poses is placed closed and open, under a `door:<id>` control, closed by
 * default. a telescopic bridge is placed retracted and extended, under a `bridge:<id>` control, retracted by
 * default. a model without view states whose template sets its own Animator's bools on load is posed in the
 * states they settle; one bool from a saved property puts it under an `activation:<id>` control, set by
 * default. rows the game creates later (`createState` ≠ 0) are placed the same way and also require their
 * level's `created:<level id>` control, off by default. a limited-time photo event's spot also requires the
 * scene's `activity:snapshot` control, off by default. an auto-moving platform that starts with its level
 * rides its spline
 *
 * @param context install readers and the bundle resolver
 * @param options.scene owning map
 * @param options.level restricts decoding to one level, or null for the map
 * @param options.partition numeric level tags
 * @param options.scripted logic ids of the interactives level scripts show and hide
 * @param options.erosionCores by logic id, the conditions a blight core's erosion root loads under
 * @returns placements, controls, explicit unsupported-file diagnostics and the placements of interactives
 *   whose model wasn't found (a template that's missing or can't be read, or a model id the model table
 *   lacks); no partial file is used
 * @throws {FormatError} for broken authored references or malformed supported records
 */
export const loadInteractiveFacilities = async (
	context: FacilityContext,
	{
		scene,
		level,
		partition,
		scripted,
		erosionCores,
	}: {
		scene: string;
		level: string | null;
		partition: LevelPartition | undefined;
		scripted: ReadonlySet<string>;
		erosionCores: ReadonlyMap<string, Alternatives>;
	},
): Promise<{
	models: StructureModel[];
	progressions: DraftControl[];
	/** by logic id, the controls of the rows level scripts show and hide, shown as placed */
	scriptControls: Map<string, DraftControl>;
	/** per level with rows the game creates later (`createState` ≠ 0), the control that shows them, off */
	created: DraftControl[];
	/** the control that shows limited-time event placements, off; empty when the scene has none */
	activities: DraftControl[];
	/** controls of interactives whose look follows the player's presence */
	proximityControls: DraftControl[];
	doors: InteractiveDoor[];
	bridges: DraftControl[];
	unsupported: UnsupportedFile[];
	standIns: InteractiveStandIn[];
	/** every placed row's template and position, by logic id */
	placements: Map<string, { template: string; position: Vec3 }>;
}> => {
	// the order below is the order models, controls and diagnostics are emitted in, which downstream ids
	// follow: keep it when adding a kind
	const sources = await FacilitySources.open(context);
	const interactives = await loadInteractiveTable(sources);
	// placements first, so only the templates they use are read
	const { placed, createdControls, levelDataPaths } = await collectPlacements(sources, {
		scene,
		level,
		partition,
	});
	const rows = new Map(placed.map(({ row }) => [row.id, row]));
	const templates = await resolveTemplateModels(sources, interactives, placed);
	const { authored, modelless } = templates;
	const prefabs = await PrefabHashes.open(context);
	prefabs.find(authored.values().flatMap((template) => template.forms.map((form) => form.prefab)));
	const doodads = new DoodadGroups(sources, prefabs);
	await doodads.read(authored);

	const models: StructureModel[] = [];
	const progressions: DraftControl[] = [];
	const effects = new RestingEffects(sources, prefabs);
	const extras = new LevelDataExtras(sources, levelDataPaths);
	const facilities = new FacilityForms(sources, progressions);
	const platforms = new MovingPlatforms(sources, extras);
	const jumpPads = new JumpPads(effects);
	const bridges = new TelescopicBridges(sources, prefabs);
	const doors = new InteractiveDoors(sources);
	const restLooks = new RestLooks(sources, { progressions, doodads, rows });
	const animatorStarts = new AnimatorStarts(sources, { prefabs, progressions, doodads });
	const regionWalls = new RegionWalls(sources);
	const cranes = new CraneTowers(sources, prefabs);
	// a row is drawn by the first of these that claims it, else as its plain model or facility forms
	const kinds: InteractiveKind[] = [bridges, doors, restLooks, animatorStarts, regionWalls, cranes];
	const readers: TemplateReader[] = [platforms, jumpPads, ...kinds];
	{
		const traits = new TemplateTraitsReader(sources, templates.traits);
		for (const [key, template] of authored) {
			if (template.model === null) {
				// oxlint-disable-next-line no-await-in-loop -- one view state file and a clip per form
				await facilities.prepare(template);
				continue;
			}
			const single = { ...template, model: template.model };
			const traitsOf = traits.of(template.data);
			for (const reader of readers) {
				// oxlint-disable-next-line no-await-in-loop -- a few view state files and one-frame clips per model
				await reader.prepare(key, single, traitsOf);
			}
		}
	}
	{
		const nexus = await regionWalls.readNexus(placed);
		if (nexus !== null) {
			progressions.push(nexus);
		}
	}
	await cranes.hang(placed, authored, rows);

	const switches = new RowSwitches(scripted);
	const standIns: InteractiveStandIn[] = [];
	for (const entry of placed) {
		const { path, levelId, levelTag, row } = entry;
		const gate = rowGate(switches.of(entry), erosionCores.get(row.id.toString()));
		// oxlint-disable-next-line no-await-in-loop -- splines are read once per level
		const ride = await platforms.rideOf(row, levelId);
		// oxlint-disable-next-line no-await-in-loop -- locks are read once per level
		const locked = await extras.isLocked(levelId, row.id);
		const template = authored.get(row.template);
		if (template === undefined) {
			const reason = modelless.get(row.template);
			if (reason !== undefined) {
				standIns.push({
					source: `${path}#${row.id}`,
					template: row.template,
					reason,
					levelTag,
					position: row.position,
					rotation: row.rotation,
					scale: row.scale,
					visibility: gate({ alternatives: [[]] }),
				});
			}
			continue;
		}
		const placer = new InteractiveRow({
			sources,
			prefabs,
			models,
			effects,
			placed: entry,
			template,
			gate,
			ride,
			hang: cranes.hangOf(row.id),
			locked,
		});
		jumpPads.decorate(placer);
		let claimed = false;
		for (const kind of kinds) {
			// oxlint-disable-next-line no-await-in-loop -- each kind reads once per prefab and parameter set
			if (await kind.place(placer)) {
				claimed = true;
				break;
			}
		}
		if (claimed) {
			continue;
		}
		if (template.name === null) {
			placer.place(template.forms[0], { alternatives: [[]] }, null);
			doodads.place(placer);
		} else {
			facilities.place(placer);
		}
	}
	await effects.place(models);
	progressions.push(...doodads.progressions());

	return {
		models,
		progressions,
		scriptControls: switches.scriptControls,
		created: [...createdControls.values()],
		activities: switches.activities(),
		proximityControls: restLooks.proximityControls,
		doors: doors.doors,
		bridges: bridges.controls,
		unsupported: sources.unsupported,
		standIns,
		placements: new Map(
			placed.map(({ row }) => [row.id.toString(), { template: row.template, position: row.position }]),
		),
	};
};
