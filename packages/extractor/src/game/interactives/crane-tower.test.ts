import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LevelInteractive } from '@endfield-noclip/formats/endfield/level-interactives';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import { quaternionUnityEuler } from '@endfield-noclip/formats/unity/transform';
import type { PPtr } from '@endfield-noclip/formats/unity/values';

import type { AssetResolver, ObjectRef } from '../assets/assets.ts';

import { craneSteps, craneTowerOf, readCraneLook } from './crane-tower.ts';

const floatBits = (value: number): string => {
	const view = new DataView(new ArrayBuffer(4));
	view.setFloat32(0, value);
	return String(view.getUint32(0));
};

const param = (key: string, values: (string | number)[]) => ({
	key,
	value: { type: 6, valueArray: values.map((value) => ({ valueBit64: String(value), valueString: null })) },
});

// int_crane_tower's component as saved, and map01_lv006's tower 3500021909 (near unity 479, 58, 224)
const template = {
	componentList: [
		{
			$type: 'Beyond_Gameplay_CraneTowerComponentDataForMemoryPack',
			propertyList: [
				param('position_list', [20, 30, 40].map(floatBits)),
				param('rotation_list', [0, 30, 60].map(floatBits)),
				param('euler_angles', [45, 90, 135, 180, 270, 0].map(floatBits)),
				param('target', [0]),
			],
		},
	],
};
const row = {
	componentProperties: new Map([
		[
			172,
			[
				{
					key: 'position_list',
					type: 6,
					values: [22.5, 28].map((v) => ({ bits: BigInt(floatBits(v)), text: null })),
				},
				{
					key: 'rotation_list',
					type: 6,
					values: [158, 220].map((v) => ({ bits: BigInt(floatBits(v)), text: null })),
				},
				{ key: 'euler_angles', type: 6, values: [{ bits: BigInt(floatBits(30)), text: null }] },
				{ key: 'target', type: 13, values: [{ bits: 3500021665n, text: null }] },
			],
		],
	]),
} as unknown as LevelInteractive;

test("a placement's crane parameters override the template's, and states pick clamped steps", () => {
	const tower = craneTowerOf(template, row);
	assert.ok(tower !== null);
	assert.deepEqual(tower.ropeLengths, [22.5, 28]);
	assert.deepEqual(tower.armYaws, [158, 220]);
	assert.deepEqual(tower.hookYaws, [30]);
	assert.equal(tower.target, 3500021665n);
	assert.deepEqual(craneSteps(tower, [0, 0, 0]), { ropeLength: 22.5, armYaw: 158, hookYaw: 30 });
	assert.deepEqual(craneSteps(tower, [5, -1, 2]), { ropeLength: 28, armYaw: 158, hookYaw: 30 });
	assert.equal(craneSteps({ ...tower, hookYaws: [] }, [0, 0, 0]), null);
	assert.equal(craneTowerOf({ componentList: [] }, row), null);
});

// int_crane_tower_postmodel's hierarchy, reduced to the Transforms the tower component moves:
// root (MonoBehaviour) → BasePoint → { Arm → ScaleBase, RopeStart → RopeEnd → Hook → RotatePoint → AttachPoint }
const objects = new Map<bigint, { classId: number; data: object }>();
const pptr = (id: number) => ({ m_FileID: 0, m_PathID: BigInt(id) });
{
	const nodes: [name: string, id: number, children: number[], position: number[], extra?: number][] = [
		['root', 1, [2], [0, 0, 0], 100],
		['BasePoint', 2, [3, 5], [0, 0, 0]],
		['Arm', 3, [4], [0, 0, 0]],
		['ScaleBase', 4, [], [0, 19.05, 22.24]],
		['RopeStart', 5, [6], [0, 18.07, 22.247]],
		['RopeEnd', 6, [7], [0, 0, 0]],
		['Hook', 7, [8], [0, 0, 0]],
		['RotatePoint', 8, [9], [0, 0, 0]],
		['AttachPoint', 9, [], [0, -1.714, 0]],
	];
	for (const [name, id, children, [x, y, z], mono] of nodes) {
		const components = [{ component: pptr(id + 10) }];
		if (mono !== undefined) {
			components.push({ component: pptr(mono) });
		}
		objects.set(BigInt(id), {
			classId: UnityClass.GameObject,
			data: { m_Name: name, m_IsActive: 1, m_Component: components },
		});
		objects.set(BigInt(id + 10), {
			classId: UnityClass.Transform,
			data: {
				m_GameObject: pptr(id),
				m_LocalPosition: { x, y, z },
				m_LocalRotation: { x: 0, y: 0, z: 0, w: 1 },
				m_LocalScale: { x: 1, y: 1, z: 1 },
				m_Children: children.map((child) => pptr(child + 10)),
			},
		});
	}
	objects.set(100n, {
		classId: UnityClass.MonoBehaviour,
		data: {
			rotateBaseTrans: pptr(12),
			rotateHeaderTrans: pptr(18),
			ropeEndTrans: pptr(16),
			ropeScaleTrans: pptr(14),
			attachTrans: pptr(19),
		},
	});
}
const refOf = (pathId: bigint) => ({
	file: { node: { path: 'CAB-test' } },
	info: { pathId, classId: objects.get(pathId)!.classId },
});
const resolver = {
	read: async (ref: ObjectRef) => objects.get(ref.info.pathId)!.data,
	resolve: async (_: ObjectRef, pointer: PPtr) =>
		objects.has(pointer.pathId) ? refOf(pointer.pathId) : null,
} as unknown as AssetResolver;

test('a crane tower stretches its rope, turns its arm and hook, and reports where its hook hangs', async () => {
	const look = await readCraneLook(
		resolver,
		refOf(1n) as unknown as ObjectRef,
		'tower',
		{ position: [479.23, 57.88, 223.94], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
		{ ropeLength: 22.5, armYaw: 158, hookYaw: 30 },
	);
	assert.ok(look !== null);
	const [x, y, z] = look.attach.position;
	// the arm's tip 22.247 m out along yaw 158°, 18.07 m up; the rope 22.5 m down, the attach point 1.714 m below
	const yaw = (158 * Math.PI) / 180;
	assert.ok(Math.abs(x - (479.23 + 22.247 * Math.sin(yaw))) < 1e-3);
	assert.ok(Math.abs(y - (57.88 + 18.07 - 22.5 - 1.714)) < 1e-3);
	assert.ok(Math.abs(z - (223.94 + 22.247 * Math.cos(yaw))) < 1e-3);
	// the hook keeps its own world yaw, not the arm's
	assert.ok(Math.abs(quaternionUnityEuler(look.attach.rotation)[1] - 30) < 1e-3);
	const [clip] = look.pose.clips;
	assert.equal(clip.animator, null);
	assert.equal(clip.transforms.size, 4);
});

test('a prefab without the crane MonoBehaviour has no crane look', async () => {
	const look = await readCraneLook(
		resolver,
		refOf(2n) as unknown as ObjectRef,
		'tower',
		{ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
		{ ropeLength: 1, armYaw: 0, hookYaw: 0 },
	);
	assert.equal(look, null);
});
