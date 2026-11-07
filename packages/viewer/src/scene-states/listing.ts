/**
 * which scene controls and environment volumes the viewer lists for the current level, and how it groups the
 * rest by level (see docs/viewer/scene-states.md "the scene conditions panel").
 *
 * @module
 */

import type { EnvironmentVolumeInfo } from '@endfield-noclip/package-format/environment';
import { volumeReaches } from '@endfield-noclip/package-format/environment-volumes';
import type { LevelInfo } from '@endfield-noclip/package-format/manifest';
import type { ControlPlace, SceneControl, StatesInfo } from '@endfield-noclip/package-format/states';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import { type EnvironmentScene, volumeLevelTag } from '../environment/blend.ts';

/** entries listed under one of the other levels */
export interface LevelGroup<T> {
	level: LevelInfo;
	entries: T[];
}

/**
 * @param entries what isn't listed for the current level
 * @param levels the package's levels
 * @param here the current level, which gets no group
 * @param tags the level tags an entry belongs to
 * @returns per other level in package order, the entries with its tag, skipping levels with none; an entry of
 *   several levels is in each of their groups
 */
export const groupByLevel = <T>(
	entries: readonly T[],
	levels: readonly LevelInfo[],
	here: LevelInfo | null,
	tags: (entry: T) => readonly number[],
): LevelGroup<T>[] =>
	levels.flatMap((level) => {
		if (level === here) {
			return [];
		}
		const listed = entries.filter((entry) => tags(entry).includes(level.tag));
		return listed.length === 0 ? [] : [{ level, entries: listed }];
	});

/**
 * @param control a scene control
 * @param level the current level, or `null` for none
 * @returns whether the control gates the level's content: its level tags include 0 or the level's tag. every
 *   control is listed without a level
 */
export const controlListedFor = (control: SceneControl, level: LevelInfo | null): boolean =>
	level === null || control.levelTags.includes(0) || control.levelTags.includes(level.tag);

/**
 * @param controls scene controls
 * @param level the current level, or `null` for none
 * @returns the controls {@link controlListedFor} the level, in order
 */
export const controlsForLevel = <T extends SceneControl>(
	controls: readonly T[],
	level: LevelInfo | null,
): T[] => controls.filter((control) => controlListedFor(control, level));

const followerCache = new WeakMap<StatesInfo, Map<string, SceneControl[]>>();

/**
 * @param states a package's controls
 * @returns by control id, the derived controls that read it, in package order: what follows it
 */
export const followersOf = (states: StatesInfo): ReadonlyMap<string, readonly SceneControl[]> =>
	followerCache.getOrInsertComputed(states, () => {
		const followers = new Map<string, SceneControl[]>();
		for (const control of states.controls) {
			if (control.source.kind !== 'derived') {
				continue;
			}
			const inputs = new Set(
				states.conditionalSets[control.source.condition]?.alternatives.flatMap((requirements) =>
					requirements.map(({ control: input }) => input),
				),
			);
			for (const input of inputs) {
				followers.getOrInsertComputed(input, () => []).push(control);
			}
		}
		return followers;
	});

/** how far from the camera a control's content still counts as nearby, in metres */
export const NEARBY_RADIUS = 200;

/**
 * @param place where a control's content is
 * @param eye the camera's position, in Unity coordinates
 * @returns the distance from the eye to the box around the content (0 inside it), else to its position
 */
export const placeDistance = (place: ControlPlace, eye: Readonly<Vec3>): number => {
	if (place.bounds === null) {
		return Math.hypot(...place.position.map((value, axis) => value - eye[axis]));
	}
	const { min, max } = place.bounds;
	return Math.hypot(...eye.map((value, axis) => Math.max(min[axis] - value, 0, value - max[axis])));
};

/**
 * @param controls scene controls
 * @param eye the camera's position, in Unity coordinates
 * @returns the controls with a place within {@link NEARBY_RADIUS} of the eye, nearest first
 */
export const controlsNear = <T extends SceneControl>(controls: readonly T[], eye: Readonly<Vec3>): T[] =>
	controls
		.flatMap((control) => {
			const distance = control.place === null ? Infinity : placeDistance(control.place, eye);
			return distance <= NEARBY_RADIUS ? [{ control, distance }] : [];
		})
		.toSorted((a, b) => a.distance - b.distance)
		.map(({ control }) => control);

/** an environment volume listed for a level */
export interface ListedVolume {
	/** index into the environment table's volumes */
	id: number;
	volume: EnvironmentVolumeInfo;
	/** the level tag of the volume's group; 0 for scene-wide volumes */
	owner: number;
}

/**
 * volumes apply wherever they hold the camera, so a neighbour's volume reaching into the level is listed with
 * the level's own and the scene-wide ones
 *
 * @param scene the package's environment table and manifest
 * @param level the current level, or `null` for none (then only scene-wide volumes are listed)
 * @returns the package's environment volumes listed for the level, in order
 */
export const volumesForLevel = (scene: EnvironmentScene, level: LevelInfo | null): ListedVolume[] =>
	scene.environment.volumes.flatMap((volume, id) => {
		const owner = volumeLevelTag(scene.manifest, volume);
		const listed =
			owner === 0 || (level !== null && (owner === level.tag || volumeReaches(volume.shape, level.rect)));
		return listed ? [{ id, volume, owner }] : [];
	});
