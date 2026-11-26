import type { WaterDecal } from '@endfield-noclip/formats/endfield/init-chunk-data';
import type { MaterialRecord, ShaderSummary } from '@endfield-noclip/formats/unity/material';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import { BlobKind } from '@endfield-noclip/package-format/blobs';
import type { GeometryEntry } from '@endfield-noclip/package-format/geometry';
import type { Chain } from '@endfield-noclip/package-format/instances';
import type { MaterialEntry, MaterialMotion, MaterialTable } from '@endfield-noclip/package-format/materials';
import type { LitSway, LitVertexOffset } from '@endfield-noclip/package-format/surfaces';
import {
	type TextureEntry,
	textureLevelLayout,
	type TextureSampler,
} from '@endfield-noclip/package-format/textures';

import {
	type AssetRef,
	type AssetResolver,
	type LocatedObject,
	locatedObject,
	type ObjectLocator,
	type ObjectRef,
	recordBundleReads,
} from '../../game/assets/assets.ts';
import { placedWaterFoam } from '../../game/materials/effects/water-foam.ts';
import {
	describeMaterial,
	materialVat,
	materialSway,
	materialVertexOffset,
} from '../../game/materials/material-describe.ts';
import { type LocatedMaterial, locateMaterial } from '../../game/materials/material-load.ts';
import { type MaterialValues as ConvertedMaterial, readerOf } from '../../game/materials/material-values.ts';
import {
	placedSludge,
	SLUDGE_HEIGHTMAP_SLOT,
	type SludgePatchParams,
} from '../../game/materials/surfaces/sludge.ts';
import { keywordsNotDrawn, surfaceGaps } from '../../game/materials/surfaces/surface-keywords.ts';
import type { MaterialValues } from '../../game/prefabs/prefab.ts';
import { bundleSources, sourcesCurrent } from '../../ir/bundle-memo.ts';
import { compareNumbers } from '../../util/compare.ts';
import { errorText, failureReason } from '../../util/errors.ts';
import { orderedPool } from '../../util/pool.ts';
import type { BlobMeta } from '../cache/blob-file.ts';
import type { BlobPlacement, BlobStore } from '../cache/blob-store.ts';
import type { PackCache } from '../cache/pack-cache.ts';
import { PhaseTimer } from '../phase-timer.ts';

import { type AssetArchives, type Place, mergePlaces } from './asset-placement.ts';
import {
	type BundleSource,
	type ConvertJob,
	type ConvertPool,
	type ConvertResult,
	type ConvertResultOf,
	resultMatches,
} from './convert-pool.ts';
import type { OffsetReach, SwayReach } from './geometry.ts';
import { surfaceMotion } from './material-motion.ts';
import { convertMaterial, ShaderTable } from './materials.ts';
import type { VatBake } from './vat-skin.ts';

// converting the assets the packer referenced (by the ids `AssetIds` handed out) reads materials first (they
// decide which meshes need tangents and which textures are used), then meshes, then textures, then describes
// the materials' surfaces once their textures have their final ids. meshes and textures convert on worker
// threads; each stage stores results in id order, so the package is deterministic.

// #region types

/** a sludge patch's per-placement heightmap and dimensions, folded into its material variant */
export interface SludgeMaterialOverride extends SludgePatchParams {
	/** heightmap texture asset ref (`Slu__<level>__<id>.png`) */
	heightmap: AssetRef;
}

/** what a material variant (`AssetIds.internObjectVariant`, `internVariant`) changes */
export interface MaterialOverrides {
	/** saved values replaced before conversion, as a pose's clips set them, or `null` */
	saved: MaterialValues | null;
	/** a static WaterDecal box's renderer values, folded into its foam once described, or `null` */
	waterDecal: WaterDecal | null;
	/** a sprayable sludge patch's heightmap and dimensions, folded in once described, or `null` */
	sludge?: SludgeMaterialOverride | null;
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
	/** optional max packed texture edge in texels (omits top mip piece blobs) */
	maxTextureSize?: number | null;
	/** materials decoded at once */
	materialConcurrency: number;
	log: (line: string) => void;
}

