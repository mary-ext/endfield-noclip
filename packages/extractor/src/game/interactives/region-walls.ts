import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import type { LevelInteractive } from '@endfield-noclip/formats/endfield/level-interactives';
import { parseSparkTable } from '@endfield-noclip/formats/hg/spark-buffer';

import { VfsGroup } from '../../hg/vfs.ts';
import { type DraftControl, sceneControl } from '../state/scene-control.ts';

import type { FacilitySources } from './facility-sources.ts';
import type { InteractiveKind, InteractiveRow, SingleModelTemplate } from './interactive-row.ts';
import type { PlacedInteractive } from './placed-interactives.ts';
import { componentValues } from './template-data.ts';
import type { TemplateTraits } from './template-traits.ts';

/** the component of Dijiang's construction-area walls */
export const REGION_WALL_COMPONENTS = ['_SpaceshipRegionWallDataForMemoryPack'];

/** construction area → the Control Nexus level that unlocks it */
const AREA_UNLOCK_TABLE = 'Data/TableCfg/SpaceshipAreaUnlockNeedCenterLvTable.bytes';

/** the placement parameter naming a region wall's construction area */
const AREA_KEY = 'system_inst_key';

/**
 * @param row a placed interactive
 * @returns the string of its {@link AREA_KEY} parameter on any component, or null
 */
const areaOf = (row: LevelInteractive): string | null => {
	for (const value of componentValues(row, AREA_KEY)) {
		if (value?.text) {
			return value.text;
		}
	}
	return null;
};

/**
 * Dijiang's region walls, which hide once the Control Nexus level unlocks their construction area. one
 * `controlNexus:<level id>` control, offered at the levels that unlock an area; levels between them change no
 * wall. without the unlock table, walls are left to the next kind
 */
export class RegionWalls implements InteractiveKind {
	readonly #sources: FacilitySources;
	/** by template key */
	readonly #walls = new Set<string>();
	#nexus: { control: DraftControl; unlockOf: Map<string, number> } | null = null;

	/** @param sources install readers, where a missing unlock table is reported */
	constructor(sources: FacilitySources) {
		this.#sources = sources;
	}

	prepare(key: string, _template: SingleModelTemplate, traits: TemplateTraits): void {
		if (traits.kind === 'regionWall') {
			this.#walls.add(key);
		}
	}

	/**
	 * reads the unlock table when any wall is placed, once every template is prepared
	 *
	 * @param placed the placed rows
	 * @returns the Control Nexus control, `null` without walls or the table
	 * @throws {FormatError} if the table has an invalid entry
	 */
	async readNexus(placed: readonly PlacedInteractive[]): Promise<DraftControl | null> {
		const { vfs } = this.#sources.context;
		const walls = placed.filter(({ row }) => this.#walls.has(row.template));
		const file = walls.length > 0 ? await vfs.find(VfsGroup.Table, AREA_UNLOCK_TABLE) : undefined;
		if (walls.length > 0 && file === undefined) {
			this.#sources.report(AREA_UNLOCK_TABLE, 'missing; region walls stay shown');
		}
		if (file === undefined) {
			return null;
		}
		const unlockOf = new Map<string, number>();
		for (const [area, unlock] of parseSparkTable(await vfs.readVerified(file)).entries) {
			if (typeof area !== 'string' || typeof unlock !== 'number' || unlock < 1 || unlock > 31) {
				throw new FormatError(`${AREA_UNLOCK_TABLE} has an invalid entry for ${String(area)}`);
			}
			unlockOf.set(area, unlock);
		}
		// oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy
		const levels = [...new Set([1, ...unlockOf.values()])].sort((a, b) => a - b);
		this.#nexus = {
			control: sceneControl({
				kind: 'controlNexus',
				id: `controlNexus:${walls[0].levelId}`,
				name: 'Control Nexus level',
				values: levels.map((value) => ({ value, label: `Level ${value}` })),
				default: 1,
				assumption: 'level 1, before the player upgrades it',
			}),
			unlockOf,
		};
		return this.#nexus.control;
	}

	place(placed: InteractiveRow): boolean {
		const { row, template } = placed;
		const nexus = this.#nexus;
		if (nexus === null || !this.#walls.has(row.template)) {
			return false;
		}
		const unlock = nexus.unlockOf.get(areaOf(row) ?? '');
		if (unlock === undefined) {
			// no level unlocks the area in this client
			placed.place(template.forms[0], { alternatives: [[]] }, null);
			return true;
		}
		let mask = 0;
		for (const { value } of nexus.control.values) {
			if (value < unlock) {
				mask |= 1 << value;
			}
		}
		if (mask !== 0) {
			placed.place(
				template.forms[0],
				{ alternatives: [[{ control: nexus.control.id, mask: mask >>> 0 }]] },
				null,
			);
		}
		return true;
	}
}
