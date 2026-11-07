import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import {
	readDynamicResources,
	type DynamicModel,
	type DynamicResourceEntity,
} from '@endfield-noclip/formats/endfield/dynamic-resources';
import { DynamicData, type ExtraSceneSlot } from '@endfield-noclip/formats/endfield/dynamic-scene';
import { cellOf, levelOfCell, type LevelPartition } from '@endfield-noclip/formats/endfield/level-partition';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import { isObject } from '@endfield-noclip/formats/unity/values';

import { unique } from '@mary-ext/array-fns';

import type { Context } from '../../context.ts';
import { VfsGroup } from '../../hg/vfs.ts';
import type { AssetResolver } from '../assets/assets.ts';
import { type DraftControl, sceneControl, switchValues } from '../state/scene-control.ts';

import type { StructureModel } from './dynamic-structures.ts';
import { readGrowBoxShutter, readPlantingFieldLevels } from './grow-boxes.ts';

// Dijiang's cabins: rooms the player builds into fixed slots of the spaceship
// (docs/game-data/scene-states.md#dijiang-cabins). a built cabin's rows are placed at the slot origin, turned
// by its direction in quarter turns of yaw; with that convention each cabin's entrance meets the slot's door.
// a slot gets the largest cabin type whose row pivots fit its box, else the smallest: our rule, since no client
// data assigning types to slots was found.

const CABIN_DATA = 'Data/Json/SpaceshipCabinData.json';

/**
 * the game's room type ids (`SpaceshipRoomTypeTable`) of the cabin types, which name their rooms' bakes. the
 * table names no cabin types, so these are matched by hand by its rows' icon names
 * (`icon_sapceship_room_icon_manufacturing_station`, `…_grow_cabin`)
 */
const ROOM_TYPES = new Map([
	['ManufacturingStation', 1],
	['GrowCabin', 2],
]);

/** a cabin slot as its built cabin needs it lit */
export interface CabinRoom {
	/** the slot's `cabin:<id>` control */
	control: string;
	levelTag: number;
	/** the slot origin */
	position: [number, number, number];
	/** the room type id of the slot's cabin type, or `null` if the game has none for it */
	roomType: number | null;
}

/** a cabin type and its placed rows in cabin space */
interface Cabin {
	type: string;
	models: DynamicModel[];
	/** the rows' pivot extents in x and z, for choosing a slot's type */
	min: [number, number];
	max: [number, number];
	/** planting boxes by row index: the shutter they hide once unlocked, and their field (from 1) */
	boxes: Map<number, { shutter: string; field: number }>;
}

/**
 * @returns the cabin's planting boxes by row index: rows whose prefab has a shutter, numbered as the cabin's
 *   entity lists them in its resource groups
 * @throws {FormatError} if a box row isn't in any resource group
 */
const findBoxes = async (
	resolver: AssetResolver,
	type: string,
	models: readonly DynamicModel[],
	rowOf: ReadonlyMap<string, number>,
	entities: readonly DynamicResourceEntity[],
): Promise<Map<number, { shutter: string; field: number }>> => {
	const shutters = new Map<bigint, Promise<string | null>>();
	const shutterOf = (hash: bigint) =>
		shutters.getOrInsertComputed(hash, async () => {
			const paths = unique(
				resolver.manifest.findAssets(hash).map((asset) => resolver.manifest.assetPath(asset)),
			);
			if (paths.length !== 1) {
				return null;
			}
			return readGrowBoxShutter(
				resolver,
				await resolver.findUnique({ hash, path: paths[0] }, UnityClass.GameObject),
			);
		});
	const shutterRows = new Map<number, string>();
	await Promise.all(
		models.map(async (model, row) => {
			const shutter = await shutterOf(model.pathHash);
			if (shutter !== null) {
				shutterRows.set(row, shutter);
			}
		}),
	);
	const boxes = new Map<number, { shutter: string; field: number }>();
	for (const { entity } of entities) {
		for (const { resources } of entity.resourceGroups) {
			if (resources.type !== DynamicData.Model) {
				continue;
			}
			for (let i = resources.index; i < resources.index + resources.count; i++) {
				const row = rowOf.get(`${resources.grid}:${i}`);
				const shutter = row === undefined ? undefined : shutterRows.get(row);
				if (row !== undefined && shutter !== undefined && !boxes.has(row)) {
					boxes.set(row, { shutter, field: boxes.size + 1 });
				}
			}
		}
	}
	if (boxes.size !== shutterRows.size) {
		throw new FormatError(`${type} has planting boxes outside its entities' resource groups`);
	}
	return boxes;
};

