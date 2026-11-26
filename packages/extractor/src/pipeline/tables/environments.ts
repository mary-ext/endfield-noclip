import type { EnvironmentVolume } from '@endfield-noclip/formats/endfield/environment-volume';
import type { PartitionLevel } from '@endfield-noclip/formats/endfield/level-partition';
import {
	ENVIRONMENT_SECTIONS,
	type EnvironmentPhase,
	type EnvironmentSection,
	type EnvironmentSectionName,
} from '@endfield-noclip/formats/hg/environment-phase';
import { type LensFlareDataSRP, readLensFlareData } from '@endfield-noclip/formats/unity/lens-flare-data';
import { ShaderPropertyFlags, ShaderPropertyType } from '@endfield-noclip/formats/unity/material';
import type { PlainKinds, PlainObject } from '@endfield-noclip/formats/unity/plain-object';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import { isObject, numberField, pptrField } from '@endfield-noclip/formats/unity/values';
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
	RainPresetting,
	RayPlanetMaterial,
	SkyPlanetMaterial,
	SnowPresetting,
	WeatherAssets,
} from '@endfield-noclip/package-format/environment';
import type { LevelEnvironment } from '@endfield-noclip/package-format/manifest';
import type { Color, Vec2, Vec3, Vec4 } from '@endfield-noclip/package-format/values';

import {
	type AssetResolver,
	type LocatedObject,
	locatedObject,
	type ObjectRef,
	recordBundleReads,
} from '../../game/assets/assets.ts';
import {
	environmentBlend,
	environmentVolumeShape,
	type LevelEnvironmentChoice,
	type LoadedPhase,
	type LoadedVolumeProfile,
	loadLevelPhases,
	loadVolumeProfile,
	resolveLevelEnvironment,
	resolveLevelPost,
	type SceneEnvironmentVolume,
	type SceneVolumes,
	scenePhaseLoader,
	type SectionSource,
} from '../../game/environment.ts';
import { type LoadedMaterial, loadMaterial } from '../../game/materials/material-load.ts';
import { linearRgb, scaleRgb } from '../../game/materials/material-values.ts';
import { allOf } from '../../game/state/game-state.ts';
import {
	type DraftControl,
	sceneControl,
	SWITCH_VALUES,
	type Visibility,
} from '../../game/state/scene-control.ts';
import type { Context } from '../../install/context.ts';
import {
	bundleSources,
	relocateSaved,
	type SavedLocator,
	saveLocated,
	sourcesCurrent,
} from '../../ir/bundle-memo.ts';
import { compareNumbers, compareStrings } from '../../util/compare.ts';
import { errorText } from '../../util/errors.ts';
import type { PackCache } from '../cache/pack-cache.ts';
import type { BundleSource } from '../compile/convert-pool.ts';
import type { ControlRegistry } from '../control-registry.ts';

const ENVIRONMENTS_ENTRY = new URL(import.meta.url);

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
	snowConfig: 'snow',
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
	volumeOwners: {
		levelTag: number;
		sceneStates: number[];
		condition: Visibility | null;
		dynamic?: boolean;
	}[];
	/** textures the phases reference; slots index this list */
	textures: LocatedObject[];
	/** index into {@link textures} of the height fog's flow noise, or `null` if the install lacks it */
	flowNoise: number | null;
	/** render-pipeline weather presettings, with texture refs still indexing {@link textures} */
	weather: WeatherAssets | null;
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

/** the render pipeline asset whose bundle also holds `HGRainPresettingAsset` and `HGSnowPresettingAsset` */
const RENDER_PIPELINE_ASSET_PATH =
	'Assets/Beyond/InitialAssets/Settings/RenderPipeline/HGRenderPipelineAsset.asset';

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
		return errorText(error);
	}
};

const readVec2 = (raw: unknown): Vec2 => {
	if (!isObject(raw)) {
		return [0, 0];
	}
	return [numberField(raw, 'x'), numberField(raw, 'y')];
};

