import type { MemoryPackValue } from '@endfield-noclip/formats/endfield/memory-pack';
import type { RowPath } from '@endfield-noclip/package-format/instances';

import { curveMoveOf, curvePath } from './curve-move.ts';
import type { FacilitySources } from './facility-sources.ts';
import type { SingleModelTemplate, TemplateReader } from './interactive-row.ts';
import type { LevelDataExtras, PlacedInteractive } from './placed-interactives.ts';
import { type StartState, stateOf } from './template-data.ts';
import type { TemplateTraits } from './template-traits.ts';

/** auto-moving platforms, which ride their spline from the start when their level starts them moving */
export class MovingPlatforms implements TemplateReader {
	readonly #sources: FacilitySources;
	readonly #extras: LevelDataExtras;
	/** auto-moving platforms' decoded templates and starting `state`, by key */
	readonly #platforms = new Map<string, { template: MemoryPackValue; start: StartState | null }>();

	/**
	 * @param sources where a missing spline or a move that can't be drawn is reported
	 * @param extras the levels' splines
	 */
	constructor(sources: FacilitySources, extras: LevelDataExtras) {
		this.#sources = sources;
		this.#extras = extras;
	}

	prepare(key: string, _template: SingleModelTemplate, traits: TemplateTraits): void {
		if (traits.kind === 'other' && traits.autoMove !== null) {
			this.#platforms.set(key, { template: traits.autoMove, start: traits.start });
		}
	}

	/**
	 * @param placed a placed interactive
	 * @returns the path an auto-moving platform loops through, as offsets from its placement, when it starts
	 *   moving with its level (its `state` is 1 and it names a spline); `null` for one that stays put, or whose
	 *   move can't be drawn, which is reported
	 */
	async rideOf({ path, levelId, row }: PlacedInteractive): Promise<RowPath | null> {
		const platform = this.#platforms.get(row.template);
		if (platform === undefined) {
			return null;
		}
		const state = stateOf(row) ?? platform.start?.variants.get(row.template) ?? platform.start?.state ?? 0;
		const move = curveMoveOf(platform.template, row);
		if (state !== 1 || move === null || move.splineId === 0) {
			return null;
		}
		const spline = (await this.#extras.splinesOf(levelId)).get(move.splineId);
		if (spline === undefined) {
			this.#sources.report(levelId, `spline ${move.splineId} of ${row.template} not found`);
			return null;
		}
		const moving = curvePath(spline, move, row.position);
		if ('reason' in moving) {
			this.#sources.report(`${path}#${row.id}`, moving.reason);
			return null;
		}
		return moving.path;
	}
}
