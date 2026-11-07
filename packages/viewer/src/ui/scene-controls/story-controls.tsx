import type { MissionInfo, RuleText, StatesInfo } from '@endfield-noclip/package-format/states';
import { storyPointPicks, storyPoints, type StoryPoint } from '@endfield-noclip/package-format/story';

import { definite } from '@mary-ext/array-fns';

import type { ListedControl } from '../../scene-states/listing.ts';
import type { Viewer } from '../../viewer/viewer.ts';
import { ChoiceRow } from '../controls.tsx';
import { levelName } from '../format.ts';
import { LazyDetails } from '../lazy-details.tsx';

import { ControlRow } from './control-row.tsx';

/** quest log tabs in the game's order */
const CATEGORIES: { category: MissionInfo['category']; title: string }[] = [
	{ category: 'main', title: 'Main story' },
	{ category: 'side', title: 'Side and character' },
	{ category: 'discovery', title: 'Discovery' },
	{ category: 'activity', title: 'Events' },
	{ category: 'other', title: 'Other' },
];

/** @returns a mission's controls: the mission first, then quests by step, steps before unnumbered ones */
const ordered = (entries: readonly ListedControl[]): ListedControl[] =>
	entries.toSorted(
		({ control: a }, { control: b }) =>
			Number(a.story?.role !== 'mission') - Number(b.story?.role !== 'mission') ||
			(a.story?.step ?? Number.MAX_SAFE_INTEGER) - (b.story?.step ?? Number.MAX_SAFE_INTEGER) ||
			a.id.localeCompare(b.id),
	);

/**
 * a select over story points: each sets every quest and mission control of the given missions consistently
 *
 * @param props.states the package's controls and missions, which the picks cover
 * @param props.order mission indices in story order
 * @param props.listed the controls listed for the shown level, which decide the points offered
 * @param props.finished the label of the finished point
 */
const StoryProgress = ({
	viewer,
	states,
	label,
	order,
	listed,
	finished,
}: {
	viewer: Viewer;
	states: StatesInfo;
	label: string;
	order: readonly number[];
	listed: readonly ListedControl[];
	finished: string;
}) => {
	const { controls, missions } = states;
	const points: { key: string; point: StoryPoint; text: string }[] = [
		{ key: 'none', point: { mission: -1, step: 0 }, text: 'not started' },
		...storyPoints(
			listed.map(({ control }) => control),
			order,
		).map(({ point, mission, quests }) => {
			if (point === null) {
				return { key: 'done', point, text: finished };
			}
			const name = (order.length > 1 && mission !== null && missions[mission]?.name) || null;
			const step = quests.length === 0 ? 'started' : quests.map((quest) => quest.name).join(' / ');
			return {
				key: `${point.mission}:${point.step}`,
				point,
				text: name === null ? step : `${name}: ${step}`,
			};
		}),
	];
	// the point whose picks the current values match, if any; a dropped pick stands for the control's default
	const current = points.findIndex(({ point }) =>
		storyPointPicks(controls, order, point)
			.entries()
			.every(([index, value]) => {
				const fallback = controls[index].default;
				return (viewer.sceneValues[index] ?? fallback) === (value ?? fallback);
			}),
	);
	return (
		<ChoiceRow label={label}>
			<select
				value={current}
				onChange={(event) => {
					const point = points[Number(event.currentTarget.value)]?.point;
					if (point !== undefined) {
						viewer.setSceneValues(storyPointPicks(controls, order, point));
					}
				}}
			>
				{current === -1 && <option value={-1}>(mixed)</option>}
				{points.map(({ key, text }, index) => (
					<option key={key} value={index}>
						{text}
					</option>
				))}
			</select>
		</ChoiceRow>
	);
};

/**
 * quest and mission controls grouped by quest log tab and mission, with progress selects over their steps
 *
 * @param props.entries the quest and mission controls listed for the shown level
 * @param props.describe a rule in words, its references named
 */
export const StoryControls = ({
	viewer,
	entries,
	describe,
}: {
	viewer: Viewer;
	entries: readonly ListedControl[];
	describe: (rule: RuleText) => string;
}) => {
	const manifest = viewer.manifest;
	if (manifest === null) {
		return null;
	}
	const { states } = manifest;
	const grouped = Map.groupBy(entries, ({ control }) => control.story?.mission ?? null);
	const rows = (listed: readonly ListedControl[]) =>
		ordered(listed).map((entry) => (
			<ControlRow key={entry.index} viewer={viewer} entry={entry} describe={describe} />
		));
	const unplaced = grouped.get(null) ?? [];
	/** @returns the display name of the level a mission takes place in */
	const missionLevel = (id: string): string => {
		const level = manifest.levels.find((entry) => entry.id === id);
		return level === undefined ? id : levelName(level);
	};
	return (
		<>
			{states.mainStory.some((mission) => grouped.has(mission)) && (
				<StoryProgress
					viewer={viewer}
					states={states}
					label="Main story progress"
					order={states.mainStory}
					listed={entries}
					finished="main story finished"
				/>
			)}
			{CATEGORIES.map(({ category, title }) => {
				const listed = states.missions.flatMap((mission, index) =>
					mission.category === category && grouped.has(index) ? [{ mission, index }] : [],
				);
				if (listed.length === 0) {
					return null;
				}
				return (
					<section key={category} className="story-category">
						<h3>{title}</h3>
						{listed.map(({ mission, index }) => (
							<LazyDetails
								key={mission.id}
								className="story-mission"
								summary={
									<summary>
										{mission.name ?? mission.id}
										<small className="muted">
											{definite([
												mission.levelId && `takes place in ${missionLevel(mission.levelId)}`,
												mission.chapter,
												mission.episode,
												mission.name && mission.id,
											]).join(' · ')}
										</small>
									</summary>
								}
							>
								{() => (
									<>
										<StoryProgress
											viewer={viewer}
											states={states}
											label="Progress"
											order={[index]}
											listed={entries}
											finished="completed"
										/>
										<LazyDetails summary={<summary>Quests ({grouped.get(index)?.length ?? 0})</summary>}>
											{() => rows(grouped.get(index) ?? [])}
										</LazyDetails>
									</>
								)}
							</LazyDetails>
						))}
					</section>
				);
			})}
			{unplaced.length > 0 && (
				<section className="story-category">
					<h3>Not in this client</h3>
					{rows(unplaced)}
				</section>
			)}
		</>
	);
};
