import type { Aabb } from '@endfield-noclip/formats/unity/values';

import type { Alternatives } from './state/game-state.ts';
import type { Requirement } from './state/scene-control.ts';

// what `world find` lists and how it describes it; the placements themselves come from the packer's own
// sources (`pack/survey.ts`)

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
