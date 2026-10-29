import { FormatError } from '../binary/binary-reader.ts';
import { FlatBuffer } from '../binary/flatbuffer.ts';

import { readDynamicEntities, type DynamicDataRef, type DynamicEntity } from './dynamic-scene.ts';

/** a stored dynamic model placement; Euler angles are in Unity's degrees */
export interface DynamicModel {
	pathHash: bigint;
	position: [number, number, number];
	rotation: [number, number, number];
	scale: [number, number, number];
}

/** one component-group ordinal in a paired dynamic ECS chunk */
export interface DynamicEcs {
	chunk: number;
	index: number;
	sceneIndex: number;
}

/** an entity and the scene-state gates stored on it and its resource groups */
export interface DynamicResourceEntity {
	entity: DynamicEntity;
	states: number[];
	groupStates: number[][];
	/** null without script control; false means scripts must explicitly enable the entity */
	scriptDefaultLoad: boolean | null;
}

/** a main-file grid's geometry payloads */
export interface DynamicResourceGrid {
	id: number;
	models: DynamicModel[];
	ecs: DynamicEcs[];
}

/**
 * reads scene gates and geometry payloads from a DynamicStreaming main file
 *
 * @param bytes verified, uncompressed `fb_main` bytes
 * @returns grids and entities in stored order
 * @throws {FormatError} if a visibility span has the wrong type, owner or bounds
 */
export const readDynamicResources = (
	bytes: Uint8Array,
): {
	grids: DynamicResourceGrid[];
	entities: DynamicResourceEntity[];
} => {
	const fb = new FlatBuffer(bytes);
	const raw = readDynamicEntities(bytes);
	const grids: DynamicResourceGrid[] = [];
	const entities: DynamicResourceEntity[] = [];
	const gridVector = fb.vector(fb.root(), 3);
	let ordinal = 0;
	for (let i = 0; i < gridVector.length; i++) {
		const table = fb.tableAt(gridVector.start, i);
		const idAt = fb.field(table, 0);
		const id = idAt === undefined ? 0 : fb.u32(idAt);
		const integers = fb.vector(table, 3);
		const visibility = (at: number): number[] => {
			const invalid = fb.u8(at);
			const index = fb.i32(at + 12);
			const count = fb.i32(at + 16);
			if (
				invalid > 1 ||
				Boolean(invalid) === Boolean(count) ||
				fb.i32(at + 20) !== integers.length ||
				fb.i32(at + 4) !== 49 ||
				fb.u32(at + 8) !== id ||
				index < 0 ||
				count < 0 ||
				index + count > integers.length
			) {
				throw new FormatError(`invalid dynamic visibility span in grid ${id}`);
			}
			return Array.from({ length: count }, (_, n) => fb.i32(integers.start + (index + n) * 4));
		};
		const vec3 = (at: number): [number, number, number] => [fb.f32(at), fb.f32(at + 4), fb.f32(at + 8)];
		const models = fb.vector(table, 7);
		const ecs = fb.vector(table, 9);
		grids.push({
			id,
			models: Array.from({ length: models.length }, (_, n) => {
				const at = models.start + n * 96;
				return {
					pathHash: fb.u64(at + 64),
					position: vec3(at + 16),
					rotation: vec3(at + 28),
					scale: vec3(at + 40),
				};
			}),
			ecs: Array.from({ length: ecs.length }, (_, n) => {
				const at = ecs.start + n * 36;
				return { chunk: fb.i32(at), index: fb.i32(at + 4), sceneIndex: fb.i32(at + 32) };
			}),
		});
		const roots = fb.vector(table, 33);
		const dataIndex = fb.vector(table, 5);
		const resources = fb.vector(table, 32);
		const groups = fb.vector(table, 12);
		const scripts = fb.vector(table, 31);
		for (let r = 0; r < roots.length; r++, ordinal++) {
			const at = roots.start + r * 84;
			const groupStates: number[][] = [];
			let scriptDefaultLoad: boolean | null = null;
			const index = fb.i32(at + 20);
			const count = fb.i32(at + 24);
			for (let c = 0; c < count; c++) {
				const component = dataIndex.start + (index + c) * 16;
				if (fb.i32(component + 4) === 29) {
					const script = fb.i32(component + 12);
					if (script < 0 || script >= scripts.length) {
						throw new FormatError('script control outside its grid');
					}
					const value = fb.i32(scripts.start + script * 4);
					if (value !== 0 && value !== 1) {
						throw new FormatError(`invalid script default load ${value}`);
					}
					scriptDefaultLoad = value === 1;
				}
				if (fb.i32(component + 4) !== 30) {
					continue;
				}
				const resource = resources.start + fb.i32(component + 12) * 132;
				for (let g = 0; g < fb.i32(resource + 16); g++) {
					groupStates.push(visibility(groups.start + (fb.i32(resource + 12) + g) * 88 + 40));
				}
			}
			if (groupStates.length !== raw[ordinal]?.resourceGroups.length) {
				throw new FormatError('dynamic resource group visibility count mismatch');
			}
			entities.push({ entity: raw[ordinal], states: visibility(at + 36), groupStates, scriptDefaultLoad });
		}
	}
	return { grids, entities };
};

/**
 * resolves a typed resource slice without silently truncating malformed references
 *
 * @param rows the selected grid's model or ECS vector
 * @param ref resource-group reference to that vector
 * @returns the referenced rows
 * @throws {FormatError} if the slice lies outside the vector
 */
export const dynamicResourceSlice = <T>(rows: readonly T[], ref: DynamicDataRef): T[] => {
	if (ref.index < 0 || ref.count < 0 || ref.index + ref.count > rows.length) {
		throw new FormatError(`dynamic resource slice outside grid ${ref.grid}`);
	}
	return rows.slice(ref.index, ref.index + ref.count);
};
