import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import type { LevelInteractive } from '@endfield-noclip/formats/endfield/level-interactives';
import { isMemoryPackObject, type MemoryPackValue } from '@endfield-noclip/formats/endfield/memory-pack';

import { type DraftControl, sceneControl, switchValues } from '../state/scene-control.ts';

import type { FacilitySources, PrefabHashes } from './facility-sources.ts';
import type { InteractiveKind, InteractiveRow, SingleModelTemplate } from './interactive-row.ts';
import { readTelescopicPoses, type TelescopicPoses } from './telescopic-bridge.ts';
import { componentValues } from './template-data.ts';
import type { TemplateTraits } from './template-traits.ts';

/** the interactive logic type of telescopic bridges */
const TELESCOPIC_LOGIC = 8;

/** the template and placement property holding a telescopic bridge's piece count */
const PIECES_KEY = 'pieces';

/**
 * @param template a decoded interactive template
 * @param path its file, for errors
 * @returns its piece count when its logic is a telescopic bridge, otherwise `null`
 * @throws {FormatError} if a telescopic bridge lacks a valid piece count
 */
export const telescopicPieces = (template: MemoryPackValue, path: string): number | null => {
	if (!isMemoryPackObject(template)) {
		return null;
	}
	const telescopic = (Array.isArray(template.componentList) ? template.componentList : []).some(
		(component) =>
			isMemoryPackObject(component) &&
			typeof component.$type === 'string' &&
			component.$type.endsWith('_InteractiveLogicControllerComponentDataForMemoryPack') &&
			component.logicType === TELESCOPIC_LOGIC,
	);
	if (!telescopic) {
		return null;
	}
	for (const property of Array.isArray(template.configProperties) ? template.configProperties : []) {
		if (!isMemoryPackObject(property)) {
			continue;
		}
		const value = property.value;
		if (property.key !== PIECES_KEY || !isMemoryPackObject(value)) {
			continue;
		}
		const [atom] = Array.isArray(value.valueArray) ? value.valueArray : [];
		const bits = isMemoryPackObject(atom) ? atom.valueBit64 : undefined;
		const pieces = typeof bits === 'string' || typeof bits === 'number' ? Number(bits) : Number.NaN;
		if (Number.isInteger(pieces) && pieces > 0 && pieces <= 64) {
			return pieces;
		}
	}
	throw new FormatError(`${path} is a telescopic bridge without a valid ${PIECES_KEY} count`);
};

/**
 * @param row a placed interactive
 * @returns its piece count override on any component, or null
 */
const piecesOf = (row: LevelInteractive): number | null => {
	for (const value of componentValues(row, PIECES_KEY)) {
		if (value !== undefined) {
			return Number(value.bits);
		}
	}
	return null;
};

/**
 * telescopic bridges, drawn retracted and extended under a `bridge:<row id>` control, retracted by default. a
 * bridge whose prefab can't be read as one is left to the next kind
 */
export class TelescopicBridges implements InteractiveKind {
	/** one per placed bridge, in placement order */
	readonly controls: DraftControl[] = [];
	readonly #sources: FacilitySources;
	readonly #prefabs: PrefabHashes;
	/** telescopic bridges' piece counts and prefab roots, by key */
	readonly #bridges = new Map<string, { pieces: number; prefab: string }>();
	/** by prefab and piece count; `null` when the prefab isn't a readable telescopic bridge (drawn as saved) */
	readonly #looks = new Map<string, Promise<TelescopicPoses | null>>();

	/**
	 * @param sources where unreadable bridges are reported
	 * @param prefabs the prefab hash lookup
	 */
	constructor(sources: FacilitySources, prefabs: PrefabHashes) {
		this.#sources = sources;
		this.#prefabs = prefabs;
	}

	prepare(key: string, template: SingleModelTemplate, traits: TemplateTraits): void {
		if (traits.kind === 'telescopic') {
			this.#bridges.set(key, { pieces: traits.pieces, prefab: template.forms[0].prefab });
		}
	}

	async place(placed: InteractiveRow): Promise<boolean> {
		const { row, template } = placed;
		const bridge = this.#bridges.get(row.template);
		if (bridge === undefined) {
			return false;
		}
		const pieces = piecesOf(row) ?? bridge.pieces;
		const looks = await this.#looksOf(bridge.prefab, pieces);
		if (looks === null) {
			return false;
		}
		const control = `bridge:${row.id}`;
		this.controls.push(
			sceneControl({
				kind: 'bridge',
				id: control,
				name: `Telescopic bridge (${row.template})`,
				position: row.position,
				values: switchValues('retracted', `extended (${pieces} pieces)`),
				default: 0,
				assumption: 'retracted: the player or the server extends it',
			}),
		);
		placed.place(template.forms[0], { alternatives: [[{ control, mask: 1 }]] }, looks.retracted);
		for (const pose of [looks.extended, ...looks.pieces]) {
			placed.place(template.forms[0], { alternatives: [[{ control, mask: 2 }]] }, pose);
		}
		return true;
	}

	#looksOf(prefab: string, pieces: number): Promise<TelescopicPoses | null> {
		return this.#looks.getOrInsertComputed(`${prefab}:${pieces}`, () =>
			this.#sources.attempt(
				prefab,
				async () => {
					const resolver = await this.#sources.context.resolver();
					const looks = await readTelescopicPoses(resolver, await this.#prefabs.root(prefab), prefab, pieces);
					if (looks === null) {
						this.#sources.report(prefab, 'telescopic bridge prefab has no bridge MonoBehaviour');
					}
					return looks;
				},
				null,
			),
		);
	}
}
