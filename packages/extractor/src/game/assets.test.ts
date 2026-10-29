import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { UnityBundle } from '@endfield-noclip/formats/hg/bundle';
import type { BundleManifest } from '@endfield-noclip/formats/hg/bundle-manifest';
import { type ObjectInfo, UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';

import { BundleAssetFile } from '../hg/bundles.ts';
import { Vfs } from '../hg/vfs.ts';

import { AssetResolver, objectKey } from './assets.ts';

const object = (pathId: bigint, classId: number): ObjectInfo => ({
	pathId,
	classId,
	byteStart: 0,
	byteSize: 0,
	type: {
		classId,
		isStripped: false,
		scriptTypeIndex: -1,
		scriptId: undefined,
		oldTypeHash: new Uint8Array(16),
		nodes: [],
		klassName: undefined,
		nameSpace: undefined,
		asmName: undefined,
		typeDependencies: [],
	},
});

const pointer = (pathId: bigint, fileId = 0) => ({ m_FileID: fileId, m_PathID: pathId });
const container = (path: string, asset: TypeTreeObject, preloads: TypeTreeObject[]) => ({
	m_Container: [{ first: path, second: { asset, preloadIndex: 0, preloadSize: preloads.length } }],
	m_PreloadTable: preloads,
});

const file = (name: string, objects: ObjectInfo[], values: Map<bigint, TypeTreeObject>) => {
	const result = new BundleAssetFile(
		{} as UnityBundle,
		{ path: name, offset: 0, size: 0, flags: 4 },
		{
			header: { version: 22, metadataSize: 0, fileSize: 0, dataOffset: 0, littleEndian: true },
			unityVersion: '',
			targetPlatform: 0,
			enableTypeTree: true,
			types: [],
			objects,
			objectsByPathId: new Map(objects.map((info) => [info.pathId, info])),
			scriptTypes: [],
			externals: [],
			refTypes: [],
			userInformation: '',
		},
		undefined,
	);
	result.read = async (target) => values.get(typeof target === 'bigint' ? target : target.pathId) ?? {};
	result.peekName = async (info) => {
		const value = values.get(info.pathId)?.m_Name;
		return typeof value === 'string' ? value : undefined;
	};
	return result;
};

const resolver = (files: BundleAssetFile[]) => {
	const keys = {
		vfsKey: new Uint8Array(32),
		bundle: { sbox: new Uint8Array(256), key: new Uint8Array(16), iv: new Uint8Array(16), chainXor: 0n },
	};
	const result = new AssetResolver({ vfs: new Vfs('', keys.vfsKey), keys }, {} as BundleManifest);
	result.assetFiles = async () => files;
	result.bundleOfCab = async () => 0;
	return result;
};

test('container path ids resolve only inside their owning SerializedFile', async () => {
	const owner = file(
		'CAB-owner',
		[object(1n, UnityClass.AssetBundle), object(2n, UnityClass.Material)],
		new Map<bigint, TypeTreeObject>([[1n, container('material.mat', pointer(2n), [])]]),
	);
	const collision = file('CAB-collision', [object(2n, UnityClass.Material)], new Map());
	const refs = await resolver([collision, owner]).findInBundle(0, 'material.mat', UnityClass.Material);
	assert.deepEqual(refs.map(objectKey), ['CAB-owner:2']);
});

test('container external pointers preserve file id', async () => {
	const owner = file(
		'CAB-owner',
		[object(1n, UnityClass.AssetBundle), object(2n, UnityClass.Material)],
		new Map<bigint, TypeTreeObject>([[1n, container('material.mat', pointer(2n, 1), [])]]),
	);
	owner.file.externals.push({
		guid: new Uint8Array(16),
		type: 0,
		pathName: 'archive:/CAB-target/CAB-target',
	});
	const target = file('CAB-target', [object(2n, UnityClass.Material)], new Map());
	const refs = await resolver([owner, target]).findInBundle(0, 'material.mat', UnityClass.Material);
	assert.deepEqual(refs.map(objectKey), ['CAB-target:2']);
});

test('sub-assets are restricted to the container preload range and deduplicated', async () => {
	const owner = file(
		'CAB-owner',
		[object(1n, UnityClass.AssetBundle), object(2n, UnityClass.Mesh), object(3n, UnityClass.Mesh)],
		new Map<bigint, TypeTreeObject>([
			[1n, container('model.fbx', pointer(2n), [pointer(2n), pointer(2n)])],
			[2n, { m_Name: 'mesh' }],
			[3n, { m_Name: 'mesh' }],
		]),
	);
	const refs = await resolver([owner]).findInBundle(0, 'MODEL.FBX##MESH', UnityClass.Mesh);
	assert.deepEqual(refs.map(objectKey), ['CAB-owner:2']);
});

test('missing containers and mismatched main assets never fall back to bundle-wide class matches', async () => {
	const owner = file(
		'CAB-owner',
		[object(1n, UnityClass.AssetBundle), object(2n, UnityClass.Material), object(3n, UnityClass.Mesh)],
		new Map<bigint, TypeTreeObject>([
			[1n, container('material.mat', pointer(2n), [pointer(3n)])],
			[3n, { m_Name: 'mesh' }],
		]),
	);
	const assets = resolver([owner]);
	assert.deepEqual(await assets.findInBundle(0, 'missing.mesh', UnityClass.Mesh), []);
	assert.deepEqual(await assets.findInBundle(0, 'missing.fbx##mesh', UnityClass.Mesh), []);
	assert.deepEqual(await assets.findInBundle(0, 'material.mat', UnityClass.Mesh), []);
});

test('invalid preload ranges fail instead of silently truncating', async () => {
	const value = container('model.fbx', pointer(2n), []);
	value.m_Container[0].second.preloadSize = 1;
	const owner = file(
		'CAB-owner',
		[object(1n, UnityClass.AssetBundle)],
		new Map<bigint, TypeTreeObject>([[1n, value]]),
	);
	await assert.rejects(owner.assetBundles(), /invalid preload range/);
});

test('ambiguous named sub-assets remain ambiguous within a valid preload range', async () => {
	const owner = file(
		'CAB-owner',
		[object(1n, UnityClass.AssetBundle), object(2n, UnityClass.Mesh), object(3n, UnityClass.Mesh)],
		new Map<bigint, TypeTreeObject>([
			[1n, container('model.fbx', pointer(2n), [pointer(2n), pointer(3n)])],
			[2n, { m_Name: 'mesh' }],
			[3n, { m_Name: 'mesh' }],
		]),
	);
	const assets = resolver([owner]);
	assets.manifest.findAssets = () => [{ pathHash: 1n, bundleIndex: 0, pathOffset: 0, size: 0 }];
	await assert.rejects(
		assets.findUnique({ hash: 1n, path: 'model.fbx##mesh' }, UnityClass.Mesh),
		/2 Mesh objects/,
	);
});
