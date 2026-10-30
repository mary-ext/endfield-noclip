/**
 * the viewer package: what the extractor's `pack` command writes and the viewer streams. shared by both, so
 * it stays free of node APIs. the binary parts are encoded and decoded by `codec.ts`.
 *
 * blob offsets in `tables/blobs.bin` are relative to each archive's data section, so the viewer range-reads a
 * blob without parsing the archive's JSON header; czar provides the container, CRCs and tooling.
 *
 * a package is one streaming scene (one world, one coordinate frame). it's stored as czar archives: a small
 * always-resident `core.czar` holding the manifest, the tile tree, the tables and the coarse layer, and shard
 * archives holding everything else. archive members are content-addressed blobs (`blobs/<hash>.<ext>`) plus
 * the core's fixed paths in {@link CORE_PATHS}.
 *
 * @module
 */

// #region versions and paths

/** value of {@link PackageManifest.format} */
export const PACKAGE_FORMAT = 'endfield-noclip.package';

/** bumped on any incompatible change to the manifest, a table or a blob encoding */
export const PACKAGE_VERSION = 15;

/** the archive every package has; the viewer opens it first */
export const CORE_ARCHIVE = 'core.czar';

/**
 * fixed member paths inside {@link CORE_ARCHIVE}. `.zst` members are one zstd frame each (the JSON asset
 * tables shrink 6–50× that way); the rest are stored as they are
 */
export const CORE_PATHS = {
	manifest: 'manifest.json',
	tree: 'tree.bin',
	blobs: 'tables/blobs.bin',
	chains: 'tables/chains.bin',
	geometries: 'tables/geometries.json.zst',
	materials: 'tables/materials.json.zst',
	textures: 'tables/textures.json.zst',
	water: 'tables/water.json.zst',
	lights: 'tables/lights.json.zst',
	irradiance: 'tables/irradiance.bin',
} as const;

// #endregion

// #region enums

/** what a blob holds once its {@link BlobCodec} is undone */
export const BlobKind = {
	/** one terrain height page; see `encodeHeightPage` */
	TerrainHeights: 1,
	/** an instance block; see `encodeInstanceBlock` */
	Instances: 2,
	/** one mesh: meshopt-encoded vertex streams, indices and submeshes; see `encodeGeometryBlob` */
	Geometry: 3,
	/**
	 * whole mip levels of one texture as raw texel blocks, no container: a {@link TexturePiece}. levels are
	 * concatenated largest first, each level holding every array layer, cube face and depth slice in WebGPU's
	 * `writeTexture` order; sizes come from {@link textureLevelByteLength}
	 */
	Texture: 4,
	/** anything else */
	Other: 5,
	/**
	 * one cell of the baked irradiance volume, as the game's GPU reads it (`IrradianceCell` in the formats
	 * package): a spatial hash over 4³-probe blocks, then 16-byte L1 probes
	 */
	Irradiance: 6,
	/** one terrain tile's baked albedo and normal pages; see `encodeSurfacePage` */
	TerrainSurface: 7,
	/** one leaf terrain tile's close-up blend inputs; see `encodeSplatPage` */
	TerrainSplat: 8,
	/**
	 * one terrain layer texture: its BC7 mip levels from {@link TerrainSplatInfo.textureSize} down, largest
	 * first, as `writeTexture` takes them (levels under 4² padded to one block)
	 */
	TerrainLayer: 9,
} as const;

export type BlobKind = (typeof BlobKind)[keyof typeof BlobKind];

/** file extension of a blob's archive path, by kind */
export const BLOB_EXTENSIONS: Record<BlobKind, string> = {
	[BlobKind.TerrainHeights]: 'hgt',
	[BlobKind.Instances]: 'inst',
	[BlobKind.Geometry]: 'mesh',
	[BlobKind.Texture]: 'tex',
	[BlobKind.Other]: 'bin',
	[BlobKind.Irradiance]: 'iv',
	[BlobKind.TerrainSurface]: 'tsp',
	[BlobKind.TerrainSplat]: 'tsl',
	[BlobKind.TerrainLayer]: 'tly',
};

/** human-readable blob kind names, for stats and debug output */
export const BLOB_KIND_NAMES: Record<BlobKind, string> = {
	[BlobKind.TerrainHeights]: 'terrain heights',
	[BlobKind.Instances]: 'instances',
	[BlobKind.Geometry]: 'geometry',
	[BlobKind.Texture]: 'texture',
	[BlobKind.Other]: 'other',
	[BlobKind.Irradiance]: 'irradiance',
	[BlobKind.TerrainSurface]: 'terrain surface',
	[BlobKind.TerrainSplat]: 'terrain splat',
	[BlobKind.TerrainLayer]: 'terrain layer',
};

/** the outer compression of a stored blob */
export const BlobCodec = {
	None: 0,
	/** a single zstd frame */
	Zstd: 1,
} as const;

export type BlobCodec = (typeof BlobCodec)[keyof typeof BlobCodec];

/** what a tile content reference points at */
export const ContentKind = {
	/** the node's terrain height page; `param` is the game's `maxHeightError` (m) */
	TerrainHeights: 0,
	/** HLOD cluster rows `[first, first + count)` of an instance block; `tier` is the HLOD tier */
	Hlod: 1,
	/** detail instances of one level: a whole instance block */
	Detail: 2,
	/** independently streamed dynamic instances; `param` indexes {@link StatesInfo.conditionalSets} */
	Conditional: 3,
	/** the node's baked terrain surface page (albedo and normal); covers the same tile as its height page */
	TerrainSurface: 4,
	/** a leaf node's close-up blend inputs (splat control, tint, layer index) */
	TerrainSplat: 5,
} as const;

export type ContentKind = (typeof ContentKind)[keyof typeof ContentKind];

/** readable names of content kinds, for reports and debugging */
export const CONTENT_KIND_NAMES: Record<ContentKind, string> = {
	[ContentKind.TerrainHeights]: 'terrainHeights',
	[ContentKind.Hlod]: 'hlod',
	[ContentKind.Detail]: 'detail',
	[ContentKind.Conditional]: 'conditional',
	[ContentKind.TerrainSurface]: 'terrainSurface',
	[ContentKind.TerrainSplat]: 'terrainSplat',
};

/** how a draw of a LOD chain is used */
export const DrawRole = {
	/** visible geometry */
	Lit: 0,
	/** casts shadows only (a shadow proxy) */
	ShadowOnly: 1,
	/** foliage imposter card mesh */
	Card: 2,
	/** HLOD cluster mesh */
	Hlod: 3,
} as const;

export type DrawRole = (typeof DrawRole)[keyof typeof DrawRole];

/** chain flag bits */
export const ChainFlags = {
	HasShadowOnly: 1 << 0,
	Hlod: 1 << 1,
	HasCard: 1 << 2,
} as const;

/** tree node flag bits */
export const NodeFlags = {
	HasTerrain: 1 << 0,
	HasHlod: 1 << 1,
	HasDetail: 1 << 2,
} as const;

/** instance block flag bits */
export const InstanceBlockFlags = {
	/** rows are grouped by chain, so equal chains form contiguous instanced ranges */
	SortedByChain: 1 << 0,
} as const;

/**
 * what a geometry stream holds. the numbering is Unity's shader channel order, so `TexCoord0 + n` is UV set
 * `n` (the {@link TextureSlot.uv} of a material slot)
 */
export const VertexAttribute = {
	/**
	 * `unorm16x4`, always dequantized: `position = offset + value.xyz · scale` (`w` is 0). the mesh's own frame
	 * (Unity, left-handed)
	 */
	Position: 0,
	/**
	 * `snorm16x2`: an octahedral unit vector `(x, y)`, dequantized first when the stream is flagged (the game's
	 * 10-bit normals are stored as their integers with a scale of 32767/511). decode in the shader: `n = (x, y,
	 * 1 - |x| - |y|)`; where `n.z < 0`, `n.xy = (1 - |n.yx|) · sign(n.xy)` (sign of 0 taken as +1); normalize
	 */
	Normal: 1,
	/**
	 * `snorm8x4`: `xy` is the tangent, octahedral like {@link VertexAttribute.Normal}; `z` is the bitangent sign
	 * (±1). `bitangent = cross(normal, tangent) · sign`, in the mesh's frame; like Unity, multiply by the sign
	 * of the object-to-world determinant (negative under the viewer's mirroring root). MikkTSpace tangents over
	 * UV set {@link GeometryEntry.tangentUv} unless the source mesh had its own
	 */
	Tangent: 2,
	/** `unorm8x4`, or `float16x4` when the source has values outside `[0, 1]` */
	Color: 3,
	/**
	 * UV sets 0–7: `unorm16x2` dequantized like positions when that keeps the error below 2^-13 (a span of at
	 * most 16), else `float32x2`; `snorm8x4` where the source stores 4 signed bytes (the game's UV2/UV3 on
	 * foliage). UVs are the game's, unflipped: texture row 0 is `v = 0`, matching how texel data is stored
	 */
	TexCoord0: 4,
	TexCoord7: 11,
} as const;

