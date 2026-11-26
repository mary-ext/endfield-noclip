import { transformBounds } from '@endfield-noclip/formats/unity/transform';
import type { Aabb } from '@endfield-noclip/formats/unity/values';

import { gridIdReach } from '../../game/dynamic/dynamic-grids.ts';
import type { DynamicStructures } from '../../game/dynamic/dynamic-structures.ts';
import { chunkEntityPlacement } from '../instances/chains.ts';

import { decalPlacement, type PackContent, UNIT_CUBE_BOUNDS } from './pack-content.ts';
import { decalSkipReason } from './static-chunks.ts';

const SLUDGE_UNIT_BOUNDS: Aabb = { center: [0.5, 0.5, 0.5], extents: [0.5, 0.5, 0.5] };

/**
 * files the ECS entities, lights and sludge patches of the scene's dynamic structures; entities the chunk
 * files hold keep their files' gating
 *
 * @param content the pack's content, after the chunk files; rows, lights and skipped entities are added
 * @param dynamic the scene's dynamic structures
 */
export const placeDynamicEntities = (
	content: PackContent,
	{ lights, entities, sludges }: Pick<DynamicStructures, 'lights' | 'entities' | 'sludges'>,
): void => {
	const { seen } = content;
	const { subset } = content.scene;
	for (const { light, visibility } of lights) {
		content.addLight(light, visibility);
	}
	for (const { patch, tag, visibility, grid } of sludges) {
		const { origin, right, up, forward, sludgeSize, sizeY } = patch;
		// maps unit [0, 1]³ local space to world: origin + right * (u * size) + up * (h * sizeY) + forward * (v * size)
		const matrix = new Float32Array([
			right[0] * sludgeSize,
			right[1] * sludgeSize,
			right[2] * sludgeSize,
			0,
			up[0] * sizeY,
			up[1] * sizeY,
			up[2] * sizeY,
			0,
			forward[0] * sludgeSize,
			forward[1] * sludgeSize,
			forward[2] * sludgeSize,
			0,
			origin[0],
			origin[1],
			origin[2],
			1,
		]);
		const bounds = transformBounds(SLUDGE_UNIT_BOUNDS, matrix);
		if (!subset.includesPoint(tag, bounds.center)) {
			continue;
		}
		content.count('sludgePatches');
		content.addStructure(
			{
				chain: content.chains.intern([content.sludgeDraw(patch)]),
				matrix,
				bounds,
				entityId: content.nextSyntheticId(tag),
			},
			{
				tag,
				name: `sludge:${patch.id}`,
				visibility,
				loadReach: gridIdReach(grid),
			},
		);
	}
	for (const { entity, decalMaterial, visibility, grid } of entities) {
		if (seen.has(entity.id)) {
			continue;
		}
		seen.add(entity.id);
		const owner = { tag: entity.levelTag, name: entity.name, visibility, loadReach: gridIdReach(grid) };
		if (entity.matrix === null) {
			content.skipped.add('dynamic', 'no matrix', entity);
			continue;
		}
		if (entity.decal !== null) {
			const draw = decalMaterial === null ? null : content.decalDraw(decalMaterial);
			if (draw === null) {
				content.count('decalSkipped');
				content.skipped.add('dynamic', decalSkipReason(decalMaterial), entity);
				continue;
			}
			// the decal cube maps the unit cube, so its matrix gives the bounds when the entity has none
			const bounds = entity.bounds ?? transformBounds(UNIT_CUBE_BOUNDS, entity.matrix);
			if (!subset.includesPoint(entity.levelTag, bounds.center)) {
				continue;
			}
			content.count('decal');
			content.addStructure(
				{
					chain: content.chains.intern([draw]),
					matrix: entity.matrix,
					bounds,
					entityId: entity.id,
					decalPlacement: decalPlacement(entity.decal),
					spin: entity.rotator ?? undefined,
				},
				owner,
			);
			continue;
		}
		if (entity.renderer === null || entity.bounds === null) {
			content.skipped.add('dynamic', entity.renderer === null ? 'no renderer' : 'no bounds', entity);
			continue;
		}
		if (!subset.includesPoint(entity.levelTag, entity.bounds.center)) {
			continue;
		}
		content.addStructure(
			{
				chain: content.chains.intern(
					entity.renderer.draws.map((draw) => content.rendererDraw(draw)),
					chunkEntityPlacement({ ...entity, matrix: entity.matrix }),
				),
				matrix: entity.matrix,
				bounds: entity.bounds,
				entityId: entity.id,
				spin: entity.rotator ?? undefined,
			},
			owner,
		);
	}
};
