import {
	type EnvironmentVolume,
	EnvironmentVolumeType,
} from '@endfield-noclip/formats/endfield/environment-volume';
import type { PartitionLevel } from '@endfield-noclip/formats/endfield/level-partition';
import {
	ENVIRONMENT_SECTIONS,
	type EnvironmentPhase,
	type EnvironmentSection,
	type EnvironmentSectionName,
} from '@endfield-noclip/formats/hg/environment-phase';
import type { PlainObject } from '@endfield-noclip/formats/unity/plain-object';
import type {
	EnvironmentPhaseInfo,
	EnvironmentProfile,
	EnvironmentSections,
	EnvironmentVolumeInfo,
	EnvironmentVolumeShape,
	PostProfile,
} from '@endfield-noclip/package-format/environment';

import { getOrInsert, intern } from '../collections.ts';
import type { Context } from '../context.ts';
import { type AssetResolver, objectKey, type ObjectRef } from '../game/assets.ts';
import {
	type LevelEnvironmentChoice,
	type LevelPhases,
	type LoadedPhase,
	type LoadedVolumeProfile,
	loadEnvironmentPhase,
	loadLevelPhases,
	loadSceneVolumes,
	loadVolumeProfile,
	resolveLevelEnvironment,
	resolveLevelPost,
	type SectionSource,
} from '../game/environment.ts';

// the manifest's environments: each level's base environment phase (stacked over the scene's global one) and
// its post-processing profile, deduplicated. textures they reference are converted with the other assets, so
// planning happens before conversion and the texture ids are filled in after.

/** the package section each phase section becomes */
const SECTION_KEYS = {
	lightConfig: 'light',
	skyConfig: 'sky',
	atmosphereConfig: 'atmosphere',
	fogConfig: 'fog',
	heightFogConfig: 'heightFog',
	volumetricFogConfig: 'volumetricFog',
	cloudConfig: 'cloud',
	windConfig: 'wind',
	lightShaftConfig: 'lightShaft',
	colorGradingConfig: 'colorGrading',
	autoExposureConfig: 'autoExposure',
	shadowConfig: 'shadow',
} as const satisfies Record<EnvironmentSectionName, keyof EnvironmentProfile>;

/** what a level resolved to, for the pack report and debug index */
export interface LevelEnvironmentDebug {
	level: string;
	/** the base volume's object name, or `null` */
	volume: string | null;
	/** fraction of the level's sample points the base volume covers, and where it's the one shown */
	covered: number;
	shown: number;
	phase: string | null;
	post: string | null;
	/** sections not taken from the level's own phase */
	sections: Partial<Record<EnvironmentSectionName, Exclude<SectionSource, 'level'>>>;
	error: string | null;
}

/** environments planned before asset conversion */
export interface EnvironmentPlan {
	/** per level, in partition order: index into {@link profiles}, or `null` */
	levels: (number | null)[];
	profiles: PendingProfile[];
	/** every phase a volume applies, uncomposed */
	phases: PendingPhase[];
	/** owned; `group` is 0 until the packer interns {@link volumeOwners} */
	volumes: EnvironmentVolumeInfo[];
	/** per volume: its level's tag and the MapConfig scene state indices that load it, empty if always loaded */
	volumeOwners: { levelTag: number; sceneStates: number[] }[];
	/** textures the profiles and phases reference; slots index this list */
	textures: ObjectRef[];
	debug: LevelEnvironmentDebug[];
}

/** a texture field to fill in once texture ids are known */
interface TextureSlot {
	holder: PlainObject;
	key: string;
	texture: number;
}

interface PendingProfile {
	/** owned; texture fields are `null` until {@link finishEnvironments} */
	profile: EnvironmentProfile;
	slots: TextureSlot[];
}

interface PendingPhase {
	/** owned; texture fields are `null` until {@link finishEnvironments} */
	phase: EnvironmentPhaseInfo;
	slots: TextureSlot[];
}

/** the manifest's environment lists */
export interface FinishedEnvironments {
	environments: EnvironmentProfile[];
	environmentPhases: EnvironmentPhaseInfo[];
	environmentVolumes: EnvironmentVolumeInfo[];
}