/** a {@link VertexAttribute} value; UV sets fill the range `TexCoord0`…`TexCoord7` */
export type VertexAttribute = number;

/**
 * a geometry stream's element format, indexing {@link GEOMETRY_VERTEX_FORMATS}. every format is a whole
 * WebGPU vertex format, and each stream is its own vertex buffer (stride = the format's size)
 */
export const GeometryVertexFormat = {
	Unorm16x4: 0,
	Snorm16x2: 1,
	Snorm8x4: 2,
	Unorm8x4: 3,
	Float16x4: 4,
	Unorm16x2: 5,
	Float32x2: 6,
	Float32x4: 7,
} as const;

export type GeometryVertexFormat = (typeof GeometryVertexFormat)[keyof typeof GeometryVertexFormat];

/** WebGPU name and byte size of each {@link GeometryVertexFormat} */
export const GEOMETRY_VERTEX_FORMATS: Record<GeometryVertexFormat, { gpu: string; size: number }> = {
	[GeometryVertexFormat.Unorm16x4]: { gpu: 'unorm16x4', size: 8 },
	[GeometryVertexFormat.Snorm16x2]: { gpu: 'snorm16x2', size: 4 },
	[GeometryVertexFormat.Snorm8x4]: { gpu: 'snorm8x4', size: 4 },
	[GeometryVertexFormat.Unorm8x4]: { gpu: 'unorm8x4', size: 4 },
	[GeometryVertexFormat.Float16x4]: { gpu: 'float16x4', size: 8 },
	[GeometryVertexFormat.Unorm16x2]: { gpu: 'unorm16x2', size: 4 },
	[GeometryVertexFormat.Float32x2]: { gpu: 'float32x2', size: 8 },
	[GeometryVertexFormat.Float32x4]: { gpu: 'float32x4', size: 16 },
};

/** geometry blob flag bits */
export const GeometryFlags = {
	/** indices are u32; otherwise u16 */
	IndexU32: 1 << 0,
	/** the tangent stream was generated (MikkTSpace) rather than taken from the source mesh */
	GeneratedTangents: 1 << 1,
} as const;

/** geometry stream flag bits */
export const GeometryStreamFlags = {
	/**
	 * apply `offset + value · scale` per component (up to three) to the value as the GPU reads it (normalized
	 * formats already in [0, 1] or [-1, 1]); position, unorm16 UVs and the game's packed normals use it
	 */
	Dequantize: 1 << 0,
} as const;

/**
 * a texture's smallest mip levels are stored together in one blob, the longest run of levels (smallest first)
 * whose combined size stays within this many bytes; every larger level is a blob of its own. for BC7 that's
 * levels up to 128² (21.8 KB) in the tail and 256² (64 KB) as the smallest single-level piece, so no streamed
 * piece is much smaller than this and a texture is drawable after one small read
 */
export const TEXTURE_TAIL_BYTES = 64 * 1024;

// #endregion

// #region manifest

/** `manifest.json` in the core archive */
export interface PackageManifest {
	format: typeof PACKAGE_FORMAT;
	version: number;
	/**
	 * hash over the core's binary and table members. two packages with equal generations are identical; a
	 * viewer keys its caches of decoded tables by it and never mixes generations
	 */
	generation: string;
	scene: SceneInfo;
	coordinates: CoordinateConventions;
	tree: TreeInfo;
	terrain: TerrainInfo | null;
	/**
	 * every level of the scene, whether or not the package's subset includes its content. a viewer shows one
	 * level at a time: the instance refs carrying its tag (each level's content includes its own backdrop),
	 * plus those with tag 0 (shared content, on maps with several levels), over the shared terrain. empty for
	 * scenes without levels, whose instances are all shown
	 */
	levels: LevelInfo[];
	/** environment profiles, deduplicated; {@link LevelInfo.environment} indexes this list */
	environments: EnvironmentProfile[];
	/** every phase an environment volume applies; {@link EnvironmentVolumeInfo.phase} indexes this list */
	environmentPhases: EnvironmentPhaseInfo[];
	/** the scene's environment volumes, for blending at the camera */
	environmentVolumes: EnvironmentVolumeInfo[];
	states: StatesInfo;
	/** archives by index; {@link BlobRecord.archive} indexes this list. entry 0 is the core */
	archives: ArchiveInfo[];
	/** content drawn regardless of the tree's refinement (the game's always-loaded Global scenery) */
	global: ContentRef[];
	/** the slice of the scene that was packed, or `null` for all of it */
	subset: SubsetInfo | null;
	/** identifies the game build the package came from; per-asset provenance lives in the debug index */
	source: SourceFingerprint;
}

/** the streaming scene */
export interface SceneInfo {
	/** streaming scene name, e.g. `map02` */
	id: string;
	/** display name, e.g. `Wuling` */
	name: string | null;
}

/**
 * all positions, matrices and bounds are in the game's Unity frame. the viewer converts to its own frame
 * exactly once, at the root
 */
export interface CoordinateConventions {
	frame: 'unity';
	/** Unity is left-handed: +X right, +Y up, +Z forward (north on the game map) */
	handedness: 'left';
	units: 'm';
	/**
	 * the transform a right-handed viewer applies at its root. it mirrors geometry, so the viewer also swaps
	 * its front-face winding
	 */
	viewerRoot: 'scale(1, 1, -1)';
	/** see {@link InstanceBlock.transforms} */
	matrices: 'rows3x4';
}

/** the conventions every package uses */
export const COORDINATE_CONVENTIONS: CoordinateConventions = {
	frame: 'unity',
	handedness: 'left',
	units: 'm',
	viewerRoot: 'scale(1, 1, -1)',
	matrices: 'rows3x4',
};

/**
 * the tile hierarchy: a forest of quadtrees on one unbounded grid. level `l` tiles are `rootSize / 2^l`
 * across and tile `(l, x, z)` covers `[origin.x + x·size, +size) × [origin.z + z·size, +size)`; `x`, `z` may
 * be negative or exceed `2^l - 1` for content off the terrain square. children of `(l, x, z)` are `(l + 1, 2x +
 * dx, 2z + dz)`. the grid coincides with the game's terrain quadtree (same origin, same levels)
 */
export interface TreeInfo {
	/** world x, z of tile `(0, 0, 0)`'s minimum corner */
	origin: [x: number, z: number];
	/** edge length of a level-0 tile, metres */
	rootSize: number;
	/** deepest level; its 64 m tiles carry detail instances and HLOD0 */
	leafLevel: number;
	/** level whose tiles are the game's 128 m streaming and level-ownership cells */
	cellLevel: number;
	/** the level each HLOD tier attaches to, by tier */
	hlodLevels: number[];
	/** level whose tiles group shard archives (see {@link ArchiveInfo.tile}) */
	shardLevel: number;
	/** tree.bin record counts, for preallocation */
	nodeCount: number;
	refCount: number;
}

/** scene terrain parameters, from the game's `HGTerrainSurfacesData` */
export interface TerrainInfo {
	/** world position of the terrain square's minimum corner; `y` is the height of a zero sample */
	position: [x: number, y: number, z: number];
	/** metres spanned by the 15-bit height range: `y = position.y + (h & 0x7fff) · heightScale / 32768` */
	heightScale: number;
	/** edge length of the terrain square; equals {@link TreeInfo.rootSize} */
	terrainSize: number;
	/** samples per page edge; pages share their edge samples with neighbours */
	pageSize: number;
	/** bit 15 of a sample marks a hole */
	holeBit: number;
	/** levels that have height pages, ascending (the game ships a pyramid, not just leaves) */
	levels: number[];
	/** texels per surface page edge, border included; see {@link BlobKind.TerrainSurface} */
	surfaceSize: number;
	/** texels of each surface page edge outside the tile; the rest map the tile edge to edge */
	surfaceBorder: number;
	/** the close-up layer blend's inputs, or `null` if they weren't packed */
	splat: TerrainSplatInfo | null;
}

/**
 * the close-up layer blend: each leaf's 8 m cells name 4 layers, blended by the leaf's splat control page,
 * then tinted. leaf tiles carry a {@link ContentKind.TerrainSplat} ref
 */
export interface TerrainSplatInfo {
	/** metres per index cell; a leaf has `leafSize / cellSize` cells per edge */
	cellSize: number;
	/** layers by ordinal, as the splat pages' index cells name them */
	layers: TerrainLayerInfo[];
	/** texels per layer texture edge at its first packed level */
	textureSize: number;
	/** mip levels per layer texture */
	textureLevels: number;
	/** {@link BlobKind.TerrainLayer} blobs by texture index: sRGB albedo with height in alpha */
	diffuse: number[];
	/** ... linear normal xy, roughness, occlusion */
	normal: number[];
}

