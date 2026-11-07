import type { RuleText } from '@endfield-noclip/package-format/states';

import { definite } from '@mary-ext/array-fns';
import type { ReactNode } from 'react';

import { followersOf, type ListedControl } from '../../scene-states/listing.ts';
import type { Viewer } from '../../viewer/viewer.ts';
import { ChoiceRow, ControlValueSelect, FlyButton, SceneToggle } from '../controls.tsx';
import { isToggle, placeSize, ruleOf } from '../format.ts';

import { Drivers } from './drivers.tsx';

/** how many followers a row names before summing up the rest */
const FOLLOWERS_NAMED = 4;

/**
 * the controls that follow a control (derived from it), named with their place; nothing without any
 *
 * @param props.index a scene control's index
 */
const Followers = ({ viewer, index }: { viewer: Viewer; index: number }) => {
	const states = viewer.manifest?.states;
	const followers = states === undefined ? [] : (followersOf(states).get(index) ?? []);
	if (states === undefined || followers.length === 0) {
		return null;
	}
	const named = followers.slice(0, FOLLOWERS_NAMED).map((follower) => {
		const { name, place } = states.controls[follower];
		return place?.label ? `${name} (${place.label})` : name;
	});
	const more = followers.length - named.length;
	return (
		<p className="muted small">
			Drives {named.join(', ')}
			{more > 0 && ` and ${more} more`}
		</p>
	);
};

/**
 * a scene control: a checkbox for an off/on switch only the user sets, otherwise a select. derived and camera
 * controls offer to follow the game or the camera
 *
 * @param props.entry the control and its index
 * @param props.describe a rule in words, its references named
 */
export const ControlRow = ({
	viewer,
	entry,
	describe,
}: {
	viewer: Viewer;
	entry: ListedControl;
	describe: (rule: RuleText) => string;
}) => {
	const { index, control } = entry;
	const rule = ruleOf(control);
	const { place } = control;
	const detail = definite([place?.label, rule && describe(rule), control.assumption]).join(' · ');
	let input: ReactNode;
	if (isToggle(control)) {
		input = (
			<SceneToggle
				label={control.name}
				detail={detail}
				checked={(viewer.sceneValues[index] ?? control.default) === 1}
				onChange={(checked) => viewer.setSceneValue(index, Number(checked))}
			/>
		);
	} else {
		input = (
			<ChoiceRow label={control.name} detail={detail}>
				<ControlValueSelect viewer={viewer} entry={entry} />
			</ChoiceRow>
		);
	}
	return (
		<div>
			{input}
			{place !== null && (
				<FlyButton viewer={viewer} point={place.position} size={placeSize(place)} back={1.5} />
			)}
			<Drivers viewer={viewer} control={control} />
			<Followers viewer={viewer} index={index} />
		</div>
	);
};
