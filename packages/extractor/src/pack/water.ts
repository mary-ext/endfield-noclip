import type { WaterGlobalConfig, WaterSurfaceConfig } from '@endfield-noclip/formats/endfield/water';
import type { PPtr } from '@endfield-noclip/formats/unity/values';
import type {
	Rect,
	TextureRef,
	WaterConfig,
	WaterConfigEntry,
	WaterGlobal,
	WaterSurfaceEntry,
	WaterTable,
} from '@endfield-noclip/package-format/format';

import { intern } from '../collections.ts';
import type { Context } from '../context.ts';
import { errorText } from '../errors.ts';
import { type AssetResolver, objectKey, type ObjectRef } from '../game/assets.ts';
import {
	loadSectorTexture,
	loadWaterGlobalConfig,
	loadWaterSurfaceConfig,
	readSceneWater,
	type SourcedWaterSurface,
} from '../game/water-source.ts';

import type { Place } from './asset-placement.ts';
import type { PlacedTexture } from './assets.ts';
import { aabbBounds } from './bounds.ts';

// the water table: the scene's water surfaces, their configs and the global water maps. surface meshes join the
// geometry table and the maps the texture table, so planning happens before asset conversion and the texture
// ids are filled in after, as for environments.

/** what planning found, for the pack report and debug index */
export interface WaterDebug {
	/** surfaces in the scene, and those the package's subset keeps */
	surfaces: { scene: number; packed: number };
	/** the global config asset's name, or `null` */
	global: string | null;
	/** sectors with data, and those packed */
	sectors: { scene: number; packed: number };
	/** per packed surface: id, name, source chunk file, mesh and config paths */
	rows: { id: number; name: string; file: string; mesh: string | null; config: string | null }[];
	/** assets that couldn't be loaded; surfaces whose config failed are left out */
	errors: string[];
}

/** water planned before asset conversion */
export interface WaterPlan {
	/**
	 * texture fields hold indices into {@link textures} until {@link finishWater}; surface conditions are `null`
	 * until the packer interns {@link surfaceStates}
	 */
	table: WaterTable;
	/** per table surface: the MapConfig scene state indices that load it, empty if always loaded */
	surfaceStates: number[][];
	textures: PlacedTexture[];
	debug: WaterDebug;
}

/** what {@link planWater} needs from the packer */
export interface WaterPlanOptions {
	/** whether the package's subset keeps content with this level tag centred at world x, z */
	includes: (tag: number, x: number, z: number) => boolean;
	/** whether the package is a subset; full packages keep every sector */
	subset: boolean;
	/** interns a mesh into the geometry table */
	geometry: (hash: bigint) => number;
	/** the placement of a sector tile covering a world rectangle */
	placeSector: (rect: Rect) => Place;
}

/**
 * reads the scene's water and loads the configs and global maps the subset needs
 *
 * @param context world index and asset resolver
 * @param scene streaming scene
 * @param options subset predicate and the packer's interning hooks
 * @returns the table with pending texture ids, the textures to convert and debug rows
 */
export const planWater = async (
	context: Pick<Context, 'world' | 'resolver'>,
	scene: string,
	options: WaterPlanOptions,
): Promise<WaterPlan> => {
	const { world } = context;
	// every surface and global binding sits in a Global chunk (checked over all scenes of the current client)
	const water = await readSceneWater(world, scene, (file) => file.cell === null);
	const selected = selectSurfaces(water.surfaces, options.includes);
	const plan: WaterPlan = {
		table: { global: null, configs: [], surfaces: [] },
		surfaceStates: [],
		textures: [],
		debug: {
			surfaces: { scene: water.surfaces.length, packed: 0 },
			global: null,
			sectors: { scene: 0, packed: 0 },
			rows: [],
			errors: [],
		},
	};
	if (selected.length === 0) {
		return plan;
	}
	const [resolver, pathOf] = await Promise.all([context.resolver(), world.pathLookup()]);

	// configs, by asset key
	const configHashes = [...new Set(selected.map((surface) => surface.configHash))];
	const loaded = await Promise.all(
		configHashes.map(async (hash) => {
			try {
				const { config } = await loadWaterSurfaceConfig(resolver, { hash, path: pathOf(hash) ?? null });
				return configEntry(config);
			} catch (error) {
				return new Error(`config 0x${hash.toString(16)}: ${errorText(error)}`);
			}
		}),
	);
	const configIndex = new Map<bigint, number>();
	for (const [i, entry] of loaded.entries()) {
		if (entry instanceof Error) {
			plan.debug.errors.push(entry.message);
		} else {
			configIndex.set(configHashes[i], plan.table.configs.length);
			plan.table.configs.push(entry);
		}
	}

	for (const surface of selected) {
		const config = configIndex.get(surface.configHash);
		if (config === undefined) {
			continue;
		}
		plan.table.surfaces.push(surfaceEntry(surface, options.geometry(surface.meshHash), config));
		plan.surfaceStates.push(surface.sceneStates);
		plan.debug.rows.push({
			id: surface.id,
			name: surface.name,
			file: surface.source.name,
			mesh: pathOf(surface.meshHash) ?? null,
			config: pathOf(surface.configHash) ?? null,
		});
	}
	plan.debug.surfaces.packed = plan.table.surfaces.length;
	if (plan.table.surfaces.length === 0) {
		return plan;
	}

	// every binding of a scene names the same asset; the first is taken
	const binding = water.globals[0];
	if (binding === undefined) {
		plan.debug.errors.push('the scene has surfaces but no global water config binding');
		return plan;
	}
	try {
		const { ref, config } = await loadWaterGlobalConfig(resolver, {
			hash: binding.configHash,
			path: pathOf(binding.configHash) ?? null,
		});
		plan.debug.global = config.name;
		plan.debug.sectors.scene = config.sectors.length;
		plan.table.global = await planGlobal(resolver, ref, config, plan, options);
		plan.debug.sectors.packed = plan.table.global.sectors.length;
	} catch (error) {
		plan.debug.errors.push(`global config: ${errorText(error)}`);
	}
	return plan;
};

