import { multiplyMatrices, trsMatrix, unityEulerQuaternion } from '@endfield-noclip/formats/unity/transform';
import type { ControlDriver } from '@endfield-noclip/package-format/states';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import { mapDefined } from '@mary-ext/array-fns';

import type { Context } from '../../context.ts';
import { cabinDoors, type CabinRoom, loadCabins } from '../../game/dynamic/cabins.ts';
import type { DynamicStructures, StructureModel } from '../../game/dynamic/dynamic-structures.ts';
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
import {
	derivedSource,
	type DraftControl,
	sceneControl,
	scriptControlTarget,
	switchValues,
} from '../../game/state/scene-control.ts';
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
	/** Dijiang's cabin slots, with the control that builds each */
	cabinRooms: CabinRoom[];
	/** the constant water fills the scene's level scripts set, and how many they compute */
	scriptWater: { levels: ScriptWaterLevel[]; computed: number };
	/** by {@link waterActionTarget}, what runs each script action setting a water fill */
	waterDrivers: ReadonlyMap<string, ControlDriver[]>;
	/** every placed interactive's template and position, by logic id */
	placements: ReadonlyMap<string, { template: string; position: Vec3 }>;
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
	/** proximity controls of the trigger volumes script groups follow */
	const volumeProximities: DraftControl[] = [];
	{
		const waterActions = scriptWater.levels.map((level) => ({
			script: level.script,
			node: level.node,
			target: waterActionTarget(level),
		}));
		const waterTargets = new Set(waterActions.map(({ target }) => target));
		const found = await loadScriptDrivers(context, levelScripts, new Set(scripted.keys()), waterActions);
		for (const [id, drivers] of found.drivers) {
			const control = scripted.get(id);
			if (control !== undefined) {
				control.drivers = drivers;
			} else if (waterTargets.has(id)) {
				waterDrivers.set(id, drivers);
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
		// a group one script sets as the player enters and leaves a volume follows the camera through a proximity
		// control per volume
		content.count('scriptGroupsByVolume', 0);
		for (const [id, rule] of found.volumes) {
			const control = scripted.get(id);
			if (control === undefined) {
				continue;
			}
			const nearness = `proximity:volume:${rule.volume}`;
			if (!volumeProximities.some((known) => known.id === nearness)) {
				volumeProximities.push(
					sceneControl({
						kind: 'proximity',
						id: nearness,
						name: `Script ${rule.volume.replace(':', ' volume ')}`,
						values: switchValues('outside', 'inside'),
						default: 0,
						assumption: 'follows the camera, as the game follows the player',
						source: {
							kind: 'camera',
							test: {
								kind: 'near',
								reaches: rule.spheres.map(({ position, radius }) => ({ position: [...position], radius })),
							},
						},
					}),
				);
			}
			control.assumption = 'follows the camera, as its level script follows the player';
			control.source = derivedSource(
				controls.condition({ alternatives: [[{ control: nearness, mask: rule.inside ? 2 : 1 }]] }),
				[
					rule.inside ? 'shown while ' : 'hidden while ',
					{ control: nearness, text: 'the player is inside its level script’s trigger volume' },
				],
			);
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
				loadGrid: null,
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
		...volumeProximities,
	);
	content.count('bridges', facilities.bridges.length);
	content.count('unsupportedInteractiveFiles', facilities.unsupported.length);
	return {
		facilityModels: facilities.models,
		cabinModels: cabins.models,
		standIns: facilities.standIns,
		cabinRooms: cabins.rooms,
		scriptWater,
		waterDrivers,
		placements: facilities.placements,
		unsupported: facilities.unsupported,
	};
};

/**
 * @param matrix a placement's transform
 * @returns a metre cube's transform standing on the placement's pivot, scaled with it
 */
export const onPivot = (matrix: Float32Array): Float32Array =>
	multiplyMatrices(matrix, trsMatrix([0, 0.5, 0], [0, 0, 0, 1], [1, 1, 1]));
