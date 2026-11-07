// the baked irradiance volume: every cell of the scene's base bake and its scene-state bakes becomes a blob
// in the 512 m irradiance archive over it, listed in tables/irradiance.bin. cells are stored decompressed (the
// game's GPU layout) and zstd-compressed like other blobs.

import {
	decodeIrradianceCell,
	IRRADIANCE_CELL_SIZE,
	irradianceCellOrigin,
	type IrradianceRecord,
	parseIrradianceIndex,
	parseIrradianceRegion,
} from '@endfield-noclip/formats/hg/irradiance';
import { BlobKind } from '@endfield-noclip/package-format/blobs';
import {
	type IrradianceRegionInfo,
	type IrradianceTable,
	irradianceStem,
} from '@endfield-noclip/package-format/irradiance';
import type { ConditionalSetInfo, SceneRequirement } from '@endfield-noclip/package-format/states';

import { mapDefined } from '@mary-ext/array-fns';

import type { Context } from '../context.ts';
import { sceneStateControl } from '../game/scene-conditions.ts';
import type { VfsFile } from '../hg/vfs.ts';

import type { BlobStore } from './blob-store.ts';
import type { PackCache, StepMemo } from './pack-cache.ts';

/** VFS group of `Data/IrradianceVolume` */
const IRRADIANCE_GROUP = 'A63D7E6A';

/** zstd level of cells: 1.6 GB of them on map02 are compressed on every pack, too slow at the blob default */
const ZSTD_LEVEL = 9;

/** what {@link packIrradiance} reports */
export interface IrradianceReport {
	cells: number;
	/** of {@link cells}, those of scene-state bakes */
	stateCells: number;
	/** decompressed bytes of the packed cells */
	rawBytes: number;
	/** cells per level */
	levels: number[];
}

/** what the pack cache remembers of this step besides the cell blobs */
interface IrradianceMemo {
	/** per cell blob, in the same order: its key */
	keys: number[];
	/** per cell blob: the index of its bake's state group in the index (0 for the base bake) */
	stateGroups: number[];
	report: IrradianceReport;
}

/**
 * decodes and compresses the selected cells into the store's directory, without committing them
 *
 * @returns the cells' blobs and keys, in file then record order, and the report
 * @throws {Error} if a payload is shorter than its index says, or a cell's level or key is unsupported
 */
const convertCells = async (
	vfs: Context['vfs'],
	store: BlobStore,
	selected: readonly {
		name: string;
		stateGroup: number;
		payload: VfsFile;
		records: readonly IrradianceRecord[];
	}[],
): Promise<StepMemo<IrradianceMemo>> => {
	const seen = new Set<string>();
	const memo: StepMemo<IrradianceMemo> = {
		blobs: [],
		value: { keys: [], stateGroups: [], report: { cells: 0, stateCells: 0, rawBytes: 0, levels: [0, 0, 0] } },
	};
	const { report } = memo.value;
	for (const { name, stateGroup, payload: payloadFile, records } of selected) {
		// oxlint-disable-next-line no-await-in-loop -- one ~67 MB payload in memory at a time
		const payload = await vfs.readVerified(payloadFile);
		// oxlint-disable-next-line no-await-in-loop -- as above
		const prepared = await Promise.all(
			records.map((record) => {
				const { level } = irradianceCellOrigin(record.key);
				if (record.offset + record.storedLength > payload.length) {
					throw new Error(`irradiance payload ${name} is shorter than its index says`);
				}
				const id = `${stateGroup}:${record.key}`;
				if (level > 2 || seen.has(id)) {
					throw new Error(`irradiance cell ${record.key} has an unsupported level or repeats in its bake`);
				}
				seen.add(id);
				report.levels[level] = (report.levels[level] ?? 0) + 1;
				report.rawBytes += record.size;
				const raw = decodeIrradianceCell(
					payload.subarray(record.offset, record.offset + record.storedLength),
					record,
				);
				return store.prepare(raw, {
					kind: BlobKind.Irradiance,
					compress: true,
					zstdLevel: ZSTD_LEVEL,
					stem: cellStem(record.key),
					locality: null,
				});
			}),
		);
		for (const [i, record] of records.entries()) {
			memo.blobs.push(prepared[i].meta);
			memo.value.keys.push(record.key);
			memo.value.stateGroups.push(stateGroup);
		}
		if (stateGroup !== 0) {
			report.stateCells += records.length;
		}
	}
	return memo;
};

