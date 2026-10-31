import type {
	ControlDriver,
	MissionInfo,
	SceneControl,
	SceneControlKind,
} from '@endfield-noclip/package-format/states';
import {
	storyOrder,
	storyPointPicks,
	storyPoints,
	type StoryPoint,
} from '@endfield-noclip/package-format/story';

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

/** @returns a driver in words: what it does to the group, and why */
const driverText = (driver: ControlDriver): string => {
	const verb = driver.shows === null ? 'Set' : driver.shows ? 'Shown' : 'Hidden';
	switch (driver.kind) {
		case 'quest': {
			const quests = driver.quests.map((quest) =>
				quest.mission === null
					? quest.id
					: quest.name === null
						? quest.mission
						: `${quest.mission}: ${quest.name}`,
			);
			return `${verb} by quest progress: ${quests.join('; ')}`;
		}
		case 'switch': {
			return `${verb} when the player uses ${driver.template ?? 'an interactive'}`;
		}
		case 'area': {
			return `${verb} when the player enters an area (${Math.round(driver.radius)} m)`;
		}
		case 'script': {
			return `${verb} while its level script runs${driver.radius === null ? '' : ` (area ${Math.round(driver.radius)} m)`}`;
		}
		case 'level': {
			return `${verb} by ${driver.name ?? driver.levelId}, another level reusing the map`;
		}
		case 'server': {
			return `${verb} by script stages or server events`;
		}
	}
};

/** what sets a script group in game, with a button to fly to each place it starts from */
const Drivers = ({ viewer, drivers }: { viewer: Viewer; drivers: readonly ControlDriver[] }) => {
	if (drivers.length === 0) {
		return null;
	}
	return (
		<ul className="drivers">
			{drivers.map((driver) => {
				const position = 'position' in driver ? driver.position : null;
				const radius = 'radius' in driver ? (driver.radius ?? 20) : 20;
				return (
					<li key={JSON.stringify(driver)}>
						{driverText(driver)}
						{position !== null && (
							<button type="button" onClick={() => viewer.flyToPoint(position, Math.min(radius, 120) * 1.5)}>
								Go
							</button>
						)}
					</li>
				);
			})}
		</ul>
	);
};

/** kinds whose controls are plain on/off switches */
const SWITCH_KINDS: ReadonlySet<SceneControlKind> = new Set(['sceneState', 'script', 'logic']);

/**
 * a scene control: a checkbox for an on/off switch only the user sets, otherwise a select. derived controls
 * and stream areas offer to follow the game or the camera
 */
const ControlRow = ({
	viewer,
	control,
	describe,
}: {
	viewer: Viewer;
	control: SceneControl;
	/** rewrites a rule's quest and mission ids as their names */
	describe: (rule: string) => string;
}) => {
	const value = viewer.sceneValues[control.id] ?? control.default;
	const picked = control.id in viewer.scenePicks;
	const label = (entry: number): string =>
		control.values.find((candidate) => candidate.value === entry)?.label ?? String(entry);
	const detail = [control.rule && describe(control.rule), control.assumption].filter(Boolean).join(' · ');
	const follows = control.kind === 'area' ? 'Follow camera' : control.derived === null ? null : 'Follow game';
	if (follows === null && SWITCH_KINDS.has(control.kind)) {
		return (
			<div>
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
				<Drivers viewer={viewer} drivers={control.drivers} />
			</div>
		);
	}
	return (
		<div>
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
			<Drivers viewer={viewer} drivers={control.drivers} />
		</div>
	);
};

/** quest log tabs in the game's order */
const CATEGORIES: { category: MissionInfo['category']; title: string }[] = [
	{ category: 'main', title: 'Main story' },
	{ category: 'side', title: 'Side and character' },
	{ category: 'discovery', title: 'Discovery' },
	{ category: 'activity', title: 'Events' },
	{ category: 'other', title: 'Other' },
];

/** @returns a mission's controls: the mission first, then quests by step, steps before unnumbered ones */
const ordered = (entries: readonly SceneControl[]): SceneControl[] =>
	entries.toSorted(
		(a, b) =>
			Number(a.kind !== 'mission') - Number(b.kind !== 'mission') ||
			(a.story?.step ?? Number.MAX_SAFE_INTEGER) - (b.story?.step ?? Number.MAX_SAFE_INTEGER) ||
			a.id.localeCompare(b.id),
	);

/**
 * a select over story points: each sets every quest and mission control of the given missions consistently
 *
 * @param props.listed the controls listed for the shown level, which decide the points offered
 * @param props.all every control of the package, which the picks cover
 */
