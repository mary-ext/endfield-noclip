import type { WaterGlobalConfig, WaterSurfaceConfig } from '@endfield-noclip/formats/endfield/water';
import type { PPtr } from '@endfield-noclip/formats/unity/values';
import type { TextureRef } from '@endfield-noclip/package-format/textures';
import type { Rect, Vec2, Vec4 } from '@endfield-noclip/package-format/values';
import type {
	WaterConfig,
	WaterConfigEntry,
	WaterGlobal,
	WaterPlacedSurface,
	WaterSurfaceEntry,
	WaterTable,
	WaterVolumeEntry,
	WaterVolumeLevel,
	WaterVolumeSurface,
} from '@endfield-noclip/package-format/water';

import { unique } from '@mary-ext/array-fns';

import type { Context } from '../context.ts';
import { errorText } from '../errors.ts';
import { type AssetResolver, objectKey, type ObjectRef } from '../game/assets.ts';
import type { SyntheticMesh } from '../game/synthetic-mesh.ts';
import {
	loadSectorTexture,
	loadWaterGlobalConfig,
	loadWaterSurfaceConfig,
	type LoadedWaterConfig,
	readSceneWater,
	type SourcedWaterSurface,
} from '../game/water-source.ts';
import type { ScriptWaterLevel } from '../game/water-volume-scripts.ts';
import { loadVolumeSurfaceConfigs } from '../game/water-volume-surfaces.ts';
import type { LevelWaterVolume } from '../game/water-volumes.ts';
import type { ChunkSource } from '../game/world-index.ts';

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
	/** gameplay water volumes in the scene's levels, and those packed */
	volumes: { scene: number; packed: number };
	/** the global config asset's name, or `null` */
	global: string | null;
	/**
	 * sectors with data, those packed, and those of the subset whose sector asset names no tile (its data flag
	 * is set, but there's nothing to draw; listed in {@link untiledSectors})
	 */
	sectors: { scene: number; packed: number; untiled: number };
	/** grid coordinates of the sectors counted in `sectors.untiled` */
	untiledSectors: { x: number; z: number }[];
	/**
	 * per packed surface: id, name, source chunk file, mesh and config paths, and a placed surface's raw render
	 * type mask and `param1` (`null` for a volume's), which the table doesn't carry
	 */
	rows: {
		id: number;
		name: string;
		file: string;
		mesh: string | null;
		config: string | null;
		renderTypeMask: number | null;
		param1: number[] | null;
	}[];
	/** assets that couldn't be loaded; surfaces whose config failed are left out */
	errors: string[];
}

/** water planned before asset conversion */
export interface WaterPlan {
	/**
	 * texture fields hold indices into {@link textures} until {@link finishWater}; surface groups are 0 until the
	 * packer interns {@link surfaceOwners}
	 */
	table: WaterTable;
	/**
	 * per table surface: its level's tag and the chunk files that load it, `null` for a water volume, which
	 * loads with its level
	 */
	surfaceOwners: { levelTag: number; sources: ChunkSource[] | null }[];
	textures: PlacedTexture[];
	/**
	 * per table volume, per entry of its `levels`: whether the level authors it, and the script actions that
	 * set it, for the volume's `waterLevel` control
	 */
	levelSources: WaterLevelSource[][];
	debug: WaterDebug;
}

/** where one fill of a water volume comes from */
export interface WaterLevelSource {
	authored: boolean;
	actions: ScriptWaterLevel[];
	/** whether it's the empty or full end of a pool the player pumps (see {@link pumped}) */
	pumped: boolean;
}

/**
 * @param volume a water volume
 * @returns whether the player can pump it anywhere between empty and full: factory water holding an amount,
 *   not following another volume's surface
 */
export const pumped = (volume: LevelWaterVolume): boolean =>
	volume.factory && !volume.infinite && volume.parent === null && volume.id !== '0';

/**
 * @param volume a water volume's id
 * @returns the id of its `waterLevel` control
 */
export const waterLevelControl = (volume: string): string => `waterLevel:${volume}`;

