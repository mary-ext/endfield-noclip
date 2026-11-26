import { loadTexture } from '../../game/assets/asset-decode.ts';
import type { AssetResolver } from '../../game/assets/assets.ts';
import { zstdSync } from '../../util/zstd.ts';
import { type BlobDir, storeCompressed, type StoredBlobLookup } from '../cache/blob-file.ts';

import type { ConvertJob, ConvertOutput } from './convert-pool.ts';
import { convertTexture } from './textures.ts';

type TextureJob = Extract<ConvertJob, { kind: 'texture' }>;
type TextureOutput = Extract<ConvertOutput, { kind: 'texture' }>;

/**
 * converts one texture job and writes its mip piece blobs to `blobs`. lives in its own module so the pack
 * cache fingerprints texture conversion independently of geometry conversion
 *
 * @param resolver asset resolver
 * @param blobs blob directory to write stored piece blobs into
 * @param memos optional memo directory for raw-byte compression deduplication
 * @param job texture conversion job
 * @returns converted texture output
 */
export const convertTextureJob = async (
	resolver: AssetResolver,
	blobs: BlobDir,
	memos: StoredBlobLookup | null,
	job: TextureJob,
): Promise<TextureOutput> => {
	const { bundleIndex, file, pathId } = job.locator;
	const texture = await loadTexture(resolver, await resolver.objectIn(bundleIndex, file, pathId));
	const converted = convertTexture(texture);
	const metas = await Promise.all(
		converted.pieces.map((piece) => storeCompressed(blobs, memos, piece.data, job.zstdLevel, zstdSync)),
	);
	return {
		kind: 'texture',
		name: texture.name,
		entry: converted.entry,
		contentKey: converted.contentKey,
		approximations: converted.approximations,
		pieces: converted.pieces.map(({ firstLevel, levelCount }, i) => ({
			firstLevel,
			levelCount,
			blob: metas[i],
		})),
	};
};