/**
 * @param context install readers
 * @param slots the scene's cabin slots (see `DynamicStructures.slots`)
 * @param partition the scene's levels, for each slot's owner
 * @returns one control per slot, empty by default, the cabin rows each built slot shows, and each slot's
 * room
 * @throws {FormatError} if the cabin data is missing or names no scene for a cabin type
 */
export const loadCabins = async (
	context: Pick<Context, 'vfs' | 'resolver'>,
	slots: readonly { id: string; slot: ExtraSceneSlot }[],
	partition: LevelPartition | undefined,
): Promise<{ controls: DraftControl[]; models: StructureModel[]; rooms: CabinRoom[] }> => {
	if (slots.length === 0) {
		return { controls: [], models: [], rooms: [] };
	}
	const { vfs } = context;
	const read = async (group: string, name: string): Promise<Uint8Array> => {
		const file = await vfs.find(group, name);
		if (file === undefined) {
			throw new FormatError(`missing ${name}`);
		}
		return vfs.readVerified(file);
	};
	const data: unknown = JSON.parse(new TextDecoder().decode(await read(VfsGroup.JsonData, CABIN_DATA)));
	const infos = isObject(data) && isObject(data.cabinSpawnInfos) ? data.cabinSpawnInfos : {};
	const names = [...(await vfs.group(VfsGroup.DynamicStreaming)).files.keys()];
	const cabins: Cabin[] = [];
	for (const [type, info] of Object.entries(infos)) {
		const scene = isObject(info) ? info.dynamicSceneUniqueId : undefined;
		if (typeof scene !== 'string') {
			throw new FormatError(`${CABIN_DATA} names no scene for ${type}`);
		}
		const models: DynamicModel[] = [];
		/** row index of each model row, by `<grid>:<index>` */
		const rowOf = new Map<string, number>();
		const entities: DynamicResourceEntity[] = [];
		for (const name of names.filter((entry) =>
			entry.startsWith(`Data/DynamicStreaming/PC/Extra/${scene}/fb_main_`),
		)) {
			// oxlint-disable-next-line no-await-in-loop -- a few small files
			const resources = readDynamicResources(await read(VfsGroup.DynamicStreaming, name));
			for (const grid of resources.grids) {
				for (const [index, model] of grid.models.entries()) {
					rowOf.set(`${grid.id}:${index}`, models.length);
					models.push(model);
				}
				models.push(...grid.effects);
			}
			entities.push(...resources.entities);
		}
		if (models.length > 0) {
			const xs = models.map((model) => model.position[0]);
			const zs = models.map((model) => model.position[2]);
			cabins.push({
				type,
				models,
				min: [Math.min(...xs), Math.min(...zs)],
				max: [Math.max(...xs), Math.max(...zs)],
				// oxlint-disable-next-line no-await-in-loop -- one per cabin type
				boxes: await findBoxes(await context.resolver(), type, models, rowOf, entities),
			});
		}
	}
	const fieldLevels = cabins.some((cabin) => cabin.boxes.size > 0)
		? await readPlantingFieldLevels(vfs)
		: new Map<number, number>();
	// oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy
	const levels = [...new Set(fieldLevels.values())].sort((a, b) => a - b);
	const area = (cabin: Cabin) => (cabin.max[0] - cabin.min[0]) * (cabin.max[1] - cabin.min[1]);
	const bySize = cabins.toSorted((a, b) => area(b) - area(a));
	if (bySize.length === 0) {
		return { controls: [], models: [], rooms: [] };
	}

	const controls: DraftControl[] = [];
	const placed: StructureModel[] = [];
	const rooms: CabinRoom[] = [];
	for (const { id, slot } of slots) {
		const turns = slot.direction % 4;
		const cabin = bySize.find((candidate) => fits(candidate, slot, turns)) ?? bySize.at(-1)!;
		const control = `cabin:${id}`;
		const [x, , z] = slot.position;
		const cell = cellOf(x, z);
		const levelTag = (partition && levelOfCell(partition, cell.x, cell.z)?.tag) ?? 0;
		controls.push(
			sceneControl({
				kind: 'cabin',
				id: control,
				name: `Cabin slot: ${cabin.type}`,
				position: slot.position,
				values: switchValues('empty', 'built'),
				default: 0,
				assumption: 'empty, as before the player builds a cabin',
			}),
		);
		rooms.push({
			control,
			levelTag,
			position: [slot.position[0], slot.position[1], slot.position[2]],
			roomType: ROOM_TYPES.get(cabin.type) ?? null,
		});
		const levelControl = `cabinLevel:${id}`;
		if (cabin.boxes.size > 0) {
			controls.push(
				sceneControl({
					kind: 'cabinLevel',
					id: levelControl,
					name: `Cabin level: ${cabin.type}`,
					position: slot.position,
					values: levels.map((value) => ({ value, label: `Level ${value}` })),
					default: levels[0],
					assumption: 'level 1, before the player upgrades it',
				}),
			);
		}
		for (const [index, model] of cabin.models.entries()) {
			const row = {
				model: place(model, slot.position, turns),
				levelTag,
				source: `${cabin.type}#${index}@${id}`,
			};
			const box = cabin.boxes.get(index);
			if (box === undefined) {
				placed.push({ ...row, visibility: { alternatives: [[{ control, mask: 2 }]] }, pose: null });
				continue;
			}
			// a box shows its shutter below the level that unlocks its field, and the open tank from it on
			const unlock = fieldLevels.get(box.field) ?? Infinity;
			const mask = (open: boolean) =>
				levels.reduce((bits, level) => (level >= unlock === open ? bits | (1 << level) : bits), 0) >>> 0;
			for (const open of [false, true]) {
				if (mask(open) === 0) {
					continue;
				}
				placed.push({
					...row,
					visibility: {
						alternatives: [
							[
								{ control, mask: 2 },
								{ control: levelControl, mask: mask(open) },
							],
						],
					},
					pose: open
						? {
								key: `growBox:${box.shutter}:open`,
								clips: [],
								active: new Map([[box.shutter, false]]),
							}
						: null,
				});
			}
		}
	}
	return { controls, models: placed, rooms };
};

