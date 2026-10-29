import { parentPort, workerData } from 'node:worker_threads';
/**
 * worker thread that converts meshes and textures: it reads the source bundles through its own VFS and asset
 * resolver, converts, compresses and hashes the blobs, and writes them to the blob directory, so only small
 * results cross back to the packer. see {@link ConvertPool} for the packer's side
 *
 * @module
 */

import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import { bakeSkinPose } from '@endfield-noclip/formats/unity/skin-pose';

import { errorText } from '../errors.ts';
import { loadMesh, loadTexture } from '../game/asset-decode.ts';
import { AssetResolver, objectKey, recordBundleReads } from '../game/assets.ts';
import { loadBundleManifest } from '../hg/bundles.ts';
import { Vfs } from '../hg/vfs.ts';
import { zstdSync } from '../zstd.ts';

import { BlobDir, type BlobMeta, storedBlob } from './blob-file.ts';
import type {
	ConvertJob,
	ConvertOutput,
	ConvertResult,
	ConvertWorkerData,
	WorkerReply,
	WorkerRequest,
} from './convert-pool.ts';
import { convertMesh, geometryReady } from './geometry.ts';
import { convertTexture } from './textures.ts';

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- set by ConvertPool
const data = workerData as ConvertWorkerData;
const port = parentPort!;
const vfs = new Vfs(data.gameData, data.keys.vfsKey);
const blobs = new BlobDir(data.blobDir);
const resolverReady = loadBundleManifest(vfs).then(
	(manifest) => new AssetResolver({ vfs, keys: data.keys }, manifest),
);

const store = async (raw: Uint8Array, zstdLevel: number): Promise<BlobMeta> => {
	const { meta, stored } = storedBlob(raw, zstdSync(raw, zstdLevel));
	await blobs.write(meta.hash, stored);
	return meta;
};

const convert = async (job: ConvertJob): Promise<ConvertResult> => {
	const resolver = await resolverReady;
	const { result, bundles } = await recordBundleReads(() => convertWith(resolver, job));
	const sources = await Promise.all(
		bundles.map(async (index) => ({
			bundle: resolver.manifest.bundle(index).name,
			md5: await resolver.bundleMd5(index),
		})),
	);
	return { ...result, sources };
};

const convertWith = async (resolver: AssetResolver, job: ConvertJob): Promise<ConvertOutput> => {
	switch (job.kind) {
		case 'geometry': {
			await geometryReady;
			const ref = await resolver.findUnique(job.asset, UnityClass.Mesh);
			const mesh = await loadMesh(resolver, ref);
			const posed = job.asset.pose ? bakeSkinPose(mesh, job.asset.pose) : mesh;
			const converted = convertMesh(posed, job.tangentUv);
			return {
				kind: 'geometry',
				object: objectKey(ref),
				name: mesh.name,
				entry: converted.entry,
				gpuBytes: converted.gpuBytes,
				blob: await store(converted.blob, job.zstdLevel),
			};
		}
		case 'texture': {
			const { bundleIndex, file, pathId } = job.locator;
			const texture = await loadTexture(resolver, await resolver.objectIn(bundleIndex, file, pathId));
			const converted = convertTexture(texture);
			const metas = await Promise.all(converted.pieces.map((piece) => store(piece.data, job.zstdLevel)));
			return {
				kind: 'texture',
				name: texture.name,
				entry: converted.entry,
				contentKey: converted.contentKey,
				pieces: converted.pieces.map(({ firstLevel, levelCount }, i) => ({
					firstLevel,
					levelCount,
					blob: metas[i],
				})),
			};
		}
	}
};

port.on('message', (request: WorkerRequest) => {
	if (request.type === 'close') {
		void vfs.close().finally(() => port.close());
		return;
	}
	convert(request.job).then(
		(result) => port.postMessage({ id: request.id, result } satisfies WorkerReply),
		(error: unknown) => port.postMessage({ id: request.id, error: errorText(error) } satisfies WorkerReply),
	);
});