/**
 * fills in the texture ids of a planned table
 *
 * @param plan the plan; its table is completed in place and handed out
 * @param textureIds per {@link WaterPlan.textures} entry, its texture-table id or `null`
 * @returns the water table
 */
export const finishWater = (plan: WaterPlan, textureIds: readonly (number | null)[]): WaterTable => {
	const { global } = plan.table;
	if (global !== null) {
		const id = (index: TextureRef): TextureRef => (index === null ? null : (textureIds[index] ?? null));
		global.flowMap = id(global.flowMap);
		global.causticMap = id(global.causticMap);
		global.normalMaps = id(global.normalMaps);
		global.rainMap = id(global.rainMap);
		for (const sector of global.sectors) {
			sector.texture = id(sector.texture);
		}
	}
	return plan.table;
};

/**
 * @param surfaces a scene's surfaces
 * @param includes the subset predicate, applied to each surface's level tag and bounds centre
 * @returns the surfaces the subset keeps, in input order
 */
export const selectSurfaces = <T extends Pick<SourcedWaterSurface, 'levelTag' | 'bounds'>>(
	surfaces: readonly T[],
	includes: WaterPlanOptions['includes'],
): T[] => surfaces.filter(({ levelTag, bounds }) => includes(levelTag, bounds.center[0], bounds.center[2]));

/**
 * @param sectors sectors with data
 * @param global the grid's centre and sector size
 * @param surfaces world bounds of the packed surfaces
 * @returns the sectors whose square overlaps one of the surfaces in x, z
 */
export const sectorsOverlapping = <T extends { x: number; z: number }>(
	sectors: readonly T[],
	global: Pick<WaterGlobal, 'center' | 'sectorSize'>,
	surfaces: readonly Pick<WaterSurfaceEntry, 'bounds'>[],
): T[] => {
	return sectors.filter((sector) => {
		const rect = sectorRect(global, sector);
		return surfaces.some(
			({ bounds }) =>
				bounds.min[0] < rect.maxX &&
				bounds.max[0] > rect.minX &&
				bounds.min[2] < rect.maxZ &&
				bounds.max[2] > rect.minZ,
		);
	});
};

const sectorRect = (
	{ center, sectorSize }: Pick<WaterGlobal, 'center' | 'sectorSize'>,
	{ x, z }: { x: number; z: number },
): Rect => {
	const minX = center[0] + x * sectorSize;
	const minZ = center[1] + z * sectorSize;
	return { minX, minZ, maxX: minX + sectorSize, maxZ: minZ + sectorSize };
};

