import type {
	BlendSchema,
	EnvironmentPhaseInfo,
	EnvironmentProfile,
	EnvironmentSchema,
	EnvironmentSections,
	EnvironmentVolumeInfo,
	FieldBlend,
	PostProfile,
	ResolvedEnvironmentTable,
} from '@endfield-noclip/package-format/environment';
import { compareVolumes, distanceInsideVolume } from '@endfield-noclip/package-format/environment-volumes';
import type { LevelEnvironment, PackageManifest } from '@endfield-noclip/package-format/manifest';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import { SUN_EFFECTS } from './sun.ts';

/** a volume that applied at the camera, and how strongly */
export interface AppliedVolume {
	/** index into the environment table's volumes, or -1 for a pinned phase */
	id: number;
	name: string;
	phase: string;
	factor: number;
}

/** what applies at a point, worked out before any section is blended ({@link applyBlend} blends them) */
export interface BlendPlan {
	/** the volumes that apply, in order */
	applied: AppliedVolume[];
	/** changes whenever the blended profile would (volumes and rounded factors) */
	key: string;
	/** the base phase, whose every section the blend starts from, inactive ones included */
	base: EnvironmentPhaseInfo;
	/** the level's post profile */
	post: PostProfile | null;
	/** the phase each of {@link applied} applies */
	phases: EnvironmentPhaseInfo[];
	schema: EnvironmentSchema;
}

/** what the blend may use */
interface BlendOptions {
	/** whether volumes apply by where the camera is, rather than only the level's own look */
	volumes: boolean;
	/** apply only this phase over the level's own look, instead of the volumes */
	pinnedPhase: number | null;
	/**
	 * per `states.conditionalSets` entry of the manifest, whether the selected scene values satisfy it; a
	 * volume whose condition is unsatisfied (its scene states, or its own `environmentVolume` control) doesn't
	 * apply. without it, every volume with a phase counts as applying
	 */
	loaded?: readonly boolean[];
}

/** what the blend reads of a package: its environment table, and the manifest whose groups gate volumes */
export interface EnvironmentScene {
	manifest: PackageManifest;
	environment: ResolvedEnvironmentTable;
}

/** volumes with their table index, in the order they stack, per environment */
const sortedVolumes = new WeakMap<
	ResolvedEnvironmentTable,
	{ id: number; volume: EnvironmentVolumeInfo }[]
>();

const volumesOf = (
	environment: ResolvedEnvironmentTable,
): { id: number; volume: EnvironmentVolumeInfo }[] => {
	return sortedVolumes.getOrInsertComputed(environment, () =>
		environment.volumes
			.map((volume, id) => ({ id, volume }))
			.toSorted(({ volume: a }, { volume: b }) => compareVolumes(a, b)),
	);
};

/**
 * @returns whether a volume applies where it holds the camera: it has a phase, and its group's condition
 *   holds (its scene states and its `environmentVolume` control, which the package defaults off for scripted
 *   ones)
 */
const volumeApplies = (
	manifest: PackageManifest,
	volume: EnvironmentVolumeInfo,
	{ loaded }: Pick<BlendOptions, 'loaded'>,
): volume is EnvironmentVolumeInfo & { phase: number } => {
	if (volume.phase === null) {
		return false;
	}
	const condition = volumeCondition(manifest, volume);
	return condition === null || loaded === undefined || (loaded[condition] ?? false);
};

/**
 * @param manifest the volume's package manifest
 * @param volume an environment volume
 * @returns the tag of the level that owns it, 0 for scene-wide volumes
 */
export const volumeLevelTag = (manifest: PackageManifest, volume: EnvironmentVolumeInfo): number =>
	manifest.states.groups[volume.group]?.levelTag ?? 0;

/**
 * @param manifest the volume's package manifest
 * @param volume an environment volume
 * @returns the conditional set that loads it, or `null` when it always loads
 */
export const volumeCondition = (manifest: PackageManifest, volume: EnvironmentVolumeInfo): number | null =>
	manifest.states.groups[volume.group]?.condition ?? null;

