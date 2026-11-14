import { multiplyMatrices, trsMatrix, unityEulerQuaternion } from '@endfield-noclip/formats/unity/transform';
import type { ControlDriver } from '@endfield-noclip/package-format/states';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import { mapDefined } from '@mary-ext/array-fns';

import type { Context } from '../../context.ts';
import { cabinDoors, type CabinRoom, loadCabins } from '../../game/dynamic/cabins.ts';
import {
	type DecorationAnimatorStart,
	decorationAnimatorStarts,
} from '../../game/dynamic/decoration-animators.ts';
import type { DynamicStructures, StructureModel } from '../../game/dynamic/dynamic-structures.ts';
import {
	fireSeedActionTarget,
	fireSeedControl,
	loadFireSeedRadii,
	scriptFireSeedLevels,
} from '../../game/fire-seed.ts';
import {
	type InteractiveStandIn,
	loadInteractiveFacilities,
} from '../../game/interactives/interactive-facilities.ts';
import {
	activationCondition,
	entityVisibilityTargets,
	loadLevelScripts,
	loadScriptDrivers,
} from '../../game/script-drivers.ts';
import { derivedSource, type DraftControl, scriptControlTarget } from '../../game/state/scene-control.ts';
import {
	scriptWaterLevels,
	type ScriptWaterLevel,
	waterActionTarget,
} from '../../game/water/water-volume-scripts.ts';

import type { PackContent } from './pack-content.ts';

// what level scripts, interactive facilities and Dijiang's cabins add to the scene: their controls, wired to
// what drives them, the prefabs they place, and stand-ins for the facilities whose model isn't found
// (docs/extraction/scene-controls.md)

/** the scene's interactives, as the rest of the pack needs them */
export interface SceneInteractives {
	/** the prefabs facilities place */
	facilityModels: StructureModel[];
	/** the prefabs Dijiang's built cabins place */
	cabinModels: StructureModel[];
	/** facilities placed without a model the reader found, which stand-in cubes mark */
	standIns: InteractiveStandIn[];
	/** by script-controlled group id, the Animator values its level script sets as it starts */
	decorationAnimators: Map<string, DecorationAnimatorStart>;
	/** Dijiang's cabin slots, with the control that builds each */
	cabinRooms: CabinRoom[];
	/** the constant water fills the scene's level scripts set, and how many they compute */
	scriptWater: { levels: ScriptWaterLevel[]; computed: number };
	/** by {@link waterActionTarget}, what runs each script action setting a water fill */
	waterDrivers: ReadonlyMap<string, ControlDriver[]>;
	/** every placed interactive's template and position, by logic id */
	placements: ReadonlyMap<string, { template: string; position: Vec3 }>;
	/**
	 * the player's fire seed, whose control is registered: its control's id and the reveal radii per level;
	 * `null` when no level script of the scene sets it
	 */
	fireSeed: { control: string; radii: [inner: number, outer: number][] } | null;
	/** interactive LevelData files skipped as a whole, and templates or models that couldn't be resolved */
	unsupported: { path: string; reason: string }[];
}

/**
 * loads the scene's level scripts, facilities and cabins, registers their controls and places the facility
 * stand-ins
 *
 * @param context install readers
 * @param content the pack's content, after the dynamic structures' controls; controls, rows and counts are
 *   added
 * @param dynamic the scene's dynamic structures
 * @returns what the rest of the pack needs of them
 */
