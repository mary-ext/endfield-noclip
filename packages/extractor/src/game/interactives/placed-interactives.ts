import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import {
	type LevelInteractive,
	readLevelDataPrefix,
	UnsupportedLevelData,
} from '@endfield-noclip/formats/endfield/level-interactives';
import { InteractiveUnlockType, readLevelLocks } from '@endfield-noclip/formats/endfield/level-locks';
import type { LevelPartition } from '@endfield-noclip/formats/endfield/level-partition';
import { type LevelSpline, readLevelSplines } from '@endfield-noclip/formats/endfield/level-splines';
import type { MemoryPackValue } from '@endfield-noclip/formats/endfield/memory-pack';

import { formatErrorOnly } from '../../errors.ts';
import { type DraftControl, sceneControl, switchValues } from '../state/scene-control.ts';

import type { FacilitySources } from './facility-sources.ts';

/** a row of a level's LevelData interactive list, placed once per id */
export interface PlacedInteractive {
	/** its LevelData file */
	path: string;
	levelId: string;
	levelTag: number;
	row: LevelInteractive;
	/** the `created:<level id>` control of a row the game creates later, `null` for one created with the level */
	created: string | null;
}

/** the placed rows of a map or level */
export interface Placements {
	/** in LevelData order, rows created with their level before those created later */
	placed: PlacedInteractive[];
	/** by level id, the control of its rows created later */
	createdControls: Map<string, DraftControl>;
	/** by level id, its LevelData files */
	levelDataPaths: Map<string, string[]>;
}

/**
 * reads the interactive lists of a map's or a level's LevelData files. files the reader can't decode, and
 * function areas it doesn't apply, are reported
 *
 * @param sources install readers, where skipped files are reported
 * @param options.scene owning map
 * @param options.level restricts decoding to one level, or null for the map
 * @param options.partition numeric level tags
 * @returns the placed rows, deduplicated by id: a row created with its level wins over the same id created
 *   later in another layer
 * @throws {FormatError} if a level names a LevelData path the install lacks
 */
export const collectPlacements = async (
	sources: FacilitySources,
	{ scene, level, partition }: { scene: string; level: string | null; partition: LevelPartition | undefined },
): Promise<Placements> => {
	const { world } = sources.context;
	const pathOf = await world.pathLookup();
	const placed: PlacedInteractive[] = [];
	const createdControls = new Map<string, DraftControl>();
	const levelDataPaths = new Map<string, string[]>();
	const seen = new Set<bigint>();
	const later: PlacedInteractive[] = [];
	for (const config of (await world.levelConfigs()).values()) {
		if (config.mapId !== scene || (level !== null && config.id !== level)) {
			continue;
		}
		const levelTag = partition?.levels.find((entry) => entry.id === config.id)?.tag ?? 0;
		for (const hash of config.levelDataPathHashes ?? []) {
			const path = pathOf(hash);
			if (!path) {
				throw new FormatError(`missing LevelData path ${hash}`);
			}
			levelDataPaths.getOrInsertComputed(config.id, () => []).push(path);
			let prefix;
			try {
				// oxlint-disable-next-line no-await-in-loop -- level files are released after their prefix is decoded
				prefix = readLevelDataPrefix(await sources.read(path), (id) => sources.string(id));
			} catch (error) {
				if (!(error instanceof UnsupportedLevelData)) {
					throw error;
				}
				sources.report(path, error.message);
				continue;
			}
			if (prefix.hideByTypeAreas > 0) {
				sources.report(
					path,
					`${prefix.hideByTypeAreas} function areas that hide entities by type aren't applied`,
				);
			}
			for (const row of prefix.interactives) {
				if (row.createState !== 0) {
					later.push({ path, levelId: config.id, levelTag, row, created: `created:${config.id}` });
					continue;
				}
				if (seen.has(row.id)) {
					continue;
				}
				seen.add(row.id);
				placed.push({ path, levelId: config.id, levelTag, row, created: null });
			}
		}
	}
	for (const entry of later) {
		if (seen.has(entry.row.id)) {
			continue;
		}
		seen.add(entry.row.id);
		placed.push(entry);
		createdControls.getOrInsertComputed(entry.levelId, () =>
			sceneControl({
				kind: 'created',
				id: `created:${entry.levelId}`,
				name: `Created later (${entry.levelId})`,
				values: switchValues('not created', 'created'),
				default: 0,
				assumption: 'hidden: the server or a level script creates these interactives during play',
			}),
		);
	}
	return { placed, createdControls, levelDataPaths };
};

/** the MemoryPack wrapper of LevelData, decoded whole for its splines and locks */
const LEVEL_DATA_ROOT = 'Beyond_Gameplay_LevelDataForMemoryPack';

/** what a level's LevelData files hold beyond the placements */
interface LevelExtras {
	splines: Map<number, LevelSpline>;
	/** the unlock types of their interactives' gameplay locks, by logic id */
	locks: Map<bigint, number[]>;
}

/**
 * the splines and gameplay locks of each level's LevelData files, read on first request. each file is decoded
 * whole once, for both; a file or part that can't be read is reported and left out
 */
export class LevelDataExtras {
	readonly #sources: FacilitySources;
	readonly #paths: ReadonlyMap<string, readonly string[]>;
	readonly #extras = new Map<string, Promise<LevelExtras>>();

	/**
	 * @param sources install readers, where unreadable files are reported
	 * @param paths by level id, its LevelData files
	 */
	constructor(sources: FacilitySources, paths: ReadonlyMap<string, readonly string[]>) {
		this.#sources = sources;
		this.#paths = paths;
	}

	/**
	 * @param levelId a level id
	 * @returns its splines, by id
	 */
	async splinesOf(levelId: string): Promise<Map<number, LevelSpline>> {
		return (await this.#extrasOf(levelId)).splines;
	}

	/**
	 * @param levelId a placed row's level id
	 * @param id its logic id
	 * @returns whether a mini-game or submit lock swaps its model to its locked look until the player opens it
	 */
	async isLocked(levelId: string, id: bigint): Promise<boolean> {
		const locks = (await this.#extrasOf(levelId)).locks.get(id);
		return (
			locks?.some(
				(type) => type === InteractiveUnlockType.MiniGame || type === InteractiveUnlockType.Submit,
			) ?? false
		);
	}

	#extrasOf(levelId: string): Promise<LevelExtras> {
		return this.#extras.getOrInsertComputed(levelId, async () => {
			const sources = this.#sources;
			const splines = new Map<number, LevelSpline>();
			const locks = new Map<bigint, number[]>();
			// runs one reader over a decoded file, recording its failure under `what`
			const attemptRead = (path: string, what: string, readPart: () => void): void => {
				try {
					readPart();
				} catch (error) {
					sources.report(path, `${what}: ${formatErrorOnly(error).message}`);
				}
			};
			for (const path of this.#paths.get(levelId) ?? []) {
				let data: MemoryPackValue;
				try {
					// oxlint-disable-next-line no-await-in-loop -- one level's files, each released once read
					data = sources.memoryPack.decode(await sources.read(path), LEVEL_DATA_ROOT);
				} catch (error) {
					sources.report(path, `splines and gameplay locks: ${formatErrorOnly(error).message}`);
					continue;
				}
				attemptRead(path, 'splines', () => {
					for (const spline of readLevelSplines(data)) {
						splines.set(spline.id, spline);
					}
				});
				attemptRead(path, 'gameplay locks', () => {
					for (const [id, types] of readLevelLocks(data)) {
						locks.set(id, types);
					}
				});
			}
			return { splines, locks };
		});
	}
}