/**
 * @param volume a water volume's table entry
 * @returns whether scripts set it to a fill other than its authored one, so it has a `waterLevel` control
 */
export const hasWaterLevelControl = (volume: WaterVolumeEntry): boolean => volume.levels.length > 1;

/**
 * points each volume with a `waterLevel` control at it; the table's volumes are modified in place
 *
 * @param table the water table
 * @param controlIndex by control id, the package's index of each control
 * @throws {Error} if a volume's control isn't among the package's
 */
export const indexWaterControls = (table: WaterTable, controlIndex: ReadonlyMap<string, number>): void => {
	for (const volume of table.volumes) {
		if (hasWaterLevelControl(volume)) {
			const id = waterLevelControl(volume.entityId);
			const index = controlIndex.get(id);
			if (index === undefined) {
				throw new Error(`water volume control ${id} isn't among the package's controls`);
			}
			volume.control = index;
		}
	}
};

/** the scene's gameplay water volumes, as the entity pass found them */
export interface WaterVolumeInput {
	volumes: LevelWaterVolume[];
	/** LevelData files whose volumes couldn't be read */
	unsupported: { path: string; reason: string }[];
}

/** what {@link planWater} needs from the packer */
export interface WaterPlanOptions {
	/** whether the package's subset keeps content with this level tag centred at world x, z */
	includes: (tag: number, x: number, z: number) => boolean;
	/** whether the package is a subset; full packages keep every sector */
	subset: boolean;
	/** interns a mesh into the geometry table */
	geometry: (hash: bigint) => number;
	/** interns a mesh the packer makes into the geometry table */
	syntheticGeometry: (mesh: SyntheticMesh) => number;
	/** gameplay water volumes to draw as surfaces */
	volumes: WaterVolumeInput;
	/** constant fills the scene's level scripts set volumes to */
	scriptLevels: readonly ScriptWaterLevel[];
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
		table: { global: null, configs: [], surfaces: [], volumes: [] },
		surfaceOwners: [],
		textures: [],
		levelSources: [],
		debug: {
			surfaces: { scene: water.surfaces.length, packed: 0 },
			volumes: { scene: options.volumes.volumes.length, packed: 0 },
			global: null,
			sectors: { scene: 0, packed: 0, untiled: 0 },
			untiledSectors: [],
			rows: [],
			errors: options.volumes.unsupported.map(({ path, reason }) => `water volumes of ${path}: ${reason}`),
		},
	};
	const volumes = options.volumes.volumes.filter((volume) => {
		const [x, z] = polygonCenter(volume.points);
		return options.includes(volume.levelTag, x, z);
	});
	if (selected.length === 0 && volumes.length === 0) {
		return plan;
	}
	const [resolver, pathOf] = await Promise.all([context.resolver(), world.pathLookup()]);

	// volumes that name no config take their liquid's surface prefab's
	const liquids = unique(
		volumes.filter((volume) => volume.configHash === null).map(({ itemType }) => itemType),
	);
	let liquidConfigs = new Map<string, LoadedWaterConfig<WaterSurfaceConfig> | Error>();
	if (liquids.length > 0) {
		try {
			liquidConfigs = await loadVolumeSurfaceConfigs({ world, resolver }, liquids);
		} catch (error) {
			plan.debug.errors.push(`water volume surfaces: ${errorText(error)}`);
		}
	}

	/** by config key (a path hash, or a liquid's item type), its table index */
	const configIndex = new Map<bigint | string, number>();
	/** by liquid item type, its config's name (reached by PPtr, so its path isn't known) */
	const liquidConfigNames = new Map<string, string>();
	const configHashes = unique([
		...selected.map((surface) => surface.configHash),
		...volumes.flatMap((volume) => (volume.configHash === null ? [] : [volume.configHash])),
	]);
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
	for (const [i, entry] of loaded.entries()) {
		if (entry instanceof Error) {
			plan.debug.errors.push(entry.message);
		} else {
			configIndex.set(configHashes[i], plan.table.configs.length);
			plan.table.configs.push(entry);
		}
	}
	for (const liquid of liquids) {
		const loadedConfig = liquidConfigs.get(liquid);
		if (loadedConfig === undefined) {
			continue;
		}
		try {
			if (loadedConfig instanceof Error) {
				throw loadedConfig;
			}
			const entry = configEntry(loadedConfig.config);
			configIndex.set(liquid, plan.table.configs.length);
			liquidConfigNames.set(liquid, entry.name);
			plan.table.configs.push(entry);
		} catch (error) {
			plan.debug.errors.push(`${liquid} surface config: ${errorText(error)}`);
		}
	}

	for (const surface of selected) {
		const config = configIndex.get(surface.configHash);
		if (config === undefined) {
			continue;
		}
		plan.table.surfaces.push(surfaceEntry(surface, options.geometry(surface.meshHash), config));
		plan.surfaceOwners.push({ levelTag: surface.levelTag, sources: surface.sources });
		plan.debug.rows.push({
			id: surface.id,
			name: surface.name,
			file: surface.source.name,
			mesh: pathOf(surface.meshHash) ?? null,
			config: pathOf(surface.configHash) ?? null,
			renderTypeMask: surface.renderTypeMask,
			param1: surface.param1,
		});
	}
	plan.debug.surfaces.packed = plan.table.surfaces.length;
	/** per table volume, the game id of the volume it follows */
	const parents: (string | null)[] = [];
	for (const volume of volumes) {
		const config = configIndex.get(volume.configHash ?? volume.itemType);
		if (config === undefined) {
			continue;
		}
		let geometry: number;
		try {
			geometry = options.syntheticGeometry({ kind: 'polygon', points: volume.points });
		} catch (error) {
			plan.debug.errors.push(`water volume ${volume.id}: ${errorText(error)}`);
			continue;
		}
		const index = plan.table.volumes.length;
		const { entry, sources, parent } = volumeEntry(volume, options.scriptLevels);
		plan.table.volumes.push(entry);
		parents.push(parent);
		plan.levelSources.push(sources);
		plan.table.surfaces.push(volumeSurface(volume, geometry, config, index));
		plan.surfaceOwners.push({ levelTag: volume.levelTag, sources: null });
		plan.debug.rows.push({
			id: Number(volume.id),
			name: `water volume ${volume.id}`,
			file: volume.source,
			mesh: null,
			config:
				volume.configHash === null
					? (liquidConfigNames.get(volume.itemType) ?? null)
					: (pathOf(volume.configHash) ?? null),
			renderTypeMask: null,
			param1: null,
		});
	}
	// a parent left out of the package (its config failed, or the subset dropped it) leaves the volume its own
	const indexOfVolume = new Map(plan.table.volumes.map((volume, i) => [volume.entityId, i]));
	for (const [i, parent] of parents.entries()) {
		plan.table.volumes[i].parent = parent === null ? null : (indexOfVolume.get(parent) ?? null);
	}
	plan.debug.volumes.packed = plan.table.volumes.length;
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
		plan.debug.sectors.untiled = plan.debug.untiledSectors.length;
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
		ref === null
			? null
			: textureIndex.getOrInsertComputed(objectKey(ref), () => plan.textures.push({ ref, place }) - 1);
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
		const tile = tiles[i];
		if (tile === null) {
			// the sector asset loaded but its tile slot is empty
			plan.debug.untiledSectors.push({ x: sector.x, z: sector.z });
			continue;
		}
		const texture = add(settled(tile), options.placeSector(sectorRect(global, sector)));
		if (texture !== null) {
			global.sectors.push({ x: sector.x, z: sector.z, texture });
		}
	}
	return global;
};

