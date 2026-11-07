import type { SceneControl } from './states.ts';

// story progress as one choice: a point in an ordered list of missions sets every quest and mission control of
// those missions consistently, instead of each quest being picked on its own.

/** a point in a story line: in `missions[mission]`, at `step` (0: just started); `null` once all are done */
export type StoryPoint = { mission: number; step: number } | null;

/** `QuestState` / `MissionState` values */
const NONE = 0;
const PROCESSING = 2;
const COMPLETED = 3;

/**
 * @param controls a package's controls
 * @param missions `StatesInfo.missions` indices in story order
 * @param point where the story stands
 * @returns picks by control index for the missions' quest and mission controls: missions before the point
 *   completed, after it not started; in its mission, quests before its step completed, at it in progress and
 *   after it not started. `null` drops a pick, so the finished story (the default) clears them. quests
 *   without a step are left alone
 */
export const storyPointPicks = (
	controls: readonly SceneControl[],
	missions: readonly number[],
	point: StoryPoint,
): Map<number, number | null> => {
	const picks = new Map<number, number | null>();
	for (const [i, { story }] of controls.entries()) {
		const index = story === null ? -1 : missions.indexOf(story.mission);
		if (story === null || index === -1) {
			continue;
		}
		if (point === null) {
			picks.set(i, null);
		} else if (index !== point.mission) {
			picks.set(i, index < point.mission ? COMPLETED : NONE);
		} else if (story.role === 'mission') {
			picks.set(i, PROCESSING);
		} else if (story.step !== null) {
			const { step } = story;
			picks.set(i, step < point.step ? COMPLETED : step === point.step ? PROCESSING : NONE);
		}
	}
	return picks;
};

/**
 * @param controls a package's controls
 * @param missions `StatesInfo.missions` indices in story order
 * @returns the points that tell the controls apart: each mission's start and each step quest controls sit at,
 *   in order, with the mission and the quests at that step (several off-flow quests can share one), then the
 *   finished story, whose mission is `null`
 */
export const storyPoints = (
	controls: readonly SceneControl[],
	missions: readonly number[],
): { point: StoryPoint; mission: number | null; quests: SceneControl[] }[] => {
	const points: { point: StoryPoint; mission: number | null; quests: SceneControl[] }[] = [];
	for (const [index, mission] of missions.entries()) {
		points.push({ point: { mission: index, step: 0 }, mission, quests: [] });
		const steps = Map.groupBy(
			controls.filter(
				(control) =>
					control.story?.role === 'quest' && control.story.mission === mission && control.story.step !== null,
			),
			(control) => control.story?.step ?? 0,
		);
		for (const [step, quests] of [...steps].toSorted((a, b) => a[0] - b[0])) {
			points.push({ point: { mission: index, step }, mission, quests });
		}
	}
	points.push({ point: null, mission: null, quests: [] });
	return points;
};
