import { useId, useState } from 'react';

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
	const volumes = manifest.environmentVolumes
		.map((volume, id) => ({ volume, id }))
		.filter(({ volume }) => (volume.level === 0 || volume.level === level?.tag) && matches(volume.name));
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
			{(['script', 'state'] as const).map((kind) => (
				<details key={kind}>
					<summary>
						{kind === 'script' ? 'Script / event scenery' : 'Scene-state previews'} (
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
					Preview activation is manual. Enabled volumes still follow camera bounds and priority. A pinned
					phase overrides these choices.
				</p>
				{volumes.map(({ volume, id }) => (
					<label className="toggle scene-toggle" key={id}>
						<input
							type="checkbox"
							disabled={volume.phase === null}
							checked={viewer.options.environmentEnabled[id] ?? volume.blendMode !== 3}
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
							</small>
						</span>
					</label>
				))}
			</details>
		</section>
	);
};
