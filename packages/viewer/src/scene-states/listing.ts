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

import { type EnvironmentScene, volumeLevel } from '../environment/blend.ts';

/** entries listed under one of the other levels */
export interface LevelGroup<T> {
	level: LevelInfo;
	/** the level's index into the package's levels */
	index: number;
	entries: T[];
}

/**
 * @param entries what isn't listed for the current level
 * @param levels the package's levels
 * @param here the current level's index, which gets no group
 * @param levelsOf the indices of the levels an entry belongs to
 * @returns per other level in package order, the entries belonging to it, skipping levels with none; an entry
 *   of several levels is in each of their groups
 */
export const groupByLevel = <T>(
	entries: readonly T[],
	levels: readonly LevelInfo[],
	here: number | null,
	levelsOf: (entry: T) => readonly number[],
): LevelGroup<T>[] =>
	levels.flatMap((level, index) => {
		if (index === here) {
			return [];
		}
		const listed = entries.filter((entry) => levelsOf(entry).includes(index));
		return listed.length === 0 ? [] : [{ level, index, entries: listed }];
	});

/** a scene control with its index into the package's controls, which scene values are keyed by */
export interface ListedControl {
	index: number;
	control: SceneControl;
}

const listedCache = new WeakMap<StatesInfo, readonly ListedControl[]>();

/**
 * @param states a package's controls
 * @returns every control with its index, in package order
 */
export const listedControls = (states: StatesInfo): readonly ListedControl[] =>
	listedCache.getOrInsertComputed(states, () =>
		states.controls.map((control, index) => ({ index, control })),
	);

/**
 * @param control a scene control
 * @param level the current level's index, or `null` for none
 * @returns whether the control gates the level's content. every control is listed without a level
 */
export const controlListedFor = (control: SceneControl, level: number | null): boolean =>
	level === null || control.levels.includes(level);

const followerCache = new WeakMap<StatesInfo, Map<number, number[]>>();

/**
 * @param states a package's controls
 * @returns by control index, the indices of the derived controls that read it, in package order: what follows
 *   it
 */
export const followersOf = (states: StatesInfo): ReadonlyMap<number, readonly number[]> =>
	followerCache.getOrInsertComputed(states, () => {
		const followers = new Map<number, number[]>();
		for (const [index, control] of states.controls.entries()) {
			if (control.source.kind !== 'derived') {
				continue;
			}
			const inputs = new Set(
				states.conditionalSets[control.source.condition]?.alternatives.flatMap((requirements) =>
					requirements.map(({ control: input }) => input),
				),
			);
			for (const input of inputs) {
				followers.getOrInsertComputed(input, () => []).push(index);
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
 * @param entries listed controls
 * @param eye the camera's position, in Unity coordinates
 * @returns the entries with a place within {@link NEARBY_RADIUS} of the eye, nearest first
 */
export const controlsNear = (entries: readonly ListedControl[], eye: Readonly<Vec3>): ListedControl[] =>
	entries
		.flatMap((entry) => {
			const { place } = entry.control;
			const distance = place === null ? Infinity : placeDistance(place, eye);
			return distance <= NEARBY_RADIUS ? [{ entry, distance }] : [];
		})
		.toSorted((a, b) => a.distance - b.distance)
		.map(({ entry }) => entry);

/** an environment volume listed for a level */
export interface ListedVolume {
	/** index into the environment table's volumes */
	id: number;
	volume: EnvironmentVolumeInfo;
	/** the index of the level owning the volume's group, or `null` for scene-wide volumes */
	owner: number | null;
}

/**
 * volumes apply wherever they hold the camera, so a neighbour's volume reaching into the level is listed with
 * the level's own and the scene-wide ones
 *
 * @param scene the package's environment table and manifest
 * @param level the current level's index, or `null` for none (then only scene-wide volumes are listed)
 * @returns the package's environment volumes listed for the level, in order
 */
export const volumesForLevel = (scene: EnvironmentScene, level: number | null): ListedVolume[] => {
	const rect = level === null ? null : (scene.manifest.levels[level]?.rect ?? null);
	return scene.environment.volumes.flatMap((volume, id) => {
		const owner = volumeLevel(scene.manifest, volume);
		const listed = owner === null || owner === level || (rect !== null && volumeReaches(volume.shape, rect));
		return listed ? [{ id, volume, owner }] : [];
	});
};
