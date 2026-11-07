import type { MaterialRecord, ShaderSummary } from '@endfield-noclip/formats/unity/material';
import { BlobKind } from '@endfield-noclip/package-format/blobs';
import type { GeometryEntry } from '@endfield-noclip/package-format/geometry';
import type { Chain } from '@endfield-noclip/package-format/instances';
import type { MaterialEntry, MaterialTable } from '@endfield-noclip/package-format/materials';
import type { LitSway } from '@endfield-noclip/package-format/surfaces';
import {
	type TextureEntry,
	textureLevelLayout,
	type TextureSampler,
} from '@endfield-noclip/package-format/textures';

import { failureReason } from '../../errors.ts';
import {
	type AssetRef,
	type AssetResolver,
	type ObjectLocator,
	type ObjectRef,
	recordBundleReads,
} from '../../game/assets/assets.ts';
import { describeMaterial, materialSway } from '../../game/materials/material-describe.ts';
import {
	type LocatedMaterial,
	type LocatedObject,
	locatedObject,
	locateMaterial,
} from '../../game/materials/material-load.ts';
import type { MaterialValues as ConvertedMaterial } from '../../game/materials/material-values.ts';
import { keywordsNotDrawn } from '../../game/materials/surfaces/surface-keywords.ts';
import type { MaterialValues } from '../../game/prefabs/prefab.ts';
import { orderedPool } from '../../pool.ts';
import { PhaseTimer } from '../phase-timer.ts';
import type { BlobMeta } from '../store/blob-file.ts';
import type { BlobPlacement, BlobStore } from '../store/blob-store.ts';
import type { PackCache } from '../store/pack-cache.ts';

import { type AssetArchives, type Place, mergePlaces } from './asset-placement.ts';
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

// converting the assets the packer referenced (by the ids `AssetIds` handed out) reads materials first (they
// decide which meshes need tangents and which textures are used), then meshes, then textures, then describes
// the materials' surfaces once their textures have their final ids. meshes and textures convert on worker
// threads; each stage stores results in id order, so the package is deterministic.

// #region types

/** what a material variant (`AssetIds.internObjectVariant`) changes */
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
	/** the texture table's sampler palette and entries */
	textures: { samplers: TextureSampler[]; entries: TextureEntry[] };
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
		geometry: GeometryTally;
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

/** geometry blob sizes and mesh totals */
interface GeometryTally extends BlobTally {
	vertices: number;
	triangles: number;
	gpuBytes: number;
	generatedTangents: number;
	/** meshes with generated tangents whose normal-mapped materials disagree on the uv set */
	tangentUvConflicts: number;
}

// #endregion

// #region conversion

/**
 * converts every referenced material, geometry and texture into blobs and table entries
 *
 * @param input assets, chains, placements and the blob store
 * @returns the tables, debug rows and statistics
 */
