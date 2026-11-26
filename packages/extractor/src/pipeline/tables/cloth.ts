import {
	CLOTH_META_BYTES,
	CLOTH_NODE_BYTES,
	CLOTH_PAIR_BYTES,
	type ClothGroup,
} from '@endfield-noclip/formats/endfield/cloth-groups';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import { objectField, pptrField } from '@endfield-noclip/formats/unity/values';
import { BlobKind } from '@endfield-noclip/package-format/blobs';
import {
	type ClothTable,
	type ClothTableEntry,
	encodeClothDataBlob,
} from '@endfield-noclip/package-format/cloth';

import type { AssetResolver, ObjectRef } from '../../game/assets/assets.ts';
import type { Context } from '../../install/context.ts';
import { compressedBlob } from '../archives.ts';
import type { BlobStore } from '../cache/blob-store.ts';

/** render pipeline global settings asset pointing at `HGRenderPipelineRuntimeResources.textures.WindNoiseTex` */
const PIPELINE_GLOBAL_SETTINGS_PATH =
	'assets/beyond/initialassets/settings/renderpipeline/hgrenderpipelineglobalsettings.asset';

/** packed cloth simulation plan, waiting on its wind noise texture id before writing `tables/cloth.bin.zst` */
export interface ClothPlan {
	/** {@link BlobKind.Cloth} blob id, or `null` when the scene has no simulated cloth */
	blob: number | null;
	/** `WindNoiseTex` (`_WindGlobalNoiseTex`) object ref to convert, or `null` */
	windNoiseTexture: ObjectRef | null;
	/** per-cloth skeleton offsets and node counts, indexed by packed cloth id */
	entries: ClothTableEntry[];
	/** `u32` cloth hash → packed cloth id (`0…entries.length - 1`) */
	clothIndexByHash: Map<number, number>;
}

/**
 * resolves `HGRenderPipelineRuntimeResources.textures.WindNoiseTex` from the install's pipeline settings
 *
 * @param context world index
 * @param resolver asset resolver
 * @returns the wind noise texture ref, or `null` if unavailable
 */
const findWindNoiseTexture = async (
	context: Pick<Context, 'world'>,
	resolver: AssetResolver,
): Promise<ObjectRef | null> => {
	const [hash] = await context.world.hashesOf(PIPELINE_GLOBAL_SETTINGS_PATH);
	if (hash === undefined) {
		return null;
	}
	try {
		const settingsRef = await resolver.findUnique(
			{ hash, path: PIPELINE_GLOBAL_SETTINGS_PATH },
			UnityClass.MonoBehaviour,
		);
		const settings = await resolver.read(settingsRef);
		const resourcesRef = await resolver.resolve(
			settingsRef,
			pptrField(settings, 'm_RenderPipelineResources'),
		);
		if (resourcesRef === null) {
			return null;
		}
		const resources = await resolver.read(resourcesRef);
		const textures = objectField(resources, 'textures');
		return await resolver.resolve(resourcesRef, pptrField(textures, 'WindNoiseTex'));
	} catch {
		return null;
	}
};

/**
 * packs all referenced cloth groups into one {@link BlobKind.Cloth} blob with dense `groupOffset.xyz` fields
 * pre-patched into `ClothMetaData`, and locates `WindNoiseTex` for texture conversion
 *
 * @param context world index and asset resolver
 * @param store blob store
 * @param groups unique cloth groups collected from the scene's chunk files
 * @param options asset archive stem and zstd level
 * @returns the cloth plan
 */