/** one close-up material layer, from the game's `SplatLayerData` */
export interface TerrainLayerInfo {
	/** index into {@link TerrainSplatInfo.diffuse} and {@link TerrainSplatInfo.normal} */
	texture: number;
	/** texture repeats per metre of world position */
	tiling: number;
	/** uv offset */
	offset: [u: number, v: number];
	/** the layer's mean albedo, linear; the tint applies relative to it */
	meanColor: [r: number, g: number, b: number];
	/** scales the normal map's xy */
	normalScale: number;
	/** multiplies the diffuse texture's rgb */
	diffuseScale: [r: number, g: number, b: number];
	/** how far below the highest layer a layer still shows in the height blend */
	blendBorder: number;
	/** height = diffuse alpha · scale + offset */
	height: [scale: number, offset: number];
	/** occlusion = normal alpha · scale + offset */
	occlusion: [scale: number, offset: number];
	/** roughness = normal blue · scale + offset */
	roughness: [scale: number, offset: number];
}

/** a level (named area) of the scene */
export interface LevelInfo {
	/** LevelConfig id, e.g. `map02_lv001` */
	id: string;
	idNum: number;
	/** entity-id tag (`id >>> 27`) of the content the level owns; also on every instance's entity id */
	tag: number;
	name: string | null;
	/** LevelConfig rect */
	rect: Rect;
	/** where the game spawns the player, Unity world coordinates */
	playerInitPos: [x: number, y: number, z: number];
	/** owned 128 m cells as tile coordinates at {@link TreeInfo.cellLevel} */
	cells: [x: number, z: number][];
	/** instances the level owns in this package, not counting HLOD clusters */
	instances: number;
	/** world bounds of the instances the level owns in this package, or `null` if none were packed */
	contentBounds: Bounds | null;
	/**
	 * index into {@link PackageManifest.environments}: the level's base environment, i.e. the one the game
	 * applies over most of the level's ground. `null` if the level has none
	 */
	environment: number | null;
}

/** a world x, z rectangle */
export interface Rect {
	minX: number;
	minZ: number;
	maxX: number;
	maxZ: number;
}

/** an axis-aligned box */
export interface Bounds {
	min: [x: number, y: number, z: number];
	max: [x: number, y: number, z: number];
}

/**
 * scenery variants. the game's stream areas (`<areaId>` chunk suffixes: interiors, caves, off-map places)
 * aren't kept apart: their content is merged into the levels that own it, so a level is drawn whole. scene
 * states (MapConfig states, the `<sceneStateId>` chunk suffix and dynamic state lists) are toggles whose
 * defaults evaluate the game's conditions for a player who finished the story. progressions
 * (outpost/settlement levels, POI facility levels, factory regions) are selected per progression, with
 * mutually exclusive levels, and manual gates for unrecovered script/logic conditions
 */
export interface StatesInfo {
	progressions: ProgressionInfo[];
	/** independent controls for scene states, scripts and logic gates */
	toggles: SceneToggleInfo[];
	/** visibility expressions of conditional instances, environment volumes and water surfaces */
	conditionalSets: ConditionalSetInfo[];
}

/** a selectable progression */
export interface ProgressionInfo {
	/** `${kind}:${key}`, e.g. `settlement:stm_hongs_1` */
	id: string;
	kind: 'settlement' | 'poi' | 'factoryRegion' | 'facility';
	/** display label when resolved */
	name?: string;
	key: string;
	levelId: string | null;
	/** levels at least one variant is shown at, ascending */
	levels: number[];
	/** the authored initial visual form, or lowest progression level, shown unless the user picks another */
	defaultLevel: number;
}

/** an on/off scene control; no runtime script or server condition is simulated */
export interface SceneToggleInfo {
	/** `sceneState:<MapConfig index>` for scene states; other ids are install-specific */
	id: string;
	name: string;
	/**
	 * `sceneState`: a MapConfig scene state. `mission` / `variable`: a dynamic entity load gate on quest and
	 * mission states / on a map or global variable; on means the gate passes. `script`: a script-loaded entity
	 * group. `logic`: a logic-state gate (the game's `LogicState`) whose condition is not recovered
	 */
	kind: 'sceneState' | 'mission' | 'variable' | 'script' | 'logic';
	/** level tags whose controls list it; 0 lists it everywhere */
	levelTags: number[];
	defaultEnabled: boolean;
	/**
	 * for scene states and gates, the game's condition in words and the assumption the default rests on; `null`
	 * for other kinds
	 */
	condition: string | null;
}

/** one required value of a scene control */
export interface SceneRequirement {
	control: string;
	/** bit n set means selected value n satisfies this requirement */
	mask: number;
}

/** a resource is visible if any alternative has all its requirements satisfied */
export interface ConditionalSetInfo {
	alternatives: SceneRequirement[][];
}

/** one archive of the package */
export interface ArchiveInfo {
	/**
	 * path relative to the package root, e.g. `core.czar`, `shards/3_2_5.czar`, `assets/2_1_2.czar`,
	 * `assets/common.czar`. an asset archive over its size cap continues in `assets/<id>.<n>.czar`, n ≥ 1
	 */
	name: string;
	role: 'core' | 'shards' | 'assets' | 'irradiance';
	/**
	 * `null` for `irradiance` archives (`irradiance/<x>_<z>.czar`: the cells over one 512 m square, see
	 * {@link irradianceArchiveName}). for `shards` archives: the {@link TreeInfo.shardLevel} tile whose subtree
	 * content it holds. for `assets` archives: the tile at or above the shard level whose subtree is the
	 * smallest one containing every use of each asset in it, or `null` for `assets/common*` (global content, or
	 * uses under different root tiles). so everything a tile draws lives in the `assets` archives of that tile
	 * and its ancestors, plus common
	 */
	tile: TileKey | null;
	/** total byte length; `null` for the core, whose size depends on this manifest */
	size: number | null;
	/**
	 * byte position of the archive's data section, which {@link BlobRecord.offset} is relative to. `null` for
	 * the core: read it from the core's own prelude, which the viewer parses when opening it
	 */
	dataOffset: number | null;
}

/** a tile address */
export interface TileKey {
	level: number;
	x: number;
	z: number;
}

/** what a partial package holds */
export interface SubsetInfo {
	/** only content owned by this level (by tag), and terrain under its cells */
	level: string | null;
	/** only content whose centre lies in this world x, z rectangle, and terrain intersecting it */
	bounds: Rect | null;
}

/** the game build */
export interface SourceFingerprint {
	/** the bundle manifest's build guid */
	buildGuid: string;
	/** the bundle manifest's content hash */
	contentHash: string;
}

// #endregion

// #region environment

/** an RGBA colour, as authored (not converted to linear; HDR colours exceed 1) */
export type Color = [r: number, g: number, b: number, a: number];
/** a `Vector2f` */
export type Vec2 = [x: number, y: number];
/** a `Vector3f`; directions and positions are in the Unity world frame */
export type Vec3 = [x: number, y: number, z: number];
/** a `Vector4f` */
export type Vec4 = [x: number, y: number, z: number, w: number];
/** a unit quaternion */
export type Quat = [x: number, y: number, z: number, w: number];

/** a texture-table id, or `null` when unset or not converted */
export type TextureRef = number | null;

/**
 * one environment: an `HGEnvironmentPhase` (`EnvParse/Env_*.asset`) plus the post-processing profile of the
 * level's global `Volume`. each section is the game's `HG*Config` with the game's field names: colours as
 * {@link Color}, vectors as arrays, `SphericalHarmonicsL2` as 27 numbers in the game's order, flags as
 * booleans, nested structs as objects, textures as {@link TextureRef}s. colour curves, editor state and
 * non-texture object references are left out.
 *
 * the game blends environment volumes by priority, and a phase only sets the sections it marks active. a
 * section the level's phase leaves inactive is taken from the scene's global volume's phase (what the game
 * applies under it), so every section here is the one in effect
 */
export interface EnvironmentProfile {
	/** the level phase's asset name, e.g. `Env_map02_lv001_art_Global_01` */
	name: string;
	light: LightConfig;
	sky: SkyConfig;
	atmosphere: AtmosphereConfig;
	fog: FogConfig;
	heightFog: HeightFogConfig;
	volumetricFog: VolumetricFogConfig;
	cloud: CloudConfig;
	wind: WindConfig;
	lightShaft: LightShaftConfig;
	colorGrading: ColorGradingConfig;
	autoExposure: AutoExposureConfig;
	shadow: ShadowConfig;
	/** the level's global post-processing volume, or `null` if it has none */
	post: PostProfile | null;
}

/** the sections of an environment phase, as in {@link EnvironmentProfile} */
export type EnvironmentSections = Omit<EnvironmentProfile, 'name' | 'post'>;

/**
 * an `HGEnvironmentPhase` as the environment volumes apply it: its own sections, uncomposed. sections it
 * marks inactive leave what's under them unchanged
 */
export interface EnvironmentPhaseInfo {
	/** the asset name, e.g. `Env_map02_lv006_jian2_key` */
	name: string;
	/** the sections the phase sets */
	active: (keyof EnvironmentSections)[];
	sections: EnvironmentSections;
}

