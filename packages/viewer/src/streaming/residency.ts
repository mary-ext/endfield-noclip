/**
 * the per-kind handlers that make decoded blobs resident on the GPU and free them. the GPU owners of each
 * kind (the renderers and stores) provide them; the stream manager drives them without knowing the kinds.
 *
 * adding a kind of resident content takes its blob kind in {@link RESIDENT_KINDS}, its decode in the decode
 * protocol and worker, its shape in `resident.ts`, and a handler where the stream is built.
 *
 * @module
 */

import { BlobKind } from '@endfield-noclip/package-format/blobs';

import type { DecodeJob, StoredBlob } from '../package/decode-pool.ts';
import type { Decoded } from '../package/decode-protocol.ts';

import type { Resident } from './resident.ts';

/** a kind of residency, which names its decode job and its decoded blob too */
export type ResidentKind = Resident['kind'];

/** the residency each blob kind becomes, or `null` for blobs the stream doesn't load */
export const RESIDENT_KINDS: Readonly<Record<BlobKind, ResidentKind | null>> = {
	[BlobKind.TerrainHeights]: 'heights',
	[BlobKind.Instances]: 'instances',
	[BlobKind.Geometry]: 'geometry',
	[BlobKind.Texture]: 'texture',
	[BlobKind.Irradiance]: 'irradiance',
	[BlobKind.TerrainSurface]: 'surface',
	[BlobKind.TerrainSplat]: 'splat',
	[BlobKind.TerrainLayer]: 'layer',
};

/** what the stream knows about a blob it uploads */
export interface UploadContext {
	/** the blob is part of the always-resident coarse layer */
	pinned: boolean;
}

/** how one kind of decoded blob becomes resident on the GPU, and stops being */
export interface ResidencyHandler<K extends ResidentKind> {
	/**
	 * @param blob blob index
	 * @param stored the blob's stored bytes
	 * @returns the blob's decode job; without this method, the job is the stored bytes alone
	 */
	job?(blob: number, stored: StoredBlob): Extract<DecodeJob, { kind: K }>;
	/**
	 * @param blob blob index
	 * @param decoded the decoded blob
	 * @param context what the stream knows about the blob
	 * @returns the residency, or `null` if there was no room (the stream evicts the kind's unused blobs and
	 *   retries, or tries again next frame)
	 */
	upload(
		blob: number,
		decoded: Extract<Decoded, { kind: K }>,
		context: UploadContext,
	): Extract<Resident, { kind: K }> | null;
	/**
	 * frees what {@link upload} made resident
	 *
	 * @param blob blob index
	 * @param resident its residency
	 */
	release(blob: number, resident: Extract<Resident, { kind: K }>): void;
}

/** a handler for every kind of residency */
export type ResidencyHandlers = { [K in ResidentKind]: ResidencyHandler<K> };

/**
 * @param handlers the handlers
 * @param kind the decoded blob's kind
 * @param blob blob index
 * @param decoded the decoded blob
 * @param context what the stream knows about the blob
 * @returns the residency, or `null` if there was no room
 */
export const uploadResident = <K extends ResidentKind>(
	handlers: ResidencyHandlers,
	kind: K,
	blob: number,
	decoded: Extract<Decoded, { kind: K }>,
	context: UploadContext,
): Extract<Resident, { kind: K }> | null => handlers[kind].upload(blob, decoded, context);

/**
 * @param handlers the handlers
 * @param kind the residency's kind
 * @param blob blob index
 * @param resident the residency to free
 */
export const releaseResident = <K extends ResidentKind>(
	handlers: ResidencyHandlers,
	kind: K,
	blob: number,
	resident: Extract<Resident, { kind: K }>,
): void => {
	handlers[kind].release(blob, resident);
};

/**
 * @param handlers the handlers
 * @param kind the blob's residency kind
 * @param blob blob index
 * @param stored the blob's stored bytes
 * @returns the blob's decode job
 */
export const decodeJob = (
	handlers: ResidencyHandlers,
	kind: ResidentKind,
	blob: number,
	stored: StoredBlob,
): DecodeJob => handlers[kind].job?.(blob, stored) ?? { kind, ...stored };
