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
	| (RequestBase & { kind: 'instances'; rowKinds: RowKinds })
	| (RequestBase & { kind: 'geometry' })
	| (RequestBase & { kind: 'texture' });

/** a decoded height page */
export interface DecodedHeights {
	id: number;
	kind: 'heights';
	side: number;
	/** raw samples (hole bit included), padded to an even count */
	samples: Uint16Array<ArrayBuffer>;
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
	submeshes: { firstIndex: number; indexCount: number; baseVertex: number }[];
}

/** a texture piece: its levels' texel blocks, largest level first */
export interface DecodedTexture {
	id: number;
	kind: 'texture';
	data: ArrayBuffer;
}

/** a successfully decoded blob */
export type Decoded = DecodedHeights | DecodedInstances | DecodedGeometry | DecodedTexture;

/** a worker's answer */
export type DecodeResponse = Decoded | { id: number; kind: 'error'; message: string };
