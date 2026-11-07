import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import type { MemoryPackReader } from '@endfield-noclip/formats/endfield/memory-pack';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import { isObject, numberField, objectField, stringField } from '@endfield-noclip/formats/unity/values';

import type { Context } from '../../context.ts';
import { VfsGroup } from '../../hg/vfs.ts';
import type { ObjectRef } from '../assets/assets.ts';
import type { WorldIndex } from '../world/world-index.ts';

import type { ModelViews } from './view-state-poses.ts';

/** the readers interactive placement needs from the context */
export type FacilityContext = Pick<Context, 'vfs' | 'world' | 'resolver' | 'memoryPack'>;

/** a file the reader skipped, or part of one, and why */
export interface UnsupportedFile {
	path: string;
	reason: string;
}

/** one visual form of an interactive: its ModelTable id, prefab and scale */
export interface InteractiveForm {
	model: string;
	prefab: string;
	scale: number;
}

/** `ModelTable.json`: the prefab, scale and view-state source of each model id */
export class ModelTable {
	readonly #data: TypeTreeObject;

	/** @param table the decoded model table */
	constructor(table: unknown) {
		if (!isObject(table)) {
			throw new FormatError('invalid model table');
		}
		this.#data = objectField(table, 'data');
	}

	/**
	 * @param model a model id
	 * @returns whether the table has it
	 */
	has(model: string): boolean {
		return model in this.#data;
	}

	/**
	 * @param model a model id the table has
	 * @returns the model, and the model whose view states it uses
	 */
	viewsOf(model: string): ModelViews {
		const source = objectField(this.#data, model).dependModelViewDataId;
		return { model, source: typeof source === 'string' && source !== '' ? source : model };
	}

	/**
	 * @param model a model id the table has
	 * @param scale the template's model scale
	 * @returns its form: its prefab, and the template's scale times its own
	 */
	formOf(model: string, scale: number): InteractiveForm {
		const data = objectField(this.#data, model);
		return {
			model,
			prefab: stringField(data, 'path').toLowerCase(),
			scale: scale * numberField(data, 'scaleFactor'),
		};
	}
}

/** what every step of interactive placement reads through, and where it reports what it couldn't read */
export class FacilitySources {
	readonly context: FacilityContext;
	readonly memoryPack: MemoryPackReader;
	readonly models: ModelTable;
	/** files and parts of files that were skipped, in the order they were met */
	readonly unsupported: UnsupportedFile[] = [];
	readonly #strings: Awaited<ReturnType<WorldIndex['stringPool']>>;

	constructor(
		context: FacilityContext,
		memoryPack: MemoryPackReader,
		strings: Awaited<ReturnType<WorldIndex['stringPool']>>,
		models: ModelTable,
	) {
		this.context = context;
		this.memoryPack = memoryPack;
		this.#strings = strings;
		this.models = models;
	}

	/**
	 * @param context install readers and the bundle resolver
	 * @returns the sources, with the string pool and model table read
	 * @throws {FormatError} if the model table is invalid
	 */
	static async open(context: FacilityContext): Promise<FacilitySources> {
		const memoryPack = await context.memoryPack();
		const strings = await context.world.stringPool();
		const table: unknown = JSON.parse(
			new TextDecoder().decode(
				await context.vfs.readFile(VfsGroup.JsonData, 'Data/Json/GameplayConfig/ModelTable.json'),
			),
		);
		return new FacilitySources(context, memoryPack, strings, new ModelTable(table));
	}

	/**
	 * @param name a JSON data file's path
	 * @returns its bytes
	 */
	read(name: string): Promise<Uint8Array> {
		return this.context.vfs.readFile(VfsGroup.JsonData, name);
	}

	/**
	 * @param id a string pool id
	 * @returns its string, or `null` when the pool lacks it
	 */
	string(id: number): string | null {
		return this.#strings.get(id);
	}

	/**
	 * @param path the file, or part of one, that was skipped
	 * @param reason why
	 */
	report(path: string, reason: string): void {
		this.unsupported.push({ path, reason });
	}

	/**
	 * runs a read whose format error leaves its subject drawn as saved
	 *
	 * @param path what's read, reported with the error
	 * @param run the read
	 * @param failed the result on a format error
	 * @returns the read's result, or `failed`
	 * @throws whatever `run` throws other than a {@link FormatError}
	 */
	async attempt<T>(path: string, run: () => Promise<T>, failed: T): Promise<T> {
		try {
			return await run();
		} catch (error) {
			if (!(error instanceof FormatError)) {
				throw error;
			}
			this.report(path, error.message);
			return failed;
		}
	}
}

/** bundle path hashes of the prefabs interactives place, found in the manifest on request */
export class PrefabHashes {
	readonly #context: FacilityContext;
	readonly #manifest: Awaited<ReturnType<WorldIndex['manifest']>>;
	readonly #hashes = new Map<string, bigint>();

	constructor(context: FacilityContext, manifest: Awaited<ReturnType<WorldIndex['manifest']>>) {
		this.#context = context;
		this.#manifest = manifest;
	}

	/**
	 * @param context install readers and the bundle resolver
	 * @returns an empty lookup over the bundle manifest
	 */
	static async open(context: FacilityContext): Promise<PrefabHashes> {
		return new PrefabHashes(context, await context.world.manifest());
	}

	/**
	 * looks up the hashes of prefabs not found yet. the manifest maps hashes to paths only, and each path
	 * decompresses on read, so it's walked once per call and the walk stops once all are found
	 *
	 * @param paths bundle paths
	 */
	find(paths: Iterable<string>): void {
		const missing = new Set([...paths].filter((path) => !this.#hashes.has(path)));
		for (const asset of this.#manifest.assets()) {
			if (missing.size === 0) {
				break;
			}
			const path = this.#manifest.assetPath(asset);
			if (missing.delete(path)) {
				this.#hashes.set(path, asset.pathHash);
			}
		}
	}

	/**
	 * @param prefab a bundle path passed to {@link find}
	 * @returns its hash, or `undefined` when the manifest lacks it
	 */
	get(prefab: string): bigint | undefined {
		return this.#hashes.get(prefab);
	}

	/**
	 * @param prefab an interactive's prefab, passed to {@link find}
	 * @returns its hash
	 * @throws {FormatError} if the manifest lacks it
	 */
	hashOf(prefab: string): bigint {
		const hash = this.#hashes.get(prefab);
		if (hash === undefined) {
			throw new FormatError(`missing interactive prefab ${prefab}`);
		}
		return hash;
	}

	/**
	 * @param prefab an interactive's prefab, passed to {@link find}
	 * @returns its root GameObject
	 * @throws {FormatError} if the manifest lacks it or its bundle doesn't hold one root
	 */
	async root(prefab: string): Promise<ObjectRef> {
		const resolver = await this.#context.resolver();
		return resolver.findUnique({ hash: this.hashOf(prefab), path: prefab }, UnityClass.GameObject);
	}
}
