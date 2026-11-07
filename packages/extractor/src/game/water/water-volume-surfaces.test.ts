import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readWaterSurfaceSettings, volumeSurfacePrefab } from './water-volume-surfaces.ts';

describe('volumeSurfacePrefab', () => {
	// map02's WaterVolumeManagerConfig, trimmed: acid 0, plant 2, sewage 3, water 4 (the fallback), and Plant2
	// (13) borrowing plant's surface
	const pptr = (fileId: number, pathId: bigint) => ({ m_FileID: fileId, m_PathID: pathId });
	const setting = (fileId: number, pathId: bigint) => ({ surfacePrefab: pptr(fileId, pathId) });
	const settings = readWaterSurfaceSettings({
		waterSurfaceMissingFallback: pptr(2, 5557907107807535942n),
		waterSurfaceSettingDict: {
			_keyData: [4, 3, 2, 0, 7],
			_valueData: [
				setting(2, 5557907107807535942n),
				setting(3, 6920472490029536733n),
				setting(5, -1580087855884082448n),
				setting(7, -9025014995019472712n),
				setting(9, 0n),
			],
		},
		waterTypeToSurfaceDict: { _keyData: [13], _valueData: [2] },
	});

	it('picks the surface listed for the water type', () => {
		assert.deepEqual(volumeSurfacePrefab(settings, 0), { fileId: 7, pathId: -9025014995019472712n });
		assert.deepEqual(volumeSurfacePrefab(settings, 3), { fileId: 3, pathId: 6920472490029536733n });
	});

	it('remaps a type before looking it up', () => {
		assert.deepEqual(volumeSurfacePrefab(settings, 13), { fileId: 5, pathId: -1580087855884082448n });
	});

	it('falls back for an unlisted type or a null entry', () => {
		const fallback = { fileId: 2, pathId: 5557907107807535942n };
		assert.deepEqual(volumeSurfacePrefab(settings, 11), fallback);
		assert.deepEqual(volumeSurfacePrefab(settings, 7), fallback);
	});

	it('rejects mismatched dictionary arrays', () => {
		assert.throws(
			() =>
				readWaterSurfaceSettings({
					waterSurfaceMissingFallback: pptr(0, 0n),
					waterSurfaceSettingDict: { _keyData: [0, 1], _valueData: [setting(0, 1n)] },
					waterTypeToSurfaceDict: { _keyData: [], _valueData: [] },
				}),
			/2 keys and 1 values/,
		);
	});
});
