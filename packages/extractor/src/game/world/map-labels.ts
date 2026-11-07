import { cellOf, levelOfCell, type LevelPartition } from '@endfield-noclip/formats/endfield/level-partition';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import { stripMarkup } from '../state/story.ts';

import type { WorldIndex } from './world-index.ts';

// where things are, in the game's own words: the level a point lies in and the nearest place name the
// in-game map prints there (docs/extraction/scene-controls.md#places)

/** a place name the in-game map prints, at a world position */
export interface MapLabel {
	text: string;
	x: number;
	z: number;
}

/** how far from a place name a point still counts as near it, in metres */
const NEAR = 150;

/** `staticElements` type of a place name */
const PLACE_NAME = 2;

/**
 * @param world world index
 * @param levelId a level id, e.g. `map01_lv001`
 * @returns the place names its in-game map prints (`UILevelMapLoadConfig` static elements of type 2 with an
 *   English text); empty without a map, and for a map with its x and z swapped (`needInverseXZ`), whose
 *   positions aren't world positions
 */
export const loadMapLabels = async (world: WorldIndex, levelId: string): Promise<MapLabel[]> => {
	const config = await world.json(`Data/Json/UILevelMapLoadConfig/${levelId}.json`);
	if (!isRecord(config) || !isRecord(config.staticElements)) {
		return [];
	}
	if (isRecord(config.basic) && config.basic.needInverseXZ === true) {
		return [];
	}
	const text = await world.text();
	const labels: MapLabel[] = [];
	for (const element of Object.values(config.staticElements)) {
		if (!isRecord(element) || element.type !== PLACE_NAME || typeof element.textId !== 'string') {
			continue;
		}
		const { position } = element;
		const name = text(element.textId);
		if (!isRecord(position) || typeof position.x !== 'number' || typeof position.z !== 'number' || !name) {
			continue;
		}
		labels.push({ text: stripMarkup(name), x: position.x, z: position.z });
	}
	return labels;
};

/** names where a point is: its level's display name and the nearest place name of that level */
export class Locator {
	readonly #partition: LevelPartition | undefined;
	readonly #names: ReadonlyMap<string, string>;
	readonly #labels: ReadonlyMap<string, readonly MapLabel[]>;

	/**
	 * @param partition the scene's levels, or `undefined` for a scene without levels
	 * @param names display names by level id
	 * @param labels place names by level id
	 */
	constructor(
		partition: LevelPartition | undefined,
		names: ReadonlyMap<string, string>,
		labels: ReadonlyMap<string, readonly MapLabel[]>,
	) {
		this.#partition = partition;
		this.#names = names;
		this.#labels = labels;
	}

	/**
	 * @param world world index
	 * @param partition the scene's levels
	 * @returns a locator over those levels' names and place names
	 */
	static async load(world: WorldIndex, partition: LevelPartition | undefined): Promise<Locator> {
		const levels = partition?.levels ?? [];
		const labels = new Map(
			await Promise.all(levels.map(async ({ id }) => [id, await loadMapLabels(world, id)] as const)),
		);
		return new Locator(partition, await world.names(), labels);
	}

	/**
	 * @param position a world position (Unity coordinates)
	 * @returns e.g. "Valley Pass · Bridge Approach": the display name of the level owning the point's cell and
	 *   the nearest of its place names within {@link NEAR} metres, the level alone without one; `null` outside
	 *   every level
	 */
	locate(position: Readonly<Vec3>): string | null {
		const [x, , z] = position;
		const cell = cellOf(x, z);
		const level = this.#partition && levelOfCell(this.#partition, cell.x, cell.z);
		if (level === undefined) {
			return null;
		}
		const name = this.#names.get(level.id) ?? level.id;
		let nearest: MapLabel | null = null;
		let best = NEAR;
		for (const label of this.#labels.get(level.id) ?? []) {
			const distance = Math.hypot(label.x - x, label.z - z);
			if (distance <= best) {
				best = distance;
				nearest = label;
			}
		}
		return nearest === null || nearest.text === name ? name : `${name} · ${nearest.text}`;
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
