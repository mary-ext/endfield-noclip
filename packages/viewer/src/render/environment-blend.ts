/**
 * the environment at the camera: the game's environment volumes blended the way `HGEnvironmentManager` does
 * each frame (`_InterpolateVolumesImpl`), over the shown level's base profile.
 *
 * volumes apply in ascending priority (then shape: global, box, prism) where they contain the camera. blend
 * mode 0 replaces the phase's sections, 1 lerps them by `clamp(distance to the edge / blendDistance)`, and 2
 * fades them in over `fadeInDuration` seconds while the camera is inside and out over `fadeOutDuration` after
 * it leaves ({@link EnvironmentFades}), snapping when the camera jumps more than 5 m in a frame. mode 3 (a
 * scripted factor) is skipped.
 *
 * a phase only touches the sections it marks active. per section the game lerps every field
 * (`HG*Config.Lerp`); here numbers and colours lerp, other values switch at the halfway point, and the cloud
 * panorama crossfades through its fade alpha when the texture changes, as `HGCloudConfig.Lerp` does
 *
 * @module
 */

import type {
	EnvironmentPhaseInfo,
	EnvironmentProfile,
	EnvironmentSections,
	EnvironmentVolumeInfo,
	EnvironmentVolumeShape,
} from '@endfield-noclip/package-format/environment';
import type { PackageManifest } from '@endfield-noclip/package-format/manifest';
import type { Rect } from '@endfield-noclip/package-format/values';

import type { Vec3 } from '../scene/camera.ts';

/** a volume that applied at the camera, and how strongly */
export interface AppliedVolume {
	/** index into the manifest's volumes, or -1 for a pinned phase */
	id: number;
	name: string;
	phase: string;
	factor: number;
}

/** the environment at a point */
export interface BlendedEnvironment {
	profile: EnvironmentProfile;
	/** the volumes that applied, in order */
	applied: AppliedVolume[];
	/** changes whenever the result does (volumes and rounded factors) */
	key: string;
}

/** what the blend may use */
export interface BlendOptions {
	/** apply only this phase over the base, instead of the volumes */
	pinnedPhase: number | null;
	/** manual preview overrides, keyed by manifest volume index; they win over scene states */
	enabled?: Readonly<Record<number, boolean>>;
	/**
	 * per `states.conditionalSets` entry of the manifest, whether the selected scene values satisfy it; a
	 * volume whose condition is unsatisfied isn't loaded. without it, every volume counts as loaded
	 */
	loaded?: readonly boolean[];
}

/** shape order among equal priorities, as `HGEnvironmentVolumeBase.CompareTo` falls back to the volume type */
const SHAPE_ORDER: Record<EnvironmentVolumeShape['kind'], number> = { global: 0, box: 1, prism: 3 };

/** volumes with their manifest index, sorted as the game applies them, per manifest */
const sortedVolumes = new WeakMap<PackageManifest, { id: number; volume: EnvironmentVolumeInfo }[]>();

const volumesOf = (manifest: PackageManifest): { id: number; volume: EnvironmentVolumeInfo }[] => {
	let sorted = sortedVolumes.get(manifest);
	if (sorted === undefined) {
		sorted = manifest.environmentVolumes
			.map((volume, id) => ({ id, volume }))
			.toSorted(
				({ volume: a }, { volume: b }) =>
					a.priority - b.priority || SHAPE_ORDER[a.shape.kind] - SHAPE_ORDER[b.shape.kind],
			);
		sortedVolumes.set(manifest, sorted);
	}
	return sorted;
};

/**
 * @returns whether a volume applies where it holds the camera: a manual override decides; else scripted
 *   volumes (mode 3) don't, and others do when their scene states load them
 */
