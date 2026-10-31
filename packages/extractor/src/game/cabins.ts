import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import { readDynamicResources, type DynamicModel } from '@endfield-noclip/formats/endfield/dynamic-resources';
import type { ExtraSceneSlot } from '@endfield-noclip/formats/endfield/dynamic-scene';
import { cellOf, levelOfCell, type LevelPartition } from '@endfield-noclip/formats/endfield/level-partition';
import { isObject } from '@endfield-noclip/formats/unity/values';
import type { SceneControl } from '@endfield-noclip/package-format/states';

import type { Context } from '../context.ts';
import { VfsGroup } from '../hg/vfs.ts';

import type { StructureModel } from './dynamic-structures.ts';

// Dijiang's cabins: rooms the player builds into fixed slots of the spaceship. a slot is an `ExtraSceneSlot`
// entity with a box, an origin and a direction; a cabin is a separately stored scene,
// `Data/DynamicStreaming/PC/Extra/<scene>/fb_main_*` (model rows only), named per cabin type by
// `Data/Json/SpaceshipCabinData.json`. a built cabin's rows are placed at the slot origin, turned by its
// direction in quarter turns of yaw: with that convention each cabin's entrance (the start of its walkway,
// at local +x) meets the slot's door. each slot holds one cabin type; the large slot fits the larger cabin
// and the small ones the smaller, which matches the room tables (one medium slot for growth chambers, small
// ones for manufacturing cabins). the cabin level (1–3) changes no stored geometry, so it isn't offered.

const CABIN_DATA = 'Data/Json/SpaceshipCabinData.json';

/** a cabin type and its placed rows in cabin space */
interface Cabin {
	type: string;
	models: DynamicModel[];
	/** the rows' pivot extents in x and z, for choosing a slot's type */
	min: [number, number];
	max: [number, number];
}

/**
 * @param context install readers
 * @param slots the scene's cabin slots (see `DynamicStructures.slots`)
 * @param partition the scene's levels, for each slot's owner
 * @returns one control per slot, empty by default, and the cabin rows each built slot shows
 * @throws {FormatError} if the cabin data names no scene, or a slot is outside every cabin's reach
 */
export const loadCabins = async (
	context: Pick<Context, 'vfs'>,
	slots: readonly { id: string; slot: ExtraSceneSlot }[],
	partition: LevelPartition | undefined,
): Promise<{ controls: SceneControl[]; models: StructureModel[] }> => {
	if (slots.length === 0) {
		return { controls: [], models: [] };
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
		for (const name of names.filter((entry) =>
			entry.startsWith(`Data/DynamicStreaming/PC/Extra/${scene}/fb_main_`),
		)) {
			// oxlint-disable-next-line no-await-in-loop -- a few small files
			for (const grid of readDynamicResources(await read(VfsGroup.DynamicStreaming, name)).grids) {
				models.push(...grid.models, ...grid.effects);
			}
		}
		if (models.length > 0) {
			const xs = models.map((model) => model.position[0]);
			const zs = models.map((model) => model.position[2]);
			cabins.push({
				type,
				models,
				min: [Math.min(...xs), Math.min(...zs)],
				max: [Math.max(...xs), Math.max(...zs)],
			});
		}
	}
	const area = (cabin: Cabin) => (cabin.max[0] - cabin.min[0]) * (cabin.max[1] - cabin.min[1]);
	const bySize = cabins.toSorted((a, b) => area(b) - area(a));
	if (bySize.length === 0) {
		return { controls: [], models: [] };
	}

	const controls: SceneControl[] = [];
	const placed: StructureModel[] = [];
	for (const { id, slot } of slots) {
		const turns = slot.direction % 4;
		const cabin = bySize.find((candidate) => fits(candidate, slot, turns)) ?? bySize.at(-1)!;
		const control = `cabin:${id}`;
		const [x, , z] = slot.position;
		const cell = cellOf(x, z);
		const levelTag = (partition && levelOfCell(partition, cell.x, cell.z)?.tag) ?? 0;
		controls.push({
			kind: 'cabin',
			id: control,
			name: `Cabin slot (${Math.round(x)}, ${Math.round(z)}): ${cabin.type}`,
			rule: null,
			assumption: 'empty, as before the player builds a cabin',
			story: null,
			drivers: [],
			levelTags: [],
			values: [
				{ value: 0, label: 'empty' },
				{ value: 1, label: 'built' },
			],
			default: 0,
			derived: null,
		});
		for (const [index, model] of cabin.models.entries()) {
			placed.push({
				model: place(model, slot.position, turns),
				levelTag,
				source: `${cabin.type}#${index}@${id}`,
				visibility: { alternatives: [[{ control, mask: 2 }]] },
			});
		}
	}
	return { controls, models: placed };
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
