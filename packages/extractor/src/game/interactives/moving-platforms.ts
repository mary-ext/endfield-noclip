import type { LevelInteractive } from '@endfield-noclip/formats/endfield/level-interactives';
import type { LevelSpline } from '@endfield-noclip/formats/endfield/level-splines';
import type { MemoryPackValue } from '@endfield-noclip/formats/endfield/memory-pack';

import type { PrefabPose } from '../prefabs/prefab.ts';

import { type CurveMove, curveMoveOf, curvePath } from './curve-move.ts';
import type { FacilitySources } from './facility-sources.ts';
import type { SingleModelTemplate, TemplateReader } from './interactive-row.ts';
import type { LevelDataExtras } from './placed-interactives.ts';
import { type StartState, stateOf } from './template-data.ts';
import type { TemplateTraits } from './template-traits.ts';

/** the spline an auto-moving platform rides, and how */
export interface Ride {
	spline: LevelSpline;
	move: CurveMove;
}

/** auto-moving platforms, which ride their spline from the start when their level starts them moving */
export class MovingPlatforms implements TemplateReader {
	readonly #sources: FacilitySources;
	readonly #extras: LevelDataExtras;
	/** auto-moving platforms' decoded templates and starting `state`, by key */
	readonly #platforms = new Map<string, { template: MemoryPackValue; start: StartState | null }>();

	/**
	 * @param sources where a missing spline is reported
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
	 * @param row a placed interactive
	 * @param levelId its level
	 * @returns the spline an auto-moving platform rides and how, when it starts moving with its level (its
	 *   `state` is 1 and it names a spline); otherwise `null`
	 */
	async rideOf(row: LevelInteractive, levelId: string): Promise<Ride | null> {
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
		return { spline, move };
	}
}

/**
 * @param ride the spline a platform rides
 * @param placement the platform's placement matrix
 * @param pose its look's pose, `null` as saved
 * @param source the row, keying the path
 * @returns the look's pose with the prefab root following the path, or why it can't be followed
 */
export const ridePose = (
	ride: Ride,
	placement: Float32Array,
	pose: PrefabPose | null,
	source: string,
): PrefabPose | { reason: string } => {
	const moving = curvePath(ride.spline, ride.move, placement);
	if ('reason' in moving) {
		return moving;
	}
	return {
		key: `${pose?.key ?? ''} path:${source}`,
		clips: pose?.clips ?? [],
		active: pose?.active ?? new Map(),
		path: moving.path,
	};
};
