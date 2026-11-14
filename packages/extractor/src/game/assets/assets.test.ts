import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { UnityBundle } from '@endfield-noclip/formats/hg/bundle';
import type { BundleManifest } from '@endfield-noclip/formats/hg/bundle-manifest';
import { type ObjectInfo, UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';

import { BundleAssetFile } from '../../hg/bundles.ts';
import { Vfs } from '../../hg/vfs.ts';
import { readPrefabLights } from '../prefabs/prefab-lights.ts';
import { readPrefabRenderers } from '../prefabs/prefab.ts';

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

test("PPtrs into Unity's built-in files resolve through the built-in lookup, and fail without a match", async () => {
	const owner = file('CAB-owner', [object(1n, UnityClass.MeshFilter)], new Map());
	owner.file.externals.push({
		guid: new Uint8Array(16),
		type: 0,
		pathName: 'Library/unity default resources',
	});
	const copy = file('CAB-copy', [object(7n, UnityClass.Mesh)], new Map());
	const copyRef = { bundleIndex: 1, file: copy, info: copy.file.objects[0] };
	const keys = {
		vfsKey: new Uint8Array(32),
		bundle: { sbox: new Uint8Array(256), key: new Uint8Array(16), iv: new Uint8Array(16), chainXor: 0n },
	};
	const asked: string[] = [];
	const assets = new AssetResolver(
		{ vfs: new Vfs('', keys.vfsKey), keys },
		{} as BundleManifest,
		async (_, path, pathId) => {
			asked.push(`${path}:${pathId}`);
			return pathId === 10210n ? copyRef : null;
		},
	);
	const from = { bundleIndex: 0, file: owner, info: owner.file.objects[0] };
	assert.equal(await assets.resolve(from, { fileId: 1, pathId: 10210n }), copyRef);
	await assert.rejects(assets.resolve(from, { fileId: 1, pathId: 10202n }), /path id 10202/);
	assert.deepEqual(asked, ['library/unity default resources:10210', 'library/unity default resources:10202']);
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

test('sub-asset lookups skip preloads into other bundles without opening them', async () => {
	const owner = file(
		'CAB-owner',
		[object(1n, UnityClass.AssetBundle), object(2n, UnityClass.Mesh)],
		new Map<bigint, TypeTreeObject>([
			[1n, container('model.fbx', pointer(2n), [pointer(2n), pointer(9n, 1)])],
			[2n, { m_Name: 'mesh' }],
		]),
	);
	owner.file.externals.push({ guid: new Uint8Array(16), type: 0, pathName: 'archive:/CAB-dep/CAB-dep' });
	Object.assign(owner.bundle, { node: () => undefined });
	const assets = resolver([owner]);
	assets.bundleOfCab = () => assert.fail('opened a dependency bundle');
	const refs = await assets.findInBundle(0, 'model.fbx##mesh', UnityClass.Mesh);
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
	assets.manifest.findAssets = () => [{ pathHash: 1n, bundleIndex: 0, pathOffset: 0, assetSize: 0 }];
	await assert.rejects(
		assets.findUnique({ hash: 1n, path: 'model.fbx##mesh' }, UnityClass.Mesh),
		/2 Mesh objects/,
	);
});

test('prefab selection follows active hierarchy and LOD references, preserving material slots and shadow-only renderers', async () => {
	const values = new Map<bigint, TypeTreeObject>();
	const objects: ObjectInfo[] = [];
	const add = (id: bigint, classId: number, data: TypeTreeObject): void => {
		objects.push(object(id, classId));
		values.set(id, data);
	};
	const vector = (x: number, y: number, z: number) => ({ x, y, z });
	const transform = (go: bigint, x: number, children: bigint[]) => ({
		m_GameObject: pointer(go),
		m_LocalPosition: vector(x, 0, 0),
		m_LocalRotation: { x: 0, y: 0, z: 0, w: 1 },
		m_LocalScale: vector(1, 1, 1),
		m_Children: children.map((id) => pointer(id)),
	});
	add(1n, UnityClass.GameObject, {
		m_Name: 'root',
		m_IsActive: true,
		m_Component: [2n, 3n].map((id) => ({ component: pointer(id) })),
	});
	add(2n, UnityClass.Transform, transform(1n, 999, [11n, 21n, 31n, 41n]));
	add(3n, 205, {
		m_Enabled: true,
		m_LODs: [
			{ screenRelativeHeight: 0.5, renderers: [{ renderer: pointer(13n) }] },
			{ screenRelativeHeight: 0.1, renderers: [{ renderer: pointer(23n) }] },
		],
	});
	for (const id of [10n, 20n, 30n]) {
		add(id, UnityClass.GameObject, {
			m_Name: 'same_name_lod1',
			m_IsActive: id !== 30n,
			m_Component: [id + 1n, id + 2n, id + 3n].map((componentId) => ({ component: pointer(componentId) })),
		});
		add(id + 1n, UnityClass.Transform, transform(id, Number(id), []));
		add(id + 2n, UnityClass.MeshFilter, { m_Mesh: pointer(50n) });
		add(id + 3n, UnityClass.MeshRenderer, {
			m_Enabled: true,
			m_CastShadows: 4,
			m_Materials: [pointer(0n), pointer(60n)],
		});
	}
	add(50n, UnityClass.Mesh, {
		m_LocalAABB: { m_Center: vector(0, 0, 0), m_Extent: vector(1, 2, 3) },
		m_SubMeshes: [{}, {}],
	});
	add(40n, UnityClass.GameObject, {
		m_Name: 'skinned part',
		m_IsActive: true,
		m_Component: [41n, 42n].map((id) => ({ component: pointer(id) })),
	});
	add(41n, UnityClass.Transform, transform(40n, 0, []));
	add(42n, UnityClass.SkinnedMeshRenderer, {
		m_Enabled: true,
		m_CastShadows: 1,
		m_Mesh: pointer(51n),
		m_Bones: [pointer(11n)],
		m_BlendShapeWeights: [],
		m_Materials: [pointer(60n)],
	});
	add(51n, UnityClass.Mesh, {
		m_LocalAABB: { m_Center: vector(0, 0, 0), m_Extent: vector(1, 1, 1) },
		m_SubMeshes: [{}],
		m_BindPose: [
			Object.fromEntries(
				Array.from({ length: 16 }, (_, k) => ['e' + (k % 4) + Math.floor(k / 4), k % 5 === 0 ? 1 : 0]),
			),
		],
	});
	add(60n, UnityClass.Material, {});
	const owner = file('CAB-prefab', objects, values);
	const rows = await readPrefabRenderers(
		resolver([owner]),
		{
			bundleIndex: 0,
			file: owner,
			info: objects[0],
		},
		{ viewPose: null, particleQuad: null, locked: false },
	);
	assert.equal(rows.length, 4);
	assert.equal(rows[3].pose?.[0][12], 10);
	assert.equal(rows[3].matrix[12], 0);
	assert.deepEqual(rows[3].bounds.center, [10, 0, 0]);
	assert.equal(rows[0].matrix[12], 10);
	assert.equal(rows[0].unsupported, null);
	assert.equal(rows[0].shadowOnly, true);
	assert.equal(rows[0].materials[0], null);
	assert.equal(rows[0].materials[1]?.info.pathId, 60n);
	// each LOD's renderer, picked by identity, shows over its own span of screen heights
	assert.deepEqual(rows[0].sizes, [{ lod: 0, min: 0.5, max: Infinity }]);
	assert.equal(rows[1].matrix[12], 20);
	assert.deepEqual(rows[1].sizes, [{ lod: 1, min: 0.1, max: 0.5 }]);
	assert.equal(rows[3].sizes, null);
	// the switched-off GameObject stands in rather than vanishing
	assert.equal(rows[2].matrix[12], 30);
	assert.notEqual(rows[2].unsupported, null);
});

test('skinned prefab meshes resolve bones under inactive GameObjects, whose renderers stand in', async () => {
	const values = new Map<bigint, TypeTreeObject>();
	const objects: ObjectInfo[] = [];
	const add = (id: bigint, classId: number, data: TypeTreeObject): void => {
		objects.push(object(id, classId));
		values.set(id, data);
	};
	const vector = (x: number, y: number, z: number) => ({ x, y, z });
	const transform = (go: bigint, x: number, children: bigint[]) => ({
		m_GameObject: pointer(go),
		m_LocalPosition: vector(x, 0, 0),
		m_LocalRotation: { x: 0, y: 0, z: 0, w: 1 },
		m_LocalScale: vector(1, 1, 1),
		m_Children: children.map((id) => pointer(id)),
	});
	const identity = Object.fromEntries(
		Array.from({ length: 16 }, (_, k) => ['e' + (k % 4) + Math.floor(k / 4), k % 5 === 0 ? 1 : 0]),
	);
	add(1n, UnityClass.GameObject, {
		m_Name: 'root',
		m_IsActive: true,
		m_Component: [{ component: pointer(2n) }],
	});
	add(2n, UnityClass.Transform, transform(1n, 0, [11n, 21n]));
	add(10n, UnityClass.GameObject, {
		m_Name: 'skin',
		m_IsActive: true,
		m_Component: [11n, 12n].map((id) => ({ component: pointer(id) })),
	});
	add(11n, UnityClass.Transform, transform(10n, 0, []));
	add(12n, UnityClass.SkinnedMeshRenderer, {
		m_Enabled: true,
		m_CastShadows: 1,
		m_Mesh: pointer(50n),
		m_Bones: [pointer(31n)],
		m_BlendShapeWeights: [],
		m_Materials: [pointer(60n)],
	});
	// the inactive rig holds a bone and a renderer that only stands in
	add(20n, UnityClass.GameObject, {
		m_Name: 'rig',
		m_IsActive: false,
		m_Component: [21n, 22n].map((id) => ({ component: pointer(id) })),
	});
	add(21n, UnityClass.Transform, transform(20n, 5, [31n]));
	add(22n, UnityClass.SkinnedMeshRenderer, {
		m_Enabled: true,
		m_CastShadows: 1,
		m_Mesh: pointer(50n),
		m_Bones: [pointer(31n)],
		m_BlendShapeWeights: [],
		m_Materials: [pointer(60n)],
	});
	add(30n, UnityClass.GameObject, {
		m_Name: 'bone',
		m_IsActive: true,
		m_Component: [{ component: pointer(31n) }],
	});
	add(31n, UnityClass.Transform, transform(30n, 2, []));
	add(50n, UnityClass.Mesh, {
		m_LocalAABB: { m_Center: vector(0, 0, 0), m_Extent: vector(1, 1, 1) },
		m_SubMeshes: [{}],
		m_BindPose: [identity],
	});
	add(60n, UnityClass.Material, {});
	const owner = file('CAB-prefab', objects, values);
	const rows = await readPrefabRenderers(
		resolver([owner]),
		{
			bundleIndex: 0,
			file: owner,
			info: objects[0],
		},
		{ viewPose: null, particleQuad: null, locked: false },
	);
	assert.deepEqual(
		rows.map((row) => [row.name, row.unsupported !== null]),
		[
			['skin', false],
			['rig', true],
		],
	);
	assert.equal(rows[0].pose?.[0][12], 7);
});

test('a root UnlockEffectConfigMono draws the locked model of a locked placement, and never stands in the other', async () => {
	const values = new Map<bigint, TypeTreeObject>();
	const objects: ObjectInfo[] = [];
	const add = (id: bigint, classId: number, data: TypeTreeObject, fields: string[] = []): void => {
		const info = object(id, classId);
		info.type?.nodes.push(
			...fields.map((name, index) => ({
				type: '',
				name,
				level: 1,
				byteSize: -1,
				typeFlags: 0,
				metaFlag: 0,
				version: 1,
				index,
				refTypeHash: 0n,
			})),
		);
		objects.push(info);
		values.set(id, data);
	};
	const vector = (x: number, y: number, z: number) => ({ x, y, z });
	const transform = (go: bigint, children: bigint[]) => ({
		m_GameObject: pointer(go),
		m_LocalPosition: vector(0, 0, 0),
		m_LocalRotation: { x: 0, y: 0, z: 0, w: 1 },
		m_LocalScale: vector(1, 1, 1),
		m_Children: children.map((id) => pointer(id)),
	});
	add(1n, UnityClass.GameObject, {
		m_Name: 'root',
		m_IsActive: true,
		m_Component: [2n, 3n].map((id) => ({ component: pointer(id) })),
	});
	add(2n, UnityClass.Transform, transform(1n, [11n, 21n]));
	add(
		3n,
		UnityClass.MonoBehaviour,
		{ m_Enabled: 1, useDifferentModel: 1, lockedModel: pointer(20n), unlockedModel: pointer(10n) },
		['m_Enabled', 'useDifferentModel', 'lockedModel', 'unlockedModel'],
	);
	// as saved, the fixed model is on and the broken one off
	for (const [id, name, active] of [
		[10n, 'Fixed', true],
		[20n, 'Broken', false],
	] as const) {
		add(id, UnityClass.GameObject, {
			m_Name: name,
			m_IsActive: active,
			m_Component: [id + 1n, id + 2n, id + 3n].map((componentId) => ({ component: pointer(componentId) })),
		});
		add(id + 1n, UnityClass.Transform, transform(id, []));
		add(id + 2n, UnityClass.MeshFilter, { m_Mesh: pointer(50n) });
		add(id + 3n, UnityClass.MeshRenderer, { m_Enabled: true, m_CastShadows: 1, m_Materials: [pointer(60n)] });
	}
	add(50n, UnityClass.Mesh, {
		m_LocalAABB: { m_Center: vector(0, 0, 0), m_Extent: vector(1, 1, 1) },
		m_SubMeshes: [{}],
	});
	add(60n, UnityClass.Material, {});
	const owner = file('CAB-prefab', objects, values);
	const read = async (locked: boolean) =>
		(
			await readPrefabRenderers(
				resolver([owner]),
				{ bundleIndex: 0, file: owner, info: objects[0] },
				{ viewPose: null, particleQuad: null, locked },
			)
		).map((row) => [row.name, row.unsupported !== null]);
	assert.deepEqual(await read(true), [['Broken', false]]);
	assert.deepEqual(await read(false), [['Fixed', false]]);
});

test('a raft post-model draws nothing for its wakes, which show only while it moves', async () => {
	const values = new Map<bigint, TypeTreeObject>();
	const objects: ObjectInfo[] = [];
	const add = (id: bigint, classId: number, data: TypeTreeObject, fields: string[] = []): void => {
		const info = object(id, classId);
		info.type?.nodes.push(
			...fields.map((name, index) => ({
				type: '',
				name,
				level: 1,
				byteSize: -1,
				typeFlags: 0,
				metaFlag: 0,
				version: 1,
				index,
				refTypeHash: 0n,
			})),
		);
		objects.push(info);
		values.set(id, data);
	};
	const vector = (x: number, y: number, z: number) => ({ x, y, z });
	const transform = (go: bigint, children: bigint[]) => ({
		m_GameObject: pointer(go),
		m_LocalPosition: vector(0, 0, 0),
		m_LocalRotation: { x: 0, y: 0, z: 0, w: 1 },
		m_LocalScale: vector(1, 1, 1),
		m_Children: children.map((id) => pointer(id)),
	});
	add(1n, UnityClass.GameObject, {
		m_Name: 'root',
		m_IsActive: true,
		m_Component: [2n, 3n].map((id) => ({ component: pointer(id) })),
	});
	add(2n, UnityClass.Transform, transform(1n, [11n, 21n, 31n]));
	// the mono names its wake roots by their Transforms
	add(
		3n,
		UnityClass.MonoBehaviour,
		{ m_Enabled: 1, headAnchorRoot: pointer(21n), tailAnchorRoot: pointer(31n), decalHeadRoot: pointer(0n) },
		['m_Enabled', 'headAnchorRoot', 'tailAnchorRoot', 'decalHeadRoot'],
	);
	// as saved, the wakes are off; another switched-off model still stands in
	for (const [id, name, active] of [
		[10n, 'Raft', true],
		[20n, 'Head', false],
		[30n, 'Tail', false],
	] as const) {
		add(id, UnityClass.GameObject, {
			m_Name: name,
			m_IsActive: active,
			m_Component: [id + 1n, id + 2n, id + 3n].map((componentId) => ({ component: pointer(componentId) })),
		});
		add(id + 1n, UnityClass.Transform, transform(id, []));
		add(id + 2n, UnityClass.MeshFilter, { m_Mesh: pointer(50n) });
		add(id + 3n, UnityClass.MeshRenderer, { m_Enabled: true, m_CastShadows: 1, m_Materials: [pointer(60n)] });
	}
	add(50n, UnityClass.Mesh, {
		m_LocalAABB: { m_Center: vector(0, 0, 0), m_Extent: vector(1, 1, 1) },
		m_SubMeshes: [{}],
	});
	add(60n, UnityClass.Material, {});
	const owner = file('CAB-prefab', objects, values);
	const rows = await readPrefabRenderers(
		resolver([owner]),
		{ bundleIndex: 0, file: owner, info: objects[0] },
		{ viewPose: null, particleQuad: null, locked: false },
	);
	assert.deepEqual(
		rows.map((row) => [row.name, row.unsupported !== null]),
		[['Raft', false]],
	);
});

test('prefab lights read the enabled lights of active GameObjects with their HG light data', async () => {
	const values = new Map<bigint, TypeTreeObject>();
	const objects: ObjectInfo[] = [];
	const add = (id: bigint, classId: number, data: TypeTreeObject): void => {
		objects.push(object(id, classId));
		values.set(id, data);
	};
	const vector = (x: number, y: number, z: number) => ({ x, y, z });
	const transform = (go: bigint, x: number, children: bigint[]) => ({
		m_GameObject: pointer(go),
		m_LocalPosition: vector(x, 0, 0),
		m_LocalRotation: { x: 0, y: 0, z: 0, w: 1 },
		m_LocalScale: vector(1, 1, 1),
		m_Children: children.map((id) => pointer(id)),
	});
	const light = (enabled: boolean) => ({
		m_Enabled: enabled,
		m_Type: 0,
		m_Color: { r: 1, g: 1, b: 1, a: 1 },
		m_Intensity: 2,
		m_UseColorTemperature: false,
		m_ColorTemperature: 6570,
		m_Range: 10,
		m_SpotAngle: 90,
		m_InnerSpotAngle: 30,
		m_BakingOutput: { lightmapBakeMode: { lightmapBakeType: 4 } },
		m_SpecularIntensity: 1,
		m_ShadowOnly: false,
		m_LinearLightLength: -1,
		m_SoftSourceRadius: 0,
		m_LightPriority: 0,
		m_UseCullingDistance: true,
		m_FalloffDistance: 20,
		m_CullingDistance: 25,
		m_EnableOBBCullingBox: false,
		m_CullingBoxRelativePosition: vector(0, 0, 0),
		m_CullingBoxHalfExtents: vector(1, 1, 1),
		m_CullingBoxOrientation: vector(0, 0, 0),
		m_CullingBoxFalloffThreshold: 0.8,
		m_Shadows: {
			m_PlatformSpecificType: { defaultParam: 2 },
			m_Strength: 1,
			m_NormalBias: 0.4,
			m_NearPlane: 0.2,
			m_FarPlane: 15,
			m_ShadowCullDistance: 50,
			m_ShadowFadeRatio: 0.8,
			m_ShadowGuardAngle: 0,
			m_PointLightShadowCasterFaces: -1,
			m_CasterProperties: 6,
		},
	});
	const additional = {
		m_LightCharacterOnly: 0,
		m_volumetricScatteringIntensity: 0.5,
		m_falloffExponent: -1,
	};
	add(1n, UnityClass.GameObject, {
		m_Name: 'root',
		m_IsActive: true,
		m_Component: [{ component: pointer(2n) }],
	});
	add(2n, UnityClass.Transform, transform(1n, 999, [11n, 21n, 31n]));
	// lit, disabled, and under an inactive GameObject
	for (const [id, active, enabled] of [
		[10n, true, true],
		[20n, true, false],
		[30n, false, true],
	] as const) {
		add(id, UnityClass.GameObject, {
			m_Name: `light ${id}`,
			m_IsActive: active,
			m_Component: [id + 1n, id + 2n, id + 3n].map((componentId) => ({ component: pointer(componentId) })),
		});
		add(id + 1n, UnityClass.Transform, transform(id, 4, []));
		add(id + 2n, UnityClass.Light, light(enabled));
		add(id + 3n, UnityClass.MonoBehaviour, additional);
	}
	const owner = file('CAB-prefab', objects, values);
	const lights = await readPrefabLights(resolver([owner]), { bundleIndex: 0, file: owner, info: objects[0] });
	assert.deepEqual(
		lights.map(({ name }) => name),
		['light 10'],
	);
	// the root's own transform is the placement's
	assert.equal(lights[0].matrix[12], 4);
	assert.deepEqual(lights[0].light.color, [2, 2, 2]);
	assert.deepEqual(lights[0].light.distanceFade, { falloff: 20, culling: 25 });
	assert.equal(lights[0].light.volumetricScatteringIntensity, 0.5);
	assert.equal(lights[0].light.tubeLength, 0);
});