const volumeApplies = (
	manifest: PackageManifest,
	volume: EnvironmentVolumeInfo,
	id: number,
	{ enabled, loaded }: Pick<BlendOptions, 'enabled' | 'loaded'>,
): volume is EnvironmentVolumeInfo & { phase: number } => {
	const manual = enabled?.[id];
	if (volume.phase === null || manual === false) {
		return false;
	}
	const condition = volumeCondition(manifest, volume);
	if (manual !== true && condition !== null && loaded !== undefined && !loaded[condition]) {
		return false;
	}
	switch (volume.blendMode) {
		case 0:
		case 1:
		case 2: {
			return true;
		}
		case 3: {
			return manual ?? false;
		}
		default: {
			return false;
		}
	}
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

/**
 * the time-faded volumes' fade factors for one camera (`HGEnvironmentVolumeBase.dataPerCameras`), carried
 * from frame to frame
 */
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
export interface BlendTime {
	fades: EnvironmentFades;
	/** seconds since the last frame */
	dt: number;
}

/**
 * @param manifest the loaded package's manifest
 * @param base the shown level's base profile (sections no volume sets keep its values)
 * @param eye the camera's world position
 * @param options which volumes may apply
 * @param time the fade state, advanced by this call; without it, time-faded volumes are fully in or out
 * @returns the profile in effect at the camera
 */
export const blendEnvironment = (
	manifest: PackageManifest,
	base: EnvironmentProfile,
	eye: Vec3,
	options: BlendOptions,
	time?: BlendTime,
): BlendedEnvironment => {
	const profile: EnvironmentProfile = structuredClone(base);
	const applied: AppliedVolume[] = [];
	const phases = manifest.environmentPhases;
	if (options.pinnedPhase !== null) {
		const phase = phases[options.pinnedPhase];
		if (phase !== undefined) {
			applyPhase(profile, phase, 1);
			applied.push({ id: -1, name: 'pinned', phase: phase.name, factor: 1 });
		}
	} else {
		const speed = time?.fades.step(eye) ?? JUMP_SPEED;
		for (const { id, volume } of volumesOf(manifest)) {
			if (!volumeApplies(manifest, volume, id, options)) {
				continue;
			}
			const distance = distanceInside(volume.shape, eye);
			const inside = distance > 0;
			let factor: number;
			switch (volume.blendMode) {
				case 0: {
					factor = inside ? 1 : 0;
					break;
				}
				case 1: {
					factor = !inside
						? 0
						: volume.shape.kind === 'global'
							? 1
							: Math.min(1, distance / (volume.blendDistance + 1e-45));
					break;
				}
				case 2: {
					// fades in over fadeInDuration seconds while inside, out over fadeOutDuration after leaving
					const duration = inside ? volume.fadeInDuration : volume.fadeOutDuration;
					const change = ((time?.dt ?? 0) * speed) / duration;
					factor =
						time === undefined
							? inside
								? 1
								: 0
							: time.fades.fade(id, inside, Number.isNaN(change) ? 1 : change);
					break;
				}
				case 3: {
					factor = inside ? 1 : 0;
					break;
				}
				default: {
					continue;
				}
			}
			const phase = phases[volume.phase];
			if (phase === undefined || factor <= 1e-4) {
				continue;
			}
			applyPhase(profile, phase, factor);
			applied.push({ id, name: volume.name, phase: phase.name, factor });
		}
	}
	const top = applied.at(-1);
	profile.name = top?.phase ?? base.name;
	return {
		profile,
		applied,
		key: applied.map(({ name, phase, factor }) => `${name}/${phase}@${factor.toFixed(2)}`).join('|'),
	};
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
 * @param manifest the loaded package's manifest
 * @param level the shown level's tag
 * @param base the level's base profile; its volume is the level's (or scene-wide) one applying that phase
 * @param target the point the view looks at
 * @param eye the viewpoint
 * @param options optionally which points are clear to view from (off the ground and out of the scenery), and
 *   the blend's preview overrides, so only volumes the blend would apply count
 * @returns the point nearest `eye` on the segment from `target` that qualifies, or `null` when none does
 */
export const eyeInLevelVolume = (
	manifest: PackageManifest,
	level: number,
	base: EnvironmentProfile,
	target: Vec3,
	eye: Vec3,
	options: { clear?: (point: Vec3) => boolean } & Pick<BlendOptions, 'enabled' | 'loaded'>,
): Vec3 | null => {
	const applicable = manifest.environmentVolumes.filter((volume, id) =>
		volumeApplies(manifest, volume, id, options),
	);
	const owner = (volume: EnvironmentVolumeInfo): number => volumeLevelTag(manifest, volume);
	const own = applicable.find(
		(volume) =>
			(owner(volume) === level || owner(volume) === 0) &&
			manifest.environmentPhases[volume.phase].name === base.name,
	);
	if (own === undefined) {
		return null;
	}
	const others = applicable.filter((volume) => owner(volume) !== 0 && owner(volume) !== level);
	// time-faded volumes apply fully anywhere inside; keep a metre off the edge
	const margin = Math.max(own.blendMode === 1 ? own.blendDistance : 0, 1);
	for (let step = VIEW_STEPS; step >= 0; step--) {
		const t = step / VIEW_STEPS;
		const point: Vec3 = [
			target[0] + (eye[0] - target[0]) * t,
			target[1] + (eye[1] - target[1]) * t,
			target[2] + (eye[2] - target[2]) * t,
		];
		if (
			distanceInside(own.shape, point) >= margin &&
			others.every((volume) => distanceInside(volume.shape, point) <= 0) &&
			(options.clear?.(point) ?? true)
		) {
			return point;
		}
	}
	return null;
};

// #endregion

// #region shapes

/**
 * @param volume an environment volume
 * @param rect a world x, z rectangle
 * @returns whether the volume's footprint may reach into the rectangle (boxes are bounded by their rotated
 *   extents' circle, so this can be true just outside a box's corners)
 */
export const volumeReaches = (volume: EnvironmentVolumeInfo, rect: Rect): boolean => {
	const { shape } = volume;
	switch (shape.kind) {
		case 'global': {
			return true;
		}
		case 'box': {
			const radius = Math.hypot(shape.scale[0], shape.scale[1], shape.scale[2]) / 2;
			const [x, , z] = shape.position;
			return (
				x + radius >= rect.minX &&
				x - radius <= rect.maxX &&
				z + radius >= rect.minZ &&
				z - radius <= rect.maxZ
			);
		}
		case 'prism': {
			const xs = shape.points.map(([x]) => x);
			const zs = shape.points.map(([, z]) => z);
			return (
				Math.max(...xs) >= rect.minX &&
				Math.min(...xs) <= rect.maxX &&
				Math.max(...zs) >= rect.minZ &&
				Math.min(...zs) <= rect.maxZ
			);
		}
	}
};

/** @returns how far inside the shape the point is (m), or ≤ 0 outside */
const distanceInside = (shape: EnvironmentVolumeShape, [x, y, z]: Vec3): number => {
	switch (shape.kind) {
		case 'global': {
			return Infinity;
		}
		case 'box': {
			const local = toBoxFrame(shape, [x - shape.position[0], y - shape.position[1], z - shape.position[2]]);
			let inside = Infinity;
			for (let axis = 0; axis < 3; axis++) {
				const half = Math.abs(shape.scale[axis]) / 2;
				inside = Math.min(inside, half - Math.abs(local[axis]));
			}
			return inside;
		}
		case 'prism': {
			if (y < shape.bottom || y > shape.top) {
				return 0;
			}
			const edge = distanceInPolygon(shape.points, x, z);
			return Math.min(edge, y - shape.bottom, shape.top - y);
		}
	}
};

/** undoes a Unity Euler rotation (applied z, then x, then y) */
const toBoxFrame = (shape: Extract<EnvironmentVolumeShape, { kind: 'box' }>, v: Vec3): Vec3 => {
	const [rx, ry, rz] = shape.rotation.map((degrees) => (degrees * Math.PI) / 180);
	let [x, y, z] = v;
	// inverse yaw
	[x, z] = [x * Math.cos(ry) - z * Math.sin(ry), x * Math.sin(ry) + z * Math.cos(ry)];
	// inverse pitch
	[y, z] = [y * Math.cos(rx) + z * Math.sin(rx), -y * Math.sin(rx) + z * Math.cos(rx)];
	// inverse roll
	[x, y] = [x * Math.cos(rz) + y * Math.sin(rz), -x * Math.sin(rz) + y * Math.cos(rz)];
	return [x, y, z];
};

/** @returns the distance from (x, z) to the polygon's nearest edge inside it, or 0 outside */
const distanceInPolygon = (points: readonly (readonly [number, number])[], x: number, z: number): number => {
	let inside = false;
	let nearest = Infinity;
	for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
		const [xi, zi] = points[i];
		const [xj, zj] = points[j];
		if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
			inside = !inside;
		}
		const ex = xi - xj;
		const ez = zi - zj;
		const t = Math.max(0, Math.min(1, ((x - xj) * ex + (z - zj) * ez) / (ex * ex + ez * ez || 1)));
		nearest = Math.min(nearest, Math.hypot(x - (xj + t * ex), z - (zj + t * ez)));
	}
	return inside ? nearest : 0;
};

