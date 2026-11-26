import { cameraValues, NO_TRIGGER_MEMORY, type TriggerMemory } from '@endfield-noclip/package-format/camera';
import {
	conditionResults,
	groupsShown,
	resolveSceneValues,
} from '@endfield-noclip/package-format/conditions';
import type { StatesInfo } from '@endfield-noclip/package-format/states';
import { areasShownIn, zonesAround, zonesAt } from '@endfield-noclip/package-format/stream-areas';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import { KeyedEventEmitter } from '@mary-ext/simple-event-emitter';

/** events emitted by {@link SceneState} when resolved values or visibility groups change */
export type SceneStateEvents = {
	values: [values: readonly number[]];
	groups: [shown: readonly boolean[]];
};

/**
 * @param a an array
 * @param b another
 * @returns whether they hold the same values
 */
const sameResults = (a: readonly boolean[], b: readonly boolean[]): boolean =>
	a.length === b.length && a.every((value, i) => value === b[i]);

/**
 * the scene controls of the loaded package: the user's picks, the values they resolve to with the camera's
 * stream areas and camera controls, the conditional sets those satisfy, and the visibility groups shown,
 * which are emitted to subscribers
 */
export class SceneState {
	/** values the user picked, by control index */
	#picks: ReadonlyMap<number, number> = new Map();
	/** every control's value by index, from the picks and the package's defaults and derived controls */
	#values: readonly number[] = [];
	/** per conditional set, whether the values satisfy it; replaced only when a result changes */
	#results: readonly boolean[] = [];
	/** stream areas the conditions were last evaluated with, or `null` for every area */
	#visibleAreas: ReadonlySet<number> | null = null;
	/** camera position {@link follow} last tested */
	#areasEye: Vec3 = [Number.NaN, 0, 0];
	/** camera control values the conditions were last evaluated with, by control index */
	#camera: ReadonlyMap<number, number> = new Map();
	/** what the camera's trigger tests remember of its path, as of {@link #areasEye} */
	#triggers: TriggerMemory = NO_TRIGGER_MEMORY;
	#states: StatesInfo | null = null;
	/**
	 * pre-filtered camera controls and their original indices in `states.controls`, rebuilt on
	 * {@link setPackage}
	 */
	#cameraControls: { controls: StatesInfo['controls']; indices: number[] } = { controls: [], indices: [] };
	readonly #events = new KeyedEventEmitter<SceneStateEvents>();
	readonly #options: { readonly streamAreas: boolean };

	/** @param options read at each evaluation: whether stream areas follow the camera */
	constructor(options: { readonly streamAreas: boolean }) {
		this.#options = options;
	}

	/**
	 * subscribes to resolved scene value or visibility group updates
	 *
	 * @param event `'values'` or `'groups'`
	 * @param listener called on each evaluation
	 * @returns unsubscribe
	 */
	subscribe<K extends keyof SceneStateEvents>(
		event: K,
		listener: (...args: SceneStateEvents[K]) => void,
	): () => void {
		return this.#events.subscribe(event, listener);
	}

	/** @returns the values the user picked, by control index; other controls follow their default or formula */
	get picks(): ReadonlyMap<number, number> {
		return this.#picks;
	}

	/** @returns every scene control's current value, by index; empty without a package */
	get values(): readonly number[] {
		return this.#values;
	}

	/** @returns per conditional set, whether the values satisfy it; a new array only when a result changes */
	get conditionResults(): readonly boolean[] {
		return this.#results;
	}

	/**
	 * @returns the stream areas shown at the camera, or `null` when every area shows (the option is off or the
	 *   package has no stream areas)
	 */
	get visibleStreamAreas(): ReadonlySet<number> | null {
		return this.#visibleAreas;
	}

	/**
	 * switches to a package's controls and drops the picks; call {@link evaluate} next
	 *
	 * @param states the package's controls, `null` without a package (which also clears the values)
	 */
	setPackage(states: StatesInfo | null): void {
		this.#states = states;
		const controls: StatesInfo['controls'] = [];
		const indices: number[] = [];
		if (states !== null) {
			for (let i = 0; i < states.controls.length; i++) {
				const control = states.controls[i];
				if (control.source.kind === 'camera') {
					controls.push(control);
					indices.push(i);
				}
			}
		}
		this.#cameraControls = { controls, indices };
		this.#picks = new Map();
		this.#triggers = NO_TRIGGER_MEMORY;
		if (states === null) {
			this.#values = [];
		}
	}