/** a texture referenced outside materials, and where its blobs go */
export interface PlacedTexture {
	ref: ObjectRef | LocatedObject;
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
	/** why the game draws nothing visible with the material (its surface is `undrawn`), or `null` */
	undrawn: string | null;
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
	/** per input geometry id, its deduplicated index in {@link geometries} */
	geometryIds: number[];
	/** per input material id, its deduplicated index in {@link materials} */
	materialIds: number[];
	/** surviving geometry {@link AssetRef}s in compacted table order, for `debug/assets.json` */
	geometryRefs: AssetRef[];
	/** surviving material {@link AssetRef}s in compacted table order, for `debug/assets.json` */
	materialRefs: AssetRef[];
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
		 * sets, those sets ascending; its tangents follow the first, so the others shade with wrong tangents.
		 * `unanimated`: why a mesh drawn with a vertex animation holds still
		 */
		geometries: (AssetDebug & { tangentUvs?: number[]; unanimated?: string })[];
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
		group.map(({ ref, place }) => textureUses.use('locator' in ref ? ref : locatedObject(ref), place)),
	);
	timer.end('materials');
	// textures don't depend on geometry, so both share the worker pool; start geometry first so its initial
	// window enters the queue ahead of textures, and commit geometry before textures so blob indices stay
	// identical to running them sequentially
	const geometryJobs = convertGeometries(input, jobs, meshNeeds(input, materials, textureUses));
	const textureJobs = startTextureJobs(input, jobs, textureUses.objects);
	const geometries = await geometryJobs;
	timer.end('geometry');
	const textures = await finishTextures(input, jobs, textureUses.objects, textureJobs);
	// slots referenced textures by object; point them at the deduplicated entries
	for (const material of materials.converted) {
		if (material !== null) {
			remapSlots(material, textures.ids);
		}
	}
	timer.end('textures');
	const surfaces = describeSurfaces(materials, input.materialOverrides);
	const dedupedGeometries = compactGeometries(geometries.entries, geometries.debug, input.geometries);
	const dedupedMaterials = compactMaterials(surfaces.entries, materials.debug, input.materials);
	return {
		geometries: dedupedGeometries.entries,
		materials: { entries: dedupedMaterials.entries },
		geometryIds: dedupedGeometries.ids,
		materialIds: dedupedMaterials.ids,
		geometryRefs: dedupedGeometries.refs,
		materialRefs: dedupedMaterials.refs,
		textures: { samplers: textures.samplers, entries: textures.entries },
		extraTextureIds: extraIndices.map((group) =>
			group.map((index) => {
				const id = textures.ids[index];
				return textures.entries[id]?.status === 'ready' ? id : null;
			}),
		),
		debug: {
			geometries: dedupedGeometries.debug,
			materials: dedupedMaterials.debug,
			textures: textures.debug,
		},
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
	geometries: readonly AssetRef[],
	materials: readonly AssetRef[],
	extraTextures: readonly (readonly PlacedTexture[])[],
): Pick<
	AssetConversion,
	| 'geometries'
	| 'materials'
	| 'geometryIds'
	| 'materialIds'
	| 'geometryRefs'
	| 'materialRefs'
	| 'textures'
	| 'extraTextureIds'
> => ({
	geometries: Array.from({ length: geometries.length }, () => ({ status: 'pending' })),
	materials: { entries: Array.from({ length: materials.length }, () => ({ status: 'pending' })) },
	geometryIds: Array.from({ length: geometries.length }, (_, i) => i),
	materialIds: Array.from({ length: materials.length }, (_, i) => i),
	geometryRefs: [...geometries],
	materialRefs: [...materials],
	textures: { samplers: [], entries: [] },
	extraTextureIds: extraTextures.map((group) => group.map(() => null)),
});

/** deduplicates identical ready geometry entries (e.g. static path-hash + prefab PPtr refs to the same mesh) */
const compactGeometries = (
	entries: readonly GeometryEntry[],
	debug: AssetConversion['debug']['geometries'],
	refs: readonly AssetRef[],
): {
	entries: GeometryEntry[];
	debug: AssetConversion['debug']['geometries'];
	refs: AssetRef[];
	ids: number[];
} => {
	const outEntries: GeometryEntry[] = [];
	const outDebug: AssetConversion['debug']['geometries'] = [];
	const outRefs: AssetRef[] = [];
	const ids: number[] = [];
	const byKey = new Map<string, number>();
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.status === 'ready') {
			const key = `${entry.blob}:${entry.vertexCount}:${entry.indexCount}:${entry.submeshCount}:${entry.attributes}:${entry.tangentUv ?? ''}:${entry.animationFrames ?? ''}`;
			const existing = byKey.get(key);
			if (existing !== undefined) {
				ids.push(existing);
				continue;
			}
			const next = outEntries.length;
			byKey.set(key, next);
			ids.push(next);
			outEntries.push(entry);
			outDebug.push(debug[i]);
			outRefs.push(refs[i]);
		} else {
			ids.push(outEntries.length);
			outEntries.push(entry);
			outDebug.push(debug[i]);
			outRefs.push(refs[i]);
		}
	}
	return { entries: outEntries, debug: outDebug, refs: outRefs, ids };
};

