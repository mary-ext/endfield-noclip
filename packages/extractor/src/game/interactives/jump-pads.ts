import type { LevelInteractive } from '@endfield-noclip/formats/endfield/level-interactives';
import type { MemoryPackValue } from '@endfield-noclip/formats/endfield/memory-pack';
import { trsMatrix, unityEulerQuaternion } from '@endfield-noclip/formats/unity/transform';

import { type ComponentKeys, componentParams } from './component-params.ts';
import type { InteractiveRow, SingleModelTemplate, TemplateReader } from './interactive-row.ts';
import type { RestingEffects } from './resting-effects.ts';
import { atomFloat, entityProperties, entityProperty, entityState } from './template-data.ts';
import type { TemplateTraits } from './template-traits.ts';

/** the component of jump pads, which place an effect of their own */
const JUMP_MACHINE: ComponentKeys = {
	suffix: '_JumpMachineComponentDataForMemoryPack',
	diffKey: 'Comp_JumpMachine',
	type: 169,
};

/** the component of jump pads */
export const JUMP_MACHINE_COMPONENTS = [JUMP_MACHINE.suffix];

/** the component of vertical jump pads (cave vents), which play an effect of their own while on */
export const JUMP_MACHINE_VERTICAL_COMPONENTS = ['_JumpMachineVerticalComponentDataForMemoryPack'];

/** the looping effect a vertical jump pad's component plays on its root while on; the name is fixed in code */
const VERTICAL_PAD_EFFECT = 'P_interactive_cavewell+1_001_01_loop';

/**
 * @param template the decoded vertical jump pad template
 * @param row a placed vertical jump pad
 * @returns the looping effect it plays on its root, or `null` unless its `state` starts on (1)
 */
export const verticalPadEffect = (template: MemoryPackValue, row: LevelInteractive): string | null => {
	const entity = entityProperties(template);
	return entity !== null && entityState(entity, row) === 1 ? VERTICAL_PAD_EFFECT : null;
};

/**
 * the stationary effect a jump pad that isn't off (`state` 0) or a free jump places at itself, turned about
 * the vertical towards its target position
 *
 * @param template the decoded jump pad template
 * @param row a placed jump pad
 * @returns the effect's name and its yaw in degrees, or `null` when it places none
 */
export const jumpPadArrow = (
	template: MemoryPackValue,
	row: LevelInteractive,
): { effect: string; yaw: number } | null => {
	const entity = entityProperties(template);
	const params = componentParams(template, row, JUMP_MACHINE);
	if (entity === null || params === null) {
		return null;
	}
	// a pad is locked while its `state` is off (0), whatever its `is_locked` property says. `free_jump` and
	// `effect` are the component's own parameters; the state and the target are the entity's
	const locked = entityState(entity, row) === 0;
	const free = (params.get('free_jump')?.values[0]?.bits ?? 0n) !== 0n;
	const effect = params.get('effect')?.values[0]?.text;
	if (locked || free || !effect) {
		return null;
	}
	const target = (entityProperty(entity, row, 'target_position') ?? []).map((atom) => atomFloat(atom.bits));
	const dx = (target[0] ?? 0) - row.position[0];
	const dz = (target[2] ?? 0) - row.position[2];
	// a zero direction looks along +z
	return { effect, yaw: dx === 0 && dz === 0 ? 0 : (Math.atan2(dx, dz) * 180) / Math.PI };
};

/** jump pads' arrows and vertical jump pads' vents: effects they place at themselves, beside their model */
export class JumpPads implements TemplateReader {
	readonly #effects: RestingEffects;
	/** jump pads' decoded templates, which say whether and where they place their arrow, by key */
	readonly #pads = new Map<string, MemoryPackValue>();
	/** vertical jump pads' decoded templates, by key */
	readonly #verticalPads = new Map<string, MemoryPackValue>();

	/** @param effects where the effects are queued */
	constructor(effects: RestingEffects) {
		this.#effects = effects;
	}

	prepare(key: string, _template: SingleModelTemplate, traits: TemplateTraits): void {
		if (traits.kind !== 'other') {
			return;
		}
		if (traits.jumpPad !== null) {
			this.#pads.set(key, traits.jumpPad);
		}
		if (traits.verticalPad !== null) {
			this.#verticalPads.set(key, traits.verticalPad);
		}
	}

	/**
	 * queues the effects a row places at itself, independent of its look
	 *
	 * @param placed a placed row with a model
	 */
	decorate(placed: InteractiveRow): void {
		const { row, source } = placed;
		const { levelTag } = placed.placed;
		const pad = this.#pads.get(row.template);
		const arrow = pad === undefined ? null : jumpPadArrow(pad, row);
		if (arrow !== null) {
			// a stationary effect, unscaled, independent of the pad's state
			this.#effects.queue({
				effect: arrow.effect,
				source,
				levelTag,
				visibility: placed.gate({ alternatives: [[]] }),
				frame: trsMatrix(row.position, unityEulerQuaternion([0, arrow.yaw, 0]), [1, 1, 1]),
				on: null,
				followRotation: true,
			});
		}
		const verticalPad = this.#verticalPads.get(row.template);
		const vent = verticalPad === undefined ? null : verticalPadEffect(verticalPad, row);
		if (vent !== null) {
			// played on the entity's root, so it follows the placement but not its model's scale
			this.#effects.queue({
				effect: vent,
				source,
				levelTag,
				visibility: placed.gate({ alternatives: [[]] }),
				frame: trsMatrix(row.position, unityEulerQuaternion(row.rotation), row.scale),
				on: null,
				followRotation: true,
			});
		}
	}
}