export const convertAssets = async (input: AssetConversionInput): Promise<AssetConversion> => {
	const jobs = new ConvertJobs(input);
	const timer = new PhaseTimer(input.log);
	const textureUses = new TextureUses();
	const materials = await loadMaterials(input, jobs, textureUses);
	const extraIndices = input.extraTextures.map((group) =>
		group.map(({ ref, place }) => textureUses.use(locatedObject(ref), place)),
	);
	timer.end('materials');
	const geometries = await convertGeometries(input, jobs, meshNeeds(input, materials));
	timer.end('geometry');
	const textures = await convertTextures(input, jobs, textureUses.objects);
	// slots referenced textures by object; point them at the deduplicated entries
	for (const material of materials.converted) {
		if (material !== null) {
			remapSlots(material, textures.ids);
		}
	}
	timer.end('textures');
	const surfaces = describeSurfaces(materials);
	return {
		geometries: geometries.entries,
		materials: { entries: surfaces.entries },
		textures: { samplers: textures.samplers, entries: textures.entries },
		extraTextureIds: extraIndices.map((group) =>
			group.map((index) => {
				const id = textures.ids[index];
				return textures.entries[id]?.status === 'ready' ? id : null;
			}),
		),
		debug: { geometries: geometries.debug, materials: materials.debug, textures: textures.debug },
		stats: {
			timings: timer.timings,
			geometry: geometries.tally,
			texturePieces: textures.pieces,
			textureFormats: textures.formats,
			textureDuplicates: textures.duplicates,
			failures: jobs.failures,
			textureApproximations: textures.approximations,
			shaders: materials.shaders.shaders.length,
			unsupportedMaterials: surfaces.unsupported,
			keywordsNotDrawn: materials.keywordsNotDrawn,
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
	geometries: Array.from({ length: geometries }, () => ({ status: 'pending' })),
	materials: { entries: Array.from({ length: materials }, () => ({ status: 'pending' })) },
	textures: { samplers: [], entries: [] },
	extraTextureIds: extraTextures.map((group) => group.map(() => null)),
});

/** runs conversion jobs on the pool or recalls them from the cache, and counts failures by reason */
class ConvertJobs {
	readonly failures: Record<string, number> = {};
	readonly #input: Pick<AssetConversionInput, 'resolver' | 'pool' | 'cache'>;
	/** shader summaries by shader object, recalled or loaded this pack; `undefined` where the cache had none */
	readonly #shaders = new Map<string, Promise<ShaderSummary | undefined>>();

	constructor(input: Pick<AssetConversionInput, 'resolver' | 'pool' | 'cache'>) {
		this.#input = input;
	}

	/** @returns the job's result, from the cache when every bundle it read is unchanged */
	async run<J extends ConvertJob>(job: J): Promise<ConvertResultOf<J>> {
		const { pool, cache } = this.#input;
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
		const recalled = await cache.recall(key, (sources) => this.#sourcesCurrent(sources));
		if (recalled !== undefined) {
			return ofJob(recalled);
		}
		const result = await pool.run(job);
		await cache.remember(key, result);
		return ofJob(result);
	}

	/**
	 * @returns the material located on the main thread, or from the cache when every bundle it read is
	 *   unchanged
	 */
	async material(asset: AssetRef): Promise<LocatedMaterial> {
		const { resolver, cache } = this.#input;
		if (cache === null) {
			return locateMaterial(resolver, asset);
		}
		const key = await cache.stepKey(MATERIAL_LOAD_ENTRY, { asset });
		const recalled = await cache.recallValue<MaterialMemo>(key);
		if (recalled !== undefined && (await this.#sourcesCurrent(recalled.sources))) {
			const shader = await this.#shaders.getOrInsertComputed(recalled.material.shaderObject.key, async () =>
				cache.recallValue<ShaderSummary>(await this.#shaderKey(cache, recalled.material.shaderObject)),
			);
			if (shader !== undefined) {
				cache.hits.materials++;
				return { ...recalled.material, shader };
			}
		}
		const { result, bundles } = await recordBundleReads(() => locateMaterial(resolver, asset));
		const sources = await Promise.all(
			bundles.map(async (index) => ({
				bundle: resolver.manifest.bundleName(index),
				md5: await resolver.bundleMd5(index),
			})),
		);
		// a shader's summary is most of a material's load and shared by thousands of them, so it's stored once
		const { shader, ...material } = result;
		// stored by the first fresh load of each shader, including one whose summary the cache didn't have
		if ((await this.#shaders.get(result.shaderObject.key)) === undefined) {
			this.#shaders.set(result.shaderObject.key, Promise.resolve(shader));
			await cache.rememberValue(await this.#shaderKey(cache, result.shaderObject), shader);
		}
		await cache.rememberValue(key, { sources, material } satisfies MaterialMemo);
		return result;
	}

	/** @returns the cache key of a shader's summary, which its bundle's md5 keeps current */
	async #shaderKey(cache: PackCache, { key, locator }: LocatedObject): Promise<string> {
		const md5 = await this.#input.resolver.bundleMd5(locator.bundleIndex);
		return cache.stepKey(MATERIAL_LOAD_ENTRY, { shader: key, md5 });
	}

	/** counts a failure by kind and reason; @returns the error's message, for the debug index */
	fail(kind: string, error: Error): string {
		const reason = `${kind}: ${failureReason(error)}`;
		this.failures[reason] = (this.failures[reason] ?? 0) + 1;
		return error.message;
	}

	/** @returns whether every bundle still has the md5 it had when the conversion read it */
	async #sourcesCurrent(sources: readonly BundleSource[]): Promise<boolean> {
		const { resolver } = this.#input;
		const md5s = await Promise.all(
			sources.map(async ({ bundle }) => {
				const index = resolver.manifest.findBundle(bundle);
				return index === undefined ? undefined : resolver.bundleMd5(index);
			}),
		);
		return sources.every(({ md5 }, i) => md5s[i] === md5);
	}
}

/** texture objects in first-use order, each with a provisional id and the places of its uses */
class TextureUses {
	readonly objects: { key: string; locator: ObjectLocator; place: Place }[] = [];
	readonly #index = new Map<string, number>();

	/** @returns the texture's provisional id */
	use({ key, locator }: LocatedObject, place: Place): number {
		let index = this.#index.get(key);
		if (index === undefined) {
			index = this.objects.length;
			this.#index.set(key, index);
			this.objects.push({ key, locator, place });
		} else {
			this.objects[index].place = mergePlaces(this.objects[index].place, place);
		}
		return index;
	}
}

// #endregion

// #region materials

/** the module whose import graph decides a material load; changing any of it misses the cached loads */
const MATERIAL_LOAD_ENTRY = new URL('../../game/materials/material-load.ts', import.meta.url);

/** a cached material load, its shader summary stored on its own, and the bundles it read */
interface MaterialMemo {
	sources: BundleSource[];
	material: Omit<LocatedMaterial, 'shader'>;
}

/** the materials loaded and converted, by material id */
interface LoadedMaterials {
	shaders: ShaderTable;
	/** `null` where the material failed */
	converted: (ConvertedMaterial | null)[];
	debug: MaterialDebug[];
	/** materials with a surface keyword the viewer doesn't draw, by `<shader> <keyword>` */
	keywordsNotDrawn: Record<string, number>;
	/** the uv set the material reads its normal map on, `null` without one */
	normalMapUv: (number | null)[];
}

/** loads and converts every material, noting the textures it binds in first-use order */
const loadMaterials = async (
	input: AssetConversionInput,
	jobs: ConvertJobs,
	textures: TextureUses,
): Promise<LoadedMaterials> => {
	const out: LoadedMaterials = {
		shaders: new ShaderTable(),
		converted: [],
		debug: [],
		keywordsNotDrawn: {},
		normalMapUv: [],
	};
	// variants of one material share its load
	const loads = new Map<bigint, Promise<LocatedMaterial>>();
	await orderedPool(
		input.materials,
		input.materialConcurrency,
		(asset) => loads.getOrInsertComputed(asset.hash, () => jobs.material(asset)),
		(result, _asset, id) => {
			if (result instanceof Error) {
				out.converted.push(null);
				out.debug.push({
					object: null,
					name: null,
					shader: null,
					error: jobs.fail('material', result),
					unsupported: null,
					keywordsNotDrawn: [],
					slotErrors: {},
				});
				out.normalMapUv.push(null);
				return;
			}
			const loaded = result;
			const place = input.places.materials[id];
			const shader = out.shaders.intern(loaded.shader, loaded.classification.family);
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
						jobs.fail('texture slot', new Error(resolved.error));
					}
					if (resolved?.texture == null) {
						return undefined;
					}
					return textures.use(resolved.texture, place);
				},
			);
			const notDrawn = keywordsNotDrawn(loaded.shader.name, converted.material.keywords);
			for (const keyword of notDrawn) {
				const key = `${loaded.shader.name} ${keyword}`;
				out.keywordsNotDrawn[key] = (out.keywordsNotDrawn[key] ?? 0) + 1;
			}
			// described once its textures have their final ids
			out.converted.push(converted.material);
			out.debug.push({
				object: loaded.object,
				name: loaded.record.name,
				shader: loaded.shader.name,
				error: null,
				unsupported: null,
				keywordsNotDrawn: notDrawn,
				slotErrors,
			});
			out.normalMapUv.push(converted.normalMapUv);
		},
	);
	return out;
};