const readVec4 = (raw: unknown): Vec4 => {
	if (!isObject(raw)) {
		return [0, 0, 0, 0];
	}
	return [numberField(raw, 'x'), numberField(raw, 'y'), numberField(raw, 'z'), numberField(raw, 'w')];
};

/**
 * loads `HGRainPresettingAsset` and `HGSnowPresettingAsset` from the render pipeline's bundle and queues
 * their textures into `textures`
 */
const findWeatherAssets = async (
	context: Pick<Context, 'world'>,
	resolver: AssetResolver,
	textures: LocatedObject[],
	textureIndex: Map<string, number>,
	report: ReportProblem,
): Promise<WeatherAssets | null> => {
	const [hash] = await context.world.hashesOf(RENDER_PIPELINE_ASSET_PATH);
	if (hash === undefined) {
		report({ kind: 'resource', path: RENDER_PIPELINE_ASSET_PATH, reason: 'no path hash' });
		return null;
	}
	let rpRef: ObjectRef;
	try {
		rpRef = await resolver.findUnique({ hash, path: RENDER_PIPELINE_ASSET_PATH }, UnityClass.MonoBehaviour);
	} catch (error) {
		report({ kind: 'resource', path: RENDER_PIPELINE_ASSET_PATH, reason: errorText(error) });
		return null;
	}
	let rainRef: ObjectRef | null = null;
	let snowRef: ObjectRef | null = null;
	for (const info of rpRef.file.file.objects) {
		if (info.classId !== UnityClass.MonoBehaviour) {
			continue;
		}
		// oxlint-disable-next-line no-await-in-loop -- peeks MonoBehaviour names in one small bundle
		const name = await rpRef.file.peekName(info);
		if (name === 'HGRainPresettingAsset') {
			rainRef = { bundleIndex: rpRef.bundleIndex, file: rpRef.file, info };
		} else if (name === 'HGSnowPresettingAsset') {
			snowRef = { bundleIndex: rpRef.bundleIndex, file: rpRef.file, info };
		}
		if (rainRef !== null && snowRef !== null) {
			break;
		}
	}
	const resolveTex = async (
		owner: ObjectRef,
		container: TypeTreeObject,
		field: string,
	): Promise<number | null> => {
		const pptr = pptrField(container, field);
		if (pptr.pathId === 0n) {
			return null;
		}
		try {
			const resolved = await resolver.resolve(owner, pptr);
			if (resolved === null) {
				return null;
			}
			const located = locatedObject(resolved);
			return textureIndex.getOrInsertComputed(located.key, () => textures.push(located) - 1);
		} catch (error) {
			report({ kind: 'resource', path: `${RENDER_PIPELINE_ASSET_PATH}#${field}`, reason: errorText(error) });
			return null;
		}
	};
	let rain: RainPresetting | null = null;
	if (rainRef !== null) {
		const obj = await resolver.read(rainRef);
		const p = obj.rainCommonPreSettingParam;
		if (isObject(p)) {
			const [
				sceneEffectRainTex,
				rainWaveTex,
				verticalFlowTexture,
				rippleTexture,
				rainSplashTexture,
				rainOcclusionSampleNoise,
			] = await Promise.all([
				resolveTex(rainRef, p, 'sceneEffectRainTex'),
				resolveTex(rainRef, p, 'rainWaveTex'),
				resolveTex(rainRef, p, 'verticalFlowTexture'),
				resolveTex(rainRef, p, 'rippleTexture'),
				resolveTex(rainRef, p, 'rainSplashTexture'),
				resolveTex(rainRef, p, 'rainOcclusionSampleNoise'),
			]);
			rain = {
				farRainDistance: numberField(p, 'farRainDistance'),
				middleRainDistance: numberField(p, 'middleRainDistance'),
				rainWaveDistance: numberField(p, 'rainWaveDistance'),
				maxRainHeight: numberField(p, 'maxRainHeight'),
				farRainMaxUVFlowSpeed: numberField(p, 'farRainMaxUVFlowSpeed'),
				farRainTex0ST: readVec4(p.farRainTex0_ST),
				farRainTex1ST: readVec4(p.farRainTex1_ST),
				sceneEffectRainMaxUVFlowSpeed: numberField(p, 'sceneEffectRainMaxUVFlowSpeed'),
				sceneEffectRainRange: numberField(p, 'sceneEffectRainRange'),
				sceneEffectRainTex,
				sceneEffectRainTexST: readVec4(p.sceneEffectRainTex_ST),
				rainWaveTex,
				rainWaveTexST: readVec4(p.rainWaveTex_ST),
				rainWaveNoiseST: readVec4(p.rainWaveNoise_ST),
				rainWaveNoiseFlowSpeedMultiplier: numberField(p, 'rainWaveNoiseFlowSpeedMultiplier'),
				verticalFlowTexture,
				verticalFlowTextureST: readVec4(p.verticalFlowTexture_ST),
				rippleTexture,
				rippleRowColumnCount: numberField(p, 'rippleRowColumnCount'),
				rippleTextureST: readVec2(p.rippleTexture_ST),
				rainSplashTexture,
				rainSplashTextureRowColumnCount: numberField(p, 'rainSplashTextureRowColumnCount'),
				rainSplashRange: numberField(p, 'rainSplashRange'),
				rainSplashYBias: numberField(p, 'rainSplashYBias'),
				rainOcclusionMapRange: numberField(p, 'rainOcclusionMapRange'),
				rainOcclusionMapHeight: numberField(p, 'rainOcclusionMapHeight'),
				rainOcclusionSampleNormalBias: numberField(p, 'rainOcclusionSampleNormalBias'),
				rainOcclusionSampleDepthBias: numberField(p, 'rainOcclusionSampleDepthBias'),
				rainOcclusionSampleNoise,
				rainOcclusionSampleNoiseScale: numberField(p, 'rainOcclusionSampleNoiseScale'),
				rainOcclusionSampleHorizontalJitterLevel: numberField(p, 'rainOcclusionSampleHorizontalJitterLevel'),
				rainOcclusionSampleVerticalJitterLevel: numberField(p, 'rainOcclusionSampleVerticalJitterLevel'),
				screenDropScatterParam: readVec2(p.screenDropScatterParam),
				screenDropFXShadingSize: numberField(p, 'screenDropFXShadingSize'),
				screenDropNoiseLevel: numberField(p, 'screenDropNoiseLevel'),
				screenDropFXNoiseTexST: readVec4(p.screenDropFXNoiseTex_ST),
			};
		}
	}
	let snow: SnowPresetting | null = null;
	if (snowRef !== null) {
		const obj = await resolver.read(snowRef);
		const p = obj.snowCommonPreSettingParam;
		if (isObject(p)) {
			const snowflakeTex = await resolveTex(snowRef, p, 'snowflakeTex');
			snow = {
				snowflakeTex,
				snowflakeTexST: readVec4(p.snowflakeTex_ST),
				maxSnowHeight: numberField(p, 'maxSnowHeight'),
				snowMaxUVFlowSpeed: numberField(p, 'snowMaxUVFlowSpeed'),
				snowRange: numberField(p, 'snowRange'),
			};
		}
	}
	return rain === null && snow === null ? null : { rain, snow };
};

