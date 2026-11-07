import { controlListedFor, groupByLevel, listedControls } from '../../scene-states/listing.ts';
import { surfaceView, volumeSurface, waterHeight } from '../../scene-states/water-levels.ts';
import type { Viewer } from '../../viewer/viewer.ts';
import { ChoiceRow, ControlValueSelect, FlyButton } from '../controls.tsx';
import { LazyDetails } from '../lazy-details.tsx';
import { useViewerState, useViewerStats } from '../use-viewer.ts';

import { Drivers } from './drivers.tsx';
import { OtherLevels } from './other-levels.tsx';

/** how fast water volumes move between levels, as multiples of the game's speed */
const RATES: { value: number; label: string }[] = [
	{ value: 1, label: 'As in game' },
	{ value: 10, label: '10× faster' },
	{ value: 100, label: '100× faster' },
	{ value: Infinity, label: 'Instantly' },
];

/** a metre count with one decimal */
const metres = (value: number): string => `${value.toFixed(1)} m`;

/**
 * the "Water levels" section: per gameplay water volume that scripts move or that something floats on, a
 * select of the levels the game sets it to; the current level's first
 *
 * @param viewer the loaded scene
 * @param matches the panel's filter
 */
export const WaterLevels = ({ viewer, matches }: { viewer: Viewer; matches: (text: string) => boolean }) => {
	useViewerState(viewer);
	// the surfaces' heights change while they move
	useViewerStats(viewer);
	const manifest = viewer.manifest;
	if (manifest === null) {
		return null;
	}
	const level = viewer.currentLevelIndex;
	const surfaces = viewer.waterSurfaces;
	const controls = listedControls(manifest.states);
	// a volume is listed with its `waterLevel` control, for the levels that control is listed for
	const all = viewer.waterVolumes.flatMap((state, index) => {
		const surface = volumeSurface(surfaces, index);
		const listed = state.entry.control === null ? undefined : controls[state.entry.control];
		if (surface === undefined || listed === undefined) {
			return [];
		}
		const { control } = listed;
		return matches(`${control.name} ${control.id}`) ? [{ state, surface, listed }] : [];
	});
	const here = all.filter(({ listed }) => controlListedFor(listed.control, level));
	const others = groupByLevel(
		all.filter(({ listed }) => !controlListedFor(listed.control, level)),
		manifest.levels,
		level,
		({ listed }) => listed.control.levels,
	);
	const rows = (entries: readonly (typeof all)[number][]) =>
		entries.map(({ state, surface, listed }) => {
			const { control } = listed;
			const { entry, current, target } = state;
			const height = metres(waterHeight(entry, current));
			const { center, size } = surfaceView(state, surface);
			return (
				<div key={listed.index}>
					<ChoiceRow
						label={control.name}
						detail={
							<>
								{current === target ? `at ${height}` : `moving, ${height}`}
								{entry.floaters.length > 0 && ` · ${entry.floaters.length} floating parts`}
							</>
						}
					>
						<ControlValueSelect viewer={viewer} entry={listed} />
					</ChoiceRow>
					<FlyButton viewer={viewer} point={center} size={size} back={0.75} />
					<Drivers viewer={viewer} control={control} />
				</div>
			);
		});
	return (
		<LazyDetails
			summary={
				<summary>
					Water levels ({here.length}
					{others.length > 0 && ` here · ${all.length} in all`})
				</summary>
			}
		>
			{() => (
				<>
					<p className="muted small">
						Gameplay water that switches, timers and scripts raise or lower. Picking a level moves the water
						there at the game&apos;s speed; what floats on it follows.
					</p>
					<ChoiceRow label="Movement">
						<select
							value={String(viewer.options.waterLevelRate)}
							onChange={(event) => viewer.setOptions({ waterLevelRate: Number(event.currentTarget.value) })}
						>
							{RATES.map(({ value, label }) => (
								<option key={label} value={String(value)}>
									{label}
								</option>
							))}
						</select>
					</ChoiceRow>
					{rows(here)}
					<OtherLevels groups={others} render={rows} />
				</>
			)}
		</LazyDetails>
	);
};