// #endregion

// #region lerp

type Sections = Record<keyof EnvironmentSections, Record<string, unknown>>;

/** fields that hold texture-table ids or materials (or other references), which switch rather than lerp */
const REFERENCE = /(texture|map|material|mat)$/i;
/** integer settings that switch rather than lerp */
const DISCRETE = /(mode|type)$/i;

/** blends a phase's active sections into the profile, in place */
const applyPhase = (profile: EnvironmentProfile, phase: EnvironmentPhaseInfo, t: number): void => {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sections are plain JSON records
	const target = profile as unknown as Sections;
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- as above
	const source = phase.sections as unknown as Sections;
	for (const name of phase.active) {
		if (t >= 1 - 1e-4) {
			target[name] = structuredClone(source[name]);
		} else if (name === 'cloud') {
			target[name] = lerpCloud(target[name], source[name], t);
		} else if (name === 'rain' && target[name] !== undefined) {
			target[name] = lerpRain(target[name], source[name], t);
		} else {
			target[name] = lerpObject(target[name], source[name], t);
		}
	}
};

const lerpObject = (
	a: Record<string, unknown>,
	b: Record<string, unknown>,
	t: number,
): Record<string, unknown> => {
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(b)) {
		out[key] = lerpValue(key, a[key], b[key], t);
	}
	return out;
};

