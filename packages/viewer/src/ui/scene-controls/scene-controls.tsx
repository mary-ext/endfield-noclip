import { ruleText } from '@endfield-noclip/package-format/conditions';
import type { RuleText, SceneControl } from '@endfield-noclip/package-format/states';

import { useId, useState } from 'react';

import { controlsForLevel, controlsNear, groupByLevel, NEARBY_RADIUS } from '../../scene-states/listing.ts';
import type { Viewer } from '../../viewer/viewer.ts';
import { ChoiceRow } from '../controls.tsx';
import { ruleOf } from '../format.ts';
import { LazyDetails } from '../lazy-details.tsx';
import { useCameraCell, useViewerState } from '../use-viewer.ts';

import { ControlRow } from './control-row.tsx';
import { EnvironmentVolumes } from './environment-volumes.tsx';
import { OtherLevels } from './other-levels.tsx';
import { StoryControls } from './story-controls.tsx';
import { WaterLevels } from './water-levels.tsx';

/** categories listed by sections of their own, which show the content they move */
const OWN_SECTIONS = new Set(['water', 'environment']);

/**
 * which controls the panel lists: those whose content is near the camera, those of the current level (the
 * other levels' grouped below), every control, or the ones the user picked a value for, wherever they are
 */
const SCOPES = ['nearby', 'level', 'all', 'picked'] as const;
type Scope = (typeof SCOPES)[number];

/**
 * @param viewer the loaded scene and its preview selections
 * @returns the package's scene controls, a section per category
 */
export const SceneControls = ({ viewer }: { viewer: Viewer }) => {
	useViewerState(viewer);
	const searchId = useId();
	const [query, setQuery] = useState('');
	const [scope, setScope] = useState<Scope>('nearby');
	useCameraCell(viewer, scope === 'nearby');
	const pkg = viewer.scene?.pkg;
	if (pkg === undefined) {
		return null;
	}
	const { manifest } = pkg;
	const level = viewer.currentLevel;
	const matches = (name: string): boolean => name.toLowerCase().includes(query.toLowerCase());
	const missions = new Map(manifest.states.missions.map((mission) => [mission.id, mission]));
	const byId = new Map(manifest.states.controls.map((entry) => [entry.id, entry]));
	/** @returns a quest control's name with its mission's, else the control's name */
	/** @returns a quest control's name with its mission's, else the control's name */
	const storyName = (control: SceneControl): string => {
		const { story } = control;
		const mission = story && missions.get(story.mission);
		if (!mission?.name || story?.role === 'mission') {
			return control.name;
		}
		return `${mission.name}: ${control.name}`;
	};
	// a reference to a quest or mission reads as its story name; others as their own text
	const describe = (rule: RuleText): string =>
		ruleText(rule, (reference) => {
			const control = byId.get(reference.control);
			return control?.story ? `“${storyName(control)}”` : reference.text;
		});
	const controls = manifest.states.controls.filter((entry) => {
		const rule = ruleOf(entry);
		return matches(`${storyName(entry)} ${entry.id} ${rule ? describe(rule) : ''}`);
	});
	const levelNames = new Map(manifest.levels.map((entry) => [entry.id, entry.name ?? entry.id]));
	// story controls are picked as points in the story rather than one by one
	const sectionRows = (entries: readonly SceneControl[]) =>
		entries.length > 0 && entries.every((entry) => entry.story !== null) ? (
			<StoryControls
				viewer={viewer}
				controls={entries}
				all={manifest.states.controls}
				missions={missions}
				mainLine={manifest.states.mainStory}
				describe={describe}
				levelName={(id) => levelNames.get(id) ?? id}
			/>
		) : (
			entries.map((entry) => (
				<ControlRow key={entry.id} viewer={viewer} control={entry} describe={describe} />
			))
		);
	const picks = viewer.scenePicks;
	const picked = controls.filter((entry) => picks[entry.id] !== undefined);
	/** per category: the controls listed first, and the other levels' below them */
	const listing = (inCategory: SceneControl[]) => {
		switch (scope) {
			case 'nearby': {
				return { here: controlsNear(inCategory, viewer.camera.position), others: [] };
			}
			case 'level': {
				const here = controlsForLevel(inCategory, level);
				const listedHere = new Set(here);
				const others = groupByLevel(
					inCategory.filter((entry) => !listedHere.has(entry)),
					manifest.levels,
					level,
					(entry) => entry.levelTags,
				);
				return { here, others };
			}
			case 'all': {
				return { here: inCategory, others: [] };
			}
			case 'picked': {
				return { here: inCategory.filter((entry) => picks[entry.id] !== undefined), others: [] };
			}
		}
	};
	return (
		<section className="panel scene-controls" aria-label="scene conditions">
			<header>
				<h2>Scene conditions</h2>
				<button onClick={() => viewer.resetSceneValues()}>Reset</button>
			</header>
			<ChoiceRow label="Show">
				<select
					value={scope}
					onChange={(event) => {
						const { value } = event.currentTarget;
						setScope(SCOPES.find((entry) => entry === value) ?? 'nearby');
					}}
				>
					<option value="nearby">Near the camera ({NEARBY_RADIUS} m)</option>
					<option value="level">This level</option>
					<option value="all">Everything</option>
					<option value="picked">Picked ({picked.length})</option>
				</select>
			</ChoiceRow>
			<label className="control-search" htmlFor={searchId}>
				Filter controls
				<input
					id={searchId}
					type="search"
					value={query}
					onChange={(event) => setQuery(event.currentTarget.value)}
				/>
			</label>
			{manifest.states.categories
				.filter(({ id }) => !OWN_SECTIONS.has(id))
				.map(({ id, title, note }) => {
					const inCategory = controls.filter((entry) => entry.category === id);
					const { here, others } = listing(inCategory);
					if (scope !== 'level' && here.length === 0) {
						return null;
					}
					const count = others.length > 0 ? `${here.length} here · ${inCategory.length} in all` : here.length;
					return (
						<LazyDetails
							key={`${scope}/${id}`}
							summary={
								<summary>
									{title} ({count})
								</summary>
							}
						>
							{() => (
								<>
									{note !== null && <p className="muted small">{note}</p>}
									{sectionRows(here)}
									<OtherLevels groups={others} render={sectionRows} />
								</>
							)}
						</LazyDetails>
					);
				})}
			<WaterLevels viewer={viewer} matches={matches} />
			<EnvironmentVolumes viewer={viewer} scene={pkg} level={level} matches={matches} />
		</section>
	);
};
