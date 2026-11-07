import type { MemoryPackValue } from '@endfield-noclip/formats/endfield/memory-pack';

import { type AnimatorStart, animatorStart } from './animator-starts.ts';
import { telescopicPieces } from './bridges.ts';
import { CRANE_TOWER_COMPONENTS } from './crane-tower.ts';
import { isAutoMovePlatform } from './curve-move.ts';
import { DOOR_COMPONENTS } from './doors.ts';
import type { FacilitySources } from './facility-sources.ts';
import { JUMP_MACHINE_COMPONENTS, JUMP_MACHINE_VERTICAL_COMPONENTS } from './jump-pads.ts';
import { REGION_WALL_COMPONENTS } from './region-walls.ts';
import { CAMPFIRE_COMPONENTS, type PlayerKey, playerKeys, VERTICAL_ROPE_COMPONENTS } from './rest-looks.ts';
import {
	type EntityProperties,
	entityProperties,
	hasComponent,
	type StartState,
	startState,
	TEMPLATE_ROOT,
} from './template-data.ts';

/**
 * what a single-model template's file says it is. doors, region walls and telescopic bridges are exclusive,
 * in that order; every other template carries what its components ask of its look
 */
export type TemplateTraits =
	| { kind: 'door' | 'regionWall' }
	| { kind: 'telescopic'; pieces: number }
	| {
			kind: 'other';
			campfire: boolean;
			keys: PlayerKey[];
			animator: AnimatorStart | null;
			start: StartState | null;
			/** a jump pad's decoded template, `null` for other templates */
			jumpPad: MemoryPackValue | null;
			/** a vertical jump pad's decoded template, `null` for other templates */
			verticalPad: MemoryPackValue | null;
			/** an auto-moving platform's decoded template, `null` for other templates */
			autoMove: MemoryPackValue | null;
			verticalRope: boolean;
			/** a crane tower's decoded template, `null` for other templates */
			craneTower: MemoryPackValue | null;
			entity: EntityProperties | null;
	  };

/** the traits of a template that can't be read, which is drawn as saved */
const UNREADABLE: TemplateTraits = {
	kind: 'other',
	campfire: false,
	keys: [],
	animator: null,
	start: null,
	jumpPad: null,
	verticalPad: null,
	autoMove: null,
	verticalRope: false,
	craneTower: null,
	entity: null,
};

/**
 * @param template a decoded interactive template
 * @param path its file, for errors
 * @returns what it says it is
 * @throws {FormatError} if a telescopic bridge lacks a valid piece count
 */
const templateTraits = (template: MemoryPackValue, path: string): TemplateTraits => {
	if (hasComponent(template, DOOR_COMPONENTS)) {
		return { kind: 'door' };
	}
	if (hasComponent(template, REGION_WALL_COMPONENTS)) {
		return { kind: 'regionWall' };
	}
	const pieces = telescopicPieces(template, path);
	if (pieces !== null) {
		return { kind: 'telescopic', pieces };
	}
	return {
		kind: 'other',
		campfire: hasComponent(template, CAMPFIRE_COMPONENTS),
		keys: playerKeys(template),
		animator: animatorStart(template),
		start: startState(template),
		jumpPad: hasComponent(template, JUMP_MACHINE_COMPONENTS) ? template : null,
		verticalPad: hasComponent(template, JUMP_MACHINE_VERTICAL_COMPONENTS) ? template : null,
		autoMove: isAutoMovePlatform(template) ? template : null,
		verticalRope: hasComponent(template, VERTICAL_ROPE_COMPONENTS),
		craneTower: hasComponent(template, CRANE_TOWER_COMPONENTS) ? template : null,
		entity: entityProperties(template),
	};
};

/** template traits by data file, each file decoded once */
export class TemplateTraitsReader {
	readonly #sources: FacilitySources;
	readonly #traits = new Map<string, TemplateTraits>();

	/** @param sources install readers, where unreadable templates are reported */
	constructor(sources: FacilitySources) {
		this.#sources = sources;
	}

	/**
	 * @param data a template's data file
	 * @returns its traits; those of a plain model when it can't be read, which is reported
	 */
	async of(data: string): Promise<TemplateTraits> {
		let traits = this.#traits.get(data);
		if (traits === undefined) {
			const sources = this.#sources;
			traits = await sources.attempt(
				data,
				async () => templateTraits(sources.memoryPack.decode(await sources.read(data), TEMPLATE_ROOT), data),
				UNREADABLE,
			);
			this.#traits.set(data, traits);
		}
		return traits;
	}
}