/**
 * resolves every level's environment and loads the phases and profiles involved
 *
 * @param context world index and asset resolver
 * @param scene streaming scene
 * @param levels the scene's levels
 * @param enabled MapConfig scene state indices active by default; level base environments are chosen among
 *   the volumes they load
 * @returns the deduplicated profiles, per-level indices and the textures to convert
 */
export const planEnvironments = async (
	context: Pick<Context, 'world' | 'resolver'>,
	scene: string,
	levels: readonly PartitionLevel[],
	enabled: ReadonlySet<number>,
): Promise<EnvironmentPlan> => {
	const plan: EnvironmentPlan = {
		levels: [],
		profiles: [],
		phases: [],
		volumes: [],
		volumeOwners: [],
		textures: [],
		debug: [],
	};
	if (levels.length === 0) {
		return plan;
	}
	const [volumes, pathOf, resolver] = await Promise.all([
		loadSceneVolumes(context.world, scene),
		context.world.pathLookup(),
		context.resolver(),
	]);

	// levels mostly share phases and profiles, so loads are cached; they run for all levels at once
	const phaseLoads = new Map<bigint, Promise<LoadedPhase>>();
	const phase = (hash: bigint) =>
		getOrInsert(phaseLoads, hash, () => loadEnvironmentPhase(resolver, hash, pathOf));
	const postLoads = new Map<bigint, Promise<LoadedVolumeProfile>>();
	const postProfile = (hash: bigint) =>
		getOrInsert(postLoads, hash, () => loadVolumeProfile(resolver, hash, pathOf));
	const loaded = await Promise.all(
		levels.map(async (level) => {
			const choice = resolveLevelEnvironment(level, volumes, enabled);
			const profile = resolveLevelPost(level, volumes, enabled)?.profile ?? null;
			try {
				const phases = await loadLevelPhases(choice, phase);
				// the post profile is only used with a phase
				return {
					choice,
					phases,
					post: phases === null || profile === null ? null : await postProfile(profile),
				};
			} catch (error) {
				return { choice, phases: error instanceof Error ? error : new Error(String(error)), post: null };
			}
		}),
	);

	// profiles by phase and post-profile name, each with its texture lookups started
	const byKey = new Map<string, number>();
	const pending: {
		phases: LevelPhases;
		post: LoadedVolumeProfile | null;
		textures: Promise<SectionTextures>;
	}[] = [];
	for (const [i, { choice, phases, post }] of loaded.entries()) {
		const debug = levelDebug(levels[i], choice);
		plan.debug.push(debug);
		if (phases === null) {
			plan.levels.push(null);
			continue;
		}
		if (phases instanceof Error) {
			debug.error = phases.message;
			plan.levels.push(null);
			continue;
		}
		debug.phase = phases.own.phase.name;
		debug.post = post?.name ?? null;
		for (const name of ENVIRONMENT_SECTIONS) {
			const { source } = phases.composed[name];
			if (source !== 'level') {
				debug.sections[name] = source;
			}
		}
		plan.levels.push(
			intern(pending, byKey, `${phases.own.phase.name}\n${post?.name ?? ''}`, () => ({
				phases,
				post,
				textures: resolveTextures(resolver, phases),
			})),
		);
	}

	const textureIndex = new Map<string, number>();
	for (const { phases, post, textures } of pending) {
		// oxlint-disable-next-line no-await-in-loop -- all lookups are in flight; profiles are built in order
		plan.profiles.push(buildProfile(phases, await textures, post, plan.textures, textureIndex));
	}

	// every volume with its own phase, for blending at the camera. a phase that can't be read leaves its volume
	// without one, which the viewer skips
	const volumePhases = await Promise.all(
		volumes.environment.map(async ({ volume }) => {
			if (volume.envPhase === null) {
				return null;
			}
			try {
				const loadedPhase = await phase(volume.envPhase);
				return { loaded: loadedPhase, textures: await resolvePhaseTextures(resolver, loadedPhase) };
			} catch {
				return null;
			}
		}),
	);
	const phaseIndex = new Map<string, number>();
	for (const [i, { tag, sceneStates, volume }] of volumes.environment.entries()) {
		const shape = volumeShape(volume);
		if (shape === null) {
			continue;
		}
		const loadedPhase = volumePhases[i];
		const index =
			loadedPhase === null
				? null
				: intern(plan.phases, phaseIndex, loadedPhase.loaded.phase.name, () =>
						buildPhase(loadedPhase.loaded.phase, loadedPhase.textures, plan.textures, textureIndex),
					);
		plan.volumes.push({
			name: volume.name.replace(/#.*$/, ''),
			group: 0,
			shape,
			blendMode: volume.blendMode,
			priority: volume.priority,
			blendDistance: volume.blendDistance,
			fadeInDuration: volume.fadeInDuration,
			fadeOutDuration: volume.fadeOutDuration,
			phase: index,
			activation: 'unknown',
		});
		plan.volumeOwners.push({ levelTag: tag, sceneStates });
	}
	return plan;
};

/** @returns where a volume applies, or `null` for shapes not understood */
const volumeShape = (volume: EnvironmentVolume): EnvironmentVolumeShape | null => {
	switch (volume.volumeType) {
		case EnvironmentVolumeType.Global: {
			return { kind: 'global' };
		}
		case EnvironmentVolumeType.Box: {
			const transform = volume.transform;
			return transform === null
				? null
				: { kind: 'box', position: transform.position, rotation: transform.rotation, scale: transform.scale };
		}
		case EnvironmentVolumeType.PolyArea: {
			const shape = volume.shape;
			if (shape === null || shape.points.length < 3) {
				return null;
			}
			const bottom = shape.position[1] + shape.baseHeightOffset;
			return { kind: 'prism', points: shape.points, bottom, top: bottom + shape.height };
		}
		default: {
			return null;
		}
	}
};

/** @returns a phase's texture objects per section, resolved against its own file */
const resolvePhaseTextures = async (
	resolver: AssetResolver,
	loaded: LoadedPhase,
): Promise<SectionTextures> => {
	const entries = await Promise.all(
		ENVIRONMENT_SECTIONS.map(async (name) => {
			const refs = await Promise.all(
				loaded.phase.sections[name].textures.map(({ pptr }) =>
					resolver.resolve(loaded.ref, pptr).catch(() => null),
				),
			);
			return [name, refs] as const;
		}),
	);
	return new Map(entries);
};

const buildPhase = (
	phase: EnvironmentPhase,
	textureRefs: SectionTextures,
	textures: ObjectRef[],
	textureIndex: Map<string, number>,
): PendingPhase => {
	const slots: TextureSlot[] = [];
	const sections: Partial<Record<keyof EnvironmentSections, PlainObject>> = {};
	const active: (keyof EnvironmentSections)[] = [];
	for (const name of ENVIRONMENT_SECTIONS) {
		const section = phase.sections[name];
		const value = structuredClone(section.value);
		fillTextureSlots(value, section, textureRefs.get(name), slots, textures, textureIndex);
		sections[SECTION_KEYS[name]] = value;
		if (section.active) {
			active.push(SECTION_KEYS[name]);
		}
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the sections are the game's TypeTree, which the interfaces transcribe
	const typed = sections as unknown as EnvironmentSections;
	return { phase: { name: phase.name, active, sections: typed }, slots };
};

/** nulls a section's texture fields and records where each resolved texture goes */
const fillTextureSlots = (
	value: PlainObject,
	section: EnvironmentSection,
	refs: (ObjectRef | null)[] | undefined,
	slots: TextureSlot[],
	textures: ObjectRef[],
	textureIndex: Map<string, number>,
): void => {
	for (const [i, { path }] of section.textures.entries()) {
		const holder = objectAt(value, path.slice(0, -1));
		const key = path.at(-1)!;
		holder[key] = null;
		const ref = refs?.[i] ?? null;
		if (ref !== null) {
			slots.push({ holder, key, texture: intern(textures, textureIndex, objectKey(ref), () => ref) });
		}
	}
};

/**
 * fills in the texture ids of planned profiles and phases
 *
 * @param plan the plan; its profiles and phases are completed in place and handed out
 * @param textureIds per {@link EnvironmentPlan.textures} entry, its texture-table id or `null`
 * @returns the manifest's environment lists
 */
export const finishEnvironments = (
	plan: EnvironmentPlan,
	textureIds: readonly (number | null)[],
): FinishedEnvironments => {
	const fill = (slots: readonly TextureSlot[]): void => {
		for (const { holder, key, texture } of slots) {
			holder[key] = textureIds[texture] ?? null;
		}
	};
	return {
		environments: plan.profiles.map(({ profile, slots }) => {
			fill(slots);
			return profile;
		}),
		environmentPhases: plan.phases.map(({ phase, slots }) => {
			fill(slots);
			return phase;
		}),
		environmentVolumes: plan.volumes,
	};
};

const levelDebug = (level: PartitionLevel, choice: LevelEnvironmentChoice): LevelEnvironmentDebug => {
	const share = choice.shares.find((candidate) => candidate.volume === choice.volume);
	const samples = Math.max(1, choice.samples);
	return {
		level: level.id,
		volume: choice.volume?.name ?? null,
		covered: (share?.covered ?? 0) / samples,
		shown: (share?.wins ?? 0) / samples,
		phase: null,
		post: null,
		sections: {},
		error: null,
	};
};

/** per section, per texture reference in it: the texture object, or `null` if unset or not found */
type SectionTextures = Map<EnvironmentSectionName, (ObjectRef | null)[]>;

const resolveTextures = async (
	resolver: AssetResolver,
	{ own, global, composed }: LevelPhases,
): Promise<SectionTextures> => {
	const entries = await Promise.all(
		ENVIRONMENT_SECTIONS.map(async (name) => {
			const { source, section } = composed[name];
			// PPtrs are relative to the file of the phase the section came from
			const from = source === 'global' && global !== null ? global : own;
			const refs = await Promise.all(
				section.textures.map(({ pptr }) => resolver.resolve(from.ref, pptr).catch(() => null)),
			);
			return [name, refs] as const;
		}),
	);
	return new Map(entries);
};

const buildProfile = (
	{ own, composed }: LevelPhases,
	textureRefs: SectionTextures,
	post: LoadedVolumeProfile | null,
	textures: ObjectRef[],
	textureIndex: Map<string, number>,
): PendingProfile => {
	const slots: TextureSlot[] = [];
	const sections: Partial<Record<keyof EnvironmentProfile, PlainObject>> = {};
	for (const name of ENVIRONMENT_SECTIONS) {
		const { section } = composed[name];
		// inherited sections are shared between profiles, so each profile gets its own copy
		const value = structuredClone(section.value);
		fillTextureSlots(value, section, textureRefs.get(name), slots, textures, textureIndex);
		sections[SECTION_KEYS[name]] = value;
	}
	return { profile: profileOf(own.phase, sections, post), slots };
};

const profileOf = (
	phase: EnvironmentPhase,
	sections: Partial<Record<keyof EnvironmentProfile, PlainObject>>,
	post: LoadedVolumeProfile | null,
): EnvironmentProfile => {
	const profile = { name: phase.name, ...sections, post: post === null ? null : postProfileOf(post) };
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the sections are the game's TypeTree, which the interfaces transcribe
	return profile as unknown as EnvironmentProfile;
};

/** @returns the package's post profile; components keep the game's field names */
const postProfileOf = (profile: LoadedVolumeProfile): PostProfile => {
	const component = (name: string) => profile.components.get(name) ?? null;
	const post = {
		name: profile.name,
		bloom: component('Bloom'),
		ambientOcclusion: component('GTAmbientOcclusion'),
		vignette: component('Vignette'),
		screenSpaceReflection: component('ScreenSpaceReflectionVolume'),
	};
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- as for the environment sections
	return post as unknown as PostProfile;
};

const objectAt = (root: PlainObject, path: readonly string[]): PlainObject => {
	let current = root;
	for (const step of path) {
		const next = current[step];
		if (next === null || typeof next !== 'object' || Array.isArray(next)) {
			throw new Error(`texture path ${path.join('.')} doesn't lead to an object`);
		}
		current = next;
	}
	return current;
};