/** where an environment volume applies, in the Unity world frame */
export type EnvironmentVolumeShape =
	| { kind: 'global' }
	/** a unit cube under the transform */
	| { kind: 'box'; position: Vec3; rotation: Vec3; scale: Vec3 }
	/** a vertical prism over a closed polygon in world x, z, from `bottom` to `top` (world y) */
	| { kind: 'prism'; points: Vec2[]; bottom: number; top: number };

/**
 * an `HGEnvironmentVolume`. the game blends them at the camera each frame (`HGEnvironmentManager`): starting
 * from the default phase, volumes in ascending order of priority (then shape: global, box, prism) that
 * contain the camera apply their phase: blend mode 0 replaces, 1 lerps by `clamp(distance to the edge /
 * blendDistance)`, 2 fades over `fadeIn/OutDuration` seconds (instantly when the camera moves over 5 m in a
 * frame), 3 lerps by a scripted factor
 */
export interface EnvironmentVolumeInfo {
	/** the object's name */
	name: string;
	/** the owning level's tag (0 for scene-wide) */
	levelTag: number;
	shape: EnvironmentVolumeShape;
	blendMode: number;
	priority: number;
	blendDistance: number;
	fadeInDuration: number;
	fadeOutDuration: number;
	/** index into {@link PackageManifest.environmentPhases}, or `null` if the phase is unset or unreadable */
	phase: number | null;
	/**
	 * index into {@link StatesInfo.conditionalSets} when the volume only loads with some scene states, `null`
	 * when it's always loaded
	 */
	condition: number | null;
	/** script activation has not been recovered; previewing this volume assumes it is enabled */
	activation: 'unknown';
}

/**
 * `HGLightConfig`: the sun. physical units: `directLux` is illuminance and `directEV100` the exposure, with
 * `preExposure = 1 / (1.2 · 2^directEV100)` and `directIntensity = directLux · preExposure` (both precomputed
 * by the game). every effect that draws the sun has its own direction: `<effect>PitchYawMode` 0 follows
 * `directPitchYaw`, 1 uses `<effect>PitchYaw`; the `rotation*` quaternions are the resolved results
 */
export interface LightConfig {
	/** the colour in effect: `directCustomColor` or the temperature's, per `directColorMode` */
	directColor: Color;
	directColorMode: number;
	directCustomColor: Color;
	/** kelvin */
	directColorTemperature: number;
	directLux: number;
	directEV100: number;
	directSpecularIntensity: number;
	directSoftSourceRadius: number;
	directDirectionMode: number;
	/** degrees: elevation, then azimuth */
	directPitchYaw: Vec2;
	timeOfDayYawOffset: number;
	timeOfDayPitchMax: number;
	indirectDiffuseFactor: number;
	indirectSpecularFactor: number;
	indirectSpecularFactorType: number;
	atmospherePitchYawMode: number;
	atmospherePitchYaw: Vec2;
	lightShaftPitchYawMode: number;
	lightShaftPitchYaw: Vec2;
	sunDiscPitchYawMode: number;
	sunDiscPitchYaw: Vec2;
	lensFlarePitchYawMode: number;
	lensFlarePitchYaw: Vec2;
	cloudShadowPitchYawMode: number;
	cloudShadowPitchYaw: Vec2;
	heightFogDirectionalInscatteringPitchYawMode: number;
	heightFogDirectionalInscatteringPitchYaw: Vec2;
	preExposure: number;
	directIntensity: number;
	directIntensityDividePi: number;
	/** the direction the sunlight travels, Unity world frame */
	forwardDirect: Vec3;
	/** the light's frame, 16 numbers row-major (`e00 e01 e02 e03 e10 …`) */
	localToWorld: number[];
	rotationAtmosphere: Quat;
	rotationLightShaft: Quat;
	rotationSunDisc: Quat;
	rotationLensFlare: Quat;
	rotationCloudShadow: Quat;
	rotationHeightFogDirectionalInscattering: Quat;
	bakedIndirectMultiplier: number;
	giBakedIndirectMultiplier: number;
}

/** `HGSkyConfig`: sky luminance, ambient light and reflections */
export interface SkyConfig {
	skyDistance: number;
	useSkyDistanceForBakeFogLut: boolean;
	skyBakedIndirectIntensity: number;
	skyDirectIntensity: number;
	giSkyMultiplier: number;
	useCustomIVDefaultSH: boolean;
	/** ambient SH used outside irradiance-volume coverage when {@link useCustomIVDefaultSH} is set */
	customIVDefaultSH: number[];
	skyMaterialType: number;
	proceduralSkyLuxFactor: number;
	enableSunDisc: boolean;
	sunDiscRadius: number;
	sunDiscRampIntensity: number;
	sunDiscColor: Color;
	skyboxBrightness: number;
	skyboxTintColor: Color;
	/** degrees */
	skyboxRotation: number;
	visibleBox: Vec3;
	reflectionType: number;
	/** the sky reflection cubemap (BC6H) */
	reflectionMap: TextureRef;
	culloff: number;
	/**
	 * ambient light, Unity `SphericalHarmonicsL2` order: 9 coefficients of red, then green, then blue; scaled
	 * by {@link LightConfig.indirectDiffuseFactor}
	 */
	skyAmbientSH: number[];
	skyboxCubeMap: TextureRef;
}

/** `HGAtmosphereConfig`: physically based sky (Hillaire-style); distances in km */
export interface AtmosphereConfig {
	groundRadius: number;
	groundAlbedo: Color;
	outerSunIrradianceColor: Color;
	atmosphereHeight: number;
	multiScatteringFactor: number;
	rayleighScatteringScale: number;
	rayleighScattering: Color;
	rayleighExponentialDistribution: number;
	mieScatteringScale: number;
	mieScattering: Color;
	mieAbsorptionScale: number;
	mieAbsorption: Color;
	mieAnisotropy: number;
	mieExponentialDistribution: number;
	ozoneAbsorptionScale: number;
	ozoneAbsorption: Color;
	tentTipAltitude: number;
	tentTipValue: number;
	tentWidth: number;
}

/** `HGFogConfig`: distance fog (aerial perspective) */
export interface FogConfig {
	enable: boolean;
	startDistance: number;
	startHeight: number;
	fallOffHeight: number;
	fallOffDistance: number;
	mieScattering: Color;
	mieScatteringScale: number;
	mieAnisotropy: number;
	rayleighScattering: Color;
	rayleighScatteringScale: number;
	inscatterAmbientColor: Color;
}

/** the two exponential height-fog layers and their froxel-fog parameters, shared by both height-fog sections */
export interface HeightFogLayers {
	enable: boolean;
	heightFogStartHeight: number;
	heightFogDensity: number;
	heightFogFalloff: number;
	heightFogStartHeightSecond: number;
	heightFogDensitySecond: number;
	heightFogFalloffSecond: number;
	heightFogInscatter: Color;
	heightFogMaxOpacity: number;
	heightFogStartDistance: number;
	heightFogStartTransition: number;
	heightFogCutoffDistance: number;
	heightFogCutoffTransition: number;
	heightFogDirectionalInscatteringExponent: number;
	heightFogDirectionalInscatteringStartDistance: number;
	heightFogDirectionalInscattering: Color;
	volumetricFogScatteringDistribution: number;
	volumetricFogAlbedo: Color;
	volumetricFogEmissive: Color;
	volumetricFogExtinctionScale: number;
	volumetricFogDistance: number;
	volumetricFogStartDistance: number;
	volumetricFogNearFadeInDistance: number;
	volumetricFogDirectLightingScatteringIntensity: number;
	volumetricFogSkyLightingScatteringIntensity: number;
	enableFlowNoise: boolean;
	flowNoiseIntensity: number;
	flowNoiseDistance: number;
	flowNoiseTilling: number;
	flowNoiseHorizontalDirAngle: number;
	flowNoiseVerticalDirAngle: number;
	flowNoiseDir: Vec3;
	flowNoiseSpeed: number;
}

/** `HGHeightFogConfig`: analytic height fog */
export interface HeightFogConfig extends HeightFogLayers {
	heightFogCullingFarClipPlane: number;
	heightFogDirectionalInscatteringExponentMobile: number;
	heightFogDirectionalInscatteringMobile: Color;
	enableVolumetricFog: boolean;
}

/** `HGVolumetricFogConfig`: froxel volumetric fog */
export interface VolumetricFogConfig extends HeightFogLayers {
	enableVLFlowNoise: boolean;
	flowVLNoise3DTexture: TextureRef;
	enableTwoParameter: boolean;
	flowVLNoiseIntensity: number;
	flowVLNoiseRemapRange: Vec2;
	flowVLNoiseDistance: number;
	flowVLNoiseTilling: number;
	flowVLNoiseTillingScale: Vec3;
	flowVLNoiseHorizontalDirAngle: number;
	flowVLNoiseVerticalDirAngle: number;
	flowVLNoiseDir: Vec3;
	flowVLNoiseSpeed: number;
	flowVLNoisePerturb3DTexture: TextureRef;
	flowVLNoisePerturbTilling: number;
	flowVLNoisePerturbIntensity: number;
	flowVLNoisePerturbSpeed: Vec3;
}

