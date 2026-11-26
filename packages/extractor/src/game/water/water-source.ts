import { ChunkObjectKind, parseInitChunk } from '@endfield-noclip/formats/endfield/init-chunk-data';
import { parseStreamingChunk } from '@endfield-noclip/formats/endfield/streaming-chunk-data';
import {
	readWaterGlobalBindings,
	readWaterGlobalConfig,
	readWaterSurfaceConfig,
	readWaterSurfaces,
	WATER_SURFACE_COMPONENT,
	type WaterGlobalBinding,
	type WaterGlobalConfig,
	type WaterSector,
	type WaterSurface,
	type WaterSurfaceConfig,
} from '@endfield-noclip/formats/endfield/water';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import { pptrField } from '@endfield-noclip/formats/unity/values';

import { definite } from '@mary-ext/array-fns';

import { mapPool } from '../../util/pool.ts';
import type { AssetRef, AssetResolver, ObjectRef } from '../assets/assets.ts';
import type { ChunkFile, ChunkSource, WorldIndex } from '../world/world-index.ts';

// #region placements

/** a water surface with the chunk file it was read from */
export interface SourcedWaterSurface extends WaterSurface {
	/** the first file holding it */
	source: ChunkFile;
	/** scene states and stream areas of the files holding it, any of which loads it */
	sources: ChunkSource[];
}

/** a scene's water placements */
export interface SceneWater {
	/** every surface, deduplicated by id (first file in name order wins) */
	surfaces: SourcedWaterSurface[];
	/** per-level global config bindings, deduplicated by id */
	globals: WaterGlobalBinding[];
}

/** chunk files read at once */
const READ_CONCURRENCY = 16;

/**
 * deduplicates water surfaces and global config bindings read from chunk files, in input file order
 *
 * @param perFile per chunk file, its surfaces and global bindings (in filename order for deterministic
 *   dedupe)
 * @returns the deduplicated placements
 */
export const collectSceneWater = (
	perFile: readonly {
		file: ChunkFile;
		surfaces: readonly WaterSurface[];
		globals: readonly WaterGlobalBinding[];
	}[],
): SceneWater => {
	const surfaces: SourcedWaterSurface[] = [];
	const globals: WaterGlobalBinding[] = [];
	const seen = new Set<number>();
	const byId = new Map<number, SourcedWaterSurface>();
	for (const read of perFile) {
		const { sceneState, area } = read.file;
		for (const surface of read.surfaces) {
			const known = byId.get(surface.id);
			if (known === undefined) {
				const sourced = Object.assign({ ...surface }, { source: read.file, sources: [{ sceneState, area }] });
				byId.set(surface.id, sourced);
				surfaces.push(sourced);
			} else {
				known.sources.push({ sceneState, area });
			}
		}
		for (const binding of read.globals) {
			if (!seen.has(binding.id)) {
				seen.add(binding.id);
				globals.push(binding);
			}
		}
	}
	return { surfaces, globals };
};

/**
 * reads the water surfaces and global config bindings of a scene. the installed client keeps surfaces in
 * Global chunks, but every chunk file is scanned unless `filter` narrows it.
 *
 * @param world world index
 * @param scene streaming scene, e.g. `map02`
 * @param filter optional chunk-file predicate
 * @param options.includeGlobals whether to also scan Mono objects for global water config bindings (default
 *   `true`); pass `false` when only water surfaces are needed
 * @returns the scene's water placements
 * @throws {Error} if a chunk with water lacks its StreamingChunkData sibling
 */
export const readSceneWater = async (
	world: WorldIndex,
	scene: string,
	filter?: (file: ChunkFile) => boolean,
	options?: { includeGlobals?: boolean },
): Promise<SceneWater> => {
	const includeGlobals = options?.includeGlobals ?? true;
	const files = (await world.chunkFiles()).filter(
		(file) => file.scene === scene && (filter === undefined || filter(file)),
	);
	const perFile = await mapPool(files, READ_CONCURRENCY, async (file) => {
		const init = parseInitChunk(await world.readInitPayload(file));
		const hasWater = init.groups.some((group) =>
			group.columns.some((column) => column.id === WATER_SURFACE_COMPONENT),
		);
		const hasGlobal = includeGlobals && init.objects.some((object) => object.kind === ChunkObjectKind.Mono);
		if (!hasWater && !hasGlobal) {
			return null;
		}
		const data = await world.readStreamingPayload(file);
		if (data === null) {
			throw new Error(`${file.name} has no StreamingChunkData sibling`);
		}
		const streaming = parseStreamingChunk(data);
		return {
			file,
			surfaces: hasWater ? readWaterSurfaces(init, streaming) : [],
			globals: hasGlobal ? readWaterGlobalBindings(init, streaming) : [],
		};
	});
	return collectSceneWater(definite(perFile));
};

// #endregion

// #region config assets

/** a decoded water config and where it came from */
export interface LoadedWaterConfig<T> {
	ref: ObjectRef;
	config: T;
}

/**
 * @param resolver asset resolver
 * @param asset the config's StringPathHash key and path (if known)
 * @returns the surface `WaterConfig`
 * @throws {Error} if the asset can't be found or read
 */
export const loadWaterSurfaceConfig = async (
	resolver: AssetResolver,
	asset: AssetRef,
): Promise<LoadedWaterConfig<WaterSurfaceConfig>> => {
	const ref = await resolver.findUnique(asset, UnityClass.MonoBehaviour);
	return { ref, config: readWaterSurfaceConfig(ref.info.type.nodes, await resolver.read(ref)) };
};

/**
 * @param resolver asset resolver
 * @param asset the config's StringPathHash key and path (if known)
 * @returns the `Global_Water_Config`
 * @throws {Error} if the asset can't be found or read
 */
export const loadWaterGlobalConfig = async (
	resolver: AssetResolver,
	asset: AssetRef,
): Promise<LoadedWaterConfig<WaterGlobalConfig>> => {
	const ref = await resolver.findUnique(asset, UnityClass.MonoBehaviour);
	return { ref, config: readWaterGlobalConfig(await resolver.read(ref)) };
};

/**
 * @param resolver asset resolver
 * @param sector a sector with data
 * @returns its flow-map tile (`waterSectorTexture0`), or `null` if unset
 * @throws {Error} if the sector asset can't be found or read
 */
export const loadSectorTexture = async (
	resolver: AssetResolver,
	sector: WaterSector,
): Promise<{ sector: ObjectRef; texture: ObjectRef | null }> => {
	const ref = await resolver.findUnique(
		{ hash: sector.assetHash, path: sector.path },
		UnityClass.MonoBehaviour,
	);
	return {
		sector: ref,
		texture: await resolver.resolve(ref, pptrField(await resolver.read(ref), 'waterSectorTexture0')),
	};
};

// #endregion
