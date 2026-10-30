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

/**
 * @param hash blob hash
 * @param kind blob kind
 * @returns the blob's member path inside its archive
 */
export const blobPath = (hash: string, kind: BlobKind): string => `blobs/${hash}.${BLOB_EXTENSIONS[kind]}`;
