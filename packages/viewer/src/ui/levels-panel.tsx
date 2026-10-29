import type { Viewer } from '../viewer.ts';

import { useViewerState } from './use-viewer.ts';

/** the package's levels: pick the one to show, or fly back over it */
export const LevelsPanel = ({ viewer }: { viewer: Viewer }) => {
	useViewerState(viewer);
	const levels = viewer.levels();
	if (levels.length === 0) {
		return null;
	}
	return (
		<section className="panel levels" aria-label="levels">
			<header>
				<h2>levels</h2>
			</header>
			<ul>
				{levels.map((level) => {
					const shown = viewer.level === level.id;
					return (
						<li key={level.id}>
							<button
								type="button"
								className="entry-name"
								title={shown ? 'fly back over this level' : 'show this level'}
								aria-pressed={shown}
								disabled={level.instances === 0}
								onClick={() => (shown ? viewer.flyToLevel(level.id) : viewer.showLevel(level.id))}
							>
								{level.name}
								<span className="muted small">
									{level.id} · {level.instances.toLocaleString()} instances
								</span>
							</button>
						</li>
					);
				})}
			</ul>
		</section>
	);
};