// #region region bakes

/** a cabin slot, with the visibility group of its built cabin */
export interface CabinRoomGroup {
	/** index into `StatesInfo.groups` */
	group: number;
	position: [number, number, number];
	/** the room type id of the slot's cabin, or `null` if the game has none for it */
	roomType: number | null;
}

const REGION_FILE = /^regionIv_(.+)_(\d+)\.bytes$/;

/**
 * packs the bakes of Dijiang's rooms with their cabin built (docs/game-data/irradiance.md#region-bakes): per
 * slot, the bake whose box holds the slot origin and whose room type is the slot's cabin's. each applies
 * while its cabin shows
 *
 * @param vfs the game's VFS
 * @param store where the probes go
 * @param options the scene, and its cabin slots
 * @returns the regions, in slot order
 * @throws {Error} if a slot's box holds no bake of its room type, or several
 */
export const packIrradianceRegions = async (
	vfs: Context['vfs'],
	store: BlobStore,
	options: { scene: string; rooms: readonly CabinRoomGroup[] },
): Promise<IrradianceRegionInfo[]> => {
	if (options.rooms.length === 0) {
		return [];
	}
	const directory = `Data/IrradianceVolume/PC/${options.scene}/v3/`;
	const names = [...(await vfs.group(IRRADIANCE_GROUP)).files.keys()].filter((name) =>
		name.startsWith(directory),
	);
	const bakes = await Promise.all(
		mapDefined(names, (path) => {
			const name = path.slice(directory.length);
			const match = REGION_FILE.exec(name);
			if (match === null) {
				return undefined;
			}
			return (async () => {
				const file = await vfs.find(IRRADIANCE_GROUP, path);
				if (file === undefined) {
					throw new Error(`irradiance region ${name} is missing`);
				}
				const region = parseIrradianceRegion(await vfs.readVerified(file));
				return { name: name.slice(0, -'.bytes'.length), roomType: Number(match[2]), region };
			})();
		}),
	);
	const regions: IrradianceRegionInfo[] = [];
	for (const { group, position, roomType } of options.rooms) {
		if (roomType === null) {
			continue;
		}
		const matches = bakes.filter(
			(bake) =>
				bake.roomType === roomType &&
				[0, 1, 2].every(
					(axis) => position[axis] >= bake.region.min[axis] && position[axis] <= bake.region.max[axis],
				),
		);
		if (matches.length !== 1) {
			throw new Error(
				`${matches.length} irradiance region bakes of room type ${roomType} hold the cabin slot at ${position.join(', ')}`,
			);
		}
		const [{ name, region }] = matches;
		const centre = (axis: number) => (region.min[axis] + region.max[axis]) / 2;
		// oxlint-disable-next-line no-await-in-loop -- one per cabin slot
		const prepared = await store.prepare(region.probes, {
			kind: BlobKind.Irradiance,
			compress: true,
			zstdLevel: ZSTD_LEVEL,
			stem: irradianceStem(centre(0), centre(2)),
			locality: null,
		});
		regions.push({ name, group, origin: region.origin, size: region.size, blob: store.commit(prepared) });
	}
	return regions;
};

// #endregion

/** @returns the stem of the archive over a cell's centre */
const cellStem = (key: number): string => {
	const { level, origin } = irradianceCellOrigin(key);
	const half = (IRRADIANCE_CELL_SIZE << level) / 2;
	return irradianceStem(origin[0] + half, origin[2] + half);
};

/**
 * packs the scene's baked irradiance volume: the base bake, and each scene-state bake whose states the scene
 * has. with a cache, the cells of an unchanged volume (same index and payload md5s, same region, same code)
 * are taken from it without reading the payloads
 *
 * @param vfs the game's VFS
 * @param store where the cells go
 * @param cache the pack cache, or `null`; its blob directory must be the store's
 * @param options the scene; which world points (cell centres) the package covers; and the visibility group
 *   under which a bake of these scene states applies (an empty list for the base bake, which must always
 *   show), or `null` to leave the bake out
 * @returns the cell table and a report, or `null` if the scene has no v3 irradiance volume
 * @throws {Error} if a payload file named by the index is missing or doesn't match it
 */
