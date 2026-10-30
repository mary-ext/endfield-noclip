import { createHash } from 'node:crypto';

import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import { BlobKind } from '@endfield-noclip/package-format/blobs';
import type { GeometryEntry } from '@endfield-noclip/package-format/geometry';
import type { Chain } from '@endfield-noclip/package-format/instances';
import type { MaterialEntry, MaterialTable, ReadyMaterial } from '@endfield-noclip/package-format/materials';
import { type TextureEntry, textureLevelLayout } from '@endfield-noclip/package-format/textures';

import { failureReason } from '../errors.ts';
import { loadMaterial } from '../game/asset-decode.ts';
import {
	type AssetRef,
	type AssetResolver,
	locateObject,
	type ObjectLocator,
	objectKey,
	type ObjectRef,
} from '../game/assets.ts';
import { orderedPool } from '../pool.ts';

import { type AssetArchives, type Place, mergePlaces } from './asset-placement.ts';
import type { BlobMeta } from './blob-file.ts';
import type { BlobPlacement, BlobStore } from './blob-store.ts';
import {
	type BundleSource,
	type ConvertJob,
	type ConvertPool,
	type ConvertResult,
	type ConvertResultOf,
	resultMatches,
} from './convert-pool.ts';
import { convertMaterial, ShaderTable } from './materials.ts';
import type { PackCache } from './pack-cache.ts';
import { PhaseTimer } from './phase-timer.ts';

// the packer references assets by dense ids handed out here, in first-reference order. converting them reads
// materials first (they decide which meshes need tangents and which textures are used), then meshes, then
// textures. meshes and textures convert on worker threads; each phase stores results in id order, so the
// package is deterministic.

// #region ids

/** assigns dense ids to assets by hash, in first-reference order */
export class AssetIds {
	readonly assets: AssetRef[] = [];
	readonly #ids = new Map<bigint, number>();

	/**
	 * @param hash StringPathHash key
	 * @param resolve looks up the path, called once per new hash
	 * @returns the asset's id
	 */
	intern(hash: bigint, resolve: (hash: bigint) => string | undefined): number {
		let id = this.#ids.get(hash);
		if (id === undefined) {
			id = this.assets.length;
			this.#ids.set(hash, id);
			this.assets.push({ hash, path: resolve(hash) ?? null });
		}
		return id;
	}

	/** @returns the asset with the given id */
	get(id: number): AssetRef {
		return this.assets[id];
	}

	/**
	 * interns an exact prefab dependency without inventing a game asset path
	 *
	 * @param ref resolved dependency
	 * @returns its asset id; negative hashes occupy a namespace separate from unsigned game hashes
	 */
	internObject(ref: ObjectRef): number {
		const key = objectKey(ref);
		const hash = -BigInt(`0x${createHash('sha256').update(key).digest('hex')}`);
		const existing = this.#ids.get(hash);
		if (existing !== undefined) {
			return existing;
		}
		const id = this.assets.length;
		this.#ids.set(hash, id);
		this.assets.push({ hash, path: key, locator: locateObject(ref) });
		return id;
	}
	/**
	 * @param ref skinned mesh dependency
	 * @param pose mesh-to-prefab bone matrices, including bind poses
	 * @returns a geometry id distinct for each authored pose of the mesh
	 */
	internPosedObject(ref: ObjectRef, pose: Float32Array[]): number {
		const key = objectKey(ref);
		const digest = createHash('sha256').update(key).update('pose');
		for (const matrix of pose) {
			digest.update(new Uint8Array(matrix.buffer, matrix.byteOffset, matrix.byteLength));
		}
		const hash = -BigInt(`0x${digest.digest('hex')}`);
		const existing = this.#ids.get(hash);
		if (existing !== undefined) {
			return existing;
		}
		const id = this.assets.length;
		this.#ids.set(hash, id);
		this.assets.push({
			hash,
			path: key,
			locator: locateObject(ref),
			pose: pose.map((matrix) => matrix.slice()),
		});
		return id;
	}
}

// #endregion

// #region conversion

