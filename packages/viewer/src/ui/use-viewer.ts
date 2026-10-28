import { useSyncExternalStore } from 'react';

import type { Viewer } from '../viewer.ts';

/**
 * re-renders the caller when the package, the options or the shown level change.
 *
 * @param viewer the viewer
 * @returns the viewer's state revision (only useful as a dependency)
 */
export const useViewerState = (viewer: Viewer): number => {
	return useSyncExternalStore(
		(listener) => viewer.subscribe(listener),
		() => viewer.stateRevision,
	);
};

/**
 * re-renders the caller when the viewer's stats change.
 *
 * @param viewer the viewer
 * @returns the viewer's stats revision (only useful as a dependency)
 */
export const useViewerStats = (viewer: Viewer): number => {
	return useSyncExternalStore(
		(listener) => viewer.subscribe(listener),
		() => viewer.statsRevision,
	);
};