/**
 * the farthest a slot's door stands from the slot origin: the medium slot's is 10.2 m off, the small ones' 9
 * m
 */
const DOOR_REACH = 12;

/**
 * matches doors to the cabin slots they open into: each door to the nearest slot origin within
 * {@link DOOR_REACH} in plan. the slots don't name their doors, and one small slot has none
 *
 * @param slots the scene's cabin slots
 * @param doors door controls with their placements
 * @returns the `cabin:<id>` control of each door's slot, by door control id
 */
export const cabinDoors = (
	slots: readonly { id: string; slot: ExtraSceneSlot }[],
	doors: readonly { id: string; position: readonly number[] }[],
): Map<string, string> => {
	const linked = new Map<string, string>();
	for (const door of doors) {
		let best: { id: string; distance: number } | null = null;
		for (const { id, slot } of slots) {
			const distance = Math.hypot(slot.position[0] - door.position[0], slot.position[2] - door.position[2]);
			if (distance <= DOOR_REACH && (best === null || distance < best.distance)) {
				best = { id, distance };
			}
		}
		if (best !== null) {
			linked.set(door.id, `cabin:${best.id}`);
		}
	}
	return linked;
};

/** @returns `(x, z)` turned by a yaw of `turns` quarter turns, as Unity turns a vector by `Euler(0, θ, 0)` */
const turn = (x: number, z: number, turns: number): [number, number] => {
	const angle = (turns * Math.PI) / 2;
	const [c, s] = [Math.round(Math.cos(angle)), Math.round(Math.sin(angle))];
	return [x * c + z * s, -x * s + z * c];
};

/** @returns a cabin row placed in a slot: offset by the slot origin, turned about it */
const place = (model: DynamicModel, origin: readonly number[], turns: number): DynamicModel => {
	const [x, y, z] = model.position;
	const [tx, tz] = turn(x, z, turns);
	// Unity's Euler order is Y·X·Z, so a yaw in front adds to the row's own yaw
	return {
		...model,
		position: [origin[0] + tx, origin[1] + y, origin[2] + tz],
		rotation: [model.rotation[0], model.rotation[1] + turns * 90, model.rotation[2]],
	};
};

/** @returns whether every row pivot of a cabin lands in the slot's box (its stored corners may be swapped) */
const fits = (cabin: Cabin, slot: ExtraSceneSlot, turns: number): boolean => {
	const low = [0, 2].map((i) => Math.min(slot.min[i], slot.max[i]) - 0.5);
	const high = [0, 2].map((i) => Math.max(slot.min[i], slot.max[i]) + 0.5);
	return cabin.models.every(({ position: [x, , z] }) => {
		const [tx, tz] = turn(x, z, turns);
		const [wx, wz] = [slot.position[0] + tx, slot.position[2] + tz];
		return wx >= low[0] && wx <= high[0] && wz >= low[1] && wz <= high[1];
	});
};