const lerpValue = (key: string, a: unknown, b: unknown, t: number): unknown => {
	if (REFERENCE.test(key)) {
		return t < 0.5 && a !== undefined ? structuredClone(a) : structuredClone(b);
	}
	if (typeof a === 'number' && typeof b === 'number' && !DISCRETE.test(key)) {
		return a + (b - a) * t;
	}
	if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
		return b.map((value, i) => lerpValue(key, a[i], value, t));
	}
	if (isRecord(a) && isRecord(b)) {
		return lerpObject(a, b, t);
	}
	return t < 0.5 && a !== undefined ? structuredClone(a) : structuredClone(b);
};

/** `HGCloudConfig.Lerp`: a changed panorama fades out to the halfway point and the new one fades in */
const lerpCloud = (
	a: Record<string, unknown>,
	b: Record<string, unknown>,
	t: number,
): Record<string, unknown> => {
	const out = lerpObject(a, b, t);
	const aOn = a.enable === true && a.cloudTexture !== null;
	const bOn = b.enable === true && b.cloudTexture !== null;
	const fadeA = typeof a.cloudFadeAlpha === 'number' ? a.cloudFadeAlpha : 1;
	const fadeB = typeof b.cloudFadeAlpha === 'number' ? b.cloudFadeAlpha : 1;
	if (aOn !== bOn) {
		// only one has clouds: keep its texture and fade it by its share
		out.enable = true;
		out.cloudTexture = aOn ? a.cloudTexture : b.cloudTexture;
		out.cloudFadeAlpha = aOn ? fadeA * (1 - t) : fadeB * t;
	} else if (aOn && a.cloudTexture !== b.cloudTexture) {
		out.cloudTexture = t < 0.5 ? a.cloudTexture : b.cloudTexture;
		out.cloudFadeAlpha = t < 0.5 ? fadeA * (1 - 2 * t) : fadeB * (2 * t - 1);
	}
	return out;
};

/** wetness fields `HGRainConfig.Lerp` takes from the side with wetness on, when only one has it */
const WETNESS_FIELDS = [
	'wetnessBasePorosity',
	'wetnessPorosityFactor',
	'baseWetnessLevel',
	'verticalWetnessScalar',
	'farSceneWetnessDistanceFactor',
	'farSceneWetnessValue',
	'rippleRoughnessMaskThreshold',
];

/**
 * `HGRainConfig.Lerp`'s wetness: with wetness on one side only, it fades in from dry with that side's
 * settings
 */
const lerpRain = (
	a: Record<string, unknown>,
	b: Record<string, unknown>,
	t: number,
): Record<string, unknown> => {
	const out = lerpObject(a, b, t);
	const aOn = a.enableWetness === true;
	const bOn = b.enableWetness === true;
	if (aOn !== bOn) {
		const on = aOn ? a : b;
		for (const key of WETNESS_FIELDS) {
			out[key] = on[key];
		}
		out.enableWetness = true;
		out.wetness = (typeof on.wetness === 'number' ? on.wetness : 0) * (aOn ? 1 - t : t);
	}
	return out;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

// #endregion
