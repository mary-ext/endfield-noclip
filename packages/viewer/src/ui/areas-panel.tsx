import type { Viewer } from '../viewer.ts';

import { useViewerState } from './use-viewer.ts';

/** the package's levels: fly to an overview or the spawn point, and isolate one */
export const AreasPanel = ({ viewer }: { viewer: Viewer }) => {
	useViewerState(viewer);
	const areas = viewer.areas();
	if (areas.length === 0) {
		return null;
	}
	return (
		<section className="panel areas" aria-label="areas">
			<header>
				<h2>areas</h2>
				<button type="button" onClick={() => viewer.flyToOverview()}>
					overview
				</button>
			</header>
			<ul>
				{areas.map((area) => {
					const isolated = viewer.isolated === area.id;
					return (
						<li key={area.id} className={isolated ? 'isolated' : undefined}>
							<button type="button" className="area-name" onClick={() => viewer.flyToLevel(area.id)}>
								{area.name}
								<span className="muted small">
									{area.id} · {area.cellCount} cells
								</span>
							</button>
							<button
								type="button"
								title="fly to the player spawn"
								onClick={() => viewer.flyToSpawn(area.id)}
							>
								spawn
							</button>
							<button
								type="button"
								aria-pressed={isolated}
								title="show only this area"
								onClick={() => viewer.isolate(isolated ? null : area.id)}
							>
								isolate
							</button>
						</li>
					);
				})}
			</ul>
		</section>
	);
};
