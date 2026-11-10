import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';

import type { Context } from '../../context.ts';
import type { PrefabPose } from '../prefabs/prefab.ts';

import {
	type ModelViews,
	readViewStates,
	records,
	statesPose,
	text,
	type ViewStateRecord,
} from './view-state-poses.ts';

// a door's open and closed poses, from its model's view states. which states are the open and closed ones:
// docs/game-data/interactives.md#interactive-doors

/** the open and closed looks of a door model */
export interface DoorPoses {
	/** the view states' names, for labels */
	openState: string;
	closedState: string;
	open: PrefabPose;
	closed: PrefabPose;
}

/** a state is settled when nothing moves it on by itself: each of its transitions waits on a condition */
const settled = (state: ViewStateRecord): boolean =>
	state.isHaveClip === true &&
	records(state.transitions).every((transition) => {
		const group = transition.conditionGroup;
		return (
			group !== null &&
			typeof group === 'object' &&
			!Array.isArray(group) &&
			records(group.conditions).length > 0
		);
	});

/**
 * @param context install readers and the bundle resolver
 * @param model a ModelTable model and the model whose view states it uses
 * @returns the model's door poses, or `null` when it has no view states or none is an open idle state
 * @throws {FormatError} if the view states are ambiguous (several open states, no way back to a closed one)
 *   or a clip can't be found or read
 */
export const readDoorPoses = async (
	context: Pick<Context, 'vfs' | 'world' | 'resolver' | 'memoryPack'>,
	model: ModelViews,
): Promise<DoorPoses | null> => {
	const states = await readViewStates(context, model);
	if (states === null) {
		return null;
	}
	const found: { animator: string | null; states: Map<string, ViewStateRecord>; open: ViewStateRecord }[] =
		[];
	for (const animator of records(states.data.modelAnimatorDatas)) {
		const name = text(animator.modelName);
		for (const layer of records(animator.layerFsmDatas)) {
			const byName = new Map(records(layer.stateDatas).map((state) => [text(state.stateName) ?? '', state]));
			for (const state of byName.values()) {
				if (settled(state) && /openidle/i.test(text(state.animationClipName) ?? '')) {
					found.push({ animator: name === '$$ROOT$$' ? null : name, states: byName, open: state });
				}
			}
		}
	}
	if (found.length === 0) {
		return null;
	}
	if (found.length > 1) {
		throw new FormatError(`${states.path} has ${found.length} open idle states`);
	}
	const [{ animator, states: byName, open }] = found;
	// the open state leaves on a condition, then plays through unconditional states to the closed one
	let closed: ViewStateRecord | undefined;
	{
		const [leave] = records(open.transitions);
		let state = byName.get(text(leave?.targetStateName) ?? '');
		for (let hops = 0; state !== undefined && hops < 8; hops++) {
			if (settled(state)) {
				closed = state;
				break;
			}
			const onward = records(state.transitions);
			state = onward.length === 1 ? byName.get(text(onward[0].targetStateName) ?? '') : undefined;
		}
	}
	if (closed === undefined || records(open.transitions).length !== 1) {
		throw new FormatError(`${states.path} has no single way from its open state back to a closed one`);
	}
	const pose = (state: ViewStateRecord): Promise<PrefabPose> =>
		statesPose(context, states, text(state.stateName) ?? '', [{ animator, states: [state] }]);
	return {
		openState: text(open.stateName) ?? '',
		closedState: text(closed.stateName) ?? '',
		open: await pose(open),
		closed: await pose(closed),
	};
};