const planGlobal = async (
	resolver: AssetResolver,
	from: ObjectRef,
	config: WaterGlobalConfig,
	plan: WaterPlan,
	options: WaterPlanOptions,
): Promise<WaterGlobal> => {
	const textureIndex = new Map<string, number>();
	const add = (ref: ObjectRef | null, place: Place): TextureRef =>
		ref === null ? null : intern(plan.textures, textureIndex, objectKey(ref), () => ({ ref, place }));
	// errors are collected per lookup and reported in lookup order, whatever order the reads finish in
	const resolveMap = async (name: string, pptr: PPtr): Promise<ObjectRef | Error | null> =>
		resolver.resolve(from, pptr).catch((error: unknown) => new Error(`${name}: ${errorText(error)}`));
	const sectors = options.subset
		? sectorsOverlapping(
				config.sectors,
				{ center: config.sceneCenterOffset, sectorSize: config.sectorSize },
				plan.table.surfaces,
			)
		: config.sectors;
	const [maps, tiles] = await Promise.all([
		Promise.all([
			resolveMap('flowMap', config.flowMap),
			resolveMap('causticMap', config.causticMap),
			resolveMap('normalMapArray', config.normalMapArray),
			resolveMap('rainMap', config.rainMap),
		]),
		Promise.all(
			sectors.map((sector) =>
				loadSectorTexture(resolver, sector).then(
					({ texture }) => texture,
					(error: unknown) => new Error(`sector ${sector.x}, ${sector.z}: ${errorText(error)}`),
				),
			),
		),
	]);
	const settled = (ref: ObjectRef | Error | null): ObjectRef | null => {
		if (ref instanceof Error) {
			plan.debug.errors.push(ref.message);
			return null;
		}
		return ref;
	};
	const [flowMap, causticMap, normalMaps, rainMap] = maps.map((ref) => add(settled(ref), null));

	const global: WaterGlobal = {
		mapSize: config.mapSize,
		sectorSize: config.sectorSize,
		center: config.sceneCenterOffset,
		flowmapPrecision: config.flowmapPrecision,
		flowMap,
		causticMap,
		normalMaps,
		rainMap,
		sectors: [],
	};
	for (const [i, sector] of sectors.entries()) {
		const texture = add(settled(tiles[i]), options.placeSector(sectorRect(global, sector)));
		if (texture !== null) {
			global.sectors.push({ x: sector.x, z: sector.z, texture });
		}
	}
	return global;
};

/** the fields an interface names, without its index signature */
type NamedKeys<T> = keyof { [K in keyof T as string extends K ? never : K]: T[K] };

/** the shape of each field {@link WaterConfig} names: 0 for a number, else the vector length */
const CONFIG_FIELDS: Record<NamedKeys<WaterConfig>, number> = {
	waterRayleighScatteringMeter: 4,
	waterRayleighAbsorptionMeter: 4,
	waterRayleighAbsorptionMeter2: 4,
	absorptionTint: 4,
	absorptionTint2: 4,
	absorptionScale: 0,
	scatterTint: 4,
	scatterScale: 0,
	safeFullAbsorpDistance: 0,
	envLightIntensity: 0,
	sceneColorEnvInfluence: 0,
	rayleighMieLerpFactor: 0,
	distanceEdgeBlendFactor: 0,
	roughness: 0,
	specular: 0,
	waterIOR: 0,
	envLightSpecularIntensity: 0,
	punctualLightSpecularIntensity: 0,
	distanceFade: 0,
	flowBaseColor: 4,
	foamColorG: 4,
	foamOpacity: 0,
	foamRoughness: 0,
	foamShapeOffset: 0,
	foamFadeDistance: 0,
	causticTilling: 0,
	causticOpacity: 0,
	causticDistort: 0,
	causticSpeed: 0,
	causticStartDepth: 0,
	causticEndDepth: 0,
	useFlowMap: 0,
	flowDirectionVector2: 2,
	flowSpeed: 0,
	flowFullCycle: 0,
	normalTilling: 0,
	normalScale: 0,
	smallWaveNormalType: 0,
	largeWaveNormalType: 0,
	largeWaveFlowSpeed: 0,
	largeWaveNormalTilling: 0,
	largeWaveNormalScale: 0,
	flowFullCycleLarge: 0,
	largeWaveInvDir: 0,
};

/**
 * @returns the config as the package stores it
 * @throws {Error} if a field {@link WaterConfig} names is missing or has another shape, so a viewer can read
 *   every named field as typed
 */
const configEntry = ({ name, values }: WaterSurfaceConfig): WaterConfigEntry => {
	for (const [field, length] of Object.entries(CONFIG_FIELDS)) {
		const value = values[field];
		const fits = length === 0 ? typeof value === 'number' : Array.isArray(value) && value.length === length;
		if (!fits) {
			throw new Error(`${name}: ${field} is ${JSON.stringify(value) ?? 'missing'}`);
		}
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every named field was checked above
	return { name, values: values as WaterConfig };
};

const surfaceEntry = (surface: SourcedWaterSurface, geometry: number, config: number): WaterSurfaceEntry => {
	const m = surface.matrix;
	return {
		id: surface.id,
		levelTag: surface.levelTag,
		condition: null,
		geometry,
		// top three rows of the column-major matrix, row-major
		transform: [m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14]],
		bounds: aabbBounds(surface.bounds),
		config,
		renderTypeMask: surface.renderTypeMask,
		param1: surface.param1,
	};
};