/**
 * deduplicates identical ready material entries (e.g. static path-hash + prefab PPtr refs to the same
 * material)
 */
const compactMaterials = (
	entries: readonly MaterialEntry[],
	debug: MaterialDebug[],
	refs: readonly AssetRef[],
): {
	entries: MaterialEntry[];
	debug: MaterialDebug[];
	refs: AssetRef[];
	ids: number[];
} => {
	const outEntries: MaterialEntry[] = [];
	const outDebug: MaterialDebug[] = [];
	const outRefs: AssetRef[] = [];
	const ids: number[] = [];
	const byKey = new Map<string, number>();
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.status === 'ready') {
			const key = JSON.stringify(entry);
			const existing = byKey.get(key);
			if (existing !== undefined) {
				ids.push(existing);
				continue;
			}
			const next = outEntries.length;
			byKey.set(key, next);
			ids.push(next);
			outEntries.push(entry);
			outDebug.push(debug[i]);
			outRefs.push(refs[i]);
		} else {
			ids.push(outEntries.length);
			outEntries.push(entry);
			outDebug.push(debug[i]);
			outRefs.push(refs[i]);
		}
	}
	return { entries: outEntries, debug: outDebug, refs: outRefs, ids };
};

/** runs conversion jobs on the pool or recalls them from the cache, and counts failures by reason */
class ConvertJobs {
	readonly failures: Record<string, number> = {};
	readonly #input: Pick<AssetConversionInput, 'resolver' | 'pool' | 'cache'>;
	/** shader summaries by shader object, recalled or loaded this pack; `undefined` where the cache had none */
	readonly #shaders = new Map<string, Promise<ShaderSummary | undefined>>();
	#materialFp: Promise<string> | undefined;

	constructor(input: Pick<AssetConversionInput, 'resolver' | 'pool' | 'cache'>) {
		this.#input = input;
	}