/** a camera move longer than this in one frame (m) is a jump, and time fades snap */
const JUMP_DISTANCE = 5;
/** how much faster time fades run after a jump (the game's) */
const JUMP_SPEED = 10000;

/** the time-faded volumes' fade factors for one camera, carried from frame to frame */
export class EnvironmentFades {
	readonly #factors = new Map<number, number>();
	#lastEye: Vec3 | null = null;

	/**
	 * advances the fades by a frame
	 *
	 * @param eye the camera's position this frame
	 * @returns the speed the fades run at: 1, or {@link JUMP_SPEED} after a jump (and on the first frame)
	 */
	step(eye: Vec3): number {
		const last = this.#lastEye;
		this.#lastEye = [...eye];
		if (last === null) {
			return JUMP_SPEED;
		}
		const moved = Math.hypot(eye[0] - last[0], eye[1] - last[1], eye[2] - last[2]);
		return moved > JUMP_DISTANCE ? JUMP_SPEED : 1;
	}

	/**
	 * @param id the volume's index
	 * @param inside whether the camera is in it
	 * @param change how far the factor moves this frame (fade time over duration), ≥ 0
	 * @returns the volume's factor after this frame
	 */
	fade(id: number, inside: boolean, change: number): number {
		const current = this.#factors.get(id);
		if (current === undefined && !inside) {
			return 0;
		}
		const next = Math.min(1, Math.max(0, (current ?? 0) + (inside ? change : -change)));
		if (next === 0 && !inside) {
			this.#factors.delete(id);
		} else {
			this.#factors.set(id, next);
		}
		return next;
	}

	/** @returns whether any fade is between its ends, so the next frame changes the blend */
	get animating(): boolean {
		for (const factor of this.#factors.values()) {
			if (factor > 0 && factor < 1) {
				return true;
			}
		}
		return false;
	}

	/** forgets every fade, as when the scene changes */
	reset(): void {
		this.#factors.clear();
		this.#lastEye = null;
	}
}

/** a frame of time fading: the fade state and the frame's duration */
interface BlendTime {
	fades: EnvironmentFades;
	/** seconds since the last frame */
	dt: number;
}

/**
 * works out which volumes apply at the camera, and how strongly, starting from the level's base phase and
 * post profile. with volumes off (or a phase pinned), the scene-wide global volumes and the level's base
 * volume apply fully wherever the camera is: the level's own look, which a pinned phase then goes over
 *
 * @param scene the loaded package's environment table and manifest
 * @param environment the shown level's base environment
 * @param eye the camera's world position
 * @param options which volumes may apply
 * @param time the fade state, which this call advances, and the frame's duration
 * @returns what applies at the camera, or `null` if the package lacks the base phase
 */
export const planBlend = (
	scene: EnvironmentScene,
	environment: LevelEnvironment,
	eye: Vec3,
	options: BlendOptions,
	time: BlendTime,
): BlendPlan | null => {
	const { manifest, environment: table } = scene;
	const baseIndex = table.volumes[environment.volume]?.phase ?? null;
	const base = baseIndex === null ? undefined : table.phases[baseIndex];
	if (base === undefined) {
		return null;
	}
	const applied: AppliedVolume[] = [];
	const phases: EnvironmentPhaseInfo[] = [];
	const apply = (id: number, name: string, index: number, factor: number): void => {
		const phase = table.phases[index];
		if (phase !== undefined && factor > 1e-4) {
			applied.push({ id, name, phase: phase.name, factor });
			phases.push(phase);
		}
	};
	if (options.pinnedPhase !== null || !options.volumes) {
		for (const { id, volume } of volumesOf(table)) {
			const sceneWide = volume.shape.kind === 'global' && volumeLevelTag(manifest, volume) === 0;
			if ((id === environment.volume || sceneWide) && volumeApplies(manifest, volume, options)) {
				apply(id, volume.name, volume.phase, 1);
			}
		}
		if (options.pinnedPhase !== null) {
			apply(-1, 'pinned', options.pinnedPhase, 1);
		}
	} else {
		const speed = time.fades.step(eye);
		for (const { id, volume } of volumesOf(table)) {
			if (volumeApplies(manifest, volume, options)) {
				apply(
					id,
					volume.name,
					volume.phase,
					volumeFactor(id, volume, distanceInsideVolume(volume.shape, eye), speed, time),
				);
			}
		}
	}
	const post = environment.post === null ? null : (table.posts[environment.post] ?? null);
	return {
		applied,
		key: applied.map(({ name, phase, factor }) => `${name}/${phase}@${factor.toFixed(2)}`).join('|'),
		base,
		post,
		phases,
		schema: table.schema,
	};
};