/** `HGCloudShadowConfig` */
export interface CloudShadowConfig {
	cloudShadowTexture: TextureRef;
	cloudShadowEnvCenter: Vec3;
	cloudShadowCoverage: number;
	cloudShadowFlowSpeed: number;
	cloudShadowFlowDirection: Vec2;
	cloudShadowAlpha: number;
	cloudShadowDistanceScale: number;
	cloudShadowScaleStartDistance: number;
	cloudShadowScaleEndDistance: number;
	enableFarCloudShadowTexture: boolean;
	cloudShadowFarEnvCenter: Vec3;
	cloudShadowFarCoverage: number;
	cloudShadowFarFlowSpeed: number;
	cloudShadowFarFlowDirection: Vec2;
}

/** `HGCloudConfig`: the panoramic cloud layer and cloud shadows */
export interface CloudConfig {
	enable: boolean;
	cloudTexture: TextureRef;
	cloudTint: Color;
	cloudContrast: number;
	lightAffectCloud: boolean;
	cloudBrightness: number;
	cloudAbsoluteBrightness: number;
	brightnessAffectCloudAlpha: boolean;
	drawCloudAfterPlanet: boolean;
	cloudTextureMode: number;
	cloudOpacityR: number;
	cloudOpacityG: number;
	cloudFlowType: number;
	/** degrees */
	rotation: number;
	cloudFlowMap: TextureRef;
	flowSpeed: number;
	flowDirectionX: number;
	flowDirectionY: number;
	enableLightShaftCloudMask: boolean;
	lightShaftCloudMaskTexture: TextureRef;
	enableCloudShadow: boolean;
	cloudShadowConfig: CloudShadowConfig;
	cloudFadeAlpha: number;
}

/** `HGShadowConfig`: the sun shadow's look and the cached and contact shadows' settings */
export interface ShadowConfig {
	csmDepthBiasV2: number;
	csmNormalBiasV2: number;
	/** how far shadows darken the sun, 0–1 */
	csmIntensity: number;
	/** penumbra tint, sampled at the shadow value; black when `null` */
	csmRampTexture: TextureRef;
	/** filter radius numerator: over each cascade's split distance, in the game's shadow atlas uv */
	csmShadowSoftness: number;
	asmCasterMinY: number;
	asmCasterMaxY: number;
	contactShadowIntensity: number;
	contactShadowSurfaceThickness: number;
	contactShadowBilinearThreshold: number;
	contactShadowContract: number;
	contactShadowIgnoreEdgePixels: boolean;
	overrideCsmFarDistanceEnabled: boolean;
	overrideCsmFarDistance: number;
	manualOverrideCsmRendering: boolean;
	overrideCsmSpherePosition: Vec3;
	overrideCsmSphereRadius: number;
	disableCsm: boolean;
	/** how far the shadow is replaced by `csmSimulatedAttenuation` (1 in caves that keep the sun out) */
	disableCsmBlendFactor: number;
	csmSimulatedAttenuation: number;
	disableAsm: boolean;
	rhodesModeEnabled: boolean;
	rhodesShipCenter: Vec3;
	rhodesShipRadius: number;
}

/** `HGWindConfig`: foliage and cloth wind */
export interface WindConfig {
	/** m/s */
	speed: number;
	/** degrees */
	horizontalDirectionAngle: number;
	verticalDirectionAngle: number;
	/** unit vector the wind blows toward, Unity world frame */
	direction: Vec3;
}

/** `HGLightShaftConfig`: screen-space sun shafts */
export interface LightShaftConfig {
	enable: boolean;
	bloomScale: number;
	bloomThreshold: number;
	bloomMaxBrightness: number;
	bloomTint: Color;
	blurIntensity: number;
	occlusionDepthRange: number;
	enableOcclusion: boolean;
	occlusionMaskDarkness: number;
}

/** `HGShadowsMidtonesHighlights` */
export interface ShadowsMidtonesHighlights {
	shadows: Vec4;
	midtones: Vec4;
	highlights: Vec4;
	shadowsStart: number;
	shadowsEnd: number;
	highlightsStart: number;
	highlightsEnd: number;
	shadowsOverriding: boolean;
	midtonesOverriding: boolean;
	highlightsOverriding: boolean;
	shadowsStartOverriding: boolean;
	shadowsEndOverriding: boolean;
	highlightsStartOverriding: boolean;
	highlightsEndOverriding: boolean;
}

/** `HGLiftGammaGain` */
export interface LiftGammaGain {
	lift: Vec4;
	gamma: Vec4;
	gain: Vec4;
	liftOverriding: boolean;
	gammaOverriding: boolean;
	gainOverriding: boolean;
}

/**
 * `HGColorGradingConfig`: tonemapping and URP-style grading (the colour curves aren't included).
 * `tonemappingMode` is the game's `TonemappingMode`: 0 `None`, 1 `Neutral`, 2 `ACES`, 3 `Custom`, 4
 * `External`, 5 `ACES_modified` (5 everywhere seen; 1–4 are hidden from the game's inspector)
 */
export interface ColorGradingConfig {
	tonemappingMode: number;
	colorLookupEnabled: boolean;
	colorLookupTexture: TextureRef;
	colorLookupContribution: number;
	whiteBalanceEnabled: boolean;
	whiteBalanceTemperature: number;
	whiteBalanceTint: number;
	colorAdjustmentsEnabled: boolean;
	colorAdjustmentsPostExposure: number;
	colorAdjustmentsContrast: number;
	colorAdjustmentsColorFilter: Color;
	colorAdjustmentsHueShift: number;
	colorAdjustmentsSaturation: number;
	channelMixerEnabled: boolean;
	channelMixerRedOutRedIn: number;
	channelMixerRedOutGreenIn: number;
	channelMixerRedOutBlueIn: number;
	channelMixerGreenOutRedIn: number;
	channelMixerGreenOutGreenIn: number;
	channelMixerGreenOutBlueIn: number;
	channelMixerBlueOutRedIn: number;
	channelMixerBlueOutGreenIn: number;
	channelMixerBlueOutBlueIn: number;
	shadowsMidtonesHighlightsEnabled: boolean;
	shadowsMidtonesHighlights: ShadowsMidtonesHighlights;
	liftGammaGainEnabled: boolean;
	liftGammaGain: LiftGammaGain;
	splitToningEnabled: boolean;
	splitToningShadows: Color;
	splitToningHighlights: Color;
	splitToningBalance: number;
	colorCurvesEnabled: boolean;
}

/**
 * `HGAutoExposureConfig`: the post exposure on top of {@link LightConfig.directEV100}'s. mode 0 meters the
 * scene, 1 holds `2^autoExposureManualEvCompensationManual`; metering mode 0 averages, 1 weights the centre
 */
export interface AutoExposureConfig {
	autoExposureMode: number;
	autoExposureManualEvCompensationAuto: number;
	autoExposureLerpUpSpeed: number;
	autoExposureLerpDownSpeed: number;
	autoExposureEv100Range: Vec2;
	autoExposureEv100HistogramRange: Vec2;
	autoExposureMeteringMode: number;
	autoExposurePixelLuminanceRange: Vec2;
	autoExposureEvClampRange: Vec2;
	autoExposureManualEvCompensationManual: number;
}

/**
 * a post-processing `VolumeProfile` (`gvp_*.asset`): its components under the game's field names, each `null`
 * when the profile doesn't have it or has it switched off. values are the profile's, overridden or not (with
 * a single global volume, the non-overridden ones are the defaults in effect). tonemapping isn't a volume
 * component here; see {@link ColorGradingConfig.tonemappingMode}
 */
export interface PostProfile {
	/** the profile's asset name, e.g. `gvp_map02_lv000_art_01` */
	name: string;
	bloom: BloomSettings | null;
	ambientOcclusion: AmbientOcclusionSettings | null;
	vignette: VignetteSettings | null;
	screenSpaceReflection: ScreenSpaceReflectionSettings | null;
}

/**
 * the game's `Bloom`, with settings per quality tier (the PC client's high tier is the reference look) and a
 * second, additive pass
 */
export interface BloomSettings {
	quality: number;
	resolutionHighQuality: number;
	resolutionMedQuality: number;
	resolutionLowQuality: number;
	thresholdHighQuality: number;
	thresholdMedQuality: number;
	thresholdLowQuality: number;
	intensityHighQuality: number;
	intensityMedQuality: number;
	intensityLowQuality: number;
	scatterHighQuality: number;
	scatterMedQuality: number;
	scatterLowQuality: number;
	tint: Color;
	blendMode: number;
	bloomUpsampleAdditive: boolean;
	thresholdAdditiveHighQuality: number;
	intensityAdditiveHighQuality: number;
	scatterAdditiveHighQuality: number;
	characterBloomControl: boolean;
	characterThreshold: number;
	characterSoftness: number;
	characterIntensity: number;
	dirtIntensity: number;
	anamorphic: boolean;
}

