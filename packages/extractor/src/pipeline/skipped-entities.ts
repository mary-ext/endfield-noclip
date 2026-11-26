/**
 * the tally behind `debug/skipped-entities.json`: chunk and dynamic entities the packer leaves out, grouped
 * by why and by their component set, since component ids are the only hint of what an entity is
 *
 * @module
 */

import { compareNumbers } from '../util/compare.ts';

/** entities left out for one reason, sharing one component set */
export interface SkippedEntityRow {
	/** `static` for InitChunkData entities, `dynamic` for DynamicStreaming ones */
	source: 'static' | 'dynamic';
	reason: string;
	/** the entities' component ids, ascending */
	components: number[];
	count: number;
	/** the first few entities' names */
	examples: string[];
}

/** how many names a row keeps */
const EXAMPLES = 3;

/** collects skipped entities into {@link SkippedEntityRow}s */
export class SkippedEntities {
	readonly #rows = new Map<string, SkippedEntityRow>();

	/**
	 * @param source where the entity comes from
	 * @param reason why it's left out
	 * @param entity its name and component ids
	 */
	add(
		source: SkippedEntityRow['source'],
		reason: string,
		entity: { name: string; components: readonly number[] },
	): void {
		const components = entity.components.toSorted(compareNumbers);
		const row = this.#rows.getOrInsertComputed(`${source}/${reason}/${components.join(',')}`, () => ({
			source,
			reason,
			components,
			count: 0,
			examples: [],
		}));
		row.count++;
		if (row.examples.length < EXAMPLES) {
			row.examples.push(entity.name);
		}
	}

	/** merges previously tallied rows into this collector */
	merge(rows: readonly SkippedEntityRow[]): void {
		for (const incoming of rows) {
			const components = incoming.components.toSorted(compareNumbers);
			const row = this.#rows.getOrInsertComputed(
				`${incoming.source}/${incoming.reason}/${components.join(',')}`,
				() => ({
					source: incoming.source,
					reason: incoming.reason,
					components,
					count: 0,
					examples: [],
				}),
			);
			row.count += incoming.count;
			for (const name of incoming.examples) {
				if (row.examples.length < EXAMPLES) {
					row.examples.push(name);
				}
			}
		}
	}

	/** @returns the rows, largest first */
	rows(): SkippedEntityRow[] {
		const rows = [...this.#rows.values()];
		rows.sort((a, b) => b.count - a.count);
		return rows;
	}
}