/** records an environment problem */
type ReportProblem = (problem: EnvironmentProblem) => void;

/**
 * resolves every level's environment and loads the phases and profiles involved
 *
 * @param context world index and asset resolver
 * @param levels the scene's levels
 * @param enabled MapConfig scene state indices active by default; level base environments are chosen among
 *   the volumes they load
 * @param chunkVolumes environment and post volumes collected from the scene's default-area chunk files
 * @param placed volumes that placed prefabs carry (`loadPlacedVolumes`), alongside the chunk volumes
 * @returns the deduplicated profiles, per-level indices and the textures to convert
 */
export const planEnvironments = async (
	context: Pick<Context, 'world' | 'resolver'>,
	levels: readonly PartitionLevel[],
	enabled: ReadonlySet<number>,
	chunkVolumes: SceneVolumes,
	placed: readonly SceneEnvironmentVolume[],
	cache: PackCache | null = null,
): Promise<EnvironmentPlan> => {
	const plan: EnvironmentPlan = {
		levels: [],
		posts: [],
		phases: [],
		volumes: [],
		volumeOwners: [],
		textures: [],
		flowNoise: null,
		weather: null,
		debug: [],
		problems: [],
		schema: mapSchemaSections(),
	};
	if (levels.length === 0) {
		return plan;
	}
	const [pathOf, resolver] = await Promise.all([context.world.pathLookup(), context.resolver()]);
	const volumes: SceneVolumes = { ...chunkVolumes, environment: [...chunkVolumes.environment, ...placed] };
	const envFp = cache === null ? null : await cache.fingerprint(ENVIRONMENTS_ENTRY);
	let planMemoKey: string | null = null;
	if (cache !== null && envFp !== null) {
		planMemoKey = cache.keyWith(envFp, {
			kind: 'environmentPlan',
			levels: levels.map(({ id, tag }) => [id, tag]),
			// oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy
			enabled: [...enabled].sort(compareNumbers),
			volumes: volumes.environment.map(({ tag, sceneStates, condition, volume, phaseObject, dynamic }) => ({
				tag,
				sceneStates,
				condition,
				dynamic: dynamic ?? false,
				id: volume.id,
				name: volume.name,
				envPhase: volume.envPhase,
				phaseObject: phaseObject?.key ?? null,
				priority: volume.priority,
			})),
			posts: volumes.post.map(({ tag, sceneStates, volume }) => ({
				tag,
				sceneStates,
				id: volume.id,
				profile: volume.profile,
				priority: volume.priority,
			})),
		});
		const recalled = await cache.recallValue<{
			plan: Omit<EnvironmentPlan, 'textures'>;
			textures: SavedLocator[];
			sources: BundleSource[];
		}>(planMemoKey);
		if (recalled !== undefined && (await sourcesCurrent(resolver, recalled.sources))) {
			const textures: LocatedObject[] = [];
			let ok = true;
			for (const saved of recalled.textures) {
				const relocated = relocateSaved(resolver.manifest, saved);
				if (relocated === undefined) {
					ok = false;
					break;
				}
				textures.push(relocated);
			}
			if (ok) {
				return { ...recalled.plan, textures };
			}
		}
	}
	const { result: built, bundles } = await recordBundleReads(async () => {
		const reported = new Set<string>();
		const report: ReportProblem = (problem) => {
			const key = JSON.stringify(problem);
			if (!reported.has(key)) {
				reported.add(key);
				plan.problems.push(problem);
			}
		};
		const textureIndex = new Map<string, number>();
		const flowNoise = await findFlowNoise(context, resolver);
		if (typeof flowNoise === 'string') {
			report({ kind: 'resource', path: FLOW_NOISE_PATH, reason: flowNoise });
		} else {
			const located = locatedObject(flowNoise);
			plan.flowNoise = textureIndex.getOrInsertComputed(located.key, () => plan.textures.push(located) - 1);
		}
		plan.weather = await findWeatherAssets(context, resolver, plan.textures, textureIndex, report);

		// levels mostly share phases and profiles, so loads are cached; they run for all levels at once
		const phase = scenePhaseLoader(resolver, pathOf, volumes.environment);
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
		// without one, which the viewer skips. the references that can't be read are reported in volume order, as
		// the loads finish in any order
		const volumePhases = await Promise.all(
			volumes.environment.map(async ({ volume }) => {
				const load = phase(volume);
				if (load === null) {
					return 'no phase set';
				}
				try {
					const loadedPhase = await load;
					const problems: EnvironmentProblem[] = [];
					const textures = await resolvePhaseTextures(resolver, loadedPhase, (problem) =>
						problems.push(problem),
					);
					return { loaded: loadedPhase, textures, problems };
				} catch (error) {
					return errorText(error);
				}
			}),
		);
		for (const loadedPhase of volumePhases) {
			if (typeof loadedPhase !== 'string') {
				const keyed = loadedPhase.problems.map((problem) => ({ problem, key: JSON.stringify(problem) }));
				keyed.sort((a, b) => compareStrings(a.key, b.key));
				for (const { problem } of keyed) {
					report(problem);
				}
			}
		}
		const phaseIndex = new Map<string, number>();
		const volumeIndex = new Map<EnvironmentVolume, number>();
		for (const [i, { tag, sceneStates, condition, volume, dynamic }] of volumes.environment.entries()) {
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
			let index: number | null = null;
			if (typeof loadedPhase === 'string') {
				report({ kind: 'phase', volume: name, reason: loadedPhase });
			} else {
				index = phaseIndex.getOrInsertComputed(loadedPhase.loaded.phase.name, () => {
					addBlendSchema(plan.schema, loadedPhase.loaded.phase);
					return (
						plan.phases.push(
							buildPhase(loadedPhase.loaded.phase, loadedPhase.textures, plan.textures, textureIndex),
						) - 1
					);
				});
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
			plan.volumeOwners.push({ levelTag: tag, sceneStates, condition, dynamic: dynamic ?? false });
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

		for (const { phase: info, slots } of plan.phases) {
			if (info.active.includes('celestial')) {
				checkRayPlanet(info.name, info.sections.celestial, slots, report);
			}
		}
		return plan;
	});
	if (planMemoKey !== null && cache !== null) {
		const { textures, ...rest } = built;
		await cache.rememberValue(planMemoKey, {
			plan: rest,
			textures: textures.map((texture) => saveLocated(resolver.manifest, texture)),
			sources: await bundleSources(resolver, bundles),
		});
	}
	return built;
};

/** the textures the ray-traced planet's shader samples; without any of them it isn't drawn */
const RAY_PLANET_TEXTURES: readonly [key: keyof RayPlanetMaterial['textures'], slot: string][] = [
	['base', '_BaseColorMap'],
	['rsm', '_RSM'],
	['clouds', '_CloudsTexMain'],
	['lut', '_TransmittanceLLUT'],
];

/** reports a ray-traced planet that's on but lacks its material or one of its textures */
const checkRayPlanet = (
	phase: string,
	celestial: CelestialConfig,
	slots: readonly TextureSlot[],
	report: ReportProblem,
): void => {
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
	const bound = new Set(
		slots.filter((s) => s.holder === (advancedPlanetMat.textures as unknown)).map((s) => s.key),
	);
	const missing = RAY_PLANET_TEXTURES.filter(([key]) => !bound.has(key)).map(([, slot]) => slot);
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
					reason: errorText(error),
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
		data.elements.map(async ({ lensFlareTexture }, i) => {
			if (lensFlareTexture === null) {
				return null;
			}
			return resolver.resolve(ref, lensFlareTexture).catch((error: unknown) => {
				fail(`elements.${i}.lensFlareTexture`, error);
				return null;
			});
		}),
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
	textures: LocatedObject[],
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
 * @returns the floats (ints included), the colours and vectors, hdr-linear colour flags, and whether a
 *   texture slot is declared
 */
const materialValues = (
	material: LoadedMaterial,
): {
	floats: Record<string, number>;
	colors: Record<string, Color>;
	hdrLinear: ReadonlySet<string>;
	declares: (slot: string) => boolean;
} => {
	const { record, shader } = material;
	if (shader.properties.length === 0) {
		return {
			floats: { ...record.ints, ...record.floats },
			colors: { ...record.colors },
			hdrLinear: new Set(),
			declares: () => true,
		};
	}
	const floats: Record<string, number> = {};
	const colors: Record<string, Color> = {};
	const hdrLinear = new Set<string>();
	const textures = new Set<string>();
	for (const { name, type, flags, default: fallback } of shader.properties) {
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
				if ((flags & ShaderPropertyFlags.Hdr) !== 0 && (flags & ShaderPropertyFlags.Gamma) === 0) {
					hdrLinear.add(name);
				}
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
	return { floats, colors, hdrLinear, declares: (slot) => textures.has(slot) };
};

const DEG = Math.PI / 180;

const normalizeVec3 = (v: Readonly<Vec3>): Vec3 => {
	const len = Math.hypot(v[0], v[1], v[2]);
	return len === 0 ? [0, 0, 0] : [v[0] / len, v[1] / len, v[2] / len];
};

const rgbOf = (c: Readonly<Color> | undefined): Vec3 => (c === undefined ? [0, 0, 0] : [c[0], c[1], c[2]]);

const linearOf = (c: Readonly<Color> | undefined, scale = 1): Vec3 =>
	c === undefined ? [0, 0, 0] : scaleRgb(linearRgb(c), scale);

const lowerRayPlanetMaterial = (
	material: LoadedMaterial,
	slotFor: <T extends object>(holder: T, key: keyof T & string, ref: ObjectRef | null) => void,
): RayPlanetMaterial => {
	const { record } = material;
	const { floats, colors, declares } = materialValues(material);
	const f = (name: string): number => floats[name] ?? 0;
	const color = (name: string): Color | undefined => colors[name];
	const resolvedTex = (slot: string): ObjectRef | null => {
		const entry = material.textures[slot];
		return entry !== undefined && entry.ref !== null && declares(slot) ? entry.ref : null;
	};
	const textures: RayPlanetMaterial['textures'] = { base: null, rsm: null, clouds: null, lut: null };
	for (const [key, slot] of RAY_PLANET_TEXTURES) {
		slotFor(textures, key, resolvedTex(slot));
	}
	const baseSlot = record.textures['_BaseColorMap'];
	const baseTransform: Vec4 =
		baseSlot !== undefined && declares('_BaseColorMap')
			? [baseSlot.scale[0], baseSlot.scale[1], baseSlot.offset[0], baseSlot.offset[1]]
			: [1, 1, 0, 0];

	const radius = f('_RealPlanetRadius');
	const offset = f('_GlobalRadiusOffset');
	const groundRadius = 0.92 * radius + offset;
	const topRadius = f('_AtmosphereRatios') * radius + offset;
	const rayleighHeight = 0.06 * (topRadius - groundRadius);
	const density = f('_Density_Multiplier');
	const phi = f('_Phi2') * DEG;
	const theta = f('_Theta2') * DEG;
	const distance = f('_Dist');
	const origin = rgbOf(color('_PlanetWSBase'));
	const pitch = f('_Pitch') * DEG;
	const roll = f('_Roll') * DEG;
	const ambient = color('_Ambient') ?? [0, 0, 0, 0];

	return {
		textures,
		center: [
			origin[0] - Math.sin(phi) * distance,
			origin[1] + Math.sin(theta) * distance,
			origin[2] - Math.cos(theta) * Math.cos(phi) * distance,
		],
		radius,
		groundRadius,
		topRadius,
		cloudRadius: radius + f('_CloudsHeight'),
		viewSamples: f('_StepsI'),
		scaleHeights: [rayleighHeight, rayleighHeight * f('_Mie_Height_Scale')],
		mieAnisotropy: f('_g'),
		useLut: f('_Use_Lut') !== 0,
		rayleigh: linearOf(color('_Ray'), density),
		mie: linearOf(color('_Mie'), density),
		brightness: f('_Light_Intensity_Multiplier'),
		cloudShadows: record.keywords.includes('_ENABLE_CLOUDS_SHADOW'),
		light: f('_CustomLightDirection') !== 0 ? normalizeVec3(rgbOf(color('_CustomLightDir'))) : null,
		lightColor: f('_CustomLightColorPla') !== 0 ? linearOf(color('_CustomLightColPla')) : null,
		lightScale: f('_DirectLightIntensityBillboard'),
		tilt: [
			[Math.cos(roll), -Math.sin(roll) * Math.cos(pitch), Math.sin(roll) * Math.sin(pitch)],
			[Math.sin(roll), Math.cos(roll) * Math.cos(pitch), -Math.cos(roll) * Math.sin(pitch)],
			[0, Math.sin(pitch), Math.cos(pitch)],
		],
		spin: f('_PlanetRotateStart') * 0.001,
		baseTransform,
		tint: linearOf(color('_TintColor') ?? [1, 1, 1, 1]),
		seaShallow: linearOf(color('_SeaShallow')),
		seaDeep: linearOf(color('_SeaDeep')),
		fresnel: linearOf(color('_FresnelColor')),
		indirect: linearOf(color('_IndirectColor'), f('_IndirectIntensity')),
		cloudShadow: linearOf(color('_CloudsShadowColor') ?? [1, 1, 1, 1]),
		ambient: linearOf(ambient, density * ambient[3]),
		cloudAlpha: f('_CloudsAlphaMain'),
		cloudBrightness: f('_Light_Intensity_Clouds_Multiplier'),
		roughness: f('_Roughness'),
		roughnessFromMap: f('_UseRoughnessMap') !== 0,
	};
};

const lowerSkyPlanetMaterial = (
	material: LoadedMaterial,
	slotFor: <T extends object>(holder: T, key: keyof T & string, ref: ObjectRef | null) => void,
): SkyPlanetMaterial => {
	const { floats, colors, hdrLinear, declares } = materialValues(material);
	const f = (name: string): number => floats[name] ?? 0;
	const resolvedTex = (slot: string): ObjectRef | null => {
		const entry = material.textures[slot];
		return entry !== undefined && entry.ref !== null && declares(slot) ? entry.ref : null;
	};
	const colorOf = (name: string, fallback: Color): Vec3 => {
		const c = colors[name] ?? fallback;
		if (hdrLinear.has(name) || c[0] > 1 || c[1] > 1 || c[2] > 1) {
			return [c[0], c[1], c[2]];
		}
		return linearRgb(c);
	};
	const lowered: SkyPlanetMaterial = {
		mainTexture: null,
		emissiveTexture: null,
		ringTexture: null,
		color: colorOf('_Color', [1, 1, 1, 1]),
		emissive: colorOf('_PlanetEmissive', [1, 1, 1, 1]),
		sharpness: f('_StarNdlSharp'),
		backFace: f('_StarBackFaceAlpha'),
		ringShadowSoftness: f('_RingShadowSoftness'),
	};
	slotFor(lowered, 'mainTexture', resolvedTex('_MainTex'));
	slotFor(lowered, 'emissiveTexture', resolvedTex('_EmissiveTex'));
	slotFor(lowered, 'ringTexture', resolvedTex('_RingTex'));
	return lowered;
};

/**
 * nulls a section's texture fields and records where each resolved texture goes; material fields become
 * lowered semantic celestial material structs whose texture slots are recorded the same way
 */
const fillTextureSlots = (
	value: PlainObject,
	section: EnvironmentSection,
	refs: SectionRefs | undefined,
	slots: TextureSlot[],
	textures: LocatedObject[],
	textureIndex: Map<string, number>,
): void => {
	const slotFor = <T extends object>(holder: T, key: keyof T & string, ref: ObjectRef | null): void => {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- texture slot holder filled in finishEnvironments
		const record = holder as Record<string, unknown>;
		record[key] = null;
		if (ref !== null) {
			const located = locatedObject(ref);
			slots.push({
				holder: record,
				key,
				texture: textureIndex.getOrInsertComputed(located.key, () => textures.push(located) - 1),
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
		if (key === 'advancedPlanetMat') {
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- lowered semantic material replaces raw PPtr
			holder[key] = lowerRayPlanetMaterial(material, slotFor) as unknown as PlainObject;
		} else if (key === 'drawMaterial') {
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- lowered semantic material replaces raw PPtr
			holder[key] = lowerSkyPlanetMaterial(material, slotFor) as unknown as PlainObject;
		} else {
			holder[key] = null;
		}
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
	const mapTexture = (index: number | null): number | null =>
		index === null ? null : (textureIds[index] ?? null);
	const weather: WeatherAssets | null =
		plan.weather === null
			? null
			: {
					rain:
						plan.weather.rain === null
							? null
							: {
									...plan.weather.rain,
									sceneEffectRainTex: mapTexture(plan.weather.rain.sceneEffectRainTex),
									rainWaveTex: mapTexture(plan.weather.rain.rainWaveTex),
									verticalFlowTexture: mapTexture(plan.weather.rain.verticalFlowTexture),
									rippleTexture: mapTexture(plan.weather.rain.rippleTexture),
									rainSplashTexture: mapTexture(plan.weather.rain.rainSplashTexture),
									rainOcclusionSampleNoise: mapTexture(plan.weather.rain.rainOcclusionSampleNoise),
								},
					snow:
						plan.weather.snow === null
							? null
							: {
									...plan.weather.snow,
									snowflakeTex: mapTexture(plan.weather.snow.snowflakeTex),
								},
				};
	return {
		posts: plan.posts,
		schema: plan.schema,
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- each pool holds its own section's values
		sections: Object.fromEntries(
			Object.values(SECTION_KEYS).map((key) => [key, sections[key] ?? []]),
		) as unknown as EnvironmentSectionPools,
		phases,
		volumes: plan.volumes,
		flowNoise: mapTexture(plan.flowNoise),
		weather,
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

// #region controls

/**
 * gives each environment volume its visibility group (its level, and the scene states of the files holding
 * it, or its placement's condition) and registers the control switching each volume with a phase. the plan's
 * volumes are modified in place
 *
 * @param plan the planned environments
 * @param controls the package's controls; extended
 */
export const gateEnvironments = (plan: EnvironmentPlan, controls: ControlRegistry): void => {
	for (const [i, volume] of plan.volumes.entries()) {
		const { levelTag, sceneStates, condition, dynamic } = plan.volumeOwners[i];
		// a prefab volume loads with its placement; chunk volumes with the scene states of their files
		const loads = condition ?? (sceneStates.length === 0 ? null : controls.stateVisibility(sceneStates));
		if (volume.phase === null) {
			volume.group = controls.groupOf(levelTag, loads);
			continue;
		}
		// the volume's control index is known once the package's controls are (see `indexEnvironmentControls`)
		const control = environmentVolumeControl(i, volume, dynamic ?? false);
		controls.add(control);
		const on = [[{ control: control.id, mask: 2 }]];
		volume.group = controls.groupOf(levelTag, {
			alternatives: loads === null ? on : allOf(loads.alternatives, on),
		});
	}
};

/**
 * @param index the volume's index in the environment table
 * @returns the id of the control switching it
 */
const environmentVolumeControlId = (index: number): string => `environmentVolume:${index}`;

/**
 * points each environment volume with a phase at the control switching it; the volumes are modified in place
 *
 * @param environment the environment table
 * @param controlIndex by control id, the package's index of each control
 * @throws {Error} if a volume's control isn't among the package's
 */
export const indexEnvironmentControls = (
	environment: EnvironmentTable,
	controlIndex: ReadonlyMap<string, number>,
): void => {
	for (const [i, volume] of environment.volumes.entries()) {
		if (volume.phase !== null) {
			const id = environmentVolumeControlId(i);
			const index = controlIndex.get(id);
			if (index === undefined) {
				throw new Error(`environment volume control ${id} isn't among the package's controls`);
			}
			volume.control = index;
		}
	}
};

/**
 * @param index the volume's index in the environment table
 * @param volume an environment volume with a phase
 * @returns the control that switches it: on by default, except a scripted (mode 3) volume, whose script isn't
 *   followed
 */
const environmentVolumeControl = (
	index: number,
	volume: EnvironmentVolumeInfo,
	dynamic: boolean,
): DraftControl => {
	const scripted = volume.blend.kind === 'scripted';
	const offByDefault = scripted || dynamic;
	return sceneControl({
		kind: 'environmentVolume',
		id: environmentVolumeControlId(index),
		name: volume.name,
		values: SWITCH_VALUES,
		default: offByDefault ? 0 : 1,
		assumption: scripted
			? 'off: a level script fades it in, which isn’t followed; on previews it at full strength'
			: dynamic
				? 'off: a level script enables it, which isn’t followed; on previews it where it holds the camera'
				: 'on: it applies wherever it holds the camera',
	});
};

// #endregion