/** `foamFadeDistance` is clamped to this before inverting it, so the rate stays finite (JSON has no ∞) */
const MIN_FOAM_FADE_DISTANCE = 1e-4;

/**
 * @returns what the shading takes from a config, with the game's own transforms applied (see
 *   docs/game-data/water.md#shading)
 * @throws {Error} if a field the shading takes is missing or has another shape
 */
export const configEntry = ({ name, values }: WaterSurfaceConfig): WaterConfigEntry => {
	const number = (field: string): number => {
		const value = values[field];
		if (typeof value !== 'number') {
			throw new Error(`${name}: ${field} is ${JSON.stringify(value) ?? 'missing'}`);
		}
		return value;
	};
	const array = (field: string, length: number): number[] => {
		const value = values[field];
		if (!Array.isArray(value) || value.length !== length) {
			throw new Error(`${name}: ${field} is ${JSON.stringify(value) ?? 'missing'}`);
		}
		return value;
	};
	const vec2 = (field: string): Vec2 => {
		const [x, y] = array(field, 2);
		return [x, y];
	};
	const vec4 = (field: string): Vec4 => {
		const [x, y, z, w] = array(field, 4);
		return [x, y, z, w];
	};
	const config: WaterConfig = {
		waterRayleighScatteringMeter: vec4('waterRayleighScatteringMeter'),
		waterRayleighAbsorptionMeter: vec4('waterRayleighAbsorptionMeter'),
		waterRayleighAbsorptionMeter2: vec4('waterRayleighAbsorptionMeter2'),
		safeFullAbsorpDistance: number('safeFullAbsorpDistance'),
		envLightIntensity: number('envLightIntensity'),
		sceneColorEnvInfluence: number('sceneColorEnvInfluence'),
		rayleighMieLerpFactor: number('rayleighMieLerpFactor'),
		distanceEdgeBlendFactor: number('distanceEdgeBlendFactor'),
		roughness: number('roughness'),
		specular: number('specular'),
		waterIOR: number('waterIOR'),
		envLightSpecularIntensity: number('envLightSpecularIntensity'),
		distanceFade: number('distanceFade'),
		distanceNormalMinStrength: number('distanceNormalMinStrength'),
		normalMipBias: (0.5 - number('envSpecularDesaturation')) * 10,
		dirSpecNormalScaler: number('dirSpecNormalScaler'),
		foamColorG: vec4('foamColorG'),
		foamOpacity: number('foamOpacity'),
		foamRoughness: number('foamRoughness'),
		foamShapeOffset: number('foamShapeOffset'),
		foamFadeRate: 1 / Math.max(number('foamFadeDistance'), MIN_FOAM_FADE_DISTANCE),
		waterBaseColorSubsurfaceScaler: number('waterBaseColorSubsurfaceScaler'),
		emissiveStrength: number('emissiveStrength'),
		causticTilling: number('causticTilling'),
		causticOpacity: number('causticOpacity'),
		causticDistort: number('causticDistort'),
		causticSpeed: number('causticSpeed'),
		causticStartDepth: number('causticStartDepth'),
		causticEndDepth: number('causticEndDepth'),
		useFlowMap: number('useFlowMap') !== 0,
		flowMapCoverage: number('FlowmapOption') === 1,
		flowDirectionVector2: vec2('flowDirectionVector2'),
		flowSpeed: number('flowSpeed'),
		flowFullCycle: number('flowFullCycle'),
		normalTilling: number('normalTilling'),
		normalScale: number('normalScale'),
		smallWaveNormalType: number('smallWaveNormalType'),
		largeWaveNormalType: number('largeWaveNormalType'),
		largeWaveSignedSpeed: number('largeWaveFlowSpeed') * (number('largeWaveInvDir') !== 0 ? -1 : 1),
		largeWaveNormalTilling: number('largeWaveNormalTilling'),
		largeWaveNormalScale: number('largeWaveNormalScale'),
		flowFullCycleLarge: number('flowFullCycleLarge'),
	};
	return { name, values: config };
};

