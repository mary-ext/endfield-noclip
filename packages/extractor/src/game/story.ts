import type { MissionRuntime } from '@endfield-noclip/formats/endfield/mission-runtime';
import type { MissionInfo, SceneControl } from '@endfield-noclip/package-format/states';

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
	controls: readonly SceneControl[],
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
			control.story = { mission: missionId, step: null };
			continue;
		}
		const quest = mission.quests.find((entry) => entry.id === id);
		const step = mission.mainPath.indexOf(id);
		control.story = { mission: missionId, step: step === -1 ? null : step + 1 };
		const label = quest && (plain(quest.objectiveKey) ?? plain(quest.descriptionKey));
		// hidden steps exist only to drive scenery; their id suffix is the best name they have
		control.name = label ?? `hidden step ${id.slice(missionId.length + 3)}`;
	}
	return [...missions.values()].toSorted((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
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
				: [plain(`chapter${chapter}_num`), plain(`chapter${chapter}_name`)].filter(Boolean).join(' · ') ||
					null,
		episode: episode === undefined ? null : plain(`ep${episode}_name`),
	};
};

/**
 * @param text a game string
 * @returns it without rich-text tags such as `<@qu.key>…</>`
 */
export const stripMarkup = (text: string): string => text.replaceAll(/<[^>]*>/g, '').trim();
