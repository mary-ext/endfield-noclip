import type { BlobCodec } from '@endfield-noclip/package-format/blobs';

import type { InstanceRows, RowKinds } from '../content/instance-rows.ts';
import type { RowBounds } from '../streaming/row-groups.ts';

/** how a blob's stored bytes are encoded */
export interface BlobEncoding {
	codec: BlobCodec;
	rawLength: number;
}

interface RequestBase extends BlobEncoding {
	id: number;
	/** the worker's buffer holding the stored bytes, from an earlier {@link WorkerMessage} of type `buffer` */
	buffer: number;
	/** the stored bytes' range in the buffer */
	offset: number;
	length: number;
	/** no later request reads the buffer, so the worker drops it and may keep its bytes */
	last: boolean;
}

/** a UV dequantization as a `_ST` transform: `uv = value · xy + zw` */
export type UvTransform = [scaleU: number, scaleV: number, offsetU: number, offsetV: number];

/** a decode job */
export type DecodeRequest =
	| (RequestBase & { kind: 'heights' })
	| (RequestBase & { kind: 'surface' })
	| (RequestBase & { kind: 'splat' })
	| (RequestBase & { kind: 'layer' })
	/** without `rowKinds`, the rows are tier 0 HLOD rows */
	| (RequestBase & { kind: 'instances'; rowKinds?: RowKinds })
	| (RequestBase & { kind: 'geometry' })
	| (RequestBase & { kind: 'texture' })
	| (RequestBase & { kind: 'irradiance' });

/** a decoded height page */
export interface DecodedHeights {
	id: number;
	kind: 'heights';
	side: number;
	/** raw samples (hole bit included), padded to an even count */
	samples: Uint16Array<ArrayBuffer>;
}

/** a decoded terrain surface page: two BC3 images, see `SurfacePage` in package-format */
export interface DecodedSurface {
	id: number;
	kind: 'surface';
	/** texels per edge */
	side: number;
	albedo: ArrayBuffer;
	normal: ArrayBuffer;
}

/** a decoded terrain splat page, see `SplatPage` in package-format */
export interface DecodedSplat {
	id: number;
	kind: 'splat';
	/** texels per image edge */
	side: number;
	/** index cells per edge */
	cells: number;
	/** RGBA8 splat control */
	control: ArrayBuffer;
	/** BC3 sRGB tint */
	tint: ArrayBuffer;
	/** the 4 layer ordinals of each cell packed into one u32, lowest byte first */
	index: ArrayBuffer;
}

/** a terrain layer texture's BC7 levels, largest first */
export interface DecodedLayer {
	id: number;
	kind: 'layer';
	data: ArrayBuffer;
}

/** a decoded instance block */
export interface DecodedInstances extends InstanceRows {
	id: number;
	kind: 'instances';
	/** what the mesh selection culls the rows by, built here to keep it off the main thread */
	bounds: RowBounds;
}

/** a decoded geometry blob: the vertex streams the viewer draws with, the indices and any animation */
export interface DecodedGeometry {
	id: number;
	kind: 'geometry';
	vertexCount: number;
	/** 2 or 4 */
	indexSize: number;
	indices: ArrayBuffer;
	/** dequantized positions are `offset + value · scale` */
	positionOffset: [x: number, y: number, z: number];
	positionScale: [x: number, y: number, z: number];
	/** `unorm16x4` positions */
	positions: ArrayBuffer;
	/** `snorm16x2` octahedral normals, or `null` if the mesh has none */
	normals: ArrayBuffer | null;
	/**
	 * UV sets 0 and 1 as {@link uvFormat}, `null` where the mesh lacks one. 16-bit UVs stay as the package
	 * stores them (the game's own quantization), at half the size, unless the other set is stored as floats
	 */
	uvs: [uv0: ArrayBuffer | null, uv1: ArrayBuffer | null];
	uvFormat: 'unorm16x2' | 'float32x2';
	/** per set, its dequantization (identity for `float32x2`) */
	uvTransforms: [uv0: UvTransform, uv1: UvTransform];
	/** `snorm8x4` tangents (octahedral xy, bitangent sign z), or `null` if the mesh has none */
	tangents: ArrayBuffer | null;
	/** `unorm8x4` vertex colours (wider values clamped to [0, 1]), or `null` if the mesh has none */
	colors: ArrayBuffer | null;
	submeshes: { firstIndex: number; indexCount: number; baseVertex: number }[];
	/**
	 * the skeletal animation the geometry plays, or `null`. the streams above then hold the bind pose, and
	 * {@link positionOffset} and {@link positionScale} are the box every frame's positions lie in, which the
	 * animation's output is quantized to
	 */
	skin: DecodedSkin | null;
}

/** what animating a geometry reads, besides the bind pose's streams (`SkinAnimation` in the package format) */
export interface DecodedSkin {
	/**
	 * u32 words: the bind pose's `unorm16x4` positions, then its normals and tangents where present, then the
	 * `unorm16x4` weights and `uint8x4` bones
	 */
	source: ArrayBuffer;
	/** where each part starts in {@link source}, in words; -1 for normals or tangents the mesh lacks */
	normalWord: number;
	tangentWord: number;
	weightWord: number;
	boneWord: number;
	/** the bind pose's position dequantization */
	bindOffset: [x: number, y: number, z: number];
	bindScale: [x: number, y: number, z: number];
	boneCount: number;
	frameCount: number;
	frameRate: number;
	/** `frameCount × boneCount` rows3x4 f32 matrices, frame-major */
	matrices: ArrayBuffer;
}

/** a texture piece: its levels' texel blocks, largest level first */
export interface DecodedTexture {
	id: number;
	kind: 'texture';
	data: ArrayBuffer;
}

/** an irradiance cell as the GPU reads it (u32 words; see `IrradianceCell` in the formats package) */
export interface DecodedIrradiance {
	id: number;
	kind: 'irradiance';
	data: ArrayBuffer;
}

/** a successfully decoded blob */
export type Decoded =
	| DecodedHeights
	| DecodedSurface
	| DecodedSplat
	| DecodedLayer
	| DecodedInstances
	| DecodedGeometry
	| DecodedTexture
	| DecodedIrradiance;

/**
 * a message to a worker. a worker handles them in order: a buffer arrives before the requests that read it,
 * and is released after them
 */
export type WorkerMessage =
	/** stored bytes later requests read ranges of; transferred */
	| { type: 'buffer'; buffer: number; data: ArrayBuffer }
	| { type: 'decode'; request: DecodeRequest }
	/** no request will read the buffer any more */
	| { type: 'release'; buffer: number };

/** a worker's answer */
export type DecodeResponse = Decoded | { id: number; kind: 'error'; message: string };
