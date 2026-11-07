import type { EnvironmentVolume } from '@endfield-noclip/formats/endfield/environment-volume';
import type { PartitionLevel } from '@endfield-noclip/formats/endfield/level-partition';
import {
	ENVIRONMENT_SECTIONS,
	type EnvironmentPhase,
	type EnvironmentSection,
	type EnvironmentSectionName,
} from '@endfield-noclip/formats/hg/environment-phase';
import { type LensFlareDataSRP, readLensFlareData } from '@endfield-noclip/formats/unity/lens-flare-data';
import { ShaderPropertyType } from '@endfield-noclip/formats/unity/material';
import type { PlainKinds, PlainObject } from '@endfield-noclip/formats/unity/plain-object';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import type {
	BlendSchema,
	CelestialConfig,
	EnvironmentPhaseEntry,
	EnvironmentPhaseInfo,
	EnvironmentProfile,
	EnvironmentSchema,
	EnvironmentSectionPools,
	EnvironmentSections,
	EnvironmentTable,
	EnvironmentVolumeInfo,
	PostProfile,
} from '@endfield-noclip/package-format/environment';
import type { LevelEnvironment } from '@endfield-noclip/package-format/manifest';
import type { ConditionalSetInfo } from '@endfield-noclip/package-format/states';

import type { Context } from '../context.ts';
import { type AssetResolver, objectKey, type ObjectRef } from '../game/assets.ts';
import {
	environmentBlend,
	environmentVolumeShape,
	type LevelEnvironmentChoice,
	type LoadedPhase,
	type LoadedVolumeProfile,
	loadEnvironmentPhase,
	loadEnvironmentPhaseObject,
	loadLevelPhases,
	loadSceneVolumes,
	loadVolumeProfile,
	resolveLevelEnvironment,
	resolveLevelPost,
	type SceneEnvironmentVolume,
	type SceneVolumes,
	type SectionSource,
} from '../game/environment.ts';
import { type LoadedMaterial, loadMaterial } from '../game/material-load.ts';

// the environment table: every volume with its phase, each level's base volume and its post-processing
// profile. textures the phases reference are converted with the other assets, so planning happens before
// conversion and the texture ids are filled in after.

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
	celestialConfig: 'celestial',
	starConfig: 'star',
	rainConfig: 'rain',
	lensFlareConfig: 'lensFlare',
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

/** an environment input the plan left out or couldn't read, for the debug index */
export type EnvironmentProblem =
	/** a volume dropped for its shape */
	| { kind: 'volume'; volume: string; reason: string }
	/** a volume kept without a phase, so the blend skips it */
	| { kind: 'phase'; volume: string; reason: string }
	/** a texture, material or lens flare a phase references that couldn't be read (left `null`) */
	| { kind: 'reference'; phase: string; section: EnvironmentSectionName; path: string; reason: string }
	/** a render pipeline resource the environments sample that couldn't be found */
	| { kind: 'resource'; path: string; reason: string };

/** environments planned before asset conversion */
export interface EnvironmentPlan {
	/** per level, in partition order: its base volume (indexing {@link volumes}) and post profile, or `null` */
	levels: (LevelEnvironment | null)[];
	/** the levels' post-processing profiles, deduplicated */
	posts: PostProfile[];
	/** every phase a volume applies, uncomposed */
	phases: PendingPhase[];
	/** owned; `group` is 0 until the packer interns {@link volumeOwners} */
	volumes: EnvironmentVolumeInfo[];
	/**
	 * per volume: its level's tag, the MapConfig scene state indices that load it (empty if always loaded) and,
	 * for prefab volumes, their placement's load condition
	 */
	volumeOwners: { levelTag: number; sceneStates: number[]; condition: ConditionalSetInfo | null }[];
	/** textures the phases reference; slots index this list */
	textures: ObjectRef[];
	/** index into {@link textures} of the height fog's flow noise, or `null` if the install lacks it */
	flowNoise: number | null;
	debug: LevelEnvironmentDebug[];
	/** what was left out, deduplicated */
	problems: EnvironmentProblem[];
	/** how the phases' fields blend, merged over every phase's TypeTree */
	schema: EnvironmentSchema;
}

/** a texture field to fill in once texture ids are known */
interface TextureSlot {
	holder: Record<string, unknown>;
	key: string;
	texture: number;
}

