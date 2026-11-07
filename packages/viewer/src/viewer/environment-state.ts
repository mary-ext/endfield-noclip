import type { EnvironmentProfile } from '@endfield-noclip/package-format/environment';
import type { LevelEnvironment } from '@endfield-noclip/package-format/manifest';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import {
	type AppliedVolume,
	applyBlend,
	EnvironmentFades,
	type EnvironmentScene,
	planBlend,
} from '../environment/blend.ts';
import { type CelestialLook, celestialLook } from '../environment/celestial-look.ts';
import { deriveEnvironment } from '../environment/derive.ts';
import type { Environment } from '../environment/environment.ts';
import { type LensFlareLook, lensFlareLook } from '../environment/lens-flare-look.ts';
import { wetnessParams } from '../environment/wetness.ts';

/** everything the renderers take from one blended environment profile */
export interface EnvironmentLook {
	environment: Environment;
	/** the nebula and planets */
	celestial: CelestialLook;
	/** the sun's lens flare, `null` for none */
	lensFlare: LensFlareLook | null;
	/** `Frame.wetness` */
	wetness: Float32Array;
}

/** what {@link EnvironmentState.update} blends at */
export interface BlendInput {
	/** the loaded package's environment table and manifest, `undefined` without one */
	scene: EnvironmentScene | undefined;
	eye: Vec3;
	/** blend the volumes by position; off applies the global and base volumes fully */
	volumes: boolean;
	/** a phase to show over the base instead of the volumes, or `null` */
	pinnedPhase: number | null;
	/** per conditional set, whether it holds; replaced (not changed in place) when the results change */
	loaded: readonly boolean[];
	/** seconds since the last update, which time-faded volumes advance by */
	dt: number;
}

/**
 * @param profile a blended profile, or `null` for the defaults
 * @returns what the renderers take from it
 */
const lookOf = (profile: EnvironmentProfile | null): EnvironmentLook => ({
	environment: deriveEnvironment(profile),
	celestial: celestialLook(profile),
	lensFlare: lensFlareLook(profile),
	wetness: wetnessParams(profile?.rain),
});

/**
 * the current level's environment blended at the camera: re-plans the blend only when the eye, the settings
 * or a fade moved, and derives a new look only when the planned volumes or factors changed
 */
export class EnvironmentState {
	/** the look in effect */
	look: EnvironmentLook = lookOf(null);
	/** the volumes applied at the camera, in order */
	applied: AppliedVolume[] = [];
	/** the time-faded volumes' fade state for the camera */
	readonly fades = new EnvironmentFades();
	/** the current level's base environment, which the volumes blend over */
	#base: LevelEnvironment | null = null;
	/** what the blend was last planned for */
	#eye: Vec3 = [Infinity, Infinity, Infinity];
	#volumes = true;
	#pinnedPhase: number | null = null;
	#loaded: readonly boolean[] = [];
	/** the last plan's key; `null` forces a new look */
	#key: string | null = null;

	/**
	 * sets the environment the volumes blend over, keeping the fades, which follow the camera rather than the
	 * level; the next {@link update} derives a new look
	 *
	 * @param base the current level's base environment, or `null` for the defaults
	 */
	setBase(base: LevelEnvironment | null): void {
		this.#base = base;
		this.#key = null;
	}

	/**
	 * @param input where and how to blend
	 * @param options.force plan even if nothing changed
	 * @returns the new look, or `null` when it didn't change
	 */
	update(input: BlendInput, options: { force: boolean }): EnvironmentLook | null {
		const { eye } = input;
		const last = this.#eye;
		if (
			!options.force &&
			input.volumes === this.#volumes &&
			input.pinnedPhase === this.#pinnedPhase &&
			input.loaded === this.#loaded &&
			!this.fades.animating &&
			eye[0] === last[0] &&
			eye[1] === last[1] &&
			eye[2] === last[2]
		) {
			return null;
		}
		this.#eye = [...eye];
		this.#volumes = input.volumes;
		this.#pinnedPhase = input.pinnedPhase;
		this.#loaded = input.loaded;
		const { scene } = input;
		const base = this.#base;
		const plan =
			scene === undefined || base === null
				? null
				: planBlend(
						scene,
						base,
						eye,
						{ volumes: input.volumes, pinnedPhase: input.pinnedPhase, loaded: input.loaded },
						{ fades: this.fades, dt: input.dt },
					);
		const key = plan?.key ?? '';
		this.applied = plan?.applied ?? [];
		if (key === this.#key) {
			return null;
		}
		this.#key = key;
		this.look = lookOf(plan === null ? null : applyBlend(plan));
		return this.look;
	}
}
