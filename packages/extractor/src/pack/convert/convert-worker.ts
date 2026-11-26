import { parentPort, workerData } from 'node:worker_threads';
/**
 * worker thread that converts meshes and textures: it reads the source bundles through its own VFS and asset
 * resolver, converts, compresses and hashes the blobs, and writes them to the blob directory, so only small
 * results cross back to the packer. see {@link ConvertPool} for the packer's side
 *
 * @module
 */

import { errorText } from '../../errors.ts';
import { AssetResolver, recordBundleReads } from '../../game/assets/assets.ts';
import { sharedBundleManifest } from '../../hg/bundles.ts';
import { Vfs } from '../../hg/vfs.ts';
import { BlobDir } from '../store/blob-file.ts';
import { openStoredBlobLookup } from '../store/pack-cache.ts';

import { convertGeometryJob } from './convert-geometry.ts';
import type {
	ConvertJob,
	ConvertOutput,
	ConvertResult,
	ConvertWorkerData,
	WorkerReply,
	WorkerRequest,
} from './convert-pool.ts';
import { convertTextureJob } from './convert-texture.ts';

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- set by ConvertPool
const data = workerData as ConvertWorkerData;
const port = parentPort!;
const vfs = new Vfs(data.gameData, data.keys.vfsKey);
const blobs = new BlobDir(data.blobDir);
const memos = data.cacheDb === null ? null : openStoredBlobLookup(data.cacheDb);
const resolver = new AssetResolver({ vfs, keys: data.keys }, sharedBundleManifest(data.manifest));

const convert = async (job: ConvertJob): Promise<ConvertResult> => {
	const { result, bundles } = await recordBundleReads(
		async (): Promise<ConvertOutput | { kind: 'failed'; error: string }> => {
			try {
				switch (job.kind) {
					case 'geometry': {
						return await convertGeometryJob(resolver, blobs, memos, job);
					}
					case 'texture': {
						return await convertTextureJob(resolver, blobs, memos, job);
					}
				}
			} catch (error) {
				return { kind: 'failed', error: errorText(error) };
			}
		},
	);
	const sources = await Promise.all(
		bundles.map(async (index) => ({
			bundle: resolver.manifest.bundleName(index),
			md5: await resolver.bundleMd5(index),
		})),
	);
	if (result.kind === 'failed') {
		return {
			kind: 'failed',
			jobKind: job.kind,
			error: result.error,
			sources,
			...(sources.length === 0 ? { manifestHash: resolver.manifest.contentHash } : {}),
		};
	}
	return { ...result, sources };
};

port.on('message', (request: WorkerRequest) => {
	if (request.type === 'close') {
		memos?.close();
		void vfs.close().finally(() => port.close());
		return;
	}
	convert(request.job).then(
		(result) => port.postMessage({ id: request.id, result } satisfies WorkerReply),
		(error: unknown) => port.postMessage({ id: request.id, error: errorText(error) } satisfies WorkerReply),
	);
});
