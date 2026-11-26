import type { BlobKind } from '@endfield-noclip/package-format/blobs';

import type { Decoded } from '../package/decode-protocol.ts';
import type { Resident } from '../render/core/resident.ts';

/** lifecycle of a blob; `fetched` blobs wait for a decode slot */
export type ItemState =
	| 'idle'
	| 'queued'
	| 'fetching'
	| 'fetched'
	| 'decoding'
	| 'uploading'
	| 'ready'
	| 'failed';

/**
 * reads of a blob that may fail before the blob fails for good: a dev server under load now and then answers
 * a range request with no bytes
 */
export const MAX_READ_FAILURES = 3;

/** a blob the viewer has asked for at some point */
export interface ContentItem {
	blob: number;
	kind: BlobKind;
	/** index of the archive holding the blob */
	archive: number;
	state: ItemState;
	/** part of the always-resident coarse layer */
	pinned: boolean;
	/** highest priority requested in {@link wantedFrame} */
	priority: number;
	wantedFrame: number;
	/** last frame it was used: wanted or marked used while resident, or uploaded */
	usedFrame: number;
	/** failed reads so far; a read fails the blob only after {@link MAX_READ_FAILURES} */
	readFailures: number;
	decoded: Decoded | null;
	/** set exactly while the item is `ready` */
	resident: Resident | null;
}