/** describes each converted material's surface, recording the ones the viewer can't draw in their debug rows */
const describeSurfaces = (
	materials: LoadedMaterials,
): { entries: MaterialEntry[]; unsupported: Record<string, number> } => {
	const unsupported: Record<string, number> = {};
	const entries = materials.converted.map((material, id): MaterialEntry => {
		if (material === null) {
			return { status: 'failed' };
		}
		const shader = materials.shaders.shaders[material.shader];
		const surface = describeMaterial(material, shader);
		if (surface.kind === 'unsupported') {
			const key = `${shader.name}: ${surface.reason}`;
			unsupported[key] = (unsupported[key] ?? 0) + 1;
			materials.debug[id].unsupported = surface.reason;
		}
		return { status: 'ready', cull: material.cull, surface };
	});
	return { entries, unsupported };
};

// #endregion

// #region geometry

/** what each mesh needs of its conversion, from the materials drawing it */
interface MeshNeeds {
	/** the uv sets its normal-mapped materials read their normal maps on */
	tangentUvs: Set<number>[];
	/** the lowest of those, which its tangents follow, `null` without one */
	tangentUv: (number | null)[];
	/** the farthest any swaying material moves it, `null` without one */
	sway: (SwayReach | null)[];
}

/**
 * a mesh gets tangents when any draw of it uses a normal-mapped material, for the lowest uv set any of them
 * reads its normal map on; a mesh any swaying material draws carries sway weights, and bounds that hold the
 * farthest sway
 */
