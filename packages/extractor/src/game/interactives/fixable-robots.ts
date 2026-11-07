import type { LevelInteractive } from '@endfield-noclip/formats/endfield/level-interactives';
import type { MemoryPackValue } from '@endfield-noclip/formats/endfield/memory-pack';

import { type ComponentKeys, componentParams } from './component-params.ts';

/** the component of broken robots, which passes its parameters on to its view states */
const FIXABLE_ROBOT: ComponentKeys = {
	suffix: '_FixableRobotComponentDataForMemoryPack',
	diffKey: 'Comp_FixableRobot',
	type: 97,
};

/** the component of broken robots */
export const FIXABLE_ROBOT_COMPONENTS = [FIXABLE_ROBOT.suffix];

/** the int parameters a broken robot passes to its view states under the same keys */
const PASSED_KEYS = ['damage_type', 'level', 'exit_type'];

/**
 * @param template the decoded broken robot template
 * @param row a placed broken robot
 * @returns the int keys its component sets before its view states start: `damage_type` (its pose), `level`
 *   (above 0, a red SOS sign instead of a yellow one) and `exit_type`, from its component parameters
 */
export const fixableRobotInts = (template: MemoryPackValue, row: LevelInteractive): Map<string, number> => {
	const params = componentParams(template, row, FIXABLE_ROBOT);
	const ints = new Map<string, number>();
	for (const key of PASSED_KEYS) {
		const bits = params?.get(key)?.values[0]?.bits;
		if (bits !== undefined) {
			ints.set(key, Number(BigInt.asIntN(32, bits)));
		}
	}
	return ints;
};
