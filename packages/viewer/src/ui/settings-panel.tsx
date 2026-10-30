import { useId } from 'react';

import { DEBUG_VIEWS } from '../render/frame-uniforms.ts';
import { TONEMAPPERS } from '../render/post-process.ts';
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
	name:
		| 'maxSse'
		| 'terrainPixels'
		| 'minBoxPixels'
		| 'outlineMetres'
		| 'budgetMiB'
		| 'textureBias'
		| 'exposure'
		| 'renderScale';
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

const Choice = <K extends 'tonemapper' | 'debugView'>({
	viewer,
	name,
	label,
	choices,
}: {
	viewer: Viewer;
	name: K;
	label: string;
	choices: readonly ViewerOptions[K][];
}) => {
	const id = useId();
	return (
		<div className="slider">
			<label htmlFor={id}>{label}</label>
			<select
				id={id}
				value={viewer.options[name]}
				onChange={(event) => {
					const value = choices.find((choice) => choice === event.currentTarget.value);
					if (value !== undefined) {
						viewer.setOptions({ [name]: value });
					}
				}}
			>
				{choices.map((choice) => (
					<option key={choice} value={choice}>
						{choice}
					</option>
				))}
			</select>
		</div>
	);
};

/** the environment volumes in effect at the camera, and a picker to pin one phase instead */
const EnvironmentControls = ({ viewer }: { viewer: Viewer }) => {
	const pinId = useId();
	const phases = viewer.environmentPhases();
	const pinned = viewer.options.environmentPin;
	return (
		<fieldset>
			<legend>environment</legend>
			<Toggle viewer={viewer} name="environmentVolumes" label="volumes at camera" />
			<div className="slider">
				<label htmlFor={pinId}>pin</label>
				<select
					id={pinId}
					value={pinned ?? ''}
					onChange={(event) => {
						const value = event.currentTarget.value;
						viewer.setOptions({ environmentPin: value === '' ? null : Number(value) });
					}}
				>
					<option value="">none</option>
					{phases.map(({ index, name }) => (
						<option key={index} value={index}>
							{name}
						</option>
					))}
				</select>
			</div>
			<ol className="applied-volumes">
				{viewer.appliedVolumes.map(({ id, name, phase, factor }) => (
					<li key={id} title={name}>
						{phase}
						{factor < 1 ? ` · ${Math.round(factor * 100)}%` : ''}
					</li>
				))}
			</ol>
		</fieldset>
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
				<Toggle viewer={viewer} name="terrainSurface" label="terrain textures" />
				<Toggle viewer={viewer} name="terrainSplat" label="terrain splat layers" />
				<Toggle viewer={viewer} name="instances" label="instances" />
				<Toggle viewer={viewer} name="boxes" label="boxes" />
				<Toggle viewer={viewer} name="detail" label="detail" />
				<Toggle viewer={viewer} name="global" label="global scenery" />
				<Toggle viewer={viewer} name="streamAreas" label="stream areas at camera" />
				<Toggle viewer={viewer} name="wireframe" label="wireframe" />
			</fieldset>
			<fieldset>
				<legend>look{viewer.environmentName === null ? '' : ` · ${viewer.environmentName}`}</legend>
				<Toggle viewer={viewer} name="sky" label="sky" />
				<Toggle viewer={viewer} name="heightFog" label="height and volumetric fog" />
				<Toggle viewer={viewer} name="atmosphereFog" label="atmosphere fog" />
				<Toggle viewer={viewer} name="shadows" label="shadows" />
				<Toggle viewer={viewer} name="water" label="water" />
				<Toggle viewer={viewer} name="ao" label="ambient occlusion" />
				<Toggle viewer={viewer} name="reflections" label="screen-space reflections" />
				<Toggle viewer={viewer} name="bloom" label="bloom" />
				<Toggle viewer={viewer} name="vignette" label="vignette" />
				<Toggle viewer={viewer} name="autoExposure" label="auto exposure" />
				<Toggle viewer={viewer} name="irradiance" label="irradiance volume" />
				<Toggle viewer={viewer} name="localLights" label="local lights" />
				<Toggle viewer={viewer} name="antialiasing" label="temporal AA" />
			</fieldset>
			<EnvironmentControls viewer={viewer} />
			<Slider viewer={viewer} name="exposure" label="exposure" min={-4} max={4} step={0.25} unit="EV" />
			<Slider
				viewer={viewer}
				name="renderScale"
				label="render scale"
				min={0.5}
				max={1}
				step={0.05}
				unit="×"
			/>
			<Choice viewer={viewer} name="tonemapper" label="tonemapper" choices={TONEMAPPERS} />
			<Choice viewer={viewer} name="debugView" label="show" choices={DEBUG_VIEWS} />
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
				min={64}
				max={2048}
				step={64}
				unit="MiB"
			/>
			<Slider
				viewer={viewer}
				name="textureBias"
				label="texture mip drop"
				min={0}
				max={2}
				step={1}
				unit="levels"
			/>
			<Toggle viewer={viewer} name="continuous" label="render every frame" />
		</section>
	);
};
