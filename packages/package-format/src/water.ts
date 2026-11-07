import type { TextureRef } from './textures.ts';
import type { Bounds, Color, Vec2, Vec4 } from './values.ts';

/**
 * `tables/water.json`: the scene's open-world water. every surface is resident (the game keeps them in its
 * Global chunks), so the table is loaded with the core. a viewer shows the surfaces whose group shows, like
 * instances, and shades them with their config and the global maps
 */
export interface WaterTable {
	/** the scene's global water, or `null` if the scene has none or the package holds no surface */
	global: WaterGlobal | null;
	/** surface configs, deduplicated; {@link WaterSurfaceEntry.config} indexes this list */
	configs: WaterConfigEntry[];
	surfaces: WaterSurfaceEntry[];
	/**
	 * gameplay water volumes; their surfaces are in {@link surfaces}, naming them by
	 * {@link WaterVolumeSurface.volume}
	 */
	volumes: WaterVolumeEntry[];
}

/**
 * a gameplay water volume (LevelData `waterVolumes`): a polygon of water whose surface level scripts raise
 * and lower. its surface sits at `base + heightMax · fraction`; its {@link WaterSurfaceEntry} is packed at
 * {@link initial}, and a viewer moves it, and the instance rows floating on the volume (an instance block's
 * `floaters`), vertically by the difference
 */
export interface WaterVolumeEntry {
	/** the game's id, decimal, for tracing the volume back */
	entityId: string;
	/** the volume's floor, world y */
	base: number;
	/** metres from {@link base} to a full volume */
	heightMax: number;
	/** the fill (0–1) the level authors it at, before any script runs */
	initial: number;
	/** metres per second the surface moves at between fills, as scripts move it */
	fillSpeed: number;
	/** fills the scene's level scripts set the volume to, ascending and deduplicated; {@link initial} is listed */
	levels: WaterVolumeLevel[];
	/**
	 * index into `StatesInfo.controls` of the `waterLevel` control whose value indexes {@link levels}, with what
	 * sets each; `null` when scripts set no fill other than {@link initial}
	 */
	control: number | null;
	/**
	 * index into {@link WaterTable.volumes} of the volume whose surface this one follows, clamped to its own
	 * depth: the surface sits at the parent's height, but no lower than {@link base} and no higher than full.
	 * `null` for a volume of its own; a following volume has no control
	 */
	parent: number | null;
}

/** a fill a water volume can be at */
export interface WaterVolumeLevel {
	/** 0–1 of {@link WaterVolumeEntry.heightMax} */
	fraction: number;
	/**
	 * metres per second the surface moves at on its way here: the speed a script sets before moving it here,
	 * else {@link WaterVolumeEntry.fillSpeed}
	 */
	speed: number;
}

/** the scene's `Global_Water_Config`: maps shared by every surface. textures are the game's, unchanged */
export interface WaterGlobal {
	/** edge of the square the global flow map and the sector grid cover, metres */
	mapSize: number;
	/** edge of one sector, metres */
	sectorSize: number;
	/** world x, z the grid is centred on (`sceneCenterOffset`) */
	center: [x: number, z: number];
	/** metres per texel of a sector tile */
	flowmapPrecision: number;
	/**
	 * flow over the whole grid, at `uv = (world.xz - center) / mapSize + 0.5`: RG direction (green negated), B
	 * foam, A wave amplitude
	 */
	flowMap: TextureRef;
	causticMap: TextureRef;
	/** a `2d-array` of wave normals: RG normal, B height, A foam shape (read on the small-wave layer only) */
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
 * what the water shading takes from a surface `WaterConfig`. fields keep the game's serialized names where
 * the value is the game's as authored (colours as {@link Color}s as authored); the few the game transforms
 * before its shaders read them are resolved at pack time under names of their own. fields the shading doesn't
 * take (the editor-side tints the `*Meter` vectors come from, ripples, displacement, TAA tweaks) aren't
 * packed
 */
export interface WaterConfig {
	// optics
	/** Rayleigh scattering per metre, rgb (`w` unused) */
	waterRayleighScatteringMeter: Vec4;
	/** absorption per metre in deep water, rgb (`w` unused) */
	waterRayleighAbsorptionMeter: Vec4;
	/** absorption per metre in shallow water, rgb, blending to the deep one by {@link safeFullAbsorpDistance} */
	waterRayleighAbsorptionMeter2: Vec4;
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
	/** metres over which the waves fade with distance (sooner at grazing angles) */
	distanceFade: number;
	/** the large waves' strength once faded */
	distanceNormalMinStrength: number;
	/**
	 * mip bias of {@link WaterGlobal.normalMaps}: `(0.5 − envSpecularDesaturation) · 10`, the game's misnamed
	 * normal-map mip offset
	 */
	normalMipBias: number;
	/** vertical scale of the normal the sun's highlight takes */
	dirSpecNormalScaler: number;
	/** the foam's colour */
	foamColorG: Color;
	foamOpacity: number;
	foamRoughness: number;
	foamShapeOffset: number;
	/** `1 / foamFadeDistance` (the metres over which foam fades out), as the game uploads it; finite */
	foamFadeRate: number;
	waterBaseColorSubsurfaceScaler: number;
	emissiveStrength: number;
	// caustics
	causticTilling: number;
	causticOpacity: number;
	causticDistort: number;
	causticSpeed: number;
	causticStartDepth: number;
	causticEndDepth: number;
	// flow and waves
	/** whether to follow the flow maps rather than flow along {@link flowDirectionVector2} */
	useFlowMap: boolean;
	/** whether the flow map's alpha masks the surface instead of scaling the waves (the game's `FlowmapOption` 1) */
	flowMapCoverage: boolean;
	/** the flow direction without a flow map, encoded as the map's rg (`· 2 − 1`, green negated) */
	flowDirectionVector2: Vec2;
	flowSpeed: number;
	flowFullCycle: number;
	normalTilling: number;
	normalScale: number;
	/** layer of {@link WaterGlobal.normalMaps} for the small waves */
	smallWaveNormalType: number;
	/** layer of {@link WaterGlobal.normalMaps} for the large waves */
	largeWaveNormalType: number;
	/** the large waves' `largeWaveFlowSpeed`, negated when the game's `largeWaveInvDir` reverses them */
	largeWaveSignedSpeed: number;
	largeWaveNormalTilling: number;
	largeWaveNormalScale: number;
	flowFullCycleLarge: number;
}

/** one water surface: a placed surface or a water volume's */
export type WaterSurfaceEntry = WaterPlacedSurface | WaterVolumeSurface;

/** a surface the scene places (InitChunkData component 30), with its own mesh */
export interface WaterPlacedSurface extends WaterSurfaceBase {
	kind: 'placed';
}

/**
 * a gameplay water volume's surface: its outline as a flat mesh, packed at the volume's authored fill and
 * moved with it
 */
export interface WaterVolumeSurface extends WaterSurfaceBase {
	kind: 'volume';
	/** index into {@link WaterTable.volumes} */
	volume: number;
}

/** what every water surface has */
export interface WaterSurfaceBase {
	/** the game's entity id, for tracing the surface back */
	entityId: number;
	/**
	 * index into `StatesInfo.groups`: the owning level and the scene states that load the surface (map02's
	 * paddy-field pools load with some)
	 */
	group: number;
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
	/**
	 * whether the surface is shaded around its mesh normals (when the mesh has them) rather than straight up.
	 * the game shades its LOD surfaces through an upward-facing grid, so only proxy-only surfaces keep theirs
	 */
	meshNormals: boolean;
}
