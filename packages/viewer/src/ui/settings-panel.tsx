import { useId } from 'react';

import type { Viewer, ViewerOptions } from '../viewer.ts';

import { useViewerState } from './use-viewer.ts';

const HLOD_TIERS = [0, 1, 2] as const;

type BooleanKey = {
	[K in keyof ViewerOptions]: ViewerOptions[K] extends boolean ? K : never;
}[keyof ViewerOptions];

const Toggle = ({ viewer, name, label }: { viewer: Viewer; name: BooleanKey; label: string }) => (
	<label className="toggle">
		<input
			type="checkbox"
			checked={viewer.options[name]}
			onChange={(event) => viewer.setOptions({ [name]: event.currentTarget.checked })}
		/>
		{label}
	</label>
);

const Slider = ({
	viewer,
	name,
	label,
	min,
	max,
	step,
	unit,
}: {
	viewer: Viewer;
	name: 'maxSse' | 'terrainPixels' | 'minBoxPixels' | 'outlineMetres' | 'budgetMiB';
	label: string;
	min: number;
	max: number;
	step: number;
	unit: string;
}) => {
	const id = useId();
	return (
		<div className="slider">
			<label htmlFor={id}>{label}</label>
			<input
				id={id}
				type="range"
				min={min}
				max={max}
				step={step}
				value={viewer.options[name]}
				onChange={(event) => viewer.setOptions({ [name]: Number(event.currentTarget.value) })}
			/>
			<output htmlFor={id}>
				{viewer.options[name]} {unit}
			</output>
		</div>
	);
};

/** layer toggles and quality sliders */
export const SettingsPanel = ({ viewer }: { viewer: Viewer }) => {
	useViewerState(viewer);
	const tiers = viewer.options.hlodTiers;
	const setTier = (tier: number, on: boolean): void => {
		const next: [boolean, boolean, boolean] = [...tiers];
		next[tier] = on;
		viewer.setOptions({ hlodTiers: next });
	};
	return (
		<section className="panel settings" aria-label="display settings">
			<fieldset>
				<legend>layers</legend>
				<Toggle viewer={viewer} name="terrain" label="terrain" />
				<Toggle viewer={viewer} name="instances" label="instances" />
				<Toggle viewer={viewer} name="boxes" label="boxes" />
				<Toggle viewer={viewer} name="detail" label="detail" />
				<Toggle viewer={viewer} name="resident" label="resident" />
				<Toggle viewer={viewer} name="wireframe" label="wireframe" />
			</fieldset>
			<fieldset>
				<legend>HLOD tiers</legend>
				{HLOD_TIERS.map((tier) => (
					<label className="toggle" key={tier}>
						<input
							type="checkbox"
							checked={tiers[tier]}
							onChange={(event) => setTier(tier, event.currentTarget.checked)}
						/>
						tier {tier}
					</label>
				))}
			</fieldset>
			<fieldset>
				<legend>colour by</legend>
				{(['tier', 'level'] as const).map((mode) => (
					<label className="toggle" key={mode}>
						<input
							type="radio"
							name="colour-by"
							checked={viewer.options.colourBy === mode}
							onChange={() => viewer.setOptions({ colourBy: mode })}
						/>
						{mode}
					</label>
				))}
			</fieldset>
			<Slider viewer={viewer} name="maxSse" label="HLOD error" min={1} max={64} step={1} unit="px" />
			<Slider
				viewer={viewer}
				name="terrainPixels"
				label="terrain error"
				min={0.5}
				max={16}
				step={0.5}
				unit="px"
			/>
			<Slider
				viewer={viewer}
				name="minBoxPixels"
				label="small-box cull"
				min={0}
				max={16}
				step={0.5}
				unit="px"
			/>
			<Slider
				viewer={viewer}
				name="outlineMetres"
				label="outline above"
				min={10}
				max={1000}
				step={10}
				unit="m"
			/>
			<Slider
				viewer={viewer}
				name="budgetMiB"
				label="memory budget"
				min={16}
				max={1024}
				step={16}
				unit="MiB"
			/>
			<Toggle viewer={viewer} name="continuous" label="render every frame" />
		</section>
	);
};