	/**
	 * changes picks without evaluating
	 *
	 * @param values by control index, one of its values or `null` to drop the pick; unknown controls and values
	 *   are ignored
	 * @returns whether there's a package to pick for
	 */
	pick(values: ReadonlyMap<number, number | null>): boolean {
		const controls = this.#states?.controls;
		if (controls === undefined) {
			return false;
		}
		const picks = new Map(this.#picks);
		for (const [index, value] of values) {
			const control = controls[index];
			if (
				control === undefined ||
				(value !== null && !control.values.some((entry) => entry.value === value))
			) {
				continue;
			}
			if (value === null) {
				picks.delete(index);
			} else {
				picks.set(index, value);
			}
		}
		this.#picks = picks;
		return true;
	}

	/** drops every pick without evaluating */
	resetPicks(): void {
		this.#picks = new Map();
	}

	/** evaluates only the package's camera controls and maps their results back to original control indices */
	#sampleCamera(eye: Vec3, visible: ReadonlySet<number> | null): ReadonlyMap<number, number> {
		const { controls, indices } = this.#cameraControls;
		if (controls.length === 0) {
			return this.#camera;
		}
		const camera = cameraValues(controls, eye, visible, this.#triggers);
		this.#triggers = camera.memory;
		const mapped = new Map<number, number>();
		for (const [compactIndex, value] of camera.values) {
			mapped.set(indices[compactIndex], value);
		}
		return mapped;
	}

	/**
	 * re-evaluates the values, conditions and visibility groups for the picks and the stream areas and camera
	 * controls at the camera, and hands the groups to every consumer
	 *
	 * @param eye the camera's position, which stands in for the player
	 */
	evaluate(eye: Vec3): void {
		const visible = this.#streamAreasAt(eye);
		this.#areasEye = [...eye];
		// camera controls follow the camera unless pinned, so the camera's values go under the picks
		this.#applyResolved(visible, this.#sampleCamera(eye, visible));
	}

	/**
	 * re-evaluates when the camera moved into a different set of stream areas, or changed a camera control's
	 * value
	 *
	 * @param eye the camera's position
	 * @returns whether it re-evaluated
	 */
	follow(eye: Vec3): boolean {
		const last = this.#areasEye;
		if (eye[0] === last[0] && eye[1] === last[1] && eye[2] === last[2]) {
			return false;
		}
		this.#areasEye = [...eye];
		const visible = this.#streamAreasAt(eye);
		const current = this.#visibleAreas;
		const same =
			visible === null || current === null
				? visible === current
				: visible.size === current.size && visible.isSubsetOf(current);
		const camera = this.#sampleCamera(eye, visible);
		let sameCamera = camera === this.#camera;
		if (!sameCamera && camera.size === this.#camera.size) {
			sameCamera = true;
			for (const [index, value] of camera) {
				if (this.#camera.get(index) !== value) {
					sameCamera = false;
					break;
				}
			}
		}
		if (same && sameCamera) {
			return false;
		}
		this.#applyResolved(visible, camera);
		return true;
	}

	/** resolves scene values, conditions, and visibility groups from already-sampled areas and camera controls */
	#applyResolved(visible: ReadonlySet<number> | null, camera: ReadonlyMap<number, number>): void {
		const states = this.#states;
		this.#visibleAreas = visible;
		this.#camera = camera;
		const values = states === null ? [] : resolveSceneValues(states, this.#picks, this.#camera);
		this.#values = values;
		this.#events.emit('values', values);
		const results = states === null ? [] : conditionResults(states, values);
		if (!sameResults(results, this.#results)) {
			this.#results = results;
		}
		const shown = states === null ? [] : groupsShown(states, this.#results);
		this.#events.emit('groups', shown);
	}

	/** @returns the stream areas to show at the eye, or `null` for every area */
	#streamAreasAt(eye: Vec3): ReadonlySet<number> | null {
		const info = this.#states?.streamAreas ?? null;
		if (info === null || !this.#options.streamAreas) {
			return null;
		}
		let zones = zonesAt(info, eye);
		if (zones.size === 0) {
			// above or below every trigger the game falls back to the root areas, which hides most of a zone's
			// level from an overview, so a free camera keeps the zones whose footprint it's over
			zones = zonesAround(info, eye);
		}
		return areasShownIn(info, zones);
	}
}