export const packIrradiance = async (
	vfs: Context['vfs'],
	store: BlobStore,
	cache: PackCache | null,
	options: {
		scene: string;
		includes: (x: number, z: number) => boolean;
		groupOf: (sceneStates: readonly string[]) => number | null;
	},
): Promise<{ table: IrradianceTable; report: IrradianceReport } | null> => {
	const directory = `Data/IrradianceVolume/PC/${options.scene}/v3/`;
	const indexFile = await vfs.find(IRRADIANCE_GROUP, `${directory}index.bytes`);
	if (indexFile === undefined) {
		return null;
	}
	const index = parseIrradianceIndex(await vfs.readVerified(indexFile));
	// validate the complete index before subset filtering, including skipped payloads.
	const payloads = await Promise.all(
		index.files.map(async (name, file) => {
			const payload = await vfs.find(IRRADIANCE_GROUP, `${directory}${name}`);
			const records = index.records.filter((record) => record.file === file);
			const end = records.reduce(
				(length, record) => Math.max(length, record.offset + record.storedLength),
				0,
			);
			if (payload === undefined || payload.entry.length !== end) {
				throw new Error(`irradiance payload ${name} is missing or its length disagrees with the index`);
			}
			return payload;
		}),
	);
	// a bake's scene states (none for the base bake) and the visibility group it applies under
	const bakes = index.stateGroups.map(({ hash, sceneStates }) => {
		const names = hash === 0 ? [] : sceneStates.map((state) => index.sceneStates[state]);
		return { names, group: options.groupOf(names) };
	});
	// the kept bakes' files and the cells of each the region keeps
	const selected = mapDefined(index.files, (name, file) => {
		const stateGroup = index.fileGroups[file];
		if (bakes[stateGroup].group === null) {
			return undefined;
		}
		const records = index.records.filter((record) => {
			if (record.file !== file) {
				return false;
			}
			const { level, origin } = irradianceCellOrigin(record.key);
			const half = (IRRADIANCE_CELL_SIZE << level) / 2;
			return options.includes(origin[0] + half, origin[2] + half);
		});
		return records.length === 0 ? undefined : { name, stateGroup, payload: payloads[file], records };
	});

	const key =
		cache === null
			? null
			: await cache.stepKey(new URL(import.meta.url), {
					index: indexFile.entry.dataMd5,
					files: selected.map(({ payload, records }) => [
						payload.entry.dataMd5,
						records.map((record) => record.key),
					]),
					zstdLevel: ZSTD_LEVEL,
				});
	let memo = key === null ? undefined : await cache?.recallStep<IrradianceMemo>(key);
	if (memo === undefined) {
		memo = await convertCells(vfs, store, selected);
		if (key !== null) {
			await cache?.rememberStep(key, memo);
		}
	}

	const { keys, stateGroups } = memo.value;
	const cells = memo.blobs.map((meta, i) => {
		const cell = keys[i];
		const { names, group } = bakes[stateGroups[i]];
		if (group === null) {
			throw new Error('irradiance: a cached cell belongs to a bake left out');
		}
		return {
			key: cell,
			blob: store.commit({
				meta,
				options: {
					kind: BlobKind.Irradiance,
					stem: cellStem(cell),
					// by cell key, so a cell's neighbours at its level are near it
					locality: cell.toString(16).padStart(8, '0'),
				},
			}),
			group,
			states: names.length,
		};
	});
	// a viewer takes a key's first shown entry, so the most specific bake comes first and the base bake last
	cells.sort((a, b) => a.key - b.key || b.states - a.states);
	const report = { ...memo.value.report, cells: cells.length };
	return {
		table: {
			keys: Uint32Array.from(cells, (cell) => cell.key),
			blobs: Uint32Array.from(cells, (cell) => cell.blob),
			groups: Uint32Array.from(cells, (cell) => cell.group),
		},
		report,
	};
};

/**
 * the requirement under which the game uses a scene-state bake: every one of its states on. inferred from the
 * bakes, not read from the game's code (see docs/game-data/irradiance.md#scene-state-bakes)
 *
 * @param names the bake's scene states
 * @param indexOf a scene state's MapConfig index by name, or `undefined` if the scene doesn't have it
 * @returns the condition, or `null` if one of the states isn't the scene's, so the bake never applies
 */
export const sceneStateBakeCondition = (
	names: readonly string[],
	indexOf: (name: string) => number | undefined,
): ConditionalSetInfo | null => {
	const requirements: SceneRequirement[] = [];
	for (const name of names) {
		const index = indexOf(name);
		if (index === undefined) {
			return null;
		}
		requirements.push({ control: sceneStateControl(index), mask: 2 });
	}
	return { alternatives: [requirements] };
};
