import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { AssetDebug } from './assets.ts';
import type { Group } from './collector.ts';

/** the directory of a package that holds its debug outputs, which the viewer ignores */
export const DEBUG_DIR = 'debug';

/** a JSON file under `debug/` */
export interface DebugFile {
	/** file name, relative to `debug/` */
	name: string;
	value: unknown;
}

/** a stand-in in `debug/stand-ins.json`: what it stands in for and why */
export interface StandInReport {
	/** the prefab, structure or entity it belongs to */
	path: string;
	/** the GameObject or entity */
	name: string;
	reason: string;
	/**
	 * where a placed stand-in's centre is, to the metre; `null` for a prefab renderer's, listed once however
	 * often the prefab is placed
	 */
	position: number[] | null;
}

/** where a package lists its stand-ins */
export const STAND_INS_FILE = 'stand-ins.json';

/** an input a pack couldn't use, in one of the `unsupported-*.json` files */
export interface UnsupportedInput {
	path: string;
	reason: string;
}

/**
 * writes a package's debug outputs
 *
 * @param outDir the package directory
 * @param files the JSON files
 * @param instances the closed {@link DebugLog}'s file, moved into place as `instances.jsonl`
 */
export const writeDebug = async (
	outDir: string,
	files: readonly DebugFile[],
	instances: string,
): Promise<void> => {
	const dir = join(outDir, DEBUG_DIR);
	await mkdir(dir, { recursive: true });
	await Promise.all(files.map(({ name, value }) => writeFile(join(dir, name), json(value))));
	await rename(instances, join(dir, 'instances.jsonl'));
};

/**
 * @param assets per table id, the asset's StringPathHash key and path
 * @param converted per table id, what conversion found, if assets were converted
 * @returns per id: key and path, plus the located object, its name and any failure
 */
export const assetRows = (
	assets: readonly { hash: bigint; path: string | null }[],
	converted: readonly AssetDebug[] | undefined,
): object[] =>
	assets.map(({ hash, path }, id) => ({ hash: `0x${hash.toString(16)}`, path, ...converted?.[id] }));

/** @returns `value` as UTF-8 JSON */
export const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

/**
 * the debug instance index, written as blocks are stored: one line per instance block with its blob hash and,
 * per row, [entity id, entity name, chunk-files index]
 */
export class DebugLog {
	readonly path: string;
	readonly #stream: WriteStream;

	private constructor(path: string, stream: WriteStream) {
		this.path = path;
		this.#stream = stream;
	}

	/** @param path file to write; its directory is created */
	static async create(path: string): Promise<DebugLog> {
		await mkdir(dirname(path), { recursive: true });
		return new DebugLog(path, createWriteStream(path));
	}

	/**
	 * appends a block's line, waiting while the stream is backed up
	 *
	 * @param blob the block's blob hash
	 * @param group the rows it was encoded from
	 * @param order per block row, its insertion index in `group`
	 */
	async block(blob: string, group: Group, order: Uint32Array): Promise<void> {
		const ids = group.rows.entityIdsInOrder(order);
		const rows = Array.from(order, (i, out): [number, string, number] => [
			ids[out],
			group.names[i],
			group.files[i],
		]);
		if (!this.#stream.write(`${JSON.stringify({ blob, rows })}\n`)) {
			await new Promise((resolve) => this.#stream.once('drain', resolve));
		}
	}

	/** flushes and closes the file */
	close(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.#stream.once('error', reject);
			this.#stream.end(resolve);
		});
	}
}
