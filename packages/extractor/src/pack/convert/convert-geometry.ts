import type { DecodedMesh } from '@endfield-noclip/formats/unity/mesh';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import { bakeSkinPose } from '@endfield-noclip/formats/unity/skin-pose';

import { errorText } from '../../errors.ts';
import { loadMesh, loadTexture } from '../../game/assets/asset-decode.ts';
import { type AssetResolver, type ObjectLocator, objectKey } from '../../game/assets/assets.ts';
import { zstdSync } from '../../zstd.ts';
import { type BlobDir, storeCompressed, type StoredBlobLookup } from '../store/blob-file.ts';

import type { ConvertJob, ConvertOutput } from './convert-pool.ts';
import { convertMesh, geometryReady, rigidSkin } from './geometry.ts';
import { syntheticMesh, syntheticMeshKey } from './synthetic-mesh.ts';
import { boneVatSkin, type VatBake, vatSkin, type VatTexels, vatTexels } from './vat-skin.ts';

type GeometryJob = Extract<ConvertJob, { kind: 'geometry' }>;
type GeometryOutput = Extract<ConvertOutput, { kind: 'geometry' }>;

/** @returns a VAT texture's texels */
const loadVatTexels = async (
	resolver: AssetResolver,
	{ bundleIndex, file, pathId }: ObjectLocator,
): Promise<VatTexels> =>
	vatTexels(await loadTexture(resolver, await resolver.objectIn(bundleIndex, file, pathId)));

/** bakes a mesh's vertex animation from its textures */
const bakeVat = async (
	resolver: AssetResolver,
	mesh: DecodedMesh,
	bake: VatBake,
): Promise<ReturnType<typeof vatSkin>> => {
	// an animation that can't be read leaves the mesh still rather than failing it
	try {
		if (bake.body === 'bone') {
			return boneVatSkin(mesh, bake, await loadVatTexels(resolver, bake.map));
		}
		return vatSkin(
			mesh,
			bake,
			await loadVatTexels(resolver, bake.position),
			await loadVatTexels(resolver, bake.rotation),
		);
	} catch (error) {
		return { reason: `a vertex animation whose textures can't be read: ${errorText(error)}` };
	}
};

/**
 * converts one geometry job and writes its blob to `blobs`. lives in its own module so the pack cache
 * fingerprints geometry conversion independently of texture conversion
 *
 * @param resolver asset resolver
 * @param blobs blob directory to write the stored blob into
 * @param memos optional memo directory for raw-byte compression deduplication
 * @param job geometry conversion job
 * @returns converted geometry output
 */
export const convertGeometryJob = async (
	resolver: AssetResolver,
	blobs: BlobDir,
	memos: StoredBlobLookup | null,
	job: GeometryJob,
): Promise<GeometryOutput> => {
	await geometryReady;
	if (job.asset.synthetic !== undefined) {
		const converted = convertMesh(syntheticMesh(job.asset.synthetic), job.tangentUv, {
			sway: job.sway ?? undefined,
			offset: job.offset ?? undefined,
		});
		return {
			kind: 'geometry',
			object: syntheticMeshKey(job.asset.synthetic),
			name: syntheticMeshKey(job.asset.synthetic),
			entry: converted.entry,
			gpuBytes: converted.gpuBytes,
			blob: await storeCompressed(blobs, memos, converted.blob, job.zstdLevel, zstdSync),
		};
	}
	const ref = await resolver.findUnique(job.asset, UnityClass.Mesh);
	const mesh = await loadMesh(resolver, ref);
	// an animated mesh stays in its bind space; a posed one is baked into its pose
	const { pose, motion } = job.asset;
	let source = pose ? bakeSkinPose(mesh, pose) : mesh;
	let skin = motion?.skin;
	let unanimated: string | undefined;
	if (motion?.kind === 'rigid') {
		source = rigidSkin(source);
	}
	if (job.vat !== null) {
		// a renderer's own animation or pose and a VAT's would compound; the renderer's is kept
		const baked =
			pose !== undefined || motion !== undefined
				? { reason: 'a vertex animation on a posed or animated renderer' }
				: await bakeVat(resolver, source, job.vat);
		if ('reason' in baked) {
			unanimated = baked.reason;
		} else {
			source = baked.mesh;
			skin = baked.motion;
		}
	}
	const converted = convertMesh(source, job.tangentUv, {
		sway: job.sway ?? undefined,
		offset: job.offset ?? undefined,
		motion: skin,
	});
	return {
		kind: 'geometry',
		object: objectKey(ref),
		name: mesh.name,
		entry: converted.entry,
		gpuBytes: converted.gpuBytes,
		blob: await storeCompressed(blobs, memos, converted.blob, job.zstdLevel, zstdSync),
		...(unanimated === undefined ? {} : { unanimated }),
	};
};