/** what {@link convertAssets} needs */
export interface AssetConversionInput {
	resolver: AssetResolver;
	store: BlobStore;
	/** converts meshes and textures, writing their blobs to the store's directory */
	pool: ConvertPool;
	/** remembers conversions across packs, or `null`; its blob directory must be the store's */
	cache: PackCache | null;
	geometries: readonly AssetRef[];
	materials: readonly AssetRef[];
	chains: readonly Chain[];
	/** per geometry and material id, where its uses are; see `AssetPlacement` */
	places: { geometries: readonly Place[]; materials: readonly Place[] };
	/** textures referenced outside materials (environment and water maps), in groups of the caller's choosing */
	extraTextures: readonly (readonly PlacedTexture[])[];
	/** names the asset archives blobs go to */
	archives: AssetArchives;
	/** zstd level for geometry blobs */
	geometryZstdLevel: number;
	/** zstd level for texture blobs */
	textureZstdLevel: number;
	/** materials decoded at once */
	materialConcurrency: number;
	log: (line: string) => void;
}

/** a texture referenced outside materials, and where its blobs go */
export interface PlacedTexture {
	ref: ObjectRef;
	place: Place;
}

/** a debug-index row: what an entry came from and why it failed */
export interface AssetDebug {
	/** `CAB-<hex>:<pathId>` of the object, when located */
	object: string | null;
	name: string | null;
	error: string | null;
}

/** sizes of one category of stored blobs */
export interface BlobTally {
	count: number;
	stored: number;
	raw: number;
}

/** the converted tables plus reporting */
export interface AssetConversion {
	geometries: GeometryEntry[];
	materials: MaterialTable;
	textures: TextureEntry[];
	/**
	 * per {@link AssetConversionInput.extraTextures} group and entry, its texture-table id, or `null` if it
	 * failed
	 */
	extraTextureIds: (number | null)[][];
	debug: {
		geometries: AssetDebug[];
		materials: (AssetDebug & { shader: string | null })[];
		/** by texture object, in first-use order; `id` is its texture-table entry */
		textures: (AssetDebug & { id: number })[];
	};
	stats: {
		timings: Record<string, number>;
		geometry: BlobTally & {
			vertices: number;
			triangles: number;
			gpuBytes: number;
			generatedTangents: number;
		};
		/** texture blobs by piece: `tail`, or the level's largest dimension */
		texturePieces: Record<string, BlobTally>;
		textureFormats: Record<string, number>;
		/** texture objects whose content equalled an earlier texture's */
		textureDuplicates: number;
		failures: Record<string, number>;
	};
}

/**
 * converts every referenced material, geometry and texture into blobs and table entries
 *
 * @param input assets, chains, placements and the blob store
 * @returns the tables, debug rows and statistics
 */
