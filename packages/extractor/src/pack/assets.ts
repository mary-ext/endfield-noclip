import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import {
	BlobKind,
	type Chain,
	type GeometryEntry,
	type MaterialEntry,
	type MaterialTable,
	type ReadyMaterial,
	type TextureEntry,
	textureLevelLayout,
} from '@endfield-noclip/package-format/format';

import { failureReason } from '../errors.ts';
import { loadMaterial, loadMesh, loadTexture } from '../game/asset-decode.ts';
import { type AssetRef, type AssetResolver, objectKey, type ObjectRef } from '../game/assets.ts';
import { orderedPool } from '../pool.ts';

import { type AssetArchives, type Place, mergePlaces } from './asset-placement.ts';
import type { BlobStore, PreparedBlob } from './blob-store.ts';
import { convertMesh, geometryReady } from './geometry.ts';
import { convertMaterial, ShaderTable } from './materials.ts';
import { PhaseTimer } from './phase-timer.ts';
import { convertTexture } from './textures.ts';

// the packer references assets by dense ids handed out here, in first-reference order. converting them reads
// materials first (they decide which meshes need tangents and which textures are used), then meshes, then
// textures. each phase decodes several assets concurrently but stores results in id order, so the package
// is deterministic.

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
}

// #endregion

// #region conversion

/** what {@link convertAssets} needs */
export interface AssetConversionInput {
	resolver: AssetResolver;
	store: BlobStore;
	geometries: readonly AssetRef[];
	materials: readonly AssetRef[];
	chains: readonly Chain[];
	/** per geometry and material id, where its uses are; see `AssetPlacement` */
	places: { geometries: readonly Place[]; materials: readonly Place[] };
	/** textures referenced outside materials (environment and water maps), in groups of the caller's choosing */
	extraTextures: readonly (readonly PlacedTexture[])[];
	/** names the asset archives blobs go to */
	archives: AssetArchives;
	/** zstd level for texture blobs */
	textureZstdLevel: number;
	/** assets decoded at once per phase */
	concurrency: number;
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
	const { resolver, store, archives } = input;
	await geometryReady;
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
	const textureObjects: { key: string; locator: TextureLocator; place: Place }[] = [];
	const textureIndex = new Map<string, number>();
	const useTexture = (ref: ObjectRef, place: Place): number => {
		const key = objectKey(ref);
		let index = textureIndex.get(key);
		if (index === undefined) {
			index = textureObjects.length;
			textureIndex.set(key, index);
			textureObjects.push({ key, locator: locate(ref), place });
		} else {
			textureObjects[index].place = mergePlaces(textureObjects[index].place, place);
		}
		return index;
	};
	await orderedPool(
		input.materials,
		input.concurrency,
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
		input.concurrency,
		async (asset, id) => {
			const ref = await resolver.findUnique(asset, UnityClass.Mesh);
			const mesh = await loadMesh(resolver, ref);
			const converted = convertMesh(mesh, tangentUv[id]);
			const prepared = await store.prepare(converted.blob, {
				kind: BlobKind.Geometry,
				compress: true,
				archive: (_hash, length) => archives.archive(input.places.geometries[id], length),
			});
			return { ref, name: mesh.name, converted, prepared };
		},
		(result, _asset, id) => {
			if (result instanceof Error) {
				geometryEntries.push({ id, status: 'failed' });
				geometryDebug.push({ object: null, name: null, error: fail('geometry', result) });
				return;
			}
			const { ref, name, converted, prepared } = result;
			const blob = commit(store, prepared, geometry);
			geometryEntries.push({ id, status: 'ready', blob, ...converted.entry });
			geometryDebug.push({ object: objectKey(ref), name, error: null });
			geometry.vertices += converted.entry.vertexCount;
			geometry.triangles += converted.entry.indexCount / 3;
			geometry.gpuBytes += converted.gpuBytes;
			if (converted.entry.tangentUv !== null) {
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
		input.concurrency,
		async (object) => {
			const { bundleIndex, file, pathId } = object.locator;
			const ref = await resolver.objectIn(bundleIndex, file, pathId);
			const texture = await loadTexture(resolver, ref);
			const converted = convertTexture(texture);
			// a twin already stored needs no compression; the commit maps it either way
			const pieces = byContent.has(converted.contentKey)
				? []
				: await Promise.all(
						converted.pieces.map((piece) =>
							store.prepare(piece.data, {
								kind: BlobKind.Texture,
								compress: true,
								zstdLevel: input.textureZstdLevel,
								archive: (_hash, length) => archives.archive(object.place, length),
							}),
						),
					);
			return { name: texture.name, converted, pieces };
		},
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
			const { name, converted, pieces } = result;
			const twin = byContent.get(converted.contentKey);
			if (twin !== undefined) {
				textureDuplicates++;
				textureIds.push(twin);
				textureDebug.push({ object: object.key, name, error: null, id: twin });
				return;
			}
			const id = textureEntries.length;
			byContent.set(converted.contentKey, id);
			textureIds.push(id);
			textureFormats[converted.entry.format] = (textureFormats[converted.entry.format] ?? 0) + 1;
			textureEntries.push({
				id,
				status: 'ready',
				...converted.entry,
				pieces: converted.pieces.map((piece, i) => {
					const { width, height } = textureLevelLayout(converted.entry, piece.firstLevel);
					const group = i === 0 && piece.levelCount > 1 ? 'tail' : String(Math.max(width, height));
					texturePieces[group] ??= { count: 0, stored: 0, raw: 0 };
					return {
						blob: commit(store, pieces[i], texturePieces[group]),
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

/** where a texture object lives, without holding its bundle open */
interface TextureLocator {
	bundleIndex: number;
	/** SerializedFile name, `CAB-<hex>` */
	file: string;
	pathId: bigint;
}

const locate = (ref: ObjectRef): TextureLocator => ({
	bundleIndex: ref.bundleIndex,
	file: ref.file.node.path,
	pathId: ref.info.pathId,
});

/** commits a prepared blob, counting its bytes when it's new */
const commit = (store: BlobStore, prepared: PreparedBlob, tally: BlobTally): number => {
	const before = store.size;
	const index = store.commit(prepared);
	if (store.size > before) {
		tally.count++;
		tally.stored += prepared.stored.byteLength;
		tally.raw += prepared.rawLength;
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
