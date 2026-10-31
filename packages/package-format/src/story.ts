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
 * @param missions mission ids in story order
 * @param point where the story stands
 * @returns picks for the missions' quest and mission controls: missions before the point completed, after it
 *   not started; in its mission, quests before its step completed, at it in progress and after it not
 *   started. `null` drops a pick, so the finished story (the default) clears them. quests without a step are
 *   left alone
 */
export const storyPointPicks = (
	controls: readonly SceneControl[],
	missions: readonly string[],
	point: StoryPoint,
): Record<string, number | null> => {
	const picks: Record<string, number | null> = {};
	for (const control of controls) {
		const index = control.story === null ? -1 : missions.indexOf(control.story.mission);
		if (index === -1) {
			continue;
		}
		if (point === null) {
			picks[control.id] = null;
		} else if (index !== point.mission) {
			picks[control.id] = index < point.mission ? COMPLETED : NONE;
		} else if (control.kind === 'mission') {
			picks[control.id] = PROCESSING;
		} else if (control.story?.step != null) {
			const { step } = control.story;
			picks[control.id] = step < point.step ? COMPLETED : step === point.step ? PROCESSING : NONE;
		}
	}
	return picks;
};

/**
 * @param controls a package's controls
 * @param missions mission ids in story order
 * @returns the points that tell the controls apart: each mission's start and each step a quest control sits
 *   at, in order, then the finished story
 */
export const storyPoints = (
	controls: readonly SceneControl[],
	missions: readonly string[],
): { point: StoryPoint; mission: string; quest: SceneControl | null }[] => {
	const points: { point: StoryPoint; mission: string; quest: SceneControl | null }[] = [];
	for (const [index, mission] of missions.entries()) {
		points.push({ point: { mission: index, step: 0 }, mission, quest: null });
		const quests = controls
			.filter((control) => control.kind === 'quest' && control.story?.mission === mission)
			.filter((control) => control.story?.step != null)
			.toSorted((a, b) => (a.story?.step ?? 0) - (b.story?.step ?? 0));
		for (const quest of quests) {
			points.push({ point: { mission: index, step: quest.story?.step ?? 0 }, mission, quest });
		}
	}
	points.push({ point: null, mission: '', quest: null });
	return points;
};

/**
 * @param id a mission id
 * @returns a key that orders main story missions by episode and mission number, decimals (`d`) included;
 *   `null` for ids outside the `e<episode>m<mission>[d<decimal>]` scheme
 */
export const storyOrder = (id: string): [number, number] | null => {
	const match = /^e(\d+)m(\d+)(?:d(\d+))?$/.exec(id);
	return match === null ? null : [Number(match[1]), Number(`${match[2]}.${match[3] ?? 0}`)];
};
