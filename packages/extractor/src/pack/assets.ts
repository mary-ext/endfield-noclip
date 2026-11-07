import { createHash } from 'node:crypto';

import type { MaterialRecord } from '@endfield-noclip/formats/unity/material';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import { BlobKind } from '@endfield-noclip/package-format/blobs';
import type { GeometryEntry } from '@endfield-noclip/package-format/geometry';
import type { Chain } from '@endfield-noclip/package-format/instances';
import type { MaterialEntry, MaterialTable } from '@endfield-noclip/package-format/materials';
import type { LitSway } from '@endfield-noclip/package-format/surfaces';
import {
	type TextureEntry,
	textureLevelLayout,
	type TextureSampler,
	type TextureTable,
} from '@endfield-noclip/package-format/textures';

import { failureReason } from '../errors.ts';
import {
	type AssetRef,
	type AssetResolver,
	locateObject,
	type ObjectLocator,
	objectKey,
	type ObjectRef,
} from '../game/assets.ts';
import { describeMaterial, materialSway } from '../game/material-describe.ts';
import { type LoadedMaterial, loadMaterial } from '../game/material-load.ts';
import { keywordsNotDrawn } from '../game/material-surfaces.ts';
import type { MaterialValues as ConvertedMaterial } from '../game/material-values.ts';
import type { MaterialValues, RendererMotion } from '../game/prefab.ts';
import { type SyntheticMesh, syntheticMeshKey } from '../game/synthetic-mesh.ts';
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
import type { SwayReach } from './geometry.ts';
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
	readonly #variants = new Map<string, number>();
	/** by id, the key of each variant, which shares its object's hash */
	readonly #variantKeys = new Map<number, string>();

	/**
	 * @param hash StringPathHash key
	 * @param resolve looks up the path, called once per new hash
	 * @returns the asset's id
	 */
	intern(hash: bigint, resolve: (hash: bigint) => string | undefined): number {
		return this.#ids.getOrInsertComputed(
			hash,
			() => this.assets.push({ hash, path: resolve(hash) ?? null }) - 1,
		);
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
		const hash = objectHash(key);
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
	 * interns a variant of a prefab dependency: the same object under an id of its own, for uses that change
	 * some of its values before it's converted (see {@link MaterialOverrides})
	 *
	 * @param ref resolved dependency
	 * @param variant tells variants of one object apart
	 * @returns the variant's id
	 */
	internObjectVariant(ref: ObjectRef, variant: string): number {
		const key = objectKey(ref);
		return this.#variants.getOrInsertComputed(`${key}/${variant}`, (variantKey) => {
			const id = this.assets.push({ hash: objectHash(key), path: key, locator: locateObject(ref) }) - 1;
			this.#variantKeys.set(id, variantKey);
			return id;
		});
	}

	/**
	 * @param id an asset id
	 * @returns a key naming the asset by what it is rather than by when it was first met, so orders built from
	 *   it don't shift when other assets come and go
	 */
	keyOf(id: number): string {
		return this.#variantKeys.get(id) ?? this.assets[id].hash.toString(16);
	}

	/**
	 * @param mesh a mesh the packer makes itself
	 * @returns its asset id
	 */
	internSynthetic(mesh: SyntheticMesh): number {
		const key = syntheticMeshKey(mesh);
		const hash = -BigInt(`0x${createHash('sha256').update(key).digest('hex')}`);
		return this.#ids.getOrInsertComputed(
			hash,
			() => this.assets.push({ hash, path: key, synthetic: mesh }) - 1,
		);
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

	/**
	 * @param ref mesh dependency
	 * @param motion the looping animation it plays
	 * @returns a geometry id distinct for each animation of the mesh
	 */
	internAnimatedObject(ref: ObjectRef, motion: RendererMotion): number {
		const key = objectKey(ref);
		const { kind, skin } = motion;
		const { matrices } = skin;
		const digest = createHash('sha256')
			.update(key)
			.update(`motion ${kind} ${skin.boneCount} ${skin.frameCount} ${skin.frameRate}`)
			.update(new Uint8Array(matrices.buffer, matrices.byteOffset, matrices.byteLength));
		const hash = -BigInt(`0x${digest.digest('hex')}`);
		return this.#ids.getOrInsertComputed(
			hash,
			() =>
				this.assets.push({
					hash,
					path: key,
					locator: locateObject(ref),
					motion: { kind, skin: { ...skin, matrices: matrices.slice() } },
				}) - 1,
		);
	}
}

/**
 * @param key an object's {@link objectKey}
 * @returns its hash; negative hashes occupy a namespace separate from unsigned game hashes
 */
