/**
 * messages between the main thread and the decode workers.
 *
 * @module
 */

import type { BlobCodec } from '@endfield-noclip/package-format/format';

import type { InstanceRows, RowKinds } from '../render/instance-rows.ts';

interface RequestBase {
	id: number;
	/** stored blob bytes; transferred */
	data: ArrayBuffer;
	codec: BlobCodec;
	rawLength: number;
}

/** a decode job */
export type DecodeRequest =
	| (RequestBase & { kind: 'heights' })
	| (RequestBase & { kind: 'surface' })
	| (RequestBase & { kind: 'detail' })
	| (RequestBase & { kind: 'layer' })
	| (RequestBase & { kind: 'instances'; rowKinds: RowKinds })
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

/** a decoded terrain detail page, see `DetailPage` in package-format */
export interface DecodedDetail {
	id: number;
	kind: 'detail';
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
}

/** a decoded geometry blob: the vertex streams the viewer draws with, and the indices */
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
	/** UV set 0 as `float32x2` (dequantized), or `null` if the mesh has none */
	uvs: ArrayBuffer | null;
	/** `snorm8x4` tangents (octahedral xy, bitangent sign z), or `null` if the mesh has none */
	tangents: ArrayBuffer | null;
	submeshes: { firstIndex: number; indexCount: number; baseVertex: number }[];
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
	| DecodedDetail
	| DecodedLayer
	| DecodedInstances
	| DecodedGeometry
	| DecodedTexture
	| DecodedIrradiance;

/** a worker's answer */
export type DecodeResponse = Decoded | { id: number; kind: 'error'; message: string };