/** the game's `GTAmbientOcclusion` (ground-truth AO) */
export interface AmbientOcclusionSettings {
	enable: boolean;
	custom: boolean;
	enableFP32Depths: boolean;
	generateNormalsInplace: boolean;
	qualityLevel: number;
	denoisePasses: number;
	/** metres */
	radius: number;
	radiusMultiplier: number;
	falloffRange: number;
	sampleDistributionPower: number;
	thinOccluderCompensation: number;
	/** exponent applied to the AO term */
	finalValuePower: number;
	depthMIPSamplingOffset: number;
	mvFactor: number;
	depthFactor: number;
}

/** URP's `Vignette`, plus the game's mode and blink */
export interface VignetteSettings {
	mode: number;
	color: Color;
	/** screen UV */
	center: Vec2;
	intensity: number;
	smoothness: number;
	roundness: number;
	rounded: boolean;
	blink: boolean;
	opacity: number;
}

/** the game's `ScreenSpaceReflectionVolume` */
export interface ScreenSpaceReflectionSettings {
	enable: boolean;
	fadenessOnScreen: number;
	fadenessOnDepth: number;
	fadenessOnDepthFactor: number;
	fadenessOnMirrorMul: number;
	fadenessOnMirrorAdd: number;
	mipThreshold: number;
}

// #endregion

// #region water

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

// #endregion

// #region lights

/**
 * `tables/lights.json`: the scene's local point and spot lights, loaded with the core. a viewer lights with
 * the ones carrying the current level's tag plus tag 0, like instances. the game's directional lights, lights
 * that only cast shadows and lights that only light characters are left out
 */
export interface LightsTable {
	lights: LightEntry[];
}

/** {@link LightEntry.kind} values */
export const LightKind = {
	Spot: 0,
	/** a point, or a tube along {@link LightEntry.direction} when {@link LightEntry.tubeLength} is positive */
	Point: 1,
} as const;

export type LightKind = (typeof LightKind)[keyof typeof LightKind];

/** one local light, with the fields the game's shading reads */
export interface LightEntry {
	kind: LightKind;
	/** the game's entity id */
	id: number;
	/** the owning level's tag (`id >>> 27`), matching {@link LevelInfo.tag} */
	levelTag: number;
	/**
	 * index into {@link StatesInfo.conditionalSets} when the light only loads with some scene states, else
	 * `null`
	 */
	condition: number | null;
	position: Vec3;
	/** unit direction the light points along (a spot's axis, a tube's segment) */
	direction: Vec3;
	/**
	 * linear colour times intensity and colour-temperature tint, in the units the shading adds to the scene as
	 * they are (the game doesn't pre-expose local lights)
	 */
	color: Vec3;
	/** metres; the light reaches nothing farther */
	range: number;
	/** full cone angles, degrees; 0 for points */
	spotAngle: number;
	innerSpotAngle: number;
	/** metres; 0 unless a tube */
	tubeLength: number;
	/** metres; widens highlights */
	softSourceRadius: number;
	/** distance falloff `(1 − d²/range²)^exponent`; negative for inverse square with a smooth window */
	falloffExponent: number;
	specularIntensity: number;
	/** scales the light in the volumetric fog; 0 leaves the fog unlit */
	volumetricScatteringIntensity: number;
	/** orders lights at equal camera distance when there are more than a viewer draws */
	priority: number;
	/**
	 * camera distances (m) over which the light fades out: full up to `falloff`, linearly in squared distance
	 * to nothing at `culling`. `null` when it never fades
	 */
	distanceFade: { falloff: number; culling: number } | null;
	/**
	 * a box confining the light: world point `p` maps to box units by `q = M · (p − position)` with `M` this
	 * rows3x4 matrix (the inverse of the box's transform, scaled to half extents), and the light fades over
	 * `max |q|` from `(1 + falloffThreshold) / 2` to 1. `null` when unconfined
	 */
	cullingBox: { matrix: number[]; falloffThreshold: number } | null;
}

// #endregion

// #region binary records

/**
 * a reference from a tree node (or {@link PackageManifest.global}) to content. stored as 24-byte records in
 * tree.bin and as JSON in the manifest
 */
export interface ContentRef {
	kind: ContentKind;
	/** HLOD tier for {@link ContentKind.Hlod}; 0 otherwise */
	tier: number;
	/**
	 * the instances' level tag (`entityId >>> 27`, matching {@link LevelInfo.tag}) for instance content; 0 for
	 * terrain
	 */
	levelTag: number;
	/** blob index */
	blob: number;
	/** first row, for refs into a shared instance block; 0 otherwise */
	first: number;
	/** row count (instances), or 1 for single-item blobs */
	count: number;
	/** kind-specific scalar; see {@link ContentKind} */
	param: number;
}

/** a tree node */
export interface TreeNode {
	level: number;
	x: number;
	z: number;
	/** bit `dz·2 + dx` set when child `(2x + dx, 2z + dz)` exists */
	childMask: number;
	/** {@link NodeFlags} */
	flags: number;
	/** bounds of everything the node and its descendants draw, including overhang past the tile */
	bounds: Bounds;
	/**
	 * world-space error, metres, of drawing this node's coarse content (HLOD, terrain page) instead of
	 * refining. screen-space error = `geometricError · viewportHeight / (2 · distance · tan(fovY / 2))`
	 */
	geometricError: number;
	/** this node's slice of {@link Tree.refs} */
	refFirst: number;
	refCount: number;
}

/** decoded tree.bin */
export interface Tree {
	/** coarse to fine: by level, then z, then x */
	nodes: TreeNode[];
	refs: ContentRef[];
}

/** a blob's storage */
export interface BlobRecord {
	/** first 128 bits of the SHA-256 of the stored bytes, as 32 lowercase hex digits */
	hash: string;
	/** index into {@link PackageManifest.archives} */
	archive: number;
	codec: BlobCodec;
	kind: BlobKind;
	/**
	 * byte offset of the member from its archive's data section ({@link ArchiveInfo.dataOffset}), so the viewer
	 * can range-read a blob without fetching the archive's JSON header
	 */
	offset: number;
	/** stored byte length */
	length: number;
	/** byte length after undoing the codec */
	rawLength: number;
}

/** one draw of a LOD chain */
export interface ChainDraw {
	/** index into the geometry table */
	geometry: number;
	/** index into the material table */
	material: number;
	submesh: number;
	/** LOD level, 0 = nearest */
	lod: number;
	role: DrawRole;
	/**
	 * shown while `minSquared < s² <= maxSquared`, `s` being the instance's screen-relative height as in
	 * Unity's LODGroup (times the viewer's LOD bias). `maxSquared` is `FLT_MAX` on the nearest LOD; a negative
	 * `minSquared` means never culled by size
	 */
	minSquared: number;
	maxSquared: number;
	/** the game's `RendererInfo.renderFlags`, kept for bits not yet understood */
	sourceFlags: number;
}

/** a LOD-chain template shared by every instance with the same ordered draws */
export interface Chain {
	lodCount: number;
	/** {@link ChainFlags} */
	flags: number;
	draws: ChainDraw[];
}

/**
 * an instance block, struct-of-arrays. rows reference chains; transforms are relative to `origin` so that f32
 * keeps sub-millimetre precision anywhere in the world
 */
export interface InstanceBlock {
	/** {@link InstanceBlockFlags} */
	flags: number;
	/** world position the rows' translations and bounds centres are relative to */
	origin: [x: number, y: number, z: number];
	/** chain index per row */
	chains: Uint32Array;
	/**
	 * 12 floats per row: the object-to-world matrix's top three rows, row-major (`m00 m01 m02 tx, m10 … ty, m20
	 * … tz`), translation relative to `origin`. matches a WGSL `array<vec4f, 3>` per instance
	 */
	transforms: Float32Array;
	/** 6 floats per row: world AABB centre (relative to `origin`) then half-extents, from the game */
	bounds: Float32Array;
	/** the game's entity id per row; `id >>> 27` is the owning level's tag */
	entityIds: Uint32Array;
	/** the chunk file's scene state id per row: 0 always loaded, `n` with MapConfig scene state `n − 1` */
	sceneStates: Uint8Array;
}

/**
 * a geometry blob's container. payloads are meshopt-encoded (meshoptimizer ≥ 1.0 codec, version 1): decode
 * each stream with `MeshoptDecoder.decodeVertexBuffer(target, vertexCount, stride, data)` and the indices
 * with `decodeIndexBuffer(target, indexCount, indexSize, data)`. no meshopt filters are used, so the decoded
 * bytes are the GPU vertex buffers as they are
 */
