import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseMaterial } from '@endfield-noclip/formats/unity/material';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';

import { BlendFactor, classifyHgrpMaterial, shaderFamily } from './material-classify.ts';

const pair = (first: string, second: TypeTreeObject[string]): TypeTreeObject => ({ first, second });

const material = (fields: { keywords?: string[]; queue?: number; floats?: Record<string, number> }) => {
	return parseMaterial({
		m_Name: 'M_test',
		m_Shader: { m_FileID: 1, m_PathID: -42n },
		m_ValidKeywords: fields.keywords ?? [],
		m_InvalidKeywords: [],
		m_CustomRenderQueue: fields.queue ?? -1,
		m_SavedProperties: {
			m_TexEnvs: [],
			m_Floats: Object.entries(fields.floats ?? {}).map(([key, value]) => pair(key, value)),
			m_Colors: [],
		},
	});
};

const shader = (name: string, queue?: number) => ({ name, renderQueue: queue, tags: {}, properties: [] });

describe('classifyHgrpMaterial', () => {
	it('classifies opaque Lit with an MRO map', () => {
		const result = classifyHgrpMaterial(material({}), shader('HGRP/Lit', 2000));
		assert.equal(result.family, 'lit');
		assert.equal(result.blend, 'opaque');
		assert.equal(result.alphaClipThreshold, null);
		assert.equal(result.cull, 'back');
		assert.equal(result.zWrite, true);
		assert.equal(result.baseTextureMapCount, 0);
	});

	it('classifies alpha-tested two-sided foliage', () => {
		const result = classifyHgrpMaterial(
			material({
				keywords: ['_ALPHATEST_ON'],
				queue: 2450,
				floats: { _AlphaClipThreshold: 0.35, _CullMode: 0 },
			}),
			shader('HGRP/Foliage/Leaf'),
		);
		assert.equal(result.family, 'leaf');
		assert.equal(result.renderQueue, 2450);
		assert.equal(result.blend, 'alphaTest');
		assert.equal(result.alphaClipThreshold, 0.35);
		assert.equal(result.cull, 'none');
		assert.equal(result.baseTextureMapCount, null);
	});

	it('classifies blended families by their factors', () => {
		const fog = classifyHgrpMaterial(
			material({ queue: 3000, floats: { _SrcBlend: BlendFactor.One, _DstBlend: BlendFactor.One } }),
			shader('HGRP/FogSimple'),
		);
		assert.equal(fog.family, 'fogSimple');
		assert.equal(fog.blend, 'additive');
		assert.equal(fog.zWrite, false);

		const glass = classifyHgrpMaterial(
			material({
				queue: 3000,
				floats: { _SurfaceType: 1, _SrcBlend: 5, _DstBlend: 10, _BaseTextureMapCount: 1 },
			}),
			shader('HGRP/LitTransparent'),
		);
		assert.equal(glass.blend, 'alphaBlend');
		assert.deepEqual(glass.blendFactors, [5, 10]);
		assert.equal(glass.baseTextureMapCount, 1);

		const premultiplied = classifyHgrpMaterial(
			material({ floats: { _SrcBlend: 1, _DstBlend: 10 } }),
			shader('HGRP/Effect/VFXBaseV2', 3000),
		);
		assert.equal(premultiplied.family, 'vfxBase');
		assert.equal(premultiplied.renderQueue, 3000);
		assert.equal(premultiplied.blend, 'premultiplied');
	});

	it('ignores properties the shader does not declare, and falls back to its defaults', () => {
		const declares = (name: string, value: number) => ({
			name,
			type: 2,
			flags: 0,
			default: [value, 0, 0, 0] as [number, number, number, number],
			defaultTexture: '',
		});
		// a Lit material still carrying LitTransparent's blend state
		const stale = classifyHgrpMaterial(
			material({ floats: { _SurfaceType: 1, _EnableAlphaBlend: 1, _SrcBlend: 5, _DstBlend: 10 } }),
			{ ...shader('HGRP/Lit', 2000), properties: [declares('_CullMode', 2)] },
		);
		assert.equal(stale.blend, 'opaque');
		assert.equal(stale.zWrite, true);

		const defaulted = classifyHgrpMaterial(material({ floats: { _SurfaceType: 1 } }), {
			...shader('HGRP/Effect/VFXBaseV2', 3000),
			properties: [declares('_SurfaceType', 1), declares('_SrcBlend', 1), declares('_DstBlend', 10)],
		});
		assert.deepEqual(defaulted.blendFactors, [1, 10]);
	});
});

describe('shaderFamily', () => {
	it('maps shader names to families', () => {
		assert.equal(shaderFamily('HGRP/Foliage/Grass Cardmesh Lod'), 'cardMesh');
		assert.equal(shaderFamily('HGRP/Foliage/TreeFoliageCardMeshLod'), 'cardMesh');
		assert.equal(shaderFamily('HGRP/Foliage/Grass'), 'grass');
		assert.equal(shaderFamily('Hidden/VLB_Standard'), 'volumetricBeam');
		assert.equal(shaderFamily('HGRP/MattePainting'), 'mattePainting');
		assert.equal(shaderFamily('HGRP/Erosion'), 'erosion');
		assert.equal(shaderFamily('HGRP/Effect/VFXWaterDitherAlpha'), 'vfxDitherAlpha');
		assert.equal(shaderFamily('HGRP/Effect/VFXWater'), 'water');
		assert.equal(shaderFamily('HGRP/DecalErosionVolume'), 'decal');
		assert.equal(shaderFamily('Custom/Thing'), 'unknown');
	});
});
