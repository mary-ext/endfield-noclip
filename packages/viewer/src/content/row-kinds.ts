import type { ContentRef } from '@endfield-noclip/package-format/tree';

import type { TileTree } from '../scene/tile-tree.ts';

import { RowKind, type RowKinds, type TierSpan } from './instance-rows.ts';

/**
 * @param tree the linked tree
 * @param global the tree's global refs
 * @returns what the rows of each instance blob are: rows of HLOD blocks take their tier from the refs that
 *   slice them
 */
export const instanceRowKinds = (tree: TileTree, global: readonly ContentRef[]): Map<number, RowKinds> => {
	const kinds = new Map<number, RowKinds>();
	const spans = new Map<number, TierSpan[]>();
	for (const node of tree.nodes) {
		for (const ref of node.hlod) {
			const list = spans.getOrInsertComputed(ref.blob, () => {
				const created: TierSpan[] = [];
				kinds.set(ref.blob, created);
				return created;
			});
			list.push({ first: ref.first, count: ref.count, tier: ref.tier });
		}
		for (const ref of [...node.detail, ...node.conditional]) {
			kinds.set(ref.blob, RowKind.Detail);
		}
	}
	for (const ref of global) {
		kinds.set(ref.blob, RowKind.Global);
	}
	return kinds;
};
