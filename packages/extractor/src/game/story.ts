import type { MissionRuntime } from '@endfield-noclip/formats/endfield/mission-runtime';
import type { MissionInfo, QuestRef } from '@endfield-noclip/package-format/states';

import { definite, mapDefined } from '@mary-ext/array-fns';

import type { DraftControl } from './scene-control.ts';
import type { WorldIndex } from './world-index.ts';

// names quest and mission controls from the game's mission definitions and English text. a quest's id is its
// mission's id, `_q#`, and a step name, so the mission is found from the id. names come from the user's install
// at pack time, like everything else in a package.

/** `MissionType` → the quest log tab it's listed under, as the client's mission type table groups them */
const CATEGORIES = new Map<number, MissionInfo['category']>([
	[0, 'main'], // Main
	[9, 'main'], // FakeMain
	[12, 'main'], // TBCMain
	[1, 'side'], // Char
	[10, 'side'], // Side
	[2, 'discovery'], // Factory
	[7, 'discovery'], // World
	[11, 'activity'], // Activity
]);

/** `MissionChapter` bit → chapter text key index */
const CHAPTERS = new Map([
	[1, 1],
	[2, 2],
]);

/**
 * names the quest and mission controls and places them in their missions; controls of other kinds are left as
 * they are. the given controls are modified in place
 *
 * @param world world index
 * @param controls the scene's controls
 * @returns the missions the quest and mission controls belong to, by id
 * @throws {FormatError} if a mission file is malformed
 */
export const labelStory = async (
	world: WorldIndex,
	controls: readonly DraftControl[],
): Promise<MissionInfo[]> => {
	const text = await world.text();
	const plain = (key: string | null): string | null => {
		const value = key === null ? undefined : text(key);
		return value === undefined ? null : stripMarkup(value);
	};
	const missions = new Map<string, MissionInfo>();
	for (const control of controls) {
		if (control.kind !== 'quest' && control.kind !== 'mission') {
			continue;
		}
		const id = control.id.slice(control.kind.length + 1);
		const missionId = control.kind === 'mission' ? id : id.split('_q#')[0];
		// oxlint-disable-next-line no-await-in-loop -- missions are cached and few
		const mission = await world.mission(missionId);
		if (mission === undefined) {
			continue;
		}
		if (!missions.has(missionId)) {
			missions.set(missionId, missionInfo(mission, plain));
		}
		if (control.kind === 'mission') {
			control.name = missions.get(missionId)?.name ?? missionId;
			control.story = { role: 'mission', mission: missionId, step: null };
			continue;
		}
		const quest = mission.quests.find((entry) => entry.id === id);
		control.story = { role: 'quest', mission: missionId, step: flowStep(mission, id) };
		const label = quest && (plain(quest.objectiveKey) ?? plain(quest.descriptionKey));
		// hidden steps exist only to drive scenery; their id suffix is the best name they have
		control.name = label ?? `hidden step ${id.slice(missionId.length + 3)}`;
	}
	// oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy
	return [...missions.values()].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
};

/**
 * @param missions the scene's missions
 * @returns the main story missions' ids in story order: by episode, mission and decimal (`d`) number, read
 *   from ids in the `e<episode>m<mission>[d<decimal>]` scheme; main missions outside it are left out
 */
export const mainStoryOrder = (missions: readonly MissionInfo[]): string[] => {
	const keyed = mapDefined(missions, ({ id, category }) => {
		const key = category === 'main' ? storyOrder(id) : null;
		return key === null ? undefined : { id, key };
	});
	return keyed
		.toSorted((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2])
		.map(({ id }) => id);
};

/**
 * @param id a mission id
 * @returns its episode, mission and decimal numbers (0 without a decimal), or `null` outside the
 *   `e<episode>m<mission>[d<decimal>]` scheme
 */
export const storyOrder = (id: string): [number, number, number] | null => {
	const match = /^e(\d+)m(\d+)(?:d(\d+))?$/.exec(id);
	return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
};

/**
 * @returns the quest's 1-based position in the mission's main flow; a quest off it, half a step after its
 *   predecessor's position (it starts once that completes); `null` when no predecessor chain reaches the
 *   flow
 */
const flowStep = (mission: MissionRuntime, id: string, seen = new Set<string>()): number | null => {
	const index = mission.mainPath.indexOf(id);
	if (index !== -1) {
		return index + 1;
	}
	if (seen.has(id)) {
		return null;
	}
	seen.add(id);
	const quest = mission.quests.find((entry) => entry.id === id);
	const steps = mapDefined(
		quest?.previous ?? [],
		(previous) => flowStep(mission, previous, seen) ?? undefined,
	);
	return steps.length === 0 ? null : Math.floor(Math.max(...steps)) + 0.5;
};

const missionInfo = (mission: MissionRuntime, plain: (key: string | null) => string | null): MissionInfo => {
	// the prologue's missions carry chapter one's bit; only their id marks them as the prologue
	const chapter = mission.id.startsWith('e0m')
		? 0
		: [...CHAPTERS].find(([bit]) => (mission.chapters & bit) !== 0)?.[1];
	const episode = /^e(\d+)m/.exec(mission.id)?.[1];
	return {
		id: mission.id,
		name: plain(mission.nameKey),
		category: CATEGORIES.get(mission.type) ?? 'other',
		chapter:
			chapter === undefined
				? null
				: definite([plain(`chapter${chapter}_num`), plain(`chapter${chapter}_name`)]).join(' · ') || null,
		episode: episode === undefined ? null : plain(`ep${episode}_name`),
		levelId: mission.levelId,
	};
};

/**
 * @param world world index
 * @param id a quest id (`<mission>_q#<step>`) or a mission id
 * @returns its mission's name and its own text, as quest controls are labelled
 */
export const questRef = async (world: WorldIndex, id: string): Promise<QuestRef> => {
	const text = await world.text();
	const plain = (key: string | null): string | null => {
		const value = key === null ? undefined : text(key);
		return value === undefined ? null : stripMarkup(value);
	};
	const missionId = id.split('_q#')[0];
	const mission = await world.mission(missionId);
	if (mission === undefined) {
		return { id, mission: null, name: null };
	}
	const quest = mission.quests.find((entry) => entry.id === id);
	return {
		id,
		mission: plain(mission.nameKey),
		name: quest === undefined ? null : (plain(quest.objectiveKey) ?? plain(quest.descriptionKey)),
	};
};

/**
 * @param text a game string
 * @returns it without rich-text tags such as `<@qu.key>…</>`
 */
export const stripMarkup = (text: string): string => text.replaceAll(/<[^>]*>/g, '').trim();