/**
 * @param plan what applies, from {@link planBlend}
 * @returns the profile in effect: the base phase's sections and the post profile with the plan's phases
 *   blended over them, sharing nothing with the manifest
 */
export const applyBlend = (plan: BlendPlan): EnvironmentProfile => {
	// the blend replaces sections rather than changing them in place, so it reads the manifest's own until the
	// copy at the end
	const profile: EnvironmentProfile = { name: plan.base.name, ...plan.base.sections, post: plan.post };
	for (const [i, { factor }] of plan.applied.entries()) {
		applyPhase(profile, plan.phases[i], factor, plan.schema);
	}
	profile.name = plan.applied.at(-1)?.phase ?? profile.name;
	return structuredClone(profile);
};

/**
 * @returns how strongly a volume applies `distance` m inside it; a scripted (manual) volume at full strength,
 *   since its script's factor isn't followed
 */
const volumeFactor = (
	id: number,
	volume: EnvironmentVolumeInfo,
	distance: number,
	speed: number,
	time: BlendTime,
): number => {
	const inside = distance > 0;
	const { blend } = volume;
	switch (blend.kind) {
		case 'replace':
		case 'scripted': {
			return inside ? 1 : 0;
		}
		case 'depth': {
			if (!inside) {
				return 0;
			}
			return volume.shape.kind === 'global' ? 1 : Math.min(1, distance / (blend.distance + 1e-45));
		}
		case 'fade': {
			const duration = inside ? blend.fadeIn : blend.fadeOut;
			const change = (time.dt * speed) / duration;
			return time.fades.fade(id, inside, Number.isNaN(change) ? 1 : change);
		}
	}
};

// #region viewpoints

/** samples along a view line when looking for a point inside a level's volume */
const VIEW_STEPS = 64;

/**
 * pulls a viewpoint towards what it looks at until the level's own look applies there: its base volume holds
 * it fully (past the blend distance) and no other level's volume reaches it. volumes have height bands and
 * neighbours' volumes overlap a level's rectangle, so a view framed from the rectangle alone often shows a
 * neighbour's environment or only the scene's global one.
 *
 * @param scene the loaded package's environment table and manifest
 * @param level the shown level's tag
 * @param environment the level's base environment
 * @param target the point the view looks at
 * @param eye the viewpoint
 * @param options optionally which points are clear to view from (off the ground and out of the scenery), and
 *   which conditional sets hold, so only volumes the blend would apply count
 * @returns the point nearest `eye` on the segment from `target` that qualifies, or `null` when none does
 */
export const eyeInLevelVolume = (
	scene: EnvironmentScene,
	level: number,
	environment: LevelEnvironment,
	target: Vec3,
	eye: Vec3,
	options: { clear?: (point: Vec3) => boolean } & Pick<BlendOptions, 'loaded'>,
): Vec3 | null => {
	const { manifest } = scene;
	const volumes = scene.environment.volumes;
	const applicable = volumes.filter((volume) => volumeApplies(manifest, volume, options));
	const owner = (volume: EnvironmentVolumeInfo): number => volumeLevelTag(manifest, volume);
	const own = volumes[environment.volume];
	if (own === undefined || !volumeApplies(manifest, own, options)) {
		return null;
	}
	const others = applicable.filter((volume) => owner(volume) !== 0 && owner(volume) !== level);
	// time-faded volumes apply fully anywhere inside; keep a metre off the edge
	const margin = Math.max(own.blend.kind === 'depth' ? own.blend.distance : 0, 1);
	for (let step = VIEW_STEPS; step >= 0; step--) {
		const t = step / VIEW_STEPS;
		const point: Vec3 = [
			target[0] + (eye[0] - target[0]) * t,
			target[1] + (eye[1] - target[1]) * t,
			target[2] + (eye[2] - target[2]) * t,
		];
		if (
			distanceInsideVolume(own.shape, point) >= margin &&
			others.every((volume) => distanceInsideVolume(volume.shape, point) <= 0) &&
			(options.clear?.(point) ?? true)
		) {
			return point;
		}
	}
	return null;
};

