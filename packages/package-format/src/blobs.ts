/** what a blob holds once its {@link BlobCodec} is undone */
export const BlobKind = {
	/** one terrain height page; see `encodeHeightPage` */
	TerrainHeights: 0,
	/** one terrain tile's baked albedo and normal pages; see `encodeSurfacePage` */
	TerrainSurface: 1,
	/** one leaf terrain tile's close-up blend inputs; see `encodeSplatPage` */
	TerrainSplat: 2,
	/**
	 * one terrain layer texture: its BC7 mip levels from {@link TerrainSplatInfo.textureSize} down, largest
	 * first, as `writeTexture` takes them (levels under 4² padded to one block)
	 */
	TerrainLayer: 3,
	/** an instance block; see `encodeInstanceBlock` */
	Instances: 4,
	/** one mesh: meshopt-encoded vertex streams, indices and submeshes; see `encodeGeometryBlob` */
	Geometry: 5,
	/**
	 * whole mip levels of one texture as raw texel blocks, no container: a {@link TexturePiece}. levels are
	 * concatenated largest first, each level holding every array layer, cube face and depth slice in WebGPU's
	 * `writeTexture` order; sizes come from {@link textureLevelByteLength}
	 */
	Texture: 6,
	/**
	 * one cell of the baked irradiance volume, as the game's GPU reads it (`IrradianceCell` in the formats
	 * package): a spatial hash over 4³-probe blocks, then 16-byte L1 probes
	 */
	Irradiance: 7,
} as const;

export type BlobKind = (typeof BlobKind)[keyof typeof BlobKind];

/** file extension of a blob's archive path, by kind */
const BLOB_EXTENSIONS: Record<BlobKind, string> = {
	[BlobKind.TerrainHeights]: 'hgt',
	[BlobKind.TerrainSurface]: 'tsp',
	[BlobKind.TerrainSplat]: 'tsl',
	[BlobKind.TerrainLayer]: 'tly',
	[BlobKind.Instances]: 'inst',
	[BlobKind.Geometry]: 'mesh',
	[BlobKind.Texture]: 'tex',
	[BlobKind.Irradiance]: 'iv',
};

/** human-readable blob kind names, for stats and debug output */
export const BLOB_KIND_NAMES: Record<BlobKind, string> = {
	[BlobKind.TerrainHeights]: 'terrain heights',
	[BlobKind.TerrainSurface]: 'terrain surface',
	[BlobKind.TerrainSplat]: 'terrain splat',
	[BlobKind.TerrainLayer]: 'terrain layer',
	[BlobKind.Instances]: 'instances',
	[BlobKind.Geometry]: 'geometry',
	[BlobKind.Texture]: 'texture',
	[BlobKind.Irradiance]: 'irradiance',
};

/** the outer compression of a stored blob */
export const BlobCodec = {
	None: 0,
	/** a single zstd frame */
	Zstd: 1,
} as const;

export type BlobCodec = (typeof BlobCodec)[keyof typeof BlobCodec];

/**
 * archives lay members out in path order, so blobs sharing a locality key sit next to each other, ordered by
 * the key, and a reader can fetch them in one range read
 *
 * @param hash blob hash
 * @param kind blob kind
 * @param locality the blob's locality key (lowercase hex digits and `.`), or `null` for a blob read alone
 * @returns the blob's member path inside its archive: `blobs/[<locality>/]<hash>.<ext>`
 */
export const blobPath = (hash: string, kind: BlobKind, locality: string | null): string =>
	`blobs/${locality === null ? '' : `${locality}/`}${hash}.${BLOB_EXTENSIONS[kind]}`;
