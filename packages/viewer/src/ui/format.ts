import type { LevelInfo } from '@endfield-noclip/package-format/manifest';
import type { ControlPlace, RuleText, SceneControl } from '@endfield-noclip/package-format/states';

/**
 * @param bytes byte count
 * @returns e.g. `12.3 MiB`
 */
export const formatBytes = (bytes: number): string => {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 ** 2) {
		return `${(bytes / 1024).toFixed(1)} KiB`;
	}
	if (bytes < 1024 ** 3) {
		return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
	}
	return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
};

/**
 * @param n a count
 * @returns e.g. `1.2M`, `34.5k`, `950`
 */
export const formatCount = (n: number): string => {
	if (n >= 1e6) {
		return `${(n / 1e6).toFixed(2)}M`;
	}
	if (n >= 1e4) {
		return `${(n / 1e3).toFixed(1)}k`;
	}
	return String(n);
};

/**
 * @param err something thrown
 * @returns its message
 */
export const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * @param level a package level
 * @returns its display name, else its id
 */
export const levelName = (level: Pick<LevelInfo, 'id' | 'name'>): string => level.name ?? level.id;

/**
 * @param place where a control's content is
 * @returns how big it is across, in metres, for flying to it; 20 m without content of its own
 */
export const placeSize = ({ bounds }: ControlPlace): number =>
	bounds === null
		? 20
		: Math.max(
				bounds.max[0] - bounds.min[0],
				bounds.max[1] - bounds.min[1],
				bounds.max[2] - bounds.min[2],
				4,
			);

/**
 * @param control a scene control
 * @returns the game's rule for a derived control, `null` for others
 */
export const ruleOf = (control: SceneControl): RuleText | null =>
	control.source.kind === 'derived' ? control.source.rule : null;

/**
 * @param control a scene control
 * @returns whether it's a plain off/on switch only the user sets, shown as a checkbox; controls whose values
 *   say more (closed/open, standing/felled) keep a select that shows them
 */
export const isToggle = (control: SceneControl): boolean =>
	control.source.kind === 'user' &&
	control.values.length === 2 &&
	control.values[0].value === 0 &&
	control.values[0].label === 'off' &&
	control.values[1].label === 'on';

/**
 * @param control a scene control
 * @returns the label of the option that leaves the control to the camera or the game, or `null` if only the
 *   user sets it
 */
export const followLabel = (control: SceneControl): string | null => {
	switch (control.source.kind) {
		case 'camera': {
			return 'Follow camera';
		}
		case 'derived': {
			return 'Follow game';
		}
		case 'user': {
			return null;
		}
	}
};