export const convertAssets = async (input: AssetConversionInput): Promise<AssetConversion> => {
	const { resolver, store, pool, cache, archives } = input;
	/** @returns whether every bundle still has the md5 it had when the conversion read it */
	const sourcesCurrent = async (sources: readonly BundleSource[]): Promise<boolean> => {
		const md5s = await Promise.all(
			sources.map(async ({ bundle }) => {
				const index = resolver.manifest.findBundle(bundle);
				return index === undefined ? undefined : resolver.bundleMd5(index);
			}),
		);
		return sources.every(({ md5 }, i) => md5s[i] === md5);
	};
	/** converts on the pool, or recalls the conversion from the cache */
	const convert = async <J extends ConvertJob>(job: J): Promise<ConvertResultOf<J>> => {
		const ofJob = (result: ConvertResult): ConvertResultOf<J> => {
			if (!resultMatches(job, result)) {
				throw new Error(`a ${job.kind} job returned a ${result.kind}`);
			}
			return result;
		};
		if (cache === null) {
			return ofJob(await pool.run(job));
		}
		const key = cache.key(job);
		const recalled = await cache.recall(key, sourcesCurrent);
		if (recalled !== undefined) {
			return ofJob(recalled);
		}
		const result = await pool.run(job);
		await cache.remember(key, result);
		return ofJob(result);
	};
	const failures: Record<string, number> = {};
	const fail = (kind: string, error: Error): string => {
		const reason = `${kind}: ${failureReason(error)}`;
		failures[reason] = (failures[reason] ?? 0) + 1;
		return error.message;
	};
	const timer = new PhaseTimer(input.log);

	// #region materials
	const shaders = new ShaderTable();
	const materialEntries: MaterialEntry[] = [];
	const materialDebug: AssetConversion['debug']['materials'] = [];
	const normalMapUv: (number | null)[] = [];
	/** texture objects in first-use order, with a provisional id each */
	const textureObjects: { key: string; locator: ObjectLocator; place: Place }[] = [];
	const textureIndex = new Map<string, number>();
	const useTexture = (ref: ObjectRef, place: Place): number => {
		const key = objectKey(ref);
		let index = textureIndex.get(key);
		if (index === undefined) {
			index = textureObjects.length;
			textureIndex.set(key, index);
			textureObjects.push({ key, locator: locateObject(ref), place });
		} else {
			textureObjects[index].place = mergePlaces(textureObjects[index].place, place);
		}
		return index;
	};
	await orderedPool(
		input.materials,
		input.materialConcurrency,
		async (asset) => {
			const ref = await resolver.findUnique(asset, UnityClass.Material);
			return { ref, loaded: await loadMaterial(resolver, ref) };
		},
		(result, _asset, id) => {
			if (result instanceof Error) {
				materialEntries.push({ id, status: 'failed' });
				materialDebug.push({ object: null, name: null, shader: null, error: fail('material', result) });
				normalMapUv.push(null);
				return;
			}
			const { ref, loaded } = result;
			const place = input.places.materials[id];
			const shader = shaders.intern(loaded.shader, loaded.classification.family);
			const converted = convertMaterial(loaded.record, loaded.classification, shader, (slot) => {
				const target = loaded.textures[slot]?.ref;
				if (target === null || target === undefined) {
					return undefined;
				}
				return useTexture(target, place);
			});
			materialEntries.push({ id, status: 'ready', ...converted.material });
			materialDebug.push({
				object: objectKey(ref),
				name: loaded.record.name,
				shader: loaded.shader.name,
				error: null,
			});
			normalMapUv.push(converted.normalMapUv);
		},
	);
	const extraIndices = input.extraTextures.map((group) =>
		group.map(({ ref, place }) => useTexture(ref, place)),
	);
	timer.end('materials');
	// #endregion

	// #region geometry
	// a mesh gets tangents when any draw of it uses a normal-mapped material
	const tangentUv = Array.from({ length: input.geometries.length }, (): number | null => null);
	for (const chain of input.chains) {
		for (const draw of chain.draws) {
			const uv = normalMapUv[draw.material] ?? null;
			const current = tangentUv[draw.geometry];
			if (uv !== null && (current === null || uv < current)) {
				tangentUv[draw.geometry] = uv;
			}
		}
	}
	const geometryEntries: GeometryEntry[] = [];
	const geometryDebug: AssetDebug[] = [];
	const geometry = {
		count: 0,
		stored: 0,
		raw: 0,
		vertices: 0,
		triangles: 0,
		gpuBytes: 0,
		generatedTangents: 0,
	};
	await orderedPool(
		input.geometries,
		CONVERSIONS_IN_FLIGHT,
		(asset, id) =>
			convert({ kind: 'geometry', asset, tangentUv: tangentUv[id], zstdLevel: input.geometryZstdLevel }),
		(result, _asset, id) => {
			if (result instanceof Error) {
				geometryEntries.push({ id, status: 'failed' });
				geometryDebug.push({ object: null, name: null, error: fail('geometry', result) });
				return;
			}
			const blob = commit(
				store,
				result.blob,
				{
					kind: BlobKind.Geometry,
					archive: (_hash, length) => archives.archive(input.places.geometries[id], length),
				},
				geometry,
			);
			geometryEntries.push({ id, status: 'ready', blob, ...result.entry });
			geometryDebug.push({ object: result.object, name: result.name, error: null });
			geometry.vertices += result.entry.vertexCount;
			geometry.triangles += result.entry.indexCount / 3;
			geometry.gpuBytes += result.gpuBytes;
			if (result.entry.tangentUv !== null) {
				geometry.generatedTangents++;
			}
		},
	);
	timer.end('geometry');
	// #endregion

	// #region textures
	const textureEntries: TextureEntry[] = [];
	const textureDebug: AssetConversion['debug']['textures'] = [];
	/** provisional (per object) → texture-table id */
	const textureIds: number[] = [];
	const byContent = new Map<string, number>();
	const texturePieces: Record<string, BlobTally> = {};
	const textureFormats: Record<string, number> = {};
	let textureDuplicates = 0;
	await orderedPool(
		textureObjects,
		CONVERSIONS_IN_FLIGHT,
		(object) => convert({ kind: 'texture', locator: object.locator, zstdLevel: input.textureZstdLevel }),
		(result, object) => {
			if (result instanceof Error) {
				textureIds.push(textureEntries.length);
				textureDebug.push({
					object: object.key,
					name: null,
					error: fail('texture', result),
					id: textureEntries.length,
				});
				textureEntries.push({ id: textureEntries.length, status: 'failed' });
				return;
			}
			const { name, pieces } = result;
			const twin = byContent.get(result.contentKey);
			if (twin !== undefined) {
				textureDuplicates++;
				textureIds.push(twin);
				textureDebug.push({ object: object.key, name, error: null, id: twin });
				return;
			}
			const id = textureEntries.length;
			byContent.set(result.contentKey, id);
			textureIds.push(id);
			textureFormats[result.entry.format] = (textureFormats[result.entry.format] ?? 0) + 1;
			const placement: BlobPlacement = {
				kind: BlobKind.Texture,
				archive: (_hash, length) => archives.archive(object.place, length),
			};
			textureEntries.push({
				id,
				status: 'ready',
				...result.entry,
				pieces: pieces.map((piece, i) => {
					const { width, height } = textureLevelLayout(result.entry, piece.firstLevel);
					const group = i === 0 && piece.levelCount > 1 ? 'tail' : String(Math.max(width, height));
					texturePieces[group] ??= { count: 0, stored: 0, raw: 0 };
					return {
						blob: commit(store, piece.blob, placement, texturePieces[group]),
						firstLevel: piece.firstLevel,
						levelCount: piece.levelCount,
					};
				}),
			});
			textureDebug.push({ object: object.key, name, error: null, id });
		},
	);
	// slots referenced textures by object; point them at the deduplicated entries
	for (const entry of materialEntries) {
		if (entry.status === 'ready') {
			remapSlots(entry, textureIds);
		}
	}
	timer.end('textures');
	// #endregion

	return {
		geometries: geometryEntries,
		materials: { shaders: shaders.shaders, entries: materialEntries },
		textures: textureEntries,
		extraTextureIds: extraIndices.map((group) =>
			group.map((index) => {
				const id = textureIds[index];
				return textureEntries[id]?.status === 'ready' ? id : null;
			}),
		),
		debug: { geometries: geometryDebug, materials: materialDebug, textures: textureDebug },
		stats: {
			timings: timer.timings,
			geometry,
			texturePieces,
			textureFormats,
			textureDuplicates,
			failures,
		},
	};
};