const objectHash = (key: string): bigint => -BigInt(`0x${createHash('sha256').update(key).digest('hex')}`);

// #endregion

// #region conversion

/** what a material variant ({@link AssetIds.internObjectVariant}) changes */
export interface MaterialOverrides {
	/** saved values replaced before conversion, as a pose's clips set them */
	saved: MaterialValues;
}

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
	/** by material id, what its variant changes */
	materialOverrides: ReadonlyMap<number, MaterialOverrides>;
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

/** a material's debug-index row */
export interface MaterialDebug extends AssetDebug {
	shader: string | null;
	/** why the viewer can't draw the material (its surface is `unsupported`), or `null` */
	unsupported: string | null;
	/** keywords of the material's surface shader that the viewer doesn't draw */
	keywordsNotDrawn: string[];
	/** bound texture slots whose PPtr couldn't be followed, with the error; the slot is left empty */
	slotErrors: Record<string, string>;
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
	textures: TextureTable;
	/**
	 * per {@link AssetConversionInput.extraTextures} group and entry, its texture-table id, or `null` if it
	 * failed
	 */
	extraTextureIds: (number | null)[][];
	debug: {
		/**
		 * `tangentUvs`: when normal-mapped materials drawing the mesh read their normal maps on different uv
		 * sets, those sets ascending; its tangents follow the first, so the others shade with wrong tangents
		 */
		geometries: (AssetDebug & { tangentUvs?: number[] })[];
		materials: MaterialDebug[];
		/**
		 * by texture object, in first-use order; `id` is its texture-table entry, `approximations` the settings
		 * WebGPU can't express (absent when there are none)
		 */
		textures: (AssetDebug & { id: number; approximations?: string[] })[];
	};
	stats: {
		timings: Record<string, number>;
		geometry: BlobTally & {
			vertices: number;
			triangles: number;
			gpuBytes: number;
			generatedTangents: number;
			/** meshes with generated tangents whose normal-mapped materials disagree on the uv set */
			tangentUvConflicts: number;
		};
		/** texture blobs by piece: `tail`, or the level's largest dimension */
		texturePieces: Record<string, BlobTally>;
		textureFormats: Record<string, number>;
		/** texture objects whose content equalled an earlier texture's */
		textureDuplicates: number;
		failures: Record<string, number>;
		/** texture objects with a setting WebGPU can't express, by approximation */
		textureApproximations: Record<string, number>;
		/** distinct shaders the materials use, by declared properties */
		shaders: number;
		/** materials the viewer can't draw, by `<shader>: <reason>` */
		unsupportedMaterials: Record<string, number>;
		/** materials with a surface keyword the viewer doesn't draw, by `<shader> <keyword>` */
		keywordsNotDrawn: Record<string, number>;
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
	/** by material id, `null` where it failed */
	const convertedMaterials: (ConvertedMaterial | null)[] = [];
	const materialDebug: MaterialDebug[] = [];
	const keywordsNotDrawnCounts: Record<string, number> = {};
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
	// variants of one material share its load
	const loads = new Map<bigint, Promise<{ ref: ObjectRef; loaded: LoadedMaterial }>>();
	await orderedPool(
		input.materials,
		input.materialConcurrency,
		(asset) =>
			loads.getOrInsertComputed(asset.hash, async () => {
				const ref = await resolver.findUnique(asset, UnityClass.Material);
				return { ref, loaded: await loadMaterial(resolver, ref) };
			}),
		(result, _asset, id) => {
			if (result instanceof Error) {
				convertedMaterials.push(null);
				materialDebug.push({
					object: null,
					name: null,
					shader: null,
					error: fail('material', result),
					unsupported: null,
					keywordsNotDrawn: [],
					slotErrors: {},
				});
				normalMapUv.push(null);
				return;
			}
			const { ref, loaded } = result;
			const place = input.places.materials[id];
			const shader = shaders.intern(loaded.shader, loaded.classification.family);
			const overrides = input.materialOverrides.get(id);
			const slotErrors: Record<string, string> = {};
			const converted = convertMaterial(
				withSavedValues(loaded.record, overrides?.saved ?? null),
				loaded.classification,
				shader,
				(slot) => {
					const resolved = loaded.textures[slot];
					if (resolved?.error !== undefined) {
						slotErrors[slot] = resolved.error;
						fail('texture slot', new Error(resolved.error));
					}
					if (resolved?.ref == null) {
						return undefined;
					}
					return useTexture(resolved.ref, place);
				},
			);
			const notDrawn = keywordsNotDrawn(loaded.shader.name, converted.material.keywords);
			for (const keyword of notDrawn) {
				const key = `${loaded.shader.name} ${keyword}`;
				keywordsNotDrawnCounts[key] = (keywordsNotDrawnCounts[key] ?? 0) + 1;
			}
			// described once its textures have their final ids
			convertedMaterials.push(converted.material);
			materialDebug.push({
				object: objectKey(ref),
				name: loaded.record.name,
				shader: loaded.shader.name,
				error: null,
				unsupported: null,
				keywordsNotDrawn: notDrawn,
				slotErrors,
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
	// a mesh gets tangents when any draw of it uses a normal-mapped material, for the lowest uv set any of
	// them reads its normal map on
	const tangentUvs = Array.from({ length: input.geometries.length }, () => new Set<number>());
	for (const chain of input.chains) {
		for (const draw of chain.draws) {
			const uv = draw.material === null ? null : (normalMapUv[draw.material] ?? null);
			if (uv !== null) {
				tangentUvs[draw.geometry].add(uv);
			}
		}
	}
	const tangentUv = tangentUvs.map((uvs) => (uvs.size === 0 ? null : Math.min(...uvs)));
	// a mesh any swaying material draws carries sway weights, and bounds that hold the farthest sway
	const sway: (SwayReach | null)[] = Array.from({ length: input.geometries.length }, () => null);
	{
		const reaches = convertedMaterials.map((material) => {
			const swayed = material === null ? null : materialSway(material, shaders.shaders[material.shader]);
			return swayed === null ? null : swayReach(swayed);
		});
		for (const chain of input.chains) {
			for (const draw of chain.draws) {
				const reach = draw.material === null ? null : (reaches[draw.material] ?? null);
				const held = sway[draw.geometry];
				if (reach !== null) {
					sway[draw.geometry] =
						held === null
							? reach
							: {
									flat: Math.max(held.flat, reach.flat),
									perHeight: Math.max(held.perHeight, reach.perHeight),
								};
				}
			}
		}
	}
	const geometryEntries: GeometryEntry[] = [];
	const geometryDebug: AssetConversion['debug']['geometries'] = [];
	const geometry = {
		count: 0,
		stored: 0,
		raw: 0,
		vertices: 0,
		triangles: 0,
		gpuBytes: 0,
		generatedTangents: 0,
		tangentUvConflicts: 0,
	};
	await orderedPool(
		input.geometries,
		CONVERSIONS_IN_FLIGHT,
		(asset, id) =>
			convert({
				kind: 'geometry',
				asset,
				tangentUv: tangentUv[id],
				sway: sway[id],
				zstdLevel: input.geometryZstdLevel,
			}),
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
					stem: archives.stem(input.places.geometries[id]),
					locality: null,
				},
				geometry,
			);
			geometryEntries.push({ id, status: 'ready', blob, ...result.entry });
			const uvs = tangentUvs[id];
			geometryDebug.push({
				object: result.object,
				name: result.name,
				error: null,
				...(uvs.size > 1 && result.entry.tangentUv !== null
					? { tangentUvs: [...uvs].toSorted((a, b) => a - b) }
					: {}),
			});
			geometry.vertices += result.entry.vertexCount;
			geometry.triangles += result.entry.indexCount / 3;
			geometry.gpuBytes += result.gpuBytes;
			if (result.entry.tangentUv !== null) {
				geometry.generatedTangents++;
				if (uvs.size > 1) {
					geometry.tangentUvConflicts++;
				}
			}
		},
	);
	timer.end('geometry');
	// #endregion

	// #region textures
	const textureEntries: TextureEntry[] = [];
	const samplers: TextureSampler[] = [];
	const samplerIds = new Map<string, number>();
	const textureDebug: AssetConversion['debug']['textures'] = [];
	/** provisional (per object) → texture-table id */
	const textureIds: number[] = [];
	const byContent = new Map<string, number>();
	const texturePieces: Record<string, BlobTally> = {};
	const textureFormats: Record<string, number> = {};
	let textureDuplicates = 0;
	const textureApproximations: Record<string, number> = {};
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
			for (const approximation of result.approximations) {
				textureApproximations[approximation] = (textureApproximations[approximation] ?? 0) + 1;
			}
			const approximations =
				result.approximations.length === 0 ? {} : { approximations: result.approximations };
			const twin = byContent.get(result.contentKey);
			if (twin !== undefined) {
				textureDuplicates++;
				textureIds.push(twin);
				textureDebug.push({ object: object.key, name, error: null, id: twin, ...approximations });
				return;
			}
			const id = textureEntries.length;
			byContent.set(result.contentKey, id);
			textureIds.push(id);
			textureFormats[result.entry.format] = (textureFormats[result.entry.format] ?? 0) + 1;
			const stem = archives.stem(object.place);
			const sampler = samplerIds.getOrInsertComputed(
				JSON.stringify(result.entry.sampler),
				() => samplers.push(result.entry.sampler) - 1,
			);
			textureEntries.push({
				id,
				status: 'ready',
				...result.entry,
				sampler,
				pieces: pieces.map((piece, i) => {
					const { width, height } = textureLevelLayout(result.entry, piece.firstLevel);
					const group = i === 0 && piece.levelCount > 1 ? 'tail' : String(Math.max(width, height));
					texturePieces[group] ??= { count: 0, stored: 0, raw: 0 };
					// a texture's pieces sit together under its tail's hash, coarse to fine
					const placement: BlobPlacement = {
						kind: BlobKind.Texture,
						stem,
						locality: `${pieces[0].blob.hash}.${i.toString(16).padStart(2, '0')}`,
					};
					return {
						blob: commit(store, piece.blob, placement, texturePieces[group]),
						firstLevel: piece.firstLevel,
						levelCount: piece.levelCount,
					};
				}),
			});
			textureDebug.push({ object: object.key, name, error: null, id, ...approximations });
		},
	);
	// slots referenced textures by object; point them at the deduplicated entries
	for (const material of convertedMaterials) {
		if (material !== null) {
			remapSlots(material, textureIds);
		}
	}
	timer.end('textures');
	// #endregion

