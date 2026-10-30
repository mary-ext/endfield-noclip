// the baked irradiance volume: every cell of the scene's base bake becomes a blob in the 512 m
// irradiance archive over it, listed in tables/irradiance.bin. cells are stored decompressed (the game's GPU
// layout) and zstd-compressed like other blobs.

import {
	decodeIrradianceCell,
	IRRADIANCE_CELL_SIZE,
	irradianceCellOrigin,
	parseIrradianceIndex,
} from '@endfield-noclip/formats/hg/irradiance';
import {
	BlobKind,
	type IrradianceTable,
	irradianceArchiveName,
} from '@endfield-noclip/package-format/format';

import type { Context } from '../context.ts';

import type { BlobStore } from './blob-store.ts';

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

/**
 * packs the scene's baked irradiance volume.
 *
 * @param vfs the game's VFS
 * @param store where the cells go
 * @param options the scene, and which world points (cell centres) the package covers
 * @returns the cell table and a report, or `null` if the scene has no v3 irradiance volume
 * @throws {Error} if a payload file named by the index is missing or doesn't match it
 */
export const packIrradiance = async (
	vfs: Context['vfs'],
	store: BlobStore,
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
	const keys = new Set<number>();
	const cells: { key: number; blob: number }[] = [];
	const report: IrradianceReport = { cells: 0, rawBytes: 0, levels: [0, 0, 0] };
	for (const [file, name] of index.files.entries()) {
		if (index.stateGroups[index.fileGroups[file]].hash !== 0) {
			continue;
		}
		const records = index.records.filter((record) => {
			if (record.file !== file) {
				return false;
			}
			const { level, origin } = irradianceCellOrigin(record.key);
			const half = (IRRADIANCE_CELL_SIZE << level) / 2;
			return options.includes(origin[0] + half, origin[2] + half);
		});
		if (records.length === 0) {
			continue;
		}
		const payloadFile = payloads[file];
		// oxlint-disable-next-line no-await-in-loop -- one ~67 MB payload in memory at a time
		const payload = await vfs.readVerified(payloadFile);
		const items = records.map((record) => {
			const { level, origin } = irradianceCellOrigin(record.key);
			const half = (IRRADIANCE_CELL_SIZE << level) / 2;
			const archive = irradianceArchiveName(origin[0] + half, origin[2] + half);
			if (record.offset + record.storedLength > payload.length) {
				throw new Error(`irradiance payload ${name} is shorter than its index says`);
			}
			if (level > 2 || keys.has(record.key)) {
				throw new Error(`irradiance cell ${record.key} has an unsupported level or duplicate base key`);
			}
			keys.add(record.key);
			report.levels[level] = (report.levels[level] ?? 0) + 1;
			report.rawBytes += record.size;
			return {
				raw: decodeIrradianceCell(
					payload.subarray(record.offset, record.offset + record.storedLength),
					record,
				),
				options: {
					kind: BlobKind.Irradiance,
					compress: true,
					zstdLevel: ZSTD_LEVEL,
					archive: () => archive,
				},
			};
		});
		// oxlint-disable-next-line no-await-in-loop -- as above
		const blobs = await store.putMany(items);
		for (const [i, record] of records.entries()) {
			cells.push({ key: record.key, blob: blobs[i] });
		}
	}
	cells.sort((a, b) => a.key - b.key);
	report.cells = cells.length;
	return {
		table: {
			keys: Uint32Array.from(cells, (cell) => cell.key),
			blobs: Uint32Array.from(cells, (cell) => cell.blob),
		},
		report,
	};
};
