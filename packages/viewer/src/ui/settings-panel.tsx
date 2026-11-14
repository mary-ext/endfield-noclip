import { useId } from 'react';

import { DEBUG_VIEWS } from '../render/frame/debug-views.ts';
import { TONEMAPPERS } from '../render/post/settings.ts';
import type { ViewerOptions } from '../viewer/options.ts';
import type { Viewer } from '../viewer/viewer.ts';

import { Checkbox } from './controls.tsx';
import { useViewerEnvironment, useViewerState, useViewerStats } from './use-viewer.ts';

const HLOD_TIERS = [0, 1, 2] as const;

/** the options whose values are `T`s */
type OptionKey<T> = {
	[K in keyof ViewerOptions]: ViewerOptions[K] extends T ? K : never;
}[keyof ViewerOptions];

const Toggle = ({ viewer, name, label }: { viewer: Viewer; name: OptionKey<boolean>; label: string }) => (
	<Checkbox checked={viewer.options[name]} onChange={(checked) => viewer.setOptions({ [name]: checked })}>
		{label}
	</Checkbox>
);

/** a label and a select over `options`, calling `onChange` with the picked option's value */
const Select = ({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: string;
	options: readonly { value: string; label: string }[];
	onChange: (value: string) => void;
}) => {
	const id = useId();
	return (
		<div className="slider">
			<label htmlFor={id}>{label}</label>
			<select id={id} value={value} onChange={(event) => onChange(event.currentTarget.value)}>
				{options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		</div>
	);
};

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
	name: OptionKey<number>;
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

const Choice = <K extends OptionKey<string>>({
	viewer,
	name,
	label,
	choices,
}: {
	viewer: Viewer;
	name: K;
	label: string;
	choices: readonly ViewerOptions[K][];
}) => (
	<Select
		label={label}
		value={viewer.options[name]}
		options={choices.map((choice) => ({ value: choice, label: choice }))}
		onChange={(text) => {
			const value = choices.find((choice) => choice === text);
			if (value !== undefined) {
				viewer.setOptions({ [name]: value });
			}
		}}
	/>
);

/** the environment volumes in effect at the camera, re-rendered on their own as the camera moves */
const AppliedVolumes = ({ viewer }: { viewer: Viewer }) => {
	useViewerEnvironment(viewer);
	return (
		<ol className="applied-volumes">
			{viewer.appliedVolumes.map(({ id, name, phase, factor }) => (
				<li key={id} title={name}>
					{phase}
					{factor < 1 ? ` · ${Math.round(factor * 100)}%` : ''}
				</li>
			))}
		</ol>
	);
};

/** the look section's legend, naming the environment profile at the camera */
const LookLegend = ({ viewer }: { viewer: Viewer }) => {
	useViewerEnvironment(viewer);
	return <legend>look{viewer.environmentName === null ? '' : ` · ${viewer.environmentName}`}</legend>;
};

/** the environment volumes in effect at the camera, and a picker to pin one phase instead */
const EnvironmentControls = ({ viewer }: { viewer: Viewer }) => {
	const pinned = viewer.options.environmentPin;
	return (
		<fieldset>
			<legend>environment</legend>
			<Toggle viewer={viewer} name="environmentVolumes" label="volumes at camera" />
			<Select
				label="pin"
				value={pinned === null ? '' : String(pinned)}
				options={[
					{ value: '', label: 'none' },
					...viewer.environmentPhases().map(({ index, name }) => ({ value: String(index), label: name })),
				]}
				onChange={(value) => viewer.setOptions({ environmentPin: value === '' ? null : Number(value) })}
			/>
			<AppliedVolumes viewer={viewer} />
		</fieldset>
	);
};

/** how many gaps {@link GapsLegend} lists */
const GAPS_LISTED = 12;

/**
 * the gaps view's legend: what the striped meshes in view are drawn without, nearest first, refreshed with
 * the stats
 */
const GapsLegend = ({ viewer }: { viewer: Viewer }) => {
	useViewerStats(viewer);
	const gaps = viewer.gapsInView();
	if (gaps.length === 0) {
		return <p className="applied-volumes">no drawn material has a known gap</p>;
	}
	return (
		<ol className="applied-volumes">
			{gaps.slice(0, GAPS_LISTED).map(({ gap, materials, nearest }) => (
				<li key={gap} title={`${materials} materials in view`}>
					{gap} · {Math.max(Math.round(nearest), 0)} m
				</li>
			))}
			{gaps.length > GAPS_LISTED ? <li>and {gaps.length - GAPS_LISTED} more</li> : null}
		</ol>
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
				<Toggle viewer={viewer} name="unsupportedMaterials" label="unsupported materials" />
				<Toggle viewer={viewer} name="missingContent" label="missing content" />
				<Toggle viewer={viewer} name="detail" label="detail" />
				<Toggle viewer={viewer} name="global" label="global scenery" />
				<Toggle viewer={viewer} name="streamAreas" label="stream areas at camera" />
				<Toggle viewer={viewer} name="wireframe" label="wireframe" />
			</fieldset>
			<fieldset>
				<LookLegend viewer={viewer} />
				<Toggle viewer={viewer} name="sky" label="sky" />
				<Toggle viewer={viewer} name="heightFog" label="height and volumetric fog" />
				<Toggle viewer={viewer} name="atmosphereFog" label="atmosphere fog" />
				<Toggle viewer={viewer} name="flowNoise" label="drifting fog" />
				<Toggle viewer={viewer} name="shadows" label="shadows" />
				<Toggle viewer={viewer} name="cloudShadows" label="cloud shadows" />
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
			{viewer.options.debugView === 'gaps' ? <GapsLegend viewer={viewer} /> : null}
			<fieldset>
				<legend>HLOD tiers</legend>
				{HLOD_TIERS.map((tier) => (
					<Checkbox key={tier} checked={tiers[tier]} onChange={(checked) => setTier(tier, checked)}>
						tier {tier}
					</Checkbox>
				))}
			</fieldset>
			<Slider
				viewer={viewer}
				name="detailDistance"
				label="detail distance"
				min={64}
				max={1024}
				step={32}
				unit="m"
			/>
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
			<Toggle viewer={viewer} name="animate" label="animate" />
			<Toggle viewer={viewer} name="continuous" label="render every frame" />
		</section>
	);
};
