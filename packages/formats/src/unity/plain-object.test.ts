import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toPlainObject } from './plain-object.ts';
import type { TypeTreeNode } from './serialized-file.ts';

/** builds a flattened TypeTree from `[level, type, name]` rows */
const tree = (rows: [number, string, string][]): TypeTreeNode[] =>
	rows.map(([level, type, name]) => ({
		type,
		name,
		level,
		byteSize: -1,
		typeFlags: type === 'Array' ? 1 : 0,
		metaFlag: 0,
		version: 1,
		index: 0,
		refTypeHash: 0n,
	}));

const pptr = (type: string, level: number, name: string): [number, string, string][] => [
	[level, type, name],
	[level + 1, 'int', 'm_FileID'],
	[level + 1, 'SInt64', 'm_PathID'],
];

test('converts a config section by its field types', () => {
	const nodes = tree([
		[0, 'MonoBehaviour', 'Base'],
		[1, 'string', 'm_Name'],
		[1, 'HGSkyConfig', 'skyConfig'],
		[2, 'UInt8', 'enableSunDisc'],
		[2, 'float', 'skyDistance'],
		[2, 'ColorRGBA', 'sunDiscColor'],
		[3, 'float', 'r'],
		[3, 'float', 'g'],
		[3, 'float', 'b'],
		[3, 'float', 'a'],
		[2, 'Vector2f', 'pitchYaw'],
		[3, 'float', 'x'],
		[3, 'float', 'y'],
		[2, 'SphericalHarmonicsL2', 'skyAmbientSH'],
		...Array.from({ length: 27 }, (_, i): [number, string, string] => [
			3,
			'float',
			`sh[${String(i).padStart(2)}]`,
		]),
		...pptr('PPtr<$Cubemap>', 2, 'reflectionMap'),
		...pptr('PPtr<$Cubemap>', 2, 'customIVCubemapMapForEdit'),
		...pptr('PPtr<$Material>', 2, 'drawMaterial'),
		[2, 'HGColorCurve', 'colorCurves'],
		[3, 'float', 'unused'],
		[2, 'vector', 'list'],
		[3, 'Array', 'Array'],
		[2, 'MinFloatParameter', 'intensity'],
		[3, 'UInt8', 'overrideState'],
		[3, 'float', 'm_Value'],
		[2, 'UInt8', 'm_active'],
	]);
	const value = {
		m_Name: 'Env_test',
		skyConfig: {
			enableSunDisc: 1,
			skyDistance: 3346,
			sunDiscColor: { r: 8, g: 7, b: 6, a: 1 },
			pitchYaw: { x: 45, y: 140 },
			skyAmbientSH: Object.fromEntries(
				Array.from({ length: 27 }, (_, i) => [`sh[${String(i).padStart(2)}]`, i / 10]),
			),
			reflectionMap: { m_FileID: 3, m_PathID: -279554176723162511n },
			customIVCubemapMapForEdit: { m_FileID: 2, m_PathID: 1n },
			drawMaterial: { m_FileID: 1, m_PathID: 2n },
			colorCurves: { unused: 0 },
			list: [1, 2],
			intensity: { overrideState: 1, m_Value: 0.5 },
			m_active: 0,
		},
	};

	const { value: plain, pptrs } = toPlainObject(nodes, value, {
		keepPPtr: (type, name) => type === 'PPtr<$Cubemap>' && !name.endsWith('ForEdit'),
		dropField: (name, type) => (name.startsWith('m_') && name !== 'm_Name') || type === 'HGColorCurve',
	});
	assert.deepEqual(plain, {
		m_Name: 'Env_test',
		skyConfig: {
			enableSunDisc: true,
			skyDistance: 3346,
			sunDiscColor: [8, 7, 6, 1],
			pitchYaw: [45, 140],
			skyAmbientSH: Array.from({ length: 27 }, (_, i) => i / 10),
			reflectionMap: null,
			intensity: 0.5,
		},
	});
	assert.deepEqual(pptrs, [
		{
			path: ['skyConfig', 'reflectionMap'],
			type: 'PPtr<$Cubemap>',
			pptr: { fileId: 3, pathId: -279554176723162511n },
		},
	]);
});