	/** @returns the job's result, from the cache when every bundle it read is unchanged */
	async run<J extends ConvertJob>(job: J, affinity?: number): Promise<ConvertResultOf<J>> {
		const { pool, cache } = this.#input;
		const ofJob = (result: ConvertResult): ConvertResultOf<J> => {
			if (result.kind === 'failed') {
				throw new Error(result.error);
			}
			if (!resultMatches(job, result)) {
				throw new Error(`a ${job.kind} job returned a ${result.kind}`);
			}
			return result;
		};
		if (cache === null) {
			return ofJob(await pool.run(job, affinity));
		}
		const key = cache.key(job.kind, job);
		const recalled = await cache.recall(key, (sources, manifestHash) =>
			this.#sourcesCurrent(sources, manifestHash),
		);
		if (recalled !== undefined) {
			return ofJob(recalled);
		}
		const result = await pool.run(job, affinity);
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
		const fp = await (this.#materialFp ??= cache.fingerprint(MATERIAL_LOAD_ENTRY));
		const key = cache.keyWith(fp, { asset });
		const recalled = await cache.recallValue<MaterialMemo>(key);
		if (recalled !== undefined) {
			const manifestHash = 'error' in recalled ? recalled.manifestHash : undefined;
			if (await this.#sourcesCurrent(recalled.sources, manifestHash)) {
				if ('error' in recalled) {
					cache.hits.materials++;
					throw new Error(recalled.error);
				}
				const relocated = this.#relocated(recalled);
				if (relocated !== undefined) {
					const shader = await this.#shaders.getOrInsertComputed(relocated.shaderObject.key, async () =>
						cache.recallValue<ShaderSummary>(await this.#shaderKey(cache, fp, relocated.shaderObject)),
					);
					if (shader !== undefined) {
						cache.hits.materials++;
						return { ...relocated, shader };
					}
				}
			}
		}
		const { result: outcome, bundles } = await recordBundleReads(
			async (): Promise<{ ok: true; value: LocatedMaterial } | { ok: false; error: Error }> => {
				try {
					return { ok: true, value: await locateMaterial(resolver, asset) };
				} catch (error) {
					return { ok: false, error: error instanceof Error ? error : new Error(errorText(error)) };
				}
			},
		);
		const sources = await bundleSources(resolver, bundles);
		if (!outcome.ok) {
			await cache.rememberValue(key, {
				sources,
				error: outcome.error.message,
				...(sources.length === 0 ? { manifestHash: resolver.manifest.contentHash } : {}),
			} satisfies MaterialMemo);
			throw outcome.error;
		}
		const result = outcome.value;
		// a shader's summary is most of a material's load and shared by thousands of them, so it's stored once
		const { shader, ...material } = result;
		// stored by the first fresh load of each shader, including one whose summary the cache didn't have
		if ((await this.#shaders.get(result.shaderObject.key)) === undefined) {
			this.#shaders.set(result.shaderObject.key, Promise.resolve(shader));
			await cache.rememberValue(await this.#shaderKey(cache, fp, result.shaderObject), shader);
		}
		const bundleName = ({ locator }: LocatedObject): string =>
			resolver.manifest.bundleName(locator.bundleIndex);
		await cache.rememberValue(key, {
			sources,
			material,
			bundles: {
				shader: bundleName(material.shaderObject),
				textures: Object.fromEntries(
					Object.entries(material.textures).map(([slot, { texture }]) => [
						slot,
						texture === null ? null : bundleName(texture),
					]),
				),
			},
		} satisfies MaterialMemo);
		return result;
	}

	/**
	 * @returns a recalled material whose shader and textures are located in this install's manifest by their
	 *   bundles' names, or `undefined` when one of those bundles is gone
	 */
	#relocated({ material, bundles }: ReadyMaterialMemo): Omit<LocatedMaterial, 'shader'> | undefined {
		const { manifest } = this.#input.resolver;
		const relocate = (
			object: LocatedObject,
			bundle: string | null | undefined,
		): LocatedObject | undefined => {
			const bundleIndex = bundle == null ? undefined : manifest.findBundle(bundle);
			return bundleIndex === undefined
				? undefined
				: { ...object, locator: { ...object.locator, bundleIndex } };
		};
		const shaderObject = relocate(material.shaderObject, bundles?.shader);
		if (shaderObject === undefined) {
			return undefined;
		}
		const textures: LocatedMaterial['textures'] = {};
		for (const [slot, resolved] of Object.entries(material.textures)) {
			if (resolved.texture === null) {
				textures[slot] = resolved;
				continue;
			}
			const texture = relocate(resolved.texture, bundles?.textures[slot]);
			if (texture === undefined) {
				return undefined;
			}
			textures[slot] = { ...resolved, texture };
		}
		return { ...material, shaderObject, textures };
	}

	/** @returns the cache key of a shader's summary, which its bundle's md5 keeps current */
	async #shaderKey(cache: PackCache, fp: string, { key, locator }: LocatedObject): Promise<string> {
		const md5 = await this.#input.resolver.bundleMd5(locator.bundleIndex);
		return cache.keyWith(fp, { shader: key, md5 });
	}

	/** counts a failure by kind and reason; @returns the error's message, for the debug index */
	fail(kind: string, error: Error): string {
		const reason = `${kind}: ${failureReason(error)}`;
		this.failures[reason] = (this.failures[reason] ?? 0) + 1;
		return error.message;
	}

	/** @returns whether every bundle still has the md5 it had when the conversion read it */
	async #sourcesCurrent(sources: readonly BundleSource[], manifestHash?: string): Promise<boolean> {
		if (manifestHash !== undefined && manifestHash !== this.#input.resolver.manifest.contentHash) {
			return false;
		}
		return sourcesCurrent(this.#input.resolver, sources);
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
interface ReadyMaterialMemo {
	sources: BundleSource[];
	material: Omit<LocatedMaterial, 'shader'>;
	/**
	 * the names of the bundles holding its shader and textures, by slot: their locators' bundle indices are
	 * manifest positions, which a game update shifts. absent in memos written before it was recorded
	 */
	bundles?: { shader: string; textures: Record<string, string | null> };
}

type MaterialMemo =
	| ReadyMaterialMemo
	| {
			sources: BundleSource[];
			error: string;
			manifestHash?: string;
	  };

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
	const heightmapLoads = new Map<bigint, Promise<LocatedMaterial['textures'][string]>>();
	const loadHeightmap = (ref: AssetRef): Promise<LocatedMaterial['textures'][string]> =>
		heightmapLoads.getOrInsertComputed(ref.hash, async () => {
			try {
				const found = await input.resolver.findUnique(ref, UnityClass.Texture2D);
				return { texture: locatedObject(found) };
			} catch (error) {
				return { texture: null, error: errorText(error) };
			}
		});
	await orderedPool(
		input.materials,
		input.materialConcurrency,
		async (asset, id) => {
			const loaded = await loads.getOrInsertComputed(asset.hash, () => jobs.material(asset));
			const sludge = input.materialOverrides.get(id)?.sludge ?? null;
			if (sludge === null) {
				return loaded;
			}
			const heightmap = await loadHeightmap(sludge.heightmap);
			return { ...loaded, textures: { ...loaded.textures, [SLUDGE_HEIGHTMAP_SLOT]: heightmap } };
		},
		(result, _asset, id) => {
			if (result instanceof Error) {
				out.converted.push(null);
				out.debug.push({
					object: null,
					name: null,
					shader: null,
					error: jobs.fail('material', result),
					unsupported: null,
					undrawn: null,
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
			const heightmap = loaded.textures[SLUDGE_HEIGHTMAP_SLOT];
			if (heightmap !== undefined) {
				if (heightmap.error !== undefined) {
					slotErrors[SLUDGE_HEIGHTMAP_SLOT] = heightmap.error;
					jobs.fail('texture slot', new Error(heightmap.error));
				} else if (heightmap.texture !== null) {
					converted.material.slots[SLUDGE_HEIGHTMAP_SLOT] = {
						texture: textures.use(heightmap.texture, place),
						uv: 0,
						scale: [1, 1],
						offset: [0, 0],
					};
				}
			}
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
				undrawn: null,
				keywordsNotDrawn: notDrawn,
				slotErrors,
			});
			out.normalMapUv.push(converted.normalMapUv);
		},
	);
	return out;
};

/**
 * the gap of a material whose looping clip changes more of its surface than numbers, so it holds the clip's
 * end
 */
const PLAYED_VALUES_GAP = 'material values a looping clip plays';

/** describes each converted material's surface, recording the ones the viewer can't draw in their debug rows */
const describeSurfaces = (
	materials: LoadedMaterials,
	overrides: ReadonlyMap<number, MaterialOverrides>,
): { entries: MaterialEntry[]; unsupported: Record<string, number> } => {
	const unsupported: Record<string, number> = {};
	const entries = materials.converted.map((material, id): MaterialEntry => {
		if (material === null) {
			return { status: 'failed' };
		}
		const shader = materials.shaders.shaders[material.shader];
		let surface = describeMaterial(material, shader);
		const placement = overrides.get(id)?.waterDecal ?? null;
		if (placement !== null && surface.kind === 'waterFoam') {
			surface = placedWaterFoam(surface, placement);
		}
		const sludge = overrides.get(id)?.sludge ?? null;
		if (sludge !== null && surface.kind === 'sludge') {
			surface = placedSludge(surface, sludge);
		}
		if (surface.kind === 'unsupported') {
			const key = `${shader.name}: ${surface.reason}`;
			unsupported[key] = (unsupported[key] ?? 0) + 1;
			materials.debug[id].unsupported = surface.reason;
		}
		if (surface.kind === 'undrawn') {
			materials.debug[id].undrawn = surface.reason;
		}
		const drawn = surface.kind !== 'unsupported' && surface.kind !== 'undrawn';
		const gaps = drawn ? surfaceGaps(readerOf(material, shader)) : [];
		// a looping clip's floats, as the numbers of the surface they change
		const played = overrides.get(id)?.saved?.motion ?? null;
		let motion: MaterialMotion | null = null;
		if (drawn && played !== null) {
			const moving = surfaceMotion(surface, played, (floats) =>
				describeMaterial({ ...material, floats: { ...material.floats, ...floats } }, shader),
			);
			if (moving === 'reshaped') {
				gaps.push(PLAYED_VALUES_GAP);
			} else {
				motion = moving;
			}
		}
		return { status: 'ready', cull: material.cull, renderQueue: material.renderQueue, surface, gaps, motion };
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
	/** the farthest any material's vertex offset moves it, `null` without one */
	offset: (OffsetReach | null)[];
	/** the vertex animation its materials play, `null` without one or when they disagree on it */
	vat: (VatBake | null)[];
	/** why a mesh drawn with vertex animations isn't baked with one, by mesh */
	unanimated: Map<number, string>;
}

/**
 * a mesh gets tangents when any draw of it uses a normal-mapped material, for the lowest uv set any of them
 * reads its normal map on; a mesh any swaying material draws carries sway weights, and bounds that hold the
 * farthest sway; a mesh any material offsets by a texture gets bounds that hold the farthest offset, and the
 * weights when one is weighted by them. a mesh drawn with a vertex animation is baked with it, on the
 * submeshes it's drawn on, when all its draws agree on one
 */
const meshNeeds = (
	input: AssetConversionInput,
	materials: LoadedMaterials,
	textures: TextureUses,
): MeshNeeds => {
	const count = input.geometries.length;
	const tangentUvs = Array.from({ length: count }, () => new Set<number>());
	const sway: (SwayReach | null)[] = Array.from({ length: count }, () => null);
	const reaches = materials.converted.map((material) => {
		const swayed =
			material === null ? null : materialSway(material, materials.shaders.shaders[material.shader]);
		return swayed === null ? null : swayReach(swayed);
	});
	const offset: (OffsetReach | null)[] = Array.from({ length: count }, () => null);
	const offsetReaches = materials.converted.map((material) => {
		const moved =
			material === null ? null : materialVertexOffset(material, materials.shaders.shaders[material.shader]);
		return moved === null ? null : offsetReach(moved);
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
						: {
								flat: Math.max(held.flat, reach.flat),
								perHeight: Math.max(held.perHeight, reach.perHeight),
								perDistance: Math.max(held.perDistance, reach.perDistance),
							};
			}
			const moved = draw.material === null ? null : (offsetReaches[draw.material] ?? null);
			const heldOffset = offset[draw.geometry];
			if (moved !== null) {
				offset[draw.geometry] =
					heldOffset === null
						? moved
						: {
								reach: [
									Math.max(heldOffset.reach[0], moved.reach[0]),
									Math.max(heldOffset.reach[1], moved.reach[1]),
									Math.max(heldOffset.reach[2], moved.reach[2]),
								],
								weighted: heldOffset.weighted || moved.weighted,
							};
			}
		}
	}
	const { vat, unanimated } = vatNeeds(input, materials, textures);
	return {
		tangentUvs,
		tangentUv: tangentUvs.map((uvs) => (uvs.size === 0 ? null : Math.min(...uvs))),
		sway,
		offset,
		vat,
		unanimated,
	};
};

/** each mesh's vertex animation (see {@link meshNeeds}) */
const vatNeeds = (
	input: AssetConversionInput,
	materials: LoadedMaterials,
	textures: TextureUses,
): Pick<MeshNeeds, 'vat' | 'unanimated'> => {
	const animations = materials.converted.map((material) =>
		material === null ? null : materialVat(material, materials.shaders.shaders[material.shader]),
	);
	const found = new Map<number, { key: string; bake: VatBake }>();
	const unanimated = new Map<number, string>();
	for (const chain of input.chains) {
		for (const draw of chain.draws) {
			const animation = draw.material === null ? null : (animations[draw.material] ?? null);
			if (animation === null || unanimated.has(draw.geometry)) {
				continue;
			}
			let bake: VatBake;
			if (animation.body === 'bone') {
				const { map, ...values } = animation;
				bake = { ...values, map: textures.objects[map].locator, submeshes: [draw.submesh] };
			} else {
				const { position, rotation, ...values } = animation;
				bake = {
					...values,
					position: textures.objects[position].locator,
					rotation: textures.objects[rotation].locator,
					submeshes: [draw.submesh],
				};
			}
			const key = JSON.stringify({ ...bake, submeshes: [] }, (_key, value: unknown) =>
				typeof value === 'bigint' ? value.toString() : value,
			);
			const held = found.get(draw.geometry);
			if (held === undefined) {
				found.set(draw.geometry, { key, bake });
			} else if (held.key !== key) {
				found.delete(draw.geometry);
				unanimated.set(draw.geometry, 'a mesh drawn with different vertex animations');
			} else if (!held.bake.submeshes.includes(draw.submesh)) {
				held.bake.submeshes.push(draw.submesh);
			}
		}
	}
	return {
		vat: input.geometries.map((_asset, id) => {
			const bake = found.get(id)?.bake ?? null;
			if (bake === null) {
				return null;
			}
			bake.submeshes.sort(compareNumbers);
			return bake;
		}),
		unanimated,
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
	const { manifest } = input.resolver;
	const inFlight = Math.max(CONVERSIONS_IN_FLIGHT, input.pool.size * 8);
	await orderedPool(
		input.geometries,
		inFlight,
		(asset, id) => {
			const affinity =
				asset.synthetic !== undefined
					? undefined
					: (asset.locator?.bundleIndex ?? manifest.findAssets(asset.hash)[0]?.bundleIndex);
			return jobs.run(
				{
					kind: 'geometry',
					asset,
					tangentUv: needs.tangentUv[id],
					sway: needs.sway[id],
					offset: needs.offset[id],
					vat: needs.vat[id],
					zstdLevel: input.geometryZstdLevel,
				},
				affinity,
			);
		},
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
			const unanimated = result.unanimated ?? needs.unanimated.get(id);
			debug.push({
				object: result.object,
				name: result.name,
				error: null,
				...(unanimated === undefined ? {} : { unanimated }),
				...(uvs.size > 1 && result.entry.tangentUv !== null
					? // oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy
						{ tangentUvs: [...uvs].sort(compareNumbers) }
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

/** converts every texture object on the worker pool while geometry runs, collecting small results in order */
const startTextureJobs = (
	input: AssetConversionInput,
	jobs: ConvertJobs,
	objects: TextureUses['objects'],
): Promise<(ConvertResultOf<Extract<ConvertJob, { kind: 'texture' }>> | Error)[]> => {
	const results: (ConvertResultOf<Extract<ConvertJob, { kind: 'texture' }>> | Error)[] = [];
	const inFlight = Math.max(CONVERSIONS_IN_FLIGHT, input.pool.size * 8);
	return orderedPool(
		objects,
		inFlight,
		(object) =>
			jobs.run(
				{ kind: 'texture', locator: object.locator, zstdLevel: input.textureZstdLevel },
				object.locator.bundleIndex,
			),
		(result) => {
			results.push(result);
		},
	).then(() => results);
};

/** commits every converted texture object in id order, storing equal contents once and their pieces together */
const finishTextures = async (
	input: AssetConversionInput,
	jobs: ConvertJobs,
	objects: TextureUses['objects'],
	pending: Promise<(ConvertResultOf<Extract<ConvertJob, { kind: 'texture' }>> | Error)[]>,
): Promise<ConvertedTextures> => {
	const results = await pending;
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
	for (const [index, result] of results.entries()) {
		const object = objects[index];
		if (result instanceof Error) {
			out.ids.push(out.entries.length);
			out.debug.push({
				object: object.key,
				name: null,
				error: jobs.fail('texture', result),
				id: out.entries.length,
			});
			out.entries.push({ status: 'failed' });
			continue;
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
			continue;
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
		const maxSize = input.maxTextureSize ?? null;
		let { width, height, mipCount } = result.entry;
		let droppedMips = 0;
		let keptPieces = pieces;
		if (maxSize !== null && result.entry.kind !== '3d' && Math.max(width, height) > maxSize) {
			keptPieces = [...pieces];
			while (keptPieces.length > 1 && Math.max(width, height) > maxSize) {
				const top = keptPieces.pop()!;
				droppedMips += top.levelCount;
				width = Math.max(1, width >> top.levelCount);
				height = Math.max(1, height >> top.levelCount);
			}
			mipCount = Math.max(1, mipCount - droppedMips);
		}
		const entryShape = { ...result.entry, width, height, mipCount };
		out.entries.push({
			status: 'ready',
			...entryShape,
			...(droppedMips > 0 ? { droppedMips } : {}),
			sampler,
			pieces: keptPieces.map((piece, i) => {
				const firstLevel = piece.firstLevel - droppedMips;
				const { width: lw, height: lh } = textureLevelLayout(entryShape, firstLevel);
				const group = i === 0 && piece.levelCount > 1 ? 'tail' : String(Math.max(lw, lh));
				out.pieces[group] ??= { count: 0, stored: 0, raw: 0 };
				// a texture's pieces sit together under its tail's hash, coarse to fine
				const placement: BlobPlacement = {
					kind: BlobKind.Texture,
					stem,
					locality: `${keptPieces[0].blob.hash}.${i.toString(16).padStart(2, '0')}`,
				};
				return {
					blob: commit(input.store, piece.blob, placement, out.pieces[group]),
					firstLevel,
					levelCount: piece.levelCount,
				};
			}),
		});
		out.debug.push({ object: object.key, name, error: null, id, ...approximations });
	}
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
 * how far a sway moves a vertex of full weight. the cloth's is the largest `(s + 1 + tendency) · amplitude`
 * of `docs/game-data/materials.md#swaying-cloth`: a kite's sine `s` is scaled by the object-space height, a
 * wave's stays within ±1. a pendulum's turns are no longer than their angles times the vertex's distance from
 * the object's origin, scaled by the most the stability lets through
 */
const swayReach = (sway: LitSway): SwayReach => {
	switch (sway.kind) {
		case 'cloth': {
			const { intensity, kite, tendency } = sway;
			const offset = Math.abs(1 + tendency);
			if (kite !== 0) {
				const amplitude = Math.abs(intensity) * 0.05;
				return { flat: amplitude * offset, perHeight: amplitude, perDistance: 0 };
			}
			return { flat: Math.abs(intensity) * 0.5 * (1 + offset), perHeight: 0, perDistance: 0 };
		}
		case 'pendulum': {
			const { intensity, spinRange, stability } = sway;
			const angle = Math.abs(intensity) * 0.05 + Math.abs(spinRange);
			// the weight the stability blends toward 1 is at most half the intensity
			const half = intensity * 0.5;
			const follow = Math.max(Math.abs(half), 1, Math.abs(half + stability * (1 - half)));
			return { flat: 0, perHeight: 0, perDistance: angle * follow };
		}
		case 'mushroom': {
			const { bendScale, squashScale, twistScale } = sway;
			// conservative upper bound over LUT curves (bend ~30°, twist ~15°, squash ~0.5)
			const perDistance =
				Math.abs(bendScale) * 0.55 + Math.abs(twistScale) * 0.26 + Math.abs(squashScale) * 0.5;
			return { flat: 0, perHeight: 0, perDistance };
		}
	}
};

/**
 * how far a vertex offset moves a vertex along each of the mesh's axes, the largest `direction · intensity ·
 * (n · (1 + bias) − bias) · (1 − strength · (1 − m))` of `docs/game-data/materials.md#vertex-offset` over the
 * textures' `n` and `m` in 0…1. a direction along the world's axes, or along the normal, can point anywhere
 * in the mesh's frame, so its length reaches along every axis; placements are taken as near unit scale
 */
const offsetReach = ({
	direction,
	space,
	intensity,
	bias,
	mask,
	vertexAlphaWeight,
}: LitVertexOffset): OffsetReach => {
	const masked = mask === null ? 1 : Math.max(1, Math.abs(1 - mask.strength));
	const scale = Math.abs(intensity) * Math.max(1, Math.abs(bias)) * masked;
	let reach: OffsetReach['reach'];
	switch (space) {
		case 'object': {
			reach = [
				Math.abs(direction[0]) * scale,
				Math.abs(direction[1]) * scale,
				Math.abs(direction[2]) * scale,
			];
			break;
		}
		case 'world': {
			const length = Math.hypot(...direction) * scale;
			reach = [length, length, length];
			break;
		}
		case 'normal': {
			reach = [scale, scale, scale];
			break;
		}
	}
	return { reach, weighted: vertexAlphaWeight };
};

/** rewrites a material's slots from per-object ids to texture-table ids, in place (the entry is ours) */
const remapSlots = (material: ConvertedMaterial, ids: readonly number[]): void => {
	for (const slot of Object.values(material.slots)) {
		slot.texture = ids[slot.texture];
	}
};

// #endregion