export interface GeometryBlob {
	/** {@link GeometryFlags} */
	flags: number;
	vertexCount: number;
	/** total indices over all submeshes */
	indexCount: number;
	streams: GeometryStream[];
	/** ranges of the index buffer; indices are local to each submesh's vertex range */
	submeshes: GeometrySubmesh[];
	/**
	 * meshopt-encoded index buffer of `indexCount` u16 or u32 ({@link GeometryFlags.IndexU32}) triangle-list
	 * indices
	 */
	indices: Uint8Array;
}

/** one vertex buffer of a {@link GeometryBlob} */
export interface GeometryStream {
	/** {@link VertexAttribute} */
	attribute: VertexAttribute;
	format: GeometryVertexFormat;
	/** {@link GeometryStreamFlags} */
	flags: number;
	/** dequantization for {@link GeometryStreamFlags.Dequantize}: `offset + value · scale`, per component */
	offset: [x: number, y: number, z: number];
	scale: [x: number, y: number, z: number];
	/** meshopt-encoded `vertexCount × stride` bytes */
	data: Uint8Array;
}

/**
 * a submesh: what a {@link ChainDraw.submesh} draws. one `drawIndexed(indexCount, …, firstIndex, baseVertex)`;
 * the submesh's vertices are `[baseVertex, baseVertex + vertexCount)`, contiguous and owned by it alone, so
 * the indices fit u16 whenever every submesh has at most 65,536 vertices
 */
export interface GeometrySubmesh {
	firstIndex: number;
	indexCount: number;
	baseVertex: number;
	vertexCount: number;
	/** the submesh's local bounds, from the game */
	bounds: Bounds;
}

// #endregion

// #region tables

/**
 * an entry that isn't converted: `pending` when the package was written without asset conversion, `failed`
 * when conversion failed (the reason is in `debug/assets.json`). draws referencing it are skipped
 */
export interface UnconvertedEntry {
	id: number;
	status: 'pending' | 'failed';
}

/** `tables/geometries.json`; entry `i` has id `i` */
export interface GeometryTable {
	entries: GeometryEntry[];
}

/** one mesh asset */
export type GeometryEntry = UnconvertedEntry | ReadyGeometry;

/** a converted mesh */
export interface ReadyGeometry {
	id: number;
	status: 'ready';
	/** the {@link BlobKind.Geometry} blob */
	blob: number;
	/** local bounds of the vertices */
	bounds: Bounds;
	vertexCount: number;
	indexCount: number;
	submeshCount: number;
	/** bit `a` set when the blob has a stream for {@link VertexAttribute} `a` */
	attributes: number;
	/** the UV set tangents were generated from, or `null` without generated tangents */
	tangentUv: number | null;
}

/** `tables/materials.json`; entry `i` has id `i` */
export interface MaterialTable {
	/** shaders by index. a material stores only the values that differ from its shader's defaults */
	shaders: ShaderEntry[];
	entries: MaterialEntry[];
}

/**
 * a shader's declared properties and their defaults. a material parameter's value is the material's override
 * if present, else this default. undeclared (stale) material properties are dropped
 */
export interface ShaderEntry {
	/** e.g. `HGRP/Lit` */
	name: string;
	family: ShaderFamily;
	/** Float, Range and Int properties */
	floats: Record<string, number>;
	/**
	 * Color properties, as authored (gamma-encoded): like Unity in a linear-space project, convert them to
	 * linear before shading
	 */
	colors: Record<string, [r: number, g: number, b: number, a: number]>;
	/** Vector properties, used as they are */
	vectors: Record<string, [x: number, y: number, z: number, w: number]>;
	/** texture properties and the Unity built-in each defaults to (`white`, `black`, `gray`, `bump`, …) */
	textures: Record<string, string>;
	/** texture properties flagged `[Normal]` (tangent-space normal maps) */
	normalMaps: string[];
}

/**
 * the HGRP shader family a shader belongs to; `unknown` for shaders the viewer has no path for. the decoder
 * (formats' `unity/material.ts`) spells the same union independently, since neither package may depend on the
 * other; the extractor's mapping type-checks against both
 */
export type ShaderFamily =
	| 'lit'
	| 'litTransparent'
	| 'leaf'
	| 'trunk'
	| 'grass'
	| 'cardMesh'
	| 'fogSimple'
	| 'waterProxy'
	| 'waterDecal'
	| 'water'
	| 'decal'
	| 'vfxBase'
	| 'vfxAdvance'
	| 'vfxRefract'
	| 'vfxDitherAlpha'
	| 'vfxFakeVolumeFog'
	| 'volumetricBeam'
	| 'terrain'
	| 'hlod'
	| 'mattePainting'
	| 'unknown';

/** how a material composites */
export type MaterialBlend = 'opaque' | 'alphaTest' | 'alphaBlend' | 'premultiplied' | 'additive' | 'custom';

/** which faces a material culls */
export type MaterialCull = 'back' | 'front' | 'none';

/** one material */
export type MaterialEntry = UnconvertedEntry | ReadyMaterial;

/** a converted material */
export interface ReadyMaterial {
	id: number;
	status: 'ready';
	/** index into {@link MaterialTable.shaders} */
	shader: number;
	/** enabled shader keywords */
	keywords: string[];
	/** the custom queue, else the shader's, else 2000 */
	renderQueue: number;
	blend: MaterialBlend;
	/** source and destination factors (Unity `BlendMode` values) for blended materials */
	blendFactors: [src: number, dst: number] | null;
	/** alpha-test threshold, or `null` without alpha testing */
	alphaClipThreshold: number | null;
	cull: MaterialCull;
	zWrite: boolean;
	/**
	 * the Lit families' `_BaseTextureMapCount`: 0 adds an MRO map (R metallic, G roughness, B occlusion) and an
	 * `RAG` normal map; 1 and 2 use an `RG` normal map with roughness in B, and metallic from the base map's
	 * alpha (1) or `_Metallic` (2). `null` outside the Lit families
	 */
	baseTextureMapCount: number | null;
	/** bound textures by Unity property name (`_BaseColorMap`, `_NormalMap`, …); empty slots are absent */
	slots: Record<string, TextureSlot>;
	/** overrides of {@link ShaderEntry.floats} */
	floats: Record<string, number>;
	/** overrides of {@link ShaderEntry.colors} */
	colors: Record<string, [r: number, g: number, b: number, a: number]>;
	/** overrides of {@link ShaderEntry.vectors} */
	vectors: Record<string, [x: number, y: number, z: number, w: number]>;
}

/** a texture bound to a material slot */
export interface TextureSlot {
	/** index into the texture table */
	texture: number;
	/** UV set ({@link VertexAttribute.TexCoord0} + `uv`) */
	uv: number;
	/** `uv' = uv · scale + offset` (Unity's `_ST`) */
	scale: [u: number, v: number];
	offset: [u: number, v: number];
}

/** `tables/textures.json`; entry `i` has id `i` */
export interface TextureTable {
	entries: TextureEntry[];
}

/** one texture. textures with identical content and sampler share one entry */
export type TextureEntry = UnconvertedEntry | ReadyTexture;

/** a converted texture: the game's texel data unchanged (no transcoding), split into mip pieces */
export interface ReadyTexture {
	id: number;
	status: 'ready';
	kind: '2d' | 'cube' | '2d-array' | 'cube-array' | '3d';
	/** a WebGPU texture format, a key of {@link TEXTURE_FORMATS} */
	format: string;
	width: number;
	height: number;
	/** WebGPU's: array layers × faces (6 per cube), or depth for `3d`, else 1 */
	depthOrArrayLayers: number;
	mipCount: number;
	sampler: TextureSampler;
	/**
	 * the blobs holding the levels, coarse to fine: the first holds the mip tail (see
	 * {@link TEXTURE_TAIL_BYTES}), each further one a single larger level. together they cover levels
	 * `0…mipCount - 1` exactly once
	 */
	pieces: TexturePiece[];
}

/** a {@link BlobKind.Texture} blob and the levels it holds */
export interface TexturePiece {
	blob: number;
	/** the largest level in the blob */
	firstLevel: number;
	levelCount: number;
}

/** Unity's sampler state in WebGPU terms (`GPUSamplerDescriptor` fields), plus the mip bias */
export interface TextureSampler {
	addressModeU: 'repeat' | 'clamp-to-edge' | 'mirror-repeat';
	addressModeV: 'repeat' | 'clamp-to-edge' | 'mirror-repeat';
	addressModeW: 'repeat' | 'clamp-to-edge' | 'mirror-repeat';
	magFilter: 'nearest' | 'linear';
	minFilter: 'nearest' | 'linear';
	mipmapFilter: 'nearest' | 'linear';
	/** 1 unless every filter is linear, as WebGPU requires */
	maxAnisotropy: number;
	/** Unity's mip bias; WebGPU samplers have none, so a shader applies it if it wants */
	mipBias: number;
}

/** block layout of a texture format: a 4×4 block for BC formats, a single texel otherwise */
export interface TextureFormatInfo {
	blockWidth: number;
	blockHeight: number;
	blockBytes: number;
}