export const packCloth = async (
	context: Pick<Context, 'world' | 'resolver'>,
	store: BlobStore,
	groups: readonly ClothGroup[],
	options: { stem: string; zstdLevel: number },
): Promise<ClothPlan> => {
	if (groups.length === 0) {
		return { blob: null, windNoiseTexture: null, entries: [], clothIndexByHash: new Map() };
	}

	const sorted = groups.toSorted((a, b) => a.groupHash - b.groupHash);
	let totalCloths = 0;
	let totalNodes = 0;
	let batchVec4Count = 0;
	let cacheVec4Count = 0;
	for (const group of sorted) {
		totalCloths += group.cloths.length;
		totalNodes += group.nodeBytes.byteLength / CLOTH_NODE_BYTES;
		batchVec4Count += group.batchBytes.byteLength / CLOTH_PAIR_BYTES;
		cacheVec4Count += group.cacheBytes.byteLength / CLOTH_PAIR_BYTES;
	}

	const meta = new Uint8Array(totalCloths * CLOTH_META_BYTES);
	const metaView = new DataView(meta.buffer);
	const nodes = new Uint8Array(totalNodes * CLOTH_NODE_BYTES);
	const batches = new Uint8Array(batchVec4Count * CLOTH_PAIR_BYTES);
	const cache = new Uint8Array(cacheVec4Count * CLOTH_PAIR_BYTES);

	const entries: ClothTableEntry[] = [];
	const clothIndexByHash = new Map<number, number>();

	let clothCursor = 0;
	let nodeCursor = 0;
	let batchVec4Cursor = 0;
	let cacheVec4Cursor = 0;

	for (const group of sorted) {
		const nodeBase = nodeCursor;
		// two batch/cache records per 16-byte vec4; multiplying by 2 keeps groupOffset.y and .z even
		const batchBase = batchVec4Cursor * 2;
		const cacheBase = cacheVec4Cursor * 2;

		for (const [i, cloth] of group.cloths.entries()) {
			const dstByte = clothCursor * CLOTH_META_BYTES;
			const srcByte = i * CLOTH_META_BYTES;
			meta.set(group.metaBytes.subarray(srcByte, srcByte + CLOTH_META_BYTES), dstByte);
			// patch `ClothMetaData.groupOffset` (int4 at +0x20): (nodeBase, batchBase, cacheBase, groupHash)
			metaView.setInt32(dstByte + 32, nodeBase, true);
			metaView.setInt32(dstByte + 36, batchBase, true);
			metaView.setInt32(dstByte + 40, cacheBase, true);
			metaView.setUint32(dstByte + 44, group.groupHash, true);

			const localNodeStart = metaView.getUint32(dstByte, true);
			entries.push({ skeletonOffset: nodeBase + localNodeStart, nodeCount: cloth.nodeCount });
			if (!clothIndexByHash.has(cloth.hash)) {
				clothIndexByHash.set(cloth.hash, clothCursor);
			}
			clothCursor++;
		}

		nodes.set(group.nodeBytes, nodeCursor * CLOTH_NODE_BYTES);
		nodeCursor += group.nodeBytes.byteLength / CLOTH_NODE_BYTES;

		batches.set(group.batchBytes, batchVec4Cursor * CLOTH_PAIR_BYTES);
		batchVec4Cursor += group.batchBytes.byteLength / CLOTH_PAIR_BYTES;

		cache.set(group.cacheBytes, cacheVec4Cursor * CLOTH_PAIR_BYTES);
		cacheVec4Cursor += group.cacheBytes.byteLength / CLOTH_PAIR_BYTES;
	}

	const raw = encodeClothDataBlob({
		clothCount: totalCloths,
		nodeCount: totalNodes,
		batchVec4Count,
		cacheVec4Count,
		meta,
		nodes,
		batches,
		cache,
	});
	const [blob, windNoiseTexture] = await Promise.all([
		store.put(raw, {
			...compressedBlob(BlobKind.Cloth, options.stem, null),
			zstdLevel: options.zstdLevel,
		}),
		findWindNoiseTexture(context, await context.resolver()),
	]);

	return { blob, windNoiseTexture, entries, clothIndexByHash };
};

/**
 * finalizes `tables/cloth.bin.zst` once `WindNoiseTex` has its texture table id
 *
 * @param plan the cloth plan from {@link packCloth}
 * @param textureIds texture ids assigned to `[plan.windNoiseTexture]` (empty if none)
 * @returns the encoded-ready cloth table
 */
export const finishCloth = (plan: ClothPlan, textureIds: readonly (number | null)[]): ClothTable => ({
	blob: plan.blob,
	windNoiseTexture: textureIds[0] ?? null,
	cloths: plan.entries,
});
