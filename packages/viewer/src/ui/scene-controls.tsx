import type { SceneControl, SceneControlKind } from '@endfield-noclip/package-format/states';

import { useId, useState } from 'react';

import { volumeCondition, volumeLevelTag, volumeReaches } from '../render/environment-blend.ts';
import type { Viewer } from '../viewer.ts';

import { useViewerState } from './use-viewer.ts';

/** panel sections in order, each listing the controls of its kinds */
const SECTIONS: { kinds: SceneControlKind[]; title: string; note: string; open: boolean }[] = [
	{
		kinds: ['sceneState'],
		title: 'Scene states',
		note: 'Each state follows the quests and variables its condition reads unless you pick a value. States without a condition are only set by dungeons and scripts.',
		open: true,
	},
	{
		kinds: ['quest', 'mission'],
		title: 'Quests and missions',
		note: 'The quest states scene states and quest-gated scenery read. Defaults assume the story is finished.',
		open: false,
	},
	{
		kinds: ['mapVar', 'globalVar'],
		title: 'Variables',
		note: 'Server variables the viewer can’t read, by the ranges the scene tells apart. Each is assumed to hold the highest value the scene compares it against.',
		open: false,
	},
	{
		kinds: ['settlement', 'poi', 'factoryRegion', 'facility', 'doodadGroups'],
		title: 'Progression',
		note: 'Outpost, facility and region levels, and visual forms; the initial appearance by default.',
		open: true,
	},
	{
		kinds: ['area'],
		title: 'Stream areas',
		note: 'Interiors, caves and other places the game loads by where the camera is. Each follows the camera unless you pick a value.',
		open: false,
	},
	{
		kinds: ['harvest'],
		title: 'Harvest',
		note: 'Trees the player fells; each tree’s state is the player’s, so one choice previews them all.',
		open: false,
	},
	{
		kinds: ['script'],
		title: 'Script / event scenery',
		note: 'Shown and hidden by level scripts and the server; the authored load default by default.',
		open: false,
	},
	{
		kinds: ['logic'],
		title: 'Logic-gate previews',
		note: 'Logic-state gates with no recovered controller.',
		open: false,
	},
];

/** kinds whose controls are plain on/off switches */
const SWITCH_KINDS: ReadonlySet<SceneControlKind> = new Set(['sceneState', 'script', 'logic']);

/**
 * a scene control: a checkbox for an on/off switch only the user sets, otherwise a select. derived controls
 * and stream areas offer to follow the game or the camera
 */
const ControlRow = ({ viewer, control }: { viewer: Viewer; control: SceneControl }) => {
	const value = viewer.sceneValues[control.id] ?? control.default;
	const picked = control.id in viewer.scenePicks;
	const label = (entry: number): string =>
		control.values.find((candidate) => candidate.value === entry)?.label ?? String(entry);
	const detail = [control.rule, control.assumption].filter(Boolean).join(' · ');
	const follows = control.kind === 'area' ? 'Follow camera' : control.derived === null ? null : 'Follow game';
	if (follows === null && SWITCH_KINDS.has(control.kind)) {
		return (
			<label className="toggle scene-toggle">
				<input
					type="checkbox"
					checked={value === 1}
					onChange={(event) => viewer.setSceneValue(control.id, Number(event.currentTarget.checked))}
				/>
				<span>
					{control.name}
					<small className="muted">{detail}</small>
				</span>
			</label>
		);
	}
	return (
		<label className="scene-choice">
			<span>
				{control.name}
				<small className="muted">{detail}</small>
			</span>
			<select
				value={follows !== null && !picked ? '' : String(value)}
				onChange={(event) => {
					const text = event.currentTarget.value;
					viewer.setSceneValue(control.id, text === '' ? null : Number(text));
				}}
			>
				{follows !== null && <option value="">{picked ? follows : `${follows} (${label(value)})`}</option>}
				{control.values.map((entry) => (
					<option key={entry.value} value={entry.value}>
						{entry.label}
						{follows === null && entry.value === control.default ? ' (initial)' : ''}
					</option>
				))}
			</select>
		</label>
	);
};

