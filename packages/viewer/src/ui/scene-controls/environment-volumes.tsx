import type { EnvironmentVolumeInfo } from '@endfield-noclip/package-format/environment';

import { mapDefined, unique } from '@mary-ext/array-fns';

import { type EnvironmentScene, volumeCondition, volumeLevel } from '../../environment/blend.ts';
import { type ListedVolume, groupByLevel, volumesForLevel } from '../../scene-states/listing.ts';
import type { Viewer } from '../../viewer/viewer.ts';
import { SceneToggle } from '../controls.tsx';
import { levelName } from '../format.ts';
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
 * @param props.level the current level's index, or `null` for none
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
	level: number | null;
	matches: (text: string) => boolean;
}) => {
	const { manifest } = scene;
	const volumes = volumesForLevel(scene, level).filter(({ volume }) => matches(volume.name));
	const listedHere = new Set(volumes.map(({ id }) => id));
	const others = groupByLevel(
		scene.environment.volumes.flatMap((volume, id) =>
			listedHere.has(id) || !matches(volume.name)
				? []
				: [{ id, volume, owner: volumeLevel(manifest, volume) }],
		),
		manifest.levels,
		level,
		({ owner }) => (owner === null ? [] : [owner]),
	);
	// a volume has one owner, so it's in one group
	const elsewhere = others.reduce((count, { entries }) => count + entries.length, 0);
	const { controls } = manifest.states;
	/** @returns the controls a volume loads with besides its own switch, by name */
	const loadingStates = (condition: number, own: number | null): string =>
		unique(
			manifest.states.conditionalSets[condition].alternatives.flatMap((requirements) =>
				mapDefined(requirements, ({ control }) => (control === own ? undefined : controls[control]?.name)),
			),
		).join(' or ');
	/** @param shown the index of the level the entries are listed under, whose own volumes don't name it */
	const toggles = (entries: readonly ListedVolume[], shown: number | null) =>
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
							{owner !== null && owner !== shown && ` · from ${levelName(manifest.levels[owner])}`}
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