	// #region surfaces
	const unsupportedMaterials: Record<string, number> = {};
	const materialEntries: MaterialEntry[] = convertedMaterials.map((material, id) => {
		if (material === null) {
			return { id, status: 'failed' };
		}
		const shader = shaders.shaders[material.shader];
		const surface = describeMaterial(material, shader);
		if (surface.kind === 'unsupported') {
			const key = `${shader.name}: ${surface.reason}`;
			unsupportedMaterials[key] = (unsupportedMaterials[key] ?? 0) + 1;
			materialDebug[id].unsupported = surface.reason;
		}
		return { id, status: 'ready', cull: material.cull, surface };
	});
	// #endregion

	return {
		geometries: geometryEntries,
		materials: { entries: materialEntries },
		textures: { samplers, entries: textureEntries },
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
			textureApproximations,
			shaders: shaders.shaders.length,
			unsupportedMaterials,
			keywordsNotDrawn: keywordsNotDrawnCounts,
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
	materials: { entries: Array.from({ length: materials }, (_, id) => ({ id, status: 'pending' })) },
	textures: { samplers: [], entries: [] },
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

/**
 * @returns the record with the given saved values replaced, ints kept among the ints; the record itself when
 *   there are none
 */
const withSavedValues = (record: MaterialRecord, saved: MaterialValues | null): MaterialRecord => {
	if (saved === null) {
		return record;
	}
	const floats = { ...record.floats };
	const ints = { ...record.ints };
	for (const [name, value] of Object.entries(saved.floats)) {
		if (Object.hasOwn(ints, name)) {
			ints[name] = value;
		} else {
			floats[name] = value;
		}
	}
	const textures = { ...record.textures };
	for (const [name, transform] of Object.entries(saved.textures)) {
		if (Object.hasOwn(textures, name)) {
			textures[name] = { ...textures[name], ...transform };
		}
	}
	return { ...record, floats, ints, colors: { ...record.colors, ...saved.colors }, textures };
};

/**
 * how far a sway moves a vertex of full weight (`docs/game-data/materials.md#swaying-cloth`): the offset is
 * `(s + 1 + tendency) · amplitude`, where a kite's sine `s` is scaled by the object-space height and its
 * amplitude is `intensity · 0.05`, and a wave's amplitude is `intensity · 0.5`
 */
const swayReach = ({ intensity, kite, tendency }: LitSway): SwayReach => {
	const offset = Math.abs(1 + tendency);
	if (kite !== 0) {
		const amplitude = Math.abs(intensity) * 0.05;
		return { flat: amplitude * offset, perHeight: amplitude };
	}
	return { flat: Math.abs(intensity) * 0.5 * (1 + offset), perHeight: 0 };
};

/** rewrites a material's slots from per-object ids to texture-table ids, in place (the entry is ours) */
const remapSlots = (material: ConvertedMaterial, ids: readonly number[]): void => {
	for (const slot of Object.values(material.slots)) {
		slot.texture = ids[slot.texture];
	}
};

// #endregion
