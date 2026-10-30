import type { TextureRef } from './textures.ts';
import type { Bounds, Color, Vec2, Vec4 } from './values.ts';

/**
 * `tables/water.json`: the scene's open-world water. every surface is resident (the game keeps them in its
 * Global chunks), so the table is loaded with the core. a viewer shows the surfaces carrying the current
 * level's tag plus tag 0, like instances, and shades them with their config and the global maps
 */
export interface WaterTable {
	/** the scene's global water, or `null` if the scene has none or the package holds no surface */
	global: WaterGlobal | null;
	/** surface configs, deduplicated; {@link WaterSurfaceEntry.config} indexes this list */
	configs: WaterConfigEntry[];
	surfaces: WaterSurfaceEntry[];
}

/**
 * the scene's `Global_Water_Config`: maps shared by every surface. textures are the game's, unchanged. the
 * global flow map covers the square of edge {@link mapSize} around {@link center}, i.e. (assumed from the
 * game's tooling, not its shaders) `uv = (world.xz - center) / mapSize + 0.5`
 */
export interface WaterGlobal {
	/** edge of the square the global flow map and the sector grid cover, metres */
	mapSize: number;
	/** edge of one sector, metres */
	sectorSize: number;
	/** world x, z the grid is centred on (`sceneCenterOffset`) */
	center: [x: number, z: number];
	/** metres per texel of a sector tile */
	flowmapPrecision: number;
	/** flow over the whole grid: RG direction, B foam, A amplitude (channel meanings unconfirmed) */
	flowMap: TextureRef;
	causticMap: TextureRef;
	/** a `2d-array` of wave normals (RG normal; A foam shape on the small-wave layer, unconfirmed) */
	normalMaps: TextureRef;
	rainMap: TextureRef;
	/**
	 * high-resolution flow tiles, like {@link flowMap} at {@link flowmapPrecision} m/texel. sector `(x, z)`
	 * covers world `[center.x + x·sectorSize, +sectorSize) × [center.z + z·sectorSize, +sectorSize)`. only the
	 * sectors that have data and overlap a packed surface are listed; elsewhere use {@link flowMap}
	 */
	sectors: WaterSector[];
}

/** one flow-map tile of the sector grid */
export interface WaterSector {
	x: number;
	z: number;
	texture: TextureRef;
}

/** a surface `WaterConfig` */
export interface WaterConfigEntry {
	/** asset name, e.g. `Config_water_Map02_15` */
	name: string;
	values: WaterConfig;
}

/**
 * a surface `WaterConfig`'s numeric fields under the game's serialized names: scalars as numbers (flags as
 * 0/1), vectors as `[x, y(, z, w)]`, colours as {@link Color}s as authored. the fields named here are those a
 * renderer needs; every other numeric field (character ripples, displacement, TAA tweaks, …) is kept under
 * its own name too
 */
export interface WaterConfig {
	[field: string]: number | number[];
	// optics
	/** Rayleigh scattering per metre, rgb (`w` unused) */
	waterRayleighScatteringMeter: Vec4;
	/** absorption per metre, rgb; `w` unconfirmed */
	waterRayleighAbsorptionMeter: Vec4;
	/** a second absorption, rgb; how it combines with the first is unconfirmed */
	waterRayleighAbsorptionMeter2: Vec4;
	absorptionTint: Color;
	absorptionTint2: Color;
	absorptionScale: number;
	scatterTint: Color;
	scatterScale: number;
	/** depth (m) past which the water is fully absorbed */
	safeFullAbsorpDistance: number;
	envLightIntensity: number;
	sceneColorEnvInfluence: number;
	rayleighMieLerpFactor: number;
	distanceEdgeBlendFactor: number;
	// appearance
	roughness: number;
	specular: number;
	/** screen-space refraction distortion strength, not an index of refraction */
	waterIOR: number;
	envLightSpecularIntensity: number;
	punctualLightSpecularIntensity: number;
	distanceFade: number;
	flowBaseColor: Color;
	foamColorG: Color;
	foamOpacity: number;
	foamRoughness: number;
	foamShapeOffset: number;
	foamFadeDistance: number;
	// caustics
	causticTilling: number;
	causticOpacity: number;
	causticDistort: number;
	causticSpeed: number;
	causticStartDepth: number;
	causticEndDepth: number;
	// flow and waves
	/** 1 to follow the flow maps, 0 to flow along {@link flowDirectionVector2} */
	useFlowMap: number;
	flowDirectionVector2: Vec2;
	flowSpeed: number;
	flowFullCycle: number;
	normalTilling: number;
	normalScale: number;
	/** layer of {@link WaterGlobal.normalMaps} for the small waves */
	smallWaveNormalType: number;
	/** layer of {@link WaterGlobal.normalMaps} for the large waves */
	largeWaveNormalType: number;
	largeWaveFlowSpeed: number;
	largeWaveNormalTilling: number;
	largeWaveNormalScale: number;
	flowFullCycleLarge: number;
	largeWaveInvDir: number;
}

/** one water surface */
export interface WaterSurfaceEntry {
	/** the game's entity id */
	id: number;
	/** the owning level's tag (`id >>> 27`), matching {@link LevelInfo.tag} */
	levelTag: number;
	/**
	 * index into {@link StatesInfo.conditionalSets} when the surface only loads with some scene states (map02's
	 * paddy-field pools), `null` when it's always loaded
	 */
	condition: number | null;
	/**
	 * geometry-table id. only positions are needed (the shading works in world x, z), and some meshes have no
	 * UVs; no tangents are generated
	 */
	geometry: number;
	/**
	 * object-to-world, rows3x4 as in {@link InstanceBlock.transforms} but absolute. many river and polygon
	 * meshes are authored in world space and have an identity transform; quads and planes are 0.1 m and scaled
	 * up
	 */
	transform: number[];
	/** world bounds, from the game */
	bounds: Bounds;
	/** index into {@link WaterTable.configs} */
	config: number;
	/** bit mask of the game's `HGWaterRenderType` (1 `Proxy`, 2 `LOD`); 1 or 2 in the current client */
	renderTypeMask: number;
	/** the game's per-surface `param1`; `w` is always 1, `x`/`y`/`z` meaning unknown */
	param1: Vec4;
}