const StoryProgress = ({
	viewer,
	label,
	order,
	listed,
	all,
	missions,
	finished,
}: {
	viewer: Viewer;
	label: string;
	/** mission ids in story order */
	order: readonly string[];
	listed: readonly SceneControl[];
	all: readonly SceneControl[];
	missions: ReadonlyMap<string, MissionInfo>;
	/** the label of the finished point */
	finished: string;
}) => {
	const points: { key: string; point: StoryPoint; text: string }[] = [
		{ key: 'none', point: { mission: -1, step: 0 }, text: 'not started' },
		...storyPoints(listed, order).map(({ point, mission, quest }) => {
			const name = (order.length > 1 && missions.get(mission)?.name) || null;
			const step = quest === null ? 'started' : quest.name;
			return {
				key: point === null ? 'done' : `${point.mission}:${point.step}`,
				point,
				text: point === null ? finished : name === null ? step : `${name}: ${step}`,
			};
		}),
	];
	// the point whose picks the current values match, if any
	const current = points.findIndex(({ point }) =>
		Object.entries(storyPointPicks(all, order, point)).every(
			([id, value]) =>
				(viewer.sceneValues[id] ?? 3) === (value ?? all.find((entry) => entry.id === id)?.default ?? 3),
		),
	);
	return (
		<label className="scene-choice">
			<span>
				{label}
				<small className="muted">sets the quests below to that point; story finished by default</small>
			</span>
			<select
				value={current}
				onChange={(event) => {
					const point = points[Number(event.currentTarget.value)]?.point;
					if (point !== undefined) {
						viewer.setSceneValues(storyPointPicks(all, order, point));
					}
				}}
			>
				{current === -1 && <option value={-1}>(mixed)</option>}
				{points.map(({ key, text }, index) => (
					<option key={key} value={index}>
						{text}
					</option>
				))}
			</select>
		</label>
	);
};

/** quest and mission controls grouped by quest log tab and mission, with progress selects over their steps */
const StoryControls = ({
	viewer,
	controls,
	all,
	missions,
	describe,
	levelName,
}: {
	viewer: Viewer;
	controls: readonly SceneControl[];
	/** every control of the package */
	all: readonly SceneControl[];
	missions: ReadonlyMap<string, MissionInfo>;
	describe: (rule: string) => string;
	/** a level id's display name */
	levelName: (id: string) => string;
}) => {
	const grouped = new Map<string | null, SceneControl[]>();
	for (const control of controls) {
		const mission = control.story?.mission ?? null;
		grouped.set(mission, [...(grouped.get(mission) ?? []), control]);
	}
	const rows = (entries: readonly SceneControl[]) =>
		ordered(entries).map((entry) => (
			<ControlRow key={entry.id} viewer={viewer} control={entry} describe={describe} />
		));
	const unplaced = grouped.get(null) ?? [];
	// the main story's episodes and missions run in one line
	const mainLine = [...missions.values()]
		.filter((mission) => mission.category === 'main' && storyOrder(mission.id) !== null)
		.map((mission) => mission.id)
		.toSorted((a, b) => {
			const [ae, am] = storyOrder(a)!;
			const [be, bm] = storyOrder(b)!;
			return ae - be || am - bm;
		});
	return (
		<>
			{mainLine.some((id) => grouped.has(id)) && (
				<StoryProgress
					viewer={viewer}
					label="Main story progress"
					order={mainLine}
					listed={controls}
					all={all}
					missions={missions}
					finished="main story finished"
				/>
			)}
			{CATEGORIES.map(({ category, title }) => {
				const listed = [...missions.values()].filter(
					(mission) => mission.category === category && grouped.has(mission.id),
				);
				if (listed.length === 0) {
					return null;
				}
				return (
					<section key={category} className="story-category">
						<h3>{title}</h3>
						{listed.map((mission) => (
							<details key={mission.id} className="story-mission">
								<summary>
									{mission.name ?? mission.id}
									<small className="muted">
										{[
											mission.levelId && `takes place in ${levelName(mission.levelId)}`,
											mission.chapter,
											mission.episode,
											mission.name && mission.id,
										]
											.filter(Boolean)
											.join(' · ')}
									</small>
								</summary>
								<StoryProgress
									viewer={viewer}
									label="Progress"
									order={[mission.id]}
									listed={controls}
									all={all}
									missions={missions}
									finished="completed"
								/>
								<details>
									<summary>Quests ({grouped.get(mission.id)?.length ?? 0})</summary>
									{rows(grouped.get(mission.id) ?? [])}
								</details>
							</details>
						))}
					</section>
				);
			})}
			{unplaced.length > 0 && (
				<section className="story-category">
					<h3>Not in this client</h3>
					{rows(unplaced)}
				</section>
			)}
		</>
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
	const missions = new Map(manifest.states.missions.map((mission) => [mission.id, mission]));
	const byId = new Map(manifest.states.controls.map((entry) => [entry.id, entry]));
	/** @returns a quest or mission control's name with its mission's, else the control's name */
	const storyName = (control: SceneControl): string => {
		const mission = control.story && missions.get(control.story.mission);
		if (!mission?.name || control.kind === 'mission') {
			return control.name;
		}
		return `${mission.name}: ${control.name}`;
	};
	const describe = (rule: string): string =>
		rule.replaceAll(/\b(quest|mission) (\S+)/g, (whole, kind: string, id: string) => {
			const control = byId.get(`${kind}:${id}`);
			return control?.story ? `“${storyName(control)}”` : whole;
		});
	// a control is listed for the levels whose content it gates
	const controls = manifest.states.controls.filter(
		(entry) =>
			(level === undefined || entry.levelTags.includes(0) || entry.levelTags.includes(level.tag)) &&
			matches(`${storyName(entry)} ${entry.id} ${entry.rule ? describe(entry.rule) : ''}`),
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
						{kinds.includes('quest') ? (
							<StoryControls
								viewer={viewer}
								controls={listed}
								all={manifest.states.controls}
								missions={missions}
								describe={describe}
								levelName={(id) => manifest.levels.find((entry) => entry.id === id)?.name ?? id}
							/>
						) : (
							listed.map((entry) => (
								<ControlRow key={entry.id} viewer={viewer} control={entry} describe={describe} />
							))
						)}
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
