import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	BlendFactor,
	classifyHgrpMaterial,
	parseMaterial,
	parseQueueTag,
	shaderFamily,
	summarizeShader,
} from './material.ts';
import type { TypeTreeObject } from './type-tree.ts';

const pair = (first: string, second: TypeTreeObject[string]): TypeTreeObject => ({ first, second });

const slot = (pathId: bigint, uvSet: number): TypeTreeObject => ({
	m_Texture: { m_FileID: pathId === 0n ? 0 : 2, m_PathID: pathId },
	m_Scale: { x: 2, y: 3 },
	m_Offset: { x: 0.5, y: 0 },
	m_UVSetIndex: uvSet,
});

const material = (fields: { keywords?: string[]; queue?: number; floats?: Record<string, number> }) => {
	return parseMaterial({
		m_Name: 'M_test',
		m_Shader: { m_FileID: 1, m_PathID: -42n },
		m_ValidKeywords: fields.keywords ?? [],
		m_InvalidKeywords: ['_OLD'],
		m_CustomRenderQueue: fields.queue ?? -1,
		stringTagMap: [pair('RenderType', 'Opaque')],
		disabledShaderPasses: ['ForwardOnly'],
		m_SavedProperties: {
			m_TexEnvs: [pair('_BaseColorMap', slot(7n, 1)), pair('_EmissiveMap', slot(0n, 0))],
			m_Ints: [pair('_StencilRef', 33)],
			m_Floats: Object.entries(fields.floats ?? {}).map(([key, value]) => pair(key, value)),
			m_Colors: [pair('_BaseColor', { r: 1, g: 0.5, b: 0.25, a: 1 })],
		},
	});
};

const shader = (name: string, queue?: number) => ({ name, renderQueue: queue, tags: {}, properties: [] });

describe('parseMaterial', () => {
	it('copies the serialized properties', () => {
		const record = material({ keywords: ['_TWO_BASEMAP'], queue: 2450, floats: { _CullMode: 0 } });
		assert.equal(record.name, 'M_test');
		assert.deepEqual(record.shader, { fileId: 1, pathId: -42n });
		assert.deepEqual(record.keywords, ['_TWO_BASEMAP']);
		assert.deepEqual(record.invalidKeywords, ['_OLD']);
		assert.equal(record.customRenderQueue, 2450);
		assert.deepEqual(record.tags, { RenderType: 'Opaque' });
		assert.deepEqual(record.disabledPasses, ['ForwardOnly']);
		assert.deepEqual(record.textures['_BaseColorMap'], {
			texture: { fileId: 2, pathId: 7n },
			scale: [2, 3],
			offset: [0.5, 0],
			uvSet: 1,
		});
		assert.equal(record.textures['_EmissiveMap'].texture, null);
		assert.deepEqual(record.floats, { _CullMode: 0 });
		assert.deepEqual(record.colors, { _BaseColor: [1, 0.5, 0.25, 1] });
		assert.deepEqual(record.ints, { _StencilRef: 33 });
	});
});

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
});

describe('shader helpers', () => {
	it('maps shader names to families', () => {
		assert.equal(shaderFamily('HGRP/Foliage/Grass Cardmesh Lod'), 'cardMesh');
		assert.equal(shaderFamily('HGRP/Foliage/TreeFoliageCardMeshLod'), 'cardMesh');
		assert.equal(shaderFamily('HGRP/Foliage/Grass'), 'grass');
		assert.equal(shaderFamily('Hidden/VLB_Standard'), 'volumetricBeam');
		assert.equal(shaderFamily('HGRP/MattePainting'), 'mattePainting');
		assert.equal(shaderFamily('HGRP/Erosion'), 'erosion');
		assert.equal(shaderFamily('HGRP/DecalErosionVolume'), 'decal');
		assert.equal(shaderFamily('Custom/Thing'), 'unknown');
	});

	it('parses queue tags', () => {
		assert.equal(parseQueueTag('Transparent+1'), 3001);
		assert.equal(parseQueueTag('Geometry-10'), 1990);
		assert.equal(parseQueueTag('AlphaTest'), 2450);
		assert.equal(parseQueueTag('2600'), 2600);
		assert.equal(parseQueueTag('Nowhere'), undefined);
	});

	it('summarizes a parsed shader form', () => {
		const summary = summarizeShader({
			m_PropInfo: {
				m_Props: [
					{
						m_Name: '_NormalMap',
						m_Description: 'Normal',
						m_Attributes: ['Normal'],
						m_Type: 4,
						m_Flags: 8,
						'm_DefValue[0]': 0,
						'm_DefValue[1]': 0,
						'm_DefValue[2]': 0,
						'm_DefValue[3]': 0,
						m_DefTexture: { m_DefaultName: 'bump', m_TexDim: 2 },
					},
				],
			},
			m_SubShaders: [
				{ m_Passes: [], m_Tags: { tags: [pair('Queue', 'AlphaTest+5'), pair('RenderType', 'X')] } },
			],
			m_Name: 'HGRP/Lit',
		});
		assert.deepEqual(summary, {
			name: 'HGRP/Lit',
			renderQueue: 2455,
			tags: { Queue: 'AlphaTest+5', RenderType: 'X' },
			properties: [{ name: '_NormalMap', type: 4, flags: 8, default: [0, 0, 0, 0], defaultTexture: 'bump' }],
		});
	});
});
