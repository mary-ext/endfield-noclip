import type { DynamicGate } from '@endfield-noclip/formats/endfield/dynamic-scene';
import type { CompareOperator, SceneCondition } from '@endfield-noclip/formats/endfield/map-config';
import type { SceneToggleInfo } from '@endfield-noclip/package-format/format';

import { describe, evaluate } from './scene-conditions.ts';

// dynamic entities' mission and variable load gates, as one toggle per distinct condition. mission gates
// default to their result for a player who finished the story. variable values are server state, and the
// tables naming the variable ids aren't read; a variable is assumed to hold the highest value any gate in the
// scene compares it against, on the reading that the story moves these variables forward (erosion cleansed,
// machines repaired, the last stage of a staged change).

/**
 * @param gate a dynamic entity load gate
 * @returns its toggle's id; equal gates share one
 */
export const gateControl = (gate: DynamicGate): string => {
	switch (gate.kind) {
		case 'mission': {
			return `mission:${describe(missionCondition(gate))}`;
		}
		case 'globalVar':
		case 'mapVar': {
			return `${variableId(gate)}:${gate.compare}:${gate.value}`;
		}
	}
};

/**
 * @param gates every gate of a scene's dynamic entities
 * @returns one toggle per distinct gate, by {@link gateControl}; names are the condition until the caller
 *   labels them, and levels are empty
 */
export const gateToggles = (gates: Iterable<DynamicGate>): Map<string, SceneToggleInfo> => {
	const all = [...gates];
	const assumed = new Map<string, number>();
	for (const gate of all) {
		if (gate.kind !== 'mission') {
			const id = variableId(gate);
			assumed.set(id, Math.max(assumed.get(id) ?? gate.value, gate.value));
		}
	}
	const toggles = new Map<string, SceneToggleInfo>();
	for (const gate of all) {
		const id = gateControl(gate);
		if (toggles.has(id)) {
			continue;
		}
		if (gate.kind === 'mission') {
			const condition = missionCondition(gate);
			toggles.set(id, {
				id,
				name: describe(condition),
				kind: 'mission',
				levelTags: [],
				defaultEnabled: evaluate(condition),
				condition: `loads while ${describe(condition)}; default: story finished`,
			});
			continue;
		}
		const value = assumed.get(variableId(gate)) ?? gate.value;
		const condition: SceneCondition =
			gate.kind === 'globalVar'
				? { kind: 'globalVar', name: `#${gate.key}`, compare: operator(gate.compare), target: gate.value }
				: {
						kind: 'mapVar',
						mapId: String(gate.mapId),
						name: `#${gate.key} (map ${gate.mapId})`,
						compare: operator(gate.compare),
						target: gate.value,
					};
		toggles.set(id, {
			id,
			name: describe(condition),
			kind: 'variable',
			levelTags: [],
			defaultEnabled: evaluate(condition, value),
			condition: `loads while ${describe(condition)}; default: variable assumed ${value}, the highest value the scene compares it against`,
		});
	}
	return toggles;
};

const variableId = (gate: Extract<DynamicGate, { kind: 'globalVar' | 'mapVar' }>): string =>
	gate.kind === 'globalVar' ? `globalVar:${gate.key}` : `mapVar:${gate.mapId}:${gate.key}`;

const missionCondition = (gate: Extract<DynamicGate, { kind: 'mission' }>): SceneCondition => ({
	kind: gate.all ? 'all' : 'any',
	reverse: !gate.loadWhen,
	conditions: gate.conditions.map(({ id, isQuest, state, same }) =>
		isQuest
			? { kind: 'quest', questId: id, compare: same ? 0 : 1, target: state }
			: { kind: 'mission', missionId: id, compare: same ? 0 : 1, target: state },
	),
});

const operator = (value: number): CompareOperator => {
	switch (value) {
		case 0:
		case 1:
		case 2:
		case 3:
		case 4:
		case 5: {
			return value;
		}
		default: {
			throw new RangeError(`compare operator ${value}`);
		}
	}
};
