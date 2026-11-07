import type { ReactNode } from 'react';

import type { LevelGroup } from '../../scene-states/listing.ts';
import { levelName } from '../format.ts';
import { LazyDetails } from '../lazy-details.tsx';

/**
 * a panel section's entries for levels other than the camera's, one collapsed group per level
 *
 * @param props.groups the entries by level, from `groupByLevel`
 * @param props.render draws one level's entries, given the level's index
 */
export const OtherLevels = <T,>({
	groups,
	render,
}: {
	groups: readonly LevelGroup<T>[];
	render: (entries: readonly T[], level: number) => ReactNode;
}) => {
	if (groups.length === 0) {
		return null;
	}
	return (
		<section className="other-levels">
			<h3>Other levels</h3>
			{groups.map(({ level, index, entries }) => (
				<LazyDetails
					key={level.id}
					summary={
						<summary>
							{levelName(level)} ({entries.length})
						</summary>
					}
				>
					{() => render(entries, index)}
				</LazyDetails>
			))}
		</section>
	);
};
