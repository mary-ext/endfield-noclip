import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { BlobKind } from '@endfield-noclip/package-format/blobs';
import {
	DrawRole,
	encodeChains,
	encodeInstanceBlock,
	type Chain,
} from '@endfield-noclip/package-format/instances';
import { CORE_PATHS, PACKAGE_FORMAT, PACKAGE_VERSION } from '@endfield-noclip/package-format/manifest';
import { ContentKind, encodeTree, type Tree } from '@endfield-noclip/package-format/tree';

import { ArchiveLayout } from './archives.ts';
import { BlobDir } from './cache/blob-file.ts';
import { BlobStore } from './cache/blob-store.ts';
import { InstanceBlockBuilder } from './instances/instances.ts';
import { PackedPackage } from './read-package.ts';
import { writePackage } from './write.ts';

describe('PackedPackage', () => {
	it('reads core tables, resolves instance blobs across core and shards, and decodes blocks', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'read-pkg-'));
		try {
			const store = new BlobStore(new BlobDir(join(dir, '.spool')), {
				zstdLevel: 3,
				archiveCap: 1024 * 1024,
				core: 'core.czar',
				memo: null,
			});
			const rows = new InstanceBlockBuilder();
			rows.add(
				{
					chain: 0,
					entityId: 101,
					matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 12, 34, 56, 1]),
					bounds: { center: [12, 34, 56], extents: [2, 3, 4] },
				},
				0,
			);
			const { block } = rows.toBlock([10, 30, 50], BigUint64Array.of(1n), new Map());
			const encodedBlock = encodeInstanceBlock(block);

			const coreBlobId = await store.put(encodedBlock, {
				kind: BlobKind.Instances,
				compress: false,
				stem: 'core.czar',
				locality: null,
			});
			const shardBlobId = await store.put(encodedBlock, {
				kind: BlobKind.Instances,
				compress: true,
				stem: 'shards/0_0_0',
				locality: '00',
			});

			const chains: Chain[] = [
				{
					contentHash: 1n,
					flags: 0,
					distanceOrigin: null,
					draws: [
						{
							geometry: 0,
							material: 0,
							particles: null,
							submesh: 0,
							lod: 0,
							role: DrawRole.Lit,
							minSquared: -1,
							maxSquared: 1e30,
							flags: 0,
							sortingLayer: 0,
							sortingOrder: 0,
						},
					],
				},
			];
			const tree: Tree = {
				nodes: [
					{
						level: 0,
						x: 0,
						z: 0,
						bounds: { min: [0, 0, 0], max: [64, 64, 64] },
						geometricError: 4,
						refFirst: 0,
						refCount: 1,
					},
				],
				refs: [
					{
						kind: ContentKind.Detail,
						tier: 0,
						group: 0,
						blob: shardBlobId,
						first: 0,
						count: 1,
						reach: null,
					},
				],
				global: [
					{
						kind: ContentKind.Detail,
						tier: 0,
						group: 0,
						blob: coreBlobId,
						first: 0,
						count: 1,
						reach: null,
					},
				],
				reaches: [],
			};
			const treeInfo = {
				origin: [0, 0] as [number, number],
				rootSize: 64,
				leafLevel: 0,
				cellLevel: 0,
				hlodLevels: [0],
				shardLevel: 0,
			};
			const layout = new ArchiveLayout(treeInfo);
			layout.stemOf({ level: 0, x: 0, z: 0 });
			await writePackage(
				{ store, layout, dir, previous: null },
				{
					format: PACKAGE_FORMAT,
					version: PACKAGE_VERSION,
					source: { buildGuid: 'test', contentHash: 'test' },
					scene: { id: 'test_scene', name: 'Test' },
					subset: null,
					tree: treeInfo,
					terrain: null,
					levels: [],
					states: {
						categories: [],
						controls: [],
						conditionalSets: [],
						groups: [],
						streamAreas: null,
						missions: [],
						mainStory: [],
					},
					irradianceRegions: [],
					fireSeed: null,
				},
				[
					{ path: CORE_PATHS.tree, data: encodeTree(tree) },
					{ path: CORE_PATHS.chains, data: encodeChains(chains) },
				],
			);

			await using pkg = await PackedPackage.open(dir);
			assert.equal(pkg.manifest.scene.id, 'test_scene');
			assert.ok(pkg.coreFiles().some((file) => file.path === CORE_PATHS.manifest));
			assert.ok((await pkg.readCore('manifest')).byteLength > 0);
			assert.equal((await pkg.tree()).nodes.length, 1);
			assert.equal((await pkg.chains()).length, 1);

			const coreHash = store.hashOf(coreBlobId);
			const shardHash = store.hashOf(shardBlobId);
			const located = await pkg.locateInstanceBlobs(new Set([coreHash, shardHash]));
			assert.equal(located.get(coreHash), coreBlobId);
			assert.equal(located.get(shardHash), shardBlobId);

			const reversed = await pkg.blobHashes(new Set([coreBlobId, shardBlobId]));
			assert.equal(reversed.get(coreBlobId), coreHash);
			assert.equal(reversed.get(shardBlobId), shardHash);

			assert.deepEqual(await pkg.readBlob(shardBlobId, BlobKind.Instances), encodedBlock);
			const decoded = await pkg.readInstanceBlock(shardBlobId);
			assert.deepEqual(decoded.origin, block.origin);
			assert.deepEqual(decoded.chains, block.chains);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
