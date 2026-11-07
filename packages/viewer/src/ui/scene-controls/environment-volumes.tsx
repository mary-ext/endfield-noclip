import type { EnvironmentVolumeInfo } from '@endfield-noclip/package-format/environment';
import type { LevelInfo } from '@endfield-noclip/package-format/manifest';

import { mapDefined, unique } from '@mary-ext/array-fns';

import { type EnvironmentScene, volumeCondition, volumeLevelTag } from '../../environment/blend.ts';
import { type ListedVolume, groupByLevel, volumesForLevel } from '../../scene-states/listing.ts';
import type { Viewer } from '../../viewer/viewer.ts';
import { SceneToggle } from '../controls.tsx';
import { LazyDetails } from '../lazy-details.tsx';

import { OtherLevels } from './other-levels.tsx';

/** @returns how an environment volume applies when its checkbox is on, in words */
const blendText = (volume: EnvironmentVolumeInfo): string => {
	if (volume.control === null) {
		return 'Phase unavailable';
	}
	if (volume.blend.kind === 'scripted') {
		return 'Scripted blend · preview at full strength';
	}
	return `Priority ${volume.priority}`;
};

/**
 * the "Lighting / environment volumes" section: a checkbox per volume over its `environmentVolume` control,
 * those listed for the current level first, then the rest by owning level
 *
 * @param props.scene the loaded package's environment table and manifest
 * @param props.level the current level, or `null` for none
 * @param props.matches the panel's filter
 */
export const EnvironmentVolumes = ({
	viewer,
	scene,
	level,
	matches,
}: {
	viewer: Viewer;
	scene: EnvironmentScene;
	level: LevelInfo | null;
	matches: (text: string) => boolean;
}) => {
	const { manifest } = scene;
	const volumes = volumesForLevel(scene, level).filter(({ volume }) => matches(volume.name));
	const listedHere = new Set(volumes.map(({ id }) => id));
	const others = groupByLevel(
		scene.environment.volumes.flatMap((volume, id) =>
			listedHere.has(id) || !matches(volume.name)
				? []
				: [{ id, volume, owner: volumeLevelTag(manifest, volume) }],
		),
		manifest.levels,
		level,
		({ owner }) => [owner],
	);
	// a volume has one owner, so it's in one group
	const elsewhere = others.reduce((count, { entries }) => count + entries.length, 0);
	const levelNames = new Map(manifest.levels.map((entry) => [entry.tag, entry.name ?? entry.id]));
	const controlNames = new Map(manifest.states.controls.map((entry) => [entry.id, entry.name]));
	/** @returns the controls a volume loads with besides its own switch, by name */
	const loadingStates = (condition: number, own: string | null): string =>
		unique(
			manifest.states.conditionalSets[condition].alternatives.flatMap((requirements) =>
				mapDefined(requirements, ({ control }) =>
					control === own ? undefined : (controlNames.get(control) ?? control),
				),
			),
		).join(' or ');
	/** @param shown the level the entries are listed under, whose own volumes don't name it */
	const toggles = (entries: readonly ListedVolume[], shown: LevelInfo | null) =>
		entries.map(({ volume, id, owner }) => {
			const { control } = volume;
			const condition = volumeCondition(manifest, volume);
			const states = condition === null ? '' : loadingStates(condition, control);
			return (
				<SceneToggle
					key={id}
					label={volume.name}
					detail={
						<>
							{blendText(volume)}
							{states !== '' && ` · with ${states}`}
							{condition !== null &&
								control !== null &&
								viewer.sceneValues[control] === 1 &&
								!viewer.conditionResults[condition] &&
								' (not loaded)'}
							{owner !== 0 && owner !== shown?.tag && ` · from ${levelNames.get(owner) ?? `level ${owner}`}`}
						</>
					}
					disabled={control === null}
					checked={control !== null && viewer.sceneValues[control] === 1}
					onChange={(checked) => {
						if (control !== null) {
							viewer.setSceneValue(control, Number(checked));
						}
					}}
				/>
			);
		});
	return (
		<LazyDetails
			summary={
				<summary>
					Lighting / environment volumes ({volumes.length}
					{others.length > 0 && ` here · ${listedHere.size + elsewhere} in all`})
				</summary>
			}
		>
			{() => (
				<>
					<p className="muted small">A pinned phase overrides these.</p>
					{toggles(volumes, level)}
					<OtherLevels groups={others} render={toggles} />
				</>
			)}
		</LazyDetails>
	);
};