const meshNeeds = (input: AssetConversionInput, materials: LoadedMaterials): MeshNeeds => {
	const count = input.geometries.length;
	const tangentUvs = Array.from({ length: count }, () => new Set<number>());
	const sway: (SwayReach | null)[] = Array.from({ length: count }, () => null);
	const reaches = materials.converted.map((material) => {
		const swayed =
			material === null ? null : materialSway(material, materials.shaders.shaders[material.shader]);
		return swayed === null ? null : swayReach(swayed);
	});
	for (const chain of input.chains) {
		for (const draw of chain.draws) {
			const uv = draw.material === null ? null : (materials.normalMapUv[draw.material] ?? null);
			if (uv !== null) {
				tangentUvs[draw.geometry].add(uv);
			}
		}
	}
	for (const chain of input.chains) {
		for (const draw of chain.draws) {
			const reach = draw.material === null ? null : (reaches[draw.material] ?? null);
			const held = sway[draw.geometry];
			if (reach !== null) {
				sway[draw.geometry] =
					held === null
						? reach
						: { flat: Math.max(held.flat, reach.flat), perHeight: Math.max(held.perHeight, reach.perHeight) };
			}
		}
	}
	return {
		tangentUvs,
		tangentUv: tangentUvs.map((uvs) => (uvs.size === 0 ? null : Math.min(...uvs))),
		sway,
	};
};

/** converts every mesh and commits its blob */
const convertGeometries = async (
	input: AssetConversionInput,
	jobs: ConvertJobs,
	needs: MeshNeeds,
): Promise<{
	entries: GeometryEntry[];
	debug: AssetConversion['debug']['geometries'];
	tally: GeometryTally;
}> => {
	const entries: GeometryEntry[] = [];
	const debug: AssetConversion['debug']['geometries'] = [];
	const tally: GeometryTally = {
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
			jobs.run({
				kind: 'geometry',
				asset,
				tangentUv: needs.tangentUv[id],
				sway: needs.sway[id],
				zstdLevel: input.geometryZstdLevel,
			}),
		(result, _asset, id) => {
			if (result instanceof Error) {
				entries.push({ status: 'failed' });
				debug.push({ object: null, name: null, error: jobs.fail('geometry', result) });
				return;
			}
			const blob = commit(
				input.store,
				result.blob,
				{ kind: BlobKind.Geometry, stem: input.archives.stem(input.places.geometries[id]), locality: null },
				tally,
			);
			entries.push({ status: 'ready', blob, ...result.entry });
			const uvs = needs.tangentUvs[id];
			debug.push({
				object: result.object,
				name: result.name,
				error: null,
				...(uvs.size > 1 && result.entry.tangentUv !== null
					? { tangentUvs: [...uvs].toSorted((a, b) => a - b) }
					: {}),
			});
			tally.vertices += result.entry.vertexCount;
			tally.triangles += result.entry.indexCount / 3;
			tally.gpuBytes += result.gpuBytes;
			if (result.entry.tangentUv !== null) {
				tally.generatedTangents++;
				if (uvs.size > 1) {
					tally.tangentUvConflicts++;
				}
			}
		},
	);
	return { entries, debug, tally };
};