// #endregion

// #region lerp

type Sections = Record<keyof EnvironmentSections, Record<string, unknown>>;

/**
 * blends a phase's active sections into the profile, replacing them. the new sections may share values with
 * both sides', which are never changed in place
 */
const applyPhase = (
	profile: EnvironmentProfile,
	phase: EnvironmentPhaseInfo,
	t: number,
	schema: EnvironmentSchema,
): void => {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sections are plain JSON records
	const target = profile as unknown as Sections;
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- as above
	const source = phase.sections as unknown as Sections;
	// the atmosphere each side's fog defers to; sections are replaced, never changed in place
	const atmospheres = {
		from: target.atmosphere,
		to: phase.active.includes('atmosphere') ? source.atmosphere : target.atmosphere,
	};
	for (const name of phase.active) {
		if (t >= 1 - 1e-4) {
			target[name] = source[name];
		} else {
			target[name] = lerpSection(name, target[name], source[name], atmospheres, t, schema[name] ?? {});
		}
	}
};

/** lerps one section, below full strength */
const lerpSection = (
	name: keyof EnvironmentSections,
	a: Record<string, unknown>,
	b: Record<string, unknown>,
	atmospheres: { from: Record<string, unknown>; to: Record<string, unknown> },
	t: number,
	schema: BlendSchema,
): Record<string, unknown> => {
	switch (name) {
		case 'light': {
			return lerpLight(a, b, t, schema);
		}
		case 'fog': {
			return lerpFog(a, b, atmospheres, t, schema);
		}
		case 'cloud': {
			return lerpCloud(a, b, t, schema);
		}
		case 'rain': {
			// the section is optional, and a profile without it is dry
			return lerpRain(a ?? {}, b, t, schema);
		}
		case 'heightFog':
		case 'volumetricFog': {
			return lerpFlowNoise(a, b, t, schema);
		}
		case 'lensFlare': {
			return lerpLensFlare(a, b, t);
		}
		default: {
			return lerpObject(a, b, t, schema);
		}
	}
};

/** lerps two objects field by field, as their schema says */
const lerpObject = (
	a: Record<string, unknown>,
	b: Record<string, unknown>,
	t: number,
	schema: BlendSchema,
): Record<string, unknown> => {
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(b)) {
		out[key] = lerpValue(schema[key], a[key], b[key], t);
	}
	return out;
};

/** @returns `a` before ½, else `b` (or `b` when `a` is missing) */
const switchValue = (a: unknown, b: unknown, t: number): unknown => (t < 0.5 && a !== undefined ? a : b);

const lerpValue = (
	blend: FieldBlend | BlendSchema | undefined,
	a: unknown,
	b: unknown,
	t: number,
): unknown => {
	if (typeof blend === 'object') {
		return isRecord(a) && isRecord(b) ? lerpObject(a, b, t, blend) : switchValue(a, b, t);
	}
	if (blend !== 'lerp' && blend !== 'round') {
		return switchValue(a, b, t);
	}
	const lerp = (x: number, y: number): number => {
		const value = x + (y - x) * t;
		return blend === 'round' ? Math.round(value) : value;
	};
	if (typeof a === 'number' && typeof b === 'number') {
		return lerp(a, b);
	}
	if (isNumbers(a) && isNumbers(b) && a.length === b.length) {
		return b.map((value, i) => lerp(a[i], value));
	}
	return switchValue(a, b, t);
};

const isNumbers = (value: unknown): value is number[] =>
	Array.isArray(value) && value.every((v) => typeof v === 'number');

const isPitchYaw = (value: unknown): value is [number, number] =>
	Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === 'number');

