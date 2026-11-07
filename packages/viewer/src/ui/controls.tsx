/**
 * form rows the panels share.
 *
 * @module
 */

import type { Vec3 } from '@endfield-noclip/package-format/values';

import type { ReactNode } from 'react';

import type { ListedControl } from '../scene-states/listing.ts';
import type { Viewer } from '../viewer/viewer.ts';

import { followLabel } from './format.ts';

/**
 * a checkbox with its label
 *
 * @param props.className the label's classes; `toggle` by default
 * @param props.onChange called with the new checked state
 * @param props.children the label
 */
export const Checkbox = ({
	className = 'toggle',
	checked,
	disabled,
	onChange,
	children,
}: {
	className?: string;
	checked: boolean;
	disabled?: boolean;
	onChange: (checked: boolean) => void;
	children: ReactNode;
}) => (
	<label className={className}>
		<input
			type="checkbox"
			checked={checked}
			disabled={disabled}
			onChange={(event) => onChange(event.currentTarget.checked)}
		/>
		{children}
	</label>
);

/**
 * a scene panel row: a name, an optional detail line under it, and the select (or other input) in `children`
 *
 * @param props.label the row's name
 * @param props.detail a muted line under the name; none when omitted
 */
export const ChoiceRow = ({
	label,
	detail,
	children,
}: {
	label: ReactNode;
	detail?: ReactNode;
	children: ReactNode;
}) => (
	<label className="scene-choice">
		<span>
			{label}
			{detail !== undefined && <small className="muted">{detail}</small>}
		</span>
		{children}
	</label>
);

/**
 * a scene panel checkbox row: a name with a detail line under it
 *
 * @param props.label the row's name
 * @param props.detail a muted line under the name
 * @param props.onChange called with the new checked state
 */
export const SceneToggle = ({
	label,
	detail,
	checked,
	disabled,
	onChange,
}: {
	label: ReactNode;
	detail: ReactNode;
	checked: boolean;
	disabled?: boolean;
	onChange: (checked: boolean) => void;
}) => (
	<Checkbox className="toggle scene-toggle" checked={checked} disabled={disabled} onChange={onChange}>
		<span>
			{label}
			<small className="muted">{detail}</small>
		</span>
	</Checkbox>
);

/**
 * a select over a scene control's values. a control the camera or the game sets offers to follow it, naming
 * the value it follows to; otherwise the default is marked "(initial)"
 *
 * @param viewer the loaded scene
 * @param entry a scene control and its index
 */
export const ControlValueSelect = ({ viewer, entry }: { viewer: Viewer; entry: ListedControl }) => {
	const { index, control } = entry;
	const value = viewer.sceneValues[index] ?? control.default;
	const picked = viewer.scenePicks.has(index);
	const follows = followLabel(control);
	const label = control.values.find((option) => option.value === value)?.label ?? String(value);
	return (
		<select
			value={follows !== null && !picked ? '' : String(value)}
			onChange={(event) => {
				const text = event.currentTarget.value;
				viewer.setSceneValue(index, text === '' ? null : Number(text));
			}}
		>
			{follows !== null && <option value="">{picked ? follows : `${follows} (${label})`}</option>}
			{control.values.map((option) => (
				<option key={option.value} value={option.value}>
					{option.label}
					{follows === null && option.value === control.default ? ' (initial)' : ''}
				</option>
			))}
		</select>
	);
};

/**
 * a "Go" button flying the camera to look at a point
 *
 * @param props.point what to look at
 * @param props.size how big what's there is, in metres; capped at 120 m so large places stay close
 * @param props.back how many sizes back to stand
 */
export const FlyButton = ({
	viewer,
	point,
	size,
	back,
}: {
	viewer: Viewer;
	point: Vec3;
	size: number;
	back: number;
}) => (
	<button type="button" onClick={() => viewer.flyToPoint(point, Math.min(size, 120) * back)}>
		Go
	</button>
);
