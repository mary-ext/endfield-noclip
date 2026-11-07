import type { ChunkEntity } from '@endfield-noclip/formats/endfield/init-chunk-data';
import type { Aabb } from '@endfield-noclip/formats/unity/values';

import type { Context } from '../context.ts';

import { loadCabins } from './cabins.ts';
import { loadDynamicStructures, type StructureModel } from './dynamic-structures.ts';
import { GameState, type Alternatives } from './game-state.ts';
import { loadInteractiveFacilities, type InteractiveStandIn } from './interactive-facilities.ts';
import { loadMapVariables } from './scene-conditions.ts';
import type { Requirement } from './scene-control.ts';
import { loadUpgradeLinks } from './settlement-upgrades.ts';
import { pivotOf, type IndexedEntity } from './world-index.ts';

// #region kinds

/**
 * where a placement comes from: `static` chunk entities, `dynamic` ECS entities in dynamic structures,
 * `model` and `effect` prefab rows of DynamicStreaming resources, `facility` interactives from LevelData,
 * `cabin` rows of built Dijiang cabins
 */
export type PlacementKind = 'static' | 'dynamic' | 'model' | 'effect' | 'facility' | 'cabin';

/** every {@link PlacementKind}, in listing order */
export const PLACEMENT_KINDS: readonly PlacementKind[] = [
	'static',
	'dynamic',
	'model',
	'effect',
	'facility',
	'cabin',
];

/**
 * @param text a comma-separated list of kinds
 * @returns the kinds, deduplicated
 * @throws {Error} on an unknown kind
 */
export const parsePlacementKinds = (text: string): Set<PlacementKind> => {
	const kinds = new Set<PlacementKind>();
	for (const part of text.split(',')) {
		const kind = PLACEMENT_KINDS.find((candidate) => candidate === part.trim());
		if (kind === undefined) {
			throw new Error(`unknown kind ${part}; expected ${PLACEMENT_KINDS.join(', ')}`);
		}
		kinds.add(kind);
	}
	return kinds;
};

// #endregion

// #region geometry

/**
 * @param point a world point
 * @param box a world box
 * @returns the distance from the point to the nearest point of the box, 0 inside it
 */
export const boxDistance = (point: readonly number[], box: Aabb): number => {
	let sum = 0;
	for (let i = 0; i < 3; i++) {
		const gap = Math.abs(point[i] - box.center[i]) - box.extents[i];
		if (gap > 0) {
			sum += gap * gap;
		}
	}
	return Math.sqrt(sum);
};

// #endregion

// #region visibility

/**
 * @param alternatives a visibility expression
 * @returns it as text: alternatives joined by `|`, requirements by `&`, each as `control=values` (the
 *   selected values that satisfy it); `always` for no requirement, `never` for no alternative
 */
export const describeAlternatives = (alternatives: Alternatives): string => {
	if (alternatives.length === 0) {
		return 'never';
	}
	const unique = [
		...new Set(alternatives.map((requirements) => requirements.map(describeRequirement).join(' & '))),
	];
	if (unique.includes('')) {
		return 'always';
	}
	return unique.join(' | ');
};

const describeRequirement = ({ control, mask }: Requirement): string => {
	const values: number[] = [];
	for (let bit = 0; bit < 32; bit++) {
		if ((mask >>> bit) & 1) {
			values.push(bit);
		}
	}
	return `${control}=${values.join('/')}`;
};

// #endregion

// #region loading

/** an ECS entity in a dynamic structure, with its visibility */
export interface EntityPlacement {
	kind: 'dynamic';
	entity: ChunkEntity;
	/** see `IndexedEntity.pivot` */
	pivot: IndexedEntity['pivot'];
	visibility: string;
}

/** a placed prefab, with its visibility */
export interface PrefabPlacement {
	kind: 'model' | 'effect' | 'facility' | 'cabin';
	model: StructureModel;
	visibility: string;
}

/** an interactive placed without a model the reader found; the package draws a stand-in cube for it */
export interface MissingFacility {
	kind: 'facility';
	standIn: InteractiveStandIn;
}

/** dynamic placements of a scene, and the sources that failed to load */
export interface DynamicPlacements {
	entities: EntityPlacement[];
	prefabs: PrefabPlacement[];
	missing: MissingFacility[];
	failures: { kind: PlacementKind; message: string }[];
}

/**
 * loads a scene's placements outside its static chunks, under the default game state. a source that throws is
 * reported in `failures` rather than failing the rest
 *
 * @param context install readers
 * @param scene streaming scene id
 * @param kinds the kinds to load; `static` is ignored here
 * @returns the placements of the requested kinds
 */
export const loadDynamicPlacements = async (
	context: Pick<Context, 'vfs' | 'world' | 'resolver' | 'memoryPack'>,
	scene: string,
	kinds: ReadonlySet<PlacementKind>,
): Promise<DynamicPlacements> => {
	const result: DynamicPlacements = { entities: [], prefabs: [], missing: [], failures: [] };
	const partition = await context.world.partition(scene);
	const fail = (kind: PlacementKind, error: unknown): void => {
		result.failures.push({ kind, message: error instanceof Error ? error.message : String(error) });
	};
	// facilities need them too: blight cores follow their erosion roots' and sludge patches' gates
	const needsStructures =
		kinds.has('dynamic') ||
		kinds.has('model') ||
		kinds.has('effect') ||
		kinds.has('cabin') ||
		kinds.has('facility');
	let structures: Awaited<ReturnType<typeof loadDynamicStructures>> | undefined;
	if (needsStructures) {
		try {
			const game = new GameState({
				links: await loadUpgradeLinks(context, scene),
				variables: await loadMapVariables(context.world, scene),
			});
			structures = await loadDynamicStructures(context, scene, partition, game);
		} catch (error) {
			for (const kind of ['dynamic', 'model', 'effect', 'cabin'] as const) {
				if (kinds.has(kind)) {
					fail(kind, error);
				}
			}
		}
	}
	if (structures !== undefined) {
		if (kinds.has('dynamic')) {
			for (const { entity, visibility } of structures.entities) {
				result.entities.push({
					kind: 'dynamic',
					entity,
					pivot: pivotOf(entity),
					visibility: describeAlternatives(visibility.alternatives),
				});
			}
		}
		for (const model of structures.models) {
			// effect rows are keyed `effect:<grid>/<index>`, model rows `<grid>/<index>`
			const kind = model.source.startsWith('effect:') ? 'effect' : 'model';
			if (kinds.has(kind)) {
				result.prefabs.push({ kind, model, visibility: describeAlternatives(model.visibility.alternatives) });
			}
		}
		if (kinds.has('cabin')) {
			try {
				const cabins = await loadCabins(context, structures.slots, partition);
				for (const model of cabins.models) {
					result.prefabs.push({
						kind: 'cabin',
						model,
						visibility: describeAlternatives(model.visibility.alternatives),
					});
				}
			} catch (error) {
				fail('cabin', error);
			}
		}
	}
	if (kinds.has('facility')) {
		try {
			// placements as authored: level scripts' show and hide actions aren't followed here
			const facilities = await loadInteractiveFacilities(
				context,
				scene,
				null,
				partition,
				new Set(),
				structures?.erosionCores ?? new Map(),
			);
			for (const model of facilities.models) {
				result.prefabs.push({
					kind: 'facility',
					model,
					visibility: describeAlternatives(model.visibility.alternatives),
				});
			}
			for (const standIn of facilities.standIns) {
				result.missing.push({ kind: 'facility', standIn });
			}
		} catch (error) {
			fail('facility', error);
		}
	}
	return result;
};

// #endregion