/** @returns the centre of a polygon's x, z bounding box */
const polygonCenter = (points: readonly (readonly [number, number])[]): [x: number, z: number] => {
	const xs = points.map(([x]) => x);
	const zs = points.map(([, z]) => z);
	return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2];
};

/** fills closer than this are one level */
const FRACTION_EPSILON = 1e-4;

/**
 * @param volume a volume
 * @param scripts every constant fill the scene's scripts set
 * @returns the volume's table entry, with its authored fill and the fills scripts set it to (its parent is
 *   left for {@link planWater}), per level where it comes from, and the game id of the volume it follows, or
 *   `null`
 */
export const volumeEntry = (
	volume: LevelWaterVolume,
	scripts: readonly ScriptWaterLevel[],
): { entry: WaterVolumeEntry; sources: WaterLevelSource[]; parent: string | null } => {
	const found: { fraction: number; speed: number | null; source: WaterLevelSource }[] = [
		{ fraction: volume.fraction, speed: null, source: { authored: true, actions: [], pumped: false } },
	];
	const at = (fraction: number) => {
		let entry = found.find((other) => Math.abs(other.fraction - fraction) < FRACTION_EPSILON);
		if (entry === undefined) {
			entry = { fraction, speed: null, source: { authored: false, actions: [], pumped: false } };
			found.push(entry);
		}
		return entry;
	};
	for (const level of scripts) {
		if (level.volume !== volume.id) {
			continue;
		}
		const raw =
			level.kind === 'fraction' ? level.value : volume.amountMax > 0 ? level.value / volume.amountMax : 0;
		const entry = at(Math.min(Math.max(raw, 0), 1));
		entry.source.actions.push(level);
		if (level.speed !== null) {
			entry.speed ??= level.speed;
		}
	}
	if (pumped(volume)) {
		at(0).source.pumped = true;
		at(1).source.pumped = true;
	}
	// a volume holding an amount moves its fill speed in amount units a second
	// (docs/game-data/water.md#depletable-pools)
	const fillSpeed =
		volume.infinite || volume.amountMax <= 0
			? volume.fillSpeed
			: (volume.fillSpeed * volume.heightMax) / volume.amountMax;
	const sorted = found.toSorted((a, b) => a.fraction - b.fraction);
	const levels: WaterVolumeLevel[] = sorted.map(({ fraction, speed }) => ({
		fraction,
		speed: speed ?? fillSpeed,
	}));
	return {
		entry: {
			entityId: volume.id,
			base: volume.pivot[1],
			heightMax: volume.heightMax,
			initial: volume.fraction,
			fillSpeed,
			levels,
			// the control's index is known once the package's controls are (see `indexWaterControls`)
			control: null,
			// the table index of the parent is known once every volume is in (see `parent` below)
			parent: null,
		},
		sources: sorted.map(({ source }) => source),
		parent: volume.parent,
	};
};