const bc = (blockBytes: number): TextureFormatInfo => ({ blockWidth: 4, blockHeight: 4, blockBytes });
const texel = (blockBytes: number): TextureFormatInfo => ({ blockWidth: 1, blockHeight: 1, blockBytes });

/**
 * the WebGPU formats a {@link ReadyTexture} can have. this is the package contract's own copy of the block
 * sizes: the extractor derives formats from formats' `binary/ktx2.ts` table, which package-format can't
 * import
 */
export const TEXTURE_FORMATS: Readonly<Record<string, TextureFormatInfo>> = {
	'bc1-rgba-unorm': bc(8),
	'bc1-rgba-unorm-srgb': bc(8),
	'bc2-rgba-unorm': bc(16),
	'bc2-rgba-unorm-srgb': bc(16),
	'bc3-rgba-unorm': bc(16),
	'bc3-rgba-unorm-srgb': bc(16),
	'bc4-r-unorm': bc(8),
	'bc4-r-snorm': bc(8),
	'bc5-rg-unorm': bc(16),
	'bc5-rg-snorm': bc(16),
	'bc6h-rgb-ufloat': bc(16),
	'bc6h-rgb-float': bc(16),
	'bc7-rgba-unorm': bc(16),
	'bc7-rgba-unorm-srgb': bc(16),
	r8unorm: texel(1),
	rg8unorm: texel(2),
	rgba8unorm: texel(4),
	'rgba8unorm-srgb': texel(4),
	bgra8unorm: texel(4),
	'bgra8unorm-srgb': texel(4),
	r16unorm: texel(2),
	rg16unorm: texel(4),
	rgba16unorm: texel(8),
	r16float: texel(2),
	rg16float: texel(4),
	rgba16float: texel(8),
	r32float: texel(4),
	rg32float: texel(8),
	rgba32float: texel(16),
};

// #endregion

// #region helpers

/**
 * @param hash blob hash
 * @param kind blob kind
 * @returns the blob's member path inside its archive
 */
export const blobPath = (hash: string, kind: BlobKind): string => `blobs/${hash}.${BLOB_EXTENSIONS[kind]}`;

/**
 * @param tree tree parameters
 * @param key tile address
 * @returns the tile's world x, z footprint
 */
export const tileFootprint = (
	tree: Pick<TreeInfo, 'origin' | 'rootSize'>,
	key: TileKey,
): { minX: number; minZ: number; size: number } => {
	const size = tree.rootSize / 2 ** key.level;
	return { minX: tree.origin[0] + key.x * size, minZ: tree.origin[1] + key.z * size, size };
};

/**
 * @param tree tree parameters
 * @param level tile level
 * @param x world x
 * @param z world z
 * @returns the level's tile containing the point
 */
export const tileAt = (
	tree: Pick<TreeInfo, 'origin' | 'rootSize'>,
	level: number,
	x: number,
	z: number,
): TileKey => {
	const size = tree.rootSize / 2 ** level;
	return {
		level,
		x: Math.floor((x - tree.origin[0]) / size),
		z: Math.floor((z - tree.origin[1]) / size),
	};
};

/**
 * @param key tile address
 * @param level a coarser or equal level
 * @returns the ancestor at `level`
 */
export const tileAncestor = (key: TileKey, level: number): TileKey => {
	const shift = key.level - level;
	if (shift < 0) {
		throw new RangeError(`level ${level} is finer than tile level ${key.level}`);
	}
	// floor division keeps negative coordinates on the right side of the grid
	return { level, x: Math.floor(key.x / 2 ** shift), z: Math.floor(key.z / 2 ** shift) };
};

/** @returns a string key for maps and archive names: `level_x_z` */
export const tileId = (key: TileKey): string => `${key.level}_${key.x}_${key.z}`;

/**
 * @param key a tile below the root
 * @returns which of its parent's four children it is: bit 0 = +x half, bit 1 = +z half
 */
export const tileQuadrant = (key: TileKey): number => {
	const parent = tileAncestor(key, key.level - 1);
	return (key.z - parent.z * 2) * 2 + (key.x - parent.x * 2);
};

/**
 * @param a a box
 * @param b another box
 * @returns a new box enclosing both
 */
export const unionBounds = (a: Bounds, b: Bounds): Bounds => {
	return {
		min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
		max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
	};
};

/**
 * @param terrain scene terrain parameters
 * @param sample a raw height sample
 * @returns whether the sample is flagged as a hole; holes still carry a usable height
 */
export const isTerrainHole = (terrain: Pick<TerrainInfo, 'holeBit'>, sample: number): boolean => {
	return (sample & terrain.holeBit) !== 0;
};

/**
 * @param terrain scene terrain parameters
 * @param sample a raw height sample
 * @returns the sample's world y, ignoring the hole flag
 */
export const terrainHeight = (
	terrain: Pick<TerrainInfo, 'position' | 'heightScale' | 'holeBit'>,
	sample: number,
): number => {
	return terrain.position[1] + ((sample & (terrain.holeBit - 1)) * terrain.heightScale) / terrain.holeBit;
};

/**
 * @param tile the shard-level tile whose subtree content the archive holds
 * @returns the archive's package-relative path
 */
export const shardArchiveName = (tile: TileKey): string => `shards/${tileId(tile)}.czar`;

/**
 * @param tile the tile the archive's assets are placed at, or `null` for the common archive
 * @param part overflow part; 0 for the first archive
 * @returns the archive's package-relative path
 */
export const assetArchiveName = (tile: TileKey | null, part: number): string => {
	const id = tile === null ? 'common' : tileId(tile);
	return part === 0 ? `assets/${id}.czar` : `assets/${id}.${part}.czar`;
};

/** world metres covered by one irradiance archive along x and z */
export const IRRADIANCE_ARCHIVE_SIZE = 512;

/**
 * @param x world x (m) of a point in the archive's square
 * @param z world z (m)
 * @returns the package-relative path of the irradiance archive holding the cells over that point
 */
export const irradianceArchiveName = (x: number, z: number): string =>
	`irradiance/${Math.floor(x / IRRADIANCE_ARCHIVE_SIZE)}_${Math.floor(z / IRRADIANCE_ARCHIVE_SIZE)}.czar`;

// #region irradiance

/**
 * `tables/irradiance.bin`: the baked irradiance volume's cells (the base bake only, without scene-state
 * bakes), each a {@link BlobKind.Irradiance} blob. cell keys are the game's layout: `x | y << 8 | z << 16 |
 * level << 24`, 8 bits per axis in 32 m units with 128 at world 0 for every scene (smaller volumes' keys are
 * shifted to it); a level-`n` cell spans `32 · 2^n` m (probes every `0.5 · 4^n` m) and its coordinates are
 * multiples of `2^n`
 */
export interface IrradianceTable {
	/** cell keys, ascending */
	keys: Uint32Array;
	/** blob index of each cell */
	blobs: Uint32Array;
}

// #endregion

/** how one mip level of a texture is laid out in its piece, in `GPUQueue.writeTexture` terms */
export interface TextureLevelLayout {
	width: number;
	height: number;
	/** array layers × faces, or depth slices for `3d` */
	depthOrArrayLayers: number;
	/** bytes per row of blocks */
	bytesPerRow: number;
	/** block rows per image */
	rowsPerImage: number;
	/** bytes of the whole level */
	byteLength: number;
}

/**
 * @param texture the texture's shape (an entry of the texture table)
 * @param level mip level, 0 = largest
 * @returns the level's size and data layout
 * @throws {RangeError} on an unknown format
 */
export const textureLevelLayout = (
	texture: Pick<ReadyTexture, 'kind' | 'format' | 'width' | 'height' | 'depthOrArrayLayers'>,
	level: number,
): TextureLevelLayout => {
	const info = TEXTURE_FORMATS[texture.format];
	if (info === undefined) {
		throw new RangeError(`unknown texture format ${texture.format}`);
	}
	const width = Math.max(1, texture.width >> level);
	const height = Math.max(1, texture.height >> level);
	const depthOrArrayLayers =
		texture.kind === '3d' ? Math.max(1, texture.depthOrArrayLayers >> level) : texture.depthOrArrayLayers;
	const bytesPerRow = Math.ceil(width / info.blockWidth) * info.blockBytes;
	const rowsPerImage = Math.ceil(height / info.blockHeight);
	return {
		width,
		height,
		depthOrArrayLayers,
		bytesPerRow,
		rowsPerImage,
		byteLength: bytesPerRow * rowsPerImage * depthOrArrayLayers,
	};
};

/**
 * @param texture the texture's shape
 * @param level mip level
 * @returns the level's byte length
 */
export const textureLevelByteLength = (
	texture: Pick<ReadyTexture, 'kind' | 'format' | 'width' | 'height' | 'depthOrArrayLayers'>,
	level: number,
): number => textureLevelLayout(texture, level).byteLength;

// #endregion