/** lerps a pitch and yaw (degrees), turning the yaw the short way round */
const lerpPitchYaw = (
	a: readonly [number, number],
	b: readonly [number, number],
	t: number,
): [number, number] => {
	const yaw = ((((b[1] - a[1]) % 360) + 540) % 360) - 180;
	return [a[0] + (b[0] - a[0]) * t, a[1] + yaw * t];
};

/**
 * the light lerp's directions: each effect's direction in effect on either side (its own, or the sun's per
 * its mode) lerps as a pitch and yaw, so every direction stays a unit vector between the two. the game's own
 * direction lerp isn't known
 */
const lerpLight = (
	a: Record<string, unknown>,
	b: Record<string, unknown>,
	t: number,
	schema: BlendSchema,
): Record<string, unknown> => {
	const out = lerpObject(a, b, t, schema);
	const sunA = a.directPitchYaw;
	const sunB = b.directPitchYaw;
	if (!isPitchYaw(sunA) || !isPitchYaw(sunB)) {
		return out;
	}
	out.directPitchYaw = lerpPitchYaw(sunA, sunB, t);
	for (const effect of SUN_EFFECTS) {
		const modeKey = `${effect}PitchYawMode`;
		const key = `${effect}PitchYaw`;
		const own = (side: Record<string, unknown>, sun: [number, number]): [number, number] => {
			const value = side[key];
			return side[modeKey] === 1 && isPitchYaw(value) ? value : sun;
		};
		if (a[modeKey] !== 1 && b[modeKey] !== 1) {
			// both follow the sun, and still do
			out[modeKey] = 0;
			continue;
		}
		out[modeKey] = 1;
		out[key] = lerpPitchYaw(own(a, sunA), own(b, sunB), t);
	}
	return out;
};

/**
 * the fog lerp: a negative `rayleighScatteringScale` defers to the atmosphere's, so where only one side
 * defers, it takes its atmosphere's scale before the lerp. how the game blends the deferral isn't known
 */
const lerpFog = (
	a: Record<string, unknown>,
	b: Record<string, unknown>,
	atmospheres: { from: Record<string, unknown>; to: Record<string, unknown> },
	t: number,
	schema: BlendSchema,
): Record<string, unknown> => {
	const key = 'rayleighScatteringScale';
	const scaleA = number(a[key]);
	const scaleB = number(b[key]);
	if (scaleA < 0 === scaleB < 0) {
		return lerpObject(a, b, t, schema);
	}
	return lerpObject(
		scaleA < 0 ? { ...a, [key]: number(atmospheres.from[key]) } : a,
		scaleB < 0 ? { ...b, [key]: number(atmospheres.to[key]) } : b,
		t,
		schema,
	);
};

/** a side of a lerp that shows, and how strongly */
interface Shown<T> {
	side: T;
	weight: number;
}

/**
 * the game's crossfade between two versions of a feature that can't lerp: the first fades out to the halfway
 * point, then the second fades in
 */
const crossFade = <T>(a: T, b: T, t: number): Shown<T> =>
	t < 0.5 ? { side: a, weight: 1 - 2 * t } : { side: b, weight: 2 * t - 1 };

/** the game's fade of a feature only one side has: it fades in from nothing, with that side's settings */
const oneSided = <T>(a: T, b: T, aHasIt: boolean, t: number): Shown<T> =>
	aHasIt ? { side: a, weight: 1 - t } : { side: b, weight: t };

/** the game's cloud lerp: a changed panorama fades out to the halfway point and the new one fades in */
const lerpCloud = (
	a: Record<string, unknown>,
	b: Record<string, unknown>,
	t: number,
	schema: BlendSchema,
): Record<string, unknown> => {
	const out = lerpObject(a, b, t, schema);
	const aOn = a.enable === true && a.cloudTexture !== null;
	const bOn = b.enable === true && b.cloudTexture !== null;
	let shown: Shown<Record<string, unknown>>;
	if (aOn !== bOn) {
		out.enable = true;
		shown = oneSided(a, b, aOn, t);
	} else if (aOn && a.cloudTexture !== b.cloudTexture) {
		shown = crossFade(a, b, t);
	} else {
		return out;
	}
	const { side, weight } = shown;
	out.cloudTexture = side.cloudTexture;
	out.cloudFadeAlpha = (typeof side.cloudFadeAlpha === 'number' ? side.cloudFadeAlpha : 1) * weight;
	return out;
};