/** @returns a volume's surface at its authored fill: its polygon, which lies at y = 0, raised to the surface */
const volumeSurface = (
	volume: LevelWaterVolume,
	geometry: number,
	config: number,
	index: number,
): WaterVolumeSurface => {
	const y = volume.pivot[1] + volume.heightMax * volume.fraction;
	const xs = volume.points.map(([x]) => x);
	const zs = volume.points.map(([, z]) => z);
	return {
		kind: 'volume',
		entityId: Number(volume.id),
		group: 0,
		geometry,
		transform: [1, 0, 0, 0, 0, 1, 0, y, 0, 0, 1, 0],
		bounds: { min: [Math.min(...xs), y, Math.min(...zs)], max: [Math.max(...xs), y, Math.max(...zs)] },
		config,
		// the game draws a volume through an HGWaterRendererV2 of a pooled prefab whose render type isn't
		// recovered; the polygon faces straight up either way
		meshNormals: false,
		volume: index,
	};
};

/** `HGWaterRenderType.LOD`: the game redraws the surface as an upward-facing, wave-displaced grid */
const RENDER_TYPE_LOD = 2;

const surfaceEntry = (surface: SourcedWaterSurface, geometry: number, config: number): WaterPlacedSurface => {
	const m = surface.matrix;
	return {
		kind: 'placed',
		entityId: surface.id,
		// interned once every surface's owner is known
		group: 0,
		geometry,
		// top three rows of the column-major matrix, row-major
		transform: [m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14]],
		bounds: aabbBounds(surface.bounds),
		config,
		// LOD surfaces' mesh normals never show in game (and point down on some polygon meshes)
		meshNormals: (surface.renderTypeMask & RENDER_TYPE_LOD) === 0,
	};
};
