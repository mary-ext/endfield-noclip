// the baked irradiance volume: every cell of the scene's base bake becomes a blob in the 512 m
// irradiance archive over it, listed in tables/irradiance.bin. cells are stored decompressed (the game's GPU
// layout) and zstd-compressed like other blobs.

import {
	decodeIrradianceCell,
	IRRADIANCE_CELL_SIZE,
	irradianceCellOrigin,
	type IrradianceRecord,
	parseIrradianceIndex,
} from '@endfield-noclip/formats/hg/irradiance';
import { BlobKind } from '@endfield-noclip/package-format/blobs';
import { type IrradianceTable, irradianceStem } from '@endfield-noclip/package-format/irradiance';

import type { Context } from '../context.ts';
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
	/** decompressed bytes of the packed cells */
	rawBytes: number;
	/** cells per level */
	levels: number[];
}

/** what the pack cache remembers of this step besides the cell blobs */
interface IrradianceMemo {
	/** per cell blob, in the same order: its key */
	keys: number[];
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
	selected: readonly { name: string; payload: VfsFile; records: readonly IrradianceRecord[] }[],
): Promise<StepMemo<IrradianceMemo>> => {
	const seen = new Set<number>();
	const memo: StepMemo<IrradianceMemo> = {
		blobs: [],
		value: { keys: [], report: { cells: 0, rawBytes: 0, levels: [0, 0, 0] } },
	};
	const { report } = memo.value;
	for (const { name, payload: payloadFile, records } of selected) {
		// oxlint-disable-next-line no-await-in-loop -- one ~67 MB payload in memory at a time
		const payload = await vfs.readVerified(payloadFile);
		// oxlint-disable-next-line no-await-in-loop -- as above
		const prepared = await Promise.all(
			records.map((record) => {
				const { level } = irradianceCellOrigin(record.key);
				if (record.offset + record.storedLength > payload.length) {
					throw new Error(`irradiance payload ${name} is shorter than its index says`);
				}
				if (level > 2 || seen.has(record.key)) {
					throw new Error(`irradiance cell ${record.key} has an unsupported level or duplicate base key`);
				}
				seen.add(record.key);
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
				});
			}),
		);
		for (const [i, record] of records.entries()) {
			memo.blobs.push(prepared[i].meta);
			memo.value.keys.push(record.key);
		}
	}
	return memo;
};

/** @returns the stem of the archive over a cell's centre */
const cellStem = (key: number): string => {
	const { level, origin } = irradianceCellOrigin(key);
	const half = (IRRADIANCE_CELL_SIZE << level) / 2;
	return irradianceStem(origin[0] + half, origin[2] + half);
};

/**
 * packs the scene's baked irradiance volume. with a cache, the cells of an unchanged volume (same index and
 * payload md5s, same region, same code) are taken from it without reading the payloads
 *
 * @param vfs the game's VFS
 * @param store where the cells go
 * @param cache the pack cache, or `null`; its blob directory must be the store's
 * @param options the scene, and which world points (cell centres) the package covers
 * @returns the cell table and a report, or `null` if the scene has no v3 irradiance volume
 * @throws {Error} if a payload file named by the index is missing or doesn't match it
 */
export const packIrradiance = async (
	vfs: Context['vfs'],
	store: BlobStore,
	cache: PackCache | null,
	options: { scene: string; includes: (x: number, z: number) => boolean },
): Promise<{ table: IrradianceTable; report: IrradianceReport } | null> => {
	const directory = `Data/IrradianceVolume/PC/${options.scene}/v3/`;
	const indexFile = await vfs.find(IRRADIANCE_GROUP, `${directory}index.bytes`);
	if (indexFile === undefined) {
		return null;
	}
	const index = parseIrradianceIndex(await vfs.readVerified(indexFile));
	// validate every file before filtering by region or scene state, including files we won't read.
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
	// the base bake's files and the cells of each the region keeps
	const selected = index.files.flatMap((name, file) => {
		if (index.stateGroups[index.fileGroups[file]].hash !== 0) {
			return [];
		}
		const records = index.records.filter((record) => {
			if (record.file !== file) {
				return false;
			}
			const { level, origin } = irradianceCellOrigin(record.key);
			const half = (IRRADIANCE_CELL_SIZE << level) / 2;
			return options.includes(origin[0] + half, origin[2] + half);
		});
		return records.length === 0 ? [] : [{ name, payload: payloads[file], records }];
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

	const cells = memo.blobs.map((meta, i) => {
		const cell = memo.value.keys[i];
		return {
			key: cell,
			blob: store.commit({ meta, options: { kind: BlobKind.Irradiance, stem: cellStem(cell) } }),
		};
	});
	cells.sort((a, b) => a.key - b.key);
	const report = { ...memo.value.report, cells: cells.length };
	return {
		table: {
			keys: Uint32Array.from(cells, (cell) => cell.key),
			blobs: Uint32Array.from(cells, (cell) => cell.blob),
		},
		report,
	};
};