/**
 * @param viewer the loaded scene and its preview selections
 * @returns controls for authored progression and manual visibility previews
 */
export const SceneControls = ({ viewer }: { viewer: Viewer }) => {
	useViewerState(viewer);
	const searchId = useId();
	const [query, setQuery] = useState('');
	const manifest = viewer.scene?.pkg.manifest;
	if (!manifest) {
		return null;
	}
	const level = manifest.levels.find((entry) => entry.id === viewer.level);
	const matches = (name: string): boolean => name.toLowerCase().includes(query.toLowerCase());
	// a control is listed for the levels whose content it gates
	const controls = manifest.states.controls.filter(
		(entry) =>
			(level === undefined || entry.levelTags.includes(0) || entry.levelTags.includes(level.tag)) &&
			matches(`${entry.name} ${entry.id} ${entry.rule ?? ''}`),
	);
	// volumes apply wherever they hold the camera, so a neighbour's volume reaching into this level is listed too
	const volumes = manifest.environmentVolumes
		.map((volume, id) => ({
			volume,
			id,
			owner: volumeLevelTag(manifest, volume),
			condition: volumeCondition(manifest, volume),
		}))
		.filter(
			({ volume, owner }) =>
				(owner === 0 || owner === level?.tag || (level !== undefined && volumeReaches(volume, level.rect))) &&
				matches(volume.name),
		);
	const levelNames = new Map(manifest.levels.map((entry) => [entry.tag, entry.name ?? entry.id]));
	const controlNames = new Map(manifest.states.controls.map((entry) => [entry.id, entry.name]));
	/** @returns the scene states a volume loads with, by name */
	const loadingStates = (condition: number): string =>
		[
			...new Set(
				manifest.states.conditionalSets[condition].alternatives.flatMap((requirements) =>
					requirements.map(({ control }) => controlNames.get(control) ?? control),
				),
			),
		].join(' or ');
	return (
		<section className="panel scene-controls" aria-label="scene conditions">
			<header>
				<h2>Scene conditions</h2>
				<button onClick={() => viewer.resetSceneValues()}>Reset</button>
			</header>
			<label className="control-search" htmlFor={searchId}>
				Filter controls
				<input
					id={searchId}
					type="search"
					value={query}
					onChange={(event) => setQuery(event.currentTarget.value)}
				/>
			</label>
			{SECTIONS.map(({ kinds, title, note, open }) => {
				const listed = controls.filter((entry) => kinds.includes(entry.kind));
				return (
					<details key={title} open={open}>
						<summary>
							{title} ({listed.length})
						</summary>
						<p className="muted small">{note}</p>
						{listed.map((entry) => (
							<ControlRow key={entry.id} viewer={viewer} control={entry} />
						))}
					</details>
				);
			})}
			<details>
				<summary>Lighting / environment volumes ({volumes.length})</summary>
				<p className="muted small">
					Volumes follow the scene states that load them; ticking one here overrides that. Enabled volumes
					still follow camera bounds and priority. A pinned phase overrides these choices.
				</p>
				{volumes.map(({ volume, id, owner, condition }) => (
					<label className="toggle scene-toggle" key={id}>
						<input
							type="checkbox"
							disabled={volume.phase === null}
							checked={
								viewer.options.environmentEnabled[id] ??
								(volume.blendMode !== 3 && (condition === null || viewer.conditionResults[condition]))
							}
							onChange={(event) =>
								viewer.setOptions({
									environmentEnabled: {
										...viewer.options.environmentEnabled,
										[id]: event.currentTarget.checked,
									},
								})
							}
						/>
						<span>
							{volume.name}
							<small className="muted">
								{volume.phase === null
									? 'Phase unavailable'
									: volume.blendMode === 3
										? 'Scripted blend · preview at full strength'
										: `Priority ${volume.priority}`}
								{condition !== null && ` · with ${loadingStates(condition)}`}
								{owner !== 0 &&
									owner !== level?.tag &&
									` · from ${levelNames.get(owner) ?? `level ${owner}`}`}
							</small>
						</span>
					</label>
				))}
			</details>
		</section>
	);
};