/**
 * entries for every referenced asset without converting any (`pack --no-assets`)
 *
 * @param geometries geometry count
 * @param materials material count
 * @param extraTextures the textures referenced outside materials, grouped as for {@link convertAssets}
 * @returns pending tables; extra textures have no id
 */
export const pendingAssets = (
	geometries: number,
	materials: number,
	extraTextures: readonly (readonly PlacedTexture[])[],
): Pick<AssetConversion, 'geometries' | 'materials' | 'textures' | 'extraTextureIds'> => ({
	geometries: Array.from({ length: geometries }, (_, id) => ({ id, status: 'pending' })),
	materials: {
		shaders: [],
		entries: Array.from({ length: materials }, (_, id) => ({ id, status: 'pending' })),
	},
	textures: [],
	extraTextureIds: extraTextures.map((group) => group.map(() => null)),
});

// #endregion

// #region helpers

/**
 * conversions started ahead of the one being committed. results are committed in order, so one slow job holds
 * back the rest of the window; a wide window keeps the workers busy meanwhile. results are small (the blobs
 * are on disk), so the width costs little memory
 */
const CONVERSIONS_IN_FLIGHT = 64;

/** commits a blob a worker wrote, counting its bytes when it's new */
const commit = (store: BlobStore, meta: BlobMeta, options: BlobPlacement, tally: BlobTally): number => {
	const before = store.size;
	const index = store.commit({ meta, options });
	if (store.size > before) {
		tally.count++;
		tally.stored += meta.length;
		tally.raw += meta.rawLength;
	}
	return index;
};

/** rewrites a material's slots from per-object ids to texture-table ids, in place (the entry is ours) */
const remapSlots = (material: ReadyMaterial, ids: readonly number[]): void => {
	for (const slot of Object.values(material.slots)) {
		slot.texture = ids[slot.texture];
	}
};

// #endregion