interface PendingPhase {
	/** owned; texture fields are `null` until {@link finishEnvironments} */
	phase: EnvironmentPhaseInfo;
	slots: TextureSlot[];
}

/**
 * the noise the height fog's flow noise samples. it's one of the render pipeline's default resources rather
 * than something a phase references
 */
const FLOW_NOISE_PATH =
	'Packages/com.hg.render-pipelines/Runtime/RenderPipelineResources/Texture/HeightFogFlowNoise.asset';

/** @returns the flow noise texture, or why the install doesn't have it where expected */
const findFlowNoise = async (
	context: Pick<Context, 'world'>,
	resolver: AssetResolver,
): Promise<ObjectRef | string> => {
	const [hash] = await context.world.hashesOf(FLOW_NOISE_PATH);
	if (hash === undefined) {
		return 'no path hash';
	}
	try {
		return await resolver.findUnique({ hash, path: FLOW_NOISE_PATH }, UnityClass.Texture3D);
	} catch (error) {
		return errorMessage(error);
	}
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** records an environment problem */
type ReportProblem = (problem: EnvironmentProblem) => void;

/**
 * resolves every level's environment and loads the phases and profiles involved
 *
 * @param context world index and asset resolver
 * @param scene streaming scene
 * @param levels the scene's levels
 * @param enabled MapConfig scene state indices active by default; level base environments are chosen among
 *   the volumes they load
 * @param placed volumes that placed prefabs carry (`loadPlacedVolumes`), alongside the chunk volumes
 * @returns the deduplicated profiles, per-level indices and the textures to convert
 */
export const planEnvironments = async (
	context: Pick<Context, 'world' | 'resolver'>,
	scene: string,
	levels: readonly PartitionLevel[],
	enabled: ReadonlySet<number>,
	placed: readonly SceneEnvironmentVolume[],
): Promise<EnvironmentPlan> => {
	const plan: EnvironmentPlan = {
		levels: [],
		posts: [],
		phases: [],
		volumes: [],
		volumeOwners: [],
		textures: [],
		flowNoise: null,
		debug: [],
		problems: [],
		schema: mapSchemaSections(),
	};
	if (levels.length === 0) {
		return plan;
	}
	const [chunkVolumes, pathOf, resolver] = await Promise.all([
		loadSceneVolumes(context.world, scene),
		context.world.pathLookup(),
		context.resolver(),
	]);
	const volumes: SceneVolumes = { ...chunkVolumes, environment: [...chunkVolumes.environment, ...placed] };
	const reported = new Set<string>();
	const report: ReportProblem = (problem) => {
		const key = JSON.stringify(problem);
		if (!reported.has(key)) {
			reported.add(key);
			plan.problems.push(problem);
		}
	};
	const flowNoise = await findFlowNoise(context, resolver);
	if (typeof flowNoise === 'string') {
		report({ kind: 'resource', path: FLOW_NOISE_PATH, reason: flowNoise });
	} else {
		plan.flowNoise = plan.textures.push(flowNoise) - 1;
	}

	// levels mostly share phases and profiles, so loads are cached; they run for all levels at once. prefab
	// volumes name their phase object, chunk volumes a StringPathHash asset
	const phaseObjects = new Map(volumes.environment.map((entry) => [entry.volume, entry.phaseObject]));
	const phaseLoads = new Map<string, Promise<LoadedPhase>>();
	const phase = (volume: EnvironmentVolume): Promise<LoadedPhase> | null => {
		const object = phaseObjects.get(volume) ?? null;
		if (object !== null) {
			return phaseLoads.getOrInsertComputed(objectKey(object), () =>
				loadEnvironmentPhaseObject(resolver, object),
			);
		}
		const hash = volume.envPhase;
		return hash === null
			? null
			: phaseLoads.getOrInsertComputed(`hash:${hash}`, () => loadEnvironmentPhase(resolver, hash, pathOf));
	};
	const postLoads = new Map<bigint, Promise<LoadedVolumeProfile>>();
	const postProfile = (hash: bigint) =>
		postLoads.getOrInsertComputed(hash, () => loadVolumeProfile(resolver, hash, pathOf));
	const loaded = await Promise.all(
		levels.map(async (level) => {
			const choice = resolveLevelEnvironment(level, volumes, enabled);
			const profile = resolveLevelPost(level, volumes, enabled)?.profile ?? null;
			try {
				// the level's and the global phase, for the debug index's section sources
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

	// every volume with its own phase, for blending at the camera. a phase that can't be read leaves its volume
	// without one, which the viewer skips
	const volumePhases = await Promise.all(
		volumes.environment.map(async ({ volume }) => {
			const load = phase(volume);
			if (load === null) {
				return 'no phase set';
			}
			try {
				const loadedPhase = await load;
				return { loaded: loadedPhase, textures: await resolvePhaseTextures(resolver, loadedPhase, report) };
			} catch (error) {
				return errorMessage(error);
			}
		}),
	);
	const textureIndex = new Map<string, number>();
	const phaseIndex = new Map<string, number>();
	const volumeIndex = new Map<EnvironmentVolume, number>();
	for (const [i, { tag, sceneStates, condition, volume }] of volumes.environment.entries()) {
		const name = volume.name.replace(/#.*$/, '');
		const shape = environmentVolumeShape(volume);
		if (typeof shape === 'string') {
			report({ kind: 'volume', volume: name, reason: shape });
			continue;
		}
		const blend = environmentBlend(volume);
		if (typeof blend === 'string') {
			report({ kind: 'volume', volume: name, reason: blend });
			continue;
		}
		const loadedPhase = volumePhases[i];
		if (typeof loadedPhase === 'string') {
			report({ kind: 'phase', volume: name, reason: loadedPhase });
		}
		const index =
			typeof loadedPhase === 'string'
				? null
				: phaseIndex.getOrInsertComputed(loadedPhase.loaded.phase.name, () => {
						addBlendSchema(plan.schema, loadedPhase.loaded.phase);
						return (
							plan.phases.push(
								buildPhase(loadedPhase.loaded.phase, loadedPhase.textures, plan.textures, textureIndex),
							) - 1
						);
					});
		if (index !== null) {
			volumeIndex.set(volume, plan.volumes.length);
		}
		plan.volumes.push({
			name,
			group: 0,
			shape,
			control: null,
			blend,
			priority: volume.priority,
			phase: index,
		});
		plan.volumeOwners.push({ levelTag: tag, sceneStates, condition });
	}

	const postIndex = new Map<string, number>();
	for (const [i, { choice, phases, post }] of loaded.entries()) {
		const debug = levelDebug(levels[i], choice);
		plan.debug.push(debug);
		if (phases instanceof Error) {
			debug.error = phases.message;
		} else if (phases !== null) {
			debug.phase = phases.own.phase.name;
			debug.post = post?.name ?? null;
			for (const name of ENVIRONMENT_SECTIONS) {
				const { source } = phases.composed[name];
				if (source !== 'level') {
					debug.sections[name] = source;
				}
			}
		}
		const volume = choice.volume === null ? undefined : volumeIndex.get(choice.volume);
		if (volume === undefined || phases === null || phases instanceof Error) {
			// the base volume's phase is unset or unreadable (recorded with the volume)
			plan.levels.push(null);
			continue;
		}
		plan.levels.push({
			volume,
			post:
				post === null
					? null
					: postIndex.getOrInsertComputed(post.name, () => plan.posts.push(postProfileOf(post)) - 1),
		});
	}

	for (const { phase: info } of plan.phases) {
		if (info.active.includes('celestial')) {
			checkRayPlanet(info.name, info.sections.celestial, report);
		}
	}
	return plan;
};

/** the textures the ray-traced planet's shader samples; without any of them it isn't drawn */
const RAY_PLANET_TEXTURES = ['_BaseColorMap', '_RSM', '_CloudsTexMain', '_TransmittanceLLUT'];

/** reports a ray-traced planet that's on but lacks its material or one of its textures */
const checkRayPlanet = (phase: string, celestial: CelestialConfig, report: ReportProblem): void => {
	const { drawAdvancedPlanet, advancedPlanetMat } = celestial.advancedPlanetConfig;
	if (!drawAdvancedPlanet) {
		return;
	}
	const path = 'advancedPlanetConfig.advancedPlanetMat';
	if (advancedPlanetMat === null) {
		report({
			kind: 'reference',
			phase,
			section: 'celestialConfig',
			path,
			reason: 'the ray-traced planet is on without a material',
		});
		return;
	}
	const missing = RAY_PLANET_TEXTURES.filter((slot) => !Object.hasOwn(advancedPlanetMat.textures, slot));
	if (missing.length > 0) {
		report({
			kind: 'reference',
			phase,
			section: 'celestialConfig',
			path,
			reason: `the ray-traced planet's material has no ${missing.join(', ')}, so it isn't drawn`,
		});
	}
};

/** @returns a phase's texture and material objects per section, resolved against its own file */
const resolvePhaseTextures = async (
	resolver: AssetResolver,
	loaded: LoadedPhase,
	report: ReportProblem,
): Promise<SectionTextures> => {
	const entries = await Promise.all(
		ENVIRONMENT_SECTIONS.map(async (name) => {
			const fail = (path: string, error: unknown): void =>
				report({
					kind: 'reference',
					phase: loaded.phase.name,
					section: name,
					path,
					reason: errorMessage(error),
				});
			return [name, await resolveSection(resolver, loaded.ref, loaded.phase.sections[name], fail)] as const;
		}),
	);
	return new Map(entries);
};

/** a lens flare asset with each element's texture object, or `null` for none */
interface LoadedFlare {
	data: LensFlareDataSRP;
	textures: (ObjectRef | null)[];
}

/** a section's references resolved: per texture, material and lens flare reference, its object or `null` */
interface SectionRefs {
	textures: (ObjectRef | null)[];
	materials: (LoadedMaterial | null)[];
	flares: (LoadedFlare | null)[];
}

/** records a reference that couldn't be read, by its field path */
type ReferenceFailure = (path: string, error: unknown) => void;

/** @returns the flare asset at `ref`, its element textures resolved against its own file */
const loadFlare = async (
	resolver: AssetResolver,
	ref: ObjectRef,
	fail: ReferenceFailure,
): Promise<LoadedFlare> => {
	const data = readLensFlareData(await ref.file.objectBytes(ref.info), {
		littleEndian: ref.file.file.header.littleEndian,
	});
	const textures = await Promise.all(
		data.elements.map(async ({ lensFlareTexture }, i) =>
			lensFlareTexture === null
				? null
				: resolver.resolve(ref, lensFlareTexture).catch((error: unknown) => {
						fail(`elements.${i}.lensFlareTexture`, error);
						return null;
					}),
		),
	);
	return { data, textures };
};

/** @returns the section's references, resolved against the phase file `from`; unreadable ones are `null` */
const resolveSection = async (
	resolver: AssetResolver,
	from: ObjectRef,
	section: EnvironmentSection,
	fail: ReferenceFailure,
): Promise<SectionRefs> => {
	const guarded = async <T>(path: readonly string[], load: () => Promise<T | null>): Promise<T | null> => {
		try {
			return await load();
		} catch (error) {
			fail(path.join('.'), error);
			return null;
		}
	};
	const [textures, materials, flares] = await Promise.all([
		Promise.all(section.textures.map(({ path, pptr }) => guarded(path, () => resolver.resolve(from, pptr)))),
		Promise.all(
			section.materials.map(({ path, pptr }) =>
				guarded(path, async () => {
					const ref = await resolver.resolve(from, pptr);
					if (ref === null) {
						return null;
					}
					const material = await loadMaterial(resolver, ref);
					for (const [slot, { error }] of Object.entries(material.textures)) {
						if (error !== undefined) {
							fail(`${path.join('.')}.${slot}`, new Error(error));
						}
					}
					return material;
				}),
			),
		),
		Promise.all(
			section.flares.map(({ path, pptr }) =>
				guarded(path, async () => {
					const ref = await resolver.resolve(from, pptr);
					return ref === null
						? null
						: await loadFlare(resolver, ref, (element, error) => fail(`${path.join('.')}.${element}`, error));
				}),
			),
		),
	]);
	return { textures, materials, flares };
};

/**
 * light config fields the game derives from others (docs/game-data/lighting.md#sun), left out of the package:
 * some phases carry them stale, and the effect quaternions can't be blended as fields
 */
const DERIVED_LIGHT_FIELDS = [
	'preExposure',
	'directIntensity',
	'directIntensityDividePi',
	'forwardDirect',
	'localToWorld',
	'rotationAtmosphere',
	'rotationLightShaft',
	'rotationSunDisc',
	'rotationLensFlare',
	'rotationCloudShadow',
	'rotationHeightFogDirectionalInscattering',
];

/** @returns an empty schema for every package section */
const mapSchemaSections = (): EnvironmentSchema => {
	const schema: Partial<EnvironmentSchema> = {};
	for (const name of ENVIRONMENT_SECTIONS) {
		schema[SECTION_KEYS[name]] = {};
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every section was just filled in
	return schema as EnvironmentSchema;
};

/**
 * Unity serializes C# enums as plain integers, with no enum type in the TypeTree, so integer fields named
 * like one (`…Mode`, `…Type`) are taken as enums and switch; other integers are counts and amounts, and
 * round
 */
const ENUM_NAME = /(mode|type)$/i;

/** @returns how fields of the given kinds blend */
const blendSchemaOf = (kinds: PlainKinds): BlendSchema => {
	const schema: BlendSchema = {};
	for (const [field, kind] of Object.entries(kinds)) {
		switch (kind) {
			case 'float': {
				schema[field] = 'lerp';
				break;
			}
			case 'integer': {
				schema[field] = ENUM_NAME.test(field) ? 'switch' : 'round';
				break;
			}
			case 'boolean':
			case 'string':
			case 'reference': {
				schema[field] = 'switch';
				break;
			}
			default: {
				schema[field] = blendSchemaOf(kind);
			}
		}
	}
	return schema;
};

/** adds what's missing from `into`; a field keeps the blend it first got */
const mergeSchema = (into: BlendSchema, from: BlendSchema): void => {
	for (const [field, blend] of Object.entries(from)) {
		const existing = into[field];
		if (existing === undefined) {
			into[field] = blend;
		} else if (typeof existing === 'object' && typeof blend === 'object') {
			mergeSchema(existing, blend);
		}
	}
};

/** merges a phase's field blends into the package's schema, in place */
const addBlendSchema = (schema: EnvironmentSchema, phase: EnvironmentPhase): void => {
	for (const name of ENVIRONMENT_SECTIONS) {
		const section = blendSchemaOf(phase.sections[name].kinds);
		if (name === 'lightConfig') {
			for (const field of DERIVED_LIGHT_FIELDS) {
				delete section[field];
			}
		}
		mergeSchema(schema[SECTION_KEYS[name]], section);
	}
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
		if (name === 'lightConfig') {
			for (const field of DERIVED_LIGHT_FIELDS) {
				delete value[field];
			}
		}
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

/**
 * a material's values as its shader sees them: every property the shader declares, with the material's value
 * or else the declared default. Unity keeps properties from a material's earlier shaders, so undeclared ones
 * are dropped; a shader that declares nothing keeps the material's values as they are
 *
 * @returns the floats (ints included), the colours and vectors, and whether a texture slot is declared
 */
const materialValues = (
	material: LoadedMaterial,
): {
	floats: Record<string, number>;
	colors: Record<string, [number, number, number, number]>;
	declares: (slot: string) => boolean;
} => {
	const { record, shader } = material;
	if (shader.properties.length === 0) {
		return {
			floats: { ...record.ints, ...record.floats },
			colors: { ...record.colors },
			declares: () => true,
		};
	}
	const floats: Record<string, number> = {};
	const colors: Record<string, [number, number, number, number]> = {};
	const textures = new Set<string>();
	for (const { name, type, default: fallback } of shader.properties) {
		switch (type) {
			case ShaderPropertyType.Float:
			case ShaderPropertyType.Range:
			case ShaderPropertyType.Int: {
				floats[name] = record.floats[name] ?? record.ints[name] ?? fallback[0];
				break;
			}
			case ShaderPropertyType.Color:
			case ShaderPropertyType.Vector: {
				colors[name] = record.colors[name] ?? fallback;
				break;
			}
			case ShaderPropertyType.Texture: {
				textures.add(name);
				break;
			}
			default: {
				break;
			}
		}
	}
	return { floats, colors, declares: (slot) => textures.has(slot) };
};

/**
 * nulls a section's texture fields and records where each resolved texture goes; material fields become
 * flattened materials whose texture slots are recorded the same way
 */
const fillTextureSlots = (
	value: PlainObject,
	section: EnvironmentSection,
	refs: SectionRefs | undefined,
	slots: TextureSlot[],
	textures: ObjectRef[],
	textureIndex: Map<string, number>,
): void => {
	const slotFor = (holder: Record<string, unknown>, key: string, ref: ObjectRef | null): void => {
		holder[key] = null;
		if (ref !== null) {
			slots.push({
				holder,
				key,
				texture: textureIndex.getOrInsertComputed(objectKey(ref), () => textures.push(ref) - 1),
			});
		}
	};
	for (const [i, { path }] of section.textures.entries()) {
		slotFor(objectAt(value, path.slice(0, -1)), path.at(-1)!, refs?.textures[i] ?? null);
	}
	for (const [i, { path }] of section.materials.entries()) {
		const holder = objectAt(value, path.slice(0, -1));
		const key = path.at(-1)!;
		const material = refs?.materials[i] ?? null;
		if (material === null) {
			holder[key] = null;
			continue;
		}
		const { record } = material;
		const { floats, colors, declares } = materialValues(material);
		const materialTextures: PlainObject = {};
		const textureTransforms: PlainObject = {};
		for (const [slot, resolved] of Object.entries(material.textures)) {
			if (resolved.ref === null || !declares(slot)) {
				continue;
			}
			const { scale, offset } = record.textures[slot];
			textureTransforms[slot] = [scale[0], scale[1], offset[0], offset[1]];
			slotFor(materialTextures, slot, resolved.ref);
		}
		holder[key] = {
			shader: material.shader.name,
			keywords: record.keywords.join(' '),
			floats,
			colors,
			textures: materialTextures,
			textureTransforms,
		};
	}
	for (const [i, { path }] of section.flares.entries()) {
		const holder = objectAt(value, path.slice(0, -1));
		const key = path.at(-1)!;
		const flare = refs?.flares[i] ?? null;
		if (flare === null) {
			holder[key] = null;
			continue;
		}
		const elements = flare.data.elements.map((element, e) => {
			const { mode, ...gradient } = structuredClone(element.colorGradient);
			const packed: Record<string, unknown> = {
				...structuredClone(element),
				lensFlareTexture: null,
				// Unity's gradient mode 1 is Fixed, as particle gradients store it
				colorGradient: { ...gradient, fixed: mode === 1 },
			};
			slotFor(packed, 'lensFlareTexture', flare.textures[e] ?? null);
			return packed;
		});
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- curve keys are objects in arrays, which plain TypeTree values never hold
		holder[key] = { name: flare.data.name, elements } as unknown as PlainObject;
	}
};

/**
 * fills in the texture ids of planned profiles and phases
 *
 * @param plan the plan; its profiles and phases are completed in place and handed out
 * @param textureIds per {@link EnvironmentPlan.textures} entry, its texture-table id or `null`
 * @returns the environment table, equal sections of different phases stored once
 */
export const finishEnvironments = (
	plan: EnvironmentPlan,
	textureIds: readonly (number | null)[],
): EnvironmentTable => {
	const fill = (slots: readonly TextureSlot[]): void => {
		for (const { holder, key, texture } of slots) {
			holder[key] = textureIds[texture] ?? null;
		}
	};
	const sections: Partial<Record<keyof EnvironmentSections, unknown[]>> = {};
	const ids = new Map<string, number>();
	const intern = (key: keyof EnvironmentSections, value: unknown): number => {
		const pool = (sections[key] ??= []);
		return ids.getOrInsertComputed(`${key}\0${JSON.stringify(value)}`, () => pool.push(value) - 1);
	};
	const phases = plan.phases.map(({ phase, slots }): EnvironmentPhaseEntry => {
		fill(slots);
		const indices: EnvironmentPhaseEntry['sections'] = {};
		for (const [key, value] of Object.entries(phase.sections)) {
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- entries of a section-keyed object
			const section = key as keyof EnvironmentSections;
			if (value !== undefined) {
				indices[section] = intern(section, value);
			}
		}
		return { name: phase.name, active: phase.active, sections: indices };
	});
	return {
		posts: plan.posts,
		schema: plan.schema,
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- each pool holds its own section's values
		sections: Object.fromEntries(
			Object.values(SECTION_KEYS).map((key) => [key, sections[key] ?? []]),
		) as unknown as EnvironmentSectionPools,
		phases,
		volumes: plan.volumes,
		flowNoise: plan.flowNoise === null ? null : (textureIds[plan.flowNoise] ?? null),
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

/** per section, its resolved references */
type SectionTextures = Map<EnvironmentSectionName, SectionRefs>;

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
