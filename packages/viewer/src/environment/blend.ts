import type {
	EnvironmentPhaseInfo,
	EnvironmentProfile,
	EnvironmentSchema,
	EnvironmentVolumeInfo,
	PostProfile,
	ResolvedEnvironmentTable,
} from '@endfield-noclip/package-format/environment';
import { compareVolumes, distanceInsideVolume } from '@endfield-noclip/package-format/environment-volumes';
import type { LevelEnvironment, PackageManifest } from '@endfield-noclip/package-format/manifest';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import { applyPhase } from './lerp.ts';

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
	/** the base phase, whose every section the blend starts from, inactive ones included */
	base: EnvironmentPhaseInfo;
	/** the level's post profile */
	post: PostProfile | null;
	/** the phase each of {@link applied} applies */
	phases: EnvironmentPhaseInfo[];
	schema: EnvironmentSchema;
}

/**
 * compares two applied-volume lists at 1% factor resolution without allocating strings
 *
 * @param a first list
 * @param b second list
 * @returns whether both lists have the same volumes, phases, and rounded factors in order
 */
export const sameApplied = (a: readonly AppliedVolume[], b: readonly AppliedVolume[]): boolean => {
	if (a.length !== b.length) {
		return false;
	}
	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (x.id !== y.id || x.phase !== y.phase || Math.round(x.factor * 100) !== Math.round(y.factor * 100)) {
			return false;
		}
	}
	return true;
};

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

interface IndexedVolume {
	id: number;
	volume: EnvironmentVolumeInfo;
	/** world-space AABB for cheap rejection before exact shape math (`null` for global volumes) */
	aabb: readonly [minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number] | null;
}

const volumeAabb = (shape: EnvironmentVolumeInfo['shape']): IndexedVolume['aabb'] => {
	switch (shape.kind) {
		case 'global': {
			return null;
		}
		case 'sphere': {
			const [cx, cy, cz] = shape.center;
			const r = shape.radius;
			return [cx - r, cy - r, cz - r, cx + r, cy + r, cz + r];
		}
		case 'box': {
			const [cx, cy, cz] = shape.center;
			const [hx, hy, hz] = shape.halfExtents;
			const m = shape.toBox;
			// rows of `toBox` are the box's unit axes in world space
			const rx = Math.abs(m[0]) * hx + Math.abs(m[3]) * hy + Math.abs(m[6]) * hz;
			const ry = Math.abs(m[1]) * hx + Math.abs(m[4]) * hy + Math.abs(m[7]) * hz;
			const rz = Math.abs(m[2]) * hx + Math.abs(m[5]) * hy + Math.abs(m[8]) * hz;
			return [cx - rx, cy - ry, cz - rz, cx + rx, cy + ry, cz + rz];
		}
		case 'prism': {
			let minX = Infinity;
			let maxX = -Infinity;
			let minZ = Infinity;
			let maxZ = -Infinity;
			for (const [x, z] of shape.points) {
				if (x < minX) {
					minX = x;
				}
				if (x > maxX) {
					maxX = x;
				}
				if (z < minZ) {
					minZ = z;
				}
				if (z > maxZ) {
					maxZ = z;
				}
			}
			return [minX, shape.bottom, minZ, maxX, shape.top, maxZ];
		}
	}
};

/** volumes with their table index and world AABB, in the order they stack, per environment */
const sortedVolumes = new WeakMap<ResolvedEnvironmentTable, IndexedVolume[]>();

const volumesOf = (environment: ResolvedEnvironmentTable): IndexedVolume[] => {
	return sortedVolumes.getOrInsertComputed(environment, () => {
		const list: IndexedVolume[] = environment.volumes.map((volume, id) => ({
			id,
			volume,
			aabb: volumeAabb(volume.shape),
		}));
		list.sort(({ volume: a }, { volume: b }) => compareVolumes(a, b));
		return list;
	});
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
 * @returns the index of the level that owns it, or `null` for scene-wide volumes
 */
export const volumeLevel = (manifest: PackageManifest, volume: EnvironmentVolumeInfo): number | null =>
	manifest.states.groups[volume.group]?.level ?? null;

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
			const sceneWide = volume.shape.kind === 'global' && volumeLevel(manifest, volume) === null;
			if ((id === environment.volume || sceneWide) && volumeApplies(manifest, volume, options)) {
				apply(id, volume.name, volume.phase, 1);
			}
		}
		if (options.pinnedPhase !== null) {
			apply(-1, 'pinned', options.pinnedPhase, 1);
		}
	} else {
		const speed = time.fades.step(eye);
		const ex = eye[0];
		const ey = eye[1];
		const ez = eye[2];
		for (const { id, volume, aabb } of volumesOf(table)) {
			if (!volumeApplies(manifest, volume, options)) {
				continue;
			}
			let distance: number;
			if (
				aabb !== null &&
				(ex < aabb[0] || ex > aabb[3] || ey < aabb[1] || ey > aabb[4] || ez < aabb[2] || ez > aabb[5])
			) {
				if (volume.blend.kind !== 'fade') {
					continue;
				}
				distance = 0;
			} else {
				distance = distanceInsideVolume(volume.shape, eye);
			}
			apply(id, volume.name, volume.phase, volumeFactor(id, volume, distance, speed, time));
		}
	}
	const post = environment.post === null ? null : (table.posts[environment.post] ?? null);
	return {
		applied,
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
 * @param level the shown level's index
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
	const own = volumes[environment.volume];
	if (own === undefined || !volumeApplies(manifest, own, options)) {
		return null;
	}
	const others = applicable.filter((volume) => {
		const owner = volumeLevel(manifest, volume);
		return owner !== null && owner !== level;
	});
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