export const collectInteractives = async (
	context: Context,
	content: PackContent,
	dynamic: Pick<DynamicStructures, 'controls' | 'erosionCores' | 'slots'>,
): Promise<SceneInteractives> => {
	const { scene, controls } = content;
	/** script-controlled entities' controls by global id */
	const scripted = new Map(
		mapDefined(dynamic.controls, (control): [string, DraftControl] | undefined =>
			control.kind === 'script' ? [scriptControlTarget(control), control] : undefined,
		),
	);
	const levelScripts = await loadLevelScripts(context, scene.id, new Set(scripted.keys()));
	const scriptWater = scriptWaterLevels(levelScripts);
	content.count('waterScriptActionsComputed', scriptWater.computed);
	const fireSeedLevels = scriptFireSeedLevels(levelScripts);
	content.count('fireSeedScriptActions', fireSeedLevels.length);
	const decorationAnimators = decorationAnimatorStarts(levelScripts);
	content.count('decorationAnimatorGroups', decorationAnimators.starts.size);
	content.count('decorationAnimatorGroupsUntraced', decorationAnimators.untraced);

	const facilities = await loadInteractiveFacilities(context, {
		scene: scene.id,
		level: scene.level,
		partition: scene.partition,
		scripted: entityVisibilityTargets(levelScripts.scripts, levelScripts.ownLevels),
		erosionCores: dynamic.erosionCores,
	});
	content.count('interactiveFacilities', facilities.progressions.length);
	for (const [id, control] of facilities.scriptControls) {
		if (!scripted.has(id)) {
			scripted.set(id, control);
			controls.add(control);
		}
	}
	content.count('scriptInteractives', facilities.scriptControls.size);

	/** by {@link waterActionTarget}, the drivers of the script action setting a water fill */
	const waterDrivers = new Map<string, ControlDriver[]>();
	/** by {@link fireSeedActionTarget}, the drivers of the script action setting the fire seed's level */
	const fireSeedDrivers = new Map<string, ControlDriver[]>();
	{
		const waterActions = scriptWater.levels.map((level) => ({
			script: level.script,
			node: level.node,
			target: waterActionTarget(level),
		}));
		const waterTargets = new Set(waterActions.map(({ target }) => target));
		const fireSeedActions = fireSeedLevels.map((level) => ({
			script: level.script,
			node: level.node,
			target: fireSeedActionTarget(level),
		}));
		const fireSeedTargets = new Set(fireSeedActions.map(({ target }) => target));
		const found = await loadScriptDrivers(context, levelScripts, new Set(scripted.keys()), [
			...waterActions,
			...fireSeedActions,
		]);
		for (const [id, drivers] of found.drivers) {
			const control = scripted.get(id);
			if (control !== undefined) {
				control.drivers = drivers;
			} else if (waterTargets.has(id)) {
				waterDrivers.set(id, drivers);
			} else if (fireSeedTargets.has(id)) {
				fireSeedDrivers.set(id, drivers);
			}
		}
		// a group its scripts set by quest checks whenever they run follows those quests; its default is then the
		// one a finished story gives (see ControlRegistry.finish)
		content.count('scriptGroupsDerived', 0);
		for (const [id, rule] of found.rules) {
			const control = scripted.get(id);
			const condition = control && activationCondition(rule, control.default === 1);
			if (!control || !condition) {
				continue;
			}
			control.assumption = 'set by its level scripts’ quest checks when they run';
			control.source = derivedSource(
				controls.condition({ alternatives: scene.game.requirements(condition) }),
				scene.game.describe(condition),
			);
			content.count('scriptGroupsDerived');
		}
		// a group one script sets only as the player crosses its trigger volumes follows the camera's path through
		// them; its stored flag holds until the camera first crosses one
		content.count('scriptGroupsByVolume', 0);
		for (const [id, rule] of found.volumes) {
			const control = scripted.get(id);
			if (control === undefined) {
				continue;
			}
			control.assumption = `follows the camera through level script ${rule.script}’s trigger volumes, as the game follows the player`;
			control.source = { kind: 'camera', test: { kind: 'triggers', triggers: rule.triggers } };
			content.count('scriptGroupsByVolume');
		}
		content.count('levelScripts', found.counts.scripts);
		content.count('levelScriptsUndecoded', found.counts.undecoded);
		content.count('scriptGroupsWithDrivers', found.counts.targeted);
		content.count('scriptVisibilityUntraced', found.untraced);
		// event types the driver mapping doesn't classify, which drivers name as `unknown`
		content.count('scriptEventTypesUnmapped', found.unmapped.size);
		if (found.unmapped.size > 0) {
			content.log(
				`script events without a driver mapping: ${[...found.unmapped]
					.map(([type, paths]) => `${type} ×${paths}`)
					.join(', ')}`,
			);
		}
	}

	for (const standIn of facilities.standIns) {
		// a metre cube on the interactive's pivot, since its model's size isn't known
		content.addStandInCube(
			{
				matrix: onPivot(trsMatrix(standIn.position, unityEulerQuaternion(standIn.rotation), standIn.scale)),
				tag: standIn.levelTag,
				visibility: standIn.visibility,
				loadReach: null,
			},
			{ path: standIn.source, name: standIn.template, reason: standIn.reason },
		);
	}

	const cabins = await loadCabins(context, dynamic.slots, scene.partition);
	content.count('cabinSlots', cabins.rooms.length);
	{
		// a Dijiang cabin's door opens once the cabin is built
		const linked = cabinDoors(
			dynamic.slots,
			facilities.doors.map(({ control, position }) => ({ id: control.id, position })),
		);
		for (const { control } of facilities.doors) {
			const cabin = linked.get(control.id);
			if (cabin !== undefined) {
				control.assumption = 'follows its Dijiang cabin slot';
				control.source = derivedSource(
					controls.condition({ alternatives: [[{ control: cabin, mask: 2 }]] }),
					['open while ', { control: cabin, text: 'its cabin slot' }, ' is built'],
				);
			}
		}
		content.count('doors', facilities.doors.length);
		content.count('cabinDoors', linked.size);
	}
	controls.add(
		...facilities.progressions,
		...facilities.created,
		...facilities.activities,
		...cabins.controls,
		...facilities.doors.map(({ control }) => control),
		...facilities.bridges,
		...facilities.proximityControls,
	);
	content.count('bridges', facilities.bridges.length);
	content.count('unsupportedInteractiveFiles', facilities.unsupported.length);

	let fireSeed: SceneInteractives['fireSeed'] = null;
	if (fireSeedLevels.length > 0) {
		const radii = await loadFireSeedRadii(context);
		const control = fireSeedControl(radii, fireSeedLevels, fireSeedDrivers);
		controls.add(control);
		// it reveals effects rather than gating content, in the levels whose scripts set it
		const scriptLevels = new Set(
			mapDefined(fireSeedLevels, ({ script }) => levelScripts.scripts.find(({ id }) => id === script)?.level),
		);
		controls.keep(
			control.id,
			mapDefined(scene.partition?.levels ?? [], ({ id, tag }) => (scriptLevels.has(id) ? tag : undefined)),
		);
		fireSeed = { control: control.id, radii };
	}
	return {
		facilityModels: facilities.models,
		cabinModels: cabins.models,
		standIns: facilities.standIns,
		decorationAnimators: decorationAnimators.starts,
		cabinRooms: cabins.rooms,
		scriptWater,
		waterDrivers,
		placements: facilities.placements,
		fireSeed,
		unsupported: facilities.unsupported,
	};
};

/**
 * @param matrix a placement's transform
 * @returns a metre cube's transform standing on the placement's pivot, scaled with it
 */
export const onPivot = (matrix: Float32Array): Float32Array =>
	multiplyMatrices(matrix, trsMatrix([0, 0.5, 0], [0, 0, 0, 1], [1, 1, 1]));