// #endregion

// #region textures

/** the converted textures */
interface ConvertedTextures {
	entries: TextureEntry[];
	samplers: TextureSampler[];
	debug: AssetConversion['debug']['textures'];
	/** by provisional id (per object), its texture-table id */
	ids: number[];
	pieces: Record<string, BlobTally>;
	formats: Record<string, number>;
	duplicates: number;
	approximations: Record<string, number>;
}

/** converts every texture object, storing equal contents once and their pieces together */
const convertTextures = async (
	input: AssetConversionInput,
	jobs: ConvertJobs,
	objects: TextureUses['objects'],
): Promise<ConvertedTextures> => {
	const out: ConvertedTextures = {
		entries: [],
		samplers: [],
		debug: [],
		ids: [],
		pieces: {},
		formats: {},
		duplicates: 0,
		approximations: {},
	};
	const samplerIds = new Map<string, number>();
	const byContent = new Map<string, number>();
	await orderedPool(
		objects,
		CONVERSIONS_IN_FLIGHT,
		(object) => jobs.run({ kind: 'texture', locator: object.locator, zstdLevel: input.textureZstdLevel }),
		(result, object) => {
			if (result instanceof Error) {
				out.ids.push(out.entries.length);
				out.debug.push({
					object: object.key,
					name: null,
					error: jobs.fail('texture', result),
					id: out.entries.length,
				});
				out.entries.push({ status: 'failed' });
				return;
			}
			const { name, pieces } = result;
			for (const approximation of result.approximations) {
				out.approximations[approximation] = (out.approximations[approximation] ?? 0) + 1;
			}
			const approximations =
				result.approximations.length === 0 ? {} : { approximations: result.approximations };
			const twin = byContent.get(result.contentKey);
			if (twin !== undefined) {
				out.duplicates++;
				out.ids.push(twin);
				out.debug.push({ object: object.key, name, error: null, id: twin, ...approximations });
				return;
			}
			const id = out.entries.length;
			byContent.set(result.contentKey, id);
			out.ids.push(id);
			out.formats[result.entry.format] = (out.formats[result.entry.format] ?? 0) + 1;
			const stem = input.archives.stem(object.place);
			const sampler = samplerIds.getOrInsertComputed(
				JSON.stringify(result.entry.sampler),
				() => out.samplers.push(result.entry.sampler) - 1,
			);
			out.entries.push({
				status: 'ready',
				...result.entry,
				sampler,
				pieces: pieces.map((piece, i) => {
					const { width, height } = textureLevelLayout(result.entry, piece.firstLevel);
					const group = i === 0 && piece.levelCount > 1 ? 'tail' : String(Math.max(width, height));
					out.pieces[group] ??= { count: 0, stored: 0, raw: 0 };
					// a texture's pieces sit together under its tail's hash, coarse to fine
					const placement: BlobPlacement = {
						kind: BlobKind.Texture,
						stem,
						locality: `${pieces[0].blob.hash}.${i.toString(16).padStart(2, '0')}`,
					};
					return {
						blob: commit(input.store, piece.blob, placement, out.pieces[group]),
						firstLevel: piece.firstLevel,
						levelCount: piece.levelCount,
					};
				}),
			});
			out.debug.push({ object: object.key, name, error: null, id, ...approximations });
		},
	);
	return out;
};

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
