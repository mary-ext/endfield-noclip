import { useId, useState } from 'react';

import { volumeReaches } from '../render/environment-blend.ts';
import type { Viewer } from '../viewer.ts';

import { useViewerState } from './use-viewer.ts';

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
	const progressions = manifest.states.progressions.filter(
		(entry) => (entry.levelId === null || entry.levelId === viewer.level) && matches(entry.name ?? entry.key),
	);
	const toggles = manifest.states.toggles.filter(
		(entry) =>
			(entry.levels.includes(0) || entry.levels.includes(level?.tag ?? 0)) &&
			matches(`${entry.name} ${entry.id}`),
	);
	// volumes apply wherever they hold the camera, so a neighbour's volume reaching into this level is listed too
	const volumes = manifest.environmentVolumes
		.map((volume, id) => ({ volume, id }))
		.filter(
			({ volume }) =>
				(volume.level === 0 ||
					volume.level === level?.tag ||
					(level !== undefined && volumeReaches(volume, level.rect))) &&
				matches(volume.name),
		);
	const levelNames = new Map(manifest.levels.map((entry) => [entry.tag, entry.name ?? entry.id]));
	const toggleNames = new Map(manifest.states.toggles.map((entry) => [entry.id, entry.name]));
	/** @returns the scene states a volume loads with, by name */
	const loadingStates = (condition: number): string =>
		[
			...new Set(
				manifest.states.conditionalSets[condition].alternatives.flatMap((requirements) =>
					requirements.map(({ control }) => toggleNames.get(control) ?? control),
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
			<details open>
				<summary>Progression ({progressions.length})</summary>
				{progressions.map((entry) => (
					<label className="scene-choice" key={entry.id}>
						<span>
							{entry.name ?? entry.key}
							<small className="muted">{entry.kind}</small>
						</span>
						<select
							value={viewer.sceneValues[entry.id]}
							onChange={(event) => viewer.setSceneValue(entry.id, Number(event.currentTarget.value))}
						>
							{entry.levels.map((value) => (
								<option key={value} value={value}>
									{entry.kind === 'facility' ? 'Visual form' : 'Level'} {value}
									{value === entry.defaultLevel ? ' (initial)' : ''}
								</option>
							))}
						</select>
					</label>
				))}
				{progressions.length === 0 && <p className="muted">No matching progression controls.</p>}
			</details>
			<details open>
				<summary>Scene states ({toggles.filter((entry) => entry.kind === 'sceneState').length})</summary>
				<p className="muted small">
					The game switches these by quest progress. Defaults assume the story is finished; states without a
					condition are only set by dungeons and scripts.
				</p>
				{toggles
					.filter((entry) => entry.kind === 'sceneState')
					.map((entry) => (
						<label className="toggle scene-toggle" key={entry.id}>
							<input
								type="checkbox"
								checked={viewer.sceneValues[entry.id] === 1}
								onChange={(event) => viewer.setSceneValue(entry.id, Number(event.currentTarget.checked))}
							/>
							<span>
								{entry.name}
								<small className="muted">{entry.condition}</small>
							</span>
						</label>
					))}
			</details>
			{(['script', 'state'] as const).map((kind) => (
				<details key={kind}>
					<summary>
						{kind === 'script' ? 'Script / event scenery' : 'Logic-gate previews'} (
						{toggles.filter((entry) => entry.kind === kind).length})
					</summary>
					<p className="muted small">Manual previews; runtime conditions are unavailable.</p>
					{toggles
						.filter((entry) => entry.kind === kind)
						.map((entry) => (
							<label className="toggle scene-toggle" key={entry.id}>
								<input
									type="checkbox"
									checked={viewer.sceneValues[entry.id] === 1}
									onChange={(event) => viewer.setSceneValue(entry.id, Number(event.currentTarget.checked))}
								/>
								<span>
									{entry.name}
									<small className="muted">
										{entry.id} · initially {entry.defaultEnabled ? 'on' : 'off'}
									</small>
								</span>
							</label>
						))}
				</details>
			))}
			<details>
				<summary>Lighting / environment volumes ({volumes.length})</summary>
				<p className="muted small">
					Volumes follow the scene states that load them; ticking one here overrides that. Enabled volumes
					still follow camera bounds and priority. A pinned phase overrides these choices.
				</p>
				{volumes.map(({ volume, id }) => (
					<label className="toggle scene-toggle" key={id}>
						<input
							type="checkbox"
							disabled={volume.phase === null}
							checked={
								viewer.options.environmentEnabled[id] ??
								(volume.blendMode !== 3 &&
									(volume.condition === null || viewer.conditionResults[volume.condition]))
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
								{volume.condition !== null && ` · with ${loadingStates(volume.condition)}`}
								{volume.level !== 0 &&
									volume.level !== level?.tag &&
									` · from ${levelNames.get(volume.level) ?? `level ${volume.level}`}`}
							</small>
						</span>
					</label>
				))}
			</details>
		</section>
	);
};