/** wetness fields the game's rain lerp takes from the side with wetness on, when only one has it */
const WETNESS_FIELDS = [
	'wetnessBasePorosity',
	'wetnessPorosityFactor',
	'baseWetnessLevel',
	'verticalWetnessScalar',
	'farSceneWetnessDistanceFactor',
	'farSceneWetnessValue',
	'rippleRoughnessMaskThreshold',
];

/** the rain lerp's wetness: with wetness on one side only, it fades in from dry with that side's settings */
const lerpRain = (
	a: Record<string, unknown>,
	b: Record<string, unknown>,
	t: number,
	schema: BlendSchema,
): Record<string, unknown> => {
	const out = lerpObject(a, b, t, schema);
	const aOn = a.enableWetness === true;
	const bOn = b.enableWetness === true;
	if (aOn !== bOn) {
		const { side, weight } = oneSided(a, b, aOn, t);
		for (const key of WETNESS_FIELDS) {
			out[key] = side[key];
		}
		out.enableWetness = true;
		out.wetness = number(side.wetness) * weight;
	}
	return out;
};

const number = (value: unknown): number => (typeof value === 'number' ? value : 0);

/** the height-fog sections' lerp for their flow noise (docs/game-data/sky-and-fog.md#flow-noise) */
const lerpFlowNoise = (
	a: Record<string, unknown>,
	b: Record<string, unknown>,
	t: number,
	schema: BlendSchema,
): Record<string, unknown> => {
	const out = lerpObject(a, b, t, schema);
	const aOn = a.enableFlowNoise === true;
	const bOn = b.enableFlowNoise === true;
	const keep = (from: Record<string, unknown>): void => {
		for (const key of ['flowNoiseSpeed', 'flowNoiseTilling', 'flowNoiseDir']) {
			out[key] = from[key];
		}
	};
	if (aOn && bOn) {
		// Unity's Mathf.Approximately
		const close = (key: string): boolean => {
			const x = number(a[key]);
			const y = number(b[key]);
			return Math.abs(x - y) < Math.max(Math.max(Math.abs(x), Math.abs(y)) * 1e-6, 8 * 1.401298e-45);
		};
		if (close('flowNoiseSpeed') && close('flowNoiseTilling')) {
			return out;
		}
		const { side, weight } = crossFade(a, b, t);
		keep(side);
		out.flowNoiseIntensity = weight * number(side.flowNoiseIntensity);
	} else if (aOn !== bOn) {
		const { side, weight } = oneSided(a, b, aOn, t);
		keep(side);
		out.enableFlowNoise = true;
		out.flowNoiseDistance = side.flowNoiseDistance;
		out.flowNoiseIntensity = number(side.flowNoiseIntensity) * weight;
	} else {
		for (const key of [
			'enableFlowNoise',
			'flowNoiseIntensity',
			'flowNoiseDistance',
			'flowNoiseSpeed',
			'flowNoiseTilling',
			'flowNoiseDir',
		]) {
			out[key] = a[key];
		}
	}
	return out;
};

/** @returns an enabled lens flare section with its intensity scaled by `weight` */
const faded = (from: Record<string, unknown>, weight: number): Record<string, unknown> => ({
	...from,
	enable: true,
	intensity: number(from.intensity) * weight,
});

/**
 * the game's lens flare lerp: a flare on one side only fades in from nothing with that side's settings; with
 * a flare on both sides, the first fades out to the halfway point and the second fades in
 */
const lerpLensFlare = (
	a: Record<string, unknown> | undefined,
	b: Record<string, unknown>,
	t: number,
): Record<string, unknown> => {
	const aOn = a?.enable === true;
	const bOn = b.enable === true;
	if (aOn === bOn) {
		if (a !== undefined && aOn) {
			const { side, weight } = crossFade(a, b, t);
			return faded(side, weight);
		}
		return a ?? b;
	}
	// without a section under it, `a` has no flare and `b` is the side with one
	const { side, weight } = oneSided(a ?? b, b, aOn, t);
	return faded(side, weight);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

// #endregion
