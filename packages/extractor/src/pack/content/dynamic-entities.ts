import { transformBounds } from '@endfield-noclip/formats/unity/transform';

import type { DynamicStructures } from '../../game/dynamic-structures.ts';

import { decalPlacement, type PackContent, UNIT_CUBE_BOUNDS } from './pack-content.ts';
import { decalSkipReason } from './static-chunks.ts';

/**
 * files the ECS entities and lights of the scene's dynamic structures; entities the chunk files hold keep
 * their files' gating
 *
 * @param content the pack's content, after the chunk files; rows, lights and skipped entities are added
 * @param dynamic the scene's dynamic structures
 */
export const placeDynamicEntities = (
	content: PackContent,
	{ lights, entities }: Pick<DynamicStructures, 'lights' | 'entities'>,
): void => {
	const { seen } = content;
	const { subset } = content.scene;
	for (const { light, visibility } of lights) {
		content.addLight(light, visibility);
	}
	for (const { entity, decalMaterial, visibility, grid: loadGrid } of entities) {
		if (seen.has(entity.id)) {
			continue;
		}
		seen.add(entity.id);
		const owner = { tag: entity.levelTag, name: entity.name, visibility, loadGrid };
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
				chain: content.chains.intern(entity.renderer.draws.map((draw) => content.rendererDraw(draw))),
				matrix: entity.matrix,
				bounds: entity.bounds,
				entityId: entity.id,
				spin: entity.rotator ?? undefined,
			},
			owner,
		);
	}
};
